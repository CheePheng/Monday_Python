import { describe, it, expect } from "vitest";
import { LINE_ITEM_WRITE_PROPS, PRODUCT_COPY_PROPS, pickWritableLineItemProps } from "../src/line-item-props";

describe("line-item write allowlist", () => {
  it("keeps writable props, drops read-only/calculated and unknown", () =>
    expect(pickWritableLineItemProps({ name: "X", price: "10", amount: "999", hs_margin: "5", bogus: "y" }))
      .toEqual({ name: "X", price: "10" }));
  it("allowlist excludes the calculated fields", () => {
    for (const c of ["amount", "hs_pre_discount_amount", "hs_margin", "hs_post_tax_amount"])
      expect(LINE_ITEM_WRITE_PROPS.has(c)).toBe(false);
  });
  it("core writable + custom fields are allowlisted", () => {
    for (const p of ["name", "price", "quantity", "hs_sku", "brand_isv", "family", "product_subcategory",
      "is_active", "note", "service_date", "recurringbillingfrequency", "hs_recurring_billing_start_date",
      "discount", "hs_discount_percentage", "hs_tax_rate_group_id", "hs_pricing_model",
      "hs_cost_of_goods_sold", "deposit", "hs_product_id", "hs_line_item_currency_code"])
      expect(LINE_ITEM_WRITE_PROPS.has(p)).toBe(true);
  });
  it("PRODUCT_COPY_PROPS excludes hs_product_id and currency (product has no line currency)", () => {
    expect(PRODUCT_COPY_PROPS.has("hs_product_id")).toBe(false);
    expect(PRODUCT_COPY_PROPS.has("name")).toBe(true);
  });
});
