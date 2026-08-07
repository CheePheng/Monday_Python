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

// Only CHANGED fields are written. Rewriting untouched columns was the root of three real bugs.
describe("contactFormToColumnValues — changed fields only", () => {
  const hydrated = {
    lastname: "Chan", email: "a@b.co", jobtitle: "CTO", phone: "+60123456789",
    salesUserId: "7", ownerId: "9", leadStatus: "New", leadSource: "Web", vendor: "Acme, Beta",
  };
  it("no edits -> writes NOTHING", () =>
    expect(contactFormToColumnValues(hydrated, hydrated)).toEqual({}));
  it("a MULTI-value dropdown is not re-sent as one invalid label (the unsavable-contact bug)", () =>
    expect(contactFormToColumnValues({ ...hydrated, email: "new@b.co" }, hydrated))
      .toEqual({ text_mm4p2bvb: "new@b.co" }));
  it("an untouched people column is not collapsed to one person", () =>
    expect(contactFormToColumnValues({ ...hydrated, jobtitle: "CEO" }, hydrated))
      .toEqual({ text_mm4sznkw: "CEO" }));
  it("an untouched phone is not rewritten (keeps monday's country flag)", () =>
    expect(contactFormToColumnValues({ ...hydrated, lastname: "Wong" }, hydrated))
      .toEqual({ text_mm4scke9: "Wong" }));
  it("a genuinely edited dropdown IS written, as a single picked label", () =>
    expect(contactFormToColumnValues({ ...hydrated, vendor: "Acme" }, hydrated))
      .toEqual({ dropdown_mm4t8gjf: { labels: ["Acme"] } }));
  it("with no baseline (create-style) it still writes everything non-empty", () =>
    expect(Object.keys(contactFormToColumnValues(hydrated)).length).toBeGreaterThan(5));
});
