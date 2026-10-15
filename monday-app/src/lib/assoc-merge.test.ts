import { describe, it, expect } from "vitest";
import { mergeAssoc } from "./assoc-merge";

const card = (itemId: string, hubspotId: string, label: string) => ({ itemId, hubspotId, label });
describe("mergeAssoc", () => {
  const cards = [card("10", "1", "Ann"), card("20", "2", "Bob")];
  const hs = [{ hubspotId: "2", name: "Bob" }, { hubspotId: "3", name: "Cara" }];
  it("keeps monday cards (with itemId) and adds HubSpot-only ones (no itemId), deduped by hubspotId", () => {
    expect(mergeAssoc(cards, hs)).toEqual([
      { itemId: "10", hubspotId: "1", label: "Ann" },
      { itemId: "20", hubspotId: "2", label: "Bob" },
      { hubspotId: "3", label: "Cara" },
    ]);
  });
  it("monday-only when HubSpot is empty", () => expect(mergeAssoc(cards, [])).toEqual(cards));
  it("HubSpot-only when there are no cards", () =>
    expect(mergeAssoc([], hs)).toEqual([{ hubspotId: "2", label: "Bob" }, { hubspotId: "3", label: "Cara" }]));
  it("empty + empty -> []", () => expect(mergeAssoc([], [])).toEqual([]));
});
