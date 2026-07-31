import { describe, it, expect } from "vitest";
import { companySearchBody, mapCompanyResult } from "../src/hubspot";

describe("companySearchBody", () => {
  it("empty query: no query, createdate HAS_PROPERTY filter, createdate-DESC sort, default limit 25", () => {
    expect(companySearchBody({})).toEqual({
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      properties: [
        "name", "domain", "industry", "type", "partner_with", "city", "state",
        "numberofemployees", "annualrevenue", "linkedin_company_page", "description",
        "createdate", "hubspot_owner_id", "sales_user",
      ],
      limit: 25,
      filterGroups: [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }],
    });
  });
  it("with a query: sets query, no filterGroups", () => {
    const b = companySearchBody({ q: "  acme " });
    expect(b.query).toBe("acme");
    expect(b.filterGroups).toBeUndefined();
  });
  it("clamps limit to [1,50] and forwards after when present", () => {
    expect(companySearchBody({ limit: 999, after: "c123" }).limit).toBe(50);
    expect(companySearchBody({ limit: 0 }).limit).toBe(1);
    expect(companySearchBody({ after: "c123" }).after).toBe("c123");
    expect(companySearchBody({}).after).toBeUndefined();
  });
});

describe("mapCompanyResult", () => {
  const owners = { "77": { name: "Jane Rep", email: "jane@dkm.com" } };
  const labels = {
    industry: { COMPUTER_SOFTWARE: "Computer Software" },
    companyType: { PARTNER: "Partner" },
    partnerWith: { DKM: "DKM" },
    salesUser: { "77": "Jane Rep" },
  };
  it("resolves owner + enum labels, falls back to raw when unmapped, '' when missing", () => {
    expect(mapCompanyResult({
      name: "Acme", domain: "acme.com", industry: "COMPUTER_SOFTWARE", type: "UNKNOWN_CODE",
      partner_with: "DKM", numberofemployees: "50", annualrevenue: "1000000",
      linkedin_company_page: "https://li/acme", description: "desc", createdate: "2026-07-01T00:00:00Z",
      hubspot_owner_id: "77", sales_user: "77",
    } as any, owners as any, labels as any)).toEqual({
      name: "Acme", domain: "acme.com", industry: "Computer Software", type: "UNKNOWN_CODE",
      partnerWith: "DKM", city: "", state: "", employees: "50", revenue: "1000000",
      linkedin: "https://li/acme", description: "desc", createdate: "2026-07-01T00:00:00Z",
      ownerName: "Jane Rep", salesUser: "Jane Rep",
    });
  });
  it("unmapped owner id + empty enums -> ''", () => {
    expect(mapCompanyResult({ hubspot_owner_id: "999" } as any, owners as any, labels as any))
      .toMatchObject({ ownerName: "", salesUser: "", industry: "", type: "", partnerWith: "" });
  });
});
