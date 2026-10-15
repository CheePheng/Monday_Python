import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import { PIPELINES } from "./fixtures/deal-pipelines";
import type { FieldSpec, ObjectSpec } from "../src/types";

/**
 * STALE_FORWARD_GATE / STALE_FORWARD_RETRY: WHAT HAD TO HOLD BEFORE THE RETRY COULD BE TURNED ON, each replayed through
 * the real engine (only HubSpot's and monday's I/O faked; the card's watch is the real Durable Object):
 *   [1] PROVENANCE. HubSpot records every write made with the CRM app's token under one sourceId -- this card's own
 *       push, but also an operator's script, the /app clear routes, the phone backfill, a DUPLICATE card's push. Only a
 *       version this card's own push explains is "not news"; every other one is a change like a person's: a retry or a
 *       rescue never sends an older person-set value back over it (EXP-A). Nothing this card cannot account for is
 *       pushed over (fail safe), a rescued edit is sent once, never in a loop, and with the retry off nothing changes.
 *   [2] THE SYNC STATE REGISTER IS DURABLE: an older stamp landing after a newer one is caught even when the watch's
 *       Durable Object was evicted between the two (EXP-G); the register cleans itself up after its window.
 *   [3] A CONVERGE THAT ALWAYS FAILS BACKS OFF, and is dead-lettered -- loudly, naming its cells -- only after a day of
 *       failures (EXP-C); one that fails for hours and then finishes heals its cell.
 *   [4] THE CREATE FILL asks the watch for marks BEFORE it re-reads the card, so its re-read is the last thing before
 *       its write (the remaining sub-second window is documented in sync.ts afterCreateWriteBack).
 *   [6] THE RETRY'S LINK CHECK: a mark from before an adoption is never re-sent, even when the adoption could not tell
 *       the watch -- monday's log dates the link, as for the rescue. A monday-born create's link is its READ: an edit
 *       made during its id write-back is the new record's, re-sent (retry) and rescued (the rescue) as such.
 * (The relation queue's marks, [5], are pinned in stale-forward-marks.test.ts.)
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
  OWN, ASK_ADA, REP, makeWorld, setWorld, installWorld, setEnv, as, live, clock, now, rep, hubspotSets, note, cell, syncState,
  hold, reach, hubspotPass, mondayEdit, mondayWebhook, settleAll, eventValue, advance, fireWatch, watchState, watchAlarmAt,
  logged, PASS, TYPED_LIVE,
} = W_;
const w = () => W_.w;
const pushes = () => W_.pushes(hubspot as never);
const trail = () => w().trail.join("\n");
const { specByObject } = await import("../src/config");
const { syncMondayItem } = await import("../src/sync");
const { uiActorTiming } = await import("../src/ui-actor");
const { resetPairedEchoes } = await import("../src/relation-edit");
const { CreateIdempotency } = await import("../src/create-idempotency-do");
const { crmStageDictsOf } = await import("../src/hubspot");
const CW = await import("../src/card-watch");

const ENVC = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const field = (spec: ObjectSpec, hs: string): FieldSpec => spec.fields.find(f => f.hs === hs)!;
const LIFE = field(CRM_CONTACTS, "lifecyclestage").col;
const JOB = field(CRM_CONTACTS, "jobtitle").col;
const EMAIL = field(CRM_CONTACTS, "email").col;
const contactsSpec = () => specByObject(ENVC, "contacts")!;
const dealsSpec = () => specByObject(ENVC, "deals")!;
const S0 = "2026-07-18T12:46:01.914Z";
const contact = (o: { extra?: Record<string, string>; typed?: string[] } = {}) =>
  setWorld(makeWorld(contactsSpec(), { hsId: "382447", itemId: "2856382447", created: "2026-07-18T12:40:00.000Z", synced: S0,
    props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead", ...(o.extra ?? {}) }, typed: o.typed }));
/** 2026-10-09 at `hh:mm:ss` or `hh:mm:ss.sss`, as ISO. */
const T = (hms: string) => `2026-10-09T${hms}${hms.includes(".") ? "" : ".000"}Z`;
const timing = { ...uiActorTiming };
const base = () => ({ boardId: w().spec.boardId, itemId: w().card.id, object: w().spec.object });

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
afterEach((c) => { W_.debugDump(c.task.name); Object.assign(uiActorTiming, timing); vi.restoreAllMocks(); vi.useRealTimers(); });

