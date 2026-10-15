import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CRM_CONTACTS } from "../src/config/crm";
import { expectedText, itemName } from "../src/mapping";
import type { Ctx, Env, HsRecord, MondayItem, RunOpts } from "../src/types";

/**
 * THE 2026-10-05 BURST, SIMULATED (HS_RATE_LIMIT_RETRY).
 *
 * Reps bulk-edited dozens of Contacts cards at once and ~40% of the person-edit pushes died on HubSpot's
 * ten_secondly_rolling limit: the context build's reads and getRecord (retries=1) threw on their first 429,
 * and the push was dropped. Here the REAL push path runs -- syncMondayItem -> reconcileColumnEdit ->
 * pushColumnEdit -> sendPatch -> patchRecord, with the real buildCtx, getRecord and hs() -- against a fake
 * HubSpot that answers EVERY request with the measured 429 for the first 5 seconds and normally after that.
 * Only monday (and the card registry and association pass) are mocked.
 *
 * Time is fake and moves only while the code is idle on a timer (drive), so each request is stamped with
 * exactly the waits before it. Every assertion on the caps reads those stamps: no call makes more than 5
 * attempts or waits more than 8 s, and the whole push stays inside Cloudflare's ~30 s waitUntil. Each push
 * runs with the env index.ts hands a webhook (withHsRetryDeadline), so the switch's OWN retries end 20 s after
 * it began; today's retries are never cut, so past 20 s a call is exactly what it is with the switch off.
 *
 * Two harder HubSpots follow: one that keeps HubSpot's REAL limit (190 accepted per rolling 10 s, so how
 * much it refuses depends on how much is sent) against pushes on a cold isolate, and one that refuses every
 * request until its 5th attempt -- the most the caps allow -- so the push's whole chain runs at its slowest.
 * The context is built per caller and cached per isolate for 60 s, with the switch on exactly as off (live).
 */

const monday = vi.hoisted(() => ({
  createItem: vi.fn(), deleteItem: vi.fn(), findItemByColumn: vi.fn(), getBoardItems: vi.fn(),
  getItem: vi.fn(), getUsersByEmail: vi.fn(), moveItem: vi.fn(), setColumns: vi.fn(),
  updateItem: vi.fn(), getItemsColumnText: vi.fn(), getLinkedItemIds: vi.fn(),
}));
const assoc = vi.hoisted(() => ({
  pushBirthAssociations: vi.fn(), reverseAssociations: vi.fn(), reverseLineItems: vi.fn(), syncAssociations: vi.fn(),
}));
const registry = vi.hoisted(() => ({
  lookupCard: vi.fn(), lookupCardOwner: vi.fn(), finishCard: vi.fn(), claimHubspotForItem: vi.fn(),
  finishHubspotForItem: vi.fn(), forgetHubspotForItem: vi.fn(), createWindowOf: vi.fn(), noteCreateWindowEdit: vi.fn(),
}));
const ensure = vi.hoisted(() => ({ ensureCardForRecord: vi.fn() }));

vi.mock("../src/monday", () => monday);
vi.mock("../src/associations", () => assoc);
vi.mock("../src/card-registry", () => registry);
vi.mock("../src/ensure-card", () => ensure);

const { getCtxCached, resetCtxCache, syncMondayItem } = await import("../src/sync");
const { hsRetry, withHsRetryDeadline } = await import("../src/hubspot");

const BASE_ENV = { ENABLE_CRM: "true", CRM_CUTOVER_AT: "2026-09-25T00:00:00Z", HUBSPOT_ACCESS_TOKEN: "x" };
const ON = { ...BASE_ENV, HS_RATE_LIMIT_RETRY: "true" } as unknown as Env;
const OFF = { ...BASE_ENV } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };

const MOD = "2026-10-05T01:00:00Z";       // what each card was last synced to
const PUSHED = "2026-10-05T01:00:09Z";    // what HubSpot answers a PATCH with
const BURST_MS = 5_000;                   // HubSpot answers 429 to everything for this long
const WAIT_UNTIL_MS = 30_000;             // Cloudflare cancels a webhook's waitUntil about here
const JOB = CRM_CONTACTS.fields.find(f => f.hs === "jobtitle")!.col;
const NEW_TITLE = "Head of Purchasing";

