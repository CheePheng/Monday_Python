import { describe, it, expect } from "vitest";
import { contactFormToColumnValues } from "./contact-form";

describe("contactFormToColumnValues", () => {
  it("maps text/status/dropdown/people and omits empty", () => {
    expect(contactFormToColumnValues({
      lastname: "Lee", email: "jo@x.com", jobtitle: "CTO",
      salesUserId: "7", ownerId: "9", leadStatus: "New", leadSource: "Web", vendor: "Acme",
    })).toEqual({
      text_mm4scke9: "Lee", text_mm4p2bvb: "jo@x.com", text_mm4sznkw: "CTO",
      multiple_person_mm542gng: { personsAndTeams: [{ id: 7, kind: "person" }] },
      multiple_person_mm4p8xe2: { personsAndTeams: [{ id: 9, kind: "person" }] },
      status: { label: "New" },
      dropdown_mm4sj3kw: { labels: ["Web"] },
      dropdown_mm4t8gjf: { labels: ["Acme"] },
    });
  });
  it("empty form -> {} (no clear path)", () => expect(contactFormToColumnValues({})).toEqual({}));
  it("does not write phone (read-only until Task 8)", () =>
    expect(contactFormToColumnValues({ phone: "123" } as any)).toEqual({}));
});
