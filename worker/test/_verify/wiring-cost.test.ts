import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * WIRING LENS -- what one run COSTS, counted on the real modules: the real activity-registry / card-registry on an
 * in-memory CREATE_IDEMPOTENCY, the real monday.ts gql (fetch stubbed), HubSpot's hs() mocked. Per contact:
 *   - already reminded for this checkpoint: ONE Durable Object read, nothing else;
 *   - due: 2 DO reads + renew + 2 DO writes, 1 HubSpot record GET (+1 owner GET per owner per run), the card read
 *     (+ monday's user list once per run) and the label.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const BOARD = "5028000495";
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };

function fakeIdempotency() {
  const state = new Map<string, Map<string, any>>();
  const calls: { name: string; method: string }[] = [];
  const of = (n: string) => { if (!state.has(n)) state.set(n, new Map()); return state.get(n)!; };
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => {
      const s = of(name);
      const rec = (method: string) => { calls.push({ name, method }); };
      return {
        async claimLock(now: number, hold: number, owner: string) {
          rec("claimLock"); const r = s.get("lock"); if (r && r.owner !== owner && now - r.at < hold) return false;
          s.set("lock", { at: now, owner }); return true;
        },
        async renewLock(now: number, owner: string) {
          rec("renewLock"); const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.set("lock", { at: now, owner }); return true;
        },
        async releaseLock(owner: string) {
          rec("releaseLock"); const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.delete("lock"); return true;
        },
        async getCard() { rec("getCard"); return s.get("card")?.itemId ?? null; },
        async rememberPermanent(v: string) { rec("rememberPermanent"); s.set("card", { itemId: v }); },
      };
    },
  };
  return { ns, calls, seed: (n: string, v: string) => of(n).set("card", { itemId: v }) };
}

let fake: ReturnType<typeof fakeIdempotency>;
let monday: string[];
let ids: string[];
const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "tok", CREATE_IDEMPOTENCY: fake.ns }) as unknown as Env;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const props = () => ({ hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
  createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "HubSpot", lifecyclestage: "lead", notes_last_updated: null });

beforeEach(() => {
  vi.clearAllMocks();
  monday = [];
  ids = ["9001"];
  fake = fakeIdempotency();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    if (method === "POST") return { total: ids.length, results: ids.map(id => ({ id, properties: props() })) };
    const m = /^\/crm\/v3\/objects\/contacts\/(\d+)\?/.exec(path);
    if (m) return { id: m[1], properties: props() };
    if (path.startsWith("/crm/v3/owners/77")) return { id: "77", email: "owner77@example.test" };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const q: string = JSON.parse(init.body).query;
    monday.push(/users\(/.test(q) ? "users" : /^\s*mutation/.test(q) ? "label" : "cells");
    if (/users\(/.test(q)) return json(200, { data: { users: [{ id: "501", email: "owner77@example.test" }] } });
    if (/^\s*query/.test(q)) return json(200, { data: { items: [{ column_values: [
      { id: STATUS, text: "", index: null, value: null },
      { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
    ] }] } });
    return json(200, { data: { change_multiple_column_values: { id: "1" } } });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const hsPaths = () => hub.hs.mock.calls.map(c => `${c[1]} ${String(c[2]).split("?")[0]}`);
const doOf = (prefix: string) => fake.calls.filter(c => c.name.startsWith(prefix)).map(c => c.method);

describe("the cost of a run", () => {
  it("a DUE contact: what flagging it takes", async () => {
    fake.seed(`card:${BOARD}:9001`, "5551");
    const s = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
    expect(hsPaths()).toEqual(["POST /crm/v3/objects/contacts/search", "GET /crm/v3/objects/contacts/9001",
      "GET /crm/v3/owners/77"]);
    expect(monday).toEqual(["cells", "users", "label"]);
    expect(doOf("wm:fur:")).toEqual(["getCard", "rememberPermanent", "rememberPermanent"]);   // read, pending, sent
    expect(doOf("card:")).toEqual(["getCard"]);
    expect(doOf("lock:")).toEqual(["claimLock", "renewLock", "releaseLock"]);
  });

  it("ALREADY reminded for this checkpoint: one Durable Object read per contact, and nothing else", async () => {
    ids = Array.from({ length: 20 }, (_, i) => String(9001 + i));
    for (const id of ids) {
      fake.seed(`card:${BOARD}:${id}`, `55${id}`);
      fake.seed(`wm:fur:${id}:${T0}:30`, `sent:${T0 + 31 * MIN}`);
    }
    const s = await runFollowUpReminders(env(), live, T0 + 36 * MIN);
    expect(s).toMatchObject({ candidates: 20, already: 20, flagged: 0 });
    expect(hsPaths()).toEqual(["POST /crm/v3/objects/contacts/search"]);          // the search, nothing per contact
    expect(monday).toEqual([]);                                                  // no monday call at all
    expect(doOf("wm:fur:")).toEqual(Array(20).fill("getCard"));                   // one note read each
    expect(doOf("card:")).toEqual([]);
    expect(doOf("lock:")).toEqual(["claimLock", "releaseLock"]);
  });

  it("several due contacts of one owner: the owner's email and monday's user list are read once a run", async () => {
    ids = ["9001", "9002", "9003"];
    for (const id of ids) fake.seed(`card:${BOARD}:${id}`, `55${id}`);
    const s = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    expect(s.flagged).toBe(3);
    expect(hsPaths().filter(p => p.startsWith("GET /crm/v3/owners/"))).toHaveLength(1);
    expect(monday.filter(m => m === "users")).toHaveLength(1);
    expect(monday.filter(m => m === "cells")).toHaveLength(3);
    expect(monday.filter(m => m === "label")).toHaveLength(3);
  });
});
