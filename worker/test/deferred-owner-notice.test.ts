import { describe, it, expect, vi, beforeEach } from "vitest";
import { deferKey, MAX_ATTEMPTS, type DeferredItem } from "../src/deferred-sync";
import type { Env } from "../src/types";

/**
 * THE OWNER NOTICE RUNS IN THE QUEUE (DeferredItem.notice). Every trigger enqueues an entry; a wave runs it with
 * minutes to spare and one at a time. It is its own kind of work -- never a sync, never merged into one -- and a
 * notice that finds the contact busy is retried like a failure, so a newer owner is never simply dropped.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));
const sync = vi.hoisted(() => ({
  syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(), recheckDanglingClears: vi.fn(), getCtxCached: vi.fn(),
}));
const notice = vi.hoisted(() => ({ noticeOwnerChange: vi.fn() }));
vi.mock("../src/sync", () => sync);
vi.mock("../src/owner-notice", () => notice);

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
const env = { DRY_RUN: "false", WRITE_HUBSPOT: "true", ENABLE_CRM: "true", OWNER_NOTICE: "true" } as unknown as Env;
const owners = { ownersById: {} };
const make = () => {
  const ctx = fakeCtx();
  const q = new (DeferredSync as any)(ctx, env) as InstanceType<typeof DeferredSync>;
  return { ctx, q, fire: async () => { ctx.alarmAt = null; await q.alarm(); } };
};
const stored = (ctx: ReturnType<typeof fakeCtx>) => (ctx.map.get("q") ?? []) as DeferredItem[];
const noticed = () => notice.noticeOwnerChange.mock.calls.map(c => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncHubspotObject.mockReset().mockResolvedValue("ok");
  sync.deleteHubspotObject.mockReset().mockResolvedValue("ok");
  sync.recheckDanglingClears.mockReset().mockResolvedValue("ok");
  sync.getCtxCached.mockReset().mockResolvedValue(owners);
  notice.noticeOwnerChange.mockReset().mockResolvedValue("notified");
});

describe("a notice is its own entry", () => {
  it("has its own key: an update and a notice of one contact are two pieces of work", () => {
    expect(deferKey({ type: "contact", id: "1", notice: true })).toBe("contact:1:n");
    expect(deferKey({ type: "contact", id: "1" })).toBe("contact:1:u");
  });

  it("is stored as one, and a burst for one contact is still one entry", async () => {
    const { ctx, q } = make();
    await q.enqueue([{ type: "contact", id: "1", notice: true }, { type: "contact", id: "1" }]);
    const r = await q.enqueue([{ type: "contact", id: "1", notice: true }, { type: "contact", id: "1", notice: true }]);
    expect(r.duplicate).toBe(2);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true }, { type: "contact", id: "1" }]);
  });
});

describe("the wave", () => {
  it("runs the notice -- and never a sync -- for a notice entry, with one owner list for the wave", async () => {
    const { q, fire } = make();
    await q.enqueue([{ type: "contact", id: "1", notice: true }, { type: "contact", id: "2" }, { type: "contact", id: "3", notice: true }]);
    await fire();
    expect(noticed()).toEqual(["1", "3"]);
    expect(notice.noticeOwnerChange).toHaveBeenCalledWith(env, "1", owners);
    expect(sync.syncHubspotObject.mock.calls.map(c => c[2])).toEqual(["2"]);
    expect(sync.getCtxCached).toHaveBeenCalledTimes(1);
  });

  it("a notice that found the contact busy is retried, then runs", async () => {
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValueOnce("busy");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, attempts: 1 }]);
    await fire();
    expect(noticed()).toEqual(["1", "1"]);
    expect(stored(ctx)).toEqual([]);
  });

  it("...but not forever: a contact that stays busy is abandoned after the queue's attempts, loudly", async () => {
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("busy");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await fire();
    expect(stored(ctx)).toEqual([]);
    expect(noticed()).toHaveLength(MAX_ATTEMPTS);
  });

  it("a failed owner list still runs the notice (the address then comes from HubSpot's owner API)", async () => {
    const { q, fire } = make();
    sync.getCtxCached.mockRejectedValueOnce(new Error("403"));
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();
    expect(notice.noticeOwnerChange).toHaveBeenCalledWith(env, "1", undefined);
  });

  it("a notice queued again while its own runs is owed again (it may have read HubSpot before the change)", async () => {
    const { ctx, q } = make();
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    notice.noticeOwnerChange.mockImplementationOnce(async () => {
      await q.enqueue([{ type: "contact", id: "1", notice: true }]);
      return "notified";
    });
    ctx.alarmAt = null; await q.alarm();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true }]);
  });
});
