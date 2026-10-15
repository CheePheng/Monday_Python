import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "rule" -- RULE-3 RESIDUAL. The rewrite reads the contact fresh (readContact) BEFORE two monday calls that
 * may each sit through a rate-limit wait of up to 65 s: the card read (readCells: gql retries=2, maxRateWaits=1)
 * and the run's first owner lookup (getUsersByEmail, maxRateWaits=1). Nothing re-reads HubSpot after them, so the
 * decision the label is written on can be a minute or two old at the write -- exactly what RULE-3's fix had to
 * prevent ("after the card lookup so that a monday wait cannot make the data stale"), and what the owner notice does
 * (owner-notice.ts:456-464: "The card read above can sit through a monday rate-limit wait: confirm HubSpot still
 * names this assignment before flagging it").
 *
 * The rate-limit waits are modelled by advancing the clock inside the monday call (gql's own wait is real time).
 * #07 records whom it mails: the card's Contact owner at the moment of the change into the label.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const md = vi.hoisted(() => {
  class MondayRateLimitedError extends Error {
    constructor(msg: string) { super(msg); this.name = "MondayRateLimitedError"; }
  }
  return { findItemByColumn: vi.fn(), setColumns: vi.fn(), gql: vi.fn(), getUsersByEmail: vi.fn(), MondayRateLimitedError };
});
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
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

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const RATE_WAIT_MS = 65_000;                                 // gql's longest single rate-limit wait (monday.ts:59)
const T0 = Date.parse("2026-10-12T02:00:00Z");
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
const iso = (t: number) => new Date(t).toISOString();

type Lead = { id: string; owner: string; assigned: string; created: string; term: string; lifecycle: string;
  lastActivity: string };
const lead = (o: Partial<Lead> = {}): Lead => ({ id: "9001", owner: "77", assigned: iso(T0), created: iso(T0 - 5 * MIN),
  term: "docusign", lifecycle: "lead", lastActivity: "", ...o });
const propsOf = (c: Lead) => ({ hubspot_owner_id: c.owner, hubspot_owner_assigneddate: c.assigned, createdate: c.created,
  utm_term: c.term, lifecyclestage: c.lifecycle, notes_last_updated: c.lastActivity || null });

let w: {
  search: Lead[];
  fresh: Record<string, Partial<Lead>>;
  owners: Record<string, string>;
  users: Record<string, string>;
  card: { status: { label: string; changedAt: number | null } | null; owner: string[] };
  emails: { label: string; to: string[]; at: number }[];
  onCellRead?: () => void;
  onUsers?: () => void;
};
let logs: string[];

function apply(v: { label: string } | null) {
  const before = w.card.status?.label ?? null;
  if (!v) { w.card.status = null; return; }
  w.card.status = { label: v.label, changedAt: store.clock.now };
  if (v.label !== before && v.label !== "已提醒") {
    w.emails.push({ label: v.label, to: [...w.card.owner], at: store.clock.now });
    w.card.status = { label: "已提醒", changedAt: store.clock.now };
  }
}

const run = (mins: number) => { store.clock.now = T0 + mins * MIN; return runFollowUpReminders(ON, live, () => store.clock.now); };

beforeEach(() => {
  vi.clearAllMocks();
  store.notes.clear(); store.locks.clear();
  logs = [];
  w = { search: [lead()], fresh: {}, owners: { "77": "owner77@example.test", "88": "owner88@example.test" },
    users: { "owner77@example.test": "501", "owner88@example.test": "502" },
    card: { status: null, owner: ["person:501"] }, emails: [] };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.getUsersByEmail.mockImplementation(async () => { w.onUsers?.(); return w.users; });
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv[STATUS]));
  md.gql.mockImplementation(async (_e: unknown, query: string, vars: any) => {
    if (/^\s*query/.test(query)) {
      w.onCellRead?.();
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
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string, body?: any) => {
    if (method === "POST") {
      const page = w.search.slice(0, body.limit);
      return { total: w.search.length, results: page.map(c => ({ id: c.id, properties: propsOf(c) })) };
    }
    const contact = /^\/crm\/v3\/objects\/contacts\/(\w+)\?/.exec(path);
    if (contact) {
      const base = w.search.find(c => c.id === contact[1]);
      if (!base) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: base.id, properties: propsOf({ ...base, ...w.fresh[base.id] }) };
    }
    const owner = /^\/crm\/v3\/owners\/(\w+)/.exec(path);
    if (owner) {
      if (!(owner[1] in w.owners)) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: owner[1], email: w.owners[owner[1]] };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

describe("RULE-3 residual: HubSpot is not re-read after the monday waits that follow the fresh read", () => {
  it("control (passes): a call logged before the fresh read is seen -- nothing written", async () => {
    w.fresh["9001"] = { lastActivity: iso(T0 + 30 * MIN) };
    await run(31);
    expect(w.emails).toHaveLength(0);
  });

  it("a call logged while the card read sits in a monday rate-limit wait: 30分钟未跟进 must NOT be written", async () => {
    // The fresh read (no activity) is done; the card read waits 65 s on monday's budget; the owner logs a call then.
    w.onCellRead = () => {
      store.clock.now += RATE_WAIT_MS;
      w.fresh["9001"] = { lastActivity: iso(store.clock.now - 10_000) };      // logged 55 s after the fresh read
    };
    await run(31);
    // HubSpot, read just before the write, says the lead was followed up after its assignment: no reminder is due.
    expect(w.emails, "a lead followed up a minute before the write was reminded anyway").toHaveLength(0);
  });

  it("a reassignment while the run waits on monday's user list: the NEW owner must not be mailed the OLD cycle's reminder", async () => {
    // The card was read showing A (person:501). The run's first owner lookup waits 65 s on monday; meanwhile HubSpot
    // reassigns the lead to B (owner 88) and the sync -- 3-7 s live -- puts B (person:502) on the card.
    w.onUsers = () => {
      store.clock.now += RATE_WAIT_MS;
      w.fresh["9001"] = { owner: "88", assigned: iso(store.clock.now - 30_000) };
      w.card.owner = ["person:502"];
    };
    await run(31);
    // A's cycle is over; B's first reminder is due 30 minutes after B's own assignment, not seconds into it.
    expect(w.emails.filter(e => e.to.includes("person:502")),
      "B was emailed '30分钟未跟进' about A's assignment ~35 s after B was assigned").toEqual([]);
  });
});
