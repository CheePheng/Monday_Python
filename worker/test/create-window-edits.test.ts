import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import type { Budget, Env, MondayEdit, RunOpts } from "../src/types";

/**
 * A PERSON'S EDIT MADE WHILE ITS CARD'S HUBSPOT RECORD IS BEING CREATED.
 *
 * The live case, 2026-09-30 17:40Z (user 104231430, Deals board): on a brand-new card, HubSpot Stage was
 * changed twice within seconds. The first change created the deal with that value. The second -- the
 * value the person actually wanted -- arrived while the create was in flight and was lost: skipped at
 * the claim as "creating", or folded into the in-flight run. Then the forward pass after HubSpot's
 * creation webhook copied HubSpot's create-time value over the card, because HubSpot's own post-create
 * recalculation had made the record look newer than the card's Sync State. Card and HubSpot both ended
 * on the value the person had moved AWAY from.
 *
 * Driven through the real syncMondayItem / syncHubspotObject, the real card registry and the REAL
 * CreateIdempotency Durable Object (in-memory storage, a real critical section), with HubSpot and monday
 * as small STATEFUL fakes. So every claim below is proven by what the two systems end up holding, not by
 * which function was called.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));

// ------------------------------------------------------------------------------------------ fakes

/** HubSpot: a store of deals. */
const hub = vi.hoisted(() => ({
  records: new Map<string, Record<string, string>>(),
  nextId: 9001,
  t: 0,
  patches: [] as { id: string; patch: Record<string, string> }[],
}));
const hs = vi.hoisted(() => ({
  createRecord: vi.fn(), getRecord: vi.fn(), patchRecord: vi.fn(), claimOwnership: vi.fn(),
  getCrmStageDicts: vi.fn(), getDealStageLabels: vi.fn(), getOwners: vi.fn(), getPropertyOptions: vi.fn(),
  searchAll: vi.fn(), searchModifiedIds: vi.fn(), searchContactByEmail: vi.fn(), searchCompanyByDomain: vi.fn(),
  // STALE_FORWARD_GATE's read: never the real one (a live HubSpot GET) should a test here ever turn the gate on.
  getRecordWithHistory: vi.fn(async () => { throw new Error("getRecordWithHistory is not faked in this file"); }),
}));
// The real module for everything pure (propertiesForSpec, OwnershipError, ...); every network call faked.
vi.mock("../src/hubspot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hubspot")>()), ...hs,
}));

/** monday: cards by item id, as column id -> display text. */
const md = vi.hoisted(() => ({
  cards: new Map<string, { name: string; created_at: string; cols: Record<string, string> }>(),
  /** Cards whose id (and Sync State, written in the same mutation) monday has not served back yet. */
  unserved: new Set<string>(),
  /** The id-column search is eventually consistent; it finds nothing unless a test says so. */
  indexed: false,
}));
const mondayApi = vi.hoisted(() => ({
  getItem: vi.fn(), setColumns: vi.fn(), updateItem: vi.fn(), findItemByColumn: vi.fn(), createItem: vi.fn(),
  deleteItem: vi.fn(), moveItem: vi.fn(), getUsersByEmail: vi.fn(), getBoardItems: vi.fn(),
  getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(),
  // STALE_FORWARD_GATE's reads and write (inert here: the gate is off in every test of this file).
  getItemFresh: vi.fn(), getLinkedCell: vi.fn(), updateColumns: vi.fn(),
}));
vi.mock("../src/monday", () => mondayApi);

// Associations are out of scope here (test/born-attached.test.ts owns the birth pass); the birth pass is
// only a place where a test can hold the create mid-way.
const assoc = vi.hoisted(() => ({
  pushBirthAssociations: vi.fn(), reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(),
}));
vi.mock("../src/associations", () => assoc);

const { syncMondayItem, syncHubspotObject, resetCtxCache, createWindowReplayOn, CREATE_WINDOW_MS } = await import("../src/sync");
const { DEALS } = await import("../src/config");
const { CreateIdempotency, RETENTION_MS } = await import("../src/create-idempotency-do");
const { CREATE_CLAIM_STALE_MS: CREATE_CLAIM_STALE } = await import("../src/card-registry");

/** Storage for one Durable Object, with blockConcurrencyWhile as a real critical section. Its one alarm
 *  is recorded, not fired: a test fires it by calling the object's alarm() when the clock says so. */
function doCtx() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage: {
      get: async (k: string) => structuredClone(map.get(k)),
      put: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
      delete: async (k: string) => { map.delete(k); },
      deleteAll: async () => { map.clear(); },
      setAlarm: async (t: number) => { alarm = t; }, deleteAlarm: async () => { alarm = null; },
      getAlarm: async () => alarm,
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn);
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
let objects: Map<string, any>;
let doKeys: string[];
const namespace = {
  idFromName: (n: string) => n,
  get: (id: string) => {
    doKeys.push(id);
    let o = objects.get(id);
    // The Worker's env, as the runtime gives every Durable Object: the row's alarm runs a sync with it.
    if (!o) { o = new (CreateIdempotency as any)(doCtx(), runEnv); objects.set(id, o); }
    return o;
  },
};

// Both kill switches ON, as the deploy passes them: every test below runs the create-window machinery,
// and BORN_ATTACHED_LINKS keeps the birth pass (the faked pushBirthAssociations) as a place a test can
// hold the create. The switch itself is proven in "the CREATE_WINDOW_REPLAY kill switch" at the end.
// DRY_RUN "false" is the live posture; only the row's own alarm reads it (webhookOpts, like the other
// Durable Objects): every event below is handed `live` directly.
const env = { ENABLE_CRM: "true", CRM_CREATE_CUTOFF_AT: "2026-09-01T00:00:00Z",
  CRM_CUTOVER_AT: "2026-09-25T00:00:00Z", CREATE_IDEMPOTENCY: namespace, DRY_RUN: "false",
  BORN_ATTACHED_LINKS: "true", CREATE_WINDOW_REPLAY: "true" } as unknown as Env;
/** The env every monday/HubSpot event below runs under; reset to `env` before each test. */
let runEnv: Env = env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const budget = (): Budget => ({ left: 30 });

// ------------------------------------------------------------------------------------------ fixtures

const STAGE = "dropdown_mm7624zd";            // "HubSpot Stage": the exact, two-way stage
const PIPELINE = "dropdown_mm76s7kk";
const AMOUNT = "deal_value";
const PROBABILITY = "deal_close_probability";
const COARSE = "deal_stage";                  // the native one-way summary
const CREATED = "date_mm7dgxym";
const A = "qualifiedtobuy", B = "presentationscheduled", C = "decisionmakerboughtin";
const LABEL: Record<string, string> = {
  appointmentscheduled: "Sales Pipeline / Appointment Scheduled",
  [A]: "Sales Pipeline / Qualified To Buy",
  [B]: "Sales Pipeline / Presentation Scheduled",
  [C]: "Sales Pipeline / Decision Maker Bought-In",
};
const COARSE_OF: Record<string, string> = { appointmentscheduled: "New", [A]: "New", [B]: "Proposal", [C]: "Negotiation" };

const CARD = "d-1";
const DEAL = "9001";
const PERSON = { id: "104231430", byAutomation: false };
const AUTOMATION = { id: "-4", byAutomation: true };
const ASK_ADA = { id: "104118038", byAutomation: false };

interface Hold { entered: Promise<void>; enter: () => void; gate: Promise<void>; release: () => void }
function makeHold(): Hold {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { release = r; });
  return { entered, enter, gate, release };
}
/** Held once, on the next call: HubSpot mid-create, or the create mid-way through its birth pass. */
let createHold: Hold | null;
let birthHold: Hold | null;
async function pass(h: Hold | null): Promise<Hold | null> { if (h) { h.enter(); await h.gate; } return null; }

/** What monday renders for a value we send it. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  const o = v as Record<string, any>;
  if (Array.isArray(o.labels)) return o.labels.join(", ");
  if ("label" in o) return String(o.label ?? "");
  if ("date" in o) return String(o.date ?? "");
  if ("text" in o) return String(o.text ?? "");
  if (Array.isArray(o.personsAndTeams)) return o.personsAndTeams.map((p: any) => p.id).join(",");
  return JSON.stringify(o);
}
function write(id: string, cv: Record<string, unknown>) {
  const c = md.cards.get(id);
  if (!c) throw new Error(`monday: no item ${id}`);
  for (const [k, v] of Object.entries(cv)) c.cols[k] = cellText(v);
}
function served(id: string) {
  const c = md.cards.get(id);
  if (!c) return null;
  const hidden = md.unserved.has(id) ? new Set([CRM_DEALS.idCol, CRM_DEALS.syncStateCol]) : new Set<string>();
  return { id, name: c.name, created_at: c.created_at, updated_at: "", group: { id: "topics" },
    column_values: Object.entries(c.cols).filter(([k]) => !hidden.has(k)).map(([k, text]) => ({ id: k, text })) };
}

/** HubSpot's clock: a little after real now, so a record created here is "recent". */
const stamp = () => new Date(Date.now() + (++hub.t) * 1000).toISOString();

let logs: string[];
const logLine = (re: RegExp) => logs.find(l => re.test(l));

beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  hub.records.clear(); hub.nextId = 9001; hub.t = 0; hub.patches = [];
  md.cards.clear(); md.unserved.clear(); md.indexed = false;
  objects = new Map(); doKeys = [];
  createHold = null; birthHold = null;
  runEnv = env;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });

  hs.getOwners.mockResolvedValue({});
  hs.getPropertyOptions.mockResolvedValue({});
  hs.getDealStageLabels.mockResolvedValue({});
  hs.getCrmStageDicts.mockResolvedValue({
    stages: LABEL, pipelines: { default: "Sales Pipeline" },
    pipelineByStage: Object.fromEntries(Object.keys(LABEL).map(s => [s, "default"])), coarse: COARSE_OF,
  });
  hs.searchContactByEmail.mockResolvedValue(null);
  hs.searchCompanyByDomain.mockResolvedValue(null);
  // Returns the create's own timestamp but STORES a later one: HubSpot recalculates a new record at once
  // (stage probability among it). That is what made the live forward pass read the record as newer.
  hs.createRecord.mockImplementation(async (_e: unknown, _s: unknown, props: Record<string, string>, o: RunOpts) => {
    if (o.dryRun || !o.writeHubspot) return null;
    createHold = await pass(createHold);
    const id = String(hub.nextId++);
    const born = stamp(), recalculated = stamp();
    hub.records.set(id, { ...props, hs_object_id: id, createdate: born, hs_lastmodifieddate: recalculated,
      hs_deal_stage_probability: "0.2" });
    return { id, modified: born };
  });
  hs.getRecord.mockImplementation(async (_e: unknown, _o: unknown, id: string) => {
    const r = hub.records.get(id);
    return r ? { id, properties: { ...r } } : null;
  });
  hs.patchRecord.mockImplementation(async (_e: unknown, _s: unknown, id: string, patch: Record<string, string>,
      o: RunOpts, auth?: { allowed: boolean }) => {
    if (auth && !auth.allowed) throw new Error("write refused");
    if (o.dryRun || !o.writeHubspot) return null;
    const r = hub.records.get(id)!;
    const mod = stamp();
    Object.assign(r, patch, { hs_lastmodifieddate: mod });
    hub.patches.push({ id, patch: { ...patch } });
    return mod;
  });

  mondayApi.getItem.mockImplementation(async (_e: unknown, id: string) => served(id));
  mondayApi.setColumns.mockImplementation(async (_e: unknown, _b: unknown, id: string, cv: Record<string, unknown>) =>
    write(id, cv));
  mondayApi.updateItem.mockImplementation(async (_e: unknown, _b: unknown, id: string, name: string,
      cv: Record<string, unknown>) => { md.cards.get(id)!.name = name; write(id, cv); });
  mondayApi.findItemByColumn.mockImplementation(async (_e: unknown, _b: unknown, col: string, value: string) =>
    md.indexed ? [...md.cards.keys()].filter(id => md.cards.get(id)!.cols[col] === value).map(served) : []);
  mondayApi.createItem.mockResolvedValue("a-duplicate-card");
  mondayApi.getUsersByEmail.mockResolvedValue({});
  mondayApi.moveItem.mockResolvedValue(undefined);

  assoc.pushBirthAssociations.mockImplementation(async () => { birthHold = await pass(birthHold); return null; });
  assoc.reverseAssociations.mockResolvedValue(undefined);
  assoc.syncAssociations.mockResolvedValue(undefined);
});

afterEach(() => { vi.restoreAllMocks(); });

/** A brand-new Deals card, made moments ago, showing the person's first choice of stage. */
function newCard(cols: Record<string, string> = {}) {
  md.cards.set(CARD, { name: "Acme renewal", created_at: new Date(Date.now() - 5_000).toISOString(),
    cols: { [CRM_DEALS.idCol]: "", [STAGE]: LABEL[A], ...cols } });
}
const setCell = (col: string, text: string) => { md.cards.get(CARD)!.cols[col] = text; };
const cell = (col: string) => md.cards.get(CARD)!.cols[col] ?? "";
const deal = () => hub.records.get(DEAL)!;
const sentProps = () => hub.patches.flatMap(p => Object.keys(p.patch));

const edit = (col: string): MondayEdit => ({ cols: [col] });
/** One monday webhook for the card, as handleMonday hands it to the sync. */
const onMonday = (e: MondayEdit | undefined, actor = PERSON, selfOrigin = false) =>
  syncMondayItem(runEnv, CRM_DEALS.boardId, CARD, live, budget(), false, selfOrigin,
    e && actor.byAutomation ? { ...e, byAutomation: true } : e, actor);
/** HubSpot's webhook for the deal (creation, property change, association change: all the same sync). */
const onHubspot = () => syncHubspotObject(runEnv, "deal", DEAL, live, budget());

/**
 * Start the create from the person's first Stage edit, and hold HubSpot mid-create. The run comes back
 * WRAPPED: an async function returning a bare promise would adopt it, and awaiting this would then wait
 * for the very create it is holding.
 */
async function createInFlight(): Promise<{ done: Promise<string> }> {
  createHold = makeHold();
  const h = createHold;
  const done = onMonday(edit(STAGE));
  await h.entered;
  return { done };
}

// ------------------------------------------------------------------------------------------ the live case
describe("the live sequence: HubSpot Stage changed twice, the second while the deal is being created", () => {
  it("ends with HubSpot AND the card on the SECOND value, and HubSpot's creation webhook cannot undo it", async () => {
    newCard();
    const first = (await createInFlight()).done;       // the first change creates the deal, from A
    setCell(STAGE, LABEL[B]);                          // ...and the person moves it on to B
    const second = await onMonday(edit(STAGE));        // another isolate: the create is still in flight
    expect(second).toMatch(/action=skipped/);
    expect(logLine(/card d-1 cols=dropdown_mm7624zd actor=104231430 class=person action=deferred-to-create/)).toBeDefined();

    createHold!.release();
    await first;
    await onHubspot();                                 // HubSpot's creation webhook, after the create

    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(COARSE)).toBe("Proposal");             // the native Stage follows the exact one
    expect(hs.createRecord).toHaveBeenCalledTimes(1);  // still one record
    expect(mondayApi.createItem).not.toHaveBeenCalled();   // and one card
    expect(logLine(/action=create-window-settled sent=dealstage,pipeline/)).toBeDefined();
  });

  it("the creation webhook arriving WHILE the create is still settling is left to the creator", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));                       // queued behind the create
    birthHold = makeHold();
    const h = birthHold;
    createHold!.release();
    await h.entered;                                   // the record exists and the card is findable...
    expect(cell(CRM_DEALS.idCol)).toBe(DEAL);
    const during = await onHubspot();                  // ...and HubSpot's webhook lands right now
    expect(during).toMatch(/action=skipped/);
    expect(logLine(/card d-1 hubspot_id=9001 action=left-to-settling-create/)).toBeDefined();
    expect(cell(STAGE), "the forward pass must not copy the create-time stage over the card").toBe(LABEL[B]);

    h.release();
    await first;
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
  });

  it("the same, folded into the in-flight run (same isolate): the creator holds the cell, the re-run sends it", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[B]);                          // the webhook coalesces this event into a re-run
    createHold!.release();
    await first;
    // The creator does not re-send its own column (it cannot tell who put the new value there); it leaves
    // the changed cell alone and sets the baseline, so nothing can copy the create-time stage back.
    expect(deal().dealstage).toBe(A);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(logLine(/action=create-window-settled .* held=dropdown_mm7624zd/)).toBeDefined();
    await onHubspot();                                 // the creation webhook, before the re-run
    expect(cell(STAGE)).toBe(LABEL[B]);
    await onMonday(edit(STAGE));                       // the coalesced re-run, which re-reads the card
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(hub.patches.filter(p => "dealstage" in p.patch)).toHaveLength(1);
  });

  it("an edit made AFTER the create settled, whose event trails HubSpot's webhook, is not overwritten", async () => {
    newCard();
    await onMonday(edit(STAGE));                       // the create, all the way through
    setCell(STAGE, LABEL[B]);                          // the person's second change is on screen...
    await onHubspot();                                 // ...HubSpot's creation webhook gets there first
    expect(cell(STAGE), "the baseline the create set means HubSpot is not 'newer' than the card").toBe(LABEL[B]);
    await onMonday(edit(STAGE));                       // then the edit's own event
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
  });

  it("an edit whose event has NOT arrived when the create settles is left on the card, then pushed by it", async () => {
    newCard();
    createHold = makeHold();
    const h = createHold;
    const created = onMonday(undefined);               // the form's item-created event: names no column
    await h.entered;
    setCell(STAGE, LABEL[B]);                          // the person's change is on screen; its event is late
    h.release();
    await created;
    expect(cell(STAGE), "the create must not treat a person's pending edit as stale").toBe(LABEL[B]);
    expect(deal().dealstage).toBe(A);                  // not sent yet: no event has asked for it
    expect(logLine(/action=create-window-settled .* held=dropdown_mm7624zd/)).toBeDefined();
    await onHubspot();                                 // HubSpot's creation webhook in between
    expect(cell(STAGE)).toBe(LABEL[B]);
    await onMonday(edit(STAGE));                       // the edit's own event, at last
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
  });

  it("what HubSpot changed on its own still reaches the card: its recalculation, dates, the summary Stage", async () => {
    newCard();
    await onMonday(edit(STAGE));
    expect(cell(PROBABILITY)).toBe("20");              // HubSpot's post-create recalculation (0.2 -> 20%)
    expect(cell(COARSE)).toBe("New");                  // one-way: always HubSpot's
    expect(cell(CREATED)).not.toBe("");
    expect(cell(PIPELINE)).toBe("Sales Pipeline");     // a create default the card never showed
    expect(cell(CRM_DEALS.syncStateCol)).toBe(deal().hs_lastmodifieddate);   // the baseline
  });
});

// ------------------------------------------------------------------------------------------ who edited
describe("an edit made during the create, by who made it", () => {
  it("a PERSON's edit of a DIFFERENT column is pushed; the create's own column is not re-sent", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(AMOUNT, "5000");
    await onMonday(edit(AMOUNT));
    createHold!.release();
    await first;
    expect(deal().amount).toBe("5000");
    expect(deal().dealstage).toBe(A);
    expect(sentProps()).toEqual(["amount"]);
    expect(cell(AMOUNT)).toBe("5000");
  });

  it("an AUTOMATION's edit is not pushed", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(AMOUNT, "999");
    await onMonday(edit(AMOUNT), AUTOMATION);
    expect(logLine(/class=automation action=deferred-to-create/)).toBeDefined();
    createHold!.release();
    await first;
    await onHubspot();
    expect(deal().amount).toBeUndefined();
    expect(hub.patches).toEqual([]);
    expect(logLine(/cols=deal_value actor=-4 class=automation action=create-window-edit-dropped/)).toBeDefined();
  });

  it("an automation's edit of a column HubSpot holds is not pushed, and the card shows HubSpot's value", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[C]);
    await onMonday(edit(STAGE), AUTOMATION);
    createHold!.release();
    await first;
    expect(deal().dealstage).toBe(A);
    expect(hub.patches).toEqual([]);
    expect(cell(STAGE)).toBe(LABEL[A]);
  });

  it("an 'ask ada' (our own token) edit is not pushed: it never reaches the create", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(AMOUNT, "777");
    const out = await onMonday(edit(AMOUNT), ASK_ADA, true);
    expect(out).toMatch(/refusing to create/);
    createHold!.release();
    await first;
    await onHubspot();
    expect(deal().amount).toBeUndefined();
    expect(hub.patches).toEqual([]);
  });

  it("our own echo of the linked card while the create settles changes nothing either", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));
    birthHold = makeHold();
    const h = birthHold;
    createHold!.release();
    await h.entered;
    const echo = await onMonday(edit(PIPELINE), ASK_ADA, true);   // e.g. the echo of a write of ours
    expect(echo).toMatch(/action=skipped/);
    expect(cell(STAGE)).toBe(LABEL[B]);
    h.release();
    await first;
    expect(deal().dealstage).toBe(B);
  });
});

