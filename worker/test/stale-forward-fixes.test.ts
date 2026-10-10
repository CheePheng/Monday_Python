import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import { PIPELINES } from "./fixtures/deal-pipelines";
import type { FieldSpec, ObjectSpec, RunOpts } from "../src/types";

/**
 * STALE_FORWARD_GATE: THE REVIEW'S CONFIRMED FINDINGS, each replayed through the real engine (only HubSpot's and
 * monday's I/O faked; the card's watch is the real Durable Object) and pinned. Every test here failed on the change as
 * it stood before its fix:
 *   [F1]  an adopted card's form values pushed (and the record claimed) by the converge's log rescue / a mark's retry;
 *   [F2]  a retried People removal clearing HubSpot's real owner (no removedPeople on the retry);
 *   [F3]  the loop breaker burying a genuine HubSpot change (keyed on HubSpot's value alone);
 *   [F4]  the monday-born create fill writing defaults over a pick made during the create;
 *   [F5]  a coarse Stage cell left by an expired mark re-converging every few seconds, forever;
 *   [F6]  a superseded retry dropping the watch with card and HubSpot disagreeing;
 *   [F7]  a second never-pushed value of the same cell left unconverged for a day (or forever);
 *   [F8]  a failed pass's scope put back with no re-run coming, read by the record's next, unrelated pass;
 *   [F9]  the Sync State register forgetting a stamp before an older write could land after it;
 *   [F10] a /resync dry run leaving durable watch state that later wrote monday for real;
 *   [F11] 31010016's New on a HubSpot-born Won deal held, and never corrected;
 *   [M2]  the register's own restamp put back over a newer stamp, unnoticed.
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
  ASK_ADA, REP, makeWorld, setWorld, installWorld, setEnv, as, live, clock, now, rep, repPeople, hubspotSets, note,
  hubspotBumps, cell, syncState, people, hold, reach, hubspotPass, mondayEdit, mondayWebhook, settleAll, eventValue,
  advance, fireWatch, drain, watchState, watchIdle, watchAlarmAt, logged, spilled, expectSyncStateNeverBackwards, TYPED_LIVE,
} = W_;
const w = () => W_.w;
const pushes = () => W_.pushes(hubspot as never);
const trail = () => w().trail.join("\n");
const count = (re: RegExp) => W_.lines.filter(l => re.test(l)).length;
const { specByObject } = await import("../src/config");
const { syncHubspotRecord, syncMondayItem } = await import("../src/sync");
const { handleHubspot } = await import("../src/webhooks");
const { uiActorTiming } = await import("../src/ui-actor");
const { resetPairedEchoes } = await import("../src/relation-edit");
const { CreateIdempotency } = await import("../src/create-idempotency-do");
const { crmStageDictsOf } = await import("../src/hubspot");
const { FIRST_DELAY_MS, WAVE_GAP_MS } = await import("../src/deferred-sync");
const { STUCK_MS } = await import("../src/card-watch");

const ENVC = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const field = (spec: ObjectSpec, hs: string): FieldSpec => spec.fields.find(f => f.hs === hs)!;
const LIFE = field(CRM_CONTACTS, "lifecyclestage").col;
const JOB = field(CRM_CONTACTS, "jobtitle").col;
const EMAIL = field(CRM_CONTACTS, "email").col;
const LAST = field(CRM_CONTACTS, "lastname").col;
const SALES = field(CRM_CONTACTS, "sales_user").col;
const contactsSpec = () => specByObject(ENVC, "contacts")!;
const dealsSpec = () => specByObject(ENVC, "deals")!;
const S0 = "2026-07-18T12:46:01.914Z";
const contact = (o: { extra?: Record<string, string>; typed?: string[] } = {}) =>
  setWorld(makeWorld(contactsSpec(), { hsId: "382447", itemId: "2856382447", created: "2026-07-18T12:40:00.000Z", synced: S0,
    props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead", ...(o.extra ?? {}) }, typed: o.typed }));
/** 2026-10-09 at `hh:mm:ss` or `hh:mm:ss.sss`, as ISO. */
const T = (hms: string) => `2026-10-09T${hms}${hms.includes(".") ? "" : ".000"}Z`;
const timing = { ...uiActorTiming };
const dry: RunOpts = { dryRun: true, writeHubspot: false, maxWrites: 30 };

/** The live CRM flag set (2026-10-10), with both gate switches on. */
const LIVE = {
  WRITE_HUBSPOT: "true", ASK_ADA_UI_EDITS: "true", HS_RATE_LIMIT_RETRY: "true", NO_ACTIVITY_RELEASE: "true",
  OWNER_NOTICE: "true", STAGE_COARSE_REVERSE: "true", CONTACT_CARD_NEEDS_OWNER: "true", CONTACT_OWNER_HUBSPOT_ONLY: "true",
  ITEM_NAME_FIT: "true", CREATE_WINDOW_REPLAY: "false", STALE_FORWARD_GATE: "true", STALE_FORWARD_RETRY: "true",
};

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
afterEach((c) => { W_.debugDump(c.task.name); Object.assign(uiActorTiming, timing); vi.useRealTimers(); });

