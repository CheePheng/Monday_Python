import { describe, it, expect } from "vitest";
import { LONG_TEXT_MAX, clampLongText, formatValue, expectedText } from "../src/mapping";
import { buildReversePatch, fieldDiffs } from "../src/reconcile";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, FieldSpec, HsRecord, MondayItem } from "../src/types";

/**
 * monday's long-text column holds EXACTLY 2000 characters, measured on this account rather than assumed:
 *
 *   1990 -> stored 1990 (exact)      2001 -> ACCEPTED, stored 2000
 *   2000 -> stored 2000 (exact)      2500 -> ACCEPTED, stored 2000
 *                                    5000 -> ACCEPTED, stored 2000
 *
 * So an over-length value does NOT fail the write, which is what the review believed. It does something
 * quieter and worse: monday truncates, expectedText predicts the untruncated string, colText reads back
 * the truncated one, the diff never clears, and the card is rewritten on EVERY subsequent webhook —
 * forever, with no error line to notice.
 *
 * `concrete_demand` (Requirement-具体需求) is the live exposure: unbounded free text submitted through
 * the public dkmeco.com web form, capped by nothing on either side.
 */

const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {},
  ownerIdByEmail: {}, portalId: "1" } as unknown as Ctx;

const LT: FieldSpec = { hs: "concrete_demand", col: "long_text_mm70scva", type: "long_text" };

/** ctx with the 优先级 dictionary, for the "refusal does not starve the card" test at the bottom. */
const priCtx = { ...ctx, labels: { contactPriority: { "P1_2小时内": "P1_2小时内", "P2_1周内": "P2_1周内" } } } as unknown as Ctx;

describe("the clamp matches monday's measured 2000-character limit", () => {
  it("is exactly 2000 — the number monday actually stores", () =>
    expect(LONG_TEXT_MAX).toBe(2000));

  it("leaves anything at or under the limit untouched", () => {
    for (const n of [0, 1, 100, 1990, 1999, 2000]) {
      const s = "x".repeat(n);
      expect(clampLongText(s)).toBe(s);
      expect(clampLongText(s).length).toBe(n);
    }
  });

  it("truncates over-length input to exactly 2000", () => {
    for (const n of [2001, 2500, 5000, 100_000])
      expect(clampLongText("x".repeat(n)).length).toBe(2000);
  });

  // Deliberately NO ellipsis. Appending "..." would make our stored value differ from what monday
  // stores whenever any other path writes the raw string, reintroducing the permanent diff from the
  // other side. Predicting monday's own truncation byte-for-byte is the whole point.
  it("appends no ellipsis — it must predict monday's own truncation exactly", () => {
    const out = clampLongText("y".repeat(2500));
    expect(out).toBe("y".repeat(2000));
    expect(out.endsWith("...")).toBe(false);
    expect(out.endsWith("…")).toBe(false);
  });
});

describe("formatValue and expectedText agree, so the diff can clear", () => {
  // THE REGRESSION THAT MATTERS. If these two ever disagree on an over-length value, fieldDiffs raises a
  // diff that no write can satisfy and the card is rewritten on every webhook for the rest of time.
  it.each([0, 1, 1999, 2000, 2001, 2500, 9999])(
    "a %i-character value round-trips to an identical string on both sides", (n) => {
      const v = "z".repeat(n);
      const written = formatValue(LT, v, ctx) as { text: string } | null;
      const predicted = expectedText(LT, v, ctx);
      if (n === 0) { expect(written).toBeNull(); expect(predicted).toBe(""); return; }
      expect(written!.text).toBe(predicted);
      expect(written!.text.length).toBeLessThanOrEqual(2000);
    });

  it("holds for multi-byte text too — the field is Chinese free text in practice", () => {
    const v = "需".repeat(2400);
    const written = formatValue(LT, v, ctx) as { text: string };
    expect(written.text).toBe(expectedText(LT, v, ctx));
    // JS string length is UTF-16 code units, which is what monday counts; assert we clamp on the same
    // unit rather than on bytes, or a Chinese value would be cut at a third of the real allowance.
    expect(written.text.length).toBe(2000);
  });

  it("does not change behaviour for the other string types", () => {
    const text: FieldSpec = { hs: "x", col: "c", type: "text" };
    const long = "q".repeat(2500);
    // `text` is NOT clamped here: monday's short-text column has its own limit and no mapping sends it
    // anything of this size. Pinning it documents that the clamp is scoped to long_text on purpose.
    expect(formatValue(text, long, ctx)).toBe(long);
    expect(expectedText(text, long, ctx)).toBe(long);
  });
});

