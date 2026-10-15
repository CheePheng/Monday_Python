import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO RULE-3: the decision is made from the SEARCH INDEX alone. This repo measured HubSpot's search
 * index needing "minutes, not seconds" (activity-registry.ts RESERVE_STALE_MS, activities.ts header); the record
 * itself (GET by id) is current. runFollowUpReminders never re-reads the contact before it flags, so:
 *   A) a call logged at T0+28 that the index does not show yet -> 30分钟未跟进 (CC ZMark) for a lead just worked;
 *   B) a manager's reassignment at T0+58 the index does not show yet -> the run decides the OLD cycle's 60-minute
 *      checkpoint, and #07b mails whoever the card shows now -- the new owner, three minutes into their assignment.
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
const iso = (t: number) => new Date(t).toISOString();

const props = (o: Record<string, unknown>) => ({
  hubspot_owner_id: "77", hubspot_owner_assigneddate: iso(T0), createdate: iso(T0 - 5 * MIN),
  utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null, ...o });

/** The index answers the search with `indexed`; the record (a GET by id) holds `current`. */
function world(indexed: Record<string, unknown>, current: Record<string, unknown>) {
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    if (method === "POST" && path.endsWith("/search")) return { results: [{ id: "9001", properties: props(indexed) }] };
    if (method === "GET" && path.startsWith("/crm/v3/objects/contacts/9001")) return { id: "9001", properties: props(current) };
    throw new Error(`unexpected ${method} ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockResolvedValue("5551");
  md.setColumns.mockResolvedValue(undefined);
});

describe("RULE-3 repro: flags on the search index's snapshot, never on the record", () => {
  it("A) a follow-up logged 3 minutes before the checkpoint, not yet indexed, still draws 30分钟未跟进", async () => {
    world({ notes_last_updated: null }, { notes_last_updated: iso(T0 + 28 * MIN) });
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
    expect(md.setColumns.mock.calls[1][3]).toEqual({ color_mm82ccsb: { label: "30分钟未跟进" } });
    expect(hub.hs.mock.calls.every(c => c[1] === "POST")).toBe(true);     // the record was never read
  });

  it("B) a reassignment 3 minutes before the run, not yet indexed: the old cycle's 60-minute flag lands on the new owner's card", async () => {
    world({}, { hubspot_owner_id: "88", hubspot_owner_assigneddate: iso(T0 + 58 * MIN) });
    const s = await runFollowUpReminders(ON, live, T0 + 61 * MIN);
    expect(s.flagged).toBe(1);
    expect(md.setColumns.mock.calls[1][3]).toEqual({ color_mm82ccsb: { label: "60分钟未跟进" } });
    expect(hub.hs.mock.calls.every(c => c[1] === "POST")).toBe(true);
  });
});
