import { describe, it, expect } from "vitest";
import {
  syncOwnerOf, authorizeWrite, canClaimCrmOwnership, claimPatch, cutoverFromEnv, withBirthOwnership,
  authorizeCreate, NEW_RECORD_ID,
} from "../src/ownership";
import { ALL_SPECS } from "../src/config";
import type { OwnershipSpec } from "../src/types";

const CUTOVER = Date.parse("2026-10-01T00:00:00Z");
const crm: OwnershipSpec = { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: CUTOVER };
const wm: OwnershipSpec = { ...crm, owner: "wm" };
const rec = (props: Record<string, string | null>) => ({ id: "1", properties: props });
const before = "2026-09-01T00:00:00Z";
const after = "2026-11-01T00:00:00Z";

describe("syncOwnerOf", () => {
  it("reads the stamp", () => expect(syncOwnerOf(rec({ sync_owner: "crm" }), crm)).toBe("crm"));
  it("trims and lowercases — the property is human-editable in HubSpot", () =>
    expect(syncOwnerOf(rec({ sync_owner: " WM " }), crm)).toBe("wm"));
  it("unstamped is empty, never a guess", () => {
    expect(syncOwnerOf(rec({}), crm)).toBe("");
    expect(syncOwnerOf(rec({ sync_owner: null }), crm)).toBe("");
    expect(syncOwnerOf(rec({ sync_owner: "  " }), crm)).toBe("");
  });
  it("an unrecognised value is 'other' — present but not ours, distinct from absent", () =>
    expect(syncOwnerOf(rec({ sync_owner: "someone_else" }), crm)).toBe("other"));
});

// The property is human-editable in HubSpot, so an ops user may park a record with "hold"/"manual".
// That must mean HANDS OFF for BOTH syncs. Treating it as "unowned" would let CRM claim it and
// overwrite the marker — the consequence, not just the normalisation, is what these assert.
describe("an unrecognised stamp parks the record", () => {
  const parked = rec({ sync_owner: "hold", createdate: after });
  const parkedOld = rec({ sync_owner: "manual", createdate: before });
  it("CRM cannot write it", () => expect(authorizeWrite(parked, crm).allowed).toBe(false));
  it("WM cannot write it either, even pre-cutover", () =>
    expect(authorizeWrite(parkedOld, wm).allowed).toBe(false));
  it("CRM cannot CLAIM it — the marker is never overwritten", () =>
    expect(canClaimCrmOwnership(parked, crm)).toBe(false));
  it("the refusal names the offending value so an operator can find it", () =>
    expect(authorizeWrite(parked, crm).reason).toContain("hold"));
});

describe("authorizeWrite — CRM Worker", () => {
  it("allows a crm-stamped record", () =>
    expect(authorizeWrite(rec({ sync_owner: "crm" }), crm).allowed).toBe(true));
  it("REFUSES a wm-stamped record, and says why", () => {
    const a = authorizeWrite(rec({ sync_owner: "wm" }), crm);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("wm");
  });
  it("REFUSES an unstamped record even post-cutover — it must CLAIM first", () =>
    expect(authorizeWrite(rec({ createdate: after }), crm).allowed).toBe(false));
  it("REFUSES an unstamped pre-cutover record", () =>
    expect(authorizeWrite(rec({ createdate: before }), crm).allowed).toBe(false));
});

describe("authorizeWrite — WM Worker", () => {
  it("allows a wm-stamped record", () =>
    expect(authorizeWrite(rec({ sync_owner: "wm" }), wm).allowed).toBe(true));
  it("REFUSES a crm-stamped record", () =>
    expect(authorizeWrite(rec({ sync_owner: "crm" }), wm).allowed).toBe(false));
  it("allows unstamped + pre-cutover (the ~44k historical records, deliberately unstamped)", () =>
    expect(authorizeWrite(rec({ createdate: before }), wm).allowed).toBe(true));
  it("REFUSES unstamped + post-cutover (CRM's to claim)", () =>
    expect(authorizeWrite(rec({ createdate: after }), wm).allowed).toBe(false));
  it("fails CLOSED on an unusable create date", () => {
    expect(authorizeWrite(rec({ createdate: "not-a-date" }), wm).allowed).toBe(false);
    expect(authorizeWrite(rec({}), wm).allowed).toBe(false);
  });
  it("accepts an epoch-ms string, which HubSpot sometimes returns", () =>
    expect(authorizeWrite(rec({ createdate: String(Date.parse(before)) }), wm).allowed).toBe(true));
});

