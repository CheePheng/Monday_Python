import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Budget, Env, RunOpts } from "../src/types";

/**
 * A CRM DEAL MUST NEVER REACH THE LIVE WORK-MANAGEMENT BOARD.
 *
 * Two Workers run from this one codebase. The old one owns Work Management (Deals board 5029480547);
 * this one owns CRM (Deals board 5028000494). Routing is EXCLUSIVE by design — each deployment resolves
 * only its own boards — because ownership guards HubSpot writes and would not save us from two Workers
 * writing the same monday board.
 *
 * Three call sites broke that rule by asserting, in a comment, that `specByObject(env,"deals")` returns
 * undefined on the CRM deployment. That was true until CRM_DEALS joined CRM_SPECS, after which every
 * one of them let a CRM deal through the guard and into the WM path:
 *
 *   syncHubspotObject   -> syncHubspotDeal -> reconciles onto WM board 5029480547
 *   deleteHubspotObject -> findLinkedDealItem -> DELETES a WM card
 *   runIncremental      -> searches and writes WM, and never sweeps the CRM Deals board at all
 *
 * These tests pin the deployment split itself, so the premise cannot expire silently a second time.
 */

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(async () => undefined),
  findItemByColumn: vi.fn(async () => [] as any[]), getBoardItems: vi.fn(async () => [] as any[]),
  getItem: vi.fn(async () => null), getUsersByEmail: vi.fn(async () => ({})),
  moveItem: vi.fn(), setColumns: vi.fn(), updateItem: vi.fn(),
}));
// Exactly the surface sync.ts imports — an omission here fails as "No export is defined on the mock",
// which reads like a routing failure and is not one.
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), patchRecord: vi.fn(),
  getCrmStageDicts: vi.fn(async () => ({})), getDealStageLabels: vi.fn(async () => ({})),
  getOwners: vi.fn(async () => [] as any[]), getPropertyOptions: vi.fn(async () => ({})),
  getRecord: vi.fn(async () => null), searchCompanyByDomain: vi.fn(async () => null),
  propertiesForSpec: vi.fn(() => ["dealname"]), searchAll: vi.fn(async () => []),
  searchContactByEmail: vi.fn(async () => null), searchModifiedIds: vi.fn(async () => [] as string[]),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(async () => null), rememberCard: vi.fn(), forgetCard: vi.fn(),
  lookupCardOwner: vi.fn(async () => null), rememberCardOwner: vi.fn(), forgetCardOwner: vi.fn(),
  finishCard: vi.fn(), claimCard: vi.fn(), claimHubspotForItem: vi.fn(),
}));

vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/card-registry", () => registry);
// syncHubspotRecord runs the association pass; it is not what these tests are about.
vi.mock("../src/associations", () => ({
  syncAssociations: vi.fn(async () => undefined),
  reverseAssociations: vi.fn(async () => undefined),
}));

const { deleteHubspotObject, legacyDealRouting, syncHubspotObject } = await import("../src/sync");
const { DEALS } = await import("../src/config");
const { CRM_DEALS } = await import("../src/config/crm");

const WM_BOARD = "5029480547";
const CRM_BOARD = "5028000494";

const wmEnv = {} as Env;                                   // ENABLE_CRM unset -> Work Management
const crmEnv = { ENABLE_CRM: "true" } as unknown as Env;   // -> CRM

const opts = { dryRun: false, maxWrites: 50 } as unknown as RunOpts;
const budget = (): Budget => ({ left: 50 });

beforeEach(() => { vi.clearAllMocks(); monday.findItemByColumn.mockResolvedValue([]); });

describe("the boards are not the same board", () => {
  it("WM Deals and CRM Deals are genuinely different boards", () => {
    expect(DEALS.boardId).toBe(WM_BOARD);
    expect(CRM_DEALS.boardId).toBe(CRM_BOARD);
    expect(DEALS.boardId).not.toBe(CRM_DEALS.boardId);
  });
});

describe("legacyDealRouting is the discriminator, and it is deployment-shaped", () => {
  it("is TRUE for the Work-Management deployment", () => {
    expect(legacyDealRouting(wmEnv)).toBe(true);
  });

  it("is FALSE for the CRM deployment, even though a deals spec exists there", () => {
    expect(legacyDealRouting(crmEnv)).toBe(false);
  });

  /** The bug was precisely that "a deals spec exists" was mistaken for "use the WM path". */
  it("distinguishes 'has a deals spec' from 'uses the multi-board path'", async () => {
    const { specByObject } = await import("../src/config");
    expect(specByObject(crmEnv, "deals")).toBeDefined();      // it DOES exist...
    expect(legacyDealRouting(crmEnv)).toBe(false);            // ...and must still not route to WM
  });

  it("survives CRM_CUTOVER_AT, which makes specsFor return COPIES rather than the originals", () => {
    const withCutover = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-16T11:16:48Z" } as unknown as Env;
    // a reference comparison would be unsafe here; boardId is not
    expect(legacyDealRouting(withCutover)).toBe(false);
  });
});

