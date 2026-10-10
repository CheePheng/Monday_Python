import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";

/**
 * STALE_FORWARD_GATE THROUGH THE REAL WEBHOOKS: a person's edit is MARKED from its monday webhook until its run
 * resolves (handleMonday), our own echo runs in its own `:self` queue, a run that died is retried from the card
 * (STALE_FORWARD_RETRY) or converged after its lease, a person's edit misread as our echo is rescued from monday's
 * activity log, relation cells keep a person's pending link, and the HubSpot webhook carries what its events named
 * into the forward pass (handleHubspot). Same world as stale-forward-gate.test.ts; associations are the REAL module.
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
vi.mock("../src/monday", () => monday);
vi.mock("../src/hubspot", async (orig) => ({ ...(await orig<typeof import("../src/hubspot")>()), ...hubspot }));
vi.mock("../src/ensure-card", () => ({ ensureCardForRecord: vi.fn(), cardIdOf: vi.fn() }));

const W_ = await import("./fixtures/stale-forward-world");
const {
  ASK_ADA, REP, makeWorld, setWorld, installWorld, setEnv, as, clock, rep, repLinks, repPeople, repRename, hubspotSets, note,
  cell, people, syncState, hold, reach, hubspotPass, mondayEdit, mondayWebhook, settleAll, eventValue, advance, fireWatch,
  drain, watchState, watchIdle, logged, spilled, watchAlarmAt,
} = W_;
const w = () => W_.w;
const pushes = () => W_.pushes(hubspot as never);
const historyReads = () => W_.historyReads(hubspot as never);
const { specByObject } = await import("../src/config");
const { handleHubspot } = await import("../src/webhooks");
const { uiActorTiming } = await import("../src/ui-actor");
const { resetPairedEchoes } = await import("../src/relation-edit");
const { MARK_LEASE_MS } = await import("../src/card-watch");

const field = (hs: string) => CRM_CONTACTS.fields.find(f => f.hs === hs)!.col;
const LIFE = field("lifecyclestage");
const LEAD = field("hs_lead_status");
const JOB = field("jobtitle");
const SALES = field("sales_user");
const ACCOUNT = "contact_account";
const NO_ACTIVITY = "group_mm7cj2yx";
const ACTIVE = "topics";
const S0 = "2026-07-18T12:46:01.914Z";
const ENVC = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const contact = (extra: Record<string, string> = {}) => setWorld(makeWorld(specByObject(ENVC, "contacts")!, {
  hsId: "382447", itemId: "2856382447", created: "2026-07-18T12:40:00.000Z", synced: S0,
  props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead", ...extra } }));
const trail = () => w().trail.join("\n");
const timing = { ...uiActorTiming };
/** HubSpot's Sales User is Joan (owner 777, monday seat 999); Ann is owner 888 (seat 998); the card shows `seats`. */
const salesUsers = (seats: string[]) => {
  w().hs.properties.sales_user = "777";
  w().hs.history.sales_user = [{ value: "777", timestamp: "2026-07-18T12:40:00.000Z", sourceType: "CRM_UI" }];
  w().ctxOwners = { "777": { name: "Joan", email: "joan@example.com" }, "888": { name: "Ann", email: "ann@example.com" } };
  w().mondayUsers = { "joan@example.com": "999", "ann@example.com": "998" };
  const c = w().card.column_values.find(x => x.id === SALES)!;
  c.persons_and_teams = seats.map(id => ({ id, kind: "person" as const }));
  c.text = seats.join(",");
  w().changedAt[SALES] = Date.parse(S0);
};
/** How many times a log line matching `re` was written. */
const count = (re: RegExp) => W_.lines.filter(l => re.test(l)).length;

/** Wait until a pass started inside a webhook's waitUntil reaches a hold. */
async function reachIn(g: { reached: Promise<void> }, waits: Promise<unknown>[], what: string): Promise<void> {
  await Promise.race([g.reached, Promise.allSettled(waits).then(() => { throw new Error(`${what} was never reached`); })]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock("2026-10-09T09:00:00.000Z");
  vi.clearAllMocks();
  installWorld(monday as never, hubspot as never);
  resetPairedEchoes();
  Object.assign(uiActorTiming, { settleMs: 0, backoffMs: [0, 0] });
});
afterEach((c) => { W_.debugDump(c.task.name); Object.assign(uiActorTiming, timing); vi.useRealTimers(); });

