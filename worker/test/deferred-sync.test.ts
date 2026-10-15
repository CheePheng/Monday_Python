import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deferKey, spillDeferred, spillDeferredLeftover, WAVE, WAVE_GAP_MS, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_QUEUE,
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

const sync = vi.hoisted(() => ({
  syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(), recheckDanglingClears: vi.fn(), getCtxCached: vi.fn(),
}));
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
  sync.syncHubspotObject.mockReset().mockResolvedValue("ok");
  sync.deleteHubspotObject.mockReset().mockResolvedValue("ok");
  sync.recheckDanglingClears.mockReset().mockResolvedValue("ok");
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

  /** ...and says WHICH it refused -- always the tail of the batch -- so a caller's fallback runs for those only. */
  it("names the items it dropped at the ceiling: the tail of the batch, by their keys", async () => {
    const { q } = make();
    await q.enqueue(items(MAX_QUEUE - 2));
    const batch: DeferredItem[] = [{ type: "contact", id: "a", notice: true }, { type: "contact", id: "b", notice: true },
      { type: "contact", id: "c", notice: true }, { type: "contact", id: "d", notice: true }];
    const r = await q.enqueue(batch);
    expect(r).toMatchObject({ queued: 2, dropped: 2, depth: MAX_QUEUE });
    expect(r.droppedKeys).toEqual(["contact:c:n", "contact:d:n"]);
    expect((await q.enqueue([{ type: "contact", id: "e" }])).droppedKeys).toEqual(["contact:e:u"]);
    expect((await make().q.enqueue(items(3))).droppedKeys).toEqual([]);
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

/**
 * A LIFECYCLE RE-CHECK (sync.ts armRecheck): queued before a backward move's clear, so a clear whose set
 * never followed is still finished if the run dies. It is a REPAIR, not a forward pass: a pass run at a
 * fixed ~15 s after the move overwrote a person's next edit still in flight (HubSpot bumps the record's
 * lastmodifieddate on its own ~7 s after every stage change, so the pass always read HubSpot as newer).
 */
describe("a lifecycle re-check", () => {
  it("runs the re-check alone -- never the full forward pass", async () => {
    const { q, fire } = make();
    await q.enqueue([{ type: "contact", id: "42000269320", recheck: true }]);
    await fire();
    expect(sync.recheckDanglingClears).toHaveBeenCalledWith(env, "contact", "42000269320", expect.anything(), expect.anything());
    expect(sync.syncHubspotObject).not.toHaveBeenCalled();
    expect(sync.deleteHubspotObject).not.toHaveBeenCalled();
  });

  it("is different work from an update of the same record: neither absorbs the other", async () => {
    const { q, fire } = make();
    expect(await q.enqueue([{ type: "contact", id: "7" }])).toMatchObject({ queued: 1 });
    expect(await q.enqueue([{ type: "contact", id: "7", recheck: true }])).toMatchObject({ queued: 1, duplicate: 0, depth: 2 });
    expect(await q.enqueue([{ type: "contact", id: "7", recheck: true }])).toMatchObject({ queued: 0, duplicate: 1 });
    await fire();
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(1);
    expect(sync.recheckDanglingClears).toHaveBeenCalledTimes(1);
  });

  it("one that cannot finish is retried AS a re-check, and bounded like any pass", async () => {
    const { ctx, q, fire } = make();
    sync.recheckDanglingClears.mockRejectedValue(new Error("lifecycle re-check of contacts/9 could not finish"));
    await q.enqueue([{ type: "contact", id: "9", recheck: true }]);
    await fire();
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "9", recheck: true, attempts: 1 }]);
    for (let i = 1; i < MAX_ATTEMPTS; i++) await fire();
    expect(sync.recheckDanglingClears).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(sync.syncHubspotObject).not.toHaveBeenCalled();
    expect(await q.depth()).toBe(0);
  });
});

/**
 * WORK ARMED WHILE A WAVE IS RUNNING. A wave's passes read HubSpot and monday, and enqueue is delivered
 * while they wait on the network. Two ways that lost work, both proven against this DO:
 *   D1. enqueue checked for duplicates against the entries the running wave was already processing, so a
 *       record armed again (hiffer's 6 -> 5, after the 10 -> 6 whose re-check was reading HubSpot) was
 *       reported a duplicate -- and the pass that "covered" it had read HubSpot BEFORE the 6 -> 5 clear;
 *   D2. alarm() wrote back the queue it had read when it started, so anything enqueued during the wave was
 *       overwritten -- or wiped with deleteAll when that queue had been empty.
 */
