import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PIPELINES } from "./fixtures/deal-pipelines";

/**
 * STALE_FORWARD_GATE ON DEALS: the native coarse Stage while STAGE_COARSE_REVERSE makes a person's edit of it two-way
 * (finding [6]: P1, P3, P4), automation 31010016's "New" (corrected at HEAD's timing, never by the watch), and a
 * monday-born deal (finding [12]: Pipeline and the default Stage at once; a fill that fails never fails the create).
 * Same world as stale-forward-gate.test.ts (test/fixtures/stale-forward-world.ts).
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
  REP, makeWorld, setWorld, installWorld, setEnv, as, live, clock, now, rep, hubspotSets, cell, syncState, hold, reach,
  hubspotPass, mondayEdit, advance, watchState, watchIdle, logged,
} = W_;
const w = () => W_.w;
const pushes = () => W_.pushes(hubspot as never);
const { specByObject } = await import("../src/config");
const { syncMondayItem } = await import("../src/sync");
const { crmStageDictsOf } = await import("../src/hubspot");
const { lookupCard } = await import("../src/card-registry");

const DICTS = crmStageDictsOf(PIPELINES as never);
const COARSE = "deal_stage", EXACT = "dropdown_mm7624zd", PIPE = "dropdown_mm76s7kk", AMOUNT = "deal_value";
const SALES = "multiple_person_mm7df31a";                                    // Deals' Sales User (two-way People)
const PROB = "deal_close_probability";
const ENVD = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const dealsSpec = () => specByObject(ENVD, "deals")!;
const trail = () => w().trail.join("\n");
const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };

function deal(stage: string, synced: string) {
  const ww = setWorld(makeWorld(dealsSpec(), { hsId: "9001", itemId: "5551", created: "2026-09-01T00:00:00.000Z", synced,
    group: "topics", labels: LABELS,
    props: { dealname: "Acme renewal", dealstage: stage, pipeline: DICTS.pipelineByStage[stage], amount: "1000",
      hs_v2_date_entered_current_stage: "2026-09-01T00:00:00.000Z" } }));
  ww.onPatch = (patch, mod) => { if (patch.dealstage) w().hs.properties.hs_v2_date_entered_current_stage = mod; };
  return ww;
}
/** Every write of `col` to `text` the Worker made (from the trail). */
const writesOf = (col: string, text: string) => w().trail.filter(l => !/ REP /.test(l) && l.includes(` ${col}: `) && l.endsWith(`-> ${JSON.stringify(text)}`)).length;
/** Wait until a pass started inside a webhook's waitUntil reaches a hold. */
async function reachIn(g: { reached: Promise<void> }, waits: Promise<unknown>[], what: string): Promise<void> {
  await Promise.race([g.reached, Promise.allSettled(waits).then(() => { throw new Error(`${what} was never reached`); })]);
}
/** The card watch's in-memory Sync State notes (the register, §13). */
const stampNotes = () => ((W_.doObjects.get(W_.watchKey()) ?? {}) as { stampNotes?: { ts: string }[] }).stampNotes?.map(n => n.ts) ?? [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock("2026-10-09T09:00:00.000Z");
  vi.clearAllMocks();
  installWorld(monday as never, hubspot as never);
  setEnv({ STAGE_COARSE_REVERSE: "true" });
  hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
  assoc.syncAssociations.mockResolvedValue(undefined);
  assoc.reverseAssociations.mockResolvedValue(undefined);
  assoc.convergeRelationCell.mockResolvedValue("matched");
});
afterEach((c) => { W_.debugDump(c.task.name); vi.useRealTimers(); });

