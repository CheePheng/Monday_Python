import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC CHECK (wiring lens) for WIRING-3, with #07 given a realistic latency instead of running instantly.
 *
 * The REAL monday.ts runs (setColumns -> gql, retries=3, back-offs 1.5 s / 3 s); fetch is a monday that holds one
 * 跟进提醒 cell. Workflow #07 emails on "status changes to 30分钟未跟进" and sets 已提醒 SEVEN seconds later. Which
 * failure of the label write's FIRST attempt leads to a second email?
 *
 *   gateway-timeout: monday commits the write at once, but the client gets a 504 sixty seconds later (the request
 *                    outlived the gateway). gql re-sends 1.5 s after that -- long after #07 set 已提醒.
 *   quick-reset:     monday commits, the connection drops at once ("Network connection lost"). gql re-sends 1.5 s
 *                    later -- while the cell still reads 30分钟未跟进 (#07 has not finished).
 *
 * INVARIANT (the agreed rule): one email per assignment and checkpoint.
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
const WF_LAG = 7_000;                                    // #07: email at once, 已提醒 7 s later

const board = { cell: null as string | null, emails: 0, labelSends: 0 };
type Mode = "ok" | "gateway-timeout" | "quick-reset" | "refused-503";
let modeOf: (labelSend: number) => Mode = () => "ok";

function apply(cv: Record<string, any>) {
  const v = cv[COL];
  const next: string | null = v === null ? null : (v?.label ?? null);
  const prev = board.cell;
  board.cell = next;
  if (next === "30分钟未跟进" && prev !== next) {
    board.emails++;
    setTimeout(() => { if (board.cell === next) board.cell = "已提醒"; }, WF_LAG);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0 + 31 * MIN + 500);
  notes.store.clear();
  board.cell = null; board.emails = 0; board.labelSends = 0;
  modeOf = () => "ok";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
    notes_last_updated: null } }] });
  reg.lookupCard.mockResolvedValue("5551");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const cv = JSON.parse(JSON.parse(init.body).variables.c);
    const isLabel = cv[COL] !== null && typeof cv[COL] === "object";
    const mode = isLabel ? modeOf(++board.labelSends) : "ok";
    await new Promise(res => setTimeout(res, 300));
    if (mode === "refused-503") return new Response("<html>503</html>", { status: 503 });   // never reached the board
    apply(cv);                                                                              // committed
    if (mode === "quick-reset") throw new TypeError("Network connection lost.");
    if (mode === "gateway-timeout") {
      await new Promise(res => setTimeout(res, 60_000));
      return new Response("<html>504 Gateway Time-out</html>", { status: 504 });
    }
    return new Response(JSON.stringify({ data: { change_multiple_column_values: { id: "5551" } } }), { status: 200 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const tick = async (at: number) => {
  vi.setSystemTime(at);
  const p = runFollowUpReminders(ON, live);
  await vi.advanceTimersByTimeAsync(4 * MIN);
  return p;
};

describe("WIRING-3 (skeptic): which lost response doubles the email", () => {
  it("(a) INVARIANT, gateway timeout after commit -> FAILS: gql's own retry re-sends over 已提醒", async () => {
    modeOf = n => n === 1 ? "gateway-timeout" : "ok";
    const s = await tick(T0 + 31 * MIN + 500);
    expect(s.flagged).toBe(1);
    expect(board.labelSends).toBe(2);
    expect(board.emails).toBe(1);                       // received 2
  });

  it("(b) INVARIANT, commit + 504, then two refusals -> released -> FAILS on the next tick", async () => {
    modeOf = n => n === 1 ? "gateway-timeout" : n <= 3 ? "refused-503" : "ok";
    const s1 = await tick(T0 + 31 * MIN + 500);
    expect(s1.errors).toBe(1);
    expect(notes.store.get(KEY)).toBe("");             // released although the owner was mailed
    await tick(T0 + 36 * MIN + 500);
    expect(board.emails).toBe(1);                       // received 2
  });

  it("calibration: a QUICK reset after commit does not double here (re-send lands before #07 finishes)", async () => {
    modeOf = n => n === 1 ? "quick-reset" : "ok";
    const s = await tick(T0 + 31 * MIN + 500);
    expect(s.flagged).toBe(1);
    expect(board.labelSends).toBe(2);
    expect(board.emails).toBe(1);                       // only while monday does not fire on a same-value write
  });
});
