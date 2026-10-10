import type { Env, ObjectSpec } from "./types";
import { getItem, getUserById, gql } from "./monday";
import { colText } from "./dedup";
import { actorLabel, isAutomationActor, isIntegrationActor } from "./actor-label";
import { coarseStageField } from "./reconcile";
import type { ActorClass } from "./relation-edit";

/**
 * ASK_ADA_UI_EDITS: WHICH OF OUR OWN TOKEN USER'S EVENTS WERE A PERSON AT THE KEYBOARD.
 *
 * THE PROBLEM. The Worker's monday token is the shared user 104118038 "ask ada", and people log into
 * monday as ask ada too. Every event carrying the token's own user id is read as the Worker's echo
 * (isIntegrationActor), so suppressSelfOriginWrites refuses every HubSpot push and record creation for
 * them: a rep editing as ask ada edits monday only, silently. A new monday account was ruled out.
 *
 * THE DISCRIMINATOR, measured read-only over 7 days on the CRM boards (2026-09-24..10-01). In monday's
 * own activity log (boards{activity_logs}), an `update_column_value` row carries `action_record_uuid`
 * in its data JSON: non-null for an action taken in the monday UI, null for EVERY API write -- the
 * Worker's, and any script using the same token. Automations (-4/-6) and the reciprocal half of a
 * Connect Boards link are null too, and a workflow acts under its OWNER's id, also null. The webhook
 * itself carries nothing that tells the two apart, so the log is read for exactly the one event.
 *   Live example, card 2866357137 (Lena Example), Lifecycle Stage color_mm70k2wk, both as 104118038:
 *   02:11:42Z "1.NEW -> 6.Not in contact" uuid a671fcec-... (a person, as ask ada);
 *   03:12:50Z "6 -> 10.Other" uuid null (the Worker's forward write).
 *
 * WHAT IS LOOKED UP, AND NOTHING ELSE. Only an event (1) on a CRM spec that suppresses self-origin
 * writes and reverses by column, (2) whose user is our token's own (isIntegrationActor -- a person's
 * own id never costs a query), and (3) of one of two kinds:
 *   - `update_column_value` on a TWO-WAY column: a reverse/appReverse field, a Connect Boards relation,
 *     or the native coarse Stage while STAGE_COARSE_REVERSE is on. A one-way or bookkeeping column
 *     could not push anything whoever edited it, so it is never worth a query (most of those events are
 *     dropped before classification anyway: ignoredColumns in webhooks.ts);
 *   - `create_pulse`: rows of that event have NO action_record_uuid key for any actor. What separates
 *     them, measured on the same 7 days: every card the Worker created carried the board's HubSpot ID
 *     column (spec.idCol) in the row's column_values_json -- buildColumnValues stamps it on every
 *     create -- and no UI create did. So a create is a person's only when that column is absent from the
 *     row AND the card's HubSpot ID cell is still empty when read.
 * `update_name` stays OUR OWN: its rows have no action_record_uuid either, and nothing else in them
 * separates a rename in the UI from the Worker's rename of a card to its record's name. A rename by a
 * person logged in as ask ada still does not reach HubSpot.
 *
 * MATCHING: THIS EVENT'S OWN ROW, AND NO OTHER. The log is read for that board + item + column + user,
 * from 120 s before the event's own time (changedAt, else triggerTime) to 30 s after it, at most 25
 * rows. A row is the event's own only when ALL of these hold:
 *   - its value AND its previous value have the event's fingerprints (valueFingerprint: the label
 *     index, the people, the linked cards, the date..., never styles or changed_at);
 *   - its created_at (monday's 1e-7 s units) is within uiActorTiming.pinMs (2 s) of the event's time.
 *     Live: the Worker's 03:12:50Z write above has created_at 03:12:50.7164, and on the same card the
 *     cell's own changed_at sat 0.43 s before its row's created_at. monday's documented webhook
 *     payload gives changedAt to 1e-7 s, created_at's unit. (A real webhook's changedAt could not be
 *     compared read-only; an offset beyond the pin makes the event "not found", i.e. ours.)
 * Why the pin. The same change recurs: 8 Worker writes on Contacts Lifecycle Stage in 7 days repeated a
 * person's exact UI change 5-13 s later (stale forward passes; card 2869494680 on 2026-09-30: UI 1->5,
 * then the Worker 5->1 and 1->5 within 5.4 s), and a rep toggled Lena Example 6->10->6->5->6 in 84 s.
 * Matching on value alone across the window let an OLDER (or later) UI row answer for the Worker's own
 * write while that write's row was not yet readable -- and the stale value it wrote would then have been
 * pushed to HubSpot under a human-edit claim (columnEditPatch sends the card's value), overwriting the
 * rep's final one. A row that is not this event's never decides: no row within the pin is "not found
 * yet" (retry), never a verdict.
 * Several rows within the pin: all UI -> a person; all API -> ours; a MIX stays ours. (Not "the nearest
 * decides": the offset between a webhook's changedAt and its own row's created_at is not measurable
 * read-only, so the nearer twin is not provably the event's own, and failing closed costs at most a push
 * today's code never made.)
 * An event without previousValue is never looked up (ours): its value alone cannot single out its row.
 * An event with no time of its own (neither changedAt nor triggerTime) is never looked up either: there
 * is nothing to pin to, and "now" would give each caller its own lookup and, possibly, its own answer.
 *
 * WHEN IT IS READ. A row becomes readable 4.0-5.8 s after its created_at (measured by polling, 177 polls).
 * So the first read waits until uiActorTiming.settleMs (6 s) after the event's time -- by then the
 * event's own row, and any twin of it within the pin, is normally readable -- rather than spend reads
 * that cannot see it; two retries (+1 s, +2.5 s) cover a slower log. A future-dated event waits at most
 * settleMs.
 *
 * FAILS CLOSED -- to today's behaviour, "our own" -- on every uncertain path: no row of this event after
 * the retries, a query error or timeout, an unreadable row (created_at included) or card, no
 * previousValue, no event time. Refusing costs the rep the push they would not have had before this
 * change; wrongly classifying our own write as a person's would push the Worker's forward write back
 * into HubSpot as a human edit.
 *
 * NO ECHO LOOP. What a person's push leads to -- HubSpot's webhook, the forward pass, a heal, a Sync
 * State stamp -- is written through the API, so its rows carry no UUID and every one of those events
 * stays our own.
 *
 * COST. One small activity_logs query per eligible event of ours -- one, normally, because the first read
 * waits for the log to settle (plus up to two retries when the row is still not there). Each such event
 * waits ~6 s from its changedAt before it is classified (inside waitUntil; monday has its 200 at once);
 * at worst, with every read slow and missing, ~18.5 s (6 + 3 reads of <=3 s + 1 + 2.5). That wait is
 * spent BEFORE the event is recorded or joins any md:* queue (routeAskAdaAware in webhooks.ts). Inside
 * the queue it held the cell for its length, and a real person's edit arriving meanwhile was re-run as
 * our echo's self-origin closure. A relation or stage cell's events are still recorded in arrival
 * order: a later edit of that cell waits for this one's verdict (the edit is delayed, never dropped).
 * Measured from the log, 2026-09-24..10-01, 7-day average: ~1,940 API writes/day
 * of ours on two-way columns (Accounts 422, Contacts 174, Deals 625, Products & Services 715; +6/day on
 * the coarse Stage with STAGE_COARSE_REVERSE) and ~10 creates/day -- versus ~5,700/day on every column,
 * most of them Sync State, which is never looked up. One query: 20 complexity points, ~0.9 s live.
 * Verdicts are cached per event, so the doorbell, the relation/stage class, the self-origin gate, the
 * actor label and a coalesced re-run all share ONE lookup.
 *
 * "false" (or anything but the literal "true", or absent) = none of this runs: no query, no log line,
 * and every caller gets exactly the answer isIntegrationActor gave before.
 */
