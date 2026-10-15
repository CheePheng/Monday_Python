import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC (lens "twice") -- TWICE-2, re-checked independently: the stale-"pending" takeover (follow-up-reminder.ts:142)
 * re-writes WITHOUT reading the card. Correct when the run died before the label landed (PROBE, passes); a second
 * email when the label landed and only the "sent:" bookkeeping was lost (INVARIANT tests, FAIL on the current code).
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const md = vi.hoisted(() => ({ findItemByColumn: vi.fn(), setColumns: vi.fn() }));
const notes = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ctl = { failValues: [] as string[] };          // prefixes whose NEXT save fails ("sent:", "")
  return {
    store, ctl,
    getWatermark: vi.fn(async (_e: unknown, n: string) => (store.has(n) ? store.get(n)! : null)),
    setWatermark: vi.fn(async (_e: unknown, n: string, v: string) => {
      const i = ctl.failValues.findIndex(p => (p === "" ? v === "" : v.startsWith(p)));
      if (i >= 0) { ctl.failValues.splice(i, 1); throw new Error(`watermark ${n} not saved: Durable Object reset because its code was updated.`); }
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
const KEY30 = `fur:9001:${new Date(T0).toISOString()}:30`;

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
  notes.store.clear();
  notes.ctl.failValues = [];
  Object.assign(board, { cell: "", emails: [] });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv));
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "HubSpot", lifecyclestage: "lead",
    notes_last_updated: null } }] });
});

async function laterRuns(...mins: number[]) { for (const m of mins) await runFollowUpReminders(ON, live, T0 + m * MIN); }

describe("TWICE-2 PROBE: the documented case is handled right", () => {
  it("run died AFTER the clear, BEFORE the label: the +46 takeover sends the one and only email", async () => {
    md.setColumns
      .mockImplementationOnce(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv))
      .mockImplementationOnce(() => new Promise<void>(() => undefined));     // killed before the label left
    void runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await new Promise(r => setTimeout(r, 0));
    expect(notes.store.get(KEY30)).toBe(`pending:${T0 + 31 * MIN}`);
    await laterRuns(36, 41, 46);
    expect(board.emails).toEqual(["30分钟未跟进"]);
  });
});

describe("TWICE-2 INVARIANT: at most one email per assignment and checkpoint", () => {
  it("label landed, the sent: save failed -> pending -> re-written at +46 without a card read", async () => {
    notes.ctl.failValues = ["sent:"];
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s).toMatchObject({ flagged: 0, errors: 1 });
    workflowFinishes();
    await laterRuns(36, 41, 46);
    expect(board.emails.length).toBeLessThanOrEqual(1);       // FAILS: 2
  });

  it("label landed, the run was cut before the sent: save -> re-written at +46", async () => {
    md.setColumns
      .mockImplementationOnce(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv))
      .mockImplementationOnce((_e: unknown, _b: string, _i: string, cv: Record<string, any>) => {
        apply(cv);                                              // the label LANDED (#07 emails)...
        return new Promise<void>(() => undefined);              // ...and the invocation never came back
      });
    void runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await new Promise(r => setTimeout(r, 0));
    workflowFinishes();
    await laterRuns(36, 41, 46);
    expect(board.emails.length).toBeLessThanOrEqual(1);       // FAILS: 2
  });

  it("label landed with an ambiguous error AND the release save failed (swallowed at :164) -> pending -> +46", async () => {
    md.setColumns
      .mockImplementationOnce(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv))
      .mockImplementationOnce(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => {
        apply(cv);
        throw new Error("monday 504: gateway timeout");
      });
    notes.ctl.failValues = [""];
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(notes.store.get(KEY30)).toBe(`pending:${T0 + 31 * MIN}`);
    workflowFinishes();
    await laterRuns(36, 41, 46);
    expect(board.emails.length).toBeLessThanOrEqual(1);       // FAILS: 2
  });

  it("checkpoint 60: the same, re-written at +71/+76 (inside the 90-minute lookback)", async () => {
    notes.store.set(KEY30, `sent:${T0 + 31 * MIN}`);
    notes.ctl.failValues = ["sent:"];
    await runFollowUpReminders(ON, live, T0 + 61 * MIN);
    workflowFinishes();
    await laterRuns(66, 71, 76, 81, 86);
    expect(board.emails.length).toBeLessThanOrEqual(1);       // FAILS: 2
  });
});