// ===================================================================================================================
describe("[1] provenance: our app's sourceId on a version THIS card did not write is news like a person's", () => {
  // EXP-A: an operator's fix made with the CRM app's own token (INTEGRATION, our sourceId), after a rep's edit was pushed.
  it.each([
    ["untyped Job Title", JOB, "jobtitle", "Buyer", "Buyer", "Director", "Director", undefined],
    ["typed Lifecycle", LIFE, "lifecyclestage", "7.Intention to purchase", "opportunity", "lead", "1.NEW", TYPED_LIVE],
  ] as const)("EXP-A %s: the converge never pushes the rep's older value back over it (STALE_FORWARD_RETRY on)",
    async (_n, col, prop, repValue, pushed, opsValue, opsShown, typed) => {
      setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
      contact({ extra: { jobtitle: "Engineer" }, typed: typed ? [...typed] : undefined });
      clock(T("08:30:00")); rep(col, repValue);                            // a rep's UI edit, pushed by its own run
      w().mods.push(T("08:30:02"));
      await mondayEdit("EDIT-0", [col]);
      expect(w().hs.properties[prop]).toBe(pushed);
      clock(T("09:00:00")); hubspotSets(prop, opsValue, T("09:00:00"), "INTEGRATION", OWN);   // an operator's script
      clock(T("09:00:01"));
      await hubspotPass("OPS", { [prop]: [T("09:00:00"), true] });         // its webhook: INTEGRATION, our sourceId
      w().mods.push(T("09:05:02"), T("09:05:03"));                         // what a wrong push would take
      await advance(T("09:05:00"));
      await advance(T("09:30:00"));
      expect(pushes(), "only the rep's own push, never the older value again\n" + trail()).toEqual([{ [prop]: pushed }]);
      expect(w().hs.properties[prop]).toBe(opsValue);
      expect(cell(col), "the card ends on the operator's value").toBe(opsShown);
      expect(logged(/action=rescued/)).toBe(false);
      expect(logged(/action=rescue-declined reason="HubSpot holds a later change/)).toBe(true);
    });

  it("EXP-A with STALE_FORWARD_RETRY off (the live configuration): as before -- the converge brings the operator's value", async () => {
    setEnv({ ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { jobtitle: "Engineer" } });
    clock(T("08:30:00")); rep(JOB, "Buyer");
    w().mods.push(T("08:30:02"));
    await mondayEdit("EDIT-0", [JOB]);
    clock(T("09:00:00")); hubspotSets("jobtitle", "Director", T("09:00:00"), "INTEGRATION", OWN);
    clock(T("09:00:01"));
    await hubspotPass("OPS", { jobtitle: [T("09:00:00"), true] });
    await advance(T("09:05:00"));
    await advance(T("09:30:00"));
    expect(pushes(), trail()).toEqual([{ jobtitle: "Buyer" }]);
    expect(cell(JOB)).toBe("Director");
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(logged(/action=rescue/)).toBe(false);
  });

  it("a mark's retry is superseded by our app's later write from another path (an operator's script; its webhook lost)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact({ extra: { jobtitle: "Engineer" }, typed: TYPED_LIVE });
    clock(T("09:00:00"));
    const prev = eventValue(JOB); rep(JOB, "Buyer");
    w().failGetRecord = "HOOK";                                            // the rep's run dies at its HubSpot read
    await settleAll(await mondayWebhook("HOOK", JOB, prev, REP));
    w().failGetRecord = undefined;
    expect((await watchState())?.marks[JOB]).toBeDefined();
    hubspotSets("jobtitle", "Director", T("09:00:10"), "INTEGRATION", OWN);  // 10 s after the edit, with our token
    w().mods.push(T("09:01:05"));
    await advance(T("09:01:01"));                                          // the lease: the retry
    await advance(T("09:10:00"));
    expect(logged(/action=edit-retry-superseded/), trail()).toBe(true);
    expect(pushes(), "the earlier edit is never sent over the later write").toEqual([]);
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(cell(JOB)).toBe("Director");
  });

  it("a DUPLICATE card's push of the same record is news for this card (its ledger is its own): never rescued over", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { jobtitle: "Engineer" } });
    clock(T("09:00:00")); rep(JOB, "Buyer", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [JOB], { selfOrigin: true });                  // misread as our echo: this card never sent it
    // A minute later another card of the same record (the Accounts board has an id on 11) pushes Director; ITS watch
    // records that write -- this card's does not.
    clock(T("09:01:00")); hubspotSets("jobtitle", "Director", T("09:01:00"), "INTEGRATION", OWN);
    const other = W_.namespace.get(`held:${w().spec.boardId}:2856399999`);
    await other.notePushes(Date.now(), { boardId: w().spec.boardId, itemId: "2856399999", object: "contacts", recordId: "382447" },
      [{ recordId: "382447", prop: "jobtitle", value: "Director", mod: Date.parse(T("09:01:00")), s: Date.now() - 300, e: Date.now() }]);
    clock(T("09:01:01"));
    await hubspotPass("DUP", { jobtitle: [T("09:01:00"), true] });
    w().mods.push(T("09:05:02"));
    await advance(T("09:05:00"));
    await advance(T("09:30:00"));
    expect(pushes(), "this card's older value is never sent over the duplicate's\n" + trail()).toEqual([]);
    expect(logged(/action=rescued/)).toBe(false);
    expect(logged(/action=rescue-declined reason="HubSpot holds a later change/)).toBe(true);
    expect(cell(JOB)).toBe("Director");
    expect(w().hs.properties.jobtitle).toBe("Director");
  });

  /** Edit A is pushed; edit B, made before A's push LANDS (so B's log row is older than A's HubSpot version), is misread
   *  as our own echo and never pushed by its run. */
  async function doubleEdit() {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { jobtitle: "Engineer" } });
    clock(T("09:00:00")); rep(JOB, "Buyer");
    w().mods.push(T("09:00:03"));
    const atPatch = hold("EDIT-A", "patch");
    const a = mondayEdit("EDIT-A", [JOB]);                                 // reads the card: Buyer
    await reach(atPatch, a, "edit A's PATCH");
    clock(T("09:00:01")); rep(JOB, "Director", { userId: ASK_ADA, uuid: true });   // edit B, while A's push is in flight
    clock(T("09:00:03")); atPatch.release(); await a;                      // HubSpot: Buyer, this card's push, 09:00:03
    clock(T("09:00:04"));
    await mondayEdit("SELF", [JOB], { selfOrigin: true });                  // B's run, misread as our echo: forward only
    expect(cell(JOB)).toBe("Director");
    w().mods.push(T("09:03:30"), T("09:03:31"));
  }

  it("this card's OWN push is not news: the double edit's later value is rescued and reaches HubSpot", async () => {
    await doubleEdit();
    await advance(T("09:03:20"));
    await advance(T("09:10:00"));
    expect(pushes(), trail()).toEqual([{ jobtitle: "Buyer" }, { jobtitle: "Director" }]);
    expect(w().hs.properties.jobtitle).toBe("Director");
    expect(cell(JOB)).toBe("Director");
    expect((await watchState())?.pushes?.map(p => `${p.prop}=${p.value}`), "both pushes are in the card's ledger")
      .toEqual(["jobtitle=Buyer", "jobtitle=Director"]);
  });

  it("every step of a backward move is this card's own (its clear and its set): the double edit's later value still reaches HubSpot", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { lifecyclestage: "opportunity" }, typed: TYPED_LIVE });
    clock(T("09:00:00")); rep(LIFE, "1.NEW");                              // A: a move BACK (opportunity -> lead)
    w().mods.push(T("09:00:03"), T("09:00:04"));                           // its clear, then its set
    const atClear = hold("EDIT-A", "patch");
    const a = mondayEdit("EDIT-A", [LIFE]);
    await reach(atClear, a, "edit A's clear");
    clock(T("09:00:01")); rep(LIFE, "5.No intention", { userId: ASK_ADA, uuid: true });   // B, before A lands
    clock(T("09:00:03")); atClear.release(); await a;
    expect(w().hs.history.lifecyclestage.map(v => v.value).slice(-2), "a clear, then the set").toEqual(["", "lead"]);
    clock(T("09:00:05"));
    await mondayEdit("SELF", [LIFE], { selfOrigin: true });                // B's run, misread as our echo
    w().mods.push(T("09:03:30"));
    await advance(T("09:03:20"));
    await advance(T("09:10:00"));
    expect(pushes().at(-1), trail()).toEqual({ lifecyclestage: "1029060900" });
    expect(w().hs.properties.lifecyclestage).toBe("1029060900");
    expect(cell(LIFE)).toBe("5.No intention");
  });

  it("FAIL SAFE: a push the ledger could not record reads as someone else's -- nothing is pushed over it; the cell converges", async () => {
    const lost = vi.spyOn(CreateIdempotency.prototype, "notePushes").mockRejectedValueOnce(new Error("DO unreachable"));
    await doubleEdit();
    expect(lost).toHaveBeenCalledTimes(1);
    await advance(T("09:03:20"));
    await advance(T("09:10:00"));
    expect(pushes(), "B is never sent on a version the card cannot account for\n" + trail()).toEqual([{ jobtitle: "Buyer" }]);
    expect(cell(JOB), "visibly converged to HubSpot").toBe("Buyer");
    expect(w().hs.properties.jobtitle).toBe("Buyer");
  });

  it("no loop: an edit rescued once whose push HubSpot stores otherwise is not rescued (or pushed) again", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    contact({ extra: { concrete_demand: "Needs 10 seats" } });             // a long-text cell carries changed_at (typed)
    const DEMAND = field(CRM_CONTACTS, "concrete_demand").col;
    const real = hubspot.patchRecord.getMockImplementation()!;
    hubspot.patchRecord.mockImplementation(async (env: unknown, s: unknown, id: string, patch: Record<string, string>, ...rest: unknown[]) => {
      const mod = await (real as any)(env, s, id, patch, ...rest);
      if (patch.concrete_demand) {                                         // HubSpot keeps it in capitals
        w().hs.properties.concrete_demand = patch.concrete_demand.toUpperCase();
        const h = w().hs.history.concrete_demand; h[h.length - 1].value = patch.concrete_demand.toUpperCase();
      }
      return mod;
    });
    clock(T("09:00:00")); rep(DEMAND, "Needs 20 seats", { userId: ASK_ADA, uuid: true });
    await mondayEdit("SELF", [DEMAND], { selfOrigin: true });               // misread as our echo: watched, never pushed
    w().mods.push(T("09:03:20"), T("09:20:00"), T("09:40:00"));
    await advance(T("09:03:10"));                                          // rescued and retried: HubSpot holds it in capitals
    expect(pushes(), trail()).toEqual([{ concrete_demand: "Needs 20 seats" }]);
    expect(w().hs.properties.concrete_demand).toBe("NEEDS 20 SEATS");
    for (const [echo, then] of [["09:03:25", "09:07:00"], ["09:20:05", "09:24:00"]] as const) {
      clock(T(echo));                                                      // the push's echo, and a later HubSpot event
      await hubspotPass(`ECHO-${echo}`, { concrete_demand: [T("09:03:20"), true] });
      await advance(T(then));
    }
    await advance(T("09:45:00"));
    expect(pushes(), "sent once -- never again in a loop\n" + trail()).toEqual([{ concrete_demand: "Needs 20 seats" }]);
    expect(cell(DEMAND), "the card shows what HubSpot holds").toBe("NEEDS 20 SEATS");
  });

  it("STALE_FORWARD_RETRY off (the live configuration): a push records nothing -- the edit path is unchanged", async () => {
    contact();
    const ledger = vi.spyOn(CreateIdempotency.prototype, "notePushes");
    clock(T("09:00:00")); rep(LIFE, "5.No intention");
    w().mods.push(T("09:00:02"));
    await mondayEdit("EDIT", [LIFE]);
    expect(pushes()).toEqual([{ lifecyclestage: "1029060900" }]);
    expect(ledger, "no ledger RPC").not.toHaveBeenCalled();
    expect((await watchState())?.pushes).toBeUndefined();
  });

  it("STALE_FORWARD_RETRY on: the push lands in the card's ledger with HubSpot's modified time", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact();
    clock(T("09:00:00")); rep(LIFE, "5.No intention");
    w().mods.push(T("09:00:02"));
    await mondayEdit("EDIT", [LIFE]);
    expect((await watchState())?.pushes).toEqual([expect.objectContaining({ recordId: "382447", prop: "lifecyclestage",
      value: "1029060900", mod: Date.parse(T("09:00:02")) })]);
  });
});

