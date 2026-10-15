import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/types";
import { CRM_CONTACTS } from "../../src/config/crm";

/**
 * REVIEW REPRO (wiring lens) -- WIRING-5: the Worker's own 跟进提醒 writes (and #07's 已提醒) each start a whole-card
 * reconcile, because color_mm82ccsb is not in ignoredColumns (webhooks.ts:92-100).
 *
 * The Contacts board's change_column_value hook (scripts/register-crm-webhooks.mjs) delivers every write: the
 * reminder's clear and its set (as our token user 104118038), then #07's 已提醒. ignoredColumns drops the owner
 * notice's 通知状态 / 上次通知Owner -- "bookkeeping too, and map to nothing in HubSpot ... A reconcile on either would
 * be pure waste" -- but has no entry for 跟进提醒, so each of these events goes on to routeMondayEdit and a
 * syncMondayItem (self-origin: reconcileForwardOnly -- a HubSpot read, a monday read, any forward writes).
 *
 * The real handleMonday runs with the live switches that matter here (ASK_ADA_UI_EDITS, STALE_FORWARD_GATE on);
 * the sync and the actor lookup are mocked, as in test/coarse-stage-webhook.test.ts.
 */

const ASK_ADA = "104118038";
const actor = vi.hoisted(() => ({
  isIntegrationActor: vi.fn(async (_e: unknown, id: string) => !id || id === "104118038"),
  isAutomationActor: (id: string) => /^-\d+$/.test(String(id ?? "").trim()),
  actorLabel: vi.fn(async () => "actor=x"),
}));
const sync = vi.hoisted(() => ({
  syncMondayItem: vi.fn(async (..._a: unknown[]) => "ok"), syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(),
  getCtxCached: vi.fn(),
}));
vi.mock("../../src/actor-label", () => actor);
vi.mock("../../src/sync", () => sync);

const { handleMonday, ignoredColumns } = await import("../../src/webhooks");
const { FOLLOW_UP } = await import("../../src/follow-up-reminder");

const LIVE = { ENABLE_CRM: "true", ASK_ADA_UI_EDITS: "true", STALE_FORWARD_GATE: "true" } as unknown as Env;
const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const settle = async () => { while (waits.length) await Promise.allSettled(waits.splice(0)); };

let logs: string[];
const post = async (columnId: string, userId: string, label: string | null, item = 5551) => {
  await handleMonday(new Request("https://w/webhooks/monday", { method: "POST",
    body: JSON.stringify({ event: { boardId: Number(CRM_CONTACTS.boardId), pulseId: item, type: "update_column_value",
      columnId, userId, value: label ? { label: { index: 0, text: label } } : null, previousValue: null,
      triggerTime: new Date().toISOString() } }) }), LIVE, ectx);
  await settle();
};

beforeEach(() => {
  vi.clearAllMocks();
  waits.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("WIRING-5: our 跟进提醒 writes come back as reconciles", () => {
  it("the owner notice's status column is bookkeeping; the reminder's is not", () => {
    const ignored = ignoredColumns(CRM_CONTACTS);
    expect(ignored.has(CRM_CONTACTS.ownerNotice!.statusCol)).toBe(true);
    expect(ignored.has(FOLLOW_UP.statusCol)).toBe(false);          // color_mm82ccsb
  });

  it("REPRO: the reminder's clear and set (our token) each reach syncMondayItem as a self-origin run", async () => {
    await post(FOLLOW_UP.statusCol, ASK_ADA, null);                // the clear
    await post(FOLLOW_UP.statusCol, ASK_ADA, "30分钟未跟进");        // the set
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(2);
    for (const c of sync.syncMondayItem.mock.calls) {
      expect(c[1]).toBe(CRM_CONTACTS.boardId);
      expect(c[6]).toBe(true);                                     // selfOrigin -> reconcileForwardOnly (sync.ts:306-308)
      expect(c[7]).toEqual({ cols: [FOLLOW_UP.statusCol] });
    }
    expect(logs.some(l => /col=color_mm82ccsb action=ignored/.test(l))).toBe(false);
  });

  it("REPRO: #07's 已提醒 write (an automation actor) reaches it too", async () => {
    await post(FOLLOW_UP.statusCol, "-4", "已提醒");
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(1);
  });

  it("control: the owner notice's 待通知 echo is dropped before any sync", async () => {
    await post(CRM_CONTACTS.ownerNotice!.statusCol, ASK_ADA, "待通知");
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    expect(logs.some(l => /action=ignored reason="bookkeeping\/one-way column"/.test(l))).toBe(true);
  });

  it("a batch: 20 cards flagged in one run -> 40 echo events -> 40 whole-card syncs", async () => {
    for (let i = 0; i < 20; i++) {
      await post(FOLLOW_UP.statusCol, ASK_ADA, null, 6000 + i);
      await post(FOLLOW_UP.statusCol, ASK_ADA, "30分钟未跟进", 6000 + i);
    }
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(40);
  });
});
