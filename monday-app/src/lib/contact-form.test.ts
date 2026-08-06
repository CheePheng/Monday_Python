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
  it("writes phone as { phone } with digits (keeps a leading +), stripping formatting", () => {
    expect(contactFormToColumnValues({ phone: "+1 (234) 567-8900" }))
      .toEqual({ phone_mm4s31p3: { phone: "+12345678900" } });
    expect(contactFormToColumnValues({ phone: "234-567-8900" }))
      .toEqual({ phone_mm4s31p3: { phone: "2345678900" } });
  });
  it("blank phone is omitted (no clear path)", () =>
    expect(contactFormToColumnValues({ phone: "   " })).toEqual({}));
});
