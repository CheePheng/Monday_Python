import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import type { Ctx, Env, FieldSpec, HsRecord, MondayItem, RunOpts } from "../src/types";
import { PIPELINES, SALES, SF_SALES, SF_MAINT, SF_TRAIN, SHARED, PARTIAL, TRUSTPILOT, SF, SFM, SFT,
  EXPECTED_TARGETS, IN_BUCKET_NOT_TARGET } from "./fixtures/deal-pipelines";

/**
 * STAGE_COARSE_REVERSE: A PERSON'S EDIT OF THE DEALS BOARD'S NATIVE STAGE, SENT TO HUBSPOT.
 *
 * The coloured Stage column (`deal_stage`) shows five labels -- New / Proposal / Negotiation / Won / Lost
 * -- summarising 42 HubSpot stages across 5 pipelines (coarseStageOf). The user approved making it
 * two-way with "only the 5 real labels would be kept". A many-to-one map has no inverse, so the way back
 * is CHOSEN, and every choice is pinned here:
 *   - within the deal's CURRENT pipeline, never another one;
 *   - nothing at all when HubSpot's stage already reads as that label;
 *   - otherwise the first stage coarseStageOf puts in that bucket -- the LAST for Lost, so 输单 and never
 *     暂停 -- sent with its pipeline;
 *   - anything else refused and snapped back, but never back onto Won (the board's Won automations);
 *     the exact HubSpot Stage column wins over it;
 *   - an automation's edit and our own echo never push.
 *
 * The pipelines are the portal's real ones (test/fixtures/deal-pipelines.ts, measured 2026-10-01).
 *
 * Part 1 is columnEditPatch alone. Part 2 drives monday webhooks through the real handleMonday ->
 * syncMondayItem -> column-level push, with HubSpot and monday as small stateful fakes, so each claim is
 * proven by what the two systems end up holding.
 */

// ------------------------------------------------------------------------------------------ mocks

const hs = vi.hoisted(() => ({
  getRecord: vi.fn(), patchRecord: vi.fn(), claimOwnership: vi.fn(), createRecord: vi.fn(),
  getCrmStageDicts: vi.fn(), getDealStageLabels: vi.fn(), getOwners: vi.fn(), getPropertyOptions: vi.fn(),
  searchAll: vi.fn(), searchModifiedIds: vi.fn(), searchContactByEmail: vi.fn(), searchCompanyByDomain: vi.fn(),
  getAssociatedIds: vi.fn(), createNote: vi.fn(),
}));
// The real module for everything pure (coarseStageOf, crmStageDictsOf, coarseTargetsFor, propertiesForSpec).
vi.mock("../src/hubspot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hubspot")>()), ...hs,
}));
const mondayApi = vi.hoisted(() => ({
  getItem: vi.fn(), setColumns: vi.fn(), updateItem: vi.fn(), findItemByColumn: vi.fn(), createItem: vi.fn(),
  deleteItem: vi.fn(), moveItem: vi.fn(), getUsersByEmail: vi.fn(), getBoardItems: vi.fn(),
  getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(), getUserById: vi.fn(), whoAmI: vi.fn(),
}));
vi.mock("../src/monday", () => mondayApi);
vi.mock("../src/actor-label", () => ({
  isIntegrationActor: vi.fn(async (_e: unknown, id: string) => !id || id === "104118038"),
  isAutomationActor: (id: string) => /^-\d+$/.test(String(id ?? "").trim()),
  actorLabel: vi.fn(async () => "actor=x"),
}));
vi.mock("../src/associations", () => ({
  reverseAssociations: vi.fn(async () => undefined), reverseLineItems: vi.fn(), syncAssociations: vi.fn(),
  pushBirthAssociations: vi.fn(), reverseSubitemEdit: vi.fn(),
}));
vi.mock("../src/card-registry", () => ({
  lookupCard: vi.fn(async () => null), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(), createWindowOf: vi.fn(async () => ({ settling: false })),
  lookupCardOwner: vi.fn(async () => null),
}));

const { handleMonday } = await import("../src/webhooks");
const { resetCtxCache, syncHubspotObject } = await import("../src/sync");
const { webhookOpts } = await import("../src/run-opts");
const { buildUpdatePayload, columnEditPatch, coarseStageField, exactStageField, fieldDiffs } = await import("../src/reconcile");
const { coarseStageOf, coarseStageTargets, coarseTargetsFor, crmStageDictsOf } = await import("../src/hubspot");

// ------------------------------------------------------------------------------------------ fixtures

const COARSE = "deal_stage";
const EXACT = "dropdown_mm7624zd";          // "HubSpot Stage": the exact, two-way stage
const PIPE = "dropdown_mm76s7kk";
const LABELS = ["New", "Proposal", "Negotiation", "Won", "Lost"] as const;
/** monday's own label ids on the Stage column, the leftovers included (see the task notes). */
const STATUS_INDEX: Record<string, number> = { Negotiation: 0, Won: 1, Lost: 2, Proposal: 3, New: 4,
  "Closed Lost": 9, "Appointment Scheduled": 10, "Presentation Scheduled": 12, Discovery: 15 };

const DICTS = crmStageDictsOf(PIPELINES);
const ctx = (): Ctx => ({
  labels: { crmStage: DICTS.stages, crmPipeline: DICTS.pipelines, crmCoarseStage: DICTS.coarse },
  ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {},
  pipelineByStage: DICTS.pipelineByStage, portalId: 1,
});

const MOD = "2026-09-29T02:00:00.000Z";     // HubSpot's modified time the card was last synced to
const PRE = "2026-01-22T06:46:54Z";         // an established deal, long outside any create window
/**
 * When the deal entered its current stage (hs_v2_date_entered_current_stage): before the card's Sync State,
 * as on every card whose stage the card already shows. Measured live 2026-10-01 on the 12 of the 150 most
 * recently updated cards whose stage was last set by an integration: 344 ms to 15 days before Sync State.
 * A fixture that models a HubSpot STAGE change moves it too, as HubSpot does (it equals the dealstage
 * history's own timestamp on 150 of 150); one that models any other HubSpot change does not.
 */
const ENTERED = "2026-09-29T01:59:59.656Z";
const DEAL = "9001";

const statusCell = (text: string) => ({ id: COARSE, text, status_index: text ? (STATUS_INDEX[text] ?? 5) : null });
function item(cells: { coarse: string; exact?: string; pipe?: string }): MondayItem {
  return { id: "CARD", name: "Acme renewal", created_at: PRE, updated_at: MOD, group: { id: "topics" },
    column_values: [
      { id: CRM_DEALS.idCol, text: DEAL }, { id: CRM_DEALS.syncStateCol, text: MOD }, statusCell(cells.coarse),
      { id: EXACT, text: cells.exact ?? "" }, { id: PIPE, text: cells.pipe ?? "" },
    ] };
}
const rec = (stage: string, pipeline: string, over: Record<string, string> = {}): HsRecord => ({
  id: DEAL, properties: { dealname: "Acme renewal", dealstage: stage, pipeline, hs_lastmodifieddate: MOD,
    hs_v2_date_entered_current_stage: ENTERED, createdate: PRE, sync_owner: "crm", ...over },
});
/** The card as the forward sync leaves it for HubSpot's `stage`, with the person's Stage pick on top. */
const cardAt = (stage: string, pick: string) => item({ coarse: pick, exact: DICTS.stages[stage],
  pipe: DICTS.pipelines[DICTS.pipelineByStage[stage]] });
const patchFor = (r: HsRecord, it: MondayItem, cols: string[] = [COARSE], extra: Record<string, unknown> = {}) =>
  columnEditPatch(r, it, CRM_DEALS, ctx(), { cols, ...extra });
const coarseField = () => CRM_DEALS.fields.find(f => f.col === COARSE)!;
const healedCols = (heal: { col: string }[]) => heal.map(f => f.col);

let logs: string[];
const logged = (re: RegExp) => logs.some(l => re.test(l));

// ================================================================================ part 1: the mapping

const stagesOf = (id: string) => PIPELINES.find(p => p.id === id)!.stages;
const stageLabel = (pipeline: string, stage: string) => stagesOf(pipeline).find(s => s.id === stage)?.label;