/** Wait until a pass started inside a webhook's waitUntil reaches a hold. */
async function reachIn(g: { reached: Promise<void> }, waits: Promise<unknown>[], what: string): Promise<void> {
  await Promise.race([g.reached, Promise.allSettled(waits).then(() => { throw new Error(`${what} was never reached`); })]);
}
/** A HubSpot webhook batch through the real handleHubspot (same module instance = same isolate). */
async function postHubspot(events: Record<string, unknown>[], pass: string): Promise<Promise<unknown>[]> {
  const waits: Promise<unknown>[] = [];
  const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
  await handleHubspot(new Request("https://w/webhooks/hubspot", { method: "POST", body: JSON.stringify(events) }), as(pass), ectx);
  return waits;
}
const propertyChange = (prop: string, at: string, src: string, id = 382447) => ({ subscriptionType: "object.propertyChange",
  objectTypeId: "0-1", objectId: id, propertyName: prop, occurredAt: Date.parse(at), changeSource: src });

// ===================================================================================================================
describe("[F1] an adopted card's form values are the form's: never pushed, rescued, re-sent or claimed on", () => {
  /** An existing HubSpot contact (opportunity, Head of IT), and a brand-new monday card a rep is filling. */
  function adoptionWorld(owned: boolean) {
    setWorld(makeWorld(contactsSpec(), { hsId: "555001", itemId: "2860000001", created: "2026-05-01T00:00:00.000Z",
      synced: "2026-09-30T00:00:00.000Z", props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com",
        lifecyclestage: "opportunity", jobtitle: "Head of IT" }, typed: TYPED_LIVE }));
    if (!owned) { w().hs.properties.sync_owner = ""; delete w().hs.history.sync_owner; }
    for (const c of w().card.column_values)
      if ([w().spec.idCol, w().spec.syncStateCol, LIFE, JOB, EMAIL].includes(c.id)) { c.text = ""; if ("status_index" in c) c.status_index = null; }
    delete w().changedAt[LIFE];
    clock(T("09:00:00"));
    w().card.created_at = now(); w().card.updated_at = now();
    hubspot.searchContactByEmail.mockResolvedValue({ id: "555001", modified: "2026-09-30T00:00:00.000Z" });
    hubspot.claimOwnership.mockImplementation(async () => { w().trail.push("CLAIM ATTEMPTED"); w().hs.properties.sync_owner = "crm";
      return "2026-10-09T09:03:29.000Z"; });
    w().mods.push(T("09:03:30"), T("09:03:31"), T("09:03:32"), T("09:03:33"));
  }
  /** The rep fills Lifecycle (09:00:05) and Job Title (09:00:10) -- "needs email" -- then the email (09:00:20), which adopts. */
  async function fill() {
    for (const [hms, c, v] of [["09:00:05", LIFE, "1.NEW"], ["09:00:10", JOB, "Buyer"], ["09:00:20", EMAIL, "pat@example.com"]] as const) {
      clock(T(hms));
      const prev = eventValue(c); rep(c, v);
      await settleAll(await mondayWebhook(`HOOK-${c}`, c, prev, REP));
    }
    expect(cell(w().spec.idCol), trail()).toBe("555001");
  }
  const converged = () => {
    expect(pushes(), "an adoption never pushes the form's values\n" + trail()).toEqual([]);
    expect(hubspot.claimOwnership, "adoption never claims").not.toHaveBeenCalled();
    expect(logged(/action=rescued/)).toBe(false);
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    expect(cell(JOB)).toBe("Head of IT");
  };

  it.each([["a CRM-owned record", true], ["an unstamped historical record", false]])(
    "%s: the converge at +W writes HubSpot's values over the form's (the log's rows predate the link)", async (_n, owned) => {
      adoptionWorld(owned); setEnv(LIVE);
      await fill();
      expect((await watchState())?.linkedAt, "the link time is recorded with the converge-all").toBeGreaterThanOrEqual(Date.parse(T("09:00:20")));
      await advance(T("09:03:40"));
      await advance(T("09:10:00"));
      converged();
    });

  it("a mark of an edit made before the link, whose run died, is given up at its lease -- never re-sent as the rep's", async () => {
    adoptionWorld(true); setEnv(LIVE);
    clock(T("09:00:05")); rep(LIFE, "1.NEW");
    // Its webhook's run died before it resolved: only its mark is left (as the webhook makes it).
    await W_.namespace.get(W_.watchKey()).markEdits(Date.now(), { boardId: w().spec.boardId, itemId: w().card.id, object: "contacts" },
      [{ key: LIFE, at: Date.now(), rx: Date.now(), actor: REP }]);
    clock(T("09:00:20"));
    const prev = eventValue(EMAIL); rep(EMAIL, "pat@example.com");
    await settleAll(await mondayWebhook("HOOK-EMAIL", EMAIL, prev, REP));
    expect(cell(w().spec.idCol)).toBe("555001");
    await advance(T("09:01:10"));                                       // its lease: a retry would be due now
    await advance(T("09:10:00"));
    expect(logged(/col=color_mm70k2wk action=edit-retry-abandoned/), trail()).toBe(true);
    expect(logged(/action=edit-retried/)).toBe(false);
    converged();
  });

  it("...and when the watch could not record the link, the id cell's own write in monday's log dates it", async () => {
    adoptionWorld(true); setEnv(LIVE);
    const once = vi.spyOn(CreateIdempotency.prototype, "watchCells").mockRejectedValueOnce(new Error("DO unreachable"));
    try { await fill(); } finally { once.mockRestore(); }
    expect((await watchState())?.allAt, "the adoption could not register its converge-all").toBeUndefined();
    note(T("09:00:30"), T("09:00:32"));                                 // a Note: HubSpot is newer, the form's cells are held
    clock(T("09:00:33"));
    await hubspotPass("NOTE", { notes_last_updated: [T("09:00:32"), false] });
    expect(cell(LIFE)).toBe("1.NEW");
    await advance(T("09:03:40"));
    await advance(T("09:10:00"));
    converged();
  });
});

