import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC CHECK (wiring lens) for WIRING-1, with REAL timing instead of a promise held open by hand.
 *
 * The REAL monday.ts runs (setColumns / findItemByColumn -> gql); only fetch is stubbed, by a monday that is slow
 * (an API latency incident: every request answers after LAT ms, and succeeds) and runs workflow #07 the way the board
 * does: on "changes to 30分钟未跟进" it emails (counted) and sets 已提醒 a few seconds later. Fake timers include Date,
 * so each run's `now` is its real tick and B starts exactly five minutes after A.
 *
 * Five new leads, assigned together at T0. Four have a registry entry; the fifth was created 23.7 h before its
 * assignment, so its card's registry entry (24 h from the card's birth, never refreshed by the forward sync, which
 * finds an existing card by the id column first: sync.ts:3699) has expired -- lookupCard misses and the read->write
 * window of its note contains a monday query (follow-up-reminder.ts:141 -> :147 -> :157).
 *
 * INVARIANT (the agreed rule): each card is emailed at most once per assignment and checkpoint.
 */

const COL = "color_mm82ccsb";
const hub = vi.hoisted(() => ({ hs: vi.fn() }));
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
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");           // the assignment of all five
const LAT = 40_000;                                       // monday answers every request after 40 s
const IDS = ["9001", "9002", "9003", "9004", "9005"];
const card = (id: string) => `55${id}`;

const cells = new Map<string, string | null>();
const emails = new Map<string, number>();
const sends: { at: number; item: string; label: string | null }[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0 + 31 * MIN + 500);                // tick :31, half a second of cron delay
  notes.store.clear(); cells.clear(); emails.clear(); sends.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockResolvedValue({ results: IDS.map(id => ({ id, properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(id === "9005" ? T0 - 23.7 * 60 * MIN : T0 - 5 * MIN).toISOString(),
    utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null } })) });
  reg.lookupCard.mockImplementation(async (_e: unknown, _b: string, id: string) => id === "9005" ? null : card(id));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    await new Promise(res => setTimeout(res, LAT));
    const { query, variables } = JSON.parse(init.body);
    if (String(query).includes("items_page_by_column_values")) {
      const id = String(variables.v[0]);
      return new Response(JSON.stringify({ data: { items_page_by_column_values: {
        items: [{ id: card(id), name: "x", column_values: [] }] } } }), { status: 200 });
    }
    const item = String(variables.i);
    const v = JSON.parse(variables.c)[COL];
    const next: string | null = v === null ? null : (v?.label ?? null);
    const prev = cells.get(item) ?? null;
    cells.set(item, next);
    sends.push({ at: Date.now(), item, label: next });
    if (next === "30分钟未跟进" && prev !== next) {                      // #07: "status changes to 30分钟未跟进"
      emails.set(item, (emails.get(item) ?? 0) + 1);                    // email the owner, CC ZMark
      setTimeout(() => { if (cells.get(item) === next) cells.set(item, "已提醒"); }, 3_000);   // then 已提醒
    }
    return new Response(JSON.stringify({ data: { change_multiple_column_values: { id: item } } }), { status: 200 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("WIRING-1 (skeptic): two real cron ticks five minutes apart, monday slow", () => {
  it("INVARIANT: every card is emailed once -- FAILS: the late-assigned lead is emailed by both runs", async () => {
    let doneA = 0, doneB = 0;
    const pA = runFollowUpReminders(ON, live).then(s => { doneA = Date.now(); return s; });       // tick :31
    let pB!: Promise<unknown>;
    setTimeout(() => { pB = runFollowUpReminders(ON, live).then(s => { doneB = Date.now(); return s; }); }, 5 * MIN);  // :36
    await vi.advanceTimersByTimeAsync(15 * MIN);
    const a = await pA; const b = await pB as Awaited<typeof pA>;

    // The trace, for the record: A is still working at :36 (four cards x two 40 s writes), B starts, skips the four A
    // has noted, reads 9005's note (absent) and queries monday for its card; A reaches 9005 while B's query is in
    // flight, reads the note (still absent) and queries too. Both flag it.
    expect(doneA - (T0 + 31 * MIN + 500)).toBeGreaterThan(5 * MIN);
    expect({ aFlagged: a.flagged, bFlagged: b.flagged }).toEqual({ aFlagged: 5, bFlagged: 1 });
    expect(sends.filter(s => s.item === card("9005") && s.label).length).toBe(2);
    expect(doneB).toBeGreaterThan(0);

    for (const id of IDS) expect({ id, emails: emails.get(card(id)) ?? 0 }).toEqual({ id, emails: 1 });
  });

  it("control: the same overlap with EVERY registry entry present -> no double (the window is two DO calls wide)", async () => {
    reg.lookupCard.mockImplementation(async (_e: unknown, _b: string, id: string) => card(id));
    const pA = runFollowUpReminders(ON, live);
    let pB!: Promise<unknown>;
    setTimeout(() => { pB = runFollowUpReminders(ON, live); }, 5 * MIN);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    const a = await pA; const b = await pB as Awaited<typeof pA>;
    expect(a.flagged + b.flagged).toBe(5);                 // B took 9005 ahead of A; A then skipped it (B's fresh pending)
    for (const id of IDS) expect({ id, emails: emails.get(card(id)) ?? 0 }).toEqual({ id, emails: 1 });
  });
});
