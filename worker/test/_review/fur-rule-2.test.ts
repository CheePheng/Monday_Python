import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Ctx, Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO RULE-2: an owner HubSpot names but monday has no seat for ("owner set but unknown").
 * The forward sync EMPTIES the card's Contact owner for such an owner (mapping.ts formatValue people -> null,
 * then reconcile.ts peopleClear), so workflow #07 -- which mails the card's Contact owner -- has nobody to send
 * to. owner-notice.ts refuses exactly this case ("no-user"); reminderDue only asks that the id be non-empty,
 * and the run flags, records "sent" (never retried) and logs action=flagged owner=<id>.
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

const { runFollowUpReminders, reminderDue } = await import("../../src/follow-up-reminder");
const { formatValue } = await import("../../src/mapping");
const { CRM_CONTACTS } = await import("../../src/config/crm");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const NO_SEAT = "424242";                                   // a HubSpot owner with no monday account

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.setColumns.mockResolvedValue(undefined);
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: NO_SEAT, hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
    notes_last_updated: null } }] });
});

describe("RULE-2 repro: an owner with no monday seat is 'flagged' though #07 has nobody to mail", () => {
  it("the sync leaves the card's Contact owner empty for this owner", () => {
    const ownerField = CRM_CONTACTS.fields.find(f => f.hs === "hubspot_owner_id")!;
    const ctx = { ownersById: { [NO_SEAT]: { name: "X", email: "x@dkmeco.com.sg" } },
      mondayUsersByEmail: {} } as unknown as Ctx;               // no monday user with that address
    expect(ownerField.type).toBe("people");
    expect(formatValue(ownerField, NO_SEAT, ctx)).toBeNull();   // -> peopleClear: the cell is emptied
  });

  it("reminderDue accepts any non-empty owner id, and the run flags + records sent without reading the card's owner", async () => {
    expect(reminderDue({ id: "9001", owner: NO_SEAT, assigned: new Date(T0).toISOString(),
      created: new Date(T0 - 5 * MIN).toISOString(), term: "docusign", lifecycle: "lead", lastActivity: "" },
      T0 + 31 * MIN)).toEqual({ checkpoint: 30 });
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
    // The only monday calls are the two status writes: nothing read who the card's Contact owner is.
    expect(md.setColumns.mock.calls.map(c => Object.keys(c[3]))).toEqual([["color_mm82ccsb"], ["color_mm82ccsb"]]);
    expect(md.findItemByColumn).not.toHaveBeenCalled();
    expect(notes.store.get(`fur:9001:${new Date(T0).toISOString()}:30`)).toMatch(/^sent:/);   // never retried
    expect(logs.some(l => l.includes(`action=flagged`) && l.includes(`owner=${NO_SEAT}`))).toBe(true);
  });
});
