import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (wiring lens) -- WIRING-2: the "pending" note is stamped with the RUN's start (`now`, taken once at
 * follow-up-reminder.ts:123), not the moment it is written (:157). Its 10-minute staleness clock (:142) therefore
 * starts before the note exists: a contact a slow run reaches minutes in gets a note that already looks minutes
 * old, and a run that starts 10 minutes after the slow run STARTED treats that live, in-flight write as "a run that
 * died" and sends it again.
 *
 * Run A (tick :31, started 0.5 s past the minute) reaches the contact late -- monday rate-limit waits on earlier
 * cards -- writes pending:<A's start>, and its clear sits in another rate-limit wait. Run C (tick :41, started 2 s
 * past the minute) reads that note: 10 min 1.5 s "old" -> retaken -> C flags; A's write then completes -> flagged
 * twice. Stamped with the write time, the note would have read about a minute old and C would have skipped.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const md = vi.hoisted(() => ({ findItemByColumn: vi.fn(), setColumns: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const notes = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getWatermark: vi.fn(async (_env: unknown, name: string) => store.has(name) ? store.get(name)! : null),
    setWatermark: vi.fn(async (_env: unknown, name: string, value: string) => { store.set(name, value); }),
  };
});
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/monday", () => md);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { runFollowUpReminders, FOLLOW_UP } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");          // the assignment
const KEY = `fur:9001:${new Date(T0).toISOString()}:30`;

const lead = () => ({ id: "9001", properties: {
  hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
  createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "HubSpot", lifecyclestage: "lead",
  notes_last_updated: null } });

const labelWrites = () => md.setColumns.mock.calls
  .map(c => (c[3] as Record<string, any>)[FOLLOW_UP.statusCol])
  .filter(v => v && typeof v === "object" && "label" in v)
  .map(v => v.label);

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockResolvedValue({ results: [lead()] });
  reg.lookupCard.mockResolvedValue("5551");
  md.setColumns.mockResolvedValue(undefined);
});

describe("WIRING-2: a live write retaken as 'stale pending'", () => {
  it("REPRO: the note written late in run A carries A's START, so run C (10 min later) retakes A's in-flight write", async () => {
    const startA = T0 + 31 * MIN + 500;                    // tick :31
    const startC = T0 + 41 * MIN + 2_000;                  // tick :41 -- two ticks later, a little more cron delay

    let finishClearA!: () => void;
    md.setColumns.mockImplementationOnce(() => new Promise<void>(res => { finishClearA = res; }));   // A: clear in a rate-limit wait

    const runA = runFollowUpReminders(ON, live, startA);
    await vi.waitFor(() => expect(finishClearA).toBeDefined());
    // Whenever A actually got here (minutes into its run), the note says A's start:
    expect(notes.store.get(KEY)).toBe(`pending:${startA}`);

    const c = await runFollowUpReminders(ON, live, startC);
    expect(startC - startA).toBeGreaterThan(10 * MIN);    // 10 min 1.5 s: "a run that died", by this clock
    expect(c.flagged).toBe(1);                             // C sends it again...

    finishClearA();
    const a = await runA;
    expect(a.flagged).toBe(1);                             // ...and A completes its own

    expect(labelWrites()).toEqual(["30分钟未跟进", "30分钟未跟进"]);   // two #07 triggers, two emails
  });
});