describe("the way back is coarseStageOf's own buckets (coarseStageTargets)", () => {
  it.each(PIPELINES.map(p => [p.label, p] as const))("%s: each label -> its bucket's first stage (last, for Lost)", (_n, p) =>
    expect(coarseStageTargets(p.stages)).toEqual(EXPECTED_TARGETS[p.id]));

  it("every stage it chooses reads back as the label that chose it, so nothing can churn", () => {
    for (const p of PIPELINES) {
      const bucket = coarseStageOf(p.stages);
      for (const [label, stage] of Object.entries(coarseStageTargets(p.stages))) expect(bucket[stage]).toBe(label);
    }
  });

  /** Sales Pipeline's Trustpilot step is a second Won-bucket stage, AFTER Closed Won, with a NUMERIC id:
   *  a JS object enumerates it FIRST, and the fixture's array lists it first too. Only displayOrder says
   *  which is the pipeline's first Won stage. */
  it("Won with several Won-bucket stages is the lowest displayOrder, not the first by key or array order", () => {
    const sales = stagesOf(SALES);
    expect(coarseStageOf(sales)[TRUSTPILOT]).toBe("Won");
    expect(Object.keys(coarseStageOf(sales))[0]).toBe(TRUSTPILOT);   // key order would pick the wrong one
    expect(sales[0].id).toBe(TRUSTPILOT);                             // and so would array order
    expect(coarseStageTargets(sales).Won).toBe("closedwon");
  });

  /**
   * THE 2026-10-01 FINDING. Every Salesforce pipeline holds 暂停 (Paused) and 输单 (Lost) with identical
   * metadata, 暂停 first. Taking the first stage of the Lost bucket sent a person's Lost to Paused on the
   * pipelines that hold ~7,900 of the portal's 8,651 deals.
   */
  it.each([["SF-Sales", SF_SALES, SF], ["SF-Maint", SF_MAINT, SFM], ["SF-Train", SF_TRAIN, SFT]] as const)(
    "%s: 暂停 and 输单 are both in the Lost bucket, and Lost is 输单 -- never the 暂停 before it", (_n, pid, ids) => {
      const stages = stagesOf(pid);
      const bucket = coarseStageOf(stages);
      expect([bucket[ids.paused], bucket[ids.lost]]).toEqual(["Lost", "Lost"]);
      expect(stageLabel(pid, ids.paused)).toBe("暂停");
      expect(coarseStageTargets(stages).Lost).toBe(ids.lost);
      expect(stageLabel(pid, coarseStageTargets(stages).Lost!)).toBe("输单");
    });

  it("on all five live pipelines Lost is the terminal lost stage (输单 / Closed Lost)", () => {
    const terminal: Record<string, string> = { [SALES]: "Closed Lost", [SF_SALES]: "输单", [SF_MAINT]: "输单",
      [SF_TRAIN]: "输单", [SHARED]: "Closed Lost" };
    for (const [pid, want] of Object.entries(terminal))
      expect([pid, stageLabel(pid, coarseStageTargets(stagesOf(pid)).Lost!)]).toEqual([pid, want]);
  });

  /** SF-Sales' array lists 输单 FIRST and 暂停 LAST: array order would get Lost wrong either way round. */
  it("Lost is the last by displayOrder, not by array order", () => {
    const sf = stagesOf(SF_SALES);
    expect([sf[0].id, sf[sf.length - 1].id]).toEqual([SF.lost, SF.paused]);
    expect(coarseStageTargets(sf).Lost).toBe(SF.lost);
  });

  it("the targets are registered beside the dictionary they were built with, and nowhere else", () => {
    expect(coarseTargetsFor(DICTS.coarse)).toEqual(EXPECTED_TARGETS);
    expect(coarseTargetsFor({ ...DICTS.coarse })).toBeUndefined();   // a copy is not the same dictionary
    expect(coarseTargetsFor(undefined)).toBeUndefined();
  });

  it("the Deals spec's coarse and exact stage fields are the ones the board has; other specs have none", () => {
    expect(coarseStageField(CRM_DEALS)?.col).toBe(COARSE);
    expect(exactStageField(CRM_DEALS)?.col).toBe(EXACT);
    expect(coarseStageField(CRM_CONTACTS)).toBeUndefined();
    // Still one-way in the spec: with the flag off, the webhook ignores it exactly as before.
    expect(coarseField()).toMatchObject({ oneWay: true, strictDict: true, labels: "crmCoarseStage" });
  });
});

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("each of the five labels, on the Sales pipeline and on a Salesforce pipeline", () => {
  const cases = LABELS.flatMap(l => [
    [l, "Sales", SALES, l === "New" ? "contractsent" : "appointmentscheduled"],
    [l, "SF-Sales", SF_SALES, l === "New" ? SF.s5 : SF.s1],
  ] as const);

  it.each(cases)("%s on %s -> that pipeline's first %s-bucket stage, sent WITH its pipeline", (label, _n, pipeline, from) => {
    const r = patchFor(rec(from, pipeline), cardAt(from, label));
    expect(r.patch).toEqual({ dealstage: EXPECTED_TARGETS[pipeline][label], pipeline });
    expect(r.heal).toEqual([]);
    expect(r.refusals).toEqual([]);
    expect(logged(new RegExp(`col=deal_stage label=${label} pipeline=${pipeline} stage=${EXPECTED_TARGETS[pipeline][label]} previous=${from} action=coarse-mapped`))).toBe(true);
  });

  /** The reviewer's probe, on each Salesforce pipeline: a deal at "5 决定 Decide", a person picks Lost. */
  it.each([["SF-Sales", SF_SALES, SF], ["SF-Maint", SF_MAINT, SFM], ["SF-Train", SF_TRAIN, SFT]] as const)(
    "Lost on a %s deal at 5 决定 Decide -> 输单, with its pipeline", (_n, pid, ids) => {
      const r = patchFor(rec(ids.s5, pid), cardAt(ids.s5, "Lost"));
      expect(r.patch).toEqual({ dealstage: ids.lost, pipeline: pid });
      expect(r.patch.dealstage).not.toBe(ids.paused);
    });
});

describe("already in that bucket: NOTHING is sent", () => {
  const cases = Object.entries(IN_BUCKET_NOT_TARGET).flatMap(([p, byLabel]) =>
    Object.entries(byLabel).map(([label, stage]) => [label, p, stage] as const));

  it.each(cases)("%s on pipeline %s while HubSpot is at %s (in the bucket, not its target)", (label, p, stage) => {
    const r = patchFor(rec(stage, p), cardAt(stage, label));
    expect(r.patch).toEqual({});
    expect(r.heal).toEqual([]);
    expect(logged(/action=coarse-in-bucket/)).toBe(true);
  });

  /** This column cannot tell Paused from Lost -- 暂停 already shows Lost -- so Lost keeps it where it is.
   *  Moving a paused deal to 输单 is HubSpot Stage's job. */
  it("a paused deal (暂停) already reads as Lost: Lost sends nothing and leaves it paused", () => {
    const r = patchFor(rec(SF.paused, SF_SALES), cardAt(SF.paused, "Lost"));
    expect(r).toEqual({ patch: {}, heal: [], healName: false, refusals: [] });
  });

  it("Won on a deal already closed won (a card automation 31010016 left on New)", () => {
    const r = patchFor(rec("closedwon", SALES), cardAt("closedwon", "Won"));
    expect(r).toEqual({ patch: {}, heal: [], healName: false, refusals: [] });
  });
});

describe("anything but the five labels is refused, and the cell snapped back to HubSpot's", () => {
  it.each(["Discovery", "Appointment Scheduled", "Presentation Scheduled", "Closed Lost", ""])("%j", (label) => {
    const r = patchFor(rec("presentationscheduled", SALES), cardAt("presentationscheduled", label));
    expect(r.patch).toEqual({});
    expect(healedCols(r.heal)).toEqual([COARSE]);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatch(/^dealstage via deal_stage: /);
    // The heal is the ordinary one: the cell is rewritten with HubSpot's own coarse label.
    const cv = buildUpdatePayload(r.heal.map(f => ({ kind: "field" as const, f, hsText: "", mdText: "" })),
      rec("presentationscheduled", SALES), CRM_DEALS, ctx());
    expect(cv[COARSE]).toEqual({ label: "Proposal" });
  });

  /** An UNSET status reads its index-5 label as text with a null index (monday-phantom-status). */
  it("an unset cell that merely READS as a label is a blank, not that label", () => {
    const it0 = cardAt("appointmentscheduled", "Won");
    it0.column_values = it0.column_values.map(c => c.id === COARSE ? { ...c, status_index: null } : c);
    const r = patchFor(rec("appointmentscheduled", SALES), it0);
    expect(r.patch).toEqual({});
    expect(r.refusals[0]).toMatch(/cannot be emptied/);
  });
});

