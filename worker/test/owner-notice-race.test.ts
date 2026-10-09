import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE 40-CONTACT REASSIGNMENT, END TO END (owner-notice.ts, OWNER_NOTICE): the real webhook, the real durable queue
 * and the real notice -- only HubSpot, monday and the stores are faked, and the board's workflow is modelled as it
 * runs: the moment 通知状态 turns 待通知 it mails whoever the card's Contact owner shows, records them in
 * 上次通知Owner and sets 已通知.
 *
 * WHAT WOULD HAVE GONE WRONG (found in review, before OWNER_NOTICE ever ran). A rep moves 40 contacts from Desmond
 * to Myla; HubSpot delivers the 40 owner changes in one batch. The webhook queued the 40 notices FIRST, then spilled
 * contacts 16-40's updates behind them, so the queue ran n1..n40 before u16..u40: 25 flags were set on cards that
 * still showed Desmond, so Desmond would get 25 "new contact" emails and his address in 上次通知Owner -- and Myla
 * would never be told, because the note already held her assignment. The notice now flags only a card that shows
 * HubSpot's owner (else "busy", retried behind the contact's own sync, which it queues if nothing else is bringing
 * it), and the webhook queues its notices behind the overflow.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

const W = vi.hoisted(() => {
  const DESMOND = { owner: "100", email: "desmond@dkm.test", monday: "9100", name: "Desmond" };
  const MYLA = { owner: "200", email: "myla@dkm.test", monday: "9200", name: "Myla" };
  const byOwner = (o: string) => [DESMOND, MYLA].find(p => p.owner === o);
  const byMonday = (m: string | null) => [DESMOND, MYLA].find(p => p.monday === m);
  return {
    DESMOND, MYLA, byOwner, byMonday,
    /** monday cards by item id: Contact owner (a monday user id), 上次通知Owner, 通知状态. */
    cards: new Map<string, { owner: string | null; told: string; status: { text: string; index: number } | null }>(),
    /** HubSpot contacts: owner and assignment stamp. */
    hsOwner: new Map<string, { owner: string; assigned: string }>(),
    /** contact -> the name of each person the board's workflow mailed about it. */
    mailed: new Map<string, string[]>(),
    notes: new Map<string, { cycle: string; at: number; flag?: { cycle: string; at: number } }>(),
    syncs: [] as string[],
    inlineSyncFails: { on: false },
  };
});

