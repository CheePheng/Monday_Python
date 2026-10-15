import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/types";
import { CRM_CONTACTS } from "../../src/config/crm";
import { specByBoard } from "../../src/config";

/**
 * WIRING LENS -- prior finding WIRING-5 (跟进提醒 events triggered whole-card reconciles), re-checked through the
 * REAL monday webhook handler, with the env the CRM Worker is deployed with (deploy-crm.cmd): the spec the webhook
 * routes on is then a COPY (CONTACT_OWNER_HUBSPOT_ONLY, CRM_CUTOVER_AT, CRM_CREATE_CUTOFF_AT each spread a new
 * object), so ObjectSpec.followUpCol must survive every copy, not only sit on CRM_CONTACTS.
 *
 * Only the sync, the actor lookup and the card registry's DO calls are mocked; webhooks.ts, config.ts, ui-actor.ts
 * run for real. fetch is stubbed to throw, so any network call would surface as an error line.
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
const registry = vi.hoisted(() => ({
  noteCreateWindowEdit: vi.fn(async () => undefined), markEdits: vi.fn(async () => undefined),
  clearMarks: vi.fn(async () => undefined),
}));
const tl = vi.hoisted(() => ({ syncMondayTimeline: vi.fn(async () => "ok") }));
vi.mock("../../src/actor-label", () => actor);
vi.mock("../../src/sync", () => sync);
vi.mock("../../src/card-registry", async (orig) => ({ ...(await orig<any>()), ...registry }));
vi.mock("../../src/activity-sync", async (orig) => ({ ...(await orig<any>()), ...tl }));

const { handleMonday } = await import("../../src/webhooks");

/** The CRM Worker's live switches that touch the monday webhook path (deploy-crm.cmd, 2026-10-12). */
const LIVE = {
  ENABLE_CRM: "true", DRY_RUN: "false", WRITE_HUBSPOT: "true", CONTACT_OWNER_HUBSPOT_ONLY: "true",
  CRM_CUTOVER_AT: "2026-09-16T11:16:48Z", CRM_CREATE_CUTOFF_AT: "2026-09-23T10:00:00Z", ASK_ADA_UI_EDITS: "true",
  STALE_FORWARD_GATE: "true", ENABLE_ACTIVITY_SYNC: "true", OWNER_NOTICE: "true", FOLLOW_UP_REMINDER: "true",
  CREATE_WINDOW_REPLAY: "false", STAGE_COARSE_REVERSE: "true",
} as unknown as Env;

const FOLLOW = "color_mm82ccsb";
const TWO_WAY = CRM_CONTACTS.fields.find(f => f.hs === "jobtitle")!.col;   // a plain two-way text column
const ITEM = 5551;

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const settle = async () => { for (let i = 0; i < 5; i++) { await Promise.allSettled(waits.splice(0)); await new Promise(r => setTimeout(r, 0)); } };
let logs: string[];

const fire = async (columnId: string, userId: string, value: unknown = { label: { index: 0, text: "30分钟未跟进" } }) => {
  await handleMonday(new Request("https://w/webhooks/monday", { method: "POST",
    body: JSON.stringify({ event: { boardId: Number(CRM_CONTACTS.boardId), pulseId: ITEM, type: "update_column_value",
      columnId, userId, value, previousValue: null } }) }), LIVE, ectx);
  await settle();
};

beforeEach(() => {
  vi.clearAllMocks();
  waits.length = 0;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WIRING-5: the 跟进提醒 column is dropped by the live webhook path", () => {
  it("the spec the webhook routes on is a transformed COPY, and it still carries followUpCol", () => {
    const routed = specByBoard(LIVE, CRM_CONTACTS.boardId)!;
    expect(routed).not.toBe(CRM_CONTACTS);                       // a copy (owner rule + cutovers)
    expect(routed.followUpCol).toBe(FOLLOW);
  });

  it("no field or relation maps 跟进提醒: the forward sync, the gate and the card watch never write it", () => {
    for (const s of [CRM_CONTACTS, specByBoard(LIVE, CRM_CONTACTS.boardId)!]) {
      expect(s.fields.some(f => f.col === FOLLOW)).toBe(false);
      expect((s.associations ?? []).some(a => a.relationCol === FOLLOW)).toBe(false);
    }
  });

  it.each([
    ["the reminder's own write (our token, ask ada)", ASK_ADA],
    ["#07 / #07b setting 已提醒 (automation user)", "-4"],
  ])("%s: no whole-card sync, no timeline read, logged as ignored", async (_n, user) => {
    await fire(FOLLOW, user);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    expect(tl.syncMondayTimeline).not.toHaveBeenCalled();
    expect(registry.markEdits).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes(`col=${FOLLOW} action=ignored reason="bookkeeping/one-way column"`))).toBe(true);
  });

  it("the clear (null value) is dropped the same way", async () => {
    await fire(FOLLOW, ASK_ADA, null);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
  });

  it("CONTROL: a two-way column's event in the same env still reaches the sync (the filter is selective)", async () => {
    await fire(TWO_WAY, "104231430", { value: "Engineer" });
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(1);
  });
});