// ===================================================================================================================
describe("[F2] a retried People removal carries what it removed: HubSpot's real owner is never cleared", () => {
  const MYLA = { owner: "888", seat: "998" }, ELAINE = { owner: "777", seat: "999" };
  const owners = () => {
    w().ctxOwners = { [ELAINE.owner]: { name: "Elaine", email: "elaine@example.com" }, [MYLA.owner]: { name: "Myla", email: "myla@example.com" } };
    w().mondayUsers = { "elaine@example.com": ELAINE.seat, "myla@example.com": MYLA.seat };
    const c = w().card.column_values.find(x => x.id === SALES)!;
    c.persons_and_teams = [{ id: MYLA.seat, kind: "person" }]; c.text = MYLA.seat;
    w().changedAt[SALES] = Date.parse(S0);
  };
  const elaineKept = () => {
    expect(pushes(), trail()).toEqual([]);
    expect(w().hs.properties.sales_user).toBe(ELAINE.owner);
    expect(people(SALES), "refused, and healed to HubSpot's owner").toEqual([ELAINE.seat]);
  };

  it("route A: HubSpot reassigned Myla -> Elaine; 10 s later a rep removes the still-shown Myla and the run dies", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { sales_user: MYLA.owner } }); owners();
    clock(T("09:00:00")); hubspotSets("sales_user", ELAINE.owner, T("09:00:00"));
    clock(T("09:00:10"));
    const prev = eventValue(SALES); repPeople(SALES, []);
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", SALES, prev, REP));
    w().failGetRecord = undefined;
    expect((await watchState())?.marks[SALES]?.people, "the mark carries the removal").toEqual({ ids: [MYLA.seat], known: true });
    clock(T("09:00:12"));
    await hubspotPass("HS-OWNER", { sales_user: [T("09:00:00"), false] });
    w().mods.push(T("09:01:15"));
    await advance(T("09:01:11"));
    await advance(T("09:06:00"));
    expect(logged(/action=edit-retried/)).toBe(true);
    elaineKept();
  });

  it("route B: the live run refused the stale removal, but its heal write was refused (rate limit): the retry refuses too", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact(); owners();
    w().hs.properties.sales_user = ELAINE.owner;
    w().hs.history.sales_user = [{ value: MYLA.owner, timestamp: "2026-07-18T12:40:00.000Z", sourceType: "CRM_UI" },
      { value: ELAINE.owner, timestamp: "2026-09-23T05:01:00.000Z", sourceType: "CRM_UI" }];
    clock(T("09:00:00"));
    const prev = eventValue(SALES); repPeople(SALES, []);
    w().rateLimitWrite = "HOOK";
    await settleAll(await mondayWebhook("HOOK", SALES, prev, REP));
    w().rateLimitWrite = undefined;
    expect(logged(/action=refused reason="sales_user: the person removed is not HubSpot's current owner/)).toBe(true);
    expect((await watchState())?.marks[SALES]).toBeDefined();
    w().mods.push(T("09:01:02"));
    await advance(T("09:01:01"));
    await advance(T("09:06:00"));
    elaineKept();
  });

  it("route C: an ask-ada UI removal misread as our echo is never rescued as a clear (the log row's removal says Myla)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact(); owners();
    w().hs.properties.sales_user = ELAINE.owner;
    w().hs.history.sales_user = [{ value: MYLA.owner, timestamp: "2026-07-18T12:40:00.000Z", sourceType: "CRM_UI" },
      { value: ELAINE.owner, timestamp: "2026-09-23T05:01:00.000Z", sourceType: "CRM_UI" }];
    clock(T("09:00:00"));
    repPeople(SALES, [], { userId: ASK_ADA });
    await mondayEdit("SELF", [SALES], { selfOrigin: true });
    w().mods.push(T("09:03:20"));
    await advance(T("09:03:10"));
    await advance(T("09:08:00"));
    expect(logged(/action=rescued/)).toBe(false);
    elaineKept();
  });

  it("control: a retried removal of HubSpot's OWN owner (the cell showed Elaine) still clears it", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { sales_user: ELAINE.owner } }); owners();
    const c = w().card.column_values.find(x => x.id === SALES)!;
    c.persons_and_teams = [{ id: ELAINE.seat, kind: "person" }]; c.text = ELAINE.seat;
    clock(T("09:00:00"));
    const prev = eventValue(SALES); repPeople(SALES, []);
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", SALES, prev, REP));
    w().failGetRecord = undefined;
    w().mods.push(T("09:01:02"));
    await advance(T("09:01:01"));
    expect(pushes(), trail()).toEqual([{ sales_user: "" }]);
  });
});