// ===================================================================================================================
describe("[2] the Sync State register is durable (EXP-G)", () => {
  it("an older stamp landing after a newer one is caught even when the watch's Durable Object was evicted in between", async () => {
    contact();
    const L1 = T("08:21:26.732"), N1 = T("08:21:32.807");
    note(T("08:21:20.172"), L1);
    clock(T("08:21:26.900"));
    const atWrite = hold("NOTE", "write");
    const run = hubspotPass("NOTE", { notes_last_updated: [L1, false] });
    await reach(atWrite, run, "the Note pass's monday write");
    clock(T("08:21:27.004")); rep(LIFE, "5.No intention");
    w().mods.push(N1);
    await mondayEdit("EDIT", [LIFE]);                                      // the newer stamp, noted
    expect(syncState()).toBe(N1);
    // Evicted while idle: a fresh instance of the watch's Durable Object, over the same storage.
    const o = W_.doObjects.get(W_.watchKey());
    W_.doObjects.set(W_.watchKey(), new (CreateIdempotency as any)(o.ctx, o.env));
    clock(T("08:22:30"));
    atWrite.release(); await run;                                          // the older stamp lands last
    expect(syncState(), "overtaken (monday has no compare-and-set)").toBe(L1);
    expect(logged(/action=verify-queued/), trail()).toBe(true);
    clock(T("08:22:32"));
    expect(await fireWatch()).toBe(true);
    expect(syncState(), trail()).toBe(N1);
  });

  it("the register's notes live in the Durable Object's storage for their window, and are then cleaned up", async () => {
    contact();
    hubspotSets("notes_last_updated", T("08:59:00"), T("08:59:05"), "CALCULATED");
    clock(T("09:00:00"));
    await hubspotPass("NOTE", { notes_last_updated: [T("08:59:05"), false] });
    const o = W_.doObjects.get(W_.watchKey());
    expect(o.ctx.map.get("stampNotes")?.map((n: { ts: string }) => n.ts)).toEqual([T("08:59:05")]);
    expect(watchAlarmAt(), "the register's own cleanup").toBe(Date.parse(T("09:00:00")) + CW.STAMP_NOTE_WINDOW_MS);
    await advance(new Date(Date.parse(T("09:00:00")) + CW.STAMP_NOTE_WINDOW_MS + 1_000).toISOString());
    expect(o.ctx.map.size, "nothing left behind").toBe(0);
    expect(watchAlarmAt()).toBeNull();
  });
});

