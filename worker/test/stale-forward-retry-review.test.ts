import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import { PIPELINES } from "./fixtures/deal-pipelines";
import type { FieldSpec, ObjectSpec } from "../src/types";

/**
 * STALE_FORWARD_RETRY, THE SECOND REVIEW: what still stood between the retry and "on", each replayed through the real
 * engine (only HubSpot's and monday's I/O faked; the card's watch -- and in [R5] the deferred queue -- are the real
 * Durable Objects):
 *   [R1] a mark's retry runs outside the cell's own queue: it re-reads the card and HubSpot right before it sends, and
 *        reads the card back after, so a newer edit of the same cell is never written over (nor a later HubSpot change);
 *   [R2] the rescue's horizon: an edit made long before the watch first held its cell is history -- converged, never
 *        pushed, claimed or counted as work -- while a recent one is rescued however late its converge runs;
 *   [R3] "sent once" is judged against this card's own pushes: this cell's own stale push overtaking the person's newest
 *        edit does not make that edit "already sent"; a later push of the property from ANOTHER cell does win;
 *   [R4] the retry's link check reads monday's log patiently, and a retry that failed before it sent anything gets its
 *        try back -- monday refusing reads no longer spends a mark;
 *   [R5] a converge that keeps failing backs off and is dead-lettered only after a day of failures, decided after a run
 *        failed: an outage of minutes or hours is ridden out, and the first converge after it heals the card;
 *   [M2] the converge asks the watch again after its activity-log read: an edit made meanwhile is held, not overwritten;
 *   [M4] a ~stage run that throws drops the marks folded into it with its stage columns (their leases take over);
 *   [M5] a rescue candidate whose history the converge did not read gets it read, instead of being put back;
 *   [M6] a backward move's clear and set reach the card's ledger together, after the set -- no RPC between them.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
const monday = vi.hoisted(() => ({
  createItem: vi.fn(), createSubitem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), findItemIdsByColumn: vi.fn(),
  getBoardItems: vi.fn(), getItem: vi.fn(), getItemFresh: vi.fn(), getItemStates: vi.fn(), getItemsColumnText: vi.fn(),
  getLinkedCell: vi.fn(), getLinkedItemIds: vi.fn(), getParentItemId: vi.fn(), getSubitems: vi.fn(), getUserById: vi.fn(),
  getUsersByEmail: vi.fn(), gql: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(), updateColumns: vi.fn(), updateItem: vi.fn(),
  whoAmI: vi.fn(),
}));
const hubspot = vi.hoisted(() => ({
  claimOwnership: vi.fn(), createRecord: vi.fn(), getDealStageLabels: vi.fn(), getCrmStageDicts: vi.fn(),
  getOwners: vi.fn(), getPropertyOptions: vi.fn(), getRecord: vi.fn(), getRecordWithHistory: vi.fn(),
  getPropertyHistory: vi.fn(), patchRecord: vi.fn(), searchCompanyByDomain: vi.fn(), searchAll: vi.fn(),
  searchContactByEmail: vi.fn(), searchModifiedIds: vi.fn(), createNote: vi.fn(), getAssociatedIds: vi.fn(),
  getAssociatedPage: vi.fn(), getAllAssociatedIds: vi.fn(), getAssociatedVia: vi.fn(), putAssociation: vi.fn(),
  deleteAssociation: vi.fn(), getRecordsByIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({
  reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(), pushBirthAssociations: vi.fn(),
  reverseSubitemEdit: vi.fn(), convergeRelationCell: vi.fn(),
}));
vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", async (orig) => ({ ...(await orig<typeof import("../src/hubspot")>()), ...hubspot }));
vi.mock("../src/associations", () => assoc);
vi.mock("../src/ensure-card", () => ({ ensureCardForRecord: vi.fn(), cardIdOf: vi.fn() }));

const W_ = await import("./fixtures/stale-forward-world");
const {
  OWN, ASK_ADA, REP, makeWorld, setWorld, installWorld, setEnv, as, live, clock, rep, repPeople, cell, people, hubspotSets,
  hubspotBumps, hold, reach, hubspotPass, mondayEdit, mondayWebhook, settleAll, eventValue, advance, fireWatch, drain,
  watchState, watchAlarmAt, logged, PASS, TYPED_LIVE, LIFECYCLE_ORDER,
} = W_;
const w = () => W_.w;
const pushes = () => W_.pushes(hubspot as never);
const trail = () => w().trail.join("\n");
const { specByObject } = await import("../src/config");
const { retryMarkedEdits, settleCardWatch, syncHubspotObject } = await import("../src/sync");
const { handleMonday } = await import("../src/webhooks");
const { uiActorTiming } = await import("../src/ui-actor");
const { resetPairedEchoes } = await import("../src/relation-edit");
const { CreateIdempotency } = await import("../src/create-idempotency-do");
const { DeferredSync } = await import("../src/deferred-sync-do");
const { crmStageDictsOf } = await import("../src/hubspot");
const CW = await import("../src/card-watch");

const ENVC = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const field = (spec: ObjectSpec, hs: string): FieldSpec => spec.fields.find(f => f.hs === hs)!;
const LIFE = field(CRM_CONTACTS, "lifecyclestage").col;
const JOB = field(CRM_CONTACTS, "jobtitle").col;
const LS = field(CRM_CONTACTS, "hs_lead_status").col;
const SALES = field(CRM_CONTACTS, "sales_user").col;
const NO_ACTIVITY = "group_mm7cj2yx";
const contactsSpec = () => specByObject(ENVC, "contacts")!;
const S0 = "2026-07-18T12:46:01.914Z";
const contact = (o: { extra?: Record<string, string>; typed?: string[] } = {}) =>
  setWorld(makeWorld(contactsSpec(), { hsId: "382447", itemId: "2856382447", created: "2026-07-18T12:40:00.000Z", synced: S0,
    props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead", ...(o.extra ?? {}) }, typed: o.typed }));
/** 2026-10-09 at `hh:mm:ss` or `hh:mm:ss.sss`, as ISO. */
const T = (hms: string) => `2026-10-09T${hms}${hms.includes(".") ? "" : ".000"}Z`;
const timing = { ...uiActorTiming };
const base = () => ({ boardId: w().spec.boardId, itemId: w().card.id, object: w().spec.object });
const count = (re: RegExp) => W_.lines.filter(l => re.test(l)).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(T("08:00:00"));
  vi.clearAllMocks();
  installWorld(monday as never, hubspot as never);
  resetPairedEchoes();
  Object.assign(uiActorTiming, { settleMs: 0, backoffMs: [0, 0] });
  assoc.syncAssociations.mockResolvedValue(undefined);
  assoc.reverseAssociations.mockResolvedValue(undefined);
  assoc.convergeRelationCell.mockResolvedValue("matched");
});
afterEach((c) => { W_.debugDump(c.task.name); Object.assign(uiActorTiming, timing); vi.restoreAllMocks(); vi.useRealTimers(); });

