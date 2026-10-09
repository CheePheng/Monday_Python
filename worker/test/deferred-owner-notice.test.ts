import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deferKey, MAX_ATTEMPTS, type DeferredItem } from "../src/deferred-sync";
import type { Env } from "../src/types";

/**
 * THE OWNER NOTICE RUNS IN THE QUEUE (DeferredItem.notice). Every trigger enqueues an entry; a wave runs it with
 * minutes to spare and one at a time. It is its own kind of work -- never a sync, never merged into one -- and a
 * notice that did not finish is retried, so a newer owner is never simply dropped:
 *   - "flagged" is run once more, afresh: to read whether the board's workflow finished the flag (EVERY FLAG IS
 *     CHECKED, owner-notice.ts) -- a workflow that never ran used to leave nothing but "flagged" in the log;
 *   - "busy" (the lock is held, the owner kept changing, or the card does not show the new owner yet), "pending"
 *     (通知状态 still waits on the board's workflow for an EARLIER assignment -- it used to count as done, and
 *     swallowed the new owner) and "waiting" (this assignment's own flag not finished yet) are retried WITHOUT
 *     counting an attempt until the entry has been in them for longer than NOTICE_BUSY_GRACE_MS: a run killed
 *     inside the lock -- a deploy restarting this queue -- leaves it held for the whole hold, and three quick counted
 *     retries abandoned the notice inside it. After the grace they count as usual, so it is still bounded;
 *   - "error" is retried the same way for NOTICE_ERROR_GRACE_MS (it used to count as done, then at once: a ~40 s
 *     monday or HubSpot outage lost the notice for good);
 *   - a notice the queue gives up on says how to recover the card.
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
// The real module, so the queue uses the real grace; only the notice itself is faked.
vi.mock("../src/owner-notice", async (orig) => ({
  ...(await orig<typeof import("../src/owner-notice")>()), noticeOwnerChange: notice.noticeOwnerChange,
}));

const { DeferredSync } = await import("../src/deferred-sync-do");
const { NOTICE_BUSY_GRACE_MS, NOTICE_ERROR_GRACE_MS } = await import("../src/owner-notice");

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
const T0 = Date.parse("2026-10-09T08:00:00Z");
/** Every [deferred] line the queue logs while `run` runs. */
const logged = async (run: () => Promise<unknown>) => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => { lines.push(String(s)); });
  try { await run(); } finally { spy.mockRestore(); }
  return lines.filter(l => l.startsWith("[deferred]"));
};

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncHubspotObject.mockReset().mockResolvedValue("ok");
  sync.deleteHubspotObject.mockReset().mockResolvedValue("ok");
  sync.recheckDanglingClears.mockReset().mockResolvedValue("ok");
  sync.getCtxCached.mockReset().mockResolvedValue(owners);
  // A settled outcome by default: "flagged" is run once more to check it (its own test, below).
  notice.noticeOwnerChange.mockReset().mockResolvedValue("already");
});
afterEach(() => { vi.useRealTimers(); });