// ------------------------------------------------------------------------------------------ the 'have' race
describe("the 'have' race: an edit after the create settled, before monday serves the id", () => {
  it("is applied as an edit of the now-linked record, not only re-stamped", async () => {
    newCard();
    await onMonday(edit(STAGE));                       // created and settled
    md.unserved.add(CARD);                             // monday's read still lacks the id it was given
    setCell(AMOUNT, "4200");
    const out = await onMonday(edit(AMOUNT));
    expect(logLine(/card d-1 re-stamped with 9001/)).toBeDefined();
    expect(logLine(/hubspot_id=9001 cols=deal_value action=replay-as-edit/)).toBeDefined();
    expect(out).toMatch(/action=updated-hubspot/);
    expect(deal().amount).toBe("4200");
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(cell(CRM_DEALS.idCol)).toBe(DEAL);
  });

  it("an automation's edit in the same race is re-stamped only, as before", async () => {
    newCard();
    await onMonday(edit(STAGE));
    md.unserved.add(CARD);
    setCell(AMOUNT, "4200");
    await onMonday(edit(AMOUNT), AUTOMATION);
    expect(logLine(/action=replay-as-edit/)).toBeUndefined();
    expect(deal().amount).toBeUndefined();
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
  });

  it("edits a dead creator left queued are applied by the next event that reads 'have'", async () => {
    useClock();
    newCard();
    const first = (await createInFlight()).done;
    setCell(AMOUNT, "3100");
    await onMonday(edit(AMOUNT));                      // queued while HubSpot made the record
    birthHold = makeHold();
    const h = birthHold;
    createHold!.release();
    await h.entered;                                   // the creator dies in its birth pass
    advance(31_000);
    md.unserved.add(CARD);
    const out = await onMonday(undefined);             // any later event on the row, e.g. a move
    expect(out).toMatch(/action=updated-hubspot/);
    expect(deal().amount).toBe("3100");
    expect(logLine(/card d-1 re-stamped with 9001/)).toBeDefined();
    h.release(); await first;
    expect(deal().amount).toBe("3100");
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
  });

  it("the registry keeps the baseline the settle wrote, for a replay on a read that lags it", async () => {
    newCard();
    await onMonday(edit(STAGE));
    const o = objects.get(`mdcreate:${CRM_DEALS.boardId}:${CARD}`);
    expect(cell(CRM_DEALS.syncStateCol)).not.toBe("");
    expect(await o.claimCard(Date.now())).toEqual({ status: "have", itemId: DEAL, baseline: cell(CRM_DEALS.syncStateCol) });
  });

  it("a card whose id write-back failed has no baseline: the replay brings HubSpot's values across", async () => {
    newCard();
    mondayApi.setColumns.mockImplementationOnce(async () => { throw new Error("monday 500"); });
    expect(await onMonday(edit(STAGE))).toMatch(/action=error/);
    expect(cell(CRM_DEALS.idCol)).toBe("");
    setCell(AMOUNT, "800");
    await onMonday(edit(AMOUNT));                      // re-stamped, and the edit applied
    expect(cell(CRM_DEALS.idCol)).toBe(DEAL);
    expect(deal().amount).toBe("800");
    expect(cell(PIPELINE), "never synced, so HubSpot's values are brought across").toBe("Sales Pipeline");
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------------------ unchanged
describe("nothing changes for a card that already has its id", () => {
  it("an established card's edit is pushed exactly as before, and the create registry is never consulted", async () => {
    hub.records.set("555", { dealname: "Old deal", dealstage: A, pipeline: "default", sync_owner: "crm",
      createdate: "2025-02-01T00:00:00Z", hs_lastmodifieddate: "2026-09-20T00:00:00Z" });
    md.cards.set(CARD, { name: "Old deal", created_at: "2025-02-01T00:00:00Z", cols: {
      [CRM_DEALS.idCol]: "555", [CRM_DEALS.syncStateCol]: "2026-09-20T00:00:00Z", [STAGE]: LABEL[B],
      [PIPELINE]: "Sales Pipeline", [COARSE]: "New" } });
    await onMonday(edit(STAGE));
    expect(hub.records.get("555")!.dealstage).toBe(B);
    expect(doKeys.filter(k => k.startsWith("mdcreate:"))).toEqual([]);
    expect(hs.createRecord).not.toHaveBeenCalled();
  });

  it("a recent card this Worker made for a HubSpot record syncs as before (no create is settling)", async () => {
    const born = stamp();
    hub.records.set("556", { dealname: "From HubSpot", dealstage: A, pipeline: "default", sync_owner: "crm",
      createdate: born, hs_lastmodifieddate: born });
    md.cards.set(CARD, { name: "From HubSpot", created_at: new Date().toISOString(), cols: {
      [CRM_DEALS.idCol]: "556", [CRM_DEALS.syncStateCol]: born, [STAGE]: LABEL[B], [PIPELINE]: "Sales Pipeline" } });
    await onMonday(edit(STAGE));
    expect(hub.records.get("556")!.dealstage).toBe(B);
    expect(logLine(/left-to-settling-create/)).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------ a creator that stalls or dies
/** Move the clock on (Date only: promises and the holds above are unaffected). */
function useClock() { vi.useFakeTimers({ toFake: ["Date"] }); }
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
afterEach(() => { vi.useRealTimers(); });

describe("a creator that stalls or dies after the record exists", () => {
  it("dies in its birth pass: a person's edit of the linked card is pushed at once, not parked", async () => {
    newCard();
    birthHold = makeHold();
    const h = birthHold;
    const first = onMonday(edit(STAGE));
    await h.entered;                                   // record made, id written... and the creator dies here
    setCell(AMOUNT, "5000");
    const out = await onMonday(edit(AMOUNT));          // monday serves the id now: the linked path
    expect(out).toMatch(/action=updated-hubspot/);
    expect(deal().amount, "nobody else would ever replay a parked edit").toBe("5000");
    expect(cell(AMOUNT)).toBe("5000");
    h.release(); await first;                          // (a very late creator changes nothing)
    expect(deal().amount).toBe("5000");
    expect(cell(AMOUNT)).toBe("5000");
  });

  it("dies in its birth pass with an edit queued: the next edit of the linked card sends that one too", async () => {
    useClock();
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));                       // queued while HubSpot made the record
    birthHold = makeHold();
    const h = birthHold;
    createHold!.release();
    await h.entered;                                   // ...and the creator dies here
    advance(31_000);                                   // its hold goes stale
    setCell(AMOUNT, "5000");
    await onMonday(edit(AMOUNT));
    expect(deal().amount).toBe("5000");
    expect(deal().dealstage, "the queued Stage edit is not left behind").toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    h.release(); await first;
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
  });

  it("stalls past its hold: HubSpot's creation webhook replays the queued edit instead of reverting it", async () => {
    useClock();
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));                       // queued
    birthHold = makeHold();
    const h = birthHold;
    createHold!.release();
    await h.entered;
    advance(31_000);                                   // a monday rate-limit wait in the birth pass
    await onHubspot();                                 // the creation webhook finds the hold stale
    expect(cell(STAGE), "the forward pass must not copy the create-time stage over it").toBe(LABEL[B]);
    expect(deal().dealstage).toBe(B);
    h.release(); await first;                          // the creator resumes and settles
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(COARSE)).toBe("Proposal");
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(mondayApi.createItem).not.toHaveBeenCalled();
  });

  it("a slow id write-back (monday's rate limit) does not let the hold lapse while its creator is alive", async () => {
    useClock();
    newCard();
    mondayApi.setColumns.mockImplementationOnce(async (_e: unknown, _b: unknown, id: string, cv: Record<string, unknown>) => {
      advance(25_000);                                 // the write-back waits out a rate limit
      write(id, cv);
    });
    birthHold = makeHold();
    const h = birthHold;
    const first = onMonday(edit(STAGE));
    await h.entered;                                   // written back; now in the birth pass
    setCell(STAGE, LABEL[B]);                          // a person's change on screen, its event late
    advance(10_000);                                   // 35 s since the hold, 10 s since the last heartbeat
    expect(await onHubspot()).toMatch(/action=skipped/);
    expect(cell(STAGE), "a live creator's card is not handed to the forward pass").toBe(LABEL[B]);
    h.release(); await first;
    expect(cell(STAGE)).toBe(LABEL[B]);
    await onMonday(edit(STAGE));
    expect(deal().dealstage).toBe(B);
  });

  it("an edit sent while the creator settles is not buried under an older baseline", async () => {
    newCard();
    birthHold = makeHold();
    const h = birthHold;
    const first = onMonday(edit(STAGE));
    await h.entered;
    // The settle reads HubSpot, then the card; a person's edit is pushed in between.
    mondayApi.getItem.mockImplementationOnce(async (_e: unknown, id: string) => {
      setCell(AMOUNT, "700");
      await onMonday(edit(AMOUNT));
      return served(id);
    });
    h.release(); await first;
    expect(deal().amount).toBe("700");
    expect(cell(AMOUNT)).toBe("700");
    expect(cell(CRM_DEALS.syncStateCol), "Sync State stays at the push, HubSpot's latest").toBe(deal().hs_lastmodifieddate);
  });

  it("an event whose read lags inside a live hold applies its own edit at once", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));                       // queued behind the create
    birthHold = makeHold();
    const h = birthHold;
    createHold!.release();
    await h.entered;
    md.unserved.add(CARD);                             // this event's read has no id yet
    setCell(AMOUNT, "6000");
    await onMonday(edit(AMOUNT));
    expect(deal().amount).toBe("6000");
    expect(cell(STAGE), "and it copies nothing of HubSpot's over the card").toBe(LABEL[B]);
    md.unserved.clear();
    h.release(); await first;
    expect(deal().dealstage).toBe(B);
    expect(deal().amount).toBe("6000");
    expect(cell(STAGE)).toBe(LABEL[B]);
  });
});

