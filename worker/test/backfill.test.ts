import { describe, it, expect } from "vitest";
import { phoneBackfillCandidates } from "../src/backfill";

const card = (itemId: string, hubspotId: string, phone: string) => ({ itemId, hubspotId, phone });

describe("phoneBackfillCandidates (historical contact migration)", () => {
  it("picks a card with a phone whose HubSpot record has none", () =>
    expect(phoneBackfillCandidates([card("i1", "h1", "+1 234-567-8900")], { h1: "" }))
      .toEqual([card("i1", "h1", "+1 234-567-8900")]));

  it("never overwrites a HubSpot phone that already exists", () =>
    expect(phoneBackfillCandidates([card("i1", "h1", "+1 234")], { h1: "+44 20 7946 0000" })).toEqual([]));

  it("treats a differently-formatted existing number as present (digit compare, not missing)", () =>
    expect(phoneBackfillCandidates([card("i1", "h1", "+1 (234) 567-8900")], { h1: "12345678900" })).toEqual([]));

  it("skips a card with no monday phone (an empty monday value never writes)", () => {
    expect(phoneBackfillCandidates([card("i1", "h1", "")], { h1: "" })).toEqual([]);
    expect(phoneBackfillCandidates([card("i1", "h1", "   ")], { h1: "" })).toEqual([]);
  });

  it("skips a card with no HubSpot id (never matched by name)", () =>
    expect(phoneBackfillCandidates([card("i1", "", "+1 234")], { h1: "" })).toEqual([]));

  it("skips a record that wasn't found in HubSpot (deleted/out of scope)", () =>
    expect(phoneBackfillCandidates([card("i1", "h1", "+1 234")], {})).toEqual([]));

  it("selects only the qualifying cards from a mixed batch", () =>
    expect(phoneBackfillCandidates(
      [card("i1", "h1", "+1 111"), card("i2", "h2", "+1 222"), card("i3", "h3", ""), card("i4", "h4", "+1 444")],
      { h1: "", h2: "+1 999", h3: "", h4: null },
    ).map(c => c.itemId)).toEqual(["i1", "i4"]));
});
