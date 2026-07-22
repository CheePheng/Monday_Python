import { describe, it, expect } from "vitest";
import { fieldsFor, validateRecordForm, recordFormToProperties } from "./record-form";

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
    expect(validateRecordForm("company", { name: "Acme" }).ok).toBe(true);
  });
  it("rejects a malformed email", () => {
    expect(validateRecordForm("contact", { firstname: "Ada", email: "nope" }).errors.email).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).errors.email).toBeUndefined();
  });
  it("warns (not errors) when the dedup key is missing", () => {
    expect(validateRecordForm("contact", { firstname: "Ada" }).warnings.email).toBeTruthy();
    expect(validateRecordForm("company", { name: "Acme" }).warnings.domain).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).warnings.email).toBeUndefined();
  });
});

describe("recordFormToProperties", () => {
  it("keeps only non-empty, trimmed fields that belong to the kind", () => {
    expect(recordFormToProperties("contact", { firstname: " Ada ", email: "", jobtitle: "CTO", bogus: "x" }))
      .toEqual({ firstname: "Ada", jobtitle: "CTO" });
  });
});
