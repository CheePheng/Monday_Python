import { describe, it, expect } from "vitest";
import { LONG_TEXT_MAX, clampLongText, formatValue, expectedText } from "../src/mapping";
import { CRM_CONTACTS, CRM_ACCOUNTS } from "../src/config/crm";
import type { Ctx, FieldSpec } from "../src/types";

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

  // All three are forward-only or HubSpot-authored, so the clamp can never truncate something a rep
  // typed in monday and then push the shortened version back to HubSpot.
  it("none of them is a plain two-way text field that could push a truncated value back", () => {
    for (const f of longTextFields)
      if (f.reverse) expect(f.hs).toBe("description");   // companies.description, HubSpot-authored prose
  });
});
