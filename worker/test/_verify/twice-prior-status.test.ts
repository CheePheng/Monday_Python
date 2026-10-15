import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "twice": the prior review's TWICE-1..3, WIRING-1..4 and hardening notes 1, 2, 4, re-run against the REWRITE.
 * The real follow-up-reminder.ts and the REAL monday.ts gql/setColumns/findItemByColumn/getUsersByEmail run against a
 * fake monday API (fetch) whose 跟进提醒 cell runs workflow #07 (twice-world.ts). Every test here PASSES on the
 * rewrite: each one is a scenario that sent a second email (or lost the log line) on 445405b.
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
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const run = () => runFollowUpReminders(ON, live, () => Date.now());
const key = (cp: 30 | 60, at = T0, id = "9001") => `fur:${id}:${at}:${cp}`;

let W: World;
let logs: string[];
const labelsSent = (item?: string) => W.w.sent.filter(s => s.cv[STATUS] && (!item || s.item === item))
  .map(s => s.cv[STATUS].label as string);
const emails = (label?: string, item?: string) =>
  W.w.emails.filter(e => (!label || e.label === label) && (!item || e.item === item)).length;
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

describe("TWICE-1 / WIRING-3: a label write whose answer is a failure but which LANDED", () => {
  it("(a) committed, #07 mails and sets 已提醒 7 s later, the 504 comes 60 s on: ONE send, never re-sent -- 1 email", async () => {
    W.w.workflow.delayMs = 7_000;
    W.w.plan = [{ fault: "commit-504", latencyMs: 60_000, commitAtMs: 1_000 }];
    const s1 = await runAt(31);
    expect(labelsSent()).toEqual(["30分钟未跟进"]);                 // 445405b: re-sent 1.5 s later over 已提醒
    expect(s1).toMatchObject({ flagged: 0, unresolved: 1, errors: 0 });
    expect(W.w.notes.get(key(30))).toMatch(/^pending:/);              // never released on an ambiguous failure
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(labelsSent()).toHaveLength(1);
    expect(emails("30分钟未跟进")).toBe(1);
    expect(W.w.notes.get(key(30))).toMatch(/^sent:/);                 // resolved from the card
  });

  it("(a') a 200 reply carrying data AND errors executed: one send, not re-sent -- 1 email", async () => {
    W.w.plan = [{ fault: "commit-data-errors" }];
    for (const m of [31, 36, 41, 46, 51, 56]) await runAt(m);
    expect(labelsSent()).toHaveLength(1);
    expect(emails()).toBe(1);
  });

  it("(b) committed, the answer lost, then two 503s queued: the 503s are never even sent, the note never released -- 1 email", async () => {
    W.w.plan = [{ fault: "commit-lost", latencyMs: 2_000 }, { fault: "503" }, { fault: "503" }];
    const s1 = await runAt(31);
    expect(s1.unresolved).toBe(1);
    expect(W.w.plan).toHaveLength(2);                                 // ONE attempt (gql retries=1)
    expect(W.w.notes.get(key(30))).not.toBe("");
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(labelsSent()).toHaveLength(1);
    expect(emails()).toBe(1);
  });

  it("(b, clear path) the cell still showed the label from an earlier cycle: cleared, label lands with a 504 -- 1 email", async () => {
    W.w.cards.get("5551")!.status = { label: "30分钟未跟进", changedAt: T0 - 3 * 60 * MIN };
    W.w.plan = [{ fault: "ok" }, { fault: "commit-504", latencyMs: 60_000, commitAtMs: 500 }];
    for (const m of [31, 36, 41, 46, 51, 56]) await runAt(m);
    expect(W.w.sent.map(s => s.cv[STATUS]?.label ?? null)).toEqual([null, "30分钟未跟进"]);
    expect(emails()).toBe(1);
  });

  it("only a rate-limit refusal (monday's proof it never ran) releases: two 429s -> released -> the next run sends it once", async () => {
    W.w.plan = [{ fault: "429" }, { fault: "429" }];                  // gql: 429, waits 65 s, 429 again -> MondayRateLimitedError
    const s1 = await runAt(31);
    expect(s1.errors).toBe(1);
    expect(W.w.notes.get(key(30))).toBe("");
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(emails()).toBe(1);
    expect(labelsSent()).toEqual(["30分钟未跟进", "30分钟未跟进", "30分钟未跟进"]);  // 2 refused + 1 landed
  });
});

