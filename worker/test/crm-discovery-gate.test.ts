import { describe, it, expect, vi, beforeEach } from "vitest";
import { mayCreateCrmCard, canClaimCrmOwnership } from "../src/ownership";
import { DEALS, CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";
import type { HsRecord, ObjectSpec, OwnershipSpec, RunOpts } from "../src/types";

/**
 * TASK 3B — the no-historical-import gate at the monday card-creation chokepoint.
 *
 * Why it exists: the Task 3 guard protects the two HUBSPOT mutation chokepoints. Creating a monday card
 * writes to MONDAY, so it never passes through them, and CRM specs set `includeAll: true` which
 * short-circuits recInScope to true. Without this gate an unstamped 2024 record with no card reaches
 * createItem the moment anything touches it.
 */

const CUT = Date.parse("2026-10-01T00:00:00Z");
const own: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: CUT };
const rec = (p: Record<string, string>): HsRecord => ({ id: "1", properties: p });

const PRE = "2024-03-01T00:00:00Z";     // historical
const POST = "2026-11-01T00:00:00Z";    // after cutover

describe("mayCreateCrmCard — the six required rules", () => {
  it("no ownership on the spec -> legacy WM behaviour, always allowed", () => {
    expect(mayCreateCrmCard(rec({}), undefined)).toBe(true);
    expect(mayCreateCrmCard(rec({ createdate: PRE }), undefined)).toBe(true);
  });

  it("sync_owner=crm -> may create", () =>
    expect(mayCreateCrmCard(rec({ sync_owner: "crm", createdate: PRE }), own)).toBe(true));

  // The 771-record case: no sales_user anywhere in this decision.
  it("unstamped + post-cutover -> may create, with no sales_user present", () =>
    expect(mayCreateCrmCard(rec({ createdate: POST }), own)).toBe(true));

  it("unstamped + PRE-cutover -> MUST NOT be imported", () =>
    expect(mayCreateCrmCard(rec({ createdate: PRE }), own)).toBe(false));

  it("sync_owner=wm -> no CRM card even post-cutover", () =>
    expect(mayCreateCrmCard(rec({ sync_owner: "wm", createdate: POST }), own)).toBe(false));

  it("unrecognised stamp -> hands off", () => {
    for (const s of ["hold", "HOLD", "manual", "x"])
      expect(mayCreateCrmCard(rec({ sync_owner: s, createdate: POST }), own)).toBe(false);
  });

  it("case and whitespace are normalised, not treated as unknown", () => {
    expect(mayCreateCrmCard(rec({ sync_owner: " CRM " }), own)).toBe(true);
    expect(mayCreateCrmCard(rec({ sync_owner: "WM", createdate: POST }), own)).toBe(false);
  });
});

describe("mayCreateCrmCard — fail-closed on bad metadata", () => {
  it("missing createdate -> refuse (a forgotten fetch must not import the portal)", () =>
    expect(mayCreateCrmCard(rec({}), own)).toBe(false));

  it.each(["", "   ", "not-a-date", "1e21", "99999999999999999999"])(
    "unusable createdate %j -> refuse", (d) =>
      expect(mayCreateCrmCard(rec({ createdate: d }), own)).toBe(false));

  it("exactly AT the cutover is post-cutover (>=, matching canClaimCrmOwnership)", () =>
    expect(mayCreateCrmCard(rec({ createdate: new Date(CUT).toISOString() }), own)).toBe(true));

  it("one millisecond before the cutover is historical", () =>
    expect(mayCreateCrmCard(rec({ createdate: new Date(CUT - 1).toISOString() }), own)).toBe(false));

  it("the inert Phase-1 cutover creates nothing at all", () => {
    const inert = { ...own, cutoverAtMs: Number.POSITIVE_INFINITY };
    expect(mayCreateCrmCard(rec({ createdate: POST }), inert)).toBe(false);
    expect(mayCreateCrmCard(rec({ sync_owner: "crm" }), inert)).toBe(true);  // an explicit stamp still wins
  });
});

// ONE rule, not two. If these ever disagree, a record could be carded but never claimable (or the
// reverse), which is the split-brain the whole ownership design exists to prevent.
describe("mayCreateCrmCard agrees with canClaimCrmOwnership on the unstamped case", () => {
  it.each([PRE, POST, "", "bad"])("createdate %j", (d) => {
    const r = rec(d ? { createdate: d } : {});
    expect(mayCreateCrmCard(r, own)).toBe(canClaimCrmOwnership(r, own));
  });
});

// ---------------------------------------------------------------------------------------------
// THE CHOKEPOINT ITSELF. A refusal must be proven by the ABSENCE of the monday write.
// ---------------------------------------------------------------------------------------------

const crmSpec: ObjectSpec = {
  ...DEALS, object: "contacts", boardId: "CRMB", idCol: "c_id", syncStateCol: "c_sync",
  groupBy: { singleGroup: "topics" }, includeAll: true, createFromMonday: false,
  fields: [], associations: undefined, ownership: own,
};
const wmSpec: ObjectSpec = { ...crmSpec, boardId: "WMB", ownership: undefined, includeAll: false };

const ctx = {
  labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {},
  portalId: 1,
} as never;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 10 };

// Stub the three collaborators ensureCardForRecord uses, so "did a card get created?" is observable.
const monday = vi.hoisted(() => ({ createItem: vi.fn(), findItemByColumn: vi.fn(), getItem: vi.fn() }));
const registry = vi.hoisted(() => ({ claimCard: vi.fn(), finishCard: vi.fn(), forgetCard: vi.fn() }));

