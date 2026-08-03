import { describe, it, expect } from "vitest";
import { companyFormToColumnValues, type CompanyForm } from "./company-form";
import { COMPANY_COLS } from "../board-config";

const base: CompanyForm = {};
describe("companyFormToColumnValues", () => {
  it("text/number -> raw string; empty omitted", () => {
    const cv = companyFormToColumnValues({ ...base, name: "Acme", city: "", employees: "50" });
    expect(cv[COMPANY_COLS.name.id]).toBe("Acme");
    expect(cv[COMPANY_COLS.employees.id]).toBe("50");
    expect(COMPANY_COLS.city.id in cv).toBe(false);
  });
  it("status -> {label}; dropdown -> {labels:[label]}", () => {
    const cv = companyFormToColumnValues({ ...base, type: "Partner", industry: "Computer Software" });
    expect(cv[COMPANY_COLS.type.id]).toEqual({ label: "Partner" });
    expect(cv[COMPANY_COLS.industry.id]).toEqual({ labels: ["Computer Software"] });
  });
  it("people -> {personsAndTeams}; empty omitted", () => {
    const cv = companyFormToColumnValues({ ...base, salesUserId: "111", ownerId: "" });
    expect(cv[COMPANY_COLS.salesUsers.id]).toEqual({ personsAndTeams: [{ id: 111, kind: "person" }] });
    expect(COMPANY_COLS.owner.id in cv).toBe(false);
  });
  it("no fields -> empty object", () => expect(companyFormToColumnValues(base)).toEqual({}));
});