const RATE_BODY = JSON.stringify({ status: "error", message: "You have reached your ten_secondly_rolling limit.",
  errorType: "RATE_LIMIT", policyName: "TEN_SECONDLY_ROLLING" });
const TEN_SECONDLY_HEADERS = {
  "X-HubSpot-RateLimit-Interval-Milliseconds": "10000", "X-HubSpot-RateLimit-Max": "190",
  "X-HubSpot-RateLimit-Remaining": "0", "X-HubSpot-RateLimit-Daily-Remaining": "999000",
};

// ------------------------------------------------------------------------------------- fake HubSpot

interface Hit { method: string; path: string; at: number; status: number; body: string }
let hits: Hit[];
let patches: { id: string; at: number; body: any }[];
let records: Record<string, HsRecord>;
let t0: number;
let burstUntil: number;
/** Which requests HubSpot answers with the measured 429. By default: every one inside the burst. */
let refuses: (method: string, path: string, body: string) => boolean;

function fakeHubspot(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const method = init?.method ?? "GET";
  const path = u.pathname + u.search;
  const at = Date.now() - t0;
  const reply = (status: number, body: string) => {
    hits.push({ method, path, at, status, body: String(init?.body ?? "") });
    return new Response(body, { status, headers: status === 429 ? TEN_SECONDLY_HEADERS : {} });
  };
  if (u.origin !== "https://api.hubapi.com") throw new Error(`not HubSpot: ${url}`);
  if (refuses(method, path, String(init?.body ?? ""))) return reply(429, RATE_BODY);
  if (method === "GET" && u.pathname === "/crm/v3/owners/") return reply(200, JSON.stringify({ results: [] }));
  if (method === "GET" && u.pathname.startsWith("/crm/v3/properties/")) return reply(200, JSON.stringify({ options: [] }));
  if (method === "GET" && u.pathname === "/crm/v3/pipelines/deals") return reply(200, JSON.stringify({ results: [] }));
  const m = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(u.pathname);
  const rec = m ? records[m[1]] : undefined;
  if (rec && method === "GET") return reply(200, JSON.stringify({ id: rec.id, properties: rec.properties }));
  if (rec && method === "PATCH") {
    const body = JSON.parse(String(init?.body));
    patches.push({ id: rec.id, at, body });
    return reply(200, JSON.stringify({ id: rec.id, properties: { ...rec.properties, ...body.properties, lastmodifieddate: PUSHED } }));
  }
  return reply(400, JSON.stringify({ message: `unexpected ${method} ${path}` }));
}

// ------------------------------------------------------------------------------------ cards, records

const contactRec = (id: string): HsRecord => ({
  id,
  properties: { firstname: "Omar", lastname: `Ruth ${id.slice(-2)}`, email: `buyer${id}@kepsla.com`, jobtitle: "Buyer",
    sync_owner: "crm", createdate: "2026-09-26T00:00:00Z", lastmodifieddate: MOD },
});

/** The card exactly as the engine would have written it from `rec`, except Job Title, which a rep just
 *  changed: the one column the push must send. */
function editedCard(rec: HsRecord, itemId: string): MondayItem {
  const ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {},
    portalId: 1 } as unknown as Ctx;
  const cells = new Map<string, string>([[CRM_CONTACTS.idCol, rec.id], [CRM_CONTACTS.syncStateCol, MOD]]);
  for (const f of CRM_CONTACTS.fields) {
    if (f.type === "people" || cells.has(f.col)) continue;
    const t = expectedText(f, rec.properties[f.hs], ctx);
    if (t) cells.set(f.col, t);
  }
  cells.set(JOB, NEW_TITLE);
  return { id: itemId, name: itemName(rec, CRM_CONTACTS), created_at: "2026-09-26T00:00:10Z", updated_at: MOD,
    group: { id: "topics" }, column_values: [...cells].map(([id, text]) => ({ id, text })) };
}