describe("TWICE-2 / WIRING-4: a stale 'pending' is resolved FROM THE CARD, never re-flagged blind", () => {
  it("the label landed, its 'sent' save failed (DO reset): later runs read the card -- 1 email; logged flagged (hardening 4)", async () => {
    W.w.noteFault = (_n, v) => v.startsWith("sent:") && Date.now() < T0 + 32 * MIN;
    const s1 = await runAt(31);
    expect(s1).toMatchObject({ flagged: 1, errors: 0 });              // hardening 4: not "error" any more
    expect(logs.some(l => /checkpoint=30 item=5551 action=note-unsaved/.test(l))).toBe(true);
    expect(W.w.notes.get(key(30))).toMatch(/^pending:/);
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(labelsSent()).toHaveLength(1);
    expect(emails()).toBe(1);
    expect(W.w.notes.get(key(30))).toMatch(/^sent:/);
  });

  it("the same at checkpoint 60 (445405b re-sent it at +71/+76): 1 email for the 60", async () => {
    W.w.noteFault = (n, v) => n === key(60) && v.startsWith("sent:") && Date.now() < T0 + 62 * MIN;
    for (const m of [31, 36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86]) await runAt(m);
    expect(emails("60分钟未跟进")).toBe(1);
    expect(emails("30分钟未跟进")).toBe(1);
  });

  it("the run died right after its label landed (note pending, its lock left behind): taken over, resolved, nothing written", async () => {
    const S = T0 + 31 * MIN;
    W.w.notes.set(key(30), `pending:${S}`);
    W.w.cards.get("5551")!.status = { label: "已提醒", changedAt: S + 2_000 };
    W.w.locks.set("follow-up", { at: S, owner: "dead-run" });
    const s36 = await runAt(36);
    expect(s36.busy).toBe(true);                                      // the dead run's hold has not passed
    const s41 = await runAt(41);
    expect(s41.resolved).toBe(1);
    for (const m of [46, 51, 56]) await runAt(m);
    expect(W.w.sent).toHaveLength(0);
    expect(W.w.notes.get(key(30))).toMatch(/^sent:/);
  });

  it("(old fur-twice-22:118) the rate-limit release itself cannot be saved: the stale pending is resolved from the card -- 1 email", async () => {
    W.w.plan = [{ fault: "429" }, { fault: "429" }];
    W.w.noteFault = (_n, v) => v === "" && Date.now() < T0 + 33 * MIN;
    await runAt(31);
    expect(W.w.notes.get(key(30))).toMatch(/^pending:/);
    for (const m of [36, 41, 46, 51, 56]) await runAt(m);
    expect(emails()).toBe(1);
  });
});

