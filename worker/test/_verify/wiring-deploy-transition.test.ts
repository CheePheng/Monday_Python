import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * WIRING LENS -- the rewrite against the DURABLE STATE THE LIVE BUILD LEAVES. The live CRM Worker runs 61c48d1
 * (FOLLOW_UP_REMINDER:true), whose note for a reminder is `fur:<contact>:<hubspot_owner_assigneddate AS HUBSPOT
 * RETURNED IT>:<checkpoint>` -- the raw ISO string (61c48d1 follow-up-reminder.ts:135). The rewrite keys the same
 * reminder `fur:<contact>:<that time in ms>:<checkpoint>` and never reads the old key. So a reminder the live build
 * flagged in the last half hour before this deploys is, to the new build, never sent: it writes the label again over
 * #07's 已提醒, and #07 emails the owner (and ZMark) a second time.
 *
 * PRECONDITION: the live minute-list cron fired at least once with a due lead. The rewrite's header says it was not
 * seen firing between 07:07 and 07:38 UTC on 2026-10-12; nothing in the repo says it never fired after that.
 *
 * Real follow-up-reminder, real activity-registry and card-registry (in-memory store), real monday.ts gql (fetch
 * stubbed, with workflow #07 on the card); HubSpot's hs() mocked.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const RAW = new Date(T0).toISOString();                 // "2026-10-12T02:00:00.000Z", as HubSpot returns it
const BOARD = "5028000495";
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
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
  return { ns, seed: (n: string, v: string) => of(n).set("card", { itemId: v }) };
}

let fake: ReturnType<typeof fakeIdempotency>;
let card: { label: string | null; changedAt: number };
let emails: number;
let clock: number;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "tok", CREATE_IDEMPOTENCY: fake.ns }) as unknown as Env;
const props = { hubspot_owner_id: "77", hubspot_owner_assigneddate: RAW, createdate: new Date(T0 - 5 * MIN).toISOString(),
  utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null };

/** #07: a change INTO a trigger label emails, then sets 已提醒. */
function apply(label: string | null) {
  const before = card.label;
  card = { label, changedAt: clock };
  if (label && label !== before && label !== "已提醒") { emails++; card = { label: "已提醒", changedAt: clock }; }
}

beforeEach(() => {
  emails = 0;
  card = { label: null, changedAt: 0 };
  fake = fakeIdempotency();
  fake.seed(`card:${BOARD}:9001`, "5551");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    if (method === "POST") return { total: 1, results: [{ id: "9001", properties: props }] };
    if (path.startsWith("/crm/v3/objects/contacts/9001?")) return { id: "9001", properties: props };
    if (path.startsWith("/crm/v3/owners/77")) return { id: "77", email: "owner77@example.test" };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (/users\(/.test(query)) return json(200, { data: { users: [{ id: "501", email: "owner77@example.test" }] } });
    if (/^\s*query/.test(query)) return json(200, { data: { items: [{ column_values: [
      { id: STATUS, text: card.label ?? "", index: card.label ? INDEX[card.label] : null,
        value: card.label ? JSON.stringify({ index: INDEX[card.label], changed_at: new Date(card.changedAt).toISOString() }) : null },
      { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
    ] }] } });
    apply(JSON.parse(variables.c)[STATUS]?.label ?? null);
    return json(200, { data: { change_multiple_column_values: { id: "5551" } } });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("deploying over the live build's notes", () => {
  it("CONTROL: the new build's own note stops a second email", async () => {
    clock = T0 + 31 * MIN; await runFollowUpReminders(env(), live, clock);
    clock = T0 + 36 * MIN; await runFollowUpReminders(env(), live, clock);
    expect(emails).toBe(1);
  });

  it("a 30-minute reminder the live build already sent (its note under the raw-ISO key) is not sent again", async () => {
    // What 61c48d1 left at +31: its note, and the card #07 already answered.
    clock = T0 + 31 * MIN;
    fake.seed(`wm:fur:9001:${RAW}:30`, `sent:${clock}`);
    apply("30分钟未跟进");
    expect(emails).toBe(1);
    // The rewrite deploys; its first run at +36.
    clock = T0 + 36 * MIN;
    await runFollowUpReminders(env(), live, clock);
    expect(emails, "the owner must get at most ONE 30-minute email for this assignment").toBe(1);
  });
});