/** HubSpot's real rule for the lifecycle stage: a single PATCH that moves it to an EARLIER stage (from a non-empty one) is
 *  ignored -- the property keeps its value and no version is written. A clear ("") and then a set do move it. */
function hubspotIgnoresBackwardLifecycle(): void {
  w().onPatch = (patch) => {
    const to = patch.lifecyclestage;
    if (to === undefined || to === "") return;
    const h = w().hs.history.lifecyclestage ?? [];
    const prev = h.length >= 2 ? h[h.length - 2].value : "";
    if (prev !== "" && LIFECYCLE_ORDER[to] !== undefined && LIFECYCLE_ORDER[prev] !== undefined
        && LIFECYCLE_ORDER[to] < LIFECYCLE_ORDER[prev]) {
      h.pop();
      w().hs.properties.lifecyclestage = prev;
      w().trail.push(`HUBSPOT    ignores the single-PATCH backward move lifecyclestage ${prev} -> ${to} (kept ${prev})`);
    }
  };
}

// ===================================================================================================================
describe("[R1] a mark's retry never writes over a newer edit of the same cell, nor over HubSpot's later change", () => {
  interface Race { col: string; prop: string; first: string; second: string; at: "hs" | "patch"; realLifecycle?: boolean }
  /** A rep's edit (`first`) whose run dies; at its lease the retry is run by hand and held at `at` -- after its card read --
   *  while the rep edits the same cell again (`second`) and that edit's own run PATCHes first. Then the retry goes on. */
  async function race(o: Race): Promise<void> {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    if (o.realLifecycle) hubspotIgnoresBackwardLifecycle();
    clock(T("09:00:00"));
    const p0 = eventValue(o.col); rep(o.col, o.first);
    w().failGetRecord = "HOOK";                                            // its run dies at its HubSpot read
    await settleAll(await mondayWebhook("HOOK", o.col, p0, REP));
    w().failGetRecord = undefined;
    expect((await watchState())?.marks[o.col], "the dead run left its mark").toBeDefined();
    w().mods.push(T("09:01:03"), T("09:01:04"), T("09:01:05"), T("09:01:06"));
    const gate = hold("RTRY", o.at);
    clock(T("09:01:01"));
    expect(await fireWatch(), "the lease ended: the alarm fires").toBe(true);
    expect(W_.spilled.some(s => s.watch?.kind === "retry"), "a retry was queued").toBe(true);
    W_.spilled.length = 0;                                                 // run by hand, so it can be held
    const retry = retryMarkedEdits(as("RTRY"), w().spec.boardId, w().card.id, live, { left: 30 });
    await reach(gate, retry, `the retry's ${o.at}`);
    clock(T("09:01:02"));
    const p1 = eventValue(o.col); rep(o.col, o.second);                    // the rep edits the cell again...
    await settleAll(await mondayWebhook("HOOK2", o.col, p1, REP));          // ...and that edit's own run PATCHes first
    clock(T("09:01:04"));
    gate.release(); await retry;
  }
  /** The pushes' echoes, and time: the holds end and the watch converges whatever still differs. */
  async function settleDown(prop: string): Promise<void> {
    clock(T("09:01:08"));
    await hubspotPass("ECHO", { [prop]: [T("09:01:05"), true] });
    w().mods.push(T("09:06:01"), T("09:06:02"), T("09:06:03"));
    await advance(T("09:05:00"));
    await advance(T("09:30:00"));
  }

  it("held after its card read: the newer edit is its own run's -- the retry re-reads the card, defers, and sends nothing", async () => {
    await race({ col: JOB, prop: "jobtitle", first: "Buyer", second: "Director", at: "hs" });
    expect(pushes(), "only the newer edit's own push\n" + trail()).toEqual([{ jobtitle: "Director" }]);
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(cell(JOB)).toBe("Director");
    expect(logged(new RegExp(`cols=${JOB} action=edit-retry-deferred`))).toBe(true);
    await settleDown("jobtitle");
    expect(pushes(), trail()).toEqual([{ jobtitle: "Director" }]);
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(cell(JOB)).toBe("Director");
  });

  it("the newer edit's own run still in flight when the retry would send: deferred -- the stale value never reaches HubSpot", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00"));
    const p0 = eventValue(JOB); rep(JOB, "Buyer");
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", JOB, p0, REP));
    w().failGetRecord = undefined;
    w().mods.push(T("09:01:05"), T("09:01:06"));
    const gate = hold("RTRY", "hs");
    clock(T("09:01:01"));
    expect(await fireWatch()).toBe(true);
    W_.spilled.length = 0;
    const retry = retryMarkedEdits(as("RTRY"), w().spec.boardId, w().card.id, live, { left: 30 });
    await reach(gate, retry, "the retry's record read, after its card read");
    clock(T("09:01:02"));
    const p1 = eventValue(JOB); rep(JOB, "Director");
    const atHs2 = hold("HOOK2", "hs");
    const waits = await mondayWebhook("HOOK2", JOB, p1, REP);               // marked; its run held before its PATCH
    await reachIn(atHs2, waits, "the newer edit's run");
    clock(T("09:01:03"));
    gate.release(); await retry;                                            // the retry goes on first
    const byRetry = pushes().map(p => p.jobtitle);
    const deferred = logged(new RegExp(`cols=${JOB} action=edit-retry-deferred`));
    clock(T("09:01:05"));
    atHs2.release(); await settleAll(waits);                                // the newer edit's own run sends it
    expect(byRetry, "the stale Buyer is never sent\n" + trail()).toEqual([]);
    expect(deferred).toBe(true);
    expect(pushes()).toEqual([{ jobtitle: "Director" }]);
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(cell(JOB)).toBe("Director");
    expect((await watchState())?.marks[JOB], "its own run cleared the mark").toBeUndefined();
  });

  it("typed Lifecycle (HubSpot's backward rule modelled): the stale backward move is never sent", async () => {
    await race({ col: LIFE, prop: "lifecyclestage", first: "5.No intention", second: "7.Intention to purchase", at: "hs",
      realLifecycle: true });
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "opportunity" }]);
    await settleDown("lifecyclestage");
    expect(w().hs.properties.lifecyclestage, trail()).toBe("opportunity");
    expect(cell(LIFE)).toBe("7.Intention to purchase");
  });

  it("held at its PATCH (in flight while the newer edit's run lands first): read back, RACED, and re-sent from the card at once", async () => {
    await race({ col: JOB, prop: "jobtitle", first: "Buyer", second: "Director", at: "patch" });
    expect(w().hs.properties.jobtitle, "the stale PATCH landed last").toBe("Buyer");
    expect(logged(new RegExp(`cols=${JOB} action=edit-retry-raced`)), trail()).toBe(true);
    clock(T("09:01:05"));
    await drain();                                                          // the re-send it queued, seconds later
    expect(w().hs.properties.jobtitle, "healed at once, not at the next converge\n" + trail()).toBe("Director");
    expect(cell(JOB)).toBe("Director");
    await settleDown("jobtitle");
    expect(w().hs.properties.jobtitle, trail()).toBe("Director");
    expect(cell(JOB)).toBe("Director");
  });

  it("the RESCUE's retry, raced the same way by the person's next edit: the newer edit ends on both sides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00")); rep(JOB, "Buyer", { userId: ASK_ADA, uuid: true });   // a person working as ask ada
    await mondayEdit("SELF", [JOB], { selfOrigin: true });                      // misread as our echo: never pushed
    w().mods.push(T("09:03:13"), T("09:03:14"), T("09:03:15"));
    const gate = hold("QUEUE", "hs");                                           // the rescue's retry, after its card read
    const adv = advance(T("09:03:10"));
    await reach(gate, adv, "the rescue's retry");
    expect(logged(/action=rescued/), trail()).toBe(true);
    clock(T("09:03:11"));
    const p1 = eventValue(JOB); rep(JOB, "Director");
    await settleAll(await mondayWebhook("HOOK2", JOB, p1, REP));                 // its run PATCHes Director first
    clock(T("09:03:14"));
    gate.release(); await adv;
    clock(T("09:03:18"));
    await hubspotPass("ECHO", { jobtitle: [T("09:03:13"), true] });
    w().mods.push(T("09:08:01"), T("09:08:02"));
    await advance(T("09:08:00"));
    await advance(T("09:40:00"));
    expect(pushes(), trail()).toEqual([{ jobtitle: "Director" }]);
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(cell(JOB)).toBe("Director");
  });

  it("[M1] a HubSpot user's change between the retry's supersede check and its push wins: re-read at the push, given up", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00"));
    const p0 = eventValue(JOB); rep(JOB, "Buyer");
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", JOB, p0, REP));
    w().failGetRecord = undefined;
    const atRead = hold("RTRY", "hs");                                          // its push's record read, after the check
    clock(T("09:01:01"));
    expect(await fireWatch()).toBe(true);
    W_.spilled.length = 0;
    const retry = retryMarkedEdits(as("RTRY"), w().spec.boardId, w().card.id, live, { left: 30 });
    await reach(atRead, retry, "the retry's record read for its push");
    clock(T("09:01:02"));
    hubspotSets("jobtitle", "Director", T("09:01:02"), "CRM_UI");               // a HubSpot user, a minute after the edit
    w().mods.push(T("09:01:03"));
    atRead.release(); await retry;
    expect(pushes(), "the minute-old edit is never sent over it\n" + trail()).toEqual([]);
    expect(logged(new RegExp(`cols=${JOB} action=edit-retry-superseded`))).toBe(true);
    await advance(T("09:01:30"));
    await advance(T("09:05:00"));                                               // the card's own hold ends at +W
    expect(cell(JOB), "the cell converges to the later change\n" + trail()).toBe("Director");
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(pushes(), "never rescued either (given up)").toEqual([]);
  });

  it("STALE_FORWARD_RETRY off: the same two edits (no retry) end on the newer one, as before", async () => {
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00"));
    const p0 = eventValue(JOB); rep(JOB, "Buyer");
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", JOB, p0, REP));
    w().failGetRecord = undefined;
    clock(T("09:01:02"));
    const p1 = eventValue(JOB); rep(JOB, "Director");
    w().mods.push(T("09:01:03"));
    await settleAll(await mondayWebhook("HOOK2", JOB, p1, REP));
    await advance(T("09:05:00")); await advance(T("09:30:00"));
    expect(pushes()).toEqual([{ jobtitle: "Director" }]);
    expect(cell(JOB)).toBe("Director");
  });
});