// ===================================================================================================================
describe("[F3][F7] the loop breaker leaves alone only what OUR write became on monday", () => {
  it.each([["typed (Lifecycle)", LIFE, "6.Not in contact/Pending further contact", "5.No intention", "1.NEW"],
    ["untyped (Job Title)", JOB, "Buyer", "Director", "Engineer"]])(
    "[F7] %s: a second never-pushed value of the same cell within the day is converged again, not left", async (_n, col, v1, v2, hs) => {
      contact({ extra: { jobtitle: "Engineer" } });
      clock(T("09:00:00")); rep(col, v1, { userId: ASK_ADA });
      await mondayEdit("SELF", [col], { selfOrigin: true });             // misread as our echo: watched, never pushed
      await advance(T("09:03:10"));
      expect(cell(col)).toBe(hs);
      clock(T("09:10:00")); rep(col, v2, { userId: ASK_ADA });
      await mondayEdit("SELF-2", [col], { selfOrigin: true });
      await advance(T("09:13:10"));
      expect(cell(col), trail()).toBe(hs);
      expect(logged(/action=converge-stuck/)).toBe(false);
      expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
      expect(pushes()).toEqual([]);
    });

  it("[F3] HubSpot's later change (its webhook lost) is never buried by the memory of an earlier converge of the same value", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ typed: TYPED_LIVE });
    clock(T("08:30:00")); rep(LIFE, "7.Intention to purchase");
    w().mods.push(T("08:30:02"));
    await mondayEdit("EDIT-0", [LIFE]);
    hubspotSets("lifecyclestage", "lead", T("09:00:00"));                // a HubSpot user; its pass's write is rate-limited
    clock(T("09:00:01")); w().rateLimitWrite = "HS-1";
    await hubspotPass("HS-1", { lifecyclestage: [T("09:00:00"), false] }).catch(() => undefined);
    await advance(T("09:00:10"));                                        // the watch converges it: 1.NEW
    expect(cell(LIFE)).toBe("1.NEW");
    clock(T("10:00:00")); rep(LIFE, "7.Intention to purchase");
    w().mods.push(T("10:00:02"));
    await mondayEdit("EDIT", [LIFE]);
    clock(T("11:00:00")); hubspotSets("lifecyclestage", "lead", T("11:00:00"));   // its webhook never reaches a pass
    note(T("11:00:01"), T("11:00:02"));
    clock(T("11:00:03"));
    await hubspotPass("NOTE", { notes_last_updated: [T("11:00:02"), false] });
    await advance(T("11:05:00"));
    await advance(T("11:30:00"));
    expect(cell(LIFE), trail()).toBe("1.NEW");
    expect(w().hs.properties.lifecyclestage).toBe("lead");
    expect(logged(/action=converge-stuck/)).toBe(false);
  });

  it("[F7] a value monday renders differently is left alone for a day -- then converged again once (never simply forgotten)", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock(T("09:00:00")); rep(JOB, "Buyer");
    const real = monday.updateColumns.getMockImplementation()!;
    monday.updateColumns.mockImplementation(async (env: unknown, b: string, i: string, cv: Record<string, unknown>, ...rest: unknown[]) =>
      real(env, b, i, cv[JOB] === "Engineer" ? { ...cv, [JOB]: "ENGINEER" } : cv, ...rest));
    await mondayEdit("SELF", [JOB], { selfOrigin: true });
    await advance(T("09:03:10"));
    expect(cell(JOB)).toBe("ENGINEER");
    expect((await watchState())?.fwd?.[JOB], "the write did not take as sent: remembered as monday shows it")
      .toMatchObject({ hs: "Engineer", fp: "ENGINEER" });
    await mondayEdit("SELF-2", [JOB], { selfOrigin: true });
    await advance(T("09:07:00"));
    expect((await watchState())?.cells[JOB]?.stuckUntil).toBeDefined();
    const writes = monday.updateColumns.mock.calls.length;
    await advance("2026-10-10T09:00:00.000Z");
    expect(monday.updateColumns.mock.calls.length, "nothing for the rest of the day").toBe(writes);
    await advance(new Date(Date.parse(T("09:03:10")) + STUCK_MS + 60_000).toISOString());
    expect(monday.updateColumns.mock.calls.length, "its day over: judged again, written once more").toBe(writes + 1);
  });
});

