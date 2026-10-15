import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO RULE-1 (follow-up-reminder.ts candidates): the HubSpot search reads at most 5 pages of 100, with
 * no `sorts` and no createdate / term filter, and drops the rest silently. A bulk reassignment of >500 OLD
 * Lifecycle-1.NEW contacts that carry any utm_term fills every page for the full hour they sit in the 30-90 min
 * window; a genuinely new DocuSign lead past page 5 is never decided, never flagged, and nothing is logged.
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
const T0 = Date.parse("2026-10-12T02:00:00Z");     // the bulk reassignment, and the new lead's assignment

const row = (id: string, created: string, term: string) => ({ id, properties: {
  hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(), createdate: created,
  utm_term: term, lifecyclestage: "lead", notes_last_updated: null } });

// 600 old leads (created 2025, a Tableau campaign term) reassigned in bulk at T0, then the new DocuSign lead.
const OLD = Array.from({ length: 600 }, (_, i) => row(String(1000 + i), "2025-03-01T00:00:00.000Z", "tableau"));
const NEW_LEAD = row("999999", new Date(T0 - 5 * MIN).toISOString(), "docusign");
const ALL = [...OLD, NEW_LEAD];

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.setColumns.mockResolvedValue(undefined);
  // HubSpot pages 100 at a time, offset cursor; with no sorts the order is HubSpot's default (here: id order).
  hub.hs.mockImplementation(async (_env: unknown, _m: string, _p: string, body: any) => {
    const from = Number(body?.after ?? 0);
    const results = ALL.slice(from, from + 100);
    const next = from + 100 < ALL.length ? { next: { after: String(from + 100) } } : {};
    return { total: ALL.length, results, paging: next };
  });
});

describe("RULE-1 repro: the 5-page cap drops a qualifying lead silently", () => {
  it("a new DocuSign lead on page 7 is never decided while a bulk reassignment fills pages 1-5", async () => {
    // Every five-minute run while the bulk sits in the 30-90 min window sees the same first 500.
    for (const m of [31, 36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86]) {
      const s = await runFollowUpReminders(ON, live, T0 + m * MIN);
      expect(s.candidates).toBe(500);
      expect(s.flagged).toBe(0);
    }
    expect(md.setColumns).not.toHaveBeenCalled();                 // neither 30分钟未跟进 nor 60分钟未跟进, ever
    expect(logs.some(l => l.includes("999999"))).toBe(false);      // the lead is never even named
    // ...and nothing says the read was cut short: no total, no "more", no truncation line.
    expect(logs.filter(l => /total|more|truncat|cap|page/i.test(l))).toEqual([]);
    // The search carries no sort and no createdate bound that would keep old leads out of the pages.
    const body = hub.hs.mock.calls[0][3];
    expect(body.sorts).toBeUndefined();
    expect(body.filterGroups[0].filters.map((f: any) => f.propertyName)).not.toContain("createdate");
    expect(hub.hs.mock.calls.filter(c => c[0] === ON).length).toBe(12 * 5);   // 5 pages a run, then stops
  });

  it("control: the same lead alone is flagged at the first run", async () => {
    hub.hs.mockResolvedValue({ results: [NEW_LEAD] });
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
  });
});