// ===================================================================================================================
describe("[R2] the rescue's horizon: an edit made long before the watch first held its cell is history", () => {
  /** An imported contact (created 07-18), carded by the 09-18 import, UNSTAMPED, sitting in No Activity. */
  function imported(): void {
    setWorld(makeWorld(contactsSpec(), { hsId: "553250000001", itemId: "2856000001", created: "2026-07-18T12:40:00.000Z",
      synced: "2026-09-18T06:00:00.000Z", typed: TYPED_LIVE,
      props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead", hs_lead_status: "NEW",
        jobtitle: "Buyer" } }));
    w().card.created_at = "2026-09-18T05:59:00.000Z";
    w().hs.properties.sync_owner = "";
    hubspot.claimOwnership.mockImplementation(async () => {
      w().trail.push("CLAIM sync_owner=crm"); w().hs.properties.sync_owner = "crm"; return "2026-10-14T02:03:05.000Z";
    });
  }
  /** What the Worker did with an ask-ada UI edit before ASK_ADA_UI_EDITS (and before the gate): our echo, forward only. */
  async function echoUnderHead(): Promise<void> {
    setEnv({ STALE_FORWARD_GATE: "false", ASK_ADA_UI_EDITS: "false" });
    await mondayEdit("SELF", [], { selfOrigin: true });
  }
  /** 2026-10-14: a passive HubSpot recalculation (a marketing-email open), and the every-minute poll's UNSCOPED pass. */
  async function passiveChangeThenPoll(): Promise<void> {
    setEnv({ STALE_FORWARD_GATE: "true", STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    clock("2026-10-14T02:00:00.000Z");
    hubspotSets("hs_email_last_open_date", "2026-10-14T01:59:30.000Z", "2026-10-14T02:00:00.000Z", "CALCULATED");
    w().mods.push("2026-10-14T02:03:10.000Z", "2026-10-14T02:03:11.000Z", "2026-10-14T02:03:12.000Z");
    clock("2026-10-14T02:00:40.000Z");
    await hubspotPass("POLL");
    await advance("2026-10-14T02:03:05.000Z");
    await advance("2026-10-14T02:40:00.000Z");
  }

  it("ask ada's Lifecycle edit of 09-28 (read as our echo then): converged -- never pushed, claimed, or counted as work", async () => {
    imported();
    clock("2026-09-28T03:00:00.000Z");
    rep(LIFE, "6.Not in contact/Pending further contact", { userId: ASK_ADA, uuid: true });
    await echoUnderHead();
    expect(cell(LIFE)).toBe("6.Not in contact/Pending further contact");
    await passiveChangeThenPoll();
    expect(pushes(), trail()).toEqual([]);
    expect(hubspot.claimOwnership, "never claimed on an old row").not.toHaveBeenCalled();
    expect(logged(/action=rescued/)).toBe(false);
    expect(cell(LIFE), "converged to HubSpot's").toBe("1.NEW");
    expect(w().card.group.id, "not taken out of No Activity by a 16-day-old edit").toBe(NO_ACTIVITY);
  });

  it("a rep's pre-cutover Lead Status edit whose run died, and an untyped Job Title of weeks ago: neither is pushed", async () => {
    imported();
    clock("2026-09-24T05:00:00.000Z");
    rep(LS, "In Progress", { userId: REP, uuid: true });
    clock("2026-09-28T03:00:00.000Z");
    rep(JOB, "Head of Purchasing", { userId: ASK_ADA, uuid: true });
    await echoUnderHead();
    await passiveChangeThenPoll();
    expect(pushes(), trail()).toEqual([]);
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(cell(LS)).toBe("New");
    expect(cell(JOB)).toBe("Buyer");
  });

  it("a People cell (Sales User) reassigned weeks ago is never pushed: no owner is reassigned on an old row", async () => {
    imported();
    w().hs.properties.sales_user = "777";
    w().hs.history.sales_user = [{ value: "777", timestamp: "2026-07-18T12:40:00.000Z", sourceType: "CRM_UI" }];
    w().ctxOwners = { "777": { name: "Joan", email: "joan@example.com" }, "888": { name: "Ann", email: "ann@example.com" } };
    w().mondayUsers = { "joan@example.com": "999", "ann@example.com": "998" };
    const c = w().card.column_values.find(x => x.id === SALES)!;
    c.persons_and_teams = [{ id: "999", kind: "person" as const }]; c.text = "999";
    w().changedAt[SALES] = Date.parse("2026-09-18T06:00:00.000Z");
    clock("2026-09-28T03:00:00.000Z");
    repPeople(SALES, ["998"], { userId: ASK_ADA });
    await echoUnderHead();
    await passiveChangeThenPoll();
    expect(pushes(), trail()).toEqual([]);
    expect(people(SALES)).toEqual(["999"]);
  });

  it("...while an edit the watch held at once is still rescued, however late its converge runs (a two-hour outage)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ typed: TYPED_LIVE });
    clock(T("09:00:00")); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });                   // misread as our echo: held at once
    w().historyFails = true;                                                  // HubSpot's reads fail from now
    const at = (m: number) => new Date(Date.parse(T("09:00:10")) + m * 60_000).toISOString();
    for (let m = 3; m <= 120; m += 3) await advance(at(m));
    expect(pushes()).toEqual([]);
    expect(logged(/action=converge-dead-letter/), "an outage is ridden out\n" + trail()).toBe(false);
    w().historyFails = false;
    w().mods.push(T("13:00:00"), T("13:00:01"));
    for (let m = 123; m <= 600; m += 3) await advance(at(m));
    expect(pushes(), "rescued once HubSpot answers\n" + trail()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(cell(LIFE)).toBe("5.No intention");
  });
});

