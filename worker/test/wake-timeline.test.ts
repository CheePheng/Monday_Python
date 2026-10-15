import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * POST /wake-timeline -- the catch-up for the hours nothing rang (#09/#10 off at 09:00:42Z on 2026-09-30,
 * until #10 stamped the Activity bell). It must do exactly what a ring does and nothing more: the same
 * syncMondayTimeline, on Contacts cards only, behind the trigger secret, CRM only.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
const act = vi.hoisted(() => ({ syncMondayTimeline: vi.fn(async (_e: Env, id: string) => `action=done pushed=1 fresh=1 item=${id}`) }));
vi.mock("../src/activity-sync", async (orig) => ({ ...(await orig<any>()), syncMondayTimeline: act.syncMondayTimeline }));
const monday = vi.hoisted(() => ({
  gql: vi.fn(), getItem: vi.fn(), setColumns: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getUserById: vi.fn(), whoAmI: vi.fn(),
}));
vi.mock("../src/monday", async (orig) => ({ ...(await orig<any>()), ...monday }));

const worker = (await import("../src/index")).default;

const crm = { ENABLE_CRM: "true", ENABLE_ACTIVITY_SYNC: "true", TRIGGER_SECRET: "s" } as unknown as Env;
const wm = { ENABLE_ACTIVITY_SYNC: "true", TRIGGER_SECRET: "s" } as unknown as Env;
const ectx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const post = (body: unknown, env: Env = crm, secret: string | null = "s") =>
  worker.fetch(new Request("https://w/wake-timeline", { method: "POST", body: JSON.stringify(body),
    headers: secret ? { "x-trigger-secret": secret } : {} }), env, ectx());

const CONTACTS = "5028000495";
beforeEach(() => {
  vi.clearAllMocks();
  monday.gql.mockImplementation(async (_e: Env, _q: string, v: any) => ({
    items: (v.i as string[]).filter(i => i !== "404").map(i => ({ id: i, board: { id: i === "600" ? "5028000496" : CONTACTS } })),
  }));
});

describe("POST /wake-timeline", () => {
  it("reads each Contacts card's timeline through the same function a ring uses, and reports it", async () => {
    const r = await post({ itemIds: ["2855736188", 2855736189] });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(act.syncMondayTimeline.mock.calls.map(c => c[1])).toEqual(["2855736188", "2855736189"]);
    expect(j.results["2855736188"]).toMatch(/pushed=1/);
  });

  it("only Contacts cards: another board's item or a missing one is skipped, never read", async () => {
    const j: any = await (await post({ itemIds: ["600", "404", "1"] })).json();
    expect(act.syncMondayTimeline.mock.calls.map(c => c[1])).toEqual(["1"]);
    expect(j.results["600"]).toMatch(/not a Contacts card/);
    expect(j.results["404"]).toMatch(/not found/);
  });

  it("dedups, and refuses an empty list or more than 20 ids", async () => {
    await post({ itemIds: ["1", "1", "1"] });
    expect(act.syncMondayTimeline).toHaveBeenCalledTimes(1);
    expect((await post({ itemIds: [] })).status).toBe(400);
    expect((await post({ itemIds: ["x", "y"] })).status).toBe(400);
    expect((await post({ itemIds: Array.from({ length: 21 }, (_, i) => String(i + 1)) })).status).toBe(400);
  });

  it("needs the trigger secret", async () => {
    expect((await post({ itemIds: ["1"] }, crm, null)).status).toBe(403);
    expect((await post({ itemIds: ["1"] }, crm, "wrong")).status).toBe(403);
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  it("is refused while activity sync is off", async () => {
    const r = await post({ itemIds: ["1"] }, { ...crm, ENABLE_ACTIVITY_SYNC: "false" } as Env);
    expect(r.status).toBe(409);
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  it("does not exist on the Work Management Worker, secret or not, and reads nothing", async () => {
    expect((await post({ itemIds: ["1"] }, wm)).status).toBe(404);
    expect(monday.gql).not.toHaveBeenCalled();
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  it("one card's failure is reported, and the rest still run", async () => {
    act.syncMondayTimeline.mockRejectedValueOnce(new Error("rate limited"));
    const j: any = await (await post({ itemIds: ["1", "2"] })).json();
    expect(j.results["1"]).toMatch(/^error: .*rate limited/);
    expect(j.results["2"]).toMatch(/pushed=1/);
  });
});