describe("[6] the coarse Stage while STAGE_COARSE_REVERSE is on", () => {
  it("P1: an email's forward pass BEFORE the rep's run reads the card holds the rep's Won; the run sends closedwon", async () => {
    deal("contractsent", "2026-09-29T02:00:00.000Z");
    expect(cell(COARSE)).toBe("Negotiation");
    clock("2026-10-09T09:00:00.000Z"); rep(COARSE, "Won");
    hubspotSets("notes_last_updated", "2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z", "CALCULATED");
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("EMAIL", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] });
    expect(cell(COARSE), trail()).toBe("Won");
    expect((await watchState())?.cells[COARSE], "held, as it was judged: seen while HubSpot was newer")
      .toMatchObject({ fp: "Won", typed: true, newer: true });
    w().mods.push("2026-10-09T09:00:05.000Z");
    await mondayEdit("EDIT", [COARSE]);
    expect(w().hs.properties.dealstage, trail()).toBe("closedwon");
    expect(cell(COARSE)).toBe("Won");
    expect(cell(EXACT)).toBe(DICTS.stages.closedwon);
    await advance("2026-10-09T09:03:10.000Z");                              // its hold ends: in line, nothing to write
    expect(cell(COARSE)).toBe("Won");
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
    expect(writesOf(COARSE, "Won"), "Won is written by nobody but the rep").toBe(0);
  });

  it("P3: the rep's run reads the card first and is held at its PATCH while the email's pass runs", async () => {
    deal("contractsent", "2026-09-29T02:00:00.000Z");
    clock("2026-10-09T09:00:00.000Z"); rep(COARSE, "Won");
    w().mods.push("2026-10-09T09:00:05.000Z");
    const atPatch = hold("EDIT", "patch");
    const edit = mondayEdit("EDIT", [COARSE]);
    await reach(atPatch, edit, "the Stage PATCH");
    hubspotSets("notes_last_updated", "2026-10-09T09:00:01.000Z", "2026-10-09T09:00:02.000Z", "CALCULATED");
    clock("2026-10-09T09:00:03.000Z");
    await hubspotPass("EMAIL", { notes_last_updated: ["2026-10-09T09:00:02.000Z", false] });
    expect(cell(COARSE), trail()).toBe("Won");
    clock("2026-10-09T09:00:05.000Z");
    atPatch.release(); await edit;
    expect(w().hs.properties.dealstage).toBe("closedwon");
    expect(cell(COARSE), trail()).toBe("Won");
    expect(cell(EXACT)).toBe(DICTS.stages.closedwon);
    expect(writesOf(COARSE, "Won"), "the board's Won automations run once: no second Won by our token").toBe(0);
  });

  it("P4: the rep's Amount edit a second later (a card behind HubSpot) never writes Negotiation over the pending Won", async () => {
    deal("contractsent", "2026-09-29T02:00:00.000Z");
    hubspotSets("notes_last_updated", "2026-10-09T08:59:00.000Z", "2026-10-09T08:59:00.000Z", "CALCULATED");
    clock("2026-10-09T09:00:00.000Z"); rep(COARSE, "Won");
    clock("2026-10-09T09:00:01.000Z"); rep(AMOUNT, "2000");
    w().mods.push("2026-10-09T09:00:03.000Z", "2026-10-09T09:00:05.000Z");
    clock("2026-10-09T09:00:02.000Z");
    await mondayEdit("EDIT-AMOUNT", [AMOUNT]);
    expect(cell(COARSE), trail()).toBe("Won");
    // Left by the Amount run, and handed to the watch as seen while HubSpot was newer (HEAD's word for it) -- whose
    // converge judges it per cell: the rep's Won is recent, so it is held, never overwritten with Negotiation.
    expect((await watchState())?.cells[COARSE]).toMatchObject({ newer: true });
    await advance("2026-10-09T09:00:40.000Z");
    expect(cell(COARSE), trail()).toBe("Won");
    await mondayEdit("EDIT-STAGE", [COARSE]);
    expect(w().hs.properties.dealstage, trail()).toBe("closedwon");
    expect(w().hs.properties.amount).toBe("2000");
    expect(writesOf(COARSE, "Negotiation")).toBe(0);
  });

  it("[F11] 31010016's New on a Won deal: held while recent, then corrected ONCE when its hold ends (HubSpot was newer: HEAD's word), never again", async () => {
    deal("closedwon", "2026-09-29T02:00:00.000Z");
    clock("2026-10-09T09:00:00.000Z"); rep(COARSE, "New", { userId: "-4", uuid: false });
    hubspotSets("notes_last_updated", "2026-10-09T09:00:01.000Z", "2026-10-09T09:00:01.000Z", "CALCULATED");
    clock("2026-10-09T09:00:02.000Z");
    await hubspotPass("ASSOC", { notes_last_updated: ["2026-10-09T09:00:01.000Z", false] });
    expect(cell(COARSE)).toBe("New");                                        // held: no Won write inside W
    expect((await watchState())?.cells[COARSE], "watched, seen while HubSpot was newer").toMatchObject({ newer: true });
    await advance("2026-10-09T09:02:59.000Z");
    expect(cell(COARSE), "not before its hold ends").toBe("New");
    await advance("2026-10-09T09:03:10.000Z");                              // the hold ends: no other event needed
    expect(cell(COARSE), trail()).toBe("Won");
    expect(writesOf(COARSE, "Won")).toBe(1);
    hubspotSets("notes_last_updated", "2026-10-09T09:30:00.000Z", "2026-10-09T09:30:00.000Z", "CALCULATED");
    clock("2026-10-09T09:30:01.000Z");
    await hubspotPass("LATER", { notes_last_updated: ["2026-10-09T09:30:00.000Z", false] });
    clock("2026-10-09T09:31:00.000Z");
    await hubspotPass("AGAIN", {});
    await advance("2026-10-09T10:00:00.000Z");
    expect(writesOf(COARSE, "Won"), "exactly once").toBe(1);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });
});