describe("a notice is its own entry", () => {
  it("has its own key: an update and a notice of one contact are two pieces of work", () => {
    expect(deferKey({ type: "contact", id: "1", notice: true })).toBe("contact:1:n");
    expect(deferKey({ type: "contact", id: "1" })).toBe("contact:1:u");
    // ...and its retry bookkeeping is not part of its identity.
    expect(deferKey({ type: "contact", id: "1", notice: true, attempts: 2, busySince: T0 })).toBe("contact:1:n");
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

  it.each(["already", "baseline", "stuck", "no-user", "no-owner", "no-email", "no-card", "dry-run", "off"])(
    "a notice that answers %j is done: not retried", async (outcome) => {
      const { ctx, q, fire } = make();
      notice.noticeOwnerChange.mockResolvedValue(outcome);
      await q.enqueue([{ type: "contact", id: "1", notice: true }]);
      await fire();
      expect(stored(ctx)).toEqual([]);
    });

  /**
   * EVERY FLAG IS CHECKED (reviewed 2026-10-09). "flagged" used to be done: a workflow that never ran -- switched
   * off, its Outlook connection lapsed -- left only "flagged" in the log, and nobody was told. It is run once more,
   * behind everything waiting, afresh (no attempts, a fresh grace): "already" once the workflow has finished it,
   * "waiting" (retried) while it has not, "stuck" (final, loud) once it is too old.
   */
  it("a notice that answers 'flagged' is run once more, afresh, to check the workflow finished it -- then done", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValueOnce("busy").mockResolvedValueOnce("error")
      .mockResolvedValueOnce("flagged").mockResolvedValueOnce("waiting").mockResolvedValueOnce("already");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();                                                   // busy
    vi.setSystemTime(T0 + 10_000); await fire();                    // error
    vi.setSystemTime(T0 + 20_000);
    const lines = await logged(fire);                               // flagged
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 + 20_000 }]);   // afresh
    expect(lines.some(l => l.includes("contact=1 notice action=check-flag"))).toBe(true);
    vi.setSystemTime(T0 + 30_000); await fire();                    // waiting: retried, free
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 + 20_000 }]);
    vi.setSystemTime(T0 + 40_000); await fire();                    // already: done
    expect(stored(ctx)).toEqual([]);
    expect(noticed()).toHaveLength(5);
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
      return "flagged";
    });
    ctx.alarmAt = null; await q.alarm();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true }]);
  });
});

describe("an 'error' is retried (it used to count as done), free for NOTICE_ERROR_GRACE_MS", () => {
  it("retried WITHOUT counting an attempt, then runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValueOnce("error");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    const lines = await logged(fire);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, errorSince: T0 }]);
    expect(lines.some(l => l.includes("contact=1 notice action=error-retry") && l.includes("attempts=0"))).toBe(true);
    vi.setSystemTime(T0 + 10_000); await fire();
    expect(noticed()).toEqual(["1", "1"]);
    expect(stored(ctx)).toEqual([]);
  });

  /**
   * THE OUTAGE (reviewed 2026-10-09). Counted at once, three retries ~12 s apart abandoned the notice inside a
   * ~40 s monday or HubSpot outage -- and unlike a sync, nothing ever brings a lost notice back.
   */
  it("an outage far longer than MAX_ATTEMPTS retries -- minutes of them -- costs no attempt, and the notice then runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("error");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    let waves = 0;
    for (let t = T0; t < T0 + 10 * 60_000; t += 12_000, waves++) { vi.setSystemTime(t); await fire(); }
    expect(waves).toBeGreaterThan(MAX_ATTEMPTS * 10);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, errorSince: T0 }]);   // no attempts at all
    notice.noticeOwnerChange.mockResolvedValue("flagged");
    await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: Date.now() }]);   // checked next
  });

  it("...but not forever: past its grace a notice that keeps failing is abandoned after the queue's attempts, loudly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("error");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();                                                   // free
    vi.setSystemTime(T0 + NOTICE_ERROR_GRACE_MS);
    const lines = await logged(async () => { for (let i = 0; i < MAX_ATTEMPTS; i++) await fire(); });
    expect(stored(ctx)).toEqual([]);
    expect(noticed()).toHaveLength(1 + MAX_ATTEMPTS);
    const last = lines.find(l => l.includes("contact=1 notice action=abandoned"))!;
    expect(last).toContain(`attempts=${MAX_ATTEMPTS}`);
    expect(last).toContain(`owner notice error for ${NOTICE_ERROR_GRACE_MS / 1000} s, past its ${NOTICE_ERROR_GRACE_MS / 1000} s grace`);
    expect(last).toContain("if this card's Contact owner was not told");
  });

  it("the two clocks are kept apart: an error after a busy is free, and the busy clock still runs from the first busy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValueOnce("busy").mockResolvedValueOnce("error").mockResolvedValueOnce("busy");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();
    vi.setSystemTime(T0 + 20_000); await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0, errorSince: T0 + 20_000 }]);
    vi.setSystemTime(T0 + NOTICE_BUSY_GRACE_MS + 60_000); await fire();   // busy past ITS grace: counted
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0, errorSince: T0 + 20_000, attempts: 1 }]);
  });
});