describe("work armed while a wave is running", () => {
  /** A pass that waits, as one reading HubSpot does, until the test lets it go; then every pass is quick. */
  function gate(fail = false) {
    let release: (() => void) | null = null;
    let open = false;
    const started = vi.fn();
    const impl = async () => {
      started();
      if (!open) await new Promise<void>(r => { release = r; });
      if (fail) throw new Error("HubSpot 503");
      return "ok";
    };
    return { impl, started, open: () => { open = true; release?.(); } };
  }

  it("D1: the SAME record armed again while its entry is in flight is owed again, not a duplicate", async () => {
    const { ctx, q, fire } = make();
    const g = gate();
    sync.recheckDanglingClears.mockImplementation(g.impl);
    await q.enqueue([{ type: "contact", id: "553232416501", recheck: true }]);          // 10 -> 6
    const wave = fire();
    await vi.waitFor(() => expect(g.started).toHaveBeenCalledTimes(1));               // reading HubSpot
    const r = await q.enqueue([{ type: "contact", id: "553232416501", recheck: true }]); // 6 -> 5, before its clear
    expect(r).toMatchObject({ queued: 1, duplicate: 0 });
    g.open();
    await wave;
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "553232416501", recheck: true }]);
    expect(ctx.alarmAt).not.toBeNull();
    await fire();                                     // the pass that starts after the 6 -> 5 clear
    expect(sync.recheckDanglingClears).toHaveBeenCalledTimes(2);
    expect(await q.depth()).toBe(0);
    expect(ctx.alarmAt).toBeNull();
  });

  it("D2: a record armed during a wave survives the wave's write-back (here: the wave's queue was otherwise empty)", async () => {
    const { ctx, q, fire } = make();
    const g = gate();
    sync.syncHubspotObject.mockImplementation(g.impl);
    await q.enqueue([{ type: "contact", id: "1" }]);                                    // a webhook's overflow
    const wave = fire();
    await vi.waitFor(() => expect(g.started).toHaveBeenCalledTimes(1));
    expect(await q.enqueue([{ type: "contact", id: "42000269320", recheck: true }])).toMatchObject({ queued: 1 });
    g.open();
    await wave;
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "42000269320", recheck: true }]);
    expect(ctx.alarmAt).not.toBeNull();
    await fire();
    expect(sync.recheckDanglingClears).toHaveBeenCalledWith(env, "contact", "42000269320", expect.anything(), expect.anything());
  });

  it("D2: ...and behind a wave that leaves work of its own, in arrival order", async () => {
    const { ctx, q, fire } = make();
    const g = gate();
    sync.syncHubspotObject.mockImplementation(g.impl);
    await q.enqueue(items(WAVE + 2));
    const wave = fire();
    await vi.waitFor(() => expect(g.started).toHaveBeenCalledTimes(1));
    await q.enqueue([{ type: "company", id: "55", recheck: true }]);
    g.open();
    await wave;
    expect(ctx.map.get("q")).toEqual([...items(WAVE + 2).slice(WAVE), { type: "company", id: "55", recheck: true }]);
  });

  it("still a duplicate: a record WAITING behind the wave, and one already owed again", async () => {
    const { ctx, q, fire } = make();
    const g = gate();
    sync.syncHubspotObject.mockImplementation(g.impl);
    const all = items(WAVE + 1);
    await q.enqueue(all);
    const wave = fire();
    await vi.waitFor(() => expect(g.started).toHaveBeenCalledTimes(1));
    expect(await q.enqueue([all[WAVE]])).toMatchObject({ queued: 0, duplicate: 1 });    // waiting: not in this wave
    expect(await q.enqueue([all[0]])).toMatchObject({ queued: 1, duplicate: 0 });       // in flight: owed again
    expect(await q.enqueue([all[0]])).toMatchObject({ queued: 0, duplicate: 1 });       // ...once
    g.open();
    await wave;
    expect(ctx.map.get("q")).toEqual([all[WAVE], all[0]]);
  });

  it("an in-flight pass that FAILS and was armed again meanwhile leaves one fresh entry, not two", async () => {
    const { ctx, q, fire } = make();
    const g = gate(true);
    sync.recheckDanglingClears.mockImplementation(g.impl);
    await q.enqueue([{ type: "contact", id: "9", recheck: true }]);
    const wave = fire();
    await vi.waitFor(() => expect(g.started).toHaveBeenCalledTimes(1));
    await q.enqueue([{ type: "contact", id: "9", recheck: true }]);
    g.open();
    await wave;
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "9", recheck: true }]);
  });

  it("an alarm that fires while a wave is still running does nothing; the running wave re-arms", async () => {
    const { ctx, q, fire } = make();
    const g = gate();
    sync.syncHubspotObject.mockImplementation(g.impl);
    await q.enqueue(items(2));
    const wave = fire();
    await vi.waitFor(() => expect(g.started).toHaveBeenCalledTimes(1));
    await q.enqueue([{ type: "contact", id: "late", recheck: true }]);
    await fire();                                    // a second invocation, overlapping the first
    expect(g.started).toHaveBeenCalledTimes(1);
    expect(sync.recheckDanglingClears).not.toHaveBeenCalled();
    g.open();
    await wave;
    expect(ctx.map.get("q")).toEqual([{ type: "contact", id: "late", recheck: true }]);
    expect(ctx.alarmAt).not.toBeNull();
  });
});