// ===================================================================================================================
describe("[3] a converge that always fails backs off, and is dead-lettered only after a day of failures (EXP-C)", () => {
  /** Time, in ten-minute steps from 09:03:10, up to `hours` after it (each call goes on from where the last one ended). */
  const clockFrom = () => {
    let k = 0;
    return async (hours: number) => {
      const start = Date.parse(T("09:03:10"));
      for (; k <= hours * 6; k++) await advance(new Date(start + k * 10 * 60_000).toISOString());
    };
  };

  it("a value monday never takes: a handful of converges in six hours (not one every ten minutes); a loud dead-letter after a day", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock(T("09:00:00")); rep(JOB, "Buyer", { userId: ASK_ADA, uuid: false });   // read as our echo: watched, never pushed
    await mondayEdit("SELF", [JOB], { selfOrigin: true });
    const real = monday.updateColumns.getMockImplementation()!;
    monday.updateColumns.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === "QUEUE") throw new Error("monday 200: ColumnValueException (a value monday will never take)");
      return (real as any)(env, ...rest);
    });
    const runs = () => hubspot.getRecordWithHistory.mock.calls.filter(c => PASS(c[0]) === "QUEUE").length;
    const run = clockFrom();
    await run(6);
    expect(runs(), trail()).toBeGreaterThan(0);
    expect(runs(), "backed off: 37 ten-minute re-queues before (EXP-C), nine with the old cap").toBeLessThanOrEqual(8);
    expect(logged(/action=converge-dead-letter/), "six hours of failures is not a day").toBe(false);
    expect((await watchState())?.cells[JOB], "still watched").toBeDefined();
    await run(26);
    expect(logged(new RegExp(`cols=${JOB} action=converge-dead-letter`))).toBe(true);
    expect(Object.keys((await watchState())?.cells ?? {}), "the cell is no longer watched").toEqual([]);
    expect(cell(JOB), "left as it is (the card's next HubSpot event judges it again)").toBe("Buyer");
  });

  it("a converge that fails for hours and then finishes heals the cell: never dead-lettered", async () => {
    contact({ extra: { jobtitle: "Engineer" } });
    clock(T("09:00:00")); rep(JOB, "Buyer", { userId: ASK_ADA, uuid: false });
    await mondayEdit("SELF", [JOB], { selfOrigin: true });
    const real = monday.updateColumns.getMockImplementation()!;
    let fails = 8;                                                         // the old cap's eight, now spread over hours
    monday.updateColumns.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === "QUEUE" && fails-- > 0) throw new Error("monday 500: unavailable");
      return (real as any)(env, ...rest);
    });
    await clockFrom()(23);
    expect(cell(JOB), trail()).toBe("Engineer");
    expect(logged(/action=converge-dead-letter/)).toBe(false);
  });
});

