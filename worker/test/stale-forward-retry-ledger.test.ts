import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PIPELINES } from "./fixtures/deal-pipelines";
import type { Budget, Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "../src/types";

/**
 * STALE_FORWARD_RETRY: THIS CARD'S OWN-WRITE LEDGER AND THE SIBLING CELLS, AFTER THE SECOND REVIEW (the round that found
 * the sibling fix still unsafe to arm). Every scenario below is a reviewer's reproduction, replayed through the REAL
 * engine (stale-forward-world: the real CreateIdempotency watch, handleMonday, retryMarkedEdits and the converge). Each
 * failed before the fix it names; the RETRY-off controls pin the live behaviour, unchanged.
 *   [B1] a ~stage run that served BOTH Stage cells and sent the exact stage recorded its push as the coarse cell's own
 *        too: the older coarse click's retry was later sent over it (closedwon over Contract Sent). A push now records
 *        only the cells whose OWN value it carried (reconcile.ts editCellsOf).
 *   [S2] a newer sibling edit HubSpot already held left no ledger record: the older sibling's retry was sent over it. It
 *        now leaves a dated one (PushRec.inLine).
 *   [S3] a push's consequence held a sibling cell for an OLDER mark: a rename whose push landed between a Name-column
 *        retry's last look and its PATCH was then lost (the converge never sends a name). Only a NEWER mark holds it, and
 *        the retry reads the ledger once its PATCH returned: a sibling's push of a later edit it landed over is re-sent.
 *   [S4] an edit run's monday write waited out monday's rate limit and landed over a sibling edit made meanwhile. With the
 *        retry on it never waits (refused: the cells converge, the marks retry).
 *   [S5] a push of a newer edit stayed dated by an older mark when the newer edit's mark came more than 5 s late.
 *   [S6] a sibling cell a FORWARD PASS wrote (HubSpot's older value) during a retry's PATCH was re-sent as a person's edit.
 *   [M7] a retry dated its push of every property by the newest edit of all its cells.
 *   [M8] an older sibling's slow push recorded after a newer edit's retry began read as a foreign later change.
 *   [M9] a retry's monday reads other than its link read sat through gql's six rate-limit waits, and a rate-limited one
 *        spent a mark's attempt.
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
  ASK_ADA, REP, makeWorld, setWorld, installWorld, setEnv, as, live, clock, rep, cell, hold, reach, mondayWebhook,
  settleAll, eventValue, advance, fireWatch, drain, watchState, logged, PASS,
} = W_;
const w = () => W_.w;
const pushes = () => W_.pushes(hubspot as never);
const trail = () => w().trail.join("\n");
const { specByObject } = await import("../src/config");
const { retryMarkedEdits } = await import("../src/sync");
const { crmStageDictsOf } = await import("../src/hubspot");
const { resetPairedEchoes } = await import("../src/relation-edit");
const { uiActorTiming } = await import("../src/ui-actor");
const { handleMonday } = await import("../src/webhooks");
const { columnEditPatch, editCellsOf, EDIT_NAME_KEY } = await import("../src/reconcile");
const { NAME_KEY } = await import("../src/card-watch");
const { CreateIdempotency } = await import("../src/create-idempotency-do");

const DICTS = crmStageDictsOf(PIPELINES as never);
const COARSE = "deal_stage", EXACT = "dropdown_mm7624zd";
const ENVC = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z" };
const LABELS = { crmCoarseStage: DICTS.coarse, crmStage: DICTS.stages, crmPipeline: DICTS.pipelines };
const field = (spec: ObjectSpec, hs: string): FieldSpec => spec.fields.find(f => f.hs === hs)!;
const S0 = "2026-07-18T12:46:01.914Z";
/** 2026-10-09 at `hh:mm:ss` or `hh:mm:ss.sss`, as ISO. */
const T = (hms: string) => `2026-10-09T${hms}${hms.includes(".") ? "" : ".000"}Z`;
const timing = { ...uiActorTiming };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(T("08:00:00"));
  vi.clearAllMocks();
  installWorld(monday as never, hubspot as never);
  resetPairedEchoes();
  Object.assign(uiActorTiming, { settleMs: 0, backoffMs: [0, 0] });
  setEnv({ STAGE_COARSE_REVERSE: "true" });
  hubspot.getCrmStageDicts.mockResolvedValue(DICTS);
  assoc.syncAssociations.mockResolvedValue(undefined);
  assoc.reverseAssociations.mockResolvedValue(undefined);
  assoc.reverseLineItems.mockResolvedValue(undefined);
  assoc.convergeRelationCell.mockResolvedValue("matched");
  // A PATCH the test did not script gets HubSpot's modified time from the clock (a second later).
  const realPatch = hubspot.patchRecord.getMockImplementation()!;
  hubspot.patchRecord.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
    if (!w().mods.length) w().mods.push(new Date(Date.now() + 1000).toISOString());
    return (realPatch as any)(env, ...rest);
  });
});
afterEach((c) => { W_.debugDump(c.task.name); Object.assign(uiActorTiming, timing); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Every monday write of the pass named `pass` fails from now on (its run dies after whatever it sent to HubSpot). */
function loseWritesOf(pass: string): void {
  for (const fn of ["setColumns", "updateColumns", "updateItem"] as const) {
    const real = monday[fn].getMockImplementation()!;
    monday[fn].mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === pass) throw new Error(`monday 500: ${pass}'s write is lost`);
      return (real as any)(env, ...rest);
    });
  }
}
/** Time passes to each of `times`: leases end, retries and converges run. */
async function pass(...times: string[]): Promise<void> {
  w().failGetRecord = undefined;
  for (const t of times) await advance(T(t));
}
const LATER = ["09:01:01", "09:01:16", "09:01:30", "09:02:05", "09:02:30", "09:03:10", "09:04:20", "09:06:00", "09:09:00",
  "09:12:00", "09:20:00", "09:40:00"];