// ===================================================================================================================
/** Every monday write of the pass named `pass` fails (its run throws after whatever it sent to HubSpot). */
function loseWritesOf(pass: string): void {
  for (const fn of ["setColumns", "updateColumns", "updateItem"] as const) {
    const real = monday[fn].getMockImplementation()!;
    monday[fn].mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === pass) throw new Error(`monday 500: ${pass}'s write is lost`);
      return (real as any)(env, ...rest);
    });
  }
}

describe("[R3] sent once -- unless this cell's own stale push overtook it; a later push from another cell wins", () => {
  it("two runs of the same cell (two isolates): run 1's stale PATCH lands last -- the newest edit ends on both sides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { jobtitle: "Engineer" } });
    clock(T("09:00:00")); rep(JOB, "Buyer");
    const g1 = hold("RUN-1", "patch");
    const r1 = mondayEdit("RUN-1", [JOB]);                                    // reads Buyer, stalls before its PATCH
    await reach(g1, r1, "run 1's PATCH");
    clock(T("09:00:01")); rep(JOB, "Director");
    w().mods.push(T("09:00:02"));
    await mondayEdit("RUN-2", [JOB]);                                         // reads Director, PATCHes first
    clock(T("09:00:03")); w().mods.push(T("09:00:03"));
    g1.release(); await r1;                                                   // the stale PATCH lands last
    expect(w().hs.properties.jobtitle).toBe("Buyer");
    expect(cell(JOB)).toBe("Director");
    clock(T("09:00:04")); await hubspotPass("ECHO-D", { jobtitle: [T("09:00:02"), true] });
    clock(T("09:00:05")); await hubspotPass("ECHO-B", { jobtitle: [T("09:00:03"), true] });
    w().mods.push(T("09:03:30"), T("09:03:31"));
    await advance(T("09:03:20"));
    await advance(T("09:15:00"));
    expect(logged(/action=rescue-declined reason="this card already sent this edit/), trail()).toBe(false);
    expect(w().hs.properties.jobtitle, trail()).toBe("Director");
    expect(cell(JOB), "the stale value is never written over the newest edit").toBe("Director");
  });

  it("a click correction (Open, Unqualified, Open again in 4 s) whose last click was misread as our echo: Open on both sides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { hs_lead_status: "NEW" } });
    clock(T("09:00:00")); let prev = eventValue(LS); rep(LS, "Open", { userId: ASK_ADA, uuid: true });
    w().mods.push(T("09:00:01"));
    await settleAll(await mondayWebhook("CLICK-1", LS, prev, ASK_ADA));
    clock(T("09:00:02")); prev = eventValue(LS); rep(LS, "Unqualified", { userId: ASK_ADA, uuid: true });
    w().mods.push(T("09:00:03"));
    await settleAll(await mondayWebhook("CLICK-2", LS, prev, ASK_ADA));
    clock(T("09:00:04")); prev = eventValue(LS); rep(LS, "Open", { userId: ASK_ADA, uuid: true });
    w().logFails = true;                                                      // its log lookup fails: read as our echo
    await settleAll(await mondayWebhook("CLICK-3", LS, prev, ASK_ADA));
    w().logFails = false;
    expect(pushes()).toEqual([{ hs_lead_status: "OPEN" }, { hs_lead_status: "UNQUALIFIED" }]);
    clock(T("09:00:05"));
    await hubspotPass("ECHO-1", { hs_lead_status: [T("09:00:01"), true] });
    await hubspotPass("ECHO-2", { hs_lead_status: [T("09:00:03"), true] });
    w().mods.push(T("09:03:30"), T("09:03:31"));
    await advance(T("09:03:20"));
    await advance(T("09:15:00"));
    expect(w().hs.properties.hs_lead_status, trail()).toBe("OPEN");
    expect(cell(LS), "the person's final Open is never put back to the mis-click").toBe("Open");
  });

  it("a company's rename after an older Name-column edit (misread as our echo): the later edit of `name` wins -- never re-sent over", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    const spec = specByObject(ENVC, "companies")!;
    const NAME_COL = field(spec, "name").col;
    setWorld(makeWorld(spec, { hsId: "7001", itemId: "2857007001", created: "2026-07-18T12:40:00.000Z", synced: S0,
      props: { name: "Acme", domain: "acme.com" } }));
    expect(w().card.name).toBe("Acme");
    clock(T("09:00:00")); rep(NAME_COL, "Acme Ltd", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [NAME_COL], { selfOrigin: true });              // misread as our echo: never pushed
    clock(T("09:00:10"));
    w().trail.push("09:00:10.000 REP        rename: \"Acme\" -> \"Acme Group\""); w().card.name = "Acme Group"; w().card.updated_at = W_.now();
    w().mods.push(T("09:00:11"));
    loseWritesOf("RENAME");
    await mondayEdit("RENAME", [], { name: true }).catch(() => undefined);    // pushed name=Acme Group; its card write lost
    expect(w().hs.properties.name).toBe("Acme Group");
    expect(cell(NAME_COL)).toBe("Acme Ltd");
    clock(T("09:00:12"));
    await hubspotPass("ECHO", { name: [T("09:00:11"), true] });
    w().mods.push(T("09:04:01"), T("09:04:02"));
    await advance(T("09:04:00"));
    await advance(T("09:30:00"));
    expect(pushes(), "the older Name-column edit is never sent over the rename\n" + trail()).toEqual([{ name: "Acme Group" }]);
    expect(w().hs.properties.name).toBe("Acme Group");
    expect(cell(NAME_COL), "the Name column converges to the later edit").toBe("Acme Group");
  });

  it("...but a Name-column edit made AFTER the rename is the newer edit: rescued and sent", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    const spec = specByObject(ENVC, "companies")!;
    const NAME_COL = field(spec, "name").col;
    setWorld(makeWorld(spec, { hsId: "7001", itemId: "2857007001", created: "2026-07-18T12:40:00.000Z", synced: S0,
      props: { name: "Acme", domain: "acme.com" } }));
    clock(T("09:00:00"));
    w().card.name = "Acme Group"; w().card.updated_at = W_.now();
    w().mods.push(T("09:00:01"));
    await mondayEdit("RENAME", [], { name: true });                           // pushed, and its Name column written
    expect(cell(NAME_COL)).toBe("Acme Group");
    clock(T("09:00:20")); rep(NAME_COL, "Acme Holdings", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [NAME_COL], { selfOrigin: true });              // misread as our echo
    w().mods.push(T("09:04:01"), T("09:04:02"));
    await advance(T("09:04:00"));
    await advance(T("09:30:00"));
    expect(pushes(), trail()).toEqual([{ name: "Acme Group" }, { name: "Acme Holdings" }]);
    expect(cell(NAME_COL)).toBe("Acme Holdings");
  });
});

