import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (lens: NEVER TWICE / FAIL CLOSED) -- TWICE-3: two cron invocations overlapping on one checkpoint.
 *
 * runFollowUpReminders takes no run lock (the marketing poll and the LAD sweep each hold one for exactly this:
 * marketing-email-poller.ts:266, lad-sweep.ts:218), the note is a READ then a later WRITE with monday I/O in between
 * (follow-up-reminder.ts:141 -> 146-147 -> 157, not a reservation like activity-registry's claimCard), the pending
 * stamp is the run's START time (line 157 `pending:${now}`), PENDING_RETRY_MS (10 min) is shorter than the cron's
 * 15-minute life, and the release (164) and "sent" (167) are unconditional overwrites. A run slowed by monday's
 * rate limit (each call here may sit through a 65 s wait and three attempts) therefore overlaps the next ones, and:
 *   a) both read "no note" and both write the label;
 *   b) a newer run takes a live run's fresh "pending" for abandoned and both write the label;
 *   c) the slow run's release wipes the newer run's "sent", and a third run writes the label again.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const md = vi.hoisted(() => ({ findItemByColumn: vi.fn(), setColumns: vi.fn() }));
const notes = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getWatermark: vi.fn(async (_e: unknown, n: string) => (store.has(n) ? store.get(n)! : null)),
    setWatermark: vi.fn(async (_e: unknown, n: string, v: string) => { store.set(n, v); }),
  };
});
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/monday", () => md);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { runFollowUpReminders, FOLLOW_UP } = await import("../../src/follow-up-reminder");

const COL = FOLLOW_UP.statusCol;
const TRIGGERS = new Set(["30分钟未跟进", "60分钟未跟进"]);
const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const KEY = `fur:9001:${new Date(T0).toISOString()}:30`;
const tick = () => new Promise(r => setTimeout(r, 0));

const board = { cell: "", emails: [] as string[] };
function apply(cv: Record<string, any>) {
  const v = cv[COL];
  const next = v === null ? "" : String(v.label);
  if (next === board.cell) return;
  board.cell = next;
  if (TRIGGERS.has(next)) board.emails.push(next);
}
function workflowFinishes() { if (TRIGGERS.has(board.cell)) board.cell = "已提醒"; }

beforeEach(() => {
  vi.clearAllMocks();
  md.setColumns.mockReset();
  md.findItemByColumn.mockReset();
  notes.store.clear();
  Object.assign(board, { cell: "", emails: [] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([{ id: "5551" }]);
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv));
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
    notes_last_updated: null } }] });
});

describe("TWICE-3: overlapping runs email one checkpoint twice", () => {
  it("a) read-then-write: run A waits in findItemByColumn (registry miss, rate limit), run B reads no note too", async () => {
    reg.lookupCard.mockResolvedValue(null);
    let releaseA!: () => void;
    md.findItemByColumn.mockImplementationOnce(() => new Promise(res => { releaseA = () => res([{ id: "5551" }]); }));
    const runA = runFollowUpReminders(ON, live, T0 + 31 * MIN);       // the :01 run, still in monday's wait
    await tick();
    await runFollowUpReminders(ON, live, T0 + 36 * MIN);              // the :06 run
    expect(board.emails).toEqual(["30分钟未跟进"]);
    workflowFinishes();
    releaseA();
    await runA;
    expect(board.emails).toEqual(["30分钟未跟进", "30分钟未跟进"]);
    expect(notes.store.get(KEY)).toBe(`sent:${T0 + 31 * MIN}`);      // A's pending overwrote B's "sent"
  });

  it("b) a LIVE run's pending (stamped with its start time) is taken over as abandoned after 10 minutes", async () => {
    let releaseClear!: () => void;
    md.setColumns.mockImplementationOnce((_e: unknown, _b: string, _i: string, cv: Record<string, any>) =>
      new Promise<void>(res => { releaseClear = () => { apply(cv); res(); }; }));   // A's clear: in a 65 s wait
    const runA = runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await tick();
    expect(notes.store.get(KEY)).toBe(`pending:${T0 + 31 * MIN}`);
    await runFollowUpReminders(ON, live, T0 + 41 * MIN + 2_000);      // the :11 run, 2 s of cron jitter late
    expect(board.emails).toEqual(["30分钟未跟进"]);
    workflowFinishes();
    releaseClear();                                                    // A's clear lands, then A's set
    await runA;
    expect(board.emails).toEqual(["30分钟未跟进", "30分钟未跟进"]);
  });

  it("c) the slow run's failed set releases the note over the newer run's 'sent': a third run writes again", async () => {
    let releaseClear!: () => void;
    md.setColumns
      .mockImplementationOnce((_e: unknown, _b: string, _i: string, cv: Record<string, any>) =>
        new Promise<void>(res => { releaseClear = () => { apply(cv); res(); }; }))              // A's clear
      .mockImplementationOnce(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv))   // C's clear
      .mockImplementationOnce(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv))   // C's set
      .mockImplementationOnce(async () => { throw new Error("monday 429: rate-limited after 1 waits"); });       // A's set: never ran
    const runA = runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await tick();
    await runFollowUpReminders(ON, live, T0 + 41 * MIN + 2_000);
    expect(notes.store.get(KEY)).toBe(`sent:${T0 + 41 * MIN + 2_000}`);
    expect(board.emails).toEqual(["30分钟未跟进"]);
    workflowFinishes();
    releaseClear();
    await runA;
    expect(notes.store.get(KEY)).toBe("");                             // C's "sent" erased by A's release
    await runFollowUpReminders(ON, live, T0 + 46 * MIN);
    expect(board.emails).toEqual(["30分钟未跟进", "30分钟未跟进"]);
  });
});
