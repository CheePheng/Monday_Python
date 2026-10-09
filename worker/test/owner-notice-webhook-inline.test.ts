import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE WEBHOOK'S INLINE FALLBACK RUNS AFTER THE BATCH'S OWN SYNCS (reviewed 2026-10-09). The real handleHubspot,
 * owner-notice and deferred-sync; I/O faked. When the queue cannot take the owner notices (unreachable, or full),
 * the webhook runs them inline -- and used to start them at once, beside the batch's inline syncs: the notice read
 * the card before its contact's sync had put the new owner on it, answered "busy", and inline that is lost. Myla
 * was never told, though the card showed her a moment later. They now run once the batch's syncs have finished,
 * with the batch's cached owner and user lists.
 */

const W = vi.hoisted(() => ({
  cardOwner: "9100" as string | null,   // Desmond's monday user, until the contact's sync puts Myla there
  assigned: "",                         // HubSpot's stamp of Myla's assignment
  order: [] as string[],
  writes: [] as unknown[],
}));

vi.mock("../src/sync", () => ({
  syncHubspotObject: vi.fn(async () => {
    await new Promise(r => setTimeout(r, 5));                       // the inline sync's own round trips
    W.cardOwner = "9200";                                           // ...then Myla is on the card
    W.order.push("sync");
    return "ok";
  }),
  deleteHubspotObject: vi.fn(async () => "ok"), syncMondayItem: vi.fn(async () => "ok"),
  recheckDanglingClears: vi.fn(async () => "ok"),
  getCtxCached: vi.fn(async () => ({
    ownersById: { "200": { email: "myla@dkm.test", name: "Myla" }, "100": { email: "desmond@dkm.test", name: "Desmond" } },
    mondayUsersByEmail: { "myla@dkm.test": "9200", "desmond@dkm.test": "9100" },
  })),
}));
vi.mock("../src/hubspot", () => ({
  getAssociatedIds: vi.fn(async () => []), createNote: vi.fn(),
  hs: vi.fn(async (_e: unknown, _m: string, path: string) => {
    if (path.startsWith("/crm/v3/owners/")) return { id: "200", email: "myla@dkm.test" };
    return { properties: { hubspot_owner_id: "200", hubspot_owner_assigneddate: W.assigned } };
  }),
}));
vi.mock("../src/monday", () => ({
  getItem: vi.fn(async () => null), getUserById: vi.fn(async () => null),
  findItemByColumn: vi.fn(async () => [{ id: "CARD" }]),
  getUsersByEmail: vi.fn(async () => ({ "myla@dkm.test": "9200", "desmond@dkm.test": "9100" })),
  gql: vi.fn(async (_e: unknown, q: string, v: any) => {
    if (q.includes("change_multiple_column_values")) { W.writes.push(JSON.parse(v.c)); return { change_multiple_column_values: { id: v.i } }; }
    W.order.push("notice-read");
    return { items: [{ column_values: [
      { id: "email_mm7v3xxg", text: "desmond@dkm.test", value: JSON.stringify({ email: "desmond@dkm.test", text: "Desmond" }) },
      { id: "color_mm7zktxc", text: "已通知", index: 1, value: JSON.stringify({ index: 1 }) },
      { id: "multiple_person_mm6zap53", text: "", value: null, persons_and_teams: W.cardOwner ? [{ id: W.cardOwner, kind: "person" }] : [] },
    ] }] };
  }),
}));
vi.mock("../src/card-registry", () => ({
  lookupCard: vi.fn(async () => "CARD"), noteCreateWindowEdit: vi.fn(async () => undefined),
}));
vi.mock("../src/activity-registry", () => ({
  acquireLock: vi.fn(async () => true), renewLock: vi.fn(async () => true), releaseLock: vi.fn(async () => undefined),
  lastNoticedCycle: vi.fn(async () => null), rememberNoticedCycle: vi.fn(async () => true),
  recordNoticeFlag: vi.fn(async () => undefined),
}));
vi.mock("../src/activity-sync", () => ({
  ACTIVITY_BY_NAME: {}, ACTIVITY_BY_TYPEID: {}, activitySyncEnabled: () => false,
  syncHubspotActivity: vi.fn(), syncMondayTimeline: vi.fn(), resetHelperOnReassignment: vi.fn(),
}));
vi.mock("../src/activity-retry", () => ({
  scheduleDelivery: vi.fn(async () => true), scheduleIfUnresolved: vi.fn(), scheduleReconcile: vi.fn(),
}));

const { handleHubspot } = await import("../src/webhooks");
const hubspot = await import("../src/hubspot");
const monday = await import("../src/monday");

beforeEach(() => {
  vi.clearAllMocks();
  W.cardOwner = "9100"; W.order = []; W.writes = [];
  W.assigned = new Date(Date.now() - 20_000).toISOString();
});

const reassign = async (env: Env) => {
  const waits: Promise<unknown>[] = [];
  const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => { lines.push(String(s)); });
  try {
    await handleHubspot(new Request("https://w/webhooks/hubspot", { method: "POST", body: JSON.stringify([
      { subscriptionType: "object.propertyChange", objectTypeId: "0-1", propertyName: "hubspot_owner_id", objectId: 5001 }]) }), env, ectx);
    while (waits.length) await Promise.all(waits.splice(0));
  } finally { spy.mockRestore(); }
  return lines.filter(l => l.startsWith("[owner-notice]"));
};

describe("the queue cannot take the notice: it runs inline, after the batch's own sync", () => {
  it.each<[string, Record<string, unknown>]>([
    ["unreachable", { idFromName: () => "x", get: () => { throw new Error("Durable Object is overloaded"); } }],
    ["full", { idFromName: () => "x", get: () => ({ enqueue: async () => ({ queued: 0, duplicate: 0, dropped: 1, depth: 5000,
      droppedKeys: ["contact:5001:n"] }) }) }],
  ])("the queue %s: one reassignment Desmond -> Myla is flagged -- the card already shows Myla", async (_why, DEFERRED_SYNC) => {
    const env = { ENABLE_CRM: "true", OWNER_NOTICE: "true", DRY_RUN: "false", DEFERRED_SYNC } as unknown as Env;
    const lines = await reassign(env);
    expect(lines.join("\n")).toContain("contacts=5001 action=inline");
    expect(lines.join("\n")).toMatch(/contact=5001 .*action=flagged why="inline: owner changed in HubSpot" owner=200/);
    expect(lines.join("\n")).not.toContain("action=lost");
    expect(W.order).toEqual(["sync", "notice-read"]);               // the notice read the card after the sync
    expect(W.writes).toEqual([{ color_mm7zktxc: { label: "待通知" } }]);
    // With the batch's cached lists: neither HubSpot's owner API nor monday's user list was read for it.
    expect((hubspot.hs as any).mock.calls.some((c: any[]) => String(c[2]).startsWith("/crm/v3/owners/"))).toBe(false);
    expect(monday.getUsersByEmail).not.toHaveBeenCalled();
  });
});
