import { describe, it, expect } from "vitest";
import { mergeLineItems } from "./line-item-merge";
import type { LineItem } from "../views/LineItemsEditor";

const row = (o: Partial<LineItem>): LineItem => ({ name: "", unitPrice: "0", quantity: "1", ...o });

describe("mergeLineItems (by HubSpot Line Item ID only)", () => {
  it("updates a matching row's fields but keeps its monday subitemId", () => {
    const cur = [row({ subitemId: "s1", lineItemId: "L1", name: "old", unitPrice: "5" })];
    const fresh = [row({ lineItemId: "L1", name: "new", unitPrice: "9" })];
    const out = mergeLineItems(cur, fresh);
    expect(out).toEqual([{ ...fresh[0], subitemId: "s1" }]);
  });
  it("adds a HubSpot line item that has no matching row", () => {
    const out = mergeLineItems([], [row({ lineItemId: "L2", name: "hs-only" })]);
    expect(out.map(r => r.lineItemId)).toEqual(["L2"]);
  });
  it("keeps unsaved rows (no lineItemId) and drops rows removed in HubSpot", () => {
    const cur = [row({ subitemId: "s3", lineItemId: "L3", name: "gone" }), row({ name: "pending" })];
    const out = mergeLineItems(cur, []);
    expect(out.map(r => r.name)).toEqual(["pending"]);
  });
  it("never matches by name", () => {
    const cur = [row({ subitemId: "s4", lineItemId: "L4", name: "Widget" })];
    const fresh = [row({ lineItemId: "L9", name: "Widget" })];
    const out = mergeLineItems(cur, fresh);
    expect(out).toEqual([{ ...fresh[0] }]);
  });
});
