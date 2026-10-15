import { describe, it, expect } from "vitest";
import { readSubscriptions } from "../scripts/read-subscriptions.mjs";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";
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

/**
 * ALL FOUR, as of 2026-09-21. Deals and Line Items were absent from this check AND from the manifest,
 * which is half of why the Products & Services board has never been written to: `hubspot_owner_id` has
 * been mapped there since 2026-09-14 and no event has ever arrived to act on it.
 */
const cases: [string, ObjectSpec, string][] = [
  ["contacts", CRM_CONTACTS, "contact"],
  ["companies", CRM_ACCOUNTS, "company"],
  ["deals", CRM_DEALS, "deal"],
  ["line_items", CRM_LINE_ITEMS, "line_item"],
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
  // The item NAME is a mapping too (nameProps): dealname and a line item's name are what the card is
  // called, so their propertyChange subscriptions are what let a HubSpot rename reach monday.
  it("has no subscription without a mapping", () => {
    const mapped = new Set([...spec.fields.map(f => f.hs), ...spec.nameProps, ...(spec.nameFallbackProps ?? [])]);
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

  /**
   * WIDENED 2026-09-21 to deals and line items, which is the other half of why the Products & Services
   * board has never been written to: `hubspot_owner_id` has been mapped there since 2026-09-14 and no
   * event has ever arrived to act on it.
   *
   * The old comment here said deals belong to the WM deployment and `specByObject` returns undefined
   * for them — true until CRM_DEALS joined CRM_SPECS, and the same expired premise that let a CRM deal
   * event route onto the live WM board (see legacyDealRouting in sync.ts).
   */
  it("subscribes to deal AND line_item events, the two objects that had none", () => {
    for (const o of ["deal", "line_item"])
      expect(subs.all.filter(s => s.objectType === o).length,
        `${o} has no subscriptions`).toBeGreaterThan(0);
  });

  /** A line item's Account is derived through its deal, so a deal association change is the ONLY
   *  signal that the derivation has gone stale. Without it the link is written once and rots. */
  it("subscribes to deal associationChange, which invalidates line items' derived Account", () =>
    expect(subs.all.some(s => s.objectType === "deal" && s.subscriptionType === "object.associationChange"))
      .toBe(true));

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
  it("covers all four CRM objects and all five activity types", () =>
    expect([...new Set(subs.all.map(s => s.objectType))].sort())
      .toEqual(["call", "company", "contact", "deal", "email", "line_item", "meeting_event", "note", "task"]));

  /**
   * CREATION, AND ASSOCIATION CHANGE. Creation alone was right while the only destination was the
   * associated Contact; it stops being right once one activity fans out to a Contact, a Company and a
   * Deal, because an activity linked to its records AFTER creation fires creation while associated
   * with nothing. Observed directly: a note created bare and associated a moment later reached the
   * Contact and missed the Company and Deal entirely.
   *
   * propertyChange stays out — monday has no timeline-item update mutation, so an edited activity is
   * something we could not act on.
   */
  it("subscribes to activity creation AND association change, never propertyChange", () => {
    for (const object of ["email", "call", "note", "meeting_event", "task"]) {
      const forObject = subs.all.filter(s => s.objectType === object).map(s => s.subscriptionType).sort();
      expect(forObject).toEqual(["object.associationChange", "object.creation"]);
    }
  });

  /**
   * DECLARED BUT NOT DELIVERING, and recorded here so nobody re-derives it from scratch. HubSpot
   * accepted the associationChange subscriptions on build #10 and still sends nothing for them, even
   * after the app was reauthorized — tested twice against a real note. The live path therefore cannot
   * depend on them; bounded rechecks after creation are what actually close the gap.
   *
   * task creation is declared too, but crm.objects.tasks.read is not obtainable for this app type
   * ("isn't available to this app — contact HubSpot support"), so task events cannot arrive either.
   * Historical Tasks import regardless, because the backfill reads HubSpot directly.
   */
  it("declares task creation even though the scope for it is unobtainable", () => {
    expect(subs.all.some(s => s.objectType === "task" && s.subscriptionType === "object.creation")).toBe(true);
  });
});
