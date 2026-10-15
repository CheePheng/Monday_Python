import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import type { FieldSpec, ObjectSpec } from "../src/types";
import type { Named } from "./fixtures/stale-forward-world";

/**
 * STALE_FORWARD_GATE THROUGH THE REAL ENGINE: a HubSpot-side forward pass never writes over a person's monday edit
 * HubSpot has not received yet, in any ordering; nothing it leaves is left forever; genuine HubSpot changes still
 * come across. The world (test/fixtures/stale-forward-world.ts) is one card and one record as stateful fakes, the
 * card's watch is the real Durable Object, and only HubSpot's and monday's I/O are faked.
 *
 * The three timelines at the top are the live ones of 2026-10-09 (Contacts, Lifecycle Stage), replayed write for
 * write with their real timestamps.
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
  OWN, OTHER_APP, ASK_ADA, REP, W, makeWorld, setWorld, installWorld, setEnv, as, live, clock, now, rep, repPeople, repRename,
  hubspotSets, note, hubspotBumps, cell, syncState, people, hold, reach, hubspotPass, mondayEdit, advance, fireWatch, drain,
  watchState, watchIdle, expectSyncStateNeverBackwards, logged, setLeadStatus, LEAD_STATUS_BASE, TYPED_LIVE, spilled,
} = W_;
const pushes = () => W_.pushes(hubspot as never);
const historyReads = () => W_.historyReads(hubspot as never);
const w = () => W_.w;
const { specByObject } = await import("../src/config");
const { settleCardWatch, syncHubspotRecord, syncMondayItem } = await import("../src/sync");
const { CreateIdempotency } = await import("../src/create-idempotency-do");

const ENVC = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const field = (spec: ObjectSpec, hs: string): FieldSpec => spec.fields.find(f => f.hs === hs)!;
const LIFE = field(CRM_CONTACTS, "lifecyclestage").col;
const LEAD = field(CRM_CONTACTS, "hs_lead_status").col;
const LAD = field(CRM_CONTACTS, "notes_last_updated").col;
const JOB = field(CRM_CONTACTS, "jobtitle").col;
const SALES = field(CRM_CONTACTS, "sales_user").col;
const NO_ACTIVITY = "group_mm7cj2yx";
const ACTIVE = "topics";
const contactsSpec = () => specByObject(ENVC, "contacts")!;
const accountsSpec = () => specByObject(ENVC, "companies")!;
const S0 = "2026-07-18T12:46:01.914Z";
const contact = (o: { hsId?: string; itemId?: string; created?: string; synced?: string; extra?: Record<string, string>; typed?: string[] } = {}) =>
  setWorld(makeWorld(contactsSpec(), { hsId: o.hsId ?? "382447", itemId: o.itemId ?? "2856382447",
    created: o.created ?? "2026-07-18T12:40:00.000Z", synced: o.synced ?? S0,
    props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead", ...(o.extra ?? {}) }, typed: o.typed }));
const trail = () => w().trail.join("\n");
/** The env of `pass` with the card's watch unreachable (every `held:` instance throws); everything else as usual. */
const noWatch = (pass: string) => {
  const env = as(pass) as unknown as { CREATE_IDEMPOTENCY: unknown };
  env.CREATE_IDEMPOTENCY = { idFromName: (n: string) => n,
    get: (id: string) => { if (String(id).startsWith("held:")) throw new Error("DO unreachable"); return W_.namespace.get(id); } };
  return env as never;
};
/** The card watch's Sync State notes (the register, §13), as its Durable Object's storage holds them. */
const stampNotes = () => ((W_.doObjects.get(W_.watchKey())?.ctx.map.get("stampNotes") ?? []) as { ts: string }[]).map(n => n.ts);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock("2026-10-09T08:00:00.000Z");
  vi.clearAllMocks();
  installWorld(monday as never, hubspot as never);
  assoc.syncAssociations.mockResolvedValue(undefined);
  assoc.reverseAssociations.mockResolvedValue(undefined);
  assoc.convergeRelationCell.mockResolvedValue("matched");
});
afterEach((c) => { W_.debugDump(c.task.name); vi.useRealTimers(); });

// ===================================================================================================================
describe("the three live timelines of 2026-10-09", () => {
  it("2856382447: the rep's pass reads the card first; the Note's pass runs while the push is on its way", async () => {
    contact();
    const s0 = syncState();
    note("2026-10-09T08:21:20.172Z", "2026-10-09T08:21:26.732Z");
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    w().mods.push("2026-10-09T08:21:32.807Z");
    const atPatch = hold("EDIT", "patch");
    const edit = mondayEdit("EDIT", [LIFE]);
    await reach(atPatch, edit, "the rep's PATCH");
    clock("2026-10-09T08:21:31.500Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T08:21:26.732Z", false] });
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(cell(LAD)).toBe("2026-10-09");
    expect(syncState(), "a pass that left a cell writes no Sync State").toBe(s0);
    clock("2026-10-09T08:21:32.807Z");
    atPatch.release();
    await edit;
    clock("2026-10-09T08:21:36.000Z");
    await hubspotPass("ECHO", { lifecyclestage: ["2026-10-09T08:21:32.807Z", true] });
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(syncState()).toBe("2026-10-09T08:21:32.807Z");
    expect(w().card.group.id).toBe(ACTIVE);
    expectSyncStateNeverBackwards(s0);
    // After the hold window the watch has nothing left to converge.
    await advance("2026-10-09T08:24:40.000Z");
    expect(cell(LIFE)).toBe("5.No intention");
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("2856363664: the Note's pass writes before the rep's own pass reads the card -- the edit is pushed, not lost", async () => {
    contact({ hsId: "363664", itemId: "2856363664", created: "2026-07-19T07:05:00.000Z", synced: "2026-07-19T07:09:24.400Z" });
    const s0 = syncState();
    note("2026-10-09T08:31:44.115Z", "2026-10-09T08:31:50.307Z");
    clock("2026-10-09T08:31:54.087Z"); rep(LIFE, "5.No intention");
    clock("2026-10-09T08:31:57.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T08:31:50.307Z", false] });
    expect(cell(LIFE), trail()).toBe("5.No intention");
    w().mods.push("2026-10-09T08:31:59.000Z");
    clock("2026-10-09T08:31:58.000Z");
    await mondayEdit("EDIT", [LIFE]);
    await hubspotPass("ECHO", { lifecyclestage: ["2026-10-09T08:31:59.000Z", true] });
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(syncState()).toBe("2026-10-09T08:31:59.000Z");
    expect(w().card.group.id).toBe(ACTIVE);
    expectSyncStateNeverBackwards(s0);
  });

  it.each([["with"], ["without"]])("2856396953: the Note's write lands after the push stamped (%s the post-stage bump)", async (bump) => {
    contact({ hsId: "396953", itemId: "2856396953", created: "2026-07-22T09:15:00.000Z", synced: "2026-07-22T09:20:41.652Z" });
    const s0 = syncState();
    clock("2026-10-09T08:07:21.788Z"); rep(LIFE, "5.No intention");
    note("2026-10-09T08:07:15.275Z", "2026-10-09T08:07:23.156Z");
    clock("2026-10-09T08:07:25.000Z");
    const atWrite = hold("NOTE", "write");
    const fwd = hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T08:07:23.156Z", false] });
    await reach(atWrite, fwd, "the Note pass's monday write");
    w().mods.push("2026-10-09T08:07:28.903Z");
    clock("2026-10-09T08:07:28.000Z");
    await mondayEdit("EDIT", [LIFE]);
    atWrite.release();
    await fwd;
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(syncState(), trail()).toBe("2026-10-09T08:07:28.903Z");
    expectSyncStateNeverBackwards(s0);
    if (bump === "with") hubspotBumps("2026-10-09T08:07:34.828Z");
    clock("2026-10-09T08:07:40.000Z");
    await hubspotPass("ECHO", { lifecyclestage: ["2026-10-09T08:07:28.903Z", true] });
    expect(cell(LIFE)).toBe("5.No intention");
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(w().card.group.id).toBe(ACTIVE);
    expectSyncStateNeverBackwards(s0);
    await advance("2026-10-09T08:11:00.000Z");
    expect(cell(LIFE)).toBe("5.No intention");
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it.each([["all typed"], ["only status/date/people typed"]])("the key timeline with %s cells", async (mode) => {
    contact({ extra: { jobtitle: "Engineer" }, typed: mode === "all typed" ? undefined : TYPED_LIVE });
    note("2026-10-09T08:21:20.172Z", "2026-10-09T08:21:26.732Z");
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention"); rep(JOB, "Buyer");
    clock("2026-10-09T08:21:28.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T08:21:26.732Z", false] });
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(cell(JOB), trail()).toBe("Buyer");
    w().mods.push("2026-10-09T08:21:32.807Z", "2026-10-09T08:21:33.500Z");
    await mondayEdit("EDIT-LIFE", [LIFE]);
    await mondayEdit("EDIT-JOB", [JOB]);
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(w().hs.properties.jobtitle).toBe("Buyer");
  });
});

