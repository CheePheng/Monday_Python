import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import {
  afterOutcome, mayDeferMirror, shouldRetry, MIRROR_SETTLE_MS,
  DELIVER_SCHEDULE_MS, RECONCILE_SCHEDULE_MS, RETRY_SCHEDULE_MS, type PendingActivity,
} from "../src/activity-retry";
import type { Env } from "../src/types";

/**
 * ACTIVITY_SKIP_MIRRORED_COPIES, end to end through the ActivityRetry Durable Object.
 *
 * monday's copy of a Contact entry onto the linked Accounts/Deals is not there the instant the Contact
 * write returns, so a check made right then reads "absent" and writes the duplicate anyway. The job's
 * FIRST delivery therefore holds the linked Company/Deal back, unclaimed, and the next delivery -- 30 s
 * later, with the full retry schedule still behind it -- checks the card and settles on monday's copy.
 * Real DO, real syncHubspotActivity; monday, HubSpot and the registry are simulated.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed", tookOverStale: false };
  };
  return {
    settled, inflight, h2m,
    m2hReservationKey: (t: string) => `act:m2h:${t}`, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string) => claim(h2m(o, i, k, d))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) => {
      settled.set(h2m(o, i, k, d), t); inflight.delete(h2m(o, i, k, d));
    }),
    unresolvedActivityToMonday: vi.fn(),
    claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
    unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(),
    releaseActivity: vi.fn(), lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);
// The REAL sync, wrapped only so the arguments the DO passes can be read back.
vi.mock("../src/activity-sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/activity-sync")>();
  return { ...real, syncHubspotActivity: vi.fn((...a: Parameters<typeof real.syncHubspotActivity>) => real.syncHubspotActivity(...a)) };
});
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

const sync = await import("../src/activity-sync");
const { ActivityRetry } = await import("../src/activity-retry-do");
vi.spyOn(console, "log").mockImplementation(() => {});

const REP_EMAIL = "rep@dkmeco.com";
const CUSTOMER = "120972797972", COMPANY = "33268028506", DEAL = "31410001";
const ACT = "403677013705";
const MARKER = `[hubspot:emails:${ACT}]`;
const CARD: Record<string, string> = { [CUSTOMER]: "2855768299", [COMPANY]: "2855639522", [DEAL]: "2859614572" };
const BOARD_OF: Record<string, string> = {
  [CUSTOMER]: CRM_CONTACTS.boardId, [COMPANY]: CRM_ACCOUNTS.boardId, [DEAL]: CRM_DEALS.boardId,
};

let links: Record<string, string[]>;
let timelines: Map<string, { id: string; content: string }[]>;
let created: string[];
let pending: (() => void)[];
let mondayCopies: boolean;
let seq: number;
const add = (card: string, e: { id: string; content: string }) => timelines.set(card, [...(timelines.get(card) ?? []), e]);
const flushCopies = () => { pending.splice(0).forEach(f => f()); };
const copiesOn = (card: string) => (timelines.get(card) ?? []).filter(e => e.content.includes(MARKER)).length;

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear();
  links = { [CARD[CUSTOMER]]: [CARD[COMPANY], CARD[DEAL]] };
  timelines = new Map(); created = []; pending = []; mondayCopies = true; seq = 0;
  monday.findItemByColumn.mockImplementation(async (_e: Env, board: string, _c: string, value: string) =>
    CARD[value] && BOARD_OF[value] === board ? [{ id: CARD[value] }] : []);
  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) {
      const card = String(v.i), content = String(v.c), id = `tl${++seq}`;
      created.push(card); add(card, { id, content });
      if (mondayCopies && card === CARD[CUSTOMER]) {
        const to = [...(links[card] ?? [])];
        pending.push(() => to.forEach(t => add(t, { id: `mc${++seq}`, content })));   // lands a moment later
      }
      return { create_timeline_item: { id } };
    }
    if (q.includes("linked_item_ids"))
      return { items: (v.i as string[]).map(id => ({ id, column_values: [{ linked_item_ids: links[id] ?? [] }] })) };
    if (q.includes("timeline_items_page"))
      return { timeline: { timeline_items_page: { cursor: null,
        timeline_items: (timelines.get(String(v.i)) ?? []).map(e => ({ id: e.id, content: e.content })) } } };
    return { items: [{ column_values: [{ text: "" }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: REP_EMAIL }] };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: `c${i.id}@example.com` } })) };
    if (path === "/crm/v3/objects/companies/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { domain: "customer.example" } })) };
    if (path.startsWith("/crm/v3/objects/emails/")) return {
      properties: { hs_timestamp: "2026-09-30T09:34:20Z", hs_email_subject: "Quotation",
        hs_email_direction: "INCOMING_EMAIL", hs_email_from_email: "c@example.com" },
    };
    const assoc: Record<string, string[]> = { contacts: [CUSTOMER], companies: [COMPANY], deals: [DEAL] };
    for (const k of Object.keys(assoc))
      if (path.includes(`/associations/${k}`)) return { results: assoc[k].map(id => ({ toObjectId: id })) };
    return { properties: {} };
  });
});

/** One real ActivityRetry over in-memory storage. */
function makeDo(flag?: string) {
  const map = new Map<string, any>();
  const self: any = { map, alarmAt: null as number | null };
  const env = {
    ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z",
    ...(flag === undefined ? {} : { ACTIVITY_SKIP_MIRRORED_COPIES: flag }),
    ACTIVITY_RETRY: { idFromName: (n: string) => n, get: () => ({ record: async () => {} }) },
  } as unknown as Env;
  const ctx = {
    storage: {
      get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
      delete: async (k: string) => { map.delete(k); }, deleteAll: async () => { map.clear(); },
      setAlarm: async (t: number) => { self.alarmAt = t; }, deleteAlarm: async () => { self.alarmAt = null; },
      getAlarm: async () => self.alarmAt,
    },
    blockConcurrencyWhile: async (fn: () => any) => fn(),
  };
  self.do = new (ActivityRetry as any)(ctx, env);
  self.env = env;
  return self;
}
const deliverJob = (): PendingActivity =>
  ({ mode: "deliver", object: "emails", hubspotId: ACT, reason: "webhook", attempts: 0, firstSeenMs: Date.now() });
