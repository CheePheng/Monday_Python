import { describe, it, expect } from "vitest";
import { coarseStageOf, COARSE_STAGES } from "../src/hubspot";
import { formatValue, expectedText } from "../src/mapping";
import { CRM_DEALS } from "../src/config/crm";
import type { Ctx, FieldSpec } from "../src/types";

/**
 * THE 2026-09-15 IMPORT ABORT, AS A TEST.
 *
 * The coarse Stage column was mapped to `stage`, a dictionary getDealStageLabels builds from
 * HubSpot's DEFAULT PIPELINE ONLY. This portal runs 42 stages across 5 pipelines and nearly every
 * deal sits in a Salesforce pipeline, so the lookup missed, formatValue fell through `dict[v] ?? v`,
 * and because every monday write sets create_labels_if_missing:true each unmapped deal MINTED a
 * status label named after its raw stage GUID. 8 appeared in the first 70 imported cards. A monday
 * status column degrades above ~19 labels, so the import was two labels away from wedging the column
 * for every user of the board.
 *
 * Two independent things had to be wrong for that to happen, so both are pinned here: the dictionary
 * has to cover every pipeline, AND the write has to refuse anything the dictionary still misses.
 * Either one alone would have prevented it.
 */

const stage = (): FieldSpec => {
  const f = CRM_DEALS.fields.find(x => x.col === "deal_stage")!;
  if (!f) throw new Error("no deal_stage field on CRM_DEALS");
  return f;
};

describe("the coarse Stage column can only ever hold the five native labels", () => {
  it("is mapped to the pipeline-wide dictionary, forward-only, and strict", () => {
    const f = stage();
    expect(f.labels).toBe("crmCoarseStage");
    expect(f.oneWay).toBe(true);        // many-to-one has no inverse; never reverse it to HubSpot
    expect(f.strictDict).toBe(true);    // an unknown stage must never mint a label
    // The regression itself: `stage` knows only the default pipeline and must never be used here.
    expect(f.labels).not.toBe("stage");
  });

  it("the exact stage and pipeline columns are untouched by this change", () => {
    const exact = CRM_DEALS.fields.find(x => x.col === "dropdown_mm7624zd")!;
    expect(exact).toMatchObject({ hs: "dealstage", labels: "crmStage", reverse: true });
    const pipe = CRM_DEALS.fields.find(x => x.col === "dropdown_mm76s7kk")!;
    expect(pipe).toMatchObject({ hs: "pipeline", labels: "crmPipeline", reverse: true });
  });
});

