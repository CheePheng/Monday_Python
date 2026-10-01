import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Ctx, Env, HsRecord, MondayItem } from "../src/types";
import { CRM_CONTACTS, CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";

/**
 * FIXES FROM THE SECOND ADVERSARIAL REVIEW (2026-09-24), each proven by behaviour:
 *   1. an emptied People cell clears HubSpot only when the person removed WAS HubSpot's owner;
 *      a team-only cell is refused;
 *   2. the removed people reach the engine from monday's before/after, across coalesced events;
 *   3. on CRM every line item in a batch becomes an event (none cut before the overflow spill), and a
 *      HubSpot line-item DELETION is dispatched as a delete;
 *   4. an activity reservation never expires (a later trigger must take it over as stale and check);
 *   5. a monday reply that carries a result is never treated as rate-limited;
 *   6. currency reverses only for codes this portal uses.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));

const captured = vi.hoisted(() => ({ mondayEdits: [] as any[], hsEvents: [] as any[], gate: null as null | Promise<void> }));
vi.mock("../src/sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/sync")>();
  return {
    ...real,
    syncMondayItem: vi.fn(async (_e: any, _b: any, _i: any, _o: any, _bu: any, _app: any, _self: any, edit: any) => {
      captured.mondayEdits.push(edit);
      if (captured.gate) await captured.gate;
      return "ok";
    }),
    syncHubspotObject: vi.fn(async (_e: any, type: string, id: string) => { captured.hsEvents.push({ type, id, deleted: false }); return "ok"; }),
    deleteHubspotObject: vi.fn(async (_e: any, type: string, id: string) => { captured.hsEvents.push({ type, id, deleted: true }); return "ok"; }),
  };
});
vi.mock("../src/actor-label", () => ({
  actorLabel: async () => "user=test", isAutomationActor: () => false, isIntegrationActor: async () => false,
}));

const { handleMonday, handleHubspot, removedPersonIds } = await import("../src/webhooks");
const { columnEditPatch, reverseFieldValue } = await import("../src/reconcile");
const { CreateIdempotency } = await import("../src/create-idempotency-do");

const crmEnv = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-16T11:16:48Z" } as unknown as Env;
const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const SALES_USER = CRM_CONTACTS.fields.find(f => f.hs === "sales_user" && f.type === "people")!.col;
const MYLA = { owner: "1739141284", monday: "102443183", email: "mylamestiola@dkmeco.com" };
const ELAINE = { owner: "165857269", monday: "102444897", email: "elainerivera@dkmeco.com" };

beforeEach(() => { captured.mondayEdits = []; captured.hsEvents = []; captured.gate = null; waits.length = 0; });

// ------------------------------------------------------------------------------ 1. the clear rule
describe("an emptied People cell clears HubSpot only when HubSpot's owner was the one removed", () => {
  const ctx = {
    labels: {}, ownersById: { [MYLA.owner]: { email: MYLA.email }, [ELAINE.owner]: { email: ELAINE.email } },
    mondayUsersByEmail: { [MYLA.email]: MYLA.monday, [ELAINE.email]: ELAINE.monday }, ownerIdByEmail: {},
  } as unknown as Ctx;
  const rec = (salesUser: string): HsRecord => ({ id: "1", properties: { sales_user: salesUser } });
  const item = (pt: { id: string; kind: string }[]): MondayItem => ({ id: "C", name: "x", created_at: "", updated_at: "",
    group: { id: "topics" }, column_values: [{ id: SALES_USER, text: pt.length ? "x" : "", persons_and_teams: pt as any }] });

  it("STALE cell: it showed Myla, HubSpot had Elaine; removing Myla does not erase Elaine -- the cell heals", () => {
    const r = columnEditPatch(rec(ELAINE.owner), item([]), CRM_CONTACTS, ctx,
      { cols: [SALES_USER], removedPeople: { [SALES_USER]: [MYLA.monday] } });
    expect(r.patch).toEqual({});
    expect(r.heal.map(f => f.col)).toEqual([SALES_USER]);
  });

  it("removing the person HubSpot actually has clears it", () => {
    const r = columnEditPatch(rec(ELAINE.owner), item([]), CRM_CONTACTS, ctx,
      { cols: [SALES_USER], removedPeople: { [SALES_USER]: [ELAINE.monday] } });
    expect(r.patch).toEqual({ sales_user: "" });
  });

  it("a TEAM left in the cell is refused and healed, never read as a clear", () => {
    const r = columnEditPatch(rec(ELAINE.owner), item([{ id: "555", kind: "team" }]), CRM_CONTACTS, ctx,
      { cols: [SALES_USER], removedPeople: { [SALES_USER]: [ELAINE.monday] } });
    expect(r.patch).toEqual({});
    expect(r.refusals.join()).toMatch(/team/);
  });

  it("without monday's before-side, the displayable-owner rule applies as before", () => {
    expect(columnEditPatch(rec(ELAINE.owner), item([]), CRM_CONTACTS, ctx, { cols: [SALES_USER] }).patch)
      .toEqual({ sales_user: "" });
    expect(columnEditPatch(rec("465759285"), item([]), CRM_CONTACTS, ctx, { cols: [SALES_USER] }).patch)
      .toEqual({});                                   // seatless owner: still never cleared
  });
});

// ------------------------------------------------------------------------------ 2. the plumbing
describe("removed people reach the engine from monday's before/after", () => {
  it("parses monday's People values, including every emptied shape", () => {
    const p = (...ids: string[]) => ({ personsAndTeams: ids.map(id => ({ id: Number(id), kind: "person" })) });
    expect(removedPersonIds({ previousValue: p("1", "2"), value: p("2") })).toEqual(["1"]);
    for (const emptied of [null, {}, { changed_at: "x" }])
      expect(removedPersonIds({ previousValue: p("1"), value: emptied })).toEqual(["1"]);
    expect(removedPersonIds({ value: p("1") })).toBeNull();                       // no before-side
    expect(removedPersonIds({ previousValue: { personsAndTeams: [{ id: 9, kind: "team" }] }, value: {} })).toEqual([]);
  });

  const fire = (ev: Record<string, unknown>) => handleMonday(new Request("https://w/webhooks/monday", {
    method: "POST", body: JSON.stringify({ event: { boardId: CRM_CONTACTS.boardId, pulseId: 777, type: "update_column_value",
      columnId: SALES_USER, userId: 104231431, ...ev } }) }), crmEnv, ectx);

  it("one event: the engine is told who was removed", async () => {
    await fire({ previousValue: { personsAndTeams: [{ id: Number(MYLA.monday), kind: "person" }] }, value: {} });
    await Promise.all(waits);
    expect(captured.mondayEdits[0].removedPeople).toEqual({ [SALES_USER]: [MYLA.monday] });
  });

  it("an event with no before-side sends no removedPeople (the fallback rule)", async () => {
    await fire({ value: {} });
    await Promise.all(waits);
    expect(captured.mondayEdits[0].removedPeople).toBeUndefined();
  });

  it("a coalesced re-run sees the removals that arrived while the first run was in flight", async () => {
    let release!: () => void;
    captured.gate = new Promise<void>(r => { release = r; });
    await fire({ previousValue: { personsAndTeams: [{ id: Number(MYLA.monday), kind: "person" }] }, value: {} });
    await new Promise(r => setTimeout(r, 0));
    await fire({ previousValue: { personsAndTeams: [{ id: Number(ELAINE.monday), kind: "person" }] }, value: {} });
    captured.gate = null; release();
    await Promise.all(waits);
    expect(captured.mondayEdits.map(e => e.removedPeople[SALES_USER])).toEqual([[MYLA.monday], [ELAINE.monday]]);
  });
});

// ------------------------------------------------------------------------------ 3. line items on CRM
describe("line items on the CRM Worker", () => {
  const fire = (events: unknown[]) => handleHubspot(new Request("https://w/webhooks/hubspot", {
    method: "POST", body: JSON.stringify(events) }), crmEnv, ectx);

  it("a HubSpot line-item DELETION is dispatched as a delete, so its P&S card is removed", async () => {
    await fire([{ subscriptionType: "object.deletion", objectTypeId: "0-8", objectId: 9956357489 }]);
    await Promise.all(waits);
    expect(captured.hsEvents).toEqual([{ type: "line_item", id: "9956357489", deleted: true }]);
  });

  it("an edit is still a sync", async () => {
    await fire([{ subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 1, propertyName: "quantity" }]);
    await Promise.all(waits);
    expect(captured.hsEvents).toEqual([{ type: "line_item", id: "1", deleted: false }]);
  });

  it("40 line items: 15 run now, and the other 25 are NOT cut before the overflow spill", async () => {
    const spilled: any[] = [];
    const env = { ...crmEnv, DEFERRED_SYNC: { idFromName: (n: string) => n,
      get: () => ({ enqueue: async (items: any[]) => { spilled.push(...items); return { queued: items.length, duplicate: 0, dropped: 0, depth: items.length }; } }) } } as unknown as Env;
    await handleHubspot(new Request("https://w/webhooks/hubspot", { method: "POST",
      body: JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ subscriptionType: "object.propertyChange",
        objectTypeId: "0-8", objectId: 1000 + i, propertyName: "price" }))) }), env, ectx);
    await Promise.all(waits);
    expect(captured.hsEvents).toHaveLength(15);
    expect(spilled).toHaveLength(25);
    expect(spilled.every(s => s.type === "line_item")).toBe(true);
  });
});

// ------------------------------------------------------------------------------ 4. reservations
describe("an activity reservation never expires; a card reservation still does", () => {
  function doState() {
    const map = new Map<string, any>(); let alarm: number | null = null;
    const ctx = { storage: {
      get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
      delete: async (k: string) => { map.delete(k); }, deleteAll: async () => { map.clear(); },
      setAlarm: async (t: number) => { alarm = t; }, deleteAlarm: async () => { alarm = null; },
    }, blockConcurrencyWhile: async (fn: () => any) => fn() };
    return { d: new (CreateIdempotency as any)(ctx, {}), alarm: () => alarm };
  }

  it("retain: no cleanup alarm, so a takeover days later still knows it is stale and checks the card", async () => {
    const s = doState();
    const T0 = Date.parse("2026-09-24T00:00:00Z");
    expect(await s.d.claimCard(T0, 15 * 60_000, true)).toEqual({ status: "proceed", tookOverStale: false });
    expect(s.alarm()).toBeNull();
    const later = await s.d.claimCard(T0 + 3 * 24 * 3_600_000, 15 * 60_000, true);
    expect(later).toEqual({ status: "proceed", tookOverStale: true });
  });

  it("the card registry keeps its 24h cleanup", async () => {
    const s = doState();
    const T0 = Date.parse("2026-09-24T00:00:00Z");
    await s.d.claimCard(T0);
    expect(s.alarm()).toBe(T0 + 24 * 3_600_000);
  });
});

// ------------------------------------------------------------------------------ 5. gql
describe("a monday reply that carries a result is never 'rate-limited'", () => {
  it("a created entry with a complexity-worded error is not re-sent and not MondayRateLimitedError", async () => {
    const { gql } = await vi.importActual<typeof import("../src/monday")>("../src/monday");
    let sends = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { sends++; return new Response(JSON.stringify({
      data: { create_timeline_item: { id: "tl-1" } }, errors: [{ message: "complexity budget warning" }] }), { status: 200 }); }) as any;
    try {
      const e = await gql({ MONDAY_API_TOKEN: "t" } as Env, "mutation { create_timeline_item { id } }", {}, 1).catch(x => x);
      expect(sends).toBe(1);
      expect(e?.name).not.toBe("MondayRateLimitedError");
    } finally { globalThis.fetch = realFetch; }
  });
});

// ------------------------------------------------------------------------------ 6. currency
describe("currency reverses only for codes this portal uses", () => {
  const ctx = { labels: {} } as unknown as Ctx;
  it.each([CRM_DEALS, CRM_LINE_ITEMS])("%# refuses a real ISO code the portal does not carry", (spec) => {
    const cur = spec.fields.find(f => /currency_code$/.test(f.hs))!;
    expect(reverseFieldValue(cur, "EUR", ctx)).toBe("");
    expect(reverseFieldValue(cur, "MYR", ctx)).toBe("");
    expect(reverseFieldValue(cur, "HKD", ctx)).toBe("HKD");
  });
});
