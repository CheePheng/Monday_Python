import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractOwnerChangeContactIds } from "../src/webhooks";
import type { Env } from "../src/types";

/**
 * THE THREE THINGS THAT ONLY FAIL SILENTLY.
 *
 * Every case below produces no error and no failed run when it is wrong — just a reminder that does
 * not fire, a communication logged twice, or an activity that quietly never arrives. So they are
 * driven through the real syncHubspotActivity / resetHelperOnReassignment against fakes, and asserted
 * on the WRITES that did or did not happen, rather than on internal state.
 *
 * The registry fake implements the durable contract in memory — claim/settle/release with the same
 * keys — because the behaviour under test IS the interaction with it, and a vi.fn() returning
 * "proceed" forever would pass the duplicate tests while proving nothing.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));

const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  const cycles = new Map<string, string>();
  const m2h = (t: string) => `act:m2h:${t}`;
  // Mirrors the real key: contact keeps its original three-part shape so pre-existing durable
  // mappings stay readable; company and deal get their own namespace.
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed" };
  };
  const settle = (k: string, v: string) => { settled.set(k, v); inflight.delete(k); };
  return {
    settled, inflight, cycles,
    m2hReservationKey: m2h, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string) =>
      claim(h2m(o, i, k, d))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) =>
      settle(h2m(o, i, k, d), t)),
    unresolvedActivityToMonday: vi.fn(),
    claimActivityToHubspot: vi.fn(async (_e: Env, t: string) => claim(m2h(t))),
    settleActivityToHubspot: vi.fn(async (_e: Env, t: string, h: string) => settle(m2h(t), h)),
    unresolvedActivityToHubspot: vi.fn(),
    claimHubspotAsRepresented: vi.fn(async (_e: Env, o: string, i: string, c: string, m: string) =>
      settle(h2m(o, i, "contact", c), `monday:${m}`)),
    releaseActivity: vi.fn(async (_e: Env, k: string) => { inflight.delete(k); }),
    lastOwnerCycle: vi.fn(async (_e: Env, c: string) => cycles.get(c) ?? null),
    rememberOwnerCycle: vi.fn(async (_e: Env, c: string, v: string) => { cycles.set(c, v); }),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);

const { syncHubspotActivity, syncMondayTimeline, resetHelperOnReassignment, mondayOriginMarker } =
  await import("../src/activity-sync");

const QUALIFYING_COL = "date_mm78yd2c";
const CONTACT = "550936454903";
const CARD = "2859742407";

const env = {
  ENABLE_ACTIVITY_SYNC: "true",
  ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z",
} as unknown as Env;

/** monday's side of the world: one card, one helper column, one timeline. */
let helper = "";
let timeline: any[] = [];
let createdTimeline: any[] = [];
let columnWrites: Record<string, unknown>[] = [];
/** HubSpot's side: the contact's owner cycle, plus whatever POST bodies we sent. */
let contactProps: Record<string, string> = {};
let posted: { path: string; body: any }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear(); reg.cycles.clear();
  helper = ""; timeline = []; createdTimeline = []; columnWrites = []; posted = [];
  contactProps = { hubspot_owner_id: "A", hubspot_owner_assigneddate: "2026-09-10T08:00:00Z" };

  monday.findItemByColumn.mockResolvedValue([{ id: CARD }]);

  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) {
      createdTimeline.push(v);
      return { create_timeline_item: { id: `tl${createdTimeline.length}` } };
    }
    if (q.includes("change_multiple_column_values")) {
      const cv = JSON.parse(v.c);
      columnWrites.push(cv);
      if (QUALIFYING_COL in cv) {
        const val: any = cv[QUALIFYING_COL];
        helper = val && typeof val === "object" && val.date ? String(val.date) : "";
      }
      return { change_multiple_column_values: { id: v.i } };
    }
    if (q.includes(QUALIFYING_COL)) return { items: [{ column_values: [{ text: helper }] }] };
    if (q.includes("timeline(id:")) return { timeline: { timeline_items_page: { timeline_items: timeline } } };
    // the card's HubSpot id column, read by syncMondayTimeline
    return { items: [{ column_values: [{ text: CONTACT }] }] };
  });

  hubspot.hs.mockImplementation(async (_e: Env, method: string, path: string, body?: any) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OWNER", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
    if (method === "POST") { posted.push({ path, body }); return { id: `hs${posted.length}` }; }
    if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
    if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`)) return { properties: contactProps };
    return { properties: {} };
  });
});

afterEach(() => { vi.useRealTimers(); });

/** A HubSpot email from owner A, after the cutover and after A was assigned. */
const emailRecord = (over: Record<string, string> = {}) => ({
  properties: {
    hs_timestamp: "2026-09-12T10:00:00Z", hs_email_subject: "Following up",
    hs_email_direction: "EMAIL", hubspot_owner_id: "A", ...over,
  },
});

// ===================================================================================================
describe("owner reassignment clears the follow-up helper", () => {
  /**
   * THE WHOLE POINT. The helper column is a PER-OWNER claim: "whoever is responsible has reached out
   * since they became responsible". Inherited across a reassignment it silences the new owner's
   * reminder forever — no error, no failed run, just a customer nobody chases.
   */
  it("Owner A qualifies, then Owner B takes over and inherits nothing", async () => {
    hubspot.hs.mockImplementation(async (_e: Env, method: string, path: string) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OWNER", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
      if (path.startsWith("/crm/v3/objects/emails/")) return emailRecord();
      if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
      if (path.startsWith(`/crm/v3/objects/contacts/${CONTACT}`)) return { properties: contactProps };
      return { properties: {} };
    });

    await syncHubspotActivity(env, "emails", "900001");
    expect(helper).toBe("2026-09-12");                      // A's outreach satisfied the cycle

    // A genuine handover: new owner, new assignment stamp.
    contactProps = { hubspot_owner_id: "B", hubspot_owner_assigneddate: "2026-09-15T09:00:00Z" };
    await resetHelperOnReassignment(env, CONTACT);

    expect(helper).toBe("");
    expect(columnWrites.at(-1)).toEqual({ [QUALIFYING_COL]: {} });
  });

  /**
   * AND IT MUST NOT FIRE ON AN ECHO. Our own reverse sync writes the owner back to HubSpot, and
   * HubSpot fires propertyChange for writes that change nothing — so "an owner event arrived" is not
   * evidence of a reassignment. Clearing here would restart a reminder cycle against a rep who has
   * already done the work.
   */
  it("an ordinary update with the same owner preserves the helper", async () => {
    reg.cycles.set(CONTACT, "A|2026-09-10T08:00:00Z");
    helper = "2026-09-12";

    await resetHelperOnReassignment(env, CONTACT);

    expect(helper).toBe("2026-09-12");
    expect(columnWrites).toEqual([]);
  });

  /** Reassignment BACK to the same owner is still a new cycle — which the owner id alone cannot
   *  express, hence hubspot_owner_assigneddate in the key. */
  it("re-assigning to the same owner starts a new cycle and clears", async () => {
    reg.cycles.set(CONTACT, "A|2026-09-10T08:00:00Z");
    helper = "2026-09-12";
    contactProps = { hubspot_owner_id: "A", hubspot_owner_assigneddate: "2026-09-15T09:00:00Z" };

    await resetHelperOnReassignment(env, CONTACT);
    expect(helper).toBe("");
  });

  /**
   * FIRST SIGHTING CLEARS NOTHING. With no stored cycle we cannot tell a reassignment from the first
   * event we happen to see, and the safe error is a reminder not sent rather than one aimed at a rep
   * who already reached out.
   */
  it("records a baseline instead of clearing when the contact has never been seen", async () => {
    helper = "2026-09-12";
    await resetHelperOnReassignment(env, CONTACT);
    expect(helper).toBe("2026-09-12");
    expect(columnWrites).toEqual([]);
    expect(reg.cycles.get(CONTACT)).toBe("A|2026-09-10T08:00:00Z");
  });

  /** monday emits update_column_value even for a same-value write, so clearing an already-empty
   *  column would wake this board's automations for nothing. */
  it("does not write when the helper is already empty", async () => {
    reg.cycles.set(CONTACT, "A|2026-09-10T08:00:00Z");
    contactProps = { hubspot_owner_id: "B", hubspot_owner_assigneddate: "2026-09-15T09:00:00Z" };
    await resetHelperOnReassignment(env, CONTACT);
    expect(columnWrites).toEqual([]);
  });

  /** Inert means inert: with the flag off nothing about activities may touch the board. */
  it("does nothing at all while ENABLE_ACTIVITY_SYNC is off", async () => {
    reg.cycles.set(CONTACT, "A|2026-09-10T08:00:00Z");
    helper = "2026-09-12";
    contactProps = { hubspot_owner_id: "B", hubspot_owner_assigneddate: "2026-09-15T09:00:00Z" };
    await resetHelperOnReassignment({ ...env, ENABLE_ACTIVITY_SYNC: "false" } as Env, CONTACT);
    expect(helper).toBe("2026-09-12");
    expect(hubspot.hs).not.toHaveBeenCalled();
  });
});

// ===================================================================================================
describe("extractOwnerChangeContactIds", () => {
  const ev = (over: Record<string, unknown>) =>
    ({ subscriptionType: "object.propertyChange", objectTypeId: "0-1", ...over });

  it("matches a contact owner change", () => {
    expect(extractOwnerChangeContactIds([ev({ propertyName: "hubspot_owner_id", objectId: CONTACT })]))
      .toEqual([CONTACT]);
  });

  /** Any other property is an ordinary edit. The reset must fire on reassignment and nothing else. */
  it.each(["firstname", "email", "phone", "hs_lead_status"])("ignores a change to %s", (prop) => {
    expect(extractOwnerChangeContactIds([ev({ propertyName: prop, objectId: CONTACT })])).toEqual([]);
  });

  it("ignores creation and deletion", () => {
    for (const sub of ["object.creation", "object.deletion"])
      expect(extractOwnerChangeContactIds([ev({ subscriptionType: sub, propertyName: "hubspot_owner_id", objectId: CONTACT })]))
        .toEqual([]);
  });

  /** A company or deal owner change has no follow-up helper to reset. */
  it("ignores companies and deals", () => {
    expect(extractOwnerChangeContactIds([
      ev({ objectTypeId: "0-2", propertyName: "hubspot_owner_id", objectId: "1" }),
      ev({ objectTypeId: "0-3", propertyName: "hubspot_owner_id", objectId: "2" }),
    ])).toEqual([]);
  });

  it("dedupes repeated deliveries", () => {
    const one = ev({ propertyName: "hubspot_owner_id", objectId: CONTACT });
    expect(extractOwnerChangeContactIds([one, { ...one }])).toEqual([CONTACT]);
  });
});

// ===================================================================================================
describe("the transient contact/card race", () => {
  /**
   * A contact and its first email are routinely created in the same second, so the activity webhook
   * arrives before the card exists. "Release and wait for redelivery" does NOT recover it: this work
   * runs in waitUntil and the webhook was acknowledged 200, so HubSpot has no reason to send it
   * again. The retry has to happen inside this invocation.
   */
  it("retries the LOOKUP until the card appears, then creates exactly one entry", async () => {
    vi.useFakeTimers();
    hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OWNER", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
      if (path.startsWith("/crm/v3/objects/emails/")) return emailRecord();
      if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
      return { properties: contactProps };
    });
    monday.findItemByColumn
      .mockResolvedValueOnce([])            // card not visible yet
      .mockResolvedValue([{ id: CARD }]);   // ...and now it is

    const p = syncHubspotActivity(env, "emails", "900002");
    await vi.advanceTimersByTimeAsync(3_000);
    await p;

    expect(monday.findItemByColumn).toHaveBeenCalledTimes(2);
    expect(createdTimeline).toHaveLength(1);
  });

  /** The retry must never turn into a second create. A redelivery after a successful sync is the
   *  ordinary case, and the durable mapping — not a lookup — is what stops it. */
  it("a redelivery after success creates nothing", async () => {
    hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OWNER", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
      if (path.startsWith("/crm/v3/objects/emails/")) return emailRecord();
      if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
      return { properties: contactProps };
    });
    await syncHubspotActivity(env, "emails", "900003");
    await syncHubspotActivity(env, "emails", "900003");
    expect(createdTimeline).toHaveLength(1);
  });

  /**
   * When the retries genuinely run out the reservation must be RELEASED, not settled: settling an
   * unresolved contact as done loses the activity permanently, and the next delivery is the only
   * chance left.
   */
  it("releases rather than settles when the card never appears", async () => {
    vi.useFakeTimers();
    hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OWNER", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
      if (path.startsWith("/crm/v3/objects/emails/")) return emailRecord();
      if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
      return { properties: contactProps };
    });
    monday.findItemByColumn.mockResolvedValue([]);

    const p = syncHubspotActivity(env, "emails", "900004");
    await vi.advanceTimersByTimeAsync(30_000);
    await p;

    expect(createdTimeline).toEqual([]);
    // No reservation was ever taken: the card is claimed only once it is known to exist, so a card
    // that never appears leaves nothing behind to release. What matters is that it was NOT settled —
    // settling an unresolved card as done is what loses the activity permanently.
    expect(reg.settleActivityToMonday).not.toHaveBeenCalled();
    expect(reg.claimActivityToMonday).not.toHaveBeenCalled();
  });
});

// ===================================================================================================
describe("the first bounce, guarded by the marker as well as the mapping", () => {
  /**
   * Pushing a native monday Call into HubSpot makes HubSpot fire object.creation for it, and that
   * event is indistinguishable from a rep's own call. The durable mapping is the authoritative guard,
   * but the bounce can arrive BEFORE it finishes writing — so the body carries a marker that says
   * where the object came from. Without the marker, that narrow race lands a custom "HubSpot Call"
   * beside the native Call it came from: one activity shown twice, on the first try.
   */
  it.each(["77123", "9f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8", "tl_Abc-123"])(
    "a marked HubSpot object creates nothing in monday, even with no mapping stored (id %s)",
    async (timelineId) => {
      hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OWNER", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
        if (path.startsWith("/crm/v3/objects/notes/")) return {
          properties: { hs_timestamp: "2026-09-12T10:00:00Z",
            hs_note_body: `Called the customer\n\n${mondayOriginMarker(timelineId)}` },
        };
        return { properties: {} };
      });

      await syncHubspotActivity(env, "notes", "900005");

      expect(createdTimeline).toEqual([]);
      // Nothing is recorded here, and nothing needs to be: the mapping is now keyed per (activity,
      // contact) and the marker is checked before any contact is resolved. The marker lives in the
      // HubSpot body permanently, so re-reading it on a redelivery is reliable.
      expect(reg.claimActivityToMonday).not.toHaveBeenCalled();
      expect([...reg.settled.keys()]).toEqual([]);
    });

  /** The producer half: every object we create from a timeline entry must carry the marker the guard
   *  above reads back, or the two halves drift apart and the guard silently stops working. */
  it("every object pushed from monday carries the marker", async () => {
    timeline = [{ id: "77123", type: "note", title: "Call notes", content: "Spoke to the customer",
      custom_activity_id: null, created_at: "2026-09-12T10:00:00Z" }];

    await syncMondayTimeline(env, CARD);

    expect(posted).toHaveLength(1);
    expect(posted[0].body.properties.hs_note_body).toContain(mondayOriginMarker("77123"));
    // ...and the reverse direction is claimed at creation, while the pair is still known
    expect(reg.settled.get(`act:h2m:notes:hs1:${CONTACT}`)).toBe("monday:77123");
  });

  /**
   * THE BELL RINGS FOR OUR OWN ENTRIES TOO -- a bell whose filter is "Any activity" stamps it for every
   * Emails & Activities entry, the marketing poller's included -- so the read it triggers must push nothing of ours back.
   * Otherwise each marketing email would become a HubSpot Note dated at the send, and that Note's own
   * webhook would come round again.
   */
  it("a ring caused by the marketing poller's entry pushes nothing (no loop)", async () => {
    timeline = [
      { id: "88001", type: "custom_activity", title: "HubSpot Marketing Email: Sent -- Autumn offer",
        content: "Autumn offer [hubspot:marketing_email:k_1:550936454903]", custom_activity_id: "19000123",
        created_at: "2026-09-30T10:00:00Z" },
      // The one reply that drops the type id must not slip through either: the marker alone refuses it.
      { id: "88002", type: "note", title: "x", content: "[hubspot:marketing_email_open:k_2:550936454903]",
        custom_activity_id: null, created_at: "2026-09-30T10:01:00Z" },
    ];

    const out = await syncMondayTimeline(env, CARD);

    expect(posted).toEqual([]);
    expect(reg.claimActivityToHubspot).not.toHaveBeenCalled();
    expect(out).toContain("nothing-to-sync");
  });

  it("reports what it pushed, for the catch-up route", async () => {
    timeline = [{ id: "77124", type: "note", title: "n", content: "Spoke again",
      custom_activity_id: null, created_at: "2026-09-12T11:00:00Z" }];
    expect(await syncMondayTimeline(env, CARD)).toMatch(/action=done pushed=1 fresh=1/);
    // A repeat ring finds it already pushed and creates nothing.
    expect(await syncMondayTimeline(env, CARD)).toMatch(/action=done pushed=0 fresh=1/);
    expect(posted).toHaveLength(1);
  });
});