// ===================================================================================================================
describe("marks: a person's edit is protected from its webhook until its run resolves", () => {
  it("a person's edit is marked before it joins its queue, and its run clears the mark", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z");
    const prev = eventValue(LIFE); rep(LIFE, "5.No intention");
    w().mods.push("2026-10-09T09:00:02.000Z");
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", LIFE, prev, REP);
    await reachIn(atHs, waits, "the run's HubSpot read");
    const st = await watchState();
    expect(st?.marks[LIFE]).toMatchObject({ actor: REP, attempts: 0, at: Date.parse("2026-10-09T09:00:00.000Z") });
    expect(st?.marks[LIFE].byAutomation).toBeUndefined();
    atHs.release(); await settleAll(waits);
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
    expect(watchAlarmAt(), "nothing left: no alarm either").toBeNull();
  });

  it("an edit of a column that can never push (not two-way) is not marked", async () => {
    contact();
    const waits = await mondayWebhook("HOOK", "text_not_synced", {}, REP);
    expect((await watchState())?.marks ?? {}).toEqual({});
    await settleAll(waits);
  });

  it("an automation's edit is marked too, as an automation's (it pushes to a record CRM owns, never claims)", async () => {
    contact();
    const prev = eventValue(LIFE); rep(LIFE, "6.Not in contact/Pending further contact", { userId: "-4", uuid: false });
    w().mods.push("2026-10-09T09:00:02.000Z");
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", LIFE, prev, "-4");
    await reachIn(atHs, waits, "the run's HubSpot read");
    expect((await watchState())?.marks[LIFE]).toMatchObject({ actor: "-4", byAutomation: true });
    atHs.release(); await settleAll(waits);
    expect(pushes()).toEqual([{ lifecyclestage: "1029059095" }]);
    expect(await watchIdle()).toBe(true);
  });

  it("our own echo is never marked, and runs in its own :self queue", async () => {
    contact();
    const prev = eventValue(LIFE); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: false });
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", LIFE, prev, ASK_ADA);
    await reachIn(atHs, waits, "the echo's HubSpot read");
    expect((await watchState())?.marks ?? {}).toEqual({});
    const waits2 = await mondayWebhook("HOOK-2", LIFE, prev, ASK_ADA);
    expect(logged(/action=coalesced-rerun key=md:2856382447:color_mm70k2wk:self /)).toBe(true);
    atHs.release(); await settleAll([...waits, ...waits2]);
    expect(pushes()).toEqual([]);
  });

  it("the :self queue: a person's edit arriving while our echo's run holds the cell is pushed as itself", async () => {
    contact();
    clock("2026-10-09T08:21:27.004Z");
    const prevEcho = eventValue(LIFE);
    rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: false });          // our own write of it (an echo)
    w().mods.push("2026-10-09T08:21:30.000Z");
    const slow = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", LIFE, prevEcho, ASK_ADA);
    await reachIn(slow, waits, "the echo's HubSpot read");
    const waits2 = await mondayWebhook("HOOK-2", LIFE, prevEcho, REP);       // a person, on the same cell
    slow.release();
    await settleAll([...waits, ...waits2]);
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(logged(/action=coalesced-rerun key=md:2856382447:color_mm70k2wk /)).toBe(false);
  });

  it("edit #2's mark survives run #1's clear, and the trailing run pushes it", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z");
    const p1 = eventValue(LIFE); rep(LIFE, "5.No intention");
    w().mods.push("2026-10-09T09:00:02.000Z", "2026-10-09T09:00:05.000Z");
    const atPatch = hold("HOOK-1", "patch");
    const waits = await mondayWebhook("HOOK-1", LIFE, p1, REP);
    await reachIn(atPatch, waits, "run #1's PATCH");
    const atCard = hold("HOOK-1", "card");                                    // the trailing run's card read
    clock("2026-10-09T09:00:01.000Z");
    const p2 = eventValue(LIFE); rep(LIFE, "7.Intention to purchase");
    const waits2 = await mondayWebhook("HOOK-2", LIFE, p2, REP);
    expect((await watchState())?.marks[LIFE].lastRx).toBe(Date.parse("2026-10-09T09:00:01.000Z"));
    clock("2026-10-09T09:00:02.000Z");
    atPatch.release();
    await reachIn(atCard, waits, "the trailing run's card read");
    expect((await watchState())?.marks[LIFE], "edit #2's mark is still there").toBeDefined();
    clock("2026-10-09T09:00:05.000Z");
    atCard.release();
    await settleAll([...waits, ...waits2]);
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }, { lifecyclestage: "opportunity" }]);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("V3: a live mark keeps an UNTYPED cell from HubSpot news older than the edit", async () => {
    contact({ jobtitle: "Engineer" });
    hubspotSets("jobtitle", "Manager", "2026-10-09T08:59:00.000Z");
    clock("2026-10-09T08:59:30.000Z");
    await hubspotPass("HS-USER", { jobtitle: ["2026-10-09T08:59:00.000Z", false] });
    expect(cell(JOB)).toBe("Manager");
    clock("2026-10-09T09:00:00.000Z");
    const prev = eventValue(JOB); rep(JOB, "Engineer");                       // typed back: HubSpot held it before
    w().mods.push("2026-10-09T09:00:08.000Z");
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", JOB, prev, REP);
    await reachIn(atHs, waits, "the run's HubSpot read");
    clock("2026-10-09T09:00:05.000Z");
    await hubspotPass("DUP", { jobtitle: ["2026-10-09T08:59:00.000Z", false] });   // a duplicate of HubSpot's old event
    expect(cell(JOB), trail()).toBe("Engineer");
    expect(logged(/col=text_mm6szy4q action=forward-held reason="a person's edit newer than HubSpot's change is on its way \(mark\)"/)).toBe(true);
    atHs.release(); await settleAll(waits);
    expect(w().hs.properties.jobtitle).toBe("Engineer");
  });

  it("...the mark carries the edit's own time, not its arrival: HubSpot's change made AFTER the edit still wins", async () => {
    contact({ jobtitle: "Engineer" });
    hubspotSets("jobtitle", "Director", "2026-10-09T08:59:00.000Z");
    clock("2026-10-09T08:59:30.000Z");
    await hubspotPass("HS-USER", { jobtitle: ["2026-10-09T08:59:00.000Z", false] });
    clock("2026-10-09T09:00:00.000Z");
    const prev = eventValue(JOB); rep(JOB, "Engineer");                       // back to a value HubSpot held
    hubspotSets("jobtitle", "Manager", "2026-10-09T09:00:10.000Z");             // a HubSpot user, AFTER the edit
    clock("2026-10-09T09:00:15.000Z"); rep(LEAD, "In Progress");               // the card changes again (another column)
    clock("2026-10-09T09:00:20.000Z");                                          // the edit's webhook arrives late
    const atCard = hold("HOOK", "card");
    const waits = await mondayWebhook("HOOK", JOB, prev, REP, { changedAt: Date.parse("2026-10-09T09:00:00.000Z") });
    await reachIn(atCard, waits, "the run's card read");
    expect((await watchState())?.marks[JOB]?.at).toBe(Date.parse("2026-10-09T09:00:00.000Z"));
    clock("2026-10-09T09:00:21.000Z");
    await hubspotPass("SWEEP");                                                 // unscoped: reads the history
    expect(cell(JOB), trail()).toBe("Manager");
    atCard.release(); await settleAll(waits);
    expect(pushes(), "the earlier edit never overwrites the later change").toEqual([]);
    expect(w().hs.properties.jobtitle).toBe("Manager");
  });

  it("a rename's mark keeps a late duplicate of HubSpot's older rename from writing over it (V3, the name)", async () => {
    setWorld(makeWorld(specByObject(ENVC, "companies")!, { hsId: "777001", itemId: "2856777001", created: "2026-07-01T00:00:00.000Z",
      synced: "2026-07-01T00:05:00.000Z", props: { name: "Acme", domain: "acme.example" } }));
    hubspotSets("name", "Acme Corp", "2026-10-09T08:59:00.000Z");
    clock("2026-10-09T08:59:30.000Z");
    await hubspotPass("HS-NAME", { name: ["2026-10-09T08:59:00.000Z", false] });
    expect(w().card.name).toBe("Acme Corp");
    clock("2026-10-09T09:00:00.000Z"); repRename("Acme");                      // back to the name HubSpot held before
    const atCard = hold("HOOK", "card");
    const waits = await mondayWebhook("HOOK", "", undefined, REP, { type: "update_name" });
    await reachIn(atCard, waits, "the rename's card read");
    expect((await watchState())?.marks["~name"]).toBeDefined();
    clock("2026-10-09T09:00:05.000Z");
    await hubspotPass("DUP", { name: ["2026-10-09T08:59:00.000Z", false] });   // a late duplicate of HubSpot's older change
    expect(w().card.name, trail()).toBe("Acme");
    w().mods.push("2026-10-09T09:00:06.000Z");
    atCard.release(); await settleAll(waits);
    expect(pushes()).toEqual([{ name: "Acme" }]);
  });

  it("our own echo of a People cell never takes a person's pending removal away from their run (§8a)", async () => {
    contact(); salesUsers(["999", "998"]);
    clock("2026-10-09T09:00:00.000Z");
    const p1 = eventValue(SALES); repPeople(SALES, ["999"]);                // removes Ann
    const atHs = hold("HOOK-1", "hs");
    const waits1 = await mondayWebhook("HOOK-1", SALES, p1, REP);
    await reachIn(atHs, waits1, "run #1's HubSpot read");
    clock("2026-10-09T09:00:01.000Z");
    const p2 = eventValue(SALES); repPeople(SALES, []);                     // then Joan, HubSpot's owner
    const waits2 = await mondayWebhook("HOOK-2", SALES, p2, REP);           // its removal waits for the trailing run
    await settleAll(await mondayWebhook("ECHO", SALES, { personsAndTeams: [{ id: 999, kind: "person" }] }, ASK_ADA));
    w().mods.push("2026-10-09T09:00:05.000Z");
    atHs.release(); await settleAll([...waits1, ...waits2]);
    expect(pushes(), trail()).toEqual([{ sales_user: "" }]);
    expect(people(SALES)).toEqual([]);
  });

  it("our own echo's removals never ride along with a person's later edit of the People cell (§8a)", async () => {
    contact(); salesUsers(["999"]);                                           // Joan, HubSpot's owner
    hubspotSets("sales_user", "888", "2026-10-09T09:00:00.000Z");             // HubSpot moves it to Ann
    clock("2026-10-09T09:00:01.000Z");
    await hubspotPass("HS-OWNER", { sales_user: ["2026-10-09T09:00:00.000Z", false] });
    expect(people(SALES)).toEqual(["998"]);
    // Our write's own echo: it took Joan out of the cell.
    await settleAll(await mondayWebhook("ECHO", SALES, { personsAndTeams: [{ id: 999, kind: "person" }] }, ASK_ADA));
    hubspotSets("sales_user", "777", "2026-10-09T09:00:10.000Z");             // ...and back to Joan: that pass never ran
    clock("2026-10-09T09:00:20.000Z");
    const prev = eventValue(SALES); repPeople(SALES, []);                     // a rep empties the stale cell: they removed Ann
    await settleAll(await mondayWebhook("EDIT", SALES, prev, REP));
    expect(hubspot.patchRecord, "Joan is never cleared on the strength of our own old echo").not.toHaveBeenCalled();
    expect(people(SALES), trail()).toEqual(["999"]);                          // refused, and healed to HubSpot's owner
  });
});

