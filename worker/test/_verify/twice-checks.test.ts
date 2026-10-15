import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "twice": the specific paths the brief names, each driven end to end (real gql, fake board running #07). All
 * of these PASS on the rewrite -- they are the "checked and found correct" evidence.
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

import { makeWorld, drive, tickTo, lead, iso, MIN, T0, STATUS, type World } from "./twice-world";
const { runFollowUpReminders, landedSince } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const run = () => runFollowUpReminders(ON, live, () => Date.now());
const key = (cp: 30 | 60, at = T0, id = "9001") => `fur:${id}:${at}:${cp}`;
let W: World;
let logs: string[];
const emails = (label?: string) => W.w.emails.filter(e => !label || e.label === label);
const labelsLanded = () => W.w.sent.filter(s => s.cv[STATUS]?.label && s.fault !== "429").length;
async function runAt(min: number) { await tickTo(T0 + min * MIN); return drive(run()); }

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

describe("landedSince on the card, end to end", () => {
  it("#07 slower than PENDING_SETTLE_MS (10 min): the label itself, changed since the note, counts as landed -- 1 email", async () => {
    W.w.workflow.delayMs = 10 * MIN;
    W.w.plan = [{ fault: "commit-lost" }];
    for (const m of [31, 36, 41, 46, 51, 56]) await runAt(m);
    expect(labelsLanded()).toBe(1);
    expect(emails()).toHaveLength(1);
    expect(logs.some(l => /action=resolved label="30分钟未跟进"/.test(l))).toBe(true);
  });

  it("#07 never finishes (the cell stays at the label): resolved as landed -- 1 email; the next cycle clears it first", async () => {
    W.w.workflow.delayMs = 24 * 60 * MIN;                            // never within the test
    W.w.plan = [{ fault: "commit-504", latencyMs: 30_000 }];
    for (const m of [31, 36, 41, 46, 51, 56]) await runAt(m);
    expect(emails("30分钟未跟进")).toHaveLength(1);
    expect(W.w.notes.get(key(30))).toMatch(/^sent:/);
  });

  it("a stale 60 note over the 30's label (#07 never finished the 30): not landed -> the 60 is flagged once", async () => {
    W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 + 31 * MIN };
    W.w.notes.set(key(30), `sent:${T0 + 31 * MIN}`);
    W.w.notes.set(key(60), `pending:${T0 + 61 * MIN}`);              // its run died before the label left
    for (const m of [66, 71, 76, 81, 86]) await runAt(m);
    expect(emails("60分钟未跟进")).toHaveLength(1);
    expect(W.w.sent.map(s => s.cv[STATUS])).toEqual([{ label: "60分钟未跟进" }]);   // no clear: a different label
  });

  it("a stale 60 note over an EARLIER cycle's 60 label: not landed -> cleared, flagged once", async () => {
    W.w.cards.get("5551")!.status = { label: "60分钟未跟进", changedAt: T0 - 5 * 60 * MIN };
    W.w.notes.set(key(30), `sent:${T0 + 31 * MIN}`);
    W.w.notes.set(key(60), `pending:${T0 + 61 * MIN}`);
    for (const m of [66, 71, 76, 81, 86]) await runAt(m);
    expect(emails("60分钟未跟进")).toHaveLength(1);
    expect(W.w.sent.map(s => s.cv[STATUS])).toEqual([null, { label: "60分钟未跟进" }]);
  });

  it("clock skew: monday's changed_at up to 5 s behind the Worker's note still reads as landed; the 5 s is the only slack", () => {
    const S = T0 + 31 * MIN;
    const cell = (changed: number) => ({ text: "已提醒", index: 1, value: JSON.stringify({ index: 1, changed_at: iso(changed) }) });
    expect(landedSince(cell(S - 5_000), S)).toBe(true);
    expect(landedSince(cell(S - 5_001), S)).toBe(false);
    // An absent change time is never guessed: unresolved, nothing written.
    expect(landedSince({ text: "已提醒", index: 1, value: JSON.stringify({ index: 1 }) }, S)).toBeNull();
  });
});

describe("the clear-then-label path", () => {
  it("the clear lands, the label is refused (rate-limited twice): released; the cell is empty; the next run sends once", async () => {
    W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
    W.w.plan = [{ fault: "ok" }, { fault: "429" }, { fault: "429" }];
    const s1 = await runAt(31);
    expect(s1.errors).toBe(1);
    expect(W.w.notes.get(key(30))).toBe("");
    expect(W.w.cards.get("5551")!.status).toBeNull();
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(emails()).toHaveLength(1);
  });

  it("the clear fails all three tries (its first LANDED, answer lost): released; the next run sends once", async () => {
    W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
    W.w.plan = [{ fault: "commit-lost" }, { fault: "503" }, { fault: "503" }];
    await runAt(31);
    expect(W.w.notes.get(key(30))).toBe("");
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(emails()).toHaveLength(1);
  });
});

describe("cycles and owners", () => {
  it("a reassignment between checkpoints: the old cycle's 60 is never sent; the new owner gets the new cycle's 30 and 60", async () => {
    const T1 = T0 + 45 * MIN;
    W.w.owners["78"] = "owner78@example.test";
    W.w.users["owner78@example.test"] = "502";
    await runAt(31);                                                   // cycle T0's 30 -> owner 501
    await tickTo(T1);
    W.w.record["9001"] = { owner: "78", assigned: iso(T1) };          // HubSpot now; the search index lags
    await tickTo(T1 + 2 * MIN);
    W.w.cards.get("5551")!.owner = ["502"];                           // the owner sync
    for (const m of [51, 56, 61]) await runAt(m);                     // the index still shows T0 at 61
    W.w.index = [lead({ owner: "78", assigned: iso(T1) })];
    for (const m of [66, 71, 76, 81, 86, 91, 96, 101, 106, 111, 116, 121, 126, 131]) await runAt(m);
    expect(emails().map(e => [e.label, e.to])).toEqual([
      ["30分钟未跟进", "501"], ["30分钟未跟进", "502"], ["60分钟未跟进", "502"]]);
    expect(logs.some(l => /checkpoint=60 .*reassigned since the search/.test(l))).toBe(true);
  });

  it("note values other than pending/sent/'': garbage reads as already; an unparsable pending is unresolved -- nothing written", async () => {
    W.w.notes.set(key(30), "garbage");
    await runAt(31);
    W.w.notes.set(key(30), "pending:abc");
    const s = await runAt(36);
    expect(s.unresolved).toBe(1);
    expect(W.w.sent).toHaveLength(0);
  });
});

describe("lock races", () => {
  it("the renew race: a run whose reads outlast its hold, after another run took the lock, finished and RELEASED it, writes nothing", async () => {
    W.w.queryLatency = (_q, n) => (n === 0 ? 620_000 : 0);           // A's card read: 10 min 20 s
    vi.setSystemTime(T0 + 31 * MIN);
    const a = run();
    await tickTo(T0 + 36 * MIN); const b = run();
    await tickTo(T0 + 41 * MIN + 500); const c = run();
    const [sa, sb, sc] = await drive(Promise.all([a, b, c]), 20 * MIN);
    expect(sb.busy).toBe(true);
    expect(sc.flagged).toBe(1);                                       // C took the expired lock, flagged, released
    expect(sa.deferred).toBe(1);                                      // A: lost-lock at its renewal
    expect(logs.some(l => /contact=9001 checkpoint=30 item=5551 action=lost-lock/.test(l))).toBe(true);
    expect(emails()).toHaveLength(1);
  });
});
