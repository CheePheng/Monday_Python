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

import { afterEach, vi } from "vitest";
import { listCompanies } from "../src/hubspot";
import type { Env } from "../src/types";

describe("listCompanies", () => {
  const env = { HUBSPOT_ACCESS_TOKEN: "t" } as Env;
  afterEach(() => vi.unstubAllGlobals());

  it("maps results (id + fields) and returns the next cursor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: "5", properties: { name: "Acme", domain: "acme.com", hubspot_owner_id: "77" } }],
      paging: { next: { after: "25" } },
    }), { status: 200 })));
    const out = await listCompanies(env, { q: "acme" }, { "77": { name: "Jane", email: null } }, {});
    expect(out.after).toBe("25");
    expect(out.items[0]).toMatchObject({ hubspotId: "5", name: "Acme", domain: "acme.com", ownerName: "Jane" });
  });

  it("returns after=null when there is no next page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const out = await listCompanies(env, {}, {}, {});
    expect(out).toEqual({ items: [], after: null });
  });
});

import { mapAssocRecord } from "../src/hubspot";

describe("mapAssocRecord", () => {
  it("company -> {hubspotId, name} (name||domain)", () => {
    expect(mapAssocRecord("companies", { id: "9", properties: { domain: "acme.com" } }))
      .toEqual({ hubspotId: "9", name: "acme.com" });
  });
  it("contact -> {hubspotId, name, email, title}", () => {
    expect(mapAssocRecord("contacts", { id: "3", properties: { firstname: "Jo", lastname: "Lee", email: "jo@x.com", jobtitle: "CTO" } }))
      .toEqual({ hubspotId: "3", name: "Jo Lee", email: "jo@x.com", title: "CTO" });
  });
  it("contact with no name falls back to email; missing title/email -> ''", () => {
    expect(mapAssocRecord("contacts", { id: "4", properties: { email: "a@b.co" } }))
      .toEqual({ hubspotId: "4", name: "a@b.co", email: "a@b.co", title: "" });
  });
});

import { mapOwners } from "../src/hubspot";

describe("companySearchBody filters", () => {
  it("owner + created + activity all go in ONE and'd filter group", () => {
    const b = companySearchBody({ ownerId: "77", created: { gte: 100, lte: 200 }, activity: { gte: 300 } }) as any;
    expect(b.filterGroups).toHaveLength(1);
    expect(b.filterGroups[0].filters).toEqual([
      { propertyName: "hubspot_owner_id", operator: "EQ", value: "77" },
      { propertyName: "createdate", operator: "GTE", value: 100 },
      { propertyName: "createdate", operator: "LTE", value: 200 },
      { propertyName: "notes_last_updated", operator: "GTE", value: 300 },
    ]);
    expect(b.query).toBeUndefined();
  });
  it("query + filters keeps BOTH query and filterGroups", () => {
    const b = companySearchBody({ q: "acme", ownerId: "77" }) as any;
    expect(b.query).toBe("acme");
    expect(b.filterGroups[0].filters).toEqual([{ propertyName: "hubspot_owner_id", operator: "EQ", value: "77" }]);
  });
  it("no query, no filters -> createdate HAS_PROPERTY default", () => {
    const b = companySearchBody({}) as any;
    expect(b.filterGroups).toEqual([{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }]);
    expect(b.query).toBeUndefined();
  });
  it("query only -> query, no filterGroups", () => {
    const b = companySearchBody({ q: "acme" }) as any;
    expect(b.query).toBe("acme");
    expect(b.filterGroups).toBeUndefined();
  });
});

describe("mapOwners", () => {
  it("maps ownersById -> sorted [{id,name}], skipping blank names", () => {
    expect(mapOwners({ "3": { name: "Zoe", email: null }, "1": { name: "Ann", email: null }, "2": { name: "", email: null } }))
      .toEqual([{ id: "1", name: "Ann" }, { id: "3", name: "Zoe" }]);
  });
});
