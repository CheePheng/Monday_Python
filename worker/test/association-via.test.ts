import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * A LINE ITEM'S ACCOUNT IS DERIVED, AND DERIVING IT MUST NOT COST LINKS.
 *
 * HubSpot defines no line_item -> company association (the labels endpoint returns an empty set), so the
 * Products & Services board can only learn its Account by walking line_item -> deal -> company. Two
 * things make that dangerous, and both are what these tests are about:
 *
 *   1. syncRelationColumn writes a relation column by FULL REPLACEMENT. A read that silently returned
 *      "fewer" instead of "all" would DELETE the links it could not see — the contact 2855936605
 *      incident. A two-leg read has two chances to be partial, so both must refuse.
 *   2. The far end is many-to-one in practice: a deal may carry two companies. Picking wrong puts the
 *      wrong Account on a rep's line item.
 */

const hsMock = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../src/monday", () => ({}));

const { getAssociatedVia } = await import("../src/hubspot");

const env = { HUBSPOT_ACCESS_TOKEN: "t" } as unknown as Env;

/** Route by URL so a test states HubSpot's answers, not the call order. */
function route(table: Record<string, any>) {
  return vi.fn(async (url: string) => {
    for (const [frag, body] of Object.entries(table))
      if (String(url).includes(frag)) return new Response(JSON.stringify(body), { status: 200 });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });
}
const assoc = (pairs: [string, number[]][], after?: string) => ({
  results: pairs.map(([id, types]) => ({ toObjectId: id, associationTypes: types.map(t => ({ typeId: t })) })),
  ...(after ? { paging: { next: { after } } } : {}),
});

beforeEach(() => { vi.restoreAllMocks(); });

describe("walking line item -> deal -> company", () => {
  it("returns the deal's company for an ordinary single-company line item", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [341]]]),
    }));
    expect(await getAssociatedVia(env, "line_items", "77", "deals", "companies", true))
      .toEqual({ ids: ["555"], truncated: false });
  });

  it("unions the companies when a line item somehow hangs off two deals", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]], ["901", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [5]]]),
      "/deals/901/associations/companies": assoc([["556", [5]]]),
    }));
    const r = await getAssociatedVia(env, "line_items", "77", "deals", "companies", false);
    expect(r.ids.sort()).toEqual(["555", "556"]);
  });

  it("does not duplicate a company reachable through two deals", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]], ["901", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [341]]]),
      "/deals/901/associations/companies": assoc([["555", [341]]]),
    }));
    expect((await getAssociatedVia(env, "line_items", "77", "deals", "companies")).ids).toEqual(["555"]);
  });

  it("returns nothing, and does NOT report truncation, when the line item has no deal", async () => {
    vi.stubGlobal("fetch", route({ "/line_items/77/associations/deals": assoc([]) }));
    // truncated:false matters — truncated:true would make the caller keep a stale link forever.
    expect(await getAssociatedVia(env, "line_items", "77", "deals", "companies"))
      .toEqual({ ids: [], truncated: false });
  });

  it("returns nothing when the deal has no company", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([]),
    }));
    expect(await getAssociatedVia(env, "line_items", "77", "deals", "companies"))
      .toEqual({ ids: [], truncated: false });
  });
});

describe("the Primary tie-break", () => {
  it("picks the Primary company when the deal carries two", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [341]], ["556", [5, 341]]]),
    }));
    expect((await getAssociatedVia(env, "line_items", "77", "deals", "companies", true)).ids)
      .toEqual(["556"]);
  });

  it("links a LONE company that carries no Primary label — a tie-break must not become a filter", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [341]]]),
    }));
    expect((await getAssociatedVia(env, "line_items", "77", "deals", "companies", true)).ids)
      .toEqual(["555"]);
  });

  it("refuses to choose when two companies are BOTH Primary, returning both", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [5]], ["556", [5]]]),
    }));
    const r = await getAssociatedVia(env, "line_items", "77", "deals", "companies", true);
    expect(r.ids.sort()).toEqual(["555", "556"]);
  });

  it("returns both when a multi-company deal has NO Primary at all", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [341]], ["556", [341]]]),
    }));
    const r = await getAssociatedVia(env, "line_items", "77", "deals", "companies", true);
    expect(r.ids.sort()).toEqual(["555", "556"]);
  });

  it("keeps every company when the tie-break is switched off", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [341]], ["556", [5]]]),
    }));
    const r = await getAssociatedVia(env, "line_items", "77", "deals", "companies", false);
    expect(r.ids.sort()).toEqual(["555", "556"]);
  });
});

describe("a partial read must never be mistaken for a complete one", () => {
  it("refuses when the FIRST leg is truncated, and never reads the second", async () => {
    const f = route({
      "/line_items/77/associations/deals": assoc([["900", [20]]], "cursor"),
      "/deals/900/associations/companies": assoc([["555", [5]]]),
    });
    vi.stubGlobal("fetch", f);
    expect(await getAssociatedVia(env, "line_items", "77", "deals", "companies", true))
      .toEqual({ ids: [], truncated: true });
    expect(f.mock.calls.some(c => String(c[0]).includes("/deals/900/associations"))).toBe(false);
  });

  it("refuses when the SECOND leg is truncated", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [5]]], "cursor"),
    }));
    expect(await getAssociatedVia(env, "line_items", "77", "deals", "companies", true))
      .toEqual({ ids: [], truncated: true });
  });

  it("refuses wholesale when only ONE of several second legs is truncated", async () => {
    // Returning the complete deal's company alone would look like a confident answer and clear the rest.
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]], ["901", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [5]]]),
      "/deals/901/associations/companies": assoc([["556", [5]]], "cursor"),
    }));
    expect((await getAssociatedVia(env, "line_items", "77", "deals", "companies", true)).truncated).toBe(true);
  });

  it("discards ids gathered before the truncation was discovered", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]], ["901", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [5]]]),
      "/deals/901/associations/companies": assoc([["556", [5]]], "cursor"),
    }));
    expect((await getAssociatedVia(env, "line_items", "77", "deals", "companies", true)).ids).toEqual([]);
  });
});

describe("non-numeric ids are not links", () => {
  it("drops a malformed far id rather than passing it to card resolution", async () => {
    vi.stubGlobal("fetch", route({
      "/line_items/77/associations/deals": assoc([["900", [20]]]),
      "/deals/900/associations/companies": assoc([["555", [5]], ["not-an-id", [341]]]),
    }));
    expect((await getAssociatedVia(env, "line_items", "77", "deals", "companies", false)).ids)
      .toEqual(["555"]);
  });
});
