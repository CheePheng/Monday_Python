import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";

/**
 * PROPERTY_BATCH_READ: buildCtx's label dictionaries from ONE batch read per object instead of one GET per
 * property -- the calls that ran into HubSpot's ten-second limit live on 2026-10-12 (530 of 547 rate-limit
 * retries in 76 s were these GETs; 11 HubSpot webhooks gave up).
 *
 * Driven through the REAL hubspot.ts and the REAL buildCtx, with only HubSpot's HTTP stubbed (fetch) and
 * monday's user list mocked, so every claim is about the actual requests made and the actual Ctx built.
 * The stub serves the same property definitions to the single GET and to the batch read, the way HubSpot does
 * (verified live: identical options for contacts hs_lead_status).
 */

const monday = vi.hoisted(() => ({ getUsersByEmail: vi.fn() }));
vi.mock("../src/monday", async (orig) => ({ ...(await orig<typeof import("../src/monday")>()), ...monday }));

const { buildCtx, labelDictsFor, resetCtxCache } = await import("../src/sync");
const { getPropertyOptions, getPropertyOptionsBatch } = await import("../src/hubspot");

const ORDER = Symbol.for("dkm-crm-sync:hubspot-option-order");
const OFF = { ENABLE_CRM: "true", HUBSPOT_ACCESS_TOKEN: "t" } as unknown as Env;
const ON = { ...OFF, PROPERTY_BATCH_READ: "true" } as unknown as Env;

/** A definition for any property name: three options in a deliberate display order, labels unique per name. */
const defOf = (name: string) => ({
  name, type: "enumeration",
  options: [
    { value: `${name}_b`, label: `${name} B`, displayOrder: 1, hidden: false },
    { value: `${name}_a`, label: `${name} A`, displayOrder: 0, hidden: false },
    { value: `${name}_c`, label: `${name} C`, displayOrder: 2, hidden: false },
  ],
});

let calls: { method: string; path: string; body?: any }[];
/** Names the stub pretends HubSpot does not have in a batch (answered as a 207 PROPERTY_NOT_FOUND error). */
let missingInBatch: Set<string>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  resetCtxCache();
  calls = [];
  missingInBatch = new Set();
  monday.getUsersByEmail.mockReset().mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (u.pathname.startsWith("/crm/v3/owners")) return json(200, { results: [] });
    if (u.pathname === "/crm/v3/pipelines/deals") return json(200, { results: [] });
    const batch = u.pathname.match(/^\/crm\/v3\/properties\/([a-z_]+)\/batch\/read$/);
    if (batch && method === "POST") {
      const names: string[] = body.inputs.map((i: { name: string }) => i.name);
      const found = names.filter(n => !missingInBatch.has(n));
      const missing = names.filter(n => missingInBatch.has(n));
      return json(missing.length ? 207 : 200, { status: "COMPLETE", results: found.map(defOf),
        ...(missing.length ? { numErrors: missing.length, errors: missing.map(n => ({ status: "error",
          category: "OBJECT_NOT_FOUND", message: `No property named '${n}' exists.`, context: { name: [n] } })) } : {}) });
    }
    const single = u.pathname.match(/^\/crm\/v3\/properties\/([a-z_]+)\/([a-z0-9_]+)$/);
    if (single && method === "GET") return json(200, defOf(single[2]));
    return json(404, { message: `unexpected ${method} ${path}` });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const propertyGets = () => calls.filter(c => c.method === "GET" && /^\/crm\/v3\/properties\/[a-z_]+\/[a-z0-9_]+$/.test(c.path));
const batchReads = () => calls.filter(c => c.method === "POST" && c.path.endsWith("/batch/read"));

