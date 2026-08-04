import { describe, it, expect } from "vitest";
import { buildSubitemReversePatch, subitemFieldByCol, liValueEqual } from "../src/line-item-reverse";

// column ids from LINE_ITEM_SUBITEMS
const PRICE = "numeric_mm53rsfd";
const QTY = "numeric_mm531345";
const AMOUNT = "numeric_mm538yj9";          // forward-only (calc)
const CURRENCY = "text_mm538b8k";           // forward-only (deal-owned)
const SERVICE_DATE = "date_mm53chbv";
const DISCOUNT = "numeric_mm53pkyf";
const DISCOUNT_PCT = "numeric_mm5ax22v";
const DESCRIPTION = "long_text_mm53a511";
const ID_COL = "text_mm53ds6w";             // not a field

describe("subitemFieldByCol / reverse flags", () => {
  it("editable columns are reverse-eligible", () => {
    for (const c of [PRICE, QTY, SERVICE_DATE, DISCOUNT, DISCOUNT_PCT, DESCRIPTION])
      expect(subitemFieldByCol(c)?.reverse).toBe(true);
  });
  it("calc + currency columns are NOT reverse-eligible", () => {
    for (const c of [AMOUNT, CURRENCY, "numeric_mm53txgw" /* pre_discount */])
      expect(subitemFieldByCol(c)?.reverse).toBeFalsy();
  });
  it("unknown / id column maps to no field", () => {
    expect(subitemFieldByCol(ID_COL)).toBeUndefined();
    expect(subitemFieldByCol("bogus")).toBeUndefined();
  });
});

describe("liValueEqual (type-aware)", () => {
  it("numbers compare numerically (90 vs 90.00)", () => expect(liValueEqual("numbers", "90", "90.00")).toBe(true));
  it("numbers differ", () => expect(liValueEqual("numbers", "90", "99")).toBe(false));
  it("dates compare by first 10 chars", () => expect(liValueEqual("date", "2026-08-04", "2026-08-04T00:00:00Z")).toBe(true));
  it("text trimmed compare", () => expect(liValueEqual("text", " x ", "x")).toBe(true));
});

describe("buildSubitemReversePatch", () => {
  it("non-reverse column (amount) -> null", () =>
    expect(buildSubitemReversePatch(AMOUNT, "123", "0")).toBeNull());
  it("currency column -> null", () =>
    expect(buildSubitemReversePatch(CURRENCY, "USD", "CNY")).toBeNull());
  it("unknown column -> null", () =>
    expect(buildSubitemReversePatch(ID_COL, "x", "")).toBeNull());
  it("empty value -> null (omit-empty, never clear from an empty cell)", () =>
    expect(buildSubitemReversePatch(PRICE, "  ", "99")).toBeNull());
  it("price differs from HubSpot -> patch price only", () =>
    expect(buildSubitemReversePatch(PRICE, "90", "99")).toEqual({ price: "90" }));
  it("price equals HubSpot (90 vs 90.00) -> null (echo)", () =>
    expect(buildSubitemReversePatch(PRICE, "90", "90.00")).toBeNull());
  it("quantity edit patches quantity only (no price)", () =>
    expect(buildSubitemReversePatch(QTY, "3", "1")).toEqual({ quantity: "3" }));
  it("unit discount patches discount and clears the % sibling", () =>
    expect(buildSubitemReversePatch(DISCOUNT, "5", "")).toEqual({ discount: "5", hs_discount_percentage: "" }));
  it("discount % patches it and clears the amount sibling", () =>
    expect(buildSubitemReversePatch(DISCOUNT_PCT, "10", "")).toEqual({ hs_discount_percentage: "10", discount: "" }));
  it("service date is sliced to YYYY-MM-DD", () =>
    expect(buildSubitemReversePatch(SERVICE_DATE, "2026-08-04T00:00:00Z", "")).toEqual({ service_date: "2026-08-04" }));
  it("service date equal after slice -> null (echo)", () =>
    expect(buildSubitemReversePatch(SERVICE_DATE, "2026-08-04", "2026-08-04")).toBeNull());
});