vi.mock("../src/sync", () => ({
  // The contact's own forward sync: what puts HubSpot's owner into the card's Contact owner.
  syncHubspotObject: vi.fn(async (_e: unknown, type: string, id: string) => {
    if (type !== "contact") return "ok";
    if (W.inlineSyncFails.on) throw new Error("monday 429: rate-limited");
    const card = W.cards.get(`item-${id}`)!;
    card.owner = W.byOwner(W.hsOwner.get(id)!.owner)?.monday ?? null;
    W.syncs.push(id);
    return "ok";
  }),
  deleteHubspotObject: vi.fn(async () => "ok"),
  recheckDanglingClears: vi.fn(async () => "ok"),
  syncMondayItem: vi.fn(async () => "ok"),
  getCtxCached: vi.fn(async () => ({
    ownersById: { [W.DESMOND.owner]: { email: W.DESMOND.email, name: W.DESMOND.name },
      [W.MYLA.owner]: { email: W.MYLA.email, name: W.MYLA.name } },
    mondayUsersByEmail: { [W.DESMOND.email]: W.DESMOND.monday, [W.MYLA.email]: W.MYLA.monday },
  })),
}));
vi.mock("../src/hubspot", () => ({
  getAssociatedIds: vi.fn(async () => []),
  createNote: vi.fn(),
  hs: vi.fn(async (_e: unknown, _m: string, path: string) => {
    const m = path.match(/\/crm\/v3\/objects\/contacts\/(\d+)/);
    if (!m) return null;
    const o = W.hsOwner.get(m[1])!;
    return { properties: { hubspot_owner_id: o.owner, hubspot_owner_assigneddate: o.assigned } };
  }),
}));
vi.mock("../src/monday", () => ({
  getItem: vi.fn(async () => null),
  getUserById: vi.fn(async () => null),
  findItemByColumn: vi.fn(async () => []),
  getUsersByEmail: vi.fn(async () => ({})),
  gql: vi.fn(async (_e: unknown, q: string, v: any) => {
    if (q.includes("change_multiple_column_values")) {
      const card = W.cards.get(v.i)!;
      const cv = JSON.parse(v.c);
      if (cv.color_mm7zktxc?.label === "待通知") {
        // THE BOARD'S WORKFLOW, at once: it mails whoever the card's Contact owner shows NOW, records them, 已通知.
        const to = W.byMonday(card.owner);
        const id = v.i.slice("item-".length);
        W.mailed.set(id, [...(W.mailed.get(id) ?? []), to?.name ?? "nobody"]);
        card.told = to?.email ?? "";
        card.status = { text: "已通知", index: 1 };
      }
      return { change_multiple_column_values: { id: v.i } };
    }
    const card = W.cards.get(v.i[0])!;
    const pt = card.owner ? [{ id: card.owner, kind: "person" }] : [];
    return { items: [{ column_values: [
      { id: "email_mm7v3xxg", text: card.told, value: card.told ? JSON.stringify({ email: card.told, text: card.told }) : null },
      { id: "color_mm7zktxc", text: card.status?.text ?? "", value: card.status
          ? JSON.stringify({ index: card.status.index, changed_at: new Date().toISOString() }) : null,
        index: card.status ? card.status.index : null },
      { id: "multiple_person_mm6zap53", text: "", value: null, persons_and_teams: pt },
    ] }] };
  }),
}));
vi.mock("../src/card-registry", () => ({
  lookupCard: vi.fn(async (_e: unknown, _b: string, id: string) => `item-${id}`),
  noteCreateWindowEdit: vi.fn(async () => undefined),
}));
vi.mock("../src/activity-registry", () => ({
  acquireLock: vi.fn(async () => true),
  renewLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined),
  lastNoticedCycle: vi.fn(async (_e: unknown, c: string) => W.notes.get(c) ?? null),
  rememberNoticedCycle: vi.fn(async (_e: unknown, c: string, cycle: string, at = Date.now(), flag?: { cycle: string; at: number }) => {
    W.notes.set(c, { cycle, at, ...(flag ? { flag } : {}) }); return true;
  }),
  recordNoticeFlag: vi.fn(async (_e: unknown, c: string, settled: { cycle: string; at: number } | null, flag: { cycle: string; at: number }) => {
    W.notes.set(c, { cycle: settled?.cycle ?? "", at: settled?.at ?? 0, flag });
  }),
}));
vi.mock("../src/activity-sync", () => ({
  ACTIVITY_BY_NAME: {}, ACTIVITY_BY_TYPEID: {}, activitySyncEnabled: () => false,
  syncHubspotActivity: vi.fn(), syncMondayTimeline: vi.fn(), resetHelperOnReassignment: vi.fn(),
}));
vi.mock("../src/activity-retry", () => ({
  scheduleDelivery: vi.fn(async () => true), scheduleIfUnresolved: vi.fn(), scheduleReconcile: vi.fn(),
}));

const { handleHubspot } = await import("../src/webhooks");
const { DeferredSync } = await import("../src/deferred-sync-do");

/** The queue's Durable Object, with its input gate: one blockConcurrencyWhile body at a time, in call order. */
function doCtx() {
  const map = new Map<string, any>();
  let chain: Promise<unknown> = Promise.resolve();
  const self = {
    alarmAt: null as number | null,
    storage: {
      get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
      deleteAll: async () => { map.clear(); }, setAlarm: async (t: number) => { self.alarmAt = t; },
      deleteAlarm: async () => { self.alarmAt = null; }, getAlarm: async () => self.alarmAt,
    },
    blockConcurrencyWhile: (fn: () => any) => { const p = chain.then(fn); chain = p.then(() => {}, () => {}); return p; },
    map,
  };
  return self;
}

