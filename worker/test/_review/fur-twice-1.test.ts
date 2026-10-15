import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (lens: NEVER TWICE / FAIL CLOSED) -- TWICE-1.
 *
 * follow-up-reminder.ts releases its note on ANY failure of the clear/set (lines 163-165) and writes the label
 * with setColumns, which sends the mutation up to 3 times (monday.ts setColumns -> gql retries=3). A label write
 * that LANDED but whose reply was lost (network reset, a 5xx after the commit, a 200 that carries both data and
 * errors) is therefore re-sent, then released, and the next run clears + sets the label again: monday workflow
 * #07 ("status changes to 30分钟未跟进") runs a second time -> a second email for one checkpoint of one assignment.
 *
 * Runs the REAL monday.ts (gql, setColumns) against a stubbed fetch that models one monday cell plus workflow
 * #07: a change INTO a trigger label = one email, then the workflow sets 已提醒; writing the value a cell already
 * holds is no change and fires nothing (the same assumption the module's own "cleared first" comment makes).
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const notes = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getWatermark: vi.fn(async (_e: unknown, n: string) => (store.has(n) ? store.get(n)! : null)),
    setWatermark: vi.fn(async (_e: unknown, n: string, v: string) => { store.set(n, v); }),
  };
});
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { runFollowUpReminders, FOLLOW_UP } = await import("../../src/follow-up-reminder");

const COL = FOLLOW_UP.statusCol;
const TRIGGERS = new Set(["30分钟未跟进", "60分钟未跟进"]);
const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const KEY = `fur:9001:${new Date(T0).toISOString()}:30`;

/** One monday cell + workflow #07/#07b. */
const board = { cell: "", emails: [] as string[], flipPending: false, flipBetweenAttempts: false, labelSends: 0 };
function apply(cv: Record<string, any>) {
  const v = cv[COL];
  const next = v === null ? "" : String(v.label);
  if (next === board.cell) return;                      // no change: no event, no trigger
  board.cell = next;
  if (TRIGGERS.has(next)) { board.emails.push(next); board.flipPending = true; }   // #07: email owner (CC ZMark)
}
/** #07's last step: set 已提醒 (normally seconds after the trigger). */
function workflowFinishes() { if (board.flipPending) { board.cell = "已提醒"; board.flipPending = false; } }

type Step = "ok" | "applied-then-network-error" | "503-not-applied" | "applied-200-with-errors";
let script: Step[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  Object.assign(board, { cell: "", emails: [], flipPending: false, flipBetweenAttempts: false, labelSends: 0 });
  script = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockResolvedValue("5551");
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
    notes_last_updated: null } }] });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const cv = JSON.parse(body.variables.c);
    const isLabel = cv[COL] !== null;
    if (isLabel) {
      board.labelSends++;
      if (board.flipBetweenAttempts) workflowFinishes();   // #07 finished inside gql's 1.5 s / 3 s backoff
    }
    const step: Step = isLabel ? (script.shift() ?? "ok") : "ok";
    if (step === "503-not-applied") return new Response("upstream unavailable", { status: 503 });
    apply(cv);
    if (step === "applied-then-network-error") throw new TypeError("Network connection lost.");
    const data = { change_multiple_column_values: { id: String(body.variables.i) } };
    if (step === "applied-200-with-errors") return Response.json({ data, errors: [{ message: "internal error" }] });
    return Response.json({ data });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("TWICE-1: a label write that landed but reported failure is released and sent again", () => {
  it("lost reply on the landed write, then two 503s: released, and the next run emails the owner a SECOND time", async () => {
    script = ["applied-then-network-error", "503-not-applied", "503-not-applied"];
    const s1 = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s1).toMatchObject({ flagged: 0, errors: 1 });
    expect(board.emails).toEqual(["30分钟未跟进"]);          // the first write DID land: email #1 went out
    expect(notes.store.get(KEY)).toBe("");                    // ...yet the note was released

    workflowFinishes();                                        // #07 sets 已提醒, as it does seconds later
    const s2 = await runFollowUpReminders(ON, live, T0 + 36 * MIN);
    expect(s2.flagged).toBe(1);
    expect(board.emails).toEqual(["30分钟未跟进", "30分钟未跟进"]);   // TWO emails, one checkpoint, one assignment
  }, 30_000);

  it("a 200 that carries data AND errors (executed) is re-sent by gql itself, then released", async () => {
    // monday.ts:50-52 says such a reply EXECUTED and must never be re-sent; line 67-68 throws inside the try and
    // the catch at 71-73 re-sends it while attempt < retries (setColumns passes 3).
    script = ["applied-200-with-errors", "applied-200-with-errors", "applied-200-with-errors"];
    board.flipBetweenAttempts = true;                          // #07 finishes within the 1.5 s / 3 s backoff
    const s1 = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(board.labelSends).toBe(3);                          // one executed write sent three times
    expect(s1).toMatchObject({ flagged: 0, errors: 1 });
    expect(notes.store.get(KEY)).toBe("");                    // released
    expect(board.emails.length).toBe(3);                       // each re-send after 已提醒 is a fresh "changes to"
  }, 30_000);
});
