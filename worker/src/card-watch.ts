/**
 * STALE_FORWARD_GATE -- THE PURE HALF: switches, the per-cell verdict, the watch's veto, and the card watch's
 * state machine. No I/O. sync.ts runs the passes, create-idempotency-do.ts keeps the watch (one `held:<board>:<item>`
 * CreateIdempotency instance per card), card-registry.ts carries the RPCs.
 *
 * THE BUG (2026-10-09). A column-level forward pass judged every differing cell by RECORD-level freshness: HubSpot's
 * lastmodifieddate against the card's Sync State. A rep's Note, pushed to HubSpot, bumps the record; that echo's
 * forward pass then read HubSpot as "newer" and wrote HubSpot's OLD Lifecycle over the Lifecycle the rep had just
 * changed, before that edit's own push had landed. The edit was lost on one side or both.
 *
 * THE RULE. HEAD still decides which differences a forward pass looks at ("in play"). Every differing TWO-WAY cell
 * in play is then judged BY ITSELF:
 *   - a cell monday stamps (status, date, people: its value's changed_at, c) -- THE LATER CHANGE WINS: HubSpot's
 *     change of that property (its webhook event, or its history) after c is forwarded; otherwise monday's change
 *     is the later one and the cell is held while it can still be on its way (c + W), then converged;
 *   - a cell monday does not stamp (text, numbers, the item name) -- judged by HubSpot's history of the property:
 *     our own write is never news, a value HubSpot never held is monday's own, and otherwise HubSpot's change since
 *     Sync State (or one the pass's events name) is forwarded;
 *   - NOTHING IS HELD FOREVER: every hold ends (W), and the card's watch converges whatever still differs when it
 *     does, with or without another event. A person's edit still on its way carries a MARK (from its webhook until
 *     its run resolves) that keeps the cell held; with STALE_FORWARD_RETRY a mark whose run died is re-sent.
 * THE TWO PATHS THAT WRITE HUBSPOT OUTSIDE A WEBHOOK (STALE_FORWARD_RETRY: a mark's retry, the converge's log rescue)
 * judge HubSpot's versions by PROVENANCE, not by sourceId alone: our app's sourceId is on every write made with the
 * CRM app's token -- this card's own push, but also an operator's script, the /app clear routes, a duplicate card's
 * push. Only a version this card's own writes explain (PushRec, isThisCardsPush) is not news to them; any other is a
 * change like a person's, and they never send an older value over it. What the card cannot account for is not sent.
 * A retry runs outside the cell's own queue, so it reads both sides again right before it sends and the card back after
 * (sync.ts RetryEdit): a newer edit of the cell is never written over. A rescue reaches back at most RESCUE_LOOKBACK_MS
 * before the watch first held the cell: anything older is history, converged. See sync.ts forwardOnlyGated for the pass.
 */
import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec, PassScope } from "./types";
import type { Diff } from "./reconcile";
import { coarseStageField } from "./reconcile";
import { colText } from "./dedup";
import { domainStem, expectedText, fitItemName, formatValue, linkText, numText, phoneDigits } from "./mapping";

// ------------------------------------------------------------------------------------------ switches

/** THE MASTER SWITCH. Only the literal "true", only on the CRM Worker, only on a column-level spec. Off: HEAD. */
export function staleForwardGateOn(env: { ENABLE_CRM?: string; STALE_FORWARD_GATE?: string }, spec: ObjectSpec): boolean {
  return env.ENABLE_CRM === "true" && env.STALE_FORWARD_GATE === "true" && !!spec.columnLevelReverse;
}

/** The two recoveries that WRITE HubSpot outside a webhook (the mark's retry, the log rescue). Gate on, and its own "true". */
export function staleForwardRetryOn(env: { ENABLE_CRM?: string; STALE_FORWARD_GATE?: string; STALE_FORWARD_RETRY?: string },
    spec: ObjectSpec): boolean {
  return staleForwardGateOn(env, spec) && env.STALE_FORWARD_RETRY === "true";
}