describe("the coarse Stage keeps HEAD's timing", () => {
  it("a pass in which HubSpot is NOT newer leaves a coarse candidate as it is, even when its events name the stage", async () => {
    deal("closedwon", "2026-10-09T09:00:05.000Z");
    clock("2026-10-09T09:00:00.000Z"); rep(COARSE, "New", { userId: "-4", uuid: false });
    clock("2026-10-09T09:10:00.000Z");                                       // long past W: a candidate
    await hubspotPass("LATE-DUP", { dealstage: ["2026-10-09T08:00:00.000Z", false] });   // a late duplicate, not newer
    expect(cell(COARSE), trail()).toBe("New");
    expect(writesOf(COARSE, "Won")).toBe(0);
    expect((await watchState())?.cells[COARSE], "a coarse candidate HubSpot is not newer than is not handed to the watch").toBeUndefined();
    await W_.advance("2026-10-09T09:30:00.000Z");
    expect(cell(COARSE), "nor converged later: HEAD's timing").toBe("New");
  });

  it("a coarse difference a pass does not put in play (HubSpot not newer) is not handed to the watch either (nothing in play, or beside a Note)", async () => {
    deal("closedwon", "2026-10-09T09:00:05.000Z");                           // Sync State ahead of HubSpot
    clock("2026-10-09T09:00:00.000Z"); rep(COARSE, "New", { userId: "-4", uuid: false });
    clock("2026-10-09T09:10:00.000Z");
    await hubspotPass("NOTHING", {});                                         // not newer, names nothing
    expect((await watchState())?.cells[COARSE]).toBeUndefined();
    hubspotSets("notes_last_updated", "2026-10-09T09:00:01.000Z", "2026-10-09T09:00:01.000Z", "CALCULATED");
    await hubspotPass("NOTE-OLD", { notes_last_updated: ["2026-10-09T09:00:01.000Z", false] });   // in play: the Note only
    expect(cell(COARSE), trail()).toBe("New");
    expect((await watchState())?.cells[COARSE]).toBeUndefined();
  });

  it("a person's two Stage edits share one queue: the runs that send them clear both their marks", async () => {
    deal("contractsent", "2026-09-29T02:00:00.000Z");
    clock("2026-10-09T09:00:00.000Z");
    const prevC = W_.eventValue(COARSE); rep(COARSE, "Won");
    w().mods.push("2026-10-09T09:00:05.000Z", "2026-10-09T09:00:06.000Z");
    const atHs = hold("HOOK-1", "hs");
    const waits = await W_.mondayWebhook("HOOK-1", COARSE, prevC, REP);
    await reachIn(atHs, waits, "run #1's HubSpot read");
    clock("2026-10-09T09:00:01.000Z");
    const prevE = W_.eventValue(EXACT); rep(EXACT, DICTS.stages.closedwon);
    const waits2 = await W_.mondayWebhook("HOOK-2", EXACT, prevE, REP);       // joins run #1's queue: the trailing run sends it
    expect(Object.keys((await watchState())?.marks ?? {}).sort()).toEqual([EXACT, COARSE].sort());
    clock("2026-10-09T09:00:02.000Z");
    atHs.release(); await W_.settleAll([...waits, ...waits2]);
    expect(w().hs.properties.dealstage, trail()).toBe("closedwon");
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });
});

