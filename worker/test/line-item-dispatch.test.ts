import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * A LINE-ITEM EVENT MUST REACH THE LINE-ITEM SPEC.
 *
 * This is the wiring the adversarial review proved was missing, and it is the single reason the
 * Products & Services board is inert: every HubSpot line-item event was converted into a DEAL event
 * (correct on Work Management, where a line item is only a subitem) and the CRM_LINE_ITEMS spec was
 * therefore never executed. Deal Owner has been mapped since 2026-09-14 and is empty on all 9,970
 * cards for exactly this reason — not because the mapping is wrong.
 *
 * The second half is the invalidation: a line item's Account is DERIVED through its deal, so the event
 * that makes it stale (the deal changing company) never touches the line item itself.
 *
 * These tests assert DISPATCH. The helper-level tests live in association-via.test.ts; passing those
 * while failing these is precisely the state the review caught.
 */

const sync = vi.hoisted(() => ({
  syncHubspotObject: vi.fn(async () => "ok"),
  deleteHubspotObject: vi.fn(async () => "ok"),
  syncMondayItem: vi.fn(async () => "ok"),
  getCtxCached: vi.fn(async () => ({ labels: {}, ownersById: {}, mondayUsersByEmail: {}, portalId: 1 })),
}));
const hubspot = vi.hoisted(() => ({
  getAssociatedIds: vi.fn(async () => [] as string[]),
  createNote: vi.fn(),
}));

vi.mock("../src/sync", () => sync);
vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => ({ getItem: vi.fn(async () => null), getUserById: vi.fn(async () => null) }));
vi.mock("../src/activity-sync", () => ({
  ACTIVITY_BY_NAME: {}, ACTIVITY_BY_TYPEID: {}, activitySyncEnabled: () => false,
  syncHubspotActivity: vi.fn(), syncMondayTimeline: vi.fn(), resetHelperOnReassignment: vi.fn(),
}));
vi.mock("../src/deferred-sync", () => ({ spillDeferred: vi.fn() }));
vi.mock("../src/activity-retry", () => ({ scheduleDelivery: vi.fn(async () => true), scheduleIfUnresolved: vi.fn(), scheduleReconcile: vi.fn() }));

const { handleHubspot, extractDealAssocChangeIds } = await import("../src/webhooks");

/** No HUBSPOT_CLIENT_SECRET -> verifyHubspot accepts (the unsigned/dev path), which is what lets these
 *  tests drive the real handler rather than a reimplementation of it. */
const crmEnv = { ENABLE_CRM: "true" } as unknown as Env;
const wmEnv = {} as Env;

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;

async function fire(env: Env, payload: unknown) {
  waits.length = 0;
  const res = await handleHubspot(
    new Request("https://w.example/webhooks/hubspot", { method: "POST", body: JSON.stringify(payload) }),
    env, ectx);
  await Promise.all(waits);      // the dispatch happens inside waitUntil
  return res;
}
const dispatched = () => (sync.syncHubspotObject.mock.calls as any[][]).map(c => ({ type: c[1], id: c[2] }));

const LINE_ITEM_EVENT = [{
  subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 9956357489,
  propertyName: "hubspot_owner_id", portalId: 39939588,
}];

beforeEach(() => { vi.clearAllMocks(); hubspot.getAssociatedIds.mockResolvedValue([]); });

describe("a HubSpot line-item event on the CRM deployment", () => {
  it("dispatches a line_item event — NOT a deal event", async () => {
    await fire(crmEnv, LINE_ITEM_EVENT);
    expect(dispatched()).toContainEqual({ type: "line_item", id: "9956357489" });
    expect(dispatched().map(d => d.type)).not.toContain("deal");
  });

  it("does not spend a HubSpot call looking up the parent deal", async () => {
    await fire(crmEnv, LINE_ITEM_EVENT);
    expect(hubspot.getAssociatedIds).not.toHaveBeenCalled();
  });

  it("dispatches one event per line item in a batch", async () => {
    await fire(crmEnv, [
      { subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 1 },
      { subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 2 },
    ]);
    expect(dispatched().filter(d => d.type === "line_item").map(d => d.id).sort()).toEqual(["1", "2"]);
  });
});

