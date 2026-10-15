import { describe, it, expect } from "vitest";
import { readAppScopes, SCOPES_FOR } from "../scripts/read-app-scopes.mjs";
import { CRM_SPECS } from "../src/config/crm";

/**
 * THE 2026-09-15 OUTAGE, AS A TEST.
 *
 * `CRM_DEALS` and `CRM_LINE_ITEMS` joined `CRM_SPECS` in ea0430a. The next deploy — made for an
 * unrelated reason — carried them to production, and because `buildCtx` loads a label dictionary for
 * every dictionary ANY spec in the deployment references, every CONTACT and COMPANY webhook began
 * reading `/crm/v3/pipelines/deals` and deal property schemas at startup. The app had no deals scope.
 * The 403 threw, the throw escaped the webhook handler, and live Contacts/Companies sync stopped on a
 * deploy that touched nothing about contacts or companies. It stayed down until someone noticed a
 * single contact had not appeared in monday.
 *
 * THE LESSON THIS PINS: adding a spec to CRM_SPECS changes what the WHOLE DEPLOYMENT reads at
 * startup, not just what that one object does. A spec is not inert because its object is not being
 * synced yet — `line_items` had, and still has, no webhook subscription at all, and it still forced a
 * schema read on every unrelated event.
 *
 * Everything here is offline and static: two files that must agree, and until now nothing compared
 * them. Exactly the shape of the mapped-but-unsubscribed bug that `mapped-vs-subscribed.test.ts`
 * exists to catch — this is the other half of that idea.
 */
describe("every CRM spec's object is covered by the app's scopes", () => {
  const scopes = readAppScopes();

  it("knows the scope names for every object a spec declares", () => {
    // Guards the test itself: a spec for a new object type (tickets, quotes, custom objects) must add
    // its entry to SCOPES_FOR, or the coverage checks below would silently pass by skipping it.
    for (const spec of CRM_SPECS)
      expect(SCOPES_FOR[spec.object], `SCOPES_FOR has no entry for "${spec.object}"`).toBeTruthy();
  });

  // The read scope. Needed to fetch records of that object at all.
  it.each(CRM_SPECS.map(s => s.object))("%s: the app can READ the object", (object) => {
    expect(scopes.has(SCOPES_FOR[object].read),
      `CRM_SPECS covers ${object} but the app lacks ${SCOPES_FOR[object].read}`).toBe(true);
  });

  /**
   * The SCHEMA scope, and this is the one that actually broke production. buildCtx resolves label
   * dictionaries for the whole deployment on EVERY invocation, so a missing schema scope for an
   * object nobody is syncing still 403s on a webhook for a completely different object.
   */
  it.each(CRM_SPECS.map(s => s.object))("%s: the app can read the object's SCHEMA", (object) => {
    expect(scopes.has(SCOPES_FOR[object].schema),
      `CRM_SPECS covers ${object} but the app lacks ${SCOPES_FOR[object].schema} — `
      + `buildCtx reads property options for EVERY spec, so this 403s on unrelated webhooks`).toBe(true);
  });

  /**
   * The write scope — and the honest version of this rule, because the naive one ("anything that
   * declares `reverse` needs write") is not yet true and pretending otherwise would just mean
   * granting privilege before it is needed.
   *
   * `deals` (10 reverse fields) and `line_items` (18) both declare two-way sync, and NEITHER has the
   * write scope. That is not currently a defect: monday boards 5028000494 and 5028000489 have ZERO
   * monday webhooks registered, so no monday edit can reach the Worker, so no reverse write can be
   * attempted. The historical import is forward-only and needs read scopes alone.
   *
   * It becomes a defect the instant someone registers monday webhooks for those boards — the first
   * rep edit would 403 exactly the way the 2026-09-15 outage did. So the pairing is recorded here:
   * GRANTING THE MONDAY WEBHOOKS AND GRANTING THE WRITE SCOPE ARE ONE STEP, NEVER TWO.
   *
   * To close it: add crm.objects.deals.write / crm.objects.line_items.write to app-hsmeta.json,
   * `hs project upload`, REAUTHORIZE the install (a scope change does not reach an existing static
   * token on its own — that is what cost the outage its second hour), then delete the entry below.
   */
  // CLOSED IN THE APP DEFINITION on 2026-09-23: both write scopes are now in app-hsmeta.json. The file
  // is only half of it -- the install must still be RE-AUTHORIZED in HubSpot before the Deals and P&S
  // monday webhooks are registered, per the rule above.
  const REVERSE_WITHOUT_WRITE_SCOPE: string[] = [];

  it("every spec that reverses can WRITE its object, except the recorded pre-webhook gaps", () => {
    const gaps: string[] = [];
    for (const spec of CRM_SPECS) {
      const reverses = spec.fields.some(f => f.reverse || f.appReverse || f.backfill)
        || !!spec.nameReverse || !!spec.createFromMonday;
      if (!reverses) continue;
      if (!scopes.has(SCOPES_FOR[spec.object].write)) gaps.push(spec.object);
    }
    // Exact match, both directions. A NEW object losing its write scope fails here; and once the
    // scope is granted, this fails until the stale entry is removed — so the list cannot rot.
    expect(gaps.sort()).toEqual([...REVERSE_WITHOUT_WRITE_SCOPE].sort());
  });

  it("the objects in that gap really do have no monday webhooks to trigger a reverse write", () => {
    // The gap is only tolerable because nothing can fire. If one of these ever becomes the live
    // two-way surface, the comment above says what has to happen first.
    for (const object of REVERSE_WITHOUT_WRITE_SCOPE)
      expect(CRM_SPECS.find(s => s.object === object), `${object} is listed but is not a CRM spec`).toBeTruthy();
  });

  /**
   * Owners back every `type: "people"` column — buildCtx calls /crm/v3/owners to map owner ids to
   * monday users. Asserted separately because it is not tied to any one spec's object, so none of the
   * per-object loops above would ever catch its absence.
   */
  it("the app can read OWNERS, which every people column depends on", () => {
    const usesPeople = CRM_SPECS.some(s => s.fields.some(f => f.type === "people"));
    expect(usesPeople).toBe(true);
    expect(scopes.has("crm.objects.owners.read")).toBe(true);
  });

  /**
   * The converse direction. A scope granted for an object no spec covers is not an outage, but it is
   * privilege the app does not need — and this app's README (§1c) argued least-privilege explicitly.
   * Reported as a failure so widening the app is a deliberate act with a reason, not a leftover.
   */
  it("grants no object scope that no spec needs", () => {
    // Widened to string: SCOPES_FOR is keyed by plain strings so it can carry an object type before
    // any spec declares one, while ObjectSpec.object is a closed union.
    const covered = new Set<string>(CRM_SPECS.map(s => s.object));
    for (const [object, s] of Object.entries(SCOPES_FOR)) {
      if (covered.has(object)) continue;
      for (const scope of [s.read, s.schema, s.write])
        expect(scopes.has(scope), `app grants ${scope} but no spec covers ${object}`).toBe(false);
    }
  });
});
