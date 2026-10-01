import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Budget, Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts } from "../src/types";

/**
 * THE WIRING, NOT THE HELPER.
 *
 * `association-via.test.ts` proves getAssociatedVia behaves correctly and `crm-line-item-account.test.ts`
 * proves the spec is shaped correctly. Neither proves the two are CONNECTED, and mutation testing showed
 * exactly that hole: dropping `a.viaPrimary` from the call site in syncAssociations — a type-clean,
 * one-token edit that in production links BOTH Accounts on every multi-company deal — left all 1,758
 * tests green. So did deleting the `if (a.via) continue;` guard in reverseAssociations, and so did
 * removing the feature entirely.
 *
 * These tests exist to kill those three mutants. Each one should fail loudly if the call site drifts.
 *
 * SINCE 2026-09-28 the guard has two forms. The whole-cell pass (WM, drawer save) still skips a derived
 * entry outright. The column-level edit path DISPATCHES it to fillDealCompany instead, which can only
 * ever write deal -> company and otherwise snaps the cell back; that dispatch is pinned at the bottom.
 */

const hubspot = vi.hoisted(() => ({
  getAssociatedVia: vi.fn(async () => ({ ids: ["555"], truncated: false })),
  getAssociatedPage: vi.fn(async () => ({ ids: ["555"], truncated: false })),
  getAssociatedIds: vi.fn(async () => ["555"]),
  getRecord: vi.fn(async () => null), getRecordsByIds: vi.fn(async () => []),
  propertiesForSpec: vi.fn(() => []), putAssociation: vi.fn(),
  createLineItem: vi.fn(), patchLineItem: vi.fn(),
  putAssociationTypes: vi.fn(), deleteAssociation: vi.fn(),
  getAllAssociatedIds: vi.fn(async () => ({ ids: ["88"], truncated: false })),
}));
const monday = vi.hoisted(() => ({
  findItemIdsByColumn: vi.fn(async () => ({ "555": "card-555" })),
  getItemsColumnText: vi.fn(async () => ({ "card-555": "555" })),
  getLinkedItemIds: vi.fn(async () => ["card-555"]),
  setColumns: vi.fn(), updateItem: vi.fn(), createItem: vi.fn(), deleteItem: vi.fn(),
  getItem: vi.fn(async () => null), getSubitems: vi.fn(async () => []),
  createSubitem: vi.fn(), getParentItemId: vi.fn(async () => null),
  getItemStates: vi.fn(async (_e: unknown, ids: string[]) => Object.fromEntries(ids.map(i => [i, "active"]))),
}));
const writeAuth = vi.hoisted(() => ({
  ensureHubspotWriteAuth: vi.fn(async () => ({ allowed: true, reason: "test", forId: "77" })),
}));

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/write-auth", () => writeAuth);
vi.mock("../src/ensure-card", () => ({
  ensureCardForRecord: vi.fn(async () => ({ status: "exists", cardId: "card-555" })),
  cardIdOf: vi.fn((r: any) => r?.cardId ?? null),
}));

const { syncAssociations, reverseAssociations } = await import("../src/associations");
const { CRM_LINE_ITEMS } = await import("../src/config/crm");

const env = { ENABLE_CRM: "true" } as unknown as Env;
const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, portalId: 1 } as unknown as Ctx;
const opts = { dryRun: false, maxWrites: 50 } as unknown as RunOpts;
const budget = (): Budget => ({ left: 50 });
const rec = { id: "77", properties: {} } as HsRecord;
const item = { id: "card-77", name: "li", column_values: [] } as unknown as MondayItem;

const companiesAssoc = () => CRM_LINE_ITEMS.associations!.find(a => a.toObject === "companies")!;

beforeEach(() => vi.clearAllMocks());

describe("the forward pass actually uses the derived read", () => {
  it("calls getAssociatedVia for the companies entry — not the plain single-leg read", async () => {
    await syncAssociations(env, CRM_LINE_ITEMS, rec, item, ctx, opts, budget());
    expect(hubspot.getAssociatedVia).toHaveBeenCalled();
    const call = (hubspot.getAssociatedVia.mock.calls as any[][])
      .find(c => c[4] === "companies" || c[3] === "companies");
    expect(call, "no getAssociatedVia call targeted companies").toBeDefined();
  });

  /** MUTANT A: `getAssociatedVia(env, spec.object, rec.id, a.via, a.toObject)` — viaPrimary dropped.
   *  primaryOnly then defaults to false and every multi-company deal links BOTH Accounts. */
  it("passes viaPrimary through, so the Primary tie-break is actually armed", async () => {
    await syncAssociations(env, CRM_LINE_ITEMS, rec, item, ctx, opts, budget());
    const call = (hubspot.getAssociatedVia.mock.calls as any[][])[0];
    expect(call, "getAssociatedVia was never called").toBeDefined();
    expect(call[5], "viaPrimary was not forwarded to getAssociatedVia").toBe(true);
    expect(call[5]).toBe(companiesAssoc().viaPrimary);
  });

  it("passes the hop object and the target object in the right order", async () => {
    await syncAssociations(env, CRM_LINE_ITEMS, rec, item, ctx, opts, budget());
    const call = (hubspot.getAssociatedVia.mock.calls as any[][])[0];
    expect(call[1]).toBe("line_items");   // fromObject
    expect(call[2]).toBe("77");           // record id
    expect(call[3]).toBe("deals");        // via
    expect(call[4]).toBe("companies");    // toObject
  });

  /** MUTANT B: collapse the ternary back to getAssociatedPage — the feature silently disappears. */
  it("does NOT use the plain association read for the derived entry", async () => {
    await syncAssociations(env, CRM_LINE_ITEMS, rec, item, ctx, opts, budget());
    const plainTargets = (hubspot.getAssociatedPage.mock.calls as any[][]).map(c => c[3]);
    expect(plainTargets, "companies was read with the single-leg helper").not.toContain("companies");
  });

  it("still uses the plain read for the ordinary Deal association", async () => {
    await syncAssociations(env, CRM_LINE_ITEMS, rec, item, ctx, opts, budget());
    expect((hubspot.getAssociatedPage.mock.calls as any[][]).map(c => c[3])).toContain("deals");
  });
});

