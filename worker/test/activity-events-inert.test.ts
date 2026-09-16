import { describe, it, expect } from "vitest";
import { extractObjectEvents, extractLineItemIds } from "../src/webhooks";

/**
 * ACTIVITY EVENTS MUST BE INERT UNTIL SOMETHING HANDLES THEM.
 *
 * On 2026-09-16 the CRM app subscribed to object.creation for email, call, note and meeting_event so
 * the HubSpot -> monday direction could be event-driven. Those events began arriving at the live
 * Worker IMMEDIATELY, hours before any handler existed, because a subscription takes effect on
 * upload.
 *
 * That ordering was deliberate — a subscription with no handler is a no-op, while a handler expecting
 * events that were never subscribed looks healthy and syncs nothing — but it is only safe if the
 * existing router genuinely ignores them. The same morning, an unhandled condition inside this
 * webhook path (a 403 while building label dictionaries) threw, escaped, and stopped live Contacts
 * and Companies sync for an hour. An unrecognised event type must therefore be a no-op, never an
 * exception, and never a misroute onto another object.
 *
 * The misroute is the subtle one. `extractObjectEvents` falls back to "deal" for a BARE payload with
 * neither subscriptionType nor objectTypeId (monday Workflow "send webhook" sends one). An activity
 * event that tripped that fallback would be synced as a DEAL carrying an email's id — a lookup for a
 * deal that does not exist, on every activity anyone logs.
 */

// Real 2026 projects-app shape: object.creation plus the activity's objectTypeId.
const activityEvent = (objectTypeId: string, objectType: string, objectId: string) => ({
  subscriptionType: "object.creation", objectTypeId, objectType, objectId, portalId: 39939588,
});

describe("HubSpot activity creation events are inert", () => {
  // 0-46 note, 0-47 meeting, 0-48 call, 0-49 email — none of which this Worker routes yet.
  it.each([
    ["0-49", "email"], ["0-48", "call"], ["0-46", "note"], ["0-47", "meeting_event"],
  ])("ignores %s (%s) rather than routing it", (typeId, name) => {
    expect(extractObjectEvents([activityEvent(typeId, name, "400330119878")])).toEqual([]);
  });

  it("ignores them when objectTypeId is absent and only the name is given", () => {
    for (const name of ["email", "call", "note", "meeting_event"])
      expect(extractObjectEvents([{ subscriptionType: "object.creation", objectType: name, objectId: "1" }]))
        .toEqual([]);
  });

  it("does not mistake an activity for a line item", () => {
    expect(extractLineItemIds([activityEvent("0-49", "email", "400330119878")])).toEqual([]);
  });

  /**
   * The bare-payload fallback must not catch activities. It exists for monday's Workflow "send
   * webhook", which posts an object with no subscriptionType at all; a HubSpot app event always
   * carries one, so the guard is that `sub` is truthy.
   */
  it("does not fall through to the bare-payload deal assumption", () => {
    const events = extractObjectEvents([activityEvent("0-49", "email", "400330119878")]);
    expect(events.find(e => e.type === "deal")).toBeUndefined();
  });

  /**
   * And the contact/company events in the same batch must still be processed — ignoring the new types
   * must not cost us the ones that were already working. Mixed batches are normal: HubSpot delivers
   * up to 100 events of different types in one POST.
   */
  it("still routes contacts and companies delivered in the same batch", () => {
    const events = extractObjectEvents([
      activityEvent("0-49", "email", "400330119878"),
      { subscriptionType: "object.creation", objectTypeId: "0-1", objectId: "550936454903" },
      activityEvent("0-48", "call", "400333919946"),
      { subscriptionType: "object.propertyChange", objectTypeId: "0-2", objectId: "346907952875" },
    ]);
    expect(events).toEqual([
      { type: "contact", id: "550936454903" },
      { type: "company", id: "346907952875" },
    ]);
  });
});