// ===================================================================================================================
describe("[R4] the retry's link check: patient, and a retry that failed before sending keeps its try", () => {
  let logCalls: { at: string; retries: unknown; waits: unknown; refused: boolean }[] = [];
  let refuseLogAt: (ms: number) => boolean = () => false;
  beforeEach(() => {
    logCalls = [];
    refuseLogAt = () => false;
    const orig = monday.gql.getMockImplementation()!;
    monday.gql.mockImplementation(async (env: unknown, query: string, vars: Record<string, unknown>, retries?: unknown, waits?: unknown) => {
      if (query.includes("activity_logs")) {
        const refused = refuseLogAt(Date.now());
        logCalls.push({ at: new Date(Date.now()).toISOString().slice(11, 19), retries, waits, refused });
        if (refused) {
          const e = new Error("monday 429: rate-limited after 6 waits: Complexity budget exhausted"); e.name = "MondayRateLimitedError";
          throw e;
        }
      }
      return orig(env, query, vars, retries, waits);
    });
  });
  /** DEFERRED_SYNC as deployed: each item tried up to MAX_ATTEMPTS (3) times, a wave (~10 s) apart. */
  async function queueDrain(): Promise<number> {
    let n = 0;
    while (W_.spilled.length) {
      const it = W_.spilled.shift()!;
      n++;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (it.watch?.kind === "converge") await settleCardWatch(as("QUEUE"), it.watch.boardId, it.id, live, { left: 30 });
          else if (it.watch?.kind === "retry") await retryMarkedEdits(as("QUEUE"), it.watch.boardId, it.id, live, { left: 30 });
          else await syncHubspotObject(as("QUEUE"), it.type, it.id, live, { left: 30 });
          break;
        } catch (e) {
          w().trail.push(`${new Date(Date.now()).toISOString().slice(11, 19)} QUEUE try ${attempt} threw: ${String(e).slice(0, 80)}`);
          clock(new Date(Date.now() + 10_000).toISOString());
        }
      }
    }
    return n;
  }
  async function runFor(fromHms: string, toHms: string): Promise<void> {
    for (let at = Date.parse(T(fromHms)); at <= Date.parse(T(toHms)); at += 15_000) {
      clock(new Date(at).toISOString());
      for (let i = 0; i < 20; i++) { const f = await fireWatch(); const r = await queueDrain(); if (!f && !r) break; }
    }
  }
  async function deadRun(): Promise<void> {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ typed: TYPED_LIVE });
    clock(T("09:00:00"));
    const prev = eventValue(LIFE); rep(LIFE, "5.No intention");
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", LIFE, prev, REP));
    w().failGetRecord = undefined;
    expect((await watchState())?.marks[LIFE]).toBeDefined();
    w().mods.push(T("09:10:00"), T("09:11:00"), T("09:12:00"));
  }
  const within = (ms: number, a: string, b: string) => ms >= Date.parse(T(a)) && ms < Date.parse(T(b));

  it("its log read waits out monday's rate limit (gql's own retries and waits), unlike the converge's", async () => {
    await deadRun();
    await runFor("09:01:00", "09:03:00");
    expect(logCalls.length, trail()).toBeGreaterThan(0);
    for (const c of logCalls) { expect(c.retries, "gql's default retries").toBeUndefined(); expect(c.waits).toBeUndefined(); }
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }]);
  });

  it("two short bursts of refusals (09:01:00-09:01:30 and 09:05:00-09:05:15) no longer spend the mark: the edit is sent", async () => {
    await deadRun();
    refuseLogAt = ms => within(ms, "09:01:00", "09:01:30") || within(ms, "09:05:00", "09:05:15");
    await runFor("09:01:00", "09:12:00");
    expect(logged(/action=edit-retry-abandoned/), trail()).toBe(false);
    expect(pushes(), "HubSpot never refused it: it is sent\n" + trail()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(logged(/action=edit-retry-refunded/)).toBe(true);
  });

  it("a card whose watch knows when it was linked needs no log read: the watch's link time settles it", async () => {
    await deadRun();
    await W_.namespace.get(W_.watchKey()).watchCells(Date.now(), CW.holdWindowMs({}), { ...base(), recordId: "382447" }, [],
      { linkedAt: Date.parse(T("08:59:00")) });                             // linked a minute before the edit
    await runFor("09:01:00", "09:02:00");
    expect(logCalls, "no activity-log read\n" + trail()).toEqual([]);
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }]);
  });
});

