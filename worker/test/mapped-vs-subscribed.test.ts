import { describe, it, expect } from "vitest";
import { readSubscriptions } from "../scripts/read-subscriptions.mjs";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import type { ObjectSpec } from "../src/types";

/**
 * MAPPED IS NOT SUBSCRIBED.
 *
 * A field needs BOTH a mapping in config/crm.ts AND an `object.propertyChange` subscription in the
 * HubSpot app's webhooks-hsmeta.json. Either half alone is a silent no-op: a mapped-but-unsubscribed
 * property simply never updates — no error, no log entry, nothing that would make anyone look. This
 * repo has already shipped that state once, with 8 fields affected, and it was found by reading two
 * files side by side rather than by any test.
 *
 * This file is that missing cross-check. It reads the REAL app manifest, the way deploy-config.test.ts
 * reads the real wrangler.jsonc.
 */

const subs = readSubscriptions();

/** Properties HubSpot sets once at record birth, which `object.creation` already delivers. */
const CREATION_ONLY = new Set([
  "createdate",              // set at birth, never changes
  "hs_object_source_label",  // read-only system metadata: how the record was created
]);

const cases: [string, ObjectSpec, string][] = [
  ["contacts", CRM_CONTACTS, "contact"],
  ["companies", CRM_ACCOUNTS, "company"],
];

describe.each(cases)("%s: every mapped property is subscribed", (_label, spec, objectType) => {
  const subscribed = new Set(subs.propsFor(objectType));

  it("has no mapped property without a propertyChange subscription", () => {
    const missing = spec.fields
      .map(f => f.hs)
      .filter(hs => !subscribed.has(hs) && !CREATION_ONLY.has(hs));
    expect(missing).toEqual([]);
  });

  // The mirror image: a subscription with no mapping burns webhook deliveries on an event that the
  // reconciler then finds nothing to do with. Not harmful, but it means someone's intent got lost.
  it("has no subscription without a mapping", () => {
    const mapped = new Set(spec.fields.map(f => f.hs));
    expect(subs.propsFor(objectType).filter(p => !mapped.has(p))).toEqual([]);
  });

  it("subscribes to creation, deletion and associationChange", () => {
    for (const t of ["object.creation", "object.deletion", "object.associationChange"])
      expect(subs.typesFor(objectType)).toContain(t);
  });

  it("marks every subscription active — an inactive one delivers nothing", () => {
    for (const s of subs.all.filter(x => x.objectType === objectType))
      expect(s.active).toBe(true);
  });
});

describe("the app points at the CRM Worker", () => {
  // The singular /webhook/hubspot was given out once by mistake; the route is PLURAL, and the wrong
  // one 404s every single delivery with nothing on the monday side to hint at why.
  it("targets the CRM Worker's plural /webhooks/hubspot route", () => {
    expect(subs.targetUrl).toBe("https://hubspot-monday-crm-sync.askada.workers.dev/webhooks/hubspot");
    expect(subs.targetUrl).not.toContain("/webhook/hubspot");
  });

  it("does NOT point at the live Work-Management Worker", () =>
    expect(subs.targetUrl).not.toContain("hubspot-monday-sync."));

  // Deals belong to the WM deployment. specByObject returns undefined for deals here, so a deal
  // subscription would be a logged no-op — but subscribing would also require a Deals scope the CRM
  // app deliberately does not request.
  it("subscribes to NO deal events", () =>
    expect(subs.all.filter(s => s.objectType === "deal")).toEqual([]));

  /**
   * WIDENED 2026-09-16, from "contacts and companies only", for the activity sync into monday's
   * native Emails & Activities timeline.
   *
   * The four activity types are CREATION ONLY, deliberately. monday has no update mutation for
   * timeline items, so synced activities are immutable; a propertyChange subscription would deliver
   * events nothing could act on, and an event stream nobody consumes is indistinguishable from a
   * broken one when you are later trying to work out why something did not sync.
   *
   * These arrive at the live Worker from the moment the app is uploaded, which is why
   * activity-events-inert.test.ts pins that the router ignores them rather than misrouting them onto
   * "deal" via the bare-payload fallback.
   */
  it("covers contacts, companies, and the four activity types", () =>
    expect([...new Set(subs.all.map(s => s.objectType))].sort())
      .toEqual(["call", "company", "contact", "email", "meeting_event", "note"]));

  it("subscribes to activity CREATION only — activities are immutable in v1", () => {
    for (const object of ["email", "call", "note", "meeting_event"]) {
      const forObject = subs.all.filter(s => s.objectType === object);
      expect(forObject.map(s => s.subscriptionType)).toEqual(["object.creation"]);
    }
  });
});
