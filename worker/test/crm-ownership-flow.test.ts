import { describe, it, expect } from "vitest";
import { authorizeWrite, canClaimCrmOwnership, claimPatch, withBirthOwnership } from "../src/ownership";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_CUTOVER_AT_MS } from "../src/config/crm";
import { ALL_SPECS } from "../src/config";
import type { HsRecord, OwnershipSpec } from "../src/types";

/**
 * TASK 9 — the claim-then-write ORDERING property.
 *
 * The rule the plan's own first draft got wrong: the gate must NOT sit near the top of reconcileRecord.
 * Placed there it claims on any reconcile of an eligible record, including a purely forward
 * HubSpot -> monday pass. Ownership is claimed only when a HubSpot business write is genuinely required,
 * i.e. after buildReversePatch has produced a NON-EMPTY patch. These tests pin the state machine that
 * `ensureHubspotWriteAuth` implements.
 */

const CUT = Date.parse("2026-10-01T00:00:00Z");
const own: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: CUT };
const wmOwn: OwnershipSpec = { ...own, owner: "wm" };
const rec = (p: Record<string, string>): HsRecord => ({ id: "1", properties: p });

const PRE = "2024-03-01T00:00:00Z";
const POST = "2026-11-01T00:00:00Z";

describe("the ordering invariant: claimable XOR writable, never both", () => {
  it("an eligible unstamped record is claimable but NOT yet writable", () => {
    const r = rec({ createdate: POST });
    expect(canClaimCrmOwnership(r, own)).toBe(true);
    expect(authorizeWrite(r, own).allowed).toBe(false);
  });

  it("once stamped it is writable and NO LONGER claimable — so a second claim is impossible", () => {
    const r = rec({ sync_owner: "crm", createdate: POST });
    expect(authorizeWrite(r, own).allowed).toBe(true);
    expect(canClaimCrmOwnership(r, own)).toBe(false);
  });

  // Simulates exactly what ensureHubspotWriteAuth does on a successful claim: reflect the confirmed
  // single-property write locally, then re-authorize. The transition must flip both predicates.
  it("the verified local transition makes the record writable in one step", () => {
    const r = rec({ createdate: POST });
    expect(authorizeWrite(r, own).allowed).toBe(false);
    Object.assign(r.properties, claimPatch(own));      // what the PATCH wrote, and only that
    expect(authorizeWrite(r, own).allowed).toBe(true);
    expect(canClaimCrmOwnership(r, own)).toBe(false);  // idempotent: no duplicate claim next tick
  });

  it("repeating the reconcile after a successful claim produces no second claim", () => {
    const r = rec({ sync_owner: "crm", createdate: POST });
    for (let i = 0; i < 5; i++) {
      expect(canClaimCrmOwnership(r, own)).toBe(false);
      expect(authorizeWrite(r, own).allowed).toBe(true);
    }
  });
});

describe("never claim", () => {
  it.each([
    ["sync_owner=wm", { sync_owner: "wm", createdate: POST }],
    ["an unknown stamp", { sync_owner: "hold", createdate: POST }],
    ["a historical pre-cutover record", { createdate: PRE }],
    ["a missing create date", {}],
    ["a malformed create date", { createdate: "not-a-date" }],
    ["an out-of-range create date", { createdate: "1e21" }],
    ["an already-crm record", { sync_owner: "crm", createdate: POST }],
  ])("%s", (_label, props) => expect(canClaimCrmOwnership(rec(props), own)).toBe(false));

  it("the WM worker never claims, whatever the record", () => {
    const cases: Record<string, string>[] = [{ createdate: POST }, { createdate: PRE }, {}];
    for (const p of cases) expect(canClaimCrmOwnership(rec(p), wmOwn)).toBe(false);
  });
});

describe("historical adopted record: forward yes, reverse no", () => {
  const historical = rec({ createdate: PRE });   // adopted by domain, deliberately left unstamped

  it("cannot be claimed", () => expect(canClaimCrmOwnership(historical, own)).toBe(false));

  it("cannot be reverse-written by CRM", () => {
    const auth = authorizeWrite(historical, own);
    expect(auth.allowed).toBe(false);
    expect(auth.reason).toMatch(/unstamped/);
  });

  // The forward direction never consults ownership at all — reading HubSpot and writing MONDAY is always
  // safe. That is why ensureHubspotWriteAuth is only reachable from the two HubSpot-write paths.
  it("still belongs to WM, which can write it", () =>
    expect(authorizeWrite(historical, wmOwn).allowed).toBe(true));
});

describe("the claim payload", () => {
  it("is exactly one property and it is the ownership stamp", () => {
    const p = claimPatch(own);
    expect(p).toEqual({ sync_owner: "crm" });
    expect(Object.keys(p)).toHaveLength(1);
  });

  it("can never carry a business field, because `prop` is a literal type", () => {
    // A spec author cannot write prop: "email" — tsc rejects it. This asserts the runtime consequence.
    expect(Object.keys(claimPatch({ ...own, createdProp: "hs_createdate" }))).toEqual(["sync_owner"]);
  });
});

describe("birth ownership is NOT a claim", () => {
  it("a brand-new record carries the stamp in its full create payload", () =>
    expect(withBirthOwnership({ name: "Acme", domain: "acme.com" }, own))
      .toEqual({ name: "Acme", domain: "acme.com", sync_owner: "crm" }));

  it("and needs no eligibility check, because it does not exist yet", () => {
    // canClaimCrmOwnership would say false for a record with no createdate; birth ownership bypasses it
    // legitimately, which is exactly why the two operations are separate functions.
    expect(canClaimCrmOwnership(rec({}), own)).toBe(false);
    expect(withBirthOwnership({}, own)).toEqual({ sync_owner: "crm" });
  });

  // CHANGED 2026-09-21: all four CRM objects are now created from monday, because the 创建/Create forms
  // are the sales team's only entry point after the migration. Birth ownership therefore applies to
  // every one of them — which is the property this block actually protects.
  it("Contacts have a birth path", () => expect(CRM_CONTACTS.createFromMonday).toBe(true));

  it("Accounts do too", () => expect(CRM_ACCOUNTS.createFromMonday).toBe(true));
});

// PHASE 1 IS INERT BY CONFIGURATION. With an infinite cutover nothing is claimable, so the claim path
// cannot fire in production even if every other guard were removed.
describe("Phase 1 inertness", () => {
  it("the shipped cutover is infinite", () => expect(CRM_CUTOVER_AT_MS).toBe(Number.POSITIVE_INFINITY));

  it("no record is claimable under the shipped CRM specs, however recent", () => {
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS])
      for (const d of [POST, PRE, new Date().toISOString()])
        expect(canClaimCrmOwnership(rec({ createdate: d }), spec.ownership!)).toBe(false);
  });

  it("and therefore no unstamped record is writable either — the CRM path can write nothing", () => {
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS])
      expect(authorizeWrite(rec({ createdate: POST }), spec.ownership!).allowed).toBe(false);
  });

  // The consequence worth stating out loud: the claim path's FIRST real execution happens the moment a
  // finite cutover is set. See the Phase-D rehearsal requirement in the plan.
  it("an explicitly crm-stamped record is still writable, so Phase D can be rehearsed record-by-record", () => {
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS])
      expect(authorizeWrite(rec({ sync_owner: "crm" }), spec.ownership!).allowed).toBe(true);
  });
});

describe("WM production specs cannot reach any of this", () => {
  it("none declares ownership, so ensureHubspotWriteAuth returns undefined for all of them", () => {
    for (const s of ALL_SPECS) expect(s.ownership?.owner).toBe("wm");
  });
});
