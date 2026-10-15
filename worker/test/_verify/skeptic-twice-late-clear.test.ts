import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC of twice-new-3-late-clear. Same world as twice-new-late-clear.test.ts. The claim's test has the timed-out
 * first clear commit 140 s after its 504. Probes how late it really has to be:
 *   - it must land AFTER #07 has set 已提醒 (here #07 sets it 5 s after the label): a clear landing between the label
 *     and 已提醒 is overwritten by #07's 已提醒, whose changed_at is after the note -> resolved as landed, one email;
 *   - landing 10 s after the 504 (just after 已提醒) is enough -- the 200 s of the claim is not needed;
 *   - the label's answer must ALSO be lost: the control in the claim's file shows "sent:" closes it.
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
const emails30 = () => W.w.emails.filter(e => e.label === "30分钟未跟进").length;
async function runAt(min: number) { await tickTo(T0 + min * MIN); return drive(runFollowUpReminders(ON, live, () => Date.now())); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  W = makeWorld();
  H.world = W;
  vi.stubGlobal("fetch", (u: unknown, i: unknown) => W.fetchMonday(u, i));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function lateClear(commitAtMs: number) {
  W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
  W.w.workflow.delayMs = 5_000;
  W.w.plan = [
    { fault: "commit-504", latencyMs: 60_000, commitAtMs },   // clear, try 1: answered 504 at 60 s, applied at commitAtMs
    { fault: "ok" },                                          // clear, try 2 at ~61.5 s
    { fault: "commit-lost" },                                 // the label at ~61.5 s: lands, answer lost
  ];
  const s1 = await runAt(31);
  expect(s1.unresolved).toBe(1);
  for (const m of [36, 41, 46, 51, 56]) await runAt(m);
}

describe("skeptic: how late the stray clear must land", () => {
  it("lands at 63 s -- after the label, BEFORE #07's 已提醒 (66.5 s): resolved as landed, one email", async () => {
    await lateClear(63_000);
    expect(W.w.cards.get("5551")!.status?.label).toBe("已提醒");
    expect(W.w.sent.filter(s => s.cv[STATUS]?.label)).toHaveLength(1);
    expect(emails30()).toBe(1);
  });

  it("lands at 70 s -- 10 s after its 504, just after 已提醒: the stale pending reads 'not landed' -- must still be one email", async () => {
    await lateClear(70_000);
    expect(emails30(), "a clear landing 10 s after its 504 is enough for the second email").toBe(1);   // FAILS: 2
  });
});
