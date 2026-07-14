import { describe, it, expect } from "vitest";
import { lineTotal, lineItemsTotal } from "./totals";
describe("line totals", () => {
  it("lineTotal = quantity × (unitPrice − discount)", () =>
    expect(lineTotal({ quantity: "2", unitPrice: "100", discount: "10" })).toBe(180));
  it("blanks default to 0; never negative", () => {
    expect(lineTotal({ quantity: "3", unitPrice: "50" })).toBe(150);
    expect(lineTotal({ quantity: "1", unitPrice: "5", discount: "999" })).toBe(0);
  });
  it("lineItemsTotal sums", () =>
    expect(lineItemsTotal([{ quantity: "2", unitPrice: "100" }, { quantity: "1", unitPrice: "50" }])).toBe(250));
});
