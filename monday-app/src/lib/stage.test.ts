import { describe, it, expect } from "vitest";
import { stageOptions, groupIdForStage, stageForGroupId, groupStageLabel } from "./stage";

// The REAL group titles + Deal Stage labels from board 5029480547. The previous fixture used titles
// that were already stage labels ("Appointment Scheduled"), so it agreed with the bug and stayed green
// while every save failed live. Keep these verbatim.
const GROUPS = [
  { id: "group_mm53yk6d", title: "Unassigned Deals" },
  { id: "group_mm4nf6fw", title: "Sales Pipeline 01 - Appointment Scheduled" },
  { id: "group_title", title: "Sales Pipeline 02 - Qualified To Buy" },
  { id: "group_mm4pa9zg", title: "Sales Pipeline 03 - Presentation Scheduled" },
  { id: "group_mm4pbazz", title: "Sales Pipeline 04 - Decision Maker Bought-In" },
  { id: "group_mm4pavfa", title: "Sales Pipeline 05 - Contract Sent" },
  { id: "group_mm4py571", title: "Sales Pipeline 06 - Closed Won" },
  { id: "group_mm4pw6e2", title: "Sales Pipeline 07 - Closed Lost" },
  { id: "group_mm4pdres", title: "Sales Pipeline 08 - Trustpilot邀约评价（已成交）" },
];
const STAGE_LABELS = [
  "Presentation Scheduled", "Qualified To Buy", "Decision Maker Bought-In", "Appointment Scheduled",
  "Closed Won", "Contract Sent", "Closed Lost", "Trustpilot邀约评价（已成交）",
];

describe("groupStageLabel", () => {
  it("strips the pipeline-number prefix", () =>
    expect(groupStageLabel("Sales Pipeline 01 - Appointment Scheduled")).toBe("Appointment Scheduled"));
  it("keeps a label that itself contains a dash", () =>
    expect(groupStageLabel("Sales Pipeline 04 - Decision Maker Bought-In")).toBe("Decision Maker Bought-In"));
  it("handles non-ASCII labels", () =>
    expect(groupStageLabel("Sales Pipeline 08 - Trustpilot邀约评价（已成交）")).toBe("Trustpilot邀约评价（已成交）"));
  it("passes through a title that has no prefix", () =>
    expect(groupStageLabel("Unassigned Deals")).toBe("Unassigned Deals"));
});

describe("stage helpers", () => {
  it("offers Deal Stage labels — never group titles — so monday accepts the value", () => {
    const opts = stageOptions(GROUPS);
    expect(opts).toEqual([
      "Appointment Scheduled", "Qualified To Buy", "Presentation Scheduled", "Decision Maker Bought-In",
      "Contract Sent", "Closed Won", "Closed Lost", "Trustpilot邀约评价（已成交）",
    ]);
    for (const o of opts) expect(STAGE_LABELS).toContain(o);
  });
  it("excludes the Unassigned group", () =>
    expect(stageOptions(GROUPS)).not.toContain("Unassigned Deals"));
  it("every offered stage resolves to a group (otherwise the deal can't be filed)", () => {
    for (const o of stageOptions(GROUPS)) expect(groupIdForStage(o, GROUPS)).toBeTruthy();
  });
  it("maps a stage label to its group id", () =>
    expect(groupIdForStage("Closed Won", GROUPS)).toBe("group_mm4py571"));
  it("does not resolve a raw group title as a stage", () =>
    expect(groupIdForStage("Sales Pipeline 06 - Closed Won", GROUPS)).toBeUndefined());
  it("returns undefined for an unknown stage", () =>
    expect(groupIdForStage("Nope", GROUPS)).toBeUndefined());
  it("never resolves to the Unassigned group", () =>
    expect(groupIdForStage("Unassigned Deals", GROUPS)).toBeUndefined());
  it("stageForGroupId maps a group id back to its stage label", () =>
    expect(stageForGroupId("group_mm4nf6fw", GROUPS)).toBe("Appointment Scheduled"));
  it("round-trips: a row's stage label reselects its own group", () => {
    for (const g of GROUPS.filter(g => g.id !== "group_mm53yk6d"))
      expect(groupIdForStage(stageForGroupId(g.id, GROUPS)!, GROUPS)).toBe(g.id);
  });
});
