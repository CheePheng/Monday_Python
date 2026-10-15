import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC (lens "twice") -- TWICE-4, re-checked independently. The HubSpot search mock APPLIES the request's own
 * hubspot_owner_assigneddate GTE/LTE filter (so a bulk batch leaves the window as time passes) and pages 100 at a
 * time in a chosen order (HubSpot's default order is not under the code's control: no `sorts` is sent).
 * The INVARIANT test asserts the due new lead is reminded: it FAILS on the current code. The PROBES measure what is
 * actually lost across a sequence of 5-minute runs, and show the miss depends on the order.
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

const { runFollowUpReminders, FOLLOW_UP } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const NEW_ID = "999999";

type Row = { id: string; assigned: number; created: number };
let rows: Row[] = [];
let order: "id-asc" | "newest-first" = "id-asc";

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockResolvedValue("5551");
  md.setColumns.mockResolvedValue(undefined);
  order = "id-asc";
  hub.hs.mockImplementation(async (_e: unknown, _m: string, _p: string, body: any) => {
    const f = body.filterGroups[0].filters;
    const gte = Number(f.find((x: any) => x.operator === "GTE").value);
    const lte = Number(f.find((x: any) => x.operator === "LTE").value);
    const hit = rows.filter(r => r.assigned >= gte && r.assigned <= lte)
      .sort((a, b) => order === "id-asc" ? Number(a.id) - Number(b.id) : b.created - a.created);
    const at = Number(body.after ?? 0);
    const page = hit.slice(at, at + 100).map(r => ({ id: r.id, properties: {
      hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(r.assigned).toISOString(),
      createdate: new Date(r.created).toISOString(), utm_term: r.id === NEW_ID ? "docusign" : "tableau",
      lifecyclestage: "lead", notes_last_updated: null } }));
    return { results: page, ...(at + 100 < hit.length ? { paging: { next: { after: String(at + 100) } } } : {}) };
  });
});

function scenario(bulkCount: number, bulkAt: number) {
  rows = Array.from({ length: bulkCount }, (_, i) => ({ id: String(100000 + i), assigned: bulkAt,
    created: Date.parse("2025-03-01T00:00:00Z") }));
  rows.push({ id: NEW_ID, assigned: T0, created: T0 - 5 * MIN });
}
function labelsSent(): string[] {
  return md.setColumns.mock.calls.map(c => c[3][FOLLOW_UP.statusCol]).filter(Boolean).map((v: any) => v.label);
}
async function everyRun() { for (let m = 31; m <= 86; m += 5) await runFollowUpReminders(ON, live, T0 + m * MIN); }

describe("TWICE-4 INVARIANT: a due new lead is reminded", () => {
  it("600 old 1.NEW contacts with a term reassigned 10 min before it: its 30-minute reminder is due at +31", async () => {
    scenario(600, T0 - 10 * MIN);
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(hub.hs).toHaveBeenCalledTimes(5);
    expect(s.flagged).toBe(1);                                 // FAILS: 0 (the lead is result #601)
  });
});

describe("TWICE-4 PROBES: what is actually lost", () => {
  it("bulk 10 min BEFORE the lead: the 30 reminder is lost, the 60 reminder goes out ~20 min late (+81)", async () => {
    scenario(600, T0 - 10 * MIN);
    await everyRun();
    expect(labelsSent()).toEqual(["60分钟未跟进"]);
    const firstFlagRun = notes.setWatermark.mock.calls.find(c => String(c[2]).startsWith("pending:"));
    expect(Number(String(firstFlagRun![2]).slice(8))).toBe(T0 + 81 * MIN);
  });

  it("bulk in the same minute as the lead: both reminders lost, every run reads like a normal one", async () => {
    scenario(600, T0);
    await everyRun();
    expect(labelsSent()).toEqual([]);
  });

  it("500 or fewer in the window: nothing lost", async () => {
    scenario(499, T0);
    await everyRun();
    expect(labelsSent()).toEqual(["30分钟未跟进", "60分钟未跟进"]);
  });

  it("if HubSpot happened to answer newest-first, nothing is lost: the miss hangs on an order the code never asks for", async () => {
    order = "newest-first";
    scenario(600, T0);
    await everyRun();
    expect(labelsSent()).toEqual(["30分钟未跟进", "60分钟未跟进"]);
  });
});