// ------------------------------------------------------------------------------------------ the row settles it
/** The create registry row of the card under test. */
const row = () => objects.get(`mdcreate:${CRM_DEALS.boardId}:${CARD}`);
const stored = async (k: string) => row().ctx.storage.get(k);
const alarmAt = async () => row().ctx.storage.getAlarm();
const WATCH_MARGIN = 5_000;

/**
 * THE MOST LIKELY TIMING OF A CREATOR THAT STOPS. The creator runs in a monday webhook's ~30 s waitUntil
 * and waits on monday's rate limit in its birth pass, so it is cut off after its hold with the person's
 * second edit still queued. HubSpot's creation webhook lands ~2 s later, inside the live hold, and is left
 * to that creator. Then nobody touches the card for minutes (2026-09-30 17:40Z). Before the row watched its
 * own hold, the queue waited for the next event, which was past the old 2-minute gate and reverted the card.
 */
async function creatorStopsAfterHold(): Promise<{ first: Promise<string>; creator: Hold; heldAt: number }> {
  useClock();
  newCard();
  const first = (await createInFlight()).done;       // the first change creates the deal, from A
  setCell(STAGE, LABEL[B]);
  await onMonday(edit(STAGE));                       // the second, queued behind the create
  birthHold = makeHold();
  const creator = birthHold;
  createHold!.release();
  await creator.entered;                             // the creator is cut off here, in its birth pass
  const heldAt = (await stored("card")).settlingAt as number;
  advance(2_000);
  expect(await onHubspot()).toMatch(/action=skipped/);   // HubSpot's creation webhook, left to the creator
  expect(logLine(/card d-1 hubspot_id=9001 action=left-to-settling-create/)).toBeDefined();
  expect(cell(STAGE)).toBe(LABEL[B]);
  return { first, creator, heldAt };
}

describe("a creator that stops after its hold: the row settles the card itself (its alarm)", () => {
  it("the hold arms the row's alarm for the moment it lapses; the alarm then sends the queued edit and what HubSpot did", async () => {
    const { first, creator, heldAt } = await creatorStopsAfterHold();
    expect(await alarmAt(), "the row watches its own hold").toBe(heldAt + CREATE_CLAIM_STALE + WATCH_MARGIN);
    expect(await stored("watch")).toEqual({ boardId: CRM_DEALS.boardId, itemId: CARD, staleMs: CREATE_CLAIM_STALE });
    expect(deal().dealstage).toBe(A);

    advance(heldAt + CREATE_CLAIM_STALE + WATCH_MARGIN - Date.now());   // nothing else happens until then
    await row().alarm();

    expect(deal().dealstage, "the person's queued edit reaches HubSpot").toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    // What the skipped creation webhook would have brought, and the baseline.
    expect(cell(COARSE)).toBe("Proposal");
    expect(cell(PROBABILITY)).toBe("20");
    expect(cell(PIPELINE)).toBe("Sales Pipeline");
    expect(cell(CREATED)).not.toBe("");
    expect(cell(CRM_DEALS.syncStateCol)).toBe(deal().hs_lastmodifieddate);
    expect(logLine(/board=\S+ item=d-1 hubspot_id=9001 queued=1 action=create-window-takeover/)).toBeDefined();
    expect(logLine(/source=monday id=d-1 action=updated-hubspot .*via=create-window-alarm/)).toBeDefined();
    // Settled: queue acknowledged, stale hold cleared, watch closed, back to the 24 h cleanup.
    expect(await stored("pending")).toBeUndefined();
    expect(await stored("card")).toEqual({ itemId: DEAL, baseline: expect.any(String) });
    expect(await stored("watch")).toBeUndefined();
    expect(await alarmAt()).toBe(Date.now() + RETENTION_MS);

    // Minutes later, the two events that used to revert it: a HubSpot change, then an unrelated edit.
    advance(3 * 60_000);
    Object.assign(deal(), { amount: "123", hs_lastmodifieddate: stamp() });
    await onHubspot();
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(AMOUNT)).toBe("123");
    setCell(AMOUNT, "5000");
    await onMonday(edit(AMOUNT));
    expect(deal().amount).toBe("5000");
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(hub.patches.filter(p => "dealstage" in p.patch), "the queued edit is sent once").toHaveLength(1);

    creator.release(); await first;                   // (a creator that does come back changes nothing)
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(mondayApi.createItem).not.toHaveBeenCalled();
  });

  it("a creator that comes back right after the takeover sends nothing twice and keeps the card on B", async () => {
    const { first, creator, heldAt } = await creatorStopsAfterHold();
    advance(heldAt + CREATE_CLAIM_STALE + WATCH_MARGIN - Date.now());
    await row().alarm();
    creator.release(); await first;                   // it renews (nothing left to replay) and settles
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(hub.patches.filter(p => "dealstage" in p.patch)).toHaveLength(1);
    expect(await stored("watch"), "its release closes the window").toBeUndefined();
    expect(await alarmAt()).toBe(Date.now() + RETENTION_MS);
  });

  it("an alarm that finds the creator alive (it renewed) does nothing but follow the heartbeat", async () => {
    useClock();
    newCard();
    mondayApi.setColumns.mockImplementationOnce(async (_e: unknown, _b: unknown, id: string, cv: Record<string, unknown>) => {
      advance(25_000);                                 // the id write-back waits out a rate limit
      write(id, cv);
    });
    birthHold = makeHold();
    const h = birthHold;
    const first = onMonday(edit(STAGE));
    await h.entered;                                   // renewed after the write-back, now in its birth pass
    const renewedAt = (await stored("card")).settlingAt as number;
    expect(await alarmAt(), "the heartbeat moved the alarm").toBe(renewedAt + CREATE_CLAIM_STALE + WATCH_MARGIN);
    setCell(STAGE, LABEL[B]);                          // a person's change on screen, its event late
    advance(10_000);
    await row().alarm();                               // e.g. an alarm set by the hold, 25 s earlier
    expect(logLine(/action=create-window-takeover/)).toBeUndefined();
    expect(cell(STAGE), "a live creator's card is not handed to a forward pass").toBe(LABEL[B]);
    expect((await stored("card")).settlingAt).toBe(renewedAt);
    expect(await alarmAt()).toBe(renewedAt + CREATE_CLAIM_STALE + WATCH_MARGIN);
    h.release(); await first;
    expect(await stored("watch")).toBeUndefined();
    expect(await alarmAt()).toBe(Date.now() + RETENTION_MS);
    await row().alarm();                               // and the 24 h cleanup, exactly as before
    expect(await stored("card")).toBeUndefined();
  });

  it("a takeover whose sync fails is retried; given up, the queue is still taken by the next sync of the card", async () => {
    const { heldAt } = await creatorStopsAfterHold();
    advance(heldAt + CREATE_CLAIM_STALE + WATCH_MARGIN - Date.now());
    hs.getRecord.mockRejectedValueOnce(new Error("HubSpot 503"));
    await row().alarm();
    expect(logLine(/attempt=1 action=create-window-takeover-retry reason="Error: HubSpot 503"/)).toBeDefined();
    expect(await stored("pending"), "nothing is acknowledged by a takeover that did not run").toHaveLength(1);
    expect(await alarmAt()).toBe(Date.now() + 60_000);
    expect(deal().dealstage).toBe(A);
    advance(60_000);
    hs.getRecord.mockRejectedValueOnce(new Error("HubSpot 503"));
    await row().alarm();
    expect(await alarmAt()).toBe(Date.now() + 5 * 60_000);
    advance(5 * 60_000);
    hs.getRecord.mockRejectedValueOnce(new Error("HubSpot 503"));
    await row().alarm();
    expect(logLine(/attempt=3 action=create-window-takeover-abandoned .*the queue stays stored/)).toBeDefined();
    expect(await stored("watch")).toBeUndefined();
    expect(await alarmAt(), "the row still lives its full retention").toBe(Date.now() + RETENTION_MS);
    expect(await stored("pending")).toHaveLength(1);
    // Minutes later, far past the old 2-minute gate: HubSpot's next change still finds the queue.
    Object.assign(deal(), { amount: "123", hs_lastmodifieddate: stamp() });
    await onHubspot();
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(AMOUNT)).toBe("123");
  });

  it("a release that could not replay (its settle round could not read the card) is taken over seconds later", async () => {
    useClock();
    newCard();
    const first = (await createInFlight()).done;
    setCell(AMOUNT, "5000");
    await onMonday(edit(AMOUNT));                      // queued
    mondayApi.getItem.mockResolvedValueOnce(null);     // the settle round's read of the card
    createHold!.release();
    await first;
    expect(deal().amount).toBeUndefined();
    expect(await stored("pending"), "a release without ack keeps the queue").toHaveLength(1);
    expect(await stored("watch"), "...and keeps watching it").toBeDefined();
    expect(await alarmAt()).toBe(Date.now() + WATCH_MARGIN);
    advance(WATCH_MARGIN);
    await row().alarm();
    expect(deal().amount).toBe("5000");
    expect(cell(AMOUNT)).toBe("5000");
    expect(await stored("pending")).toBeUndefined();
    expect(await stored("watch")).toBeUndefined();
  });

  it("a creator that stopped before its id write-back landed: the alarm re-stamps the card, then settles it", async () => {
    useClock();
    newCard();
    await createInFlight();                            // (this creator never finishes)
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));                       // queued
    mondayApi.setColumns.mockImplementationOnce(() => new Promise<void>(() => {}));   // the write-back never returns
    createHold!.release();
    await vi.waitFor(async () => expect((await stored("card"))?.settlingAt).toBeDefined());
    const heldAt = (await stored("card")).settlingAt as number;
    expect(cell(CRM_DEALS.idCol)).toBe("");
    advance(heldAt + CREATE_CLAIM_STALE + WATCH_MARGIN - Date.now());
    await row().alarm();
    expect(cell(CRM_DEALS.idCol), "the card is linked to its record again").toBe(DEAL);
    expect(logLine(/card d-1 re-stamped with 9001 \(its create stopped before monday served the id\)/)).toBeDefined();
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(PIPELINE)).toBe("Sales Pipeline");
    expect(cell(CRM_DEALS.syncStateCol)).toBe(deal().hs_lastmodifieddate);
    expect(await objects.get(`card:${CRM_DEALS.boardId}:${DEAL}`).getCard(), "and registered, for HubSpot's side").toBe(CARD);
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
  });

  it("CREATE_WINDOW_REPLAY turned off after the hold: the alarm replays nothing and closes the window", async () => {
    const { heldAt } = await creatorStopsAfterHold();
    row().env = { ...row().env, CREATE_WINDOW_REPLAY: "false" };   // flipped in the dashboard meanwhile
    advance(heldAt + CREATE_CLAIM_STALE + WATCH_MARGIN - Date.now());
    await row().alarm();
    expect(logLine(/action=create-window-replay-disabled/)).toBeDefined();
    expect(hub.patches).toEqual([]);
    expect(deal().dealstage).toBe(A);
    expect(await stored("watch")).toBeUndefined();
    expect(await alarmAt()).toBe(Date.now() + RETENTION_MS);
  });

  it.each([
    ["a HubSpot change", async () => { Object.assign(deal(), { amount: "123", hs_lastmodifieddate: stamp() }); await onHubspot(); }],
    ["a person's edit of another column", async () => { setCell(AMOUNT, "5000"); await onMonday(edit(AMOUNT)); }],
  ])("without the alarm (it never ran), %s minutes later still sends the queue instead of reverting the card",
    async (_label, next) => {
      await creatorStopsAfterHold();
      advance(3 * 60_000);                             // past the old 2-minute gate
      await next();
      expect(deal().dealstage, "the queued Stage edit reaches HubSpot").toBe(B);
      expect(cell(STAGE), "and the card keeps it").toBe(LABEL[B]);
      expect(logLine(/action=create-window-leftovers-replayed/)).toBeDefined();
    });

  it("the create-window gate reads a row for as long as the row can hold a queue, and never an older record", () => {
    expect(CREATE_WINDOW_MS).toBeGreaterThan(RETENTION_MS);
    expect(CREATE_WINDOW_MS).toBeLessThanOrEqual(RETENTION_MS + 60 * 60_000);
  });
});

