import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC for RULE-N1 ("HubSpot is read before two monday calls that can each wait up to 65 s, and is not read
 * again before the write").
 *
 * A TIMED WORLD instead of an instant one: every external call costs latency, the forward owner sync lands
 * SYNC_MS after HubSpot's change (the live 3-7 s; the fastest end is used, which favours the claim), and a
 * monday rate-limit wait is an explicit refusal + wait + re-send (gql's own shape, monday.ts:55-61). #07 is judged
 * at the moment the label lands (the card's Contact owner then), so a wrong recipient can only come from the run.
 *
 * Part A tests the claim's (a): a call logged DURING a wait is logged AFTER the checkpoint the run decided on.
 * Part B tests the claim's (b) on realistic timing, and where its proposed fix would put the re-read.
 */

const sim = vi.hoisted(() => {
  const s = {
    now: 0,
    events: [] as { at: number; fn: () => void }[],
    trace: [] as { t: number; what: string }[],
    advance(ms: number) {
      const target = s.now + ms;
      for (;;) {
        s.events.sort((a, b) => a.at - b.at);
        const e = s.events[0];
        if (!e || e.at > target) break;
        s.events.shift();
        s.now = Math.max(s.now, e.at);
        e.fn();
      }
      s.now = target;
    },
    at(t: number, fn: () => void) { s.events.push({ at: t, fn }); },
    mark(what: string) { s.trace.push({ t: s.now, what }); },
  };
  return s;
});

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
  return { notes, locks };
});
const DO_MS = 30;
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/monday", () => md);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({
  getWatermark: vi.fn(async (_e: unknown, name: string) => { sim.advance(DO_MS); sim.mark("do:getWatermark");
    return store.notes.has(name) ? store.notes.get(name)! : null; }),
  setWatermark: vi.fn(async (_e: unknown, name: string, value: string) => { sim.advance(DO_MS);
    sim.mark(`do:setWatermark:${value.split(":")[0]}`); store.notes.set(name, value); }),
  acquireLock: vi.fn(async (_e: unknown, name: string, holdMs: number, owner: string) => {
    sim.advance(DO_MS);
    const rec = store.locks.get(name);
    if (rec && rec.owner !== owner && sim.now - rec.at < holdMs) return false;
    store.locks.set(name, { at: sim.now, owner });
    return true;
  }),
  renewLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
    sim.advance(DO_MS); sim.mark("do:renewLock");
    const rec = store.locks.get(name);
    if (!rec || rec.owner !== owner) return false;
    store.locks.set(name, { at: sim.now, owner });
    return true;
  }),
  releaseLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
    sim.advance(DO_MS);
    if (store.locks.get(name)?.owner === owner) store.locks.delete(name);
  }),
}));

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const HS_MS = 250;              // one HubSpot GET
const MD_MS = 500;              // one monday call (a Worker's; the runbook's local scripts saw up to ~2.5 s)
const SYNC_MS = 3_000;          // HubSpot change -> card shows it (live 3-7 s): the fastest, the claim's best case
const RATE_WAIT_MS = 15_000;    // gql's wait when monday's reply names no reset time (monday.ts:59)
const T0 = Date.parse("2026-10-12T02:00:00Z");
const STATUS = "color_mm82ccsb";
const OWNER_COL = "multiple_person_mm6zap53";
const INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
const iso = (t: number) => new Date(t).toISOString();

let w: {
  hs: { owner: string; assigned: number; lastActivity: number | null };
  owners: Record<string, string>;
  users: Record<string, string>;
  card: { status: { label: string; changedAt: number } | null; owner: string[] };
  emails: { label: string; to: string[]; at: number }[];
  limitUsers: boolean; limitCells: boolean; limitLabel: boolean;
  onFreshRead?: () => void;
  onCellsWait?: () => void;
  onLabelRefused?: () => void;
};

const props = () => ({ hubspot_owner_id: w.hs.owner, hubspot_owner_assigneddate: iso(w.hs.assigned),
  createdate: iso(T0 - 5 * MIN), utm_term: "docusign", lifecyclestage: "lead",
  notes_last_updated: w.hs.lastActivity == null ? null : iso(w.hs.lastActivity) });

