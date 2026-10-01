import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import { CONTACTS_MYLA } from "../src/config";

/**
 * THE REPAIR ROUTES, AND THE TWO ROUTES THAT WROTE TO THE WRONG DEPLOYMENT'S BOARDS.
 *
 * /resync and /resync-activity exist so a repair runs the Worker's OWN sync code over a chosen list of
 * records instead of a script re-implementing it. That only holds if they resolve THIS deployment's
 * spec: /app/ensure-card and /import used to hardcode the Work-Management constants, so on the CRM
 * Worker they would have carded records onto WM boards. Each route is driven through the real fetch
 * handler; the sync functions underneath are captured, so the assertions are about what was CALLED.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

const calls = vi.hoisted(() => ({
  record: [] as any[], activity: [] as any[], ensure: [] as any[], fail: new Set<string>(),
}));

vi.mock("../src/sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/sync")>();
  return {
    ...real,
    getCtxCached: vi.fn(async () => ({ labels: {}, ownersById: {}, mondayUsersByEmail: {} })),
    syncHubspotRecord: vi.fn(async (_env: any, spec: any, id: string, o: any, _b: any, ignore: any, force: any) => {
      if (calls.fail.has(id)) throw new Error("boom");
      calls.record.push({ board: spec.boardId, object: spec.object, id, ignore, force, dryRun: o.dryRun, writeHubspot: o.writeHubspot });
      return "updated-monday";
    }),
  };
});

vi.mock("../src/activity-sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/activity-sync")>();
  return {
    ...real,
    syncHubspotActivity: vi.fn(async (_env: any, object: string, id: string, opts: any) => {
      calls.activity.push({ object, id, opts });
      return "delivered";
    }),
  };
});

vi.mock("../src/hubspot", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/hubspot")>();
  return {
    ...real,
    getRecord: vi.fn(async (_env: any, _object: string, id: string) =>
      ({ id, properties: { createdate: "2026-01-01T00:00:00Z" } })),
  };
});

vi.mock("../src/ensure-card", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ensure-card")>();
  return {
    ...real,
    ensureCardForRecord: vi.fn(async (_env: any, spec: any, _ctx: any, rec: any) => {
      calls.ensure.push({ board: spec.boardId, id: rec.id });
      return { status: "found", itemId: "CARD-1" };
    }),
    cardIdOf: (r: any) => r.itemId ?? null,
  };
});

const crmEnv = (over: Record<string, string> = {}): Env => ({
  TRIGGER_SECRET: "t", MONDAY_API_TOKEN: "m", HUBSPOT_ACCESS_TOKEN: "h",
  DRY_RUN: "false", WRITE_HUBSPOT: "true", MAX_WRITES: "25",
  ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-16T11:16:48Z", ENABLE_ACTIVITY_SYNC: "true",
  ...over,
} as unknown as Env);

const wmEnv = (): Env => ({
  TRIGGER_SECRET: "t", MONDAY_API_TOKEN: "m", HUBSPOT_ACCESS_TOKEN: "h",
  DRY_RUN: "false", MAX_WRITES: "100", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z",
} as unknown as Env);

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const post = (path: string, body: unknown, secret = "t") =>
  new Request(`https://w${path}`, {
    method: "POST",
    headers: { "x-trigger-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function call(path: string, body: unknown, env: Env, secret = "t") {
  const w = (await import("../src/index")).default;
  const res = await w.fetch(post(path, body, secret), env, ctx);
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeEach(() => {
  calls.record = []; calls.activity = []; calls.ensure = []; calls.fail = new Set();
});

describe("/resync", () => {
  it("refuses without the trigger secret", async () => {
    expect((await call("/resync", { object: "contacts", ids: ["1"] }, crmEnv(), "wrong")).status).toBe(403);
    expect(calls.record).toHaveLength(0);
  });

  it.each([
    ["contacts", CRM_CONTACTS.boardId],
    ["companies", CRM_ACCOUNTS.boardId],
    ["deals", CRM_DEALS.boardId],
  ])("on the CRM Worker, %s resolve to the CRM board", async (object, board) => {
    const r = await call("/resync", { object, ids: ["101", "102"] }, crmEnv());
    expect(r.status).toBe(200);
    expect(calls.record.map(c => c.board)).toEqual([board, board]);
    expect(r.json.results).toEqual({ "101": "updated-monday", "102": "updated-monday" });
  });

  it("passes forceForward only when asked, and only as a literal true", async () => {
    await call("/resync", { object: "contacts", ids: ["1"] }, crmEnv());
    await call("/resync", { object: "contacts", ids: ["2"], forceForward: "true" }, crmEnv());
    await call("/resync", { object: "contacts", ids: ["3"], forceForward: true }, crmEnv());
    expect(calls.record.map(c => c.force)).toEqual([false, false, true]);
  });

  /** Record-level WM specs have no forceForward and may decide "toHubspot": a repair must never push. */
  it("on the WM Worker, /resync is refused: its specs are record-level", async () => {
    const r = await call("/resync", { object: "contacts", ids: ["1"] }, wmEnv());
    expect(r.status).toBe(400);
    expect(calls.record).toHaveLength(0);
  });

  it("dryRun:true runs the same engine with every write suppressed, and says so", async () => {
    const r = await call("/resync", { object: "deals", ids: ["1"], forceForward: true, dryRun: true }, crmEnv());
    expect(r.json.dryRun).toBe(true);
    expect(calls.record[0]).toMatchObject({ force: true, dryRun: true, writeHubspot: false });
  });

  it("anything but a literal dryRun:true writes for real (the deployment's own posture)", async () => {
    const r = await call("/resync", { object: "deals", ids: ["1"], dryRun: "true" }, crmEnv());
    expect(r.json.dryRun).toBe(false);
    expect(calls.record[0]).toMatchObject({ dryRun: false });
  });

  it("a repeated id is synced once", async () => {
    await call("/resync", { object: "contacts", ids: ["7", "7", "8"] }, crmEnv());
    expect(calls.record.map(c => c.id)).toEqual(["7", "8"]);
  });

  it("refuses WM deals, which route across several boards", async () => {
    const r = await call("/resync", { object: "deals", ids: ["1"] }, wmEnv());
    expect(r.status).toBe(400);
    expect(calls.record).toHaveLength(0);
  });

  it.each([
    [{ object: "tickets", ids: ["1"] }],
    [{ object: "contacts", ids: [] }],
    [{ object: "contacts", ids: ["abc", "1; drop"] }],
    [{ object: "contacts", ids: Array.from({ length: 11 }, (_, i) => String(i + 1)) }],
  ])("rejects a bad request %#", async (body) => {
    expect((await call("/resync", body, crmEnv())).status).toBe(400);
    expect(calls.record).toHaveLength(0);
  });

  it("one failing record is reported and does not stop the rest", async () => {
    calls.fail.add("2");
    const r = await call("/resync", { object: "contacts", ids: ["1", "2", "3"] }, crmEnv());
    expect(r.status).toBe(200);
    expect(r.json.results["1"]).toBe("updated-monday");
    expect(r.json.results["2"]).toMatch(/^error: /);
    expect(r.json.results["3"]).toBe("updated-monday");
  });
});

