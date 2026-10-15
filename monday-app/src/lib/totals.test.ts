import { describe, it, expect } from "vitest";
import { lineTotal, lineItemsTotal } from "./totals";
describe("line totals", () => {
  it("amount discount: qty × (unitPrice − discount)", () =>
    expect(lineTotal({ quantity: "2", unitPrice: "100", discount: "10" })).toBe(180));
  it("percent discount: qty × unitPrice × (1 − pct/100)", () =>
    expect(lineTotal({ quantity: "2", unitPrice: "100", discountMode: "percent", discountPct: "5" })).toBe(190));
  it("percent ignores the amount field", () =>
    expect(lineTotal({ quantity: "1", unitPrice: "100", discount: "40", discountMode: "percent", discountPct: "10" })).toBe(90));
  it("blanks default to 0; never negative", () => {
    expect(lineTotal({ quantity: "3", unitPrice: "50" })).toBe(150);
    expect(lineTotal({ quantity: "1", unitPrice: "5", discount: "999" })).toBe(0);
    expect(lineTotal({ quantity: "1", unitPrice: "100", discountMode: "percent", discountPct: "150" })).toBe(0);
  });
  it("lineItemsTotal sums mixed modes", () =>
    expect(lineItemsTotal([
      { quantity: "2", unitPrice: "100" },
      { quantity: "2", unitPrice: "100", discountMode: "percent", discountPct: "50" },
    ])).toBe(300));
});
