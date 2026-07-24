import { describe, it, expect } from "vitest";
import { linkDisplayName } from "./link-name";

describe("linkDisplayName", () => {
  it("returns a real firstname unchanged", () =>
    expect(linkDisplayName("Emily", "", "")).toBe("Emily"));
  it("returns a real domain unchanged", () =>
    expect(linkDisplayName("cxmt.com", "", "")).toBe("cxmt.com"));
  it("contact fallback -> lastname", () =>
    expect(linkDisplayName("contacts 1", "Smith", "a@b.co")).toBe("Smith"));
  it("contact fallback, no lastname -> email", () =>
    expect(linkDisplayName("contacts 1", "", "a@b.co")).toBe("a@b.co"));
  it("contact fallback, nothing -> keep the id fallback", () =>
    expect(linkDisplayName("contacts 1", "", "")).toBe("contacts 1"));
  it("company fallback -> company name", () =>
    expect(linkDisplayName("companies 2", "Acme Inc", "Shanghai")).toBe("Acme Inc"));
  it("company fallback, no name -> keep id, NEVER the city", () =>
    expect(linkDisplayName("companies 2", "", "Shanghai")).toBe("companies 2"));
});
