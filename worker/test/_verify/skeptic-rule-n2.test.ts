import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC for RULE-N2 ("wait-owner never asks for the sync it waits on").
 *
 * The claim's own world leaves out the one thing that heals a lost owner sync in the LIVE config: the owner notice
 * (OWNER_NOTICE "true" since 2026-10-10), queued for every HubSpot owner change, which spills the contact's sync
 * when the card does not show the new owner (owner-notice.ts:441-452). Here BOTH run, the real noticeOwner and the
 * real runFollowUpReminders, on one card:
 *   - the reassignment's inline forward sync is LOST (the card keeps the previous owner, person:999);
 *   - the owner-change webhook queues the notice: it runs at +5 s; a "busy" is retried by the queue at +20 s, after
 *     the sync it spilled (the queue runs the sync ahead of the notice's retry);
 *   - #06 (on 待通知) mails the card's Contact owner and records them in 上次通知Owner; #07 (on 30/60) mails the card's
 *     Contact owner and sets 已提醒.
 * Nothing else ever touches the card (no Contacts sweep: skipFullReconcile; no CRM incremental cron).
 */

const clock = vi.hoisted(() => ({ now: 0 }));
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
  const notices = new Map<string, string>();
  const locks = new Map<string, { at: number; owner: string }>();
  return { notes, notices, locks };
});
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/monday", () => md);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({
  getWatermark: vi.fn(async (_e: unknown, name: string) => store.notes.has(name) ? store.notes.get(name)! : null),
  setWatermark: vi.fn(async (_e: unknown, name: string, value: string) => { store.notes.set(name, value); }),
  acquireLock: vi.fn(async (_e: unknown, name: string, holdMs: number, owner: string) => {
    const rec = store.locks.get(name);
    if (rec && rec.owner !== owner && clock.now - rec.at < holdMs) return false;
    store.locks.set(name, { at: clock.now, owner });
    return true;
  }),
  renewLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
    const rec = store.locks.get(name);
    if (!rec || rec.owner !== owner) return false;
    store.locks.set(name, { at: clock.now, owner });
    return true;
  }),
  releaseLock: vi.fn(async (_e: unknown, name: string, owner: string) => {
    if (store.locks.get(name)?.owner === owner) store.locks.delete(name);
  }),
  lastNoticedCycle: vi.fn(async (_e: unknown, id: string) => {
    const raw = store.notices.get(id);
    return raw ? JSON.parse(raw) : null;
  }),
  rememberNoticedCycle: vi.fn(async (_e: unknown, id: string, cycle: string, at: number, flag?: unknown) => {
    store.notices.set(id, JSON.stringify({ cycle, at, ...(flag ? { flag } : {}) })); return true;
  }),
  recordNoticeFlag: vi.fn(async (_e: unknown, id: string, settled: { cycle: string; at: number } | null, flag: unknown) => {
    store.notices.set(id, JSON.stringify({ cycle: settled?.cycle ?? "", at: settled?.at ?? 0, flag }));
  }),
}));
// The deferred queue: asked for a contact's sync, it runs it -- the card's Contact owner becomes HubSpot's owner's
// monday user, or nobody (mapping.ts formatValue; reconcile.ts peopleClear).
vi.mock("../../src/deferred-sync", () => ({
  spillDeferred: vi.fn(async (_e: unknown, items: any[]) => {
    for (const i of items ?? []) if (i?.type === "contact") { q.asked.push(String(i.id)); q.bring(String(i.id)); }
    return true;
  }),
  spillDeferredLeftover: vi.fn(async () => []),
}));

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");
const { noticeOwner } = await import("../../src/owner-notice");
const { CRM_CONTACTS } = await import("../../src/config/crm");

const ENV = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", OWNER_NOTICE: "true", DRY_RUN: "false" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const FOLLOW = "color_mm82ccsb", NOTICE = "color_mm7zktxc", TOLD = "email_mm7v3xxg", OWNER_COL = "multiple_person_mm6zap53";
const FU_INDEX: Record<string, number> = { "30分钟未跟进": 0, "已提醒": 1, "60分钟未跟进": 2 };
const NO_INDEX: Record<string, number> = { "待通知": 0, "已通知": 1 };
const EVERY_RUN = [31, 36, 41, 46, 51, 56, 61, 66, 71, 76, 81, 86];
const iso = (t: number) => new Date(t).toISOString();

let w: {
  hs: { owner: string; assigned: number };
  owners: Record<string, string>;
  users: Record<string, string>;
  card: { follow: { label: string; at: number } | null; notice: { label: string; at: number } | null; told: string; owner: string[] };
  mails07: { label: string; to: string[] }[];
  mails06: { to: string[] }[];
};
let logs: string[];

const emailOfUser = (uid: string) => Object.entries(w.users).find(([, id]) => id === uid)?.[0] ?? "";
const cellsNow = () => [
  { id: TOLD, text: w.card.told, value: w.card.told ? JSON.stringify({ email: w.card.told, text: w.card.told }) : null },
  { id: NOTICE, text: w.card.notice?.label ?? "", index: w.card.notice ? NO_INDEX[w.card.notice.label] : null,
    value: w.card.notice ? JSON.stringify({ index: NO_INDEX[w.card.notice.label], changed_at: iso(w.card.notice.at) }) : null },
  { id: FOLLOW, text: w.card.follow?.label ?? "", index: w.card.follow ? FU_INDEX[w.card.follow.label] : null,
    value: w.card.follow ? JSON.stringify({ index: FU_INDEX[w.card.follow.label], changed_at: iso(w.card.follow.at) }) : null },
  { id: OWNER_COL, text: "", value: null,
    persons_and_teams: w.card.owner.map(p => ({ kind: p.split(":")[0], id: p.split(":")[1] })) },
];

