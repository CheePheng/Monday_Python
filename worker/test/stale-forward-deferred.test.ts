import { describe, it, expect, vi, beforeEach } from "vitest";
import { deferKey, isUpdateItem, type DeferredItem } from "../src/deferred-sync";
import type { Env } from "../src/types";

/**
 * DEFERRED_SYNC under STALE_FORWARD_GATE: an update carries what its events named (its PassScope) and two waiting
 * updates of one record merge theirs (unscoped wins); the card watch's converge and retry are items of their own,
 * keyed by the monday item, run by the wave through settleCardWatch / retryMarkedEdits.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
const sync = vi.hoisted(() => ({
  syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(), recheckDanglingClears: vi.fn(), getCtxCached: vi.fn(),
  settleCardWatch: vi.fn(), retryMarkedEdits: vi.fn(),
}));
vi.mock("../src/sync", () => sync);
const { DeferredSync } = await import("../src/deferred-sync-do");

function fakeCtx() {
  const map = new Map<string, any>();
  const self = {
    alarmAt: null as number | null,
    storage: {
      get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
      deleteAll: async () => { map.clear(); }, setAlarm: async (t: number) => { self.alarmAt = t; },
      deleteAlarm: async () => { self.alarmAt = null; }, getAlarm: async () => self.alarmAt,
    },
    blockConcurrencyWhile: async (fn: () => any) => fn(),
    map,
  };
  return self;
}
const env = { DRY_RUN: "false", WRITE_HUBSPOT: "true", ENABLE_CRM: "true" } as unknown as Env;
const make = () => {
  const ctx = fakeCtx();
  const q = new (DeferredSync as any)(ctx, env) as InstanceType<typeof DeferredSync>;
  return { ctx, q, fire: async () => { ctx.alarmAt = null; await q.alarm(); } };
};
const sc = (props: Record<string, [number, boolean | null]>) =>
  ({ props: Object.fromEntries(Object.entries(props).map(([p, [at, own]]) => [p, { at, own }])) });

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of Object.values(sync)) f.mockReset().mockResolvedValue("ok");
});

describe("keys", () => {
  it("a converge and a retry are keyed by the item, apart from each other and from any update", () => {
    const c: DeferredItem = { type: "contact", id: "5", watch: { boardId: "b", kind: "converge" } };
    const r: DeferredItem = { type: "contact", id: "5", watch: { boardId: "b", kind: "retry" } };
    expect(deferKey(c)).toBe("contact:5:c");
    expect(deferKey(r)).toBe("contact:5:e");
    expect(deferKey({ type: "contact", id: "5" })).toBe("contact:5:u");
    expect(deferKey({ type: "contact", id: "5", scope: sc({ a: [1, false] }) }), "a scope is not identity").toBe("contact:5:u");
    expect(isUpdateItem(c)).toBe(false);
    expect(isUpdateItem({ type: "contact", id: "5" })).toBe(true);
    expect(isUpdateItem({ type: "contact", id: "5", recheck: true })).toBe(false);
  });
});

describe("enqueue", () => {
  it("stores an update's scope and a watch item; a duplicate watch item is a no-op", async () => {
    const { ctx, q } = make();
    await q.enqueue([{ type: "contact", id: "1", scope: sc({ a: [5, false] }) },
      { type: "contact", id: "5", watch: { boardId: "b", kind: "converge" } }]);
    const r = await q.enqueue([{ type: "contact", id: "5", watch: { boardId: "b", kind: "converge" } }]);
    expect(r).toMatchObject({ queued: 0, duplicate: 1 });
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "1", scope: sc({ a: [5, false] }) },
      { type: "contact", id: "5", watch: { boardId: "b", kind: "converge" } }]);
  });

  it("two waiting updates of one record merge what they named: the union, the newest per property", async () => {
    const { ctx, q } = make();
    await q.enqueue([{ type: "contact", id: "1", scope: sc({ a: [5, false] }) }]);
    await q.enqueue([{ type: "contact", id: "1", scope: sc({ a: [9, true], b: [1, false] }) }]);
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "1", scope: sc({ a: [9, true], b: [1, false] }) }]);
  });

  it("...and an unscoped one wins, either way round", async () => {
    const one = make();
    await one.q.enqueue([{ type: "contact", id: "1", scope: sc({ a: [5, false] }) }]);
    await one.q.enqueue([{ type: "contact", id: "1" }]);
    expect(one.ctx.map.get("q")).toEqual([{ type: "contact", id: "1" }]);
    const two = make();
    await two.q.enqueue([{ type: "contact", id: "1" }]);
    await two.q.enqueue([{ type: "contact", id: "1", scope: sc({ a: [5, false] }) }]);
    expect(two.ctx.map.get("q")).toEqual([{ type: "contact", id: "1" }]);
  });

  it("a scope never rides on a delete or a re-check", async () => {
    const { ctx, q } = make();
    await q.enqueue([{ type: "contact", id: "1", deleted: true, scope: sc({ a: [5, false] }) } as DeferredItem]);
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "1", deleted: true }]);
  });
});

describe("the wave", () => {
  it("an update runs with its scope; a converge and a retry run the card watch's passes", async () => {
    const { q, fire } = make();
    const at = Date.now() - 1000;
    await q.enqueue([{ type: "contact", id: "1", scope: sc({ a: [at, false] }) }, { type: "company", id: "2" },
      { type: "contact", id: "5", watch: { boardId: "b", kind: "converge" } },
      { type: "contact", id: "5", watch: { boardId: "b", kind: "retry" } }]);
    await fire();
    expect(sync.syncHubspotObject.mock.calls[0][3]).toMatchObject({ scope: sc({ a: [at, false] }) });
    expect(sync.syncHubspotObject.mock.calls[1][3].scope).toBeUndefined();
    expect(sync.settleCardWatch).toHaveBeenCalledWith(env, "b", "5", expect.any(Object), expect.any(Object));
    expect(sync.retryMarkedEdits).toHaveBeenCalledWith(env, "b", "5", expect.any(Object), expect.any(Object));
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(2);
  });

  it("[F8] an update whose events are older than 2 x W (a long queue) runs UNSCOPED: an old event names nothing now", async () => {
    const { q, fire } = make();
    const stale = Date.now() - 2 * 180_000 - 1000;                         // W at its default (180 s)
    await q.enqueue([{ type: "contact", id: "1", scope: sc({ jobtitle: [stale, false] }) },
      { type: "contact", id: "2", scope: sc({ jobtitle: [Date.now() - 5000, false], a: [stale, false] }) }]);
    await fire();
    expect(sync.syncHubspotObject.mock.calls[0][3].scope, "old: unscoped (history and Sync State decide)").toBeUndefined();
    expect(sync.syncHubspotObject.mock.calls[1][3].scope, "any old event makes the whole entry unscoped").toBeUndefined();
  });

  it("a converge that throws is retried (bounded), like any item", async () => {
    const { ctx, q, fire } = make();
    sync.settleCardWatch.mockRejectedValue(new Error("monday 500"));
    await q.enqueue([{ type: "contact", id: "5", watch: { boardId: "b", kind: "converge" } }]);
    await fire();
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "5", watch: { boardId: "b", kind: "converge" }, attempts: 1 }]);
  });

  it("a failed update dropped for a fresh entry of the same record hands it its scope", async () => {
    const { ctx, q, fire } = make();
    await q.enqueue([{ type: "contact", id: "1", scope: sc({ a: [5, false] }) }]);
    sync.syncHubspotObject.mockImplementationOnce(async () => {
      await q.enqueue([{ type: "contact", id: "1", scope: sc({ b: [7, false] }) }]);   // armed again mid-wave
      throw new Error("hubspot 503");
    });
    await fire();
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "1", scope: sc({ b: [7, false], a: [5, false] }) }]);
  });
});
