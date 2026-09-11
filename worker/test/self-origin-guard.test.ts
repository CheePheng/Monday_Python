import { describe, it, expect } from "vitest";
import { formatActor } from "../src/actor-label";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import { CONTACTS_MYLA, COMPANIES_MYLA, DEALS } from "../src/config";
// readCode strips comments, so these assertions target EXECUTABLE code — a comment that merely
// mentions `spec.ownership` must not satisfy or trip a structural check. Same helper the
// restore-card structural tests use; it lives in .mjs because the worker tsconfig has no node:fs types.
import { readCode } from "../scripts/read-source.mjs";

/**
 * THE PROVENANCE GUARD, and the incident that earned it.
 *
 * During the 2026-09-09/11 historical import the Worker created 1,207 HubSpot Companies — 1,207 of the
 * 1,213 it has ever created — each within 2 to 26 seconds of a monday Accounts card appearing. monday's
 * own activity log attributes every one of those cards to user 104118038, this integration's token. One
 * of the companies (domain fake.com) then accumulated 1,581 contact associations.
 *
 * The mechanism is a RACE, not a logic error, which is why no amount of reading the code would have
 * found it: createItem stamps the HubSpot ID column, monday fires create_item within milliseconds, and
 * the webhook's getItem read does not see that column yet. colText(item, idCol) returns "", so
 * syncMondayItem concludes a human made a brand-new card and createFromMonday mints a HubSpot record.
 *
 * The guard: an event attributed to our OWN token is an echo and carries no user intent, so every
 * monday -> HubSpot mutation is suppressed for it while the forward direction still runs.
 */

const src = (f: string) => readCode(f);

describe("isIntegrationActor fails CLOSED", () => {
  /**
   * The asymmetry is deliberate and is the whole safety argument: refusing to create costs a rep one
   * visible retry on a card that keeps all its data, while wrongly creating writes an irreversible
   * record into HubSpot — and, as fake.com showed, can drag 1,581 associations behind it.
   */
  it("treats an unattributed event as our own, not as a person's", () => {
    // formatActor is the shared classifier; an empty actor is never reported as a person.
    expect(formatActor("", null, "104118038")).toBe("actor=unknown");
  });

  it("flags our own token distinctly from a person", () => {
    expect(formatActor("104118038", null, "104118038")).toContain("actor=integration");
    expect(formatActor("999", { name: "Matthew", email: "m@x.com" }, "104118038")).toContain("actor=person");
  });

  // The source is asserted because the fail-closed direction is the security property, and an
  // "improvement" to return false on the uncertain paths would silently reopen the hole.
  it("returns true on every path where the actor cannot be established", () => {
    const s = src("actor-label.ts");
    const fn = s.slice(s.indexOf("export async function isIntegrationActor"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("if (!userId) return true;");          // no attribution on the event
    expect(body).toContain("if (!selfIdCache) return true;");     // could not learn our own id
    expect(body).toMatch(/catch\s*\{\s*\n?\s*return true;/);      // whoAmI threw
  });
});

describe("the guard is opt-in per spec, never inferred", () => {
  it("both CRM specs opt in", () => {
    expect(CRM_CONTACTS.suppressSelfOriginWrites).toBe(true);
    expect(CRM_ACCOUNTS.suppressSelfOriginWrites).toBe(true);
  });

  // THE REGRESSION THAT MATTERS. These three run on the live Work-Management Worker off this same
  // engine; their behaviour must be byte-for-byte what it was.
  it("NO Work-Management spec opts in", () => {
    for (const s of [CONTACTS_MYLA, COMPANIES_MYLA, DEALS])
      expect(s.suppressSelfOriginWrites).toBeUndefined();
  });

  /**
   * `ownership` was my first gate and it was wrong — restore-card.test.ts already forbids using it in
   * webhooks.ts as a stand-in for another decision, and it caught me. An explicit flag says what it
   * means; a proxy invites the next person to assume the two always travel together.
   */
  it("the webhook gate reads the explicit flag, not ownership", () => {
    const w = src("webhooks.ts");
    expect(w).toContain("spec.suppressSelfOriginWrites");
    expect(w).not.toContain("spec.ownership");
  });
});

describe("what selfOrigin actually suppresses", () => {
  const sync = src("sync.ts");

  /**
   * THE CREATE GATE COMES FIRST, before `createFromMonday`. A card with no HubSpot ID in this read is
   * not evidence a person made one — our own createItem stamps that column and the webhook can beat
   * monday serving it back. Ordering it after the createFromMonday check would leave Accounts (which
   * IS create-enabled) exposed, which is exactly the board that took the damage.
   */
  it("refuses to create a HubSpot record, and checks provenance before createFromMonday", () => {
    const i = sync.indexOf("if (selfOrigin)\n    return wlog(\"monday\"");
    const j = sync.indexOf("if (!spec.createFromMonday)");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it("skips reverse associations — the path that gave fake.com 1,581 of them", () => {
    expect(sync).toContain("budget.left > 0 && !selfOrigin");
    expect(sync).toContain("action=reverse-assoc-skipped");
  });

  /**
   * Pinning the direction forward is what stops a reverse FIELD patch. Leaving it to decideDirection
   * would sometimes choose "toHubspot" for a card we had just written ourselves — a bulk seed becoming
   * a bulk write-back.
   */
  it("pins the reconcile direction forward rather than deciding by timestamp", () => {
    expect(sync).toContain('const dir = selfOrigin ? "toMonday"');
  });

  /** The forward direction must STILL run: reconciling HubSpot's truth onto our own card is harmless
   *  and self-healing, and suppressing it would leave cards permanently stale. */
  it("still reconciles forward rather than skipping the record entirely", () => {
    expect(sync).toContain("reconcileRecord(env, spec, ctx, opts, budget, deal, item, stats, appSave, selfOrigin)");
  });
});
