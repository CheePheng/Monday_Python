import { describe, it, expect } from "vitest";
import {
  syncOwnerOf, authorizeWrite, canClaimCrmOwnership, claimPatch, cutoverFromEnv, withBirthOwnership,
} from "../src/ownership";
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
  it("an unrecognised value belongs to NEITHER owner", () =>
    expect(syncOwnerOf(rec({ sync_owner: "someone_else" }), crm)).toBe(""));
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
  });
  it("an epoch-ms string parses", () =>
    expect(cutoverFromEnv(String(CUTOVER))).toBe(CUTOVER));
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
