import { describe, it, expect } from "vitest";
import { dateCell, expectedText, formatValue } from "../src/mapping";
import { reverseFieldValue } from "../src/reconcile";
import { CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS } from "../src/config/crm";
import { ALL_SPECS } from "../src/config";
import type { Ctx, FieldSpec } from "../src/types";

/**
 * A DATE COLUMN SHOWS A DAY, AND THE DAY DEPENDS ON WHERE YOU STAND.
 *
 * HubSpot returns an instant in UTC. The engine took `slice(0, 10)` of it, which is the correct day only
 * for a viewer in UTC. This portal is Asia/Shanghai (+08:00, no DST), so everything from 16:00Z onward
 * belongs to the NEXT local day — and 488 of 1,399 populated `notes_last_updated` values are exactly
 * 16:00:00.000Z, which is local midnight: the single worst input for an off-by-one.
 *
 * These tests are mostly about the boundary and about the two halves staying in lockstep.
 */

const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, portalId: 1 } as unknown as Ctx;

const plain: FieldSpec = { hs: "x", col: "c", type: "date" };
const local: FieldSpec = { hs: "x", col: "c", type: "date", localDate: true };

describe("the local midnight boundary", () => {
  it("15:59:59Z is still the same day in Shanghai", () => {
    expect(dateCell(local, "2026-09-17T15:59:59.999Z")).toBe("2026-09-17");
  });

  it("16:00:00Z is ALREADY the next day in Shanghai — the case that broke 488 values", () => {
    expect(dateCell(local, "2026-09-17T16:00:00.000Z")).toBe("2026-09-18");
  });

  it("23:59Z is the next day", () => {
    expect(dateCell(local, "2026-09-17T23:59:00Z")).toBe("2026-09-18");
  });

  it("00:00Z is unchanged — a positive offset cannot move midnight UTC backwards", () => {
    expect(dateCell(local, "2026-09-17T00:00:00Z")).toBe("2026-09-17");
  });

  it("crosses a month boundary", () => {
    expect(dateCell(local, "2026-09-30T16:00:00Z")).toBe("2026-10-01");
  });

  it("crosses a year boundary", () => {
    expect(dateCell(local, "2026-12-31T16:00:00Z")).toBe("2027-01-01");
  });

  it("crosses a leap day", () => {
    expect(dateCell(local, "2028-02-28T16:00:00Z")).toBe("2028-02-29");
  });

  it("the live example from deal 14054129559 — Nov 9 16:00Z is Nov 10 locally", () => {
    expect(dateCell(plain, "2023-11-09T16:00:00Z")).toBe("2023-11-09");   // what the board shows today
    expect(dateCell(local, "2023-11-09T16:00:00Z")).toBe("2023-11-10");   // what the rep actually picked
  });
});

describe("a date-only property must not be disturbed", () => {
  /** HubSpot `date` properties (service_date, registration_date) arrive as midnight UTC or a bare day.
   *  A +8h shift cannot move either off its own day, so flagged or not the answer is identical. */
  it("a bare YYYY-MM-DD is unchanged either way", () => {
    expect(dateCell(plain, "2025-06-27")).toBe("2025-06-27");
    expect(dateCell(local, "2025-06-27")).toBe("2025-06-27");
  });

  it("midnight UTC is unchanged either way", () => {
    expect(dateCell(plain, "2025-06-27T00:00:00Z")).toBe("2025-06-27");
    expect(dateCell(local, "2025-06-27T00:00:00Z")).toBe("2025-06-27");
  });
});

describe("unflagged fields keep the old behaviour exactly", () => {
  it.each([
    "2026-09-17T16:00:00.000Z", "2026-09-17T23:59:59Z", "2026-09-17T00:00:00Z", "2026-09-17",
  ])("%s slices, it does not shift", (v) => {
    expect(dateCell(plain, v)).toBe(v.slice(0, 10));
  });
});

describe("malformed input degrades, it does not explode", () => {
  it.each(["not-a-date", "", "2026-13-45T99:99:99Z"])("%j falls back to the old slice", (v) => {
    expect(() => dateCell(local, v)).not.toThrow();
    expect(dateCell(local, v)).toBe(v.slice(0, 10));
  });

  it("never yields the string 'Invalid Date' into a live cell", () => {
    for (const v of ["nonsense", "2026-99-99"]) expect(dateCell(local, v)).not.toContain("Invalid");
  });
});

