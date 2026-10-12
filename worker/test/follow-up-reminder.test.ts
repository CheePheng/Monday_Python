import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../src/types";

/**
 * 02.2 FOLLOW-UP REMINDER (FOLLOW_UP_REMINDER): hiffer's rule of 2026-10-12 as agreed with the user -- 30 and 60
 * minutes after the owner assignment, any hour; new leads only (created within the 24 h before the assignment);
 * term contains hubspot/docusign in any case; Lifecycle 1.NEW; nothing logged since the assignment -> flag 跟进提醒
 * once per assignment and checkpoint for workflow #07 / #07b to email the card's Contact owner (CC ZMark).
 *
 * reminderDue is pure and tested directly. runFollowUpReminders runs for real against a small world: HubSpot's
 * search (as its index sees the contacts) and its record reads (as they are now), one Contacts card -- its 跟进提醒
 * and Contact owner cells -- with workflow #07 on it, which emails on every change INTO a trigger label and then sets
 * 已提醒, and the durable notes and run lock. Every "emails" count below is #07's.
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
    // CreateIdempotency's claimLock / renewLock / releaseLock, on the test's clock.
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
vi.mock("../src/hubspot", () => hub);
vi.mock("../src/monday", () => md);
vi.mock("../src/card-registry", () => reg);
vi.mock("../src/activity-registry", () => ({
  getWatermark: store.getWatermark, setWatermark: store.setWatermark,
  acquireLock: store.acquireLock, renewLock: store.renewLock, releaseLock: store.releaseLock,
}));

const { reminderDue, runFollowUpReminders, followUpReminderOn, landedSince, FOLLOW_UP, PENDING_SETTLE_MS,
  RUN_LOCK_HOLD_MS } = await import("../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");          // the assignment
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
const iso = (t: number) => new Date(t).toISOString();

type Lead = ReturnType<typeof lead>;
const lead = (o: Partial<Record<string, string>> = {}) => ({
  id: "9001", owner: "77", assigned: iso(T0), created: iso(T0 - 5 * MIN), term: "docusign", lifecycle: "lead",
  lastActivity: "", ...o,
});
const propsOf = (c: Lead) => ({ hubspot_owner_id: c.owner, hubspot_owner_assigneddate: c.assigned, createdate: c.created,
  utm_term: c.term, lifecyclestage: c.lifecycle, notes_last_updated: c.lastActivity || null });

/** The world one test runs in. */
let w: {
  search: Lead[];                                    // what HubSpot's search index returns
  fresh: Record<string, Partial<Lead>>;              // the record now, where it differs from the index
  gone: Set<string>;                                 // contacts HubSpot no longer has
  owners: Record<string, string>;                    // HubSpot owner id -> email (absent: 404)
  users: Record<string, string>;                     // monday users by email
  status: { label: string; changedAt: number | null } | null;   // the card's 跟进提醒
  owner: string[];                                   // the card's Contact owner
  workflow: boolean;                                 // #07 on
  emails: number;
  labelFails: ("rate" | "lost-landed" | "lost-unlanded")[];      // how the next label writes fail
  onCellRead?: () => void;
};
let labels: { retries: number; label: string }[];
let searches: any[];
let logs: string[];

/** A change of 跟进提醒: #07 emails on a change INTO a trigger label, then sets 已提醒. A clear mails nobody. */
function apply(v: { label: string } | null) {
  const before = w.status?.label ?? null;
  if (!v) { w.status = null; return; }
  w.status = { label: v.label, changedAt: store.clock.now };
  if (v.label !== before && v.label !== "已提醒" && w.workflow) {
    w.emails++;
    w.status = { label: "已提醒", changedAt: store.clock.now };
  }
}

const run = (mins: number, opts: RunOpts = live) => {
  store.clock.now = T0 + mins * MIN;
  return runFollowUpReminders(ON, opts, () => store.clock.now);
};
const key = (checkpoint: 30 | 60, assigned = T0, id = "9001") => `fur:${id}:${assigned}:${checkpoint}`;

