import { describe, it, expect } from "vitest";
import { fieldsFor, validateRecordForm, recordFormToProperties, NO_WEBSITE } from "./record-form";

describe("fieldsFor", () => {
  it("contact requires firstname; company requires name", () => {
    expect(fieldsFor("contact").find(f => f.required)?.prop).toBe("firstname");
    expect(fieldsFor("company").find(f => f.required)?.prop).toBe("name");
  });
});

describe("validateRecordForm", () => {
  it("requires the name field", () => {
    expect(validateRecordForm("contact", {}).ok).toBe(false);
    expect(validateRecordForm("contact", { firstname: "Ada" }).ok).toBe(true);
    expect(validateRecordForm("company", { name: "Acme", domain: "acme.com" }).ok).toBe(true);
  });
  it("rejects a malformed email", () => {
    expect(validateRecordForm("contact", { firstname: "Ada", email: "nope" }).errors.email).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).errors.email).toBeUndefined();
  });
  // Contacts only. A company with no domain is now a hard ERROR (see "company domain gate" below), because
  // domain is the only de-duplication key a company has.
  it("warns (not errors) when a contact has no email", () => {
    expect(validateRecordForm("contact", { firstname: "Ada" }).warnings.email).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).warnings.email).toBeUndefined();
  });
});

describe("company domain gate", () => {
  it("is valid with a domain", () =>
    expect(validateRecordForm("company", { name: "Acme", domain: "acme.com" }).ok).toBe(true));
  it("is INVALID with no domain and the box unticked", () => {
    const v = validateRecordForm("company", { name: "Acme" });
    expect(v.ok).toBe(false);
    expect(v.errors.domain).toBeTruthy();
  });
  it("is INVALID when the domain is only whitespace", () => {
    const v = validateRecordForm("company", { name: "Acme", domain: "   " });
    expect(v.ok).toBe(false);
    expect(v.errors.domain).toBeTruthy();
  });
  it("is valid with no domain once the box is ticked", () =>
    expect(validateRecordForm("company", { name: "Acme", [NO_WEBSITE]: "1" }).ok).toBe(true));
  it("never sends the checkbox flag to HubSpot", () =>
    expect(recordFormToProperties("company", { name: "Acme", [NO_WEBSITE]: "1" }))
      .toEqual({ name: "Acme" }));
});

describe("recordFormToProperties", () => {
  it("keeps only non-empty, trimmed fields that belong to the kind", () => {
    expect(recordFormToProperties("contact", { firstname: " Ada ", email: "", jobtitle: "CTO", bogus: "x" }))
      .toEqual({ firstname: "Ada", jobtitle: "CTO" });
  });
});
