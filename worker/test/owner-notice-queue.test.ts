import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";

/**
 * THE OWNER NOTICE THROUGH THE REAL QUEUE (reviewed 2026-10-09): the real DeferredSync, deferred-sync, owner-notice
 * and activity-registry on the real CreateIdempotency class. Only HubSpot, monday, the card registry and the
 * contact's own sync are faked, and the board's workflow is modelled as it runs: the moment 通知状态 turns 待通知 it
 * mails whoever the card's Contact owner shows, records them in 上次通知Owner and sets 已通知 -- when it works.
 * The Worker's write of 待通知 comes back with no changed_at -- the harder case: live, monday stamps a {label} write,
 * but undated {"index":N} status values exist on the board.
 *
 * What each case pins:
 *   - EVERY FLAG IS CHECKED: a workflow that never runs is "stuck", loudly, within minutes of the flag -- it used to
 *     read "flagged" and nothing else, ever;
 *   - AN OUTAGE DOES NOT LOSE A NOTICE: "error" is retried free for NOTICE_ERROR_GRACE_MS -- three counted retries
 *     ~12 s apart used to abandon it inside a ~40 s monday outage;
 *   - A LANDED WRITE THAT LOST ITS RESPONSE is waited on, dated by its own flag -- never "stuck" by an older one;
 *   - A BUSY NOTICE'S SYNC REQUEST does not reset that sync's attempts each wave.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));

const W = vi.hoisted(() => {
  const MYLA = { owner: "200", email: "myla@dkm.test", monday: "9200", name: "Myla" };
  const ELAINE = { owner: "300", email: "elaine@dkm.test", monday: "9300", name: "Elaine" };
  const people = [MYLA, ELAINE];
  return {
    MYLA, ELAINE, people,
    card: { owner: null as string | null, told: "", status: null as null | { text: string; index: number } },
    hs: { owner: "200", assigned: "" },
    workflowAlive: true,
    mondayDownUntil: 0,
    /** The next status write lands, and its response is lost. */
    loseNextResponse: false,
    syncFails: false,
    mailed: [] as string[],
    writes: 0,
    syncRuns: 0,
  };
});

vi.mock("../src/sync", () => ({
  // The contact's own sync: what puts HubSpot's owner into the card's Contact owner.
  syncHubspotObject: vi.fn(async () => {
    W.syncRuns++;
    if (W.syncFails) throw new Error("monday 400: ColumnValueException");
    W.card.owner = W.people.find(p => p.owner === W.hs.owner)?.monday ?? null;
    return "ok";
  }),
  deleteHubspotObject: vi.fn(async () => "ok"),
  recheckDanglingClears: vi.fn(async () => "ok"),
  settleAbandonedCreate: vi.fn(),
  getCtxCached: vi.fn(async () => ({
    ownersById: Object.fromEntries(W.people.map(p => [p.owner, { email: p.email, name: p.name }])),
    mondayUsersByEmail: Object.fromEntries(W.people.map(p => [p.email, p.monday])),
  })),
}));
vi.mock("../src/hubspot", () => ({
  hs: vi.fn(async (_e: unknown, _m: string, path: string) =>
    /\/crm\/v3\/objects\/contacts\//.test(path)
      ? { properties: { hubspot_owner_id: W.hs.owner, hubspot_owner_assigneddate: W.hs.assigned } } : null),
}));
vi.mock("../src/monday", () => ({
  findItemByColumn: vi.fn(async () => []),
  getUsersByEmail: vi.fn(async () => ({})),
  gql: vi.fn(async (_e: unknown, q: string, v: any) => {
    // What gql throws once its own retries are spent on a monday 5xx.
    if (Date.now() < W.mondayDownUntil) throw new Error("monday 503: Service Unavailable");
    if (q.includes("change_multiple_column_values")) {
      W.writes++;
      W.card.status = { text: "待通知", index: 0 };                 // an API write: no changed_at
      if (W.workflowAlive) {
        const to = W.people.find(p => p.monday === W.card.owner);
        W.mailed.push(to?.name ?? "nobody");
        W.card.told = to?.email ?? "";
        W.card.status = { text: "已通知", index: 1 };
      }
      if (W.loseNextResponse) { W.loseNextResponse = false; throw new Error("network connection lost"); }
      return { change_multiple_column_values: { id: v.i } };
    }
    const pt = W.card.owner ? [{ id: W.card.owner, kind: "person" }] : [];
    return { items: [{ column_values: [
      { id: "email_mm7v3xxg", text: W.card.told, value: W.card.told ? JSON.stringify({ email: W.card.told, text: W.card.told }) : null },
      { id: "color_mm7zktxc", text: W.card.status?.text ?? "", index: W.card.status ? W.card.status.index : null,
        value: W.card.status ? JSON.stringify({ index: W.card.status.index }) : null },
      { id: "multiple_person_mm6zap53", text: "", value: null, persons_and_teams: pt },
    ] }] };
  }),
}));
vi.mock("../src/card-registry", () => ({ lookupCard: vi.fn(async () => "item-1") }));

