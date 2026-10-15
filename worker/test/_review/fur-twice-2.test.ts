import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (lens: NEVER TWICE / FAIL CLOSED) -- TWICE-2.
 *
 * The note goes pending -> (clear, set) -> sent (follow-up-reminder.ts:157-167). If the label LANDED but the run
 * never gets to save "sent:" -- the save itself fails (setWatermark throws, e.g. a DO reset on deploy), or the
 * invocation is cut between the set and the save -- the note stays "pending:<run start>", and line 142 takes it
 * over once it is older than PENDING_RETRY_MS (10 min) WITHOUT looking at the card: the clear + set run again and
 * #07 emails the owner a second time for the same checkpoint. Works the same for the 60 checkpoint.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const md = vi.hoisted(() => ({ findItemByColumn: vi.fn(), setColumns: vi.fn() }));
const notes = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ctl = { failSentOnce: false };
  return {
    store, ctl,
    getWatermark: vi.fn(async (_e: unknown, n: string) => (store.has(n) ? store.get(n)! : null)),
    setWatermark: vi.fn(async (_e: unknown, n: string, v: string) => {
      if (ctl.failSentOnce && v.startsWith("sent:")) {
        ctl.failSentOnce = false;
        throw new Error(`watermark ${n} not saved: Durable Object reset because its code was updated.`);
      }
      store.set(n, v);
    }),
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

/** One monday cell + workflow #07/#07b ("status changes to <label>" -> email, then 已提醒). */
const board = { cell: "", emails: [] as string[] };
function workflowFinishes() { if (TRIGGERS.has(board.cell)) board.cell = "已提醒"; }

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  notes.ctl.failSentOnce = false;
  Object.assign(board, { cell: "", emails: [] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => {
    const v = cv[COL];
    const next = v === null ? "" : String(v.label);
    if (next === board.cell) return;
    board.cell = next;
    if (TRIGGERS.has(next)) board.emails.push(next);
  });
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "HubSpot", lifecyclestage: "lead",
    notes_last_updated: null } }] });
});

describe("TWICE-2: a landed write whose 'sent' was never saved is re-sent after 10 minutes", () => {
  it("30 checkpoint: the sent: save fails -> pending -> taken over at +46 -> second email", async () => {
    notes.ctl.failSentOnce = true;
    const s1 = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(board.emails).toEqual(["30分钟未跟进"]);          // the reminder went out...
    expect(s1).toMatchObject({ flagged: 0, errors: 1 });      // ...logged as an error, not as flagged
    workflowFinishes();
    for (const m of [36, 41]) await runFollowUpReminders(ON, live, T0 + m * MIN);
    expect(board.emails).toHaveLength(1);
    await runFollowUpReminders(ON, live, T0 + 46 * MIN);      // pending is 15 min old: "a run that died"
    expect(board.emails).toEqual(["30分钟未跟进", "30分钟未跟进"]);
  });

  it("60 checkpoint: same, re-sent at +76 (still inside the 90-minute lookback)", async () => {
    notes.store.set(`fur:9001:${new Date(T0).toISOString()}:30`, `sent:${T0 + 31 * MIN}`);
    notes.ctl.failSentOnce = true;
    await runFollowUpReminders(ON, live, T0 + 61 * MIN);
    expect(board.emails).toEqual(["60分钟未跟进"]);
    workflowFinishes();
    for (const m of [66, 71, 76]) await runFollowUpReminders(ON, live, T0 + m * MIN);
    expect(board.emails).toEqual(["60分钟未跟进", "60分钟未跟进"]);
  });
});