describe("TWICE-3 / WIRING-1 / WIRING-2: overlapping runs", () => {
  it("monday answers every call after 100 s (mutations 120 s); 5 leads, one a registry miss; a run every 5 min: each lead mailed once per checkpoint", async () => {
    const ids = ["9001", "9002", "9003", "9004", "9005"];
    W.w.index = ids.map(id => lead({ id }));
    ids.forEach((id, i) => { W.w.cards.set(String(5551 + i), { contact: id, status: null, owner: ["501"] });
      if (id !== "9005") W.w.registry.set(id, String(5551 + i)); });
    W.w.latencyMs = 100_000;
    W.w.plan = Array.from({ length: 40 }, () => ({ fault: "ok" as const, latencyMs: 120_000 }));
    vi.setSystemTime(T0 + 31 * MIN + 500);
    const runs: Promise<any>[] = [];
    for (let m = 31; m <= 86; m += 5) { await tickTo(T0 + m * MIN + 500); runs.push(run()); }
    const stats = await drive(Promise.all(runs), 40 * MIN);
    for (const [i, id] of ids.entries()) {
      const item = String(5551 + i);
      expect({ id, e30: emails("30分钟未跟进", item) <= 1, e60: emails("60分钟未跟进", item) <= 1 })
        .toEqual({ id, e30: true, e60: true });
    }
    expect(stats.some(s => s.busy)).toBe(true);                      // the lock kept a run out
  });

  it("12 leads, monday 40 s a call, ticks :31:00.5 / :36:00.5 / :41:02 (fur-wiring-8's): no lead mailed twice", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(9001 + i));
    W.w.index = ids.map(id => lead({ id }));
    ids.forEach((id, i) => { W.w.cards.set(String(5551 + i), { contact: id, status: null, owner: ["501"] });
      W.w.registry.set(id, String(5551 + i)); });
    W.w.latencyMs = 40_000;
    W.w.plan = Array.from({ length: 60 }, () => ({ fault: "ok" as const, latencyMs: 40_000 }));
    vi.setSystemTime(T0 + 31 * MIN + 500);
    const runs = [run()];
    await tickTo(T0 + 36 * MIN + 500); runs.push(run());
    await tickTo(T0 + 41 * MIN + 2_000); runs.push(run());
    for (const m of [46, 51, 56]) { await tickTo(T0 + m * MIN + 500); runs.push(run()); }
    await drive(Promise.all(runs), 40 * MIN);
    const per = ids.map((_, i) => emails("30分钟未跟进", String(5551 + i)));
    expect(Math.max(...per)).toBe(1);
  });

  it("WIRING-2: 'pending' is stamped when it is written (here 200 s into the run), not at the run's start", async () => {
    W.w.latencyMs = 100_000;                                          // the card read and the user list: 100 s each
    vi.setSystemTime(T0 + 31 * MIN);
    await drive(run());
    const p = W.w.noteLog.find(([n, v]) => n === key(30) && v.startsWith("pending:"))!;
    const stamp = Number(p[1].slice("pending:".length));
    expect(stamp - (T0 + 31 * MIN)).toBeGreaterThanOrEqual(200_000);
    const labelAt = W.w.sent.find(s => s.cv[STATUS]?.label)!.at;
    expect(labelAt - stamp).toBeLessThan(1_000);
  });
});

describe("hardening notes", () => {
  it("1: one assignment read as ISO with ms, ISO without ms, then epoch ms is ONE cycle -- 1 email", async () => {
    await runAt(31);
    W.w.index = [lead({ assigned: "2026-10-12T02:00:00Z" })];
    await runAt(36);
    W.w.index = [lead({ assigned: String(T0) })];
    await runAt(41);
    expect(labelsSent()).toHaveLength(1);
    expect(emails()).toBe(1);
  });

  it("2 (the part that is fixed): a release at minute 51, or a pending whose label did not land, is retried at 56", async () => {
    W.w.plan = [{ fault: "429" }, { fault: "429" }];
    await runAt(51);                                                   // the first run that reaches it
    expect(W.w.notes.get(key(30))).toBe("");
    await runAt(56);
    expect(emails("30分钟未跟进")).toBe(1);

    W.w.notes.clear(); W.w.emails.length = 0; W.w.cards.get("5551")!.status = null;
    W.w.index = [lead({ assigned: iso(T0 + 60 * MIN) })];             // a fresh cycle, 60 min later
    W.w.plan = [{ fault: "lost" }];                                    // did not land, answer lost
    await runAt(60 + 51);
    expect(W.w.notes.get(key(30, T0 + 60 * MIN))).toMatch(/^pending:/);
    await runAt(60 + 56);                                              // 445405b: retried only after 10 min (never, here)
    expect(emails("30分钟未跟进")).toBe(1);
  });
});