describe("[12] a monday-born deal (CREATE_WINDOW_REPLAY off as live, unless a test says otherwise)", () => {
  const born = async (o: { failFill?: boolean; salesSeat?: string } = {}) => {
    const spec = dealsSpec();
    clock("2026-10-09T09:00:00.000Z");
    const ww = setWorld(makeWorld(spec, { hsId: "", itemId: "5552", created: now(), synced: "", group: "topics", labels: LABELS,
      props: {} }));
    ww.card.name = "New deal";
    ww.card.column_values.find(c => c.id === spec.idCol)!.text = "";
    ww.card.column_values.find(c => c.id === spec.syncStateCol)!.text = "";
    rep(COARSE, "New", { userId: "-4", uuid: false });
    rep(AMOUNT, "500");
    if (o.salesSeat) W_.repPeople(SALES, [o.salesSeat]);                     // a monday user with no HubSpot owner
    hubspot.createRecord.mockImplementation(async (_e: unknown, _s: unknown, props: Record<string, string>) => {
      const at = "2026-10-09T09:00:01.000Z";
      w().hs = { id: "9002", properties: { ...props, hs_object_id: "9002", createdate: at, hs_lastmodifieddate: at,
        hs_v2_date_entered_current_stage: at, sync_owner: "crm" }, history: {} };
      for (const [p, v] of Object.entries(props)) w().hs.history[p] = [{ value: v, timestamp: at, sourceType: "INTEGRATION", sourceId: W_.OWN }];
      return { id: "9002", modified: at };
    });
    if (o.failFill) {
      const real = monday.updateColumns.getMockImplementation()!;
      monday.updateColumns.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
        if (W_.PASS(env) === "CREATE") throw new Error("monday 400: invalid value for this column");
        return real(env, ...rest);
      });
    }
    clock("2026-10-09T09:00:01.500Z");
    return syncMondayItem(as("CREATE"), spec.boardId, ww.card.id, live, { left: 30 }, false, false, { cols: [AMOUNT] },
      { id: REP, byAutomation: false });
  };

  it("shows the Pipeline and the default Stage at once; HubSpot's own recalculation still comes across; the watch goes idle", async () => {
    const out = await born();
    expect(out).toMatch(/action=created-hubspot/);
    expect(cell(dealsSpec().idCol)).toBe("9002");
    expect(cell(PIPE), trail()).toBe(DICTS.pipelines.default);
    expect(cell(EXACT)).toBe(DICTS.stages.appointmentscheduled);
    expect(logged(/action=create-filled/)).toBe(true);
    expect((await watchState())?.allAt).toBeDefined();
    expect(stampNotes(), "the register has the write-back's stamp (§13: every gated stamp)").toEqual(["2026-10-09T09:00:01.000Z"]);
    // HubSpot recalculates the new deal ~1 s later: its probability, and a later modified time.
    hubspotSets("hs_deal_stage_probability", "0.2", "2026-10-09T09:00:02.000Z", "CALCULATED");
    clock("2026-10-09T09:00:04.000Z");
    await hubspotPass("CREATION");                                            // a creation event: unscoped
    expect(cell(PROB), trail()).toBe("20");
    expect(cell(PIPE)).toBe(DICTS.pipelines.default);
    expect(syncState()).toBe("2026-10-09T09:00:02.000Z");
    await advance("2026-10-09T09:03:10.000Z");
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
    expect(pushes(), "nothing is pushed back").toEqual([]);
  });

  it("the fill shows only what the create SENT: a person it could not send (no HubSpot owner) stays on the card", async () => {
    const out = await born({ salesSeat: "555" });
    expect(out).toMatch(/action=created-hubspot/);
    expect(cell(PIPE), trail()).toBe(DICTS.pipelines.default);
    expect(w().hs.properties.sales_user, "never sent").toBeUndefined();
    expect(cell(SALES), "not emptied by the fill (the watch's converge decides it at +W)").toBe("555");
    expect(W_.people(SALES)).toEqual(["555"]);
  });

  it("with CREATE_WINDOW_REPLAY on, the creator's own settle round brings the card into line: no early fill, no watch", async () => {
    setEnv({ CREATE_WINDOW_REPLAY: "true" });
    const out = await born();
    expect(out).toMatch(/action=created-hubspot/);
    expect(logged(/action=create-filled/)).toBe(false);
    expect((await watchState())?.allAt, "the creator settles the card itself").toBeUndefined();
    expect(stampNotes()).toEqual(["2026-10-09T09:00:01.000Z"]);
  });

  it("a fill monday rejects never yields WRITEBACK_FAILED, the record stays paired, and the watch converges the card", async () => {
    const out = await born({ failFill: true });
    expect(out).toMatch(/action=created-hubspot/);
    expect(out).not.toMatch(/WRITEBACK_FAILED/);
    expect(logged(/action=create-fill-failed/)).toBe(true);
    expect(cell(dealsSpec().idCol)).toBe("9002");
    expect(await lookupCard(as("T"), dealsSpec().boardId, "9002"), "finishCard ran").toBe("5552");
    expect(cell(PIPE)).toBe("");
    await advance("2026-10-09T09:03:10.000Z");                              // converge-all at +W
    expect(cell(PIPE), trail()).toBe(DICTS.pipelines.default);
    expect(cell(EXACT)).toBe(DICTS.stages.appointmentscheduled);
    expect(await watchIdle(), JSON.stringify(await watchState())).toBe(true);
  });
});
