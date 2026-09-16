import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deferKey, spillDeferred, WAVE, WAVE_GAP_MS, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_QUEUE,
  type DeferredItem,
} from "../src/deferred-sync";
import { readCode } from "../scripts/read-source.mjs";
import type { Env } from "../src/types";

/**
 * THE OVERFLOW OF AN OVERSIZED WEBHOOK BATCH.
 *
 * handleHubspot processes a bounded slice of each batch and used to log the remainder as
 * `action=deferred ... reason="batch > 15; backup catches overflow"`. That sentence is true on the
 * Work Management Worker, which runs a ten-minute cron. It was never true here: crons are disabled
 * for Phase 1, so scheduled() never fires and the overflow was discarded — roughly two thirds of
 * every batch during a bulk update, behind a log line that read as though something else would
 * handle it.
 *
 * A dropped change is invisible: the card keeps its old values and nothing records that it is stale.
 * These tests are about the difference between "deferred" and "gone".
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

const sync = vi.hoisted(() => ({ syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(), getCtxCached: vi.fn() }));
vi.mock("../src/sync", () => sync);

const { DeferredSync } = await import("../src/deferred-sync-do");

function fakeCtx() {
  const map = new Map<string, any>();
  const self = {
    alarmAt: null as number | null,
    storage: {
      get: async (k: string) => map.get(k),
      put: async (k: string, v: any) => { map.set(k, v); },
      deleteAll: async () => { map.clear(); },
      setAlarm: async (t: number) => { self.alarmAt = t; },
      deleteAlarm: async () => { self.alarmAt = null; },
      getAlarm: async () => self.alarmAt,
    },
    blockConcurrencyWhile: async (fn: () => any) => fn(),
    map,
  };
  return self;
}

const env = { DRY_RUN: "false", WRITE_HUBSPOT: "true", ENABLE_CRM: "true" } as unknown as Env;
/**
 * `fire()` models what the runtime actually does: an alarm is CONSUMED when it fires, so the handler
 * starts with nothing scheduled. Calling alarm() directly would leave the previous alarm set and
 * quietly hide whether the handler re-arms — the difference between "drained and stopped" and
 * "drained and still spinning".
 */
const make = () => {
  const ctx = fakeCtx();
  const q = new (DeferredSync as any)(ctx, env) as InstanceType<typeof DeferredSync>;
  const fire = async () => { ctx.alarmAt = null; await q.alarm(); };
  return { ctx, q, fire };
};
const items = (n: number, type: "contact" | "company" = "contact"): DeferredItem[] =>
  Array.from({ length: n }, (_, i) => ({ type, id: `${1000 + i}` }));

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncHubspotObject.mockResolvedValue("ok");
  sync.deleteHubspotObject.mockResolvedValue("ok");
});

describe("the queue", () => {
  it("accepts overflow and arms a first wave", async () => {
    const { ctx, q, fire } = make();
    const r = await q.enqueue(items(20));
    expect(r).toMatchObject({ queued: 20, duplicate: 0, dropped: 0, depth: 20 });
    expect(ctx.alarmAt).toBeGreaterThan(Date.now());
    expect(ctx.alarmAt! - Date.now()).toBeLessThanOrEqual(FIRST_DELAY_MS);
  });

  /**
   * A bulk update fires the same record in several consecutive batches. Without deduplication the
   * queue would hold one contact a dozen times and re-sync it a dozen times — the burst amplified
   * rather than absorbed.
   */
  it("deduplicates a record already waiting", async () => {
    const { q, fire } = make();
    await q.enqueue(items(5));
    const again = await q.enqueue(items(5));
    expect(again).toMatchObject({ queued: 0, duplicate: 5, depth: 5 });
  });

  /** An update and a delete of the same record are different work and must both survive. */
  it("treats a delete as distinct from an update", async () => {
    const { q, fire } = make();
    await q.enqueue([{ type: "contact", id: "7" }]);
    const r = await q.enqueue([{ type: "contact", id: "7", deleted: true }]);
    expect(r).toMatchObject({ queued: 1, duplicate: 0, depth: 2 });
    expect(deferKey({ type: "contact", id: "7" }))
      .not.toBe(deferKey({ type: "contact", id: "7", deleted: true }));
  });

  /** A burst of spills must not keep pushing the first wave further away. */
  it("does not re-arm when a wave is already scheduled", async () => {
    const { ctx, q, fire } = make();
    await q.enqueue(items(3));
    const first = ctx.alarmAt;
    await q.enqueue(items(3, "company"));
    expect(ctx.alarmAt).toBe(first);
  });

  it("refuses beyond the capacity ceiling rather than accepting silently", async () => {
    const { q, fire } = make();
    await q.enqueue(items(MAX_QUEUE));
    const r = await q.enqueue([{ type: "contact", id: "overflow" }]);
    expect(r).toMatchObject({ queued: 0, dropped: 1, depth: MAX_QUEUE });
  });
});