export function askAdaUiEditsOn(env: Env): boolean {
  return env.ASK_ADA_UI_EDITS === "true";
}

/** Lookup timing. Mutable only so tests need not wait out the real backoff. */
export const uiActorTiming = {
  beforeMs: 120_000,
  afterMs: 30_000,
  limit: 25,
  /** A row is this event's own only when its created_at is within this of the event's time. */
  pinMs: 2_000,
  /** The first read waits until this long after the event's time (rows become readable 4.0-5.8 s on). */
  settleMs: 6_000,
  /** Waits between attempts when this event's row is not found yet: two retries, then fail closed. */
  backoffMs: [1_000, 2_500],
  /** Per query. A query that has not answered by then counts as an error (-> our own). */
  attemptTimeoutMs: 3_000,
};

type Verdict = { ui: boolean; reason: string };
const NOT_UI: Verdict = { ui: false, reason: "no lookup" };

/** What kind of lookup an event needs, or null when it gets none (and stays our own). */
type Kind = "column" | "create";

function isColumnEvent(type: string): boolean {
  return type === "update_column_value" || type === "change_column_value";
}

/** The two-way columns of a spec: the only ones whose events of ours are worth a log query. */
export function uiLookupColumns(env: Env, spec: ObjectSpec): Set<string> {
  const ignored = new Set([spec.syncStateCol, spec.idCol, spec.linkCol].filter(Boolean) as string[]);
  const out = new Set<string>();
  // A hubspotOnly column too: an edit of it by a person logged in as our token user must be put back, and
  // only this lookup can tell that edit from our own echo (which a forward-only pass rightly leaves alone).
  for (const f of spec.fields) if (!f.oneWay && (f.reverse || f.appReverse || f.hubspotOnly)) out.add(f.col);
  for (const a of spec.associations ?? []) if (a.relationCol) out.add(a.relationCol);
  // The native coarse Stage is `oneWay` in the spec; it is two-way only while STAGE_COARSE_REVERSE is on
  // (coarseStageCols in webhooks.ts, the same literal "true" test).
  if (env.STAGE_COARSE_REVERSE === "true") { const c = coarseStageField(spec); if (c) out.add(c.col); }
  for (const c of ignored) out.delete(c);
  return out;
}