// ------------------------------------------------------------------------------------------ settled in the creator's place
/**
 * WHOEVER SETTLES A STOPPED CREATOR'S CARD SETTLES IT AS THE CREATOR WOULD HAVE: the row's alarm, a sync
 * that finds the hold stale, a 'have' read that takes the queue. Each runs the creator's own round
 * (settleRound) on what the hold recorded (CreateSnapshot), not the ordinary engine -- which, judged by a
 * Sync State HubSpot's post-create recalculation has already passed, copies the create-time values over
 * every edit on the card.
 */
describe("a stopped creator's card is settled by the rules of its own round", () => {
  /**
   * The live bug in its SAME-ISOLATE form: the second Stage change folds into a re-run of the creator's own
   * webhook key (coalesceLatest), so nothing queues, and that re-run dies with the creator.
   */
  async function foldedAndCutOff(actor = PERSON): Promise<{ heldAt: number }> {
    useClock();
    newCard();
    // Cut off in its birth pass -- or, for an automation's create (which has no birth pass), in its settle
    // round, whose first HubSpot read never returns.
    const cut = makeHold();
    if (actor.byAutomation) {
      const real = hs.getRecord.getMockImplementation()!;
      hs.getRecord.mockImplementationOnce(async () => { cut.enter(); return new Promise(() => {}); });
      hs.getRecord.mockImplementation(real);
    } else birthHold = cut;
    void onMonday(edit(STAGE), actor);                 // the first change creates the deal from A
    await cut.entered;
    setCell(STAGE, LABEL[B]);                          // the second change: a re-run of the creator's key, lost with it
    const heldAt = (await stored("card")).settlingAt as number;
    advance(2_000);
    expect(await onHubspot()).toMatch(/action=skipped/);   // HubSpot's creation webhook, left to the creator
    expect(cell(STAGE)).toBe(LABEL[B]);
    return { heldAt };
  }
  const toLapse = (heldAt: number) => advance(heldAt + CREATE_CLAIM_STALE + WATCH_MARGIN - Date.now());
  const stageSends = () => hub.patches.filter(p => "dealstage" in p.patch).map(p => p.patch.dealstage);
  const PRIORITY = "color_mm76tdww";
  const CLOSE = "deal_expected_close_date";

  it("the second change, folded into the creator's own run, is sent by the alarm and not overwritten", async () => {
    const { heldAt } = await foldedAndCutOff();
    toLapse(heldAt);
    await row().alarm();
    expect(deal().dealstage, "what the lost re-run would have sent").toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(COARSE)).toBe("Proposal");
    expect(cell(PIPELINE)).toBe("Sales Pipeline");
    expect(cell(PROBABILITY)).toBe("20");
    expect(cell(CRM_DEALS.syncStateCol)).toBe(deal().hs_lastmodifieddate);
    expect(stageSends()).toEqual([B]);
    expect(await stored("snapshot"), "settled: what the hold recorded is gone").toBeUndefined();
    expect((await stored("card")).baseline, "and the Sync State the round left is the row's baseline now")
      .toBe(cell(CRM_DEALS.syncStateCol));
  });

  it("the same when no alarm runs: a HubSpot change minutes later sends it rather than reverting the card", async () => {
    await foldedAndCutOff();
    advance(3 * 60_000);
    Object.assign(deal(), { amount: "123", hs_lastmodifieddate: stamp() });
    await onHubspot();
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(AMOUNT)).toBe("123");
  });

  it("an AUTOMATION's create: a changed cell of its own column is left on the card, never sent", async () => {
    const { heldAt } = await foldedAndCutOff(AUTOMATION);
    toLapse(heldAt);
    await row().alarm();
    expect(stageSends()).toEqual([]);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(cell(PIPELINE), "HubSpot's own values still come across").toBe("Sales Pipeline");
  });

  it("HubSpot's own changes reach the card although a person's push during the hold moved Sync State past them", async () => {
    useClock();
    newCard();
    birthHold = makeHold();
    void onMonday(edit(STAGE));
    await birthHold.entered;                           // the creator is cut off
    advance(1_000);
    Object.assign(deal(), { amount: "100", hs_lastmodifieddate: stamp() });   // a HubSpot workflow on creation
    expect(await onHubspot()).toMatch(/action=skipped/);
    advance(2_000);
    setCell(STAGE, LABEL[C]);
    await onMonday(edit(STAGE));                       // a person's edit, sent at once (live hold)
    const heldAt = (await stored("card")).settlingAt as number;
    toLapse(heldAt);
    await row().alarm();
    expect(deal().dealstage).toBe(C);
    expect(cell(AMOUNT), "the workflow's value").toBe("100");
    expect(cell(PIPELINE)).toBe("Sales Pipeline");
    expect(cell(PROBABILITY)).toBe("20");
    expect(cell(CREATED)).not.toBe("");
  });

  // ---- whose edit it is: the LATEST entry of a column decides, on every path
  async function personThenAutomation(): Promise<{ heldAt: number }> {
    useClock();
    newCard();
    const first = (await createInFlight()).done;
    void first;
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));                       // a person's: queued
    setCell(STAGE, LABEL[C]);
    await onMonday(edit(STAGE), AUTOMATION);           // an automation's, later: queued
    birthHold = makeHold();
    const creator = birthHold;
    createHold!.release();
    await creator.entered;                             // the creator stops in its birth pass
    return { heldAt: (await stored("card")).settlingAt as number };
  }

  it("an automation's later edit of a person's queued column is not sent by the alarm", async () => {
    const { heldAt } = await personThenAutomation();
    toLapse(heldAt);
    await row().alarm();
    expect(stageSends()).toEqual([]);
    expect(deal().dealstage).toBe(A);
    expect(cell(STAGE), "the automation's edit is shown as HubSpot has it").toBe(LABEL[A]);
    expect(logLine(/cols=dropdown_mm7624zd actor=-4 class=automation action=create-window-edit-dropped/)).toBeDefined();
  });

  it("...nor by a sync that finds the creator gone", async () => {
    await personThenAutomation();
    advance(40_000);
    await onHubspot();
    expect(stageSends()).toEqual([]);
    expect(deal().dealstage).toBe(A);
  });

  it("...nor by a 'have' read that takes the queue", async () => {
    await personThenAutomation();
    advance(40_000);
    md.unserved.add(CARD);
    await onMonday(undefined);                         // any later event, on a read without the id
    expect(stageSends()).toEqual([]);
    expect(deal().dealstage).toBe(A);
  });

  // ---- a late replay does not undo a newer HubSpot change
  it("a replay after two failed takeovers keeps a HubSpot user's newer change of the same property", async () => {
    const { heldAt } = await (async () => {
      useClock();
      newCard();
      void (await createInFlight()).done;
      setCell(STAGE, LABEL[B]);
      await onMonday(edit(STAGE));                     // queued
      birthHold = makeHold();
      const creator = birthHold;
      createHold!.release();
      await creator.entered;
      return { heldAt: (await stored("card")).settlingAt as number };
    })();
    toLapse(heldAt);
    hs.getRecord.mockRejectedValueOnce(new Error("HubSpot 503"));
    await row().alarm();
    advance(60_000);
    hs.getRecord.mockRejectedValueOnce(new Error("HubSpot 503"));
    await row().alarm();
    advance(90_000);                                   // ~3 minutes after the create
    Object.assign(deal(), { dealstage: C, hs_lastmodifieddate: stamp() });   // a HubSpot user's change
    await onHubspot();
    expect(deal().dealstage, "the newer HubSpot value stands").toBe(C);
    expect(cell(STAGE), "and the card shows it").toBe(LABEL[C]);
    expect(stageSends()).toEqual([]);
    expect(logLine(/cols=dropdown_mm7624zd .*action=create-window-edit-refused/)).toBeDefined();
  });

  it("an hour-old queue keeps HubSpot's newer change too, and still sends what HubSpot has not changed", async () => {
    useClock();
    newCard();
    const first = (await createInFlight()).done;
    setCell(STAGE, LABEL[B]);
    await onMonday(edit(STAGE));
    setCell(AMOUNT, "5000");
    await onMonday(edit(AMOUNT));
    mondayApi.setColumns.mockImplementationOnce(async () => { throw new Error("monday 500"); });   // the write-back
    createHold!.release();
    expect(await first).toMatch(/action=error/);      // no id on the card, the queue kept, nothing watching it
    advance(60 * 60_000);
    Object.assign(deal(), { dealstage: C, hs_lastmodifieddate: stamp() });   // a HubSpot user, an hour on
    setCell(CLOSE, "2026-12-01");
    await onMonday(edit(CLOSE));                       // then a person's edit of another column
    expect(deal().closedate).toBe("2026-12-01");
    expect(deal().dealstage).toBe(C);
    expect(cell(STAGE)).toBe(LABEL[C]);
    expect(deal().amount, "HubSpot never held an amount, so the person's still goes").toBe("5000");
  });

  it("a queue behind a card-owner re-stamp is applied at once, not stranded for a late sync", async () => {
    useClock();
    const REC = "556";
    const born = new Date(Date.now() - 10_000).toISOString();
    hub.records.set(REC, { dealname: "From HubSpot", dealstage: A, pipeline: "default", sync_owner: "crm",
      createdate: born, hs_lastmodifieddate: born });
    md.cards.set(CARD, { name: "From HubSpot", created_at: new Date(Date.now() - 5_000).toISOString(), cols: {
      [CRM_DEALS.idCol]: REC, [CRM_DEALS.syncStateCol]: born, [STAGE]: LABEL[A], [PIPELINE]: "Sales Pipeline" } });
    md.unserved.add(CARD);                             // monday's read still lacks the id createItem wrote
    const owner = namespace.get(`hsof:${CRM_DEALS.boardId}:${CARD}`);
    await owner.rememberOwner(REC, Date.now(), 90 * 86_400_000);
    await namespace.get(`card:${CRM_DEALS.boardId}:${REC}`).finishCard(CARD, Date.now());
    const gate = makeHold();
    const realGet = owner.getCard.bind(owner);
    let n = 0;
    owner.getCard = async () => { if (n++ === 0) { gate.enter(); await gate.gate; } return realGet(); };
    const ev1 = onMonday(edit(PRIORITY), AUTOMATION);  // an item-created automation's event holds the claim
    await gate.entered;
    setCell(AMOUNT, "900");
    expect(await onMonday(edit(AMOUNT))).toMatch(/action=skipped/);   // a person's: queued behind it
    gate.release();
    await ev1;
    expect(hub.records.get(REC)!.amount, "sent by the re-stamp's own replay").toBe("900");
    expect(await stored("pending")).toBeUndefined();
    md.unserved.clear();
    advance(60 * 60_000);
    Object.assign(hub.records.get(REC)!, { amount: "5000", hs_lastmodifieddate: new Date().toISOString() });
    await syncHubspotObject(runEnv, "deal", REC, live, budget());
    expect(hub.records.get(REC)!.amount, "an hour later HubSpot's Amount stands").toBe("5000");
    expect(cell(AMOUNT)).toBe("5000");
  });

  // ---- a cell our own token (or a dropped automation event) wrote last is not a person's edit
  it("our own token's later write of a person's queued column is not sent as the person's edit", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(AMOUNT, "5000");
    await onMonday(edit(AMOUNT));                      // a person's: queued
    setCell(AMOUNT, "777");
    expect(await onMonday(edit(AMOUNT), ASK_ADA, true)).toMatch(/refusing to create/);   // ours: noted
    createHold!.release();
    await first;
    expect(deal().amount).toBeUndefined();
    expect(hub.patches).toEqual([]);
    expect(cell(AMOUNT), "left as it is, like any echo of ours").toBe("777");
    expect(logLine(/cols=deal_value actor=104118038 class=integration action=create-window-edit-dropped/)).toBeDefined();
  });

  it("...nor when our echo reaches the linked card while the creator settles", async () => {
    newCard();
    const first = (await createInFlight()).done;
    setCell(AMOUNT, "5000");
    await onMonday(edit(AMOUNT));                      // queued
    birthHold = makeHold();
    const h = birthHold;
    createHold!.release();
    await h.entered;
    setCell(AMOUNT, "777");
    expect(await onMonday(edit(AMOUNT), ASK_ADA, true)).toMatch(/action=skipped/);   // linked, left to the creator
    h.release();
    await first;
    expect(deal().amount).toBeUndefined();
    expect(hub.patches).toEqual([]);
  });

  // ---- a read that predates the creator's settle is judged by the baseline the settle wrote
  it("an edit racing the creator's release on a read without the id does not revert a held edit", async () => {
    newCard();
    birthHold = makeHold();
    const h = birthHold;
    const first = onMonday(edit(STAGE));
    await h.entered;
    setCell(STAGE, LABEL[B]);                          // a person's Stage change, its event late
    setCell(AMOUNT, "4200");
    md.unserved.add(CARD);
    mondayApi.setColumns.mockImplementationOnce(async (_e: unknown, _b: unknown, id: string, cv: Record<string, unknown>) => {
      write(id, cv);                                   // the 'have' re-stamp...
      h.release(); await first;                        // ...during which the creator settles and releases
    });
    await onMonday(edit(AMOUNT));
    expect(cell(STAGE), "the held edit is not copied over").toBe(LABEL[B]);
    md.unserved.clear();
    await onMonday(edit(STAGE));
    expect(deal().amount).toBe("4200");
    expect(deal().dealstage).toBe(B);
  });

  it("...nor on the linked path, whose card read predates the settle's stamp", async () => {
    newCard();
    birthHold = makeHold();
    const h = birthHold;
    const first = onMonday(edit(STAGE));
    await h.entered;
    setCell(STAGE, LABEL[B]);
    setCell(AMOUNT, "4200");
    const real = hs.getRecord.getMockImplementation()!;
    let n = 0;
    hs.getRecord.mockImplementation(async (...a: any[]) => {
      if (n++ === 0) { h.release(); await first; }     // the Amount event's read is done; the creator settles now
      return (real as any)(...a);
    });
    await onMonday(edit(AMOUNT));
    expect(cell(STAGE)).toBe(LABEL[B]);
    await onMonday(edit(STAGE));
    expect(deal().dealstage).toBe(B);
    expect(deal().amount).toBe("4200");
  });

  // ---- the card-owner re-stamp does not bury what HubSpot changed after the card was made
  it("a card-owner re-stamp's replay brings across a HubSpot change the card never showed", async () => {
    const born = new Date(Date.now() - 20_000).toISOString();
    const later = new Date(Date.now() - 5_000).toISOString();
    hub.records.set("556", { dealname: "From HubSpot", dealstage: C, pipeline: "default", sync_owner: "crm",
      createdate: born, hs_lastmodifieddate: later });
    md.cards.set(CARD, { name: "From HubSpot", created_at: new Date(Date.now() - 15_000).toISOString(), cols: {
      [CRM_DEALS.idCol]: "556", [CRM_DEALS.syncStateCol]: born, [STAGE]: LABEL[A], [PIPELINE]: "Sales Pipeline" } });
    md.unserved.add(CARD);
    await namespace.get(`hsof:${CRM_DEALS.boardId}:${CARD}`).rememberOwner("556", Date.now(), 90 * 86_400_000);
    setCell(AMOUNT, "900");
    await onMonday(edit(AMOUNT));
    expect(hub.records.get("556")!.amount).toBe("900");
    expect(cell(STAGE), "HubSpot moved on after the card was made").toBe(LABEL[C]);
    md.unserved.clear();
    await syncHubspotObject(runEnv, "deal", "556", live, budget());
    expect(cell(STAGE)).toBe(LABEL[C]);
    expect(hub.records.get("556")!.dealstage).toBe(C);
  });
});