function apply(cv: Record<string, any>) {
  if (FOLLOW in cv) {
    const v = cv[FOLLOW], before = w.card.follow?.label ?? null;
    if (!v) w.card.follow = null;
    else {
      w.card.follow = { label: v.label, at: clock.now };
      if (v.label !== before && v.label !== "已提醒") {                   // #07 / #07b
        w.mails07.push({ label: v.label, to: [...w.card.owner] });
        w.card.follow = { label: "已提醒", at: clock.now };
      }
    }
  }
  if (NOTICE in cv) {
    const v = cv[NOTICE], before = w.card.notice?.label ?? null;
    w.card.notice = v ? { label: v.label, at: clock.now } : null;
    if (v?.label === "待通知" && before !== "待通知") {                    // #06
      w.mails06.push({ to: [...w.card.owner] });
      const uid = w.card.owner[0]?.split(":")[1];
      if (uid) w.card.told = emailOfUser(uid);
      w.card.notice = { label: "已通知", at: clock.now };
    }
  }
}

const followUp = (mins: number) => { clock.now = T0 + mins * MIN; return runFollowUpReminders(ENV, live, () => clock.now); };
const notice = (secs: number) => { clock.now = T0 + secs * 1000;
  return noticeOwner(ENV, undefined, CRM_CONTACTS, { contactId: "9001", why: "owner changed in HubSpot" }, () => clock.now); };

beforeEach(() => {
  vi.clearAllMocks();
  store.notes.clear(); store.notices.clear(); store.locks.clear();
  logs = []; q.asked = [];
  // Owner 66 (monday 999) held the contact before and was told; at T0 HubSpot reassigned it to 77. The inline sync
  // that should have put 77's monday user (or nobody) on the card was LOST: the card still shows 999.
  w = { hs: { owner: "77", assigned: T0 },
    owners: { "66": "prev@example.test", "77": "owner77@example.test" },
    users: { "prev@example.test": "999", "owner77@example.test": "501" },
    card: { follow: null, notice: { label: "已通知", at: T0 - 20 * MIN }, told: "prev@example.test", owner: ["person:999"] },
    mails07: [], mails06: [] };
  q.bring = (id: string) => {
    if (id !== "9001") return;
    const uid = w.users[w.owners[w.hs.owner] ?? ""];
    w.card.owner = uid ? [`person:${uid}`] : [];
  };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.getUsersByEmail.mockImplementation(async () => ({ ...w.users }));
  md.setColumns.mockImplementation(async (_e: unknown, _b: string, _i: string, cv: Record<string, any>) => apply(cv));
  md.gql.mockImplementation(async (_e: unknown, query: string, vars: any) => {
    if (/^\s*query/.test(query)) return { items: [{ column_values: cellsNow() }] };
    apply(JSON.parse(vars.c));
    return { change_multiple_column_values: { id: vars.i } };
  });
  hub.hs.mockImplementation(async (_e: unknown, method: string, path: string) => {
    const p = { hubspot_owner_id: w.hs.owner, hubspot_owner_assigneddate: iso(w.hs.assigned), createdate: iso(T0 - 5 * MIN),
      utm_term: "docusign", lifecyclestage: "lead", notes_last_updated: null };
    if (method === "POST") return { total: 1, results: [{ id: "9001", properties: p }] };
    if (/^\/crm\/v3\/objects\/contacts\/9001\?/.test(path)) return { id: "9001", properties: p };
    const owner = /^\/crm\/v3\/owners\/(\w+)/.exec(path);
    if (owner) {
      if (!(owner[1] in w.owners)) throw new Error(`hubspot GET ${path}: 404 Not Found`);
      return { id: owner[1], email: w.owners[owner[1]] };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
});

/** The live sequence after the reassignment: the queued notice (+5 s), its queue retry (+20 s) if busy, then the
 *  reminder's runs. */
async function liveSequence() {
  const first = await notice(5);
  const second = first === "busy" ? await notice(20) : null;
  for (const m of EVERY_RUN) await followUp(m);
  return { first, second };
}

describe("RULE-N2 with the owner notice in the loop (the live config)", () => {
  it("control (passes): a SEATED new owner -- the notice spills the lost sync, and both reminders reach the new owner", async () => {
    const { first, second } = await liveSequence();
    expect(first).toBe("busy");
    expect(q.asked, "the notice asked the queue for the contact's sync").toEqual(["9001"]);
    expect(second).toBe("flagged");
    expect(w.mails07.map(e => e.label)).toEqual(["30分钟未跟进", "60分钟未跟进"]);
    expect(w.mails07.every(e => e.to.join() === "person:501")).toBe(true);
    expect(logs.some(l => /action=wait-owner/.test(l)), "the reminder never even had to wait").toBe(false);
  });

  it("a SEATLESS new owner: the notice answers no-user and spills nothing -- the seat=none escalation must still reach #07's CC", async () => {
    w.owners["77"] = "noseat@example.test";                              // no monday user has this address
    const { first } = await liveSequence();
    expect(first, "the owner notice settles before its card check").toBe("no-user");
    expect(q.asked, "so nothing asks for the lost sync").toEqual([]);
    const waits = logs.filter(l => /contact=9001 .*action=wait-owner .*card_shows=person:999 wants=nobody/.test(l)).length;
    expect(w.mails07.map(e => e.label),
      `${waits} runs answered wait-owner on a card still showing the previous owner; the seat=none flag never came`)
      .toEqual(["30分钟未跟进", "60分钟未跟进"]);
  });
});