// ===================================================================================================================
describe("reverse orderings of the same four events (the first attempt's seven)", () => {
  const NOTE_AT = "2026-10-09T08:21:20.172Z";
  const L1 = "2026-10-09T08:21:26.732Z";
  const N1 = "2026-10-09T08:21:32.807Z";
  const ends = (s0: string) => {
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(cell(LAD)).toBe("2026-10-09");
    expect(w().card.group.id).toBe(ACTIVE);
    expectSyncStateNeverBackwards(s0);
  };
  const noteEv = { notes_last_updated: [L1, false] } as Named;
  const echoEv = { lifecyclestage: [N1, true] } as Named;

  it("the Note's pass runs entirely before the rep's edit", async () => {
    contact(); const s0 = syncState();
    note(NOTE_AT, L1);
    clock("2026-10-09T08:21:26.900Z");
    await hubspotPass("NOTE", noteEv);
    expect(syncState()).toBe(L1);
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    await mondayEdit("EDIT", [LIFE]);
    await hubspotPass("ECHO", echoEv);
    ends(s0);
    expect(syncState()).toBe(N1);
  });

  it("the rep's whole pass runs before the Note's pass starts", async () => {
    contact(); const s0 = syncState();
    note(NOTE_AT, L1);
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    await mondayEdit("EDIT", [LIFE]);
    await hubspotPass("NOTE", noteEv);
    await hubspotPass("ECHO", echoEv);
    ends(s0);
    expect(syncState()).toBe(N1);
  });

  it("the push's own webhook arrives before the rep's pass has written monday", async () => {
    contact(); const s0 = syncState();
    note(NOTE_AT, L1);
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    const atWrite = hold("EDIT", "write");
    const edit = mondayEdit("EDIT", [LIFE]);
    await reach(atWrite, edit, "the rep pass's monday write");
    await hubspotPass("ECHO", echoEv);
    atWrite.release();
    await edit;
    await hubspotPass("NOTE", noteEv);
    ends(s0);
    expect(syncState()).toBe(N1);
  });

  it("the Note's pass reads HubSpot before the push and the card after it, and writes after the rep's pass", async () => {
    contact(); const s0 = syncState();
    note(NOTE_AT, L1);
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    const atCard = hold("NOTE", "card");
    const fwd = hubspotPass("NOTE", noteEv);
    await reach(atCard, fwd, "the Note pass's card read");
    w().mods.push(N1);
    await mondayEdit("EDIT", [LIFE]);
    atCard.release();
    await fwd;
    await hubspotPass("ECHO", echoEv);
    ends(s0);
  });

  it("the Note's pass read the card before the edit, and its write lands after the push: the register restores Sync State", async () => {
    contact(); const s0 = syncState();
    note(NOTE_AT, L1);
    clock("2026-10-09T08:21:26.900Z");
    const atWrite = hold("NOTE", "write");
    const fwd = hubspotPass("NOTE", noteEv);
    await reach(atWrite, fwd, "the Note pass's monday write");
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    await mondayEdit("EDIT", [LIFE]);
    clock("2026-10-09T08:21:33.000Z");
    atWrite.release();
    await fwd;
    expect(cell(LIFE), trail()).toBe("5.No intention");
    // monday has no compare-and-set: the Note pass's older stamp landed after the push's -- and the card's register
    // saw the two write windows overlap, and restores the newer stamp shortly after.
    expect(syncState()).toBe(L1);
    clock("2026-10-09T08:21:34.600Z");
    expect(await fireWatch()).toBe(true);
    expect(syncState(), trail()).toBe(N1);
    expect(logged(/\[sync-state\] .*action=restamped/)).toBe(true);
    await hubspotPass("ECHO", echoEv);
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(w().card.group.id).toBe(ACTIVE);
    // The only backwards write is the overtaken one, and the register put the newest stamp back over it.
    expect(w().stamps).toEqual([N1, L1, N1]);
    void s0;
  });

  it("...the register stays quiet when stamps do not overlap (no read-back, no restamp)", async () => {
    contact();
    note(NOTE_AT, L1);
    clock("2026-10-09T08:21:26.900Z");
    await hubspotPass("NOTE", noteEv);
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    clock("2026-10-09T08:21:28.000Z");
    await mondayEdit("EDIT", [LIFE]);
    clock("2026-10-09T08:21:40.000Z");
    expect(await fireWatch()).toBe(false);
    expect(logged(/action=verify-queued/)).toBe(false);
    expect(w().stamps).toEqual([L1, N1]);
  });

  it("the same column edited twice: edit #1's echo leaves edit #2 alone, and #2 is pushed (double edit A)", async () => {
    contact(); const s0 = syncState();
    clock("2026-10-09T08:21:27.004Z"); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    await mondayEdit("EDIT-1", [LIFE]);
    clock("2026-10-09T08:21:33.500Z"); rep(LIFE, "7.Intention to purchase");
    hubspotBumps("2026-10-09T08:21:39.900Z");
    clock("2026-10-09T08:21:40.000Z");
    await hubspotPass("ECHO-1", echoEv);
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    w().mods.push("2026-10-09T08:21:41.000Z");
    await mondayEdit("EDIT-2", [LIFE]);
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }, { lifecyclestage: "opportunity" }]);
    expect(cell(LIFE)).toBe("7.Intention to purchase");
    expectSyncStateNeverBackwards(s0);
  });

  it("...and when edit #1's echo is served BEFORE edit #1's own stamp lands", async () => {
    contact(); const s0 = syncState();
    clock("2026-10-09T08:21:27.000Z"); rep(LIFE, "5.No intention");
    w().mods.push("2026-10-09T08:21:28.000Z");
    const atWrite = hold("EDIT-1", "write");
    const e1 = mondayEdit("EDIT-1", [LIFE]);
    await reach(atWrite, e1, "edit #1's monday write");          // pushed at 08:21:28, not stamped yet
    clock("2026-10-09T08:21:29.000Z"); rep(LIFE, "7.Intention to purchase");
    hubspotBumps("2026-10-09T08:21:34.000Z");
    clock("2026-10-09T08:21:34.500Z");
    await hubspotPass("ECHO-1", { lifecyclestage: ["2026-10-09T08:21:28.000Z", true] });
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    atWrite.release(); await e1;
    w().mods.push("2026-10-09T08:21:36.000Z");
    clock("2026-10-09T08:21:35.500Z");
    await mondayEdit("EDIT-2", [LIFE]);
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }, { lifecyclestage: "opportunity" }]);
    expect(cell(LIFE)).toBe("7.Intention to purchase");
    expectSyncStateNeverBackwards(s0);
  });

  it("a pass whose HubSpot read predates a push that stamped meanwhile writes HubSpot's change but no older stamp", async () => {
    contact(); const s0 = syncState();
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:00.000Z");
    clock("2026-10-09T09:00:01.000Z");
    const atFresh = hold("HS-1", "fresh");
    const p = hubspotPass("HS-1", { lifecyclestage: ["2026-10-09T09:00:00.000Z", false] });
    await reach(atFresh, p, "the pass's card read");                       // it read HubSpot at 09:00:00
    rep(LEAD, "In Progress");
    w().mods.push("2026-10-09T09:00:03.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await mondayEdit("EDIT-LEAD", [LEAD]);                                    // pushed and stamped 09:00:03
    atFresh.release(); await p;
    expect(cell(LIFE)).toBe("7.Intention to purchase");
    expect(syncState(), trail()).toBe("2026-10-09T09:00:03.000Z");
    expectSyncStateNeverBackwards(s0);
  });

  it("two HubSpot webhooks whose reads cross never stamp the older time over the newer", async () => {
    contact(); const s0 = syncState();
    hubspotBumps("2026-10-09T09:00:00.000Z");
    clock("2026-10-09T09:00:01.000Z");
    const atCard = hold("OLDER", "card");
    const older = hubspotPass("OLDER", {});
    await reach(atCard, older, "the older pass's card read");
    hubspotBumps("2026-10-09T09:00:05.000Z");
    await hubspotPass("NEWER", {});
    atCard.release(); await older;
    expect(syncState()).toBe("2026-10-09T09:00:05.000Z");
    expectSyncStateNeverBackwards(s0);
  });
});