describe("the Work-Management deployment is untouched", () => {
  it("still converts a line-item event into its parent DEAL events", async () => {
    hubspot.getAssociatedIds.mockResolvedValue(["334777970383"]);
    await fire(wmEnv, LINE_ITEM_EVENT);
    expect(dispatched()).toContainEqual({ type: "deal", id: "334777970383" });
    expect(dispatched().map(d => d.type)).not.toContain("line_item");
  });

  it("never dispatches a line_item event, because WM has no line-items board", async () => {
    hubspot.getAssociatedIds.mockResolvedValue(["900"]);
    await fire(wmEnv, LINE_ITEM_EVENT);
    expect(dispatched().map(d => d.type)).not.toContain("line_item");
  });
});

describe("a deal changing company invalidates its line items", () => {
  const ASSOC_CHANGE = [{
    subscriptionType: "object.associationChange", fromObjectTypeId: "0-3", fromObjectId: 900,
    toObjectTypeId: "0-2", toObjectId: 555, portalId: 39939588,
  }];

  it("extracts the DEAL id from an associationChange payload", () => {
    expect(extractDealAssocChangeIds(ASSOC_CHANGE)).toEqual(["900"]);
  });

  it("re-dispatches every line item of that deal, on CRM", async () => {
    hubspot.getAssociatedIds.mockResolvedValue(["11", "12"]);
    await fire(crmEnv, ASSOC_CHANGE);
    expect(dispatched()).toContainEqual({ type: "line_item", id: "11" });
    expect(dispatched()).toContainEqual({ type: "line_item", id: "12" });
  });

  it("still syncs the deal itself", async () => {
    hubspot.getAssociatedIds.mockResolvedValue(["11"]);
    await fire(crmEnv, ASSOC_CHANGE);
    expect(dispatched()).toContainEqual({ type: "deal", id: "900" });
  });

  it("does NOT fan out on an ordinary deal property change", async () => {
    hubspot.getAssociatedIds.mockResolvedValue(["11"]);
    await fire(crmEnv, [{ subscriptionType: "object.propertyChange", objectTypeId: "0-3",
      objectId: 900, propertyName: "dealname" }]);
    expect(dispatched().map(d => d.type)).not.toContain("line_item");
  });

  it("does NOT fan out on a CONTACT association change", async () => {
    hubspot.getAssociatedIds.mockResolvedValue(["11"]);
    await fire(crmEnv, [{ subscriptionType: "object.associationChange", fromObjectTypeId: "0-1",
      fromObjectId: 77, toObjectTypeId: "0-2", toObjectId: 555 }]);
    expect(extractDealAssocChangeIds([{ subscriptionType: "object.associationChange",
      fromObjectTypeId: "0-1", fromObjectId: 77 }])).toEqual([]);
    expect(dispatched().map(d => d.type)).not.toContain("line_item");
  });

  it("does NOT fan out on the Work-Management deployment", async () => {
    hubspot.getAssociatedIds.mockResolvedValue(["11", "12"]);
    await fire(wmEnv, ASSOC_CHANGE);
    expect(dispatched().map(d => d.type)).not.toContain("line_item");
  });

  /** A failed lookup must not take down the contact/company events sharing the batch. */
  it("survives a failed line-item lookup and still syncs the deal", async () => {
    hubspot.getAssociatedIds.mockRejectedValue(new Error("HubSpot 500"));
    await expect(fire(crmEnv, ASSOC_CHANGE)).resolves.toBeTruthy();
    expect(dispatched()).toContainEqual({ type: "deal", id: "900" });
  });
});

describe("extractDealAssocChangeIds is narrow on purpose", () => {
  it("ignores non-associationChange subscriptions", () => {
    expect(extractDealAssocChangeIds([
      { subscriptionType: "object.creation", objectTypeId: "0-3", objectId: 900 },
      { subscriptionType: "object.propertyChange", objectTypeId: "0-3", objectId: 901 },
      { subscriptionType: "object.deletion", objectTypeId: "0-3", objectId: 902 },
    ])).toEqual([]);
  });

  it("accepts the legacy deal.associationChange shape too", () => {
    expect(extractDealAssocChangeIds([{ subscriptionType: "deal.associationChange", objectId: 900 }]))
      .toEqual(["900"]);
  });

  it("dedupes repeated changes to the same deal in one batch", () => {
    expect(extractDealAssocChangeIds([
      { subscriptionType: "object.associationChange", fromObjectTypeId: "0-3", fromObjectId: 900 },
      { subscriptionType: "object.associationChange", fromObjectTypeId: "0-3", fromObjectId: 900 },
    ])).toEqual(["900"]);
  });

  it.each([null, undefined, {}, [], "nonsense", [{ subscriptionType: "object.associationChange" }]])(
    "returns [] for junk: %j", (b) => expect(extractDealAssocChangeIds(b)).toEqual([]));
});