describe("coarseStageOf buckets by metadata, never by label text", () => {
  // Shaped like a Salesforce pipeline here: nine stages, the last two closed.
  const sfStages = [
    { id: "s1", displayOrder: 0, metadata: { isClosed: "false" } },
    { id: "s2", displayOrder: 1, metadata: { isClosed: "false" } },
    { id: "s3", displayOrder: 2, metadata: { isClosed: "false" } },
    { id: "s4", displayOrder: 3, metadata: { isClosed: "false" } },
    { id: "s5", displayOrder: 4, metadata: { isClosed: "false" } },
    { id: "s6", displayOrder: 5, metadata: { isClosed: "false" } },
    { id: "won", displayOrder: 6, metadata: { isClosed: "true", isClosedWon: "true" } },
    { id: "lost", displayOrder: 7, metadata: { isClosed: "true" } },
  ];

  it("maps every stage to one of exactly five labels", () => {
    const m = coarseStageOf(sfStages);
    expect(Object.keys(m)).toHaveLength(sfStages.length);
    for (const v of Object.values(m)) expect(COARSE_STAGES).toContain(v);
  });

  /**
   * Won is tested BEFORE Lost on purpose: a closed-won stage is also `isClosed`, so checking closed
   * first would label every won deal Lost. 3,640 of this portal's 8,651 deals are closed won, so
   * getting this backwards would mis-state the outcome of 42% of the pipeline.
   */
  it("a closed-WON stage is Won, not Lost", () => {
    expect(coarseStageOf(sfStages).won).toBe("Won");
    expect(coarseStageOf(sfStages).lost).toBe("Lost");
  });

  it("accepts metadata as booleans as well as HubSpot's strings", () => {
    const m = coarseStageOf([
      { id: "w", displayOrder: 0, metadata: { isClosed: true, isClosedWon: true } },
      { id: "l", displayOrder: 1, metadata: { isClosed: true } },
    ]);
    expect(m).toEqual({ w: "Won", l: "Lost" });
  });

  // A pipeline whose closed-won stage predates isClosedWon: probability 1 on a closed stage means won.
  it("treats a closed stage at probability 1 as Won when isClosedWon is absent", () => {
    const m = coarseStageOf([{ id: "w", displayOrder: 0, metadata: { isClosed: "true", probability: 1 } }]);
    expect(m.w).toBe("Won");
  });

  it("splits the OPEN stages of a pipeline into thirds by position", () => {
    const m = coarseStageOf(sfStages);
    // Six open stages -> two per bucket, in displayOrder.
    expect([m.s1, m.s2, m.s3, m.s4, m.s5, m.s6])
      .toEqual(["New", "New", "Proposal", "Proposal", "Negotiation", "Negotiation"]);
  });

  it("orders by displayOrder, not by array order", () => {
    const shuffled = [
      { id: "c", displayOrder: 2, metadata: { isClosed: "false" } },
      { id: "a", displayOrder: 0, metadata: { isClosed: "false" } },
      { id: "b", displayOrder: 1, metadata: { isClosed: "false" } },
    ];
    expect(coarseStageOf(shuffled)).toEqual({ a: "New", b: "Proposal", c: "Negotiation" });
  });

  // Degenerate pipelines must still produce a legal label rather than undefined.
  it.each([1, 2, 3, 4, 5, 7, 9, 11])("a pipeline with %i open stages labels all of them legally", (n) => {
    const m = coarseStageOf(Array.from({ length: n }, (_, i) =>
      ({ id: `s${i}`, displayOrder: i, metadata: { isClosed: "false" } })));
    expect(Object.keys(m)).toHaveLength(n);
    for (const v of Object.values(m)) expect(["New", "Proposal", "Negotiation"]).toContain(v);
  });

  it("an empty pipeline yields an empty map rather than throwing", () => {
    expect(coarseStageOf([])).toEqual({});
  });
});

describe("an unmapped stage is refused, never written raw", () => {
  const ctx = { labels: { crmCoarseStage: { known: "Won" } } } as unknown as Ctx;

  it("writes the bucketed label for a stage the dictionary knows", () => {
    expect(formatValue(stage(), "known", ctx)).toEqual({ label: "Won" });
    expect(expectedText(stage(), "known", ctx)).toBe("Won");
  });

  /**
   * THE ACTUAL BUG. Before strictDict this returned { label: "<raw guid>" }, and
   * create_labels_if_missing turned that into a permanent new status label on a shared board.
   */
  it("OMITS the column for an unknown stage id instead of minting a label", () => {
    expect(formatValue(stage(), "9f26268b-9906-4924-a999-1555079f5f39", ctx)).toBeNull();
  });

  /**
   * expectedText must agree with formatValue or the card is rewritten on every webhook forever,
   * chasing a value the column is never actually given. Same lockstep rule as phone and email.
   */
  it("predicts nothing for the value it refuses to write, so no diff churns", () => {
    expect(expectedText(stage(), "9f26268b-9906-4924-a999-1555079f5f39", ctx)).toBe("");
  });

  it("an empty dictionary refuses every stage rather than writing them all raw", () => {
    const empty = { labels: { crmCoarseStage: {} } } as unknown as Ctx;
    expect(formatValue(stage(), "anything", empty)).toBeNull();
    expect(expectedText(stage(), "anything", empty)).toBe("");
  });

  // Non-strict status fields must keep the old permissive behaviour — this flag is opt-in per field.
  it("leaves ordinary status fields falling back to the raw value", () => {
    const loose = { ...stage(), strictDict: undefined } as FieldSpec;
    expect(formatValue(loose, "unmapped", ctx)).toEqual({ label: "unmapped" });
  });
});