describe("the 'have' race keeps the card's baseline", () => {
  it("an edit replayed on a lagging read does not revert the person's other edit on the way", async () => {
    newCard();
    await onMonday(edit(STAGE));                       // created and settled on A
    md.unserved.add(CARD);                             // monday's read lacks the id AND Sync State
    setCell(STAGE, LABEL[B]);                          // the person moves Stage on...
    setCell(AMOUNT, "4200");                           // ...then sets Amount; Amount's event lands first
    await onMonday(edit(AMOUNT));
    expect(cell(STAGE), "HubSpot has not changed since the create settled").toBe(LABEL[B]);
    expect(deal().amount).toBe("4200");
    await onMonday(edit(STAGE));                       // Stage's own event
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
  });
});

describe("the creator's own column is not re-sent as a person's edit", () => {
  it("an 'ask ada' edit of the column that started the create is not pushed", async () => {
    newCard();
    const first = (await createInFlight()).done;       // a person's Stage=A starts it
    setCell(STAGE, LABEL[C]);
    const out = await onMonday(edit(STAGE), ASK_ADA, true);
    expect(out).toMatch(/refusing to create/);
    createHold!.release();
    await first;
    expect(hub.patches.filter(p => "dealstage" in p.patch)).toEqual([]);
    expect(deal().dealstage).toBe(A);
  });
});

