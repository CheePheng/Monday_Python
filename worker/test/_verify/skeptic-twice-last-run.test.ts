import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC of twice-hardening2-last-run-drop / hardening-2. Same world as twice-new-last-run-drop.test.ts. Probes:
 *   - the claimed two-run window: the :51 run reaches the card late (its card read waits 150 s), its label's answer is
 *     lost and it did NOT land; the :56 run skips the pending as < 3 min old; :61 decides the 60 -- the 30 is gone;
 *   - the 60's own last run (:86, refused twice): :91 is past the 90-min lookback, the contact is not even searched;
 *   - IMPACT bound: in the 30's case the owner is still mailed once (the 60), so the loss is one of two reminders.
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

import { makeWorld, drive, tickTo, MIN, T0, type World } from "./twice-world";
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

describe("skeptic: a checkpoint's last run(s)", () => {
  it("two-run window: the :51 run stamps at :53:30, its label is lost (not landed); :56 skips it as fresh; the 30 is dropped silently", async () => {
    W.w.cards.get("5551")!.owner = ["999"];
    for (const m of [31, 36, 41, 46]) await runAt(m);
    W.w.cards.get("5551")!.owner = ["501"];
    W.w.queryLatency = (q) => (/items\s*\(\s*ids/.test(q) ? 150_000 : 0);   // the :51 run's card read waits 150 s
    W.w.plan = [{ fault: "lost" }];                                           // the label: answer lost, NOT landed
    await runAt(51);
    W.w.queryLatency = null;
    const stamp = Number(W.w.notes.get(`fur:9001:${T0}:30`)!.slice("pending:".length));
    expect(stamp - T0).toBeGreaterThan(53 * MIN);                              // stamped late in the run
    expect(logs.some(l => /reads the card to tell/.test(l))).toBe(true);       // the run promised a later look
    const before = logs.length;
    for (const m of [56, 61, 66, 71, 76, 81, 86]) await runAt(m);
    const later = logs.slice(before);
    expect(emails("60分钟未跟进")).toBe(1);                                   // the owner still gets one reminder
    const thirtySent = emails("30分钟未跟进") === 1;
    const dropTold = later.some(l => /checkpoint=30\b/.test(l));
    expect(thirtySent || dropTold, "the 30 is neither sent nor reported dropped after the :51 run's promise").toBe(true);   // FAILS
  });

  it("the 60's last run (:86) refused twice: :91 never searches it -- the 60 is neither sent nor reported dropped", async () => {
    for (const m of [31]) await runAt(m);                                     // the 30 goes out normally
    W.w.cards.get("5551")!.owner = ["999"];
    for (const m of [61, 66, 71, 76, 81]) await runAt(m);
    W.w.cards.get("5551")!.owner = ["501"];
    W.w.plan = [{ fault: "429" }, { fault: "429" }];
    await runAt(86);
    expect(logs.some(l => /checkpoint=60 .*released for the next run/.test(l))).toBe(true);
    const before = logs.length;
    await runAt(91);
    const later = logs.slice(before);
    expect(emails("30分钟未跟进")).toBe(1);
    expect(W.w.searches.at(-1)!.filterGroups[0].filters[0].value).toBe(String(T0 + 91 * MIN - 90 * MIN));
    const sixtySent = emails("60分钟未跟进") === 1;
    const dropTold = later.some(l => /checkpoint=60\b/.test(l));
    expect(sixtySent || dropTold, "the 60 is neither sent nor reported dropped after 'released for the next run'").toBe(true);   // FAILS
  });
});
