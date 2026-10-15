import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (lens: NEVER TWICE / FAIL CLOSED) -- TWICE-4: a reminder silently lost past the 5-page cap.
 *
 * candidates() (follow-up-reminder.ts:96-116) reads at most 5 pages x 100 and then stops without a word. Its
 * filter has no createdate bound (the 24 h new-lead rule is applied only afterwards, in reminderDue) and, since
 * 445405b, no activity bound either, and it asks for no sort order. So any bulk (re)assignment of more than 500
 * existing 1.NEW contacts that carry a utm_term fills the 30-90 minute window for the next hour, and a genuine new
 * DocuSign/HubSpot lead assigned in that hour that falls beyond the 500th result is never decided at all: no
 * reminder, no error, and the run line reads like an ordinary run.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const md = vi.hoisted(() => ({ findItemByColumn: vi.fn(), setColumns: vi.fn() }));
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

const row = (id: string, created: number, assigned: number, lastActivity: string | null) => ({ id, properties: {
  hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(assigned).toISOString(), createdate: new Date(created).toISOString(),
  utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: lastActivity } });

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.setColumns.mockResolvedValue(undefined);
});

describe("TWICE-4: the 500-result cap drops a due new lead without a trace", () => {
  it("a bulk reassignment of 500 old 1.NEW contacts (an hour earlier) hides a new lead on page 6", async () => {
    const bulkAt = T0 - 10 * MIN;                          // a rep's book of old leads moved in one batch
    const old = Array.from({ length: 500 }, (_, i) =>
      row(String(100000 + i), Date.parse("2025-03-01T00:00:00Z"), bulkAt, "2025-06-01T00:00:00Z"));
    const fresh = row("9001", T0 - 5 * MIN, T0, null);     // a real DocuSign lead, assigned 31 minutes ago
    hub.hs.mockImplementation(async (_e: unknown, _m: string, _p: string, body: any) => {
      const at = Number(body.after ?? 0);
      const all = [...old, fresh];                         // HubSpot's own order: no sort is requested
      const page = all.slice(at, at + 100);
      return { results: page, ...(at + 100 < all.length ? { paging: { next: { after: String(at + 100) } } } : {}) };
    });
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(hub.hs).toHaveBeenCalledTimes(5);                // page 6 is never asked for
    expect(s).toMatchObject({ candidates: 500, flagged: 0, errors: 0 });
    expect(md.setColumns).not.toHaveBeenCalled();           // the new lead's 30-minute reminder is lost
    expect(logs.filter(l => !l.startsWith("[follow-up] action=run "))).toEqual([]);   // ...and nothing says so
  });
});
