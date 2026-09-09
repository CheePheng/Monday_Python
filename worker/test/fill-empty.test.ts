import { describe, it, expect } from "vitest";
import { buildReversePatch, fieldDiffs } from "../src/reconcile";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import { CONTACTS_MYLA, COMPANIES_MYLA, DEALS } from "../src/config";
import type { Ctx, HsRecord, MondayItem, ObjectSpec } from "../src/types";

/**
 * THE ASYMMETRIC FILL RULE.
 *
 *   monday has a value, HubSpot is blank   -> FILL HubSpot
 *   monday is blank, HubSpot has a value   -> NEVER clear HubSpot
 *
 * The engine's original default was to leave an empty HubSpot value alone in BOTH directions, so the
 * two systems could never fight and no loop could form. That was right while monday was the secondary
 * surface. It is wrong once reps work in monday: a salesperson typing Annual Revenue into a blank field
 * watched it silently revert on the next HubSpot change — observed live on 2026-09-08, when a monday
 * annualrevenue of 2500000.50 simply never propagated because HubSpot's value was empty.
 *
 * The opt-in is PER SPEC, never per object NAME. BACKFILL_OBJECTS and INDEPENDENT_BACKFILL_OBJECTS are
 * sets of "contacts"/"companies", which the LIVE Work-Management specs share — adding "companies" to
 * either would have changed WM behaviour silently. That is the whole reason for the flag.
 */

const ctx = {
  labels: { leadStatus: { NEW: "New", IN_PROGRESS: "In Progress" }, companyType: { PARTNER: "Partner" } },
  ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {}, portalId: "1",
} as unknown as Ctx;

const card = (spec: ObjectSpec, hsId: string, cells: Record<string, string>): MondayItem => ({
  id: "CARD1", name: "Reverse Test Company", group: { id: "topics" },
  column_values: [
    { id: spec.idCol, text: hsId, value: null },
    ...Object.entries(cells).map(([id, text]) => ({ id, text, value: null })),
  ],
} as unknown as MondayItem);

const rec = (props: Record<string, string>): HsRecord =>
  ({ id: "344965792487", properties: { name: "Reverse Test Company", ...props } }) as unknown as HsRecord;

const revenue = CRM_ACCOUNTS.fields.find(f => f.hs === "annualrevenue")!;
const cityF = CRM_ACCOUNTS.fields.find(f => f.hs === "city")!;

describe("both CRM specs opt in; no WM spec does", () => {
  it("CRM Contacts and Accounts fill empty HubSpot values", () => {
    expect(CRM_CONTACTS.fillEmptyFromMonday).toBe(true);
    expect(CRM_ACCOUNTS.fillEmptyFromMonday).toBe(true);
  });

  // THE CRITICAL ASSERTION. These three specs run on the live WM Worker off the same engine.
  it("NO Work-Management spec opts in — their behaviour is unchanged", () => {
    for (const s of [CONTACTS_MYLA, COMPANIES_MYLA, DEALS])
      expect(s.fillEmptyFromMonday).toBeUndefined();
  });
});