// ------------------------------------------------------------------------------------------ adoption
describe("an edit made while a Contacts card is being ADOPTED", () => {
  const ITEM = "c-1";
  const JOB = "text_mm6szy4q";
  let searchHold: Hold | null;
  const onContact = (e: MondayEdit | undefined, actor = PERSON) =>
    syncMondayItem(runEnv, CRM_CONTACTS.boardId, ITEM, live, budget(), false, false, e, actor);
  const jobCell = () => md.cards.get(ITEM)!.cols[JOB] ?? "";
  beforeEach(() => {
    searchHold = null;
    hub.records.set("7001", { email: "ann@x.com", firstname: "Ann", lastname: "Lee", jobtitle: "Old",
      sync_owner: "crm", createdate: "2025-01-01T00:00:00Z", lastmodifieddate: "2026-09-20T00:00:00Z" });
    hs.searchContactByEmail.mockImplementation(async () => {
      searchHold = await pass(searchHold);
      return { id: "7001", modified: "2026-09-20T00:00:00Z" };
    });
  });
  function contactCard(job = "") {
    md.cards.set(ITEM, { name: "Ann Lee", created_at: new Date(Date.now() - 5_000).toISOString(),
      cols: { [CRM_CONTACTS.idCol]: "", contact_email: "ann@x.com", text_mm6sab4c: "Ann", text_mm6snp6r: "Lee",
        [JOB]: job } });
  }

  it("a person's edit queued during the adoption is sent to the adopted record, from a fresh read", async () => {
    contactCard();
    searchHold = makeHold();
    const s = searchHold;
    const first = onContact(edit("contact_email"));
    await s.entered;                                   // searching HubSpot for the email
    md.cards.get(ITEM)!.cols[JOB] = "New title";
    const queued = await onContact(edit(JOB));
    expect(queued).toMatch(/action=skipped/);
    s.release();
    await first;
    expect(hub.records.get("7001")!.jobtitle).toBe("New title");
    expect(jobCell()).toBe("New title");
    expect(hs.createRecord).not.toHaveBeenCalled();
  });

  it("a value the card already held when the adoption read it is not pushed onto the existing record", async () => {
    contactCard("Typed on the form");
    searchHold = makeHold();
    const s = searchHold;
    const first = onContact(undefined);                // item created
    await s.entered;
    await onContact(edit(JOB));                        // the form's column event, trailing
    s.release();
    await first;
    expect(hub.records.get("7001")!.jobtitle).toBe("Old");
    expect(hub.patches).toEqual([]);
  });

  it("CREATE_WINDOW_REPLAY off: the old adoption -- a plain finish, and the edit made during it is not sent", async () => {
    runEnv = { ...env, CREATE_WINDOW_REPLAY: "false" } as unknown as Env;
    contactCard();
    searchHold = makeHold();
    const s = searchHold;
    const first = onContact(edit("contact_email"));
    await s.entered;
    md.cards.get(ITEM)!.cols[JOB] = "New title";
    expect(await onContact(edit(JOB))).toMatch(/action=skipped/);
    expect(logLine(/action=deferred-to-create/), "nothing queues").toBeUndefined();
    s.release();
    await first;
    expect(hub.records.get("7001")!.jobtitle, "the old outcome: the edit is lost").toBe("Old");
    expect(hub.patches).toEqual([]);
    expect(hs.createRecord).not.toHaveBeenCalled();
    // Settled by the plain finish: no "link" baseline was recorded.
    expect(await objects.get(`mdcreate:${CRM_CONTACTS.boardId}:${ITEM}`).claimCard(Date.now()))
      .toEqual({ status: "have", itemId: "7001" });
  });
});

