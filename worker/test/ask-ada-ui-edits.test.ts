import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import { readWranglerConfig } from "../scripts/read-wrangler.mjs";

/**
 * ASK_ADA_UI_EDITS, AT THE WEBHOOK: people log into monday as the token user (104118038 "ask ada"),
 * and every one of that user's events used to read as the Worker's own echo. With the flag on, such an
 * event on a two-way column -- or a create -- is a PERSON's when monday's activity log proves a UI
 * action (ui-actor.ts); every uncertain path stays our own, exactly as before.
 *
 * The sync is mocked here: these prove what reaches it (selfOrigin, edit, actor) and which queue a
 * relation edit joins. test/ask-ada-ui-push.test.ts drives the same event through the real sync to a
 * HubSpot PATCH.
 */

const ASK_ADA = "104118038";
const PERSON = "104231431";
const actor = vi.hoisted(() => ({
  isIntegrationActor: vi.fn(async (_e: unknown, id: string) => !id || id === "104118038"),
  isAutomationActor: (id: string) => /^-\d+$/.test(String(id ?? "").trim()),
  actorLabel: vi.fn(async (_e: unknown, id: string) =>
    id === "104118038" ? `actor=integration user=${id}` : `actor=person user=${id}`),
}));
const sync = vi.hoisted(() => ({
  syncMondayItem: vi.fn(async (..._a: unknown[]) => "ok"), syncHubspotObject: vi.fn(), deleteHubspotObject: vi.fn(),
  getCtxCached: vi.fn(),
}));
const md = vi.hoisted(() => ({ gql: vi.fn(), getItem: vi.fn(), getUserById: vi.fn() }));
const act = vi.hoisted(() => ({ syncMondayTimeline: vi.fn(async () => "action=done") }));
const rel = vi.hoisted(() => ({ recorded: [] as string[] }));
vi.mock("../src/actor-label", () => actor);
vi.mock("../src/sync", () => sync);
vi.mock("../src/monday", async (orig) => ({ ...(await orig<typeof import("../src/monday")>()), ...md }));
vi.mock("../src/activity-sync", async (orig) => ({ ...(await orig<any>()), syncMondayTimeline: act.syncMondayTimeline }));
vi.mock("../src/card-registry", async (orig) => ({
  ...(await orig<typeof import("../src/card-registry")>()), noteCreateWindowEdit: vi.fn(async () => undefined),
}));
vi.mock("../src/relation-edit", async (orig) => {
  const real = await orig<typeof import("../src/relation-edit")>();
  return { ...real, recordRelationEvent: (k: string, d: unknown) => { rel.recorded.push(k); return real.recordRelationEvent(k, d as never); } };
});

const { handleMonday } = await import("../src/webhooks");
const ui = await import("../src/ui-actor");
const { classifyMondayActor, isOwnEcho, valueFingerprint, uiActorTiming, resetUiActorCache, uiLookupColumns } = ui;

// ------------------------------------------------------------------------------------------ fixtures

const LIFE = "color_mm70k2wk";                       // Contacts "Lifecycle Stage" (reverse: true)
const ITEM = "2866357137";                           // Lena Example
const label = (index: number, text: string) => ({ post_id: null,
  label: { is_done: false, index, style: { border: "#000", color: "#333", var_name: "x" }, text } });
const NEW = label(1, "1.NEW"), NOT_IN_CONTACT = label(6, "6.Not in contact/Pending further contact"),
  OTHER = label(10, "10.Other");

// The two rows monday's log holds for card 2866357137, as read live on 2026-10-01 (data trimmed to the
// keys the matcher reads; created_at exactly as read, in monday's 1e-7 s units: 02:11:42.3005Z, 03:12:50.7164Z).
const UI_ROW_0211 = { event: "update_column_value", user_id: ASK_ADA, created_at: "17908207023005310",
  data: JSON.stringify({ pulse_id: Number(ITEM), column_id: LIFE, board_id: 5028000495, column_type: "color",
    previous_value: { ...NEW, label: { ...NEW.label, is_done: true } }, value: NOT_IN_CONTACT,
    action_record_uuid: "a671fcec-f9e9-415f-9f52-42364cfdfeb6", is_undo_action: null }) };
const API_ROW_0312 = { event: "update_column_value", user_id: ASK_ADA, created_at: "17908243707164310",
  data: JSON.stringify({ pulse_id: Number(ITEM), column_id: LIFE, board_id: 5028000495, column_type: "color",
    previous_value: NOT_IN_CONTACT, value: OTHER, action_record_uuid: null, is_undo_action: null }) };

/** The webhook event monday sent for each of those changes (shape per monday's documented payload). */
const evAt = (o: Record<string, unknown>) => ({ boardId: Number(CRM_CONTACTS.boardId), pulseId: Number(ITEM),
  type: "update_column_value", columnId: LIFE, userId: Number(ASK_ADA), ...o });
const EV_0211 = evAt({ value: NOT_IN_CONTACT, previousValue: NEW, changedAt: 1790820702.3,
  triggerTime: "2026-10-01T02:11:42.512Z" });
const EV_0312 = evAt({ value: OTHER, previousValue: NOT_IN_CONTACT, changedAt: 1790824370.716,
  triggerTime: "2026-10-01T03:12:51.004Z" });

const base = { ENABLE_CRM: "true" } as unknown as Env;
const ON = { ...base, ASK_ADA_UI_EDITS: "true" } as unknown as Env;
const ON_BELL = { ...ON, ENABLE_ACTIVITY_SYNC: "true" } as unknown as Env;

