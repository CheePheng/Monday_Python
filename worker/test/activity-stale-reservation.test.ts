import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE DUPLICATE THIS CLOSES.
 *
 * A monday create succeeds but its response is lost — a timeout under load, which the historical
 * import produced in quantity. markUnresolved deliberately leaves the reservation standing, because
 * releasing it would be worse. Fifteen minutes later RESERVE_STALE_MS expires, the next attempt
 * inherits the abandoned reservation, and claimCard says "proceed".
 *
 * Before this fix that attempt created a SECOND entry without ever looking at the card: the retry
 * path (activity-retry-do.ts) and the webhook path both call syncHubspotActivity with no opts, so
 * verifyExisting was false. Measured on production: 906 of 1,382 post-cutover email entries were
 * duplicated this way.
 *
 * The fix is narrow — when and ONLY when a stale reservation is inherited, look at the card first.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
const retry = vi.hoisted(() => ({ scheduleReconcile: vi.fn(), scheduleIfUnresolved: vi.fn() }));

const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  return {
    settled,
    /** what claimActivityToMonday will answer next — the test drives the reservation state */
    nextClaim: { status: "proceed", tookOverStale: false } as any,
    m2hReservationKey: (t: string) => `act:m2h:${t}`, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async () => reg.nextClaim),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) => {
      settled.set(h2m(o, i, k, d), t);
    }),
    unresolvedActivityToMonday: vi.fn(),
    claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
    unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(),
    releaseActivity: vi.fn(), lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(),
    getWatermark: vi.fn(async () => null), setWatermark: vi.fn(),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/activity-retry", () => retry);

const { syncHubspotActivity, syncMondayTimeline, mondayOriginMarker } = await import("../src/activity-sync");

const EMAIL = "400818361067";
const CONTACT = "553196381902", CARD = "2860521683";

/** entries already on the card, as monday would report them */
let onCard: string[];
let created: number;

const env = { ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2020-01-01T00:00:00Z" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear();
  reg.nextClaim = { status: "proceed", tookOverStale: false };
  onCard = [];
  created = 0;

  monday.findItemByColumn.mockImplementation(async (_e: Env, _b: string, _c: string, value: string) =>
    value === CONTACT ? [{ id: CARD }] : []);
  monday.gql.mockImplementation(async (_e: Env, q: string) => {
    if (q.includes("create_timeline_item")) {
      created++;
      onCard.push(`[hubspot:emails:${EMAIL}]`);
      return { create_timeline_item: { id: `tl${created}` } };
    }
    if (q.includes("timeline_items_page"))
      return { timeline: { timeline_items_page: { cursor: null, timeline_items: onCard.map(c => ({ content: c })) } } };
    return { items: [{ column_values: [{ text: "" }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
    if (path.includes("/associations/")) return { results: [] };
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: "customer@example.com" } })) };
    if (path.includes(`/emails/${EMAIL}`)) return { properties: {
      hs_timestamp: "2026-09-18T09:55:01Z", hs_email_subject: "Invite",
      hs_email_from_email: "rep@dkmeco.com", hs_email_to_email: "customer@example.com",
      hubspot_owner_id: "OW", hs_email_text: "Hi there" } };
    return { properties: {} };
  });
});

describe("inheriting an abandoned reservation", () => {
  it("does NOT create a second copy when the lost write had in fact landed", async () => {
    onCard.push(`[hubspot:emails:${EMAIL}]`);          // the first attempt DID write; we never heard
    reg.nextClaim = { status: "proceed", tookOverStale: true };

    await syncHubspotActivity(env, "emails", EMAIL);   // retry path: no opts, verifyExisting false

    expect(created).toBe(0);                            // the duplicate, asserted absent
    expect(onCard).toHaveLength(1);
    expect(reg.settleActivityToMonday).toHaveBeenCalledWith(
      expect.anything(), "emails", EMAIL, "contact", CONTACT, "already-on-card");
  });

  it("DOES create when the lost write genuinely never landed", async () => {
    onCard = [];                                        // nothing on the card
    reg.nextClaim = { status: "proceed", tookOverStale: true };

    await syncHubspotActivity(env, "emails", EMAIL);

    expect(created).toBe(1);                            // the retry must still be able to recover
    expect(onCard).toHaveLength(1);
  });
});

describe("a fresh reservation", () => {
  it("creates without paying for a card read", async () => {
    reg.nextClaim = { status: "proceed", tookOverStale: false };

    await syncHubspotActivity(env, "emails", EMAIL);

    expect(created).toBe(1);
    // no timeline read on the happy path — the check exists only where a duplicate is possible
    const reads = monday.gql.mock.calls.filter(c => String(c[1]).includes("timeline_items_page"));
    expect(reads).toHaveLength(0);
  });

  it("still refuses when another path holds the reservation", async () => {
    reg.nextClaim = { status: "creating" };
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });

  it("still refuses when the guard store is unavailable", async () => {
    reg.nextClaim = { status: "blocked" };
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });

  it("skips silently when the mapping already says it is synced", async () => {
    reg.nextClaim = { status: "have", id: "tl-existing" };
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });
});

/**
 * THE SAME HOLE, monday -> HubSpot (review 2026-09-30). pushOne ignored tookOverStale and POSTed a new
 * note or call whenever a reservation was inherited -- a create that had landed and lost its response
 * became a second HubSpot note. The wake-ups multiplied that day (the bell's trailing re-read, the
 * person doorbell, POST /wake-timeline), so the check now runs here too.
 */