describe("a HubSpot deal DELETION", () => {
  it("on the CRM deployment, searches the CRM board and NEVER the WM board", async () => {
    await deleteHubspotObject(crmEnv, "deal", "77", opts, budget());
    const boards = (monday.findItemByColumn.mock.calls as any[][]).map(c => c[1]);
    expect(boards).not.toContain(WM_BOARD);
    if (boards.length) expect(boards).toContain(CRM_BOARD);
  });

  it("on the CRM deployment, deletes nothing when no CRM card is linked", async () => {
    const r = await deleteHubspotObject(crmEnv, "deal", "77", opts, budget());
    expect(monday.deleteItem).not.toHaveBeenCalled();
    expect(r).toContain("no linked monday card");
  });

  it("on the CRM deployment, deletes the CRM card when one IS linked", async () => {
    monday.findItemByColumn.mockResolvedValue([{ id: "999" }] as any);
    await deleteHubspotObject(crmEnv, "deal", "77", opts, budget());
    expect(monday.deleteItem).toHaveBeenCalledWith(crmEnv, "999", opts);
  });

  it("on the WM deployment, still uses the multi-board deal search — behaviour is unchanged", async () => {
    await deleteHubspotObject(wmEnv, "deal", "77", opts, budget());
    expect((monday.findItemByColumn.mock.calls as any[][]).map(c => c[1])).toContain(WM_BOARD);
  });

  it("a CRM deal deletion cannot consume budget against the WM board", async () => {
    const b = budget();
    await deleteHubspotObject(crmEnv, "deal", "77", opts, b);
    expect(b.left).toBe(50);
    expect(monday.deleteItem).not.toHaveBeenCalled();
  });
});

describe("a HubSpot deal UPDATE", () => {
  it("on the CRM deployment, fetches with the CRM spec's properties, not the WM spec's", async () => {
    await syncHubspotObject(crmEnv, "deal", "77", opts, budget());
    // syncHubspotRecord asks propertiesForSpec(spec) — prove it was handed the CRM spec
    const specs = (hubspot.propertiesForSpec.mock.calls as any[][]).map(c => c[0]?.boardId);
    expect(specs).not.toContain(WM_BOARD);
    expect(specs).toContain(CRM_BOARD);
  });

  it("on the CRM deployment, reads the deal through the generic single-board path", async () => {
    await syncHubspotObject(crmEnv, "deal", "77", opts, budget());
    // getRecord is reached with the object name; the WM path would have used propertiesForSpec(DEALS)
    expect(hubspot.getRecord).toHaveBeenCalled();
    expect((hubspot.getRecord.mock.calls as any[][])[0][1]).toBe("deals");
  });

  it("on the WM deployment, still routes through the pipeline-aware deal path", async () => {
    await syncHubspotObject(wmEnv, "deal", "77", opts, budget());
    const specs = (hubspot.propertiesForSpec.mock.calls as any[][]).map(c => c[0]?.boardId);
    expect(specs).toContain(WM_BOARD);
    expect(specs).not.toContain(CRM_BOARD);
  });
});

describe("the other objects are untouched by this change", () => {
  it.each([["contact", "5028000495"], ["company", "5028000496"]] as const)(
    "a CRM %s still resolves to its own board", async (objectType, board) => {
      await syncHubspotObject(crmEnv, objectType, "77", opts, budget());
      const specs = (hubspot.propertiesForSpec.mock.calls as any[][]).map(c => c[0]?.boardId);
      expect(specs).toContain(board);
      expect(specs).not.toContain(WM_BOARD);
    });

  it.each([["contact", "5029639630"], ["company", "5029639440"]] as const)(
    "a WM %s still resolves to its own board", async (objectType, board) => {
      await syncHubspotObject(wmEnv, objectType, "77", opts, budget());
      const specs = (hubspot.propertiesForSpec.mock.calls as any[][]).map(c => c[0]?.boardId);
      expect(specs).toContain(board);
    });

  it("a CRM contact deletion never touches a WM board", async () => {
    await deleteHubspotObject(crmEnv, "contact", "77", opts, budget());
    const boards = (monday.findItemByColumn.mock.calls as any[][]).map(c => c[1]);
    expect(boards).toEqual(["5028000495"]);
  });
});
