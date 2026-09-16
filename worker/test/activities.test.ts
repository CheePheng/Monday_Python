import { describe, it, expect } from "vitest";
import { qualifiesAsFollowUp, eligibleForHubspot, MONDAY_ACTIVITY_TYPE,
         HUBSPOT_OBJECT_FOR_NATIVE, timelinePayload } from "../src/activities";
import type { HsActivity, FollowUpContext } from "../src/activities";

/**
 * FOLLOW-UP QUALIFICATION, and why it is worth this much test.
 *
 * monday workflows #03 / #04 / #05 chase a rep after Owner assigned date, and each one only fires
 * while its date column is EMPTY. So whatever writes that column decides whether a reminder happens
 * at all.
 *
 * CADENCE, live vs intended — the numbers differ and the difference is deliberate:
 *   live today      #03 = 2 days, #04 = 3 days, #05 = 5 days
 *   intended        #03 = 1 day,  #04 = 3 days, #05 = 5 days
 * Only #03 changes, and NOT YET: the workflows stay untouched until the Activity sync is proven and
 * enabled, because retiming a chaser while the thing that silences it is still inert would chase
 * reps over contacts they had in fact worked. Recorded here so nobody reads "2 days" as the target.
 *
 * Say yes too easily and the escalation to Zmark silently never fires for
 * exactly the contacts nobody has worked — the system goes quiet and looks healthy, which is the
 * hardest failure to notice. Say no too easily and reps are chased over contacts they demonstrably
 * emailed, which is how people learn to ignore the alerts.
 *
 * Every rule here is therefore stated as the mistake it prevents, not as a requirement.
 */

const ASSIGNED = Date.parse("2026-09-10T00:00:00Z");
const ctx: FollowUpContext = { contactOwnerId: "164317533", ownerAssignedAtMs: ASSIGNED };

const outboundEmail = (over: Partial<HsActivity> = {}): HsActivity => ({
  id: "1", object: "emails", timestamp: "2026-09-12T10:00:00Z",
  ownerId: "164317533", direction: "EMAIL", ...over,
});

describe("qualifiesAsFollowUp", () => {
  it("accepts an outbound email the current owner sent after assignment", () => {
    expect(qualifiesAsFollowUp(outboundEmail(), ctx)).toBe(true);
  });

  /**
   * Inbound mail is the CUSTOMER acting, and it is the strongest possible evidence that a reply is
   * owed. Counting it would cancel the reminder at the exact moment it is most warranted.
   */
  it("REFUSES inbound customer email", () => {
    expect(qualifiesAsFollowUp(outboundEmail({ direction: "INCOMING_EMAIL" }), ctx)).toBe(false);
    expect(qualifiesAsFollowUp(outboundEmail({ direction: "FORWARDED_EMAIL" }), ctx)).toBe(false);
  });

  /**
   * A sequence send is the machine's work. hs_sequence_id is populated on real sequence mail — proven
   * against live data (sequence 727707385, three Docusign sends) — so this needs no Sequences scope.
   */
  it("REFUSES a sequence-generated email even though it is outbound and owner-attributed", () => {
    expect(qualifiesAsFollowUp(outboundEmail({ sequenceId: "727707385" }), ctx)).toBe(false);
  });

  /**
   * Activity from before the current assignment is the PREVIOUS owner's work. Without this a
   * reassignment inherits history and the new owner is never chased at all — the reassignment case is
   * precisely when a reminder matters most.
   */
  it("REFUSES activity at or before the Owner assigned date", () => {
    expect(qualifiesAsFollowUp(outboundEmail({ timestamp: "2026-09-09T23:59:59Z" }), ctx)).toBe(false);
    expect(qualifiesAsFollowUp(outboundEmail({ timestamp: "2026-09-10T00:00:00Z" }), ctx)).toBe(false);
    expect(qualifiesAsFollowUp(outboundEmail({ timestamp: "2026-09-10T00:00:01Z" }), ctx)).toBe(true);
  });

  /**
   * Attribution is by HUBSPOT OWNER ID, never the monday People column. Some owners have no monday
   * account — "Rick Avery Antonio" is the live example, 136 contacts deep — so matching on the monday
   * assignee would fail closed for them and chase reps forever over contacts they had worked.
   */
  it("REFUSES activity by someone other than the current contact owner", () => {
    expect(qualifiesAsFollowUp(outboundEmail({ ownerId: "99999999" }), ctx)).toBe(false);
  });

  it("falls back to the source user when no owner is set", () => {
    expect(qualifiesAsFollowUp(outboundEmail({ ownerId: undefined, sourceUserId: "164317533" }), ctx)).toBe(true);
    expect(qualifiesAsFollowUp(outboundEmail({ ownerId: undefined, sourceUserId: undefined }), ctx)).toBe(false);
  });

  it("REFUSES an unparseable or missing timestamp rather than assuming recent", () => {
    expect(qualifiesAsFollowUp(outboundEmail({ timestamp: undefined }), ctx)).toBe(false);
    expect(qualifiesAsFollowUp(outboundEmail({ timestamp: "not a date" }), ctx)).toBe(false);
  });

  /**
   * CORRECTED. An earlier version of this test asserted that notes and meetings qualify, reasoning
   * only that they carry no direction to check. That confuses "nothing disqualifies it" with
   * "it is evidence of contact".
   *
   * A note is the rep talking to themselves — "call him Tuesday", "waiting on legal". A meeting
   * object is normally a SCHEDULED one, written when the invite goes out rather than when anyone is
   * actually spoken to. Either silences the chaser for work that has not happened yet, and a reminder
   * that stops early is invisible: nobody notices the email that was never sent.
   *
   * Both still SYNC and stay visible on the timeline. Visibility and qualification are separate.
   */
  it("REFUSES a note — internal notes are not customer contact", () => {
    expect(qualifiesAsFollowUp({ id: "2", object: "notes", timestamp: "2026-09-12T10:00:00Z",
      ownerId: "164317533" }, ctx)).toBe(false);
  });

  // Revisit only when a HELD meeting is distinguishable from a booked one (an outcome, or an end
  // time in the past). Until then, fail closed.
  it("REFUSES a meeting — the object usually means booked, not held", () => {
    expect(qualifiesAsFollowUp({ id: "3", object: "meetings", timestamp: "2026-09-12T10:00:00Z",
      ownerId: "164317533" }, ctx)).toBe(false);
  });

  it("REFUSES a call with no direction, since a call's direction is knowable", () => {
    expect(qualifiesAsFollowUp({ id: "4", object: "calls", timestamp: "2026-09-12T10:00:00Z",
      ownerId: "164317533" }, ctx)).toBe(false);
    expect(qualifiesAsFollowUp({ id: "5", object: "calls", timestamp: "2026-09-12T10:00:00Z",
      ownerId: "164317533", direction: "OUTBOUND" }, ctx)).toBe(true);
  });
});

