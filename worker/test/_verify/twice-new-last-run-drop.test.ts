import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "twice", hardening note 2 -- what is LEFT of it. The rewrite settles a pending note after 3 min (not 10) and
 * stamps it at the write, so a note released or left pending up to minute ~51 is retried by the next run. But a
 * transient failure in the LAST run of a checkpoint's window (minute 55-60 for the 30, 85-90 for the 60) is never
 * retried: the next run decides the other checkpoint (or none), never reads that note again, and nothing says the
 * reminder was dropped -- while the failing run's own line promised "released for the next run" / "a run 3 min on
 * reads the card to tell". Here the card's Contact owner lags (the designed "wait-owner") until minute 55.
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

import { makeWorld, drive, tickTo, MIN, T0, type World, type Step } from "./twice-world";
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
let W: World;
let logs: string[];
const emails = (label: string) => W.w.emails.filter(e => e.label === label).length;
const runAt = async (min: number) => { await tickTo(T0 + min * MIN); return drive(runFollowUpReminders(ON, live, () => Date.now())); };

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

describe("a transient failure in a checkpoint's last run", () => {
  it.each<[string, Step[], RegExp]>([
    ["refused (rate-limited twice): 'released for the next run'", [{ fault: "429" }, { fault: "429" }], /released for the next run/],
    ["answer lost, did NOT land: 'a run 3 min on reads the card'", [{ fault: "lost" }], /reads the card to tell/],
  ])("%s -- the 30-minute reminder is sent later, or a later run says it was dropped", async (_n, plan, promise) => {
    W.w.cards.get("5551")!.owner = ["999"];                      // the previous owner, until the sync catches up
    for (const m of [31, 36, 41, 46, 51]) await runAt(m);
    expect(logs.filter(l => /action=wait-owner/.test(l))).toHaveLength(5);
    W.w.cards.get("5551")!.owner = ["501"];
    W.w.plan = plan;
    await runAt(56);
    expect(logs.some(l => promise.test(l))).toBe(true);           // the run promised a retry
    const before = logs.length;
    for (const m of [61, 66, 71, 76, 81, 86]) await runAt(m);
    const later = logs.slice(before);
    expect(emails("60分钟未跟进")).toBe(1);                      // the 60 goes out
    const thirtySent = emails("30分钟未跟进") === 1;
    const dropTold = later.some(l => /checkpoint=30\b/.test(l));
    expect(thirtySent || dropTold, "the 30-minute reminder is neither sent nor reported dropped").toBe(true);   // FAILS
  });

  it("control: the same failure at minute 51 is retried at 56 -- the 30-minute reminder goes out", async () => {
    W.w.cards.get("5551")!.owner = ["999"];
    for (const m of [31, 36, 41, 46]) await runAt(m);
    W.w.cards.get("5551")!.owner = ["501"];
    W.w.plan = [{ fault: "429" }, { fault: "429" }];
    await runAt(51);
    await runAt(56);
    expect(emails("30分钟未跟进")).toBe(1);
  });
});
