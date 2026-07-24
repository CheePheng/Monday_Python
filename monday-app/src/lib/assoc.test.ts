import { describe, it, expect } from "vitest";
import { buildCreateAssoc, isPendingCreate } from "./assoc";

describe("buildCreateAssoc", () => {
  it("stages a contact create with a name label + trimmed properties", () => {
    const a = buildCreateAssoc("contact", { firstname: " Ada ", lastname: "Lovelace", email: "a@b.co", bogus: "x" }, "key-1");
    expect(a.label).toBe("Ada Lovelace");
    expect(a.create).toEqual({ key: "key-1", properties: { firstname: "Ada", lastname: "Lovelace", email: "a@b.co" } });
    expect(a.hubspotId).toBeUndefined();
    expect(a.itemId).toBeUndefined();
  });
  it("labels a company by name, falling back to domain", () => {
    expect(buildCreateAssoc("company", { name: "Acme" }, "k").label).toBe("Acme");
    expect(buildCreateAssoc("company", { domain: "acme.com" }, "k").label).toBe("acme.com");
  });
  it("falls back to a generic label when nothing is filled", () => {
    expect(buildCreateAssoc("contact", {}, "k").label).toBe("New contact");
  });
});

describe("isPendingCreate", () => {
  it("is true only for an unresolved create", () => {
    expect(isPendingCreate({ label: "x", create: { key: "k", properties: {} } })).toBe(true);
    expect(isPendingCreate({ label: "x", create: { key: "k", properties: {} }, hubspotId: "9" })).toBe(false);
    expect(isPendingCreate({ label: "x", hubspotId: "9" })).toBe(false);
  });
});