// ------------------------------------------------------------------------------------------ the kill switch
describe("the CREATE_WINDOW_REPLAY kill switch", () => {
  const withSwitch = (v: string | undefined, links = "true") =>
    ({ ...env, CREATE_WINDOW_REPLAY: v, BORN_ATTACHED_LINKS: links }) as unknown as Env;

  /** THE LIVE SEQUENCE of 2026-09-30 17:40Z, end to end, under one value of the switch: the first Stage
   *  change creates the deal, the second lands while HubSpot is making it, then HubSpot's creation webhook. */
  async function liveSequence(e: Env): Promise<string> {
    runEnv = e;
    newCard();
    const first = (await createInFlight()).done;       // the first change creates the deal, from A
    setCell(STAGE, LABEL[B]);                          // ...and the person moves it on to B
    const second = await onMonday(edit(STAGE));        // another isolate: the create is still in flight
    createHold!.release();
    await first;
    await onHubspot();                                 // HubSpot's creation webhook, after the create
    return second;
  }

  it("ON: the fixed outcome -- HubSpot and the card end on the SECOND value", async () => {
    expect(await liveSequence(withSwitch("true"))).toMatch(/action=skipped/);
    expect(logLine(/class=person action=deferred-to-create/)).toBeDefined();
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
  });

  it.each([["\"false\"", "false"], ["absent", undefined], ["\"TRUE\"", "TRUE"], ["\"1\"", "1"], ["empty", ""]])(
    "OFF (%s): the OLD outcome -- the second edit is lost, and card and HubSpot end on the FIRST value",
    async (_label, value) => {
      expect(await liveSequence(withSwitch(value))).toMatch(/action=skipped/);
      expect(logLine(/create already in flight — skipping/)).toBeDefined();
      expect(logLine(/action=deferred-to-create/), "the claim queues nothing").toBeUndefined();
      expect(deal().dealstage, "the second value was never sent").toBe(A);
      expect(hub.patches).toEqual([]);
      expect(cell(STAGE), "the creation webhook's forward pass copied the create-time value back").toBe(LABEL[A]);
      expect(logLine(/create-window-settled|left-to-settling-create|replay-as-edit/)).toBeUndefined();
      // Still exactly one record and one card: the duplicate guards do not depend on the switch.
      expect(hs.createRecord).toHaveBeenCalledTimes(1);
      expect(mondayApi.createItem).not.toHaveBeenCalled();
      // The create settled with the plain finish: an id and nothing else (no hold, no baseline, no queue).
      const row = objects.get(`mdcreate:${CRM_DEALS.boardId}:${CARD}`);
      expect(await row.ctx.storage.get("pending")).toBeUndefined();
      expect(await row.ctx.storage.get("card")).toEqual({ itemId: DEAL });
    });

  it("OFF: no entry point of the machinery is reached -- no queueing claim, no settle mode, no window read", async () => {
    const proto = (CreateIdempotency as any).prototype;
    const claim = vi.spyOn(proto, "claimCard");
    const settle = vi.spyOn(proto, "settleCreate");
    const window = vi.spyOn(proto, "createWindow");
    await liveSequence(withSwitch("false"));
    md.unserved.add(CARD);                             // and the 'have' race on top
    setCell(AMOUNT, "4200");
    await onMonday(edit(AMOUNT));
    md.unserved.clear();
    await onHubspot();                                 // a young linked card's sync
    expect(claim).toHaveBeenCalled();
    expect(claim.mock.calls.filter(c => c[3] !== undefined), "a claim never carries an edit").toEqual([]);
    expect(settle, "no hold, renew, release or link").not.toHaveBeenCalled();
    expect(window, "reconcileRecord never asks about a create window").not.toHaveBeenCalled();
  });

  it("OFF: HubSpot's webhook in the middle of the create syncs the card forward, as before (not left to it)", async () => {
    runEnv = withSwitch("false");
    newCard();
    birthHold = makeHold();
    const h = birthHold;
    const first = onMonday(edit(STAGE));
    await h.entered;                                   // the record exists and the card is findable
    expect(await onHubspot()).toMatch(/action=updated-monday/);
    expect(logLine(/left-to-settling-create/)).toBeUndefined();
    h.release(); await first;
    expect(logLine(/create-window-settled/)).toBeUndefined();
  });

  it("OFF: the 'have' race re-stamps only, as before -- the edit is not applied", async () => {
    runEnv = withSwitch("false");
    newCard();
    await onMonday(edit(STAGE));                       // created
    md.unserved.add(CARD);                             // monday's read still lacks the id it was given
    setCell(AMOUNT, "4200");
    const out = await onMonday(edit(AMOUNT));
    expect(logLine(/card d-1 re-stamped with 9001/)).toBeDefined();
    expect(logLine(/action=replay-as-edit/)).toBeUndefined();
    expect(out).toMatch(/action=adopted-hubspot/);
    expect(deal().amount, "the old outcome: re-stamped, the edit dropped").toBeUndefined();
    expect(hs.createRecord).toHaveBeenCalledTimes(1);
    expect(cell(CRM_DEALS.idCol)).toBe(DEAL);
  });

  it("is independent of BORN_ATTACHED_LINKS: ON with the birth links off still ends on the second value", async () => {
    await liveSequence(withSwitch("true", "false"));
    expect(assoc.pushBirthAssociations).not.toHaveBeenCalled();
    expect(deal().dealstage).toBe(B);
    expect(cell(STAGE)).toBe(LABEL[B]);
  });

  it("only the literal \"true\" arms it, and only on a column-level spec", () => {
    expect(createWindowReplayOn({ CREATE_WINDOW_REPLAY: "true" }, CRM_DEALS)).toBe(true);
    expect(createWindowReplayOn({ CREATE_WINDOW_REPLAY: "true" }, CRM_CONTACTS)).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "True", " true", "1", "yes"])
      expect(createWindowReplayOn({ CREATE_WINDOW_REPLAY: v }, CRM_DEALS)).toBe(false);
    expect(createWindowReplayOn({ CREATE_WINDOW_REPLAY: "true" }, DEALS), "Work Management: never").toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ the Durable Object
describe("CreateIdempotency: the queue behind a monday-row create", () => {
  const T = Date.parse("2026-10-01T09:00:00Z");
  const e = (cols: string[], actorClass: "person" | "automation" = "person") => ({ cols, actorClass, at: T });
  const fresh = () => new (CreateIdempotency as any)(doCtx(), {});
  const BASE = "2026-10-01T09:00:01.000Z";

  it("an edit that finds the record still being made is queued, in the same critical section as the answer", async () => {
    const d = fresh();
    expect(await d.claimCard(T)).toEqual({ status: "proceed", tookOverStale: false });
    expect(await d.claimCard(T + 1, 30_000, false, e([STAGE]))).toEqual({ status: "creating", deferred: true });
    expect(await d.claimCard(T + 2)).toEqual({ status: "creating" });            // nothing to queue
    await d.settleCreate(DEAL, T + 3, "hold", { baseline: BASE });
    expect(await d.settleCreate(DEAL, T + 4, "renew")).toEqual([e([STAGE])]);
    expect(await d.settleCreate(DEAL, T + 5, "renew"), "read, not removed").toEqual([e([STAGE])]);
  });

  it("once the record exists nothing queues: a claim reads 'have' (settling), and the window check says so", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([STAGE]));
    await d.settleCreate(DEAL, T + 2, "hold", { baseline: BASE });
    expect(await d.claimCard(T + 3, 30_000, false, e([AMOUNT])))
      .toEqual({ status: "have", itemId: DEAL, settling: true, baseline: BASE });
    expect(await d.createWindow(T + 4, 30_000)).toEqual({ settling: true });
    expect(await d.settleCreate(DEAL, T + 5, "renew"), "the claim above queued nothing").toEqual([e([STAGE])]);
    await d.settleCreate(DEAL, T + 6, "release", { ack: 1, baseline: "2026-10-01T09:00:05.000Z" });
    expect(await d.claimCard(T + 7)).toEqual({ status: "have", itemId: DEAL, baseline: "2026-10-01T09:00:05.000Z" });
    // Settled: nothing to take, and the Sync State the settle wrote, for a read that predates it.
    expect(await d.createWindow(T + 8, 30_000)).toEqual({ settling: false, baseline: "2026-10-01T09:00:05.000Z" });
  });

  it("a release without ack (the replay did not run) keeps the queue, and the hold's baseline, for the next reader", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([AMOUNT]));
    await d.settleCreate(DEAL, T + 2, "hold", { baseline: BASE });
    await d.settleCreate(DEAL, T + 3, "release");
    expect(await d.createWindow(T + 4, 30_000)).toEqual({ settling: false, baseline: BASE, leftovers: [e([AMOUNT])] });
    expect(await d.claimCard(T + 5)).toEqual({ status: "have", itemId: DEAL, baseline: BASE });   // taken once
  });

  it("release acknowledges only what the replay was given: a failed renew (nothing read) removes nothing", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([AMOUNT]));
    await d.settleCreate(DEAL, T + 2, "hold");
    await d.settleCreate(DEAL, T + 3, "release", { ack: 0 });
    expect(await d.claimCard(T + 4)).toEqual({ status: "have", itemId: DEAL, pending: [e([AMOUNT])] });
  });

  it("a hold that goes stale hands its queue to whoever reads next, once, and clears the hold", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([AMOUNT]));
    await d.settleCreate(DEAL, T + 2, "hold", { baseline: BASE });
    expect(await d.createWindow(T + 20_000, 30_000)).toEqual({ settling: true });  // alive: not handed out
    expect(await d.createWindow(T + 60_000, 30_000)).toEqual({ settling: false, baseline: BASE, leftovers: [e([AMOUNT])] });
    expect(await d.claimCard(T + 60_001)).toEqual({ status: "have", itemId: DEAL, baseline: BASE });
    // ...and via a claim, for a read that lags the id:
    const c = fresh();
    await c.claimCard(T);
    await c.claimCard(T + 1, 30_000, false, e([STAGE]));
    await c.settleCreate(DEAL, T + 2, "hold");
    expect(await c.claimCard(T + 60_000)).toEqual({ status: "have", itemId: DEAL, pending: [e([STAGE])] });
    expect(await c.claimCard(T + 60_001)).toEqual({ status: "have", itemId: DEAL });
  });

  it("a creator that comes back after a takeover takes the hold up again, with nothing left to replay", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([AMOUNT]));
    await d.settleCreate(DEAL, T + 2, "hold");
    await d.createWindow(T + 60_000, 30_000);                                   // taken over
    expect(await d.settleCreate(DEAL, T + 61_000, "renew")).toEqual([]);
    expect(await d.createWindow(T + 61_001, 30_000)).toEqual({ settling: true });
  });

  it("'link' (an adoption) settles at once and hands the queue back", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e(["text_mm6szy4q"]));
    expect(await d.settleCreate("7001", T + 2, "link", { baseline: BASE })).toEqual([e(["text_mm6szy4q"])]);
    expect(await d.claimCard(T + 3)).toEqual({ status: "have", itemId: "7001", baseline: BASE });
  });

  it("an unknown row is never 'settling', and has nothing left", async () => {
    expect(await fresh().createWindow(T, 30_000)).toEqual({ settling: false });
  });

  const W = { boardId: "b-1", itemId: "i-1", staleMs: 30_000 };
  it("a watched hold arms the alarm for its lapse, each heartbeat moves it, a full release is the 24 h cleanup again", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([STAGE]));
    await d.settleCreate(DEAL, T + 2, "hold", { baseline: BASE, watch: W });
    expect(await d.ctx.storage.getAlarm()).toBe(T + 2 + 30_000 + 5_000);
    expect(await d.ctx.storage.get("watch")).toEqual(W);
    await d.settleCreate(DEAL, T + 9, "renew", { watch: W });
    expect(await d.ctx.storage.getAlarm()).toBe(T + 9 + 30_000 + 5_000);
    await d.settleCreate(DEAL, T + 12, "release", { ack: 1 });
    expect(await d.ctx.storage.get("watch")).toBeUndefined();
    expect(await d.ctx.storage.getAlarm()).toBe(T + 12 + RETENTION_MS);
  });

  it("without a watch every call arms the 24 h cleanup exactly as before; a plain finish closes a watch", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.settleCreate(DEAL, T + 2, "hold", { baseline: BASE });
    expect(await d.ctx.storage.getAlarm()).toBe(T + 2 + RETENTION_MS);
    expect(await d.ctx.storage.get("watch")).toBeUndefined();
    const u = fresh();
    await u.claimCard(T);
    await u.settleCreate(DEAL, T + 2, "hold", { watch: W });
    await u.finishCard(DEAL, T + 3);                  // the create path's un-hold after a failed write-back
    expect(await u.ctx.storage.get("watch")).toBeUndefined();
    expect(await u.ctx.storage.getAlarm()).toBe(T + 3 + RETENTION_MS);
  });

  it("a release that leaves part of the queue keeps watching it, for a takeover in seconds; a link watches nothing", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([AMOUNT]));
    await d.settleCreate(DEAL, T + 2, "hold", { watch: W });
    await d.settleCreate(DEAL, T + 3, "release");      // the settle round could not run
    expect(await d.ctx.storage.get("watch")).toEqual(W);
    expect(await d.ctx.storage.getAlarm()).toBe(T + 3 + 5_000);
    const l = fresh();
    await l.claimCard(T);
    await l.settleCreate("7001", T + 2, "link", { baseline: BASE });
    expect(await l.ctx.storage.get("watch")).toBeUndefined();
    expect(await l.ctx.storage.getAlarm()).toBe(T + 2 + RETENTION_MS);
  });

  const SNAP = { built: { [STAGE]: LABEL[A] }, sent: { dealstage: A }, at: T };
  it("a hold's snapshot is kept until the window is settled: a full release, a link, or a reader taking it", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.claimCard(T + 1, 30_000, false, e([AMOUNT]));
    await d.settleCreate(DEAL, T + 2, "hold", { baseline: BASE, snapshot: SNAP });
    expect(await d.ctx.storage.get("snapshot")).toEqual(SNAP);
    await d.settleCreate(DEAL, T + 3, "release");      // the round did not run: kept
    expect(await d.ctx.storage.get("snapshot")).toEqual(SNAP);
    expect(await d.createWindow(T + 4, 30_000), "a reader takes it with the queue")
      .toEqual({ settling: false, baseline: BASE, leftovers: [e([AMOUNT])], snapshot: SNAP });
    expect(await d.ctx.storage.get("snapshot")).toBeUndefined();
    // A round that ran and took the whole queue (ack, 0 included) settles it.
    const r = fresh();
    await r.claimCard(T);
    await r.settleCreate(DEAL, T + 2, "hold", { snapshot: SNAP });
    await r.settleCreate(DEAL, T + 3, "release", { ack: 0 });
    expect(await r.ctx.storage.get("snapshot")).toBeUndefined();
    // A stale hold with nothing queued still hands the snapshot over: that window was never settled.
    const s = fresh();
    await s.claimCard(T);
    await s.settleCreate(DEAL, T + 2, "hold", { snapshot: SNAP });
    expect(await s.claimCard(T + 60_000)).toEqual({ status: "have", itemId: DEAL, snapshot: SNAP });
    expect(await s.claimCard(T + 60_001)).toEqual({ status: "have", itemId: DEAL });
  });

  it("a note is kept only while the window is open, is handed out beside the queue, and is never counted by ack", async () => {
    const d = fresh();
    const ours = { cols: [AMOUNT], actorClass: "integration" as const, at: T + 1 };
    expect(await d.noteEdit(T, 30_000, ours), "no create at all: nothing to protect").toBe(false);
    await d.claimCard(T);
    expect(await d.noteEdit(T + 1, 30_000, ours), "the record is being made").toBe(true);
    await d.claimCard(T + 2, 30_000, false, e([AMOUNT]));
    await d.settleCreate(DEAL, T + 3, "hold", { snapshot: SNAP });
    expect(await d.settleCreate(DEAL, T + 4, "renew")).toEqual([e([AMOUNT]), { ...ours, note: true }]);
    await d.settleCreate(DEAL, T + 5, "release", { ack: 1 });
    expect(await d.ctx.storage.get("pending")).toBeUndefined();
    expect(await d.ctx.storage.get("notes")).toBeUndefined();
    expect(await d.noteEdit(T + 6, 30_000, ours), "settled: closed").toBe(false);
    expect(await d.ctx.storage.get("notes")).toBeUndefined();
    // Behind a queue with no snapshot (a create made with the switch off), a note still counts.
    const q = fresh();
    await q.claimCard(T);
    await q.claimCard(T + 1, 30_000, false, e([AMOUNT]));
    await q.finishCard(DEAL, T + 2);
    expect(await q.createWindow(T + 3, 30_000, ours)).toEqual({ settling: false,
      leftovers: [e([AMOUNT]), { ...ours, note: true }] });
    // Notes alone -- nothing queued, nothing unsettled -- are dropped, not handed out.
    const n = fresh();
    await n.claimCard(T);
    await n.noteEdit(T + 1, 30_000, ours);
    await n.finishCard(DEAL, T + 2);
    expect(await n.claimCard(T + 3)).toEqual({ status: "have", itemId: DEAL });
  });

  it("the alarm of a row that watches nothing is the 24 h cleanup, exactly as before", async () => {
    const d = fresh();
    await d.claimCard(T);
    await d.finishCard("item-1", T + 1);
    await d.alarm();
    expect(await d.claimCard(T + 2)).toEqual({ status: "proceed", tookOverStale: false });
  });

  it("the card registry and activity reservations answer exactly as before", async () => {
    const d = fresh();
    expect(await d.claimCard(T)).toEqual({ status: "proceed", tookOverStale: false });
    expect(await d.claimCard(T + 1)).toEqual({ status: "creating" });
    await d.finishCard("item-1", T + 2);
    expect(await d.claimCard(T + 3)).toEqual({ status: "have", itemId: "item-1" });
    const a = fresh();
    expect(await a.claimCard(T, 15 * 60_000, true)).toEqual({ status: "proceed", tookOverStale: false });
    expect(await a.claimCard(T + 3 * 24 * 3_600_000, 15 * 60_000, true)).toEqual({ status: "proceed", tookOverStale: true });
  });
});