// ===================================================================================================================
describe("double edits, two columns, two pushes at once", () => {
  it("double edit B: edit #2 made INSIDE push #1's read-to-PATCH window is not reverted by #1's echo", async () => {
    contact(); const s0 = syncState();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    const atPatch = hold("EDIT-1", "patch");
    const e1 = mondayEdit("EDIT-1", [LIFE]);
    await reach(atPatch, e1, "edit #1's PATCH");                         // read the card (5) already
    clock("2026-10-09T09:00:01.000Z"); rep(LIFE, "7.Intention to purchase");
    w().mods.push("2026-10-09T09:00:01.500Z");
    clock("2026-10-09T09:00:01.500Z");
    atPatch.release(); await e1;
    hubspotBumps("2026-10-09T09:00:08.000Z");
    clock("2026-10-09T09:00:08.500Z");
    await hubspotPass("ECHO-1", { lifecyclestage: ["2026-10-09T09:00:01.500Z", true] });
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    w().mods.push("2026-10-09T09:00:10.000Z");
    await mondayEdit("EDIT-2", [LIFE]);
    expect(w().hs.properties.lifecyclestage).toBe("opportunity");
    expectSyncStateNeverBackwards(s0);
  });

  it("double edit B, judged by HubSpot's history (an unscoped pass): our own push newest -> held", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    const atPatch = hold("EDIT-1", "patch");
    const e1 = mondayEdit("EDIT-1", [LIFE]);
    await reach(atPatch, e1, "edit #1's PATCH");
    clock("2026-10-09T09:00:01.000Z"); rep(LIFE, "7.Intention to purchase");
    w().mods.push("2026-10-09T09:00:01.500Z");
    clock("2026-10-09T09:00:01.500Z");
    atPatch.release(); await e1;
    hubspotBumps("2026-10-09T09:00:08.000Z");
    clock("2026-10-09T09:00:08.500Z");
    await hubspotPass("SWEEP");                                            // unscoped: every in-play cell's history
    expect(historyReads()).toBe(1);
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
  });

  it("double edit C: a text value HubSpot NEVER held is monday's own, even when HubSpot changed it since Sync State", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    hubspotSets("jobtitle", "Engineer II", "2026-10-09T08:59:00.000Z");   // HubSpot's change, its webhook not served
    clock("2026-10-09T09:00:00.000Z"); rep(JOB, "Director");               // then a rep's own value
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("SWEEP");
    expect(cell(JOB), trail()).toBe("Director");
    expect(logged(/col=text_mm6szy4q action=forward-held reason="a value HubSpot has never held/)).toBe(true);
    w().mods.push("2026-10-09T09:00:03.000Z");
    await mondayEdit("EDIT", [JOB]);
    expect(w().hs.properties.jobtitle).toBe("Director");
  });

  it("double edit C: a text cell typed BACK to an older HubSpot value after our push -- our own push is not news", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z"); rep(JOB, "Director");
    w().mods.push("2026-10-09T09:00:03.000Z");
    await mondayEdit("EDIT-1", [JOB]);
    clock("2026-10-09T09:00:05.000Z"); rep(JOB, "Engineer");               // undo: HubSpot held it before
    hubspotBumps("2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("ECHO", { jobtitle: ["2026-10-09T09:00:03.000Z", null] });   // its source unknown: the history decides
    expect(cell(JOB), trail()).toBe("Engineer");
    w().mods.push("2026-10-09T09:00:08.000Z");
    await mondayEdit("EDIT-2", [JOB]);
    expect(w().hs.properties.jobtitle).toBe("Engineer");
  });

  it("two columns: a Lead Status edit's pass never writes HubSpot's old Lifecycle over a Lifecycle edit on its way", async () => {
    contact(); const s0 = syncState();
    note("2026-10-09T08:21:20.172Z", "2026-10-09T08:21:26.732Z");
    clock("2026-10-09T08:21:27.000Z"); rep(LIFE, "5.No intention");
    clock("2026-10-09T08:21:28.000Z"); rep(LEAD, "Unqualified");
    w().mods.push("2026-10-09T08:21:31.000Z");
    clock("2026-10-09T08:21:30.000Z");
    await mondayEdit("EDIT-LEAD", [LEAD]);
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(cell(LAD)).toBe("2026-10-09");                                    // HubSpot's own change still came across
    expect(logged(/cols=color_mm70k2wk action=left-to-forward-pass/)).toBe(true);
    // HubSpot was newer than Sync State: the left cell is due for a converge, which finds it recent and holds it.
    expect((await watchState())?.cells[LIFE]?.due).toBeDefined();
    await advance("2026-10-09T08:21:45.000Z");
    expect(cell(LIFE), trail()).toBe("5.No intention");
    w().mods.push("2026-10-09T08:21:46.000Z");
    await mondayEdit("EDIT-LIFE", [LIFE]);
    expect(pushes()).toEqual([{ hs_lead_status: "UNQUALIFIED" }, { lifecyclestage: "1029060900" }]);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(cell(LEAD)).toBe("Unqualified");
    expect(w().card.group.id).toBe(ACTIVE);
    expectSyncStateNeverBackwards(s0);
  });

  it("two pushes at once: the earlier push's older stamp landing last is restored by the register", async () => {
    contact();
    clock("2026-10-09T08:21:27.000Z"); rep(LIFE, "5.No intention"); rep(LEAD, "In Progress");
    w().mods.push("2026-10-09T08:21:32.807Z");
    const atWrite = hold("EDIT-LIFE", "write");
    const a = mondayEdit("EDIT-LIFE", [LIFE]);
    await reach(atWrite, a, "the Lifecycle pass's monday write");
    w().mods.push("2026-10-09T08:21:33.500Z");
    clock("2026-10-09T08:21:33.600Z");
    await mondayEdit("EDIT-LEAD", [LEAD]);                                   // pushed later, stamped first
    clock("2026-10-09T08:21:34.000Z");
    atWrite.release(); await a;
    expect(syncState()).toBe("2026-10-09T08:21:32.807Z");                  // overtaken (no compare-and-set)
    clock("2026-10-09T08:21:35.600Z");
    expect(await fireWatch()).toBe(true);
    expect(syncState(), trail()).toBe("2026-10-09T08:21:33.500Z");
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(w().hs.properties.hs_lead_status).toBe("IN_PROGRESS");
  });
});

// ===================================================================================================================
describe("[5][9][13] a HubSpot change landing inside a person's run comes across by its own named pass", () => {
  it("typed: Lifecycle changed between a Lead Status run's HubSpot read and its PATCH", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LEAD, "In Progress");
    const atPatch = hold("EDIT-LEAD", "patch");
    const e = mondayEdit("EDIT-LEAD", [LEAD]);
    await reach(atPatch, e, "the Lead Status PATCH");
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:01.000Z");
    w().mods.push("2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:02.000Z");
    atPatch.release(); await e;
    expect(syncState()).toBe("2026-10-09T09:00:02.000Z");                 // the push's own stamp, past the change
    expect(cell(LIFE)).toBe("1.NEW");
    expect(historyReads(), "no extra read in the push").toBe(0);
    expect(monday.getItemFresh).not.toHaveBeenCalled();
    clock("2026-10-09T09:00:04.000Z");
    await hubspotPass("HS-USER", { lifecyclestage: ["2026-10-09T09:00:01.000Z", false] });
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    expect(historyReads(), "a typed cell named by a known event needs no history").toBe(0);
    expect(w().card.group.id).toBe(ACTIVE);
  });

  it("untyped: Job Title changed between a Lead Status run's HubSpot read and its PATCH", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z"); rep(LEAD, "In Progress");
    const atPatch = hold("EDIT-LEAD", "patch");
    const e = mondayEdit("EDIT-LEAD", [LEAD]);
    await reach(atPatch, e, "the Lead Status PATCH");
    hubspotSets("jobtitle", "Head of IT", "2026-10-09T09:00:01.000Z");
    w().mods.push("2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:02.500Z");
    atPatch.release(); await e;
    expect(cell(JOB)).toBe("Engineer");
    clock("2026-10-09T09:00:04.000Z");
    await hubspotPass("HS-USER", { jobtitle: ["2026-10-09T09:00:01.000Z", false] });
    expect(cell(JOB), trail()).toBe("Head of IT");
  });

  it("the same, untyped, when the card did NOT change since the event: no history read at all", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z");
    hubspotSets("jobtitle", "Head of IT", "2026-10-09T09:00:01.000Z");
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("HS-USER", { jobtitle: ["2026-10-09T09:00:01.000Z", false] });
    expect(cell(JOB)).toBe("Head of IT");
    expect(historyReads()).toBe(0);
  });
});