/** What monday's activity_logs returns, per call (the last entry repeats). */
let logReplies: (unknown[] | Error | "hang")[] = [];
const logCalls = () => md.gql.mock.calls.filter(c => String(c[1]).includes("activity_logs"));

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
const settle = async () => { while (waits.length) await Promise.allSettled(waits.splice(0)); };

let logs: string[];
const logged = (re: RegExp) => logs.some(l => re.test(l));

const post = (env: Env, ev: Record<string, unknown>) =>
  handleMonday(new Request("https://w/webhooks/monday", { method: "POST", body: JSON.stringify({ event: ev }) }), env, ectx);
const fire = async (env: Env, ev: Record<string, unknown>) => { const r = await post(env, ev); await settle(); return r; };

const calls = () => sync.syncMondayItem.mock.calls.map(c => ({
  selfOrigin: c[6], edit: c[7] as Record<string, unknown> | undefined, actor: c[8] }));

const saved = { ...uiActorTiming, backoffMs: [...uiActorTiming.backoffMs] };
beforeEach(() => {
  vi.clearAllMocks();
  resetUiActorCache();
  rel.recorded.length = 0;
  waits.length = 0;
  logs = [];
  logReplies = [[UI_ROW_0211]];
  Object.assign(uiActorTiming, { backoffMs: [0, 0], attemptTimeoutMs: 200, settleMs: 0 });
  sync.syncMondayItem.mockImplementation(async () => "ok");
  md.gql.mockImplementation(async (_e: unknown, query: string) => {
    if (!query.includes("activity_logs")) throw new Error(`unexpected query ${query.slice(0, 40)}`);
    const n = logCalls().length - 1;
    const r = logReplies[Math.min(n, logReplies.length - 1)];
    if (r === "hang") return new Promise(() => {});
    if (r instanceof Error) throw r;
    return { boards: [{ activity_logs: r }] };
  });
  md.getUserById.mockResolvedValue({ name: "ask ada", email: "ask@ada.example" });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { Object.assign(uiActorTiming, saved); vi.restoreAllMocks(); });

// ------------------------------------------------------------------------------------------ flag off

describe("flag OFF: byte-identical to today -- every event of ours is an echo, and no query is made", () => {
  it.each([["absent", base], ["\"false\"", { ...base, ASK_ADA_UI_EDITS: "false" }],
    ["\"TRUE\"", { ...base, ASK_ADA_UI_EDITS: "TRUE" }], ["\"1\"", { ...base, ASK_ADA_UI_EDITS: "1" }]])(
    "ASK_ADA_UI_EDITS %s", async (_n, env) => {
      await fire({ ...(env as Env), ENABLE_ACTIVITY_SYNC: "true" } as Env, EV_0211);
      expect(md.gql).not.toHaveBeenCalled();
      expect(calls()).toEqual([{ selfOrigin: true, edit: { cols: [LIFE] }, actor: { id: ASK_ADA, byAutomation: false } }]);
      expect(act.syncMondayTimeline).not.toHaveBeenCalled();             // our echo never rings the doorbell
      expect(logged(/action=ui-actor/)).toBe(false);
      expect(logged(/\[actor\].* actor=integration user=104118038$/)).toBe(true);
    });

  it("a relation edit of ours joins the integration queue, as before", async () => {
    await fire(base, { boardId: Number(CRM_CONTACTS.boardId), pulseId: 5001, type: "update_column_value",
      columnId: "contact_account", userId: Number(ASK_ADA), value: { linkedPulseIds: [{ linkedPulseId: 9 }] },
      previousValue: {} });
    expect(rel.recorded).toEqual(["5001:contact_account:integration"]);
    expect(md.gql).not.toHaveBeenCalled();
  });

  it("the classifier itself is the old inline expression, call for call", async () => {
    expect(await classifyMondayActor(base, CRM_CONTACTS, EV_0211)).toBe("integration");
    expect(await classifyMondayActor(base, CRM_CONTACTS, { ...EV_0211, userId: PERSON })).toBe("person");
    expect(await classifyMondayActor(base, CRM_CONTACTS, { ...EV_0211, userId: -4 })).toBe("automation");
    expect(await classifyMondayActor(base, CRM_CONTACTS, { ...EV_0211, userId: undefined })).toBe("integration");
    expect(await isOwnEcho(base, CRM_CONTACTS, EV_0211)).toBe(true);
    expect(md.gql).not.toHaveBeenCalled();
  });

  it("ships OFF in wrangler.jsonc", () => {
    expect(((readWranglerConfig().vars ?? {}) as Record<string, string>).ASK_ADA_UI_EDITS).toBe("false");
  });
});

// ------------------------------------------------------------------------------------------ flag on

describe("flag ON: a UI row makes our token user's edit a PERSON's", () => {
  it("the 02:11:42Z Lifecycle Stage change (UI row) reaches the sync as a person's edit -> it pushes", async () => {
    await fire(ON_BELL, EV_0211);
    expect(calls()).toEqual([{ selfOrigin: false, edit: { cols: [LIFE] }, actor: { id: ASK_ADA, byAutomation: false } }]);
    expect(logged(/action=ui-actor class=person reason="the log row of this change carries an action_record_uuid \(a monday UI action\); 0\.0 s from the event"/)).toBe(true);
    expect(logged(/action=self-origin/)).toBe(false);
    // The actor label says who it was, and the doorbell rings like any person's edit.
    expect(logged(/\[actor\].* actor=person user=104118038 who="ask ada \(UI\)"/)).toBe(true);
    expect(act.syncMondayTimeline).toHaveBeenCalledWith(ON_BELL, ITEM);
    // ONE lookup for the doorbell, the label and the self-origin gate together.
    expect(logCalls()).toHaveLength(1);
    const vars = logCalls()[0][2] as Record<string, unknown>;
    expect(vars).toMatchObject({ b: [CRM_CONTACTS.boardId], i: [ITEM], u: [ASK_ADA], c: [LIFE] });
    expect(vars.f).toBe("2026-10-01T02:09:42.300Z");                     // 120 s before changedAt
    expect(vars.t).toBe("2026-10-01T02:12:12.300Z");                     // 30 s after
  });

  it("monday gets its 200 before the lookup answers (the route runs inside waitUntil)", async () => {
    let answer!: (v: unknown) => void;
    md.gql.mockImplementationOnce(() => new Promise(r => { answer = r; }));
    const res = await post(ON, EV_0211);
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 0));
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    answer({ boards: [{ activity_logs: [UI_ROW_0211] }] });
    await settle();
    expect(calls()[0].selfOrigin).toBe(false);
  });

  it("the 03:12:50Z change (the Worker's API row) stays our own: no push", async () => {
    logReplies = [[API_ROW_0312, UI_ROW_0211]];
    await fire(ON_BELL, EV_0312);
    expect(calls()).toEqual([{ selfOrigin: true, edit: { cols: [LIFE] }, actor: { id: ASK_ADA, byAutomation: false } }]);
    expect(logged(/action=ui-actor class=integration reason="the log row of this change has no action_record_uuid \(an API write\); 0\.0 s from the event"/)).toBe(true);
    expect(logged(/action=self-origin/)).toBe(true);
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
    expect(logged(/\[actor\].* actor=integration user=104118038$/)).toBe(true);
  });

  it("the log lagged: the row appears on a retry and is still found", async () => {
    logReplies = [[], [UI_ROW_0211]];
    await fire(ON, EV_0211);
    expect(logCalls()).toHaveLength(2);
    expect(calls()[0].selfOrigin).toBe(false);
  });

  it("no matching row after the retries: FAIL CLOSED to our own", async () => {
    logReplies = [[]];
    await fire(ON, EV_0211);
    expect(logCalls()).toHaveLength(1 + uiActorTiming.backoffMs.length);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/class=integration reason="no log row for this change within 2 s of the event after 3 reads; fail closed"/)).toBe(true);
  });

  it("a row for a DIFFERENT change does not match (value or before-value differs)", async () => {
    logReplies = [[UI_ROW_0211]];
    await fire(ON, { ...EV_0211, previousValue: OTHER });                // same value, other before-side
    expect(calls()[0].selfOrigin).toBe(true);
  });

  it("a lookup error is our own -- one query, no retry", async () => {
    logReplies = [new Error("monday 500")];
    await fire(ON, EV_0211);
    expect(logCalls()).toHaveLength(1);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/class=integration reason="lookup failed \(Error: monday 500\); fail closed"/)).toBe(true);
  });

  it("a lookup that never answers times out and is our own", async () => {
    logReplies = ["hang"];
    await fire(ON, EV_0211);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/class=integration reason="lookup failed \(timeout\); fail closed"/)).toBe(true);
  });

  it("an ambiguous log (a UI and an API row for the same change) is our own", async () => {
    const apiTwin = { ...UI_ROW_0211, data: JSON.stringify({ ...JSON.parse(UI_ROW_0211.data), action_record_uuid: null }) };
    logReplies = [[UI_ROW_0211, apiTwin]];
    await fire(ON, EV_0211);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/reason="ambiguous: 1 UI and 1 API row\(s\) of this change within 2 s of the event"/)).toBe(true);
  });

  it("update_name of ours stays our own, and is never looked up", async () => {
    await fire(ON, { boardId: Number(CRM_ACCOUNTS.boardId), pulseId: 777, type: "update_name", userId: Number(ASK_ADA),
      value: { name: "Acme" }, previousValue: { name: "Acme Ltd" } });
    expect(md.gql).not.toHaveBeenCalled();
    expect(calls()).toEqual([{ selfOrigin: true, edit: { cols: [], name: true }, actor: { id: ASK_ADA, byAutomation: false } }]);
  });

  it("a column that cannot push (bookkeeping, one-way) is never looked up", async () => {
    await fire(ON_BELL, evAt({ columnId: CRM_CONTACTS.syncStateCol, value: { value: "x" }, previousValue: null }));
    expect(md.gql).not.toHaveBeenCalled();
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();             // the doorbell asked, and got "ours"
    expect(uiLookupColumns(ON, CRM_CONTACTS).has(CRM_CONTACTS.syncStateCol)).toBe(false);
    expect(uiLookupColumns(ON, CRM_CONTACTS).has(LIFE)).toBe(true);
    expect(uiLookupColumns(ON, CRM_CONTACTS).has("contact_account")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ time pin

describe("flag ON: the verdict comes from THIS event's own log row, pinned to its time", () => {
  // Card 2869494680's live shape (2026-09-30): a person's UI change, then the Worker's stale forward write
  // repeating a transition seconds later. Here the rep works AS ask ada: UI 5->1 at t0, UI 1->5 at t0+40 s,
  // and the Worker's stale forward pass writes 5->1 at t0+44 s -- its own row not readable yet (measured:
  // a row becomes readable 4.0-5.8 s after its created_at).
  const t0 = Date.parse("2026-09-30T02:39:00.000Z");
  const FIVE = label(5, "5.No intention"), ONE = label(1, "1.NEW"), TEN = label(10, "10.Other");
  const at = (ms: number) => String(Math.round(ms * 1e4));                 // monday's 1e-7 s units
  const lifeRow = (ms: number, prev: unknown, val: unknown, uuid: string | null, created: string | null = at(ms)) => ({
    event: "update_column_value", user_id: ASK_ADA, ...(created === null ? {} : { created_at: created }),
    data: JSON.stringify({ pulse_id: Number(ITEM), column_id: LIFE, previous_value: prev, value: val, action_record_uuid: uuid }) });
  const ev = (ms: number, prev: unknown, val: unknown) => evAt({ value: val, previousValue: prev, changedAt: ms / 1000,
    triggerTime: new Date(ms + 400).toISOString() });
  const OLD_UI = [lifeRow(t0 + 40_000, ONE, FIVE, "uuid-2nd-click"), lifeRow(t0, FIVE, ONE, "uuid-1st-click")];

  it("an OLDER UI row of the same change cannot answer for the Worker's stale write: retried, then ours", async () => {
    logReplies = [OLD_UI];
    await fire(ON, ev(t0 + 44_000, FIVE, ONE));
    expect(calls()[0].selfOrigin).toBe(true);                             // nothing pushed as a human edit
    expect(logCalls()).toHaveLength(3);                                   // never a verdict on the old row
    expect(logged(/class=integration reason="no log row for this change within 2 s of the event \(nearest 44\.0 s away\) after 3 reads; fail closed"/)).toBe(true);
  });

  it("...and once the Worker's own (null-uuid) row is readable, that row decides: ours", async () => {
    logReplies = [OLD_UI, [lifeRow(t0 + 44_000, FIVE, ONE, null), ...OLD_UI]];
    await fire(ON, ev(t0 + 44_000, FIVE, ONE));
    expect(logCalls()).toHaveLength(2);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/class=integration reason="the log row of this change has no action_record_uuid \(an API write\); 0\.0 s from the event"/)).toBe(true);
  });

  it("a LATER UI row of the same change (inside the +30 s window), found on a retry, cannot answer either", async () => {
    logReplies = [[], [lifeRow(t0 + 25_000, FIVE, ONE, "uuid-later")]];
    await fire(ON, ev(t0, FIVE, ONE));
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logCalls()).toHaveLength(3);
  });

  it("the event's OWN UI row, found on a retry, is a person's edit -- an older API row of the change is no ambiguity", async () => {
    logReplies = [[lifeRow(t0 - 60_000, FIVE, ONE, null)],
      [lifeRow(t0 + 500, FIVE, ONE, "uuid-own"), lifeRow(t0 - 60_000, FIVE, ONE, null)]];
    await fire(ON, ev(t0, FIVE, ONE));
    expect(logCalls()).toHaveLength(2);
    expect(calls()[0].selfOrigin).toBe(false);
    expect(logged(/class=person reason="the log row of this change carries an action_record_uuid \(a monday UI action\); 0\.5 s from the event"/)).toBe(true);
  });

  it("a row just outside the pin (2.5 s off) is not this event's row", async () => {
    logReplies = [[lifeRow(t0 + 2_500, FIVE, ONE, "uuid")]];
    await fire(ON, ev(t0, FIVE, ONE));
    expect(calls()[0].selfOrigin).toBe(true);
  });

  it("a UI and an API row of the change BOTH within the pin: ambiguous, ours", async () => {
    logReplies = [[lifeRow(t0 + 300, FIVE, ONE, "uuid"), lifeRow(t0 - 900, FIVE, ONE, null)]];
    await fire(ON, ev(t0, FIVE, ONE));
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/reason="ambiguous: 1 UI and 1 API row\(s\) of this change within 2 s of the event"/)).toBe(true);
  });

  it("a row whose created_at cannot be read cannot be pinned, so it never decides", async () => {
    logReplies = [[lifeRow(t0, FIVE, ONE, "uuid", null), lifeRow(t0, FIVE, ONE, "uuid", "not-a-time")]];
    await fire(ON, ev(t0, FIVE, ONE));
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logCalls()).toHaveLength(3);
  });

  it("an event WITHOUT previousValue is never decided on its value alone: ours, and no query", async () => {
    const e: Record<string, unknown> = ev(t0, FIVE, ONE);
    delete e.previousValue;
    logReplies = [[lifeRow(t0, TEN, ONE, "uuid")]];                       // a UI row with ANOTHER before-value
    await fire(ON, e);
    expect(md.gql).not.toHaveBeenCalled();
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/class=integration reason="the event carries no previousValue: its own log row cannot be identified; fail closed" attempts=0/)).toBe(true);
  });

  it("an event with no time of its own (no changedAt, no triggerTime): ours, no query -- and every caller agrees", async () => {
    const relNoTime = { boardId: Number(CRM_CONTACTS.boardId), pulseId: 5001, type: "update_column_value",
      columnId: "contact_account", userId: Number(ASK_ADA), value: { linkedPulseIds: [{ linkedPulseId: 9 }] }, previousValue: {} };
    logReplies = [[], [{ event: "update_column_value", user_id: ASK_ADA, created_at: at(Date.now()),
      data: JSON.stringify({ pulse_id: 5001, column_id: "contact_account", action_record_uuid: "uuid",
        value: { linkedPulseIds: [{ linkedPulseId: 9 }] }, previous_value: { linkedPulseIds: [] } }) }]];
    await fire(ON, relNoTime);
    expect(md.gql).not.toHaveBeenCalled();
    expect(rel.recorded).toEqual(["5001:contact_account:integration"]);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(logged(/reason="the event carries no time to pin its log row to; fail closed" attempts=0/)).toBe(true);
  });

  it("the first read waits until the event's own row can be readable (settleMs)", async () => {
    Object.assign(uiActorTiming, { settleMs: 120 });
    const now = Date.now();
    logReplies = [[lifeRow(now, FIVE, ONE, "uuid")]];
    let firstReadAt = 0;
    md.gql.mockImplementationOnce(async () => { firstReadAt = Date.now(); return { boards: [{ activity_logs: logReplies[0] }] }; });
    await fire(ON, ev(now, FIVE, ONE));
    expect(firstReadAt - now).toBeGreaterThanOrEqual(100);
    expect(logCalls()).toHaveLength(1);                                   // one read, not a burst of early misses
    expect(calls()[0].selfOrigin).toBe(false);
  });

  it("a future-dated event waits no longer than settleMs", async () => {
    Object.assign(uiActorTiming, { settleMs: 50 });
    const future = Date.now() + 3_600_000;
    logReplies = [[lifeRow(future, FIVE, ONE, null)]];
    const s = Date.now();
    await fire(ON, ev(future, FIVE, ONE));
    expect(Date.now() - s).toBeLessThan(1_000);
    expect(calls()[0].selfOrigin).toBe(true);
  });
});

