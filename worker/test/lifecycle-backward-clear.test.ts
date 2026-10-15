import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_SPECS } from "../src/config/crm";
import {
  backwardClearPlan, danglingClearVerdict, optionOrderOf, reverseFieldValue, withOptionOrder, OPTION_ORDER_KEY,
} from "../src/reconcile";
import { expectedText, itemName } from "../src/mapping";
import type { Ctx, Env, FieldSpec, HsRecord, MondayItem, ObjectSpec, RunOpts, WriteAuth } from "../src/types";

/**
 * A MONDAY LIFECYCLE STAGE EDIT TO AN EARLIER STAGE MUST LAND IN HUBSPOT.
 *
 * Reported 2026-10-01: "monday to hubspot life cycle stage have problem but not hubspot to monday". Proven
 * from HubSpot's own history (propertiesWithHistory, read live):
 *   - contact 42000269320 ("test tt"): Matthew Ng set monday 7.Intention to purchase -> 3.Competitors at
 *     04:25:35Z; the Worker processed it at 04:25:41Z (Sync State written, sync_owner claimed) and HubSpot
 *     still holds `opportunity` from 2026-08-06, with NO new history entry. The card still shows 3.
 *   - contact 553232416501: hiffer's 10 -> 6 -> 5 -> 6 left no history entry at all. A HubSpot UI user then
 *     made the same move -- and HubSpot's UI did it as "" at 03:12:27 followed by 6 at 03:12:28.
 * HubSpot's API accepts a PATCH to an EARLIER lifecycle stage with a 200 and ignores it; to move it back
 * the value must be cleared first. Forward moves (1.NEW -> 7) always worked, which is why only some edits
 * were lost and why HubSpot -> monday was never affected.
 *
 * Driven through the real syncMondayItem / syncHubspotRecord with the REAL patchRecord: only `fetch` is
 * faked under it, so the order and body of each PATCH asserted below is what would go on the wire, and the
 * ownership refusal is patchRecord's own assert, not a stub's.
 */

// ------------------------------------------------------------------------------------------ fixtures

/**
 * contacts `lifecyclestage` IN HUBSPOT'S OWN ORDER, [value, label] at displayOrder 0..9, as
 * GET /crm/v3/properties/contacts/lifecyclestage (and /companies/lifecyclestage, identical) returned it on
 * 2026-10-01.
 *
 * AN ARRAY, NOT AN OBJECT LITERAL, because an object cannot carry this order: JS lists integer-like keys
 * (1028988526, 1029055302, ...) BEFORE string keys, so Object.keys/entries of the value -> label map start
 * 1028988526, 1029055302, 1029059094, ... and put `lead` at 6. A fixture that took positions from that
 * (it did, until 2026-10-01) gets 40 of the 90 ordered pairs backwards -- among them hiffer's own 6 -> 5 --
 * and so cannot catch the very bug the order exists to prevent. "the fixture is in the live order" below
 * pins this.
 */
const STAGES: readonly (readonly [value: string, label: string])[] = [
  ["lead", "1.NEW"],
  ["marketingqualifiedlead", "2.Information error or incomplete/Send email for promotion"],
  ["1028988526", "3.Competitors"],
  ["1029059094", "4.Returning customers/Have purchased from other channels"],
  ["1029060900", "5.No intention"],
  ["1029059095", "6.Not in contact/Pending further contact"],
  ["opportunity", "7.Intention to purchase"],
  ["customer", "8.The customer generating the transaction"],
  ["1029055302", "9.False or spam information"],
  ["1135842429", "10.Other"],
];
/** value -> label (key order is meaningless here: see STAGES). */
const LIFECYCLE: Record<string, string> = Object.fromEntries(STAGES);
/** The property's options as the live GET returned them. */
const LIVE_OPTIONS = STAGES.map(([value, label], displayOrder) => ({ value, label, displayOrder, hidden: false }));
const ORDER: Record<string, number> = Object.fromEntries(STAGES.map(([value], displayOrder) => [value, displayOrder]));
/** The same options, NOT in displayOrder sequence -- nothing promises the API lists them sorted. */
const SHUFFLED_OPTIONS = [7, 2, 9, 0, 5, 3, 8, 1, 6, 4].map(i => LIVE_OPTIONS[i]);
/** The stage value whose label starts "<n>." -- so a test reads as the person's edit did. */
const stage = (n: number): string => STAGES[n - 1][0];

const PRE = "2024-07-24T11:48:14.462Z";     // 42000269320's createdate
const MOD = "2026-10-01T03:00:00Z";         // the card's Sync State
const CLEARED = "2026-10-01T04:25:41.100Z"; // lastmodifieddate after the clear
const PUSHED = "2026-10-01T04:25:41.857Z";  // lastmodifieddate after the real write
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const env = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z", HUBSPOT_ACCESS_TOKEN: "x" } as unknown as Env;

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(), getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(),
}));
/** Every HubSpot call EXCEPT patchRecord is stubbed. patchRecord is the real one (see the file note). */
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
  getOwners: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(),
  searchCompanyByDomain: vi.fn(), propertiesForSpec: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({
  reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(),
}));
const ensure = vi.hoisted(() => ({ ensureCardForRecord: vi.fn() }));

vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hubspot")>()), ...hubspot,
}));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ensure);

const { syncMondayItem, syncHubspotRecord, recheckDanglingClears, settleAbandonedCreate, resetCtxCache } = await import("../src/sync");
const real = await vi.importActual<typeof import("../src/hubspot")>("../src/hubspot");

// ------------------------------------------------------------------------------------- fake HubSpot

type Reply = { status: number; body?: unknown } | Error;
let replies: Reply[] = [];
/** Served for GET /crm/v3/properties/contacts/lifecyclestage while set: only by tests that run the REAL
 *  getPropertyOptions under buildCtx (see "the live order, end to end"). */
let propertyOptions: unknown[] | null = null;
/** One version of `lifecyclestage` as propertiesWithHistory lists it. */
type Version = { value: string; timestamp: string; sourceType: string; sourceId?: string };
/** Served (newest first) for the record GET with propertiesWithHistory=lifecyclestage while set. */
let history: Version[] | null = null;

/**
 * A STATEFUL HUBSPOT, for the tests that follow one record through a failure and its repair. PATCHes apply
 * to `props` exactly as the live portal applies them -- a lifecycle move to an EARLIER stage is answered 200
 * and IGNORED, which is the bug -- every applied stage change is appended to `history` as our integration's,
 * and `fail` decides per body whether this request fails (a status) or is never answered ("hang": the
 * isolate dies with it in flight).
 */
interface Model {
  props: Record<string, string>;
  history: Version[];                 // oldest first
  clock: number;
  fail?: (body: Record<string, string>) => number | "hang" | undefined;
}
let model: Model | null = null;
function modelPatch(m: Model, body: Record<string, string>): Response | Promise<Response> {
  const f = m.fail?.(body);
  if (f === "hang") return new Promise<Response>(() => {});
  if (f) return new Response(JSON.stringify({ status: "error", message: `HTTP ${f}` }), { status: f });
  m.clock += 500;
  const at = new Date(m.clock).toISOString();
  for (const [k, v] of Object.entries(body)) {
    const was = m.props[k] ?? "";
    if (k === "lifecyclestage" && v !== "" && was !== "" && ORDER[v] < ORDER[was]) continue;  // HubSpot ignores it
    if (v === was) continue;
    m.props[k] = v;
    if (k === "lifecyclestage") m.history.push({ value: v, timestamp: at, sourceType: "INTEGRATION", sourceId: "52247773" });
  }
  m.props.lastmodifieddate = at;
  return new Response(JSON.stringify({ id: "42000269320", properties: { ...m.props } }), { status: 200 });
}

const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? "GET";
  if (propertyOptions && method === "GET" && /\/crm\/v3\/properties\/contacts\/lifecyclestage$/.test(String(url)))
    return new Response(JSON.stringify({ name: "lifecyclestage", options: propertyOptions }));
  if (method === "GET" && /\/crm\/v3\/objects\/contacts\/\d+\?.*propertiesWithHistory=lifecyclestage/.test(String(url))) {
    const h = model ? [...model.history].reverse() : history;
    if (!h) throw new Error(`unexpected history read ${url}`);
    return new Response(JSON.stringify({ id: "42000269320", properties: model ? { ...model.props } : {},
      propertiesWithHistory: { lifecyclestage: h } }));
  }
  // Only the record PATCH may reach the network here: anything else is a call this file did not expect.
  if (method !== "PATCH" || !/\/crm\/v3\/objects\/contacts\/\d+$/.test(String(url)))
    throw new Error(`unexpected fetch ${init?.method} ${url}`);
  if (model) return modelPatch(model, JSON.parse(String(init!.body)).properties);
  const r = replies.shift() ?? { status: 200, body: { properties: { lastmodifieddate: PUSHED } } };
  if (r instanceof Error) throw r;
  return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
});
/** The history reads that went out. */
const historyReads = () => fetchMock.mock.calls.filter(c => /propertiesWithHistory/.test(String(c[0])));