describe("draining", () => {
  it("processes one bounded wave and re-arms while work remains", async () => {
    const { ctx, q, fire } = make();
    await q.enqueue(items(WAVE + 4));

    await fire();

    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(WAVE);
    expect(await q.depth()).toBe(4);
    expect(ctx.alarmAt! - Date.now()).toBeLessThanOrEqual(WAVE_GAP_MS);
  });

  it("drains to empty and stops arming", async () => {
    const { ctx, q, fire } = make();
    await q.enqueue(items(WAVE + 2));
    await fire();
    await fire();

    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(WAVE + 2);
    expect(await q.depth()).toBe(0);
    expect(ctx.alarmAt).toBeNull();
  });

  it("routes a deletion to the delete path", async () => {
    const { q, fire } = make();
    await q.enqueue([{ type: "company", id: "55", deleted: true }]);
    await fire();
    expect(sync.deleteHubspotObject).toHaveBeenCalledWith(env, "company", "55", expect.anything(), expect.anything());
    expect(sync.syncHubspotObject).not.toHaveBeenCalled();
  });

  /** One broken record must not take the wave down with it. */
  it("keeps going when a record fails", async () => {
    const { q, fire } = make();
    sync.syncHubspotObject.mockRejectedValueOnce(new Error("HubSpot 500"));
    await q.enqueue(items(3));

    await fire();

    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(3);
    expect(await q.depth()).toBe(1);                       // the failure requeued, the others done
  });

  /**
   * BOUNDED, NEVER INFINITE. A record that keeps failing is abandoned with a loud line: an endless
   * queue would re-read the same broken record forever and crowd out the work behind it, which is
   * worse than one visible loss.
   */
  it("abandons a record after the attempt ceiling", async () => {
    const { ctx, q, fire } = make();
    sync.syncHubspotObject.mockRejectedValue(new Error("permanently broken"));
    await q.enqueue([{ type: "contact", id: "9" }]);

    for (let i = 0; i < MAX_ATTEMPTS; i++) await fire();

    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(await q.depth()).toBe(0);
    expect(ctx.alarmAt).toBeNull();
  });
});

describe("the producer", () => {
  /**
   * SHARED CODE, TWO WORKERS. deferred-sync.ts is compiled into the Work Management Worker too, and
   * that deployment has no such binding — it has a cron instead. Touching a missing binding there
   * would throw inside the webhook handler, which is precisely the failure that stopped live sync
   * for an hour on 2026-09-15.
   */
  it("is a no-op when the binding is absent", async () => {
    await expect(spillDeferred({} as Env, items(3))).resolves.toBeUndefined();
  });

  it("never throws when the durable object is unreachable", async () => {
    const broken = { DEFERRED_SYNC: { idFromName: () => "x", get: () => { throw new Error("DO down"); } } } as unknown as Env;
    await expect(spillDeferred(broken, items(2))).resolves.toBeUndefined();
  });

  it("does nothing for an empty overflow", async () => {
    const ns = { idFromName: vi.fn(), get: vi.fn() };
    await spillDeferred({ DEFERRED_SYNC: ns } as unknown as Env, []);
    expect(ns.get).not.toHaveBeenCalled();
  });
});

describe("what is spilled, and what is deliberately not", () => {
  const code = readCode("webhooks.ts");

  /** Deals and line items keep their existing behaviour exactly — this change is scoped to the two
   *  CRM object types that were observed overflowing. */
  it("spills only contacts and companies", () => {
    expect(code).toContain('.filter(e => e.type === "contact" || e.type === "company")');
  });

  /** The misleading claim is gone: it said a backup would catch the overflow, and none existed. */
  it("no longer claims a backup catches the overflow", () => {
    expect(code).not.toContain("backup catches overflow");
  });

  it("spills the overflow, not the processed slice", () => {
    expect(code).toContain("const overflow = events.slice(MAX);");
  });
});