const { DeferredSync } = await import("../src/deferred-sync-do");
const { CreateIdempotency } = await import("../src/create-idempotency-do");
const { queueOwnerNotices, FLAG_STUCK_MS, NOTICE_BUSY_GRACE_MS } = await import("../src/owner-notice");
const { MAX_ATTEMPTS } = await import("../src/deferred-sync");

function doCtx() {
  const map = new Map<string, any>();
  const self = {
    alarmAt: null as number | null,
    storage: {
      get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
      delete: async (k: string) => { map.delete(k); }, deleteAll: async () => { map.clear(); },
      setAlarm: async (t: number) => { self.alarmAt = t; }, deleteAlarm: async () => { self.alarmAt = null; },
      getAlarm: async () => self.alarmAt,
    },
    blockConcurrencyWhile: async (fn: () => any) => fn(),
    map,
  };
  return self;
}

const T0 = Date.parse("2026-10-09T08:00:00Z");
let env: any, qctx: ReturnType<typeof doCtx>, q: any;
const lines: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  W.card = { owner: W.MYLA.monday, told: "", status: null };
  W.hs = { owner: W.MYLA.owner, assigned: new Date(T0 - 60_000).toISOString() };   // Myla, a minute ago
  W.workflowAlive = true; W.mondayDownUntil = 0; W.loseNextResponse = false; W.syncFails = false;
  W.mailed = []; W.writes = 0; W.syncRuns = 0;
  lines.length = 0;
  const rows = new Map<string, any>();
  env = { ENABLE_CRM: "true", OWNER_NOTICE: "true", DRY_RUN: "false" };
  env.CREATE_IDEMPOTENCY = { idFromName: (n: string) => n,
    get: (n: string) => { if (!rows.has(n)) rows.set(n, new (CreateIdempotency as any)(doCtx(), env)); return rows.get(n); } };
  qctx = doCtx();
  q = new (DeferredSync as any)(qctx, env);
  env.DEFERRED_SYNC = { idFromName: () => "defer", get: () => q };
  vi.spyOn(console, "log").mockImplementation((s: unknown) => { lines.push(String(s)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Run the queue's alarm each time it comes due, until it is empty or `until` passes. */
async function drain(until: number) {
  while (qctx.alarmAt != null && qctx.alarmAt <= until) {
    vi.setSystemTime(qctx.alarmAt);
    qctx.alarmAt = null;
    await q.alarm();
  }
}
const noticeLines = () => lines.filter(l => l.startsWith("[owner-notice] contact=1 "));
const outcomes = () => noticeLines().map(l => /action=(\S+)/.exec(l)![1]);
const queueEmpty = () => (qctx.map.get("q") ?? []).length === 0;

describe("every flag is checked", () => {
  it("a working workflow: flagged, checked once -- 'already' -- one email, the queue empty", async () => {
    await queueOwnerNotices(env as Env, ["1"], "owner changed in HubSpot");
    await drain(T0 + 10 * 60_000);
    expect(outcomes()).toEqual(["flagged", "already"]);
    expect(W.mailed).toEqual(["Myla"]);
    expect(queueEmpty()).toBe(true);
  });

  /** Switched off, out of quota, its Outlook connection lapsed: it used to read "flagged", and nothing ever again. */
  it("a workflow that never runs: 'waiting' on each check, then 'stuck' -- loud, final -- within minutes of the flag", async () => {
    W.workflowAlive = false;
    await queueOwnerNotices(env as Env, ["1"], "owner changed in HubSpot");
    await drain(T0 + 30 * 60_000);
    const seen = outcomes();
    expect(seen[0]).toBe("flagged");
    expect(seen.slice(1, -1).every(o => o === "waiting")).toBe(true);
    expect(seen.at(-1)).toBe("stuck");
    const stuck = noticeLines().at(-1)!;
    expect(stuck).toContain("this owner may NOT have been told");
    const flaggedAt = T0 + 15_000;                                  // the first wave
    expect(Date.now() - flaggedAt).toBeGreaterThan(FLAG_STUCK_MS);
    expect(Date.now() - flaggedAt).toBeLessThan(NOTICE_BUSY_GRACE_MS);   // said before the queue would give up
    expect(W.writes).toBe(1);
    expect(W.mailed).toEqual([]);
    expect(queueEmpty()).toBe(true);
  });
});

describe("an outage does not lose a notice", () => {
  /** THE REVIEWER'S CASE: monday down from T0+10 s to T0+45 s -- three counted retries used to abandon it at ~40 s. */
  it("monday down for the first 45 s: retried free, and flagged once monday is back -- one email", async () => {
    W.mondayDownUntil = T0 + 45_000;
    await queueOwnerNotices(env as Env, ["1"], "owner changed in HubSpot");
    await drain(T0 + 10 * 60_000);
    expect(outcomes().filter(o => o === "error").length).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
    expect(outcomes()).toContain("flagged");
    expect(lines.some(l => l.includes("action=abandoned"))).toBe(false);
    expect(W.mailed).toEqual(["Myla"]);
    expect(queueEmpty()).toBe(true);
  });
});

describe("a write that landed but lost its response", () => {
  /** F2: three days after Myla's flag (finished by the workflow), Elaine's write lands and its response is lost. */
  it("is waited on -- 'pending', dated by its own flag -- and never written twice; never 'stuck' by Myla's old flag", async () => {
    await queueOwnerNotices(env as Env, ["1"], "owner changed in HubSpot");
    await drain(T0 + 10 * 60_000);
    expect(W.mailed).toEqual(["Myla"]);
    vi.setSystemTime(T0 + 3 * 24 * 3_600_000);
    W.hs = { owner: W.ELAINE.owner, assigned: new Date(Date.now() - 30_000).toISOString() };
    W.card.owner = W.ELAINE.monday;
    W.workflowAlive = false;                                        // still sending when the retry comes...
    W.loseNextResponse = true;
    lines.length = 0;
    await queueOwnerNotices(env as Env, ["1"], "owner changed in HubSpot");
    vi.setSystemTime(Date.now() + 15_000); qctx.alarmAt = null; await q.alarm();   // the write lands; "error"
    vi.setSystemTime(Date.now() + 10_000); qctx.alarmAt = null; await q.alarm();   // the retry
    expect(outcomes()).toEqual(["error", "pending"]);
    expect(noticeLines().at(-1)).toMatch(/flag_told=no flag_age_s=10 flag_age_from=note/);
    // ...and the workflow finishes it: Elaine told, and the next run settles it.
    W.mailed.push("Elaine"); W.card.told = W.ELAINE.email; W.card.status = { text: "已通知", index: 1 };
    await drain(Date.now() + 10 * 60_000);
    expect(outcomes().at(-1)).toBe("already");
    expect(W.writes).toBe(2);
    expect(queueEmpty()).toBe(true);
  });
});

describe("a busy notice asks for its contact's sync -- without resetting that sync's attempts", () => {
  it("a sync that keeps failing is abandoned after MAX_ATTEMPTS each time it is asked for, never kept alive wave after wave", async () => {
    W.card.owner = null;                                            // the card does not show Myla yet
    W.syncFails = true;
    await queueOwnerNotices(env as Env, ["1"], "owner changed in HubSpot");
    await drain(T0 + 30 * 60_000);
    const abandonedSyncs = lines.filter(l => l.startsWith("[deferred] contact=1 action=abandoned")).length;
    expect(abandonedSyncs).toBeGreaterThan(0);
    expect(W.syncRuns).toBe(abandonedSyncs * MAX_ATTEMPTS);        // every run counted toward an abandonment
    expect(lines.some(l => l.includes("contact=1 notice action=abandoned"))).toBe(true);
    expect(queueEmpty()).toBe(true);
    console.info(`sync runs: ${W.syncRuns} (abandoned ${abandonedSyncs} times)`);
  });
});