// ===================================================================================================================
describe("[R5] a converge that keeps failing backs off; only a day of failures dead-letters it", () => {
  // THE REAL DEFERRED QUEUE (FIRST_DELAY_MS, WAVE_GAP_MS, MAX_ATTEMPTS as deployed) and the real watch, driven alarm by
  // alarm: whichever is due next fires.
  const cloneJ = <X>(x: X): X => (x === undefined ? x : JSON.parse(JSON.stringify(x)) as X);
  function mkCtx() {
    const map = new Map<string, unknown>();
    let alarm: number | null = null;
    let chain: Promise<unknown> = Promise.resolve();
    return {
      storage: {
        get: async (k: string) => cloneJ(map.get(k)), put: async (k: string, v: unknown) => { map.set(k, cloneJ(v)); },
        delete: async (k: string) => { map.delete(k); }, deleteAll: async () => { map.clear(); },
        setAlarm: async (ts: number) => { alarm = ts; }, deleteAlarm: async () => { alarm = null; }, getAlarm: async () => alarm,
      },
      blockConcurrencyWhile: <X>(fn: () => Promise<X>): Promise<X> => { const run = chain.then(fn); chain = run.catch(() => undefined); return run as Promise<X>; },
      alarmAt: () => alarm, clearAlarm: () => { alarm = null; },
    };
  }
  let qCtx: ReturnType<typeof mkCtx>;
  let queue: any;
  function newQueue(): void {
    qCtx = mkCtx();
    const env = new Proxy({}, { get: (_t, k) => (as("QUEUE") as any)[k] });
    queue = new (DeferredSync as any)(qCtx, env);
  }
  async function runUntil(targetMs: number): Promise<void> {
    for (let i = 0; i < 50_000; i++) {
      if (W_.spilled.length) await queue.enqueue(W_.spilled.splice(0));
      const wa = watchAlarmAt(), qa = qCtx.alarmAt();
      const next = Math.min(wa ?? Infinity, qa ?? Infinity);
      if (!Number.isFinite(next) || next > targetMs) { if (Date.now() < targetMs) clock(new Date(targetMs).toISOString()); return; }
      if (next > Date.now()) clock(new Date(next).toISOString());
      if (qa !== null && qa <= Date.now()) { qCtx.clearAlarm(); await queue.alarm(); }
      else await fireWatch();
    }
    throw new Error("runUntil made no progress");
  }
  const T0 = Date.parse(T("09:00:00"));
  const PERSON = "6.Not in contact/Pending further contact";
  let begins = 0;
  async function outage(o: { retry: boolean; minutes: number; untilH: number }) {
    if (o.retry) setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact();
    newQueue();
    const from = T0 + 180_000, to = from + o.minutes * 60_000;
    const realHist = hubspot.getRecordWithHistory.getMockImplementation()!;
    hubspot.getRecordWithHistory.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (Date.now() >= from && Date.now() < to) throw new Error("hubspot GET: 503 Service Unavailable");
      return (realHist as any)(env, ...rest);
    });
    const realPatch = hubspot.patchRecord.getMockImplementation()!;
    hubspot.patchRecord.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (!w().mods.length) w().mods.push(new Date(Date.now() + 400).toISOString());
      return (realPatch as any)(env, ...rest);
    });
    const realBegin = (CreateIdempotency as any).prototype.beginConverge;
    begins = 0;
    vi.spyOn((CreateIdempotency as any).prototype, "beginConverge").mockImplementation(async function (this: any, ...a: unknown[]) {
      begins++; return realBegin.apply(this, a);
    });
    clock(new Date(T0).toISOString()); rep(LIFE, PERSON, { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });                   // a person's edit read as our echo: watched
    expect((await watchState())?.cells[LIFE]).toBeDefined();
    await runUntil(T0 + o.untilH * 3600_000);                                 // no HubSpot event at all
  }

  it.each([30, 180])("a %i-minute HubSpot outage from the first converge is ridden out: the card is put back once HubSpot answers (STALE_FORWARD_RETRY off)", async (minutes) => {
    await outage({ retry: false, minutes, untilH: 24 });
    expect(logged(/action=converge-dead-letter/), trail()).toBe(false);
    expect(cell(LIFE), "healed, never left silently out of line").toBe("1.NEW");
    expect(w().hs.properties.lifecyclestage).toBe("lead");
    expect(Object.keys((await watchState())?.cells ?? {})).toEqual([]);
  });

  it("...and with STALE_FORWARD_RETRY on the same edit reaches HubSpot after a 30-minute outage", async () => {
    await outage({ retry: true, minutes: 30, untilH: 24 });
    expect(w().hs.properties.lifecyclestage, trail()).toBe("1029059095");
    expect(cell(LIFE)).toBe(PERSON);
  });

  it("a value monday never takes: the converge backs off (bounded over six hours), dead-lettered loudly after a day", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    newQueue();
    const realBegin = (CreateIdempotency as any).prototype.beginConverge;
    begins = 0;
    vi.spyOn((CreateIdempotency as any).prototype, "beginConverge").mockImplementation(async function (this: any, ...a: unknown[]) {
      begins++; return realBegin.apply(this, a);
    });
    clock(new Date(T0).toISOString()); rep(JOB, "Buyer", { userId: ASK_ADA, uuid: false });
    await mondayEdit("SELF", [JOB], { selfOrigin: true });
    const real = monday.updateColumns.getMockImplementation()!;
    monday.updateColumns.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === "QUEUE") throw new Error("monday 200: ColumnValueException (a value monday will never take)");
      return (real as any)(env, ...rest);
    });
    await runUntil(T0 + 6 * 3600_000);
    expect(begins, "backed off: far fewer than one every ten minutes").toBeLessThanOrEqual(24);
    expect(logged(/action=converge-dead-letter/)).toBe(false);
    expect((await watchState())?.cells[JOB], "still watched").toBeDefined();
    await runUntil(T0 + 23 * 3600_000);
    expect(logged(/action=converge-dead-letter/), "not before a day of failures").toBe(false);
    await runUntil(T0 + 31 * 3600_000);
    expect(logged(new RegExp(`cols=${JOB} action=converge-dead-letter`)), trail()).toBe(true);
    expect(Object.keys((await watchState())?.cells ?? {})).toEqual([]);
    const after = begins;
    await runUntil(T0 + 48 * 3600_000);
    expect(begins, "nothing re-queued after the dead-letter").toBe(after);
  });
});