vi.mock("../src/monday", () => ({
  createItem: monday.createItem, findItemByColumn: monday.findItemByColumn, getItem: monday.getItem,
}));
vi.mock("../src/card-registry", () => ({
  claimCard: registry.claimCard, finishCard: registry.finishCard, forgetCard: registry.forgetCard,
}));

const { ensureCardForRecord, cardIdOf } = await import("../src/ensure-card");

beforeEach(() => {
  vi.clearAllMocks();
  registry.claimCard.mockResolvedValue({ status: "reserved" });   // no existing card
  registry.finishCard.mockResolvedValue(undefined);
  registry.forgetCard.mockResolvedValue(undefined);
  monday.findItemByColumn.mockResolvedValue([]);                  // nothing found by column search
  monday.createItem.mockResolvedValue("ITEM1");
});

describe("ensureCardForRecord — the gate fires before any monday write", () => {
  it("REFUSES a pre-cutover unstamped record and creates NOTHING", async () => {
    const r = await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: PRE }), live);
    // "refused", not "skipped": Task 10 split the TERMINAL refusal from transient contention so
    // /app/ensure-card can answer 422 non-retryable instead of 409 "retry shortly".
    expect(r.status).toBe("refused");
    expect(monday.createItem).not.toHaveBeenCalled();
  });

  it("releases the reservation on refusal, so the record is not wedged as 'creating'", async () => {
    await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: PRE }), live);
    expect(registry.forgetCard).toHaveBeenCalledTimes(1);
    expect(registry.finishCard).not.toHaveBeenCalled();
  });

  it("REFUSES a wm-stamped record", async () => {
    const r = await ensureCardForRecord({} as never, crmSpec, ctx, rec({ sync_owner: "wm", createdate: POST }), live);
    expect(r.status).toBe("refused");
    expect(monday.createItem).not.toHaveBeenCalled();
  });

  it("REFUSES a record parked with an unrecognised stamp", async () => {
    const r = await ensureCardForRecord({} as never, crmSpec, ctx, rec({ sync_owner: "hold", createdate: POST }), live);
    expect(r.status).toBe("refused");
    expect(monday.createItem).not.toHaveBeenCalled();
  });

  it("CREATES for a post-cutover record with no sales_user", async () => {
    const r = await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: POST }), live);
    expect(r.status).toBe("created");
    expect(monday.createItem).toHaveBeenCalledTimes(1);
  });

  // RULE 4: an already-adopted historical card must keep receiving forward updates. The gate sits
  // AFTER the adopt-by-column-search, so an existing card short-circuits before the gate is consulted.
  it("an ADOPTED pre-cutover record still resolves its existing card (updates keep flowing)", async () => {
    monday.findItemByColumn.mockResolvedValue([{ id: "ADOPTED" }]);
    const r = await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: PRE }), live);
    expect(r).toEqual({ status: "existing", itemId: "ADOPTED" });
    expect(monday.createItem).not.toHaveBeenCalled();
  });

  it("a registry-known pre-cutover card is returned, not refused", async () => {
    registry.claimCard.mockResolvedValue({ status: "have", itemId: "KNOWN" });
    monday.getItem.mockResolvedValue({ id: "KNOWN" });
    const r = await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: PRE }), live);
    expect(r).toEqual({ status: "existing", itemId: "KNOWN" });
  });

  // WM REGRESSION GUARD.
  it("a spec WITHOUT ownership creates exactly as before, whatever the dates", async () => {
    for (const d of [PRE, POST, ""]) {
      vi.clearAllMocks();
      registry.claimCard.mockResolvedValue({ status: "reserved" });
      monday.findItemByColumn.mockResolvedValue([]);
      monday.createItem.mockResolvedValue("ITEM1");
      const r = await ensureCardForRecord({} as never, wmSpec, ctx, rec(d ? { createdate: d } : {}), live);
      expect(r.status).toBe("created");
      expect(monday.createItem).toHaveBeenCalledTimes(1);
    }
  });

  it("PRODUCTION specs declare no ownership, so none of them can be gated", () => {
    for (const s of [DEALS, CONTACTS_MYLA, COMPANIES_MYLA]) expect(s.ownership).toBeUndefined();
  });
});

// Every caller receives EnsureCard, so a refusal is only safe if each handles it without crashing,
// looping, or dereferencing null. cardIdOf is the shared adapter three of them use.
describe("refusal is safe for every caller shape", () => {
  it("cardIdOf maps a refusal to null rather than throwing", () =>
    expect(cardIdOf({ status: "skipped" })).toBeNull());

  it("a refusal is never reported as created/existing, so no caller miscounts it", async () => {
    const r = await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: PRE }), live);
    expect(r.status).not.toBe("created");
    expect(r.status).not.toBe("existing");
    expect("itemId" in r).toBe(false);   // nothing to dereference
  });

  it("a refusal issues no HubSpot call — the gate is monday-side only", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;
    await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: PRE }), live);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Repeated refusal is stable: same answer, still no write, no growing state. A poll that keeps
  // rediscovering a historical record therefore cannot become a retry storm.
  it("refusing repeatedly is idempotent and never escalates", async () => {
    for (let i = 0; i < 5; i++)
      expect((await ensureCardForRecord({} as never, crmSpec, ctx, rec({ createdate: PRE }), live)).status)
        .toBe("refused");
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(registry.forgetCard).toHaveBeenCalledTimes(5);
  });
});
