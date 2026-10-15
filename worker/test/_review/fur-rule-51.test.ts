import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC CHECK, RULE-1 (follow-up-reminder.ts candidates, lines 96-116). Asserts the CORRECT behaviour, so the
 * "bug" tests are expected to FAIL on the current code. Pins the exact boundary: 499 other in-window rows + the new
 * lead is fine, 500 + the new lead loses it -- the cap is 5 pages x 100 and nothing logs the cut.
 * HubSpot's order without `sorts` is simulated as id ascending (new records, highest ids, come last).
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const md = vi.hoisted(() => ({ findItemByColumn: vi.fn(), setColumns: vi.fn() }));
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
vi.mock("../../src/monday", () => md);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");

const row = (id: string, created: string, term: string) => ({ id, properties: {
  hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(), createdate: created,
  utm_term: term, lifecyclestage: "lead", notes_last_updated: null } });
const NEW_LEAD = row("999999", new Date(T0 - 5 * MIN).toISOString(), "docusign");

let logs: string[];
function world(oldCount: number) {
  const all = [...Array.from({ length: oldCount }, (_, i) => row(String(1000 + i), "2025-03-01T00:00:00.000Z", "tableau")), NEW_LEAD];
  hub.hs.mockImplementation(async (_env: unknown, _m: string, _p: string, body: any) => {
    const from = Number(body?.after ?? 0);
    const next = from + 100 < all.length ? { next: { after: String(from + 100) } } : {};
    return { total: all.length, results: all.slice(from, from + 100), paging: next };
  });
}
const flaggedIds = () => logs.filter(l => l.includes("action=flagged")).map(l => /contact=(\d+)/.exec(l)?.[1]);

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.setColumns.mockResolvedValue(undefined);
});

describe("RULE-1 skeptic: the 500-row cap", () => {
  it("control: 499 reassigned old leads + the new lead -> the new lead IS flagged (row 500 is still read)", async () => {
    world(499);
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.candidates).toBe(500);
    expect(flaggedIds()).toEqual(["999999"]);
  });

  it("EXPECTED TO FAIL: 500 reassigned old leads + the new lead -> the new lead is reminded at some run in its window", async () => {
    world(500);
    for (const m of [31, 36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86]) await runFollowUpReminders(ON, live, T0 + m * MIN);
    expect(flaggedIds()).toContain("999999");
  });

  it("EXPECTED TO FAIL: a run that stops with paging.next still set says so", async () => {
    world(500);
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(logs.some(l => /truncat|more than|not read|total=|paging|cap/i.test(l))).toBe(true);
  });
});