/** The deferred queue (DEFERRED_SYNC), faked at its one method: what was handed to it. */
const enqueue = vi.fn(async (items: unknown[]) => ({ queued: items.length, duplicate: 0, dropped: 0, depth: items.length }));
const durableEnv = (): Env => ({ ...env,
  DEFERRED_SYNC: { idFromName: (n: string) => n, get: () => ({ enqueue }) } } as unknown as Env);
const ok = (lastmodifieddate: string, props: Record<string, string | null> = {}): Reply =>
  ({ status: 200, body: { id: "42000269320", properties: { lastmodifieddate, ...props } } });
const rejected = (msg = "VALIDATION_ERROR"): Reply => ({ status: 400, body: { status: "error", message: msg } });

/** The record PATCHes that went out, in order: their property bodies. */
const patches = (): Record<string, string>[] =>
  fetchMock.mock.calls.filter(c => c[1]?.method === "PATCH").map(c => JSON.parse(String(c[1]!.body)).properties);

let logs: string[] = [];
const logged = (needle: string) => logs.filter(l => l.includes(needle));

let originalFetch: typeof fetch;
beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  replies = [];
  propertyOptions = null;
  history = null;
  model = null;
  logs = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as never;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  monday.getUsersByEmail.mockResolvedValue({});
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  monday.moveItem.mockResolvedValue(undefined);
  monday.findItemByColumn.mockResolvedValue([]);
  hubspot.getOwners.mockResolvedValue({});
  hubspot.getDealStageLabels.mockResolvedValue({});
  hubspot.getCrmStageDicts.mockResolvedValue({ pipelines: {}, stages: {}, pipelineByStage: {} });
  hubspot.propertiesForSpec.mockReturnValue([]);
  hubspot.claimOwnership.mockResolvedValue(MOD);
  // As buildCtx receives it from the real getPropertyOptions: the dictionary, carrying its live order.
  hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, object: string, prop: string) =>
    object === "contacts" && prop === "lifecyclestage" ? withOptionOrder({ ...LIFECYCLE }, ORDER) : {});
  assoc.reverseAssociations.mockResolvedValue(undefined);
  assoc.reverseLineItems.mockResolvedValue(undefined);
  registry.lookupCard.mockResolvedValue(null);
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const life = (): FieldSpec => CRM_CONTACTS.fields.find(f => f.hs === "lifecyclestage")!;

/** Contact 42000269320 as HubSpot holds it: stage `opportunity` (7), already claimed by CRM. */
const testTt = (over: Record<string, string> = {}): HsRecord => ({
  id: "42000269320",
  properties: {
    firstname: "test", lastname: "tt", email: "testtt@example.com", lifecyclestage: "opportunity",
    sync_owner: "crm", createdate: PRE, lastmodifieddate: MOD, ...over,
  },
});

/** The card as monday shows it: built from `from`, stamped `stamp`, then overridden cell by cell. */
function card(from: HsRecord, stamp: string, text: Record<string, string> = {}): MondayItem {
  const ctx = { labels: { lifecycleStage: LIFECYCLE }, ownersById: {}, mondayUsersByEmail: {} } as unknown as Ctx;
  const cv: MondayItem["column_values"] = [
    { id: CRM_CONTACTS.idCol, text: from.id },
    { id: CRM_CONTACTS.syncStateCol, text: stamp },
  ];
  for (const f of CRM_CONTACTS.fields) {
    if (f.type === "people") continue;
    const t = expectedText(f, from.properties[f.hs], ctx);
    if (t !== null) cv.push({ id: f.col, text: t });
  }
  for (const [col, t] of Object.entries(text)) {
    const hit = cv.find(c => c.id === col);
    if (hit) hit.text = t; else cv.push({ id: col, text: t });
  }
  return { id: "2855744260", name: itemName(from, CRM_CONTACTS), created_at: PRE, updated_at: MOD,
    group: { id: "topics" }, column_values: cv };
}

/** A person's edit of these cells (col -> text) at once, on a record HubSpot holds as `rec`. */
async function editCells(rec: HsRecord, cells: Record<string, string>, opts: RunOpts = live, e: Env = env) {
  monday.getItem.mockResolvedValue(card(rec, MOD, cells));
  hubspot.getRecord.mockResolvedValue(rec);
  return syncMondayItem(e, CRM_CONTACTS.boardId, "2855744260", opts, { left: 30 }, false, false,
    { cols: Object.keys(cells), actor: "104231430" });
}

/** A person's edit of the Lifecycle Stage cell to `label`, on a record HubSpot holds as `rec`. */
async function editStage(rec: HsRecord, label: string, opts: RunOpts = live, e: Env = env) {
  return editCells(rec, { [life().col]: label }, opts, e);
}

/** Every column value written to monday in this test, across setColumns and updateItem. */
const mondayWrites = (): Record<string, unknown>[] => [
  ...monday.setColumns.mock.calls.map(c => c[3] as Record<string, unknown>),
  ...monday.updateItem.mock.calls.map(c => c[4] as Record<string, unknown>),
];

// ------------------------------------------------------------------------------------------------
// 1. The two live cases, end to end.
// ------------------------------------------------------------------------------------------------

describe("a backward move is sent as a clear, then the stage", () => {
  it("Matthew's edit, 7.Intention to purchase -> 3.Competitors: PATCH \"\" first, then 1028988526", async () => {
    replies = [ok(CLEARED, { lifecyclestage: "" }), ok(PUSHED, { lifecyclestage: "1028988526" })];
    await editStage(testTt(), "3.Competitors");

    expect(patches()).toEqual([{ lifecyclestage: "" }, { lifecyclestage: "1028988526" }]);
    // Both to the same record, and nothing else went to HubSpot.
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls).toEqual([
      "https://api.hubapi.com/crm/v3/objects/contacts/42000269320",
      "https://api.hubapi.com/crm/v3/objects/contacts/42000269320",
    ]);
    expect(logged("action=lifecycle-backward-clear-set")).toHaveLength(1);
    expect(logged("action=lifecycle-backward-clear-set")[0]).toContain("moves=lifecyclestage:opportunity->1028988526");
    expect(logged("action=lifecycle-noop")).toEqual([]);
  });

  it("hiffer's edit, 10.Other -> 6.Not in contact: the same clear-then-set", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    await editStage(testTt({ lifecyclestage: "1135842429" }), "6.Not in contact/Pending further contact");
    expect(patches()).toEqual([{ lifecyclestage: "" }, { lifecyclestage: "1029059095" }]);
  });

  it("Sync State is stamped from the REAL write, not from the clear", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    await editStage(testTt(), "3.Competitors");
    const stamps = mondayWrites().map(cv => cv[CRM_CONTACTS.syncStateCol]).filter(Boolean);
    expect(stamps).toEqual([PUSHED]);
  });

  it("and the card is NOT snapped back: no monday write touches the Lifecycle Stage cell", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    await editStage(testTt(), "3.Competitors");
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
  });

  it("an unclaimed record is claimed first, then cleared, then set -- in that order", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    await editStage(testTt({ sync_owner: "" }), "3.Competitors");
    expect(hubspot.claimOwnership).toHaveBeenCalledTimes(1);
    expect(hubspot.claimOwnership.mock.calls[0][4]).toBe("human-edit");
    expect(patches()).toEqual([{ lifecyclestage: "" }, { lifecyclestage: "1028988526" }]);
    // vi.fn invocation order is global across mocks: the claim strictly before the first PATCH.
    expect(hubspot.claimOwnership.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
  });
});

// ------------------------------------------------------------------------------------------------
// 1b. The same, with the order coming from where production gets it: the real getPropertyOptions, fed
//     the live options out of sequence, through buildCtx and the ctx cache. Nothing here hands the code
//     an order -- so a regression that ranked options by anything but displayOrder fails here.
// ------------------------------------------------------------------------------------------------