describe("canClaimCrmOwnership", () => {
  it("claims an unstamped post-cutover record", () =>
    expect(canClaimCrmOwnership(rec({ createdate: after }), crm)).toBe(true));
  it("never claims pre-cutover", () =>
    expect(canClaimCrmOwnership(rec({ createdate: before }), crm)).toBe(false));
  it("never re-claims an already-stamped record", () => {
    expect(canClaimCrmOwnership(rec({ sync_owner: "crm", createdate: after }), crm)).toBe(false);
    expect(canClaimCrmOwnership(rec({ sync_owner: "wm", createdate: after }), crm)).toBe(false);
  });
  it("the WM Worker never claims", () =>
    expect(canClaimCrmOwnership(rec({ createdate: after }), wm)).toBe(false));
  it("cannot claim on an unusable create date", () =>
    expect(canClaimCrmOwnership(rec({ createdate: "nope" }), crm)).toBe(false));
  it("an INFINITE cutover makes claiming impossible — the Phase 1 inert setting", () =>
    expect(canClaimCrmOwnership(rec({ createdate: after }),
      { ...crm, cutoverAtMs: Number.POSITIVE_INFINITY })).toBe(false));
});

describe("claimPatch", () => {
  it("is EXACTLY one property", () => {
    const p = claimPatch(crm);
    expect(p).toEqual({ sync_owner: "crm" });
    expect(Object.keys(p)).toHaveLength(1);
  });
});

