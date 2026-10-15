import { describe, it, expect } from "vitest";
import { progressSteps, isComplete, isFailed, CREATE_STEPS } from "./create-progress";

const done = { status: "completed" as const, steps: { dedup: true, hubspot: true, monday: true, owner: true, associations: true } };
const failedAtHubspot = { status: "failed" as const, failedStep: "hubspot" as const, steps: { dedup: true, hubspot: false, monday: false, owner: false, associations: false } };

describe("progressSteps", () => {
  it("null (in-flight) => every step pending", () =>
    expect(progressSteps(null).map(s => s.status)).toEqual(["pending", "pending", "pending", "pending", "pending"]));
  it("completed => every step done", () =>
    expect(progressSteps(done).every(s => s.status === "done")).toBe(true));
  it("failed at hubspot => dedup done, hubspot failed, rest pending", () => {
    const s = progressSteps(failedAtHubspot);
    expect(s.find(x => x.key === "dedup")!.status).toBe("done");
    expect(s.find(x => x.key === "hubspot")!.status).toBe("failed");
    expect(s.find(x => x.key === "monday")!.status).toBe("pending");
  });
  it("labels are in the fixed order", () =>
    expect(CREATE_STEPS.map(s => s.key)).toEqual(["dedup", "hubspot", "monday", "owner", "associations"]));
});

describe("isComplete / isFailed", () => {
  it("read the status", () => {
    expect(isComplete(done)).toBe(true);
    expect(isFailed(failedAtHubspot)).toBe(true);
    expect(isComplete(failedAtHubspot)).toBe(false);
    expect(isComplete(null)).toBe(false);
  });
});