const IDS = Array.from({ length: 40 }, (_, i) => String(9001 + i));

/** One webhook batch of the 40 reassignments -- both properties HubSpot sends for each -- then the queue, drained. */
async function reassignAll(opts: { inlineSyncFails?: boolean } = {}) {
  const ctx = doCtx();
  const env: any = { ENABLE_CRM: "true", OWNER_NOTICE: "true", DRY_RUN: "false" };
  const q = new (DeferredSync as any)(ctx, env);
  env.DEFERRED_SYNC = { idFromName: () => "defer", get: () => q };
  const assigned = new Date(Date.now() - 60_000).toISOString();
  for (const id of IDS) {
    W.cards.set(`item-${id}`, { owner: W.DESMOND.monday, told: W.DESMOND.email, status: { text: "已通知", index: 1 } });
    W.hsOwner.set(id, { owner: W.MYLA.owner, assigned });
  }
  const payload = IDS.flatMap(id => ["hubspot_owner_id", "hubspot_owner_assigneddate"].map(propertyName =>
    ({ subscriptionType: "object.propertyChange", objectTypeId: "0-1", propertyName, objectId: Number(id) })));
  const waits: Promise<unknown>[] = [];
  const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    W.inlineSyncFails.on = !!opts.inlineSyncFails;
    await handleHubspot(new Request("https://w/webhooks/hubspot", { method: "POST", body: JSON.stringify(payload) }),
      env as Env, ectx);
    while (waits.length) await Promise.all(waits.splice(0));
    W.inlineSyncFails.on = false;
    const queued = (ctx.map.get("q") ?? []).map((x: any) => `${x.notice ? "n" : "u"}${Number(x.id) - 9000}`);
    for (let waves = 0; (ctx.map.get("q") ?? []).length && waves < 40; waves++) { ctx.alarmAt = null; await q.alarm(); }
    return { queued, left: (ctx.map.get("q") ?? []).length };
  } finally { spy.mockRestore(); W.inlineSyncFails.on = false; }
}

beforeEach(() => {
  W.cards.clear(); W.hsOwner.clear(); W.mailed.clear(); W.notes.clear(); W.syncs.length = 0;
});

describe("a 40-contact reassignment in one webhook batch", () => {
  it("queues the overflow's updates AHEAD of the notices", async () => {
    const { queued } = await reassignAll();
    const n = (i: number) => `n${i}`, u = (i: number) => `u${i}`;
    expect(queued.slice(0, 25)).toEqual(Array.from({ length: 25 }, (_, i) => u(16 + i)));
    expect(queued.slice(25)).toEqual(Array.from({ length: 40 }, (_, i) => n(1 + i)));
  });

  it("tells every contact's NEW owner, once -- never the previous one -- and leaves the queue empty", async () => {
    const { left } = await reassignAll();
    expect(left).toBe(0);
    for (const id of IDS) expect(W.mailed.get(id)).toEqual([W.MYLA.name]);
    for (const id of IDS) expect(W.cards.get(`item-${id}`)!.told).toBe(W.MYLA.email);
  });

  /** Nothing makes an inline sync finish first: when they all fail, each notice waits for -- and queues -- its sync. */
  it("...even when the batch's inline syncs fail: every notice waits for the card to show Myla, then flags", async () => {
    const { left } = await reassignAll({ inlineSyncFails: true });
    expect(left).toBe(0);
    for (const id of IDS) expect(W.mailed.get(id)).toEqual([W.MYLA.name]);
    // contacts 1-15 had no sync but the inline one: their notices queued it.
    for (const id of IDS.slice(0, 15)) expect(W.syncs).toContain(id);
  });
});