describe("'busy' is free until it has outlasted the notice lock, then bounded", () => {
  it("a notice that found the contact busy is retried WITHOUT counting an attempt, then runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValueOnce("busy");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    const lines = await logged(fire);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 }]);
    expect(lines.some(l => l.includes("contact=1 notice action=busy-retry") && l.includes("attempts=0"))).toBe(true);
    vi.setSystemTime(T0 + 20_000);
    await fire();
    expect(noticed()).toEqual(["1", "1"]);
    expect(stored(ctx)).toEqual([]);
  });

  /** THE KILLED RUN: its lock stands for the whole hold, and the queue comes back every ~20 s. */
  it("busy through a whole lock hold -- far more retries than MAX_ATTEMPTS -- costs no attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("busy");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    let waves = 0;
    for (let t = T0; t < T0 + NOTICE_BUSY_GRACE_MS; t += 20_000, waves++) { vi.setSystemTime(t); await fire(); }
    expect(waves).toBeGreaterThan(MAX_ATTEMPTS);
    expect(noticed()).toHaveLength(waves);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 }]);   // no attempts at all
    // ...and the lock the killed run left has long expired by now: the next run takes it and flags -- and the
    // check of that flag follows, afresh (no attempts, a new grace).
    notice.noticeOwnerChange.mockResolvedValue("flagged");
    vi.setSystemTime(T0 + NOTICE_BUSY_GRACE_MS - 1);
    await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 + NOTICE_BUSY_GRACE_MS - 1 }]);
  });

  it("...then counted as usual: still busy past the grace, it is abandoned after the queue's attempts, loudly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("busy");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();                                                  // busy from T0: free
    vi.setSystemTime(T0 + NOTICE_BUSY_GRACE_MS);
    await fire();                                                  // the grace is out: attempt 1
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0, attempts: 1 }]);
    const lines = await logged(async () => { for (let i = 1; i < MAX_ATTEMPTS; i++) await fire(); });
    expect(stored(ctx)).toEqual([]);
    expect(noticed()).toHaveLength(1 + MAX_ATTEMPTS);
    expect(lines.some(l => l.includes("contact=1 notice action=abandoned") && l.includes("busy"))).toBe(true);
  });

  /**
   * "PENDING" USED TO COUNT AS DONE: a 待通知 still waiting for an EARLIER assignment was taken to cover the new one,
   * and the entry was dropped -- though the workflow may already have picked the earlier owner, or be stuck. Now it
   * is a wait like "busy": retried free until the workflow has recorded whom it told (the notice then answers
   * "already", or flags), or the flag is old enough to be "stuck" -- which is final.
   */
  it("a notice that answers 'pending' is retried like 'busy' -- free, without an attempt -- then runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValueOnce("pending").mockResolvedValueOnce("pending").mockResolvedValueOnce("flagged");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    const lines = await logged(fire);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 }]);
    expect(lines.some(l => l.includes("contact=1 notice action=pending-retry") && l.includes("attempts=0"))).toBe(true);
    vi.setSystemTime(T0 + 20_000); await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 }]);   // still no attempt
    vi.setSystemTime(T0 + 40_000); await fire();
    expect(noticed()).toEqual(["1", "1", "1"]);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 + 40_000 }]);   // the flag's check
  });

  it("...and bounded like 'busy': pending past the grace counts, and is abandoned after the queue's attempts, loudly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("pending");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();
    vi.setSystemTime(T0 + NOTICE_BUSY_GRACE_MS);
    const lines = await logged(async () => { for (let i = 0; i < MAX_ATTEMPTS; i++) await fire(); });
    expect(stored(ctx)).toEqual([]);
    expect(lines.some(l => l.includes("contact=1 notice action=abandoned") && l.includes("pending"))).toBe(true);
  });

  /**
   * A PENDING THAT OUTLIVES ITS GRACE IS A WEDGED CARD (reviewed 2026-10-09). A 待通知 nobody can date -- monday gave
   * no changed_at, and it is not the Worker's own open flag -- is never "stuck" (that needs an age): it is "pending"
   * until the queue gives up. A bare "abandoned" left it looking like a queue hiccup; the last line says what it is
   * and how to recover the card, whole (not cut at 120 characters like other entries' reasons).
   */
  it("the last line of a 'pending' given up on says the card is wedged, and how to recover it -- checking whom it told first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("pending");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();
    vi.setSystemTime(T0 + NOTICE_BUSY_GRACE_MS);
    const lines = await logged(async () => { for (let i = 0; i < MAX_ATTEMPTS; i++) await fire(); });
    const last = lines.find(l => l.includes("contact=1 notice action=abandoned"))!;
    expect(last).toContain("通知状态 has stood at 待通知 for an earlier assignment all this time, of unknown age");
    expect(last).toContain("This assignment is NOT flagged and nothing re-runs it");
    expect(last).toContain("To recover: check this card's 上次通知Owner and the board's workflow run history first");
    expect(last).toContain("clear 通知状态 and set it to 待通知 by hand");
    expect(last.endsWith('by hand"')).toBe(true);                   // whole, not cut short
  });

  it("'waiting' -- this assignment's own flag not finished yet -- is retried free like 'busy', and given up on with how to recover", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("waiting");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    const first = await logged(fire);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 }]);
    expect(first.some(l => l.includes("contact=1 notice action=waiting-retry") && l.includes("attempts=0"))).toBe(true);
    vi.setSystemTime(T0 + NOTICE_BUSY_GRACE_MS);
    const lines = await logged(async () => { for (let i = 0; i < MAX_ATTEMPTS; i++) await fire(); });
    expect(stored(ctx)).toEqual([]);
    expect(lines.find(l => l.includes("contact=1 notice action=abandoned"))).toContain("this assignment's own 待通知 still stands");
  });

  /** One run of waits: a notice that is busy (its card behind), then pending (the workflow mid-send), keeps its start. */
  it("busy then pending is one unbroken run: busySince is kept from the first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValueOnce("busy").mockResolvedValueOnce("pending");
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    await fire();
    vi.setSystemTime(T0 + 20_000); await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true, busySince: T0 }]);
  });

  /** The retry goes BEHIND everything waiting -- the contact's own sync, which the busy notice may have queued. */
  it("a busy notice's retry runs after the contact's update queued during its run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    notice.noticeOwnerChange.mockImplementationOnce(async () => {
      await q.enqueue([{ type: "contact", id: "1" }]);     // the notice found the card behind: its sync is queued
      return "busy";
    });
    await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1" }, { type: "contact", id: "1", notice: true, busySince: T0 }]);
    const order: string[] = [];
    sync.syncHubspotObject.mockImplementation(async () => { order.push("update"); return "ok"; });
    notice.noticeOwnerChange.mockImplementation(async () => { order.push("notice"); return "flagged"; });
    vi.setSystemTime(T0 + 10_000); await fire();
    expect(order).toEqual(["update", "notice"]);
  });

  it("a busy notice queued again during its wave leaves the fresh entry, not two", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    await q.enqueue([{ type: "contact", id: "1", notice: true }]);
    notice.noticeOwnerChange.mockImplementationOnce(async () => {
      await q.enqueue([{ type: "contact", id: "1", notice: true }]);
      return "busy";
    });
    await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", notice: true }]);
  });

  /**
   * A FRESH TRIGGER STARTS A WAITING NOTICE AFRESH (reviewed 2026-10-09). A new reassignment merged into an entry
   * that an outage or a busy card had already spent attempts on got only what was left -- one more failure and the
   * new owner was lost too.
   */
  it("a fresh trigger for a notice already waiting -- attempts spent, graces used -- starts it afresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const { ctx, q, fire } = make();
    notice.noticeOwnerChange.mockResolvedValue("busy");
    await q.enqueue([{ type: "contact", id: "1", notice: true }, { type: "contact", id: "2", notice: true }]);
    await fire();
    vi.setSystemTime(T0 + NOTICE_BUSY_GRACE_MS); await fire(); await fire();
    expect(stored(ctx)).toEqual([
      { type: "contact", id: "1", notice: true, busySince: T0, attempts: 2 },
      { type: "contact", id: "2", notice: true, busySince: T0, attempts: 2 },
    ]);
    const r = await q.enqueue([{ type: "contact", id: "2", notice: true }]);   // a new reassignment of contact 2
    expect(r).toMatchObject({ queued: 0, duplicate: 1 });
    expect(stored(ctx)).toEqual([
      { type: "contact", id: "1", notice: true, busySince: T0, attempts: 2 },
      { type: "contact", id: "2", notice: true },
    ]);
    await fire();                                                   // contact 1's last attempt; contact 2 free again
    expect(stored(ctx)).toEqual([{ type: "contact", id: "2", notice: true, busySince: T0 + NOTICE_BUSY_GRACE_MS }]);
  });

  it("...while an update arriving for a record whose update is waiting stays a plain duplicate (nothing reset)", async () => {
    const { ctx, q } = make();
    await q.enqueue([{ type: "contact", id: "1" }]);
    ctx.map.set("q", [{ type: "contact", id: "1", attempts: 2 }]);
    await q.enqueue([{ type: "contact", id: "1" }]);
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1", attempts: 2 }]);
  });
});

