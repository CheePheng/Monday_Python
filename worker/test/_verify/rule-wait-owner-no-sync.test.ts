import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "rule" -- A LOST REMINDER: "wait-owner" waits, but never asks for the sync it waits on.
 *
 * remindOne answers "wait-owner" whenever the card's Contact owner does not show HubSpot's owner's monday user (or
 * shows someone when that owner has no seat) -- "nothing noted, the next run looks again" (follow-up-reminder.ts:
 * 296-301). It never asks for the contact's sync. At +30 minutes a card still behind is not "a sync on its way" (the
 * live owner sync takes 3-7 s): it is a sync that was LOST -- an inline sync cut off by the webhook's ~30 s
 * waitUntil, or one that failed -- and the Contacts board has no sweep (skipFullReconcile; the CRM incremental is
 * off). The owner notice, which this rule was copied from, says exactly that and heals it: owner-notice.ts:446-450
 * spills the contact's sync (spillDeferred, ensure: true) "in case nothing else is bringing it". The owner notice does
 * not always get there first: it settles BEFORE its card check for "no-user" (a seatless new owner), "already"
 * (上次通知Owner names the owner: an A->B->A move), "pending"/"stuck" (an earlier 待通知 still standing).
 *
 * The world: the deferred queue (and the sync) bring the card to HubSpot's owner WHEN ASKED; nothing else does.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const md = vi.hoisted(() => {
  class MondayRateLimitedError extends Error {
    constructor(msg: string) { super(msg); this.name = "MondayRateLimitedError"; }
  }
  return { findItemByColumn: vi.fn(), setColumns: vi.fn(), gql: vi.fn(), getUsersByEmail: vi.fn(), MondayRateLimitedError };
});
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const q = vi.hoisted(() => ({ asked: [] as string[], bring: (_id: string) => undefined as void }));
const store = vi.hoisted(() => {
  const notes = new Map<string, string>();
  const locks = new Map<string, { at: number; owner: string }>();
  const clock = { now: 0 };
  return {
    notes, locks, clock,
    getWatermark: vi.fn(async (_e: unknown, name: string) => notes.has(name) ? notes.get(name)! : null),
    setWatermark: vi.fn(async (_e: unknown, name: string, value: string) => { notes.set(name, value); }),
    acquireLock: vi.fn(async (_e: unknown, name: string, holdMs: number, owner: string) => {
      const rec = locks.get(name);
      if (rec && rec.owner !== owner && clock.now - rec.at < holdMs) return false;
      locks.set(name, { at: clock.now, owner });
      return true;
    }),
    renewLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
      const rec = locks.get(name);
      if (!rec || rec.owner !== owner) return false;
      locks.set(name, { at: clock.now, owner });
      return true;
    }),
    releaseLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
      if (locks.get(name)?.owner === owner) locks.delete(name);
    }),
  };
});
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/monday", () => md);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({
  getWatermark: store.getWatermark, setWatermark: store.setWatermark,
  acquireLock: store.acquireLock, renewLock: store.renewLock, releaseLock: store.releaseLock,
}));
// The deferred queue and the sync: asked for a contact's sync, they bring its card to HubSpot's owner.
const take = (items: any[]) => { for (const i of items ?? []) if (i?.type === "contact") { q.asked.push(String(i.id)); q.bring(String(i.id)); } };
vi.mock("../../src/deferred-sync", () => ({
  spillDeferred: vi.fn(async (_e: unknown, items: any[]) => { take(items); return true; }),
  spillDeferredLeftover: vi.fn(async (_e: unknown, items: any[]) => { take(items); return []; }),
}));
vi.mock("../../src/sync", () => ({
  syncHubspotObject: vi.fn(async (_e: unknown, _o: string, id: string) => { take([{ type: "contact", id }]); return "synced"; }),
}));

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
const iso = (t: number) => new Date(t).toISOString();
const EVERY_RUN = [31, 36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86];

const LEAD = { id: "9001", owner: "77", assigned: iso(T0), created: iso(T0 - 5 * MIN), term: "docusign", lifecycle: "lead" };
const props = () => ({ hubspot_owner_id: LEAD.owner, hubspot_owner_assigneddate: LEAD.assigned, createdate: LEAD.created,
  utm_term: LEAD.term, lifecyclestage: LEAD.lifecycle, notes_last_updated: null });

