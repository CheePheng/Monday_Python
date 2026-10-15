import { describe, it, expect } from "vitest";
import { readCode } from "../scripts/read-source.mjs";
import { authorizeWrite } from "../src/ownership";
import { DEALS } from "../src/config";
import { CRM_LINE_ITEMS } from "../src/config/crm";
import type { HsRecord } from "../src/types";

/**
 * NO PRODUCTION ROUTE MAY MUTATE HUBSPOT OUTSIDE THE OWNERSHIP MODEL.
 *
 * The Worker-to-Worker simulation was clean while three app routes were still exempt. `/app/line-item`
 * and `/app/association` call the HubSpot mutators directly, and the line-item mutators took no spec at
 * all — so a rep with the Deal Cockpit open could PATCH, DELETE or unlink a record belonging to the
 * other deployment, and every sync-path proof would still have passed.
 *
 * Two kinds of assertion here, deliberately. The behavioural ones prove the rule; the SOURCE ones prove
 * there is no fourth call site quietly added later, which is the failure that actually recurs.
 */

// readCode, not readSource: comments are stripped, so these assertions target EXECUTABLE code. A rule
// that matched prose would fire on the very comments explaining why the rule exists.
const SRC = (f: string): string => readCode(f);

// ---------------------------------------------------------------- no unguarded call site survives

describe("every HubSpot mutator call site passes an ownership spec", () => {
  /**
   * patchRecord and createRecord were MISSING from this list, and that omission is the whole reason
   * 1,955 green tests let three broken routes through.
   *
   * The list was written when only the line-item and association mutators asserted ownership, and it
   * was never revisited once every WM spec gained `ownership` -- at which point patchRecord and
   * createRecord began asserting too. /app/clear-deal-fields, /app/clear-record-fields and
   * /app/backfill-contact-phones then threw OwnershipError on every call, and the one test whose job
   * was to notice could not see them. A guard list that does not name every guarded mutator is not a
   * guard list; it is a subset that reads like one.
   */
  const MUTATORS = ["patchLineItem", "createLineItem", "deleteLineItem", "putAssociation",
                    "deleteAssociation", "patchRecord", "createRecord"];

  it.each(MUTATORS)("%s is never called with a bare opts argument in index.ts", (fn) => {
    // A call ending in `appWriteOpts(env))` passes no spec/auth — exactly the bypass that existed.
    const bare = new RegExp(`${fn}\\([^;]*appWriteOpts\\(env\\)\\s*\\)`, "s");
    expect(bare.test(SRC("index.ts")), `${fn} has an unguarded call in index.ts`).toBe(false);
  });

  it.each(["patchLineItem", "createLineItem"])("%s is never called with a bare opts in associations.ts", (fn) => {
    const bare = new RegExp(`${fn}\\([^;]*,\\s*opts\\s*\\)`, "s");
    expect(bare.test(SRC("associations.ts")), `${fn} has an unguarded call in associations.ts`).toBe(false);
  });

  /** The guard must run BEFORE the dry-run branch, or a refusal is indistinguishable from a skip. */
  it.each(["patchLineItem", "deleteLineItem", "createLineItem"])(
    "%s asserts ownership before checking dryRun", (fn) => {
      const body = SRC("hubspot.ts").split(`export async function ${fn}(`)[1] ?? "";
      const guard = body.indexOf("assertMayWriteLineItem");
      const dry = body.indexOf("opts.dryRun");
      expect(guard, `${fn} has no ownership guard`).toBeGreaterThan(-1);
      expect(guard, `${fn} checks dryRun before ownership`).toBeLessThan(dry);
    });

  it("deleteAssociation gained the guard putAssociation already had", () => {
    const body = SRC("hubspot.ts").split("export async function deleteAssociation(")[1] ?? "";
    expect(body).toContain("assertMayWrite(fromSpec, fromId, auth)");
  });

  it("/app/line-item resolves an auth before mutating", () => {
    const s = SRC("index.ts");
    expect(s).toContain("lineItemWriteAuth(env, p.lineItemId!)");
    expect(s).toMatch(/error: "not-owned"/);
  });

  it("/app/association resolves an auth on the INITIATING record before mutating", () => {
    const s = SRC("index.ts");
    expect(s).toContain("specByObject(env, a.fromObject!)");
    expect(s).toContain("authorizeWrite(fromRec, aSpec.ownership)");
  });

  it("app-created line items are BORN owned, never unstamped", () => {
    for (const f of ["index.ts", "associations.ts"]) {
      const s = SRC(f);
      if (!s.includes("createLineItem(")) continue;
      expect(s, `${f} creates a line item without birth ownership`).toContain("withBirthOwnership(props");
    }
  });
});

