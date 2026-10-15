import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (wiring lens) -- WIRING-3: a label write whose RESPONSE is lost is sent again, and #07 mails twice.
 *
 * The REAL monday.ts runs here (setColumns -> gql); only fetch is stubbed, by a tiny monday that holds one cell and
 * runs workflow #07 the way the board does: on "status changes to 30分钟未跟进" it emails (counted) and sets 已提醒.
 *
 *  (a) follow-up-reminder.ts:162 writes the label through setColumns, which ALWAYS calls gql with retries=3
 *      (monday.ts:346-353, "IDEMPOTENT ... so it retries hard"); the reminder's trailing `1` is maxRateWaits, not
 *      retries. The write is not idempotent in effect: #07 changes the cell right after it. When the first attempt
 *      LANDED but its response was lost, gql re-sends {label: 30分钟未跟进} 1.5 s later; if #07 has already set
 *      已提醒, that is a new "changes to 30分钟未跟进" -> a second email.
 *  (b) when every attempt reports a failure although the first one landed, the reminder RELEASES the note
 *      (follow-up-reminder.ts:163-165, any error) and the next run clears and sets again -> a second email.
 *      monday.ts:21-24 says only MondayRateLimitedError proves a mutation never ran; owner-notice.ts:475-482 writes
 *      its status with retries=1 and never releases for exactly this reason.
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
const T0 = Date.parse("2026-10-12T02:00:00Z");
const KEY = `fur:9001:${new Date(T0).toISOString()}:30`;

/** The fake board: one 跟进提醒 cell, and workflow #07. */
const board = { cell: null as string | null, emails: 0, labelSends: 0 };
let lose: (labelSend: number) => "apply-then-lose" | "lose" | "ok" = () => "ok";

function apply(cv: Record<string, any>) {
  const v = cv[COL];
  const next = v === null ? null : (v?.label ?? null);
  const prev = board.cell;
  board.cell = next;
  if (next === "30分钟未跟进" && prev !== next) {   // #07: "status changes to 30分钟未跟进"
    board.emails++;                                 // email the Contact owner, CC ZMark
    board.cell = "已提醒";                           // and set 已提醒
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });   // skip gql's 1.5 s / 3 s back-offs
  notes.store.clear();
  board.cell = null; board.emails = 0; board.labelSends = 0;
  lose = () => "ok";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
    notes_last_updated: null } }] });
  reg.lookupCard.mockResolvedValue("5551");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const cv = JSON.parse(JSON.parse(init.body).variables.c);
    const isLabel = cv[COL] !== null && typeof cv[COL] === "object";
    if (isLabel) {
      const how = lose(++board.labelSends);
      if (how === "apply-then-lose") { apply(cv); throw new TypeError("Network connection lost."); }
      if (how === "lose") throw new TypeError("Network connection lost.");
    }
    apply(cv);
    return new Response(JSON.stringify({ data: { change_multiple_column_values: { id: "5551" } } }), { status: 200 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const run = async (now: number) => {
  const p = runFollowUpReminders(ON, live, now);
  await vi.runAllTimersAsync();
  return p;
};

describe("WIRING-3: a lost response on the label write", () => {
  it("(a) REPRO: gql re-sends the landed label after #07 set 已提醒 -> #07 fires twice in ONE run", async () => {
    lose = n => n === 1 ? "apply-then-lose" : "ok";        // the first send lands, its response does not come back
    const s = await run(T0 + 31 * MIN);
    expect(s.flagged).toBe(1);                              // the run believes it flagged once...
    expect(board.labelSends).toBe(2);                       // ...but the label went out twice (setColumns: retries=3)
    expect(board.emails).toBe(2);                           // two "changes to 30分钟未跟进": two emails
    expect(notes.store.get(KEY)).toMatch(/^sent:/);
  });

  it("(b) REPRO: every attempt reports a failure though the first landed -> the note is RELEASED -> the next run mails again", async () => {
    lose = n => n === 1 ? "apply-then-lose" : n <= 3 ? "lose" : "ok";
    const s1 = await run(T0 + 31 * MIN);
    expect(s1.errors).toBe(1);
    expect(board.emails).toBe(1);                           // the owner WAS mailed (and the card reads 已提醒)
    expect(board.cell).toBe("已提醒");
    expect(notes.store.get(KEY)).toBe("");                  // ...yet the note was released as "never sent"

    const s2 = await run(T0 + 36 * MIN);                     // the next tick
    expect(s2.flagged).toBe(1);
    expect(board.emails).toBe(2);                           // cleared then set: a second email for the same checkpoint
  });

  it("control: no lost response, one email", async () => {
    const s = await run(T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
    expect(board.emails).toBe(1);
  });
});