/**
 * A BUSY NOTICE ASKS FOR ITS CONTACT'S SYNC, AND ONLY ASKS (DeferredItem.ensure; reviewed 2026-10-09). Queued like
 * any arm, the request was "owed again" beside the contact's own sync while that sync ran in the same wave: the
 * write-back then dropped the failing sync's retry for the fresh entry, resetting its attempts every wave, and a sync
 * that kept failing ran ~40 times in 7 minutes instead of MAX_ATTEMPTS.
 */
describe("a busy notice's request for its contact's sync", () => {
  it("is a duplicate of that sync while the wave is running it: the failing sync keeps its attempts, and is abandoned", async () => {
    const { ctx, q, fire } = make();
    sync.syncHubspotObject.mockRejectedValue(new Error("monday 400: ColumnValueException"));
    notice.noticeOwnerChange.mockImplementation(async () => {
      await q.enqueue([{ type: "contact", id: "1", ensure: true }]);
      return "busy";
    });
    await q.enqueue([{ type: "contact", id: "1" }, { type: "contact", id: "1", notice: true }]);
    await fire();
    expect(stored(ctx).find(x => !x.notice)).toEqual({ type: "contact", id: "1", attempts: 1 });
    await fire(); await fire();
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(stored(ctx).some(x => !x.notice)).toBe(false);          // abandoned after MAX_ATTEMPTS, as any sync
  });

  it("...and queued when nothing is bringing it (an inline sync that failed): neither running nor waiting", async () => {
    const { ctx, q } = make();
    const r = await q.enqueue([{ type: "contact", id: "1", ensure: true }]);
    expect(r).toMatchObject({ queued: 1 });
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1" }]);    // `ensure` itself is never stored
    expect((await q.enqueue([{ type: "contact", id: "1", ensure: true }])).duplicate).toBe(1);
  });

  it("an ordinary arm of a record whose pass is running is still owed again (unchanged)", async () => {
    const { ctx, q, fire } = make();
    await q.enqueue([{ type: "contact", id: "1" }]);
    sync.syncHubspotObject.mockImplementationOnce(async () => {
      await q.enqueue([{ type: "contact", id: "1" }]);
      return "ok";
    });
    await fire();
    expect(stored(ctx)).toEqual([{ type: "contact", id: "1" }]);
  });
});

describe("everything else is retried exactly as before", () => {
  it("a failing update, delete or re-check is an attempt, and never carries busySince", async () => {
    const { ctx, q, fire } = make();
    sync.syncHubspotObject.mockRejectedValueOnce(new Error("HubSpot 502"));
    sync.deleteHubspotObject.mockRejectedValueOnce(new Error("monday 500"));
    sync.recheckDanglingClears.mockRejectedValueOnce(new Error("monday 500"));
    await q.enqueue([{ type: "contact", id: "1" }, { type: "contact", id: "2", deleted: true }, { type: "deal", id: "3", recheck: true }]);
    await fire();
    expect(stored(ctx)).toEqual([
      { type: "contact", id: "1", attempts: 1 },
      { type: "contact", id: "2", deleted: true, attempts: 1 },
      { type: "deal", id: "3", recheck: true, attempts: 1 },
    ]);
    expect(notice.noticeOwnerChange).not.toHaveBeenCalled();
  });
});