describe("the live order, end to end through the real getPropertyOptions (one cached ctx)", () => {
  beforeEach(() => {
    propertyOptions = SHUFFLED_OPTIONS;
    hubspot.getPropertyOptions.mockImplementation((e: Env, o: string, p: string) =>
      o === "contacts" && p === "lifecyclestage" ? real.getPropertyOptions(e, o, p) : Promise.resolve({}));
  });

  /** A person's edits in turn, each from the stage the one before left; the PATCH bodies each sent. */
  async function walk(start: number, ...moves: number[]): Promise<Record<string, string>[][]> {
    const sent: Record<string, string>[][] = [];
    let at = start;
    for (const to of moves) {
      const before = patches().length;
      await editStage(testTt({ lifecyclestage: stage(at) }), STAGES[to - 1][1]);
      sent.push(patches().slice(before));
      at = to;
    }
    return sent;
  }
  const propertyReads = () => fetchMock.mock.calls.filter(c => (c[1]?.method ?? "GET") === "GET");

  it("hiffer's 10 -> 6 -> 5 -> 6: clear+set, clear+set, then ONE PATCH", async () => {
    expect(await walk(10, 6, 5, 6)).toEqual([
      [{ lifecyclestage: "" }, { lifecyclestage: stage(6) }],
      [{ lifecyclestage: "" }, { lifecyclestage: stage(5) }],
      [{ lifecyclestage: stage(6) }],
    ]);
    expect(propertyReads()).toHaveLength(1);       // one read; the order survived the ctx cache
  });

  it("Matthew's 7 -> 3, then 3 -> 1.NEW: both clear+set", async () => {
    expect(await walk(7, 3, 1)).toEqual([
      [{ lifecyclestage: "" }, { lifecyclestage: stage(3) }],
      [{ lifecyclestage: "" }, { lifecyclestage: stage(1) }],
    ]);
    expect(propertyReads()).toHaveLength(1);
  });

  it("forward moves the key order would rank backwards stay one PATCH: 1.NEW -> 3, 8 -> 9", async () => {
    expect(await walk(1, 3)).toEqual([[{ lifecyclestage: stage(3) }]]);
    expect(await walk(8, 9)).toEqual([[{ lifecyclestage: stage(9) }]]);
  });
});

// ------------------------------------------------------------------------------------------------
// 2. Everything that is NOT a backward move is exactly one PATCH, as before.
// ------------------------------------------------------------------------------------------------