describe("getPropertyOptionsBatch: one request, the same dictionaries as the single read", () => {
  it("sends ONE POST with archived:false and each name once", async () => {
    await getPropertyOptionsBatch(OFF, "contacts", ["hs_lead_status", "lifecyclestage", "hs_lead_status"]);
    expect(batchReads()).toHaveLength(1);
    expect(batchReads()[0].path).toBe("/crm/v3/properties/contacts/batch/read");
    expect(batchReads()[0].body).toEqual({ archived: false, inputs: [{ name: "hs_lead_status" }, { name: "lifecyclestage" }] });
    expect(propertyGets()).toHaveLength(0);
  });

  it("builds exactly getPropertyOptions' dictionary, display order included (non-enumerable)", async () => {
    const batch = await getPropertyOptionsBatch(OFF, "contacts", ["hs_lead_status"]);
    const single = await getPropertyOptions(OFF, "contacts", "hs_lead_status");
    expect(batch.hs_lead_status).toEqual(single);
    expect((batch.hs_lead_status as any)[ORDER]).toEqual((single as any)[ORDER]);
    expect((batch.hs_lead_status as any)[ORDER]).toEqual({ hs_lead_status_a: 0, hs_lead_status_b: 1, hs_lead_status_c: 2 });
    expect(Object.keys(batch.hs_lead_status)).toEqual(["hs_lead_status_b", "hs_lead_status_a", "hs_lead_status_c"]);
  });

  it("a name the batch does not return (207) is read alone, exactly as before -- and only that name", async () => {
    missingInBatch = new Set(["leadstatus"]);
    const out = await getPropertyOptionsBatch(OFF, "contacts", ["hs_lead_status", "leadstatus"]);
    expect(Object.keys(out).sort()).toEqual(["hs_lead_status", "leadstatus"]);
    expect(propertyGets().map(c => c.path)).toEqual(["/crm/v3/properties/contacts/leadstatus"]);
    expect(out.leadstatus).toEqual(await getPropertyOptions(OFF, "contacts", "leadstatus"));
  });
});

describe("buildCtx with PROPERTY_BATCH_READ", () => {
  const objectsOf = (env: Env) => new Set(calls.filter(c => c.method === "POST").map(c => c.path.split("/")[4]));

  it("OFF (today): one GET per fetched dictionary, never a batch read", async () => {
    await buildCtx(OFF);
    expect(batchReads()).toHaveLength(0);
    expect(propertyGets().length).toBeGreaterThan(15);   // the CRM specs reference ~27 enum properties
  });

  it("ON: one batch read per object and no single property GET; the Ctx's dictionaries are identical", async () => {
    const off = await buildCtx(OFF);
    const offGets = propertyGets().length;
    calls = [];
    resetCtxCache();
    const on = await buildCtx(ON);

    expect(propertyGets()).toHaveLength(0);
    const objects = [...objectsOf(ON)].sort();
    expect(batchReads()).toHaveLength(objects.length);
    expect(objects.length).toBeLessThanOrEqual(4);
    // Every property the OFF build read alone is asked for in exactly one batch.
    const asked = batchReads().flatMap(c => c.body.inputs.map((i: { name: string }) => `${c.path.split("/")[4]}/${i.name}`));
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.length).toBe(offGets);

    expect(on.labels).toEqual(off.labels);
    for (const d of Object.keys(off.labels) as (keyof typeof off.labels)[])
      expect((on.labels[d] as any)?.[ORDER]).toEqual((off.labels[d] as any)?.[ORDER]);
    // Everything else in the Ctx is untouched by the switch.
    const { labels: _a, ...restOn } = on;
    const { labels: _b, ...restOff } = off;
    expect(restOn).toEqual(restOff);
  });

  it("ON: every dictionary the deployment wants is filled (none dropped by the regrouping)", async () => {
    const ctx = await buildCtx(ON);
    for (const d of labelDictsFor(ON)) expect(ctx.labels[d], d).toBeDefined();
  });

  it("ON: a batch that fails fails the build, as a failed GET does today (no silent empty dictionary)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.startsWith("/crm/v3/owners") || u.pathname === "/crm/v3/pipelines/deals") return json(200, { results: [] });
      if (u.pathname.endsWith("/batch/read") && init?.method === "POST") return json(400, { message: "bad request" });
      return json(200, defOf(u.pathname.split("/").pop()!));
    }));
    await expect(buildCtx(ON)).rejects.toThrow(/batch\/read: 400/);
  });

  it("the WM-style env (no ENABLE_CRM) never batches, even with the var set", async () => {
    await buildCtx({ HUBSPOT_ACCESS_TOKEN: "t", PROPERTY_BATCH_READ: "true" } as unknown as Env);
    expect(batchReads()).toHaveLength(0);
  });
});