describe("cutoverFromEnv — fails safe, never opens the floodgates", () => {
  it("a real ISO timestamp parses", () =>
    expect(cutoverFromEnv("2026-10-01T00:00:00Z")).toBe(Date.parse("2026-10-01T00:00:00Z")));
  it("undefined/missing -> INFINITY (claiming disabled)", () =>
    expect(cutoverFromEnv(undefined)).toBe(Number.POSITIVE_INFINITY));
  it('EMPTY STRING -> INFINITY, never 0. Number("") is 0, which would make EVERY record look '
     + "post-cutover and hand CRM the whole portal", () => {
    expect(cutoverFromEnv("")).toBe(Number.POSITIVE_INFINITY);
    expect(cutoverFromEnv("   ")).toBe(Number.POSITIVE_INFINITY);
  });
  it("malformed -> INFINITY", () => {
    expect(cutoverFromEnv("not-a-date")).toBe(Number.POSITIVE_INFINITY);
    expect(cutoverFromEnv("NaN")).toBe(Number.POSITIVE_INFINITY);
  });
  it("a zero or negative epoch is refused (a sentinel, not a real cutover)", () => {
    expect(cutoverFromEnv("0")).toBe(Number.POSITIVE_INFINITY);
    expect(cutoverFromEnv("-1")).toBe(Number.POSITIVE_INFINITY);
    expect(cutoverFromEnv("+0")).toBe(Number.POSITIVE_INFINITY);
  });
  it("an epoch-ms string parses", () =>
    expect(cutoverFromEnv(String(CUTOVER))).toBe(CUTOVER));

  // THE DANGEROUS INPUTS ARE THE PLAUSIBLE TYPOS. Each of these parses as epoch-ms a few
  // milliseconds after 1970, which would put the cutover in the past, make EVERY record
  // post-cutover, and hand the CRM Worker the entire portal.
  it('"1" (meaning "enabled") is refused, not treated as 1ms after 1970', () =>
    expect(cutoverFromEnv("1")).toBe(Number.POSITIVE_INFINITY));
  it('"2026" (the year) is refused, not 2026ms after 1970', () =>
    expect(cutoverFromEnv("2026")).toBe(Number.POSITIVE_INFINITY));
  it('"20261001" (a date without separators) is refused', () =>
    expect(cutoverFromEnv("20261001")).toBe(Number.POSITIVE_INFINITY));
  it("a date before the plausible window is refused", () =>
    expect(cutoverFromEnv("1999-01-01T00:00:00Z")).toBe(Number.POSITIVE_INFINITY));
  it("a date past the plausible window is refused", () =>
    expect(cutoverFromEnv("2200-01-01T00:00:00Z")).toBe(Number.POSITIVE_INFINITY));
  it("overflow and non-finite forms are refused", () => {
    for (const v of ["1e999", "Infinity", "-Infinity", "1e21", "0x10", "1_000", "1.5"])
      expect(cutoverFromEnv(v)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("authorizeCreate", () => {
  it("allows a create and is bound to the new-record id, not a real record", () => {
    const a = authorizeCreate(crm);
    expect(a.allowed).toBe(true);
    expect(a.forId).toBe(NEW_RECORD_ID);
  });
});

// A garbage create date must NOT make a record claimable. Number("1e21") is finite, so a bare
// `>=` comparison would have sailed straight through.
describe("an unusable create date fails closed in BOTH directions", () => {
  for (const bad of ["1e21", "1e999", "not-a-date", ""]) {
    it(`createdate ${JSON.stringify(bad)}: not claimable, not writable`, () => {
      const r = rec({ createdate: bad });
      expect(canClaimCrmOwnership(r, crm)).toBe(false);
      expect(authorizeWrite(r, wm).allowed).toBe(false);
    });
  }
});

// TRIPWIRE. Phase 1 must ship with NO production spec declaring ownership — the guard and the
// property-fetch addition are both no-ops until one does. The day someone flips it, this names the
// invariant instead of letting six call sites throw in production.
describe("Phase 1 tripwire", () => {
  it("no production spec declares ownership yet", () =>
    expect(ALL_SPECS.every(s => s.ownership?.owner === "wm")).toBe(true));
  it("no production spec declares adoptBy yet", () =>
    expect(ALL_SPECS.every(s => !s.adoptBy)).toBe(true));
});

describe("withBirthOwnership", () => {
  it("stamps a CRM create payload alongside the business fields", () =>
    expect(withBirthOwnership({ firstname: "Jo", email: "jo@x.com" }, crm))
      .toEqual({ firstname: "Jo", email: "jo@x.com", sync_owner: "crm" }));
  it("leaves a spec WITHOUT ownership untouched (production create path unchanged)", () =>
    expect(withBirthOwnership({ dealname: "D" }, undefined)).toEqual({ dealname: "D" }));
  it("a birth stamp is NOT a claim — claimPatch stays single-property", () => {
    expect(Object.keys(withBirthOwnership({ a: "1", b: "2" }, crm))).toHaveLength(3);
    expect(Object.keys(claimPatch(crm))).toHaveLength(1);
  });
  it("does not mutate the caller's object", () => {
    const src = { firstname: "Jo" };
    withBirthOwnership(src, crm);
    expect(src).toEqual({ firstname: "Jo" });
  });
});

// The ordering property that stops the claim path from becoming a general write bypass.
describe("claim-then-write ordering", () => {
  it("unstamped post-cutover: claimable, NOT writable", () => {
    const r = rec({ createdate: after });
    expect(canClaimCrmOwnership(r, crm)).toBe(true);
    expect(authorizeWrite(r, crm).allowed).toBe(false);
  });
  it("once stamped it is writable and no longer claimable", () => {
    const r = rec({ createdate: after, sync_owner: "crm" });
    expect(canClaimCrmOwnership(r, crm)).toBe(false);
    expect(authorizeWrite(r, crm).allowed).toBe(true);
  });
});

// ADOPTION MUST NOT TRANSFER OWNERSHIP. A rep recreating an old contact on the CRM board links the
// existing HubSpot record (so no duplicate) but must NOT take ownership of history.
describe("adopting a historical WM-owned record", () => {
  const historical = rec({ createdate: "2024-03-01T00:00:00Z" }); // unstamped, pre-cutover

  it("is NOT claimable — recreating a record must not migrate ownership", () =>
    expect(canClaimCrmOwnership(historical, crm)).toBe(false));
  it("is NOT writable by CRM — reverse writes stay blocked", () =>
    expect(authorizeWrite(historical, crm).allowed).toBe(false));
  it("stays writable by WM, which still owns it", () =>
    expect(authorizeWrite(historical, wm).allowed).toBe(true));
  it("the same holds for a company adopted by domain", () => {
    const oldCo = rec({ createdate: "2023-01-01T00:00:00Z" });
    expect(canClaimCrmOwnership(oldCo, crm)).toBe(false);
    expect(authorizeWrite(oldCo, crm).allowed).toBe(false);
  });
});
