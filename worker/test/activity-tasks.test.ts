import { describe, it, expect } from "vitest";
import { taskTimestamp, timelinePayload, MONDAY_ACTIVITY_TYPE, qualifiesAsFollowUp } from "../src/activities";
import { destInCanaryScope, ACTIVITY_BY_NAME } from "../src/activity-sync";
import type { Env } from "../src/types";

/**
 * HUBSPOT TASKS — imported as history, not rebuilt as a task system.
 *
 * Measured before deciding: 8,372 tasks, 6,533 already completed, fifteen created in the last month,
 * and exactly TWO open with a future due date. Nobody works from HubSpot tasks, so a timeline record
 * preserves everything of value and there is no task-management workflow to replace. The two live
 * ones get an actionable monday equivalent by hand rather than by building a feature for them.
 */

describe("when a task belongs in the timeline", () => {
  /**
   * hs_timestamp on a task is its DUE DATE, not when anything happened. Using it directly would file
   * a task completed in July under its October deadline — and a timeline sorted by "when did this
   * happen" would then be wrong about the one thing it is for.
   */
  it("dates a completed task by its completion, not its deadline", () => {
    expect(taskTimestamp({
      hs_timestamp: "2026-10-01T00:00:00Z",
      hs_task_completion_date: "2026-07-05T04:38:10Z",
    })).toBe("2026-07-05T04:38:10Z");
  });

  /** An open task has nothing to have happened yet, so its deadline is the best anchor available. */
  it("falls back to the due date while a task is open", () => {
    expect(taskTimestamp({ hs_timestamp: "2026-10-01T00:00:00Z" })).toBe("2026-10-01T00:00:00Z");
    expect(taskTimestamp({ hs_timestamp: "2026-10-01T00:00:00Z", hs_task_completion_date: "" }))
      .toBe("2026-10-01T00:00:00Z");
  });

  it("has no opinion when a task carries neither date", () => {
    expect(taskTimestamp({})).toBeUndefined();
  });
});

describe("the task payload", () => {
  const payload = () => timelinePayload(
    { id: "55722117240", object: "tasks", timestamp: "2026-07-05T04:38:10Z", ownerId: "431181649" },
    {
      title: "對 Ted Cheng 進行後續追蹤",
      body: "Regarding email: Hello from DKM",
      taskStatus: "COMPLETED", taskType: "TODO", taskPriority: "HIGH",
      taskDue: "2026-07-10T00:00:00Z", taskCompleted: "2026-07-05T04:38:10Z",
    });

  it("uses the dedicated HubSpot Task activity type", () => {
    expect(payload().custom_activity_id).toBe(MONDAY_ACTIVITY_TYPE.tasks);
    expect(MONDAY_ACTIVITY_TYPE.tasks).toBe("5f0e2267-8cea-45fa-bb54-2b1a29324a34");
  });

  /** BOTH dates are kept in the body even though only one drives the position: the deadline is
   *  information a rep wants after the fact, and it is the only place it survives. */
  it("preserves status, type, priority, due date and completion date", () => {
    const c = payload().content;
    expect(c).toContain("Status: COMPLETED");
    expect(c).toContain("Task type: TODO");
    expect(c).toContain("Priority: HIGH");
    expect(c).toContain("Due: 2026-07-10T00:00:00Z");
    expect(c).toContain("Completed: 2026-07-05T04:38:10Z");
    expect(c).toContain("HubSpot owner: 431181649");
    expect(c).toContain("[hubspot:tasks:55722117240]");
  });

  /** Most tasks in this portal have priority NONE; printing it would be noise on 8,000 entries. */
  it("omits a priority of NONE", () => {
    const c = timelinePayload({ id: "1", object: "tasks" }, { title: "x", taskPriority: "NONE" }).content;
    expect(c).not.toContain("Priority:");
  });

  it("keeps the title from the task subject", () => {
    expect(payload().title).toBe("對 Ted Cheng 進行後續追蹤");
  });
});

describe("tasks never silence a reminder", () => {
  /**
   * A task is a note-to-self about intended work — "call him Tuesday" — not evidence anyone was
   * actually contacted. Counting one as follow-up would cancel the chase for work that has not
   * happened, which is the expensive direction to be wrong in.
   */
  it("does not qualify as follow-up even when the owner matches", () => {
    expect(qualifiesAsFollowUp(
      { id: "1", object: "tasks", timestamp: "2026-09-12T10:00:00Z", ownerId: "A", direction: "OUTBOUND" },
      { contactOwnerId: "A", ownerAssignedAtMs: Date.parse("2026-09-01T00:00:00Z") })).toBe(false);
  });
});

describe("live routing for tasks", () => {
  /** Routed by the objectType NAME. The numeric objectTypeId is deliberately absent: the schemas
   *  endpoint is not readable on this app's scopes, and a guessed id would route silently wrong. */
  it("routes the task objectType by name", () => {
    expect(ACTIVITY_BY_NAME.task).toBe("tasks");
  });
});

describe("canary scope is per destination kind", () => {
  const env = (o: Record<string, string>) => o as unknown as Env;

  it("admits everything when no allowlist is set", () => {
    expect(destInCanaryScope(env({}), "contact", "1")).toBe(true);
    expect(destInCanaryScope(env({}), "company", "2")).toBe(true);
    expect(destInCanaryScope(env({}), "deal", "3")).toBe(true);
  });

  /**
   * THE TRAP THIS EXISTS FOR. A Company id compared against a CONTACT allowlist can only ever be
   * false, so a three-way canary would resolve all three destinations, silently drop two, and "pass"
   * having proven nothing about the fan-out it was built to test.
   */
  it("does not judge a company by the contact allowlist", () => {
    const e = env({ ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "C1", ACTIVITY_CANARY_HUBSPOT_COMPANY_ID: "K1" });
    expect(destInCanaryScope(e, "contact", "C1")).toBe(true);
    expect(destInCanaryScope(e, "company", "K1")).toBe(true);
    expect(destInCanaryScope(e, "company", "C1")).toBe(false);
    expect(destInCanaryScope(e, "contact", "K1")).toBe(false);
  });

  /** A kind with no variable set is out of scope while any allowlist is active — the canary must not
   *  quietly widen to a board nobody named. */
  it("excludes a kind that was not named", () => {
    const e = env({ ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "C1" });
    expect(destInCanaryScope(e, "deal", "D1")).toBe(false);
    expect(destInCanaryScope(e, "company", "K1")).toBe(false);
  });

  it("admits a deal once its own allowlist names it", () => {
    const e = env({ ACTIVITY_CANARY_HUBSPOT_DEAL_ID: "D1" });
    expect(destInCanaryScope(e, "deal", "D1")).toBe(true);
    expect(destInCanaryScope(e, "deal", "D2")).toBe(false);
  });
});