// ===================================================================================================================
describe("the clock-ordering edge (TIE_MS)", () => {
  const crossing = async () => {
    contact();
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:59:59.000Z");
    clock("2026-10-09T10:00:00.200Z");
    const atWrite = hold("HS-1", "write");
    const p = hubspotPass("HS-1", { lifecyclestage: ["2026-10-09T09:59:59.000Z", false] });
    await reach(atWrite, p, "the first pass's write");
    hubspotSets("lifecyclestage", "customer", "2026-10-09T10:00:00.500Z", "AUTOMATION_PLATFORM");
    clock("2026-10-09T10:00:01.200Z");
    atWrite.release(); await p;                                               // our write of opportunity, 0.7 s late
    expect(cell(LIFE)).toBe("7.Intention to purchase");
  };

  it("our forward of HubSpot's earlier value crossed its newer change: the tie-break forwards the newer one", async () => {
    await crossing();
    clock("2026-10-09T10:00:03.000Z");
    await hubspotPass("HS-2", { lifecyclestage: ["2026-10-09T10:00:00.500Z", false] });
    expect(cell(LIFE), trail()).toBe("8.The customer generating the transaction");
    expect(historyReads(), "the tie zone reads the history once").toBe(1);
  });

  it("...but a PERSON's value in the tie zone (not HubSpot's earlier one) is held", async () => {
    await crossing();
    rep(LIFE, "5.No intention");                                             // at 10:00:01.2, 0.7 s after customer
    clock("2026-10-09T10:00:03.000Z");
    await hubspotPass("HS-2", { lifecyclestage: ["2026-10-09T10:00:00.500Z", false] });
    expect(cell(LIFE), trail()).toBe("5.No intention");
  });
});

// ===================================================================================================================
describe("genuine HubSpot changes still come across promptly (R5)", () => {
  it("a HubSpot change of the SAME column after the rep's push reaches monday at once", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    w().mods.push("2026-10-09T09:00:01.000Z");
    await mondayEdit("EDIT", [LIFE]);
    clock("2026-10-09T09:00:30.000Z");
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:30.000Z");
    await hubspotPass("HS-USER", { lifecyclestage: ["2026-10-09T09:00:30.000Z", false] });
    expect(cell(LIFE)).toBe("7.Intention to purchase");
    expect(syncState()).toBe("2026-10-09T09:00:30.000Z");
  });

  it("a HubSpot user changing the stage AFTER the rep's edit, before its push: the later change wins on both sides", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("HS-USER", { lifecyclestage: ["2026-10-09T09:00:02.000Z", false] });
    expect(cell(LIFE)).toBe("7.Intention to purchase");
    await mondayEdit("EDIT", [LIFE]);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(w().hs.properties.lifecyclestage).toBe("opportunity");
  });

  it("another app's change after the edit wins (an INTEGRATION write that is not ours)", async () => {
    contact();
    clock("2026-10-09T10:00:00.000Z"); rep(LIFE, "5.No intention");
    hubspotSets("lifecyclestage", "customer", "2026-10-09T10:00:03.000Z", "INTEGRATION", OTHER_APP);
    clock("2026-10-09T10:00:04.000Z");
    await hubspotPass("APP", { lifecyclestage: ["2026-10-09T10:00:03.000Z", null] });   // INTEGRATION, not ours: unknown
    expect(cell(LIFE), trail()).toBe("8.The customer generating the transaction");
  });

  it("a genuine change of a TEXT cell showing HubSpot's previous value comes across at once", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z");
    w().card.updated_at = now();                                              // the card was just written (any column)
    hubspotSets("jobtitle", "Manager", "2026-10-09T09:00:01.000Z");
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("HS-USER", { jobtitle: ["2026-10-09T09:00:01.000Z", false] });
    expect(cell(JOB), trail()).toBe("Manager");
  });

  it("a Note-only pass (no two-way cell differs): no history GET, no fresh read, no watch RPC; stamps as before", async () => {
    contact();
    note("2026-10-09T09:00:00.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    const watchRpc = vi.spyOn(CreateIdempotency.prototype, "watchCells");
    const stampRpc = vi.spyOn(CreateIdempotency.prototype, "noteStamp");
    try {
      await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:06.000Z", false] });
      expect(watchRpc, "no watch RPC").not.toHaveBeenCalled();
      expect(stampRpc, "HEAD's calls plus one noteStamp").toHaveBeenCalledTimes(1);
    } finally { watchRpc.mockRestore(); stampRpc.mockRestore(); }
    expect(historyReads()).toBe(0);
    expect(monday.getItemFresh).not.toHaveBeenCalled();
    expect(await watchState(), "no watch for a card nothing was left on").toBeUndefined();
    expect(hubspot.getRecord).toHaveBeenCalledTimes(1);
    expect(cell(LAD)).toBe("2026-10-09");
    expect(syncState()).toBe("2026-10-09T09:00:06.000Z");
    expect(w().card.group.id).toBe(NO_ACTIVITY);                             // a Note is not a worked status
  });

  it("a genuine typed change named by its own event costs no history GET, even when the card changed after it", async () => {
    contact();
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:00.000Z");
    clock("2026-10-09T09:00:01.000Z"); rep(JOB, "Buyer");                   // the card changes after HubSpot's change
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("HS-USER", { lifecyclestage: ["2026-10-09T09:00:00.000Z", false] });
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    expect(historyReads(), "a status cell carries changed_at: its own event decides").toBe(0);
    expect(cell(JOB)).toBe("Buyer");
  });

  it("...while a text cell the card changed at or after its event has HubSpot's history read FIRST, then the card", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    hubspotSets("jobtitle", "Manager", "2026-10-09T09:00:00.000Z");
    clock("2026-10-09T09:00:00.500Z"); rep(LIFE, "5.No intention");          // the card changes after HubSpot's change
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("HS-USER", { jobtitle: ["2026-10-09T09:00:00.000Z", false] });
    expect(cell(JOB), trail()).toBe("Manager");
    expect(cell(LIFE)).toBe("5.No intention");
    expect(historyReads()).toBe(1);
    expect(hubspot.getRecordWithHistory.mock.invocationCallOrder[0], "HubSpot first, so the card read is never the older")
      .toBeLessThan(monday.getItemFresh.mock.invocationCallOrder[0]);
  });

  it("a watched cell forwarded by HubSpot's later change leaves the watch at once (no needless converge)", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });                  // read as our own echo: watched
    expect((await watchState())?.cells[LIFE]).toBeDefined();
    hubspotSets("lifecyclestage", "customer", "2026-10-09T09:00:10.000Z");    // a HubSpot user, later
    clock("2026-10-09T09:00:11.000Z");
    await hubspotPass("HS-USER", { lifecyclestage: ["2026-10-09T09:00:10.000Z", false] });
    expect(cell(LIFE)).toBe("8.The customer generating the transaction");
    expect((await watchState())?.cells[LIFE], "resolved by the forward").toBeUndefined();
  });

  it("an unscoped pass (a creation event, a sweep) still forwards a genuine typed change, by its history", async () => {
    contact();
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:00.000Z");
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("SWEEP");
    expect(cell(LIFE)).toBe("7.Intention to purchase");
    expect(historyReads()).toBe(1);
    expect(syncState()).toBe("2026-10-09T09:00:00.000Z");
  });
});