// ===================================================================================================================
describe("[4] the monday-born create fill asks the watch first, then re-reads the card, then writes", () => {
  it("the probe precedes the re-read: the re-read is the last thing before the fill's write", async () => {
    setEnv({ STAGE_COARSE_REVERSE: "true", ASK_ADA_UI_EDITS: "true", CREATE_WINDOW_REPLAY: "false" });
    const spec = bornDeal();
    const probe = vi.spyOn(CreateIdempotency.prototype, "watchCells");
    clock(T("09:00:01.500"));
    await syncMondayItem(as("CREATE"), spec.boardId, w().card.id, live, { left: 30 }, false, false, { cols: [AMOUNT] },
      { id: REP, byAutomation: false });
    expect(logged(/action=create-filled/), trail()).toBe(true);
    const reread = monday.getItemFresh.mock.calls.findIndex(c => PASS(c[0]) === "CREATE" && c[3] === 0);
    expect(reread, "the fill re-read the card").toBeGreaterThanOrEqual(0);
    const allProbe = probe.mock.calls.findIndex(c => (c[4] as { all?: boolean })?.all);
    expect(probe.mock.invocationCallOrder[allProbe], "the watch is asked before the re-read")
      .toBeLessThan(monday.getItemFresh.mock.invocationCallOrder[reread]);
  });
});