describe("the forward write and the diff prediction must agree", () => {
  /** If they ever disagreed, every dated card would be rewritten on every pass, forever — the churn
   *  trap FieldSpec.scale already documents. */
  it.each([
    "2026-09-17T16:00:00.000Z", "2026-09-17T15:59:59Z", "2026-12-31T16:00:00Z", "2026-09-17",
  ])("formatValue and expectedText produce the same day for %s", (v) => {
    expect((formatValue(local, v, ctx) as { date: string }).date).toBe(expectedText(local, v, ctx));
    expect((formatValue(plain, v, ctx) as { date: string }).date).toBe(expectedText(plain, v, ctx));
  });

  it("an empty value is still empty on both halves", () => {
    expect(formatValue(local, "", ctx)).toBeNull();
    expect(expectedText(local, "", ctx)).toBe("");
  });
});

describe("which fields carry the flag, and which deliberately do not", () => {
  const dateFields = (s: { fields: FieldSpec[] }) => s.fields.filter(f => f.type === "date");

  /**
   * The original fear: a reverse write pushing a STALE (day-early) cell into HubSpot. True under the old
   * record-level engine, which pushed every differing column. Under column-level reverse (2026-09-23) a
   * column reaches HubSpot only when a PERSON edits that very column -- and then they are choosing the
   * date. So a flagged reversible field is safe exactly when its spec is column-level.
   */
  it("every flagged date field is oneWay, or reversible only through column-level reverse", () => {
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS])
      for (const f of dateFields(spec))
        if (f.localDate && !f.oneWay)
          expect(spec.columnLevelReverse, `${spec.object}.${f.hs} is flagged + reversible on a record-level spec`).toBe(true);
  });

  it("every HubSpot `datetime` property we map one-way IS flagged", () => {
    // Verified live against the portal: these four are type=datetime. registration_date, service_date
    // and hs_recurring_billing_start_date are type=date and are correctly absent.
    const instants = ["notes_last_updated", "createdate", "hubspot_owner_assigneddate"];
    for (const spec of [CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS])
      for (const f of dateFields(spec))
        if (instants.includes(f.hs) && f.oneWay)
          expect(f.localDate, `${spec.object}.${f.hs} is an instant but unflagged`).toBe(true);
  });

  /**
   * closedate IS flagged since 2026-09-23. It is a datetime: a date picked in HubSpot's UI is stored as
   * local midnight (16:00Z the day before), and 7,094 of 8,632 deals showed the day BEFORE on monday.
   * The "own migration" the old test asked for is the forward refresh (/resync forceForward) of the
   * cells written day-early; new writes are right from the deploy on.
   */
  it("closedate is flagged, and its round trip is stable in both directions", () => {
    const closedate = CRM_DEALS.fields.find(f => f.hs === "closedate")!;
    expect(closedate.reverse).toBe(true);
    expect(closedate.localDate).toBe(true);
    // A date picked in HubSpot (local midnight) shows as that day ...
    expect(expectedText(closedate, "2023-06-29T16:00:00Z", ctx)).toBe("2023-06-30");
    // ... a date a rep types on monday goes back as a plain date, stored at 00:00Z ...
    expect(reverseFieldValue(closedate, "2026-10-02", ctx)).toBe("2026-10-02");
    // ... and reads back as the same day, so no diff and no rewrite loop.
    expect(expectedText(closedate, "2026-10-02T00:00:00.000Z", ctx)).toBe("2026-10-02");
    expect(expectedText(closedate, "2026-10-02", ctx)).toBe("2026-10-02");
  });

  it("the date-only line-item properties are deliberately NOT flagged", () => {
    for (const hs of ["service_date", "hs_recurring_billing_start_date"])
      expect(CRM_LINE_ITEMS.fields.find(f => f.hs === hs)?.localDate).toBeUndefined();
  });

  /** mapping.ts is shared with the Worker running Work Management in production. */
  it("NO live Work-Management spec is affected", () => {
    for (const spec of ALL_SPECS)
      for (const f of spec.fields) expect(f.localDate, `${spec.object}.${f.hs}`).toBeUndefined();
  });
});