describe("/resync-activity", () => {
  it("refuses without the trigger secret", async () => {
    expect((await call("/resync-activity", { object: "emails", ids: ["1"] }, crmEnv(), "")).status).toBe(403);
  });

  it("refuses while activity sync is off", async () => {
    const r = await call("/resync-activity", { object: "emails", ids: ["1"] }, crmEnv({ ENABLE_ACTIVITY_SYNC: "false" }));
    expect(r.status).toBe(409);
    expect(calls.activity).toHaveLength(0);
  });

  it("delivers each activity with verifyExisting, so a present one is not written twice", async () => {
    const r = await call("/resync-activity", { object: "emails", ids: ["11", "12"] }, crmEnv());
    expect(r.status).toBe(200);
    expect(calls.activity).toEqual([
      { object: "emails", id: "11", opts: { verifyExisting: true } },
      { object: "emails", id: "12", opts: { verifyExisting: true } },
    ]);
  });

  it("never bypasses the activity cutover", async () => {
    await call("/resync-activity", { object: "calls", ids: ["1"], ignoreCutover: true }, crmEnv());
    expect(calls.activity[0].opts).not.toHaveProperty("ignoreCutover");
  });

  it("rejects an object that is not an activity", async () => {
    expect((await call("/resync-activity", { object: "contacts", ids: ["1"] }, crmEnv())).status).toBe(400);
  });
});

describe("Work-Management-only /app writes are refused on the CRM Worker", () => {
  it.each([
    ["/app/contact", { idempotencyKey: "k", firstname: "A", email: "a@example.com" }],
    ["/app/company", { idempotencyKey: "k", name: "A", domain: "example.com" }],
    ["/app/backfill-contact-phones", {}],
    ["/app/sync-contact", { itemId: "1" }],
    ["/app/sync-company", { itemId: "1" }],
    ["/app/sync-deal", { itemId: "1" }],
  ])("%s answers 409 wm-only-route and does nothing", async (path, body) => {
    const r = await call(path, body, crmEnv());
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("wm-only-route");
    expect(calls.ensure).toHaveLength(0);
  });

  it("CRM-valid /app writes are not caught by the refusal", async () => {
    expect((await call("/app/ensure-card", { object: "contacts", hubspotId: "5001" }, crmEnv())).status).toBe(200);
  });
});

describe("/app/ensure-card resolves THIS deployment's board", () => {
  it("on the CRM Worker, a contact is carded on the CRM Contacts board", async () => {
    const r = await call("/app/ensure-card", { object: "contacts", hubspotId: "5001" }, crmEnv());
    expect(r.status).toBe(200);
    expect(calls.ensure).toEqual([{ board: CRM_CONTACTS.boardId, id: "5001" }]);
  });

  it("on the CRM Worker, a company is carded on the CRM Accounts board", async () => {
    await call("/app/ensure-card", { object: "companies", hubspotId: "7001" }, crmEnv());
    expect(calls.ensure[0].board).toBe(CRM_ACCOUNTS.boardId);
  });

  it("on the WM Worker, nothing changes: the WM Contacts board", async () => {
    await call("/app/ensure-card", { object: "contacts", hubspotId: "5001" }, wmEnv());
    expect(calls.ensure[0].board).toBe(CONTACTS_MYLA.boardId);
  });
});