describe("the producer", () => {
  /**
   * SHARED CODE, TWO WORKERS. deferred-sync.ts is compiled into the Work Management Worker too, and
   * that deployment has no such binding — it has a cron instead. Touching a missing binding there
   * would throw inside the webhook handler, which is precisely the failure that stopped live sync
   * for an hour on 2026-09-15.
   */
  // `false` = "not queued", for a caller with a fallback (the owner notice runs inline then).
  it("is a no-op when the binding is absent, and says it queued nothing", async () => {
    await expect(spillDeferred({} as Env, items(3))).resolves.toBe(false);
  });

  it("never throws when the durable object is unreachable, and says it queued nothing", async () => {
    const broken = { DEFERRED_SYNC: { idFromName: () => "x", get: () => { throw new Error("DO down"); } } } as unknown as Env;
    await expect(spillDeferred(broken, items(2))).resolves.toBe(false);
  });

  it("does nothing for an empty overflow", async () => {
    const ns = { idFromName: vi.fn(), get: vi.fn() };
    await spillDeferred({ DEFERRED_SYNC: ns } as unknown as Env, []);
    expect(ns.get).not.toHaveBeenCalled();
  });

  /**
   * THE LEFTOVER: which items the queue does NOT hold, for a caller whose fallback must run for exactly those. Told
   * only "not all of it", the owner notice ran every id inline, the queued ones first, and the webhook's ~30 s
   * cut-off ended the loop before it reached any the queue had dropped.
   */
  it("spillDeferredLeftover: exactly the dropped tail when the queue is full, [] when it holds them all", async () => {
    const { q } = make();
    const live = { DEFERRED_SYNC: { idFromName: () => "x", get: () => q } } as unknown as Env;
    const batch = items(4);
    expect(await spillDeferredLeftover(live, batch)).toEqual([]);
    expect(await spillDeferredLeftover(live, batch)).toEqual([]);                // already waiting: held
    await q.enqueue(items(MAX_QUEUE - 6, "company"));
    const more = [{ type: "contact" as const, id: "n1", notice: true }, { type: "contact" as const, id: "n2", notice: true },
      { type: "contact" as const, id: "n3", notice: true }, { type: "contact" as const, id: "n4", notice: true }];
    expect(await spillDeferredLeftover(live, more)).toEqual(more.slice(2));
    expect(await spillDeferred(live, more.slice(0, 2))).toBe(true);              // the two it took are held
  });

  it("spillDeferredLeftover: every item with no binding or an unreachable queue", async () => {
    const batch = items(3);
    expect(await spillDeferredLeftover({} as Env, batch)).toEqual(batch);
    const broken = { DEFERRED_SYNC: { idFromName: () => "x", get: () => { throw new Error("DO down"); } } } as unknown as Env;
    expect(await spillDeferredLeftover(broken, batch)).toEqual(batch);
  });

  /**
   * AN INSTANCE FROM BEFORE droppedKeys (mid-deploy) says only HOW MANY it dropped. Once full it drops every later
   * item that is not a duplicate -- the tail -- so the tail is the answer. Answering every item put the ones it HAD
   * taken first in the owner notice's inline line, ahead of the ones it dropped, and the webhook's ~30 s cut-off
   * could end the loop before reaching those.
   */
  it("spillDeferredLeftover: from a queue that says only how many it dropped, the TAIL of that many", async () => {
    const batch = items(5);
    const old = (dropped: number) => ({ DEFERRED_SYNC: { idFromName: () => "x",
      get: () => ({ enqueue: async () => ({ queued: 5 - dropped, duplicate: 0, dropped, depth: MAX_QUEUE }) }) } }) as unknown as Env;
    expect(await spillDeferredLeftover(old(2), batch)).toEqual(batch.slice(3));
    expect(await spillDeferredLeftover(old(5), batch)).toEqual(batch);
    expect(await spillDeferredLeftover(old(0), batch)).toEqual([]);
    expect(await spillDeferredLeftover(old(1), [])).toEqual([]);
  });
});

describe("what is spilled, and what is deliberately not", () => {
  const code = readCode("webhooks.ts");

  /** Deals and line items keep their existing behaviour exactly — this change is scoped to the two
   *  CRM object types that were observed overflowing. */
  // Deals and line items joined on 2026-09-23: the CRM app's deal/line-item subscriptions make a bulk
  // deal edit overflow the batch exactly as contacts did, and CRM has no cron to catch the remainder.
  it("spills contacts, companies, deals and line items -- nothing else", () => {
    expect(code).toContain('.filter(e => e.type === "contact" || e.type === "company" || e.type === "deal" || e.type === "line_item")');
  });

  /** The misleading claim is gone: it said a backup would catch the overflow, and none existed. */
  it("no longer claims a backup catches the overflow", () => {
    expect(code).not.toContain("backup catches overflow");
  });

  it("spills the overflow, not the processed slice", () => {
    expect(code).toContain("const overflow = events.slice(MAX);");
  });
});