// ===================================================================================================================
describe("[M2] the converge asks the watch again after its activity-log read", () => {
  it("a person's edit made while the converge reads monday's log is held, not written over", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00")); rep(JOB, "Buyer", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [JOB], { selfOrigin: true });                     // misread as our echo: watched
    clock(T("09:00:30")); hubspotSets("jobtitle", "Director", T("09:00:30"), "INTEGRATION", OWN);   // an operator's fix
    clock(T("09:00:31"));
    await hubspotPass("OPS", { jobtitle: [T("09:00:30"), true] });
    clock(T("09:03:01"));
    expect(await fireWatch(), trail()).toBe(true);
    W_.spilled.length = 0;
    const atLog = hold("CONV", "log");
    const conv = settleCardWatch(as("CONV"), w().spec.boardId, w().card.id, live, { left: 30 });
    await reach(atLog, conv, "the converge's log read");
    clock(T("09:03:02"));
    const prev = eventValue(JOB); rep(JOB, "Manager");                        // the rep edits the cell meanwhile
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", JOB, prev, REP);                // marked; its run reads the card later
    await Promise.race([atHs.reached, Promise.allSettled(waits)]);
    clock(T("09:03:03"));
    atLog.release(); await conv;
    expect(cell(JOB), "not written over by the converge\n" + trail()).toBe("Manager");
    w().mods.push(T("09:03:05"));
    atHs.release(); await settleAll(waits);
    await advance(T("09:30:00"));
    expect(w().hs.properties.jobtitle, trail()).toBe("Manager");
    expect(cell(JOB)).toBe("Manager");
  });
});

