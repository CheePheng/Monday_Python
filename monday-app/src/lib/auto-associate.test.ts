import { describe, it, expect } from "vitest";
import { mergeAssociatedCompanies } from "./auto-associate";
import type { Assoc } from "./assoc";

const co = (hubspotId: string, label: string): Assoc => ({ hubspotId, label });

describe("mergeAssociatedCompanies", () => {
  it("appends a new associated company", () =>
    expect(mergeAssociatedCompanies([], [{ hubspotId: "1", name: "Acme" }]))
      .toEqual([{ hubspotId: "1", label: "Acme" }]));
  it("dedupes one already staged (by hubspotId)", () =>
    expect(mergeAssociatedCompanies([co("1", "Acme")], [{ hubspotId: "1", name: "Acme" }]))
      .toEqual([co("1", "Acme")]));
  it("adds only the new ones from a mixed batch", () =>
    expect(mergeAssociatedCompanies([co("1", "Acme")], [{ hubspotId: "1", name: "Acme" }, { hubspotId: "2", name: "Beta" }]))
      .toEqual([co("1", "Acme"), { hubspotId: "2", label: "Beta" }]));
  it("empty fetch is a no-op (same array back)", () => {
    const cur = [co("1", "Acme")];
    expect(mergeAssociatedCompanies(cur, [])).toBe(cur);
  });
  it("falls back to the id when a name is missing", () =>
    expect(mergeAssociatedCompanies([], [{ hubspotId: "9", name: "" }]))
      .toEqual([{ hubspotId: "9", label: "9" }]));
});
