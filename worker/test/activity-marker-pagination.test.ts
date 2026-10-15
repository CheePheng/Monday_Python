import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE MARKER CHECK IS NOW THE LAST LINE OF DEFENCE, so it is tested like one.
 *
 * When a stale reservation is inherited, whether a duplicate is created comes down entirely to
 * whether alreadyOnCard() can find an existing marker. Two properties of real monday timelines make
 * that harder than it looks, both measured on production data:
 *
 *   - they get long: 1,339 distinct entries on one Contact card
 *   - their pages OVERLAP: the same 36 pages returned 449 repeated rows
 *
 * So a first-page-only check, or one that treats a failed read as "absent", still duplicates — and
 * it duplicates precisely on the busiest cards, which are the ones that matter most.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
const retry = vi.hoisted(() => ({ scheduleReconcile: vi.fn(), scheduleIfUnresolved: vi.fn() }));
const reg = vi.hoisted(() => ({
  nextClaim: { status: "proceed", tookOverStale: true } as any,
  m2hReservationKey: (t: string) => `act:m2h:${t}`,
  h2mReservationKey: (o: string, i: string, k: string, d: string) => `act:h2m:${o}:${i}:${d}`,
  claimActivityToMonday: vi.fn(async () => reg.nextClaim),
  settleActivityToMonday: vi.fn(), unresolvedActivityToMonday: vi.fn(),
  claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
  unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(),
  releaseActivity: vi.fn(), lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(),
  getWatermark: vi.fn(async () => null), setWatermark: vi.fn(),
}));

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/activity-retry", () => retry);

const { syncHubspotActivity } = await import("../src/activity-sync");

const EMAIL = "400818361067";
const CONTACT = "553196381902", CARD = "2860521683";
const MARKER = `[hubspot:emails:${EMAIL}]`;

let created = 0;
/** pages the fake monday will serve, in order: each is [rows, nextCursor] */
let pages: Array<{ rows: string[]; cursor: string | null }>;
let pageIndex: number;
let readError: string | null;

const env = { ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2020-01-01T00:00:00Z" } as unknown as Env;

/** a page of filler entries that are NOT our marker */
const filler = (n: number, tag = "x") =>
  Array.from({ length: n }, (_, i) => `[hubspot:emails:9${tag}${i}]`);

beforeEach(() => {
  vi.clearAllMocks();
  created = 0; pageIndex = 0; readError = null;
  reg.nextClaim = { status: "proceed", tookOverStale: true };

  monday.findItemByColumn.mockImplementation(async (_e: Env, _b: string, _c: string, value: string) =>
    value === CONTACT ? [{ id: CARD }] : []);

  monday.gql.mockImplementation(async (_e: Env, q: string) => {
    if (q.includes("create_timeline_item")) { created++; return { create_timeline_item: { id: "tl" } }; }
    if (q.includes("timeline_items_page")) {
      if (readError) throw new Error(readError);
      const p = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex++;
      return { timeline: { timeline_items_page: {
        cursor: p.cursor, timeline_items: p.rows.map(c => ({ content: c })) } } };
    }
    return { items: [{ column_values: [{ text: "" }] }] };
  });

  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.includes("/associations/contacts")) return { results: [{ toObjectId: CONTACT }] };
    if (path.includes("/associations/")) return { results: [] };
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: "c@example.com" } })) };
    if (path.includes(`/emails/${EMAIL}`)) return { properties: {
      hs_timestamp: "2026-09-18T09:55:01Z", hs_email_subject: "Invite", hubspot_owner_id: "OW",
      hs_email_text: "Hi there" } };
    return { properties: {} };
  });
});

describe("finding an existing marker on a long timeline", () => {
  it("finds it on page 1 and creates nothing", async () => {
    pages = [{ rows: [MARKER, ...filler(99)], cursor: null }];
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });

  it("finds it on page 2, beyond the first 100 entries", async () => {
    pages = [
      { rows: filler(100, "a"), cursor: "c1" },
      { rows: [...filler(50, "b"), MARKER], cursor: null },
    ];
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });

  /** 1,339 entries over 14 pages, the marker on the last one — the real card's shape. */
  it("finds it on the fourteenth page of a production-sized timeline", async () => {
    pages = Array.from({ length: 13 }, (_, i) => ({ rows: filler(100, `p${i}`), cursor: `c${i}` }));
    pages.push({ rows: [...filler(39, "last"), MARKER], cursor: null });
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });

  it("still finds it when pages overlap and repeat rows", async () => {
    const shared = filler(60, "dup");
    pages = [
      { rows: [...shared, ...filler(40, "a")], cursor: "c1" },
      { rows: [...shared, ...filler(40, "b")], cursor: "c2" },   // 60 rows repeated
      { rows: [...shared, MARKER], cursor: null },
    ];
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });
});

describe("when the card cannot be read conclusively", () => {
  it("terminates and refuses to write when pagination repeats a cursor", async () => {
    // a cursor that never advances: without a guard this spins the whole budget then says "absent"
    pages = [{ rows: filler(100, "loop"), cursor: "SAME" }];
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);                  // must NOT fall through to a create
  });

  it("refuses to write when the timeline read throws", async () => {
    pages = [{ rows: [], cursor: null }];
    readError = "monday 500";
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);                  // fail CLOSED, never "absent"
  });

  it("refuses to write when monday returns no page at all", async () => {
    monday.gql.mockImplementation(async (_e: Env, q: string) => {
      if (q.includes("create_timeline_item")) { created++; return { create_timeline_item: { id: "tl" } }; }
      if (q.includes("timeline_items_page")) return {};        // empty response, not an error
      return { items: [{ column_values: [{ text: "" }] }] };
    });
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(0);
  });
});

describe("when the marker genuinely is not there", () => {
  it("creates exactly one entry after walking every page", async () => {
    pages = [
      { rows: filler(100, "a"), cursor: "c1" },
      { rows: filler(100, "b"), cursor: "c2" },
      { rows: filler(20, "c"), cursor: null },
    ];
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(1);                  // the retry must still be able to recover a lost write
  });

  it("does not mistake a longer id that starts with the same digits", async () => {
    pages = [{ rows: [`[hubspot:emails:${EMAIL}9]`, `[hubspot:calls:${EMAIL}]`], cursor: null }];
    await syncHubspotActivity(env, "emails", EMAIL);
    expect(created).toBe(1);                  // neither is this activity
  });
});