// ===================================================================================================================
describe("[F4] the monday-born create fill never writes over a pick made during the create", () => {
  const DICTS = crmStageDictsOf(PIPELINES as never);
  const COARSE = "deal_stage", EXACT = "dropdown_mm7624zd", PIPE = "dropdown_mm76s7kk", AMOUNT = "deal_value";
  const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };
  function bornDeal() {
    const spec = dealsSpec();
    clock(T("09:00:00"));
    const ww = setWorld(makeWorld(spec, { hsId: "", itemId: "5552", created: now(), synced: "", group: "topics", labels: LABELS, props: {} }));
    ww.card.name = "New deal";
    ww.card.column_values.find(c => c.id === spec.idCol)!.text = "";
    ww.card.column_values.find(c => c.id === spec.syncStateCol)!.text = "";
    rep(COARSE, "New", { userId: "-4", uuid: false });
    rep(AMOUNT, "500");
    hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
    hubspot.createRecord.mockImplementation(async (_e: unknown, _s: unknown, props: Record<string, string>) => {
      const at = T("09:00:01");
      w().hs = { id: "9002", properties: { ...props, hs_object_id: "9002", createdate: at, hs_lastmodifieddate: at,
        hs_v2_date_entered_current_stage: at, sync_owner: "crm" }, history: {} };
      for (const [p, v] of Object.entries(props)) w().hs.history[p] = [{ value: v, timestamp: at, sourceType: "INTEGRATION", sourceId: W_.OWN }];
      return { id: "9002", modified: at };
    });
    return spec;
  }

  it("Deals: a HubSpot Stage picked while the create's write-back is in flight stays on the card and reaches HubSpot", async () => {
    setEnv({ STAGE_COARSE_REVERSE: "true", ASK_ADA_UI_EDITS: "true", CREATE_WINDOW_REPLAY: "false" });
    const spec = bornDeal();
    const [pickId, pickLabel] = ["contractsent", DICTS.stages.contractsent];
    const atWriteBack = hold("CREATE", "write");
    clock(T("09:00:01.500"));
    const create = syncMondayItem(as("CREATE"), spec.boardId, w().card.id, live, { left: 30 }, false, false, { cols: [AMOUNT] },
      { id: REP, byAutomation: false });
    await reach(atWriteBack, create, "the create's id write-back");
    clock(T("09:00:02"));
    const prev = eventValue(EXACT); rep(EXACT, pickLabel);               // the rep picks a stage right away
    atWriteBack.release();
    await create;
    expect(cell(EXACT), "the fill left the pick alone\n" + trail()).toBe(pickLabel);
    expect(cell(PIPE), "...and still filled what nobody changed").toBe(DICTS.pipelines.default);
    expect(logged(/cols=dropdown_mm7624zd.*action=create-fill-skipped/)).toBe(true);
    expect((await watchState())?.linkedAt, "linked as of the create's read: the pick, made after it, is an edit")
      .toBe(Date.parse(T("09:00:01.500")));
    clock(T("09:00:03"));
    w().mods.push(T("09:00:04"), T("09:00:05"));
    await settleAll(await mondayWebhook("HOOK", EXACT, prev, REP));
    hubspotSets("hs_deal_stage_probability", "0.2", T("09:00:04.500"), "CALCULATED");
    clock(T("09:00:08"));
    await hubspotPass("CREATION");
    await advance(T("09:05:00"));
    expect(w().hs.properties.dealstage, trail()).toBe(pickId);
    expect(cell(EXACT)).toBe(pickLabel);
  });

  it("Contacts: a Last Name typed during the create is not replaced by the create's split", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true", CREATE_WINDOW_REPLAY: "false" });
    const spec = contactsSpec();
    clock(T("09:00:00"));
    const ww = setWorld(makeWorld(spec, { hsId: "", itemId: "7771", created: now(), synced: "", props: {} }));
    ww.card.name = "John Smith";
    for (const c of ww.card.column_values) c.text = "";
    rep(EMAIL, "john@example.com");
    hubspot.searchContactByEmail.mockResolvedValue(null);
    hubspot.createRecord.mockImplementation(async (_e: unknown, _s: unknown, props: Record<string, string>) => {
      const at = T("09:00:01");
      w().hs = { id: "8002", properties: { ...props, hs_object_id: "8002", createdate: at, lastmodifieddate: at, sync_owner: "crm" }, history: {} };
      for (const [p, v] of Object.entries(props)) w().hs.history[p] = [{ value: v, timestamp: at, sourceType: "INTEGRATION", sourceId: W_.OWN }];
      return { id: "8002", modified: at };
    });
    const atWriteBack = hold("CREATE", "write");
    clock(T("09:00:01"));
    const create = syncMondayItem(as("CREATE"), spec.boardId, w().card.id, live, { left: 30 }, false, false, { cols: [EMAIL] },
      { id: REP, byAutomation: false });
    await reach(atWriteBack, create, "the create's id write-back");
    clock(T("09:00:02"));
    const prev = eventValue(LAST); rep(LAST, "Smith-Jones");
    atWriteBack.release();
    await create;
    expect(hubspot.createRecord.mock.calls[0][2].lastname, "the create split the name").toBe("Smith");
    expect(cell(LAST), trail()).toBe("Smith-Jones");
    clock(T("09:00:03"));
    w().mods.push(T("09:00:04"), T("09:00:05"));
    await settleAll(await mondayWebhook("HOOK", LAST, prev, REP));
    await advance(T("09:05:00"));
    expect(w().hs.properties.lastname, "the person's Last Name reaches HubSpot").toBe("Smith-Jones");
    expect(cell(LAST)).toBe("Smith-Jones");
  });
});

// ===================================================================================================================
describe("[F5] a coarse Stage cell left by an expired mark converges at most once (HEAD's timing), never in a loop", () => {
  const DICTS = crmStageDictsOf(PIPELINES as never);
  const COARSE = "deal_stage";
  const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };
  const converges = () => count(/\[converge\] .*action=converged/);
  /** Production-shaped time: 1 s ticks; the watch's alarm fires when due; DEFERRED_SYNC runs FIRST_DELAY after a spill,
   *  then every WAVE_GAP while it has work. */
  async function runFor(ms: number) {
    const start = Date.now();
    let deferredAt: number | null = null;
    for (let t = start + 1000; t <= start + ms; t += 1000) {
      clock(new Date(t).toISOString());
      await fireWatch();
      if (spilled.length && deferredAt === null) deferredAt = t + FIRST_DELAY_MS;
      if (deferredAt !== null && t >= deferredAt) { await drain(); deferredAt = spilled.length ? t + WAVE_GAP_MS : null; }
    }
  }
  async function wonAndRunDies(retry: string) {
    setEnv({ STAGE_COARSE_REVERSE: "true", STALE_FORWARD_RETRY: retry });
    hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
    setWorld(makeWorld(dealsSpec(), { hsId: "9001", itemId: "5551", created: "2026-09-01T00:00:00.000Z", synced: "2026-09-29T02:00:00.000Z",
      group: "topics", labels: LABELS, typed: TYPED_LIVE, props: { dealname: "Acme renewal", dealstage: "contractsent",
        pipeline: DICTS.pipelineByStage.contractsent, amount: "1000", hs_v2_date_entered_current_stage: "2026-09-01T00:00:00.000Z" } }));
    clock(T("09:00:00"));
    const prev = eventValue(COARSE); rep(COARSE, "Won");
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", COARSE, prev, REP));
    if (retry === "true") w().failGetRecord = "QUEUE"; else w().failGetRecord = undefined;
    expect((await watchState())?.marks[COARSE]).toBeDefined();
  }

  it.each([["off (the mark's lease ends)", "false"], ["on, every retry dies (the mark is given up)", "true"]])(
    "STALE_FORWARD_RETRY %s: one converge at most, then the watch is idle; the card keeps HEAD's timing", async (_n, retry) => {
      await wonAndRunDies(retry);
      await runFor(20 * 60_000);
      expect(converges(), trail()).toBeLessThanOrEqual(2);
      expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
      const alarm = watchAlarmAt();
      expect(alarm === null || alarm > Date.now() + 23 * 60 * 60_000, "nothing to wake for but its memory's cleanup").toBe(true);
      expect(cell(COARSE), "left until HubSpot is newer, as HEAD leaves it").toBe("Won");
      expect(pushes()).toEqual([]);
    });
});