/** #07: a change INTO a trigger label mails the card's Contact owner now, then sets 已提醒. */
function land(v: { label: string } | null) {
  const before = w.card.status?.label ?? null;
  if (!v) { w.card.status = null; return; }
  w.card.status = { label: v.label, changedAt: sim.now };
  if (v.label !== before && v.label !== "已提醒") {
    w.emails.push({ label: v.label, to: [...w.card.owner], at: sim.now });
    w.card.status = { label: "已提醒", changedAt: sim.now };
  }
}

/** HubSpot reassigns the lead to owner 88 at time `r`; the forward sync puts monday user 502 on the card SYNC_MS on. */
function reassignAt(r: number) {
  sim.at(r, () => { w.hs.owner = "88"; w.hs.assigned = r; sim.mark("hubspot:reassigned"); });
  sim.at(r + SYNC_MS, () => { w.card.owner = ["person:502"]; sim.mark("card:shows-502"); });
}

const run = (mins: number, secs = 0) => {
  sim.now = T0 + mins * MIN + secs * 1000;
  return runFollowUpReminders(ON, live, () => sim.now);
};

beforeEach(() => {
  vi.clearAllMocks();
  store.notes.clear(); store.locks.clear();
  sim.events = []; sim.trace = [];
  w = { hs: { owner: "77", assigned: T0, lastActivity: null },
    owners: { "77": "owner77@example.test", "88": "owner88@example.test" },
    users: { "owner77@example.test": "501", "owner88@example.test": "502" },
    card: { status: null, owner: ["person:501"] }, emails: [],
    limitUsers: false, limitCells: false, limitLabel: false };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockImplementation(async () => { sim.advance(DO_MS); return "5551"; });
  md.findItemByColumn.mockResolvedValue([]);
  md.getUsersByEmail.mockImplementation(async () => {
    sim.mark("md:users");
    if (w.limitUsers) { sim.advance(MD_MS); sim.advance(RATE_WAIT_MS); }   // refused, waited, re-sent
    sim.advance(MD_MS);
    return { ...w.users };
  });
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => {
    sim.advance(MD_MS / 2); land(cv[STATUS]); sim.advance(MD_MS / 2);
  });
  md.gql.mockImplementation(async (_e: unknown, query: string, vars: any) => {
    if (/^\s*query/.test(query)) {
      sim.mark("md:cells");
      if (w.limitCells) { sim.advance(MD_MS); w.onCellsWait?.(); sim.advance(RATE_WAIT_MS); }
      sim.advance(MD_MS);
      const s = w.card.status;
      return { items: [{ column_values: [
        { id: STATUS, text: s?.label ?? "", index: s ? INDEX[s.label] : null,
          value: s ? JSON.stringify({ index: INDEX[s.label], changed_at: iso(s.changedAt) }) : null },
        { id: OWNER_COL, text: "", value: null,
          persons_and_teams: w.card.owner.map(p => ({ kind: p.split(":")[0], id: p.split(":")[1] })) },
      ] }] };
    }
    sim.mark("md:label");
    if (w.limitLabel) {               // monday refuses it (it did NOT run); gql waits, then sends it again
      sim.advance(MD_MS); sim.mark("md:label-refused"); w.onLabelRefused?.(); sim.advance(RATE_WAIT_MS);
    }
    sim.advance(MD_MS / 2);
    land(JSON.parse(vars.c)[STATUS]);
    sim.mark("md:label-landed");
    sim.advance(MD_MS / 2);
    return { change_multiple_column_values: { id: vars.i } };
  });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    if (method === "POST") { sim.advance(400); return { total: 1, results: [{ id: "9001", properties: props() }] }; }
    if (/^\/crm\/v3\/objects\/contacts\/9001\?/.test(path)) {
      sim.advance(HS_MS); sim.mark("hs:contact"); const p = props(); w.onFreshRead?.(); return { id: "9001", properties: p };
    }
    const owner = /^\/crm\/v3\/owners\/(\w+)/.exec(path);
    if (owner) { sim.advance(HS_MS); sim.mark("hs:owner"); return { id: owner[1], email: w.owners[owner[1]] }; }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

const tOf = (what: string) => sim.trace.find(e => e.what === what)?.t ?? NaN;
const toB = () => w.emails.filter(e => e.to.includes("person:502"));

describe("Part A -- the claim's (a): a call logged during a wait comes AFTER the checkpoint the run decided on", () => {
  it("(a) replayed: the call lands after the 30-minute checkpoint, and the decision was taken after it too", async () => {
    // The claim's (a), timed: the card read waits (15 s here); the owner logs a call 10 s after the fresh read.
    w.limitCells = true;
    w.onFreshRead = () => sim.at(sim.now + 10_000, () => { w.hs.lastActivity = sim.now; sim.mark("hubspot:call-logged"); });
    await run(31);
    const decided = tOf("hs:contact"), call = tOf("hubspot:call-logged");
    expect(decided - T0, "the run decides (fresh read) at or after the 30-minute checkpoint").toBeGreaterThanOrEqual(30 * MIN);
    expect(call - T0, "the call the wait hides was logged after the 30-minute checkpoint").toBeGreaterThan(30 * MIN);
    expect(w.emails.map(e => e.label)).toEqual(["30分钟未跟进"]);
  });

  it("control: NO wait at all, same call time (+31:55) -- the reminder goes out all the same, just before the call", async () => {
    w.onFreshRead = () => sim.at(T0 + 31 * MIN + 55_000, () => { w.hs.lastActivity = sim.now; });
    await run(31);
    expect(w.emails.map(e => e.label), "the lead was untouched at its checkpoint: reminded with or without a wait")
      .toEqual(["30分钟未跟进"]);
    expect(w.emails[0].to).toEqual(["person:501"]);
  });

  it("control: the cron's own phase already decides the same case -- a run at +34 sees the +31:55 call, nothing sent", async () => {
    sim.now = T0;
    sim.at(T0 + 31 * MIN + 55_000, () => { w.hs.lastActivity = sim.now; });
    sim.advance(34 * MIN);                                   // the call is in HubSpot before this run starts
    await run(34);
    expect(w.emails, "whether a 30-35 min follow-up is mailed is the 5-minute cron's phase, by design").toHaveLength(0);
  });
});

describe("Part B -- the claim's (b) on realistic timing", () => {
  it("control: no monday wait -- a reassignment 0.1 s after the fresh read cannot reach the card before the label", async () => {
    w.onFreshRead = () => reassignAt(sim.now + 100);
    await run(31);
    sim.advance(10_000);                                     // let the sync land, after the run
    expect(toB(), "B is not mailed without a wait").toEqual([]);
    expect(w.emails.map(e => e.to.join())).toEqual(["person:501"]);   // the cycle's owner, as designed
    expect(tOf("md:label-landed")).toBeLessThan(tOf("card:shows-502"));
  });

  it("(b) reproduced with a 15 s wait on monday's user list: B is mailed A's cycle's reminder", async () => {
    w.limitUsers = true;
    w.onFreshRead = () => reassignAt(sim.now + 1_000);
    await run(31);
    expect(toB(), "B was mailed '30分钟未跟进' for A's assignment seconds into B's own: the users-list wait").toEqual([]);
  });

  it("the SAME race through the label's own rate-limit wait -- after every HubSpot read, so the proposed re-read before renewLock cannot see it", async () => {
    w.limitLabel = true;
    w.onLabelRefused = () => reassignAt(sim.now + 1);
    await run(31);
    // Where the reassignment fell: after the fresh read, after renewLock and after the pending note -- i.e. after the
    // point where the claim's fix would re-read HubSpot (immediately before renewLock).
    const r = tOf("hubspot:reassigned");
    expect(r).toBeGreaterThan(tOf("hs:contact"));
    expect(r).toBeGreaterThan(tOf("do:renewLock"));
    expect(r).toBeGreaterThan(tOf("do:setWatermark:pending"));
    expect(toB(), "B was mailed A's cycle's reminder: the label's maxRateWaits=1 re-sent it after the reassignment").toEqual([]);
  });
});
