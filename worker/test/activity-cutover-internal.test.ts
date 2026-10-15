import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import type { Env } from "../src/types";

/**
 * TWO REASONS REAL ACTIVITY NEVER REACHED MONDAY -- the "emails still not syncing" report, 2026-09-23.
 *
 * 1. THE CUTOVER READ THE WRONG DATE. When reps connected their inboxes on 2026-09-21/22, HubSpot imported
 *    their existing mail as NEW objects with OLD dates: 819 emails, 25% of all email since the cutover.
 *    The live sync tested only hs_timestamp, so it refused them; the historical import had already
 *    finished, so it never saw them. They reached no card.
 * 2. THE BUSINESS'S OWN COMPANY TOOK 76% OF EVERYTHING. HubSpot links every email to the company that
 *    matches the sender's domain, so the internal "Test" company (www.dkmeco.com) was a destination for
 *    2,310 of 3,054 activities. The staff rule only ever covered contact cards.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
// The registry mock is the one activity-fanout.test.ts uses, so the durable-claim contract is the same.
const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed" };
  };
  return {
    settled, inflight,
    m2hReservationKey: (t: string) => `act:m2h:${t}`, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string) =>
      claim(h2m(o, i, k, d))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) => {
      settled.set(h2m(o, i, k, d), t); inflight.delete(h2m(o, i, k, d));
    }),
    unresolvedActivityToMonday: vi.fn(),
    claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
    unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(),
    releaseActivity: vi.fn(), lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(),
  };
});
vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);

const { syncHubspotActivity, activityIsLive, internalDomains, resetStaffEmailCache } = await import("../src/activity-sync");

const REP_EMAIL = "rep@dkmeco.com";
const CUSTOMER = "553287164663";
const INTERNAL_CO = "16824787545";   // "Test", domain www.dkmeco.com
const CUSTOMER_CO = "31125660999";   // a real customer
const ACT = "401418474202";
const CUTOVER = "2026-09-16T11:16:48Z";
const CARD: Record<string, string> = { [CUSTOMER]: "2860111111", [INTERNAL_CO]: "2855573545", [CUSTOMER_CO]: "2855620348" };
const BOARD_OF: Record<string, string> = {
  [CUSTOMER]: CRM_CONTACTS.boardId, [INTERNAL_CO]: CRM_ACCOUNTS.boardId, [CUSTOMER_CO]: CRM_ACCOUNTS.boardId,
};
const DOMAIN: Record<string, string> = { [INTERNAL_CO]: "www.dkmeco.com", [CUSTOMER_CO]: "risen.com" };

let created: string[] = [];
let email: Record<string, string>;
let companyReadFails = false;
let ownerEmails: string[] = [REP_EMAIL];
const env = { ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: CUTOVER } as unknown as Env;

afterEach(() => { DOMAIN[CUSTOMER_CO] = "risen.com"; });

beforeEach(() => {
  vi.clearAllMocks();
  // The owner list is cached per isolate for ten minutes; without this a test's `ownerEmails` would be
  // ignored whenever an earlier test had already filled the cache (and leak into the next one).
  resetStaffEmailCache();
  reg.settled.clear(); reg.inflight.clear();
  created = []; companyReadFails = false; ownerEmails = [REP_EMAIL];
  // The inbox-import shape: dated 2026-03 (before the cutover), created in HubSpot 2026-09-21.
  email = { hs_timestamp: "2026-03-02T01:00:00Z", hs_createdate: "2026-09-21T18:40:00Z",
    hs_email_subject: "Re: Apollo Enterprise plan review", hs_email_direction: "EMAIL", hs_email_from_email: REP_EMAIL };
  monday.findItemByColumn.mockImplementation(async (_e: Env, board: string, _c: string, value: string) =>
    CARD[value] && BOARD_OF[value] === board ? [{ id: CARD[value] }] : []);
  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) { created.push(String(v.i)); return { create_timeline_item: { id: `tl${created.length}` } }; }
    return { items: [{ column_values: [{ text: "" }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.startsWith("/crm/v3/owners")) return { results: ownerEmails.map((e, i) => ({ id: `OW${i}`, email: e })) };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: `c${i.id}@example.com` } })) };
    if (path === "/crm/v3/objects/companies/batch/read") {
      if (companyReadFails) throw new Error("hubspot 503");
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { domain: DOMAIN[i.id] ?? "" } })) };
    }
    if (path.startsWith("/crm/v3/objects/emails/")) return { properties: email };
    if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CUSTOMER }] };
    if (path.includes("/associations/companies")) return { results: [{ toObjectId: INTERNAL_CO }, { toObjectId: CUSTOMER_CO }] };
    if (path.includes("/associations/deals")) return { results: [] };
    return { properties: {} };
  });
});

describe("the cutover: refuse only what the historical import already carried", () => {
  const e = (hs_timestamp: string, hs_createdate?: string) => ({ hs_timestamp, hs_createdate });

  it("dated before, created after (an inbox import) -> live", () =>
    expect(activityIsLive(env, e("2026-03-02T01:00:00Z", "2026-09-21T18:40:00Z"))).toBe(true));

  it("created before, dated after (a task due next week) -> live -- the import deferred these", () =>
    expect(activityIsLive(env, e("2026-09-30T00:00:00Z", "2026-09-01T00:00:00Z"))).toBe(true));

  it("both before -> not live: the import has it", () =>
    expect(activityIsLive(env, e("2026-03-02T01:00:00Z", "2026-03-02T01:00:05Z"))).toBe(false));

  it("no creation date at all falls back to the activity's own date, as before", () => {
    expect(activityIsLive(env, e("2026-09-20T00:00:00Z"))).toBe(true);
    expect(activityIsLive(env, e("2026-03-02T00:00:00Z"))).toBe(false);
  });

  it("an inbox-imported customer email now reaches the customer's card", async () => {
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(created).toContain(CARD[CUSTOMER]);
  });
});

describe("the business's own company is not a destination", () => {
  it("the internal company is skipped; the customer and the customer's company are written", async () => {
    email.hs_timestamp = "2026-09-22T01:00:00Z";
    await syncHubspotActivity(env, "emails", ACT);
    expect(created).not.toContain(CARD[INTERNAL_CO]);
    expect(created).toContain(CARD[CUSTOMER_CO]);
    expect(created).toContain(CARD[CUSTOMER]);
  });

  /** Filing a customer's email in one extra place is recoverable; dropping it is not. */
  it("if the domains cannot be read, every company stays a destination", async () => {
    companyReadFails = true;
    await syncHubspotActivity(env, "emails", ACT);
    expect(created).toContain(CARD[INTERNAL_CO]);
    expect(created).toContain(CARD[CUSTOMER_CO]);
  });

  it("internal domains come from the owners, never from a public mail provider", () => {
    const d = internalDomains(new Set(["rep@dkmeco.com", "sg@dkmeco.com.sg", "someone@gmail.com", "x@DKMECO.COM"]));
    expect([...d].sort()).toEqual(["dkmeco.com", "dkmeco.com.sg"]);
  });

  it("an owner on gmail.com does not make gmail companies internal", async () => {
    ownerEmails = ["bcybislciq@gmail.com"];
    DOMAIN[CUSTOMER_CO] = "gmail.com";
    email.hs_timestamp = "2026-09-22T01:00:00Z";
    await syncHubspotActivity(env, "emails", ACT);
    expect(created).toContain(CARD[CUSTOMER_CO]);
  });
});

describe("unchanged: the Deals board is still reachable", () => {
  it("the Deals spec exists for the fan-out", () => expect(CRM_DEALS.boardId).toBe("5028000494"));
});