describe("the derived link can never be written back to HubSpot", () => {
  /** MUTANT C: delete `if (a.via) continue;` from reverseAssociations. HubSpot defines no
   *  line_item -> company association type, so the PUT is not merely wrong, it cannot succeed. */
  it("reverseAssociations issues NO putAssociation for the derived companies entry", async () => {
    await reverseAssociations(env, CRM_LINE_ITEMS, rec, item, opts, budget());
    for (const call of (hubspot.putAssociation.mock.calls as any[][]))
      expect(JSON.stringify(call)).not.toContain("companies");
  });

  it("never even READS the monday relation column of a derived association", async () => {
    // getLinkedItemIds is the first thing the reverse loop does per entry; reaching it for the derived
    // entry would mean the `continue` is gone, whatever happens afterwards.
    await reverseAssociations(env, CRM_LINE_ITEMS, rec, item, opts, budget());
    const cols = (monday.getLinkedItemIds.mock.calls as any[][]).map(c => c[2]);
    expect(cols).not.toContain(companiesAssoc().relationCol);
  });

  it("the guard is keyed on `via`, so any future derived association is covered too", async () => {
    const synthetic = {
      ...CRM_LINE_ITEMS,
      associations: [{ toObject: "contacts" as const, nameProps: ["firstname"],
        relationCol: "some_relation_col", via: "deals" as const }],
    } as ObjectSpec;
    await reverseAssociations(env, synthetic, rec, item, opts, budget());
    expect((monday.getLinkedItemIds.mock.calls as any[][]).map(c => c[2]))
      .not.toContain("some_relation_col");
  });

  it("a NON-derived association is still reversed — the guard must not disable everything", async () => {
    const plainSpec = {
      ...CRM_LINE_ITEMS,
      associations: [{ toObject: "deals" as const, nameProps: ["dealname"],
        relationCol: "board_relation_mm76w9y5" }],
    } as ObjectSpec;
    await reverseAssociations(env, plainSpec, rec, item, opts, budget());
    expect((monday.getLinkedItemIds.mock.calls as any[][]).map(c => c[2]))
      .toContain("board_relation_mm76w9y5");
  });
});

/**
 * THE EDIT PATH: a person's edit of the derived cell reaches fillDealCompany, never the generic reverse.
 * MUTANT D: replace the dispatch with the generic unlink/add steps -- they would PUT or DELETE
 * line_items <-> companies. MUTANT E: drop the dispatch back to a bare `continue` -- the refused edit would
 * no longer snap back, and the cell would keep showing an Account HubSpot does not derive.
 */
describe("the column-level edit path dispatches the derived entry", () => {
  const col = () => companiesAssoc().relationCol!;
  const personEdit = (env: Env, spec: ObjectSpec = CRM_LINE_ITEMS, c = col()) =>
    reverseAssociations(env, spec, rec, item, opts, budget(), {
      onlyCols: new Set([c]), basis: "human-edit", linked: { [c]: ["card-555"] }, unlinked: { [c]: ["card-9"] } });

  it("no generic write of any kind for the derived entry, in either direction", async () => {
    await personEdit(env);
    for (const f of [hubspot.putAssociation, hubspot.deleteAssociation])
      for (const call of f.mock.calls as any[][]) expect(JSON.stringify(call)).not.toContain("companies");
    expect(hubspot.putAssociationTypes).not.toHaveBeenCalled();     // flag off in this env
  });

  it("the refused edit is snapped back from the DERIVED read (line item -> deal -> company)", async () => {
    await personEdit(env);
    expect(hubspot.getAssociatedVia).toHaveBeenCalledWith(env, "line_items", "77", "deals", "companies", true);
  });

  it("a future derived shape is refused by fillDealCompany even with the flag on", async () => {
    const synthetic = { ...CRM_LINE_ITEMS, associations: [{ toObject: "contacts" as const,
      nameProps: ["firstname"], relationCol: "some_relation_col", via: "deals" as const }] } as ObjectSpec;
    await personEdit({ ...env, PS_ACCOUNT_REVERSE: "true" } as Env, synthetic, "some_relation_col");
    expect(hubspot.putAssociationTypes).not.toHaveBeenCalled();
    expect(hubspot.putAssociation).not.toHaveBeenCalled();
    expect(hubspot.deleteAssociation).not.toHaveBeenCalled();
  });
});

describe("a refused read must not reach the relation writer", () => {
  it("a truncated derived read writes nothing", async () => {
    hubspot.getAssociatedVia.mockResolvedValueOnce({ ids: [], truncated: true } as any);
    await syncAssociations(env, CRM_LINE_ITEMS, rec, item, ctx, opts, budget());
    // syncRelationColumn returns before resolving cards when truncated; findItemIdsByColumn is the
    // first thing it would do for the companies target.
    const boards = (monday.findItemIdsByColumn.mock.calls as any[][]).map(c => c[1]);
    expect(boards).not.toContain("5028000496");
  });
});