describe("anything else stays a single PATCH", () => {
  it("a forward move, 1.NEW -> 7.Intention to purchase", async () => {
    await editStage(testTt({ lifecyclestage: "lead" }), "7.Intention to purchase");
    expect(patches()).toEqual([{ lifecyclestage: "opportunity" }]);
    expect(logged("action=lifecycle-backward")).toEqual([]);
  });

  it("a forward move to the very last stage, 3 -> 10.Other", async () => {
    await editStage(testTt({ lifecyclestage: "1028988526" }), "10.Other");
    expect(patches()).toEqual([{ lifecyclestage: "1135842429" }]);
  });

  it("a first fill (HubSpot empty) -- nothing to move back from", async () => {
    await editStage(testTt({ lifecyclestage: "" }), "3.Competitors");
    expect(patches()).toEqual([{ lifecyclestage: "1028988526" }]);
  });

  it("the value HubSpot already holds: nothing is sent, nothing is claimed", async () => {
    await editStage(testTt(), "7.Intention to purchase");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
  });

  it("an emptied cell is a clear, which HubSpot always accepts: one PATCH of \"\"", async () => {
    await editStage(testTt(), "");
    expect(patches()).toEqual([{ lifecyclestage: "" }]);
  });

  it("UNKNOWN ORDER (the dictionary carries none): one PATCH, as before, and a log line", async () => {
    hubspot.getPropertyOptions.mockImplementation(async (_e: unknown, o: string, p: string) =>
      o === "contacts" && p === "lifecyclestage" ? { ...LIFECYCLE } : {});
    await editStage(testTt(), "3.Competitors");
    expect(patches()).toEqual([{ lifecyclestage: "1028988526" }]);
    expect(logged("action=lifecycle-order-unknown")).toHaveLength(1);
    expect(logged("action=lifecycle-order-unknown")[0]).toContain("field=lifecyclestage");
  });

  it("UNKNOWN ORDER (HubSpot holds a value outside the options): one PATCH and a log line", async () => {
    await editStage(testTt({ lifecyclestage: "salesqualifiedlead" }), "3.Competitors");
    expect(patches()).toEqual([{ lifecyclestage: "1028988526" }]);
    expect(logged("action=lifecycle-order-unknown")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
// 3. Ownership governs BOTH PATCHes: a refused write sends no clear.
// ------------------------------------------------------------------------------------------------

describe("an ownership refusal sends neither PATCH", () => {
  it.each(["wm", "hold"])("sync_owner=%s: no clear, no set, no claim; the cell is healed to HubSpot's stage", async (stamp) => {
    await editStage(testTt({ sync_owner: stamp }), "3.Competitors");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    const healed = mondayWrites().find(cv => life().col in cv);
    expect(healed?.[life().col]).toEqual({ label: "7.Intention to purchase" });
  });

  it("an automation cannot claim, so on an unclaimed record it sends neither either", async () => {
    monday.getItem.mockResolvedValue(card(testTt({ sync_owner: "" }), MOD, { [life().col]: "3.Competitors" }));
    hubspot.getRecord.mockResolvedValue(testTt({ sync_owner: "" }));
    await syncMondayItem(env, CRM_CONTACTS.boardId, "2855744260", live, { left: 30 }, false, false,
      { cols: [life().col], byAutomation: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an auth computed for ANOTHER record: patchRecord refuses the clear itself, nothing goes out", async () => {
    const wrong: WriteAuth = { allowed: true, reason: "stamped crm", forId: "999" };
    await expect(real.patchRecord(env, CRM_CONTACTS, "42000269320", { lifecyclestage: "" }, live, wrong))
      .rejects.toThrow(/computed for 999/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------
// 4. The set fails after the clear went out.
// ------------------------------------------------------------------------------------------------

describe("when the set fails after the clear", () => {
  it("it is retried once, and a retry that lands is a success (no restore, no snap-back)", async () => {
    replies = [ok(CLEARED), rejected(), ok(PUSHED)];
    await editStage(testTt(), "3.Competitors");
    expect(patches()).toEqual([{ lifecyclestage: "" }, { lifecyclestage: "1028988526" }, { lifecyclestage: "1028988526" }]);
    expect(logged("action=lifecycle-backward-clear-set")[0]).toContain("retried=1");
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
    expect(mondayWrites().map(cv => cv[CRM_CONTACTS.syncStateCol]).filter(Boolean)).toEqual([PUSHED]);
  });

  it("twice: the previous stage is restored, and the card snaps back to it through the ordinary heal", async () => {
    replies = [ok(CLEARED), rejected(), rejected(), ok("2026-10-01T04:25:42Z")];
    await editStage(testTt(), "3.Competitors");
    expect(patches()).toEqual([
      { lifecyclestage: "" }, { lifecyclestage: "1028988526" }, { lifecyclestage: "1028988526" },
      { lifecyclestage: "opportunity" },                              // the restore
    ]);
    expect(logged("action=lifecycle-backward-failed")).toHaveLength(1);
    expect(logged("action=lifecycle-backward-failed")[0]).toContain(`restore="ok"`);
    expect(logged("action=rejected")).toHaveLength(1);               // pushColumnEdit's own rejection path
    const healed = mondayWrites().find(cv => life().col in cv);
    expect(healed?.[life().col]).toEqual({ label: "7.Intention to purchase" });
  });

  it("a restore that fails too is logged as such, and the sync still finishes (no throw out of it)", async () => {
    replies = [ok(CLEARED), rejected(), rejected(), rejected("restore refused")];
    await expect(editStage(testTt(), "3.Competitors")).resolves.toBeDefined();
    expect(patches()).toHaveLength(4);
    expect(logged("action=lifecycle-backward-failed")[0]).toMatch(/restore="failed: .*restore refused/);
  });

  it("a CLEAR that fails sends nothing more: no set, no restore, the cell is healed", async () => {
    replies = [rejected("clear refused")];
    await editStage(testTt(), "3.Competitors");
    expect(patches()).toEqual([{ lifecyclestage: "" }]);
    expect(logged("action=lifecycle-backward-failed")).toEqual([]);
    const healed = mondayWrites().find(cv => life().col in cv);
    expect(healed?.[life().col]).toEqual({ label: "7.Intention to purchase" });
  });

  it("a dry run sends nothing at all", async () => {
    await editStage(testTt(), "3.Competitors", { ...live, dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged("DRY hubspot PATCH contacts/42000269320")).toHaveLength(2);
    expect(logged("action=lifecycle-backward-clear-set")[0]).toContain("result=dry-run");
  });
});

// ------------------------------------------------------------------------------------------------
// 5. The drawer (appSave) takes the record-level path, which must clear too.
// ------------------------------------------------------------------------------------------------

describe("a drawer save", () => {
  it("of an earlier stage sends the clear, then the stage", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    monday.getItem.mockResolvedValue(card(testTt(), MOD, { [life().col]: "3.Competitors" }));
    hubspot.getRecord.mockResolvedValue(testTt());
    await syncMondayItem(env, CRM_CONTACTS.boardId, "2855744260", live, { left: 30 }, true);
    expect(patches()).toEqual([{ lifecyclestage: "" }, { lifecyclestage: "1028988526" }]);
  });

  it("of a later stage is one PATCH", async () => {
    monday.getItem.mockResolvedValue(card(testTt({ lifecyclestage: "lead" }), MOD, { [life().col]: "7.Intention to purchase" }));
    hubspot.getRecord.mockResolvedValue(testTt({ lifecyclestage: "lead" }));
    await syncMondayItem(env, CRM_CONTACTS.boardId, "2855744260", live, { left: 30 }, true);
    expect(patches()).toEqual([{ lifecyclestage: "opportunity" }]);
  });
});

// ------------------------------------------------------------------------------------------------
// 6. The echoes: neither the clear's nor the set's may blank or revert the card.
// ------------------------------------------------------------------------------------------------

describe("the HubSpot echo of our own clear", () => {
  it("a read that lands BETWEEN the two PATCHes (stage empty, HubSpot newer) does not blank the cell", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(CLEARED) });
    try {
      const between = testTt({ lifecyclestage: "", lastmodifieddate: CLEARED });
      history = [{ value: "", timestamp: CLEARED, sourceType: "INTEGRATION" },
        { value: "opportunity", timestamp: "2026-08-06T03:08:12.141Z", sourceType: "DEALS" }];
      monday.findItemByColumn.mockResolvedValue([card(testTt({ lifecyclestage: "1028988526" }), MOD)]);
      hubspot.getRecord.mockResolvedValue(between);
      await syncHubspotRecord(env, CRM_CONTACTS, "42000269320", live, { left: 30 });
      // It finds OUR clear and sends the card's stage -- the very value the set in flight is sending, so the
      // two agree whichever lands second. Nothing else: no claim, and the cell is never blanked.
      expect(patches()).toEqual([{ lifecyclestage: "1028988526" }]);
      expect(hubspot.claimOwnership).not.toHaveBeenCalled();
      for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
    } finally { vi.useRealTimers(); }
  });

  it("the same, after our stamp already landed (HubSpot reads OLDER than Sync State): monday untouched", async () => {
    const between = testTt({ lifecyclestage: "", lastmodifieddate: CLEARED });
    monday.findItemByColumn.mockResolvedValue([card(testTt({ lifecyclestage: "1028988526" }), PUSHED)]);
    hubspot.getRecord.mockResolvedValue(between);
    await syncHubspotRecord(env, CRM_CONTACTS, "42000269320", live, { left: 30 });
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
  });

  it("the echo of the set finds the card already in line and writes nothing", async () => {
    const after = testTt({ lifecyclestage: "1028988526", lastmodifieddate: PUSHED });
    monday.findItemByColumn.mockResolvedValue([card(after, PUSHED)]);
    hubspot.getRecord.mockResolvedValue(after);
    await syncHubspotRecord(env, CRM_CONTACTS, "42000269320", live, { left: 30 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(monday.setColumns).not.toHaveBeenCalled();
    expect(monday.updateItem).not.toHaveBeenCalled();
  });

  it("our own token's monday echo naming the Lifecycle column never writes HubSpot", async () => {
    monday.getItem.mockResolvedValue(card(testTt(), MOD, { [life().col]: "3.Competitors" }));
    hubspot.getRecord.mockResolvedValue(testTt());
    await syncMondayItem(env, CRM_CONTACTS.boardId, "2855744260", live, { left: 30 }, false, true, { cols: [life().col] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------
// 7. The silent no-op itself is now visible.
// ------------------------------------------------------------------------------------------------

describe("patchRecord reports a lifecycle write HubSpot answered but ignored", () => {
  const auth: WriteAuth = { allowed: true, reason: "stamped crm", forId: "42000269320" };

  it("the response still holds the old stage -> action=lifecycle-noop (logged, not retried)", async () => {
    replies = [ok(PUSHED, { lifecyclestage: "opportunity" })];
    const mod = await real.patchRecord(env, CRM_CONTACTS, "42000269320", { lifecyclestage: "1029059095" }, live, auth);
    expect(mod).toBe(PUSHED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logged("action=lifecycle-noop")).toHaveLength(1);
    expect(logged("action=lifecycle-noop")[0]).toContain(`sent="1029059095" stored="opportunity"`);
  });

  it.each([
    ["the response confirms the stage", { lifecyclestage: "1029059095" }, { lifecyclestage: "1029059095" }],
    ["the response does not carry the property", { lifecyclestage: "1029059095" }, {}],
    ["a clear answered with null", { lifecyclestage: "" }, { lifecyclestage: null }],
    ["an unflagged property that differs", { jobtitle: "Buyer" }, { jobtitle: "buyer" }],
  ])("nothing is reported when %s", async (_why, sent, stored) => {
    replies = [ok(PUSHED, stored as Record<string, string | null>)];
    await real.patchRecord(env, CRM_CONTACTS, "42000269320", sent as Record<string, string>, live, auth);
    expect(logged("action=lifecycle-noop")).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// 8. The order: read live with the labels, carried on the dictionary, never guessed.
// ------------------------------------------------------------------------------------------------

describe("the option order", () => {
  it("the real getPropertyOptions records displayOrder where optionOrderOf reads it (the key pair)", async () => {
    const getSpy = vi.fn(async (_url: string) => new Response(JSON.stringify({ name: "lifecyclestage", options: LIVE_OPTIONS })));
    globalThis.fetch = getSpy as never;
    const dict = await real.getPropertyOptions(env, "contacts", "lifecyclestage");
    expect({ ...optionOrderOf(dict) }).toEqual(ORDER);
    expect(String(getSpy.mock.calls[0][0])).toContain("/crm/v3/properties/contacts/lifecyclestage");
  });

  it("and leaves the dictionary itself exactly as it was: same keys, same labels, still reversible", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ options: LIVE_OPTIONS }))) as never;
    const dict = await real.getPropertyOptions(env, "contacts", "lifecyclestage");
    expect(dict).toEqual(LIFECYCLE);
    expect(Object.keys(dict)).toHaveLength(10);
    expect(Object.getOwnPropertySymbols(dict).every(k => !Object.getOwnPropertyDescriptor(dict, k)!.enumerable)).toBe(true);
    const ctx = { labels: { lifecycleStage: dict } } as unknown as Ctx;
    expect(reverseFieldValue(life(), "3.Competitors", ctx)).toBe("1028988526");
  });

  it("the key both modules use is the same string", () => {
    expect(OPTION_ORDER_KEY).toBe("dkm-crm-sync:hubspot-option-order");
  });

  it.each([
    ["no options", []],
    ["an unordered option (-1)", [{ value: "a", displayOrder: 0 }, { value: "b", displayOrder: -1 }]],
    ["a missing displayOrder", [{ value: "a", displayOrder: 0 }, { value: "b" }]],
    ["two options sharing one position", [{ value: "a", displayOrder: 1 }, { value: "b", displayOrder: 1 }]],
  ])("%s: no order at all, rather than a partial one", (_why, options) => {
    expect(real.optionDisplayOrder(options as never)).toBeUndefined();
  });

  it("the fixture is in the live order: 1.NEW at 0 .. 10.Other at 9 -- which the map's own key order is NOT", () => {
    expect(STAGES.map(([, label]) => label.split(".")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(ORDER.lead).toBe(0);
    expect(ORDER["1135842429"]).toBe(9);
    // The trap the fixture used to fall into: integer-like keys enumerate first.
    expect(Object.keys(LIFECYCLE).indexOf("lead")).toBe(6);
  });

  it("optionDisplayOrder reads each option's own displayOrder: 1.NEW (0) .. 10.Other (9)", () =>
    expect({ ...real.optionDisplayOrder(LIVE_OPTIONS) }).toEqual(ORDER));

  it("options that arrive OUT of displayOrder sequence give the same order", () =>
    expect({ ...real.optionDisplayOrder(SHUFFLED_OPTIONS) }).toEqual(ORDER));

  it("and so does the real getPropertyOptions given them, though its dictionary's key order differs again", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ options: SHUFFLED_OPTIONS }))) as never;
    const dict = await real.getPropertyOptions(env, "contacts", "lifecyclestage");
    expect({ ...optionOrderOf(dict) }).toEqual(ORDER);
    expect(Object.keys(dict)).not.toEqual(STAGES.map(([v]) => v));
  });
});

// ------------------------------------------------------------------------------------------------
// 9. backwardClearPlan, in isolation.
// ------------------------------------------------------------------------------------------------

describe("backwardClearPlan", () => {
  const ctx = { labels: { lifecycleStage: withOptionOrder({ ...LIFECYCLE }, ORDER) } } as unknown as Ctx;
  const plan = (from: string, to: string, spec: ObjectSpec = CRM_CONTACTS, c: Ctx = ctx) =>
    backwardClearPlan(spec, { lifecyclestage: to }, { lifecyclestage: from }, c);

  it("every strictly-earlier target is a backward move; every later one is not (all 90 ordered pairs)", () => {
    let backward = 0;
    STAGES.forEach(([from], i) => STAGES.forEach(([to], j) => {
      if (i === j) return;
      const p = plan(from, to);
      // By POSITION IN STAGES (the label's own number), never by ORDER: the expectation must not share
      // a mistake with the thing it checks.
      if (j < i) { expect(p.clear, `${i + 1}->${j + 1}`).toEqual({ lifecyclestage: "" }); backward++; }
      else expect(p.clear, `${i + 1}->${j + 1}`).toEqual({});
      expect(p.unknown).toEqual([]);
    }));
    expect(backward).toBe(45);
  });

  /** Each of these comes out the other way round under the map's key order (`lead` at 6): see STAGES. */
  it.each([
    [3, 1, true],     // Matthew's next move after 7 -> 3: 3.Competitors -> 1.NEW
    [6, 5, true],     // hiffer's second move: 6.Not in contact -> 5.No intention
    [9, 8, true],     // 9.False or spam -> 8.The customer
    [5, 6, false],    // hiffer's third move: 5 -> 6 is FORWARD, one PATCH
    [1, 3, false],    // 1.NEW -> 3.Competitors
  ])("%i -> %i is backward: %s", (from, to, back) =>
    expect(plan(stage(from), stage(to)).clear).toEqual(back ? { lifecyclestage: "" } : {}));

  it("records what a failed set puts back", () =>
    expect(plan("opportunity", "1028988526").previous).toEqual({ lifecyclestage: "opportunity" }));

  it("other properties in the same patch are never cleared", () => {
    const p = backwardClearPlan(CRM_CONTACTS, { lifecyclestage: "lead", jobtitle: "Buyer", leadstatus: "" },
      { lifecyclestage: "customer", jobtitle: "Head", leadstatus: "1New" }, ctx);
    expect(p.clear).toEqual({ lifecyclestage: "" });
  });

  it("a patch without the property plans nothing", () =>
    expect(backwardClearPlan(CRM_CONTACTS, { jobtitle: "x" }, { lifecyclestage: "customer" }, ctx))
      .toEqual({ clear: {}, previous: {}, unknown: [] }));

  it("no order on the dictionary: unknown, never a guess", () => {
    const bare = { labels: { lifecycleStage: { ...LIFECYCLE } } } as unknown as Ctx;
    expect(plan("opportunity", "1028988526", CRM_CONTACTS, bare)).toEqual({ clear: {}, previous: {}, unknown: ["lifecyclestage"] });
  });

  it("a copy of the dictionary does not carry the order (and is therefore unknown, i.e. today's behaviour)", () =>
    expect(optionOrderOf({ ...withOptionOrder({ ...LIFECYCLE }, ORDER) })).toBeUndefined());
});

// ------------------------------------------------------------------------------------------------
// 10. Blast radius: which fields and which objects.
// ------------------------------------------------------------------------------------------------

describe("blast radius", () => {
  it("Contacts' Lifecycle Stage carries the flag", () => expect(life().backwardNeedsClear).toBe(true));

  it("it is the only flagged field on any CRM spec", async () => {
    const flagged = CRM_SPECS.flatMap(s => s.fields.filter(f => f.backwardNeedsClear).map(f => `${s.object}.${f.hs}`));
    expect(flagged).toEqual(["contacts.lifecyclestage"]);
  });

  /** Companies have the same pipeline in this portal (read live), but CRM Accounts does not map it. Should it
   *  ever be mapped, it must carry the flag -- otherwise its backward moves would be lost exactly the same way. */
  it("CRM Accounts does not map lifecyclestage, so companies have nothing to clear", () => {
    expect(CRM_ACCOUNTS.fields.some(f => f.hs === "lifecyclestage")).toBe(false);
    expect(backwardClearPlan(CRM_ACCOUNTS, { lifecyclestage: "lead" }, { lifecyclestage: "customer" },
      { labels: {} } as unknown as Ctx)).toEqual({ clear: {}, previous: {}, unknown: [] });
  });

  it("every spec that maps lifecyclestage, on either deployment, carries the flag", async () => {
    const { ALL_KNOWN_SPECS } = await import("../src/config");
    expect(ALL_KNOWN_SPECS.some(s => s.fields.some(f => f.hs === "lifecyclestage"))).toBe(true);
    for (const s of ALL_KNOWN_SPECS) for (const f of s.fields.filter(x => x.hs === "lifecyclestage"))
      expect(f.backwardNeedsClear, `${s.object} ${f.col}`).toBe(true);
  });

  it("the mechanism is per field, not per object: a flagged companies field would be planned the same way", () => {
    const companies = { ...CRM_ACCOUNTS, fields: [...CRM_ACCOUNTS.fields,
      { hs: "lifecyclestage", col: "x", type: "status", labels: "lifecycleStage", reverse: true, backwardNeedsClear: true } as FieldSpec] };
    const ctx = { labels: { lifecycleStage: withOptionOrder({ ...LIFECYCLE }, ORDER) } } as unknown as Ctx;
    expect(backwardClearPlan(companies, { lifecyclestage: "lead" }, { lifecyclestage: "customer" }, ctx).clear)
      .toEqual({ lifecyclestage: "" });
  });
});

// ------------------------------------------------------------------------------------------------
// 11. A CLEAR IS NEVER LEFT TO CHANCE. Review finding, 2026-10-01: once the clear has landed, a set that
//     cannot follow it (HubSpot 429/503 for longer than the in-process retries, or the isolate cancelled
//     ~30 s into its waitUntil) used to leave HubSpot's stage EMPTY, the card healed to a stage HubSpot no
//     longer held, and nothing anywhere that would ever repair it.
// ------------------------------------------------------------------------------------------------

const jobtitle = (): FieldSpec => CRM_CONTACTS.fields.find(f => f.hs === "jobtitle")!;
/** When the repair runs: 19 s after CLEARED, well inside the window. */
const REPAIR_NOW = "2026-10-01T04:26:00.000Z";
const RESTORED = "2026-10-01T04:25:42.000Z";
/** HubSpot's history of 42000269320's stage after OUR clear: newest first. */
const ourClear = (at = CLEARED, by: Partial<Version> = {}): Version[] => [
  { value: "", timestamp: at, sourceType: "INTEGRATION", sourceId: "52247773", ...by },
  { value: "opportunity", timestamp: "2026-08-06T03:08:12.141Z", sourceType: "DEALS", sourceId: "deals-lifecycle-sync" },
  { value: "lead", timestamp: PRE, sourceType: "IMPORT", sourceId: "49222891" },
];
const syncStamps = () => mondayWrites().map(cv => cv[CRM_CONTACTS.syncStateCol]).filter(Boolean);

describe("the clear carries the rest of the edit: only the stage itself can fail after it", () => {
  it("every other property rides in the FIRST PATCH, with the clear; the second carries the stage alone", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    await editCells(testTt(), { [life().col]: "3.Competitors", [jobtitle().col]: "Buyer" });
    expect(patches()).toEqual([{ jobtitle: "Buyer", lifecyclestage: "" }, { lifecyclestage: "1028988526" }]);
    for (const cv of mondayWrites()) { expect(cv).not.toHaveProperty(life().col); expect(cv).not.toHaveProperty(jobtitle().col); }
    expect(syncStamps()).toEqual([PUSHED]);
  });

  it("a 400 caused by another property fails BEFORE anything is cleared: one PATCH, both cells healed", async () => {
    replies = [rejected("Property values were not valid: jobtitle")];
    await editCells(testTt({ jobtitle: "Head" }), { [life().col]: "3.Competitors", [jobtitle().col]: "Buyer" });
    expect(patches()).toEqual([{ jobtitle: "Buyer", lifecyclestage: "" }]);
    expect(logged("action=lifecycle-backward-failed")).toEqual([]);
    const healed = mondayWrites().find(cv => life().col in cv);
    expect(healed?.[life().col]).toEqual({ label: "7.Intention to purchase" });
    expect(healed?.[jobtitle().col]).toBe("Head");
  });

  it("a stage that fails after the clear heals only the STAGE (restored): the other cells landed and stay", async () => {
    replies = [ok(CLEARED, { jobtitle: "Buyer" }), rejected(), rejected(), ok(RESTORED, { lifecyclestage: "opportunity" })];
    await editCells(testTt(), { [life().col]: "3.Competitors", [jobtitle().col]: "Buyer" });
    expect(patches()).toEqual([
      { jobtitle: "Buyer", lifecyclestage: "" }, { lifecyclestage: "1028988526" }, { lifecyclestage: "1028988526" },
      { lifecyclestage: "opportunity" },
    ]);
    const healed = mondayWrites().find(cv => life().col in cv);
    expect(healed?.[life().col]).toEqual({ label: "7.Intention to purchase" });
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(jobtitle().col);
    expect(syncStamps()).toEqual([RESTORED]);            // the card now reflects HubSpot as of the restore
  });
});

describe("a set AND a restore that both fail: the card is never told a stage HubSpot does not hold", () => {
  it("the card keeps the person's stage, Sync State does not move past the clear, and the log says what is pending", async () => {
    replies = [ok(CLEARED), rejected(), rejected(), rejected("restore refused")];
    await editStage(testTt(), "3.Competitors");
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
    for (const s of syncStamps()) expect(Date.parse(String(s))).toBeLessThan(Date.parse(CLEARED));
    const line = logged("action=lifecycle-backward-failed")[0];
    expect(line).toMatch(/restore="failed: .*restore refused/);
    expect(line).toContain("pending=lifecyclestage");
  });

  it("a restore that is confirmed still heals the card, stamped from the restore (unchanged behaviour)", async () => {
    replies = [ok(CLEARED), rejected(), rejected(), ok(RESTORED)];
    await editStage(testTt(), "3.Competitors");
    expect(mondayWrites().find(cv => life().col in cv)?.[life().col]).toEqual({ label: "7.Intention to purchase" });
    expect(syncStamps()).toEqual([RESTORED]);
  });
});

describe("the re-check is armed in the durable queue BEFORE anything is cleared", () => {
  it("a backward move hands the record to DEFERRED_SYNC first, then clears, then sets", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    await editStage(testTt(), "3.Competitors", live, durableEnv());
    expect(enqueue).toHaveBeenCalledTimes(1);
    // A RE-CHECK, not an update: the queue runs recheckDanglingClears for it, never a forward pass.
    expect(enqueue.mock.calls[0][0]).toEqual([{ type: "contact", id: "42000269320", recheck: true }]);
    const firstPatch = fetchMock.mock.calls.findIndex(c => c[1]?.method === "PATCH");
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[firstPatch]);
  });

  it.each([
    ["a forward move", "lead", "7.Intention to purchase"],
    ["a first fill", "", "3.Competitors"],
    ["an emptied cell", "opportunity", ""],
  ])("%s arms nothing (one PATCH, nothing to repair)", async (_why, from, label) => {
    await editStage(testTt({ lifecyclestage: from }), label, live, durableEnv());
    expect(patches()).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a dry run arms nothing, and an ownership refusal arms nothing", async () => {
    await editStage(testTt(), "3.Competitors", { ...live, dryRun: true }, durableEnv());
    await editStage(testTt({ sync_owner: "wm" }), "3.Competitors", live, durableEnv());
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a deployment without the queue (no DEFERRED_SYNC) still clears and sets", async () => {
    replies = [ok(CLEARED), ok(PUSHED)];
    await editStage(testTt(), "3.Competitors");
    expect(patches()).toEqual([{ lifecyclestage: "" }, { lifecyclestage: "1028988526" }]);
  });
});

describe("the re-check: a forward pass that finds the stage emptied by OUR clear fills it from the card", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date(REPAIR_NOW) }); });
  afterEach(() => { vi.useRealTimers(); });

  /** HubSpot emptied at CLEARED, the card showing `shown` and stamped `stamp`. */
  async function recheck(shown: string, opts: { stamp?: string; over?: Record<string, string> } = {}) {
    const rec = testTt({ lifecyclestage: "", lastmodifieddate: CLEARED, ...opts.over });
    monday.findItemByColumn.mockResolvedValue([card(testTt(), opts.stamp ?? MOD, { [life().col]: shown })]);
    hubspot.getRecord.mockResolvedValue(rec);
    return syncHubspotRecord(env, CRM_CONTACTS, "42000269320", live, { left: 30 });
  }

  it("the person's stage still on the card (the isolate died after the clear): it is sent, and stamped", async () => {
    history = ourClear();
    replies = [ok(PUSHED, { lifecyclestage: "1028988526" })];
    await recheck("3.Competitors");
    expect(historyReads()).toHaveLength(1);
    expect(patches()).toEqual([{ lifecyclestage: "1028988526" }]);
    expect(logged("action=lifecycle-clear-repaired")).toHaveLength(1);
    expect(logged("action=lifecycle-clear-repaired")[0]).toContain(`value="1028988526"`);
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
    expect(syncStamps()).toEqual([PUSHED]);
  });

  it("the previous stage on the card (an earlier heal): that is what goes back -- HubSpot and card agree again", async () => {
    history = ourClear();
    await recheck("7.Intention to purchase");
    expect(patches()).toEqual([{ lifecyclestage: "opportunity" }]);
  });

  it.each([
    ["a PERSON emptied it in HubSpot (CRM_UI)", ourClear(CLEARED, { sourceType: "CRM_UI", sourceId: "userId:164317533" })],
    ["the clear is older than the window", ourClear("2026-09-30T04:25:41.100Z")],
    ["nothing was cleared (no earlier value)", [{ value: "", timestamp: CLEARED, sourceType: "INTEGRATION" }]],
    ["HubSpot's newest version is not empty after all (a read that lagged)", [{ value: "1028988526", timestamp: CLEARED, sourceType: "INTEGRATION" }]],
    ["no history at all", []],
  ])("never when %s: nothing is written, and it is logged", async (_why, h) => {
    history = h as Version[];
    await recheck("3.Competitors");
    expect(historyReads()).toHaveLength(1);
    expect(patches()).toEqual([]);
    expect(logged("action=lifecycle-empty-left")).toHaveLength(1);
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
  });

  it("never on a record CRM does not own: refused before even the history is read, nothing written", async () => {
    history = ourClear();
    await recheck("3.Competitors", { over: { sync_owner: "wm" } });
    expect(historyReads()).toEqual([]);
    expect(patches()).toEqual([]);
    expect(logged("action=lifecycle-clear-repair-refused")).toHaveLength(1);
  });

  it("not even a read when the card is empty too, or HubSpot has not changed since Sync State", async () => {
    await recheck("");
    await recheck("3.Competitors", { stamp: CLEARED });
    expect(historyReads()).toEqual([]);
    expect(patches()).toEqual([]);
  });

  it("a dry run reads, but writes nothing", async () => {
    history = ourClear();
    const rec = testTt({ lifecyclestage: "", lastmodifieddate: CLEARED });
    monday.findItemByColumn.mockResolvedValue([card(testTt(), MOD, { [life().col]: "3.Competitors" })]);
    hubspot.getRecord.mockResolvedValue(rec);
    await syncHubspotRecord(env, CRM_CONTACTS, "42000269320", { ...live, dryRun: true }, { left: 30 });
    expect(fetchMock.mock.calls.filter(c => c[1]?.method === "PATCH")).toEqual([]);
    expect(logged("DRY hubspot PATCH contacts/42000269320")).toHaveLength(1);
  });

  it("a repair HubSpot refuses NOW throws (so the queue tries again) and leaves Sync State behind the clear", async () => {
    history = ourClear();
    replies = [rejected("try later")];
    await expect(recheck("3.Competitors")).rejects.toThrow(/lifecyclestage/);
    for (const s of syncStamps()) expect(Date.parse(String(s))).toBeLessThan(Date.parse(CLEARED));
  });
});

// ------------------------------------------------------------------------------------------------
// 12. The reviewer's scenarios, end to end, against a HubSpot that ignores backward moves as the live one
//     does. hs() backs off with setTimeout; here it runs at once, so 18 s of backoff costs nothing.
// ------------------------------------------------------------------------------------------------

describe("end to end against a stateful HubSpot", () => {
  let realSetTimeout: typeof setTimeout;
  beforeEach(() => {
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as never;
    model = {
      props: { ...(testTt().properties as Record<string, string>) },
      history: [
        { value: "lead", timestamp: PRE, sourceType: "IMPORT", sourceId: "49222891" },
        { value: "opportunity", timestamp: "2026-08-06T03:08:12.141Z", sourceType: "DEALS", sourceId: "deals-lifecycle-sync" },
      ],
      clock: Date.parse("2026-10-01T04:25:41.000Z"),
    };
    hubspot.getRecord.mockImplementation(async () => ({ id: "42000269320", properties: { ...model!.props } }));
  });
  afterEach(() => { globalThis.setTimeout = realSetTimeout; vi.useRealTimers(); });

  /** The card after the edit's run: the person's cell, plus whatever that run wrote back. */
  function cardAfterRun(): MondayItem {
    const c = card(testTt(), MOD, { [life().col]: "3.Competitors" });
    for (const cv of mondayWrites()) for (const [col, v] of Object.entries(cv)) {
      const text = typeof v === "string" ? v : (v as { label?: string })?.label ?? "";
      const hit = c.column_values.find(x => x.id === col);
      if (hit) hit.text = text; else c.column_values.push({ id: col, text });
    }
    return c;
  }
  /** What the deferred queue runs ~15 s later for the re-check armRecheck queued (DeferredItem.recheck):
   *  recheckDanglingClears, which reads HubSpot as it is NOW and then the card -- and writes monday nothing. */
  async function theRecheck(c: MondayItem = cardAfterRun()): Promise<string> {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 15_000) });
    monday.findItemByColumn.mockResolvedValue([c]);
    hubspot.getRecord.mockImplementation(async () => ({ id: "42000269320", properties: { ...model!.props } }));
    return recheckDanglingClears(durableEnv(), "contact", "42000269320", live, { left: 30 });
  }
  /** `c`, showing `text` in column `col`. */
  const withCell = (c: MondayItem, col: string, text: string): MondayItem =>
    ({ ...c, column_values: [...c.column_values.filter(x => x.id !== col), { id: col, text }] });
  /** A person's edit of `cols` on the card `c`, with HubSpot read live from the model. */
  async function personEdits(c: MondayItem | MondayItem[], cols: string[]): Promise<string> {
    for (const x of ([] as MondayItem[]).concat(c)) monday.getItem.mockResolvedValueOnce(x);
    monday.getItem.mockResolvedValue(([] as MondayItem[]).concat(c).at(-1));
    hubspot.getRecord.mockImplementation(async () => ({ id: "42000269320", properties: { ...model!.props } }));
    return syncMondayItem(durableEnv(), CRM_CONTACTS.boardId, "2855744260", live, { left: 30 }, false, false,
      { cols, actor: "104231430" });
  }

  it("P1: the clear lands, every request after it 503s -- and the queued re-check sets the person's stage", async () => {
    model!.fail = b => b.lifecyclestage === "" ? undefined : 503;
    await editStage(testTt(), "3.Competitors", live, durableEnv());
    expect(model!.props.lifecyclestage).toBe("");                     // the state the finding describes
    expect(enqueue).toHaveBeenCalledTimes(1);                          // ...but the re-check is already queued
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);

    model!.fail = undefined;                                            // HubSpot recovers
    const mondayBefore = mondayWrites().length;
    await theRecheck();
    expect(model!.props.lifecyclestage).toBe("1028988526");            // Matthew's 3.Competitors, at last
    expect(cardAfterRun().column_values.find(c => c.id === life().col)?.text).toBe("3.Competitors");
    expect(mondayWrites()).toHaveLength(mondayBefore);                  // a repair: monday is not written
  });

  it("the isolate dies between the clear and the set (a request never answered): the re-check still lands it", async () => {
    model!.fail = b => b.lifecyclestage === "" ? undefined : "hang";
    void editStage(testTt(), "3.Competitors", live, durableEnv());   // cancelled mid-flight: never resumes
    await vi.waitFor(() => expect(model!.props.lifecyclestage).toBe(""));
    expect(enqueue).toHaveBeenCalledTimes(1);

    model!.fail = undefined;
    await theRecheck();
    expect(model!.props.lifecyclestage).toBe("1028988526");
  });

  it("a set that DOES land: the re-check finds everything in line and writes nothing to HubSpot", async () => {
    await editStage(testTt(), "3.Competitors", live, durableEnv());
    expect(model!.props.lifecyclestage).toBe("1028988526");
    const before = patches().length;
    await theRecheck();
    expect(patches()).toHaveLength(before);
    expect(historyReads()).toEqual([]);
  });

  it("P4: a deterministic 400 on another column of the edit: nothing is cleared, HubSpot keeps 7", async () => {
    model!.fail = b => "jobtitle" in b ? 400 : undefined;
    await editCells(testTt(), { [life().col]: "3.Competitors", [jobtitle().col]: "Buyer" }, live, durableEnv());
    expect(model!.props.lifecyclestage).toBe("opportunity");
    expect(patches()).toHaveLength(1);
    expect(mondayWrites().find(cv => life().col in cv)?.[life().col]).toEqual({ label: "7.Intention to purchase" });
  });

  // --------------------------------------------------------------------------------------------------
  // Review round 3, finding 1: the queued re-check ran a FULL forward pass, ~15 s after every backward
  // move. HubSpot bumps lastmodifieddate on its own ~7 s after each stage change (read live on 553232416501:
  // INTEGRATION 03:10:17.297, then sourceType API at 03:10:24.585 and .740), so that pass found HubSpot
  // newer than Sync State and copied HubSpot's value over any cell that differed -- a person's next edit
  // still on its way included.
  // --------------------------------------------------------------------------------------------------

  it("PROBE-CLOBBER: a move that LANDED, HubSpot's own bump, a Job Title edit in flight -> the re-check writes monday nothing", async () => {
    model!.props.jobtitle = "Head";
    await editStage(testTt({ jobtitle: "Head" }), "3.Competitors", live, durableEnv());
    expect(model!.props.lifecyclestage).toBe("1028988526");
    const stamped = String(syncStamps().at(-1));
    model!.clock += 7_000; model!.props.lastmodifieddate = new Date(model!.clock).toISOString();  // HubSpot's bump
    // ~+13 s: Matthew types a new Job Title. monday shows it; its run has not pushed yet.
    const typed = card(testTt({ jobtitle: "Head" }), stamped, { [life().col]: "3.Competitors", [jobtitle().col]: "Buyer" });
    const before = { monday: mondayWrites().length, patches: patches().length };
    await theRecheck(typed);                                            // ~+15 s
    expect(mondayWrites().slice(before.monday)).toEqual([]);
    expect(patches()).toHaveLength(before.patches);
    expect(historyReads()).toEqual([]);                                 // the stage is set: nothing to look up
    // ...so his own run, reading the card after the re-check, still finds 'Buyer' to send.
    await personEdits(typed, [jobtitle().col]);
    expect(model!.props.jobtitle).toBe("Buyer");
    for (const cv of mondayWrites().slice(before.monday)) expect(cv[jobtitle().col]).not.toBe("Head");
  });

  it("the re-check never creates a card, and says so when there is none", async () => {
    model!.fail = b => b.lifecyclestage === "" ? undefined : 503;
    await editStage(testTt(), "3.Competitors", live, durableEnv());
    model!.fail = undefined;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 15_000) });
    monday.findItemByColumn.mockResolvedValue([]);
    hubspot.getRecord.mockImplementation(async () => ({ id: "42000269320", properties: { ...model!.props } }));
    const line = await recheckDanglingClears(durableEnv(), "contact", "42000269320", live, { left: 30 });
    expect(line).toContain("action=skipped");
    expect(ensure.ensureCardForRecord).not.toHaveBeenCalled();
    expect(model!.props.lifecyclestage).toBe("");
  });

  it("a re-check that cannot finish throws, so the queue tries again -- and writes monday nothing either way", async () => {
    model!.fail = b => b.lifecyclestage === "" ? undefined : 503;
    await editStage(testTt(), "3.Competitors", live, durableEnv());
    const mondayBefore = mondayWrites().length;
    await expect(theRecheck()).rejects.toThrow(/lifecycle re-check of contacts\/42000269320 lifecyclestage/);
    expect(mondayWrites()).toHaveLength(mondayBefore);
    model!.fail = undefined;                                             // the queue's next attempt
    await theRecheck();
    expect(model!.props.lifecyclestage).toBe("1028988526");
  });

  // --------------------------------------------------------------------------------------------------
  // Review round 3, finding 2 (B1): the clear landed, the set and the restore did not, HubSpot holds "" and
  // Sync State stays behind the clear for the re-check. The SAME person then edits another column. That run
  // went through reconcileColumnEdit, which never looked for the unfinished clear, and stamped Sync State
  // with its own push time -- so every later re-check and echo found HubSpot "not newer" and left the stage
  // empty for good.
  // --------------------------------------------------------------------------------------------------

  /** Leaves HubSpot holding "" from our clear: the set (twice) and the restore all fail. */
  async function danglingClear(): Promise<void> {
    model!.fail = b => b.lifecyclestage === "" ? undefined : 503;
    await editStage(testTt(), "3.Competitors", live, durableEnv());
    expect(model!.props.lifecyclestage).toBe("");
    expect(syncStamps()).toEqual([]);                                     // Sync State held behind the clear
  }

  it("B1: a dangling clear, then the person edits Job Title -> that run finishes the stage first, then sends Job Title", async () => {
    await danglingClear();
    model!.fail = undefined;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 5_000) });
    const before = { patches: patches().length, monday: mondayWrites().length };
    await personEdits(withCell(cardAfterRun(), jobtitle().col, "Buyer"), [jobtitle().col]);
    expect(patches().slice(before.patches)).toEqual([{ lifecyclestage: "1028988526" }, { jobtitle: "Buyer" }]);
    expect(model!.props.lifecyclestage).toBe("1028988526");
    expect(model!.props.jobtitle).toBe("Buyer");
    expect(logged("action=lifecycle-clear-repaired")).toHaveLength(1);
    for (const cv of mondayWrites().slice(before.monday)) expect(cv).not.toHaveProperty(life().col);
    expect(syncStamps()).toEqual([model!.props.lastmodifieddate]);        // stamped once HubSpot holds both
    // And nothing is left for the re-check (the probe's final read: "" -- now the person's stage).
    const p = patches().length;
    await theRecheck(withCell(cardAfterRun(), jobtitle().col, "Buyer"));
    expect(patches()).toHaveLength(p);
  });

  it("B1: the card that run read predates the person's stage edit -> the repair sends what the card shows NOW", async () => {
    await danglingClear();
    model!.fail = undefined;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 5_000) });
    // The Job Title run read the card before the stage edit (still 7) and HubSpot after its clear ("").
    const stale = withCell(withCell(cardAfterRun(), life().col, "7.Intention to purchase"), jobtitle().col, "Buyer");
    const fresh = withCell(cardAfterRun(), jobtitle().col, "Buyer");
    const before = { patches: patches().length, monday: mondayWrites().length, reads: monday.getItem.mock.calls.length };
    await personEdits([stale, fresh], [jobtitle().col]);
    expect(patches().slice(before.patches)[0]).toEqual({ lifecyclestage: "1028988526" });   // not "opportunity"
    expect(model!.props.lifecyclestage).toBe("1028988526");
    expect(monday.getItem.mock.calls.length - before.reads).toBe(2);     // the edit's own read, and the re-read
    // ...and the run does not then "forward" that stage over its own, older read of the cell: the cell already
    // shows it, and a write there could only land over a change made since.
    for (const cv of mondayWrites().slice(before.monday)) expect(cv).not.toHaveProperty(life().col);
  });

  it("B1: a repair HubSpot still refuses -> Sync State does not move, and the re-check is armed again", async () => {
    model!.fail = b => "lifecyclestage" in b && b.lifecyclestage !== "" ? 503 : undefined;
    await editStage(testTt(), "3.Competitors", live, durableEnv());
    expect(model!.props.lifecyclestage).toBe("");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 5_000) });
    const before = { monday: mondayWrites().length, enqueued: enqueue.mock.calls.length };
    await personEdits(withCell(cardAfterRun(), jobtitle().col, "Buyer"), [jobtitle().col]);
    expect(model!.props.jobtitle).toBe("Buyer");                          // the person's own edit still lands
    expect(model!.props.lifecyclestage).toBe("");
    for (const cv of mondayWrites().slice(before.monday)) expect(cv).not.toHaveProperty(CRM_CONTACTS.syncStateCol);
    expect(enqueue.mock.calls.slice(before.enqueued).map(c => c[0]))
      .toEqual([[{ type: "contact", id: "42000269320", recheck: true }]]);
    expect(logged("action=lifecycle-clear-repair-failed").length).toBeGreaterThan(0);
    model!.fail = undefined;                                              // HubSpot recovers: the re-check lands it
    await theRecheck(withCell(cardAfterRun(), jobtitle().col, "Buyer"));
    expect(model!.props.lifecyclestage).toBe("1028988526");
  });

  it("B1: an edit OF the stage itself is pushed as the edit it is (from empty, one PATCH), not repaired from the card", async () => {
    await danglingClear();
    model!.fail = undefined;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 5_000) });
    const before = { patches: patches().length, reads: historyReads().length };
    await personEdits(withCell(cardAfterRun(), life().col, "5.No intention"), [life().col]);
    expect(patches().slice(before.patches)).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(historyReads()).toHaveLength(before.reads);
    expect(model!.props.lifecyclestage).toBe("1029060900");
  });

  // A person who EMPTIES the Lifecycle cell on monday sends one PATCH of "" -- which HubSpot's history also
  // records as an INTEGRATION clear of a set value, the very shape a dangling clear has. What tells them
  // apart is Sync State: that push stamps it AT the clear (read live 2026-10-01: a write's history timestamp
  // IS the lastmodifieddate it sets -- INTEGRATION 03:10:17.297 on both, CRM_UI 03:12:57.175 on both), while a
  // dangling clear always leaves Sync State strictly before it. Probed as PROBE B (r2safety): without this,
  // our own token writing a stage into the emptied cell was sent to HubSpot as a "repair".
  /** A person empties the cell: HubSpot "" from our push, Sync State stamped at it; then HubSpot's own bump. */
  async function deliberateClear(): Promise<string> {
    await editStage(testTt(), "", live, durableEnv());
    expect(model!.props.lifecyclestage).toBe("");
    const stamp = String(syncStamps().at(-1));
    expect(stamp).toBe(model!.history.at(-1)!.timestamp);          // stamped AT the clear
    model!.clock += 7_000; model!.props.lastmodifieddate = new Date(model!.clock).toISOString();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 10 * 60_000) });
    return stamp;
  }

  it("PROBE B: a person's own monday clear, then OUR TOKEN writes a stage into the cell -> HubSpot is not written", async () => {
    const stamp = await deliberateClear();
    const before = patches().length;
    monday.getItem.mockResolvedValue(card(testTt(), stamp, { [life().col]: "8.The customer generating the transaction" }));
    hubspot.getRecord.mockImplementation(async () => ({ id: "42000269320", properties: { ...model!.props } }));
    await syncMondayItem(durableEnv(), CRM_CONTACTS.boardId, "2855744260", live, { left: 30 }, false, true, { cols: [life().col] });
    expect(patches().slice(before)).toEqual([]);
    expect(model!.props.lifecyclestage).toBe("");
    expect(logged("action=lifecycle-empty-left").at(-1)).toMatch(/not newer than Sync State/);
  });

  it("PROBE B, through a person's edit of ANOTHER column: still only that column is sent", async () => {
    const stamp = await deliberateClear();
    const before = patches().length;
    await personEdits(card(testTt(), stamp, { [life().col]: "8.The customer generating the transaction",
      [jobtitle().col]: "Buyer" }), [jobtitle().col]);
    expect(patches().slice(before)).toEqual([{ jobtitle: "Buyer" }]);
    expect(model!.props.lifecyclestage).toBe("");
  });

  it("PROBE B, through the queued re-check: nothing is sent either", async () => {
    const stamp = await deliberateClear();
    const before = patches().length;
    await theRecheck(card(testTt(), stamp, { [life().col]: "8.The customer generating the transaction" }));
    expect(patches()).toHaveLength(before);
  });

  it("B1: an empty stage a PERSON left in HubSpot is not ours: left as it is, and the edit stamps as usual", async () => {
    model!.props.lifecyclestage = "";
    model!.history.push({ value: "", timestamp: new Date(model!.clock).toISOString(), sourceType: "CRM_UI", sourceId: "userId:164317533" });
    model!.props.lastmodifieddate = new Date(model!.clock).toISOString();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(model!.clock + 5_000) });
    await personEdits(card(testTt(), MOD, { [life().col]: "7.Intention to purchase", [jobtitle().col]: "Buyer" }), [jobtitle().col]);
    expect(patches()).toEqual([{ jobtitle: "Buyer" }]);
    expect(model!.props.lifecyclestage).toBe("");
    expect(logged("action=lifecycle-empty-left")).toHaveLength(1);
    expect(syncStamps()).toEqual([model!.props.lastmodifieddate]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("danglingClearVerdict and Sync State", () => {
  const now = Date.parse(REPAIR_NOW);
  it("a clear newer than Sync State can be ours (a move's half: Sync State was held behind it)", () =>
    expect(danglingClearVerdict(ourClear(), now, Date.parse(MOD))).toBeNull());
  it("a clear AT Sync State is one monday already took -- a person's own clear, sent from monday", () =>
    expect(danglingClearVerdict(ourClear(), now, Date.parse(CLEARED))).toMatch(/not newer than Sync State/));
  it("and one before it, likewise", () =>
    expect(danglingClearVerdict(ourClear(), now, Date.parse(PUSHED))).toMatch(/not newer than Sync State/));
  it("an empty or unreadable Sync State does not decide it (the other rules still do)", () => {
    expect(danglingClearVerdict(ourClear(), now, NaN)).toBeNull();
    expect(danglingClearVerdict(ourClear(), now)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// 13. Finding 2 (B1), the create window's round: a stopped creator's settle (settleRound) stamps Sync State
//     too, so it must finish an unfinished clear before it does.
// ------------------------------------------------------------------------------------------------

describe("a create window's round finishes a dangling clear before it stamps", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date(REPAIR_NOW) }); });
  afterEach(() => { vi.useRealTimers(); });

  async function settle(): Promise<string> {
    hubspot.getRecord.mockResolvedValue(testTt({ lifecyclestage: "", lastmodifieddate: CLEARED }));
    monday.getItem.mockResolvedValue(card(testTt(), MOD, { [life().col]: "3.Competitors" }));
    return settleAbandonedCreate({ ...env, CREATE_WINDOW_REPLAY: "true" } as unknown as Env, CRM_CONTACTS.boardId,
      "2855744260", "42000269320", { entries: [], snapshot: { built: {}, sent: {}, at: Date.parse(CLEARED) } },
      undefined, live, { left: 30 });
  }

  it("the card's stage is sent, and the round stamps from that write", async () => {
    history = ourClear();
    replies = [ok(PUSHED, { lifecyclestage: "1028988526" })];
    await settle();
    expect(patches()).toEqual([{ lifecyclestage: "1028988526" }]);
    expect(logged("action=lifecycle-clear-repaired")).toHaveLength(1);
    expect(syncStamps()).toEqual([PUSHED]);
    for (const cv of mondayWrites()) expect(cv).not.toHaveProperty(life().col);
  });

  it("a repair HubSpot refuses now: the round leaves Sync State where it was", async () => {
    history = ourClear();
    replies = [rejected("try later")];
    await settle();
    expect(patches()).toEqual([{ lifecyclestage: "1028988526" }]);
    expect(syncStamps()).toEqual([]);
    expect(logged("action=lifecycle-clear-repair-failed")).toHaveLength(1);
  });
});
