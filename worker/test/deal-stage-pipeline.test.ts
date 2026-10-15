import { describe, it, expect } from "vitest";
import { buildReversePatch, fieldDiffs } from "../src/reconcile";
import { applyScale, unapplyScale, expectedText, formatValue } from "../src/mapping";
import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "../src/types";

/**
 * DEAL STAGE + PIPELINE, one of the two genuinely dangerous behaviours in the Deals phase.
 *
 * A wrong reverse stage write does not fail loudly — it silently moves the deal into ANOTHER
 * PIPELINE's stage, and pipeline is what reporting, forecasting and the Won automations all key off.
 * Measured on portal 39939588: `dealstage` has 42 values across 5 pipelines, and the three Salesforce
 * pipelines use the SAME NINE Chinese stage labels, so `赢单` alone is three distinct stage ids.
 *
 * Two defences, tested here:
 *   1. the dictionary is PIPELINE-QUALIFIED, so its inverse is a function rather than a coin flip
 *   2. the stage and its pipeline are PATCHed together, because HubSpot rejects a stage that does not
 *      belong to the record's current pipeline
 */

// Measured stage ids, from getCrmStageDicts against the live portal.
const SF_SALES_WON = "cd8b9086-9983-4f82-bdf0-83dfd3fd96ef";
const SF_MAINT_WON = "d0e83c62-647f-4511-bc00-4b92a752c690";
const SF_TRAIN_WON = "ea1194fc-eb54-498a-84b2-599a07add210";
const SALES_PIPE = "551f4f6c-ced0-4069-b1be-f0d3dc33bf2d";
const MAINT_PIPE = "d10159b0-bab4-487a-a11f-55f3a682a170";
const TRAIN_PIPE = "08554d8d-265d-4fbf-94e2-7002cb1ecbca";

const STAGE_LABELS: Record<string, string> = {
  [SF_SALES_WON]: "SF-Sales / 赢单",
  [SF_MAINT_WON]: "SF-Maint / 赢单",
  [SF_TRAIN_WON]: "SF-Train / 赢单",
  closedwon: "Sales / Closed Won",
  deal_registration_closed_won: "Shared / Closed Won",
};
const PIPELINE_BY_STAGE: Record<string, string> = {
  [SF_SALES_WON]: SALES_PIPE,
  [SF_MAINT_WON]: MAINT_PIPE,
  [SF_TRAIN_WON]: TRAIN_PIPE,
  closedwon: "default",
  deal_registration_closed_won: "81ee3345-1b0f-42aa-9e78-580614546602",
};

const ctx = (): Ctx => ({
  labels: {
    crmStage: STAGE_LABELS,
    crmPipeline: { default: "Sales Pipeline", [SALES_PIPE]: "Salesforce - Sales", [MAINT_PIPE]: "Salesforce - Maintenance" },
  },
  ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {},
  pipelineByStage: PIPELINE_BY_STAGE, portalId: 1,
});

const STAGE_FIELD: FieldSpec = { hs: "dealstage", col: "hs_stage", type: "dropdown", labels: "crmStage", reverse: true };
const PIPE_FIELD: FieldSpec = { hs: "pipeline", col: "pipe", type: "dropdown", labels: "crmPipeline", reverse: true };

const spec = (): ObjectSpec => ({
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"], boardId: "1", idCol: "hsid", syncStateCol: "state",
  groupBy: { singleGroup: "topics" }, fields: [STAGE_FIELD, PIPE_FIELD], createFromMonday: false,
  stagePipelinePairing: { stageProp: "dealstage", pipelineProp: "pipeline" },
});

const item = (cells: Record<string, string>): MondayItem => ({
  id: "9", name: "A deal", created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z",
  group: { id: "topics" },
  column_values: Object.entries(cells).map(([id, text]) => ({ id, text })),
});

