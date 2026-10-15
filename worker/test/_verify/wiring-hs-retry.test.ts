import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";
import { hsRetry, hsRetryDeadlineOf } from "../../src/hubspot";

/**
 * WIRING LENS -- the reminder with HS_RATE_LIMIT_RETRY "true" (live since deploy-crm.cmd), through the REAL hubspot.ts
 * hs() and the REAL monday.ts gql (fetch stubbed per host), the real activity-registry on an in-memory store. The cron
 * env carries no invocation retry deadline (only the webhooks' does), so each HubSpot call is bounded per call; the
 * switch's waits go through hsRetry.sleep, stubbed here so the test does not wait.
 */

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const BOARD = "5028000495";
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const KEY = `fur:9001:${T0}:30`;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };

function fakeIdempotency() {
  const state = new Map<string, Map<string, any>>();
  const of = (n: string) => { if (!state.has(n)) state.set(n, new Map()); return state.get(n)!; };
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => {
      const s = of(name);
      return {
        async claimLock(now: number, hold: number, owner: string) {
          const r = s.get("lock"); if (r && r.owner !== owner && now - r.at < hold) return false;
          s.set("lock", { at: now, owner }); return true;
        },
        async renewLock(now: number, owner: string) {
          const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.set("lock", { at: now, owner }); return true;
        },
        async releaseLock(owner: string) {
          const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.delete("lock"); return true;
        },
        async getCard() { return s.get("card")?.itemId ?? null; },
        async rememberPermanent(v: string) { s.set("card", { itemId: v }); },
      };
    },
  };
  return { ns, note: (n: string) => of(n).get("card")?.itemId ?? null, seed: (n: string, v: string) => of(n).set("card", { itemId: v }) };
}

let fake: ReturnType<typeof fakeIdempotency>;
let logs: string[];
let hub: { method: string; path: string }[];
let labels: number;
/** Per HubSpot path prefix: the statuses to answer first, in order (then 200). */
let hsFail: Record<string, number[]>;
const sleeps: number[] = [];
const realSleep = hsRetry.sleep;
const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", HS_RATE_LIMIT_RETRY: "true", MONDAY_API_TOKEN: "tok",
  HUBSPOT_ACCESS_TOKEN: "hs", CREATE_IDEMPOTENCY: fake.ns }) as unknown as Env;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const props = { hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
  createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null };

beforeEach(() => {
  logs = []; hub = []; labels = 0; hsFail = {}; sleeps.length = 0;
  fake = fakeIdempotency();
  fake.seed(`card:${BOARD}:9001`, "5551");
  hsRetry.sleep = async (ms: number) => { sleeps.push(ms); };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    if (url.startsWith("https://api.hubapi.com")) {
      const path = url.slice("https://api.hubapi.com".length);
      hub.push({ method: init.method, path });
      const key = Object.keys(hsFail).find(k => path.startsWith(k));
      const st = key ? hsFail[key].shift() : undefined;
      if (st === 404) return json(404, { status: "error", message: "Object not found" });
      if (st) return json(st, { status: "error", message: "busy" }, st === 429 ? { "retry-after": "1" } : {});
      if (init.method === "POST") return json(200, { total: 1, results: [{ id: "9001", properties: props }] });
      if (path.startsWith("/crm/v3/objects/contacts/9001?")) return json(200, { id: "9001", properties: props });
      if (path.startsWith("/crm/v3/owners/77")) return json(200, { id: "77", email: "owner77@example.test" });
      return json(404, {});
    }
    const q: string = JSON.parse(init.body).query;
    if (/users\(/.test(q)) return json(200, { data: { users: [{ id: "501", email: "owner77@example.test" }] } });
    if (/^\s*query/.test(q)) return json(200, { data: { items: [{ column_values: [
      { id: STATUS, text: "", index: null, value: null },
      { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
    ] }] } });
    labels++;
    return json(200, { data: { change_multiple_column_values: { id: "5551" } } });
  }));
});
afterEach(() => { hsRetry.sleep = realSleep; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("HS_RATE_LIMIT_RETRY on", () => {
  it("the cron's env carries no invocation retry deadline (each call is bounded on its own)", () =>
    expect(hsRetryDeadlineOf(env())).toBeUndefined());

  it("a 429 on the search is waited out (Retry-After) and the run flags once", async () => {
    hsFail = { "/crm/v3/objects/contacts/search": [429] };
    const s = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(hub.filter(h => h.method === "POST")).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(s.flagged).toBe(1);
    expect(labels).toBe(1);
  });

  it("a 404 on the fresh read is still recognised as 'HubSpot has no such contact' -- nothing written", async () => {
    hsFail = { "/crm/v3/objects/contacts/9001": [404] };
    const s = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(s.skipped).toBe(1);
    expect(labels).toBe(0);
    expect(logs.some(l => /action=skip reason="HubSpot has no such contact \(404\)"/.test(l))).toBe(true);
  });

  it("an owner read that keeps failing (5xx) is an error -- nothing noted, nothing written; the next run flags once", async () => {
    hsFail = { "/crm/v3/owners/77": [503, 503, 503, 503, 503, 503, 503, 503] };
    const s1 = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(s1.errors).toBe(1);
    expect(labels).toBe(0);
    expect(fake.note(`wm:${KEY}`)).toBeNull();
    hsFail = {};
    const s2 = await runFollowUpReminders(env(), live, T0 + 36 * MIN);
    expect(s2.flagged).toBe(1);
    expect(labels).toBe(1);
  });
});