// ===================================================================================================================
const DICTS = crmStageDictsOf(PIPELINES as never);
const COARSE = "deal_stage", EXACT = "dropdown_mm7624zd", AMOUNT = "deal_value";
const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };
/** A brand-new Deals card a rep is filling (an automation set New), created in HubSpot at 09:00:01. */
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
    for (const [p, v] of Object.entries(props)) w().hs.history[p] = [{ value: v, timestamp: at, sourceType: "INTEGRATION", sourceId: OWN }];
    return { id: "9002", modified: at };
  });
  return spec;
}

describe("[6] the retry's link check: what the card showed before it was linked is never re-sent", () => {
  /** An existing HubSpot contact (opportunity), and a brand-new monday card a rep is filling. */
  function adoptionWorld() {
    setWorld(makeWorld(contactsSpec(), { hsId: "555001", itemId: "2860000001", created: "2026-05-01T00:00:00.000Z",
      synced: "2026-09-30T00:00:00.000Z", props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com",
        lifecyclestage: "opportunity", jobtitle: "Head of IT" }, typed: TYPED_LIVE }));
    for (const c of w().card.column_values)
      if ([w().spec.idCol, w().spec.syncStateCol, LIFE, JOB, EMAIL].includes(c.id)) { c.text = ""; if ("status_index" in c) c.status_index = null; }
    delete w().changedAt[LIFE];
    clock(T("09:00:00"));
    w().card.created_at = now(); w().card.updated_at = now();
    hubspot.searchContactByEmail.mockResolvedValue({ id: "555001", modified: "2026-09-30T00:00:00.000Z" });
    hubspot.claimOwnership.mockImplementation(async () => { w().trail.push("CLAIM ATTEMPTED"); return "2026-10-09T09:03:29.000Z"; });
    w().mods.push(T("09:03:30"), T("09:03:31"), T("09:03:32"), T("09:03:33"));
  }

  it("a pre-adoption mark whose run died, when the adoption could not tell the watch: monday's log dates the link", async () => {
    adoptionWorld(); setEnv(LIVE);
    clock(T("09:00:05")); rep(LIFE, "1.NEW");
    // Its webhook's run died before it resolved: only its mark is left (as the webhook makes it).
    await W_.namespace.get(W_.watchKey()).markEdits(Date.now(), base(), [{ key: LIFE, at: Date.now(), rx: Date.now(), actor: REP }]);
    const once = vi.spyOn(CreateIdempotency.prototype, "watchCells").mockRejectedValueOnce(new Error("DO unreachable"));
    clock(T("09:00:20"));
    const prev = eventValue(EMAIL); rep(EMAIL, "pat@example.com");
    await settleAll(await mondayWebhook("HOOK-EMAIL", EMAIL, prev, REP));
    expect(once, "the adoption's watch call failed").toHaveBeenCalled();
    expect(cell(w().spec.idCol)).toBe("555001");
    expect((await watchState())?.linkedAt, "the watch never learnt the link").toBeUndefined();
    await advance(T("09:01:10"));                                         // the mark's lease: a retry would re-send it
    await advance(T("09:10:00"));
    expect(logged(/action=edit-retried/), trail()).toBe(false);
    expect(logged(new RegExp(`cols=${LIFE} action=edit-retry-abandoned reason="made before the card was linked`))).toBe(true);
    expect(pushes(), "an adoption never pushes the form's values").toEqual([]);
    expect(hubspot.claimOwnership, "never claims").not.toHaveBeenCalled();
    expect(cell(LIFE), "converged to HubSpot's").toBe("7.Intention to purchase");
  });

  it("the monday log unreadable: the retry sends nothing on that uncertainty (the mark stays, and is retried)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    contact();
    clock(T("09:00:00"));
    const prev = eventValue(LIFE); rep(LIFE, "5.No intention");
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", LIFE, prev, REP));
    w().failGetRecord = undefined;
    w().logFails = true;
    await advance(T("09:01:01"));
    expect(pushes(), trail()).toEqual([]);
    expect((await watchState())?.marks[LIFE], "kept for its next try").toBeDefined();
    w().logFails = false;
    w().mods.push(T("09:02:05"));
    await advance(T("09:02:02"));
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029060900" }]);
  });

  /** The rep picks a HubSpot Stage while the create's id write-back is in flight (its write lands at 09:00:02). */
  async function pickDuringWriteBack(who: { userId?: string; uuid?: boolean } = {}) {
    setEnv({ STAGE_COARSE_REVERSE: "true", ASK_ADA_UI_EDITS: "true", CREATE_WINDOW_REPLAY: "false", STALE_FORWARD_RETRY: "true" });
    const spec = bornDeal();
    const atWriteBack = hold("CREATE", "write");
    clock(T("09:00:01.500"));
    const create = syncMondayItem(as("CREATE"), spec.boardId, w().card.id, live, { left: 30 }, false, false, { cols: [AMOUNT] },
      { id: REP, byAutomation: false });
    await reach(atWriteBack, create, "the create's id write-back");
    clock(T("09:00:02"));
    const prev = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent, who);
    atWriteBack.release();
    await create;
    expect(cell(EXACT), trail()).toBe(DICTS.stages.contractsent);
    return { spec, prev };
  }

  it("a monday-born create's link is its READ: a pick during its write-back whose run died is re-sent (not given up)", async () => {
    const { prev } = await pickDuringWriteBack();
    clock(T("09:00:03"));
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", EXACT, prev, REP, { changedAt: Date.parse(T("09:00:02")) }));
    w().failGetRecord = undefined;
    expect((await watchState())?.marks[EXACT]).toBeDefined();
    w().mods.push(T("09:01:06"), T("09:01:07"));
    await advance(T("09:01:05"));
    await advance(T("09:10:00"));
    expect(logged(/action=edit-retry-abandoned/), trail()).toBe(false);
    expect(w().hs.properties.dealstage, trail()).toBe("contractsent");
    expect(cell(EXACT)).toBe(DICTS.stages.contractsent);
  });

  it("the create's own versions are this card's: a pick made DURING the create call (before HubSpot stamped them) is re-sent", async () => {
    setEnv({ STAGE_COARSE_REVERSE: "true", ASK_ADA_UI_EDITS: "true", CREATE_WINDOW_REPLAY: "false", STALE_FORWARD_RETRY: "true" });
    const spec = bornDeal();
    const made = hubspot.createRecord.getMockImplementation()!;
    let prev: unknown;
    hubspot.createRecord.mockImplementation(async (...args: unknown[]) => {
      clock(T("09:00:00.800"));                                            // HubSpot is still making the record
      prev = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
      clock(T("09:00:01.200"));
      return (made as any)(...args);                                       // its versions: 09:00:01, after the pick
    });
    clock(T("09:00:00.500"));
    await syncMondayItem(as("CREATE"), spec.boardId, w().card.id, live, { left: 30 }, false, false, { cols: [AMOUNT] },
      { id: REP, byAutomation: false });
    expect(cell(EXACT), "the fill left the pick alone\n" + trail()).toBe(DICTS.stages.contractsent);
    clock(T("09:00:02"));
    w().failGetRecord = "HOOK";
    await settleAll(await mondayWebhook("HOOK", EXACT, prev, REP, { changedAt: Date.parse(T("09:00:00.800")) }));
    w().failGetRecord = undefined;
    w().mods.push(T("09:01:06"), T("09:01:07"));
    await advance(T("09:01:05"));
    await advance(T("09:10:00"));
    expect(logged(/action=edit-retry-superseded/), trail()).toBe(false);
    expect(w().hs.properties.dealstage).toBe("contractsent");
    expect(cell(EXACT)).toBe(DICTS.stages.contractsent);
  });

  it("...and the same pick misread as our echo is RESCUED (the id write-back is the create's own link write)", async () => {
    await pickDuringWriteBack({ userId: ASK_ADA, uuid: true });
    clock(T("09:00:03"));
    await syncMondayItem(as("SELF"), dealsSpec().boardId, w().card.id, live, { left: 30 }, false, true, { cols: [EXACT] },
      { id: ASK_ADA, byAutomation: false });                              // misread as our own echo: forward only
    w().mods.push(T("09:03:20"), T("09:03:21"));
    await advance(T("09:03:10"));
    await advance(T("09:10:00"));
    expect(logged(/\[converge\] .*action=rescued/), trail()).toBe(true);
    expect(w().hs.properties.dealstage).toBe("contractsent");
    expect(cell(EXACT)).toBe(DICTS.stages.contractsent);
  });
});
