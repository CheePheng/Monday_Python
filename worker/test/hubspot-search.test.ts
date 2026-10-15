import { describe, it, expect, afterEach, vi } from "vitest";
import { mapSearchResult, searchObjects } from "../src/hubspot";
import type { Env } from "../src/types";

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
  it("product: name + price (empty sku/description)", () =>
    expect(mapSearchResult("products", { name: "Xtract Universal", price: "15400" }))
      .toEqual({ name: "Xtract Universal", secondary: "15400", sku: "", price: "15400", description: "" }));
  it("product: full name/sku/price/description", () =>
    expect(mapSearchResult("products", { name: "Zoom Pro", hs_sku: "Z-1", price: "168", description: "Team plan" }))
      .toEqual({ name: "Zoom Pro", secondary: "168", sku: "Z-1", price: "168", description: "Team plan" }));
  it("missing fields are safe", () =>
    expect(mapSearchResult("companies", {})).toEqual({ name: "(no name)", secondary: "" }));
});

describe("searchObjects total", () => {
  const env = { HUBSPOT_ACCESS_TOKEN: "test-token" } as Env;

  afterEach(() => vi.unstubAllGlobals());

  it("returns HubSpot's total when the response includes one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ total: 42, results: [{ id: "1", properties: { name: "Acme" } }] }), { status: 200 })));
    await expect(searchObjects(env, "companies", "acme", 10)).resolves.toEqual({
      results: [{ id: "1", name: "Acme", secondary: "" }],
      total: 42,
    });
  });

  it("falls back to results.length when the response omits total", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ id: "1", properties: { name: "Acme" } }] }), { status: 200 })));
    await expect(searchObjects(env, "companies", "acme", 10)).resolves.toEqual({
      results: [{ id: "1", name: "Acme", secondary: "" }],
      total: 1,
    });
  });
});
