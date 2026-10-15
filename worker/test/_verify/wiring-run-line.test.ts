import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";
// @ts-ignore -- node:fs in a test (the worker tsconfig has no Node types; vitest runs on Node)
import { readFileSync } from "node:fs";
import { watermarkName as ladWatermark, seenName as ladSeen } from "../../src/lad-sweep";
import { WM_LIVE, WM_BACKFILL } from "../../src/marketing-email-poller";

/**
 * WIRING LENS -- the run's own wiring on the shared CREATE_IDEMPOTENCY namespace, with the REAL activity-registry
 * and card-registry on an in-memory namespace whose methods can be made to fail, the REAL monday.ts (fetch stubbed):
 *   - which Durable Object names a run touches, and that none is another module's;
 *   - exactly one "[follow-up] action=run" line per invocation, whatever the store does;
 *   - DRY_RUN: no lock, no note written, no monday mutation -- on the stale-"pending" path too.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));
const { runFollowUpReminders, PENDING_SETTLE_MS } = await import("../../src/follow-up-reminder");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const NOW = T0 + 31 * MIN;
const BOARD = "5028000495";
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const dry: RunOpts = { ...live, dryRun: true };

type Fail = Partial<Record<"claimLock" | "renewLock" | "releaseLock" | "getCard" | "rememberPermanent", boolean>>;
function fakeIdempotency(fail: Fail = {}) {
  const state = new Map<string, Map<string, any>>();
  const calls: { name: string; method: string }[] = [];
  const of = (n: string) => { if (!state.has(n)) state.set(n, new Map()); return state.get(n)!; };
  const guard = (name: string, method: keyof Fail) => {
    calls.push({ name, method });
    if (fail[method]) throw new Error("Durable Object reset because its code was updated");
  };
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => {
      const s = of(name);
      return {
        async claimLock(now: number, hold: number, owner: string) {
          guard(name, "claimLock");
          const r = s.get("lock"); if (r && r.owner !== owner && now - r.at < hold) return false;
          s.set("lock", { at: now, owner }); return true;
        },
        async renewLock(now: number, owner: string) {
          guard(name, "renewLock");
          const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.set("lock", { at: now, owner }); return true;
        },
        async releaseLock(owner: string) {
          guard(name, "releaseLock");
          const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.delete("lock"); return true;
        },
        async getCard() { guard(name, "getCard"); return s.get("card")?.itemId ?? null; },
        async rememberPermanent(v: string) { guard(name, "rememberPermanent"); s.set("card", { itemId: v }); },
      };
    },
  };
  return { ns, calls, note: (n: string) => of(n).get("card")?.itemId ?? null,
    seed: (n: string, v: string) => of(n).set("card", { itemId: v }) };
}

let fake: ReturnType<typeof fakeIdempotency>;
let logs: string[];
let sent: string[];
/** The card's 跟进提醒 as monday reports it. */
let cell: { index: number | null; text: string; changedAt?: number };
const runLines = () => logs.filter(l => l.startsWith("[follow-up] action=run "));
const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "tok", CREATE_IDEMPOTENCY: fake.ns }) as unknown as Env;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.clearAllMocks();
  logs = []; sent = [];
  cell = { index: null, text: "" };
  fake = fakeIdempotency();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    const props = { hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
      createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null };
    if (method === "POST") return { total: 1, results: [{ id: "9001", properties: props }] };
    if (path.startsWith("/crm/v3/objects/contacts/9001?")) return { id: "9001", properties: props };
    if (path.startsWith("/crm/v3/owners/77")) return { id: "77", email: "owner77@example.test" };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body.query);
    if (/users\(limit:500\)/.test(body.query)) return json(200, { data: { users: [{ id: "501", email: "owner77@example.test" }] } });
    if (/^\s*query/.test(body.query)) return json(200, { data: { items: [{ column_values: [
      { id: STATUS, text: cell.text, index: cell.index,
        value: cell.index == null ? null : JSON.stringify({ index: cell.index, ...(cell.changedAt ? { changed_at: new Date(cell.changedAt).toISOString() } : {}) }) },
      { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
    ] }] } });
    return json(200, { data: { change_multiple_column_values: { id: "5551" } } });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the Durable Object names a run uses", () => {
  it("lock:follow-up, the card registry's read, and wm:fur:<contact>:<assignment ms>:<checkpoint> -- nothing else", async () => {
    fake.seed(`card:${BOARD}:9001`, "5551");
    const s = await runFollowUpReminders(env(), live, NOW);
    expect(s.flagged).toBe(1);
    expect([...new Set(fake.calls.map(c => c.name))].sort())
      .toEqual([`card:${BOARD}:9001`, "lock:follow-up", `wm:fur:9001:${T0}:30`].sort());
  });

  it("none of them is another module's: the other locks and watermarks on the same namespace", () => {
    const src = (f: string): string => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
    const lockNames = [
      /const LOCK_NAME = "([^"]+)"/.exec(src("lad-sweep.ts"))![1],
      /const LOCK_NAME = "([^"]+)"/.exec(src("marketing-email-poller.ts"))![1],
    ];
    expect(lockNames).toEqual(["lad-sweep", "marketing-email-poll"]);
    expect(src("owner-notice.ts")).toContain("const lockName = `notice:${contactId}`");
    for (const n of lockNames) expect(n).not.toBe("follow-up");
    expect("follow-up".startsWith("notice:")).toBe(false);
    const watermarks = ["tasks", ladWatermark("contacts"), ladSeen("contacts"), WM_LIVE, WM_BACKFILL];
    for (const w of watermarks) expect(w.startsWith("fur:")).toBe(false);
  });
});

