import { describe, it, expect } from "vitest";
import { sortDeals } from "./sort";
import type { DealRow } from "./filter";

const R = (o: Partial<DealRow>): DealRow => ({ id: "x", name: "", stage: "", salesUserIds: [], ...o });
const rows: DealRow[] = [
  R({ id: "1", name: "Beta", amount: "500", closeDate: "2026-09-01", company: "Zeta" }),
  R({ id: "2", name: "Alpha", amount: "1500", closeDate: "2026-07-01", company: "Acme" }),
  R({ id: "3", name: "Gamma", amount: "", closeDate: "2026-08-01", company: "" }),
];
const ids = (rs: DealRow[]) => rs.map(r => r.id);

describe("sortDeals", () => {
  it("name asc / desc", () => {
    expect(ids(sortDeals(rows, "name", "asc"))).toEqual(["2", "1", "3"]);
    expect(ids(sortDeals(rows, "name", "desc"))).toEqual(["3", "1", "2"]);
  });
  it("amount numeric (blank treated as 0)", () =>
    expect(ids(sortDeals(rows, "amount", "asc"))).toEqual(["3", "1", "2"]));
  it("closeDate ascending (ISO)", () =>
    expect(ids(sortDeals(rows, "closeDate", "asc"))).toEqual(["2", "3", "1"]));
  it("does not mutate input", () => { const c = [...rows]; sortDeals(rows, "name", "asc"); expect(rows).toEqual(c); });
});
