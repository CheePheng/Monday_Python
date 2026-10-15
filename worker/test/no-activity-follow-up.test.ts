import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE OTHER HALF OF "WORKED": ANY ACTIVITY THAT REACHES THE CARD (NO_ACTIVITY_RELEASE; the business's rule since
 * 2026-10-10). The owner's email or call, a colleague's email, the customer's own reply, a note -- each takes the
 * card out of "No Activity" when it is synced onto it. Driven through the real syncHubspotActivity against fakes,
 * and asserted on the move that did or did not happen.
 *
 * Two things deliberately do NOT change with it:
 *   - only RECENT activity moves a card (WORK_RECENT_MS): a replay or backfill of last week's email is not today's
 *     work;
 *   - the follow-up reminders' own rule: only the owner's outbound email or call after assignment writes Last
 *     qualifying follow-up date -- a customer's reply must never silence the chaser.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn(), moveItem: vi.fn() }));
const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k); return { status: "proceed" };
  };
  return {
    settled, inflight,
    m2hReservationKey: (t: string) => `act:m2h:${t}`, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string) => claim(h2m(o, i, k, d))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) => {
      settled.set(h2m(o, i, k, d), t); inflight.delete(h2m(o, i, k, d));
    }),
    unresolvedActivityToMonday: vi.fn(), claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
    unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(), releaseActivity: vi.fn(),
    lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(async () => undefined),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);

const { syncHubspotActivity } = await import("../src/activity-sync");

const CONTACT = "551203987421";
const CARD = "2856378306";
const NO_ACTIVITY = "group_mm7cj2yx";
const env = {
  ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z",
  ENABLE_CRM: "true", NO_ACTIVITY_RELEASE: "true", DRY_RUN: "false",
} as unknown as Env;

let group = NO_ACTIVITY;
let engagement: Record<string, string> = {};
let timelineWrites = 0;
/** Writes of Last qualifying follow-up date (the reminders' column): the owner's outbound email/call only. */
let helperWrites = 0;
/** An activity time this many minutes ago: release needs RECENT outreach (WORK_RECENT_MS). */
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear();
  group = NO_ACTIVITY; timelineWrites = 0; helperWrites = 0;
  engagement = { hs_timestamp: minutesAgo(5), hs_email_subject: "Following up",
    hs_email_direction: "EMAIL", hubspot_owner_id: "A" };
  monday.findItemByColumn.mockResolvedValue([{ id: CARD }]);
  monday.moveItem.mockResolvedValue(undefined);
  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) { timelineWrites++; return { create_timeline_item: { id: "tl1" } }; }
    if (q.includes("change_multiple_column_values")) {
      if (String(v.c).includes("date_mm78yd2c")) helperWrites++;
      return { change_multiple_column_values: { id: v.i } };
    }
    if (q.includes("group { id }")) return { items: [{ group: { id: group } }] };
    return { items: [{ column_values: [{ text: "" }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, method: string, path: string) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "A", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
    if (path.startsWith("/crm/v3/objects/emails/") || path.startsWith("/crm/v3/objects/calls/") ||
        path.startsWith("/crm/v3/objects/notes/")) return { properties: engagement };
    if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
    if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`))
      return { properties: { hubspot_owner_id: "A", hubspot_owner_assigneddate: "2026-09-16T08:00:00Z" } };
    if (method === "POST") return { id: "x" };
    return { properties: {} };
  });
});

const movedTo = () => monday.moveItem.mock.calls.map(c => [c[2], c[3]]);

describe("any activity that reaches the card -> it leaves No Activity", () => {
  it("an outbound email by the owner moves the card to Active Contacts (and writes the reminders' date)", async () => {
    await syncHubspotActivity(env, "emails", "800001");
    expect(movedTo()).toEqual([[CARD, "topics"]]);
    expect(helperWrites).toBe(1);
  });

  it("an outbound call by the owner moves it too", async () => {
    engagement = { hs_timestamp: minutesAgo(5), hs_call_title: "Intro", hs_call_direction: "OUTBOUND",
      hubspot_owner_id: "A" };
    await syncHubspotActivity(env, "calls", "800002");
    expect(movedTo()).toEqual([[CARD, "topics"]]);
  });

  /** These moved nothing until 2026-10-10. They move the card now -- and still never write the reminders' date:
   *  a customer's reply is the reason a reply is owed, and silencing the chaser for it is the expensive mistake. */
  it("the customer's own reply (inbound) moves it; the reminders' date is NOT written", async () => {
    engagement.hs_email_direction = "INCOMING_EMAIL";
    await syncHubspotActivity(env, "emails", "800004");
    expect(movedTo()).toEqual([[CARD, "topics"]]);
    expect(helperWrites).toBe(0);
  });

  it("a colleague's email moves it; the reminders' date is NOT written", async () => {
    engagement.hubspot_owner_id = "B";
    await syncHubspotActivity(env, "emails", "800005");
    expect(movedTo()).toEqual([[CARD, "topics"]]);
    expect(helperWrites).toBe(0);
  });

  it("a note moves it; the reminders' date is NOT written", async () => {
    engagement = { hs_timestamp: minutesAgo(5), hs_note_body: "Spoke to her at the dinner", hubspot_owner_id: "A" };
    await syncHubspotActivity(env, "notes", "800009");
    expect(timelineWrites).toBe(1);
    expect(movedTo()).toEqual([[CARD, "topics"]]);
    expect(helperWrites).toBe(0);
  });

  it("a card already out of No Activity is left where it is", async () => {
    group = "topics";
    await syncHubspotActivity(env, "emails", "800003");
    expect(monday.moveItem).not.toHaveBeenCalled();
  });
});

/** Each of these still DELIVERS the activity to the card's timeline -- only the move is withheld. Asserting the
 *  write keeps the case honest: a broken delivery would otherwise pass for a correct refusal. */
describe("what does not move it", () => {
  it("an email from weeks ago does not move it -- not today's work", async () => {
    engagement.hs_timestamp = "2026-09-15T09:00:00Z";
    await syncHubspotActivity(env, "emails", "800006");
    expect(timelineWrites).toBe(1);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  /** A replay (/resync-activity, a catch-up script) of the owner's email from last week: it qualifies, the
   *  helper date is written, but it is not today's work. */
  it("the owner's email from three days ago, replayed now, does not move it", async () => {
    engagement.hs_timestamp = minutesAgo(3 * 24 * 60);
    await syncHubspotActivity(env, "emails", "800008");
    expect(timelineWrites).toBe(1);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a colleague's note from three days ago, replayed now, does not move it either", async () => {
    engagement = { hs_timestamp: minutesAgo(3 * 24 * 60), hs_note_body: "old", hubspot_owner_id: "B" };
    await syncHubspotActivity(env, "notes", "800010");
    expect(timelineWrites).toBe(1);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("switch off: the activity syncs, the card stays", async () => {
    await syncHubspotActivity({ ...env, NO_ACTIVITY_RELEASE: "false" } as Env, "emails", "800007");
    expect(timelineWrites).toBe(1);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });
});
