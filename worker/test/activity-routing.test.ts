import { describe, it, expect } from "vitest";
import { extractActivityEvents, extractObjectEvents } from "../src/webhooks";
import { ACTIVITY_BY_TYPEID, ACTIVITY_BY_NAME, activitySyncEnabled } from "../src/activity-sync";
import { readCode } from "../scripts/read-source.mjs";
import type { Env } from "../src/types";

/**
 * ROUTING FOR ACTIVITY EVENTS, kept apart from the object path on purpose.
 *
 * Activity webhooks arrive on the SAME endpoint that serves contacts and companies. On 2026-09-15 a
 * 403 raised while that endpoint built label dictionaries escaped the handler and stopped live sync
 * for an hour. So the requirement is not merely "activities work" — it is that an activity event
 * cannot reach the code that failed, and cannot take a shared batch down with it.
 */

const ev = (over: Record<string, unknown>) => ({ subscriptionType: "object.creation", ...over });

describe("extractActivityEvents", () => {
  it.each([["0-49", "emails"], ["0-48", "calls"], ["0-46", "notes"], ["0-47", "meetings"]])(
    "routes objectTypeId %s to %s", (typeId, object) => {
      expect(extractActivityEvents([ev({ objectTypeId: typeId, objectId: "400330119878" })]))
        .toEqual([{ object, id: "400330119878" }]);
    });

  it.each([["email", "emails"], ["call", "calls"], ["note", "notes"], ["meeting_event", "meetings"]])(
    "routes objectType %s to %s when no objectTypeId is given", (name, object) => {
      expect(extractActivityEvents([ev({ objectType: name, objectId: "7" })]))
        .toEqual([{ object, id: "7" }]);
    });

  /**
   * CREATION ONLY. monday has no timeline-item update mutation, so a propertyChange on an activity is
   * an event we could not act on — matching it would schedule work with no possible outcome.
   */
  it("ignores propertyChange and deletion on activities", () => {
    for (const sub of ["object.propertyChange", "object.deletion"])
      expect(extractActivityEvents([{ subscriptionType: sub, objectTypeId: "0-49", objectId: "1" }])).toEqual([]);
  });

  /**
   * AND IT MUST ALSO CATCH ASSOCIATION CHANGES, now that one activity fans out to a Contact, a
   * Company and a Deal. An activity whose associations are attached AFTER creation fires creation
   * while associated with nothing — observed directly while proving the fan-out: a note created bare
   * and associated afterwards reached the Contact and missed the Company and Deal entirely.
   *
   * Re-running costs almost nothing, because each destination has its own durable mapping.
   */
  it("routes an association change so late-linked destinations are not lost", () => {
    expect(extractActivityEvents([
      { subscriptionType: "object.associationChange", objectTypeId: "0-46", objectId: "400369925881" }]))
      .toEqual([{ object: "notes", id: "400369925881" }]);
  });

  it("still refuses an association change on a contact, company or deal", () => {
    expect(extractActivityEvents([
      { subscriptionType: "object.associationChange", objectTypeId: "0-1", objectId: "1" },
      { subscriptionType: "object.associationChange", objectTypeId: "0-2", objectId: "2" },
      { subscriptionType: "object.associationChange", objectTypeId: "0-3", objectId: "3" },
    ])).toEqual([]);
  });

  it("ignores contacts, companies and deals — those belong to the object path", () => {
    expect(extractActivityEvents([
      ev({ objectTypeId: "0-1", objectId: "1" }),
      ev({ objectTypeId: "0-2", objectId: "2" }),
      ev({ objectTypeId: "0-3", objectId: "3" }),
    ])).toEqual([]);
  });

  /**
   * THE MISROUTE GUARD. extractObjectEvents treats a payload with NEITHER subscriptionType NOR
   * objectTypeId as a deal, for monday's Workflow "send webhook". Nothing here may inherit that
   * guess: an activity read as a deal is a lookup for a deal that does not exist, on every activity
   * anyone logs, and silent — a missing deal is an ordinary outcome, so nothing would ever complain.
   */
  it("never guesses: a bare payload yields no activity", () => {
    expect(extractActivityEvents([{ objectId: "400330119878" }])).toEqual([]);
    expect(extractActivityEvents([{ hs_object_id: "400330119878" }])).toEqual([]);
  });

  it("dedupes repeated deliveries of one activity", () => {
    const one = ev({ objectTypeId: "0-49", objectId: "5" });
    expect(extractActivityEvents([one, one, one])).toEqual([{ object: "emails", id: "5" }]);
  });

  it("ignores a non-numeric id rather than passing it to HubSpot", () => {
    expect(extractActivityEvents([ev({ objectTypeId: "0-49", objectId: "not-an-id" })])).toEqual([]);
  });

  /**
   * The two extractors must PARTITION a mixed batch: every event goes to exactly one of them. HubSpot
   * delivers up to 100 events of different types per POST, so an overlap would double-process and a
   * gap would drop events silently.
   */
  it("partitions a mixed batch with the object extractor — no overlap, no gap", () => {
    const batch = [
      ev({ objectTypeId: "0-49", objectId: "400330119878" }),
      ev({ objectTypeId: "0-1", objectId: "550936454903" }),
      ev({ objectTypeId: "0-48", objectId: "400333919946" }),
      { subscriptionType: "object.propertyChange", objectTypeId: "0-2", objectId: "346907952875" },
    ];
    expect(extractActivityEvents(batch)).toEqual([
      { object: "emails", id: "400330119878" }, { object: "calls", id: "400333919946" }]);
    expect(extractObjectEvents(batch)).toEqual([
      { type: "contact", id: "550936454903" }, { type: "company", id: "346907952875" }]);
  });
});

describe("the feature gate", () => {
  it("is OFF unless the var is exactly \"true\"", () => {
    for (const v of [undefined, "", "false", "1", "TRUE", "yes"])
      expect(activitySyncEnabled({ ENABLE_ACTIVITY_SYNC: v } as unknown as Env)).toBe(false);
    expect(activitySyncEnabled({ ENABLE_ACTIVITY_SYNC: "true" } as unknown as Env)).toBe(true);
  });

  // Both directions must consult the gate, or shipping "inert" is only inert on one side.
  it("gates both directions in the handler", () => {
    const code = readCode("webhooks.ts");
    expect(code.match(/activitySyncEnabled\(env\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("activity sync cannot re-enter the path that failed on 2026-09-15", () => {
  /**
   * The outage was a 403 thrown while buildCtx assembled label dictionaries, escaping this handler.
   * Activity events now land on the same endpoint, so the isolation is asserted structurally: the
   * activity module must not reach for the context builder or a spec's field mapping at all.
   */
  it("activity-sync.ts never calls buildCtx or getCtxCached", () => {
    const code = readCode("activity-sync.ts");
    expect(code).not.toContain("buildCtx");
    expect(code).not.toContain("getCtxCached");
    expect(code).not.toContain("buildColumnValues");
  });

  it("every activity sync call is fired detached, so one cannot fail the batch", () => {
    const code = readCode("webhooks.ts");
    expect(code).toContain("ectx.waitUntil(syncHubspotActivity(");
    expect(code).toContain("ectx.waitUntil(syncMondayTimeline(");
  });
});