// ===================================================================================================================
describe("nothing is held forever (R3): what a pass leaves, the watch converges", () => {
  it("[3][14] a seat added for HubSpot's Sales User: the empty People cell fills via the converge", async () => {
    contact();
    w().hs.properties.sales_user = "777";
    w().hs.history.sales_user = [{ value: "777", timestamp: "2026-07-18T12:40:00.000Z", sourceType: "CRM_UI" }];
    w().ctxOwners = { "777": { name: "Joan Zhang", email: "joan@example.com" } };
    w().mondayUsers = { "joan@example.com": "999" };                         // her seat, added today
    note("2026-10-09T09:00:00.000Z", "2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] });
    expect(people(SALES), "left for the converge").toEqual([]);
    await advance("2026-10-09T09:00:30.000Z");
    expect(people(SALES), trail()).toEqual(["999"]);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });

  it("[3][14] a Lead Status option renamed in HubSpot: the label follows via the converge", async () => {
    contact({ extra: { hs_lead_status: "OPEN" } });
    setLeadStatus({ ...LEAD_STATUS_BASE, OPEN: "Open - contacted" });
    note("2026-10-09T09:00:00.000Z", "2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] });
    expect(cell(LEAD)).toBe("Open");
    await advance("2026-10-09T09:00:30.000Z");
    expect(cell(LEAD), trail()).toBe("Open - contacted");
  });

  it("[3] a second person added to a People cell (nothing to send): held at most W, then reset via the converge", async () => {
    contact();
    w().hs.properties.sales_user = "777";
    w().hs.history.sales_user = [{ value: "777", timestamp: "2026-07-18T12:40:00.000Z", sourceType: "CRM_UI" }];
    w().ctxOwners = { "777": { name: "Joan", email: "joan@example.com" }, "888": { name: "Ann", email: "ann@example.com" } };
    w().mondayUsers = { "joan@example.com": "999", "ann@example.com": "998" };
    w().card.column_values.find(c => c.id === SALES)!.persons_and_teams = [{ id: "999", kind: "person" }];
    w().changedAt[SALES] = Date.parse(S0);
    clock("2026-10-09T09:00:00.000Z");
    repPeople(SALES, ["999", "998"]);
    await mondayEdit("EDIT", [SALES]);                                         // the first person is unchanged: nothing sent
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    note("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:06.000Z", false] });
    expect(people(SALES), trail()).toEqual(["999", "998"]);                  // inside the window: held
    await advance("2026-10-09T09:03:30.000Z");
    expect(people(SALES), trail()).toEqual(["999"]);
  });

  it("a converge that finds a typed cell changed again moments ago holds it, re-anchored at its changed_at", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "6.Not in contact/Pending further contact", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });                  // read as our own echo: watched
    clock("2026-10-09T09:02:30.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA });   // again; its webhook lost
    await advance("2026-10-09T09:03:00.000Z");
    expect(cell(LIFE), trail()).toBe("5.No intention");                      // changed 30 s ago: held
    expect((await watchState())?.cells[LIFE]).toMatchObject({ fp: "5.No intention", since: Date.parse("2026-10-09T09:02:30.000Z"), typed: true });
    await advance("2026-10-09T09:05:29.000Z");
    expect(cell(LIFE), "not before its own window ends").toBe("5.No intention");
    await advance("2026-10-09T09:05:31.000Z");
    expect(cell(LIFE), trail()).toBe("1.NEW");                               // never pushed: converged back, visibly
  });

  it("[1] a died edit beside a pass that only forwards a named one-way change is still handed to the watch", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");          // its run died before it read anything
    clock("2026-10-09T09:00:02.000Z"); rep(LEAD, "In Progress");
    const atPatch = hold("EDIT-LEAD", "patch");
    const e = mondayEdit("EDIT-LEAD", [LEAD]);
    await reach(atPatch, e, "the Lead Status PATCH");
    note("2026-10-09T09:00:03.000Z", "2026-10-09T09:00:03.000Z");           // lands between its read and its PATCH
    w().mods.push("2026-10-09T09:00:05.000Z");
    clock("2026-10-09T09:00:05.000Z");
    atPatch.release(); await e;
    expect(syncState()).toBe("2026-10-09T09:00:05.000Z");
    clock("2026-10-09T09:00:07.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:03.000Z", false] });   // not newer: only LAD in play
    expect(cell(LAD)).toBe("2026-10-09");
    expect(cell(LIFE)).toBe("5.No intention");
    expect((await watchState())?.cells[LIFE], "the left two-way cell is watched").toBeDefined();
    await advance("2026-10-09T09:03:30.000Z");
    expect(cell(LIFE), trail()).toBe("1.NEW");                               // never pushed: converged back, visibly
  });

  it("[0] an adopted contact: the form's values converge to HubSpot's at +W, and the card leaves No Activity", async () => {
    contact({ hsId: "555001", itemId: "2860000001", created: "2026-05-01T00:00:00.000Z", synced: "2026-09-30T00:00:00.000Z",
      extra: { lifecyclestage: "opportunity", jobtitle: "Head of IT" } });
    clock("2026-10-09T09:00:00.000Z");
    w().card.column_values.find(c => c.id === w().spec.idCol)!.text = "";
    w().card.column_values.find(c => c.id === w().spec.syncStateCol)!.text = "";
    rep(LIFE, "1.NEW"); rep(JOB, "Buyer");
    w().card.created_at = now();
    hubspot.searchContactByEmail.mockResolvedValue({ id: "555001", modified: "2026-09-30T00:00:00.000Z" });
    await syncMondayItem(as("CREATE"), w().spec.boardId, w().card.id, live, { left: 30 }, false, false, undefined,
      { id: REP, byAutomation: false });
    expect(cell(w().spec.idCol)).toBe("555001");
    expect((await watchState())?.allAt).toBe(Date.parse("2026-10-09T09:03:00.000Z"));
    expect(stampNotes(), "the register has the adoption's stamp (§13: every gated stamp)").toEqual(["2026-09-30T00:00:00.000Z"]);
    note("2026-10-09T09:00:20.000Z", "2026-10-09T09:00:22.000Z");             // the rep logs a Note at once
    clock("2026-10-09T09:00:23.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:22.000Z", false] });
    expect(cell(LIFE), trail()).toBe("1.NEW");                               // inside the window: held
    expect(cell(JOB)).toBe("Buyer");
    await advance("2026-10-09T09:03:10.000Z");
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    expect(cell(JOB)).toBe("Head of IT");
    expect(w().card.group.id).toBe(ACTIVE);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
    expect(hubspot.patchRecord, "an adoption never pushes the form's values").not.toHaveBeenCalled();
    const converge = hubspot.getRecordWithHistory.mock.calls.find(c => W_.PASS(c[0]) === "QUEUE")!;
    expect(converge[4], "converge-all: the history of every two-way property")
      .toEqual(expect.arrayContaining(["lifecyclestage", "jobtitle", "hs_lead_status", "sales_user"]));
  });

  it("[0] an adopted contact with NO HubSpot event: the watch alone converges it", async () => {
    contact({ hsId: "555002", itemId: "2860000002", created: "2026-05-01T00:00:00.000Z", synced: "2026-09-30T00:00:00.000Z",
      extra: { lifecyclestage: "opportunity" } });
    clock("2026-10-09T09:00:00.000Z");
    w().card.column_values.find(c => c.id === w().spec.idCol)!.text = "";
    w().card.column_values.find(c => c.id === w().spec.syncStateCol)!.text = "";
    rep(LIFE, "1.NEW");
    w().card.created_at = now();
    hubspot.searchContactByEmail.mockResolvedValue({ id: "555002", modified: "2026-09-30T00:00:00.000Z" });
    await syncMondayItem(as("CREATE"), w().spec.boardId, w().card.id, live, { left: 30 }, false, false, undefined,
      { id: REP, byAutomation: false });
    await advance("2026-10-09T09:03:10.000Z");
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
    expect(await watchIdle()).toBe(true);
  });

  it("[11] a nameless company's domain changes in HubSpot: the card's name (its domain stem) follows", async () => {
    setWorld(makeWorld(accountsSpec(), { hsId: "777002", itemId: "2856777002", created: "2026-07-01T00:00:00.000Z",
      synced: "2026-07-01T00:05:00.000Z", props: { domain: "oldco.com" } }));
    expect(w().card.name).toBe("oldco");
    clock("2026-10-09T09:00:00.000Z");
    hubspotSets("domain", "newco.com", "2026-10-09T09:00:00.000Z");
    await hubspotPass("DOMAIN", { domain: ["2026-10-09T09:00:00.000Z", false] });
    expect(w().card.name, trail()).toBe("newco");
    expect(syncState()).toBe("2026-10-09T09:00:00.000Z");
  });

  it("[11] a NAMED company's domain change is no news for its name: a rename on its way survives it", async () => {
    setWorld(makeWorld(accountsSpec(), { hsId: "777003", itemId: "2856777003", created: "2026-07-01T00:00:00.000Z",
      synced: "2026-07-01T00:05:00.000Z", props: { name: "Acme", domain: "acme.com" } }));
    clock("2026-10-09T09:00:00.000Z"); repRename("Acme Holdings");
    hubspotSets("domain", "acme.co", "2026-10-09T09:00:01.000Z");
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("DOMAIN", { domain: ["2026-10-09T09:00:01.000Z", false] });
    expect(w().card.name, trail()).toBe("Acme Holdings");
    expect(monday.updateItem, "no name sent while a rename is on its way").not.toHaveBeenCalled();
  });

  it("[4] a held cell does not freeze OTHER typed columns: a HubSpot change, then a rep's edit of it, both survive", async () => {
    contact(); const s0 = syncState();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");          // its push is slow
    clock("2026-10-09T09:00:05.000Z");
    hubspotSets("hs_lead_status", "OPEN", "2026-10-09T09:00:05.000Z");        // a HubSpot workflow
    await hubspotPass("WF", { hs_lead_status: ["2026-10-09T09:00:05.000Z", false] });
    expect(cell(LEAD)).toBe("Open");
    expect(cell(LIFE)).toBe("5.No intention");
    expect(syncState(), "held: no stamp").toBe(s0);
    clock("2026-10-09T09:00:10.000Z"); rep(LEAD, "Unqualified");              // the rep, after the workflow
    note("2026-10-09T09:00:11.000Z", "2026-10-09T09:00:12.000Z");
    clock("2026-10-09T09:00:13.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:12.000Z", false] });
    expect(cell(LEAD), trail()).toBe("Unqualified");                         // monday changed it later: held
    w().mods.push("2026-10-09T09:00:15.000Z", "2026-10-09T09:00:16.000Z");
    await mondayEdit("EDIT-LEAD", [LEAD]);
    await mondayEdit("EDIT-LIFE", [LIFE]);
    expect(w().hs.properties.hs_lead_status).toBe("UNQUALIFIED");
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expectSyncStateNeverBackwards(s0);
  });

  it("[4] ...nor an UNTYPED column: a HubSpot change, then a rep's new value, both survive", async () => {
    contact({ extra: { jobtitle: "Engineer" } }); const s0 = syncState();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");          // its push is slow: Sync State stays
    clock("2026-10-09T09:00:05.000Z");
    hubspotSets("jobtitle", "Manager", "2026-10-09T09:00:05.000Z");
    await hubspotPass("HS-USER", { jobtitle: ["2026-10-09T09:00:05.000Z", false] });
    expect(cell(JOB)).toBe("Manager");
    expect(syncState()).toBe(s0);
    clock("2026-10-09T09:00:10.000Z"); rep(JOB, "Director");                 // the rep, after HubSpot's change
    note("2026-10-09T09:00:11.000Z", "2026-10-09T09:00:12.000Z");
    clock("2026-10-09T09:00:13.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:12.000Z", false] });
    expect(cell(JOB), trail()).toBe("Director");
    w().mods.push("2026-10-09T09:00:15.000Z");
    await mondayEdit("EDIT-JOB", [JOB]);
    expect(w().hs.properties.jobtitle).toBe("Director");
  });
});