// ===================================================================================================================
// PURE: WHICH EDITED CELLS A PUSH SPEAKS FOR (reconcile.ts editCellsOf)
// ===================================================================================================================
describe("pure: the edited cells a columnEditPatch result carries, and those HubSpot already holds (editCellsOf)", () => {
  const PIPE = "dropdown_mm76s7kk";
  const ctx = (): Ctx => ({ labels: { crmStage: DICTS.stages, crmPipeline: DICTS.pipelines, crmCoarseStage: DICTS.coarse },
    ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {}, pipelineByStage: DICTS.pipelineByStage,
    portalId: 1 } as unknown as Ctx);
  const SYNCED = "2026-09-29T02:00:00.000Z";
  const deals = () => specByObject(ENVC, "deals")!;
  const dealCard = (c: { coarse: string; exact: string; pipe: string }): MondayItem => ({ id: "5551", name: "Acme renewal",
    created_at: "2026-01-22T06:46:54Z", updated_at: SYNCED, group: { id: "topics" }, column_values: [
      { id: deals().idCol, text: "9001" }, { id: deals().syncStateCol, text: SYNCED },
      { id: COARSE, text: c.coarse, status_index: 1 }, { id: EXACT, text: c.exact }, { id: PIPE, text: c.pipe }] });
  const dealRec = (stage: string): HsRecord => ({ id: "9001", properties: { dealstage: stage,
    pipeline: DICTS.pipelineByStage[stage], hs_v2_date_entered_current_stage: "2026-09-29T01:59:59.000Z",
    hs_lastmodifieddate: SYNCED } });
  const atStage = (stage: string, o: { coarse?: string; exact?: string; pipe?: string } = {}) => dealCard({
    coarse: o.coarse ?? DICTS.coarse[stage], exact: o.exact ?? DICTS.stages[stage],
    pipe: o.pipe ?? DICTS.pipelines[DICTS.pipelineByStage[stage]] });
  const cellsOf = (rec: HsRecord, card: MondayItem, cols: string[], spec = deals(), name = false) => {
    const r = columnEditPatch(rec, card, spec, ctx(), { cols, ...(name ? { name: true } : {}) });
    return { patch: r.patch, ...editCellsOf(r) };
  };

  it("EDIT_NAME_KEY is card-watch.ts's NAME_KEY (the item name's watch key)", () => {
    expect(EDIT_NAME_KEY).toBe(NAME_KEY);
  });

  it("both Stage cells in one change: the push is the exact cell's alone -- the coarse Stage is refused (the exact stage wins)", () => {
    const c = cellsOf(dealRec("presentationscheduled"),
      atStage("presentationscheduled", { coarse: "Won", exact: DICTS.stages.contractsent }), [COARSE, EXACT]);
    expect(c.patch).toEqual({ dealstage: "contractsent", pipeline: DICTS.pipelineByStage.contractsent });
    expect(c.carried).toEqual([EXACT]);
    expect(c.inLine).toEqual([]);
  });

  it("the coarse Stage alone, mapped: carried; one whose label HubSpot's stage already reads as: in line", () => {
    expect(cellsOf(dealRec("presentationscheduled"), atStage("presentationscheduled", { coarse: "Won" }), [COARSE]).carried)
      .toEqual([COARSE]);
    const inBucket = cellsOf(dealRec("closedwon"), atStage("closedwon", { coarse: "Won" }), [COARSE]);
    expect(inBucket).toEqual({ patch: {}, carried: [], inLine: [COARSE] });
  });

  it("the coarse Stage refused (the HubSpot Stage cell names a stage HubSpot does not hold): neither", () => {
    const c = cellsOf(dealRec("presentationscheduled"),
      atStage("presentationscheduled", { coarse: "Won", exact: DICTS.stages.contractsent }), [COARSE]);
    expect(c).toEqual({ patch: {}, carried: [], inLine: [] });
  });

  it("the HubSpot Stage HubSpot already holds: in line; another one: carried", () => {
    expect(cellsOf(dealRec("contractsent"), atStage("contractsent"), [EXACT])).toEqual({ patch: {}, carried: [], inLine: [EXACT] });
    expect(cellsOf(dealRec("presentationscheduled"), atStage("presentationscheduled", { exact: DICTS.stages.contractsent }),
      [EXACT]).carried).toEqual([EXACT]);
  });

  it("a Pipeline edit the stage's own pipeline replaces is not carried (the HubSpot Stage is)", () => {
    const other = Object.keys(DICTS.pipelines).find(p => p !== DICTS.pipelineByStage.contractsent && DICTS.pipelines[p])!;
    const c = cellsOf(dealRec("presentationscheduled"),
      atStage("presentationscheduled", { exact: DICTS.stages.contractsent, pipe: DICTS.pipelines[other] }), [EXACT, PIPE]);
    expect(c.patch.pipeline, "the pairing sends the stage's own pipeline").toBe(DICTS.pipelineByStage.contractsent);
    expect(c.carried).toEqual([EXACT]);
  });

  it("Accounts: the Name column under a rename in the same change -- only the item name's value is carried", () => {
    const acc = specByObject(ENVC, "companies")!;
    const nameCol = field(acc, "name").col;
    const card: MondayItem = { id: "2857007001", name: "Acme Group", created_at: S0, updated_at: S0, group: { id: "g" },
      column_values: [{ id: acc.idCol, text: "7001" }, { id: acc.syncStateCol, text: S0 }, { id: nameCol, text: "Acme Holdings" }] };
    const rec: HsRecord = { id: "7001", properties: { name: "Acme" } };
    expect(cellsOf(rec, card, [nameCol], acc, true)).toEqual({ patch: { name: "Acme Group" }, carried: [NAME_KEY], inLine: [] });
    expect(cellsOf({ id: "7001", properties: { name: "Acme Group" } }, card, [], acc, true))
      .toEqual({ patch: {}, carried: [], inLine: [NAME_KEY] });
  });
});

// ===================================================================================================================
// THE DEALS STAGE PAIR
// ===================================================================================================================
function deal(stage: string) {
  const ww = setWorld(makeWorld(specByObject(ENVC, "deals")!, { hsId: "9001", itemId: "5551", created: "2026-09-01T00:00:00.000Z",
    synced: "2026-09-29T02:00:00.000Z", group: "topics", labels: LABELS,
    props: { dealname: "Acme renewal", dealstage: stage, pipeline: DICTS.pipelineByStage[stage], amount: "1000",
      hs_v2_date_entered_current_stage: "2026-09-01T00:00:00.000Z" } }));
  ww.onPatch = (patch, mod) => { if (patch.dealstage) w().hs.properties.hs_v2_date_entered_current_stage = mod; };
  return ww;
}
const stages = () => ({ sent: pushes().map(p => p.dealstage), hs: w().hs.properties.dealstage, coarse: cell(COARSE),
  exact: cell(EXACT) });

