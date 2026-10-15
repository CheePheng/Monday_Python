import { describe, it, expect, afterEach, vi } from "vitest";
import { contactSearchBody, mapContactResult, listContacts } from "../src/hubspot";
import type { Env } from "../src/types";

describe("contactSearchBody", () => {
  it("empty query: createdate HAS_PROPERTY, createdate-DESC sort, default limit 25", () => {
    const b = contactSearchBody({}) as any;
    expect(b.sorts).toEqual([{ propertyName: "createdate", direction: "DESCENDING" }]);
    expect(b.limit).toBe(25);
    expect(b.filterGroups).toEqual([{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }]);
    expect(b.query).toBeUndefined();
    expect(b.properties).toContain("firstname");
    expect(b.properties).toContain("email");
  });
  it("owner + created + activity in ONE and'd group; query kept alongside", () => {
    const b = contactSearchBody({ q: " jo ", ownerId: "77", created: { gte: 100, lte: 200 }, activity: { gte: 300 } }) as any;
    expect(b.query).toBe("jo");
    expect(b.filterGroups[0].filters).toEqual([
      { propertyName: "hubspot_owner_id", operator: "EQ", value: "77" },
      { propertyName: "createdate", operator: "GTE", value: 100 },
      { propertyName: "createdate", operator: "LTE", value: 200 },
      { propertyName: "notes_last_updated", operator: "GTE", value: 300 },
    ]);
  });
  it("clamps limit to [1,50] and forwards after", () => {
    expect((contactSearchBody({ limit: 999 }) as any).limit).toBe(50);
    expect((contactSearchBody({ limit: 0 }) as any).limit).toBe(1);
    expect((contactSearchBody({ after: "c1" }) as any).after).toBe("c1");
  });
});

describe("mapContactResult", () => {
  const owners = { "77": { name: "Jane Rep", email: "jane@dkm.com" } };
  // salesUser maps a raw HubSpot OWNER ID -> owner name; without it the directory shows a bare id.
  const labels = { leadStatus: { NEW: "New" }, contactSource: { WEB: "Web" }, contactVendor: { ACME: "Acme" },
    salesUser: { "77": "Jane Rep" } };
  it("joins name, resolves owner + enum labels, '' when missing", () => {
    expect(mapContactResult({
      firstname: "Jo", lastname: "Lee", email: "jo@x.com", phone: "123", jobtitle: "CTO",
      company: "Acme Inc", hs_lead_status: "NEW", leadsource: "WEB", createdate: "2026-07-01T00:00:00Z",
      hubspot_owner_id: "77", sales_user: "77",
    } as any, owners as any, labels as any)).toEqual({
      name: "Jo Lee", email: "jo@x.com", phone: "123", jobtitle: "CTO", company: "Acme Inc",
      leadStatus: "New", leadSource: "Web", createdate: "2026-07-01T00:00:00Z",
      ownerName: "Jane Rep", salesUser: "Jane Rep",
    });
  });
  it("no name falls back to email", () =>
    expect(mapContactResult({ email: "a@b.co" } as any, owners as any, labels as any).name).toBe("a@b.co"));
});

describe("listContacts", () => {
  const env = { HUBSPOT_ACCESS_TOKEN: "t" } as Env;
  afterEach(() => vi.unstubAllGlobals());
  it("maps id + fields and returns the next cursor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: "5", properties: { firstname: "Jo", lastname: "Lee", email: "jo@x.com" } }],
      paging: { next: { after: "25" } },
    }), { status: 200 })));
    const out = await listContacts(env, { q: "jo" }, { "77": { name: "Jane", email: null } }, {});
    expect(out.after).toBe("25");
    expect(out.items[0]).toMatchObject({ hubspotId: "5", name: "Jo Lee", email: "jo@x.com" });
  });
  it("after=null when no next page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    expect(await listContacts(env, {}, {}, {})).toEqual({ items: [], after: null });
  });
});
