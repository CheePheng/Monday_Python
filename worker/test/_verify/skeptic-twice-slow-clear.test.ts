import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC of twice-new-2-write-outlasts-lock. Same world as twice-new-slow-clear.test.ts (real monday.ts gql/setColumns,
 * fake board running #07). Probes whether the claim leans on an unrealistic monday:
 *   (in-order) the claim's test has monday APPLY A's last clear (received :39:30) only at :41:10 -- AFTER C's clear and
 *     label (received :41:00.5). Here A's last clear is applied the moment monday receives it (in order); only its
 *     ANSWER is slow. If the double still happens, the out-of-order application is not what the claim rests on.
 *   (clear-fails) the claim's fix 1 renews before the LABEL. Here A's clear itself fails after the hold (524, 524, 429,
 *     524): no label is ever sent by A, yet its release at follow-up-reminder.ts:318 ("" unconditional) can still wipe
 *     the newer run's "sent:".
 *   (bounds) the label-only path: its worst case (a 429 after 100 s, the 65 s wait, a 100 s answer) stays in the hold.
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
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

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

/** As the claim's test: A (:31:00.5) reaches the card's write at :35:00.5; the cell shows an earlier cycle's label. */
async function scenario(plan: Step[], ticks: number[], earlierLabel = true) {
  if (earlierLabel) W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
  W.w.queryLatency = (_q, n) => (n === 0 ? 240_000 : 0);
  W.w.plan = plan;
  vi.setSystemTime(T0 + 31 * MIN + 500);
  const runs = [run()];
  for (const m of ticks) { await tickTo(T0 + m * MIN + 500); runs.push(run()); }
  return drive(Promise.all(runs), 40 * MIN);
}

describe("skeptic: a card write that outlasts the run lock's hold", () => {
  it("(in-order) A's last clear is APPLIED on receipt (:39:30), only its answer is slow -- still must mail once", async () => {
    const stats = await scenario([
      { fault: "524", latencyMs: 100_000 }, { fault: "524", latencyMs: 100_000 }, { fault: "429" },
      { fault: "ok", latencyMs: 100_000, commitAtMs: 0 },           // A's clear, try 4: applied at :39:30, answered :41:10
      { fault: "ok" },                                              // C's label (the cell is already empty: no clear)
      { fault: "429" }, { fault: "ok", latencyMs: 100_000 },        // A's label, after the hold
    ], [36, 41]);
    expect(stats[1].busy).toBe(true);
    expect(stats[2].busy).toBeUndefined();
    expect(W.w.sent.map(s => (s.cv[STATUS] === null ? "clear" : s.cv[STATUS]?.label))).toEqual(
      ["clear", "clear", "clear", "clear", "30分钟未跟进", "30分钟未跟进", "30分钟未跟进"]);
    expect(emails30(), "in-order monday: A's label after C's flag still mails twice").toBe(1);       // FAILS: 2
  });

  it("(clear-fails) A's clear fails after the hold (no label sent by A); its release wipes C's sent: -- must mail once", async () => {
    await scenario([
      { fault: "524", latencyMs: 100_000 }, { fault: "524", latencyMs: 100_000 }, { fault: "429" },
      { fault: "524", latencyMs: 100_000 },                         // A's clear, try 4: fails at :41:10 -> release ""
      { fault: "ok" }, { fault: "ok" },                             // C's clear + label at :41:00.5
      { fault: "ok" },                                              // D (:46) label
    ], [36, 41, 46]);
    const aLabels = W.w.sent.filter(s => s.cv[STATUS]?.label && (s.at - T0) > 41 * MIN + 1_000 && (s.at - T0) < 46 * MIN);
    expect(aLabels, "A never sends a label in this variant").toHaveLength(0);
    expect(W.w.noteLog.map(([, v]) => v.split(":")[0] || "release")).toEqual(
      ["pending", "pending", "sent", "release", "pending", "sent"]);  // A pending, C pending+sent, A's release, D
    expect(emails30(), "a release by a run that lost its lock must not reopen the checkpoint").toBe(1);   // FAILS: 2
  });

  it("(bounds) label-only worst case -- 429 after 100 s, 65 s wait, 100 s answer -- ends inside the 6-min hold: one email", async () => {
    await scenario([{ fault: "429", latencyMs: 100_000 }, { fault: "ok", latencyMs: 100_000 }], [36, 41, 46], false);
    expect(emails30()).toBe(1);
    expect(W.w.sent.filter(s => s.cv[STATUS]?.label)).toHaveLength(2);   // the refused try + the landed one
  });
});
