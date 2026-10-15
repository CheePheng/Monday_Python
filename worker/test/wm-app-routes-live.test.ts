import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE DEAL COCKPIT, RUN AGAINST A WORK-MANAGEMENT ENVIRONMENT.
 *
 * A 137-commit jump was about to ship to the live WM Worker. It dry-ran clean and 1,955 tests passed,
 * and three routes the Cockpit calls every day would have returned 502 on every request:
 * /app/clear-deal-fields, /app/clear-record-fields and /app/backfill-contact-phones. A fourth path,
 * /app/contact and /app/company creation, would have failed on every genuinely new record.
 *
 * The cause was one silent coupling. Giving the WM specs `ownership` turned hubspot.ts's
 * assertMayWrite from a no-op into a real assertion for those specs -- and patchRecord/createRecord
 * call sites that passed no WriteAuth stopped being "unguarded" and started being "throwing".
 *
 * Nothing caught it because the only test watching those call sites, app-route-ownership.test.ts,
 * listed five mutators and not these two, and because NO test had ever executed these routes. So this
 * file drives the real fetch handler with a WM-shaped env: no ENABLE_CRM, full production write
 * posture, ownership live. Structural assertions are kept in the other file; these are behavioural,
 * because a route returning 502 is a fact about running code, not about its source text.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

/** Every HubSpot call the routes under test make, captured rather than sent. */
const hubspot = vi.hoisted(() => ({ calls: [] as any[], records: new Map<string, any>() }));

vi.mock("../src/hubspot", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/hubspot")>();
  return {
    ...real,
    getRecord: vi.fn(async (_env: any, object: string, id: string) => {
      const rec = hubspot.records.get(`${object}:${id}`);
      return rec ? { id, properties: rec } : null;
    }),
    getRecordsByIds: vi.fn(async (_env: any, object: string, ids: string[]) =>
      ids.map(id => hubspot.records.get(`${object}:${id}`)).filter(Boolean)
        .map((p: any, i) => ({ id: ids[i], properties: p }))),
    patchRecord: vi.fn(async (_env: any, spec: any, id: string, props: any, _o: any, auth: any) => {
      // Mirrors the REAL guard: a spec with ownership must be handed a matching, allowed auth.
      if (spec.ownership) {
        if (!auth) throw new Error(`hubspot write to ${spec.object}/${id} requires a WriteAuth`);
        if (auth.forId !== id) throw new Error(`auth was computed for ${auth.forId}`);
        if (!auth.allowed) throw new Error(`refused: ${auth.reason}`);
      }
      hubspot.calls.push({ fn: "patchRecord", object: spec.object, id, props });
      return "2026-09-22T00:00:00Z";
    }),
    archiveDeal: vi.fn(async (_env: any, id: string, _o: any, spec: any, auth: any) => {
      // Mirrors the REAL guard now in archiveDeal: a spec with ownership needs a matching, allowed auth.
      if (spec?.ownership) {
        if (!auth) throw new Error(`archive of deals/${id} requires a WriteAuth`);
        if (auth.forId !== id) throw new Error(`auth was computed for ${auth.forId}`);
        if (!auth.allowed) throw new Error(`refused: ${auth.reason}`);
      }
      hubspot.calls.push({ fn: "archiveDeal", object: "deals", id });
      return true;
    }),
  };
});

vi.mock("../src/monday", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/monday")>();
  return { ...real, setColumns: vi.fn(async () => {}), getBoardItems: vi.fn(async () => []) };
});

const CUTOVER = "2026-09-25T00:00:00Z";

