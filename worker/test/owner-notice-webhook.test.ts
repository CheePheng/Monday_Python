import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE OWNER-CHANGE WEBHOOK -> THE OWNER NOTICE (OWNER_NOTICE). HubSpot is where owners change, so a contact's
 * object.propertyChange on hubspot_owner_id is what starts a reassignment notice.
 *
 * The webhook only ENQUEUES it: one cheap call, never the notice itself. A webhook's own work is cut off ~30 s
 * after its response and a notice can wait on monday's rate limit longer than that; the durable queue runs it with
 * minutes to spare, one at a time.
 *
 * And it enqueues them BEHIND the batch's overflow. The board's workflow mails whoever the card's Contact owner
 * shows, which only the contact's own sync sets: queued first, a 40-contact reassignment runs its notices for
 * contacts 16-40 ahead of those contacts' updates, and 25 flags would mail the previous owner.
 *
 * But AHEAD of the batch's deal-association reads (CRM): up to 15 HubSpot reads one after another, in a waitUntil
 * that has ~30 s. Queued after them, the notices were lost -- every one of the batch, without a line -- whenever
 * the time ran out during the reads. What those reads append past the inline slice is spilled after them.
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
const { spillDeferred } = await import("../src/deferred-sync");
const { getAssociatedIds } = await import("../src/hubspot");
const { CRM_CONTACTS } = await import("../src/config/crm");
const queued = () => (queueOwnerNotices as any).mock.calls.map((c: any[]) => c[1]);
/** Every item handed to the durable queue, call by call, as "<type>:<id>". */
const spills = (): string[][] => (spillDeferred as any).mock.calls.map((c: any[]) => c[1].map((s: { type: string; id: string }) => `${s.type}:${s.id}`));
/** The events the batch synced inline, as "<type>:<id>". */
const inline = (): string[] => sync.syncHubspotObject.mock.calls.map((c: any[]) => `${c[1]}:${c[2]}`);
const ids = (type: string, from: number, n: number) => Array.from({ length: n }, (_, i) => `${type}:${from + i}`);

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
/** A deal's associations changed: on CRM its line items are read from HubSpot and re-synced. */
const assocChange = (dealId: number) => ({ subscriptionType: "object.associationChange", fromObjectTypeId: "0-3",
  fromObjectId: dealId, toObjectTypeId: "0-2", toObjectId: 555 });

beforeEach(() => {
  vi.clearAllMocks();
  (getAssociatedIds as any).mockImplementation(async () => []);
});

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

  it("a bulk reassignment's notices are queued AFTER the batch's overflow, so each contact's update waits ahead of its notice", async () => {
    await fire(on, Array.from({ length: 40 }, (_, i) => change(1000 + i)));
    const spill = (spillDeferred as any).mock;
    expect(spill.calls).toHaveLength(1);
    expect(spill.calls[0][1].map((s: { id: string }) => s.id)).toEqual(Array.from({ length: 25 }, (_, i) => String(1015 + i)));
    expect(spill.invocationCallOrder[0]).toBeLessThan((queueOwnerNotices as any).mock.invocationCallOrder[0]);
    expect(queued()[0]).toHaveLength(40);
  });

  /** With no queue to take them, the notices run inline: they must never hold up the batch's own syncs. */
  it("...handed to waitUntil, never awaited by the batch: its syncs do not wait for the notices", async () => {
    const order: string[] = [];
    (queueOwnerNotices as any).mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push("notices");
    });
    sync.syncHubspotObject.mockImplementationOnce(async () => { order.push("sync"); return "ok"; });
    await fire(on, [change(7)]);
    expect(order).toEqual(["sync", "notices"]);
  });

  /**
   * Both of the notice's columns come back as monday events -- 通知状态 from our own 待通知 and from the workflow's
   * 已通知, 上次通知Owner from the workflow -- and neither maps to anything in HubSpot, so both are bookkeeping.
   */
  it("通知状态 and 上次通知Owner events are ignored on the monday side, like Sync State", () => {
    const ignored = ignoredColumns(CRM_CONTACTS);
    expect(ignored.has("color_mm7zktxc")).toBe(true);
    expect(ignored.has("email_mm7v3xxg")).toBe(true);
    expect(ignored.has(CRM_CONTACTS.ownerNotice!.statusCol)).toBe(true);
    expect(ignored.has(CRM_CONTACTS.ownerNotice!.lastToldCol)).toBe(true);
    expect(ignored.has(CRM_CONTACTS.syncStateCol)).toBe(true);
  });

  /** The 02.2 follow-up reminder's 跟进提醒 is the same kind of column: three events a reminder (the Worker's clear and
   *  label, #07's 已提醒), none of them anything HubSpot holds. */
  it("跟进提醒 events are ignored too", () => {
    expect(CRM_CONTACTS.followUpCol).toBe("color_mm82ccsb");
    expect(ignoredColumns(CRM_CONTACTS).has("color_mm82ccsb")).toBe(true);
  });
});