function kindOf(env: Env, spec: ObjectSpec | undefined, ev: any): Kind | null {
  if (!spec || !spec.suppressSelfOriginWrites || !spec.columnLevelReverse) return null;
  const type = String(ev?.type ?? "");
  if (type === "create_pulse" || type === "create_item") return "create";
  // update_name / change_name: deliberately nothing (see the header). A rename of ours stays our own.
  const col = ev?.columnId ? String(ev.columnId) : "";
  if (col && isColumnEvent(type) && uiLookupColumns(env, spec).has(col)) return "column";
  return null;
}

/**
 * A monday column value reduced to what the change WAS, so the webhook's copy and the activity log's
 * copy of one change compare equal: styles, `changed_at`, `post_id` and key order are dropped, and every
 * empty shape (null, "", {}, {changed_at}, [] lists) reads the same. Shapes as recorded live on the CRM
 * boards, 2026-09-30/10-01: status {label:{index,text,style}}, people {personsAndTeams}, relation
 * {linkedPulseIds}, dropdown {chosenValues}, date {date,time}, phone, email, link {url,text}, long text
 * {text}, text / numbers {value}.
 */
export function valueFingerprint(v: unknown): string {
  let o: any = v;
  if (typeof o === "string") {
    const s = o.trim();
    if (!s || s === "null") return "∅";
    try { o = JSON.parse(s); } catch { return `S:${s}`; }
  }
  if (o === null || o === undefined) return "∅";
  if (typeof o !== "object") return `S:${String(o)}`;
  const list = (a: unknown, f: (x: any) => string) =>
    Array.isArray(a) ? a.map(f).filter(Boolean).sort().join(",") : canon(a);
  let body: string;
  if ("label" in o) {
    const l = o.label;
    body = l == null ? "" : l.index !== null && l.index !== undefined ? `L:${l.index}` : l.text ? `LT:${l.text}` : "";
  }
  else if ("personsAndTeams" in o) body = list(o.personsAndTeams, p => p?.id == null ? "" : `${p.kind ?? "person"}:${p.id}`);
  else if ("linkedPulseIds" in o) body = list(o.linkedPulseIds, x => String(x?.linkedPulseId ?? ""));
  else if ("chosenValues" in o) body = list(o.chosenValues, x => String(x?.id ?? x?.name ?? ""));
  else if ("date" in o) body = o.date ? `D:${o.date}|${o.time ?? ""}` : "";
  else if ("phone" in o) body = o.phone ? `P:${o.phone}` : "";
  else if ("email" in o) body = o.email ? `E:${o.email}` : "";
  else if ("url" in o) body = o.url ? `U:${o.url}` : "";
  else if ("checked" in o) body = `C:${String(o.checked)}`;
  else if ("text" in o) body = o.text ? `T:${o.text}` : "";
  else if ("value" in o) body = o.value === null || o.value === undefined || o.value === "" ? "" : `V:${String(o.value)}`;
  else {
    const { changed_at: _c, ...rest } = o;
    body = Object.keys(rest).length ? canon(rest) : "";
  }
  return body || "∅";
}

