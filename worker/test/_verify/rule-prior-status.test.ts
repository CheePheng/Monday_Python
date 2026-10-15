import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "rule" -- STATUS OF THE PRIOR FINDINGS RULE-1, RULE-2, RULE-3 and TWICE-4 against the rewritten
 * follow-up-reminder.ts. Every test here is expected to PASS: each one proves the fix (or the fixed part of it).
 *
 * The world differs from test/follow-up-reminder.test.ts in two ways that matter for these findings:
 *   - HubSpot's search APPLIES THE REQUEST'S OWN filters and sort (and pages them), so the createdate bound and
 *     the ascending sort are judged by what they do, not by the request's shape;
 *   - workflow #07 RECORDS WHOM IT MAILS: the card's Contact owner at the moment of the change into the label.
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
const DAY = 24 * 60 * MIN;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
const iso = (t: number) => new Date(t).toISOString();

type Lead = { id: string; owner: string; assigned: string; created: string; term: string; lifecycle: string;
  lastActivity: string };
const lead = (o: Partial<Lead> = {}): Lead => ({ id: "9001", owner: "77", assigned: iso(T0), created: iso(T0 - 5 * MIN),
  term: "docusign", lifecycle: "lead", lastActivity: "", ...o });
const propsOf = (c: Lead): Record<string, string | null> => ({ hubspot_owner_id: c.owner,
  hubspot_owner_assigneddate: c.assigned, createdate: c.created, utm_term: c.term, lifecyclestage: c.lifecycle,
  notes_last_updated: c.lastActivity || null });

type Card = { contact: string; status: { label: string; changedAt: number | null } | null; owner: string[] };
let w: {
  search: Lead[];                                  // HubSpot's search index
  fresh: Record<string, Partial<Lead>>;            // the record now, where it differs from the index
  owners: Record<string, string>;                  // HubSpot owner id -> email (absent: 404)
  users: Record<string, string>;                   // monday users by email
  cards: Record<string, Card>;                     // by monday item id
  emails: { contact: string; label: string; to: string[] }[];
};
let logs: string[];
let searches: any[];

const itemOf = (contact: string) => `item-${contact}`;
const addCard = (contact: string, owner: string[]) => { w.cards[itemOf(contact)] = { contact, status: null, owner }; };

/** A change of 跟进提醒: #07 mails the card's Contact owner on a change INTO a trigger label, then sets 已提醒. */
function apply(item: string, v: { label: string } | null) {
  const card = w.cards[item];
  const before = card.status?.label ?? null;
  if (!v) { card.status = null; return; }
  card.status = { label: v.label, changedAt: store.clock.now };
  if (v.label !== before && v.label !== "已提醒") {
    w.emails.push({ contact: card.contact, label: v.label, to: [...card.owner] });
    card.status = { label: "已提醒", changedAt: store.clock.now };
  }
}

const DATE_PROPS = new Set(["hubspot_owner_assigneddate", "createdate", "notes_last_updated"]);
const asNum = (prop: string, raw: string) => DATE_PROPS.has(prop) ? (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)) : raw;

/** HubSpot's search, as HubSpot runs it: the request's own filters (AND), its sort (ties by id), then the page. */
function searchEngine(body: any): Lead[] {
  const filters: any[] = body.filterGroups?.[0]?.filters ?? [];
  const hits = w.search.filter(c => filters.every(f => {
    const raw = propsOf(c)[f.propertyName];
    if (f.operator === "HAS_PROPERTY") return raw != null && raw !== "";
    if (raw == null || raw === "") return false;
    const v = asNum(f.propertyName, raw), want = asNum(f.propertyName, String(f.value));
    if (f.operator === "GTE") return v >= want;
    if (f.operator === "LTE") return v <= want;
    if (f.operator === "EQ") return v === want;
    throw new Error(`operator ${f.operator} not modelled`);
  }));
  const s = body.sorts?.[0];
  const byId = (a: Lead, b: Lead) => Number(a.id) - Number(b.id);       // unsorted: creation order (oldest id first)
  if (!s) return hits.sort(byId);
  const dir = s.direction === "DESCENDING" ? -1 : 1;
  return hits.sort((a, b) => {
    const x = asNum(s.propertyName, propsOf(a)[s.propertyName] ?? "") as number;
    const y = asNum(s.propertyName, propsOf(b)[s.propertyName] ?? "") as number;
    return x === y ? byId(a, b) : (x < y ? -dir : dir);
  });
}