// ===================================================================================================================
describe("everything else unchanged (R6), and the failure paths", () => {
  it("judge 2's rename window: a rename still on its way survives a Note's write (no name is sent)", async () => {
    setWorld(makeWorld(accountsSpec(), { hsId: "777001", itemId: "2856777001", created: "2026-07-01T00:00:00.000Z",
      synced: "2026-07-01T00:05:00.000Z", props: { name: "Acme", domain: "acme.example" } }));
    clock("2026-10-09T09:00:00.000Z"); repRename("Acme Holdings");
    hubspotSets("notes_last_updated", "2026-10-09T09:00:00.000Z", "2026-10-09T09:00:04.000Z", "CALCULATED");
    clock("2026-10-09T09:00:05.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:04.000Z", false] });
    expect(w().card.name, trail()).toBe("Acme Holdings");
    expect(monday.updateItem).not.toHaveBeenCalled();
    expect(monday.updateColumns).toHaveBeenCalled();
    w().mods.push("2026-10-09T09:00:08.000Z");
    await mondayEdit("RENAME", [], { name: true });
    expect(pushes()).toEqual([{ name: "Acme Holdings" }]);
    expect(w().card.name).toBe("Acme Holdings");
  });

  it("HubSpot's history unreadable: the recent edit is held, the rest written, Sync State stays", async () => {
    contact(); const s0 = syncState();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    w().historyFails = true;
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("SWEEP");                                               // unscoped: wants the history
    expect(logged(/action=history-unreadable/)).toBe(true);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(cell(LAD)).toBe("2026-10-09");
    expect(syncState()).toBe(s0);
    w().historyFails = false;
    w().mods.push("2026-10-09T09:00:05.000Z");
    await mondayEdit("EDIT", [LIFE]);
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(syncState()).toBe("2026-10-09T09:00:05.000Z");
  });

  it("HubSpot's history unreadable for an event whose source cannot be told: the cell is held, on one read, never a second", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z"); rep(JOB, "Buyer");                    // the rep's edit, on its way
    hubspotSets("jobtitle", "Manager", "2026-10-09T09:00:01.000Z", "INTEGRATION", OTHER_APP);
    w().historyFails = true;
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("APP", { jobtitle: ["2026-10-09T09:00:01.000Z", null] });
    expect(cell(JOB), trail()).toBe("Buyer");
    expect(historyReads(), "a read that failed is not asked again in the same pass").toBe(1);
  });

  it("a record gone from HubSpot by its history read: the pass skips, writes nothing, and never throws", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    hubspot.getRecordWithHistory.mockImplementationOnce(async () => null);   // deleted between the pass's two reads
    clock("2026-10-09T09:00:03.000Z");
    await expect(hubspotPass("SWEEP")).resolves.toBeTruthy();
    expect(logged(/action=skipped reason="the record is gone from HubSpot since this pass read it"/)).toBe(true);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(cell(LAD), "nothing written").toBe("");
  });

  it("a card gone by the pass's fresh read: the pass skips, writes nothing, and never throws", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    monday.getItemFresh.mockImplementationOnce(async () => null);
    clock("2026-10-09T09:00:03.000Z");
    await expect(hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] })).resolves.toBeTruthy();
    expect(logged(/action=skipped reason="the card is gone since this pass read it"/)).toBe(true);
    expect(cell(LAD), "nothing written").toBe("");
  });

  it("the cells' changed_at unreadable: every cell is judged as untyped -- the recent edit still held, the pass completes", async () => {
    contact(); const s0 = syncState();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    monday.getItemFresh.mockRejectedValueOnce(new Error("monday 500: boom"));
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] });
    expect(logged(/action=stamps-unreadable/)).toBe(true);
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(cell(LAD)).toBe("2026-10-09");
    expect(syncState(), "a held cell: no stamp").toBe(s0);
  });

  it("a backward move's clear left unfinished is repaired first, as HEAD does (repairDanglingClears)", async () => {
    contact({ extra: { lifecyclestage: "opportunity" } });
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");          // a backward move
    // Its run cleared HubSpot's stage (our own write) and died before the set followed.
    hubspotSets("lifecyclestage", "", "2026-10-09T09:00:02.000Z", "INTEGRATION", OWN);
    w().mods.push("2026-10-09T09:00:05.000Z");
    clock("2026-10-09T09:00:04.000Z");
    await hubspotPass("ECHO", { lifecyclestage: ["2026-10-09T09:00:02.000Z", true] });   // the clear's own echo
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(logged(/action=lifecycle-clear-repaired/)).toBe(true);
    expect(cell(LIFE)).toBe("5.No intention");
    expect(syncState()).toBe("2026-10-09T09:00:05.000Z");
  });

  it("a baseline Sync State that lands after a push's newer stamp is caught by the register and restored", async () => {
    contact();
    hubspotBumps("2026-10-09T09:00:01.000Z");                                 // HubSpot's own recalculation: nothing differs
    const atWrite = hold("BUMP", "write");
    clock("2026-10-09T09:00:02.000Z");
    const bump = hubspotPass("BUMP", {});                                     // read HubSpot (09:00:01) and the card...
    await reach(atWrite, bump, "the baseline stamp's write");
    clock("2026-10-09T09:00:03.000Z"); rep(JOB, "Buyer");
    w().mods.push("2026-10-09T09:00:04.000Z");
    await mondayEdit("EDIT", [JOB]);                                          // ...a push stamps its own, newer
    expect(syncState()).toBe("2026-10-09T09:00:04.000Z");
    clock("2026-10-09T09:00:05.000Z");
    atWrite.release(); await bump;                                            // the older baseline lands last
    expect(syncState(), "overtaken (monday has no compare-and-set)").toBe("2026-10-09T09:00:01.000Z");
    await advance("2026-10-09T09:00:07.000Z");
    expect(syncState(), trail()).toBe("2026-10-09T09:00:04.000Z");
    expect(logged(/\[sync-state\] .*action=restamped/)).toBe(true);
  });

  it("a stamp-only write (its one judged cell left alone by the loop breaker) goes to the register too", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z"); rep(JOB, "Buyer");
    const real = monday.updateColumns.getMockImplementation()!;
    monday.updateColumns.mockImplementation(async (env: unknown, b: string, i: string, cv: Record<string, unknown>, ...rest: unknown[]) =>
      real(env, b, i, cv[JOB] === "Engineer" ? { ...cv, [JOB]: "ENGINEER" } : cv, ...rest));
    await mondayEdit("SELF", [JOB], { selfOrigin: true });
    await advance("2026-10-09T09:03:10.000Z");                               // converged once: monday shows ENGINEER
    await mondayEdit("SELF-2", [JOB], { selfOrigin: true });
    await advance("2026-10-09T09:07:00.000Z");                               // ...and from then on left alone
    expect((await watchState())?.cells[JOB]?.stuckUntil).toBeDefined();
    hubspotBumps("2026-10-09T09:08:00.000Z");                                 // HubSpot's own recalculation
    const atWrite = hold("BUMP", "write");
    clock("2026-10-09T09:08:01.000Z");
    const bump = hubspotPass("BUMP", {});                                     // the stuck cell is all it judges: a stamp-only write
    await reach(atWrite, bump, "the stamp-only write");
    clock("2026-10-09T09:08:02.000Z"); rep(LIFE, "5.No intention");
    w().mods.push("2026-10-09T09:08:03.000Z");
    await mondayEdit("EDIT", [LIFE]);                                         // a push stamps its own, newer
    clock("2026-10-09T09:08:04.000Z");
    atWrite.release(); await bump;                                            // the older stamp lands last
    expect(syncState(), "overtaken").toBe("2026-10-09T09:08:00.000Z");
    await advance("2026-10-09T09:08:06.000Z");
    expect(syncState(), trail()).toBe("2026-10-09T09:08:03.000Z");
  });

  it("an edit pass that sends nothing never stamps past HubSpot's change it left: the next pass still sees it (no watch at all)", async () => {
    contact({ extra: { hs_lead_status: "NEW" } }); const s0 = syncState();
    hubspotSets("hs_lead_status", "OPEN", "2026-10-09T09:00:00.000Z");        // a HubSpot workflow; its webhook lost
    clock("2026-10-09T09:00:05.000Z"); rep(LIFE, "1.NEW");                   // the rep re-picks HubSpot's own value
    await syncMondayItem(noWatch("EDIT"), w().spec.boardId, w().card.id, live, { left: 30 }, false, false, { cols: [LIFE] },
      { id: REP, byAutomation: false });
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(cell(LEAD), "never written by the edit's pass").toBe("New");
    expect(syncState(), "no stamp past what it left").toBe(s0);
    clock("2026-10-09T09:00:10.000Z");
    await syncHubspotRecord(noWatch("SWEEP"), w().spec, w().hs.id, live, { left: 30 });
    expect(cell(LEAD), trail()).toBe("Open");
  });

  it("an edit pass never writes HubSpot's name over a rename still on its way, even when HubSpot is newer", async () => {
    setWorld(makeWorld(accountsSpec(), { hsId: "777005", itemId: "2856777005", created: "2026-07-01T00:00:00.000Z",
      synced: "2026-07-01T00:05:00.000Z", props: { name: "Acme", domain: "acme.example", city: "Paris" } }));
    const CITY = field(accountsSpec(), "city").col;
    clock("2026-10-09T09:00:00.000Z"); repRename("Acme Holdings");            // its own run is slow
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");             // HubSpot newer than Sync State
    clock("2026-10-09T09:00:03.000Z"); rep(CITY, "Lyon");
    w().mods.push("2026-10-09T09:00:04.000Z");
    await mondayEdit("EDIT-CITY", [CITY]);
    expect(pushes()).toEqual([{ city: "Lyon" }]);
    expect(w().card.name, trail()).toBe("Acme Holdings");
    expect(logged(/cols=name action=left-to-forward-pass/)).toBe(true);
  });

  it("a gated pass still moves a card between groups as HEAD does, for a spec mapping a property to groups", async () => {
    const spec = { ...contactsSpec(), groupBy: { prop: "hs_lead_status", map: { NEW: "g_new", OPEN: "g_open" }, reverse: false } } as ObjectSpec;
    setWorld(makeWorld(spec, { hsId: "382447", itemId: "2856382447", created: "2026-07-18T12:40:00.000Z", synced: S0, group: "g_new",
      props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead", hs_lead_status: "NEW" } }));
    hubspotSets("hs_lead_status", "OPEN", "2026-10-09T09:00:00.000Z");
    clock("2026-10-09T09:00:01.000Z");
    await hubspotPass("WF", { hs_lead_status: ["2026-10-09T09:00:00.000Z", false] }, spec);
    expect(cell(LEAD)).toBe("Open");
    expect(w().card.group.id, trail()).toBe("g_open");
    w().card.group.id = "g_new";                                              // dragged back by hand
    clock("2026-10-09T09:00:30.000Z");
    // A late duplicate of the event (HubSpot no newer than Sync State) still names the property behind the group.
    await hubspotPass("DUP", { hs_lead_status: ["2026-10-09T09:00:00.000Z", false] }, spec);
    expect(w().card.group.id, trail()).toBe("g_open");
  });

  it("an operator's forced /resync still forces (HubSpot authoritative, no gate, no history)", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    await syncHubspotRecord(as("RESYNC"), w().spec, w().hs.id, live, { left: 30 }, undefined, true);
    expect(cell(LIFE)).toBe("1.NEW");
    expect(historyReads()).toBe(0);
    expect(monday.getItemFresh).not.toHaveBeenCalled();
  });

  it("a refused edit: held from the forward pass beside it, healed by its own pass", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "Something typed");
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] });
    expect(cell(LIFE)).toBe("Something typed");
    await mondayEdit("EDIT", [LIFE]);
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(cell(LIFE)).toBe("1.NEW");
  });

  it("an automation still cannot claim: its value is held, then healed by its own pass", async () => {
    contact();
    w().hs.properties.sync_owner = ""; delete w().hs.history.sync_owner;
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "6.Not in contact/Pending further contact", { userId: "-4", uuid: false });
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("NOTE", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] });
    expect(cell(LIFE)).toBe("6.Not in contact/Pending further contact");
    await mondayEdit("AUTOMATION", [LIFE], { byAutomation: true });
    expect(hubspot.claimOwnership).not.toHaveBeenCalled();
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
    expect(cell(LIFE)).toBe("1.NEW");
    expect(w().card.group.id).toBe(NO_ACTIVITY);
  });

  it("a worked change from HubSpot releases the card from No Activity (forward pass)", async () => {
    contact();
    hubspotSets("lifecyclestage", "1029059095", "2026-10-09T09:00:00.000Z");
    clock("2026-10-09T09:00:01.000Z");
    await hubspotPass("HS-USER", { lifecyclestage: ["2026-10-09T09:00:00.000Z", false] });
    expect(cell(LIFE)).toBe("6.Not in contact/Pending further contact");
    expect(w().card.group.id).toBe(ACTIVE);
  });

  it("a gated write monday refuses for its rate limit is never sent late: the cells are due for a converge, which writes", async () => {
    contact();
    hubspotSets("lifecyclestage", "opportunity", "2026-10-09T09:00:00.000Z");
    w().rateLimitWrite = "HS-USER";
    clock("2026-10-09T09:00:01.000Z");
    await expect(hubspotPass("HS-USER", { lifecyclestage: ["2026-10-09T09:00:00.000Z", false] })).rejects.toThrow(/rate-limited/);
    expect(monday.updateColumns.mock.calls.at(-1)![5], "a gated write never waits on monday's rate limit").toBe(0);
    expect(logged(/action=write-rate-limited/)).toBe(true);
    expect(cell(LIFE)).toBe("1.NEW");
    expect((await watchState())?.cells[LIFE]?.due).toBeDefined();
    await advance("2026-10-09T09:00:30.000Z");
    expect(cell(LIFE), trail()).toBe("7.Intention to purchase");
  });

  it("the watch unreachable: holds stand, candidates are left, forwards proceed -- and nothing throws", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention");
    hubspotSets("jobtitle", "Manager", "2026-10-09T09:00:01.000Z");
    note("2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z");
    const env = as("NOTE") as unknown as { CREATE_IDEMPOTENCY: unknown };
    env.CREATE_IDEMPOTENCY = { idFromName: (n: string) => n, get: () => { throw new Error("DO unreachable"); } };
    clock("2026-10-09T09:00:03.000Z");
    await syncHubspotRecord(env as never, w().spec, w().hs.id,
      { ...live, scope: { props: { notes_last_updated: { at: Date.parse("2026-10-09T09:00:02.000Z"), own: false },
        jobtitle: { at: Date.parse("2026-10-09T09:00:01.000Z"), own: false } } } }, { left: 30 });
    expect(cell(LIFE)).toBe("5.No intention");
    expect(cell(JOB)).toBe("Manager");
    expect(cell(LAD)).toBe("2026-10-09");
    expect(logged(/action=watch-unreachable/)).toBe(true);
  });

  it("the loop breaker: a value monday renders differently is converged once, then left alone", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock("2026-10-09T09:00:00.000Z"); rep(JOB, "Buyer");
    const real = monday.updateColumns.getMockImplementation()!;
    monday.updateColumns.mockImplementation(async (env: unknown, b: string, i: string, cv: Record<string, unknown>, ...rest: unknown[]) =>
      real(env, b, i, cv[JOB] === "Engineer" ? { ...cv, [JOB]: "ENGINEER" } : cv, ...rest));
    await mondayEdit("SELF", [JOB], { selfOrigin: true });                  // read as our own echo: forward only -> watch
    expect((await watchState())?.cells[JOB]).toBeDefined();
    await advance("2026-10-09T09:03:10.000Z");
    expect(cell(JOB), trail()).toBe("ENGINEER");
    await mondayEdit("SELF-2", [JOB], { selfOrigin: true });                 // our echo of that write -> watch again
    const writes = monday.updateColumns.mock.calls.length;
    await advance("2026-10-09T09:07:00.000Z");
    expect(monday.updateColumns.mock.calls.length, "not written a second time").toBe(writes);
    expect(logged(/action=converge-stuck/)).toBe(true);
    expect((await watchState())?.cells[JOB]?.stuckUntil, "left alone for a day, not re-converged every few seconds")
      .toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
  });

  it("[2] an edit read as our own echo (no rescue: STALE_FORWARD_RETRY off) is put back by the watch after the window", async () => {
    contact(); const s0 = syncState();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "6.Not in contact/Pending further contact", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });                  // forward only, HubSpot not newer
    expect(cell(LIFE)).toBe("6.Not in contact/Pending further contact");
    expect((await watchState())?.cells[LIFE]).toBeDefined();
    await advance("2026-10-09T09:03:10.000Z");
    expect(cell(LIFE), trail()).toBe("1.NEW");
    expectSyncStateNeverBackwards(s0);
  });

  it("no DEFERRED_SYNC binding: the watch's alarm converges the card itself, inline", async () => {
    W_.setDeferredUnbound(true);
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "6.Not in contact/Pending further contact", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/action=converge-inline/)).toBe(true);
    expect(spilled).toEqual([]);
    expect(cell(LIFE), trail()).toBe("1.NEW");
  });

  it("a converge whose record is gone from HubSpot drops the card's watch (and writes nothing)", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    w().hs.id = "gone";
    await advance("2026-10-09T09:03:10.000Z");
    expect(cell(LIFE)).toBe("5.No intention");
    expect(await watchState()).toBeUndefined();
    expect(logged(/is gone from HubSpot: the watch is dropped/)).toBe(true);
  });

  it("a converge for a card with no watch (dropped meanwhile) does nothing, and never throws", async () => {
    contact();
    await expect(settleCardWatch(as("QUEUE"), w().spec.boardId, w().card.id, live, { left: 30 })).resolves.toMatch(/the card has no watch/);
    expect(historyReads()).toBe(0);
  });

  it("a converge after the switch was turned off drops the card's watch and writes nothing", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    expect(await watchState()).toBeDefined();
    setEnv({ STALE_FORWARD_GATE: "false" });
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/STALE_FORWARD_GATE is off for this board: the watch is dropped/)).toBe(true);
    expect(await watchState()).toBeUndefined();
    expect(cell(LIFE)).toBe("5.No intention");
  });

  it("a converge of a card no longer linked to a record drops its watch without reading HubSpot", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); const prev = W_.eventValue(LIFE); rep(LIFE, "5.No intention");
    w().failGetRecord = "HOOK";
    await W_.settleAll(await W_.mondayWebhook("HOOK", LIFE, prev, REP));     // its run dies: only its mark is left
    w().card.column_values.find(c => c.id === w().spec.idCol)!.text = "";   // unlinked meanwhile
    await advance("2026-10-09T09:01:05.000Z");                                // the lease ends: the cell is watched
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/the card is not linked to a HubSpot record: the watch is dropped/)).toBe(true);
    expect(hubspot.getRecordWithHistory).not.toHaveBeenCalled();
    expect(await watchState()).toBeUndefined();
  });

  it("a converge whose card is gone drops the watch, and never throws", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    monday.getItemFresh.mockImplementationOnce(async () => null);            // deleted from the board meanwhile
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/reason="the card is gone: the watch is dropped/)).toBe(true);
    expect(await watchState()).toBeUndefined();
    expect(w().trail.some(l => / threw: /.test(l)), trail()).toBe(false);
  });

  it("a converge whose card now shows another record drops the watch, and writes nothing from the old one", async () => {
    contact();
    clock("2026-10-09T09:00:00.000Z"); rep(LIFE, "5.No intention", { userId: ASK_ADA });
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });
    w().card.column_values.find(c => c.id === w().spec.idCol)!.text = "999999";   // re-linked by hand
    await advance("2026-10-09T09:03:10.000Z");
    expect(logged(/the card no longer shows contacts 382447: the watch is dropped/)).toBe(true);
    expect(cell(LIFE), trail()).toBe("5.No intention");
    expect(await watchState()).toBeUndefined();
  });

  it("[2] an Accounts rename by ask ada (never looked up): put back after the window, never rescued", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    setWorld(makeWorld(accountsSpec(), { hsId: "777001", itemId: "2856777001", created: "2026-07-01T00:00:00.000Z",
      synced: "2026-07-01T00:05:00.000Z", props: { name: "Acme", domain: "acme.example" } }));
    clock("2026-10-09T09:00:00.000Z"); repRename("Acme Holdings");
    await mondayEdit("SELF", [], { name: true, selfOrigin: true });
    expect(w().card.name).toBe("Acme Holdings");
    await advance("2026-10-09T09:03:10.000Z");
    expect(w().card.name, trail()).toBe("Acme");
    expect(hubspot.patchRecord).not.toHaveBeenCalled();
  });
});
