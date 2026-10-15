import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "twice", NEW: the run lock is renewed ONCE, before the note -- but after that renewal the card's write can
 * still take longer than the lock's hold (RUN_LOCK_HOLD_MS, 6 min). The CLEAR (taken when the cell still shows this
 * checkpoint's label from an earlier cycle) goes through setColumns: gql retries=3, plus one rate-limit wait -- and
 * monday's gateway answers a stuck call only after ~100 s (Cloudflare 524). Then the LABEL is sent with no renewal
 * in between. A run that took the lock over meanwhile has resolved the "pending" note from a card the slow write had
 * not reached yet ("not landed") and flagged it itself; the slow run's label then lands after it -> #07 mails twice.
 * Or the slow run's label is refused and its release ("") wipes the newer run's "sent:" -> the next run flags again.
 * Real monday.ts gql/setColumns, fake board running #07, ticks every 5 min.
 */

const H = vi.hoisted(() => ({ world: null as any }));
vi.mock("../../src/hubspot", () => ({ hs: (...a: any[]) => H.world.hs(...a) }));
vi.mock("../../src/card-registry", () => ({ lookupCard: (...a: any[]) => H.world.lookupCard(...a) }));
vi.mock("../../src/activity-registry", () => ({
  getWatermark: (...a: any[]) => H.world.reg.getWatermark(...a),
  setWatermark: (...a: any[]) => H.world.reg.setWatermark(...a),
  acquireLock: (...a: any[]) => H.world.reg.acquireLock(...a),
  renewLock: (...a: any[]) => H.world.reg.renewLock(...a),
  releaseLock: (...a: any[]) => H.world.reg.releaseLock(...a),
}));

import { makeWorld, drive, tickTo, MIN, T0, STATUS, type World, type Step } from "./twice-world";
const { runFollowUpReminders, RUN_LOCK_HOLD_MS } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
let W: World;
let logs: string[];
const run = () => runFollowUpReminders(ON, live, () => Date.now());
const emails30 = () => W.w.emails.filter(e => e.label === "30分钟未跟进").length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  W = makeWorld();
  H.world = W;
  vi.stubGlobal("fetch", (u: unknown, i: unknown) => W.fetchMonday(u, i));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(`${new Date(Date.now()).toISOString().slice(11, 19)} ${a.map(String).join(" ")}`);
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Run A at :31:00.5 reaches the card at :35:00.5 (its card read waited 4 min on monday -- or earlier cards took
 *  that long), renews, notes "pending", and clears the label an earlier cycle left (#07 never finished it). */
async function scenario(clearPlan: Step[], labelPlanA: Step[], extraTicks: number[] = []) {
  expect(RUN_LOCK_HOLD_MS).toBe(6 * MIN);
  W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
  W.w.queryLatency = (_q, n) => (n === 0 ? 240_000 : 0);        // only A's first card read is slow
  // Mutation requests in the order monday receives them: A's clear attempts, then C's clear + label (fast), then A's label.
  W.w.plan = [...clearPlan, { fault: "ok" }, { fault: "ok" }, ...labelPlanA];
  vi.setSystemTime(T0 + 31 * MIN + 500);
  const runs = [run()];                                            // A
  for (const m of [36, 41, ...extraTicks]) { await tickTo(T0 + m * MIN + 500); runs.push(run()); }
  return drive(Promise.all(runs), 40 * MIN);
}

describe("a card write that outlasts the run lock's hold", () => {
  // A's clear: 524 after 100 s, 524 after 100 s, a 429 (65 s wait), then it commits after 100 s: ~370 s after the renewal.
  const slowClear: Step[] = [{ fault: "524", latencyMs: 100_000 }, { fault: "524", latencyMs: 100_000 }, { fault: "429" },
    { fault: "ok", latencyMs: 100_000 }];

  it("(a) the newer run flags it; the slow run's label lands after: #07 must still mail only once", async () => {
    const stats = await scenario(slowClear, [{ fault: "429" }, { fault: "ok", latencyMs: 100_000 }]);
    expect(stats[1].busy).toBe(true);                               // B (:36) kept out by A's lock
    expect(stats[2].busy).toBeUndefined();                          // C (:41) took the expired lock over
    // Label requests monday did not refuse: C's at :41:00.5, A's at :42:15 (after its own 429 at :41:10).
    expect(W.w.sent.filter(s => s.cv[STATUS]?.label && s.fault !== "429").map(s => (s.at - T0) / 1000))
      .toEqual([41 * 60 + 0.5, 42 * 60 + 15]);
    expect(emails30()).toBe(1);                                     // FAILS: 2
  });

  it("(c) the slow run's label is refused: its release wipes the newer run's 'sent:', and the next run flags again", async () => {
    await scenario(slowClear, [{ fault: "429" }, { fault: "429" }], [46]);
    expect(emails30()).toBe(1);                                     // FAILS: 2
  });

  it("control: the same slow monday on the label alone (no clear) stays inside the hold -- one email", async () => {
    W.w.queryLatency = (_q, n) => (n === 0 ? 240_000 : 0);
    W.w.plan = [{ fault: "429" }, { fault: "ok", latencyMs: 100_000 }];
    vi.setSystemTime(T0 + 31 * MIN + 500);
    const runs = [run()];
    for (const m of [36, 41, 46]) { await tickTo(T0 + m * MIN + 500); runs.push(run()); }
    await drive(Promise.all(runs), 40 * MIN);
    expect(emails30()).toBe(1);
  });
});
