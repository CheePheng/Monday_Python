import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";
// @ts-ignore -- node:fs in a test (the worker tsconfig has no Node types; vitest runs on Node)
import { readFileSync, readdirSync } from "node:fs";
import { CRM_CONTACTS, CRM_SPECS } from "../../src/config/crm";
// @ts-ignore -- read-only pre-deploy script; importing it runs nothing (main() runs only when invoked directly)
import { specColumnRefs } from "../../scripts/verify-spec-columns-exist.mjs";

/**
 * SKEPTIC (wiring) for WIRING-N1 -- "the two pre-deploy column checks miss ObjectSpec.followUpCol".
 *
 * Checked here: (1) whether the gap is NEW (did adding followUpCol to the spec lose coverage that existed before?),
 * (2) the blast radius of a dead 跟进提醒 (the 2026-09-08 class stopped EVERY card on a board), and (3) the claim's
 * failure sequence with the column gone from the board: reads omit the cell, and a mutation naming it is refused.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));
const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const FOLLOW = CRM_CONTACTS.followUpCol!;

describe("WIRING-N1: is the check gap new, and what does a dead 跟进提醒 break?", () => {
  it("NOT A REGRESSION: specColumnRefs covers exactly the same columns with or without followUpCol on the spec", () => {
    // At HEAD (445405b) the spec had no followUpCol (the column was a literal in follow-up-reminder.ts), so the
    // check never covered 跟进提醒 before the rewrite either.
    const without = { ...CRM_CONTACTS, followUpCol: undefined };
    expect(specColumnRefs(CRM_CONTACTS)).toEqual(specColumnRefs(without));
  });

  it("BLAST RADIUS: no spec field or relation names 跟进提醒 -- only the reminder's own mutation would be refused", () => {
    for (const s of CRM_SPECS) {
      expect(s.fields.some(f => f.col === FOLLOW)).toBe(false);
      expect((s.associations ?? []).some((a: any) => a.relationCol === FOLLOW)).toBe(false);
    }
    // and in src, only follow-up-reminder.ts uses the column (webhooks.ts only IGNORES it).
    const dir = new URL("../../src/", import.meta.url);
    const users = (readdirSync(dir, { recursive: true }) as string[])
      .filter(f => String(f).endsWith(".ts"))
      .filter(f => /followUpCol|FOLLOW_UP\.statusCol|color_mm82ccsb/.test(readFileSync(new URL(String(f).replace(/\\/g, "/"), dir), "utf8")))
      .map(f => String(f).replace(/\\/g, "/")).sort();
    expect(users).toEqual(["config/crm.ts", "follow-up-reminder.ts", "types.ts", "webhooks.ts"]);
  });
});

// ---- (3) the claim's failure sequence, on the real reminder with 跟进提醒 deleted from the board ------------------
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const BOARD = "5028000495";
const OWNER_COL = "multiple_person_mm6zap53";
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
let store: Map<string, Map<string, any>>;
let mutations: number;
let emails: number;
let logs: string[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ns = () => ({
  idFromName: (name: string) => ({ name }),
  get: ({ name }: { name: string }) => {
    if (!store.has(name)) store.set(name, new Map());
    const s = store.get(name)!;
    return {
      async claimLock(now: number, hold: number, owner: string) {
        const r = s.get("lock"); if (r && r.owner !== owner && now - r.at < hold) return false; s.set("lock", { at: now, owner }); return true;
      },
      async renewLock(now: number, owner: string) {
        const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.set("lock", { at: now, owner }); return true;
      },
      async releaseLock(owner: string) { const r = s.get("lock"); if (!r || r.owner !== owner) return false; s.delete("lock"); return true; },
      async getCard() { return s.get("card")?.itemId ?? null; },
      async rememberPermanent(v: string) { s.set("card", { itemId: v }); },
    };
  },
});
let doNs: ReturnType<typeof ns>;
const env = () => ({ ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "tok", CREATE_IDEMPOTENCY: doNs }) as unknown as Env;
const props = { hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
  createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "HubSpot form", lifecyclestage: "lead", notes_last_updated: null };

describe("WIRING-N1 failure sequence: 跟进提醒 deleted from the board", () => {
  beforeEach(() => {
    store = new Map(); doNs = ns(); mutations = 0; emails = 0; logs = [];
    doNs.get({ name: `card:${BOARD}:9001` }).rememberPermanent("5551");
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
      if (method === "POST") return { total: 1, results: [{ id: "9001", properties: props }] };
      if (path.startsWith("/crm/v3/objects/contacts/9001?")) return { id: "9001", properties: props };
      if (path.startsWith("/crm/v3/owners/77")) return { id: "77", email: "owner77@example.test" };
      throw new Error(`unexpected ${method} ${path}`);
    });
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
      const { query, variables } = JSON.parse(init.body);
      if (/users\s*\(/.test(query)) return json(200, { data: { users: [{ id: "501", email: "owner77@example.test" }] } });
      // A read naming a column the board no longer has returns only the columns it does have.
      if (/^\s*query/.test(query)) return json(200, { data: { items: [{ column_values: [
        { id: OWNER_COL, text: "Owner", value: null, persons_and_teams: [{ id: 501, kind: "person" }] },
      ] }] } });
      // A mutation naming an unknown column is refused whole (the 2026-09-08 incident).
      if (/change_multiple_column_values/.test(query)) {
        mutations++;
        if (FOLLOW in JSON.parse(variables.c))
          return json(200, { errors: [{ message: "This column ID doesn't exist for the board",
            extensions: { code: "InvalidColumnIdException" } }], data: { change_multiple_column_values: null } });
        return json(200, { data: { change_multiple_column_values: { id: "5551" } } });
      }
      throw new Error(`unexpected monday call: ${query.slice(0, 60)}`);
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("each run tries once, is refused, logs 'unresolved'; no reminder is ever delivered (as the claim says)", async () => {
    const a = await runFollowUpReminders(env(), live, T0 + 31 * MIN);
    const b = await runFollowUpReminders(env(), live, T0 + 36 * MIN);     // pending note > 3 min: resolved from the card
    expect(a.unresolved).toBe(1);
    expect(b.unresolved).toBe(1);
    expect(mutations).toBe(2);
    expect(emails).toBe(0);
    expect(logs.filter(l => /action=unresolved/.test(l)).length).toBe(2);
  });
});