describe("which live mappings this protects", () => {
  const longTextFields = [...CRM_CONTACTS.fields, ...CRM_ACCOUNTS.fields].filter(f => f.type === "long_text");

  it("covers every long_text mapping on both boards", () => {
    expect(longTextFields.map(f => f.hs).sort())
      .toEqual(["concrete_demand", "description", "registration_page__c"]);
  });

  // THIS PREMISE EXPIRED ON 2026-09-09. It used to read "none of them is a plain two-way text field
  // that could push a truncated value back", and that was true only because `concrete_demand` and
  // `registration_page__c` were forward-only. The reverse batch made them two-way, which created the
  // exact hazard the old assertion was watching for: monday shows the first 2000 characters of a
  // longer HubSpot value, so a rep who edits that cell is editing a PARTIAL VIEW, and a naive reverse
  // write would replace the full HubSpot text with their 2000-character version — silently deleting
  // prose they were never shown. The guard is `viewTruncated`, asserted below.
  it("two of the three are now two-way, which is why the viewTruncated guard exists", () => {
    const twoWay = longTextFields.filter(f => f.reverse).map(f => f.hs).sort();
    expect(twoWay).toEqual(["concrete_demand", "description", "registration_page__c"]);
  });
});

describe("a two-way long_text refuses the reverse write when monday holds only a partial view", () => {
  const cd = CRM_CONTACTS.fields.find(f => f.hs === "concrete_demand")!;

  const rec = (v: string): HsRecord =>
    ({ id: "301", properties: { firstname: "Jane", lastname: "Smith", concrete_demand: v } }) as unknown as HsRecord;
  const card = (v: string): MondayItem => ({
    id: "CARD1", name: "Jane Smith", group: { id: "topics" },
    column_values: [
      { id: CRM_CONTACTS.idCol, text: "301", value: null },
      { id: cd.col, text: v, value: null },
    ],
  } as unknown as MondayItem);

  // The rep's edit is REALISTIC: they opened a cell holding monday's 2000-character view of a longer
  // HubSpot value and appended a sentence. Their text is genuinely new, and it is still refused —
  // because accepting it would drop everything past character 2000 that they never saw.
  it("refuses, and the card reconciles forward instead", () => {
    const full = "a".repeat(2500);
    const repEdit = "a".repeat(2000) + " plus my note";
    const diffs = fieldDiffs(rec(full), card(repEdit), CRM_CONTACTS, ctx);
    const d = diffs.find(x => x.f?.hs === "concrete_demand")!;
    expect(d.viewTruncated).toBe(true);
    expect(buildReversePatch(diffs, card(repEdit), CRM_CONTACTS, ctx)).toEqual({});
  });

  // The guard is scoped to the ACTUAL hazard, not to the type. A HubSpot value that fits in monday is
  // fully visible on the card, so the rep is authoritative and the edit must go through — otherwise
  // "Requirement" would be dead in monday for every normal-length record, which is the common case.
  it("allows the write when the whole HubSpot value fits in monday", () => {
    const item = card("需要 40 个席位，预算已批");
    const diffs = fieldDiffs(rec("需要 20 个席位"), item, CRM_CONTACTS, ctx);
    expect(diffs.find(x => x.f?.hs === "concrete_demand")!.viewTruncated).toBeUndefined();
    expect(buildReversePatch(diffs, item, CRM_CONTACTS, ctx))
      .toEqual({ concrete_demand: "需要 40 个席位，预算已批" });
  });

  // Boundary: exactly 2000 is stored EXACTLY by monday (measured above), so the card is complete and
  // the write is allowed. 2001 is the first length monday cannot hold.
  it("draws the line at 2001, not 2000", () => {
    const at = card("b".repeat(1500));
    expect(fieldDiffs(rec("a".repeat(2000)), at, CRM_CONTACTS, ctx)
      .find(x => x.f?.hs === "concrete_demand")!.viewTruncated).toBeUndefined();
    expect(fieldDiffs(rec("a".repeat(2001)), at, CRM_CONTACTS, ctx)
      .find(x => x.f?.hs === "concrete_demand")!.viewTruncated).toBe(true);
  });

  // The refusal must not starve the OTHER fields on the same card. An earlier version of this code
  // returned early on a refused reverse write, which froze every forward-only field on that card
  // indefinitely; here the truncated long_text is skipped while a normal edit on the same card still
  // reaches HubSpot in the same patch.
  it("skips only the truncated field, leaving the rest of the patch intact", () => {
    const pri = CRM_CONTACTS.fields.find(f => f.hs === "priority__c")!;
    const item = {
      id: "CARD1", name: "Jane Smith", group: { id: "topics" },
      column_values: [
        { id: CRM_CONTACTS.idCol, text: "301", value: null },
        { id: cd.col, text: "a".repeat(2000) + " edited", value: null },
        { id: pri.col, text: "P2_1周内", value: null },
      ],
    } as unknown as MondayItem;
    const r = {
      id: "301",
      properties: { firstname: "Jane", lastname: "Smith",
        concrete_demand: "a".repeat(2500), priority__c: "P1_2小时内" },
    } as unknown as HsRecord;
    const patch = buildReversePatch(fieldDiffs(r, item, CRM_CONTACTS, priCtx), item, CRM_CONTACTS, priCtx);
    expect(patch).toEqual({ priority__c: "P2_1周内" });
  });
});