// ===================================================================================================================
describe("[F6] a retry superseded by HubSpot's later change: card and HubSpot end on the later change", () => {
  async function diedEdit() {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00"));
    const prev = eventValue(JOB); rep(JOB, "Buyer");
    w().failGetRecord = "HOOK";                                          // the rep's run dies at its HubSpot read
    await settleAll(await mondayWebhook("HOOK", JOB, prev, REP));
    w().failGetRecord = undefined;
    expect((await watchState())?.marks[JOB]).toBeDefined();
    hubspotSets("jobtitle", "Director", T("09:00:10"));                  // a HubSpot user, 10 s AFTER the edit
  }

  it("its webhook delivered: the change's own pass forwards it at once -- the edit's mark is older than the change", async () => {
    await diedEdit();
    clock(T("09:00:11"));
    await hubspotPass("HS-USER", { jobtitle: [T("09:00:10"), false] });
    expect(cell(JOB), trail()).toBe("Director");
    await advance(T("09:01:01"));
    await advance(T("09:10:00"));
    expect(pushes()).toEqual([]);
    expect(cell(JOB)).toBe("Director");
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("its webhook lost: the superseded retry hands the cell to the watch, which converges it (never rescued again)", async () => {
    await diedEdit();
    await advance(T("09:01:01"));                                       // the lease: the retry finds the later change
    expect(logged(/action=edit-retry-superseded/)).toBe(true);
    expect((await watchState())?.cells[JOB], "due for a converge, not merely cleared").toMatchObject({ fp: "Buyer" });
    await advance(T("09:10:00"));
    expect(cell(JOB), trail()).toBe("Director");
    expect(pushes()).toEqual([]);
    expect(logged(/action=rescued/)).toBe(false);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("a forward a live mark DOES veto (the edit is newer than HubSpot's news) stays watched as a hold, so it still converges", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    hubspotSets("jobtitle", "Manager", T("08:59:00"));
    clock(T("08:59:30"));
    await hubspotPass("HS-USER", { jobtitle: [T("08:59:00"), false] });
    expect(cell(JOB)).toBe("Manager");
    clock(T("09:00:00"));
    const prev = eventValue(JOB); rep(JOB, "Engineer");                 // typed back: HubSpot held it before
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", JOB, prev, REP);
    await reachIn(atHs, waits, "the run's HubSpot read");
    clock(T("09:00:05"));
    await hubspotPass("DUP", { jobtitle: [T("08:59:00"), false] });     // a late duplicate of HubSpot's older change
    expect(cell(JOB), trail()).toBe("Engineer");
    expect((await watchState())?.cells[JOB], "vetoed by the mark: held, still watched").toMatchObject({ fp: "Engineer", typed: false });
    w().mods.push(T("09:00:08"));
    atHs.release(); await settleAll(waits);
    expect(w().hs.properties.jobtitle).toBe("Engineer");
  });
});

// ===================================================================================================================
describe("[F8] a failed pass's scope is never read by the record's next, unrelated pass", () => {
  it("a pass that throws with no re-run pending drops its scope: a later Note's pass does not name the old change", async () => {
    setEnv({ ASK_ADA_UI_EDITS: "true" });
    Object.assign(uiActorTiming, { attemptTimeoutMs: 60_000 });          // the classification below is held on purpose
    contact({ extra: { jobtitle: "Engineer" } });
    hubspotSets("jobtitle", "Manager", T("09:00:00"));                  // a HubSpot user
    clock(T("09:00:01"));
    w().rateLimitWrite = "HS-1";                                         // its pass's write is refused: the pass throws
    await settleAll(await postHubspot([propertyChange("jobtitle", T("09:00:00"), "CRM_UI")], "HS-1"));
    expect(logged(/source=hubspot contact=382447 action=error/), "no trailing run: the error surfaces").toBe(true);
    clock(T("09:00:10"));
    expect(await fireWatch()).toBe(true);
    await drain("CONVERGE");                                             // the watch converges it on its own
    expect(cell(JOB)).toBe("Manager");
    // Two minutes later (inside 2 x W): a person working as ask ada sets Job Title back to "Engineer"; their edit's
    // classification (the activity log) is still pending, so it is not marked yet...
    clock(T("09:02:00"));
    const prev = eventValue(JOB); rep(JOB, "Engineer", { userId: ASK_ADA, uuid: true });
    w().mods.push(T("09:02:20"));
    const logGate = hold("EDIT", "log");
    const mondayWaits = await mondayWebhook("EDIT", JOB, prev, ASK_ADA);
    await reachIn(logGate, mondayWaits, "the classification's log read");
    // ...and they log a Note, whose webhook reaches this same isolate.
    note(T("09:02:01"), T("09:02:02"));
    clock(T("09:02:03"));
    await settleAll(await postHubspot([propertyChange("notes_last_updated", T("09:02:02"), "CALCULATED")], "NOTE"));
    expect(cell(JOB), "the Note's pass names only the Note\n" + trail()).toBe("Engineer");
    clock(T("09:02:08"));
    logGate.release(); await settleAll(mondayWaits);
    expect(w().hs.properties.jobtitle, "the person's edit reaches HubSpot").toBe("Engineer");
    expect(cell(JOB)).toBe("Engineer");
  });
});

// ===================================================================================================================
describe("[F9] the Sync State register keeps every stamp longer than any write can take", () => {
  it.each([["61 s", 61_000], ["five minutes", 5 * 60_000]])("an older stamp landing %s after a newer one is caught and restored", async (_n, late) => {
    contact();
    const L1 = T("08:21:26.732"), N1 = T("08:21:32.807");
    note(T("08:21:20.172"), L1);
    clock(T("08:21:26.900"));
    const atWrite = hold("NOTE", "write");
    const run = hubspotPass("NOTE", { notes_last_updated: [L1, false] });
    await reach(atWrite, run, "the Note pass's monday write");           // HEAD's write: it may wait on the rate limit
    const editAt = Date.parse(T("08:21:27.004"));
    clock(new Date(editAt).toISOString()); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    await mondayEdit("EDIT", [LIFE]);
    expect(syncState()).toBe(N1);
    clock(new Date(editAt + late).toISOString());
    atWrite.release(); await run;                                         // the older stamp lands last
    expect(syncState(), "overtaken (monday has no compare-and-set)").toBe(L1);
    expect(logged(/action=verify-queued/), trail()).toBe(true);
    clock(new Date(editAt + late + 2_000).toISOString());
    expect(await fireWatch()).toBe(true);
    expect(syncState(), trail()).toBe(N1);
    expect(cell(LIFE)).toBe("5.No intention");
  });
});

// ===================================================================================================================
describe("[F10] a dry run (/resync dryRun) leaves nothing durable behind", () => {
  /** A Lifecycle a person set long ago that HubSpot never received, under a Sync State equal to HubSpot's modified time. */
  function drift() {
    clock("2026-07-18T12:40:00.000Z");
    contact();
    clock("2026-10-01T03:00:00.000Z"); rep(LIFE, "5.No intention");
    clock(T("08:00:00"));
  }

  it("nothing in play (HubSpot not newer): no watch, no alarm -- and nothing written later", async () => {
    drift();
    await syncHubspotRecord(as("RESYNC"), w().spec, w().hs.id, dry, { left: 30 });
    expect(await watchState(), "nothing registered").toBeUndefined();
    expect(watchAlarmAt()).toBeNull();
    await advance(T("08:30:00"));
    expect(cell(LIFE)).toBe("5.No intention");
  });

  it("HubSpot newer (a dropped webhook): the dry run answers, but registers nothing -- the cell is not written later", async () => {
    drift();
    hubspotSets("notes_last_updated", "2026-10-08T09:00:00.000Z", "2026-10-08T09:00:05.000Z", "CALCULATED");
    await syncHubspotRecord(as("RESYNC"), w().spec, w().hs.id, dry, { left: 30 });
    expect(await watchState()).toBeUndefined();
    await advance(T("08:30:00"));
    expect(cell(LIFE)).toBe("5.No intention");
    expect(cell(field(w().spec, "notes_last_updated").col), "the one-way column it only sized is not written either").toBe("");
    expect(syncState(), "nothing was stamped, then or later").toBe(S0);
  });

  it("a dry run's stamp (never written) is never noted: the register cannot 'restore' it later", async () => {
    contact();
    hubspotSets("notes_last_updated", T("07:59:00"), T("07:59:05"), "CALCULATED");
    const stampRpc = vi.spyOn(CreateIdempotency.prototype, "noteStamp");
    try {
      await syncHubspotRecord(as("RESYNC"), w().spec, w().hs.id, dry, { left: 30 });
      expect(stampRpc, "a stamp never written is never noted").not.toHaveBeenCalled();
    } finally { stampRpc.mockRestore(); }
    expect(syncState()).toBe(S0);
  });
});

// ===================================================================================================================
describe("[F11] 31010016's New on a HubSpot-born Won deal: corrected once its hold ends, as HEAD corrects it", () => {
  const DICTS = crmStageDictsOf(PIPELINES as never);
  const COARSE = "deal_stage", AMOUNT = "deal_value", PROB = "deal_close_probability";
  const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };
  const wonWrites = () => w().trail.filter(l => !/ REP /.test(l) && l.includes(` ${COARSE}: `) && l.endsWith(`-> "Won"`)).length;
  /** The Worker made the card at 09:00:00 from a read at 08:59:59; the board's automation sets New at 09:00:02. */
  function born() {
    setEnv({ STAGE_COARSE_REVERSE: "true" });
    hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
    clock(T("09:00:00"));
    setWorld(makeWorld(dealsSpec(), { hsId: "9001", itemId: "5551", created: "2026-10-09T08:59:59.000Z", synced: "2026-10-09T08:59:59.000Z",
      group: "topics", labels: LABELS, props: { dealname: "Renewal", dealstage: "closedwon", pipeline: DICTS.pipelineByStage.closedwon,
        amount: "1000", hs_v2_date_entered_current_stage: "2026-10-09T08:59:59.000Z" } }));
    expect(cell(COARSE)).toBe("Won");
    clock(T("09:00:02")); rep(COARSE, "New", { userId: "-4", uuid: false });
  }

  it("the creation burst inside W holds it; its hold ending writes Won once -- with no further HubSpot event", async () => {
    born();
    hubspotSets("hs_deal_stage_probability", "1", T("09:00:05"), "CALCULATED");
    clock(T("09:00:09"));
    await hubspotPass("PROB", { hs_deal_stage_probability: [T("09:00:05"), false] });
    clock(T("09:00:12"));
    await hubspotPass("ASSOC", {});
    expect(cell(COARSE), "held inside W").toBe("New");
    expect(cell(PROB)).toBe("100");
    await advance(T("10:00:00"));
    expect(cell(COARSE), trail()).toBe("Won");
    expect(wonWrites()).toBe(1);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("...and a person's Amount edit stamping past HubSpot's newer time meanwhile does not bury it", async () => {
    born();
    hubspotBumps(T("09:00:05"));
    clock(T("09:00:08"));
    await hubspotPass("ASSOC", {});
    expect(cell(COARSE)).toBe("New");
    clock(T("09:01:00")); rep(AMOUNT, "2000");
    w().mods.push(T("09:01:01"));
    await mondayEdit("EDIT-AMOUNT", [AMOUNT]);
    expect(syncState(), "the push stamps its own time, past HubSpot's").toBe(T("09:01:01"));
    await advance(T("10:00:00"));
    expect(cell(COARSE), trail()).toBe("Won");
    expect(wonWrites()).toBe(1);
    expect(w().hs.properties.amount).toBe("2000");
  });

  it("...and when the Amount edit is the first pass to see HubSpot newer, it hands the coarse Stage over as such", async () => {
    born();
    hubspotBumps(T("09:00:05"));                                          // HubSpot's recalculation; no pass has run yet
    clock(T("09:00:30")); rep(AMOUNT, "2000");
    w().mods.push(T("09:00:31"));
    await mondayEdit("EDIT-AMOUNT", [AMOUNT]);
    expect(cell(COARSE)).toBe("New");
    expect((await watchState())?.cells[COARSE], "left by the edit, seen while HubSpot was newer").toMatchObject({ newer: true });
    await advance(T("10:00:00"));
    expect(cell(COARSE), trail()).toBe("Won");
    expect(wonWrites()).toBe(1);
  });

  it("HubSpot never newer than Sync State (its recalculation before the card's read): left, as HEAD leaves it", async () => {
    setEnv({ STAGE_COARSE_REVERSE: "true" });
    hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
    clock(T("09:00:00"));
    setWorld(makeWorld(dealsSpec(), { hsId: "9001", itemId: "5551", created: "2026-10-09T08:59:55.000Z", synced: "2026-10-09T08:59:59.000Z",
      group: "topics", labels: LABELS, props: { dealname: "Renewal", dealstage: "closedwon", pipeline: DICTS.pipelineByStage.closedwon,
        amount: "1000", hs_v2_date_entered_current_stage: "2026-10-09T08:59:55.000Z" } }));
    clock(T("09:00:02")); rep(COARSE, "New", { userId: "-4", uuid: false });
    clock(T("09:00:08"));
    await hubspotPass("ASSOC", {});
    await advance(T("10:00:00"));
    expect(cell(COARSE)).toBe("New");
    expect(wonWrites()).toBe(0);
  });
});

// ===================================================================================================================
describe("[M2] the register's own restamp is recorded like any stamp", () => {
  it("a newer stamp written while the restamp was in flight is restored over it in turn; the restamp never waits on the rate limit", async () => {
    contact();
    const LEAD = field(w().spec, "hs_lead_status").col;
    clock(T("08:21:27.000"));
    rep(LIFE, "5.No intention"); rep(LEAD, "In Progress");
    w().mods.push(T("08:21:32.807"));
    const atWrite = hold("EDIT-LIFE", "write");
    const a = mondayEdit("EDIT-LIFE", [LIFE]);
    await reach(atWrite, a, "the Lifecycle pass's monday write");
    w().mods.push(T("08:21:33.500"));
    clock(T("08:21:33.600"));
    await mondayEdit("EDIT-LEAD", [LEAD]);                                 // pushed later, stamped first
    clock(T("08:21:34"));
    atWrite.release(); await a;                                           // the older stamp lands last
    expect(syncState()).toBe(T("08:21:32.807"));
    // The read-back finds it overtaken and restamps 08:21:33.5 -- while a third push stamps a newer one.
    clock(T("08:21:35.600"));
    const atRestamp = hold("ALARM", "write");
    const fired = fireWatch();
    await reach(atRestamp, fired, "the restamp's write");
    rep(LIFE, "7.Intention to purchase");
    w().mods.push(T("08:21:36"));
    await mondayEdit("EDIT-LIFE-2", [LIFE]);
    expect(syncState()).toBe(T("08:21:36"));
    atRestamp.release(); await fired;
    expect(syncState(), "the restamp overtook the newest stamp").toBe(T("08:21:33.500"));
    const restamp = monday.setColumns.mock.calls.find(c => W_.PASS(c[0]) === "ALARM")!;
    expect(restamp[5], "never waits on monday's rate limit").toBe(0);
    clock(T("08:21:38"));
    expect(await fireWatch(), "the restamp itself was noted, and found overtaking").toBe(true);
    expect(syncState(), trail()).toBe(T("08:21:36"));
  });
});