describe("the echo guard is structural", () => {
  /**
   * create_timeline_item REQUIRES a custom_activity_id, so everything this integration writes has one
   * and nothing it writes can ever be eligible to travel back. That holds even if every stored
   * mapping is lost — which is exactly when a bookkeeping-based guard would fail.
   */
  it("REFUSES anything carrying a custom_activity_id — that is our own writing", () => {
    for (const id of Object.values(MONDAY_ACTIVITY_TYPE))
      expect(eligibleForHubspot({ custom_activity_id: id, type: "custom" })).toBe(false);
  });

  it("accepts native entries, which have no custom_activity_id", () => {
    expect(eligibleForHubspot({ custom_activity_id: null, type: "note" })).toBe(true);
    expect(eligibleForHubspot({ custom_activity_id: null, type: "activity" })).toBe(true);
  });

  it("refuses a native type we have no HubSpot mapping for, rather than guessing one", () => {
    expect(eligibleForHubspot({ custom_activity_id: null, type: "something_new" })).toBe(false);
    expect(eligibleForHubspot({ custom_activity_id: null, type: undefined })).toBe(false);
  });

  it("maps the two native types monday actually produces", () => {
    expect(HUBSPOT_OBJECT_FOR_NATIVE.note).toBe("notes");
    expect(HUBSPOT_OBJECT_FOR_NATIVE.activity).toBe("calls");  // "Call summary" arrives as "activity"
  });
});

describe("the timeline payload", () => {
  it("carries the ORIGINAL timestamp, not the sync time", () => {
    const pl = timelinePayload(outboundEmail(), { title: "Hello" });
    expect(pl.timestamp).toBe("2026-09-12T10:00:00Z");
  });

  it("embeds the HubSpot id so a human can see an entry's origin from the card", () => {
    const pl = timelinePayload(outboundEmail({ id: "397633515214" }), { title: "Hello" });
    expect(pl.content).toContain("[hubspot:emails:397633515214]");
  });

  it("marks a sequence email as informational in the body", () => {
    const pl = timelinePayload(outboundEmail({ sequenceId: "727707385" }), { title: "Hello" });
    expect(pl.content).toContain("does not count as follow-up");
  });

  it("uses the right custom type per object", () => {
    expect(timelinePayload(outboundEmail(), {}).custom_activity_id).toBe(MONDAY_ACTIVITY_TYPE.emails);
    expect(timelinePayload({ id: "9", object: "calls" }, {}).custom_activity_id).toBe(MONDAY_ACTIVITY_TYPE.calls);
  });
});
