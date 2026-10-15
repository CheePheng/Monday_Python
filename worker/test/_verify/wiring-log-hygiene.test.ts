import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * WIRING LENS -- the reminder's log lines carry ids only: an error that quotes an address (HubSpot's owner API, a
 * monday error body) is redacted before it is logged, on every failure path a run has. Real follow-up-reminder,
 * real activity-registry (in-memory store), real monday.ts gql (fetch stubbed); HubSpot's hs() mocked.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const BOARD = "5028000495";
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const ADDR = "rep.someone@dkmeco.com.sg";
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };

function fakeIdempotency() {
  const state = new Map<string, Map<string, any>>();
  const of = (n: string) => { if (!state.has(n)) state.set(n, new Map()); return state.get(n)!; };
  return {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => {
      const s = of(name);
      if (name.startsWith("card:")) s.set("card", { itemId: "5551" });
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
}

let logs: string[];
let labelReply: () => Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "tok",
  CREATE_IDEMPOTENCY: fakeIdempotency() }) as unknown as Env;
const props = { hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
  createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null };
const lines = () => logs.filter(l => l.startsWith("[follow-up]"));

beforeEach(() => {
  logs = [];
  labelReply = () => json(200, { data: { change_multiple_column_values: { id: "5551" } } });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    if (method === "POST") return { total: 1, results: [{ id: "9001", properties: props }] };
    if (path.startsWith("/crm/v3/objects/contacts/9001?")) return { id: "9001", properties: props };
    if (path.startsWith("/crm/v3/owners/77")) return { id: "77", email: ADDR };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const q: string = JSON.parse(init.body).query;
    if (/users\(/.test(q)) return json(200, { data: { users: [{ id: "501", email: ADDR }] } });
    if (/^\s*query/.test(q)) return json(200, { data: { items: [{ column_values: [
      { id: STATUS, text: "", index: null, value: null },
      { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
    ] }] } });
    return labelReply();
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("no address in a [follow-up] line, on any failure path", () => {
  it("CONTROL: a clean flag logs ids only", async () => {
    await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(lines().some(l => /action=flagged/.test(l))).toBe(true);
    for (const l of lines()) expect(l).not.toContain("@");
  });

  it("the owner read fails quoting the owner's address", async () => {
    const real = hub.hs.getMockImplementation()!;
    hub.hs.mockImplementation(async (e: unknown, method: string, path: string) => {
      if (path.startsWith("/crm/v3/owners/")) throw new Error(`hubspot GET ${path}: 500 {"message":"owner ${ADDR} unavailable"}`);
      return real(e, method, path);
    });
    const s = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(s.errors).toBe(1);
    for (const l of lines()) expect(l).not.toContain("@");
  });

  it("the label write fails with a monday error body quoting an address", async () => {
    labelReply = () => json(500, { error_message: `Internal error for user ${ADDR}`, status_code: 500 });
    const s = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(s.unresolved).toBe(1);
    for (const l of lines()) expect(l).not.toContain("@");
  });

  it("the search fails quoting an address", async () => {
    hub.hs.mockImplementation(async () => { throw new Error(`hubspot POST search: 400 {"message":"bad filter ${ADDR}"}`); });
    const s = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(s.errors).toBe(1);
    for (const l of lines()) expect(l).not.toContain("@");
  });
});