describe("the exact HubSpot Stage is authoritative and wins", () => {
  it("both edited in one change: the exact stage is sent, the coarse one refused and healed", () => {
    const it0 = item({ coarse: "Won", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" });
    const r = patchFor(rec("appointmentscheduled", SALES), it0, [COARSE, EXACT]);
    expect(r.patch).toEqual({ dealstage: "contractsent", pipeline: SALES });
    expect(healedCols(r.heal)).toEqual([COARSE]);
    expect(r.refusals.join(" ")).toMatch(/exact stage wins/);
  });

  /** The one case only the same-change rule decides: the exact edit leaves the stage where HubSpot has it,
   *  so no other guard sees a difference -- and the exact stage (unchanged) still wins over the label. */
  it("both edited in one change, the exact one left where HubSpot has it: nothing is sent, the label is healed", () => {
    const it0 = item({ coarse: "Won", exact: "Sales / Appointment Scheduled", pipe: "Sales Pipeline" });
    const r = patchFor(rec("appointmentscheduled", SALES), it0, [COARSE, EXACT]);
    expect(r.patch).toEqual({});
    expect(healedCols(r.heal)).toEqual([COARSE]);
    expect(r.refusals[0]).toMatch(/HubSpot Stage was edited in the same change, and the exact stage wins/);
  });

  it("the same with the columns in the other order", () => {
    const it0 = item({ coarse: "Lost", exact: "Sales / Qualified To Buy", pipe: "Sales Pipeline" });
    expect(patchFor(rec("appointmentscheduled", SALES), it0, [EXACT, COARSE]).patch)
      .toEqual({ dealstage: "qualifiedtobuy", pipeline: SALES });
  });

  /** Not healed: the exact edit's own run sends it and brings this cell into line (see part 2). Healing
   *  here wrote the bucket of the stage HubSpot was about to leave, and the exact run then wrote it back. */
  it("an exact edit still on its way in another run (its cell names a stage HubSpot does not hold) wins too, unhealed", () => {
    const it0 = item({ coarse: "Won", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" });
    const r = patchFor(rec("appointmentscheduled", SALES), it0);
    expect(r.patch).toEqual({});
    expect(r.heal).toEqual([]);
    expect(r.hold).toEqual([EXACT]);                        // this run's forward pass leaves that edit alone
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatch(/HubSpot Stage shows "Sales \/ Contract Sent", which HubSpot does not hold: the exact stage wins; left as set: the HubSpot Stage edit's own run/);
  });

  /** Behind HubSpot ON THE STAGE the cell shows HubSpot's PREVIOUS stage: nothing else will bring HubSpot's
   *  change to it. The forward pass writes that cell, so nothing is held from it. */
  it("the same on a card BEHIND HubSpot on the stage (its cell shows HubSpot's previous stage): healed to HubSpot's", () => {
    const it0 = item({ coarse: "Won", exact: "Sales / Appointment Scheduled", pipe: "Sales Pipeline" });
    const stageMoved = { hs_lastmodifieddate: "2026-09-29T03:00:00.000Z", hs_v2_date_entered_current_stage: "2026-09-29T03:00:00.000Z" };
    const r = patchFor(rec("contractsent", SALES, stageMoved), it0);
    expect(r.patch).toEqual({});
    expect(healedCols(r.heal)).toEqual([COARSE]);
    expect(r.hold).toBeUndefined();
    expect(r.refusals[0]).toMatch(/which HubSpot does not hold: the exact stage wins$/);
  });

  it("an exact cell that names no stage at all (empty, or text no dictionary knows) does not block", () => {
    for (const exact of ["", "an old label"]) {
      const r = patchFor(rec("appointmentscheduled", SALES), item({ coarse: "Won", exact, pipe: "Sales Pipeline" }));
      expect(r.patch).toEqual({ dealstage: "closedwon", pipeline: SALES });
    }
  });
});

describe("the deal's CURRENT pipeline", () => {
  it("HubSpot's pipeline, even when the card's Pipeline cell is out of date", () => {
    const it0 = item({ coarse: "Won", exact: DICTS.stages[SF.s1], pipe: "Sales Pipeline" });
    expect(patchFor(rec(SF.s1, SF_SALES), it0).patch).toEqual({ dealstage: SF.won, pipeline: SF_SALES });
  });

  it("the card's Pipeline cell only when HubSpot has none", () => {
    const it0 = item({ coarse: "Lost", exact: DICTS.stages[SF.s1], pipe: "Salesforce - Sales" });
    expect(patchFor(rec(SF.s1, ""), it0).patch).toEqual({ dealstage: SF.lost, pipeline: SF_SALES });
  });

  it("neither: refused, never guessed", () => {
    const r = patchFor(rec(SF.s1, ""), item({ coarse: "Lost", exact: DICTS.stages[SF.s1], pipe: "" }));
    expect(r.patch).toEqual({});
    expect(r.refusals[0]).toMatch(/pipeline is unknown/);
  });

  /** Without this the pairing would send the stage's own (old) pipeline and silently undo the edit. */
  it("a Pipeline edit in the same change is honoured: the stage is chosen in the NEW pipeline", () => {
    const it0 = item({ coarse: "Proposal", exact: "Sales / Appointment Scheduled", pipe: "Salesforce - Sales" });
    expect(patchFor(rec("appointmentscheduled", SALES), it0, [PIPE, COARSE]).patch)
      .toEqual({ pipeline: SF_SALES, dealstage: SF.s3 });
  });

  it("a label the pipeline has no stage for is refused (the synthetic PARTIAL: no Lost, one open stage)", () => {
    for (const label of ["Lost", "Proposal", "Negotiation"]) {
      const r = patchFor(rec("partial_open", PARTIAL), cardAt("partial_open", label));
      expect(r.patch).toEqual({});
      expect(r.refusals[0]).toMatch(new RegExp(`has no stage that reads as ${label}`));
    }
    expect(patchFor(rec("partial_open", PARTIAL), cardAt("partial_open", "Won")).patch)
      .toEqual({ dealstage: "partial_won", pipeline: PARTIAL });
  });

  it("the real Shared Selling pipeline has every label", () => {
    const r = patchFor(rec("deal_registration_discovery", SHARED), cardAt("deal_registration_discovery", "Lost"));
    expect(r.patch).toEqual({ dealstage: "deal_registration_closed_lost", pipeline: SHARED });
  });

  it("a dictionary without its targets (not built by getCrmStageDicts) refuses rather than guessing", () => {
    const c = ctx();
    c.labels.crmCoarseStage = { ...DICTS.coarse };
    const r = columnEditPatch(rec("appointmentscheduled", SALES), cardAt("appointmentscheduled", "Won"), CRM_DEALS, c,
      { cols: [COARSE] });
    expect(r.patch).toEqual({});
    expect(r.refusals[0]).toMatch(/stage order is not loaded/);
  });
});

describe("an automation's edit never pushes", () => {
  it("an edit marked as an automation's is refused and healed, even on a record CRM owns", () => {
    const r = patchFor(rec("contractsent", SALES), cardAt("contractsent", "New"), [COARSE], { byAutomation: true });
    expect(r.patch).toEqual({});
    expect(healedCols(r.heal)).toEqual([COARSE]);
    expect(r.refusals[0]).toMatch(/automation/);
  });

  /** 31010016's New on a card of a Won deal: refused, and NOT snapped back to Won (see below). */
  it("on a Won deal it is refused and left as set -- never written back to Won", () => {
    const r = patchFor(rec("closedwon", SALES), cardAt("closedwon", "New"), [COARSE], { byAutomation: true });
    expect(r.patch).toEqual({});
    expect(r.heal).toEqual([]);
    expect(r.refusals[0]).toMatch(/automation.*left as set, not snapped back/);
  });
});

/**
 * NEVER A SNAP-BACK ONTO Won. A heal is a monday write by our token, and a change to Won runs the board's
 * 31010010 (notify every board subscriber) and 31010017 (create a NEW Client Project item). A refused edit
 * of a deal that is already Won is therefore left as the person set it, and logged -- which is what the
 * flag-off Worker does with it (ignores it) -- while a deal that BECOMES Won in the change still shows it.
 */
describe("never a snap-back onto Won", () => {
  /** A heal exactly as sync.ts builds it: `{ kind: "field", f, hsText: "", mdText: "" }`. */
  const healPayload = (heal: FieldSpec[], r: HsRecord) => buildUpdatePayload(
    heal.map(f => ({ kind: "field" as const, f, hsText: "", mdText: "" })), r, CRM_DEALS, ctx());

  const wonDeals = [["Sales", SALES, "closedwon"], ["Sales (Trustpilot)", SALES, TRUSTPILOT], ["SF-Sales", SF_SALES, SF.won]] as const;
  const refusals = [["a leftover label", "Closed Lost"], ["Discovery", "Discovery"], ["a blank", ""]] as const;

  it.each(wonDeals.flatMap(([n, p, s]) => refusals.map(([what, pick]) => [what, n, p, s, pick] as const)))(
    "%s on a Won %s deal: refused, nothing sent, and the cell is NOT written back to Won", (_w, _n, p, stage, pick) => {
      const r = patchFor(rec(stage, p), cardAt(stage, pick));
      expect(r.patch).toEqual({});
      expect(r.heal).toEqual([]);
      expect(r.refusals).toHaveLength(1);
      expect(r.refusals[0]).toMatch(/^dealstage via deal_stage: .*; left as set, not snapped back: the deal is already Won/);
    });

  it("a pending exact edit, or no known pipeline, on a Won deal: left as set too", () => {
    const pending = patchFor(rec("closedwon", SALES), item({ coarse: "Lost", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" }));
    expect([pending.patch, pending.heal]).toEqual([{}, []]);
    expect(pending.refusals[0]).toMatch(/which HubSpot does not hold.*left as set/);
    const noPipe = patchFor(rec(SF.won, ""), item({ coarse: "Lost", exact: "", pipe: "" }));
    expect([noPipe.patch, noPipe.heal]).toEqual([{}, []]);
    expect(noPipe.refusals[0]).toMatch(/pipeline is unknown.*left as set/);
  });

  it("a refusal on a deal that is NOT Won still snaps back, as before", () => {
    const r = patchFor(rec("contractsent", SALES), cardAt("contractsent", "Discovery"));
    expect(healedCols(r.heal)).toEqual([COARSE]);
    expect(healPayload(r.heal, rec("contractsent", SALES))[COARSE]).toEqual({ label: "Negotiation" });
  });

  /**
   * "ALREADY Won" IS WHAT THE CARD LAST RECEIVED FROM HUBSPOT, not HubSpot's stage now. On a card behind
   * HubSpot ON THE STAGE (the deal entered its stage after Sync State) the HubSpot Stage cell still shows
   * HubSpot's previous stage, and a Won HubSpot has is one the card never showed: writing it is news, as
   * the forward pass would.
   */
  describe("a card behind HubSpot on the stage: judged by what the card last received", () => {
    const LATER = { hs_lastmodifieddate: "2026-09-29T03:00:00.000Z", hs_v2_date_entered_current_stage: "2026-09-29T03:00:00.000Z" };
    const behindWon = () => rec(SF.won, SF_SALES, LATER);                  // HubSpot: 赢单, since the card's sync

    it.each([["Proposal"], ["Lost"], ["Discovery"], [""]])(
      "HubSpot closed it won, the card still shows 5 决定 Decide, a person picks %j: healed onto Won, vouched", (pick) => {
        const r = patchFor(behindWon(), cardAt(SF.s5, pick));
        expect(r.patch).toEqual({});
        expect(healedCols(r.heal)).toEqual([COARSE]);
        expect(healPayload(r.heal, behindWon())[COARSE]).toEqual({ label: "Won" });
        expect(logged(/won-heal-withheld/)).toBe(false);
      });

    it("the person's own pick of Won there: nothing to heal, and nothing sent over HubSpot's newer stage", () => {
      const r = patchFor(behindWon(), cardAt(SF.s5, "Won"));
      expect([r.patch, r.heal]).toEqual([{}, []]);
      expect(r.refusals[0]).toMatch(/not healed: the cell already shows Won/);
    });

    it("the card had already shown a Won stage (HubSpot moved it to another since): left as set", () => {
      const r = patchFor(rec(TRUSTPILOT, SALES, LATER), cardAt("closedwon", "Discovery"));
      expect([r.patch, r.heal]).toEqual([{}, []]);
      expect(r.refusals[0]).toMatch(/left as set, not snapped back: the deal is already Won/);
    });

    /** Two labels read back as "a;b", which is no stage: it says nothing of what the card received. */
    it("a HubSpot Stage cell naming no single stage (two labels) falls back to HubSpot's stage: left as set", () => {
      const it0 = item({ coarse: "Discovery", exact: "Sales / Appointment Scheduled, Sales / Qualified To Buy", pipe: "Sales Pipeline" });
      const r = patchFor(rec("closedwon", SALES, LATER), it0);
      expect([r.patch, r.heal]).toEqual([{}, []]);
      expect(r.refusals[0]).toMatch(/left as set, not snapped back: the deal is already Won/);
    });

    /** In line with HubSpot, a HubSpot Stage cell that differs is a person's edit on its way: HubSpot's own
     *  stage is what the card last received, so a Won deal being moved out of Won is still not rewritten. */
    it("in line with HubSpot, a pending HubSpot Stage edit OUT of Won does not make the deal 'not yet Won'", () => {
      const r = patchFor(rec("closedwon", SALES), item({ coarse: "Discovery", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" }));
      expect([r.patch, r.heal]).toEqual([{}, []]);
      expect(r.refusals[0]).toMatch(/left as set, not snapped back: the deal is already Won/);
    });

    it("the stage's own time given in epoch milliseconds reads the same as ISO", () => {
      const ms = { ...LATER, hs_v2_date_entered_current_stage: String(Date.parse(LATER.hs_v2_date_entered_current_stage)) };
      const r = patchFor(rec(SF.won, SF_SALES, ms), cardAt(SF.s5, "Proposal"));
      expect(healedCols(r.heal)).toEqual([COARSE]);
      expect(healPayload(r.heal, rec(SF.won, SF_SALES, ms))[COARSE]).toEqual({ label: "Won" });
    });
  });

  /**
   * BEHIND HUBSPOT FOR A REASON THAT IS NOT THE STAGE. Measured live 2026-10-01 (read-only): 29 of the 150
   * most recently updated Deals cards, and 83 of the board's 8,689 (median 192 h, p90 1,777 h), have an
   * hs_lastmodifieddate after Sync State -- a customer's email reply (hs_latest_sales_email_reply_date, a
   * rollup no webhook reports), a post-create recalculation, a clone, a CRM_UI edit of another property --
   * while the deal entered its stage after Sync State on ONE of the 150. On every other one a HubSpot
   * Stage cell that differs from HubSpot is a person's edit on its way, exactly as on a card in line: the
   * Stage column yields to it unhealed, and the same run's forward pass must leave that cell alone (`hold`)
   * or it reverts the edit before the edit's own run reads it. Healing here used to write Won by our token
   * (31010010 notify, 31010017 a duplicate Client Project) and throw the person's HubSpot Stage away.
   */
  describe("a card behind HubSpot for a reason that is NOT the stage: judged by the stage's own time", () => {
    const REPLY = { hs_lastmodifieddate: "2026-09-29T09:00:00.000Z" };      // the stage itself: ENTERED, before MOD

    it.each([["Proposal"], ["Negotiation"], ["Lost"], ["Discovery"], [""]])(
      "a Won deal, Stage %j beside a pending HubSpot Stage -> Contract Sent: left as set, and that cell held", (pick) => {
        const r = patchFor(rec("closedwon", SALES, REPLY), item({ coarse: pick, exact: "Sales / Contract Sent", pipe: "Sales Pipeline" }));
        expect([r.patch, r.heal, r.hold]).toEqual([{}, [], [EXACT]]);
        expect(r.refusals).toHaveLength(1);
        expect(r.refusals[0]).toMatch(/; left as set/);
        expect(logged(/won-heal-withheld/)).toBe(false);
      });

    it("a deal being closed (Stage Won beside a pending HubSpot Stage -> Closed Won): left as set, and that cell held", () => {
      const r = patchFor(rec("contractsent", SALES, REPLY), item({ coarse: "Won", exact: "Sales / Closed Won", pipe: "Sales Pipeline" }));
      expect([r.patch, r.heal, r.hold]).toEqual([{}, [], [EXACT]]);
      expect(r.refusals[0]).toMatch(/HubSpot Stage shows "Sales \/ Closed Won", which HubSpot does not hold: the exact stage wins; left as set/);
    });

    it("an SF-Sales Won deal, Stage Lost beside a pending HubSpot Stage -> 输单: left as set, and that cell held", () => {
      const r = patchFor(rec(SF.won, SF_SALES, REPLY), item({ coarse: "Lost", exact: "SF-Sales / 输单", pipe: "Salesforce - Sales" }));
      expect([r.patch, r.heal, r.hold]).toEqual([{}, [], [EXACT]]);
    });

    /** A leftover on a deal that is NOT Won is still snapped back -- but the pending cell is held all the same. */
    it("a leftover pick beside a pending HubSpot Stage on a deal that is not Won: snapped back, and that cell still held", () => {
      const r = patchFor(rec("contractsent", SALES, REPLY), item({ coarse: "Discovery", exact: "Sales / Closed Won", pipe: "Sales Pipeline" }));
      expect(r.patch).toEqual({});
      expect(r.hold).toEqual([EXACT]);
      expect(healPayload(r.heal, rec("contractsent", SALES, REPLY))[COARSE]).toEqual({ label: "Negotiation" });
    });

    /** No stage time is no evidence of a stage change: hs_lastmodifieddate alone never makes this a heal. */
    it("no stage time at all (not returned): not read as a stage change -- nothing healed, the cell held", () => {
      const r = patchFor(rec("closedwon", SALES, { ...REPLY, hs_v2_date_entered_current_stage: "" }),
        item({ coarse: "Proposal", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" }));
      expect([r.patch, r.heal, r.hold]).toEqual([{}, [], [EXACT]]);
    });

    it("no pending HubSpot Stage edit (the cell shows HubSpot's stage): nothing held, the label sent as usual", () => {
      const r = patchFor(rec("closedwon", SALES, REPLY), cardAt("closedwon", "Lost"));
      expect(r.patch).toEqual({ dealstage: "closedlost", pipeline: SALES });
      expect(r.hold).toBeUndefined();
    });

    it("a HubSpot Stage edit in the same change drains that cell here: nothing held", () => {
      const r = patchFor(rec("closedwon", SALES, REPLY), item({ coarse: "Proposal", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" }),
        [COARSE, EXACT]);
      expect(r.patch).toEqual({ dealstage: "contractsent", pipeline: SALES });
      expect(r.hold).toBeUndefined();
    });
  });

  describe("both stage columns in one change (the exact stage wins)", () => {
    it("a deal BECOMING Won through the exact edit: the coarse cell is healed to Won -- that is news", () => {
      const it0 = item({ coarse: "Proposal", exact: "Sales / Closed Won", pipe: "Sales Pipeline" });
      const r = patchFor(rec("contractsent", SALES), it0, [COARSE, EXACT]);
      expect(r.patch).toEqual({ dealstage: "closedwon", pipeline: SALES });
      expect(healedCols(r.heal)).toEqual([COARSE]);
      // After the push HubSpot is closedwon, and this heal -- vouched for by coarseStageEdit -- writes Won.
      expect(healPayload(r.heal, rec("closedwon", SALES))[COARSE]).toEqual({ label: "Won" });
      expect(logged(/won-heal-withheld/)).toBe(false);
    });

    /** PROBE 1's second run: both cells already agree on Won. A heal would be our token writing Won onto Won. */
    it("a deal becoming Won, the coarse cell already set to Won by the person: not healed, nothing of ours written", () => {
      const it0 = item({ coarse: "Won", exact: "Sales / Closed Won", pipe: "Sales Pipeline" });
      const r = patchFor(rec("contractsent", SALES), it0, [COARSE, EXACT]);
      expect(r.patch).toEqual({ dealstage: "closedwon", pipeline: SALES });
      expect(r.heal).toEqual([]);
      expect(r.refusals[0]).toMatch(/exact stage wins; not healed: the cell already shows Won/);
    });

    it("an already-Won deal moved to another Won stage: not rewritten to Won", () => {
      const it0 = item({ coarse: "Proposal", exact: "Sales / Trustpilot邀约评价（已成交）", pipe: "Sales Pipeline" });
      const r = patchFor(rec("closedwon", SALES), it0, [COARSE, EXACT]);
      expect(r.patch).toEqual({ dealstage: TRUSTPILOT, pipeline: SALES });
      expect(r.heal).toEqual([]);
      expect(r.refusals[0]).toMatch(/exact stage wins; left as set, not snapped back/);
    });

    it("an already-Won deal moved OUT of Won: the cell shows the new bucket", () => {
      const it0 = item({ coarse: "Proposal", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" });
      const r = patchFor(rec("closedwon", SALES), it0, [COARSE, EXACT]);
      expect(r.patch).toEqual({ dealstage: "contractsent", pipeline: SALES });
      expect(healPayload(r.heal, rec("contractsent", SALES))[COARSE]).toEqual({ label: "Negotiation" });
    });

    /** Moving OUT of Won is not vouched for: if that PATCH fails, the heal would be a snap-back onto Won. */
    it("an already-Won deal moved out of Won, and the PATCH then fails: the heal onto Won is withheld", () => {
      const it0 = item({ coarse: "Proposal", exact: "Sales / Contract Sent", pipe: "Sales Pipeline" });
      const r = patchFor(rec("closedwon", SALES), it0, [COARSE, EXACT]);
      expect(healPayload(r.heal, rec("closedwon", SALES))).toEqual({});
      expect(logged(/col=deal_stage action=won-heal-withheld/)).toBe(true);
    });

    /** If that PATCH then fails, sync.ts heals with HubSpot's UNCHANGED (not Won) stage: never Won. */
    it("the vouched heal, if the push then fails, writes HubSpot's unchanged stage -- not Won", () => {
      const it0 = item({ coarse: "Proposal", exact: "Sales / Closed Won", pipe: "Sales Pipeline" });
      const r = patchFor(rec("contractsent", SALES), it0, [COARSE, EXACT]);
      expect(healPayload(r.heal, rec("contractsent", SALES))[COARSE]).toEqual({ label: "Negotiation" });
    });
  });

  /**
   * THE BACKSTOP, for the heals sync.ts makes itself (HubSpot rejected the PATCH, or the claim was
   * refused): buildUpdatePayload never writes Won as a heal of the coarse Stage it was not vouched for.
   */
  describe("buildUpdatePayload", () => {
    const heal = (f: FieldSpec) => ({ kind: "field" as const, f, hsText: "", mdText: "" });

    it("the spec's own coarse field, healed onto a Won deal: withheld and logged", () => {
      const cv = buildUpdatePayload([heal(coarseField())], rec("closedwon", SALES), CRM_DEALS, ctx());
      expect(cv).toEqual({});
      expect(logged(/object=deals hubspot_id=9001 col=deal_stage action=won-heal-withheld/)).toBe(true);
    });

    it("the same heal onto a deal that is not Won is written, as before", () => {
      expect(buildUpdatePayload([heal(coarseField())], rec(SF.paused, SF_SALES), CRM_DEALS, ctx()))
        .toEqual({ [COARSE]: { label: "Lost" } });
    });

    it("the FORWARD direction is unchanged: HubSpot's Won still reaches the card (fieldDiffs' own diff)", () => {
      const it0 = item({ coarse: "Negotiation", exact: "Sales / Closed Won", pipe: "Sales Pipeline" });
      const diffs = fieldDiffs(rec("closedwon", SALES), it0, CRM_DEALS, ctx()).filter(d => d.f?.col === COARSE);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].hsText).toBe("Won");
      expect(buildUpdatePayload(diffs, rec("closedwon", SALES), CRM_DEALS, ctx())).toEqual({ [COARSE]: { label: "Won" } });
      expect(logged(/won-heal-withheld/)).toBe(false);
    });

    /** What makes "no hsText" mean "a heal" for this column: fieldDiffs never raises one without it. */
    it("fieldDiffs never raises a coarse-Stage diff without hsText (a deal with no stage is skipped)", () => {
      const it0 = item({ coarse: "Won", exact: "", pipe: "" });
      expect(fieldDiffs(rec("", ""), it0, CRM_DEALS, ctx()).filter(d => d.f?.col === COARSE)).toEqual([]);
    });

    it("other columns' heals are untouched, Won stage or not", () => {
      const exactField = CRM_DEALS.fields.find(f => f.col === EXACT)!;
      expect(buildUpdatePayload([heal(exactField)], rec("closedwon", SALES), CRM_DEALS, ctx()))
        .toEqual({ [EXACT]: { labels: ["Sales / Closed Won"] } });
    });
  });
});

// ================================================================================ part 2: end to end

/** HubSpot: one deal. monday: one card, as column id -> cell. */
let deal: Record<string, string>;
let patches: Record<string, string>[];
let cells: Map<string, { text: string; status_index?: number | null }>;
let clock: number;
let getItemHold: { enter: () => void; gate: Promise<void> } | null;
/**
 * The board's history of the coarse Stage cell, and WHO wrote each value: a person, or our token (every
 * write the Worker makes, a same-value one included). monday runs 31010010 (notify every subscriber) and
 * 31010017 (a NEW Client Project item) on every CHANGE of this cell to Won, whoever makes it -- our token
 * included (activity log 2026-09-27T19:06:04Z: 104118038 wrote New -> Won on item 2859588157, and both
 * automations ran at 19:06:04.546Z).
 */
let history: { who: "person" | "ours"; from: string; to: string }[];

const ON = { ENABLE_CRM: "true", DRY_RUN: "false", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z",
  STAGE_COARSE_REVERSE: "true" } as unknown as Env;
const OFF = { ...ON, STAGE_COARSE_REVERSE: undefined } as unknown as Env;
const PERSON = "104231430";
const ASK_ADA = "104118038";
const ITEM = "7001";

function cellOf(col: string, v: unknown): { text: string; status_index?: number | null } {
  if (typeof v === "string" || typeof v === "number") return { text: String(v) };
  const o = (v ?? {}) as Record<string, any>;
  if (col === COARSE) return statusCellValue(String(o.label ?? ""));
  if (Array.isArray(o.labels)) return { text: o.labels.join(", ") };
  if ("label" in o) return { text: String(o.label ?? "") };
  if ("date" in o) return { text: String(o.date ?? "") };
  return { text: JSON.stringify(o) };
}
const statusCellValue = (text: string) => ({ text, status_index: text ? (STATUS_INDEX[text] ?? 5) : null });
const cell = (col: string) => cells.get(col)?.text ?? "";
/** The person (or anyone) changes a cell on the board. */
const setCell = (col: string, text: string) => cells.set(col, col === COARSE ? statusCellValue(text) : { text });
/** A PERSON changes a cell; monday records the change (its webhook is posted separately). */
const personSets = (col: string, text: string) => {
  const from = cell(col);
  setCell(col, text);
  if (col === COARSE && from !== text) history.push({ who: "person", from, to: text });
};
/** Each of these ran the board's Won automations (31010010 notify, 31010017 Client Project) once. */
const wonChanges = () => history.filter(h => h.to === "Won" && h.from !== "Won");

/** An established, CRM-owned deal and its card, in line with each other. */
function linked(stage: string, pipeline: string, coarseShown?: string) {
  deal = { dealname: "Acme renewal", dealstage: stage, pipeline, hs_lastmodifieddate: MOD,
    hs_v2_date_entered_current_stage: ENTERED, createdate: PRE, sync_owner: "crm" };
  cells = new Map<string, { text: string; status_index?: number | null }>([
    [CRM_DEALS.idCol, { text: DEAL }], [CRM_DEALS.syncStateCol, { text: MOD }],
    [COARSE, statusCellValue(coarseShown ?? DICTS.coarse[stage])],
    [EXACT, { text: DICTS.stages[stage] }], [PIPE, { text: DICTS.pipelines[pipeline] }],
  ]);
}

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const settle = async () => { while (waits.length) await Promise.allSettled(waits.splice(0)); };
const post = (env: Env, columnId: string, userId: string | number) =>
  handleMonday(new Request("https://w/webhooks/monday", { method: "POST",
    body: JSON.stringify({ event: { boardId: Number(CRM_DEALS.boardId), pulseId: Number(ITEM), type: "update_column_value",
      columnId, userId, value: {}, previousValue: {} } }) }), env, ectx);
/** A person (or automation, or our token) changes `col` to `text`, and monday tells the Worker. */
const change = async (env: Env, col: string, text: string, userId: string | number = PERSON) => {
  setCell(col, text);
  await post(env, col, userId);
  await settle();
};

describe("end to end: a monday edit of the coarse Stage, through the real sync, to HubSpot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCtxCache();
    patches = []; clock = 0; getItemHold = null; history = [];
    hs.getOwners.mockResolvedValue({});
    hs.getPropertyOptions.mockResolvedValue({});
    hs.getDealStageLabels.mockResolvedValue({});
    hs.getCrmStageDicts.mockResolvedValue(DICTS);          // the registered dictionary, as buildCtx receives it
    hs.getRecord.mockImplementation(async (_e: unknown, _o: unknown, id: string) =>
      id === DEAL ? { id, properties: { ...deal } } : null);
    hs.patchRecord.mockImplementation(async (_e: unknown, _s: unknown, id: string, patch: Record<string, string>,
        o: RunOpts, auth?: { allowed: boolean }) => {
      if (auth && !auth.allowed) throw new Error("write refused");
      if (o.dryRun || !o.writeHubspot) return null;
      const mod = new Date(Date.parse(MOD) + (++clock) * 60_000).toISOString();
      // HubSpot moves the stage's own time with the stage -- to the write's own time, the boundary case.
      const entered = patch.dealstage && patch.dealstage !== deal.dealstage ? { hs_v2_date_entered_current_stage: mod } : {};
      Object.assign(deal, patch, { hs_lastmodifieddate: mod }, entered);
      patches.push({ ...patch });
      return mod;
    });
    mondayApi.getUsersByEmail.mockResolvedValue({});
    const card = () => ({ id: ITEM, name: "Acme renewal", created_at: PRE, updated_at: "", group: { id: "topics" },
      column_values: [...cells].map(([cid, c]) => ({ id: cid, ...c })) });
    mondayApi.getItem.mockImplementation(async (_e: unknown, id: string) => {
      if (getItemHold) { const h = getItemHold; getItemHold = null; h.enter(); await h.gate; }
      return id !== ITEM ? null : card();
    });
    // The HubSpot webhook's lookup of the card by its HubSpot ID column.
    mondayApi.findItemByColumn.mockImplementation(async (_e: unknown, _b: unknown, _c: unknown, v: string) =>
      v === DEAL ? [card()] : []);
    const write = (cv: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(cv)) {
        const from = cell(k);
        cells.set(k, cellOf(k, v));
        if (k === COARSE) history.push({ who: "ours", from, to: cell(k) });
      }
    };
    mondayApi.setColumns.mockImplementation(async (_e: unknown, _b: unknown, _id: string, cv: Record<string, unknown>) => write(cv));
    mondayApi.updateItem.mockImplementation(async (_e: unknown, _b: unknown, _id: string, _n: string, cv: Record<string, unknown>) => write(cv));
  });

  it("a person's Won: HubSpot moves to the pipeline's closed-won stage, and the card follows", async () => {
    linked("appointmentscheduled", SALES);
    await change(ON, COARSE, "Won");
    expect(patches).toEqual([{ dealstage: "closedwon", pipeline: SALES }]);
    expect(deal.dealstage).toBe("closedwon");
    expect(cell(COARSE)).toBe("Won");                      // the person's pick, not rewritten
    expect(cell(EXACT)).toBe("Sales / Closed Won");        // the exact stage shows what was sent
    expect(cell(CRM_DEALS.syncStateCol)).toBe(deal.hs_lastmodifieddate);
  });

  it("a Salesforce pipeline: Negotiation -> its first open stage of the last third, never another pipeline", async () => {
    linked(SF.s1, SF_SALES);
    await change(ON, COARSE, "Negotiation");
    expect(patches).toEqual([{ dealstage: SF.s5, pipeline: SF_SALES }]);
    expect(cell(EXACT)).toBe("SF-Sales / 5 决定 Decide");
  });

  /** The reviewer's probe, end to end: Lost on a Salesforce - Sales deal at 5 决定 Decide. */
  it("a Salesforce pipeline: Lost -> 输单 (never 暂停), and HubSpot Stage follows", async () => {
    linked(SF.s5, SF_SALES);
    await change(ON, COARSE, "Lost");
    expect(patches).toEqual([{ dealstage: SF.lost, pipeline: SF_SALES }]);
    expect(cell(EXACT)).toBe("SF-Sales / 输单");
    expect(cell(COARSE)).toBe("Lost");
  });

  it("already Won in HubSpot (the card showed automation 31010016's New): Won sends nothing", async () => {
    linked("closedwon", SALES, "New");
    await change(ON, COARSE, "Won");
    expect(patches).toEqual([]);
    expect(cell(COARSE)).toBe("Won");
    expect(deal.dealstage).toBe("closedwon");
  });

  it("a leftover label is refused and the cell snaps back to HubSpot's", async () => {
    linked("presentationscheduled", SALES);
    await change(ON, COARSE, "Discovery");
    expect(patches).toEqual([]);
    expect(cell(COARSE)).toBe("Proposal");
    expect(logged(/action=refused reason="dealstage via deal_stage: "Discovery" is not one of the five Stage labels/)).toBe(true);
  });

  /** Every monday write the Worker made to the coarse Stage cell (setColumns and updateItem alike). */
  const coarseWrites = () => [...mondayApi.setColumns.mock.calls.map(c => c[3]), ...mondayApi.updateItem.mock.calls.map(c => c[4])]
    .filter((cv: Record<string, unknown>) => COARSE in cv).map((cv: Record<string, unknown>) => cv[COARSE]);

  /**
   * THE 2026-10-01 FINDING, end to end. A snap-back is a monday write by our token, and a change to Won
   * runs 31010010 (notify the board) and 31010017 (a NEW Client Project item). A refused edit of an
   * already-Won deal must not write Won back.
   */
  describe("a Won deal: a refused or failed edit is never written back to Won", () => {
    it.each([["Closed Lost", SF.won, SF_SALES], ["Discovery", "closedwon", SALES], ["Appointment Scheduled", SF.won, SF_SALES]])(
      "a person picks %s on a Won deal: nothing sent, the cell is left as set, Won is never written", async (pick, stage, pipeline) => {
        linked(stage, pipeline);
        await change(ON, COARSE, pick);
        expect(patches).toEqual([]);
        expect(coarseWrites()).toEqual([]);
        expect(cell(COARSE)).toBe(pick);
        expect(deal.dealstage).toBe(stage);
        expect(logged(/action=refused reason="dealstage via deal_stage: .*left as set, not snapped back: the deal is already Won/)).toBe(true);
      });

    it("HubSpot REJECTS the PATCH that would move a Won deal to Lost: the heal is withheld, not Won", async () => {
      linked(SF.won, SF_SALES);
      hs.patchRecord.mockImplementationOnce(async () => { throw new Error("HubSpot 400 VALIDATION_ERROR"); });
      await change(ON, COARSE, "Lost");
      expect(patches).toEqual([]);
      expect(deal.dealstage).toBe(SF.won);
      expect(logged(/action=rejected fields=dealstage,pipeline/)).toBe(true);
      expect(logged(/col=deal_stage action=won-heal-withheld/)).toBe(true);
      expect(coarseWrites()).toEqual([]);
      expect(cell(COARSE)).toBe("Lost");
    });

    it("the claim is REFUSED (a record CRM does not own): the heal is withheld, not Won", async () => {
      linked("closedwon", SALES);
      deal.sync_owner = "wm";
      await change(ON, COARSE, "Negotiation");
      expect(patches).toEqual([]);
      expect(logged(/action=refused-forward-instead fields=dealstage,pipeline/)).toBe(true);
      expect(logged(/col=deal_stage action=won-heal-withheld/)).toBe(true);
      expect(coarseWrites()).toEqual([]);
    });

    it("the same rejection on a deal that is NOT Won still snaps the cell back, as before", async () => {
      linked("contractsent", SALES);
      hs.patchRecord.mockImplementationOnce(async () => { throw new Error("HubSpot 400 VALIDATION_ERROR"); });
      await change(ON, COARSE, "Won");
      expect(patches).toEqual([]);
      expect(coarseWrites()).toEqual([{ label: "Negotiation" }]);
      expect(cell(COARSE)).toBe("Negotiation");
    });

    it("a person's Won on a deal that is not Won yet still sends it (the edit itself is untouched)", async () => {
      linked(SF.s5, SF_SALES);
      await change(ON, COARSE, "Won");
      expect(patches).toEqual([{ dealstage: SF.won, pipeline: SF_SALES }]);
      expect(coarseWrites()).toEqual([]);                  // the person's own Won stays; nothing rewrites it
      expect(cell(COARSE)).toBe("Won");
    });
  });

  it("an automation's edit never pushes, even on a record CRM owns -- and is left alone, as before", async () => {
    linked("closedwon", SALES);
    await change(ON, COARSE, "New", -4);                   // 31010016 on a card made from a Won deal
    expect(patches).toEqual([]);
    expect(hs.getRecord).not.toHaveBeenCalled();
    expect(mondayApi.getItem).not.toHaveBeenCalled();
    expect(cell(COARSE)).toBe("New");
    expect(deal.dealstage).toBe("closedwon");
  });

  it("our own token's echo never pushes", async () => {
    linked("appointmentscheduled", SALES);
    await change(ON, COARSE, "Won", ASK_ADA);
    expect(patches).toEqual([]);
    expect(hs.getRecord).not.toHaveBeenCalled();
  });

  it.each([["absent", OFF], ["\"false\"", { ...ON, STAGE_COARSE_REVERSE: "false" }]])(
    "flag %s: a person's edit is ignored exactly as before -- nothing is read or written", async (_n, env) => {
      linked("appointmentscheduled", SALES);
      await change(env as Env, COARSE, "Won");
      expect(patches).toEqual([]);
      expect(hs.getRecord).not.toHaveBeenCalled();
      expect(mondayApi.getItem).not.toHaveBeenCalled();
      expect(mondayApi.setColumns).not.toHaveBeenCalled();
      expect(cell(COARSE)).toBe("Won");
      expect(logged(/col=deal_stage action=ignored reason="bookkeeping\/one-way column"/)).toBe(true);
    });

  /**
   * Both stage columns edited while a stage sync is in flight. Without one shared queue the coarse and the
   * exact edit would be sent by two runs racing each other, and the last PATCH to land would win.
   */
  it("both stage columns edited in one go: the exact stage wins, and the coarse cell follows it", async () => {
    linked("appointmentscheduled", SALES);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const gate = new Promise<void>(r => { release = r; });
    getItemHold = { enter, gate };
    setCell(COARSE, "Proposal");
    await post(ON, COARSE, PERSON);                        // run 1: held at its card read
    await entered;
    setCell(EXACT, "Sales / Contract Sent");
    await post(ON, EXACT, PERSON);
    setCell(COARSE, "Won");
    await post(ON, COARSE, PERSON);
    release();
    await settle();

    expect(logged(/action=coalesced-rerun key=md:7001:~stage /)).toBe(true);
    expect(patches).toEqual([{ dealstage: "contractsent", pipeline: SALES }]);
    expect(deal.dealstage).toBe("contractsent");
    expect(cell(EXACT)).toBe("Sales / Contract Sent");
    expect(cell(COARSE)).toBe("Negotiation");              // the bucket of the stage that was sent
  });

  /** The one heal onto Won that IS written: the deal becomes Won in this very change, via the exact stage. */
  it("both columns in one go, the exact stage making the deal Won: the coarse cell shows Won", async () => {
    linked("contractsent", SALES);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const gate = new Promise<void>(r => { release = r; });
    getItemHold = { enter, gate };
    setCell(COARSE, "Proposal");
    await post(ON, COARSE, PERSON);                        // run 1: held at its card read
    await entered;
    setCell(EXACT, "Sales / Closed Won");
    await post(ON, EXACT, PERSON);
    setCell(COARSE, "Lost");
    await post(ON, COARSE, PERSON);
    release();
    await settle();

    // The re-run carries both columns as one change: the exact stage is sent, the coarse one yields.
    expect(logged(/action=coalesced-rerun key=md:7001:~stage /)).toBe(true);
    expect(logged(/HubSpot Stage was edited in the same change, and the exact stage wins/)).toBe(true);
    expect(patches).toEqual([{ dealstage: "closedwon", pipeline: SALES }]);
    expect(cell(COARSE)).toBe("Won");
    expect(coarseWrites().at(-1)).toEqual({ label: "Won" });
    expect(logged(/won-heal-withheld/)).toBe(false);
  });

  /** HubSpot's deal webhook, as it lands: the forward pass (reconcileForwardOnly) through the real sync. */
  const hubspotWebhook = (env: Env) => syncHubspotObject(env, "deal", DEAL, webhookOpts(env), { left: 30 });
  const LATER = "2026-09-29T03:00:00.000Z";

  /**
   * THE 2026-10-01 RE-REVIEW, FINDING 1. A HubSpot user closes the deal won; before that webhook is served
   * (seconds; minutes when a batch spills to the deferred queue) a person edits the monday Stage. The card
   * is BEHIND HubSpot, so a Won HubSpot stage is not a Won the card ever showed. The edit is refused (the
   * card's HubSpot Stage names a stage HubSpot no longer holds, or the label is a leftover) -- and the card
   * must still end on Won, changed to Won ONCE, exactly as with the flag off. It used to be left on the
   * person's pick: the run's forward pass moved Sync State up to HubSpot's change while skipping the edited
   * Stage, so the Won webhook then found nothing newer. No Won, no notification, no Client Project.
   */
  describe("a HubSpot stage change still on its way when a person edits the Stage (the card is behind)", () => {
    it.each([["OFF", "Proposal", OFF], ["ON", "Proposal", ON], ["OFF", "Discovery", OFF], ["ON", "Discovery", ON],
      ["ON", "Lost", ON]] as const)(
      "flag %s: HubSpot closes the deal won, a person picks %s before it lands: the card ends Won, changed once", async (_n, pick, env) => {
        linked(SF.s5, SF_SALES);                                          // in line: Negotiation / 5 决定 Decide
        Object.assign(deal, { dealstage: SF.won, hs_lastmodifieddate: LATER,       // HubSpot: 赢单, not on the card yet
          hs_v2_date_entered_current_stage: LATER });
        personSets(COARSE, pick);
        await post(env, COARSE, PERSON); await settle();
        await hubspotWebhook(env);                                         // the Won's own webhook, served later

        expect(patches).toEqual([]);                        // the person's pick is never sent over HubSpot's newer Won
        expect(deal.dealstage).toBe(SF.won);
        expect(cell(COARSE)).toBe("Won");
        expect(cell(EXACT)).toBe("SF-Sales / 赢单");
        expect(wonChanges()).toEqual([{ who: "ours", from: pick, to: "Won" }]);
        expect(coarseWrites()).toEqual([{ label: "Won" }]);
        expect(logged(/won-heal-withheld/)).toBe(false);
      });

    /** The Won rule itself is unchanged: a Won the card has ALREADY shown is never written back. */
    it("HubSpot moves an already-Won deal to another Won stage meanwhile: a leftover pick is left as set, never Won", async () => {
      linked("closedwon", SALES);                                         // the card showed Won (and ran the automations)
      Object.assign(deal, { dealstage: TRUSTPILOT, hs_lastmodifieddate: LATER, hs_v2_date_entered_current_stage: LATER });
      personSets(COARSE, "Discovery");
      await post(ON, COARSE, PERSON); await settle();
      await hubspotWebhook(ON);

      expect(patches).toEqual([]);
      expect(cell(EXACT)).toBe("Sales / Trustpilot邀约评价（已成交）");     // the rest of the card follows HubSpot
      expect(cell(COARSE)).toBe("Discovery");
      expect(wonChanges()).toEqual([]);
      expect(coarseWrites()).toEqual([]);
      expect(logged(/left as set, not snapped back: the deal is already Won/)).toBe(true);
    });
  });

  /**
   * THE 2026-10-01 RE-REVIEW, FINDING 2. A rep closes a deal the natural way: Stage = Won, then a second
   * later HubSpot Stage = "Sales / Closed Won" so the two agree. The Stage webhook's run reads the card
   * after both clicks, so it sees an exact stage HubSpot does not hold yet and yields to it -- and used to
   * snap the coarse cell back to HubSpot's bucket (Won -> Negotiation) with our token, after which the
   * exact stage's own run brought it forward again (Negotiation -> Won): a SECOND change to Won, a second
   * "has been won" notification and a duplicate Client Project. The exact stage's own run brings the
   * coarse cell into line (fieldDiffs compares first, so it never writes Won onto Won); nothing else may.
   */
  describe("a rep sets both stage columns a second apart (the Stage run reads both)", () => {
    const bothClicks = async (env: Env, first: [string, string], second: [string, string]) => {
      personSets(...first);
      personSets(...second);
      await post(env, first[0], PERSON); await settle();                // the first click's webhook: reads both
      await post(env, second[0], PERSON); await settle();               // the second click's webhook
    };

    it.each([["OFF", COARSE, OFF], ["ON", COARSE, ON], ["OFF", EXACT, OFF], ["ON", EXACT, ON]] as const)(
      "flag %s, %s clicked first: Closed Won is sent once, and the cell changes to Won once -- the person's", async (_n, firstCol, env) => {
        linked("contractsent", SALES);                                    // Negotiation, CRM-owned
        const stage: [string, string] = [COARSE, "Won"], exact: [string, string] = [EXACT, "Sales / Closed Won"];
        await bothClicks(env, ...(firstCol === COARSE ? [stage, exact] : [exact, stage]) as [[string, string], [string, string]]);

        expect(patches).toEqual([{ dealstage: "closedwon", pipeline: SALES }]);
        expect(deal.dealstage).toBe("closedwon");
        expect(cell(COARSE)).toBe("Won");
        expect(wonChanges()).toEqual([{ who: "person", from: "Negotiation", to: "Won" }]);
        expect(coarseWrites()).toEqual([]);                  // nothing of ours touches the cell at all
      });

    /** The mirror: moving a Won deal OUT of Won the same way must not write Won either. */
    it.each([["Proposal"], ["Discovery"]])(
      "a Won deal: Stage -> %s, then HubSpot Stage -> Contract Sent: the cell follows the exact stage, Won is never written", async (pick) => {
        linked("closedwon", SALES);
        await bothClicks(ON, [COARSE, pick], [EXACT, "Sales / Contract Sent"]);

        expect(patches).toEqual([{ dealstage: "contractsent", pipeline: SALES }]);
        expect(cell(COARSE)).toBe("Negotiation");
        expect(wonChanges()).toEqual([]);
        expect(history.filter(h => h.who === "ours")).toEqual([{ who: "ours", from: pick, to: "Negotiation" }]);
      });

    /** The reviewer's PROBE 1: a stage run already in flight, then both columns set to agree on Won. */
    it("a stage run in flight, then Closed Won and Won set to agree: one change to Won, the person's", async () => {
      linked("contractsent", SALES);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(r => { enter = r; });
      const gate = new Promise<void>(r => { release = r; });
      getItemHold = { enter, gate };
      personSets(COARSE, "Proposal");
      await post(ON, COARSE, PERSON);                        // run 1: held at its card read
      await entered;
      personSets(EXACT, "Sales / Closed Won");
      await post(ON, EXACT, PERSON);
      personSets(COARSE, "Won");
      await post(ON, COARSE, PERSON);
      release();
      await settle();

      expect(patches).toEqual([{ dealstage: "closedwon", pipeline: SALES }]);
      expect(cell(COARSE)).toBe("Won");
      expect(wonChanges()).toEqual([{ who: "person", from: "Proposal", to: "Won" }]);
      expect(coarseWrites()).toEqual([]);
    });
  });

  /**
   * THE 2026-10-01 ROUND-2 FINDING. The same two clicks on a card BEHIND HubSpot for a reason that is not
   * the stage -- about 1 card in 5 of those recently worked (29 of 150), 83 of the board's 8,689, days to
   * months behind: a customer's email reply (a rollup no webhook reports), a post-create recalculation, a
   * clone. hs_lastmodifieddate said "behind", so the HubSpot Stage cell was read as HubSpot's PREVIOUS stage
   * rather than the person's pending edit: the Stage run healed onto Won (vouched, our token -- 31010010
   * notify, 31010017 a duplicate Client Project) and its forward pass reverted the HubSpot Stage cell, so
   * that edit's own run found nothing to send. It must end exactly as the flag-off Worker ends it.
   */
  describe("a card behind HubSpot for a reason that is NOT the stage: a rep sets both stage columns a second apart", () => {
    const REPLY = "2026-09-29T09:00:00.000Z";     // a customer's reply: hs_lastmodifieddate moves, the stage does not
    const bothClicks = async (env: Env, first: [string, string], second: [string, string]) => {
      personSets(...first);
      personSets(...second);
      await post(env, first[0], PERSON); await settle();                // the Stage click's webhook: reads both
      await post(env, second[0], PERSON); await settle();               // the HubSpot Stage click's webhook
    };
    const cases = [
      ["a Won deal moved out of Won", "closedwon", SALES, "Proposal", "Sales / Contract Sent", "contractsent", "Negotiation"],
      ["a Won deal moved out of Won", "closedwon", SALES, "Negotiation", "Sales / Contract Sent", "contractsent", "Negotiation"],
      ["a Won deal moved out of Won, a leftover label beside it", "closedwon", SALES, "Discovery", "Sales / Contract Sent", "contractsent", "Negotiation"],
      ["an SF-Sales Won deal lost", SF.won, SF_SALES, "Lost", "SF-Sales / 输单", SF.lost, "Lost"],
      ["a deal closed won", "contractsent", SALES, "Won", "Sales / Closed Won", "closedwon", "Won"],
      ["an SF-Sales deal closed won", SF.s5, SF_SALES, "Won", "SF-Sales / 赢单", SF.won, "Won"],
    ] as const;

    it.each(cases.flatMap(([what, stage, pipeline, pick, ...rest]) =>
      [["OFF", what, pick, OFF, stage, pipeline, ...rest], ["ON", what, pick, ON, stage, pipeline, ...rest]] as const))(
      "flag %s: %s (Stage -> %s, then HubSpot Stage) -- the exact stage is sent and kept; Won changes only by the person",
      async (_n, _what, pick, env, stage, pipeline, exactLabel, sent, coarseEnd) => {
        linked(stage, pipeline);
        deal.hs_lastmodifieddate = REPLY;                                 // behind, but not on the stage
        const from = cell(COARSE);
        await bothClicks(env, [COARSE, pick], [EXACT, exactLabel]);

        expect(patches).toEqual([{ dealstage: sent, pipeline }]);
        expect(deal.dealstage).toBe(sent);
        expect(cell(EXACT)).toBe(exactLabel);                             // the person's HubSpot Stage, never reverted
        expect(cell(COARSE)).toBe(coarseEnd);
        expect(wonChanges()).toEqual(pick === "Won" ? [{ who: "person", from, to: "Won" }] : []);
        expect(history.filter(h => h.who === "ours" && h.to === "Won")).toEqual([]);
        expect(cell(CRM_DEALS.syncStateCol)).toBe(deal.hs_lastmodifieddate);
        expect(logged(/won-heal-withheld/)).toBe(false);
      });

    it("HubSpot Stage clicked first, then Stage: the same", async () => {
      linked("closedwon", SALES);
      deal.hs_lastmodifieddate = REPLY;
      await bothClicks(ON, [EXACT, "Sales / Contract Sent"], [COARSE, "Negotiation"]);
      expect(patches).toEqual([{ dealstage: "contractsent", pipeline: SALES }]);
      expect([cell(COARSE), cell(EXACT)]).toEqual(["Negotiation", "Sales / Contract Sent"]);
      expect(wonChanges()).toEqual([]);
    });

    /** The Stage alone on such a card is untouched by this: nothing is pending, so nothing is held. */
    it("a single Stage edit on such a card: sent as usual, and the card follows", async () => {
      linked(SF.s5, SF_SALES);
      deal.hs_lastmodifieddate = REPLY;
      personSets(COARSE, "Lost");
      await post(ON, COARSE, PERSON); await settle();
      expect(patches).toEqual([{ dealstage: SF.lost, pipeline: SF_SALES }]);
      expect([cell(COARSE), cell(EXACT)]).toEqual(["Lost", "SF-Sales / 输单"]);
      expect(cell(CRM_DEALS.syncStateCol)).toBe(deal.hs_lastmodifieddate);
    });

    /**
     * A HELD CELL DOES NOT MOVE SYNC STATE. If the stage's own time ever lags a real HubSpot stage change
     * (it is a calculated property), the HubSpot Stage cell -- HubSpot's previous stage -- would be taken for
     * a person's edit. Stamping Sync State over it would then bury HubSpot's change for good; left unstamped,
     * that change's own webhook still brings it, once, as the flag-off Worker does.
     */
    it("the stage's own time lagging a real HubSpot Won: nothing is buried, the Won's webhook still brings it once", async () => {
      linked(SF.s5, SF_SALES);
      Object.assign(deal, { dealstage: SF.won, hs_lastmodifieddate: LATER });   // the stage time not caught up yet
      personSets(COARSE, "Proposal");
      await post(ON, COARSE, PERSON); await settle();
      expect(cell(CRM_DEALS.syncStateCol)).toBe(MOD);                    // not stamped over a cell it held
      expect(cell(EXACT)).toBe("SF-Sales / 5 决定 Decide");

      await hubspotWebhook(ON);
      expect(patches).toEqual([]);
      expect([cell(COARSE), cell(EXACT)]).toEqual(["Won", "SF-Sales / 赢单"]);
      expect(wonChanges()).toEqual([{ who: "ours", from: "Proposal", to: "Won" }]);
      expect(cell(CRM_DEALS.syncStateCol)).toBe(LATER);
    });
  });
});
