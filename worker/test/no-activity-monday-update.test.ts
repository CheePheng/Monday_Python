import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * A MONDAY UPDATE ON A CONTACTS CARD IS WORK (NO_ACTIVITY_RELEASE, "any activity counts", 2026-10-10): the Update
 * becomes a HubSpot Note as before, and the card leaves "No Activity". Driven through the real syncMondayUpdate.
 * The Worker never posts Updates of its own, so every one is a person's.
 */

const sync = vi.hoisted(() => ({
  deleteHubspotObject: vi.fn(), syncHubspotObject: vi.fn(), syncMondayItem: vi.fn(),
  getCtxCached: vi.fn(async () => ({ ownerIdByEmail: {} })),
}));
const hubspot = vi.hoisted(() => ({ createNote: vi.fn(async () => "NOTE1"), getAssociatedIds: vi.fn(async () => []) }));
const monday = vi.hoisted(() => ({ getItem: vi.fn(), getUserById: vi.fn(async () => ({ name: "Myla", email: "" })),
  gql: vi.fn(), moveItem: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock("../src/sync", () => sync);
vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-sync", () => ({
  ACTIVITY_BY_NAME: {}, ACTIVITY_BY_TYPEID: {}, activitySyncEnabled: () => false,
  syncHubspotActivity: vi.fn(), syncMondayTimeline: vi.fn(), resetHelperOnReassignment: vi.fn(),
}));
vi.mock("../src/deferred-sync", () => ({ spillDeferred: vi.fn(async () => true) }));
vi.mock("../src/activity-retry", () => ({ scheduleDelivery: vi.fn(), scheduleIfUnresolved: vi.fn(), scheduleReconcile: vi.fn() }));
vi.mock("../src/owner-notice", () => ({ ownerNoticeOn: () => false, queueOwnerNotices: vi.fn(), runOwnerNoticesInline: vi.fn() }));

const { syncMondayUpdate } = await import("../src/webhooks");
const { CRM_ACCOUNTS, CRM_CONTACTS } = await import("../src/config/crm");

const ITEM = "2856363664";
const on = { ENABLE_CRM: "true", NO_ACTIVITY_RELEASE: "true", DRY_RUN: "false" } as unknown as Env;
const ev = { type: "create_update", pulseId: Number(ITEM), userId: 104239547, textBody: "Called her, no intention" };
const card = (groupId: string, hsId = "463919511251", idCol = CRM_CONTACTS.idCol) =>
  ({ id: ITEM, name: "x", group: { id: groupId }, column_values: [{ id: idCol, text: hsId }] });
const moved = () => monday.moveItem.mock.calls.map(c => [c[2], c[3]]);

beforeEach(() => {
  vi.clearAllMocks();
  monday.getItem.mockResolvedValue(card("group_mm7cj2yx"));
});

describe("a monday Update on a Contacts card", () => {
  it("becomes a HubSpot Note, and the card leaves No Activity -- without re-reading its group", async () => {
    await syncMondayUpdate(on, CRM_CONTACTS, ev);
    expect(hubspot.createNote).toHaveBeenCalledTimes(1);
    expect(moved()).toEqual([[ITEM, "topics"]]);
    expect(monday.gql).not.toHaveBeenCalled();
  });

  it("a card already in Active Contacts stays", async () => {
    monday.getItem.mockResolvedValue(card("topics"));
    await syncMondayUpdate(on, CRM_CONTACTS, ev);
    expect(hubspot.createNote).toHaveBeenCalledTimes(1);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("switch off: the Note is still made, the card stays", async () => {
    await syncMondayUpdate({ ...on, NO_ACTIVITY_RELEASE: "false" } as Env, CRM_CONTACTS, ev);
    expect(hubspot.createNote).toHaveBeenCalledTimes(1);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("an Update on an Accounts card moves nothing (only Contacts have the group)", async () => {
    monday.getItem.mockResolvedValue(card("group_mm7cj2yx", "40000000001", CRM_ACCOUNTS.idCol));
    await syncMondayUpdate(on, CRM_ACCOUNTS, ev);
    expect(hubspot.createNote).toHaveBeenCalledTimes(1);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a card not linked to HubSpot: no Note, no move", async () => {
    monday.getItem.mockResolvedValue(card("group_mm7cj2yx", ""));
    await syncMondayUpdate(on, CRM_CONTACTS, ev);
    expect(hubspot.createNote).not.toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });
});
