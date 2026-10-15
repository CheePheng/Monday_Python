import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC CHECK, RULE-3. The search index (POST .../search) answers with a stale snapshot; the record itself
 * (GET by id) is current. Asserts the RULE-CORRECT outcome, so the two scenario tests are expected to FAIL on the
 * current code: it flags from the index alone (follow-up-reminder.ts:97-113 -> 135-162) and never reads the record.
 *   A) activity logged at T0+28 (record) not yet in the index at the T0+31 run -> the rule says "followed up since
 *      the assignment": no 30分钟未跟进.
 *   B) reassigned at T0+58 (record) not yet in the index at the T0+61 run -> the T0 assignment is superseded; its
 *      60-minute checkpoint is no longer due under "per assignment".
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
const base = { hubspot_owner_id: "77", hubspot_owner_assigneddate: iso(T0), createdate: iso(T0 - 5 * MIN),
  utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null as string | null };

function world(indexed: Partial<typeof base>, current: Partial<typeof base>) {
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string, body: any) => {
    if (method === "POST" && path === "/crm/v3/objects/contacts/search") return { results: [{ id: "9001", properties: { ...base, ...indexed } }] };
    if (method === "GET" && path.startsWith("/crm/v3/objects/contacts/9001")) return { id: "9001", properties: { ...base, ...current } };
    if (method === "POST" && path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: String(i.id), properties: { ...base, ...current } })) };
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

describe("RULE-3 skeptic: decided from the index alone", () => {
  it("control: index and record agree -> 30分钟未跟进 once", async () => {
    world({}, {});
    expect((await runFollowUpReminders(ON, live, T0 + 31 * MIN)).flagged).toBe(1);
  });

  it("EXPECTED TO FAIL (A): activity at T0+28 on the record, index stale -> no reminder", async () => {
    world({ notes_last_updated: null }, { notes_last_updated: iso(T0 + 28 * MIN) });
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(md.setColumns).not.toHaveBeenCalled();
    expect(s.flagged).toBe(0);
  });

  it("EXPECTED TO FAIL (B): reassigned at T0+58 on the record, index stale -> the old cycle's 60 is not flagged", async () => {
    notes.store.set(`fur:9001:${iso(T0)}:30`, `sent:${T0 + 31 * MIN}`);   // the old cycle's 30 went out normally
    world({}, { hubspot_owner_id: "88", hubspot_owner_assigneddate: iso(T0 + 58 * MIN) });
    const s = await runFollowUpReminders(ON, live, T0 + 61 * MIN);
    expect(md.setColumns).not.toHaveBeenCalled();
    expect(s.flagged).toBe(0);
  });

  it("evidence: the only HubSpot call a run makes is the search", async () => {
    world({}, {});
    await runFollowUpReminders(ON, live, T0 + 61 * MIN);
    expect(hub.hs.mock.calls.map(c => `${c[1]} ${c[2]}`)).toEqual(["POST /crm/v3/objects/contacts/search"]);
  });
});