// ===================================================================================================================
describe("a person's edit whose run died (R2 / R3)", () => {
  const dies = async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z");
    const prev = eventValue(LIFE); rep(LIFE, "5.No intention");
    w().failGetRecord = "HOOK";
    const waits = await mondayWebhook("HOOK", LIFE, prev, REP);
    await settleAll(waits);
    expect(logged(/source=monday item=2856382447 action=error/)).toBe(true);
    expect((await watchState())?.marks[LIFE], "a run that throws leaves its mark").toBeDefined();
  };

  it("STALE_FORWARD_RETRY: at its lease the watch spills a retry that pushes the edit; the card leaves No Activity", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    await dies();
    note("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:06.000Z", false] });
    expect(cell(LIFE), "held meanwhile").toBe("5.No intention");
    expect(watchAlarmAt()).toBe(Date.parse("2026-10-09T09:00:00.000Z") + MARK_LEASE_MS);
    w().mods.push("2026-10-09T09:01:02.000Z");
    await advance("2026-10-09T09:01:01.000Z");
    expect(logged(/action=retry-queued/)).toBe(true);
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(w().card.group.id).toBe(ACTIVE);
    expect(syncState()).toBe("2026-10-09T09:01:02.000Z");
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("the retry drops a key HubSpot changed AFTER the edit (the later change wins); the next pass forwards it", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    await dies();
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:30.000Z");  // a HubSpot user, after the edit; its webhook lost
    await advance("2026-10-09T09:01:01.000Z");
    expect(logged(/action=edit-retry-superseded/)).toBe(true);
    expect((await watchState())?.marks[LIFE], "its mark is cleared: the later change is not held off").toBeUndefined();
    expect(pushes()).toEqual([]);
    expect(w().hs.properties.lifecyclestage).toBe("opportunity");
    clock("2026-10-09T09:01:10.000Z");
    await hubspotPass("SWEEP");
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
  });

  it("the retry of a card no longer linked clears its marks and pushes nothing", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    await dies();
    w().card.column_values.find(c => c.id === w().spec.idCol)!.text = "";
    await advance("2026-10-09T09:01:01.000Z");
    expect(pushes()).toEqual([]);
    expect((await watchState())?.marks[LIFE]).toBeUndefined();
  });

  it("the retry of a record gone from HubSpot clears its marks and pushes nothing", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    await dies();
    w().hs.id = "gone";
    await advance("2026-10-09T09:01:01.000Z");
    expect(pushes()).toEqual([]);
    expect((await watchState())?.marks[LIFE]).toBeUndefined();
  });

  it("an automation's edit whose run died is retried as an automation's: on a record CRM does not own it claims nothing", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact();
    w().hs.properties.sync_owner = ""; delete w().hs.history.sync_owner;
    clock("2026-10-09T09:00:00.000Z");
    const prev = eventValue(LIFE); rep(LIFE, "6.Not in contact/Pending further contact", { userId: "-4", uuid: false });
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", LIFE, prev, "-4"));
    expect((await watchState())?.marks[LIFE]).toMatchObject({ byAutomation: true });
    await advance("2026-10-09T09:01:01.000Z");
    expect(logged(/class=automation action=edit-retried/)).toBe(true);
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(pushes()).toEqual([]);
    expect(cell(LIFE), trail()).toBe("1.NEW");                                // refused, and healed
  });

  it("a retry that keeps failing backs off -- 60 s, then 120 s, then 240 s -- and is then given up", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    await dies();
    w().failGetRecord = "QUEUE";                                              // every retry dies too
    const tries = () => count(/action=edit-retried/);
    await advance("2026-10-09T09:01:00.000Z"); expect(tries(), "at the lease").toBe(1);
    await advance("2026-10-09T09:01:59.000Z"); expect(tries()).toBe(1);
    await advance("2026-10-09T09:02:00.000Z"); expect(tries(), "+60 s").toBe(2);
    await advance("2026-10-09T09:03:59.000Z"); expect(tries()).toBe(2);
    await advance("2026-10-09T09:04:00.000Z"); expect(tries(), "+120 s").toBe(3);
    await advance("2026-10-09T09:07:59.000Z"); expect(tries()).toBe(3);
    await advance("2026-10-09T09:08:00.000Z"); expect(tries(), "+240 s").toBe(4);
    await advance("2026-10-09T09:10:00.000Z");
    expect(logged(/action=edit-retry-abandoned/)).toBe(true);
    expect(tries(), "given up, never tried again").toBe(4);
  });

  it("STALE_FORWARD_RETRY off: the mark ends at its lease, the cell keeps its own hold, then converges back (visible)", async () => {
    await dies();
    await advance("2026-10-09T09:01:05.000Z");
    expect(logged(/action=mark-expired/)).toBe(true);
    expect(cell(LIFE), "still inside its own hold window").toBe("5.No intention");
    await advance("2026-10-09T09:03:10.000Z");
    expect(cell(LIFE), trail()).toBe("1.NEW");
    expect(pushes()).toEqual([]);
    expect(await watchIdle()).toBe(true);
  });

  it("TTL: a mark whose retries keep failing is given up; its cell converges and is not rescued again", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    await dies();
    w().failGetRecord = "QUEUE";                                              // every retry dies too
    for (const at of ["09:01:01", "09:02:02", "09:04:03", "09:08:04", "09:10:05", "09:12:00"])
      await advance(`2026-10-09T${at}.000Z`);
    expect(logged(/action=edit-retry-abandoned/)).toBe(true);
    w().failGetRecord = undefined;
    await advance("2026-10-09T09:14:00.000Z");
    expect(cell(LIFE), trail()).toBe("1.NEW");
    expect(pushes()).toEqual([]);
  });
});

