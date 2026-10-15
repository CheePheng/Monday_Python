import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC (lens "twice") -- TWICE-3, re-checked independently with the REAL monday.ts (gql, setColumns,
 * findItemByColumn) behind a stubbed fetch. Several contacts, one 跟进提醒 cell per card, workflow #07 modelled as
 * in the other files (a change INTO a trigger label = one email).
 *
 * PREMISE probes: how long one run lasts when monday's complexity budget makes each call wait once (fake timers).
 * INVARIANT tests: two overlapping runs, one checkpoint -> at most one email. They FAIL on the current code.
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
const itemOf = (contact: string) => `55${contact}`;
const KEY = `fur:9001:${new Date(T0).toISOString()}:30`;

const cells = new Map<string, string>();
let emails: string[] = [];
function apply(item: string, cv: Record<string, any>) {
  const v = cv[COL];
  const next = v === null ? "" : String(v.label);
  if ((cells.get(item) ?? "") === next) return;
  cells.set(item, next);
  if (TRIGGERS.has(next)) emails.push(`${item}:${next}`);
}
function workflowFinishes() { for (const [k, v] of cells) if (TRIGGERS.has(v)) cells.set(k, "已提醒"); }

/** `hangOnce`: the next request it matches waits for the test to release it. `limitOnce`: 429 every body's 1st try. */
let hangOnce: ((q: string, vars: any) => boolean) | null = null;
const hung: Array<() => void> = [];
let limitOnce = false;
const seen = new Map<string, number>();

function contacts(ids: string[]) {
  hub.hs.mockResolvedValue({ results: ids.map(id => ({ id, properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
    notes_last_updated: null } })) });
}

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  cells.clear(); emails = []; seen.clear(); hung.length = 0;
  hangOnce = null; limitOnce = false;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockImplementation(async (_e: unknown, _b: string, id: string) => itemOf(id));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const q: string = body.query;
    const vars = body.variables;
    if (limitOnce) {
      const n = (seen.get(init.body) ?? 0) + 1;
      seen.set(init.body, n);
      if (n % 2 === 1) return Response.json({ errors: [{ message: "Complexity budget exhausted",
        extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: 60 } }] }, { status: 429 });
    }
    const answer = () => {
      if (q.includes("items_page_by_column_values"))
        return Response.json({ data: { items_page_by_column_values: { items: [{ id: itemOf(String(vars.v[0])) }] } } });
      apply(String(vars.i), JSON.parse(vars.c));
      return Response.json({ data: { change_multiple_column_values: { id: String(vars.i) } } });
    };
    if (hangOnce && hangOnce(q, vars)) {
      hangOnce = null;
      return new Promise<Response>(res => { hung.push(() => res(answer())); });
    }
    return answer();
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("TWICE-3 PREMISE: a run can outlive the 5- and the 10-minute marks", () => {
  async function timedRun(n: number): Promise<number> {
    vi.useFakeTimers({ now: T0 + 31 * MIN, toFake: ["setTimeout", "Date"] });
    limitOnce = true;
    contacts(Array.from({ length: n }, (_, i) => String(9001 + i)));
    const start = Date.now();
    const p = runFollowUpReminders(ON, live, start);
    await vi.runAllTimersAsync();
    const s = await p;
    expect(s.flagged).toBe(n);
    return Date.now() - start;
  }
  it("3 due leads, each monday call waiting once (retry_in_seconds 60): > 5 minutes", async () => {
    const d = await timedRun(3);
    console.info(`3 leads: ${(d / 1000).toFixed(0)} s`);
    expect(d).toBeGreaterThan(5 * MIN);
  });
  it("5 due leads, the same: > 10 minutes -- longer than PENDING_RETRY_MS", async () => {
    const d = await timedRun(5);
    console.info(`5 leads: ${(d / 1000).toFixed(0)} s`);
    expect(d).toBeGreaterThan(10 * MIN);
  });
});

describe("TWICE-3 INVARIANT: overlapping runs, one checkpoint, at most one email", () => {
  it("(a) run A waits in findItemByColumn (registry miss); run B reads no note either; both write", async () => {
    contacts(["9001"]);
    reg.lookupCard.mockResolvedValue(null);
    hangOnce = q => q.includes("items_page_by_column_values");
    const runA = runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await vi.waitFor(() => expect(hung).toHaveLength(1));     // A is inside findItemByColumn, no note yet
    expect(notes.store.has(KEY)).toBe(false);
    await runFollowUpReminders(ON, live, T0 + 36 * MIN);      // the :06 run goes all the way through
    expect(emails).toHaveLength(1);
    workflowFinishes();                                        // #07: 已提醒
    hung[0]();                                                 // A's findItemByColumn returns
    await runA;
    expect(emails.length).toBeLessThanOrEqual(1);              // FAILS: 2
  }, 30_000);

  it("(b) A's live 'pending' is stamped with A's START: the :11 run (2 s jitter) takes it over mid-write", async () => {
    contacts(["9001"]);
    hangOnce = (q, vars) => q.includes("change_multiple_column_values") && JSON.parse(vars.c)[COL] === null;
    const runA = runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await vi.waitFor(() => expect(hung).toHaveLength(1));     // A wrote pending, its clear is in a wait
    expect(notes.store.get(KEY)).toBe(`pending:${T0 + 31 * MIN}`);
    await runFollowUpReminders(ON, live, T0 + 41 * MIN + 2_000);
    expect(emails).toHaveLength(1);
    workflowFinishes();
    hung[0]();                                                 // A's clear lands, then A's set
    await runA;
    expect(emails.length).toBeLessThanOrEqual(1);              // FAILS: 2
  }, 30_000);

  it("PROBE: with a card-registry hit and a 5-minute overlap, the fresh pending protects the checkpoint", async () => {
    contacts(["9001"]);
    hangOnce = (q, vars) => q.includes("change_multiple_column_values") && JSON.parse(vars.c)[COL] === null;
    const runA = runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await vi.waitFor(() => expect(hung).toHaveLength(1));
    const sB = await runFollowUpReminders(ON, live, T0 + 36 * MIN);
    expect(sB.already).toBe(1);
    hung[0]();
    await runA;
    expect(emails).toHaveLength(1);
  }, 30_000);
});