describe("[B1] a ~stage run that served BOTH Stage cells, sent the exact stage and died: the older coarse click is never retried over it", () => {
  /** RS-D1: Stage = Won (:00) and HubSpot Stage = Contract Sent (:05) reach ONE ~stage run (a burst); it PATCHes the
   *  exact stage ("the exact stage wins") and dies at its monday write. */
  async function burst(retry: boolean) {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
    deal("presentationscheduled");
    clock(T("09:00:00"));
    const pC = eventValue(COARSE); rep(COARSE, "Won");
    clock(T("09:00:05"));
    const pE = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    clock(T("09:00:06"));
    loseWritesOf("CLICK1"); loseWritesOf("CLICK2");                       // whichever pass's run serves both dies
    const [a, b] = await Promise.all([
      mondayWebhook("CLICK1", COARSE, pC, REP, { changedAt: Date.parse(T("09:00:00")) }),
      mondayWebhook("CLICK2", EXACT, pE, REP, { changedAt: Date.parse(T("09:00:05")) }),
    ]);
    await settleAll([...a, ...b]);
    const ledger = ((await watchState())?.pushes ?? []).filter(p => p.prop === "dealstage").map(p => ({ v: p.value, keys: p.keys }));
    const mid = stages();
    await pass(...LATER.map(t => t === "09:01:01" ? "09:01:07" : t));
    return { mid, ledger, ...stages() };
  }

  it("RS-D1 RETRY on: closedwon is never sent; Contract Sent ends on both sides -- the push is recorded as the exact cell's alone", async () => {
    const r = await burst(true);
    expect(r.mid.sent, "the one run sent the exact stage\n" + trail()).toEqual(["contractsent"]);
    expect(r.ledger, "the coarse Stage it refused is not this push's cell").toEqual([{ v: "contractsent", keys: [EXACT] }]);
    expect(r.sent, "closedwon (the OLDER click, refused by its own run) is never sent\n" + trail()).toEqual(["contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(r.coarse, "the coarse Stage converges to the newer stage's bucket").toBe("Negotiation");
    expect(logged(new RegExp(`cols=${COARSE} action=edit-retry-superseded reason="this card's own push`))).toBe(true);
  });

  it("RS-D1 RETRY off (live): the same", async () => {
    const r = await burst(false);
    expect(r.sent, trail()).toEqual(["contractsent"]);
    expect(r.hs).toBe("contractsent");
  });

  it("RS-D1 with the HubSpot Stage event's mark lost (its RPC failed): the push alone gives the older coarse click up", async () => {
    const real = CreateIdempotency.prototype.markEdits;
    vi.spyOn(CreateIdempotency.prototype, "markEdits").mockImplementation(async function (this: unknown, ...a: unknown[]) {
      if ((a[2] as { key: string }[]).some(m => m.key === EXACT)) throw new Error("DO unreachable");
      return (real as any).apply(this, a);
    });
    const r = await burst(true);
    expect(r.mid.sent, trail()).toEqual(["contractsent"]);
    expect(r.sent, "no newer mark is left to wait for: the push itself is the later change\n" + trail()).toEqual(["contractsent"]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
  });

  /** RS-D2: the natural path -- an earlier Stage = New run waits out monday's rate limit at its card read; its trailing
   *  re-run carries both later clicks (Won :10, Contract Sent :15), PATCHes the exact stage, and its write is lost. */
  it.each([true, false])("RS-D2 RETRY %s: an earlier Stage run held; its re-run carries Stage = Won and HubSpot Stage = Contract Sent and dies -> Contract Sent ends on both sides", async (retry) => {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
    deal("presentationscheduled");
    clock(T("09:00:00"));
    const p0 = eventValue(COARSE); rep(COARSE, "New");
    const atCard = hold("CLICK0", "card");
    const w0 = await mondayWebhook("CLICK0", COARSE, p0, REP);
    await reach(atCard, Promise.allSettled(w0), "CLICK0's card read");
    clock(T("09:00:10"));
    const pK = eventValue(COARSE); rep(COARSE, "Won");
    const wK = await mondayWebhook("CLICK1", COARSE, pK, REP);
    clock(T("09:00:15"));
    const pS = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    const wS = await mondayWebhook("CLICK2", EXACT, pS, REP);
    const atPatch = hold("CLICK0", "patch");                               // the trailing re-run's PATCH
    clock(T("09:00:20"));
    atCard.release();
    await reach(atPatch, Promise.allSettled([...w0, ...wK, ...wS]), "the re-run's PATCH");
    loseWritesOf("CLICK0");                                                // its PATCH lands; its monday write is lost
    atPatch.release();
    await settleAll([...w0, ...wK, ...wS]);
    expect(pushes().map(p => p.dealstage).slice(-1), "the re-run sent the exact stage\n" + trail()).toEqual(["contractsent"]);
    await pass(...LATER);
    const r = stages();
    expect(r.sent.includes("closedwon"), "closedwon (older than Contract Sent) is never sent\n" + trail()).toBe(false);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
  });

  /** V3: an earlier Stage = New run waits at its HubSpot read (after its card read); its own PATCH lands, and its re-run
   *  -- carrying both later clicks -- PATCHes the exact stage and its write is refused. (RETRY off, live: R0's own
   *  consequence write puts Appointment Scheduled over the HubSpot Stage click before its re-run reads it -- the
   *  pre-existing loss of [S4]'s family, on HEAD and live d93c470 alike; the retry's consequence hold keeps it.) */
  it("V3 RETRY on: Stage = New's run slow at its HubSpot read; its re-run carries Won and Contract Sent and dies -> Contract Sent", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("presentationscheduled");
    clock(T("09:00:00"));
    const p0 = eventValue(COARSE); rep(COARSE, "New");
    const atHs = hold("R0", "hs");
    const w0 = await mondayWebhook("R0", COARSE, p0, REP);
    await reach(atHs, Promise.allSettled(w0), "R0's HubSpot read");
    clock(T("09:00:10"));
    const pK = eventValue(COARSE); rep(COARSE, "Won");
    const wK = await mondayWebhook("K", COARSE, pK, REP);
    clock(T("09:00:15"));
    const pS = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    const wS = await mondayWebhook("S", EXACT, pS, REP);
    clock(T("09:00:20"));
    let patches = 0;
    const realPatch = hubspot.patchRecord.getMockImplementation()!;
    hubspot.patchRecord.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === "R0") patches++;
      return (realPatch as any)(env, ...rest);
    });
    for (const fn of ["setColumns", "updateItem", "updateColumns"] as const) {
      const real = monday[fn].getMockImplementation()!;
      monday[fn].mockImplementation(async (env: unknown, ...rest: unknown[]) => {
        if (PASS(env) === "R0" && patches >= 2) throw new Error("monday 500: the re-run's write is lost");
        return (real as any)(env, ...rest);
      });
    }
    atHs.release();
    await settleAll([...w0, ...wK, ...wS]);
    expect(pushes().map(p => p.dealstage).slice(-1), trail()).toEqual(["contractsent"]);
    await pass(...LATER);
    const r = stages();
    expect(r.sent.includes("closedwon"), "closedwon (older than Contract Sent) is never sent\n" + trail()).toBe(false);
    expect(r.hs).toBe("contractsent");
  });
});

describe("[S2] a newer sibling edit HubSpot already held leaves a dated ledger record: the older sibling's retry is given up for it", () => {
  /** V1-A (RS-D3): HubSpot holds contractsent. Stage = Won (run dies before its PATCH); twenty seconds later HubSpot
   *  Stage is re-picked away and back to Contract Sent, and that run (reading the final value) has nothing to send. */
  it.each([true, false])("V1-A RETRY %s: Won (dead), then HubSpot Stage away and back to the stage HubSpot holds -> closedwon never sent", async (retry) => {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
    deal("contractsent");
    clock(T("09:00:00"));
    const pK = eventValue(COARSE); rep(COARSE, "Won");
    w().failGetRecord = "CLICK1";
    await settleAll(await mondayWebhook("CLICK1", COARSE, pK, REP));
    w().failGetRecord = undefined;
    clock(T("09:00:20"));
    const pS1 = eventValue(EXACT); rep(EXACT, DICTS.stages.decisionmakerboughtin);
    const slow = hold("CLICK2", "card");
    const w1 = await mondayWebhook("CLICK2", EXACT, pS1, REP);
    await reach(slow, Promise.allSettled(w1), "CLICK2's card read");
    clock(T("09:00:22"));
    const pS2 = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    const w2 = await mondayWebhook("CLICK3", EXACT, pS2, REP);
    slow.release();
    await settleAll([...w1, ...w2]);
    if (retry) expect(((await watchState())?.pushes ?? []).filter(p => p.inLine && p.prop === "dealstage")
      .map(p => ({ keys: p.keys, a: p.a })), "the in-line pick, dated by its edit").toEqual([{ keys: [EXACT], a: Date.parse(T("09:00:22")) }]);
    await pass(...LATER);
    const r = stages();
    expect(r.sent.includes("closedwon"), "the OLDER Won is never sent over the newer (re-picked) Contract Sent\n" + trail()).toBe(false);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    // (The Stage cell keeps HEAD's timing either way: a coarse value converges once HubSpot is newer than Sync State.)
    if (retry) expect(logged(new RegExp(`cols=${COARSE} action=edit-retry-superseded reason="this card's own push`))).toBe(true);
  });

  it("V1-B RETRY on: Won, then HubSpot Stage away and back, EVERY run dead before its PATCH -- the exact retry finds it in line, the Won retry is given up", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("contractsent");
    for (const [p, at, col, label] of [["CLICK1", "09:00:00", COARSE, "Won"],
        ["CLICK2", "09:00:20", EXACT, DICTS.stages.decisionmakerboughtin],
        ["CLICK3", "09:00:22", EXACT, DICTS.stages.contractsent]] as const) {
      clock(T(at));
      const prev = eventValue(col); rep(col, label);
      w().failGetRecord = p;
      await settleAll(await mondayWebhook(p, col, prev, REP));
      w().failGetRecord = undefined;
    }
    await pass(...LATER);
    const r = stages();
    expect(r.sent, "nothing to send: the newest edit is what HubSpot holds\n" + trail()).toEqual([]);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(logged(new RegExp(`cols=${COARSE} action=edit-retry-deferred`)), "first it waited for the newer pick").toBe(true);
    expect(logged(new RegExp(`cols=${COARSE} action=edit-retry-superseded`)), "then gave way to it").toBe(true);
  });

  it.each([true, false])("V1-C RETRY %s: the card behind on the stage -- HubSpot moved to contractsent before the Won click (dead); a HubSpot Stage pick of that stage lives -> closedwon never sent", async (retry) => {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
    deal("presentationscheduled");
    clock(T("08:59:30"));
    W_.hubspotSets("dealstage", "contractsent", T("08:59:30"), "CRM_UI");
    w().hs.properties.hs_v2_date_entered_current_stage = T("08:59:30");
    clock(T("09:00:00"));
    const pK = eventValue(COARSE); rep(COARSE, "Won");
    w().failGetRecord = "CLICK1";
    await settleAll(await mondayWebhook("CLICK1", COARSE, pK, REP));
    w().failGetRecord = undefined;
    clock(T("09:00:20"));
    const pS = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    await settleAll(await mondayWebhook("CLICK2", EXACT, pS, REP));
    await pass(...LATER);
    const r = stages();
    expect(r.sent.includes("closedwon"), trail()).toBe(false);
    expect(r.hs).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
  });

  it("the CONTROL still holds: a newer pick that does send gives the Won retry up (a push), and Won is never sent", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("contractsent");
    clock(T("09:00:00"));
    const pK = eventValue(COARSE); rep(COARSE, "Won");
    w().failGetRecord = "CLICK1";
    await settleAll(await mondayWebhook("CLICK1", COARSE, pK, REP));
    w().failGetRecord = undefined;
    clock(T("09:00:20"));
    const pS = eventValue(EXACT); rep(EXACT, DICTS.stages.decisionmakerboughtin);
    await settleAll(await mondayWebhook("CLICK2", EXACT, pS, REP));
    await pass(...LATER);
    expect(stages().sent, trail()).toEqual(["decisionmakerboughtin"]);
    expect(stages().hs).toBe("decisionmakerboughtin");
  });
});

