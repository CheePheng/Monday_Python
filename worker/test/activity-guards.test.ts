import { describe, it, expect } from "vitest";
import { activityCutoverMs, afterCutover, inCanaryScope, activitySyncEnabled } from "../src/activity-sync";
import { qualifiesAsFollowUp } from "../src/activities";
import { readCode } from "../scripts/read-source.mjs";
import type { Env } from "../src/types";

const env = (o: Record<string, string | undefined>) => o as unknown as Env;

describe("the activity cutover", () => {
  /**
   * FAILS CLOSED. This value's whole job is to stop a bulk write, so an absent or malformed one must
   * mean "sync nothing", never "sync everything". The opposite default would turn a typo in a Worker
   * var into a push of every contact's entire history.
   */
  it.each([undefined, "", "not a date", "tomorrow"])("is INFINITY when unset/garbage (%s)", (v) => {
    expect(activityCutoverMs(env({ ACTIVITY_CUTOVER_AT: v }))).toBe(Number.POSITIVE_INFINITY);
    expect(afterCutover(env({ ACTIVITY_CUTOVER_AT: v }), "2026-09-16T00:00:00Z")).toBe(false);
  });

  it("admits activity at or after the cutover and refuses anything before it", () => {
    const e = env({ ACTIVITY_CUTOVER_AT: "2026-09-16T12:00:00Z" });
    expect(afterCutover(e, "2026-09-16T11:59:59Z")).toBe(false);
    expect(afterCutover(e, "2026-09-16T12:00:00Z")).toBe(true);
    expect(afterCutover(e, "2026-09-17T00:00:00Z")).toBe(true);
  });

  it("refuses an activity with no timestamp rather than assuming it is recent", () => {
    const e = env({ ACTIVITY_CUTOVER_AT: "2026-09-16T12:00:00Z" });
    expect(afterCutover(e, undefined)).toBe(false);
    expect(afterCutover(e, "")).toBe(false);
  });

  /**
   * The case this exists for: the first wake-up on a contact whose timeline already holds years of
   * native history. No entry has a mapping yet, so "unmapped" would otherwise read as "new" and push
   * the whole history into HubSpot — the historical backfill we agreed not to do, arriving by
   * accident rather than decision.
   */
  it("keeps a pre-existing timeline out of HubSpot", () => {
    const e = env({ ACTIVITY_CUTOVER_AT: "2026-09-16T12:00:00Z" });
    const timeline = [
      { created_at: "2024-03-01T09:00:00Z" }, { created_at: "2025-11-20T15:00:00Z" },
      { created_at: "2026-09-16T11:00:00Z" }, { created_at: "2026-09-16T13:00:00Z" },
    ];
    expect(timeline.filter(t => afterCutover(e, t.created_at)))
      .toEqual([{ created_at: "2026-09-16T13:00:00Z" }]);
  });
});

describe("canary scope", () => {
  /**
   * ENABLE_ACTIVITY_SYNC is GLOBAL. Turning it on for "a canary" without an allowlist would start
   * processing every contact in a 94,000-contact portal, which is the opposite of a canary.
   */
  it("admits everything when no allowlist is set", () => {
    expect(inCanaryScope(env({}), "123", "456")).toBe(true);
  });

  it("admits only the named contact once an allowlist is set", () => {
    const e = env({ ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "550936454903" });
    expect(inCanaryScope(e, "550936454903", undefined)).toBe(true);
    expect(inCanaryScope(e, "999999999", undefined)).toBe(false);
  });

  it("admits by monday item id too, for the wake-up direction", () => {
    const e = env({ ACTIVITY_CANARY_MONDAY_ITEM_ID: "2859742407" });
    expect(inCanaryScope(e, undefined, "2859742407")).toBe(true);
    expect(inCanaryScope(e, undefined, "1111111")).toBe(false);
  });

  it("refuses an unknown record when an allowlist is set but nothing identifies it", () => {
    expect(inCanaryScope(env({ ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "550936454903" }))).toBe(false);
  });
});

