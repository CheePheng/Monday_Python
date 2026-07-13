import { describe, it, expect } from "vitest";
import { stageOptions, groupIdForStage, stageForGroupId } from "./stage";

const GROUPS = [
  { id: "group_mm4nf6fw", title: "Appointment Scheduled" },
  { id: "group_mm4py571", title: "Closed Won" },
  { id: "group_mm53yk6d", title: "Unassigned Deals" },
];

describe("stage helpers", () => {
  it("stageOptions excludes the Unassigned group", () =>
    expect(stageOptions(GROUPS)).toEqual(["Appointment Scheduled", "Closed Won"]));
  it("groupIdForStage maps a stage title to its group id", () =>
    expect(groupIdForStage("Closed Won", GROUPS)).toBe("group_mm4py571"));
  it("groupIdForStage returns undefined for an unknown stage", () =>
    expect(groupIdForStage("Nope", GROUPS)).toBeUndefined());
  it("stageForGroupId maps a group id back to its title", () =>
    expect(stageForGroupId("group_mm4nf6fw", GROUPS)).toBe("Appointment Scheduled"));
});