/** The live WM binding set: production write posture, ownership active, no ENABLE_CRM. */
const wmEnv = (): Env => ({
  TRIGGER_SECRET: "t",
  MONDAY_API_TOKEN: "m",
  HUBSPOT_ACCESS_TOKEN: "h",
  DRY_RUN: "false",
  LINE_ITEM_WRITE: "true",
  MAX_WRITES: "100",
  CRM_CUTOVER_AT: CUTOVER,
} as unknown as Env);

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const post = (path: string, body: unknown) =>
  new Request(`https://w${path}`, {
    method: "POST",
    headers: { "x-trigger-secret": "t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function worker() { return (await import("../src/index")).default; }

beforeEach(() => {
  hubspot.calls = [];
  hubspot.records = new Map<string, any>([
    // Unstamped and created well before the cutover -> WM's to write. The ordinary case.
    ["deals:9001",     { sync_owner: "", createdate: "2026-01-01T00:00:00Z" }],
    ["companies:7001", { sync_owner: "", createdate: "2026-01-01T00:00:00Z" }],
    ["contacts:5001",  { sync_owner: "", createdate: "2026-01-01T00:00:00Z" }],
    // Already claimed by the CRM Worker -> WM must refuse. 4,179 real records look like this today.
    ["companies:7002", { sync_owner: "crm", createdate: "2026-01-01T00:00:00Z" }],
    ["contacts:5002",  { sync_owner: "crm", createdate: "2026-01-01T00:00:00Z" }],
  ]);
});

/**
 * DELETE /app/deal was the one HubSpot write the Cockpit could make with no ownership check at all.
 * A deal the CRM Worker owns must not be archivable from a WM card: HubSpot's delete webhook would
 * then remove the CRM card too.
 */
describe("DELETE /app/deal on the Work Management Worker", () => {
  const del = (body: unknown) => new Request("https://w/app/deal", {
    method: "DELETE", headers: { "x-trigger-secret": "t", "content-type": "application/json" }, body: JSON.stringify(body) });

  it("archives a WM-owned deal", async () => {
    const res = await (await worker()).fetch(del({ hubspotDealId: "9001" }), wmEnv(), ctx);
    expect(res.status).toBe(200);
    expect(hubspot.calls).toContainEqual({ fn: "archiveDeal", object: "deals", id: "9001" });
  });

  it("refuses a CRM-owned deal with 409 and archives nothing", async () => {
    hubspot.records.set("deals:9002", { sync_owner: "crm", createdate: "2026-01-01T00:00:00Z" });
    const res = await (await worker()).fetch(del({ hubspotDealId: "9002" }), wmEnv(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe("not-owned");
    expect(hubspot.calls).toHaveLength(0);
  });
});

describe("/app/clear-deal-fields on the Work Management Worker", () => {
  it("clears a WM-owned deal instead of returning 502", async () => {
    const res = await (await worker()).fetch(
      post("/app/clear-deal-fields", { hubspotDealId: "9001", fields: ["amount"] }), wmEnv(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(hubspot.calls).toContainEqual({ fn: "patchRecord", object: "deals", id: "9001", props: { amount: "" } });
  });

  /** The guard must still refuse -- 409 with a reason, which the drawer can show, not a bare 502. */
  it("refuses a deal the CRM Worker owns with 409, not 502", async () => {
    hubspot.records.set("deals:9002", { sync_owner: "crm", createdate: "2026-01-01T00:00:00Z" });
    const res = await (await worker()).fetch(
      post("/app/clear-deal-fields", { hubspotDealId: "9002", fields: ["amount"] }), wmEnv(), ctx);

    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe("not-owned");
    expect(hubspot.calls).toHaveLength(0);
  });
});

describe("/app/clear-record-fields on the Work Management Worker", () => {
  // The clearable allowlist is per object -- `city` is a company field, `jobtitle` a contact one --
  // so the field travels with the case. Sending an off-list field would 400 at the parser and never
  // reach the ownership path these tests exist to exercise.
  it.each([
    ["companies", "7001", "city"],
    ["contacts", "5001", "jobtitle"],
  ])("clears a WM-owned %s instead of returning 502", async (object, id, field) => {
    const res = await (await worker()).fetch(
      post("/app/clear-record-fields", { object, hubspotId: id, fields: [field] }), wmEnv(), ctx);

    expect(res.status).toBe(200);
    expect(hubspot.calls.map(c => c.id)).toContain(id);
  });

  it.each([
    ["companies", "7002", "city"],
    ["contacts", "5002", "jobtitle"],
  ])("refuses a crm-owned %s with 409 and writes nothing", async (object, id, field) => {
    const res = await (await worker()).fetch(
      post("/app/clear-record-fields", { object, hubspotId: id, fields: [field] }), wmEnv(), ctx);

    expect(res.status).toBe(409);
    expect(hubspot.calls).toHaveLength(0);
  });

  /** An unreadable record is not an owned one. It must refuse, and it must not throw. */
  it("refuses when HubSpot cannot return the record", async () => {
    const res = await (await worker()).fetch(
      post("/app/clear-record-fields", { object: "companies", hubspotId: "404404", fields: ["city"] }), wmEnv(), ctx);

    expect(res.status).toBe(409);
    expect(hubspot.calls).toHaveLength(0);
  });
});

describe("the ownership decision carried into the patch", () => {
  /**
   * assertMayWrite rejects an auth whose forId belongs to a different record, so a route that computed
   * one decision and reused it across records would throw rather than mis-write. Pinned because the
   * phone backfill patches MANY contacts from ONE read loop, which is exactly that shape.
   */
  it("is computed for the record being written, not a neighbour", async () => {
    const { authorizeWrite } = await import("../src/ownership");
    const { CONTACTS_MYLA } = await import("../src/config");
    const o = CONTACTS_MYLA.ownership!;
    const a = authorizeWrite({ id: "5001", properties: { sync_owner: "", createdate: "2026-01-01T00:00:00Z" } }, o);
    expect(a.forId).toBe("5001");
    expect(a.allowed).toBe(true);

    const claimed = authorizeWrite({ id: "5002", properties: { sync_owner: "crm", createdate: "2026-01-01T00:00:00Z" } }, o);
    expect(claimed.allowed).toBe(false);
    expect(claimed.forId).toBe("5002");
  });
});

/**
 * THE APP ROUTES AND THE CRONS MUST AGREE ABOUT THE CUTOVER.
 *
 * withCutover() returns COPIES of the specs, so the module constants index.ts imports keep OWN_WM's
 * placeholder cutoverAtMs of Infinity. A route authorizing against one of those treats EVERY unstamped
 * record as pre-cutover and therefore writable -- while the cron path, which resolves specs through
 * specsFor(env), refuses the post-cutover ones. Same Worker, same record, two answers.
 */
describe("the deployment cutover reaches the app routes, not just the crons", () => {
  it("the module constant does NOT carry the cutover (which is why routes must resolve the spec)", async () => {
    const { DEALS } = await import("../src/config");
    expect(DEALS.ownership!.cutoverAtMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("specByObject DOES carry it, for every WM spec", async () => {
    const { specByObject, specsFor } = await import("../src/config");
    const env = { CRM_CUTOVER_AT: CUTOVER } as any;
    expect(specByObject(env, "deals")!.ownership!.cutoverAtMs).toBe(Date.parse(CUTOVER));
    for (const s of specsFor(env))
      if (s.ownership) expect(s.ownership.cutoverAtMs).toBe(Date.parse(CUTOVER));
  });

  /**
   * The behavioural consequence: a deal created AFTER the cutover and never claimed is CRM's to claim,
   * so WM must refuse it. Authorizing against the module constant would have allowed it.
   */
  it("refuses an unstamped post-cutover deal from /app/clear-deal-fields", async () => {
    hubspot.records.set("deals:9003", { sync_owner: "", createdate: "2026-10-05T00:00:00Z" });
    const res = await (await worker()).fetch(
      post("/app/clear-deal-fields", { hubspotDealId: "9003", fields: ["amount"] }), wmEnv(), ctx);

    expect(res.status).toBe(409);
    expect(hubspot.calls).toHaveLength(0);
  });

  /** ...and still writes the pre-cutover one, so the fix did not simply refuse everything. */
  it("still allows an unstamped pre-cutover deal", async () => {
    const res = await (await worker()).fetch(
      post("/app/clear-deal-fields", { hubspotDealId: "9001", fields: ["amount"] }), wmEnv(), ctx);

    expect(res.status).toBe(200);
    expect(hubspot.calls).toHaveLength(1);
  });
});

/**
 * THE CREATE PATH, WHICH NEEDS BOTH HALVES.
 *
 * createRecord asserts a WriteAuth exactly as patchRecord does, so the Cockpit's Create Contact and
 * Create Company threw on every genuinely new record. Passing the auth alone would fix the throw and
 * leave a subtler bug behind: a record born UNSTAMPED is, after CRM_CUTOVER_AT, precisely the shape
 * the CRM Worker is entitled to claim -- so this Worker would create records and then hand them away.
 * withBirthOwnership is the other half. Both are pinned here.
 */
describe("app-driven HubSpot creation on the Work Management Worker", () => {
  it("authorizes the create instead of throwing", async () => {
    const { authorizeCreate } = await import("../src/ownership");
    const { CONTACTS_MYLA, COMPANIES_MYLA } = await import("../src/config");
    for (const spec of [CONTACTS_MYLA, COMPANIES_MYLA]) {
      expect(spec.ownership, `${spec.object} must declare ownership for this to matter`).toBeDefined();
      const auth = authorizeCreate(spec.ownership!);
      expect(auth.allowed).toBe(true);
      expect(auth.forId).toBe("(new)");   // the id createRecord asserts against
    }
  });

  it("stamps the new record as wm at birth, so the CRM Worker cannot later claim it", async () => {
    const { withBirthOwnership, authorizeWrite } = await import("../src/ownership");
    const { CONTACTS_MYLA } = await import("../src/config");
    const o = { ...CONTACTS_MYLA.ownership!, cutoverAtMs: Date.parse(CUTOVER) };

    const props = withBirthOwnership({ email: "a@b.com" }, o);
    expect(props[o.prop]).toBe("wm");

    // The stamp is load-bearing: a record born this way stays WM-writable even AFTER the cutover,
    // where an unstamped one created at the same moment would not be.
    const born = { id: "1", properties: { ...props, createdate: "2026-10-01T00:00:00Z" } };
    expect(authorizeWrite(born, o).allowed).toBe(true);

    const unstamped = { id: "2", properties: { sync_owner: "", createdate: "2026-10-01T00:00:00Z" } };
    expect(authorizeWrite(unstamped, o).allowed).toBe(false);
  });

  /** The call site itself: both arguments present, not just one. */
  it("passes the auth AND the birth stamp at the call site", async () => {
    const { readCode } = await import("../scripts/read-source.mjs");
    const src = readCode("create-records.ts");
    expect(src).toContain("withBirthOwnership");
    expect(src).toContain("authorizeCreate(spec.ownership)");
  });
});