// ===================================================================================================================
// THE ACCOUNTS NAME PAIR
// ===================================================================================================================
const companies = () => specByObject(ENVC, "companies")!;
const NAME_COL = () => field(companies(), "name").col;
function company() {
  return setWorld(makeWorld(companies(), { hsId: "7001", itemId: "2857007001", created: "2026-07-18T12:40:00.000Z", synced: S0,
    props: { name: "Acme", domain: "acme.com" } }));
}
/** Someone renames the item now (on the card only; its webhook is sent by renameHook). */
function renameOnCard(name: string, who = "REP"): void {
  w().trail.push(`${W_.now().slice(11, 23)} ${who.padEnd(10)} rename: ${JSON.stringify(w().card.name)} -> ${JSON.stringify(name)}`);
  w().card.name = name; w().card.updated_at = W_.now();
}
async function renameHook(p: string, o: { changedAt?: number; dies?: boolean } = {}): Promise<void> {
  if (o.dies) w().failGetRecord = p;
  await settleAll(await mondayWebhook(p, "", {}, REP, { type: "update_name", ...(o.changedAt ? { changedAt: o.changedAt } : {}) }));
  w().failGetRecord = undefined;
}
const names = () => ({ hs: w().hs.properties.name, item: w().card.name, col: cell(NAME_COL()), sent: pushes().map(p => p.name) });
/** The watch's alarm fires at `hms` (a lease ended) and its retry is run BY HAND as pass RTRY, held at `op`. */
async function retryHeldAt(hms: string, op: "hs" | "patch" | "history" | "card"):
    Promise<{ run: Promise<string>; release: () => void }> {
  clock(T(hms));
  expect(await fireWatch(), "the lease ended: the alarm fires").toBe(true);
  expect(W_.spilled.some(s => s.watch?.kind === "retry"), "a retry was queued").toBe(true);
  W_.spilled.length = 0;
  const g = hold("RTRY", op);
  const run = retryMarkedEdits(as("RTRY"), w().spec.boardId, w().card.id, live, { left: 30 });
  await reach(g, run, `the retry's ${op}`);
  return { run, release: g.release };
}

describe("[S2] Accounts: a newer Name-column edit HubSpot already held", () => {
  it.each([true, false])("V1-N RETRY %s: rename (dead), then the Name column away and back to HubSpot's name (both dead) -> the older rename is never sent", async (retry) => {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
    company();
    clock(T("09:00:00")); renameOnCard("Acme Group"); await renameHook("CLICK1", { dies: true });
    for (const [p, at, v] of [["CLICK2", "09:00:20", "Acme X"], ["CLICK3", "09:00:22", "Acme"]] as const) {
      clock(T(at));
      const prev = eventValue(NAME_COL()); rep(NAME_COL(), v);
      w().failGetRecord = p;
      await settleAll(await mondayWebhook(p, NAME_COL(), prev, REP));
      w().failGetRecord = undefined;
    }
    await pass(...LATER);
    const r = names();
    expect(r.sent.includes("Acme Group"), "the OLDER rename is never sent over the newer Name-column edit\n" + trail()).toBe(false);
    expect(r.hs).toBe("Acme");
    expect(r.col).toBe("Acme");
    expect(r.item, "the item name converges to the newer edit").toBe("Acme");
  });
});

describe("[S3] a Name-column retry vs a rename whose push lands between the retry's last look and its PATCH", () => {
  /** RS-N1: the Name column (09:00:00, run dead before its PATCH); the rename (09:01:00) is on the card before the retry
   *  reads it, its webhook late; the rename's own run pushes first, the retry's older PATCH lands last. */
  it("RS-N1 RETRY on: the newer rename ends on both sides (re-sent from the ledger; its consequence wrote over the OLDER mark's cell)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    w().failGetRecord = "NAMECOL";
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP));
    w().failGetRecord = undefined;
    clock(T("09:01:00")); renameOnCard("Acme Group");                    // its webhook is late
    const r0 = await retryHeldAt("09:01:01", "patch");                     // past its last look, before its PATCH
    clock(T("09:01:02")); w().mods.push(T("09:01:02"));
    await renameHook("RENAME", { changedAt: Date.parse(T("09:01:00")) }); // the rename's own run pushes first
    expect(w().hs.properties.name, trail()).toBe("Acme Group");
    expect(cell(NAME_COL()), "the rename's consequence writes over the OLDER Name-column edit's cell").toBe("Acme Group");
    clock(T("09:01:03")); w().mods.push(T("09:01:03"));
    r0.release(); await r0.run;                                            // the older Name-column value lands last
    expect(w().hs.properties.name, "no compare-and-set: the older value landed last").toBe("Acme Holdings");
    expect(logged(/cols=~name action=edit-retry-raced reason="this card's own push of a later edit/), trail()).toBe(true);
    await pass("09:01:05", ...LATER.slice(1));
    const r = names();
    expect(r.hs, "the newer rename ends in HubSpot\n" + trail()).toBe("Acme Group");
    expect(r.item, "and on the card").toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });

  it("RETRY off (live): the same edits end on the newer rename", async () => {
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    w().failGetRecord = "NAMECOL";
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP));
    w().failGetRecord = undefined;
    clock(T("09:01:00")); renameOnCard("Acme Group");
    clock(T("09:01:02")); w().mods.push(T("09:01:02"));
    await renameHook("RENAME", { changedAt: Date.parse(T("09:01:00")) });
    await pass(...LATER);
    const r = names();
    expect(r.hs, trail()).toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });

  it("the consequence still holds a sibling cell for a NEWER mark (a slower run of the OLDER edit lands after the newer one was made)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    const g = hold("NAMECOL", "patch");
    w().mods.push(T("09:00:30"));
    const waits = await mondayWebhook("NAMECOL", NAME_COL(), prev, REP);
    await reach(g, Promise.allSettled(waits), "the Name column's PATCH");
    clock(T("09:00:20")); renameOnCard("Acme Group"); await renameHook("RENAME", { dies: true });
    clock(T("09:00:30")); g.release(); await settleAll(waits);
    expect(w().card.name, "the rename's mark is newer than the edit this push carried: held").toBe("Acme Group");
    await pass(...LATER);
    const r = names();
    expect(r.hs, trail()).toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });
});

