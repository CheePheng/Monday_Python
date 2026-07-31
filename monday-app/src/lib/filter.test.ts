import { describe, it, expect } from "vitest";
import { filterDeals, type DealRow } from "./filter";

const ROWS: DealRow[] = [
  { id: "1", name: "Acme Renewal", stage: "Contract Sent", salesUserIds: ["111"] },
  { id: "2", name: "Beta Expansion", stage: "Closed Won", salesUserIds: ["222"] },
  { id: "3", name: "Acme Upsell", stage: "Contract Sent", salesUserIds: ["111", "333"] },
];

describe("filterDeals", () => {
  it("no filters -> all rows", () =>
    expect(filterDeals(ROWS, {}).map(r => r.id)).toEqual(["1", "2", "3"]));
  it("text query matches name (case-insensitive)", () =>
    expect(filterDeals(ROWS, { q: "acme" }).map(r => r.id)).toEqual(["1", "3"]));
  it("stage filter", () =>
    expect(filterDeals(ROWS, { stage: "Closed Won" }).map(r => r.id)).toEqual(["2"]));
  it("mine filter uses myUserId membership", () =>
    expect(filterDeals(ROWS, { mine: true, myUserId: "111" }).map(r => r.id)).toEqual(["1", "3"]));
  it("filters combine (AND)", () =>
    expect(filterDeals(ROWS, { q: "acme", mine: true, myUserId: "333" }).map(r => r.id)).toEqual(["3"]));
  it("search also matches company and contact", () => {
    const rs: DealRow[] = [
      { id: "1", name: "Deal one", stage: "s", salesUserIds: [], company: "Acme Corp" },
      { id: "2", name: "Deal two", stage: "s", salesUserIds: [], contact: "Jane Acme" },
      { id: "3", name: "Deal three", stage: "s", salesUserIds: [], company: "Beta" },
    ];
    expect(filterDeals(rs, { q: "acme" }).map(r => r.id)).toEqual(["1", "2"]);
  });
  it("salesUserId filters to deals that include that user", () =>
    expect(filterDeals(ROWS, { salesUserId: "333" }).map(r => r.id)).toEqual(["3"]));
  it("salesUserId combines with other filters (AND)", () =>
    expect(filterDeals(ROWS, { salesUserId: "111", stage: "Contract Sent" }).map(r => r.id)).toEqual(["1", "3"]));
});

const row = (id: string, createdAt?: string): DealRow =>
  ({ id, name: "D" + id, stage: "New", salesUserIds: [], createdAt });

describe("filterDeals createdRange", () => {
  const rows = [row("1", "2026-07-10T00:00:00Z"), row("2", "2026-07-20T00:00:00Z"), row("3", undefined)];
  const ms = (s: string) => Date.parse(s);
  it("keeps rows whose createdAt is within [gte,lte]", () => {
    const out = filterDeals(rows, { createdRange: { gte: ms("2026-07-15T00:00:00Z"), lte: ms("2026-07-25T00:00:00Z") } });
    expect(out.map(r => r.id)).toEqual(["2"]);
  });
  it("gte-only / lte-only are open-ended on the missing side", () => {
    expect(filterDeals(rows, { createdRange: { gte: ms("2026-07-15T00:00:00Z") } }).map(r => r.id)).toEqual(["2"]);
    expect(filterDeals(rows, { createdRange: { lte: ms("2026-07-15T00:00:00Z") } }).map(r => r.id)).toEqual(["1"]);
  });
  it("excludes rows with missing/invalid createdAt when a range is active", () =>
    expect(filterDeals(rows, { createdRange: { gte: 0 } }).map(r => r.id)).toEqual(["1", "2"]));
  it("no createdRange leaves rows untouched (all 3)", () =>
    expect(filterDeals(rows, {}).length).toBe(3));
  it("composes with other filters (AND)", () =>
    expect(filterDeals(rows, { q: "D2", createdRange: { gte: ms("2026-07-15T00:00:00Z") } }).map(r => r.id)).toEqual(["2"]));
});