let cards: Record<string, MondayItem>;
function seed(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = String(394787683000 + i);
    records[id] = contactRec(id);
    cards[`CARD${i}`] = editedCard(records[id], `CARD${i}`);
    ids.push(`CARD${i}`);
  }
  return ids;
}

// ------------------------------------------------------------------------------------------- driver

/** Settle `p` with the clock moving only while the code is idle on a timer (see the header). */
async function drive(p: Promise<unknown>): Promise<void> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 100_000 && !done; i++) {
    await realTick();
    if (!done && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  if (!done) throw new Error("the push never settled");
}
/** One real macrotask. Node's setImmediate, which the fake timers leave alone (the Workers types do not
 *  declare it, hence the cast). */
const realTick = () => new Promise<void>(r =>
  (globalThis as unknown as { setImmediate: (cb: () => void) => void }).setImmediate(() => r()));

/** One person's Job Title edit, as the monday webhook hands it to the sync: with the env index.ts gives the
 *  invocation (withHsRetryDeadline -- off, the very same env), and stamped with when it settled. */
const push = (env: Env, itemId: string) =>
  syncMondayItem(withHsRetryDeadline(env), CRM_CONTACTS.boardId, itemId, live, { left: 30 }, false, false, { cols: [JOB] })
    .then(out => ({ out, settledAt: Date.now() - t0 }), (e: unknown) => ({ error: String(e), settledAt: Date.now() - t0 }));

/** Every call's attempts, by request: a call is one method+path (each card's record has its own path). */
function calls(): { key: string; attempts: number; waitedMs: number; lastStatus: number }[] {
  const by = new Map<string, Hit[]>();
  for (const h of hits) by.set(`${h.method} ${h.path}`, [...(by.get(`${h.method} ${h.path}`) ?? []), h]);
  return [...by].map(([key, hs]) => ({ key, attempts: hs.length, waitedMs: hs[hs.length - 1].at - hs[0].at,
    lastStatus: hs[hs.length - 1].status }));
}

let logs: string[];
const realRandom = hsRetry.random;

beforeEach(() => {
  vi.clearAllMocks();
  resetCtxCache();
  hits = []; patches = []; records = {}; cards = {}; logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  t0 = Date.now();
  burstUntil = 0;
  refuses = () => Date.now() < burstUntil;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => fakeHubspot(String(url), init)));
  monday.getUsersByEmail.mockResolvedValue({});
  monday.getItem.mockImplementation(async (_e: unknown, id: string) => cards[id] ?? null);
  monday.setColumns.mockResolvedValue(undefined);
  monday.updateItem.mockResolvedValue(undefined);
  monday.moveItem.mockResolvedValue(undefined);
  assoc.reverseAssociations.mockResolvedValue(undefined);
  registry.lookupCard.mockResolvedValue(null);
});