describe("[S5] a push of a newer edit whose mark came more than 5 s late is dated by that edit", () => {
  /** S1 = Name column "Acme Ltd" (09:00:00), its run reading the card at 09:00:03; the rename (09:00:01, run dead); S2 =
   *  Name column "Acme Holdings" (09:00:02), its mark recorded at `s2At`. S1's run pushes S2's value. */
  async function boundary(s2At: string) {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Ltd");
    const g = hold("S1", "card");
    w().mods.push(T("09:00:03"));
    const waits = await mondayWebhook("S1", NAME_COL(), prev, REP);
    await reach(g, Promise.allSettled(waits), "S1's card read");
    clock(T("09:00:01")); renameOnCard("Acme Group"); await renameHook("RENAME", { dies: true });
    clock(T("09:00:02"));
    const prev2 = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    clock(T("09:00:03")); g.release(); await settleAll(waits);
    clock(T(s2At));
    await settleAll(await mondayWebhook("S2", NAME_COL(), prev2, REP, { changedAt: Date.parse(T("09:00:02")) }));
    const dated = ((await watchState())?.pushes ?? []).find(p => p.prop === "name" && !p.inLine)?.a;
    await pass(...LATER);
    return { ...names(), dated };
  }

  it("S2's mark 5.1 s after the push: the push is re-dated to S2's edit, and the older rename is never sent", async () => {
    const r = await boundary("09:00:08.100");
    expect(r.dated, "dated by S2's 09:00:02 edit, not S1's 09:00:00").toBe(Date.parse(T("09:00:02")));
    expect(r.sent, trail()).toEqual(["Acme Holdings"]);
    expect([r.hs, r.item, r.col]).toEqual(["Acme Holdings", "Acme Holdings", "Acme Holdings"]);
  });

  it("S2's mark 4.9 s after: as before", async () => {
    const r = await boundary("09:00:07.900");
    expect(r.dated).toBe(Date.parse(T("09:00:02")));
    expect(r.sent, trail()).toEqual(["Acme Holdings"]);
  });

  /** Natural timing: ask-ada UI edits of the Name column (classified on their first log read, so routed 6.9 s after
   *  they were made), and a colleague's rename between them, its run dead. */
  async function natural(retry: boolean) {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false", ASK_ADA_UI_EDITS: "true" });
    company();
    const webhook = async (p: string, value: unknown, prev: unknown, at: string) => {
      const waits: Promise<unknown>[] = [];
      const ectx = { waitUntil: (x: Promise<unknown>) => { waits.push(x); } } as unknown as ExecutionContext;
      const ev = { boardId: Number(w().spec.boardId), pulseId: Number(w().card.id), type: "update_column_value",
        columnId: NAME_COL(), userId: Number(ASK_ADA), changedAt: Date.parse(at) / 1000, value, previousValue: prev };
      await handleMonday(new Request("https://w/webhooks/monday", { method: "POST", body: JSON.stringify({ event: ev }) }), as(p), ectx);
      await settleAll(waits);
    };
    clock(T("09:00:00"));
    const prevS1 = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Ltd", { userId: ASK_ADA, uuid: true });
    const valS1 = eventValue(NAME_COL());
    clock(T("09:00:03")); renameOnCard("Acme Group", "COLLEAGUE"); await renameHook("RENAME", { dies: true });
    clock(T("09:00:06.500"));
    const prevS2 = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings", { userId: ASK_ADA, uuid: true });
    const valS2 = eventValue(NAME_COL());
    clock(T("09:00:06.900")); w().mods.push(T("09:00:07"));
    await webhook("S1", valS1, prevS1, T("09:00:00"));
    clock(T("09:00:13.400"));
    await webhook("S2", valS2, prevS2, T("09:00:06.500"));
    await pass(...LATER);
    return names();
  }
  it.each([true, false])("V2 natural timing, RETRY %s: the newest edit (the second Name-column edit) ends on both sides", async (retry) => {
    const r = await natural(retry);
    expect(logged(/action=ui-actor class=person/), "the ask-ada edits are a person's").toBe(true);
    expect(r.sent, trail()).toEqual(["Acme Holdings"]);
    expect([r.hs, r.item, r.col]).toEqual(["Acme Holdings", "Acme Holdings", "Acme Holdings"]);
  });
});

// ===================================================================================================================
// [S4] AN EDIT RUN'S MONDAY WRITE UNDER MONDAY'S RATE LIMIT
// ===================================================================================================================
/**
 * A monday rate-limit episode for the pass `p`: a write allowed to wait (gql's own waits: any but 0) sits through it
 * until `release`, and then lands; one sent with no waits (0) is refused at once -- it never ran -- as monday refuses it.
 */
function rateLimitEpisode(p: string): { reached: Promise<void>; release: () => void } {
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  let arrived!: () => void;
  const reached = new Promise<void>(r => { arrived = r; });
  let over = false;
  for (const fn of ["setColumns", "updateColumns", "updateItem"] as const) {
    const real = monday[fn].getMockImplementation()!;
    monday[fn].mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === p && !over) {
        if (rest[fn === "updateItem" ? 5 : 4] === 0) {
          w().trail.push(`${W_.now().slice(11, 23)} ${p.padEnd(10)} ${fn} REFUSED (rate limit; sent with no waits)`);
          const e = new Error("monday 429: rate-limited after 0 waits"); e.name = "MondayRateLimitedError";
          throw e;
        }
        arrived(); await gate;                                             // gql sits through the rate limit's waits
      }
      return (real as any)(env, ...rest);
    });
  }
  return { reached, release: () => { over = true; open(); } };
}

