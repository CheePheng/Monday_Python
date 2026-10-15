import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC (wiring) for WIRING-N2 -- "deploying the rewrite over the live build's notes mails a reminder twice".
 *
 * The claim's own test SIMULATES the live build's flag (it seeds a note and applies the label by hand). This replays
 * it with the CODE THAT IS ACTUALLY LIVE: 445405b (deployed as 428e8a01 at about 07:15 UTC, after 61c48d1), a verbatim
 * copy in skeptic-wiring-legacy-445405b.ts. Its note key is `fur:<id>:<raw stamp>:<cp>`, the same as 61c48d1's.
 *
 * Real activity-registry and card-registry over an in-memory CreateIdempotency fake (the DO's own lock semantics),
 * real monday.ts gql/setColumns over a stubbed fetch, with workflows #07 (30) / #07b (60) on the board: a change INTO
 * a trigger label emails, then sets 已提醒; a clear or an unchanged value mails nobody. HubSpot's hs() is mocked.
 *
 * The boundary tests pin down when the claim bites, and when it does not.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));
const rewrite = await import("../../src/follow-up-reminder");
const deployed = await import("./skeptic-wiring-legacy-445405b");

const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const BOARD = "5028000495";
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
const TRIGGERS = new Set(["30分钟未跟进", "60分钟未跟进"]);
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
  return { ns, state };
}

let fake: ReturnType<typeof fakeIdempotency>;
let card: { label: string | null; changedAt: number };
let emails: string[];
let clock: number;
let stamp: string;                 // hubspot_owner_assigneddate exactly as HubSpot's API returns it
let logs: string[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "tok",
  CREATE_IDEMPOTENCY: fake.ns }) as unknown as Env;
const props = () => ({ hubspot_owner_id: "77", hubspot_owner_assigneddate: stamp,
  createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null });

/** One write to 跟进提醒, then #07/#07b: a change INTO a trigger label emails and sets 已提醒. */
function apply(label: string | null) {
  const before = card.label;
  card = { label, changedAt: clock };
  if (label && label !== before && TRIGGERS.has(label)) {
    emails.push(label);
    card = { label: "已提醒", changedAt: clock };
  }
}
const count = (label: string) => emails.filter(e => e === label).length;
const runDeployed = async (min: number) => { clock = T0 + min * MIN; return deployed.runFollowUpReminders(env(), live, clock); };
const runRewrite = async (min: number) => { clock = T0 + min * MIN; return rewrite.runFollowUpReminders(env(), live, clock); };

beforeEach(() => {
  emails = []; logs = [];
  card = { label: null, changedAt: 0 };
  stamp = new Date(T0).toISOString();                 // "2026-10-12T02:00:00.000Z": HubSpot v3 returns datetimes as ISO
  fake = fakeIdempotency();
  fake.ns.get({ name: `card:${BOARD}:9001` }).rememberPermanent("5551");
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    if (method === "POST" && path === "/crm/v3/objects/contacts/search") return { total: 1, results: [{ id: "9001", properties: props() }] };
    if (method === "GET" && path.startsWith("/crm/v3/objects/contacts/9001?")) return { id: "9001", properties: props() };
    if (method === "GET" && path.startsWith("/crm/v3/owners/77")) return { id: "77", email: "owner77@example.test" };
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (/users\s*\(/.test(query)) return json(200, { data: { users: [{ id: "501", email: "owner77@example.test" }] } });
    if (/^\s*query/.test(query)) return json(200, { data: { items: [{ column_values: [
      { id: STATUS, text: card.label ?? "", index: card.label ? INDEX[card.label] : null,
        value: card.label ? JSON.stringify({ index: INDEX[card.label], changed_at: new Date(card.changedAt).toISOString() }) : null },
      { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
    ] }] } });
    if (/change_multiple_column_values/.test(query)) {
      const cv = JSON.parse(variables.c);
      if (STATUS in cv) apply(cv[STATUS] === null ? null : cv[STATUS].label);
      return json(200, { data: { change_multiple_column_values: { id: "5551" } } });
    }
    throw new Error(`unexpected monday call: ${query.slice(0, 60)}`);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WIRING-N2 replayed with the deployed 445405b code, then the rewrite", () => {
  it("CONTROL: the rewrite alone mails one 30-minute reminder over two runs", async () => {
    await runRewrite(31);
    await runRewrite(36);
    expect(emails).toEqual(["30分钟未跟进"]);
  });

  it("CONTROL: the deployed build alone mails one 30-minute reminder over two runs (its own key stops it)", async () => {
    await runDeployed(31);
    await runDeployed(36);
    expect(emails).toEqual(["30分钟未跟进"]);
    // ...and the note it leaves is under the RAW stamp, which the rewrite never reads.
    expect(fake.state.get(`wm:fur:9001:${stamp}:30`)?.get("card")?.itemId).toMatch(/^sent:/);
  });

  it("30: 445405b flags at +31 (and #07 mails); the rewrite deploys and runs at +35 -- the owner must get ONE email", async () => {
    await runDeployed(31);
    expect(emails).toEqual(["30分钟未跟进"]);
    expect(card.label).toBe("已提醒");
    await runRewrite(35);
    const flagged = logs.filter(l => /\[follow-up\] contact=9001 checkpoint=30 .*action=flagged/.test(l));
    expect(count("30分钟未跟进"), `at most ONE 30-minute email per assignment (rewrite logged: ${flagged.join(" | ")})`).toBe(1);
  });

  it("60: 445405b flags 30 at +31 and 60 at +61; the rewrite runs at +65 -- ONE 60-minute email", async () => {
    await runDeployed(31);
    await runDeployed(61);
    expect(emails).toEqual(["30分钟未跟进", "60分钟未跟进"]);
    await runRewrite(65);
    expect(count("60分钟未跟进"), "at most ONE 60-minute email per assignment").toBe(1);
  });

  it("BOUNDARY (exposure window): a flag made more than ~30 min before the rewrite's first run is not repeated", async () => {
    // 445405b flags 30 at +26..+31; the rewrite's first run is at +61 (60 is a NEW checkpoint, rightly mailed once).
    await runDeployed(31);
    await runRewrite(61);
    expect(count("30分钟未跟进")).toBe(1);
    expect(count("60分钟未跟进")).toBe(1);
  });

  it("BOUNDARY (precondition): if the live minute-list cron never ran, there is nothing to repeat", async () => {
    await runRewrite(35);
    await runRewrite(65);
    expect(emails).toEqual(["30分钟未跟进", "60分钟未跟进"]);
  });

  it("BOUNDARY (stamp format): were HubSpot's stamp epoch-ms digits, both builds' keys would coincide -- no repeat", async () => {
    stamp = String(T0);
    await runDeployed(31);
    await runRewrite(35);
    expect(count("30分钟未跟进")).toBe(1);
  });
});