const run = (mins: number) => { store.clock.now = T0 + mins * MIN; return runFollowUpReminders(ON, live, () => store.clock.now); };

beforeEach(() => {
  vi.clearAllMocks();
  store.notes.clear(); store.locks.clear();
  logs = []; searches = [];
  w = { search: [lead()], fresh: {}, owners: { "77": "owner77@example.test", "88": "owner88@example.test" },
    users: { "owner77@example.test": "501", "owner88@example.test": "502" }, cards: {}, emails: [] };
  addCard("9001", ["person:501"]);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockImplementation(async (_e: unknown, _b: string, id: string) => w.cards[itemOf(id)] ? itemOf(id) : null);
  md.findItemByColumn.mockResolvedValue([]);
  md.getUsersByEmail.mockImplementation(async () => w.users);
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, item: string, cv: Record<string, any>) => apply(item, cv[STATUS]));
  md.gql.mockImplementation(async (_e: unknown, query: string, vars: any) => {
    if (/^\s*query/.test(query)) {
      const card = w.cards[vars.i[0]];
      if (!card) return { items: [] };
      const s = card.status;
      return { items: [{ column_values: [
        { id: STATUS, text: s?.label ?? "", index: s ? INDEX[s.label] : null,
          value: s ? JSON.stringify({ index: INDEX[s.label], ...(s.changedAt != null ? { changed_at: iso(s.changedAt) } : {}) }) : null },
        { id: OWNER_COL, text: "", value: null,
          persons_and_teams: card.owner.map(p => ({ kind: p.split(":")[0], id: p.split(":")[1] })) },
      ] }] };
    }
    apply(vars.i, JSON.parse(vars.c)[STATUS]);
    return { change_multiple_column_values: { id: vars.i } };
  });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string, body?: any) => {
    if (method === "POST") {
      searches.push(body);
      const all = searchEngine(body);
      const from = Number(body.after ?? 0);
      return { total: all.length, results: all.slice(from, from + body.limit).map(c => ({ id: c.id, properties: propsOf(c) })),
        ...(from + body.limit < all.length ? { paging: { next: { after: String(from + body.limit) } } } : {}) };
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

const EVERY_RUN = [31, 36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86];

describe("RULE-1 / TWICE-4 (fixed): the search can no longer be filled by old contacts, is sorted, and logs a cut", () => {
  it("600 OLD 1.NEW contacts reassigned in bulk 10 min before a new lead no longer hide it: both reminders go out", async () => {
    const bulk = Array.from({ length: 600 }, (_, i) => lead({ id: String(10_000 + i), assigned: iso(T0 - 10 * MIN),
      created: iso(T0 - 30 * DAY), term: "docusign" }));
    w.search = [...bulk, lead({ id: "999999" })];
    addCard("999999", ["person:501"]);
    for (const m of EVERY_RUN) await run(m);
    expect(w.emails.filter(e => e.contact === "999999").map(e => e.label)).toEqual(["30分钟未跟进", "60分钟未跟进"]);
    expect(logs.some(l => /action=truncated/.test(l))).toBe(false);          // nothing was cut: the bound removed them
    // Control -- the mechanism: the same request WITHOUT its createdate bound puts the new lead past row 500.
    const req = searches[0];
    const unbounded = { ...req, filterGroups: [{ filters: req.filterGroups[0].filters.filter((f: any) => f.propertyName !== "createdate") }] };
    store.clock.now = T0 + 31 * MIN;
    expect(searchEngine(unbounded).findIndex(c => c.id === "999999")).toBeGreaterThanOrEqual(500);
  });

  it("more than 500 NEW leads matching: the cut is logged with the count left unread", async () => {
    w.search = Array.from({ length: 620 }, (_, i) => lead({ id: String(20_000 + i), term: "tableau" }));
    const s = await run(31);
    expect(searches).toHaveLength(5);
    expect(s).toMatchObject({ candidates: 500, unread: 120 });
    expect(logs.some(l => /\[follow-up\] action=truncated read=500 unread=120/.test(l))).toBe(true);
  });

  it("oldest assignment first: with a cut, the lead nearest to leaving the window is the one read", async () => {
    // 600 new (term tableau, never due) leads assigned AFTER the due one; the due one is assigned first but has the
    // highest id, so HubSpot's unsorted (creation) order would put it at row 601.
    w.search = [...Array.from({ length: 600 }, (_, i) => lead({ id: String(30_000 + i), assigned: iso(T0 + 2 * MIN), term: "tableau" })),
      lead({ id: "999999" })];
    addCard("999999", ["person:501"]);
    await run(36);
    expect(w.emails.map(e => e.contact)).toEqual(["999999"]);
    const unsorted = { ...searches[0], sorts: undefined };
    expect(searchEngine(unsorted).findIndex(c => c.id === "999999")).toBe(600);       // control: unsorted, unread
  });

  it("the createdate bound excludes no due lead: created exactly 24 h before an assignment exactly 90 min old", async () => {
    w.search = [lead({ created: iso(T0 - DAY) })];
    const s = await runFollowUpReminders(ON, live, (store.clock.now = T0 + 90 * MIN));
    expect(s.flagged).toBe(1);
    expect(w.emails.map(e => e.label)).toEqual(["60分钟未跟进"]);
  });

  it("the createdate bound excludes no due lead: HubSpot stamping the owner a few ms BEFORE createdate", async () => {
    w.search = [lead({ created: iso(T0 + 3) })];
    await run(31);
    expect(w.emails.map(e => e.label)).toEqual(["30分钟未跟进"]);
  });
});

describe("RULE-2 (fixed): whom #07 mails is checked; a seatless owner is flagged knowingly (seat=none)", () => {
  it("an owner with no monday account, card showing nobody: flagged and logged seat=none", async () => {
    w.users = {};
    w.cards[itemOf("9001")].owner = [];
    const s = await run(31);
    expect(s.flagged).toBe(1);
    expect(logs.some(l => /action=flagged label="30分钟未跟进" owner=77 seat=none/.test(l))).toBe(true);
    expect(w.emails).toEqual([{ contact: "9001", label: "30分钟未跟进", to: [] }]);
  });

  it("a seated owner the card does not show yet: wait-owner, nothing noted -- flagged once it does, never the previous owner", async () => {
    w.cards[itemOf("9001")].owner = ["person:999"];
    const s1 = await run(31);
    expect(s1.waiting).toBe(1);
    expect(store.setWatermark).not.toHaveBeenCalled();
    expect(w.emails).toHaveLength(0);
    w.cards[itemOf("9001")].owner = ["person:501"];
    await run(36);
    expect(w.emails).toEqual([{ contact: "9001", label: "30分钟未跟进", to: ["person:501"] }]);
  });

  it("a seatless owner while the card still shows the previous owner: waits, never mails the previous owner", async () => {
    w.users = { "owner88@example.test": "502" };
    w.cards[itemOf("9001")].owner = ["person:502"];
    for (const m of [31, 36, 41]) await run(m);
    expect(w.emails).toHaveLength(0);
  });
});

describe("prior hardening note (key normalisation): one assignment, two spellings, one cycle", () => {
  it("the stamp read as ISO, then as epoch ms by the next run: reminded once", async () => {
    await run(31);
    w.search = [lead({ assigned: String(T0) })];
    await run(36);
    expect(w.emails).toHaveLength(1);
  });
});

describe("RULE-3 (fixed part): the record is read fresh before the card is flagged", () => {
  it("a call logged at +28 that the index does not show yet: nothing written", async () => {
    w.fresh["9001"] = { lastActivity: iso(T0 + 28 * MIN) };
    await run(31);
    expect(w.emails).toHaveLength(0);
    expect(hub.hs.mock.calls.some(c => c[1] === "GET" && /^\/crm\/v3\/objects\/contacts\/9001\?/.test(String(c[2])))).toBe(true);
  });

  it("a reassignment at +58 that the index does not show yet: the old cycle's 60 reminder is not written, nobody mailed", async () => {
    w.fresh["9001"] = { owner: "88", assigned: iso(T0 + 58 * MIN) };
    w.cards[itemOf("9001")].owner = ["person:502"];            // the sync already shows the new owner
    await run(61);
    expect(w.emails).toHaveLength(0);
  });
});
