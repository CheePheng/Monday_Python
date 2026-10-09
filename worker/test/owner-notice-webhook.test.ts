import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE OWNER-CHANGE WEBHOOK -> THE OWNER NOTICE (OWNER_NOTICE). HubSpot is where owners change, so a contact's
 * object.propertyChange on hubspot_owner_id is what starts a reassignment notice.
 *
 * The webhook only ENQUEUES it: one cheap call, never the notice itself. A webhook's own work is cut off ~30 s
 * after its response and a notice can wait on monday's rate limit longer than that; the durable queue runs it with
 * minutes to spare, one at a time, after this batch's own sync has made any card it needed.
 */

const sync = vi.hoisted(() => ({
  deleteHubspotObject: vi.fn(async () => "ok"), syncHubspotObject: vi.fn(async () => "ok"),
  syncMondayItem: vi.fn(async () => "ok"), getCtxCached: vi.fn(),
}));
vi.mock("../src/sync", () => sync);
vi.mock("../src/hubspot", () => ({ getAssociatedIds: vi.fn(async () => []), createNote: vi.fn() }));
vi.mock("../src/monday", () => ({ getItem: vi.fn(async () => null), getUserById: vi.fn(async () => null) }));
vi.mock("../src/activity-sync", () => ({
  ACTIVITY_BY_NAME: {}, ACTIVITY_BY_TYPEID: {}, activitySyncEnabled: () => false,
  syncHubspotActivity: vi.fn(), syncMondayTimeline: vi.fn(), resetHelperOnReassignment: vi.fn(),
}));
vi.mock("../src/deferred-sync", () => ({ spillDeferred: vi.fn(async () => true) }));
vi.mock("../src/activity-retry", () => ({ scheduleDelivery: vi.fn(async () => true), scheduleIfUnresolved: vi.fn(), scheduleReconcile: vi.fn() }));
vi.mock("../src/owner-notice", async (orig) => ({
  ...(await orig<typeof import("../src/owner-notice")>()), queueOwnerNotices: vi.fn(async () => undefined),
}));

const { handleHubspot, ignoredColumns } = await import("../src/webhooks");
const { queueOwnerNotices } = await import("../src/owner-notice");
const { CRM_CONTACTS } = await import("../src/config/crm");
const queued = () => (queueOwnerNotices as any).mock.calls.map((c: any[]) => c[1]);

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const fire = async (env: Env, payload: unknown) => {
  const res = await handleHubspot(new Request("https://w/webhooks/hubspot", { method: "POST", body: JSON.stringify(payload) }), env, ectx);
  await Promise.all(waits.splice(0));
  return res;
};
const change = (id: number, prop = "hubspot_owner_id", typeId = "0-1") =>
  ({ subscriptionType: "object.propertyChange", objectTypeId: typeId, propertyName: prop, objectId: id });

const on = { ENABLE_CRM: "true", OWNER_NOTICE: "true" } as unknown as Env;

beforeEach(() => { vi.clearAllMocks(); });

describe("owner change -> one queued notice per contact", () => {
  it("queues the batch's owner changes, and still syncs the contact as before", async () => {
    await fire(on, [change(551203987421)]);
    expect(queued()).toEqual([["551203987421"]]);
    expect(sync.syncHubspotObject).toHaveBeenCalledWith(on, "contact", "551203987421", expect.anything(), expect.anything());
  });

  it("one call for the whole batch, each contact once", async () => {
    await fire(on, [change(1), change(1), change(2)]);
    expect(queued()).toEqual([["1", "2"]]);
  });

  it("a bulk reassignment of 100 is one enqueue of 100 -- nothing decided inline", async () => {
    await fire(on, Array.from({ length: 100 }, (_, i) => change(1000 + i)));
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toHaveLength(100);
  });

  it("any other property, or a company/deal owner: synced, never queued", async () => {
    await fire(on, [change(1, "lifecyclestage"), change(2, "hubspot_owner_id", "0-2"), change(3, "hubspot_owner_id", "0-3")]);
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(3);
    expect(queueOwnerNotices).not.toHaveBeenCalled();
  });

  it("switch off, or the Work-Management Worker: synced, never queued", async () => {
    await fire({ ENABLE_CRM: "true" } as Env, [change(1)]);
    await fire({ OWNER_NOTICE: "true" } as unknown as Env, [change(1)]);
    expect(sync.syncHubspotObject).toHaveBeenCalledTimes(2);
    expect(queueOwnerNotices).not.toHaveBeenCalled();
  });

  it("a failing enqueue never fails the webhook (it still answers ok) nor the contact's sync", async () => {
    (queueOwnerNotices as any).mockRejectedValueOnce(new Error("DO down"));
    const res = await fire(on, [change(1)]);
    expect(await res.text()).toBe("ok");
    expect(sync.syncHubspotObject).toHaveBeenCalled();
  });

  /** Our own write of 上次通知Owner comes back as a monday event; it maps to nothing, so it is bookkeeping. */
  it("上次通知Owner events are ignored on the monday side, like Sync State", () => {
    expect(ignoredColumns(CRM_CONTACTS).has("email_mm7v3xxg")).toBe(true);
    expect(ignoredColumns(CRM_CONTACTS).has(CRM_CONTACTS.syncStateCol)).toBe(true);
  });
});