const syncCalls = () => (sync.syncHubspotActivity as any).mock.calls as any[][];

describe("flag on: the first delivery holds the linked Account/Deal back, the next one finds monday's copy", () => {
  it("one entry per card, the job keeps one clock, and it ends after the ordinary reconcile looks", async () => {
    const inst = makeDo("true");
    await inst.do.schedule(deliverJob());

    await inst.do.alarm();                                           // the delivery
    expect(syncCalls()[0]).toEqual([inst.env, "emails", ACT, { deferMirrorCheck: true }]);
    expect(created).toEqual([CARD[CUSTOMER]]);
    expect(inst.map.get("job")).toMatchObject({ mode: "deliver", attempts: 0, mirrorDeferred: true, reason: "mirror-settle" });
    expect(Math.round((inst.alarmAt - Date.now()) / 1000)).toBe(MIRROR_SETTLE_MS / 1000);

    flushCopies();                                                   // 30 s later: monday's copy has landed
    await inst.do.alarm();                                           // the held destinations
    expect(syncCalls()[1]).toHaveLength(3);                          // never deferred twice
    expect(created).toEqual([CARD[CUSTOMER]]);
    expect(reg.settled.get(reg.h2m("emails", ACT, "company", COMPANY))).toMatch(/^mc/);
    expect(reg.settled.get(reg.h2m("emails", ACT, "deal", DEAL))).toMatch(/^mc/);
    expect(inst.map.get("job")).toMatchObject({ mode: "reconcile", attempts: 0 });

    await inst.do.alarm(); await inst.do.alarm();                    // the two reconcile looks
    expect(inst.map.get("job")).toBeUndefined();
    expect(created).toEqual([CARD[CUSTOMER]]);
    for (const c of Object.values(CARD)) expect(copiesOn(c)).toBe(1);
  });

  it("when monday made no copy (linked too late), the held card is written on the next pass -- never lost", async () => {
    mondayCopies = false;
    const inst = makeDo("true");
    await inst.do.schedule(deliverJob());
    await inst.do.alarm();
    expect(created).toEqual([CARD[CUSTOMER]]);
    await inst.do.alarm();
    expect(created.sort()).toEqual(Object.values(CARD).sort());
    for (const c of Object.values(CARD)) expect(copiesOn(c)).toBe(1);
  });
});