// ===================================================================================================================
describe("the log rescue (STALE_FORWARD_RETRY): an edit monday's log proves was a person's", () => {
  it("ask ada's UI edit read as our own echo is rescued by the converge and pushed as a person's", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });                  // misread as our echo: forward only
    w().mods.push("2026-10-09T09:03:20.000Z");
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/\[converge\] .*action=rescued/)).toBe(true);
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(w().card.group.id).toBe(ACTIVE);
  });

  it("...but our own API write of a value is converged, never rescued", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: false });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    await advance("2026-10-09T09:03:10.000Z");
    expect(pushes()).toEqual([]);
    expect(cell(LIFE), trail()).toBe("1.NEW");
  });

  it("the activity log unreadable: the cell is left, and the converge judges it again later", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    w().logFails = true;
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/action=rescue-unreadable/)).toBe(true);
    expect(cell(LIFE)).toBe("5.No intention");
    w().logFails = false;
    w().mods.push("2026-10-09T09:09:00.000Z");
    await advance("2026-10-09T09:08:30.000Z");
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029060900" }]);
  });

  it("an activity log that stays unreadable: after LOG_RETRY_MAX tries the cell converges anyway (nothing is held forever)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    w().logFails = true;
    await advance("2026-10-09T09:03:10.000Z");
    expect((await watchState())?.cells[LIFE]?.due).toBe(Date.parse("2026-10-09T09:08:10.000Z"));
    expect((await watchState())?.convergeAttempts).toBe(1);
    await advance("2026-10-09T09:08:09.000Z");
    expect(count(/action=rescue-unreadable/), "not again before LOG_RETRY_MS").toBe(1);
    await advance("2026-10-09T09:08:20.000Z");
    await advance("2026-10-09T09:13:30.000Z");
    expect(count(/action=rescue-unreadable/)).toBe(3);
    expect(cell(LIFE)).toBe("5.No intention");
    await advance("2026-10-09T09:18:40.000Z");
    expect(cell(LIFE), trail()).toBe("1.NEW");
    expect(pushes()).toEqual([]);
  });

  it("a candidate whose value could never be sent is converged without a log read (no rescue)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "Something typed", { userId: ASK_ADA, uuid: true });   // not a Lifecycle label
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    await advance("2026-10-09T09:03:10.000Z");
    expect(monday.gql.mock.calls.some(c => String(c[1]).includes("activity_logs")), "no log read").toBe(false);
    expect(logged(/action=rescued/)).toBe(false);
    expect(cell(LIFE), trail()).toBe("1.NEW");
  });

  it("an automation's edit whose webhook was lost is rescued too, and sent as an automation's (it never claims)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "6.Not in contact/Pending further contact", { userId: "-4", uuid: false });
    note("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:06.000Z", false] });   // held (recent), watched
    expect(cell(LIFE)).toBe("6.Not in contact/Pending further contact");
    w().mods.push("2026-10-09T09:03:20.000Z");
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/\[converge\] .*action=rescued/)).toBe(true);
    expect(logged(/class=automation action=edit-retried/)).toBe(true);
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029059095" }]);
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
  });

  it("a log row whose value is not the card's (the card moved on without a row) is never rescued", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    w().card.column_values.find(c => c.id === LIFE)!.text = "6.Not in contact/Pending further contact";   // no log row for this
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/action=rescued/)).toBe(false);
    expect(pushes()).toEqual([]);
    expect(cell(LIFE), trail()).toBe("1.NEW");
  });
});