describe("flag ON: everyone else is unaffected", () => {
  it("a real person's edit: no lookup, a person's edit as always", async () => {
    await fire(ON_BELL, { ...EV_0211, userId: Number(PERSON) });
    expect(md.gql).not.toHaveBeenCalled();
    expect(calls()).toEqual([{ selfOrigin: false, edit: { cols: [LIFE] }, actor: { id: PERSON, byAutomation: false } }]);
    expect(act.syncMondayTimeline).toHaveBeenCalledTimes(1);
  });

  it("an automation (-4): no lookup, an automation's edit as always", async () => {
    await fire(ON_BELL, { ...EV_0211, userId: -4 });
    expect(md.gql).not.toHaveBeenCalled();
    expect(calls()).toEqual([{ selfOrigin: false, edit: { cols: [LIFE], byAutomation: true }, actor: { id: "-4", byAutomation: true } }]);
    expect(act.syncMondayTimeline).not.toHaveBeenCalled();
  });

  it("an unattributed event: no lookup, our own (fails closed)", async () => {
    await fire(ON, { ...EV_0211, userId: undefined });
    expect(md.gql).not.toHaveBeenCalled();
    expect(calls()[0].selfOrigin).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ relations

describe("flag ON: a relation edit by our token user in the UI goes to the PERSON queue", () => {
  const relEv = (o: Record<string, unknown> = {}) => ({ boardId: Number(CRM_CONTACTS.boardId), pulseId: 5001,
    type: "update_column_value", columnId: "contact_account", userId: Number(ASK_ADA), changedAt: 1790820702.3,
    value: { linkedPulseIds: [{ linkedPulseId: 9 }] }, previousValue: {}, ...o });
  const relRow = (uuid: string | null) => ({ event: "update_column_value", user_id: ASK_ADA, created_at: "17908207023000000",
    data: JSON.stringify({ pulse_id: 5001, column_id: "contact_account", action_record_uuid: uuid,
      value: { changed_at: "2026-10-01T02:11:42Z", linkedPulseIds: [{ linkedPulseId: 9 }] }, previous_value: { linkedPulseIds: [] } }) });

  it("UI row -> the person queue, with the person's own diff", async () => {
    logReplies = [[relRow("5f0c-uuid")]];
    await fire(ON, relEv());
    expect(rel.recorded).toEqual(["5001:contact_account:person"]);
    const c = calls()[0];
    expect(c.selfOrigin).toBe(false);
    expect(c.edit).toMatchObject({ cols: ["contact_account"], actor: ASK_ADA, linked: { contact_account: ["9"] },
      unlinked: { contact_account: [] } });
  });

  it("API row (our forward write, or monday's reciprocal half of a click) -> the integration queue", async () => {
    logReplies = [[relRow(null)]];
    await fire(ON, relEv());
    expect(rel.recorded).toEqual(["5001:contact_account:integration"]);
    expect(calls()[0].selfOrigin).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ creates

describe("flag ON: create_pulse by our token user", () => {
  const createEv = { boardId: Number(CRM_DEALS.boardId), pulseId: 6001, type: "create_pulse", userId: Number(ASK_ADA),
    pulseName: "New deal", triggerTime: "2026-10-01T04:23:35.105Z" };
  const createRow = (cv: Record<string, unknown>) => ({ event: "create_pulse", user_id: ASK_ADA,
    data: JSON.stringify({ pulse_id: 6001, board_id: Number(CRM_DEALS.boardId), column_values_json: JSON.stringify(cv) }) });
  const card = (hsId: string) => ({ id: "6001", name: "New deal", created_at: "", updated_at: "", group: { id: "g" },
    column_values: [{ id: CRM_DEALS.idCol, text: hsId }] });

  it("UI create (no HubSpot ID column in the row, none on the card) -> a person's create", async () => {
    logReplies = [[createRow({})]];                                     // "{}": the live shape of a UI create
    md.getItem.mockResolvedValue(card(""));
    await fire(ON, createEv);
    expect(calls()).toEqual([{ selfOrigin: false, edit: undefined, actor: { id: ASK_ADA, byAutomation: false } }]);
    expect(logged(/type=create_pulse .*class=person reason="created without a HubSpot ID/)).toBe(true);
    expect(logCalls()[0][2]).not.toHaveProperty("c");                   // no column filter for a create
  });

  it("API create (the row carries the HubSpot ID column) -> our own, no card read", async () => {
    logReplies = [[createRow({ [CRM_DEALS.idCol]: { value: "351753457379" }, deal_stage: { index: 4 } })]];
    await fire(ON, createEv);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(md.getItem).not.toHaveBeenCalled();
  });

  it("a UI-looking row on a card that already carries a HubSpot ID -> our own", async () => {
    logReplies = [[createRow({})]];
    md.getItem.mockResolvedValue(card("351753457379"));
    await fire(ON, createEv);
    expect(calls()[0].selfOrigin).toBe(true);
  });

  it("a create row with no readable column values -> our own, no card read", async () => {
    logReplies = [[{ event: "create_pulse", user_id: ASK_ADA, data: JSON.stringify({ pulse_id: 6001 }) }]];
    md.getItem.mockResolvedValue(card(""));
    await fire(ON, createEv);
    expect(calls()[0].selfOrigin).toBe(true);
    expect(md.getItem).not.toHaveBeenCalled();
  });

  it("no create row -> our own", async () => {
    logReplies = [[]];
    await fire(ON, createEv);
    expect(calls()[0].selfOrigin).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ stage

describe("flag ON + STAGE_COARSE_REVERSE: the coarse Stage edited as ask ada in the UI is a person's", () => {
  const STAGE_ON = { ...ON, STAGE_COARSE_REVERSE: "true" } as unknown as Env;
  const stageEv = { boardId: Number(CRM_DEALS.boardId), pulseId: 7001, type: "update_column_value", columnId: "deal_stage",
    userId: Number(ASK_ADA), changedAt: 1790820702.3, value: label(15, "Discovery"), previousValue: label(4, "New") };
  const stageRow = (uuid: string | null) => ({ event: "update_column_value", user_id: ASK_ADA, created_at: "17908207023000000",
    data: JSON.stringify({ pulse_id: 7001, column_id: "deal_stage", action_record_uuid: uuid,
      value: label(15, "Discovery"), previous_value: label(4, "New") }) });

  it("UI row -> sent, on the shared stage queue", async () => {
    logReplies = [[stageRow("uuid-1")]];
    await fire(STAGE_ON, stageEv);
    expect(calls()).toEqual([{ selfOrigin: false, edit: { cols: ["deal_stage"] }, actor: { id: ASK_ADA, byAutomation: false } }]);
  });

  it("API row -> dropped, exactly as our own echo always was", async () => {
    logReplies = [[stageRow(null)]];
    await fire(STAGE_ON, stageEv);
    expect(sync.syncMondayItem).not.toHaveBeenCalled();
    expect(logged(/action=ignored reason="the coarse Stage, edited by our own token/)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------ timing

/**
 * REVIEW 2026-10-01 (findings 1-3). A lookup takes ~6 s (settleMs) and up to ~18.5 s. Two things must hold
 * while it is in flight:
 *   - it never holds an md:* queue: coalesceLatest re-runs the FIRST event's closure, so a real person's
 *     edit of the same cell arriving during an echo's lookup was folded into the echo's self-origin run and
 *     never pushed (findings 1 and 3, R2-A);
 *   - a relation or stage cell's edits are still RECORDED in arrival order: an ask ada add recorded ~6 s
 *     late was composed after a colleague's later removal of the same card, and pushed last (finding 2,
 *     R2-B), re-creating the link the colleague removed.
 * settleMs is scaled to 150 ms (production 6,000 ms); the shapes are production's.
 */
describe("flag ON: a lookup in flight holds no queue, and a cell's edits are recorded in arrival order", () => {
  const SETTLE = 150;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const at = (ms: number) => String(Math.round(ms * 1e4));
  /** The log row of `ev` itself, as monday records it (created_at = the event's own time). */
  const ownRow = (ev: Record<string, any>, uuid: string | null) => ({ event: "update_column_value", user_id: ASK_ADA,
    created_at: at(ev.changedAt * 1000), data: JSON.stringify({ pulse_id: ev.pulseId, column_id: ev.columnId,
      action_record_uuid: uuid, value: ev.value, previous_value: ev.previousValue }) });
  /** monday's log: every row in `board` is returned on every read (the matcher pins each to its event). */
  let board: unknown[] = [];
  // A failed expectation must not leave its lookups and runs to land in the next test.
  afterEach(async () => { await settle(); });
  beforeEach(() => {
    Object.assign(uiActorTiming, { settleMs: SETTLE });
    board = [];
    md.gql.mockImplementation(async (_e: unknown, q: string) => {
      if (!q.includes("activity_logs")) throw new Error("unexpected monday query");
      return { boards: [{ activity_logs: board }] };
    });
  });
  const now = () => Date.now() / 1000;

  it("finding 1 / R2-A: a REAL person's edit of the cell during our echo's lookup runs as itself, at once", async () => {
    const echo = evAt({ value: OTHER, previousValue: NOT_IN_CONTACT, changedAt: now() });
    board = [ownRow(echo, null)];                                        // the Worker's own API write
    await post(ON, echo);
    await sleep(30);
    await post(ON, { ...echo, userId: Number(PERSON), value: NEW, previousValue: OTHER, changedAt: now() });
    await sleep(0);
    // The person's run did not wait behind our lookup (still settling), and is not ours.
    expect(calls()).toEqual([{ selfOrigin: false, edit: { cols: [LIFE] }, actor: { id: PERSON, byAutomation: false } }]);
    expect(logged(/coalesced-rerun/)).toBe(false);
    await settle();
    expect(calls()).toEqual([
      { selfOrigin: false, edit: { cols: [LIFE] }, actor: { id: PERSON, byAutomation: false } },
      { selfOrigin: true, edit: { cols: [LIFE] }, actor: { id: ASK_ADA, byAutomation: false } }]);
    expect(logCalls()).toHaveLength(1);                                 // the echo's one lookup, nothing for the person
  });

  it("finding 1: a person's edit during our echo's lookup on a PEOPLE column is not folded into it either", async () => {
    // The Owner column shares one md:<item>:<col> queue for every actor, like any plain column.
    const OWNER = CRM_CONTACTS.fields.find(f => f.type === "people" && (f.reverse || f.appReverse))!.col;
    const p = (id: number) => ({ personsAndTeams: [{ id, kind: "person" }] });
    const echo = evAt({ columnId: OWNER, value: p(1), previousValue: p(2), changedAt: now() });
    board = [ownRow(echo, null)];
    await post(ON, echo);
    await sleep(30);
    await post(ON, { ...echo, userId: Number(PERSON), value: p(3), previousValue: p(1), changedAt: now() });
    await settle();
    expect(calls().map(c => [c.selfOrigin, (c.actor as any).id])).toEqual([[false, PERSON], [true, ASK_ADA]]);
    expect(calls()[0].edit).toMatchObject({ cols: [OWNER], removedPeople: { [OWNER]: ["1"] } });
  });

  const REL = "contact_account";
  const linkEv = (userId: string) => ({ boardId: Number(CRM_CONTACTS.boardId), pulseId: 5001, type: "update_column_value",
    columnId: REL, userId: Number(userId), changedAt: now(), value: { linkedPulseIds: [{ linkedPulseId: 9 }] }, previousValue: {} });
  const unlinkEv = (userId: string) => ({ ...linkEv(userId), changedAt: now(), value: {},
    previousValue: { linkedPulseIds: [{ linkedPulseId: 9 }] } });
  const relRuns = () => calls().map(c => `+[${((c.edit?.linked as any)?.[REL] ?? []).join(",")}]`
    + ` -[${((c.edit?.unlinked as any)?.[REL] ?? []).join(",")}]`);

  it("finding 2 / R2-B: an ask ada UI link, then a colleague's unlink of that card: composed in arrival order", async () => {
    const add = linkEv(ASK_ADA);
    board = [ownRow(add, "uuid-ui-link")];
    await post(ON, add);
    await sleep(30);
    const res = await post(ON, unlinkEv(PERSON));
    // monday has its 200 at once, and the unlink waits its turn behind the add still being classified.
    expect(res.status).toBe(200);
    expect(rel.recorded).toEqual([]);
    expect(logged(/col=contact_account user=104231431 action=arrival-order-wait/)).toBe(true);
    await settle();
    expect(rel.recorded).toEqual(["5001:contact_account:person", "5001:contact_account:person"]);
    // The add is never the LAST word on card 9: the removal came after it, so it is sent after it.
    expect(relRuns()).toEqual(["+[9] -[]", "+[] -[9]"]);
  });

  it("finding 2: two ask ada UI edits of one cell, the FIRST one's read slower: still recorded first", async () => {
    Object.assign(uiActorTiming, { settleMs: 0, backoffMs: [120, 0] });
    const add = linkEv(ASK_ADA);
    let reads = 0;
    md.gql.mockImplementation(async () => {
      reads++;                                                          // read 1 (the add's) lags: no row yet
      return { boards: [{ activity_logs: reads === 1 ? [] : board }] };
    });
    board = [ownRow(add, "uuid-ui-link")];
    await post(ON, add);
    await sleep(30);
    const rm = unlinkEv(ASK_ADA);
    board = [ownRow(add, "uuid-ui-link"), ownRow(rm, "uuid-ui-unlink")];
    await post(ON, rm);
    await settle();
    expect(reads).toBe(3);                                              // the add: miss + hit; the unlink: hit
    expect(rel.recorded).toEqual(["5001:contact_account:person", "5001:contact_account:person"]);
    expect(relRuns()).toEqual(["+[9] -[]", "+[] -[9]"]);
  });

  it("a real person's relation edit on a cell with nothing pending is routed before monday's 200, as before", async () => {
    await post(ON, linkEv(PERSON));
    expect(rel.recorded).toEqual(["5001:contact_account:person"]);       // recorded inline, not deferred
    expect(logged(/arrival-order-wait/)).toBe(false);
    await settle();
    expect(md.gql).not.toHaveBeenCalled();
    expect(relRuns()).toEqual(["+[9] -[]"]);
  });

  it("the barrier never holds the SYNC: a cell's next edit is routed while the previous run is still syncing", async () => {
    let release!: () => void;
    sync.syncMondayItem.mockImplementationOnce(() => new Promise(r => { release = () => r("ok"); }));
    await post(ON, linkEv(PERSON));
    await sleep(0);
    expect(sync.syncMondayItem).toHaveBeenCalledTimes(1);                // first run in flight, not finished
    await post(ON, unlinkEv(PERSON));
    expect(rel.recorded).toHaveLength(2);                                // routed inline, recorded at once
    expect(logged(/arrival-order-wait/)).toBe(false);
    release();
    await settle();
    expect(relRuns()).toEqual(["+[9] -[]", "+[] -[9]"]);
  });

  const STAGE_ON = { ...ON, STAGE_COARSE_REVERSE: "true" } as unknown as Env;
  const EXACT = "dropdown_mm7624zd";                                    // Deals exact "Deal Stage" (reverse)
  const coarseEv = (userId: string) => ({ boardId: Number(CRM_DEALS.boardId), pulseId: 7001, type: "update_column_value",
    columnId: "deal_stage", userId: Number(userId), changedAt: now(), value: label(15, "Discovery"), previousValue: label(4, "New") });
  const exactEv = (userId: string) => ({ ...coarseEv(userId), columnId: EXACT, changedAt: now(),
    value: { chosenValues: [{ id: 7, name: "Proposal" }] }, previousValue: { chosenValues: [{ id: 3, name: "Discovery" }] } });

  it("finding 2 (stage): an ask ada UI coarse Stage edit, then a person's exact stage edit: sent in that order", async () => {
    const c = coarseEv(ASK_ADA);
    board = [ownRow(c, "uuid-ui-stage")];
    await post(STAGE_ON, c);
    await sleep(30);
    await post(STAGE_ON, exactEv(PERSON));
    await settle();
    // Each run sends the stage columns drained in it; the exact stage, edited last, is sent last.
    expect(calls().flatMap(x => (x.edit?.cols as string[]) ?? [])).toEqual(["deal_stage", EXACT]);
    expect(calls().every(x => x.selfOrigin === false)).toBe(true);
  });

  it("stage: our own echo of the coarse Stage (dropped) delays a person's exact edit behind it -- never drops it", async () => {
    const c = coarseEv(ASK_ADA);
    board = [ownRow(c, null)];
    await post(STAGE_ON, c);
    await sleep(30);
    await post(STAGE_ON, exactEv(PERSON));
    await settle();
    expect(logged(/action=ignored reason="the coarse Stage, edited by our own token/)).toBe(true);
    expect(calls()).toEqual([{ selfOrigin: false, edit: { cols: [EXACT] }, actor: { id: PERSON, byAutomation: false } }]);
  });

  it("flag OFF: none of this -- no barrier, no lookup, every event routed inline as before", async () => {
    await post(base, linkEv(ASK_ADA));
    await post(base, unlinkEv(PERSON));
    expect(rel.recorded).toEqual(["5001:contact_account:integration", "5001:contact_account:person"]);
    await settle();
    expect(md.gql).not.toHaveBeenCalled();
    expect(logged(/arrival-order-wait/)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ the matcher

describe("valueFingerprint: the webhook's copy and the log's copy of one change compare equal", () => {
  it.each([
    ["status", { label: { index: 6, text: "6.x", style: { color: "#1" }, is_done: false }, post_id: null },
      { post_id: null, label: { is_done: true, index: 6, style: { color: "#2" }, text: "6.x" } }],
    ["people", { personsAndTeams: [{ id: 2, kind: "person" }, { id: 1, kind: "person" }], changed_at: "a" },
      { personsAndTeams: [{ kind: "person", id: 1 }, { kind: "person", id: 2 }] }],
    ["relation", { linkedPulseIds: [{ linkedPulseId: 9 }] }, { changed_at: "b", linkedPulseIds: [{ linkedPulseId: 9 }] }],
    ["dropdown", { chosenValues: [{ id: 2, name: "Sales Pipeline" }] }, { chosenValues: [{ name: "Sales Pipeline", id: 2 }] }],
    ["date", { date: "2026-10-01", icon: null, time: null }, { date: "2026-10-01", icon: null, changed_at: "c", time: null }],
    ["text", { value: "abc" }, { value: "abc" }],
    ["numbers", { value: "15500", unit: null }, { unit: null, value: 15500 }],
    ["phone", { phone: "91982", countryShortName: "IN", changed_at: "d" }, { countryShortName: "", phone: "91982" }],
    ["link", { url: "https://x", text: "x" }, { changed_at: "e", text: "x", url: "https://x" }],
    ["long text", { text: "hello", changed_at: "f" }, { changed_at: "g", text: "hello" }],
    ["JSON string", JSON.stringify({ value: "abc" }), { value: "abc" }],
  ])("%s", (_n, webhook, log) => {
    expect(valueFingerprint(webhook)).toBe(valueFingerprint(log));
    expect(valueFingerprint(webhook)).not.toBe("∅");
  });

  it("every empty shape reads the same", () => {
    for (const v of [null, undefined, "", "null", {}, { changed_at: "x" }, { linkedPulseIds: [] }, { personsAndTeams: [] },
      { chosenValues: [] }, { value: "" }, { label: null }, { date: null }])
      expect(valueFingerprint(v)).toBe("∅");
  });

  it("different values differ", () => {
    expect(valueFingerprint(NEW)).not.toBe(valueFingerprint(NOT_IN_CONTACT));
    expect(valueFingerprint({ linkedPulseIds: [{ linkedPulseId: 9 }] })).not.toBe(valueFingerprint({ linkedPulseIds: [{ linkedPulseId: 8 }] }));
  });
});