describe("monday -> HubSpot: inheriting an abandoned reservation", () => {
  const ITEM = "2855736188", TL = "tl-note-1", AT = "2026-09-30T09:30:00Z";
  let inHubspot: { id: string; properties: Record<string, string> }[];
  let hsCreates: number;
  let searchFails: boolean;

  beforeEach(() => {
    inHubspot = []; hsCreates = 0; searchFails = false;
    reg.claimActivityToHubspot.mockResolvedValue({ status: "proceed", tookOverStale: true } as any);
    monday.gql.mockImplementation(async (_e: Env, q: string) => {
      if (q.includes("timeline(id:"))
        return { timeline: { timeline_items_page: { timeline_items: [
          { id: TL, type: "note", title: "", content: "Called, will visit Tuesday", created_at: AT }] } } };
      return { items: [{ column_values: [{ text: CONTACT }] }] };
    });
    hubspot.hs.mockImplementation(async (_e: Env, method: string, path: string, body?: any) => {
      if (path === "/crm/v3/objects/notes/search") {
        if (searchFails) throw new Error("HubSpot 502");
        return { results: inHubspot };
      }
      if (method === "POST" && path === "/crm/v3/objects/notes") {
        hsCreates++;
        const n = { id: `n${hsCreates}`, properties: { hs_note_body: body.properties.hs_note_body } };
        inHubspot.push(n);
        return n;
      }
      return {};
    });
  });

  it("does NOT create a second note when the lost create had landed: it settles to the one found", async () => {
    inHubspot.push({ id: "n-landed", properties: { hs_note_body: `Called, will visit Tuesday\n\n${mondayOriginMarker(TL)}` } });
    await syncMondayTimeline(env, ITEM);
    expect(hsCreates).toBe(0);
    expect(reg.settleActivityToHubspot).toHaveBeenCalledWith(expect.anything(), TL, "n-landed");
    const search = hubspot.hs.mock.calls.find(c => c[2] === "/crm/v3/objects/notes/search")!;
    expect((search[3] as any).filterGroups[0].filters).toContainEqual(
      { propertyName: "associations.contact", operator: "EQ", value: CONTACT });
  });

  it("a same-second note WITHOUT our marker is someone else's: it still creates", async () => {
    inHubspot.push({ id: "n-rep", properties: { hs_note_body: "A rep's own note" } });
    await syncMondayTimeline(env, ITEM);
    expect(hsCreates).toBe(1);
  });

  it("DOES create when nothing landed", async () => {
    await syncMondayTimeline(env, ITEM);
    expect(hsCreates).toBe(1);
    expect(reg.settleActivityToHubspot).toHaveBeenCalledWith(expect.anything(), TL, "n1");
  });

  it("cannot check HubSpot: defers, creates nothing", async () => {
    searchFails = true;
    await syncMondayTimeline(env, ITEM);
    expect(hsCreates).toBe(0);
    expect(reg.settleActivityToHubspot).not.toHaveBeenCalled();
  });

  it("a FRESH reservation pays no search", async () => {
    reg.claimActivityToHubspot.mockResolvedValue({ status: "proceed", tookOverStale: false } as any);
    await syncMondayTimeline(env, ITEM);
    expect(hsCreates).toBe(1);
    expect(hubspot.hs.mock.calls.some(c => c[2] === "/crm/v3/objects/notes/search")).toBe(false);
  });
});

/**
 * A FLOODED TIMELINE. syncMondayTimeline read one default page (25, newest first), so a rep's note behind
 * 25 newer marketing or HubSpot entries was never pushed -- and wake-timelines.mjs, reading the same one
 * page, never listed it either. It pages now, while every entry is still after the activity cutover.
 */
describe("syncMondayTimeline pages a flooded timeline", () => {
  const ITEM = "2855736188";
  const ours = (i: number) => ({ id: `mk${i}`, type: "custom", custom_activity_id: "x", title: "", content: "sent",
    created_at: `2026-09-30T1${String(i % 10)}:00:00Z` });
  let pages: Record<string, { cursor: string | null; timeline_items: any[] }>;
  let hsCreates: number;

  beforeEach(() => {
    hsCreates = 0;
    reg.claimActivityToHubspot.mockResolvedValue({ status: "proceed", tookOverStale: false } as any);
    monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
      if (q.includes("timeline(id:")) return { timeline: { timeline_items_page: pages[String(v.c ?? "first")] } };
      return { items: [{ column_values: [{ text: CONTACT }] }] };
    });
    hubspot.hs.mockImplementation(async (_e: Env, method: string, path: string) => {
      if (method === "POST" && path === "/crm/v3/objects/notes") { hsCreates++; return { id: `n${hsCreates}` }; }
      return {};
    });
  });
  const timelineReads = () => monday.gql.mock.calls.filter(c => String(c[1]).includes("timeline(id:")).length;

  it("a note on the SECOND page is still pushed", async () => {
    pages = {
      first: { cursor: "c2", timeline_items: Array.from({ length: 25 }, (_, i) => ours(i)) },
      c2: { cursor: "c3", timeline_items: [
        { id: "tl-rep", type: "note", custom_activity_id: null, title: "", content: "rep note", created_at: "2026-09-30T09:30:00Z" },
        { id: "old", type: "note", custom_activity_id: null, title: "", content: "ancient", created_at: "2019-01-01T00:00:00Z" }] },
    };
    await syncMondayTimeline(env, ITEM);
    expect(hsCreates).toBe(1);
    expect(timelineReads()).toBe(2);           // stopped: the second page reached back before the cutover
  });

  it("an ordinary card costs one read: the first page already reaches before the cutover", async () => {
    pages = { first: { cursor: "c2", timeline_items: [ours(1), { ...ours(2), created_at: "2019-01-01T00:00:00Z" }] } };
    await syncMondayTimeline(env, ITEM);
    expect(timelineReads()).toBe(1);
  });
});