beforeEach(() => {
  vi.clearAllMocks();
  store.notes.clear();
  store.locks.clear();
  logs = []; labels = []; searches = [];
  w = { search: [lead()], fresh: {}, gone: new Set(), owners: { "77": "owner77@example.test" },
    users: { "owner77@example.test": "501" }, status: null, owner: ["person:501"], workflow: true, emails: 0,
    labelFails: [] };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.getUsersByEmail.mockImplementation(async () => w.users);
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv[STATUS]));
  md.gql.mockImplementation(async (_e: unknown, query: string, vars: any, retries: number) => {
    if (/^\s*query/.test(query)) {
      w.onCellRead?.();
      const s = w.status;
      return { items: [{ column_values: [
        { id: STATUS, text: s?.label ?? "", index: s ? INDEX[s.label] : null,
          value: s ? JSON.stringify({ index: INDEX[s.label], ...(s.changedAt != null ? { changed_at: iso(s.changedAt) } : {}) }) : null },
        { id: OWNER_COL, text: "", value: null,
          persons_and_teams: w.owner.map(p => ({ kind: p.split(":")[0], id: p.split(":")[1] })) },
      ] }] };
    }
    const cv = JSON.parse(vars.c);
    labels.push({ retries, label: cv[STATUS]?.label });
    const fail = w.labelFails.shift();
    if (fail === "rate") throw new md.MondayRateLimitedError("monday 429: rate-limited after 1 waits");
    if (fail === "lost-unlanded") throw new Error("monday 504: gateway timeout");
    apply(cv[STATUS]);
    if (fail === "lost-landed") throw new Error("monday 504: gateway timeout");
    return { change_multiple_column_values: { id: vars.i } };
  });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string, body?: any) => {
    if (method === "POST") {
      searches.push(body);
      const from = Number(body.after ?? 0);
      const page = w.search.slice(from, from + body.limit);
      return { total: w.search.length, results: page.map(c => ({ id: c.id, properties: propsOf(c) })),
        ...(from + body.limit < w.search.length ? { paging: { next: { after: String(from + body.limit) } } } : {}) };
    }
    const contact = /^\/crm\/v3\/objects\/contacts\/(\w+)\?/.exec(path);
    if (contact) {
      const base = w.search.find(c => c.id === contact[1]);
      if (!base || w.gone.has(contact[1])) throw new Error(`hubspot GET ${path}: 404 Not Found`);
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

describe("reminderDue (pure)", () => {
  it.each([
    [29, null], [30, 30], [45, 30], [59, 30], [60, 60], [75, 60], [90, 60], [91, null],
  ])("%i minutes after the assignment -> %s", (mins, want) => {
    const d = reminderDue(lead(), T0 + (mins as number) * MIN);
    expect("checkpoint" in d ? d.checkpoint : null).toBe(want);
  });

  it.each(["docusign", "DocuSign", "docusign下载", "HubSpot CRM", "hubspot", "sumsub+hubspot"])(
    "term %j matches", (term) => expect(reminderDue(lead({ term }), T0 + 31 * MIN)).toEqual({ checkpoint: 30 }));

  it.each(["tableau", "minitab", "", "docu sign"])("term %j does not", (term) =>
    expect(reminderDue(lead({ term }), T0 + 31 * MIN)).toHaveProperty("skip"));

  it("new leads only: created more than 24 h before the assignment is history, ignored", () => {
    expect(reminderDue(lead({ created: iso(T0 - 25 * 60 * MIN) }), T0 + 31 * MIN)).toEqual({ skip: "not a new lead" });
    expect(reminderDue(lead({ created: iso(T0 - 23 * 60 * MIN) }), T0 + 31 * MIN)).toEqual({ checkpoint: 30 });
  });

  it("a lead created at 23:50 and assigned at 23:55 is still reminded after midnight (no calendar 'today' gap)", () => {
    const assigned = Date.parse("2026-10-12T15:55:00Z");    // 23:55 MYT
    const c = lead({ created: "2026-10-12T15:50:00Z", assigned: iso(assigned) });
    expect(reminderDue(c, assigned + 31 * MIN)).toEqual({ checkpoint: 30 });   // 00:26 MYT the next day
  });

  it("Lifecycle other than 1.NEW, activity logged after the assignment, or no owner: no reminder", () => {
    expect(reminderDue(lead({ lifecycle: "marketingqualifiedlead" }), T0 + 31 * MIN)).toHaveProperty("skip");
    expect(reminderDue(lead({ lastActivity: iso(T0 + 10 * MIN) }), T0 + 31 * MIN))
      .toEqual({ skip: "followed up since the assignment" });
    expect(reminderDue(lead({ lastActivity: iso(T0) }), T0 + 31 * MIN))
      .toEqual({ skip: "followed up since the assignment" });       // at the very moment of the assignment counts
    expect(reminderDue(lead({ owner: "" }), T0 + 31 * MIN)).toEqual({ skip: "no owner" });
  });

  it("OPTION A: activity only BEFORE the (re)assignment does not count -- the new owner is still reminded", () => {
    expect(reminderDue(lead({ lastActivity: iso(T0 - 20 * MIN) }), T0 + 31 * MIN)).toEqual({ checkpoint: 30 });
    expect(reminderDue(lead({ lastActivity: String(T0 - 1) }), T0 + 61 * MIN)).toEqual({ checkpoint: 60 });
  });

  it("an epoch-ms assignment stamp works as well as an ISO one", () =>
    expect(reminderDue(lead({ assigned: String(T0) }), T0 + 61 * MIN)).toEqual({ checkpoint: 60 }));
});

describe("landedSince (pure): did a write made at or after a time reach 跟进提醒?", () => {
  const cell = (index: number | null, changed?: number, text = "已提醒") =>
    ({ text, index, value: index == null ? null : JSON.stringify({ index, ...(changed != null ? { changed_at: iso(changed) } : {}) }) });
  it("a label set since then: landed", () => expect(landedSince(cell(1, T0 + 1000), T0)).toBe(true));
  it("a label from before then: not landed", () => expect(landedSince(cell(1, T0 - 60_000), T0)).toBe(false));
  it("an empty cell -- even one showing monday's phantom text -- not landed", () => {
    expect(landedSince(undefined, T0)).toBe(false);
    expect(landedSince({ text: "已提醒", index: null, value: null }, T0)).toBe(false);
  });
  it("a label with no change time, or no time to compare with: unknown", () => {
    expect(landedSince(cell(1), T0)).toBeNull();
    expect(landedSince(cell(1, T0 + 1000), NaN)).toBeNull();
  });
});

describe("the search", () => {
  it("asks HubSpot only for the window, Lifecycle 1.NEW, a term and a new lead's age -- oldest assignment first", async () => {
    w.search = [];
    const now = T0 + 31 * MIN;
    await run(31);
    expect(searches).toHaveLength(1);
    expect(searches[0].filterGroups[0].filters).toEqual([
      { propertyName: "hubspot_owner_assigneddate", operator: "GTE", value: String(now - 90 * MIN) },
      { propertyName: "hubspot_owner_assigneddate", operator: "LTE", value: String(now - 30 * MIN) },
      { propertyName: "lifecyclestage", operator: "EQ", value: "lead" },
      { propertyName: "utm_term", operator: "HAS_PROPERTY" },
      { propertyName: "createdate", operator: "GTE", value: String(now - 90 * MIN - 24 * 60 * MIN) },
    ]);
    expect(searches[0].sorts).toEqual([{ propertyName: "hubspot_owner_assigneddate", direction: "ASCENDING" }]);
    expect(searches[0].properties).toContain("notes_last_updated");
  });

  it("reads at most 5 pages of 100, and says so when more matched", async () => {
    w.search = Array.from({ length: 620 }, (_, i) => lead({ id: String(10_000 + i), term: "tableau" }));
    const s = await run(31);
    expect(searches).toHaveLength(5);
    expect(s).toMatchObject({ candidates: 500, unread: 120 });
    expect(logs.some(l => /\[follow-up\] action=truncated read=500 unread=120/.test(l))).toBe(true);
  });

  it("a failed search is logged, never thrown -- and the run still logs its one line", async () => {
    hub.hs.mockRejectedValue(new Error("hubspot 429"));
    await expect(run(31)).resolves.toMatchObject({ errors: 1 });
    expect(logs.filter(l => l.startsWith("[follow-up] action=run "))).toHaveLength(1);
    expect(store.locks.size).toBe(0);                        // released
  });
});

describe("runFollowUpReminders", () => {
  it("switch off: no search, no write", async () => {
    const s = await runFollowUpReminders({ ENABLE_CRM: "true" } as unknown as Env, live, T0 + 31 * MIN);
    expect(hub.hs).not.toHaveBeenCalled();
    expect(labels).toHaveLength(0);
    expect(s.flagged).toBe(0);
    expect(followUpReminderOn({ FOLLOW_UP_REMINDER: "true" })).toBe(false);   // never without ENABLE_CRM
  });

  it("logs one summary line every run, even with nothing to do (proof the cron is alive)", async () => {
    w.search = [];
    await run(31);
    expect(logs.filter(l => l.startsWith("[follow-up] action=run "))).toHaveLength(1);
  });

  it("flags 30分钟未跟进 once, in ONE attempt: the note pending before the write, sent after -- one email", async () => {
    const s = await run(31);
    expect(s.flagged).toBe(1);
    expect(labels).toEqual([{ retries: 1, label: "30分钟未跟进" }]);
    expect(md.setColumns).not.toHaveBeenCalled();            // nothing to clear: the cell did not show the label
    expect(store.setWatermark.mock.calls.map(c => [c[1], String(c[2]).split(":")[0]]))
      .toEqual([[key(30), "pending"], [key(30), "sent"]]);
    expect(w.emails).toBe(1);
    expect(logs.some(l => /\[follow-up\] contact=9001 checkpoint=30 item=5551 action=flagged label="30分钟未跟进" owner=77$/.test(l)))
      .toBe(true);
  });

  it("a cell still showing this very label (an earlier cycle's flag #07 never finished) is cleared first, so #07 fires", async () => {
    w.status = { label: "30分钟未跟进", changedAt: T0 - 2 * 60 * MIN };
    await run(31);
    expect(md.setColumns.mock.calls.map(c => c[3])).toEqual([{ [STATUS]: null }]);
    expect(labels.map(l => l.label)).toEqual(["30分钟未跟进"]);
    expect(w.emails).toBe(1);
  });

  it("NEVER TWICE: the next runs inside the same half-hour write nothing", async () => {
    for (const m of [31, 36, 41, 46, 51, 56]) await run(m);
    expect(labels).toHaveLength(1);
    expect(w.emails).toBe(1);
  });

  it("then the 60-minute reminder fires once, and nothing after it", async () => {
    for (const m of [31, 36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86]) await run(m);
    expect(labels.map(l => l.label)).toEqual(["30分钟未跟进", "60分钟未跟进"]);
    expect(w.emails).toBe(2);
  });

  it("a NEW assignment (a new stamp) is a new cycle with its own reminders", async () => {
    await run(31);
    const T1 = T0 + 40 * MIN;                                    // reassigned
    w.search = [lead({ assigned: iso(T1) })];
    await run(40 + 31);
    expect(labels.map(l => l.label)).toEqual(["30分钟未跟进", "30分钟未跟进"]);
    expect(store.notes.get(key(30, T1))).toMatch(/^sent:/);
  });

  it("the cycle is the assignment's TIME: the same assignment read as ISO, then as epoch ms, is reminded once", async () => {
    await run(31);
    w.search = [lead({ assigned: String(T0) })];
    await run(36);
    expect(labels).toHaveLength(1);
  });

  it("a lead with activity only before its reassignment is flagged for the new owner", async () => {
    w.search = [lead({ lastActivity: iso(T0 - 5 * MIN) })];
    expect((await run(31)).flagged).toBe(1);
  });

  it("only the matching contact of several is flagged", async () => {
    w.search = [lead(), lead({ id: "9002", term: "tableau" }), lead({ id: "9003", lastActivity: "2026-10-12T02:10:00Z" })];
    const s = await run(31);
    expect(s).toMatchObject({ candidates: 3, flagged: 1, skipped: 2 });
  });

  it("FAILS CLOSED: an unreadable note store writes nothing", async () => {
    store.getWatermark.mockRejectedValueOnce(new Error("watermark x unreadable: DO down"));
    const s = await run(31);
    expect(s.errors).toBe(1);
    expect(labels).toHaveLength(0);
  });

  it("FAILS CLOSED: a note that cannot be saved writes nothing", async () => {
    store.setWatermark.mockRejectedValueOnce(new Error("watermark x not saved: DO down"));
    const s = await run(31);
    expect(s.errors).toBe(1);
    expect(labels).toHaveLength(0);
  });

  it("no card yet: nothing written, nothing noted -- the next run tries again", async () => {
    reg.lookupCard.mockResolvedValue(null);
    const s = await run(31);
    expect(s.noCard).toBe(1);
    expect(labels).toHaveLength(0);
    expect(store.setWatermark).not.toHaveBeenCalled();
  });

  it("DRY_RUN writes nothing, notes nothing and takes no lock", async () => {
    await run(31, { ...live, dryRun: true });
    expect(labels).toHaveLength(0);
    expect(md.setColumns).not.toHaveBeenCalled();
    expect(store.setWatermark).not.toHaveBeenCalled();
    expect(store.acquireLock).not.toHaveBeenCalled();
    expect(logs.some(l => /action=dry-run label="30分钟未跟进"/.test(l))).toBe(true);
  });
});

describe("never twice: a write whose outcome is not known", () => {
  it("a label monday REFUSED (rate-limited: it never ran) releases the note, and the next run sends it -- once", async () => {
    w.labelFails = ["rate"];
    const s1 = await run(31);
    expect(s1.errors).toBe(1);
    expect(store.notes.get(key(30))).toBe("");
    await run(36);
    await run(41);
    expect(labels).toHaveLength(2);
    expect(w.emails).toBe(1);
  });

  it("a label that LANDED but lost its reply is never re-sent: not in the run, and not by the next -- the card says it landed", async () => {
    w.labelFails = ["lost-landed"];
    const s1 = await run(31);
    expect(s1).toMatchObject({ flagged: 0, unresolved: 1 });
    expect(labels).toHaveLength(1);                          // ONE attempt: gql with retries=1, never re-sent
    expect(store.notes.get(key(30))).toBe(`pending:${T0 + 31 * MIN}`);
    await run(33);                                            // younger than PENDING_SETTLE_MS: left alone
    expect(store.notes.get(key(30))).toMatch(/^pending:/);
    const s3 = await run(36);
    expect(s3.resolved).toBe(1);
    expect(store.notes.get(key(30))).toMatch(/^sent:/);
    for (const m of [41, 46, 51, 56]) await run(m);
    expect(labels).toHaveLength(1);
    expect(w.emails).toBe(1);
  });

  it("a label that lost its reply and did NOT land is sent by a later run -- once", async () => {
    w.labelFails = ["lost-unlanded"];
    await run(31);
    expect(w.emails).toBe(0);
    for (const m of [36, 41, 46]) await run(m);
    expect(labels).toHaveLength(2);
    expect(w.emails).toBe(1);
  });

  it("a landed label whose 'sent' note failed to save is not sent again: a later run resolves it from the card", async () => {
    store.setWatermark.mockImplementation(async (_e: unknown, name: string, value: string) => {
      if (value.startsWith("sent:") && store.clock.now === T0 + 31 * MIN) throw new Error("watermark not saved: DO reset");
      store.notes.set(name, value);
    });
    const s1 = await run(31);
    expect(s1.flagged).toBe(1);
    expect(logs.some(l => /action=note-unsaved/.test(l))).toBe(true);
    for (const m of [36, 41, 46, 51, 56]) await run(m);
    expect(labels).toHaveLength(1);
    expect(w.emails).toBe(1);
    expect(store.notes.get(key(30))).toMatch(/^sent:/);
  });

  it("a stale 'pending' over a cell unchanged since before it (the run died before its label) is flagged -- once", async () => {
    w.status = { label: "已提醒", changedAt: T0 - 3 * 60 * MIN };       // an earlier cycle's
    store.notes.set(key(30), `pending:${T0 + 31 * MIN}`);
    await run(36);
    await run(41);
    expect(labels).toHaveLength(1);
    expect(w.emails).toBe(1);
  });

  it("a stale 'pending' over a label monday gives no change time for: unresolved, nothing written", async () => {
    w.status = { label: "30分钟未跟进", changedAt: null };
    store.notes.set(key(30), `pending:${T0 + 31 * MIN}`);
    const s = await run(36);
    expect(s.unresolved).toBe(1);
    expect(labels).toHaveLength(0);
    expect(md.setColumns).not.toHaveBeenCalled();
  });

  it("a failed clear means the label never left: the note is released and the next run flags -- once", async () => {
    w.status = { label: "30分钟未跟进", changedAt: T0 - 2 * 60 * MIN };
    md.setColumns.mockRejectedValueOnce(new Error("monday 500"));
    const s1 = await run(31);
    expect(s1.errors).toBe(1);
    expect(labels).toHaveLength(0);
    expect(store.notes.get(key(30))).toBe("");
    await run(36);
    await run(41);
    expect(labels).toHaveLength(1);
    expect(w.emails).toBe(1);
  });

  it("the pending note is stamped when it is written, not when the run started", async () => {
    let calls = 0;
    w.onCellRead = () => { if (calls++ === 0) store.clock.now += 2 * MIN; };   // a slow card read
    await run(31);
    expect(store.notes.get(key(30))).toMatch(/^sent:/);
    expect(store.setWatermark.mock.calls.find(c => String(c[2]).startsWith("pending:"))![2])
      .toBe(`pending:${T0 + 33 * MIN}`);
  });
});

describe("one run at a time", () => {
  it("another run holds the lock: this one searches nothing and writes nothing", async () => {
    store.locks.set("follow-up", { at: T0 + 30 * MIN, owner: "other-run" });
    const s = await run(31);
    expect(s.busy).toBe(true);
    expect(hub.hs).not.toHaveBeenCalled();
    expect(labels).toHaveLength(0);
    expect(logs.filter(l => l.startsWith("[follow-up] action=run "))).toHaveLength(1);
  });

  it("a lock left by a run that died is taken over once its hold has passed", async () => {
    store.locks.set("follow-up", { at: T0 + 31 * MIN - RUN_LOCK_HOLD_MS - 1, owner: "dead-run" });
    expect((await run(31)).flagged).toBe(1);
  });

  it("the lock is RENEWED right before the write: a run that lost it writes nothing more", async () => {
    w.search = [lead(), lead({ id: "9002" })];
    w.onCellRead = () => store.locks.set("follow-up", { at: store.clock.now, owner: "newer-run" });
    const s = await run(31);
    expect(labels).toHaveLength(0);
    expect(store.setWatermark).not.toHaveBeenCalled();
    expect(s.deferred).toBe(2);
    expect(store.locks.get("follow-up")?.owner).toBe("newer-run");           // never released by the loser
  });

  it("the lock is released when the run ends", async () => {
    await run(31);
    expect(store.acquireLock).toHaveBeenCalledTimes(1);
    expect(store.renewLock).toHaveBeenCalledTimes(1);
    expect(store.locks.size).toBe(0);
  });

  it("a run past its deadline starts no new card: the rest are left to the next run", async () => {
    w.search = [lead(), lead({ id: "9002" }), lead({ id: "9003" })];
    w.onCellRead = () => { store.clock.now += 4 * MIN; };       // a slow monday
    const s = await run(31);
    expect(s).toMatchObject({ flagged: 1, deferred: 2 });
    expect(logs.some(l => /action=stopped deferred=2/.test(l))).toBe(true);
  });

  it("two overlapping runs never flag one contact twice", async () => {
    // Run A is held inside its first card read until run B has started and finished.
    let releaseA!: () => void;
    const gate = new Promise<void>(r => { releaseA = r; });
    let first = true;
    w.onCellRead = () => undefined;
    const realGql = md.gql.getMockImplementation()!;
    md.gql.mockImplementation(async (...a: any[]) => {
      if (first && /^\s*query/.test(a[1])) { first = false; await gate; }
      return realGql(...(a as [any, any, any, any]));
    });
    store.clock.now = T0 + 31 * MIN;
    const a = runFollowUpReminders(ON, live, () => store.clock.now);
    await new Promise(r => setTimeout(r, 10));
    store.clock.now = T0 + 36 * MIN;
    const b = await runFollowUpReminders(ON, live, () => store.clock.now);
    expect(b.busy).toBe(true);
    releaseA();
    await a;
    expect(labels).toHaveLength(1);
    expect(w.emails).toBe(1);
  });
});

describe("read fresh: the search index lags HubSpot by minutes", () => {
  it("a call logged since the assignment that the index does not show yet: nothing written", async () => {
    w.fresh["9001"] = { lastActivity: iso(T0 + 28 * MIN) };
    const s = await run(31);
    expect(labels).toHaveLength(0);
    expect(s.skipped).toBe(1);
    expect(logs.some(l => /action=skip reason="read fresh: followed up since the assignment"/.test(l))).toBe(true);
  });

  it("Lifecycle moved off 1.NEW: nothing written", async () => {
    w.fresh["9001"] = { lifecycle: "marketingqualifiedlead" };
    await run(31);
    expect(labels).toHaveLength(0);
  });

  it("reassigned since the search: the old assignment's 60-minute reminder is not sent", async () => {
    w.fresh["9001"] = { assigned: iso(T0 + 58 * MIN) };
    const s = await run(61);
    expect(labels).toHaveLength(0);
    expect(s.skipped).toBe(1);
    expect(logs.some(l => /reassigned since the search/.test(l))).toBe(true);
  });

  it("a contact HubSpot no longer has: nothing written", async () => {
    w.gone.add("9001");
    await run(31);
    expect(labels).toHaveLength(0);
  });
});

describe("whom #07 mails: the card's Contact owner", () => {
  it("still showing the previous owner: nothing written, nothing noted -- flagged once the card shows the new one", async () => {
    w.owner = ["person:999"];
    const s1 = await run(31);
    expect(s1.waiting).toBe(1);
    expect(labels).toHaveLength(0);
    expect(store.setWatermark).not.toHaveBeenCalled();
    expect(logs.some(l => /action=wait-owner owner=77 card_shows=person:999 wants=person:501/.test(l))).toBe(true);
    w.owner = ["person:501"];
    await run(36);
    expect(w.emails).toBe(1);
  });

  it("showing nobody yet, though the owner has a monday account: waits", async () => {
    w.owner = [];
    expect((await run(31)).waiting).toBe(1);
    expect(labels).toHaveLength(0);
  });

  it("an owner with NO monday account: the card shows nobody, and it is flagged all the same (seat=none) -- #07's CC is told", async () => {
    w.users = {};
    w.owner = [];
    expect((await run(31)).flagged).toBe(1);
    expect(logs.some(l => /action=flagged label="30分钟未跟进" owner=77 seat=none/.test(l))).toBe(true);
  });

  it("an owner with no monday account while the card still shows someone: waits -- never mails the previous owner", async () => {
    w.users = {};
    w.owner = ["person:999"];
    expect((await run(31)).waiting).toBe(1);
    expect(labels).toHaveLength(0);
  });

  it("each owner's email and monday's user list are read once a run", async () => {
    w.search = [lead(), lead({ id: "9002" })];
    await run(31);
    expect(hub.hs.mock.calls.filter(c => String(c[2]).startsWith("/crm/v3/owners/"))).toHaveLength(1);
    expect(md.getUsersByEmail).toHaveBeenCalledTimes(1);
    expect(labels).toHaveLength(2);
  });

  it("an owner read that fails (not a 404) is an error: nothing written, the next run tries again", async () => {
    const real = hub.hs.getMockImplementation()!;
    hub.hs.mockImplementationOnce(real).mockImplementationOnce(real).mockImplementationOnce(async () => {
      throw new Error("hubspot GET /crm/v3/owners/77: 503 Service Unavailable");
    });
    const s = await run(31);
    expect(s.errors).toBe(1);
    expect(labels).toHaveLength(0);
    await run(36);
    expect(w.emails).toBe(1);
  });
});

describe("constants the design rests on", () => {
  it("a pending note settles well inside a checkpoint's half-hour, and the lock outlasts one card", () => {
    expect(PENDING_SETTLE_MS).toBeLessThan(10 * MIN);
    expect(RUN_LOCK_HOLD_MS).toBeGreaterThan(5 * MIN);
    expect(FOLLOW_UP.statusCol).toBe(STATUS);
  });
});