describe("the qualified dictionary makes the inverse a function", () => {
  /** THE WHOLE REASON FOR THE PREFIX. Three stages share the label 赢单; unqualified, inverting the
   *  dictionary would map that one label to whichever id happened to be written last. */
  it("three distinct 赢单 stages produce three distinct monday labels", () => {
    const labels = [SF_SALES_WON, SF_MAINT_WON, SF_TRAIN_WON].map(id => STAGE_LABELS[id]);
    expect(new Set(labels).size).toBe(3);
    for (const l of labels) expect(l).toContain("赢单");
  });

  it("every label in the dictionary is unique, so no two stages can collide", () => {
    const values = Object.values(STAGE_LABELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("a monday edit resolves to the RIGHT pipeline's stage id, not merely to a 赢单", () => {
    const patch = buildReversePatch(
      [{ kind: "field", f: STAGE_FIELD, hsText: "SF-Sales / 赢单", mdText: "SF-Maint / 赢单" }],
      item({ hs_stage: "SF-Maint / 赢单" }), spec(), ctx());
    expect(patch.dealstage).toBe(SF_MAINT_WON);
    expect(patch.dealstage).not.toBe(SF_SALES_WON);
  });
});

describe("the stage and its pipeline are written together", () => {
  /**
   * THE COMMON EDIT, and the one that fails without pairing: a rep moves a deal from the Sales
   * pipeline to Maintenance by picking a stage. Only the Stage column changed, so only `dealstage`
   * would be in the patch — and HubSpot rejects a stage that does not belong to the record's CURRENT
   * pipeline, which is still Sales.
   */
  it("sends pipeline even when only the stage column changed", () => {
    const patch = buildReversePatch(
      [{ kind: "field", f: STAGE_FIELD, hsText: "SF-Sales / 赢单", mdText: "SF-Maint / 赢单" }],
      item({ hs_stage: "SF-Maint / 赢单" }), spec(), ctx());
    expect(patch).toEqual({ dealstage: SF_MAINT_WON, pipeline: MAINT_PIPE });
  });

  it("the pipeline it sends is the STAGE's pipeline, overriding a stale Pipeline cell", () => {
    // The rep changed Stage to a Maintenance stage but the Pipeline column still reads Sales. The
    // stage is authoritative: sending the two as the cells read would be an invalid pair.
    const patch = buildReversePatch(
      [
        { kind: "field", f: STAGE_FIELD, hsText: "SF-Sales / 赢单", mdText: "SF-Maint / 赢单" },
        { kind: "field", f: PIPE_FIELD, hsText: "Salesforce - Sales", mdText: "Salesforce - Sales" },
      ],
      item({ hs_stage: "SF-Maint / 赢单", pipe: "Salesforce - Sales" }), spec(), ctx());
    expect(patch.dealstage).toBe(SF_MAINT_WON);
    expect(patch.pipeline).toBe(MAINT_PIPE);
  });

  /** Fail CLOSED. A stage id with no known pipeline is one this Worker has never seen; sending it
   *  alone is exactly the failure the pairing exists to prevent, so the stage is dropped instead. */
  it("refuses to send a stage whose pipeline is unknown", () => {
    const c = ctx();
    c.labels.crmStage = { ...STAGE_LABELS, mystery: "Ghost / Stage" };
    c.pipelineByStage = { ...PIPELINE_BY_STAGE };          // deliberately no entry for `mystery`
    const patch = buildReversePatch(
      [{ kind: "field", f: STAGE_FIELD, hsText: "Sales / Closed Won", mdText: "Ghost / Stage" }],
      item({ hs_stage: "Ghost / Stage" }), spec(), c);
    expect(patch.dealstage).toBeUndefined();
    expect(patch.pipeline).toBeUndefined();
  });

  /** The pairing must not fire for a spec that has not opted in — the live Work-Management DEALS
   *  spec writes dealstage without it and must keep behaving byte-for-byte as before. */
  it("does nothing on a spec that does not declare the pairing", () => {
    const s = spec();
    delete s.stagePipelinePairing;
    const patch = buildReversePatch(
      [{ kind: "field", f: STAGE_FIELD, hsText: "SF-Sales / 赢单", mdText: "SF-Maint / 赢单" }],
      item({ hs_stage: "SF-Maint / 赢单" }), s, ctx());
    expect(patch).toEqual({ dealstage: SF_MAINT_WON });
    expect(patch.pipeline).toBeUndefined();
  });

  /** An unknown label is refused by the dictionary before the pairing is reached, so no half-write
   *  of a lone pipeline can escape. */
  it("a stage label that is not in the dictionary writes nothing at all", () => {
    const patch = buildReversePatch(
      [{ kind: "field", f: STAGE_FIELD, hsText: "Sales / Closed Won", mdText: "Something A Rep Typed" }],
      item({ hs_stage: "Something A Rep Typed" }), spec(), ctx());
    expect(patch).toEqual({});
  });
});

/**
 * THE PROBABILITY UNIT TRAP. HubSpot stores hs_deal_stage_probability as a FRACTION (0.2) while the
 * monday column renders `%`. Without the conversion a 20% deal reads "0.2%" — wrong by two orders of
 * magnitude, plausible enough to pass a glance, and multiplied into money by the Forecast Value
 * formula on that same board.
 */
describe("probability scaling, in both directions and in the diff", () => {
  const PROB: FieldSpec = { hs: "hs_deal_stage_probability", col: "prob", type: "numbers", reverse: true, scale: 100 };

  it("HubSpot 0.2 displays as 20", () => {
    expect(applyScale(PROB, "0.2")).toBe("20");
    expect(formatValue(PROB, "0.2", ctx())).toBe("20");
  });

  it("monday 20 goes back as 0.2", () => {
    expect(unapplyScale(PROB, "20")).toBe("0.2");
  });

  /**
   * THE PART THAT PREVENTS PERMANENT CHURN, and the reason expectedText must apply the same
   * transform as formatValue: if only one side scaled, every comparison would differ and the card
   * would be rewritten on every single pass forever. Contacts learned this with phone and email.
   */
  it("expectedText predicts exactly what formatValue writes", () => {
    for (const raw of ["0.2", "0.07", "1", "0.9999", "0"])
      expect(String(formatValue(PROB, raw, ctx()) ?? "")).toBe(expectedText(PROB, raw, ctx()));
  });

  it("a scaled value that round-trips produces NO diff", () => {
    const rec: HsRecord = { id: "1", properties: { hs_deal_stage_probability: "0.07", dealname: "A deal" } };
    const s = spec();
    s.fields = [PROB];
    const diffs = fieldDiffs(rec, item({ prob: "7" }), s, ctx());
    expect(diffs.filter(d => d.kind === "field")).toEqual([]);
  });

  /** 0.07 * 100 is 7.000000000000001 in binary floating point. Unrounded, that differs from monday's
   *  stored "7" on every comparison and rewrites the card forever — a churn bug with no error. */
  it("does not leak binary floating-point noise", () => {
    expect(applyScale(PROB, "0.07")).toBe("7");
    expect(applyScale(PROB, "0.29")).toBe("29");
    expect(unapplyScale(PROB, "7")).toBe("0.07");
  });

  it("leaves a non-numeric value alone rather than turning it into NaN", () => {
    expect(applyScale(PROB, "")).toBe("");
    expect(applyScale(PROB, "n/a")).toBe("n/a");
  });

  it("is inert on a field that declares no scale", () => {
    const plain: FieldSpec = { hs: "amount", col: "amt", type: "numbers", reverse: true };
    expect(applyScale(plain, "1500")).toBe("1500");
    expect(unapplyScale(plain, "1500")).toBe("1500");
  });
});