describe("the notices never wait behind the batch's deal-association reads", () => {
  /**
   * THE CUT-OFF (reviewer residual R1). The reads are sequential HubSpot GETs inside the webhook's ~30 s waitUntil.
   * Here the one read has not returned while the test looks -- as when the waitUntil is cut off during it: the
   * notices must be queued by then, behind the contact overflow.
   */
  it("a deal-association read that has not returned: the notices are queued anyway, behind the contact overflow", async () => {
    const gate: { release?: (lineItems: string[]) => void } = {};
    (getAssociatedIds as any).mockImplementation(() => new Promise<string[]>(r => { gate.release = r; }));
    const contacts = Array.from({ length: 20 }, (_, i) => change(2000 + i));
    try {
      await handleHubspot(new Request("https://w/webhooks/hubspot", { method: "POST",
        body: JSON.stringify([...contacts, assocChange(900)]) }), on, ectx);
      await vi.waitFor(() => expect(queueOwnerNotices).toHaveBeenCalledTimes(1), { timeout: 500 });
      expect(getAssociatedIds).toHaveBeenCalledWith(on, "deals", "900", "line_items");
      expect(gate.release).toBeDefined();                     // the read is out...
      expect(sync.syncHubspotObject).not.toHaveBeenCalled();  // ...and the batch is still waiting on it
      expect(queued()).toEqual([ids("contact", 2000, 20).map(s => s.split(":")[1])]);
      // The overflow known before the reads -- contacts 16-20 and the deal -- went first, ahead of the notices.
      expect(spills()).toEqual([[...ids("contact", 2015, 5), "deal:900"]]);
      expect((spillDeferred as any).mock.invocationCallOrder[0])
        .toBeLessThan((queueOwnerNotices as any).mock.invocationCallOrder[0]);
    } finally {
      gate.release?.(["71", "72"]);
      await Promise.all(waits.splice(0));
    }
    // Once the read returns the batch finishes as before: what it appended past MAX is spilled, in a second part.
    expect(spills()).toEqual([[...ids("contact", 2015, 5), "deal:900"], ["line_item:71", "line_item:72"]]);
    expect(inline()).toEqual(ids("contact", 2000, 15));
  });

  it("line items the reads append past MAX are spilled, and the inline slice is the first MAX of the final batch", async () => {
    (getAssociatedIds as any).mockImplementation(async () => ids("x", 7000, 20).map(s => s.split(":")[1]));
    await fire(on, [change(1), assocChange(900)]);
    // contact 1, deal 900, then line items 7000-7019: 22 events, nothing past MAX until the reads.
    expect(inline()).toEqual(["contact:1", "deal:900", ...ids("line_item", 7000, 13)]);
    expect(spills()).toEqual([ids("line_item", 7013, 7)]);
    expect(queued()).toEqual([["1"]]);
  });

  it("both parts in one batch: every event past MAX is spilled exactly once -- the contacts before the notices", async () => {
    (getAssociatedIds as any).mockImplementation(async () => ["81", "82", "83"]);
    await fire(on, [...Array.from({ length: 18 }, (_, i) => change(3000 + i)), assocChange(900)]);
    const all = spills().flat();
    expect(new Set(all).size).toBe(all.length);
    expect(spills()).toEqual([[...ids("contact", 3015, 3), "deal:900"], ["line_item:81", "line_item:82", "line_item:83"]]);
    expect(inline()).toEqual(ids("contact", 3000, 15));
    expect(all.some(s => inline().includes(s))).toBe(false);          // nothing synced inline is spilled too
    const order = (spillDeferred as any).mock.invocationCallOrder as number[];
    const noticesAt = (queueOwnerNotices as any).mock.invocationCallOrder[0] as number;
    expect(order[0]).toBeLessThan(noticesAt);
    expect(order[1]).toBeGreaterThan(noticesAt);
  });

  it("reads that append nothing past MAX add no spill: one part, or none at all, as before", async () => {
    await fire(on, [...Array.from({ length: 17 }, (_, i) => change(4000 + i)), assocChange(900)]);   // the read finds none
    expect(spills()).toEqual([[...ids("contact", 4015, 2), "deal:900"]]);
    vi.clearAllMocks();
    (getAssociatedIds as any).mockImplementation(async () => ["91", "92"]);
    await fire(on, [change(4100), assocChange(901)]);
    expect(spills()).toEqual([]);
    expect(inline()).toEqual(["contact:4100", "deal:901", "line_item:91", "line_item:92"]);
  });

  /** Work Management has no line-items spec: its line-item -> deal reads still come first, then its one spill. */
  it("the Work-Management path is unchanged: line-item reads, then one spill that holds the deals they found", async () => {
    (getAssociatedIds as any).mockImplementation(async () => ["555"]);
    const wm = {} as Env;
    await fire(wm, [...Array.from({ length: 15 }, (_, i) => change(5000 + i, "lifecyclestage")),
      { subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 1, propertyName: "price" }]);
    expect(getAssociatedIds).toHaveBeenCalledTimes(1);
    expect(getAssociatedIds).toHaveBeenCalledWith(wm, "line_items", "1", "deals");
    expect(spills()).toEqual([["deal:555"]]);
    expect((getAssociatedIds as any).mock.invocationCallOrder[0])
      .toBeLessThan((spillDeferred as any).mock.invocationCallOrder[0]);
    expect(queueOwnerNotices).not.toHaveBeenCalled();
  });
});