let w: {
  owners: Record<string, string>;
  users: Record<string, string>;
  card: { status: { label: string; changedAt: number | null } | null; owner: string[] };
  emails: { label: string; to: string[] }[];
};
let logs: string[];

function apply(v: { label: string } | null) {
  const before = w.card.status?.label ?? null;
  if (!v) { w.card.status = null; return; }
  w.card.status = { label: v.label, changedAt: store.clock.now };
  if (v.label !== before && v.label !== "已提醒") {
    w.emails.push({ label: v.label, to: [...w.card.owner] });
    w.card.status = { label: "已提醒", changedAt: store.clock.now };
  }
}

const run = (mins: number) => { store.clock.now = T0 + mins * MIN; return runFollowUpReminders(ON, live, () => store.clock.now); };

beforeEach(() => {
  vi.clearAllMocks();
  store.notes.clear(); store.locks.clear();
  logs = []; q.asked = [];
  w = { owners: { "77": "owner77@example.test" }, users: { "owner77@example.test": "501", "prev@example.test": "999" },
    card: { status: null, owner: ["person:999"] }, emails: [] };   // the previous owner: the owner sync was lost
  // The contact's sync, as mapping.ts formatValue writes the Contact owner: HubSpot's owner's monday user, or nobody.
  q.bring = (id: string) => {
    if (id !== LEAD.id) return;
    const uid = w.users[w.owners[LEAD.owner] ?? ""];
    w.card.owner = uid ? [`person:${uid}`] : [];
  };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.getUsersByEmail.mockImplementation(async () => w.users);
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv[STATUS]));
  md.gql.mockImplementation(async (_e: unknown, query: string, vars: any) => {
    if (/^\s*query/.test(query)) {
      const s = w.card.status;
      return { items: [{ column_values: [
        { id: STATUS, text: s?.label ?? "", index: s ? INDEX[s.label] : null,
          value: s ? JSON.stringify({ index: INDEX[s.label], ...(s.changedAt != null ? { changed_at: iso(s.changedAt) } : {}) }) : null },
        { id: OWNER_COL, text: "", value: null,
          persons_and_teams: w.card.owner.map(p => ({ kind: p.split(":")[0], id: p.split(":")[1] })) },
      ] }] };
    }
    apply(JSON.parse(vars.c)[STATUS]);
    return { change_multiple_column_values: { id: vars.i } };
  });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    if (method === "POST") return { total: 1, results: [{ id: LEAD.id, properties: props() }] };
    if (/^\/crm\/v3\/objects\/contacts\/9001\?/.test(path)) return { id: LEAD.id, properties: props() };
    const owner = /^\/crm\/v3\/owners\/(\w+)/.exec(path);
    if (owner) {
      if (!(owner[1] in w.owners)) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: owner[1], email: w.owners[owner[1]] };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

describe("wait-owner never asks for the sync it waits on: a lost owner sync loses both reminders", () => {
  it("control (passes): once the card shows the owner, it is flagged -- the waiting is the only obstacle", async () => {
    q.bring(LEAD.id);
    for (const m of EVERY_RUN) await run(m);
    expect(w.emails.map(e => e.label)).toEqual(["30分钟未跟进", "60分钟未跟进"]);
  });

  it("a seated owner whose card still shows the previous owner at +30: the reminder must bring the sync, then flag", async () => {
    for (const m of EVERY_RUN) await run(m);
    const waits = logs.filter(l => /contact=9001 .*action=wait-owner/.test(l)).length;
    expect(w.emails.map(e => e.label),
      `${waits} runs answered wait-owner and none asked for the contact's sync (asked: [${q.asked.join(",")}])`)
      .toEqual(["30分钟未跟进", "60分钟未跟进"]);
    expect(w.emails.every(e => e.to.join() === "person:501")).toBe(true);
  });

  it("a SEATLESS new owner whose card still shows the previous owner: the CC (ZMark) must be told too", async () => {
    // owner-notice answers "no-user" for this owner before any card check, so it spills nothing either.
    w.owners = { "77": "noseat@example.test" };
    for (const m of EVERY_RUN) await run(m);
    expect(w.emails.map(e => e.label), "the seatless owner's escalation never reached #07's CC")
      .toEqual(["30分钟未跟进", "60分钟未跟进"]);
    expect(w.emails.every(e => e.to.length === 0)).toBe(true);           // never the previous owner
  });
});