describe("[S4] RETRY on: an edit run's monday write never waits out monday's rate limit, so it never lands over an edit made meanwhile", () => {
  it("P1s: Stage = New's consequence write meets the rate limit; HubSpot Stage = Contract Sent clicked meanwhile -> Contract Sent on both sides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("presentationscheduled");
    clock(T("09:00:00"));
    const p0 = eventValue(COARSE); rep(COARSE, "New");
    const ep = rateLimitEpisode("CLICK0");
    const w0 = await mondayWebhook("CLICK0", COARSE, p0, REP);
    await Promise.race([ep.reached, Promise.allSettled(w0)]);
    clock(T("09:00:03"));
    const pS = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    const wS = await mondayWebhook("CLICK2", EXACT, pS, REP);
    clock(T("09:00:12")); ep.release();
    await settleAll([...w0, ...wS]);
    await pass(...LATER);
    const r = stages();
    expect(logged(/action=write-rate-limited reason="monday refused the write for its rate limit/), trail()).toBe(true);
    expect(r.hs, "the newer HubSpot Stage reaches HubSpot\n" + trail()).toBe("contractsent");
    expect(r.exact).toBe(DICTS.stages.contractsent);
    expect(r.sent.slice(-1)).toEqual(["contractsent"]);
  });

  it("P5, the mirror: HubSpot Stage = Contract Sent's consequence write meets the rate limit; Stage = Won clicked meanwhile -> Won on both sides", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("presentationscheduled");
    clock(T("09:00:00"));
    const p0 = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    const ep = rateLimitEpisode("CLICK0");
    const w0 = await mondayWebhook("CLICK0", EXACT, p0, REP);
    await Promise.race([ep.reached, Promise.allSettled(w0)]);
    clock(T("09:00:03"));
    const pK = eventValue(COARSE); rep(COARSE, "Won");
    const wK = await mondayWebhook("CLICK2", COARSE, pK, REP, { changedAt: Date.parse(T("09:00:03")) });
    clock(T("09:00:12")); ep.release();
    await settleAll([...w0, ...wK]);
    await pass(...LATER);
    const r = stages();
    expect(r.hs, "the newer Won reaches HubSpot\n" + trail()).toBe("closedwon");
    expect(r.coarse).toBe("Won");
    expect(r.exact).toBe(DICTS.stages.closedwon);
  });

  it("the refused write's two-way cells are left due for a converge -- even when no mark of the run survives to retry it", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("presentationscheduled");
    const lost = vi.spyOn(CreateIdempotency.prototype, "markEdits").mockRejectedValueOnce(new Error("DO unreachable"));
    clock(T("09:00:00"));
    const p0 = eventValue(COARSE); rep(COARSE, "New");
    const ep = rateLimitEpisode("CLICK0");
    const w0 = await mondayWebhook("CLICK0", COARSE, p0, REP);
    await Promise.race([ep.reached, Promise.allSettled(w0)]);
    ep.release();                                                          // (a write that waited would land now)
    await settleAll(w0);
    expect(lost, "the edit's mark was never written").toHaveBeenCalledTimes(1);
    expect(w().hs.properties.dealstage, trail()).toBe("appointmentscheduled");
    expect(cell(EXACT), "its consequence write was refused").toBe(DICTS.stages.presentationscheduled);
    await pass(...LATER);
    expect(cell(EXACT), "converged to what HubSpot holds\n" + trail()).toBe(DICTS.stages.appointmentscheduled);
    expect(stages().sent).toEqual(["appointmentscheduled"]);
  });

  it("RETRY on, a write of no two-way cell but the edited one (a contact's Lifecycle: no sibling) keeps gql's own waits -- its No Activity release is never skipped", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    const contacts = specByObject(ENVC, "contacts")!;
    setWorld(makeWorld(contacts, { hsId: "382447", itemId: "2856382447", created: "2026-07-18T12:40:00.000Z", synced: S0,
      props: { firstname: "Pat", lastname: "Lee", email: "pat@example.com", lifecyclestage: "lead" } }));
    const LIFE = field(contacts, "lifecyclestage").col;
    clock(T("09:00:00"));
    const prev = eventValue(LIFE); rep(LIFE, "5.No intention");
    await settleAll(await mondayWebhook("EDIT", LIFE, prev, REP));
    expect(pushes(), trail()).toEqual([{ lifecyclestage: "1029060900" }]);
    const writes = monday.setColumns.mock.calls.filter(c => PASS(c[0]) === "EDIT");
    expect(writes.length, trail()).toBeGreaterThan(0);
    for (const c of writes) expect(c, "no waits argument").toHaveLength(5);
  });

  it("RETRY off (live): the edit run's write keeps gql's own waits, exactly as at HEAD", async () => {
    deal("presentationscheduled");
    clock(T("09:00:00"));
    const p0 = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);
    await settleAll(await mondayWebhook("CLICK0", EXACT, p0, REP));
    const writes = [...monday.setColumns.mock.calls, ...monday.updateItem.mock.calls].filter(c => PASS(c[0]) === "CLICK0");
    expect(writes.length, trail()).toBeGreaterThan(0);
    for (const c of monday.setColumns.mock.calls.filter(x => PASS(x[0]) === "CLICK0")) expect(c, "no waits argument").toHaveLength(5);
    for (const c of monday.updateItem.mock.calls.filter(x => PASS(x[0]) === "CLICK0")) expect(c).toHaveLength(6);
  });
});

// ===================================================================================================================
// [S6] A SIBLING CELL A FORWARD PASS WROTE DURING A RETRY'S PATCH IS NOT A PERSON'S EDIT
// ===================================================================================================================
/**
 * A HubSpot user moves the deal at 09:00:00 (its forward pass is LATE); the rep sets HubSpot Stage = Closed Won at
 * 09:00:10 (run dead before its PATCH). RETRY on: the mark's retry runs at 09:01:11, and the late forward pass -- having
 * read HubSpot BEFORE the retry's PATCH -- writes the coarse Stage AFTER the PATCH lands, before the retry reads the
 * card back. RETRY off: the late forward pass runs at 09:01:12.
 */
async function staleForwardDuringRetry(retry: boolean, start: string, hsUser: string) {
  setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
  deal(start);
  clock(T("09:00:00"));
  W_.hubspotSets("dealstage", hsUser, T("09:00:00"), "CRM_UI");
  w().hs.properties.hs_v2_date_entered_current_stage = T("09:00:00");
  clock(T("09:00:10"));
  const prev = eventValue(EXACT); rep(EXACT, DICTS.stages.closedwon);
  w().failGetRecord = "CLICK1";
  await settleAll(await mondayWebhook("CLICK1", EXACT, prev, REP));
  w().failGetRecord = undefined;
  if (retry) {
    const r0 = await retryHeldAt("09:01:11", "patch");                     // past its last look, about to PATCH
    const back = hold("RTRY", "card");                                      // its read-back, once the PATCH returned
    clock(T("09:01:12"));
    const atWrite = hold("HSWH", "write");
    const f = W_.hubspotPass("HSWH", { dealstage: [T("09:00:00"), false] });
    await reach(atWrite, f, "the forward pass's monday write");           // it read HubSpot BEFORE the PATCH
    clock(T("09:01:13")); w().mods.push(T("09:01:13"));
    r0.release();
    await reach(back, r0.run, "the retry's read-back");                    // the PATCH has landed
    expect(w().hs.properties.dealstage, "the retry's PATCH landed").toBe("closedwon");
    atWrite.release(); await f;                                            // the stale forward write lands now
    back.release(); await r0.run;
    clock(T("09:01:15")); await drain();
  } else {
    clock(T("09:01:12"));
    await W_.hubspotPass("HSWH", { dealstage: [T("09:00:00"), false] });
  }
  await pass("09:01:20", "09:02:30", "09:04:00", "09:06:00", "09:10:00", "09:20:00", "09:40:00");
  return stages();
}

