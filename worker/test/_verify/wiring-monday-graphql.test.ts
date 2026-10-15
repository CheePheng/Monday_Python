import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";
// @ts-ignore -- node:fs in a test (the worker tsconfig has no Node types; vitest runs on Node)
import { readFileSync } from "node:fs";

/**
 * WIRING LENS -- what the rewrite actually SENDS to monday, through the REAL monday.ts gql (fetch stubbed): the
 * API-Version header, the card read, the label mutation, and how the real gql's retries / rate-limit waits map onto
 * the note (only MondayRateLimitedError releases it). The notes and the lock run through the real activity-registry
 * on an in-memory CREATE_IDEMPOTENCY; the card registry is the real one on the same store. HubSpot is mocked.
 *
 * The query and mutation are compared with the owner notice's (owner-notice.ts), which has run live on the same
 * API version since 2026-10-09: same shape, so the same validity.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const NOW = T0 + 31 * MIN;
const BOARD = "5028000495";
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const KEY = `wm:fur:9001:${T0}:30`;
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

type Req = { headers: Record<string, string>; query: string; variables: any };
let sent: Req[];
/** How the next label mutations answer, in order: a Response factory each. */
let labelReplies: (() => Response)[];
let fake: ReturnType<typeof fakeIdempotency>;
let logs: string[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RATE = () => json(429, { error_code: "ComplexityException", error_message: "Complexity budget exhausted, reset in 0 seconds", status_code: 429 });
const OK = () => json(200, { data: { change_multiple_column_values: { id: "5551" } } });

const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "tok", CREATE_IDEMPOTENCY: fake.ns }) as unknown as Env;
const mutations = () => sent.filter(r => /^\s*mutation/.test(r.query));
const reads = () => sent.filter(r => /^\s*query/.test(r.query) && r.query.includes("column_values(ids:"));

beforeEach(() => {
  vi.clearAllMocks();
  sent = []; labelReplies = []; logs = [];
  fake = fakeIdempotency();
  fake.seed(`card:${BOARD}:9001`, "5551");                       // the card registry knows the card
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    const props = { hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
      createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null };
    if (method === "POST") return { total: 1, results: [{ id: "9001", properties: props }] };
    if (path.startsWith("/crm/v3/objects/contacts/9001?")) return { id: "9001", properties: props };
    if (path.startsWith("/crm/v3/owners/77")) return { id: "77", email: "owner77@example.test" };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ headers: init.headers, query: body.query, variables: body.variables });
    if (/users\(limit:500\)/.test(body.query)) return json(200, { data: { users: [{ id: "501", email: "owner77@example.test" }] } });
    if (/^\s*query/.test(body.query)) return json(200, { data: { items: [{ column_values: [
      { id: STATUS, text: "", value: null, index: null },
      { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
    ] }] } });
    const r = labelReplies.shift();
    return r ? r() : OK();
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** owner-notice.ts's query/mutation text, as written in its source: the template literal starting with `head`. */
function ownerNoticeTemplate(head: RegExp): string {
  const src: string = readFileSync(new URL("../../src/owner-notice.ts", import.meta.url), "utf8");
  const m = head.exec(src);
  if (!m) throw new Error("template not found in owner-notice.ts");
  return m[1];
}
/** Whitespace collapsed, the column-id list and interpolations generalised. */
const shape = (q: string) => q.replace(/\$\{[^}]*\}/g, "<X>").replace(/column_values\(ids: \[[^\]]*\]\)/, "column_values(ids: [<COLS>])")
  .replace(/\s+/g, " ").trim();

describe("the monday calls the reminder makes", () => {
  it("every monday request carries API-Version 2024-10 and the token", async () => {
    await runFollowUpReminders(env(), live, NOW);
    expect(sent.length).toBeGreaterThanOrEqual(3);                 // users, the card read, the label
    for (const r of sent) expect(r.headers).toMatchObject({ "API-Version": "2024-10", Authorization: "tok" });
  });

  it("the card read is the owner notice's live query, column list aside, naming 跟进提醒 and Contact owner", async () => {
    await runFollowUpReminders(env(), live, NOW);
    expect(reads()).toHaveLength(1);
    const q = reads()[0].query;
    expect(q).toContain(`column_values(ids: ["${STATUS}", "${OWNER_COL}"])`);
    expect(reads()[0].variables).toEqual({ i: ["5551"] });
    const theirs = ownerNoticeTemplate(/`(query \(\$i: \[ID!\]\) \{ items\(ids: \$i\) \{ column_values\(ids:[\s\S]*?\} \} \} \})`/);
    expect(shape(q)).toBe(shape(theirs));
  });

  it("the label mutation is the owner notice's live mutation, with {label} and no create_labels_if_missing", async () => {
    await runFollowUpReminders(env(), live, NOW);
    expect(mutations()).toHaveLength(1);
    const m = mutations()[0];
    const theirs = ownerNoticeTemplate(/`(mutation \(\$b: ID!, \$i: ID!, \$c: JSON!\) \{[\s\S]*?\{ id \} \})`/);
    expect(shape(m.query)).toBe(shape(theirs));
    expect(m.query).not.toContain("create_labels_if_missing");
    expect(m.variables).toEqual({ b: BOARD, i: "5551", c: JSON.stringify({ [STATUS]: { label: "30分钟未跟进" } }) });
    expect(fake.note(KEY)).toMatch(/^sent:/);
  });
});

describe("the real gql's retries, mapped onto the note", () => {
  it("a 504 after the label was sent: ONE send, the note left pending (never released)", async () => {
    labelReplies = [() => new Response("gateway timeout", { status: 504 })];
    const s = await runFollowUpReminders(env(), live, NOW);
    expect(mutations()).toHaveLength(1);
    expect(fake.note(KEY)).toBe(`pending:${NOW}`);
    expect(s.unresolved).toBe(1);
  });

  it("a reply carrying data AND errors executed: ONE send, the note left pending (the card settles it later)", async () => {
    labelReplies = [() => json(200, { data: { change_multiple_column_values: { id: "5551" } }, errors: [{ message: "partial" }] })];
    await runFollowUpReminders(env(), live, NOW);
    expect(mutations()).toHaveLength(1);
    expect(fake.note(KEY)).toBe(`pending:${NOW}`);
  });

  it("rate-limited twice (neither ran): two sends, MondayRateLimitedError -- the note released for the next run", async () => {
    labelReplies = [RATE, RATE];
    const s = await runFollowUpReminders(env(), live, NOW);
    expect(mutations()).toHaveLength(2);
    expect(fake.note(KEY)).toBe("");
    expect(s.errors).toBe(1);
  }, 10_000);

  it("rate-limited, then a 504 on the re-send: the re-send may have run -- the note stays pending", async () => {
    labelReplies = [RATE, () => new Response("gateway timeout", { status: 504 })];
    await runFollowUpReminders(env(), live, NOW);
    expect(mutations()).toHaveLength(2);
    expect(fake.note(KEY)).toBe(`pending:${NOW}`);
  }, 10_000);
});