/** The same, for the card's watch, which only ever exists for a column-level spec. */
export function watchRetryOn(env: { ENABLE_CRM?: string; STALE_FORWARD_GATE?: string; STALE_FORWARD_RETRY?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.STALE_FORWARD_GATE === "true" && env.STALE_FORWARD_RETRY === "true";
}

export const HOLD_DEFAULT_S = 180;
export const HOLD_MIN_S = 60;
export const HOLD_MAX_S = 900;

/** W: the longest a person's push is believed to take (STALE_FORWARD_HOLD_S, seconds, clamped). Junk -> default. */
export function holdWindowMs(env: { STALE_FORWARD_HOLD_S?: string }): number {
  const raw = String(env.STALE_FORWARD_HOLD_S ?? "").trim();
  const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const s = Number.isFinite(n) && n > 0 ? Math.min(HOLD_MAX_S, Math.max(HOLD_MIN_S, n)) : HOLD_DEFAULT_S;
  return s * 1000;
}

// ------------------------------------------------------------------------------------------ constants

/** monday's change and HubSpot's change this close together are not ordered by their clocks alone. */
export const TIE_MS = 5_000;
/** A relation cell a person changed this recently is not rewritten from HubSpot's set (their mark may not be in yet). */
export const RELATION_HOLD_MS = 60_000;
/** A person's edit's run is presumed alive this long after its first event reached us. */
export const MARK_LEASE_MS = 60_000;
/** ...and its mark is given up this long after it (STALE_FORWARD_RETRY: after its retries). */
export const MARK_TTL_MS = 600_000;
/** Gaps between a mark's retries, counted after the lease. */
export const RETRY_BACKOFF_MS = [60_000, 120_000, 240_000];
/** The loop breaker: a converge's write of one HubSpot value that monday shows otherwise (it did not take as sent) is
 *  repeated at most once per this long; then the cell is judged, and converged, again. */
export const STUCK_MS = 24 * 60 * 60_000;
/** The watch's memory (the loop breaker's, the given-up marks') lives this long. */
export const WATCH_RETENTION_MS = 24 * 60 * 60_000;
/** A converge already queued is not queued again before this. */
export const CONVERGE_RECHECK_MS = 600_000;
/** An alarm is never set closer than this. */
export const ALARM_MARGIN_MS = 5_000;
/** A suspicious Sync State stamp is read back this long after it. */
export const VERIFY_DELAY_MS = 1_500;
/**
 * How long the register keeps each Sync State stamp written on its card (in the watch's Durable Object STORAGE, so
 * an instance evicted while idle forgets nothing): longer than any stamp-carrying write can take to land, because a
 * newer stamp's note must still be there when an older write's note arrives, or the overtaking goes unseen.
 *   - A write that does not refuse at once (HEAD's own, the edit pass's, the create's write-back, an adoption's) is
 *     held by monday.ts gql through at most six rate-limit waits of at most 65 s, plus its retries' pauses (4.5 s):
 *     6.6 minutes before any request's own time, and at most nine requests.
 *   - Where it can wait that long it runs in a Durable Object alarm (the deferred queue's wave, the watch's own),
 *     which has 15 minutes of wall time; a webhook's work is cut off about 30 s after its response.
 * Sixteen minutes covers both bounds: gql's waits with a minute for each of its requests, and the longest any
 * invocation that writes a stamp can live.
 */
export const STAMP_NOTE_WINDOW_MS = 16 * 60_000;
/** The register keeps at most this many notes (always the newest stamp among them). */
export const STAMP_NOTES_MAX = 64;
/** A converge whose activity-log read failed retries its rescue this long after, at most this many times. */
export const LOG_RETRY_MS = 5 * 60_000;
export const LOG_RETRY_MAX = 3;
/**
 * A CONVERGE THAT KEEPS FAILING (it throws: a value monday never takes, an outage) BACKS OFF instead of being re-queued
 * every CONVERGE_RECHECK_MS for as long as it fails: each re-queue waits as long as its converges have been failing in a
 * row -- never less than CONVERGE_RECHECK_MS, never more than CONVERGE_BACKOFF_MAX_MS -- so the waits double. An outage
 * of minutes or hours is ridden out, cells and all, and the first converge after it heals them (convergeRecheckMs).
 * Only a run of failures that has lasted CONVERGE_GIVE_UP_MS is DEAD-LETTERED -- decided after a run FAILED, never when
 * one begins, so the run that would succeed is always tried: its cells leave the watch with a loud line naming them
 * (reduceFailConverge). A finished converge ends the run of failures; so does a watch left with nothing to converge (no
 * cell, no converge-all), so a later episode starts afresh. Marks are never touched: a person's edit still on its way
 * keeps its own lifecycle.
 */
export const CONVERGE_BACKOFF_MAX_MS = 4 * 60 * 60_000;
export const CONVERGE_GIVE_UP_MS = 24 * 60 * 60_000;
/**
 * THE RESCUE'S HORIZON (STALE_FORWARD_RETRY): a person's edit monday's log proves is rescued only when it was made at
 * most this long before the watch first held that value of its cell (WatchCell.seen; a cell the converge judges without
 * having held it: the converge's own time), and never before CRM_CUTOVER_AT. Anything older is HISTORY, not an edit on
 * its way: a value left on a card from before the gate or the retry existed, a pre-cutover edit, a reassignment weeks
 * old on a dormant record that a passive HubSpot recalculation brought into play. Pushed, it would claim the record,
 * take the card out of No Activity and reassign owners on the strength of an old row -- so such a cell converges to
 * HubSpot instead. An edit misread as our echo is held by its own echo's pass within seconds, one whose webhook monday
 * never delivered by the next pass that sees the card: an hour covers both, with room for a slow queue. Measured from
 * the watch's first sight, not from now, so a converge an outage holds up for hours still rescues an edit it held at once.
 */
export const RESCUE_LOOKBACK_MS = 60 * 60_000;

/**
 * A pass's events older than this (2 x W) no longer NAME anything: their scope is dropped and the pass is unscoped
 * (the history and Sync State decide). A webhook's events reach their pass within seconds; only a leaked or a
 * long-queued scope is this old, and an old event naming a property must never make a forward pass write HubSpot's
 * value over a person's edit made since.
 */
export function scopeMaxAgeMs(env: { STALE_FORWARD_HOLD_S?: string }): number {
  return 2 * holdWindowMs(env);
}

// ------------------------------------------------------------------------------------------ our own versions

/** The CRM app (runbook 2026-10-05): every PATCH this Worker sends is recorded by HubSpot under this sourceId. */
export const OWN_HS_SOURCE_ID = "52247773";

/** One version of a property, as HubSpot's propertiesWithHistory lists it. */
export interface HsVersion { value: string; timestamp: string; sourceType: string; sourceId?: string }

/** Is this version our own write? Exactly: an INTEGRATION write carrying our app's sourceId. */
export function isOwnVersion(v: HsVersion): boolean {
  return v.sourceType === "INTEGRATION" && String(v.sourceId ?? "") === OWN_HS_SOURCE_ID;
}

// ------------------------------------------------------------------------------------------ this card's own writes

/**
 * ONE OF THIS CARD'S OWN HUBSPOT WRITES (STALE_FORWARD_RETRY's provenance): a property this card's engine PATCHed --
 * a person's column-level push (its retry's and a rescue's included), a backward move's clear / set / restore, the
 * dangling-clear repair -- or sent in a monday-born create. HubSpot records every one of them under our app's
 * sourceId; so does EVERY other write made with the CRM app's token: an operator's script, /app/clear-deal-fields and
 * /app/clear-record-fields, the phone backfill, a DUPLICATE card's push of the same record. isOwnVersion cannot tell
 * those apart; a version matching one of these records can (isThisCardsPush), and only it is "ours, from this card".
 * Kept in the card's watch (CardWatch.pushes), and written only while STALE_FORWARD_RETRY is on: its two readers --
 * the converge's log rescue and the mark's retry -- are the only paths that write HubSpot outside a webhook.
 */
export interface PushRec {
  /** The HubSpot record written. */
  recordId: string;
  prop: string;
  /** The value sent ("" for a clear). */
  value: string;
  /** The modified time HubSpot answered the write with (ms, HubSpot's own clock); NaN when it answered none. */
  mod: number;
  /** When the write was sent and answered (ms, the Worker's clock). */
  s: number;
  e: number;
  /**
   * The cells the run that sent it was sending (their watch keys: a column, NAME_KEY); ALL_CELLS for a write of the
   * card as a whole (a monday-born create's payload, a drawer save). Two cells can feed one property (the Deals coarse
   * and exact Stage; a company's item name and its Name column), and the rescue tells this cell's own stale push from a
   * later edit of the property in another cell by it (ownLaterVerdict). Absent: not recorded -- read as another cell's.
   */
  keys?: string[];
}
/** PushRec.keys of a write of the card as a whole. */
export const ALL_CELLS = "*";
/** A version is this write's when it is within this of the write's answered modified time, or of its own window. */
export const PUSH_MATCH_MS = 5_000;
/** How long a card remembers its own writes: as long as the watch's other memories. Its readers need minutes. */
export const PUSH_RETENTION_MS = WATCH_RETENTION_MS;
/** At most this many writes per property (the newest), and in all. */
export const PUSH_KEEP_PER_PROP = 8;
export const PUSH_KEEP_MAX = 64;

/**
 * A value as this card sent it, against a value HubSpot stores: the same text (trimmed, in any case), the same
 * number ("1000" / "1000.0"), or the same time ("2026-10-09" / its epoch ms). Lenient on purpose: a version it fails to
 * match reads as someone else's, which is the safe side (nothing is pushed over it) but loses the double edit's later
 * value; one it matches wrongly could only be a same-valued write in the same few seconds.
 */
export function sameStoredValue(sent: unknown, stored: unknown): boolean {
  const a = String(sent ?? "").trim(), b = String(stored ?? "").trim();
  if (a === b || a.toLowerCase() === b.toLowerCase()) return true;
  if (!a || !b) return false;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  const ta = timeOf(a), tb = timeOf(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/** The recorded write of THIS card that a version of `recordId` is -- our sourceId, the same property, the same value, at
 *  the same time (HubSpot's answered modified time, or the write's own window, within PUSH_MATCH_MS); the latest such
 *  write when several match -- or undefined. */
export function pushOf(v: TaggedVersion, pushes: readonly PushRec[] | undefined, recordId: string): PushRec | undefined {
  if (!isOwnVersion(v) || !pushes?.length) return undefined;
  const t = timeOf(v.timestamp);
  if (!Number.isFinite(t)) return undefined;
  let best: PushRec | undefined;
  for (const p of pushes)
    if (p.recordId === recordId && p.prop === v.prop && sameStoredValue(p.value, v.value)
        && ((Number.isFinite(p.mod) && Math.abs(t - p.mod) <= PUSH_MATCH_MS)
          || (t >= p.s - PUSH_MATCH_MS && t <= p.e + PUSH_MATCH_MS))
        && (!best || p.e > best.e)) best = p;
  return best;
}

/** Is this version one of THIS card's own writes of `recordId` (pushOf)? */
export function isThisCardsPush(v: TaggedVersion, pushes: readonly PushRec[] | undefined, recordId: string): boolean {
  return !!pushOf(v, pushes, recordId);
}

/**
 * THE NEWEST CHANGE THIS CARD DID NOT MAKE: the newest time of a version its own writes do not explain -- anyone
 * else's, or our app's from another path or card -- or undefined when there is none. A version whose time cannot be
 * read is +Infinity: it cannot be placed, so nothing is ever judged newer than it (never push on uncertainty).
 */
export function newestForeignAt(versions: TaggedVersion[] | undefined, pushes: readonly PushRec[] | undefined,
    recordId: string): number | undefined {
  if (!versions) return undefined;
  let max = -Infinity;
  for (const v of versions) {
    if (isThisCardsPush(v, pushes, recordId)) continue;
    const t = timeOf(v.timestamp);
    max = Math.max(max, Number.isFinite(t) ? t : Infinity);
  }
  return max === -Infinity ? undefined : max;
}

/** Did this card already send `value` for `prop` -- a write that ended at or after `since` (a monday log row's time;
 *  the write's is the Worker's clock, so within PUSH_MATCH_MS of it counts)? */
export function sentSince(pushes: readonly PushRec[] | undefined, recordId: string, prop: string, value: unknown,
    since: number): boolean {
  return !!pushes?.some(p => p.recordId === recordId && p.prop === prop && sameStoredValue(p.value, value)
    && p.e >= since - PUSH_MATCH_MS);
}

/**
 * THE RESCUE'S LAST QUESTION, ABOUT THIS CARD'S OWN WRITES (after provenance: no foreign version is newer than the edit).
 * `versions`: the property's history, newest first; `key`: the cell; `want`: what it would send; `rowAt`: the person's
 * edit -- the cell's NEWEST row in monday's log, so any push of this very cell that holds another value was built from
 * an older read than that edit.
 *   - "sibling": HubSpot's newest version is this card's push of the property from ANOTHER cell (or from cells it did
 *     not record), sent after the edit -- the Deals coarse Stage beside the exact one, a company's item name beside its
 *     Name column: that later edit of the property wins, and this cell converges to it;
 *   - "sent": this card already sent `want` since the edit, and what HubSpot holds instead is not explained by a stale
 *     push of this very cell landing after it -- HubSpot's own answer (it stored the value otherwise, ignored it): the
 *     edit is sent ONCE, and the cell converges, never re-sent in a loop;
 *   - undefined: send it. Notably when this cell's own push of `want` was OVERTAKEN by a stale push of the same cell (a
 *     run that read the card before the edit and sent last, another isolate's): the edit never landed. A sentSince that
 *     ignored this lost the person's newest edit on both sides.
 */
export function ownLaterVerdict(versions: readonly TaggedVersion[], pushes: readonly PushRec[] | undefined, recordId: string,
    prop: string, key: string, want: unknown, rowAt: number): "sibling" | "sent" | undefined {
  const newest = versions.find(v => v.prop === prop);
  const np = newest ? pushOf(newest, pushes, recordId) : undefined;
  const ofThisCell = (p: PushRec) => !!p.keys && (p.keys.includes(key) || p.keys.includes(ALL_CELLS));
  if (np && !ofThisCell(np) && np.e >= rowAt - PUSH_MATCH_MS) return "sibling";
  const sent = (pushes ?? []).filter(p => p.recordId === recordId && p.prop === prop && sameStoredValue(p.value, want)
    && p.e >= rowAt - PUSH_MATCH_MS);
  if (!sent.length) return undefined;
  const lastSent = Math.max(...sent.map(p => p.e));
  const overtaken = !!np && ofThisCell(np) && !sameStoredValue(np.value, want) && np.e > lastSent;
  return overtaken ? undefined : "sent";
}

/**
 * Was a HubSpot WEBHOOK event our own write? true / false, or null when it cannot be told -- then the history read
 * decides, which is verified. A misparsed event can therefore never make our own push read as HubSpot's change.
 */
export function eventOwnness(changeSource: unknown, sourceId: unknown): boolean | null {
  const src = String(changeSource ?? "").trim();
  if (!src) return null;
  if (src !== "INTEGRATION") return false;
  return String(sourceId ?? "").trim() === OWN_HS_SOURCE_ID ? true : null;
}

// ------------------------------------------------------------------------------------------ time

/** epoch-ms digits or ISO -> ms; NaN when neither. */
export function timeOf(v: unknown): number {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
}

/** monday's updated_at, as a time no earlier than the update: a value without fractions of a second is read as the
 *  END of that second, so "monday has not changed since t" is never claimed for a change inside t's own second. */
export function updatedAtMs(v: unknown): number {
  const s = String(v ?? "").trim();
  const t = timeOf(s);
  if (!Number.isFinite(t)) return NaN;
  return /\.\d+/.test(s) || /^\d+$/.test(s) ? t : t + 999;
}

// ------------------------------------------------------------------------------------------ which cells are gated

export const NAME_KEY = "~name";
export const relKey = (col: string): string => `rel:${col}`;

/** The Deals native coarse Stage, while STAGE_COARSE_REVERSE makes a person's edit of it two-way. */
export function isCoarseGated(env: { STAGE_COARSE_REVERSE?: string }, spec: ObjectSpec, f: FieldSpec | undefined): boolean {
  return !!f && env.STAGE_COARSE_REVERSE === "true" && coarseStageField(spec) === f;
}

/** A column a person's monday edit can push: a two-way field, or the coarse Stage while it is two-way. Not a
 *  one-way field, and not a hubspotOnly one (it has neither reverse flag). */
export function isGatedField(env: { STAGE_COARSE_REVERSE?: string }, spec: ObjectSpec, f: FieldSpec): boolean {
  return (!f.oneWay && !!(f.reverse || f.appReverse)) || isCoarseGated(env, spec, f);
}

export function isGatedCol(env: { STAGE_COARSE_REVERSE?: string }, spec: ObjectSpec, col: string): boolean {
  return spec.fields.some(f => f.col === col && isGatedField(env, spec, f));
}

/** The columns whose changed_at a gated pass reads. */
export function gatedCols(env: { STAGE_COARSE_REVERSE?: string }, spec: ObjectSpec): string[] {
  return [...new Set(spec.fields.filter(f => isGatedField(env, spec, f)).map(f => f.col))];
}

/**
 * The properties the item name is built from on `rec`, as mapping.ts itemName builds it: the nameProps when any is
 * non-empty, else the FIRST non-empty fallback, else none. So a named company's domain change is no news for its
 * name, while a nameless company's is.
 */
export function nameFeedProps(spec: ObjectSpec, rec: HsRecord): string[] {
  if (spec.nameProps.some(p => String(rec.properties[p] ?? "").trim())) return [...spec.nameProps];
  const fb = (spec.nameFallbackProps ?? []).find(p => String(rec.properties[p] ?? "").trim());
  return fb ? [fb] : [];
}

/**
 * THE HUBSPOT PROPERTIES BEHIND A GATED DIFFERENCE, or undefined when the difference is not gated (HEAD's rule):
 *   - a two-way field (or the coarse Stage while two-way): [f.hs];
 *   - the item name on a spec that pushes it (nameReverse): nameReverse with the properties feeding the name.
 * A backfill and a view the card only shows cut short are never gated. Relation cells are judged elsewhere.
 */
export function gatedProps(env: { STAGE_COARSE_REVERSE?: string }, spec: ObjectSpec, d: Diff, rec: HsRecord): string[] | undefined {
  if (d.backfill || d.viewTruncated) return undefined;
  if (d.kind === "name")
    return spec.nameReverse ? [...new Set([spec.nameReverse, ...nameFeedProps(spec, rec)])] : undefined;
  if (d.kind !== "field" || !d.f) return undefined;
  return isGatedField(env, spec, d.f) ? [d.f.hs] : undefined;
}

/** The properties a difference reflects, gated or not: what a pass's events must name to put it in play. */
export function diffProps(spec: ObjectSpec, d: Diff, rec: HsRecord): string[] {
  if (d.kind === "field" && d.f) return [d.f.hs];
  if (d.kind === "name") return [...new Set([...(spec.nameReverse ? [spec.nameReverse] : []), ...nameFeedProps(spec, rec)])];
  if (d.kind === "group" && "prop" in spec.groupBy) return [spec.groupBy.prop];
  return [];
}

/** The watch's key for a gated difference: its column id, or NAME_KEY. */
export function gateKey(d: Diff): string {
  return d.kind === "name" ? NAME_KEY : d.f!.col;
}

/** A card cell normalised exactly as fieldDiffs normalises the monday side, so a value this Worker wrote and monday
 *  re-rendered (a phone reformatted, a number with separators) still reads as the same cell. */
export function cellKey(f: FieldSpec, item: MondayItem): string {
  if (f.type === "people") {
    const cv = item.column_values.find(c => c.id === f.col);
    return (cv?.persons_and_teams ?? []).filter(p => p.kind === "person").map(p => String(p.id)).sort().join(",");
  }
  const t = colText(item, f.col);
  switch (f.type) {
    case "phone": return phoneDigits(t);
    case "email": return t.trim().toLowerCase();
    case "link": return linkText(t);
    case "numbers": return numText(t);
    default: return t;
  }
}

/** A cell's fingerprint: cellKey for a field, the trimmed item name for the name. */
export function cellFp(d: Diff, card: MondayItem): string {
  return d.kind === "name" ? card.name.trim() : cellKey(d.f!, card);
}

/** A HubSpot value as the cell would show it, normalised like cellKey. */
export function fpOfField(f: FieldSpec, value: string | null | undefined, ctx: Ctx): string {
  if (f.type === "people") {
    const want = formatValue(f, value, ctx) as { personsAndTeams?: { id: number }[] } | null;
    return (want?.personsAndTeams ?? []).map(p => String(p.id)).sort().join(",");
  }
  const t = expectedText(f, value, ctx) ?? "";
  switch (f.type) {
    case "phone": return phoneDigits(t);
    case "email": return t.trim().toLowerCase();
    case "link": return linkText(t);
    case "numbers": return numText(t);
    default: return t;
  }
}

/** A version of one of the name's properties as the card's name would show it: fitted like monday.ts fits a name,
 *  and a fallback through the spec's transform (an Accounts domain becomes its stem). */
export function fpOfName(spec: ObjectSpec, ctx: Ctx, prop: string, value: string): string {
  const v = String(value ?? "").trim();
  const isFallback = (spec.nameFallbackProps ?? []).includes(prop) && !spec.nameProps.includes(prop);
  let shown = v;
  if (isFallback && spec.nameFallbackTransform === "domainStem") shown = domainStem(v) || v;
  else if (isFallback && spec.nameFallbackTransform === "emailLocalPart") {
    const at = v.indexOf("@");
    shown = (at > 0 ? v.slice(0, at).trim() : "") || v;
  }
  return (ctx.itemNameMax ? fitItemName(shown, ctx.itemNameMax) : shown).trim();
}

// ------------------------------------------------------------------------------------------ the pass's events

/** Merge two scopes: unscoped wins; otherwise the union, keeping the newest event per property. */
export function mergeScopes(a: PassScope | "unscoped" | undefined, b: PassScope | "unscoped" | undefined):
    PassScope | "unscoped" {
  if (a === undefined) return b ?? "unscoped";
  if (b === undefined) return a;
  if (a === "unscoped" || b === "unscoped") return "unscoped";
  const props: PassScope["props"] = { ...a.props };
  for (const [p, ev] of Object.entries(b.props)) {
    const cur = props[p];
    if (!cur || ev.at > cur.at) props[p] = { ...ev };
    else if (ev.at === cur.at && ev.own !== cur.own) props[p] = { at: cur.at, own: null };
  }
  return { props };
}

/**
 * A scope as a pass may still use it: undefined (UNSCOPED) when any event it carries is older than `maxAgeMs`, or
 * cannot be placed in time. Such an event is a leaked or long-queued one -- what it named may have been changed on
 * monday since -- so nothing is taken on its say-so: the history and Sync State decide every cell, as for a creation.
 */
export function freshScope(scope: PassScope | undefined, now: number, maxAgeMs: number): PassScope | undefined {
  if (!scope) return undefined;
  for (const ev of Object.values(scope.props))
    if (!Number.isFinite(ev.at) || ev.at <= 0 || now - ev.at > maxAgeMs) return undefined;
  return scope;
}

export interface NamedEvent { at: number; own: boolean | null }

/** The newest event the scope names among `props`, or undefined when it names none of them. */
export function newestNamed(scope: PassScope | undefined, props: string[]): NamedEvent | undefined {
  if (!scope) return undefined;
  let best: NamedEvent | undefined;
  for (const p of props) {
    const ev = scope.props[p];
    if (!ev) continue;
    if (!best || ev.at > best.at) best = { at: ev.at, own: ev.own };
    else if (ev.at === best.at && ev.own !== best.own) best = { at: best.at, own: null };
  }
  return best;
}

// ------------------------------------------------------------------------------------------ the per-cell verdict

/** A version tagged with the property it belongs to (a name merges several). */
export interface TaggedVersion extends HsVersion { prop: string }

/** The versions of `props`, merged and newest first; undefined when the history of any of them was not read. */
export function mergedVersions(history: Record<string, HsVersion[]> | undefined, props: string[]): TaggedVersion[] | undefined {
  if (!history || !props.every(p => Object.hasOwn(history, p))) return undefined;
  const all: TaggedVersion[] = [];
  for (const p of props) for (const v of history[p]) all.push({ ...v, prop: p });
  return all.map((v, i) => ({ v, i, t: timeOf(v.timestamp) }))
    .sort((a, b) => (Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity) || a.i - b.i)
    .map(x => x.v);
}

/** The newest time of a version that is not our own, or undefined (no history, or only our own). */
export function newestNonOwnAt(versions: TaggedVersion[] | undefined): number | undefined {
  if (!versions) return undefined;
  let max = -Infinity;
  for (const v of versions) if (!isOwnVersion(v)) { const t = timeOf(v.timestamp); if (Number.isFinite(t) && t > max) max = t; }
  return Number.isFinite(max) ? max : undefined;
}

export interface CellFacts {
  /** The cell's changed_at (ms); null = the cell is UNTYPED (monday stamps no changed_at on it). */
  c: number | null;
  /** The card's updated_at (ms; NaN when unknown). */
  u: number;
  /** The card's Sync State (ms; NaN when none). */
  S: number;
  /** The history of the cell's properties, merged, newest first; undefined = not read. */
  versions?: TaggedVersion[];
  /** The newest event this pass's events name among the cell's properties. */
  named?: NamedEvent;
  /** The card's value (text; "" when empty). */
  md: string;
  /** The card's value, fingerprinted (cellFp). */
  fp: string;
  /** A version of one of the cell's properties as the cell would show it; null = cannot tell. */
  fpOf: (v: TaggedVersion) => string | null;
  now: number;
  W: number;
  /** The history could not be read: what would need it is judged without. */
  historyFailed?: boolean;
}

export type CellVerdict =
  | { v: "forward"; why: string }
  | { v: "hold"; typed: boolean; anchor: number; why: string }
  | { v: "candidate"; typed: boolean; why: string }
  | { v: "need-history"; why: string };

/**
 * ONE DIFFERING TWO-WAY CELL: HubSpot's value over it (forward), or left alone (hold while it can still be a
 * person's edit on its way, candidate once it cannot), or -- the caller reads the history and asks again.
 *
 * TYPED (c known):
 *   T1  no history and no usable event: monday-later.
 *   T2  a usable event, no history: our own -> monday-later; after c -> forward; within TIE_MS -> the history;
 *       else monday-later.
 *   T3  history (n = the newest version): our own -> monday-later; after c -> forward; within TIE_MS of c with the
 *       cell showing HubSpot's previous value -> forward (our forward of that value crossed HubSpot's change);
 *       else monday-later.
 *   monday-later: hold (anchor c) while c is less than W old, else candidate.
 * UNTYPED:
 *   U1  a usable event, no history: our own -> monday-later; not ours and the card unchanged since -> forward;
 *       the card changed since -> the history.
 *   U2  history: our own newest -> monday-later; a non-empty value HubSpot never held -> monday-later; HubSpot
 *       changed since Sync State, or the events name it -> forward; else monday-later.
 *   U3  no history: monday-later.
 *   monday-later: hold (anchor u) while the card changed less than W ago, else candidate.
 * An event whose source cannot be told (own null) is not usable: the history decides.
 */
export function judgeCell(x: CellFacts): CellVerdict {
  const mondayLater = (why: string): CellVerdict => {
    if (x.c !== null) return x.now - x.c < x.W ? { v: "hold", typed: true, anchor: x.c, why } : { v: "candidate", typed: true, why };
    return Number.isFinite(x.u) && x.now - x.u < x.W
      ? { v: "hold", typed: false, anchor: x.u, why } : { v: "candidate", typed: false, why };
  };
  const needHistory = (why: string): CellVerdict =>
    x.historyFailed ? mondayLater(`${why}; HubSpot's history is unreadable`) : { v: "need-history", why };
  const ev = x.named;
  const usable = !!ev && ev.own !== null && Number.isFinite(ev.at);
  const vs = x.versions;

  if (x.c !== null) {
    const c = x.c;
    if (vs === undefined) {
      if (usable) {
        if (ev!.own) return mondayLater("the newest change the events name is our own write");
        if (ev!.at > c) return { v: "forward", why: "HubSpot changed it after monday did (its event)" };
        if (c - ev!.at < TIE_MS) return needHistory("monday's change and the event's are within the tie window");
        return mondayLater("monday changed it after the event's change");
      }
      if (ev) return needHistory("the event's source cannot be told");
      return mondayLater("no history and no event naming it");
    }
    if (!vs.length) return mondayLater("HubSpot holds no version of it");
    const n = vs[0];
    if (isOwnVersion(n)) return mondayLater("HubSpot's newest version is our own write");
    const V = timeOf(n.timestamp);
    if (V > c) return { v: "forward", why: "HubSpot changed it after monday did" };
    if (c - V < TIE_MS && vs[1] && x.fpOf(vs[1]) === x.fp)
      return { v: "forward", why: "tie-break: our forward of HubSpot's earlier value crossed its newer change" };
    return mondayLater("monday changed it after HubSpot did");
  }

  if (vs === undefined) {
    if (usable) {
      if (ev!.own) return mondayLater("the newest change the events name is our own write");
      if (Number.isFinite(x.u) && x.u < ev!.at) return { v: "forward", why: "the card is unchanged since HubSpot's change (its event)" };
      return needHistory("the card changed since the event");
    }
    if (ev) return needHistory("the event's source cannot be told");
    return mondayLater("no history read");
  }
  if (!vs.length) return mondayLater("HubSpot holds no version of it");
  const n = vs[0];
  if (isOwnVersion(n)) return mondayLater("HubSpot's newest version is our own write");
  if (x.md.trim()) {
    const fps = vs.map(v => x.fpOf(v));
    const held = fps.some(f => f !== null && f === x.fp) ? true : fps.every(f => f !== null) ? false : null;
    if (held === false) return mondayLater("a value HubSpot has never held: monday's own");
  }
  const V = timeOf(n.timestamp);
  const S = Number.isFinite(x.S) ? x.S : -Infinity;
  if (V > S || ev) return { v: "forward", why: ev ? "HubSpot changed it, and the events name it" : "HubSpot changed it after Sync State" };
  return mondayLater("HubSpot has not changed it since Sync State");
}

/**
 * Read the cell's history BEFORE the card? Unscoped pass: always. Scoped: only a cell the events name whose
 * source cannot be told, or one that may be untyped and that the card changed at or after the event.
 */
export function needHistoryBefore(o: { scoped: boolean; named?: NamedEvent; possiblyUntyped: boolean; u: number }): boolean {
  if (!o.scoped) return true;
  if (!o.named) return false;
  if (o.named.own === null || !Number.isFinite(o.named.at)) return true;
  return o.possiblyUntyped && !(o.u < o.named.at);
}

// ------------------------------------------------------------------------------------------ the watch's veto

/** What the card's watch answers for one cell (watchCells). */
export interface WatchReply {
  /** When this hold started: c for a typed cell, the first time THIS value was held for an untyped one. */
  since: number;
  /** since + the cell's window has passed. */
  expired: boolean;
  /** A live mark on the cell: a person's edit still on its way. */
  mark?: { at: number; rel?: RelMark };
  /** The loop breaker leaves this value alone: the cell shows what our converge's write of HubSpot's CURRENT value
   *  became on monday (asked with `hs`), so it already has HubSpot's value, as monday renders it. */
  stuck: boolean;
  /** A mark of this cell was given up for this value (STALE_FORWARD_RETRY): it is not rescued again. */
  gaveUpFp?: string;
}

export type FinalVerdict = "forward" | "hold" | "candidate" | "left";

/**
 * THE WATCH'S VETO over a cell's verdict.
 *   V1 a typed hold ends at c + W (judgeCell already measured it).
 *   V2 an untyped hold ends W after THIS value was first held: the watch's since.
 *   V3 a live mark: a hold or candidate stays held (the mark's own lifecycle bounds it); an untyped forward is held
 *      when the mark is newer than HubSpot's newest change not ours (or that time is unknown); a typed forward never.
 *      `newestNonOwn` is that change's time as the pass knows it: from the history when read, else the event that
 *      named the cell (not ours) -- an edit older than HubSpot's own later change never holds it off.
 *   V4 a candidate with no mark: left, for the converge (in the converge pass: rescued or converged).
 *   V5 stuck: left.
 * The watch unreachable (null): holds stand, candidates are left, forwards proceed.
 */
export function applyVeto(v: CellVerdict, r: WatchReply | null | undefined,
    o: { typed: boolean; newestNonOwn?: number; unreachable?: boolean }): { final: FinalVerdict; why: string } {
  if (v.v === "need-history") return { final: "hold", why: v.why };
  if (v.v === "forward") {
    if (!o.typed && r?.mark && (o.newestNonOwn === undefined || r.mark.at > o.newestNonOwn))
      return { final: "hold", why: "a person's edit newer than HubSpot's change is on its way (mark)" };
    return { final: "forward", why: v.why };
  }
  if (o.unreachable || r === null) return v.v === "hold" ? { final: "hold", why: v.why } : { final: "left", why: v.why };
  if (r?.stuck) return { final: "left", why: "the loop breaker leaves this value alone" };
  if (v.v === "hold") {
    if (v.typed || !r?.expired) return { final: "hold", why: v.why };
    if (r?.mark) return { final: "hold", why: "a person's edit of it is on its way (mark)" };
    return { final: "candidate", why: "this value has been held for the whole window" };
  }
  if (r?.mark) return { final: "hold", why: "a person's edit of it is on its way (mark)" };
  return { final: "candidate", why: v.why };
}

// ------------------------------------------------------------------------------------------ the card's watch

/** One cell a pass left in place. */
export interface WatchCell {
  fp: string;
  since: number;
  typed: boolean;
  windowMs: number;
  /** Converge it at this time (a candidate: at once). */
  due?: number;
  /** The loop breaker leaves it alone until then. */
  stuckUntil?: number;
  /**
   * The Deals coarse Stage only (HEAD's timing for it): a pass that judged THIS value saw HubSpot newer than Sync
   * State -- HEAD would have written HubSpot's stage over it then. Its converge does so once its hold ends; without
   * it, a coarse value is left to the next pass in which HubSpot is newer, as HEAD leaves it.
   */
  newer?: true;
  /** When the watch first held THIS value of the cell (a new value starts again): the rescue's horizon is measured from
   *  it (RESCUE_LOOKBACK_MS). Absent (a cell a mark's lapse or a give-up made): the converge's own time. */
  seen?: number;
}

/** A relation edit's net change, composed in arrival order (relation-edit.ts recordRelationEvent's rule). */
export interface RelMark { added: string[]; removed: string[]; known: boolean; largestAdd: number; largestRemove: number }

/** A person's (or an automation's) edit of a cell, from its webhook until its run resolves. */
export interface EditMark {
  /** The latest event's own time (monday's changedAt). */
  at: number;
  /** When its first and latest events reached us. The lease counts from the first. */
  firstRx: number;
  lastRx: number;
  actor?: string;
  byAutomation?: boolean;
  rel?: RelMark;
  /**
   * A People cell's edit: the monday person ids its events REMOVED (monday's own before/after), composed as the
   * webhook composes them for a run (a union); `known` false once any event lacked its before-side. A retry sends
   * them as the edit's removedPeople, so emptying a stale cell is refused exactly as the live run refuses it --
   * never read as "the person removed HubSpot's owner".
   */
  people?: { ids: string[]; known: boolean };
  /** Made by the converge's log rescue, not by a webhook: its retry is due at once. */
  rescued?: boolean;
  retryQueuedAt?: number;
  /** Retry runs begun. */
  attempts: number;
}

export interface CardWatch {
  boardId: string;
  itemId: string;
  object: string;
  recordId?: string;
  cells: Record<string, WatchCell>;
  marks: Record<string, EditMark>;
  /** Converge EVERY differing two-way cell at this time (an adoption, a create). */
  allAt?: number;
  /**
   * When the card was linked to its record (an adoption, a monday-born create's id write-back). What monday showed
   * before it is the form's starting state, not an edit of the record: it is never rescued as a person's edit, and
   * a mark of an edit made before it is never re-sent -- such a cell converges to HubSpot. Kept while the watch is.
   */
  linkedAt?: number;
  /**
   * A monday-born create only: the window of its own id write-back (the Worker's clock). Its link time is the create's
   * READ (linkedAt), which comes BEFORE that write: what the card showed then is what the create sent, and an edit
   * made since -- during the write-back too -- is an edit of the new record. So the id cell's log row of that write
   * does not move the link time (effectiveLinkAt); any other id write does.
   */
  linkWrite?: { s: number; e: number };
  /** This card's own HubSpot writes, newest last (STALE_FORWARD_RETRY; see PushRec). */
  pushes?: PushRec[];
  /** Converges begun since the last one that finished (a run of failures), and when the first of them began: the
   *  re-queue's back-off and the dead-letter are measured from it (CONVERGE_BACKOFF_MAX_MS, CONVERGE_GIVE_UP_MS). */
  convergeRuns?: number;
  convergeSince?: number;
  /**
   * The loop breaker's memory, per cell: a converge wrote HubSpot's value (`hs`, its text) at `at`, and monday then
   * showed `fp` -- NOT HubSpot's value (a re-rendering, a value that does not take). Only that state is left alone
   * again: a new value on the cell, or a new HubSpot value, is converged as any other. No memory when the write took.
   */
  fwd?: Record<string, { hs: string; at: number; fp?: string }>;
  /** Marks given up (STALE_FORWARD_RETRY), by the value they protected ("" = unknown): never rescued again. */
  gaveUp?: Record<string, { fp: string; at: number }>;
  convergeQueuedAt?: number;
  /** Converges whose activity-log read failed in a row. */
  convergeAttempts?: number;
}

export interface WatchBase { boardId: string; itemId: string; object: string; recordId?: string }

export interface WatchReq {
  key: string;
  fp: string;
  typed: boolean;
  anchor: number;
  /**
   * hold: register; candidate: register and converge at once; probe: only ask (marks, stuck);
   * forward: an untyped FORWARD verdict pending its mark check (V3) -- the cell is resolved (dropped) unless a live
   * mark newer than `newsAt` vetoes it, and then it is registered as a hold, so it still converges once that mark
   * resolves (the pass applies the same rule to the reply).
   */
  kind: "hold" | "candidate" | "probe" | "forward";
  windowMs?: number;
  /** forward: HubSpot's newest change not ours, as the pass knows it (undefined: unknown). */
  newsAt?: number;
  /** HubSpot's value for the cell, as text: the loop breaker leaves a cell alone only for the value it wrote. */
  hs?: string;
  /** The coarse Stage: this pass saw HubSpot newer than Sync State (WatchCell.newer). */
  newer?: boolean;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Is this mark still protecting its cell? With the retry off, for its lease; on, until its run resolves (cleared),
 *  it is given up (the alarm, beginRetry), or its TTL passes. */
export function isMarkLive(m: EditMark | undefined, now: number, retryOn: boolean): boolean {
  if (!m) return false;
  if (!retryOn) return now - m.firstRx < MARK_LEASE_MS;
  return now - m.firstRx < MARK_TTL_MS;
}

/** When this mark's next retry is due (STALE_FORWARD_RETRY). */
export function retryDueAt(m: EditMark): number {
  if (m.retryQueuedAt === undefined) return m.rescued ? m.firstRx : m.firstRx + MARK_LEASE_MS;
  const i = Math.min(Math.max(m.attempts, 1), RETRY_BACKOFF_MS.length) - 1;
  return m.retryQueuedAt + RETRY_BACKOFF_MS[i];
}

/** A given-up mark's value: matches `fp` (or any value, when it was not known) within the memory's life. */
export function gaveUpMatches(g: { fp: string; at: number } | undefined, fp: string, now: number): boolean {
  return !!g && now - g.at < WATCH_RETENTION_MS && (g.fp === "" || g.fp === fp);
}

function fresh(base: WatchBase): CardWatch {
  return { boardId: base.boardId, itemId: base.itemId, object: base.object,
    ...(base.recordId ? { recordId: base.recordId } : {}), cells: {}, marks: {} };
}

function withBase(w: CardWatch | undefined, base: WatchBase): CardWatch {
  const cur = w ? clone(w) : fresh(base);
  cur.cells ??= {}; cur.marks ??= {};
  if (base.recordId) cur.recordId = base.recordId;
  return cur;
}

/** The watch with nothing left to do and no memory left is no watch. A cell the loop breaker left alone is due for
 *  a converge once its day is over -- never simply forgotten, so a value that still differs then is judged again.
 *  The link time (linkedAt) is kept only while something else keeps the watch; the card's own writes (pushes) for
 *  PUSH_RETENTION_MS. With no cell and no converge-all left, the converge's bookkeeping goes too (its run of
 *  failures, its queue time, its log-read failures): that episode is over, and a later one starts afresh. */
export function pruneWatch(w: CardWatch, now: number): CardWatch | undefined {
  const out = clone(w);
  for (const c of Object.values(out.cells))
    if (c.stuckUntil !== undefined && c.stuckUntil <= now) { delete c.stuckUntil; c.due = now; }
  if (!Object.keys(out.cells).length && out.allAt === undefined)
    for (const k of ["convergeRuns", "convergeSince", "convergeQueuedAt", "convergeAttempts"] as const) delete out[k];
  for (const mem of ["fwd", "gaveUp"] as const) {
    const m = out[mem];
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) if (now - v.at >= WATCH_RETENTION_MS) delete m[k];
    if (!Object.keys(m).length) delete out[mem];
  }
  if (out.pushes) {
    out.pushes = keepPushes(out.pushes, now);
    if (!out.pushes.length) delete out.pushes;
  }
  if (!Object.keys(out.cells).length && !Object.keys(out.marks).length && out.allAt === undefined
      && !out.fwd && !out.gaveUp && !out.pushes) return undefined;
  return out;
}

/** The writes still remembered: within PUSH_RETENTION_MS, the newest PUSH_KEEP_PER_PROP of each record's property and
 *  PUSH_KEEP_MAX in all, oldest first. */
function keepPushes(list: PushRec[], now: number): PushRec[] {
  const byProp = new Map<string, PushRec[]>();
  for (const p of list) {
    if (!Number.isFinite(p.e) || now - p.e >= PUSH_RETENTION_MS) continue;
    const k = `${p.recordId}|${p.prop}`;
    byProp.set(k, [...(byProp.get(k) ?? []), p]);
  }
  return [...byProp.values()].flatMap(ps => ps.sort((a, b) => a.e - b.e).slice(-PUSH_KEEP_PER_PROP))
    .sort((a, b) => a.e - b.e).slice(-PUSH_KEEP_MAX);
}

/** This card's own HubSpot writes, recorded (STALE_FORWARD_RETRY; see PushRec). */
export function reduceNotePushes(w: CardWatch | undefined, base: WatchBase, entries: PushRec[], now: number): CardWatch | undefined {
  const cur = withBase(w, base);
  cur.pushes = keepPushes([...(cur.pushes ?? []), ...entries.map(e => clone(e))], now);
  if (!cur.pushes.length) delete cur.pushes;
  return pruneWatch(cur, now);
}

/**
 * WHEN THE CARD WAS LINKED TO ITS RECORD, for the log rescue and the mark's retry: what the card showed before it is
 * the form's starting state, never an edit of the record. From the watch's own record (linkedAt), and from the record-id
 * cell's newest write in monday's log (`idRow`; absent: none in the window; null: it cannot be told), whichever is
 * later -- except a monday-born create's own id write-back (linkWrite: our token's write inside that window), which
 * does not move a link that the create's READ made. Infinity when the log cannot tell: nothing is proven after it.
 */
export function effectiveLinkAt(w: Pick<CardWatch, "linkedAt" | "linkWrite"> | undefined,
    idRow: { atMs: number; cls: string } | null | undefined): number {
  if (idRow === null) return Infinity;
  const known = w?.linkedAt ?? -Infinity;
  if (!idRow) return known;
  const createsOwnWrite = !!w?.linkWrite && w.linkedAt !== undefined && idRow.cls === "integration"
    && idRow.atMs >= w.linkWrite.s - PUSH_MATCH_MS && idRow.atMs <= w.linkWrite.e + PUSH_MATCH_MS;
  return createsOwnWrite ? known : Math.max(known, Number.isFinite(idRow.atMs) ? idRow.atMs : Infinity);
}

/**
 * A PASS TELLS THE WATCH WHAT IT LEFT IN PLACE, and learns per cell since when, whether the hold ended, any live
 * mark, and the loop breaker's word. One critical section in the Durable Object.
 *   - typed: since = its changed_at, re-anchored on every request (V1);
 *   - untyped: the same value keeps its since; a new value starts at min(now, the card's updated_at) (V2);
 *   - candidate: due at once; probe: nothing registered;
 *   - `resolved`: cells a pass found in line (removed); `all`: converge every two-way cell within W.
 */
export function reduceWatchCells(w: CardWatch | undefined, base: WatchBase, reqs: WatchReq[],
    o: { resolved?: string[]; all?: boolean; linkedAt?: number; linkWrite?: { s: number; e: number } }, now: number, W: number,
    retryOn: boolean): { watch: CardWatch | undefined; replies: Record<string, WatchReply> } {
  const cur = withBase(w, base);
  for (const k of o.resolved ?? []) delete cur.cells[k];
  // The latest link wins, with its own id write (a monday-born create's), or none.
  if (o.linkedAt !== undefined && Number.isFinite(o.linkedAt) && !(cur.linkedAt !== undefined && cur.linkedAt > o.linkedAt)) {
    cur.linkedAt = o.linkedAt;
    if (o.linkWrite && Number.isFinite(o.linkWrite.s) && Number.isFinite(o.linkWrite.e)) cur.linkWrite = { ...o.linkWrite };
    else delete cur.linkWrite;
  }
  const replies: Record<string, WatchReply> = {};
  for (const r of reqs) {
    const m = cur.marks[r.key];
    const mark = isMarkLive(m, now, retryOn) ? { at: m!.at, ...(m!.rel ? { rel: clone(m!.rel) } : {}) } : undefined;
    const g = cur.gaveUp?.[r.key];
    const gaveUp = g && now - g.at < WATCH_RETENTION_MS ? { gaveUpFp: g.fp } : {};
    const cell = cur.cells[r.key];
    const same = !!cell && cell.fp === r.fp;
    const f = cur.fwd?.[r.key];
    const stuck = same && (cell!.stuckUntil ?? 0) > now && (r.hs === undefined || f?.hs === r.hs);
    if (r.kind === "probe") {
      replies[r.key] = { since: cell?.since ?? now, expired: false, stuck, ...(mark ? { mark } : {}), ...gaveUp };
      continue;
    }
    // An untyped forward: resolved, unless a live mark newer than HubSpot's news vetoes it (V3) -- then held here,
    // so the cell is still watched (and converges) once that mark resolves.
    if (r.kind === "forward" && !(mark && (r.newsAt === undefined || mark.at > r.newsAt))) {
      delete cur.cells[r.key];
      replies[r.key] = { since: now, expired: false, stuck: false, ...gaveUp };
      continue;
    }
    const anchor = Number.isFinite(r.anchor) ? r.anchor : now;
    const since = r.typed ? anchor : same ? cell!.since : Math.min(now, anchor);
    const windowMs = r.windowMs ?? W;
    cur.cells[r.key] = { fp: r.fp, since, typed: r.typed, windowMs,
      ...(r.kind === "candidate" ? { due: now } : same && cell!.due !== undefined ? { due: cell!.due } : {}),
      ...(stuck ? { stuckUntil: cell!.stuckUntil } : {}),
      ...(r.newer || (same && cell!.newer) ? { newer: true as const } : {}),
      seen: same ? cell!.seen ?? now : now };
    replies[r.key] = { since, expired: now - since >= windowMs, stuck, ...(mark ? { mark } : {}), ...gaveUp };
  }
  if (o.all) cur.allAt = Math.min(cur.allAt ?? Infinity, now + W);
  return { watch: pruneWatch(cur, now), replies };
}

/** One edit to mark. `rel`: the relation edit's own diff (undefined: none; null: its before-side was unreadable).
 *  `people`: a People cell's edit, the person ids it removed (undefined: not a People edit; null: cannot be told). */
export interface MarkInput {
  key: string;
  at: number;
  rx: number;
  actor?: string;
  byAutomation?: boolean;
  rel?: { added: string[]; removed: string[] } | null;
  people?: string[] | null;
  rescued?: boolean;
}

/** A People edit's removed ids, composed over its events as the webhook composes them for a run: a union, unknown
 *  once any event could not tell. */
export function composePeople(acc: { ids: string[]; known: boolean } | undefined, removed: string[] | null):
    { ids: string[]; known: boolean } {
  const ids = new Set(acc?.ids ?? []);
  if (removed) for (const id of removed) ids.add(String(id));
  return { ids: [...ids], known: (acc?.known ?? true) && removed !== null };
}

/** relation-edit.ts recordRelationEvent's composition, on a mark: add-then-remove cancels. */
export function composeRel(acc: RelMark | undefined, diff: { added: string[]; removed: string[] } | null): RelMark {
  const out: RelMark = acc ? clone(acc) : { added: [], removed: [], known: true, largestAdd: 0, largestRemove: 0 };
  if (!diff) { out.known = false; return out; }
  out.largestAdd = Math.max(out.largestAdd, diff.added.length);
  out.largestRemove = Math.max(out.largestRemove, diff.removed.length);
  const added = new Set(out.added), removed = new Set(out.removed);
  for (const c of diff.removed) { if (added.has(c)) added.delete(c); else removed.add(c); }
  for (const c of diff.added) { if (removed.has(c)) removed.delete(c); else added.add(c); }
  out.added = [...added]; out.removed = [...removed];
  return out;
}

/** Mark edits: the latest event's time, the first and latest receipt, the latest actor; relation diffs composed. */
export function reduceMarkEdits(w: CardWatch | undefined, base: WatchBase, marks: MarkInput[], now: number): CardWatch | undefined {
  const cur = withBase(w, base);
  for (const m of marks) {
    const prev = cur.marks[m.key];
    const rel = m.rel === undefined ? prev?.rel : composeRel(prev?.rel, m.rel);
    const people = m.people === undefined ? prev?.people : composePeople(prev?.people, m.people);
    const actor = m.actor ?? prev?.actor;
    cur.marks[m.key] = {
      at: Math.max(prev?.at ?? -Infinity, Number.isFinite(m.at) ? m.at : m.rx),
      firstRx: prev?.firstRx ?? m.rx,
      lastRx: Math.max(prev?.lastRx ?? -Infinity, m.rx),
      ...(actor ? { actor } : {}),
      ...(m.byAutomation ? { byAutomation: true } : {}),
      ...(rel ? { rel } : {}),
      ...(people ? { people } : {}),
      ...(m.rescued || prev?.rescued ? { rescued: true } : {}),
      ...(prev?.retryQueuedAt !== undefined ? { retryQueuedAt: prev.retryQueuedAt } : {}),
      attempts: prev?.attempts ?? 0,
    };
  }
  return pruneWatch(cur, now);
}

/** A run resolved at or after `t0`: its marks (no event since t0) and the holds it settled (held since t0) go. */
export function reduceClearMarks(w: CardWatch | undefined, keys: string[], t0: number, now: number): CardWatch | undefined {
  if (!w) return undefined;
  const cur = clone(w);
  for (const k of keys) {
    if (cur.marks[k] && cur.marks[k].lastRx <= t0) delete cur.marks[k];
    if (cur.cells[k] && cur.cells[k].since <= t0) delete cur.cells[k];
  }
  return pruneWatch(cur, now);
}

/**
 * A converge takes a snapshot of the watch; it stays queued until finishConverge, and is counted (convergeRuns, from
 * convergeSince) until then -- a run of failures, which backs the re-queue off (convergeRecheckMs). Every converge that
 * begins is run: the cap is decided after one FAILED (reduceFailConverge), never here.
 */
export function reduceBeginConverge(w: CardWatch | undefined, now: number): { watch: CardWatch | undefined; snapshot?: CardWatch } {
  if (!w) return { watch: undefined };
  const cur = clone(w);
  const runs = cur.convergeRuns ?? 0;
  cur.convergeQueuedAt = now;
  cur.convergeRuns = runs + 1;
  if (!runs || cur.convergeSince === undefined) cur.convergeSince = now;
  return { watch: cur, snapshot: clone(w) };
}

/**
 * A CONVERGE FAILED (it threw): once its converges have been failing for CONVERGE_GIVE_UP_MS in a row, the watch's
 * cells are DEAD-LETTERED (`deadLetter`: their keys, "~all" for a pending converge-all): they leave the watch, which stops
 * re-queuing a converge that a day of back-off has not healed; the card's next HubSpot event judges them again. Before
 * that nothing changes: the failure is the run already counted, and the re-queue backs off. Marks and memories are kept.
 */
export function reduceFailConverge(w: CardWatch | undefined, now: number):
    { watch: CardWatch | undefined; deadLetter?: string[]; failingMs?: number } {
  if (!w || !w.convergeRuns || w.convergeSince === undefined || now - w.convergeSince < CONVERGE_GIVE_UP_MS) return { watch: w };
  const cur = clone(w);
  const deadLetter = [...Object.keys(cur.cells), ...(cur.allAt !== undefined ? ["~all"] : [])];
  cur.cells = {};
  delete cur.allAt;
  return { watch: pruneWatch(cur, now), deadLetter, failingMs: now - w.convergeSince };
}

/** How long a queued converge is left before the watch queues it again: CONVERGE_RECHECK_MS -- or, while its converges
 *  keep failing (begun, never finished), as long as they have been failing in a row, at most CONVERGE_BACKOFF_MAX_MS. */
export function convergeRecheckMs(w: Pick<CardWatch, "convergeRuns" | "convergeSince" | "convergeQueuedAt">): number {
  if (!w.convergeRuns || w.convergeSince === undefined || w.convergeQueuedAt === undefined) return CONVERGE_RECHECK_MS;
  return Math.min(CONVERGE_BACKOFF_MAX_MS, Math.max(CONVERGE_RECHECK_MS, w.convergeQueuedAt - w.convergeSince));
}

/** What a converge pass did, for the watch to keep. */
export interface ConvergeOutcome {
  /** The card or record is gone, the card shows another record, or the switch is off: drop the watch. */
  done?: boolean;
  /** Watched cells found in line with HubSpot (or, the coarse Stage, left to HEAD's timing: no longer watched). */
  resolved: string[];
  /**
   * Cells written with HubSpot's value (`hs`, its text). `post`: what the cell showed when read back after the write,
   * present only when that still differs from HubSpot -- the write did not take as sent, and the loop breaker
   * remembers that exact state (and nothing when the write took).
   */
  forwarded: { key: string; fp: string; hs: string; post?: string }[];
  /** Cells still held, with their own clock. */
  held: WatchReq[];
  /** Cells the loop breaker left alone. */
  stuck: string[];
  /** Cells rescued as a person's edit (marked, and retried). */
  rescued: string[];
  /** Cells whose rescue could not be judged (the activity log was unreadable). */
  logUnreadable?: string[];
  /** The watched keys this converge was asked to settle (its snapshot's cells). One it neither settled nor re-held
   *  is put off for CONVERGE_RECHECK_MS: no watched cell can make the watch converge again at once, in a loop. */
  considered?: string[];
}

export function reduceFinishConverge(w: CardWatch | undefined, o: ConvergeOutcome, now: number, W: number): CardWatch | undefined {
  if (!w || o.done) return undefined;
  const cur = clone(w);
  for (const k of o.resolved) delete cur.cells[k];
  for (const f of o.forwarded) {
    delete cur.cells[f.key];
    if (f.post !== undefined) { cur.fwd ??= {}; cur.fwd[f.key] = { hs: f.hs, at: now, fp: f.post }; }
    else if (cur.fwd) delete cur.fwd[f.key];
  }
  for (const r of o.held) {
    const cell = cur.cells[r.key];
    const same = !!cell && cell.fp === r.fp;
    const anchor = Number.isFinite(r.anchor) ? r.anchor : now;
    cur.cells[r.key] = { fp: r.fp, since: r.typed ? anchor : same ? cell!.since : Math.min(now, anchor), typed: r.typed,
      windowMs: r.windowMs ?? cell?.windowMs ?? W, ...(same && cell!.stuckUntil !== undefined ? { stuckUntil: cell!.stuckUntil } : {}),
      ...(r.newer || (same && cell!.newer) ? { newer: true as const } : {}), seen: same ? cell!.seen ?? now : now };
  }
  for (const k of o.stuck) {
    const c = cur.cells[k];
    if (!c) continue;
    delete c.due;
    c.stuckUntil = (cur.fwd?.[k]?.at ?? now) + STUCK_MS;
  }
  for (const k of o.rescued) if (cur.cells[k]) delete cur.cells[k].due;
  const unreadable = o.logUnreadable ?? [];
  for (const k of unreadable) if (cur.cells[k]) cur.cells[k].due = now + LOG_RETRY_MS;
  if (unreadable.length) cur.convergeAttempts = (cur.convergeAttempts ?? 0) + 1;
  else delete cur.convergeAttempts;
  const handled = new Set([...o.resolved, ...o.forwarded.map(f => f.key), ...o.held.map(h => h.key), ...o.stuck,
    ...o.rescued, ...unreadable]);
  for (const k of o.considered ?? []) {
    const c = cur.cells[k];
    if (c && !handled.has(k) && cellDueAt(c) <= now) c.due = now + CONVERGE_RECHECK_MS;
  }
  if (cur.allAt !== undefined && cur.allAt <= now) delete cur.allAt;
  delete cur.convergeQueuedAt;
  delete cur.convergeRuns;                                   // it finished: a run of failures, if any, is over
  delete cur.convergeSince;
  return pruneWatch(cur, now);
}

/** A cell made due by a mark that was given up: the converge judges it (and does not rescue it again). */
function abandonMark(cur: CardWatch, k: string, now: number, W: number): void {
  const m = cur.marks[k];
  delete cur.marks[k];
  const cell = cur.cells[k] ?? { fp: "", since: m?.at ?? now, typed: false, windowMs: W };
  cur.cells[k] = { ...cell, due: now };
  delete cur.cells[k].stuckUntil;
  cur.gaveUp ??= {};
  cur.gaveUp[k] = { fp: cell.fp, at: now };
}

/** An edit made before the card was linked to its record (linkedAt): the form's starting state, never re-sent. */
function madeBeforeLink(cur: CardWatch, m: EditMark): boolean {
  return cur.linkedAt !== undefined && m.at <= cur.linkedAt;
}

/** A mark past its TTL, or past its retries. */
function markSpent(m: EditMark, now: number): boolean {
  return now - m.firstRx >= MARK_TTL_MS || m.attempts > RETRY_BACKOFF_MS.length;
}

/**
 * THE RETRY PASS BEGINS (STALE_FORWARD_RETRY): the marks past their lease (a rescued one at once), each counted as
 * an attempt. A mark past MARK_TTL_MS, or past RETRY_BACKOFF_MS.length attempts -- or made before the card was
 * linked to its record (linkedAt) -- is given up: its cell becomes due and its value is not rescued again.
 */
export function reduceBeginRetry(w: CardWatch | undefined, now: number, W: number, retryOn: boolean):
    { watch: CardWatch | undefined; live: Record<string, EditMark>; abandoned: string[] } {
  if (!w || !retryOn) return { watch: w, live: {}, abandoned: [] };
  const cur = clone(w);
  const live: Record<string, EditMark> = {};
  const abandoned: string[] = [];
  for (const [k, m] of Object.entries(cur.marks)) {
    if (!(m.rescued || now - m.firstRx >= MARK_LEASE_MS)) continue;
    if (markSpent(m, now) || madeBeforeLink(cur, m)) { abandonMark(cur, k, now, W); abandoned.push(k); continue; }
    m.attempts++;
    live[k] = clone(m);
  }
  return { watch: pruneWatch(cur, now), live, abandoned };
}

/**
 * A RETRY THAT FAILED IN ITS OWN READS, BEFORE IT SENT ANYTHING (STALE_FORWARD_RETRY): monday's log for the link check,
 * the card, HubSpot's history for the supersede check, the re-reads right before the push. Those fail under the very
 * rate limits that kill the runs a retry recovers, and a read that could not be had is not a send that failed: each mark
 * gets the attempt back, so three refused reads never spend a mark HubSpot never refused. Its backoff (retryQueuedAt)
 * stands, and its TTL still bounds it. The push path's own failures count as before.
 */
export function reduceRefundRetry(w: CardWatch | undefined, keys: string[], now: number): CardWatch | undefined {
  if (!w) return undefined;
  const cur = clone(w);
  for (const k of keys) { const m = cur.marks[k]; if (m && m.attempts > 0) m.attempts--; }
  return pruneWatch(cur, now);
}

/**
 * A RETRY SUPERSEDED (STALE_FORWARD_RETRY): HubSpot changed these cells after the edits their marks carried, and the
 * later change wins. The marks go -- and each cell, as it shows now (`fps`), is due for a converge at once, which
 * writes HubSpot's later value over it; that value is never rescued again as a person's edit (gaveUp). Clearing
 * alone left card and HubSpot disagreeing with nothing scheduled. A mark an event reached after the retry began
 * (`t0`) is a newer edit's: it stays, and its own run settles the cell.
 */
export function reduceSupersede(w: CardWatch | undefined, base: WatchBase, fps: Record<string, string>, t0: number, now: number,
    W: number): CardWatch | undefined {
  const cur = withBase(w, base);
  for (const [k, fp] of Object.entries(fps)) {
    if (cur.marks[k] && cur.marks[k].lastRx > t0) continue;
    delete cur.marks[k];
    cur.cells[k] = { fp, since: now, typed: false, windowMs: W, due: now };
    cur.gaveUp ??= {};
    cur.gaveUp[k] = { fp, at: now };
  }
  return pruneWatch(cur, now);
}

/** What the watch's alarm found due. */
export interface AlarmStep {
  watch: CardWatch | undefined;
  converge: boolean;
  retry: boolean;
  /** Marks whose lease ended (retry off). */
  expired: string[];
  /** Marks given up (retry on: TTL, or tries). */
  abandoned: string[];
}

/** When a cell is due for a converge: its own `due` when it has one (a candidate: at once; a converge whose
 *  activity-log read failed: LOG_RETRY_MS later, even though its hold ended long ago), else when its hold ends. */
function cellDueAt(c: WatchCell): number {
  return c.due ?? c.since + c.windowMs;
}

/** THE WATCH'S ALARM, pure: queue a converge, retry or expire marks. The caller does the I/O after. */
export function reduceAlarm(w: CardWatch | undefined, now: number, W: number, retryOn: boolean): AlarmStep {
  if (!w) return { watch: undefined, converge: false, retry: false, expired: [], abandoned: [] };
  const cur = clone(w);
  const expired: string[] = [], abandoned: string[] = [];
  let retry = false;
  for (const [k, m] of Object.entries(cur.marks)) {
    if (retryOn) {
      const due = now >= retryDueAt(m);
      // Spent marks go at once; an edit made before the card was linked goes when it would otherwise be re-sent.
      if (markSpent(m, now) || (due && madeBeforeLink(cur, m))) { abandonMark(cur, k, now, W); abandoned.push(k); }
      else if (due) { retry = true; m.retryQueuedAt = now; }
    } else if (now - m.firstRx >= MARK_LEASE_MS) {
      delete cur.marks[k];
      expired.push(k);
      // The cell falls back to its own hold clock: the edit's own time.
      if (!cur.cells[k]) cur.cells[k] = { fp: "", since: m.at, typed: false, windowMs: W };
    }
  }
  const pruned = pruneWatch(cur, now);
  let converge = false;
  if (pruned) {
    const due = (pruned.allAt !== undefined && pruned.allAt <= now)
      || Object.entries(pruned.cells).some(([k, c]) => !((c.stuckUntil ?? 0) > now)
        && !isMarkLive(pruned.marks[k], now, retryOn) && cellDueAt(c) <= now);
    if (due && (pruned.convergeQueuedAt === undefined || now - pruned.convergeQueuedAt >= convergeRecheckMs(pruned))) {
      converge = true;
      pruned.convergeQueuedAt = now;
    }
  }
  return { watch: pruned, converge, retry, expired, abandoned };
}

/** When the watch's alarm should next run, never sooner than ALARM_MARGIN_MS; null when nothing is ever due. */
export function nextAlarmAt(w: CardWatch | undefined, now: number, retryOn: boolean): number | null {
  if (!w) return null;
  let next = Infinity;
  const recheck = convergeRecheckMs(w);
  const queuedUntil = w.convergeQueuedAt !== undefined && now - w.convergeQueuedAt < recheck
    ? w.convergeQueuedAt + recheck : -Infinity;
  const convergeAt = (t: number) => Math.max(t, queuedUntil);
  for (const [k, c] of Object.entries(w.cells)) {
    if (c.stuckUntil !== undefined && c.stuckUntil > now) { next = Math.min(next, c.stuckUntil); continue; }
    if (isMarkLive(w.marks[k], now, retryOn)) continue;          // its mark's times are counted below
    next = Math.min(next, convergeAt(cellDueAt(c)));
  }
  if (w.allAt !== undefined) next = Math.min(next, convergeAt(w.allAt));
  for (const m of Object.values(w.marks))
    next = Math.min(next, retryOn ? Math.min(retryDueAt(m), m.firstRx + MARK_TTL_MS) : m.firstRx + MARK_LEASE_MS);
  for (const mem of [w.fwd, w.gaveUp]) for (const v of Object.values(mem ?? {})) next = Math.min(next, v.at + WATCH_RETENTION_MS);
  for (const p of w.pushes ?? []) if (Number.isFinite(p.e)) next = Math.min(next, p.e + PUSH_RETENTION_MS);
  if (!Number.isFinite(next)) return null;
  return Math.max(next, now + ALARM_MARGIN_MS);
}

// ------------------------------------------------------------------------------------------ the Sync State register

/** One Sync State write: `t` (ms) written between `s` and `e`. */
export interface StampNote { t: number; ts: string; s: number; e: number; at: number }

/**
 * A STAMP THAT MAY HAVE BEEN OVERTAKEN (monday has no compare-and-set): this one is OLDER than one already noted --
 * written at or after a newer one -- or an older one's write was still in flight when this one started, and may
 * have landed after it.
 */
export function stampSuspicious(notes: StampNote[], cur: { t: number; s: number }): boolean {
  if (notes.some(n => n.t > cur.t)) return true;
  return notes.some(n => n.t < cur.t && n.e >= cur.s);
}

/** The register's notes still within STAMP_NOTE_WINDOW_MS (a stored value that is not a list reads as none). */
export function liveStampNotes(notes: unknown, now: number): StampNote[] {
  return Array.isArray(notes) ? (notes as StampNote[]).filter(n => n && now - n.at < STAMP_NOTE_WINDOW_MS) : [];
}

/** At most STAMP_NOTES_MAX notes, the most recently noted -- and always the newest stamp among them all. */
export function trimStampNotes(notes: StampNote[]): StampNote[] {
  if (notes.length <= STAMP_NOTES_MAX) return notes;
  const newest = notes.reduce((a, n) => (n.t > a.t ? n : a));
  const kept = notes.slice(-STAMP_NOTES_MAX);
  return kept.includes(newest) ? kept : [newest, ...kept.slice(1)];
}

// ------------------------------------------------------------------------------------------ misc

/** The DEFERRED_SYNC type for a spec's object (the watch's converge and retry items). */
export function eventTypeOfObject(object: string): "contact" | "company" | "deal" | "line_item" | undefined {
  return ({ contacts: "contact", companies: "company", deals: "deal", line_items: "line_item" } as const)[object as
    "contacts" | "companies" | "deals" | "line_items"];
}