// ---------------------------------------------------------------- the rule the routes now enforce

describe("what the Deal Cockpit may and may not touch", () => {
  const CUT = Date.parse("2026-09-10T00:00:00Z");
  const wmOwn = { prop: "sync_owner" as const, createdProp: "createdate", owner: "wm" as const, cutoverAtMs: CUT };
  const crmOwn = { ...wmOwn, owner: "crm" as const };
  const li = (props: Record<string, string>): HsRecord => ({ id: "LI1", properties: props });
  const OLD = { createdate: "2026-09-01T00:00:00Z" };

  it("the app on WM cannot PATCH or DELETE a crm-owned line item", () => {
    const a = authorizeWrite(li({ ...OLD, sync_owner: "crm" }), wmOwn);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("owned by crm");
  });

  it("the app on CRM cannot PATCH or DELETE a wm-owned line item", () =>
    expect(authorizeWrite(li({ ...OLD, sync_owner: "wm" }), crmOwn).allowed).toBe(false));

  it("each may touch its own", () => {
    expect(authorizeWrite(li({ ...OLD, sync_owner: "wm" }), wmOwn).allowed).toBe(true);
    expect(authorizeWrite(li({ ...OLD, sync_owner: "crm" }), crmOwn).allowed).toBe(true);
  });

  it("hold refuses BOTH", () => {
    expect(authorizeWrite(li({ ...OLD, sync_owner: "hold" }), wmOwn).allowed).toBe(false);
    expect(authorizeWrite(li({ ...OLD, sync_owner: "hold" }), crmOwn).allowed).toBe(false);
  });

  /** An unreadable line item must yield a REFUSING auth rather than no auth: a missing auth would make
   *  assertMayWriteLineItem throw a 502-shaped error, where a clean 409 is the honest answer. Asserted
   *  on the source, because constructing the object here would prove only that I can type it. */
  it("an unreadable line item produces a refusing auth, not an absent one", () => {
    const body = readCode("write-auth.ts").split("export async function lineItemWriteAuth(")[1] ?? "";
    expect(body).toContain("line item not readable");
    expect(body).toMatch(/allowed:\s*false/);
  });
});

describe("which spec governs a line-item write", () => {
  it("CRM uses its real line_items spec; WM falls back to deals", () => {
    expect(CRM_LINE_ITEMS.object).toBe("line_items");
    expect(CRM_LINE_ITEMS.ownership?.owner).toBe("crm");
    // WM has no line_items ObjectSpec — line items live as subitems of DEALS, whose ownership governs.
    expect(DEALS.ownership?.owner).toBe("wm");
    expect(DEALS.associations?.some(a => a.toObject === "line_items" && a.subitems)).toBe(true);
  });

  it("both resolve the same property contract, differing only in owner", () => {
    expect(CRM_LINE_ITEMS.ownership?.prop).toBe(DEALS.ownership?.prop);
    expect(CRM_LINE_ITEMS.ownership?.createdProp).toBe(DEALS.ownership?.createdProp);
    expect(CRM_LINE_ITEMS.ownership?.owner).not.toBe(DEALS.ownership?.owner);
  });
});