describe("monday value + blank HubSpot -> FILL", () => {
  it("raises a backfill diff for annualrevenue, the field that exposed this", () => {
    const d = fieldDiffs(rec({ annualrevenue: "" }),
      card(CRM_ACCOUNTS, "344965792487", { [revenue.col]: "2500000.50" }), CRM_ACCOUNTS, ctx);
    expect(d.filter(x => x.f?.hs === "annualrevenue"))
      .toMatchObject([{ hsText: "", mdText: "2500000.50", backfill: true }]);
  });

  it("and the patch carries the CANONICAL number, not monday's rendering", () => {
    const item = card(CRM_ACCOUNTS, "344965792487", { [revenue.col]: "2500000.50" });
    const d = fieldDiffs(rec({ annualrevenue: "" }), item, CRM_ACCOUNTS, ctx);
    expect(buildReversePatch(d, item, CRM_ACCOUNTS, ctx)).toEqual({ annualrevenue: "2500000.5" });
  });

  it("fills a text field the same way", () => {
    const item = card(CRM_ACCOUNTS, "344965792487", { [cityF.col]: "Johor Bahru" });
    const d = fieldDiffs(rec({ city: "" }), item, CRM_ACCOUNTS, ctx);
    expect(buildReversePatch(d, item, CRM_ACCOUNTS, ctx)).toEqual({ city: "Johor Bahru" });
  });

  // The id-column match is the anti-mismatch guard: a card must prove it represents THIS record before
  // its value is allowed into HubSpot. No name matching, ever.
  it("REFUSES to fill when the card's HubSpot id does not match the record", () => {
    const d = fieldDiffs(rec({ annualrevenue: "" }),
      card(CRM_ACCOUNTS, "999999999", { [revenue.col]: "2500000.50" }), CRM_ACCOUNTS, ctx);
    expect(d.filter(x => x.f?.hs === "annualrevenue")).toEqual([]);
  });

  // A value that cannot survive the reverse mapping must not raise a diff, or it re-diffs every pass
  // forever with nothing to show for it.
  it("REFUSES to fill from a non-numeric monday value", () => {
    const d = fieldDiffs(rec({ annualrevenue: "" }),
      card(CRM_ACCOUNTS, "344965792487", { [revenue.col]: "approx 500" }), CRM_ACCOUNTS, ctx);
    expect(d.filter(x => x.f?.hs === "annualrevenue")).toEqual([]);
  });

  it("REFUSES to fill from an unknown status label", () => {
    const type = CRM_ACCOUNTS.fields.find(f => f.hs === "type")!;
    const d = fieldDiffs(rec({ type: "" }),
      card(CRM_ACCOUNTS, "344965792487", { [type.col]: "Not A Real Type" }), CRM_ACCOUNTS, ctx);
    expect(d.filter(x => x.f?.hs === "type")).toEqual([]);
  });

  // Forward-only fields must NOT be filled from monday, however tempting — HubSpot owns them. The
  // example is deliberately `hs_object_source_label`, a plain TEXT field: text always survives the
  // reverse mapping, so nothing else can be doing the refusing. That isolates the guard to the
  // `reverse` flag itself rather than to a dictionary lookup or a numeric parse further down.
  // (This used to use `timezone`, which went two-way in the 2026-09-09 reverse batch.)
  it("only fills reverse:true fields, never a forward-only one", () => {
    const fwd = CRM_ACCOUNTS.fields.find(f => f.hs === "hs_object_source_label")!;
    expect(fwd.reverse).toBeUndefined();
    expect(fwd.type).toBe("text");
    const d = fieldDiffs(rec({ hs_object_source_label: "" }),
      card(CRM_ACCOUNTS, "344965792487", { [fwd.col]: "CRM_UI" }), CRM_ACCOUNTS, ctx);
    expect(d.filter(x => x.f?.hs === "hs_object_source_label")).toEqual([]);
  });

  // The counterpart, so the test above cannot pass for the wrong reason (e.g. the card id failing to
  // match, or the fill rule being off entirely). Same shape, same object, same TEXT type — the only
  // difference is `reverse: true`, and this one DOES fill.
  it("and the same shape with reverse:true DOES fill, proving the flag is what decides", () => {
    const rev = CRM_ACCOUNTS.fields.find(f => f.hs === "timezone")!;
    expect(rev.reverse).toBe(true);
    expect(rev.type).toBe("text");
    const item = card(CRM_ACCOUNTS, "344965792487", { [rev.col]: "Asia/Kuala_Lumpur" });
    const d = fieldDiffs(rec({ timezone: "" }), item, CRM_ACCOUNTS, ctx);
    expect(d.filter(x => x.f?.hs === "timezone")).toMatchObject([{ backfill: true }]);
    expect(buildReversePatch(d, item, CRM_ACCOUNTS, ctx)).toEqual({ timezone: "Asia/Kuala_Lumpur" });
  });
});

describe("blank monday + HubSpot value -> NEVER clear (unchanged)", () => {
  it("builds no patch entry for a blanked column, so HubSpot keeps its value", () => {
    const item = card(CRM_ACCOUNTS, "344965792487", { [cityF.col]: "" });
    const d = fieldDiffs(rec({ city: "Kuala Lumpur" }), item, CRM_ACCOUNTS, ctx);
    // A diff IS raised (the card is stale and will be refilled forward) ...
    expect(d.some(x => x.f?.hs === "city")).toBe(true);
    // ... but nothing is sent to HubSpot.
    expect(buildReversePatch(d, item, CRM_ACCOUNTS, ctx)).toEqual({});
  });

  it("holds for a number too — a cleared revenue cell does not zero HubSpot", () => {
    const item = card(CRM_ACCOUNTS, "344965792487", { [revenue.col]: "" });
    const d = fieldDiffs(rec({ annualrevenue: "1000000" }), item, CRM_ACCOUNTS, ctx);
    expect(buildReversePatch(d, item, CRM_ACCOUNTS, ctx)).toEqual({});
  });

  it("and for a status — a cleared Type cell does not blank HubSpot's type", () => {
    const type = CRM_ACCOUNTS.fields.find(f => f.hs === "type")!;
    const item = card(CRM_ACCOUNTS, "344965792487", { [type.col]: "" });
    const d = fieldDiffs(rec({ type: "PARTNER" }), item, CRM_ACCOUNTS, ctx);
    expect(buildReversePatch(d, item, CRM_ACCOUNTS, ctx)).toEqual({});
  });
});

describe("the WM engine path is untouched", () => {
  // Same shape as the CRM fill test, against a WM spec: no flag, so no backfill diff unless that
  // field carries its own `backfill: true` and its object is in BACKFILL_OBJECTS.
  it("a WM company with a blank HubSpot value raises NO fill diff", () => {
    const f = COMPANIES_MYLA.fields.find(x => x.hs === "annualrevenue")!;
    expect(f.backfill).toBeUndefined();
    const d = fieldDiffs(rec({ annualrevenue: "" }),
      card(COMPANIES_MYLA, "344965792487", { [f.col]: "2500000" }), COMPANIES_MYLA, ctx);
    expect(d.filter(x => x.f?.hs === "annualrevenue")).toEqual([]);
  });

  // The WM deal backfill allowlist must keep working exactly as before.
  it("a WM deal field carrying backfill:true still fills", () => {
    const f = DEALS.fields.find(x => x.hs === "amount")!;
    expect(f.backfill).toBe(true);
    const d = fieldDiffs({ id: "9001", properties: { amount: "" } } as unknown as HsRecord,
      card(DEALS, "9001", { [f.col]: "5000" }), DEALS, ctx);
    expect(d.filter(x => x.f?.hs === "amount"))
      .toMatchObject([{ hsText: "", mdText: "5000", backfill: true }]);
  });
});
