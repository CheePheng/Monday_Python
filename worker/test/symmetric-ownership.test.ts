import { describe, it, expect } from "vitest";
import { authorizeWrite, canClaimCrmOwnership, mayCreateCrmCard } from "../src/ownership";
import { propertiesForSpec } from "../src/hubspot";
import { specsFor, ALL_SPECS, DEALS } from "../src/config";
import { CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";
import type { HsRecord, ObjectSpec } from "../src/types";

/**
 * ONE HUBSPOT RECORD, ONE WRITER — proven from both sides.
 *
 * `authorizeWrite` has implemented the whole rule since 2026-09-07, but only CRM ever asked it: the WM
 * specs declared no `ownership`, so the guard returned "allowed" for them unconditionally. The result
 * was a genuine live conflict rather than a theoretical one — 15 deals in the `default` pipeline sat in
 * BOTH Workers' write scope, and once CRM claimed one, WM would have carried on patching it.
 *
 * This file is the symmetry proof. Every case is asserted from the WM side AND the CRM side, because a
 * rule enforced on one side only is not a rule.
 */

const CUT = Date.parse("2026-09-10T00:00:00Z");
const wmSpec = (cutoverAtMs = CUT): ObjectSpec =>
  ({ ...DEALS, ownership: { prop: "sync_owner", createdProp: "createdate", owner: "wm", cutoverAtMs } });
const crmSpec = (cutoverAtMs = CUT): ObjectSpec =>
  ({ ...CRM_DEALS, ownership: { prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs } });

const rec = (props: Record<string, string>): HsRecord => ({ id: "D1", properties: props });
const PRE = { createdate: "2026-09-01T00:00:00Z" };    // before the cutover -> WM's
const POST = { createdate: "2026-09-20T00:00:00Z" };   // after it -> CRM's to claim

// ---------------------------------------------------------------- the WM side (the new half)

describe("Work Management refuses what it does not own", () => {
  it("sync_owner=crm -> NO write", () => {
    const a = authorizeWrite(rec({ ...PRE, sync_owner: "crm" }), wmSpec().ownership!);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("owned by crm");
  });

  it("sync_owner=hold -> NO write (an operator parked it)", () => {
    const a = authorizeWrite(rec({ ...PRE, sync_owner: "hold" }), wmSpec().ownership!);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("hands off");
  });

  it("sync_owner=wm -> allowed, as before", () =>
    expect(authorizeWrite(rec({ ...PRE, sync_owner: "wm" }), wmSpec().ownership!).allowed).toBe(true));

  it("blank + PRE-cutover -> allowed (the ~44k historical records)", () =>
    expect(authorizeWrite(rec(PRE), wmSpec().ownership!).allowed).toBe(true));

  it("blank + POST-cutover -> DENIED, it is CRM's to claim", () => {
    const a = authorizeWrite(rec(POST), wmSpec().ownership!);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("post-cutover");
  });

  /** Today's shipped state: no CRM_CUTOVER_AT var -> Infinity -> WM keeps writing every unstamped
   *  record exactly as it does now. The crm/hold refusals still bite, which is the point. */
  it("with an INFINITE cutover WM still writes unstamped records — today's behaviour preserved", () => {
    const inf = wmSpec(Number.POSITIVE_INFINITY).ownership!;
    expect(authorizeWrite(rec(PRE), inf).allowed).toBe(true);
    expect(authorizeWrite(rec(POST), inf).allowed).toBe(true);
    expect(authorizeWrite(rec({ ...POST, sync_owner: "crm" }), inf).allowed).toBe(false);
  });

  it("an unusable createdate is REFUSED, never guessed", () =>
    expect(authorizeWrite(rec({ createdate: "" }), wmSpec().ownership!).allowed).toBe(false));

  it("WM never claims, whatever the record looks like", () => {
    for (const p of [PRE, POST, { ...POST, sync_owner: "" }])
      expect(canClaimCrmOwnership(rec(p), wmSpec().ownership!)).toBe(false);
  });

  /**
   * THE REGRESSION THAT ALMOST SHIPPED. `mayCreateCrmCard` gated on the mere PRESENCE of ownership as a
   * proxy for "is CRM". Giving WM an ownership spec inverted it: WM's cutover is Infinity, so
   * `created >= Infinity` was false for every record and the WM Worker stopped carding anything at all.
   */
  it("WM card creation is NOT gated by the no-historical-import rule", () => {
    for (const p of [PRE, POST, {}])
      expect(mayCreateCrmCard(rec(p), wmSpec(Number.POSITIVE_INFINITY).ownership!)).toBe(true);
  });
});

// ---------------------------------------------------------------- the CRM side (unchanged)

describe("CRM refuses what it does not own", () => {
  it("sync_owner=wm -> DENIED", () => {
    const a = authorizeWrite(rec({ ...POST, sync_owner: "wm" }), crmSpec().ownership!);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("owned by wm");
  });

  it("sync_owner=crm -> allowed", () =>
    expect(authorizeWrite(rec({ ...POST, sync_owner: "crm" }), crmSpec().ownership!).allowed).toBe(true));

  it("blank -> must CLAIM first, never write directly", () => {
    const a = authorizeWrite(rec(POST), crmSpec().ownership!);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("must claim");
  });

  it("claims only POST-cutover records", () => {
    expect(canClaimCrmOwnership(rec(POST), crmSpec().ownership!)).toBe(true);
    expect(canClaimCrmOwnership(rec(PRE), crmSpec().ownership!)).toBe(false);
  });
});

// ---------------------------------------------------------------- the symmetry itself

describe("exactly one writer, for every possible record state", () => {
  const states: [string, Record<string, string>][] = [
    ["blank pre-cutover", PRE],
    ["blank post-cutover", POST],
    ["stamped wm", { ...PRE, sync_owner: "wm" }],
    ["stamped crm", { ...POST, sync_owner: "crm" }],
    ["parked hold", { ...PRE, sync_owner: "hold" }],
    ["unusable createdate", { createdate: "nonsense" }],
  ];

  it.each(states)("%s: never both Workers", (_label, props) => {
    const wm = authorizeWrite(rec(props), wmSpec().ownership!).allowed;
    const crm = authorizeWrite(rec(props), crmSpec().ownership!).allowed;
    expect(wm && crm, "BOTH Workers may write this record").toBe(false);
  });

  /** The only states with NO writer are the deliberately-parked and the unusable ones. */
  it.each(states)("%s: a writable record has exactly one owner", (label, props) => {
    const wm = authorizeWrite(rec(props), wmSpec().ownership!).allowed;
    const crm = authorizeWrite(rec(props), crmSpec().ownership!).allowed;
    if (label === "parked hold" || label === "unusable createdate" || label === "blank post-cutover")
      expect(wm || crm).toBe(false);          // hold/unusable refuse both; blank post-cutover needs a claim
    else expect(Number(wm) + Number(crm)).toBe(1);
  });
});

// ---------------------------------------------------------------- the real specs and the live conflict

describe("the shipped specs", () => {
  it("every WM spec is owner wm; every CRM spec is owner crm", () => {
    for (const s of ALL_SPECS) expect(s.ownership?.owner).toBe("wm");
    for (const s of specsFor({ ENABLE_CRM: "true" })) expect(s.ownership?.owner).toBe("crm");
  });

  it("both sides fetch the ownership metadata they authorize on", () => {
    for (const s of [...ALL_SPECS, CRM_DEALS, CRM_LINE_ITEMS]) {
      const p = propertiesForSpec(s);
      expect(p, `${s.object} does not fetch sync_owner`).toContain("sync_owner");
      expect(p, `${s.object} does not fetch createdate`).toContain("createdate");
    }
  });

  /**
   * The 15 live deals that provoked all of this: `pipeline = "default"` puts them in WM's search
   * scope, and their createdate puts them after the CRM cutover. Before this change BOTH Workers were
   * permitted; now the outcome depends only on the stamp, and never grants both.
   */
  it("a contested default-pipeline deal has one writer, whatever its stamp", () => {
    const contested = { createdate: "2026-09-18T06:26:26Z" };   // deal 349204144871's real createdate
    for (const stamp of [undefined, "wm", "crm", "hold"]) {
      const props = stamp ? { ...contested, sync_owner: stamp } : contested;
      const wm = authorizeWrite(rec(props), wmSpec().ownership!).allowed;
      const crm = authorizeWrite(rec(props), crmSpec().ownership!).allowed;
      expect(wm && crm, `stamp=${stamp} lets both write`).toBe(false);
    }
  });

  it("and the WM Deals spec keeps its own board and pipeline scope", () => {
    expect(DEALS.boardId).toBe("5029480547");
    expect(DEALS.searchFilters).toEqual([{ propertyName: "pipeline", operator: "EQ", value: "default" }]);
    expect(CRM_DEALS.boardId).toBe("5028000494");
  });
});