/**
 * A card's RAW column value (items { column_values { value } }) fingerprinted as the webhook / activity log would show
 * the same value: monday's column-value JSON spells some types differently from its events -- a status as
 * {index, changed_at} (events: {label:{index}}), a text or numbers cell as a bare JSON string (events: {value}), a
 * dropdown as {ids} (events: {chosenValues}). Anything else goes to valueFingerprint as it is. A shape this does not
 * know simply never matches an event's -- the safe direction for its one reader (the converge's rescue).
 */
export function cardValueFingerprint(raw: unknown): string {
  let o: any = raw;
  if (typeof o === "string") {
    const s = o.trim();
    if (!s || s === "null") return "∅";
    try { o = JSON.parse(s); } catch { return valueFingerprint({ value: s }); }
  }
  if (typeof o === "string" || typeof o === "number") return valueFingerprint({ value: o });
  if (o && typeof o === "object" && !Array.isArray(o)) {
    if (!("label" in o) && typeof o.index === "number") return valueFingerprint({ label: { index: o.index } });
    if (!("chosenValues" in o) && Array.isArray(o.ids)) return valueFingerprint({ chosenValues: o.ids.map((id: unknown) => ({ id })) });
  }
  return valueFingerprint(o);
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().map(k => `${k}:${canon((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** The event's own time in ms: changedAt (epoch seconds, fractional), else triggerTime, else null --
 *  never "now": a row pinned to the clock is pinned to nothing, and each caller would get its own key. */
export function eventMs(ev: any): number | null {
  const c = Number(ev?.changedAt);
  if (Number.isFinite(c) && c > 1e9) return c > 1e12 ? c : c * 1000;
  const t = Date.parse(String(ev?.triggerTime ?? ""));
  return Number.isFinite(t) ? t : null;
}

/** `atMs`: the row's created_at in ms (monday gives 1e-7 s units); NaN when unreadable -- never pinned. */
interface LogRow { event: string; user_id: string; atMs: number; data: any }

function hasUuid(d: any): boolean {
  return typeof d?.action_record_uuid === "string" && d.action_record_uuid.trim() !== "";
}

class LookupTimeout extends Error {}

/** `p`, or a LookupTimeout after uiActorTiming.attemptTimeoutMs (or `ms`). A read inside a webhook's waitUntil
 *  must never sit through gql's own retries and rate-limit waits. */
async function withTimeout<T>(p: Promise<T>, ms = uiActorTiming.attemptTimeoutMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new LookupTimeout("timeout")), ms);
  });
  try { return await Promise.race([p, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function readLog(env: Env, boardId: string, itemId: string, userId: string, at: number,
    columnId?: string): Promise<LogRow[]> {
  const t = uiActorTiming;
  const query = `query ($b:[ID!], $i:[ID!], $u:[ID!], $f:ISO8601DateTime, $t:ISO8601DateTime${columnId ? ", $c:[String]" : ""}) {
    boards(ids:$b) { activity_logs(item_ids:$i, user_ids:$u, from:$f, to:$t, limit:${t.limit}${columnId ? ", column_ids:$c" : ""}) {
      event user_id created_at data } } }`;
  const vars: Record<string, unknown> = {
    b: [boardId], i: [itemId], u: [userId],
    f: new Date(at - t.beforeMs).toISOString(), t: new Date(at + t.afterMs).toISOString(),
    ...(columnId ? { c: [columnId] } : {}),
  };
  // One attempt, no rate-limit waits: a 65 s wait inside a webhook's waitUntil would outlive it. A
  // refused or slow query is an error, and an error is our own (fail closed).
  const d = await withTimeout(gql(env, query, vars, 1, 0));
  const board = d?.boards?.[0];
  if (!board) throw new Error("board not readable");
  const out: LogRow[] = [];
  for (const r of board.activity_logs ?? []) {
    let data: any = r?.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { continue; } }
    // created_at arrives as a numeric string of 1e-7 s; anything else (absent, an ISO date...) is NaN.
    const raw = String(r?.created_at ?? "").trim();
    const atMs = /^\d+$/.test(raw) ? Number(raw) / 1e4 : NaN;
    if (data && typeof data === "object")
      out.push({ event: String(r.event ?? ""), user_id: String(r.user_id ?? ""), atMs, data });
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** This event's row is not among the rows read yet: retry, and on the last read fail closed with `miss`. */
type Miss = { miss: string };
/** One decision from the rows read so far -- a verdict, or a Miss. */
type Decide = (rows: LogRow[]) => Promise<Verdict | Miss>;

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The event's OWN row decides, and only it: same item, column, user, value AND previous value, AND a
 * created_at within uiActorTiming.pinMs of the event's time `at`. A same-change row further off is
 * another change (a person's earlier click, our stale re-write of it) and only shows in the Miss, as a
 * diagnostic. Callers guarantee the event carries previousValue and a time (lookup()).
 */
function columnDecider(ev: any, itemId: string, userId: string, at: number): Decide {
  const col = String(ev.columnId);
  const want = valueFingerprint(ev.value);
  const wantPrev = valueFingerprint(ev.previousValue);
  const pin = uiActorTiming.pinMs;
  const within = `within ${pin / 1000} s of the event`;
  return async rows => {
    const same = rows.filter(r => r.event === "update_column_value" && r.user_id === userId
      && String(r.data.pulse_id ?? "") === itemId && String(r.data.column_id ?? "") === col
      && valueFingerprint(r.data.value) === want && valueFingerprint(r.data.previous_value) === wantPrev);
    const off = (r: LogRow) => Math.abs(r.atMs - at);          // NaN for an unreadable created_at
    const own = same.filter(r => off(r) <= pin);                // ...and NaN <= pin is false: never pinned
    if (!own.length) {
      const nearest = same.map(off).filter(Number.isFinite).sort((a, b) => a - b)[0];
      return { miss: `no log row for this change ${within}${nearest === undefined ? "" : ` (nearest ${secs(nearest)} away)`}` };
    }
    const ui = own.filter(h => hasUuid(h.data)).length;
    if (ui && ui < own.length)
      return { ui: false, reason: `ambiguous: ${ui} UI and ${own.length - ui} API row(s) of this change ${within}` };
    const d = secs(Math.min(...own.map(off)));
    return ui ? { ui: true, reason: `the log row of this change carries an action_record_uuid (a monday UI action); ${d} from the event` }
      : { ui: false, reason: `the log row of this change has no action_record_uuid (an API write); ${d} from the event` };
  };
}

/**
 * A card is created once, so its create_pulse row is identified by the card alone and is not pinned to
 * the event's time (the window only bounds the read).
 */
function createDecider(env: Env, spec: ObjectSpec, itemId: string, userId: string): Decide {
  return async rows => {
    const hits = rows.filter(r => r.event === "create_pulse" && r.user_id === userId
      && String(r.data.pulse_id ?? "") === itemId);
    if (!hits.length) return { miss: "no create_pulse row for this card" };
    // Measured 2026-09-24..10-01: always a JSON STRING -- "{}" for a UI create, the stamped columns
    // (idCol first) for an API create. Anything else is unreadable, and unreadable is our own.
    let cv: any = hits[0].data.column_values_json;
    if (typeof cv === "string") { try { cv = JSON.parse(cv); } catch { cv = undefined; } }
    if (!cv || typeof cv !== "object" || Array.isArray(cv))
      return { ui: false, reason: "the create row carries no readable column values" };
    if (Object.prototype.hasOwnProperty.call(cv, spec.idCol))
      return { ui: false, reason: "created carrying the HubSpot ID column (an API create)" };
    const item = await withTimeout(getItem(env, itemId));
    if (!item) return { ui: false, reason: "the card could not be read" };
    if (colText(item, spec.idCol)) return { ui: false, reason: "the card already carries a HubSpot ID" };
    return { ui: true, reason: "created without a HubSpot ID and the card still has none (a monday UI create)" };
  };
}

// Per event: the doorbell, the stage/relation class, the self-origin gate, the label and a coalesced
// re-run of one event all ask, and must get one lookup and one answer. Bounded and short-lived.
const verdicts = new Map<string, { at: number; p: Promise<Verdict> }>();
const VERDICT_TTL_MS = 10 * 60_000;
const VERDICT_MAX = 1_000;

function cacheKey(spec: ObjectSpec, ev: any, kind: Kind): string {
  const item = String(ev?.pulseId ?? ev?.itemId ?? "");
  const user = String(ev?.userId ?? "");
  const at = eventMs(ev) ?? "-";
  if (kind !== "column") return `${spec.boardId}|${item}|${kind}|${user}|${at}`;
  return `${spec.boardId}|${item}|${String(ev.columnId)}|${user}|${at}|${valueFingerprint(ev.value)}`
    + `|${"previousValue" in ev ? valueFingerprint(ev.previousValue) : "-"}`;
}

/** Test seam: forget every cached verdict. */
export function resetUiActorCache(): void { verdicts.clear(); }

async function lookup(env: Env, spec: ObjectSpec, ev: any, kind: Kind): Promise<Verdict> {
  const boardId = spec.boardId;
  const itemId = String(ev?.pulseId ?? ev?.itemId ?? "");
  const userId = String(ev?.userId ?? "");
  const col = kind === "column" ? String(ev.columnId) : "";
  const started = Date.now();
  const say = (v: Verdict, attempts: number) => {
    console.log(`[ui-actor] source=monday board=${boardId} item=${itemId} col=${col || "-"} type=${String(ev?.type ?? "")}`
      + ` user=${userId} action=ui-actor class=${v.ui ? "person" : "integration"} reason="${v.reason}"`
      + ` attempts=${attempts} ms=${Date.now() - started}`);
    return v;
  };
  if (!itemId || !/^\d+$/.test(itemId)) return say({ ui: false, reason: "no item id on the event" }, 0);
  const anchor = eventMs(ev);
  if (kind === "column") {
    // Nothing to single out THIS event's row by: never looked up (see MATCHING in the header).
    if (!("previousValue" in (ev ?? {})))
      return say({ ui: false, reason: "the event carries no previousValue: its own log row cannot be identified; fail closed" }, 0);
    if (anchor === null) return say({ ui: false, reason: "the event carries no time to pin its log row to; fail closed" }, 0);
  }
  const at = anchor ?? Date.now();                              // a create without a time: the window only
  const decide = kind === "column" ? columnDecider(ev, itemId, userId, at) : createDecider(env, spec, itemId, userId);
  // Do not read before the event's own row can be readable (WHEN IT IS READ). Capped at settleMs, so a
  // future-dated event cannot hold the run.
  const settle = uiActorTiming.settleMs;
  if (anchor !== null && settle > 0) {
    const wait = Math.min(settle, Math.max(0, anchor + settle - Date.now()));
    if (wait > 0) await sleep(wait);
  }
  const waits = uiActorTiming.backoffMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const v = await decide(await readLog(env, boardId, itemId, userId, at, col || undefined));
      if (!("miss" in v)) return say(v, attempt);
      if (attempt > waits.length) return say({ ui: false, reason: `${v.miss} after ${attempt} reads; fail closed` }, attempt);
    } catch (e) {
      return say({ ui: false, reason: `lookup failed (${e instanceof LookupTimeout ? "timeout" : String(e).slice(0, 100)}); fail closed` }, attempt);
    }
    await sleep(waits[attempt - 1]);
  }
}

/** The cached UI verdict for an event of OUR token user. Callers have already established the user. */
async function uiVerdict(env: Env, spec: ObjectSpec | undefined, ev: any): Promise<Verdict> {
  if (!askAdaUiEditsOn(env)) return NOT_UI;
  const id = String(ev?.userId ?? "");
  if (!id || isAutomationActor(id)) return NOT_UI;
  const kind = kindOf(env, spec, ev);
  if (!kind || !spec) return NOT_UI;
  const key = cacheKey(spec, ev, kind);
  const now = Date.now();
  const hit = verdicts.get(key);
  if (hit && now - hit.at < VERDICT_TTL_MS) return hit.p;
  if (verdicts.size >= VERDICT_MAX)
    for (const [k, v] of verdicts) if (now - v.at >= VERDICT_TTL_MS || verdicts.size >= VERDICT_MAX) verdicts.delete(k);
  // lookup() never throws (every failure is a verdict), but a bug must not escape as a person either.
  const p = lookup(env, spec, ev, kind).catch(e => ({ ui: false, reason: `lookup threw (${String(e).slice(0, 80)})` }));
  verdicts.set(key, { at: now, p });
  return p;
}

/**
 * Will classifying this event read monday's log? True only with the flag on, for our own token user's
 * event of a kind that is looked up. handleMonday (routeAskAdaAware) uses it to answer monday at once
 * and classify inside waitUntil, BEFORE the event joins any queue, rather than hold the webhook's
 * response open for a query and its retries.
 */
export async function uiLookupDue(env: Env, spec: ObjectSpec | undefined, ev: any): Promise<boolean> {
  if (!askAdaUiEditsOn(env)) return false;
  const id = String(ev?.userId ?? "");
  if (!id || isAutomationActor(id)) return false;
  if (!kindOf(env, spec, ev)) return false;
  return isIntegrationActor(env, id);
}

/**
 * Is this event OUR OWN token's echo -- the self-origin answer? isIntegrationActor exactly (including
 * its fail-closed paths), except that, with ASK_ADA_UI_EDITS on, an event the activity log proves was
 * a monday UI action is not. Used where the old code asked isIntegrationActor directly, without the
 * automation check first (the self-origin gate, the person doorbell).
 */
export async function isOwnEcho(env: Env, spec: ObjectSpec | undefined, ev: any): Promise<boolean> {
  if (!(await isIntegrationActor(env, String(ev?.userId ?? "")))) return false;
  return !(await uiVerdict(env, spec, ev)).ui;
}

/**
 * THE ACTOR CLASS of a monday event: "automation" (a negative pseudo-user), "integration" (our own
 * token's echo; also every event that cannot be attributed) or "person". With the flag off this is the
 * expression webhooks.ts used to inline, call for call:
 *   isAutomationActor(id) ? "automation" : await isIntegrationActor(env, id) ? "integration" : "person"
 * With it on, an event of our token user that monday's log proves was a UI action is a "person" -- and
 * then flows exactly like any person's edit (push, human-edit claim basis, the person relation queue).
 */
export async function classifyMondayActor(env: Env, spec: ObjectSpec | undefined, ev: any): Promise<ActorClass> {
  if (isAutomationActor(String(ev?.userId ?? ""))) return "automation";
  return (await isOwnEcho(env, spec, ev)) ? "integration" : "person";
}

/**
 * The monday PERSON ids a People-column event removed: in `previousValue`, not in `value`. null when
 * the event did not carry the before-side, so the caller can tell "removed nobody" from "cannot tell".
 * An emptied cell arrives as null, `{}` or `{changed_at}` -- all read as "no one".
 */
export function removedPersonIds(ev: any): string[] | null {
  if (!ev || typeof ev !== "object" || !("previousValue" in ev)) return null;
  const persons = (v: any): Set<string> | null => {
    if (v === null || v === undefined) return new Set();
    let o: any = v;
    if (typeof o === "string") { try { o = JSON.parse(o); } catch { return null; } }
    if (typeof o !== "object") return null;
    if (!("personsAndTeams" in o)) return new Set();
    if (!Array.isArray(o.personsAndTeams)) return null;
    return new Set(o.personsAndTeams.filter((p: any) => p?.kind === "person").map((p: any) => String(p.id)));
  };
  const before = persons(ev.previousValue), after = persons(ev.value);
  if (!before || !after) return null;
  return [...before].filter(id => !after.has(id));
}

/** The newest change of one cell, as monday's activity log has it (lastCellChanges). */
export interface CellChange {
  atMs: number;
  userId: string;
  /** automation: a negative pseudo-user; integration: our token's API write; person: anyone else, or our token user
   *  in the monday UI (the row carries an action_record_uuid, ASK_ADA_UI_EDITS on). */
  cls: ActorClass;
  /** valueFingerprint of the value the row set. */
  valueFp: string;
  /** A People column's row: the person ids it removed (removedPersonIds over the row's before/after; null when the
   *  row carries no before-side). Absent for any other column. */
  removed?: string[] | null;
}

/** A PATIENT log read's bound: longer than gql's own retries and six rate-limit waits of at most 65 s; it only cuts off a
 *  request that never answers. For a caller inside a Durable Object alarm (15 minutes of wall time), never a webhook. */
export const PATIENT_LOG_TIMEOUT_MS = 8 * 60_000;

/**
 * WHO LAST CHANGED EACH OF THESE CELLS, by monday's activity log (STALE_FORWARD_RETRY's rescue, sync.ts
 * settleCardWatch): one activity_logs query for the card -- every user -- from `fromMs` less 120 s to now, at most 50
 * rows; per column the NEWEST update_column_value row. A column with no row in that window is ABSENT from the answer;
 * one whose newest row cannot be told -- two rows at the same created_at, or one with an unreadable created_at -- has
 * no verdict (null). The whole answer is null when the query fails, times out or a row is unreadable: fail closed,
 * nothing is rescued. The read is one try that never waits on monday's rate limit, bounded at 3 s -- the converge's,
 * which holds its card read meanwhile -- unless `patient` (a mark's retry, sync.ts retryMarkedEdits, before it reads the
 * card): then gql's own retries and rate-limit waits, bounded by PATIENT_LOG_TIMEOUT_MS. A retry runs under the very
 * rate limits that killed the run it recovers, and a read refused at once there only defers it.
 */
export async function lastCellChanges(env: Env, spec: ObjectSpec, itemId: string, cols: string[], fromMs: number,
    o: { patient?: boolean } = {}): Promise<Record<string, CellChange | null> | null> {
  if (!cols.length) return {};
  const query = `query ($b:[ID!], $i:[ID!], $c:[String], $f:ISO8601DateTime, $t:ISO8601DateTime) {
    boards(ids:$b) { activity_logs(item_ids:$i, column_ids:$c, from:$f, to:$t, limit:50) {
      event user_id created_at data } } }`;
  const from = Number.isFinite(fromMs) ? fromMs : Date.now();
  const vars = { b: [spec.boardId], i: [itemId], c: cols,
    f: new Date(from - 120_000).toISOString(), t: new Date(Date.now() + 1_000).toISOString() };
  let d: any;
  try { d = o.patient ? await withTimeout(gql(env, query, vars), PATIENT_LOG_TIMEOUT_MS) : await withTimeout(gql(env, query, vars, 1, 0)); }
  catch (e) {
    console.log(`[ui-actor] source=monday board=${spec.boardId} item=${itemId} action=cell-log-unreadable`
      + ` reason="${e instanceof LookupTimeout ? "timeout" : String(e).slice(0, 100)}"`);
    return null;
  }
  const board = d?.boards?.[0];
  if (!board) return null;
  const want = new Set(cols);
  const newest = new Map<string, { atMs: number; data: any; userId: string; tie: boolean; unreadable: boolean }>();
  for (const r of board.activity_logs ?? []) {
    if (String(r?.event ?? "") !== "update_column_value") continue;
    let data: any = r?.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { return null; } }
    if (!data || typeof data !== "object") return null;
    if (String(data.pulse_id ?? "") !== String(itemId)) continue;
    const col = String(data.column_id ?? "");
    if (!want.has(col)) continue;
    const raw = String(r?.created_at ?? "").trim();
    const atMs = /^\d+$/.test(raw) ? Number(raw) / 1e4 : NaN;
    const cur = newest.get(col);
    if (!Number.isFinite(atMs)) { newest.set(col, { ...(cur ?? { atMs: -Infinity, data, userId: "" }), tie: false, unreadable: true }); continue; }
    if (!cur || atMs > cur.atMs) newest.set(col, { atMs, data, userId: String(r?.user_id ?? ""), tie: false, unreadable: cur?.unreadable ?? false });
    else if (atMs === cur.atMs) cur.tie = true;
  }
  const out: Record<string, CellChange | null> = {};
  const peopleCols = new Set(spec.fields.filter(f => f.type === "people").map(f => f.col));
  for (const col of cols) {
    const n = newest.get(col);
    if (!n) continue;
    if (n.tie || n.unreadable || !Number.isFinite(n.atMs)) { out[col] = null; continue; }
    const cls: ActorClass = isAutomationActor(n.userId) ? "automation"
      : (await isIntegrationActor(env, n.userId)) ? (hasUuid(n.data) && askAdaUiEditsOn(env) ? "person" : "integration")
      : "person";
    const removed = peopleCols.has(col)
      ? { removed: removedPersonIds("previous_value" in n.data ? { previousValue: n.data.previous_value, value: n.data.value }
        : { value: n.data.value }) } : {};
    out[col] = { atMs: n.atMs, userId: n.userId, cls, valueFp: valueFingerprint(n.data.value), ...removed };
  }
  return out;
}

const selfName: { v?: string } = {};

/**
 * actorLabel, except that our token user's UI action reads `actor=person ... who="ask ada (UI)"` (the
 * token user's own name), so a log can tell a person working as ask ada from the sync. Flag off:
 * actorLabel exactly. Never throws.
 */
export async function mondayActorLabel(env: Env, spec: ObjectSpec | undefined, ev: any): Promise<string> {
  const id = String(ev?.userId ?? "");
  const base = await actorLabel(env, id);
  if (!askAdaUiEditsOn(env) || !base.startsWith("actor=integration")) return base;
  try {
    if (!(await uiVerdict(env, spec, ev)).ui) return base;
    if (selfName.v === undefined) selfName.v = (await getUserById(env, id))?.name || "token user";
    return `actor=person user=${id} who="${selfName.v} (UI)"`;
  } catch {
    return `actor=person user=${id} who="token user (UI)"`;
  }
}