afterEach(() => {
  hsRetry.random = realRandom;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Warm the context BEFORE the burst (the usual case: getCtxCached keeps it for 60 s), then start it. */
async function warmThenBurst(env: Env): Promise<void> {
  await getCtxCached(env);
  hits = [];
  burstUntil = Date.now() + BURST_MS;
}

// ------------------------------------------------------------------------------------------- the runs

describe("control, switch OFF: the 2026-10-05 failure, reproduced", () => {
  it("a warm-context push dies on getRecord's first 429 -- nothing reaches HubSpot, the card is not stamped", async () => {
    const [card] = seed(1);
    await warmThenBurst(OFF);
    const p = push(OFF, card);
    await drive(p);
    expect(await p).toMatchObject({ error: expect.stringMatching(
      /^Error: hubspot GET \/crm\/v3\/objects\/contacts\/394787683000\?properties=\S+: 429 \{"status":"error","message":"You have reached your ten_secondly_rolling limit/) });
    expect(hits).toHaveLength(1);                                // one attempt, at t=0, and no more
    expect(patches).toEqual([]);
    expect(monday.setColumns).not.toHaveBeenCalled();
  });

  it("a burst of 12 such pushes: all 12 dropped", async () => {
    const ids = seed(12);
    await warmThenBurst(OFF);
    const all = Promise.all(ids.map(id => push(OFF, id)));
    await drive(all);
    expect((await all).every(r => "error" in r)).toBe(true);
    expect(patches).toEqual([]);
  });
});

describe.each([0, 0.5, 0.999])("switch ON, jitter %s: the same burst, ridden out within the caps", (r) => {
  beforeEach(() => { hsRetry.random = () => r; });

  it("the warm-context push lands: the rep's Job Title reaches HubSpot after the burst, and the card is stamped", async () => {
    const [card] = seed(1);
    await warmThenBurst(ON);
    const p = push(ON, card);
    await drive(p);
    expect(await p).toMatchObject({ out: expect.stringContaining("action=updated-hubspot") });
    expect(patches).toEqual([{ id: "394787683000", at: expect.any(Number), body: { properties: { jobtitle: NEW_TITLE } } }]);
    expect(patches[0].at).toBeGreaterThanOrEqual(BURST_MS);
    // The env is the invocation's (withHsRetryDeadline): ON's vars and bindings, plus its deadline.
    expect(monday.setColumns).toHaveBeenCalledWith(expect.objectContaining(ON), CRM_CONTACTS.boardId, card,
      { [CRM_CONTACTS.syncStateCol]: PUSHED }, live);
    for (const c of calls()) {
      expect(c.attempts).toBeLessThanOrEqual(hsRetry.maxAttempts);
      expect(c.waitedMs).toBeLessThanOrEqual(hsRetry.maxTotalWaitMs);
      expect(c.lastStatus).toBe(200);
    }
    expect(Math.max(...hits.map(h => h.at))).toBeLessThan(WAIT_UNTIL_MS);
    expect(logs.some(l => /^\[hubspot\] action=retried-ok method=GET path=\/crm\/v3\/objects\/contacts\/394787683000\?/.test(l))).toBe(true);
  });

  it("a cold context too: the build's parallel reads, then the record read, then the PATCH -- each within the caps", async () => {
    const [card] = seed(1);
    burstUntil = Date.now() + BURST_MS;                          // nothing cached: the build runs inside the burst
    const p = push(ON, card);
    await drive(p);
    expect(await p).toMatchObject({ out: expect.stringContaining("action=updated-hubspot") });
    expect(patches.map(x => x.body)).toEqual([{ properties: { jobtitle: NEW_TITLE } }]);
    const cs = calls();
    expect(cs.filter(c => c.key.startsWith("GET /crm/v3/properties/")).length).toBeGreaterThan(10);  // the build's reads
    for (const c of cs) {
      expect(c.attempts).toBeLessThanOrEqual(hsRetry.maxAttempts);
      expect(c.waitedMs).toBeLessThanOrEqual(hsRetry.maxTotalWaitMs);
      expect(c.lastStatus).toBe(200);
    }
    expect(Math.max(...hits.map(h => h.at))).toBeLessThan(WAIT_UNTIL_MS);
  });

  it("the 12-push burst: every edit lands, each exactly once", async () => {
    const ids = seed(12);
    await warmThenBurst(ON);
    const all = Promise.all(ids.map(id => push(ON, id)));
    await drive(all);
    expect((await all).every(x => "out" in x && x.out.includes("action=updated-hubspot"))).toBe(true);
    expect(patches.map(x => x.id).sort()).toEqual(Object.keys(records).sort());
    expect(new Set(patches.map(x => x.id)).size).toBe(12);       // a PATCH is answered once and never resent
    for (const c of calls()) {
      expect(c.attempts).toBeLessThanOrEqual(hsRetry.maxAttempts);
      expect(c.waitedMs).toBeLessThanOrEqual(hsRetry.maxTotalWaitMs);
    }
    expect(Math.max(...hits.map(h => h.at))).toBeLessThan(WAIT_UNTIL_MS);
  });
});

// ---------------------------------------------- a cold isolate, against HubSpot's real limit (load-dependent)

/** HubSpot's limit as it is: at most `max` requests ACCEPTED in any rolling 10 s, so whether a request is refused
 *  depends on how many were sent before it. Refused requests are not counted (the optimistic reading). */
function rollingLimit(max = 190, windowMs = 10_000): typeof refuses {
  const accepted: number[] = [];
  return () => {
    const now = Date.now();
    while (accepted.length && now - accepted[0] >= windowMs) accepted.shift();
    if (accepted.length >= max) return true;
    accepted.push(now);
    return false;
  };
}

/** What the context builds sent: one build is 22 property reads, the owners' 2 pages and 1 pipelines read. */
const buildReads = () => ({
  properties: hits.filter(h => h.method === "GET" && h.path.startsWith("/crm/v3/properties/")).length,
  owners: hits.filter(h => h.method === "GET" && h.path.startsWith("/crm/v3/owners/")).length,
  pipelines: hits.filter(h => h.method === "GET" && h.path === "/crm/v3/pipelines/deals").length,
});
const landed = (rs: ({ out: string } | { error: string })[]) =>
  rs.filter(r => "out" in r && r.out.includes("action=updated-hubspot")).length;

describe("a bulk edit on a COLD isolate, against HubSpot's real limit (190 accepted per rolling 10 s)", () => {
  it("control, switch OFF: 8 simultaneous edits each build the context (200 GETs) -- and none lands", async () => {
    refuses = rollingLimit();
    const all = Promise.all(seed(8).map(id => push(OFF, id)));
    await drive(all);
    expect(landed(await all)).toBe(0);
    expect(patches).toEqual([]);
    expect(buildReads().properties).toBeGreaterThanOrEqual(8 * 22);   // eight builds
  });

  /**
   * A KNOWN LIMIT, NOT FIXED BY THIS SWITCH. Each push builds its own context, exactly as off (a shared build
   * was tried and taken out: a caller joined to another invocation's build was held to that invocation's fate
   * and budget). So 8 cold edits send 8 builds' 200 GETs: 190 are accepted at once, the window stays full for
   * 10 s, and a call's 8 s of retries all fall inside it. The retry alone rescues none of them -- exactly as
   * off. What it does rescue is the warm-context burst above (the isolate built its context in the last 60 s:
   * each push is then one record read and one PATCH), and a cold burst small enough to fit the window (below).
   */
  it.each([8, 40])("known limit, switch ON: %i simultaneous edits on a cold isolate each build the context -- none lands, as off", async (n) => {
    hsRetry.random = () => 0.5;
    refuses = rollingLimit();
    const all = Promise.all(seed(n).map(id => push(ON, id)));
    await drive(all);
    expect(landed(await all)).toBe(0);
    expect(patches).toEqual([]);
    expect(buildReads().properties).toBeGreaterThanOrEqual(n * 22);   // n builds, as off
    expect((await all).every(r => "error" in r && r.settledAt < WAIT_UNTIL_MS)).toBe(true);   // each failed, logged
  });

  it("switch ON: up to 7 simultaneous edits on a cold isolate stay under the limit by themselves -- every one lands", async () => {
    refuses = rollingLimit();
    const all = Promise.all(seed(7).map(id => push(ON, id)));
    await drive(all);
    expect(landed(await all)).toBe(7);
    expect(buildReads()).toEqual({ properties: 7 * 22, owners: 7 * 2, pipelines: 7 });
    expect(hits.filter(h => h.status === 429)).toEqual([]);
  });

  it("switch ON: a build that fails is not kept -- the next edit builds afresh, and lands", async () => {
    const [a, b] = seed(2);
    refuses = (_m, path) => path === "/crm/v3/pipelines/deals" && Date.now() - t0 < 30_000;
    const first = push(ON, a);
    await drive(first);
    expect(await first).toMatchObject({ error: expect.stringMatching(/GET \/crm\/v3\/pipelines\/deals: 429 /) });
    await vi.advanceTimersByTimeAsync(30_000);
    const second = push(ON, b);
    await drive(second);
    expect(await second).toMatchObject({ out: expect.stringContaining("action=updated-hubspot") });
    expect(buildReads().owners).toBe(4);                         // two builds
  });
});

// ------------------------------------------- every request refused until its 5th attempt: the slowest chain

/** Every distinct request (method, path and body) refused until its 5th attempt -- the most the caps allow. */
function untilFifthAttempt(): typeof refuses {
  const seen = new Map<string, number>();
  return (method, path, body) => {
    const k = `${method} ${path} ${body}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n < 5;
  };
}
const lastSent = () => Math.max(...hits.map(h => h.at));
const gaveUpAtDeadline = () => logs.some(l =>
  /^\[hubspot\] action=gave-up .* reason="the invocation's retry deadline \(20000 ms\) is reached"$/.test(l));

describe.each([0, 0.5, 0.999])("every request refused until its 5th attempt, jitter %s: the push ends inside the waitUntil", (r) => {
  beforeEach(() => { hsRetry.random = () => r; });

  it("warm context (record read, PATCH): the PATCH lands, well before 25 s", async () => {
    const [card] = seed(1);
    await getCtxCached(ON);
    hits = [];
    refuses = untilFifthAttempt();
    const p = push(ON, card);
    await drive(p);
    const res = await p;
    expect(res).toMatchObject({ out: expect.stringContaining("action=updated-hubspot") });
    expect(patches).toHaveLength(1);
    expect(patches[0].at).toBeLessThan(25_000);
    expect(res.settledAt).toBeLessThan(25_000);
    expect(lastSent()).toBeLessThanOrEqual(hsRetry.invocationMs);
  });

  it("cold context (owners x2, pipelines, record, PATCH): the switch stops at the 20 s deadline, today's floor at most 2 s on -- logged, inside the waitUntil", async () => {
    const [card] = seed(1);
    refuses = untilFifthAttempt();
    const p = push(ON, card);
    await drive(p);
    const res = await p;
    // Bounded per call only, this push sent its PATCH at 32-40 s: after Cloudflare had cancelled it, silently.
    // With the deadline, the switch's own waits end at 20 s. The pipelines read, begun at 16 s, then still has
    // today's last attempt to make -- at 16 + 2 + 4 = 22 s, as off makes it -- and nothing waits past that.
    const ends = { 0: 20_000, 0.5: 22_000, 0.999: 22_000 }[r as 0 | 0.5 | 0.999];
    expect(lastSent()).toBe(ends);
    expect(res.settledAt).toBe(ends);
    expect(res).toMatchObject({ error: expect.stringMatching(/^Error: hubspot GET \S+: 429 /) });   // the webhook logs it
    expect(gaveUpAtDeadline()).toBe(true);
  });
});

describe("an UNCLAIMED record (record read, ownership claim, PATCH), every request refused until its 5th attempt", () => {
  it("bounded per call it ended at 48 s; now the switch stops at 20 s, and the PATCH's last attempt -- today's, at 22 s -- lands the edit", async () => {
    hsRetry.random = () => 0.5;            // record read 0-8 s, claim 8-16 s, the PATCH from 16 s
    const [card] = seed(1);
    records["394787683000"].properties.sync_owner = "";
    await getCtxCached(ON);
    hits = [];
    refuses = untilFifthAttempt();
    const p = push(ON, card);
    await drive(p);
    const res = await p;
    // The PATCH's attempts: 16, 17, 19 and 20 s (the switch's own, cut at the deadline), then 22 s -- the moment
    // off makes its third and last (16 + 2 + 4). Cutting that one healed the rep's edit away where off lands it.
    expect(hits.filter(h => h.method === "PATCH" && h.body.includes("jobtitle")).map(h => [h.at, h.status]))
      .toEqual([[16_000, 429], [17_000, 429], [19_000, 429], [20_000, 429], [22_000, 200]]);
    expect(patches.map(x => x.body)).toEqual([{ properties: { sync_owner: "crm" } }, { properties: { jobtitle: NEW_TITLE } }]);
    expect(res).toMatchObject({ out: expect.stringContaining("action=updated-hubspot") });
    expect(res.settledAt).toBe(22_000);
    expect(res.settledAt).toBeLessThan(WAIT_UNTIL_MS);
    expect(monday.setColumns).not.toHaveBeenCalledWith(expect.anything(), CRM_CONTACTS.boardId, card,
      expect.objectContaining({ [JOB]: "Buyer" }), live);       // never healed back over the rep's edit
  });
});

// ------------------------------------------------------- the context build: per caller, on exactly as off

/**
 * THE CONTEXT IS BUILT BY THE CALLER THAT NEEDS IT, with the switch on exactly as off: getCtxCached is live's,
 * a plain 60 s cache per isolate. A build shared between concurrent callers was tried and taken out, because a
 * caller joined to ANOTHER invocation's build is held to that invocation: to its fate (Cloudflare cancels it,
 * or a client disconnects, and the build never settles -- the joiner waits on it past its own waitUntil, and its
 * coalesce entry is stranded), and to its budget (a starter late in its invocation builds with no retries left,
 * and a fresh caller joined to it fails with it). Built per caller, neither can happen: each caller's build runs
 * on its own env, and no caller ever waits on another's.
 */
describe("the context build, per caller: no caller waits on another's build (switch ON, exactly as OFF)", () => {
  it.each([["OFF", OFF], ["ON", ON]] as const)("%s: two callers that find no context each build their own", async (_l, env) => {
    const both = Promise.all([getCtxCached(env), getCtxCached(env)]);
    await drive(both);
    const [a, b] = await both;
    expect(a).not.toBe(b);
    expect(buildReads()).toEqual({ properties: 44, owners: 4, pipelines: 2 });
    expect([a, b]).toContain(await getCtxCached(env));           // the 60 s cache, as before: no third build
    expect(hits).toHaveLength(50);
  });

  it("ON: a build that never settles -- its invocation is gone -- holds up no other caller: the next edit builds its own, at once, and lands", async () => {
    const [card] = seed(1);
    // The first caller's invocation is gone mid-build: nothing it sent will ever be answered.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    void getCtxCached(withHsRetryDeadline(ON));
    await vi.advanceTimersByTimeAsync(5_000);
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => fakeHubspot(String(url), init)));
    const next = push(ON, card);
    await drive(next);
    expect(await next).toEqual({ out: expect.stringContaining("action=updated-hubspot"), settledAt: 5_000 });
    expect(buildReads()).toEqual({ properties: 22, owners: 2, pipelines: 1 });   // its own build
  });

  it("ON: a caller late in its invocation builds on its own budget only -- a fresh caller beside it is not held to it", async () => {
    hsRetry.random = () => 0.5;
    const [late, fresh] = seed(2);
    // The deal pipelines read is refused for the first 7 s. The LATE push (21 s into its invocation: the
    // switch's own retries are spent) gets today's retries only -- 0, 2 and 6 s, all refused -- and fails,
    // logged, exactly as off would. The FRESH push beside it retries on its own budget, 8 s, and lands.
    refuses = (_m, path) => path === "/crm/v3/pipelines/deals" && Date.now() - t0 < 7_000;
    const lateRun = syncMondayItem(withHsRetryDeadline(ON, Date.now() - 21_000), CRM_CONTACTS.boardId, late, live,
      { left: 30 }, false, false, { cols: [JOB] }).then(out => ({ out }), (e: unknown) => ({ error: String(e) }));
    const freshRun = push(ON, fresh);
    const both = Promise.all([lateRun, freshRun]);
    await drive(both);
    const [l, f] = await both;
    expect(l).toEqual({ error: expect.stringMatching(/^Error: hubspot GET \/crm\/v3\/pipelines\/deals: 429 /) });
    expect(f).toMatchObject({ out: expect.stringContaining("action=updated-hubspot") });
    expect(patches.map(x => x.id)).toEqual(["394787683001"]);    // the fresh edit, and only it
    expect(buildReads().pipelines).toBe(3 + 5);                  // the late build's 3 attempts, the fresh one's 5
  });
});
