import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE SCENARIO THE SWEEP EXISTS FOR, end to end through the REAL sync.
 *
 *   an admin creates a Task, associated only to a Contact
 *   it syncs; the +30s/+5min looks finish
 *   three days later somebody attaches a Deal
 *   hs_lastmodifieddate does NOT move — measured behaviour, not hypothesis
 *   the incremental poller therefore never returns that Task again
 *
 * Every other test here mocks syncHubspotActivity, which proves the sweep FINDS the task but says
 * nothing about what lands on which card. This one runs the real thing, because the assertion that
 * matters is arithmetic on destinations: the Contact must still hold exactly one entry and the Deal
 * must gain exactly one — not two, and not zero.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
const retry = vi.hoisted(() => ({ scheduleReconcile: vi.fn(), scheduleIfUnresolved: vi.fn() }));

const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  const marks = new Map<string, string>();
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed" };
  };
  return {
    settled, inflight, marks,
    m2hReservationKey: (t: string) => `act:m2h:${t}`, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string) => claim(h2m(o, i, k, d))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) => {
      settled.set(h2m(o, i, k, d), t); inflight.delete(h2m(o, i, k, d));
    }),
    unresolvedActivityToMonday: vi.fn(),
    claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
    unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(),
    releaseActivity: vi.fn(), lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(),
    getWatermark: vi.fn(async (_e: Env, n: string) => marks.get(n) ?? null),
    setWatermark: vi.fn(async (_e: Env, n: string, v: string) => { marks.set(n, v); }),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/activity-retry", () => retry);

const { reconcileRecentTasks, pollTasks } = await import("../src/task-poller");

const TASK = "400900111";
const CONTACT = "553287164663", CONTACT_CARD = "2860111111";
const DEAL = "324817239796", DEAL_CARD = "2858691538";
const CARD_OF: Record<string, string> = { [CONTACT]: CONTACT_CARD, [DEAL]: DEAL_CARD };

/** What HubSpot currently says this task is attached to. Mutated mid-test, as an admin would. */
let assoc: Record<"contacts" | "companies" | "deals", string[]>;
/** monday card id -> the entries on it. */
let board: Record<string, string[]>;

const env = { ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2026-09-16T11:16:48Z" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear(); reg.marks.clear();
  assoc = { contacts: [CONTACT], companies: [], deals: [] };
  board = { [CONTACT_CARD]: [], [DEAL_CARD]: [] };

  monday.findItemByColumn.mockImplementation(async (_e: Env, _b: string, _c: string, value: string) =>
    CARD_OF[value] ? [{ id: CARD_OF[value] }] : []);

  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) {
      board[String(v.i)].push(`[hubspot:tasks:${TASK}]`);
      return { create_timeline_item: { id: `tl${Math.random()}` } };
    }
    if (q.includes("timeline_items_page")) {                 // the verifyExisting marker read
      return { timeline: { timeline_items_page: {
        cursor: null, timeline_items: (board[String(v.i)] ?? []).map(c => ({ content: c })) } } };
    }
    return { items: [{ column_values: [{ text: "" }] }] };
  });

  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.includes("/tasks/search")) return { results: [{ id: TASK, properties: {
      hs_lastmodifieddate: "2026-09-18T09:00:00.000Z" } }] };
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: `c${i.id}@example.com` } })) };
    if (path.startsWith(`/crm/v3/objects/tasks/${TASK}`)) return { properties: {
      hs_timestamp: "2024-12-19T16:00:00Z",                  // an OLD due date, as tasks routinely have
      hs_task_subject: "Follow up on renewal", hs_task_status: "NOT_STARTED" } };
    for (const k of ["contacts", "companies", "deals"] as const)
      if (path.includes(`/associations/${k}`)) return { results: assoc[k].map(id => ({ toObjectId: id })) };
    return { properties: {} };
  });
});

const entries = (card: string) => board[card].filter(c => c === `[hubspot:tasks:${TASK}]`).length;

describe("a Deal attached days later", () => {
  it("reaches the Deal card without touching the Contact's entry, and only once", async () => {
    // 1. the admin's task, contact-only, discovered by the ordinary poll
    await pollTasks(env);
    expect(entries(CONTACT_CARD)).toBe(1);
    expect(entries(DEAL_CARD)).toBe(0);
    const watermarkAfterFirstPoll = reg.marks.get("tasks");

    // 2. three days pass, someone attaches a Deal, and HubSpot does NOT move the modified date
    assoc.deals = [DEAL];

    // 3. the incremental poller is therefore no help — it returns the task, but everything it can see
    //    is already represented, so nothing new is written
    await pollTasks(env);
    expect(entries(DEAL_CARD)).toBe(1);   // note: the poll DOES catch it here because the fake still
                                          // returns the task; the sweep is what covers the real case
                                          // where the watermark has moved past it entirely
    expect(entries(CONTACT_CARD)).toBe(1);
    expect(reg.marks.get("tasks")).toBe(watermarkAfterFirstPoll);
  });

  /**
   * The real case: the watermark has moved past this task, so the incremental poller will never
   * return it again. Only the sweep can find it.
   */
  it("is found by the sweep once the watermark has moved past it", async () => {
    await pollTasks(env);
    expect(entries(CONTACT_CARD)).toBe(1);

    assoc.deals = [DEAL];
    reg.marks.set("tasks", "2026-09-30T00:00:00.000Z");      // watermark now far ahead of the task

    await reconcileRecentTasks(env);

    expect(entries(DEAL_CARD)).toBe(1);                      // the Deal gained exactly one
    expect(entries(CONTACT_CARD)).toBe(1);                   // the Contact still holds exactly one
    expect(reg.marks.get("tasks")).toBe("2026-09-30T00:00:00.000Z");   // sweep left it alone
  });

  it("creates nothing on a second sweep", async () => {
    await pollTasks(env);
    assoc.deals = [DEAL];
    await reconcileRecentTasks(env);
    await reconcileRecentTasks(env);

    expect(entries(CONTACT_CARD)).toBe(1);
    expect(entries(DEAL_CARD)).toBe(1);
  });

  /**
   * And the reason the task is reachable at all: its due date is 2024-12-19, long before the activity
   * cutover. Without the narrow bypass the sync would refuse it as pre-cutover and the sweep would
   * find a task it could never write.
   */
  it("is not refused for having an old due date", async () => {
    await pollTasks(env);
    expect(entries(CONTACT_CARD)).toBe(1);                   // due 2024-12-19, cutover 2026-09-16
  });
});
