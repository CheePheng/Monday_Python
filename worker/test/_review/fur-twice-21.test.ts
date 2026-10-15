import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC (lens "twice") -- TWICE-1, re-checked independently.
 *
 * The REAL monday.ts (gql, setColumns) runs against a stubbed fetch that models one 跟进提醒 cell plus workflow #07:
 * a change INTO a trigger label = one email; #07 then sets 已提醒 (when, is up to each case). Writing the value the
 * cell already holds is NOT a change and fires nothing (the assumption most favourable to the code).
 *
 * The INVARIANT tests assert the agreed rule (at most ONE email per assignment and checkpoint): they FAIL on the
 * current code. The PROBE tests check the premises and the benign paths, and pass.
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

const board = { cell: "", emails: [] as string[], labelSends: 0 };
function apply(cv: Record<string, any>) {
  const v = cv[COL];
  const next = v === null ? "" : String(v.label);
  if (next === board.cell) return;
  board.cell = next;
  if (TRIGGERS.has(next)) board.emails.push(next);
}
function workflowFinishes() { if (TRIGGERS.has(board.cell)) board.cell = "已提醒"; }

/** What monday does with each LABEL send (the clear always succeeds). */
type Step =
  | "ok"
  | "commit-then-reset"            // committed; connection drops at once (#07 not finished yet)
  | "commit-slow-504"              // committed; #07 runs during the long wait; then a gateway 504
  | "503";                         // not applied
let script: Step[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  Object.assign(board, { cell: "", emails: [], labelSends: 0 });
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
    const step: Step = isLabel ? (script.shift() ?? "ok") : "ok";
    if (isLabel) board.labelSends++;
    if (step === "503") return new Response("<html>503</html>", { status: 503 });
    apply(cv);
    if (step === "commit-then-reset") throw new TypeError("Network connection lost.");
    if (step === "commit-slow-504") { workflowFinishes(); return new Response("<html>504</html>", { status: 504 }); }
    return Response.json({ data: { change_multiple_column_values: { id: String(body.variables.i) } } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("TWICE-1 PROBES (premises)", () => {
  it("the `1` follow-up-reminder.ts passes to setColumns is maxRateWaits, not retries: a label write is SENT 3 times", async () => {
    script = ["503", "503", "503"];
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(board.labelSends).toBe(3);
    expect(s).toMatchObject({ flagged: 0, errors: 1 });
    expect(notes.store.get(KEY)).toBe("");                    // released: correct here, nothing applied
  }, 30_000);

  it("benign in-run path: a quick reset after commit, #07 still running -> the re-send is a no-op, ONE email", async () => {
    script = ["commit-then-reset", "ok"];
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s).toMatchObject({ flagged: 1, errors: 0 });
    expect(board.emails).toEqual(["30分钟未跟进"]);
  }, 30_000);
});

describe("TWICE-1 INVARIANT: at most one email per assignment and checkpoint", () => {
  it("(a) in-run: commit, #07 finishes during the slow request, 504 -> gql re-sends -> second email, run says flagged=1", async () => {
    script = ["commit-slow-504", "ok"];
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s).toMatchObject({ flagged: 1, errors: 0 });       // the logs show ONE clean flag...
    expect(board.emails.length).toBeLessThanOrEqual(1);       // ...FAILS: 2 emails
  }, 30_000);

  it("(b) cross-run: commit + lost reply, then two 503s -> note released -> the 5-minute-later run emails again", async () => {
    script = ["commit-then-reset", "503", "503"];
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(notes.store.get(KEY)).toBe("");
    workflowFinishes();
    await runFollowUpReminders(ON, live, T0 + 36 * MIN);
    expect(board.emails.length).toBeLessThanOrEqual(1);       // FAILS: 2 emails
  }, 30_000);
});
