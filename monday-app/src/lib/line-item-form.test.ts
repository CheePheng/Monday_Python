import { describe, it, expect } from "vitest";
import { validateLineItemForm, computeTotals, LI_FIELDS, type LineItemFormValues } from "./line-item-form";

const base: LineItemFormValues = { name: "X", price: "100", quantity: "2", hs_pricing_model: "flat" };

describe("validateLineItemForm", () => {
  it("passes with name + price + pricing model", () => expect(validateLineItemForm(base).ok).toBe(true));
  it("requires name, price, pricing model", () => {
    expect(validateLineItemForm({ ...base, name: "" }).ok).toBe(false);
    expect(validateLineItemForm({ ...base, price: "" }).ok).toBe(false);
    expect(validateLineItemForm({ ...base, hs_pricing_model: "" }).ok).toBe(false);
  });
  it("rejects a non-numeric price/quantity", () =>
    expect(validateLineItemForm({ ...base, price: "abc" }).ok).toBe(false));
});

describe("computeTotals", () => {
  it("subtotal = price*qty; amount-discount reduces net", () =>
    expect(computeTotals({ ...base, discountMode: "amount", discount: "10" }))
      .toMatchObject({ subtotal: 200, net: 180 }));
  it("percent discount", () =>
    expect(computeTotals({ ...base, discountMode: "percent", hs_discount_percentage: "10" }))
      .toMatchObject({ subtotal: 200, net: 180 }));
  it("margin = (price - unit cost) * qty", () =>
    expect(computeTotals({ ...base, hs_cost_of_goods_sold: "60" }).margin).toBe(80));
});

it("LI_FIELDS lists only verified writable props (never a calc prop)", () => {
  const calc = ["amount", "hs_pre_discount_amount", "hs_margin", "hs_post_tax_amount"];
  for (const f of LI_FIELDS) expect(calc).not.toContain(f.prop);
});
