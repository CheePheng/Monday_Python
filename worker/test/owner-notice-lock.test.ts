import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";

/**
 * THE OWNER NOTICE RENEWS ITS LOCK RIGHT BEFORE IT WRITES -- AND A RENEWAL NEVER TAKES A LOCK
 * (CreateIdempotency.renewLock, activity-registry renewLock).
 *
 * claimLock (acquireLock) grants a lock whose record is GONE, which is right for a first claim. It was also the
 * renewal, and that was wrong: run A overran its 90 s hold on rate-limit waits; run B took the expired lock, set
 * 待通知, remembered the assignment and RELEASED the lock, deleting its record; the workflow sent and set 已通知.
 * A's "renewal" found no record, was granted, and A wrote 待通知 again from its stale reads -- a second email.
 * A renewal extends only a lock that still names its run.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
vi.mock("../src/sync", () => ({ settleAbandonedCreate: vi.fn() }));

const { CreateIdempotency } = await import("../src/create-idempotency-do");
const { acquireLock, renewLock, releaseLock } = await import("../src/activity-registry");

const HOLD = 90_000;
const T0 = Date.parse("2026-10-09T08:00:00Z");

/** One lock row, as the Durable Object stores it. */
function lockRow() {
  const map = new Map<string, any>();
  const ctx = {
    storage: {
      get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
      delete: async (k: string) => { map.delete(k); }, deleteAll: async () => { map.clear(); },
      setAlarm: async () => {}, deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: async (fn: () => any) => fn(),
  };
  return { d: new (CreateIdempotency as any)(ctx, {}), map };
}

describe("CreateIdempotency.renewLock: only a lock this run still holds", () => {
  it("extends the run's own lock -- even past its hold, since nobody took it over", async () => {
    const { d, map } = lockRow();
    expect(await d.claimLock(T0, HOLD, "A")).toBe(true);
    expect(await d.renewLock(T0 + HOLD + 30_000, "A")).toBe(true);
    expect(map.get("lock")).toEqual({ at: T0 + HOLD + 30_000, owner: "A" });
    // ...so the extended hold keeps a newcomer out again.
    expect(await d.claimLock(T0 + HOLD + 40_000, HOLD, "B")).toBe(false);
  });

  it("refuses while another run holds it", async () => {
    const { d } = lockRow();
    expect(await d.claimLock(T0, HOLD, "A")).toBe(true);
    expect(await d.claimLock(T0 + HOLD + 1, HOLD, "B")).toBe(true);      // A's hold ran out: B takes over
    expect(await d.renewLock(T0 + HOLD + 2, "A")).toBe(false);
  });

  /** THE OVERRUN: where a re-take is granted, the renewal is refused. */
  it("refuses once the lock is gone -- taken over and released meanwhile -- where claimLock would grant it", async () => {
    const { d, map } = lockRow();
    expect(await d.claimLock(T0, HOLD, "A")).toBe(true);
    expect(await d.claimLock(T0 + HOLD + 1, HOLD, "B")).toBe(true);
    expect(await d.releaseLock("B")).toBe(true);
    expect(map.has("lock")).toBe(false);
    expect(await d.renewLock(T0 + HOLD + 5, "A")).toBe(false);
    expect(map.has("lock")).toBe(false);                                // ...and takes nothing
    expect(await d.claimLock(T0 + HOLD + 5, HOLD, "A")).toBe(true);      // the re-take that used to be the renewal
  });

  it("refuses when there never was a lock", async () => {
    expect(await lockRow().d.renewLock(T0, "A")).toBe(false);
  });
});

describe("activity-registry renewLock", () => {
  const envFor = (d: unknown) => ({
    CREATE_IDEMPOTENCY: { idFromName: (k: string) => k, get: () => d },
  }) as unknown as Env;

  it("renews through the lock's own row, with the run's id", async () => {
    const { d } = lockRow();
    const env = envFor(d);
    expect(await acquireLock(env, "notice:1", HOLD, "run-a")).toBe(true);
    expect(await renewLock(env, "notice:1", "run-a")).toBe(true);
    expect(await renewLock(env, "notice:1", "run-b")).toBe(false);
    await releaseLock(env, "notice:1", "run-a");
    expect(await renewLock(env, "notice:1", "run-a")).toBe(false);
  });

  it("FAILS CLOSED: an unreachable store is no renewal, never a throw", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const down = { CREATE_IDEMPOTENCY: { idFromName: (k: string) => k,
        get: () => ({ renewLock: async () => { throw new Error("DO down"); } }) } } as unknown as Env;
      expect(await renewLock(down, "notice:1", "run-a")).toBe(false);
    } finally { spy.mockRestore(); }
  });
});