describe("flag off: the DO runs exactly as before", () => {
  it.each([["absent", undefined], ['"false"', "false"]])("flag %s: three-argument call, no deferral, today's copies", async (_n, flag) => {
    const inst = makeDo(flag);
    await inst.do.schedule(deliverJob());
    await inst.do.alarm();
    expect(syncCalls()[0]).toEqual([inst.env, "emails", ACT]);
    expect(syncCalls()[0]).toHaveLength(3);
    expect(created.sort()).toEqual(Object.values(CARD).sort());
    expect(inst.map.get("job")).toEqual({ ...deliverJob(), firstSeenMs: expect.any(Number),
      mode: "reconcile", attempts: 0, reason: "association-settle" });
    expect(inst.map.get("job").mirrorDeferred).toBeUndefined();
  });
});

describe("the deferral policy", () => {
  const job = (over: Partial<PendingActivity> = {}): PendingActivity =>
    ({ mode: "deliver", object: "emails", hubspotId: "1", reason: "webhook", attempts: 0, firstSeenMs: 0, ...over });

  it("only a job's first delivery may defer, only once, and only with the flag", () => {
    expect(mayDeferMirror(job(), true)).toBe(true);
    expect(mayDeferMirror(job(), false)).toBe(false);
    expect(mayDeferMirror(job({ attempts: 1 }), true)).toBe(false);
    expect(mayDeferMirror(job({ mirrorDeferred: true }), true)).toBe(false);
    expect(mayDeferMirror(job({ mode: "reconcile" }), true)).toBe(false);
    expect(mayDeferMirror(job({ mode: "retry" }), true)).toBe(false);
    expect(mayDeferMirror(job({ mode: undefined }), true)).toBe(false);
  });

  it("a deferred delivery comes back as a delivery in 30 s, without spending an attempt", () => {
    expect(afterOutcome(job(), "deferred", 0)).toEqual({ action: "retry", delayMs: MIRROR_SETTLE_MS,
      job: { ...job(), mirrorDeferred: true, reason: "mirror-settle" } });
    expect(MIRROR_SETTLE_MS).toBe(RECONCILE_SCHEDULE_MS[0]);
  });

  /** The held Company/Deal must have the same retry budget as a destination that was never held. */
  it("after the deferral the retry schedule is the whole ordinary one", () => {
    let j = (afterOutcome(job(), "deferred", 0) as any).job as PendingActivity;
    const delays: number[] = [];
    for (;;) {
      const s = afterOutcome(j, "unresolved", 0);
      if (s.action !== "retry") { expect(s.action).toBe("die"); break; }
      delays.push(s.delayMs); j = s.job;
    }
    expect(delays).toEqual(DELIVER_SCHEDULE_MS.slice(1));
    expect(delays).toEqual([...RETRY_SCHEDULE_MS]);
  });

  it("a second 'deferred' cannot loop: it is an ordinary, bounded retry", () => {
    const s = afterOutcome(job({ mirrorDeferred: true }), "deferred", 0);
    expect(s).toMatchObject({ action: "retry", delayMs: DELIVER_SCHEDULE_MS[1], job: { attempts: 1 } });
    expect(afterOutcome(job({ mirrorDeferred: true, attempts: DELIVER_SCHEDULE_MS.length - 1 }), "deferred", 0).action).toBe("die");
    expect(shouldRetry("deferred")).toBe(true);
  });

  it("a deferred job that then settles hands over to the ordinary reconcile", () => {
    expect(afterOutcome(job({ mirrorDeferred: true }), "skipped", 0)).toMatchObject({
      action: "retry", delayMs: RECONCILE_SCHEDULE_MS[0], job: { mode: "reconcile", attempts: 0 } });
  });
});