// ===================================================================================================================
describe("relation cells: a person's pending link is never taken back out by a forward pass", () => {
  const linked = () => {
    contact();
    w().otherCards = { "7001": { text_mm6tsnwx: "501" }, "7002": { text_mm6tsnwx: "502" } };
    w().links[ACCOUNT] = { ids: ["7001"], changedAt: Date.parse("2026-07-18T12:46:01.914Z") };
    w().assoc.companies = ["501"];
  };

  it.each([
    ["within its lease (STALE_FORWARD_RETRY off)", "false", "2026-10-09T09:00:30.000Z"],
    ["a slow run past the recency hold (STALE_FORWARD_RETRY on: the mark lives until its run resolves)", "true", "2026-10-09T09:01:32.000Z"],
  ])("a forward pass applies the person's relation edit still on its way (their mark): %s", async (_n, retry, noteAt) => {
    setEnv({ STALE_FORWARD_RETRY: retry });
    linked();
    clock("2026-10-09T09:00:00.000Z");
    const prev = repLinks(ACCOUNT, ["7001", "7002"]);
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", ACCOUNT, prev, REP);
    await reachIn(atHs, waits, "the relation run's HubSpot read");
    expect((await watchState())?.marks["rel:contact_account"]?.rel).toMatchObject({ added: ["7002"], removed: [], known: true });
    note(noteAt, noteAt);
    clock(noteAt);
    await hubspotPass("NOTE", { notes_last_updated: [noteAt, false] });
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001", "7002"]);
    expect(logged(/relation=companies .*reason="the cell shows HubSpot's links with a person's edit still on its way"/)).toBe(true);
    atHs.release(); await settleAll(waits);
    expect(w().assoc.companies).toEqual(["501", "502"]);
    expect(w().links[ACCOUNT].ids).toEqual(["7001", "7002"]);
    expect((await watchState())?.marks["rel:contact_account"], "the run cleared its mark").toBeUndefined();
  });

  it("a person's UNLINK still on its way is not undone by a forward pass re-adding the card (agreement 2 holds)", async () => {
    linked();
    w().links[ACCOUNT] = { ids: ["7001", "7002"], changedAt: Date.parse("2026-07-18T12:46:01.914Z") };
    w().assoc.companies = ["501", "502"];
    clock("2026-10-09T09:00:00.000Z");
    const prev = repLinks(ACCOUNT, ["7001"]);
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", ACCOUNT, prev, REP);
    await reachIn(atHs, waits, "the relation run's HubSpot read");
    note("2026-10-09T09:00:20.000Z", "2026-10-09T09:00:21.000Z");
    clock("2026-10-09T09:00:22.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:21.000Z", false] });
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001"]);                // not re-added from HubSpot's set
    atHs.release(); await settleAll(waits);
    expect(w().assoc.companies, trail()).toEqual(["501"]);                    // the unlink reached HubSpot
  });

  it("...and past the recency hold too (STALE_FORWARD_RETRY on: the unlink's mark lives until its run resolves)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    linked();
    w().links[ACCOUNT] = { ids: ["7001", "7002"], changedAt: Date.parse("2026-07-18T12:46:01.914Z") };
    w().assoc.companies = ["501", "502"];
    clock("2026-10-09T09:00:00.000Z");
    const prev = repLinks(ACCOUNT, ["7001"]);
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", ACCOUNT, prev, REP);
    await reachIn(atHs, waits, "the relation run's HubSpot read");
    note("2026-10-09T09:01:30.000Z", "2026-10-09T09:01:31.000Z");
    clock("2026-10-09T09:01:32.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:01:31.000Z", false] });
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001"]);
    expect(logged(/relation=companies .*reason="the cell shows HubSpot's links with a person's edit still on its way"/)).toBe(true);
    atHs.release(); await settleAll(waits);
    expect(w().assoc.companies, trail()).toEqual(["501"]);
  });

  it("HubSpot's own new link and a person's link still on its way both stay on the cell", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    linked();
    w().otherCards["7003"] = { text_mm6tsnwx: "503" };
    clock("2026-10-09T09:00:00.000Z");
    const prev = repLinks(ACCOUNT, ["7001", "7002"]);
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", ACCOUNT, prev, REP);
    await reachIn(atHs, waits, "the relation run's HubSpot read");
    w().assoc.companies = ["501", "503"];                                     // HubSpot links another company meanwhile
    note("2026-10-09T09:01:30.000Z", "2026-10-09T09:01:31.000Z");
    clock("2026-10-09T09:01:32.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:01:31.000Z", false] });
    expect([...w().links[ACCOUNT].ids].sort(), trail()).toEqual(["7001", "7002", "7003"]);
    atHs.release(); await settleAll(waits);
    expect([...w().assoc.companies].sort()).toEqual(["501", "502", "503"]);
  });

  it("a person's relation edit whose shape cannot be told holds the whole cell from a forward pass; its run decides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    linked();
    clock("2026-10-09T09:00:00.000Z");
    repLinks(ACCOUNT, ["7001", "7002"]);
    const atHs = hold("HOOK", "hs");
    const waits = await mondayWebhook("HOOK", ACCOUNT, undefined, REP);      // no previousValue: the diff cannot be told
    await reachIn(atHs, waits, "the relation run's HubSpot read");
    expect((await watchState())?.marks["rel:contact_account"]?.rel?.known).toBe(false);
    note("2026-10-09T09:01:30.000Z", "2026-10-09T09:01:31.000Z");
    clock("2026-10-09T09:01:32.000Z");                                       // past the recency hold; the mark lives (retry on)
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:01:31.000Z", false] });
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001", "7002"]);
    expect(logged(/action=forward-held reason="a person's edit of this cell is on its way, and what it changed cannot be told"/)).toBe(true);
    atHs.release(); await settleAll(waits);
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001"]);               // its run refused it, and snapped the cell back
    expect(w().assoc.companies).toEqual(["501"]);
  });

  it("a relation edit whose before-side is unknown is refused and snapped back at once: the gate never holds a snap-back", async () => {
    linked();
    clock("2026-10-09T09:00:00.000Z");
    repLinks(ACCOUNT, ["7001", "7002"]);
    await settleAll(await mondayWebhook("HOOK", ACCOUNT, undefined, REP));
    expect(logged(/action=reverse-refused-snap-back/)).toBe(true);
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001"]);
    expect(w().assoc.companies).toEqual(["501"]);
  });

  it("the watch's converge of a relation cell has no recency hold: it ends in HubSpot's set when due, even if the cell just moved", async () => {
    linked();
    w().otherCards["7003"] = { text_mm6tsnwx: "503" };
    clock("2026-10-09T09:00:00.000Z");
    repLinks(ACCOUNT, ["7001", "7002"]);                                     // no webhook, ever
    note("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:06.000Z", false] });
    expect(w().links[ACCOUNT].ids).toEqual(["7001", "7002"]);               // changed seconds ago: held
    clock("2026-10-09T09:00:58.000Z");
    repLinks(ACCOUNT, ["7001", "7002", "7003"]);                             // moved again just before its converge (no webhook)
    await advance("2026-10-09T09:01:00.000Z");
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001"]);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("an automation's relation edit is not marked (its run pushes nothing); nor is a person's event that changes nothing", async () => {
    linked();
    clock("2026-10-09T09:00:00.000Z");
    const prev = repLinks(ACCOUNT, ["7001", "7002"]);
    const waits = await mondayWebhook("AUTO", ACCOUNT, prev, "-4");
    expect((await watchState())?.marks ?? {}).toEqual({});
    await settleAll(waits);
    const same = await mondayWebhook("SAME", ACCOUNT, eventValue(ACCOUNT), REP);   // before and after the same
    expect((await watchState())?.marks ?? {}).toEqual({});
    await settleAll(same);
  });

  it.each([
    ["a link", ["7001"], ["501"], ["7001", "7002"], ["501", "502"]],
    ["an unlink", ["7001", "7002"], ["501", "502"], ["7001"], ["501"]],
  ])("%s whose run died is sent again from its mark, as the person's (STALE_FORWARD_RETRY)", async (_n, before, hsBefore, after, hsAfter) => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    linked();
    w().links[ACCOUNT] = { ids: [...before], changedAt: Date.parse("2026-07-18T12:46:01.914Z") };
    w().assoc.companies = [...hsBefore];
    clock("2026-10-09T09:00:00.000Z");
    const prev = repLinks(ACCOUNT, after);
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", ACCOUNT, prev, REP));
    expect((await watchState())?.marks["rel:contact_account"]?.rel?.known).toBe(true);
    await advance("2026-10-09T09:01:01.000Z");
    expect([...w().assoc.companies].sort(), trail()).toEqual(hsAfter);
    expect(w().links[ACCOUNT].ids).toEqual(after);
  });

  it("a relation cell changed seconds ago (its mark not in yet) is held, then converged with HubSpot's set", async () => {
    linked();
    clock("2026-10-09T09:00:00.000Z");
    repLinks(ACCOUNT, ["7001", "7002"]);                                     // no webhook yet (and none ever, here)
    note("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:06.000Z", false] });
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001", "7002"]);
    expect((await watchState())?.cells["rel:contact_account"]).toBeDefined();
    await advance("2026-10-09T09:01:10.000Z");
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001"]);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("[F10] a dry run's relation pass registers no hold -- nothing durable -- so nothing rewrites the cell later", async () => {
    linked();
    clock("2026-10-09T09:00:00.000Z");
    repLinks(ACCOUNT, ["7001", "7002"]);                                     // changed seconds ago (no webhook)
    note("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    const { syncHubspotRecord } = await import("../src/sync");
    await syncHubspotRecord(as("RESYNC"), w().spec, w().hs.id, { dryRun: true, writeHubspot: false, maxWrites: 30 }, { left: 30 });
    expect(logged(/relation=companies action=forward-held/), "the dry run still answers as a live pass would").toBe(true);
    expect(await watchState(), "but registers nothing").toBeUndefined();
    await advance("2026-10-09T09:01:10.000Z");
    expect(w().links[ACCOUNT].ids, trail()).toEqual(["7001", "7002"]);
  });

  it("the control: with the gate off, the forward pass takes the person's new link back out", async () => {
    setEnv({ STALE_FORWARD_GATE: "false" });
    linked();
    clock("2026-10-09T09:00:00.000Z");
    repLinks(ACCOUNT, ["7001", "7002"]);
    note("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:06.000Z", false] });
    expect(w().links[ACCOUNT].ids).toEqual(["7001"]);
    expect(monday.getLinkedCell).not.toHaveBeenCalled();
  });
});

