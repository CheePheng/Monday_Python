import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "twice": EVERY AWAIT CAN FAIL, OR BE THE LAST THING AN INVOCATION DOES. Each operation of the first run (at
 * +31) -- every DO call (behind activity-registry's own fail-loud / fail-closed / fail-soft wrappers), every HubSpot
 * call, every monday query and mutation through the real gql -- is failed each of three ways: "throw" (never
 * applied), "throw-after" (applied, answer lost), "hang-after" (applied, then the invocation died on it, its lock left
 * behind). The runs every 5 minutes after it are clean. No checkpoint may be mailed twice; and with 25 minutes of
 * runs left, none should be lost either. Both write paths: the label alone, and clear-then-label (the cell still
 * showed this checkpoint's label from an earlier cycle).
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

import { makeWorld, drive, tickTo, MIN, T0, type World, type Mode } from "./twice-world";
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
let W: World;
const run = () => runFollowUpReminders(ON, live, () => Date.now());
const emails = (label: string) => W.w.emails.filter(e => e.label === label).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function scenario(clearPath: boolean, fault: { at: number; mode: Mode } | null) {
  vi.clearAllTimers();
  vi.setSystemTime(T0 + 31 * MIN);
  W = makeWorld();
  H.world = W;
  vi.stubGlobal("fetch", (u: unknown, i: unknown) => W.fetchMonday(u, i));
  if (clearPath) W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
  W.w.workflow.delayMs = 5_000;
  let firstDone = false;
  let fired = "";
  let firstSettled = false;
  W.w.fault = (i, op) => {
    if (firstDone || !fault || i !== fault.at) return undefined;
    fired = op;
    return fault.mode;
  };
  void run().finally(() => { firstDone = true; firstSettled = true; });
  await tickTo(T0 + 34 * MIN);                                    // the first run: finished, or dead
  firstDone = true;
  const ops1 = W.w.ops.slice();
  for (const m of [36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86]) { await tickTo(T0 + m * MIN); await drive(run(), 4 * MIN); }
  return { ops1, fired, firstSettled, labels: W.w.sent.filter(s => s.cv.color_mm82ccsb).length,
    e30: emails("30分钟未跟进"), e60: emails("60分钟未跟进") };
}

describe.each([["the label alone", false], ["clear, then the label", true]])("fault sweep: %s", (_n, clearPath) => {
  it("any one operation of the first run failed any way: no checkpoint mailed twice, none lost", async () => {
    const clean = await scenario(clearPath as boolean, null);
    expect(clean).toMatchObject({ e30: 1, e60: 1 });
    const ops = clean.ops1;
    expect(ops).toContain(clearPath ? "monday:clear" : "monday:label");
    const rows: { k: number; op: string; mode: Mode; fired: string; dead: boolean; labels: number; e30: number; e60: number }[] = [];
    for (let k = 0; k < ops.length; k++)
      for (const mode of ["throw", "throw-after", "hang-after"] as Mode[]) {
        const r = await scenario(clearPath as boolean, { at: k, mode });
        rows.push({ k, op: ops[k], mode, fired: r.fired, dead: !r.firstSettled, labels: r.labels, e30: r.e30, e60: r.e60 });
      }
    expect(rows.filter(r => r.fired !== r.op)).toEqual([]);         // every fault hit the operation it was aimed at
    expect(rows.filter(r => r.mode === "hang-after").every(r => r.dead)).toBe(true);
    process.stderr.write(`[sweep ${clearPath ? "clear" : "label"}] ${rows.length} scenarios over ops ${ops.join(" > ")}\n`
      + rows.map(r => `  ${r.op} ${r.mode}: label sends=${r.labels} e30=${r.e30} e60=${r.e60}${r.dead ? " (run 1 died)" : ""}`).join("\n") + "\n");
    expect(rows.filter(r => r.e30 > 1 || r.e60 > 1)).toEqual([]);  // never twice
    expect(rows.filter(r => r.e30 < 1 || r.e60 < 1)).toEqual([]);  // never lost
  });
});
