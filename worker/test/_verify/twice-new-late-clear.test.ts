import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "twice", NEW: the CLEAR is sent through setColumns (gql retries=3). The design itself allows that "monday can
 * commit a write after the reply to it timed out" (PENDING_SETTLE_MS). So: the clear's first try times out (504)
 * but is still in monday's pipeline; the second try clears; the label lands (#07 mails) but its answer is lost
 * ("pending"); THEN the first clear commits -> 跟进提醒 is EMPTY. The next run reads the stale pending against an
 * empty cell -- "not landed" -- and flags again: a second email. Only a retried clear can leave a clear in flight
 * behind the label; a single-try clear that fails releases the note before any label is sent.
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

import { makeWorld, drive, tickTo, MIN, T0, STATUS, type World } from "./twice-world";
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
let W: World;
let logs: string[];
const emails30 = () => W.w.emails.filter(e => e.label === "30分钟未跟进").length;
async function runAt(min: number) { await tickTo(T0 + min * MIN); return drive(runFollowUpReminders(ON, live, () => Date.now())); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  W = makeWorld();
  H.world = W;
  vi.stubGlobal("fetch", (u: unknown, i: unknown) => W.fetchMonday(u, i));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a clear that commits after the label", () => {
  it("the clear's first try 504s at 60 s and commits at 200 s; its retry clears; the label lands, answer lost: one email only", async () => {
    W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };   // #07 never finished an earlier cycle
    W.w.workflow.delayMs = 5_000;
    W.w.plan = [
      { fault: "commit-504", latencyMs: 60_000, commitAtMs: 200_000 },   // clear, try 1: still in monday's pipeline
      { fault: "ok" },                                                     // clear, try 2 (1.5 s later)
      { fault: "commit-lost" },                                            // the label: lands, answer lost
    ];
    const s1 = await runAt(31);
    expect(s1.unresolved).toBe(1);
    expect(emails30()).toBe(1);
    await tickTo(T0 + 31 * MIN + 200_000 + 1_000);
    expect(W.w.cards.get("5551")!.status).toBeNull();                      // the late clear wiped 已提醒
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(W.w.sent.filter(s => s.cv[STATUS]?.label).length).toBe(2);
    expect(emails30()).toBe(1);                                            // FAILS: 2
  });

  it("control: the same late clear with the label's answer received ('sent' noted): one email", async () => {
    W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
    W.w.workflow.delayMs = 5_000;
    W.w.plan = [{ fault: "commit-504", latencyMs: 60_000, commitAtMs: 200_000 }, { fault: "ok" }, { fault: "ok" }];
    for (const m of [31, 36, 41, 46, 51, 56]) await runAt(m);
    expect(emails30()).toBe(1);
  });
});