// ===================================================================================================================
describe("handleHubspot: what the events named reaches the pass", () => {
  const post = async (events: Record<string, unknown>[], pass = "HS") => {
    const waits: Promise<unknown>[] = [];
    const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
    await handleHubspot(new Request("https://w/webhooks/hubspot", { method: "POST", body: JSON.stringify(events) }), as(pass), ectx);
    return waits;
  };
  const change = (prop: string, at: string, src: string, sourceId?: string, id = 382447) => ({
    subscriptionType: "object.propertyChange", objectTypeId: "0-1", objectId: id, propertyName: prop,
    occurredAt: Date.parse(at), changeSource: src, ...(sourceId ? { sourceId } : {}) });

  it("a Note's propertyChange scopes its pass: the rep's pending Lifecycle is held, with no history read", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await settleAll(await post([change("notes_last_updated", "2026-10-09T09:00:02.000Z", "CALCULATED")]));
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(cell(field("notes_last_updated"))).toBe("2026-10-09");
    expect(historyReads()).toBe(0);
  });

  it("the push's own echo (INTEGRATION, our sourceId) reads as our own: a second edit of the cell is held", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    w().mods.push("2026-10-09T09:00:02.000Z");
    await mondayEdit("EDIT-1", [LIFE]);
    clock("2026-10-09T09:00:03.000Z"); rep(LIFE, "7.Intention to purchase");
    W_.hubspotBumps("2026-10-09T09:00:08.000Z");
    clock("2026-10-09T09:00:09.000Z");
    await settleAll(await post([change("lifecyclestage", "2026-10-09T09:00:02.000Z", "INTEGRATION", W_.OWN)]));
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    expect(historyReads(), "our own write needs no history").toBe(0);
  });

  it("a creation event leaves the pass unscoped: every differing two-way cell's history is read", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    W_.hubspotBumps("2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await settleAll(await post([{ subscriptionType: "object.creation", objectTypeId: "0-1", objectId: 382447,
      occurredAt: Date.parse("2026-10-09T09:00:02.000Z") }]));
    expect(historyReads()).toBe(1);
    expect(cell(LIFE)).toBe("5.No intention");
  });

  it("an overflowing batch spills its records WITH what their events named", async () => {
    contact();
    clock("2026-10-09T09:00:03.000Z");
    const events = Array.from({ length: 17 }, (_, i) => change("notes_last_updated", "2026-10-09T09:00:02.000Z", "CALCULATED", undefined, 400000 + i));
    await settleAll(await post(events));
    const overflow = spilled.filter(s => !s.watch);
    expect(overflow.map(s => s.id)).toEqual(["400015", "400016"]);
    expect(overflow[0].scope?.props.notes_last_updated).toEqual({ at: Date.parse("2026-10-09T09:00:02.000Z"), own: false });
  });

  it("with the switch off the webhook gathers no scopes: a spilled record carries none", async () => {
    setEnv({ STALE_FORWARD_GATE: "false" });
    contact();
    clock("2026-10-09T09:00:03.000Z");
    const events = Array.from({ length: 17 }, (_, i) => change("notes_last_updated", "2026-10-09T09:00:02.000Z", "CALCULATED", undefined, 400000 + i));
    await settleAll(await post(events));
    const overflow = spilled.filter(s => !s.watch);
    expect(overflow.map(s => s.id)).toEqual(["400015", "400016"]);
    expect(overflow.map(s => s.scope)).toEqual([undefined, undefined]);
  });

  it("a pass that throws puts its scope back: the re-run after the error is still judged on what the events named", async () => {
    contact();
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:01.000Z");   // a HubSpot user
    let fail!: () => void; const failNow = new Promise<void>(r => { fail = r; });
    let started!: () => void; const inFirst = new Promise<void>(r => { started = r; });
    hubspot.getRecord.mockImplementationOnce(async () => { started(); await failNow; throw new Error("hubspot GET: 503 unavailable"); });
    clock("2026-10-09T09:00:02.000Z");
    const waits = await post([change("lifecyclestage", "2026-10-09T09:00:01.000Z", "CRM_UI")], "HS-1");
    await inFirst;
    note("2026-10-09T09:00:02.000Z", "2026-10-09T09:00:03.000Z");
    clock("2026-10-09T09:00:04.000Z");
    const waits2 = await post([change("notes_last_updated", "2026-10-09T09:00:03.000Z", "CALCULATED")], "HS-2");
    fail();
    await settleAll([...waits, ...waits2]);
    expect(logged(/action=error-then-rerun key=hs:contact:382447:u/)).toBe(true);
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    expect(historyReads(), "its own event named it: no history needed").toBe(0);
  });
});