describe("exactly one action=run line per invocation, whatever the store does", () => {
  it.each([
    ["the lock store throws (fails closed: busy)", { claimLock: true }, 0],
    ["the release throws (the label went out before it)", { releaseLock: true }, 1],
    ["the notes are unreadable", { getCard: true }, 0],
    ["the notes cannot be saved", { rememberPermanent: true }, 0],
    ["the renewal throws (fails closed: lost lock)", { renewLock: true }, 0],
  ] as [string, Fail, number][])("%s", async (_n, fail, labels) => {
    fake = fakeIdempotency(fail);
    fake.seed(`card:${BOARD}:9001`, "5551");
    await expect(runFollowUpReminders(env(), live, NOW)).resolves.toBeDefined();
    expect(runLines()).toHaveLength(1);
    expect(sent.filter(q => /^\s*mutation/.test(q))).toHaveLength(labels);
  });
});

describe("DRY_RUN: no lock, no note, no monday write", () => {
  it("on the ordinary path", async () => {
    fake.seed(`card:${BOARD}:9001`, "5551");
    const s = await runFollowUpReminders(env(), dry, NOW);
    expect(s.flagged).toBe(0);
    expect(fake.calls.filter(c => c.method !== "getCard")).toEqual([]);
    expect(sent.filter(q => /^\s*mutation/.test(q))).toHaveLength(0);
    expect(logs.some(l => /action=dry-run label="30分钟未跟进" owner=77$/.test(l))).toBe(true);
  });

  it("on a stale 'pending' the card shows landed: resolved in the log, but the note is NOT written", async () => {
    const pendingAt = NOW - PENDING_SETTLE_MS - MIN;
    fake.seed(`card:${BOARD}:9001`, "5551");
    fake.seed(`wm:fur:9001:${T0}:30`, `pending:${pendingAt}`);
    cell = { index: 1, text: "已提醒", changedAt: pendingAt + 2_000 };
    const s = await runFollowUpReminders(env(), dry, NOW);
    expect(s.resolved).toBe(1);
    expect(fake.note(`wm:fur:9001:${T0}:30`)).toBe(`pending:${pendingAt}`);   // untouched
    expect(fake.calls.filter(c => c.method !== "getCard")).toEqual([]);
    expect(sent.filter(q => /^\s*mutation/.test(q))).toHaveLength(0);
  });
});
