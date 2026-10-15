import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import type { Ctx, Env, HsRecord, RunOpts } from "../src/types";

/**
 * A CARD'S BIRTH NEVER WAITS ON AN OWNER NOTICE (reviewed 2026-10-09). The real ensureCardForRecord, owner-notice and
 * deferred-sync; only I/O is faked. With OWNER_NOTICE "true", every new Contacts card queues a notice -- and when the
 * queue did not take it (its Durable Object reset by the very deploy that flips the switch, overloaded, or full),
 * the notice ran INLINE, inside the card's birth: ~10 s of lock retries when the contact's lock was held, a minute
 * or more per monday rate-limit wait, a whole monday user list and HubSpot's owner API -- all before the caller (a
 * webhook's association pass, a Deal Cockpit request, a create's coalesce queue) got its card back. It is only
 * queued now; one the queue does not take is logged as lost.
 */

const monday = vi.hoisted(() => ({ createItem: vi.fn(), findItemByColumn: vi.fn(), getItem: vi.fn(), gql: vi.fn(),
  getUsersByEmail: vi.fn() }));
const cards = vi.hoisted(() => ({ claimCard: vi.fn(), finishCard: vi.fn(), forgetCard: vi.fn(), lookupCard: vi.fn() }));
const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const reg = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => true), renewLock: vi.fn(async () => true), releaseLock: vi.fn(async () => undefined),
  lastNoticedCycle: vi.fn(async () => null), rememberNoticedCycle: vi.fn(async () => true),
  recordNoticeFlag: vi.fn(async () => undefined),
}));
vi.mock("../src/monday", () => monday);
vi.mock("../src/card-registry", () => cards);
vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/activity-registry", () => reg);

const { ensureCardForRecord } = await import("../src/ensure-card");

const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {},
  portalId: 1 } as unknown as Ctx;
const rec: HsRecord = { id: "552000000001", properties: { firstname: "New", lastname: "Lead", hubspot_owner_id: "1739141284",
  createdate: "2026-10-09T01:00:00Z", lastmodifieddate: "2026-10-09T01:00:05Z" } };
/** The live posture: the notice on, the queue bound -- but `enqueue` answers as given. */
const envWith = (enqueue: () => Promise<unknown>) => ({ ENABLE_CRM: "true", CONTACT_CARD_NEEDS_OWNER: "true",
  OWNER_NOTICE: "true", DRY_RUN: "false",
  DEFERRED_SYNC: { idFromName: () => "x", get: () => ({ enqueue }) } }) as unknown as Env;

const lines: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  lines.length = 0;
  vi.spyOn(console, "log").mockImplementation((s: unknown) => { lines.push(String(s)); });
  cards.claimCard.mockResolvedValue({ status: "claimed" });
  cards.lookupCard.mockResolvedValue("NEWCARD");
  monday.findItemByColumn.mockResolvedValue([]);
  monday.createItem.mockResolvedValue("NEWCARD");
  hubspot.hs.mockImplementation(async (_e: unknown, _m: string, path: string) => path.startsWith("/crm/v3/owners/")
    ? { email: "myla@example.com" }
    : { properties: { hubspot_owner_id: "1739141284", hubspot_owner_assigneddate: new Date(Date.now() - 60_000).toISOString() } });
  monday.getUsersByEmail.mockResolvedValue({ "myla@example.com": "102443183" });
  monday.gql.mockResolvedValue({ items: [] });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("a new card queues its owner notice -- and never runs it", () => {
  it.each<[string, () => Promise<unknown>]>([
    ["unreachable (a deploy resetting it)", async () => { throw new Error("Durable Object reset because its code was updated"); }],
    ["full (it dropped the notice)", async () => ({ queued: 0, duplicate: 0, dropped: 1, depth: 5000,
      droppedKeys: ["contact:552000000001:n"] })],
  ])("the queue %s: the card is returned at once -- no notice read, lock or write inside its birth -- and the notice is logged lost",
    async (_why, enqueue) => {
      const env = envWith(enqueue);
      expect(await ensureCardForRecord(env, CRM_CONTACTS, ctx, rec, live)).toEqual({ status: "created", itemId: "NEWCARD" });
      expect(hubspot.hs).not.toHaveBeenCalled();
      expect(reg.acquireLock).not.toHaveBeenCalled();
      expect(monday.gql).not.toHaveBeenCalled();
      expect(monday.getUsersByEmail).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain(`[owner-notice] contacts=${rec.id} action=not-queued why="new card"`);
      expect(lines.join("\n")).toContain("lost -- nothing re-runs them");
    });

  /** The contact's lock held by another run (a queue run killed mid-wave holds it 90 s) used to cost the birth ~10 s. */
  it("...even with the contact's notice lock held elsewhere: the card's birth takes no time on it", async () => {
    vi.useFakeTimers();
    reg.acquireLock.mockResolvedValue(false as never);
    const env = envWith(async () => { throw new Error("Durable Object is overloaded"); });
    let done = false;
    const p = ensureCardForRecord(env, CRM_CONTACTS, ctx, rec, live).then(r => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(await p).toEqual({ status: "created", itemId: "NEWCARD" });
    expect(reg.acquireLock).not.toHaveBeenCalled();
  });

  it("a queue that takes it: queued, and nothing else", async () => {
    const enqueue = vi.fn(async () => ({ queued: 1, duplicate: 0, dropped: 0, depth: 1, droppedKeys: [] }));
    expect(await ensureCardForRecord(envWith(enqueue), CRM_CONTACTS, ctx, rec, live)).toEqual({ status: "created", itemId: "NEWCARD" });
    expect(enqueue).toHaveBeenCalledWith([{ type: "contact", id: rec.id, notice: true }]);
    expect(lines.join("\n")).toContain(`[owner-notice] contacts=${rec.id} action=queued why="new card"`);
    expect(hubspot.hs).not.toHaveBeenCalled();
  });
});