describe("follow-up qualification uses the CONTACT's owner, not the activity's", () => {
  /**
   * THE BUG THIS PINS. The first implementation passed the activity's own owner in as
   * `contactOwnerId`, so the comparison was value-against-itself and every activity qualified —
   * including one logged by a colleague who does not own the contact. It is invisible in production:
   * a reminder that stops early raises no error, it just leaves a customer nobody chases.
   */
  it("refuses an activity whose actor is not the contact's owner", () => {
    const ctx = { contactOwnerId: "164317533", ownerAssignedAtMs: Date.parse("2026-09-10T00:00:00Z") };
    const byColleague = { id: "1", object: "emails", timestamp: "2026-09-12T10:00:00Z",
      ownerId: "99999999", direction: "EMAIL" };
    expect(qualifiesAsFollowUp(byColleague, ctx)).toBe(false);
    expect(qualifiesAsFollowUp({ ...byColleague, ownerId: "164317533" }, ctx)).toBe(true);
  });

  /**
   * And the assignment timestamp must keep its TIME. monday's Owner assigned date is a date column,
   * so using it truncates to midnight and activity from earlier on the reassignment day would count
   * toward the new owner's cycle when it belongs to the previous owner.
   */
  it("distinguishes activity earlier the same day as the reassignment", () => {
    const exact = { contactOwnerId: "A", ownerAssignedAtMs: Date.parse("2026-09-12T14:00:00Z") };
    const morning = { id: "1", object: "emails", timestamp: "2026-09-12T09:00:00Z",
      ownerId: "A", direction: "EMAIL" };
    expect(qualifiesAsFollowUp(morning, exact)).toBe(false);
    const midnight = { contactOwnerId: "A", ownerAssignedAtMs: Date.parse("2026-09-12T00:00:00Z") };
    expect(qualifiesAsFollowUp(morning, midnight)).toBe(true);   // what truncation would wrongly allow
  });
});

describe("structural guarantees", () => {
  const code = readCode("activity-sync.ts");

  /** Both directions must consult the cutover, or "cutover-forward only" holds on one side. */
  it("applies the cutover in both directions", () => {
    expect((code.match(/afterCutover\(/g)?.length ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("applies canary scope in both directions", () => {
    expect((code.match(/inCanaryScope\(/g)?.length ?? 0)).toBeGreaterThanOrEqual(2);
  });

  /**
   * FIRST BOUNCE. Creating a HubSpot Note/Call from a monday entry makes HubSpot fire object.creation
   * for it; that event is indistinguishable from a rep's own. The structural echo guard does not
   * cover it — that only stops OUR monday writes travelling back, and this is a HubSpot object we
   * really created. The h2m side must be claimed at creation time or the bounce lands a custom copy
   * beside the native entry it came from.
   */
  it("claims the reverse direction when creating in HubSpot", () => {
    expect(code).toContain("claimHubspotAsRepresented(env, object, newId, contactId, entry.id)");
  });

  /**
   * A missing contact or card is usually a RACE — a contact and its first email are often created in
   * the same second — so it must be retryable. Settling it as done would lose the activity forever.
   */
  it("defers rather than settles when the contact or card is not yet visible", () => {
    expect(code).not.toContain('settleActivityToMonday(env, object, hubspotId, "no-contact")');
    expect(code).not.toContain('settleActivityToMonday(env, object, hubspotId, "no-card")');
  });

  /**
   * THE CARD IS RESOLVED BEFORE THE RESERVATION IS TAKEN. Claiming first and then discovering there
   * is no card leaves a reservation standing for a write that was never going to happen, which blocks
   * the retry that would have succeeded once the card appeared.
   */
  it("claims a card only after that card is known to exist", () => {
    const loop = code.slice(code.indexOf("for (const contactId of targets)"));
    expect(loop.indexOf("cards.get(contactId)")).toBeLessThan(loop.indexOf("claimActivityToMonday"));
  });

  /**
   * THE DEFECT THAT REACHED PRODUCTION. Taking the first association filed 40 outbound emails on the
   * SENDER's card and none on the customers'. The reservation key must carry the contact, or the
   * first card written marks the whole activity done and every other participant is skipped.
   */
  it("keys the reservation per activity AND contact", () => {
    expect(readCode("activity-registry.ts"))
      .toContain("`act:h2m:${object}:${hubspotId}:${contactId}`");
    expect(code).toContain("claimActivityToMonday(env, object, hubspotId, contactId)");
  });

  /** monday-origin activity must never mark follow-up: the timeline read carries no reliable mapping
   *  from the monday author to a HubSpot owner, so assuming the logger is the contact owner would
   *  silence reminders on someone else's say-so. */
  it("never qualifies monday-origin activity", () => {
    const pushOne = code.slice(code.indexOf("async function pushOne"));
    expect(pushOne).not.toContain("maybeMarkFollowUp");
  });

  it("the flag is off unless exactly \"true\"", () => {
    expect(activitySyncEnabled(env({ ENABLE_ACTIVITY_SYNC: "false" }))).toBe(false);
    expect(activitySyncEnabled(env({ ENABLE_ACTIVITY_SYNC: "true" }))).toBe(true);
  });
});
