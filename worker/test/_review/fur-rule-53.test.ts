import { describe, it, expect } from "vitest";

/**
 * SKEPTIC CHECK, RULE-4 (evidence, all expected to PASS).
 *   1. The agreed rule's "nothing logged since the assignment" IS notes_last_updated vs hubspot_owner_assigneddate,
 *      and reminderDue implements exactly that -- ISO and epoch-ms stamps alike, "at the assignment" counting.
 *   2. A monday Call summary (native type "activity") and a native Note ARE pushed to HubSpot (eligibleForHubspot),
 *      and the Activity bell column is a wake column. Live, #10 (recipe 38841239, "an activity/email is created in
 *      Emails & Activities") stamps that bell -- so a call logged on the card does reach HubSpot, contrary to the
 *      finding's "rings for Notes only" (webhooks.ts:36-41 is a stale 09-30 note about workflow 1940472437).
 *   3. The residual the finding is right about: a native "email" entry is never pushed (a documented decision).
 */
const { reminderDue } = await import("../../src/follow-up-reminder");
const { eligibleForHubspot } = await import("../../src/activities");
const { ACTIVITY_WAKE_COLS, ACTIVITY_BELL_COL } = await import("../../src/webhooks");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const lead = (o: Record<string, string> = {}) => ({ id: "1", owner: "77", assigned: new Date(T0).toISOString(),
  created: new Date(T0 - 5 * MIN).toISOString(), term: "DocuSign", lifecycle: "lead", lastActivity: "", ...o });

describe("RULE-4 skeptic", () => {
  it("1. the rule's activity test is notes_last_updated vs the assignment stamp, implemented exactly", () => {
    expect(reminderDue(lead({ lastActivity: String(T0 + 5 * MIN) }), T0 + 31 * MIN)).toEqual({ skip: "followed up since the assignment" });
    expect(reminderDue(lead({ lastActivity: new Date(T0).toISOString() }), T0 + 31 * MIN)).toEqual({ skip: "followed up since the assignment" });
    expect(reminderDue(lead({ lastActivity: String(T0 - 1) }), T0 + 31 * MIN)).toEqual({ checkpoint: 30 });
    expect(reminderDue(lead({ assigned: String(T0), lastActivity: new Date(T0 + MIN).toISOString() }), T0 + 61 * MIN))
      .toEqual({ skip: "followed up since the assignment" });
  });

  it("2. a monday Call summary and a Note are pushed when the bell rings", () => {
    expect(eligibleForHubspot({ type: "activity", custom_activity_id: null, content: "called" })).toBe(true);
    expect(eligibleForHubspot({ type: "note", custom_activity_id: null, content: "spoke to him" })).toBe(true);
    expect(ACTIVITY_BELL_COL).toBe("date_mm7pw446");
    expect(ACTIVITY_WAKE_COLS.has(ACTIVITY_BELL_COL)).toBe(true);
  });

  it("3. residual: a native email entry is not pushed", () => {
    expect(eligibleForHubspot({ type: "email", custom_activity_id: null, content: "Hi" })).toBe(false);
  });
});
