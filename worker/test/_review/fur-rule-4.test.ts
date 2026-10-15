import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO RULE-4: "nothing logged since the assignment" is judged ONLY by HubSpot's notes_last_updated, but a
 * follow-up a rep logs on the monday card does not reliably reach it:
 *   - an email sent from the card's Emails & Activities is a native timeline entry of type "email", which the
 *     Worker never pushes to HubSpot (activities.ts HUBSPOT_OBJECT_FOR_NATIVE: note / activity only);
 *   - a Call summary is pushed only when something wakes the card's timeline, and the bell workflow rings for
 *     Notes only (webhooks.ts ACTIVITY_BELL_COL / ringOnPersonEdit docs) -- not testable here, monday config.
 * So the lead's notes_last_updated stays empty, and the run flags 30分钟未跟进 (CC ZMark) without ever looking at
 * the card's own activity.
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
const { eligibleForHubspot, HUBSPOT_OBJECT_FOR_NATIVE } = await import("../../src/activities");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockResolvedValue("5551");
  md.setColumns.mockResolvedValue(undefined);
});

describe("RULE-4 repro: a follow-up logged on the monday card never counts", () => {
  it("a rep's email from the card's Emails & Activities is never pushed, so notes_last_updated cannot move", () => {
    const emailedAtT0plus5 = { id: "tl-1", type: "email", custom_activity_id: null, content: "Hi, following up",
      created_at: new Date(T0 + 5 * MIN).toISOString() };
    expect(eligibleForHubspot(emailedAtT0plus5)).toBe(false);
    expect(Object.keys(HUBSPOT_OBJECT_FOR_NATIVE).sort()).toEqual(["activity", "note"]);
  });

  it("...and the run flags 30分钟未跟进 from notes_last_updated alone, reading nothing on the card", async () => {
    hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
      hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
      createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "DocuSign", lifecyclestage: "lead",
      notes_last_updated: null } }] });
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
    expect(md.setColumns.mock.calls[1][3]).toEqual({ color_mm82ccsb: { label: "30分钟未跟进" } });
    expect(md.findItemByColumn).not.toHaveBeenCalled();           // no read of the card, its timeline or bell
  });
});
