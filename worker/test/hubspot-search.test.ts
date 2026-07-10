import { describe, it, expect } from "vitest";
import { mapSearchResult } from "../src/hubspot";

describe("mapSearchResult (/app/search picker mapping)", () => {
  it("contact: name = 'first last', secondary = email", () =>
    expect(mapSearchResult("contacts", { firstname: "Jo", lastname: "Lee", email: "jo@x.com" }))
      .toEqual({ name: "Jo Lee", secondary: "jo@x.com" }));
  it("contact with no name falls back to email", () =>
    expect(mapSearchResult("contacts", { email: "jo@x.com" }))
      .toEqual({ name: "jo@x.com", secondary: "jo@x.com" }));
  it("company: name + domain", () =>
    expect(mapSearchResult("companies", { name: "Acme", domain: "acme.com" }))
      .toEqual({ name: "Acme", secondary: "acme.com" }));
  it("product: name + price", () =>
    expect(mapSearchResult("products", { name: "Xtract Universal", price: "15400" }))
      .toEqual({ name: "Xtract Universal", secondary: "15400" }));
  it("missing fields are safe", () =>
    expect(mapSearchResult("companies", {})).toEqual({ name: "(no name)", secondary: "" }));
});