// ===================================================================================================================
const DICTS = crmStageDictsOf(PIPELINES as never);
const COARSE = "deal_stage", EXACT = "dropdown_mm7624zd";
const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };
function deal(stage: string, synced: string) {
  const ww = setWorld(makeWorld(specByObject(ENVC, "deals")!, { hsId: "9001", itemId: "5551", created: "2026-09-01T00:00:00.000Z",
    synced, group: "topics", labels: LABELS,
    props: { dealname: "Acme renewal", dealstage: stage, pipeline: DICTS.pipelineByStage[stage], amount: "1000",
      hs_v2_date_entered_current_stage: "2026-09-01T00:00:00.000Z" } }));
  ww.onPatch = (patch: Record<string, string>, mod: string) => { if (patch.dealstage) w().hs.properties.hs_v2_date_entered_current_stage = mod; };
  hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
  return ww;
}
async function reachIn(g: { reached: Promise<void> }, waits: Promise<unknown>[], what: string): Promise<void> {
  await Promise.race([g.reached, Promise.allSettled(waits).then(() => { throw new Error(`${what} was never reached`); })]);
}

describe("[M4] a ~stage run that throws drops the marks folded into it, with its stage columns", () => {
  it("a lost HubSpot Stage edit is still put back by the watch once its lease ends (the next stage run never clears its mark)", async () => {
    setEnv({ STAGE_COARSE_REVERSE: "true" });
    deal("contractsent", "2026-09-29T02:00:00.000Z");
    const hsLabel = DICTS.stages.contractsent;
    expect(cell(EXACT)).toBe(hsLabel);
    clock(T("09:00:00"));
    const prevC = eventValue(COARSE); rep(COARSE, "Won");
    const atHs = hold("HOOK-1", "hs");
    const waits1 = await mondayWebhook("HOOK-1", COARSE, prevC, REP);
    await reachIn(atHs, waits1, "run #1's HubSpot read");
    clock(T("09:00:01"));
    const prevE = eventValue(EXACT); rep(EXACT, DICTS.stages.appointmentscheduled);
    const waits2 = await mondayWebhook("HOOK-2", EXACT, prevE, REP);          // folded into run #1's ~stage queue
    w().failGetRecord = "HOOK-1";
    atHs.release(); await settleAll([...waits1, ...waits2]);                 // run #1 throws: E2 is never run
    w().failGetRecord = undefined;
    expect(w().hs.properties.dealstage, "nothing reached HubSpot").toBe("contractsent");
    clock(T("09:00:30"));
    const prevC3 = eventValue(COARSE); rep(COARSE, "Lost");
    await settleAll(await mondayWebhook("HOOK-3", COARSE, prevC3, REP));
    expect((await watchState())?.marks[EXACT], "the unrelated stage run never cleared the lost edit's mark").toBeDefined();
    await advance(T("09:10:00"));
    await advance(T("12:00:00"));
    expect(cell(EXACT), "put back, visibly\n" + trail()).toBe(hsLabel);
  });
});

// ===================================================================================================================
describe("[M5] a rescue candidate whose history the converge did not read gets it read", () => {
  it("a person's Lifecycle edit whose webhook was lost, put in play by a converge of another cell: rescued, not put back", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00")); rep(JOB, "Buyer", { userId: ASK_ADA, uuid: false });
    await mondayEdit("SELF", [JOB], { selfOrigin: true });                     // our own write: watched, converged later
    clock(T("09:00:10")); rep(LIFE, "5.No intention");                       // a person's edit; monday never delivers it
    w().historyFails = true;                                                  // the first converge of JOB fails
    await advance(T("09:03:05"));
    w().historyFails = false;
    clock(T("09:05:00")); hubspotBumps(T("09:05:00"));                       // a recalculation: newer than Sync State
    w().mods.push(T("09:20:00"), T("09:20:01"));
    await advance(T("09:13:10"));
    await advance(T("09:30:00"));
    expect(logged(/action=rescue-declined reason="HubSpot's history of it was not read/), trail()).toBe(false);
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(cell(LIFE)).toBe("5.No intention");
  });
});

// ===================================================================================================================
describe("[M6] a backward move's ledger entries are recorded together, after its set", () => {
  it("no ledger RPC between the clear and the set: HubSpot holds the stage empty no longer than the two PATCHes", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { lifecyclestage: "opportunity" }, typed: TYPED_LIVE });
    const ledger = vi.spyOn(CreateIdempotency.prototype, "notePushes");
    clock(T("09:00:00")); rep(LIFE, "5.No intention");                       // a move BACK: a clear, then the set
    w().mods.push(T("09:00:02"), T("09:00:03"));
    await mondayEdit("EDIT", [LIFE]);
    expect(pushes()).toEqual([{ lifecyclestage: "" }, { lifecyclestage: "1029060900" }]);
    expect(ledger, "one RPC for the whole move").toHaveBeenCalledTimes(1);
    const set = hubspot.patchRecord.mock.invocationCallOrder[1];
    expect(ledger.mock.invocationCallOrder[0], "recorded after the set").toBeGreaterThan(set);
    expect((await watchState())?.pushes?.map(p => `${p.prop}=${p.value}`)).toEqual(["lifecyclestage=", "lifecyclestage=1029060900"]);
  });
});