describe("[S6] a raced sibling is never re-sent on the card's word: a forward pass's stale write of it is not a person's edit", () => {
  it("V1 RETRY on: the stale coarse Stage is held and converged -- HubSpot's older stage is never re-sent over the rep's newer Closed Won", async () => {
    const r = await staleForwardDuringRetry(true, "presentationscheduled", "contractsent");
    expect(r.sent, "only the rep's edit\n" + trail()).toEqual(["closedwon"]);
    expect(logged(/cols=deal_stage action=edit-retry-raced/), "never marked as a person's raced edit").toBe(false);
    expect(logged(/cols=deal_stage action=forward-held reason="another cell feeding the same HubSpot property/)).toBe(true);
    expect(r.hs).toBe("closedwon");
    expect(r.exact).toBe(DICTS.stages.closedwon);
    expect(r.coarse, "the held Stage converges to the newer edit's bucket").toBe("Won");
  });

  it("V2 RETRY on, another bucket: the deal never lands on a stage nobody chose", async () => {
    const r = await staleForwardDuringRetry(true, "appointmentscheduled", "decisionmakerboughtin");
    expect(r.sent, trail()).toEqual(["closedwon"]);
    expect(r.hs).toBe("closedwon");
  });

  it.each([["presentationscheduled", "contractsent"], ["appointmentscheduled", "decisionmakerboughtin"]])(
    "RETRY off (live) control, from %s: the HubSpot user's %s stands, nothing pushed", async (start, hsUser) => {
      const r = await staleForwardDuringRetry(false, start, hsUser);
      expect(r.sent, trail()).toEqual([]);
      expect(r.hs).toBe(hsUser);
    });

  /** Accounts: a HubSpot user's rename (09:00:00, its forward pass late); the rep's newer Name-column edit (09:00:10, run
   *  dead). The forward pass writes the item name with the older name during the retry's PATCH window. */
  async function accountStaleForward(retry: boolean) {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
    company();
    clock(T("09:00:00"));
    W_.hubspotSets("name", "Acme Corp", T("09:00:00"), "CRM_UI");
    clock(T("09:00:10"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    w().failGetRecord = "NAMECOL";
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP));
    w().failGetRecord = undefined;
    if (retry) {
      const r0 = await retryHeldAt("09:01:11", "patch");
      const back = hold("RTRY", "card");
      clock(T("09:01:12"));
      const atWrite = hold("HSWH", "write");
      const f = W_.hubspotPass("HSWH", { name: [T("09:00:00"), false] });
      await reach(atWrite, f, "the forward pass's monday write");
      clock(T("09:01:13")); w().mods.push(T("09:01:13"));
      r0.release();
      await reach(back, r0.run, "the retry's read-back");
      atWrite.release(); await f;
      back.release(); await r0.run;
      clock(T("09:01:15")); await drain();
    } else {
      clock(T("09:01:12"));
      await W_.hubspotPass("HSWH", { name: [T("09:00:00"), false] });
    }
    await pass("09:01:20", "09:02:30", "09:04:00", "09:06:00", "09:10:00", "09:20:00", "09:40:00");
    return names();
  }
  it("V6 RETRY on: the HubSpot user's older name, written on the item by a stale forward pass, is never pushed as ours over the rep's newer edit", async () => {
    const r = await accountStaleForward(true);
    expect(r.sent, trail()).toEqual(["Acme Holdings"]);
    expect(logged(/cols=~name action=edit-retry-raced/)).toBe(false);
    expect(r.hs).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item, "the held item name converges").toBe("Acme Holdings");
  });
  it("V7 RETRY off (live) control: nothing pushed", async () => {
    const r = await accountStaleForward(false);
    expect(r.sent, trail()).toEqual([]);
  });
});

// ===================================================================================================================
// [M7] / [M8] THE LEDGER'S DATES AND ITS RE-READ
// ===================================================================================================================
describe("[M7] a retry dates its push of each property by that property's own cells", () => {
  const CITY = "text_mm6tdrdn";
  /** RS-N2: the [LOW] case -- a rename (run dead), then a newer Name-column edit by a person working as ask ada misread
   *  as our echo (no mark) -- with an unrelated City edit (run dead) retried in the SAME retry as the rename. */
  async function run(withCity: boolean) {
    setEnv({ STALE_FORWARD_RETRY: "true", ASK_ADA_UI_EDITS: "true" });
    company();
    clock(T("09:00:00")); renameOnCard("Acme Group"); await renameHook("RENAME", { dies: true });
    clock(T("09:00:20"));
    rep(NAME_COL(), "Acme Holdings", { userId: ASK_ADA, uuid: true });
    await W_.mondayEdit("SELF", [NAME_COL()], { selfOrigin: true });
    if (withCity) {
      clock(T("09:00:40"));
      const prev = eventValue(CITY); rep(CITY, "Shenzhen");
      w().failGetRecord = "CITY";
      await settleAll(await mondayWebhook("CITY", CITY, prev, REP));
      w().failGetRecord = undefined;
    }
    clock(T("09:02:00"));                                                  // the retry runs late: every mark is due
    w().mods.push(T("09:02:01"));
    expect(await fireWatch(true)).toBe(true);
    await drain();
    const ledger = ((await watchState())?.pushes ?? []).filter(p => !p.inLine)
      .map(p => ({ prop: p.prop, value: p.value, keys: p.keys, a: p.a }));
    w().mods.push(T("09:06:01"), T("09:06:02"), T("09:10:01"));
    for (const t of ["09:03:00", "09:04:10", "09:06:00", "09:10:00", "09:20:00", "09:40:00"]) await advance(T(t));
    return { ...names(), ledger };
  }
  it("CONTROL (no City): the misread newer Name-column edit is rescued", async () => {
    const r = await run(false);
    expect(r.hs, trail()).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
  });
  it("with a later City edit in the same retry: `name` is dated by the rename alone -- the newer Name-column edit is still rescued", async () => {
    const r = await run(true);
    expect(r.hs, "the newest name edit (09:00:20) ends in HubSpot\n" + trail()).toBe("Acme Holdings");
    expect(r.col).toBe("Acme Holdings");
    expect(r.item).toBe("Acme Holdings");
    expect(r.ledger.find(p => p.prop === "name" && p.value === "Acme Group"), "the retry's push of the rename")
      .toEqual({ prop: "name", value: "Acme Group", keys: ["~name"], a: Date.parse(T("09:00:00")) });
    expect(r.ledger.find(p => p.prop === "city"))
      .toEqual({ prop: "city", value: "Shenzhen", keys: [CITY], a: Date.parse(T("09:00:40")) });
  });
});

describe("[M8] an OLDER sibling's slow push recorded after a newer edit's retry began is this card's own, judged by its edit", () => {
  /** RS-N3: the Name column (09:00:00) -- its run stalled at its card read; the rename (09:00:10) -- run dead. The
   *  rename's retry begins at 09:01:11 and is held at its history read while the stalled run pushes the older value. */
  async function run(retry: boolean) {
    setEnv({ STALE_FORWARD_RETRY: retry ? "true" : "false" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    const slow = hold("NAMECOL", "card");
    const wN = await mondayWebhook("NAMECOL", NAME_COL(), prev, REP);
    await reach(slow, Promise.allSettled(wN), "the Name column's card read");
    clock(T("09:00:10")); renameOnCard("Acme Group"); await renameHook("RENAME", { dies: true });
    let r0: { run: Promise<string>; release: () => void } | undefined;
    if (retry) r0 = await retryHeldAt("09:01:11", "history");
    clock(T("09:01:12")); w().mods.push(T("09:01:12"));
    slow.release(); await settleAll(wN);                                   // the OLDER edit's run finally pushes
    if (r0) { clock(T("09:01:13")); w().mods.push(T("09:01:14")); r0.release(); await r0.run; }
    w().mods.push(T("09:03:01"), T("09:03:02"), T("09:06:01"));
    for (const t of ["09:02:00", "09:03:00", "09:05:00", "09:08:00", "09:20:00", "09:40:00"]) await advance(T(t));
    return names();
  }
  it("RETRY on: the newer rename ends on both sides", async () => {
    const r = await run(true);
    expect(logged(/cols=~name action=edit-retry-superseded/), "never superseded by the older edit's push\n" + trail()).toBe(false);
    expect(r.hs, "the newer rename (09:00:10) ends in HubSpot\n" + trail()).toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });

  it("...and when that push lands after the retry's own checks, before its last look (retryGate reads the ledger again too)", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    const slow = hold("NAMECOL", "card");
    const wN = await mondayWebhook("NAMECOL", NAME_COL(), prev, REP);
    await reach(slow, Promise.allSettled(wN), "the Name column's card read");
    clock(T("09:00:10")); renameOnCard("Acme Group"); await renameHook("RENAME", { dies: true });
    const r0 = await retryHeldAt("09:01:11", "hs");                        // past its own checks, before its last look
    clock(T("09:01:12")); w().mods.push(T("09:01:12"));
    slow.release(); await settleAll(wN);
    clock(T("09:01:13")); w().mods.push(T("09:01:14")); r0.release(); await r0.run;
    expect(logged(/cols=~name action=edit-retry-superseded/), "never superseded by the older edit's push\n" + trail()).toBe(false);
    await pass("09:02:00", "09:03:00", "09:05:00", "09:08:00", "09:20:00", "09:40:00");
    const r = names();
    expect(r.hs, trail()).toBe("Acme Group");
    expect(r.item).toBe("Acme Group");
    expect(r.col).toBe("Acme Group");
  });
});

describe("[S2]/[M8] the retry's last look (retryGate) reads the ledger and the marks again", () => {
  it("a newer HubSpot Stage pick that HubSpot already held, resolved while the Won retry was between its checks and its last look: Won is never sent", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    deal("contractsent");
    clock(T("09:00:00"));
    const pK = eventValue(COARSE); rep(COARSE, "Won");
    w().failGetRecord = "CLICK1";
    await settleAll(await mondayWebhook("CLICK1", COARSE, pK, REP));
    w().failGetRecord = undefined;
    const r0 = await retryHeldAt("09:01:01", "hs");
    clock(T("09:01:02"));
    const p1 = eventValue(EXACT); rep(EXACT, DICTS.stages.decisionmakerboughtin);
    const atCard = hold("PICK1", "card");
    const w1 = await mondayWebhook("PICK1", EXACT, p1, REP);
    await reach(atCard, Promise.allSettled(w1), "the pick's card read");
    clock(T("09:01:03"));
    const p2 = eventValue(EXACT); rep(EXACT, DICTS.stages.contractsent);      // back to what HubSpot holds
    const w2 = await mondayWebhook("PICK2", EXACT, p2, REP);
    atCard.release(); await settleAll([...w1, ...w2]);
    expect(pushes(), "nothing to send for the pick").toEqual([]);
    clock(T("09:01:04")); r0.release(); await r0.run;
    expect(logged(new RegExp(`cols=${COARSE} action=edit-retry-superseded reason="HubSpot changed it after the edit, read right`
      + ` before the push`)), trail()).toBe(true);
    await pass(...LATER.slice(2));
    expect(stages().sent, "the OLDER Won is never sent\n" + trail()).toEqual([]);
    expect(stages().hs).toBe("contractsent");
  });

  it("a rename on the card before the retry read it, its webhook marked while the retry waited before its last look: the older Name-column value is never sent", async () => {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    w().failGetRecord = "NAMECOL";
    await settleAll(await mondayWebhook("NAMECOL", NAME_COL(), prev, REP));
    w().failGetRecord = undefined;
    clock(T("09:00:50")); renameOnCard("Acme Group");                     // its webhook is late
    const r0 = await retryHeldAt("09:01:01", "hs");
    clock(T("09:01:02"));
    const atHs = hold("RENAME", "hs");                                     // the rename's own run, before its PATCH
    const wR = await mondayWebhook("RENAME", "", {}, REP, { type: "update_name", changedAt: Date.parse(T("09:00:50")) });
    await reach(atHs, Promise.allSettled(wR), "the rename's HubSpot read");
    clock(T("09:01:03")); r0.release(); await r0.run;
    expect(pushes(), "the older value is not sent while the newer edit is on its way\n" + trail()).toEqual([]);
    expect(logged(/cols=text_mm6t1q4h action=edit-retry-deferred/)).toBe(true);
    clock(T("09:01:04")); w().mods.push(T("09:01:05")); atHs.release(); await settleAll(wR);
    await pass(...LATER.slice(2));
    const r = names();
    expect(r.sent, trail()).toEqual(["Acme Group"]);
    expect([r.hs, r.item, r.col]).toEqual(["Acme Group", "Acme Group", "Acme Group"]);
  });
});

// ===================================================================================================================
// [M9] A RETRY'S MONDAY READS AND ITS RUN'S ALLOWANCE
// ===================================================================================================================
describe("[M9] a retry's monday reads are patient only within its run's allowance, and a rate-limited read before the PATCH spends no attempt", () => {
  async function markedName(): Promise<void> {
    setEnv({ STALE_FORWARD_RETRY: "true" });
    company();
    clock(T("09:00:00"));
    const prev = eventValue(NAME_COL()); rep(NAME_COL(), "Acme Holdings");
    w().failGetRecord = "EDIT";
    await settleAll(await mondayWebhook("EDIT", NAME_COL(), prev, REP));
    w().failGetRecord = undefined;
    clock(T("09:01:01"));
    expect(await fireWatch()).toBe(true);
    W_.spilled.length = 0;
  }

  it("each card read is given the waits its run's allowance still covers -- none once it is spent", async () => {
    await markedName();
    w().mods.push(T("09:01:02"));
    await retryMarkedEdits(as("WAVE"), w().spec.boardId, w().card.id, live, { left: 30 });
    const fresh = monday.getItem.mock.calls.filter(c => PASS(c[0]) === "WAVE").map(c => c[2]);
    expect(fresh.length, trail()).toBeGreaterThanOrEqual(3);                // its read, the edit's, the last look, the read-back
    expect(new Set(fresh), "a fresh allowance (120 s) covers one of monday's waits (65 s each)").toEqual(new Set([1]));
    expect(w().hs.properties.name).toBe("Acme Holdings");
    monday.getItem.mockClear();
    clock(T("09:02:00")); rep(NAME_COL(), "Acme Corp");
    w().failGetRecord = "EDIT2";
    await settleAll(await mondayWebhook("EDIT2", NAME_COL(), eventValue(NAME_COL()), REP));
    w().failGetRecord = undefined;
    clock(T("09:03:01")); expect(await fireWatch()).toBe(true); W_.spilled.length = 0;
    w().mods.push(T("09:03:02"));
    await retryMarkedEdits(as("WAVE"), w().spec.boardId, w().card.id, live, { left: 30, patientMs: 0 } as Budget);
    const spent = monday.getItem.mock.calls.filter(c => PASS(c[0]) === "WAVE").map(c => c[2]);
    expect(new Set(spent), "the allowance spent: one try each, no waits").toEqual(new Set([0]));
  });

  it("a card read refused for monday's rate limit inside the edit's own path (before any PATCH) gives the mark its attempt back", async () => {
    await markedName();
    const before = (await watchState())!.marks[NAME_COL()];
    let n = 0;
    const real = monday.getItem.getMockImplementation()!;
    monday.getItem.mockImplementation(async (env: unknown, ...rest: unknown[]) => {
      if (PASS(env) === "WAVE" && ++n === 2) {                             // the edit path's own card read (syncMondayItem)
        const e = new Error("monday 429: rate-limited after 0 waits"); e.name = "MondayRateLimitedError";
        throw e;
      }
      return (real as any)(env, ...rest);
    });
    await expect(retryMarkedEdits(as("WAVE"), w().spec.boardId, w().card.id, live, { left: 30, patientMs: 0 } as Budget))
      .rejects.toThrow(/rate-limited/);
    expect(pushes(), "nothing was sent").toEqual([]);
    expect(logged(/action=edit-retry-refunded/), trail()).toBe(true);
    expect((await watchState())!.marks[NAME_COL()].attempts, "the attempt is given back").toBe(before.attempts);
  });
});
