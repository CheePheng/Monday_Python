/**
 * HUBSPOT MARKETING EMAILS, POLLED onto monday Contact timelines.
 *
 * Polled because nothing can push them: HubSpot has no webhook for marketing email events. The source
 * is the legacy Email Events API; what becomes an entry is decided in marketing-emails.ts. This file is
 * the I/O: the gates, two durable cursors, recipient -> contact -> card, and claim -> create -> settle.
 *
 * THE SHAPE IS task-poller.ts's, for the same reason: oldest first, and the watermark only ever moves
 * over work that actually landed, so a failure leaves everything after it unseen rather than silently
 * skipped. The watermark IS the queue. The ActivityRetry DO does not fit -- its alarm re-reads a CRM
 * object by id, and a marketing event has no such object.
 *
 * WHY THE CRON AWAITS THIS (index.ts). A poll can spend a minute or two writing to monday. Cloudflare
 * guarantees the full cron budget only to the promise scheduled() RETURNS; waitUntil is documented at
 * about 30 seconds. A write cut off between create and settle is exactly the lost-response state
 * behind the 136/160 doubled emails, so the promise is returned, never detached. For the same reason
 * the wall clock is bounded INSIDE a poll too: no claim starts once less than CREATE_RESERVE_MS of
 * the budget is left, and every monday call here sits through fewer rate-limit waits than the default.
 *
 * IDEMPOTENCY is the durable registry, keyed exactly like every other synced activity
 * (act:h2m:<object>:<eventKey>:<contactId>). The card's own markers are read ONLY on a stale takeover:
 * reading a busy prospect's whole timeline can come back "unknown", and doing that for every entry
 * would stall the feed on exactly the contacts that matter most.
 *
 * NOTHING MAY STALL THE FEED FOREVER. Every failure that repeats -- one entry's create, one campaign's
 * lookup, one recipient's contact read, one slice too dense to read -- has a poison clock (poisonClock):
 * after POISON_TRIES failures spanning at least POISON_MIN_AGE_MS it is dead-lettered, logged, and
 * stepped over. Until then it stops the cursor where it is, which is the whole point of a watermark.
 *
 * DEPLOY NOTES (what the gates below enforce, and what they cannot):
 *   - MARKETING_CUTOVER_AT is set ONCE, to an instant already past, and never re-passed. A later value
 *     is refused while it is in the future, and a value moved past the stored live watermark is
 *     ignored for reading (the watermark wins) and logged loudly -- but the cleanest cutover is the
 *     one nobody touches again.
 *   - ENABLE_MARKETING_EMAIL_SYNC stays "false" until the precondition in marketing-emails.ts holds
 *     (zero campaign-type/campaign-unknown exclusions for real sends in a dry run), AND while ANY
 *     active monday automation writes Last Activity Date (date_mm7054jz): then every marketing entry
 *     -- and a backfill's thousands -- would stamp it and silence reminders #03/#04/#05. Since
 *     2026-09-30 #09 and #10 are off and workflow 1940472437 stamps the hidden Activity bell
 *     (date_mm7pw446) instead, which nothing reads. scripts/check-activity-doorbell.mjs checks both
 *     structurally (a reminder that only READS Last Activity Date is not a writer); LAD-WRITER or
 *     INCOMPLETE keeps this off. An "Any activity" bell rings for every marketing entry too: one
 *     automation action each, so check the plan's quota before a backfill.
 */
import type { Env } from "./types";
import { hs } from "./hubspot";
import { gql, findItemByColumn } from "./monday";
import { CRM_CONTACTS } from "./config/crm";
import { PORTAL_ID } from "./config";
import { MONDAY_ACTIVITY_TYPE } from "./activities";
import { activitySyncEnabled, staffEmails, alreadyOnCard, internalDomains } from "./activity-sync";
import {
  getWatermark, setWatermark, claimActivityToMonday, settleActivityToMonday, unresolvedActivityToMonday,
  peekActivityToMonday, releaseActivity, h2mReservationKey, acquireLock, releaseLock, readNote, writeNote,
  readNoteStrict,
} from "./activity-registry";
import { activityRetryBound, deadLetterStub } from "./activity-retry";
import { writeModeFor } from "./run-opts";
import {
  planEntries, campaignIdsNeeded, isStaffEmail, parseCanaryIds, eventKey, MARKETING_OBJECTS,
  type MarketingEvent, type CampaignInfo, type PlannedEntry,
} from "./marketing-emails";

/** MondayRateLimitedError's name -- matched by name, as activity-sync.ts does. */
const MONDAY_RATE_LIMITED = "MondayRateLimitedError";

/** Re-read this far behind the live watermark: an event indexed a moment after the last read. */
export const OVERLAP_MS = 30 * 60_000;
/** Events newer than this are not yet "complete": no cursor ever claims the last half hour. */
export const SETTLE_MS = 30 * 60_000;
/** One slice of the event stream per read; a cursor that is days behind walks forward a day at a time. */
export const SLICE_MS = 24 * 3_600_000;
export const MAX_SLICES_PER_PHASE = 7;
/** Once a day, look at the last 48 hours again whatever the watermark says (the Task-watermark lesson). */
export const REREAD_MS = 48 * 3_600_000;
/**
 * The re-read's per-poll bound. It re-plans every event of 48 hours and pays a registry read for each;
 * after a blast (the peak week held 2,037 sends) that is well over a thousand Durable Object calls in
 * one invocation. So it resumes from a note instead, this many entries a poll.
 */
export const MAX_REREAD_ENTRIES = 400;
/** A contact's card can lag its first email; wait this long before giving up on a missing card. */
export const NO_CARD_GRACE_MS = 60 * 60_000;
export const DEFAULT_MAX_WRITES = 60;
/** Wall-clock budget, well inside the 15-minute cron limit and the next tick. */
export const POLL_BUDGET_MS = 10 * 60_000;
export const LOCK_HOLD_MS = 14 * 60_000;
/**
 * No claim starts with less than this left of the budget. A claim can lead to a stale-takeover walk
 * and a create, each with its own rate-limit waits; started at the last second of the budget they would
 * run past LOCK_HOLD_MS -- the next cron takes the lock over -- or past the cron limit, which cuts the
 * invocation between create and settle.
 */
export const CREATE_RESERVE_MS = 90_000;
/** monday rate-limit waits per call here (up to 65 s each), against gql's default six. */
export const POLL_RATE_WAITS = 2;
/**
 * A failure this many times, over at least this long, is poison: dead-letter it and move on. The AGE
 * is the real clock -- an entry blocked on its own in-flight reservation fails once a poll, so the
 * tries alone would let one bad entry hold every contact's feed for hours.
 */
export const POISON_TRIES = 3;
export const POISON_MIN_AGE_MS = 60 * 60_000;
export const EVENTS_PAGE = 1000;
/**
 * OUR OWN BOUND, not HubSpot's: offset paging has no documented cap, but one invocation's subrequests
 * and CPU do. A slice with more events than this is halved, down to MIN_SLICE_MS.
 */
export const MAX_EVENT_PAGES = 10;
export const MIN_SLICE_MS = 5 * 60_000;
/** A ledger page stays far below a Durable Object value's 128 KiB; a fuller hour spills to page 1, 2... */
export const LEDGER_PAGE_CHARS = 100_000;
export const LEDGER_PAGES = 24;

export const WM_LIVE = "marketing_email";
export const WM_BACKFILL = "marketing_email_backfill";
export const NOTE_REREAD = "marketing_email_reread";
const LOCK_NAME = "marketing-email-poll";
export const ledgerName = (hour: string, page = 0) => page ? `mkt-ledger:${hour}:${page}` : `mkt-ledger:${hour}`;
export const triesName = (e: PlannedEntry, contactId: string) => `mkt-tries:${e.object}:${e.id}:${contactId}`;
export const campaignTriesName = (id: string) => `mkt-campaign-tries:${id}`;
export const sliceTriesName = (phase: string, fromMs: number) => `mkt-slice-tries:${phase}:${fromMs}`;

export interface MarketingPollOpts {
  /** Force a dry run whatever DRY_RUN says (the on-demand route). A dry run can never be forced OFF. */
  dryRun?: boolean;
  /** Lower the write cap for this run (canary / on-demand). Never raises it. */
  maxWrites?: number;
  /** Test seam for "now". */
  nowMs?: number;
}

export interface MarketingPollResult {
  status: "ran" | "disabled" | "refused" | "busy";
  reason?: string;
  dryRun: boolean;
  canary: boolean;
  scanned: number; planned: number; written: number; wouldWrite: number;
  skipped: number; failures: number; deadLettered: number;
  excluded: Record<string, number>;
  /** Things an operator must hear about even when the poll "worked" (a moved cutover, a dense slice). */
  warnings: string[];
  watermark: { live?: string[]; backfill?: string[] };
  reread: "done" | "not-due" | "incomplete" | "not-run";
  /** Dry run only: what WOULD have been written, first few. */
  sample: Array<{ object: string; id: string; contactId: string; cardId: string; title: string; timestamp: string }>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A timestamp an operator set on purpose: parseable, and not absurd. Anything else is "unset". */
export function parseInstant(v: string | undefined): number | null {
  const raw = String(v ?? "").trim();
  // A full date at least: Date.parse("2026") is a perfectly good 1 January, and nobody meant that.
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > Date.parse("2020-01-01T00:00:00Z") && ms < Date.parse("2100-01-01T00:00:00Z")
    ? ms : null;
}

/**
 * The per-poll write cap. "0" is an operator PAUSING writes, and means exactly that -- it used to fall
 * through to the default 60, the opposite of what anyone typing it meant. Unset or junk is the default.
 */
export function maxWritesPerPoll(env: Env): number {
  const raw = String(env.MARKETING_MAX_WRITES_PER_POLL ?? "").trim();
  if (raw === "0") return 0;
  const n = Number(raw || DEFAULT_MAX_WRITES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_WRITES;
}

/**
 * EVERY GATE, before a single call. Each is a way this could write when nobody meant it to:
 *   - on the Work Management Worker (it shares this source; it must never poll);
 *   - with the feature flag, or the activity kill switch, anything but the literal "true";
 *   - with writes paused (MARKETING_MAX_WRITES_PER_POLL "0");
 *   - with no monday activity type (the entries would have nowhere honest to go);
 *   - with no cutover (the live cursor would have to guess where to start);
 *   - with a cutover in the FUTURE. A planned go-live time looks harmless and is not: the backfill
 *     would run up to it and store it as its watermark, while the live cursor and the re-read both
 *     start at it -- so every event between now and then would be read by nobody, ever.
 */
export function marketingGate(env: Env, nowMs = Date.now()): { ok: true; cutoverMs: number; typeId: string }
    | { ok: false; status: "disabled" | "refused"; reason: string } {
  if (env.ENABLE_CRM !== "true") return { ok: false, status: "refused", reason: "not the CRM Worker" };
  if (env.ENABLE_MARKETING_EMAIL_SYNC !== "true")
    return { ok: false, status: "disabled", reason: "ENABLE_MARKETING_EMAIL_SYNC is not \"true\"" };
  if (!activitySyncEnabled(env))
    return { ok: false, status: "disabled", reason: "ENABLE_ACTIVITY_SYNC is off (the kill switch for every timeline write)" };
  if (maxWritesPerPoll(env) === 0)
    return { ok: false, status: "disabled", reason: "MARKETING_MAX_WRITES_PER_POLL is \"0\" (writes paused)" };
  const typeId = MONDAY_ACTIVITY_TYPE[MARKETING_OBJECTS.send] ?? "";
  if (!typeId) return { ok: false, status: "refused",
    reason: "the monday \"HubSpot Marketing Email\" activity type is not set in activities.ts (run scripts/create-marketing-activity-type.mjs)" };
  const cutoverMs = parseInstant(env.MARKETING_CUTOVER_AT);
  if (cutoverMs === null) return { ok: false, status: "refused", reason: "MARKETING_CUTOVER_AT is unset or unparseable" };
  if (cutoverMs > nowMs) return { ok: false, status: "refused",
    reason: `MARKETING_CUTOVER_AT is in the future (${iso(cutoverMs)}); set it to an instant already past` };
  return { ok: true, cutoverMs, typeId };
}

/** Everything one poll carries between phases. */
interface Run {
  env: Env; now: number; deadline: number; dryRun: boolean; cap: number; used: number;
  typeId: string; cutoverMs: number;
  staff: Set<string>; internal: Set<string>; canary: Set<string> | null;
  campaigns: Map<string, CampaignInfo | null>;
  contactOf: Map<string, string | null>;
  /** Entries already decided THIS run. The re-read and a backfill overlapping the live window see the
   *  same events; deciding each once keeps the counts honest and a dry run from reporting it twice. */
  decided: Set<string>;
  /** Events already planned this run, for the same reason: a later phase re-reading them adds nothing
   *  but double counts. Safe to drop, because a phase that stopped short on a FAILURE ends the run's
   *  later phases, and the phases that still run after a budget stop read disjoint ranges. */
  seenEvents: Set<string>;
  /** Entries the current phase may still hand to deliver() (the re-read's bound; otherwise unbounded). */
  entryBudget: number;
  ledger: { hour: string; page: number; text: string } | null;
  r: MarketingPollResult;
}

const emptyResult = (dryRun: boolean, canary: boolean): MarketingPollResult => ({
  status: "ran", dryRun, canary, scanned: 0, planned: 0, written: 0, wouldWrite: 0, skipped: 0, failures: 0,
  deadLettered: 0, excluded: {}, warnings: [], watermark: {}, reread: "not-run", sample: [],
});

const count = (run: Run, why: string) => { run.r.excluded[why] = (run.r.excluded[why] ?? 0) + 1; };
const outOfBudget = (run: Run) => run.used >= run.cap || Date.now() > run.deadline;
const warn = (run: Run, text: string) => {
  run.r.warnings.push(text);
  console.log(`[mkt-poller] action=warning reason="${text}"`);
};
/** The HTTP status in hs()'s error text ("hubspot GET /path: 403 ..."), or null for a network error. */
const httpStatus = (e: unknown): number | null => {
  const m = /: (\d{3}) /.exec(String(e));
  return m ? Number(m[1]) : null;
};
/**
 * A problem with the TOKEN, not with the thing asked about: a 401, or a 403 naming a missing scope.
 * Never read as an answer about one campaign or one recipient -- that would exclude every campaign in
 * turn and let the cursor sail past all of them. It stops the feed, as a failure, until someone fixes
 * the token (the local token answered exactly this, MISSING_SCOPES, on 2026-09-30).
 */
const tokenProblem = (e: unknown, s: number | null) =>
  s === 401 || (s === 403 && /MISSING_SCOPES|scope/i.test(String(e)));
/** A 4xx that will say the same thing next time: not a blip, an answer about THIS request. */
const permanent4xx = (e: unknown, s: number | null) =>
  s !== null && s >= 400 && s < 500 && s !== 429 && !tokenProblem(e, s);

export async function pollMarketingEmails(env: Env, opts: MarketingPollOpts = {}): Promise<MarketingPollResult> {
  const canaryIds = parseCanaryIds(env.MARKETING_CANARY_CONTACT_IDS);
  const dryRun = opts.dryRun === true || writeModeFor(env, 0).dryRun;
  const r = emptyResult(dryRun, !!canaryIds);
  const now = opts.nowMs ?? Date.now();

  const gate = marketingGate(env, now);
  if (!gate.ok) {
    r.status = gate.status; r.reason = gate.reason;
    console.log(`[mkt-poller] action=${gate.status} reason="${gate.reason}"`);
    return r;
  }

  // A dry run writes NOTHING durable, the lock included; two dry runs racing cost only reads.
  const runId = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  if (!dryRun && !(await acquireLock(env, LOCK_NAME, LOCK_HOLD_MS, runId))) {
    r.status = "busy"; r.reason = "another marketing poll holds the lock";
    console.log(`[mkt-poller] action=busy reason="${r.reason}"`);
    return r;
  }
  const cap = Math.max(0, Math.min(maxWritesPerPoll(env), opts.maxWrites ?? Number.POSITIVE_INFINITY));
  const run: Run = {
    env, now, deadline: Date.now() + POLL_BUDGET_MS, dryRun, cap, used: 0,
    typeId: gate.typeId, cutoverMs: gate.cutoverMs, staff: new Set(), internal: new Set(), canary: canaryIds,
    campaigns: new Map(), contactOf: new Map(), decided: new Set(), seenEvents: new Set(),
    entryBudget: Number.POSITIVE_INFINITY, ledger: null, r,
  };
  /**
   * A CANARY KEEPS ITS OWN CURSORS. Advancing the production cursors past everyone else's events while
   * only the canary contact is in scope would make those events invisible forever once the canary is
   * lifted. The registry is shared, so whatever the canary wrote is simply "have" to production later.
   */
  const suffix = canaryIds ? ":canary" : "";

  try {
    /**
     * FAIL CLOSED on the staff list. Without it every colleague's copy of every internal test send
     * would land on their own Contact card, which is the incident the staff rule exists for.
     */
    try { run.staff = await staffEmails(env); run.internal = internalDomains(run.staff); }
    catch (e) {
      r.failures++; r.reason = `staff list unreadable: ${String(e).slice(0, 100)}`;
      console.log(`[mkt-poller] action=refused reason="${r.reason}" -- nothing written, cursors unchanged`);
      return r;
    }

    const liveDone = await livePhase(run, WM_LIVE + suffix);
    if (liveDone) {
      /**
       * The backfill waits only on a re-read that FAILED. One that merely ran out of its per-poll bound
       * resumes next poll from its note -- blocking the backfill on that would stop it for as long as a
       * blast stays inside the 48-hour window.
       */
      const failuresBefore = r.failures;
      await rereadPhase(run, NOTE_REREAD + suffix);
      if (r.failures === failuresBefore) await backfillPhase(run, WM_BACKFILL + suffix);
    }
  } finally {
    if (!dryRun) await releaseLock(env, LOCK_NAME, runId);
    const w = r.watermark;
    console.log(`[mkt-poller] scanned=${r.scanned} planned=${r.planned} written=${r.written}`
      + ` wouldWrite=${r.wouldWrite} skipped=${r.skipped} failures=${r.failures} dead=${r.deadLettered}`
      + ` watermark=${w.live ? w.live.join(" -> ") : "-"} backfill=${w.backfill ? w.backfill.join(" -> ") : "-"}`
      + ` reread=${r.reread} dryRun=${dryRun} canary=${!!canaryIds}`
      + ` excluded=${JSON.stringify(r.excluded)}${r.warnings.length ? ` warnings=${r.warnings.length}` : ""}`);
  }
  return r;
}

/** Only ever forward, and never in a dry run: a dry run that moved a cursor would hide real work. */
async function advance(run: Run, name: string, before: string, high: number | null): Promise<string> {
  if (high === null || high <= Date.parse(before)) return before;
  const after = iso(high);
  if (run.dryRun) return before;
  await setWatermark(run.env, name, after);    // throws: never report progress that was not saved
  return after;
}

/** Returns whether the live phase completed -- later phases only run behind a healthy live feed. */
async function livePhase(run: Run, name: string): Promise<boolean> {
  const stored = await getWatermark(run.env, name);
  const before = stored ?? iso(run.cutoverMs);
  let from: number;
  if (stored !== null && Date.parse(stored) < run.cutoverMs) {
    /**
     * THE CUTOVER MOVED PAST THE WATERMARK -- a redeploy re-passed --var MARKETING_CUTOVER_AT=<deploy
     * time>. Clamping to the new cutover would jump the gap silently: the backfill only covers what
     * is BEFORE its start, and nothing else would ever read [watermark, new cutover]. The stored
     * watermark is the truth about what has been read, so reading carries on from it, loudly.
     */
    warn(run, `MARKETING_CUTOVER_AT (${iso(run.cutoverMs)}) is later than the stored live watermark (${stored}): `
      + `reading on from the watermark, not jumping the gap. Set the cutover once and never re-pass it.`);
    from = Date.parse(stored) - OVERLAP_MS;
  } else {
    // Never before the cutover: the backfill cursor owns everything earlier, and may be deliberately off.
    from = Math.max(Date.parse(before) - OVERLAP_MS, run.cutoverMs);
  }
  let c: CursorResult = { high: null, completed: false };
  try { c = await runCursor(run, "live", from, run.now, true); }
  catch (e) { phaseFailed(run, "live", e); }
  run.r.watermark.live = [before, await advance(run, name, before, c.high)];
  return c.completed;
}

/**
 * THE DAILY 48-HOUR RE-READ, resumable. Its note holds "YYYY-MM-DD" once today's pass is complete, or
 * "YYYY-MM-DD|<ms>" -- how far today's pass has got -- while it is not. A new day starts a new pass.
 */
async function rereadPhase(run: Run, name: string): Promise<void> {
  const today = iso(run.now).slice(0, 10);
  const [day, pos] = String((await readNote(run.env, name)) ?? "").split("|");
  if (day === today && !pos) { run.r.reread = "not-due"; return; }
  const start = Math.max(run.now - REREAD_MS, run.cutoverMs);
  const from = day === today && Number.isFinite(Number(pos)) ? Math.max(start, Number(pos)) : start;
  let c: CursorResult = { high: null, completed: false };
  run.entryBudget = MAX_REREAD_ENTRIES;
  try { c = await runCursor(run, "reread", from, run.now, true); }
  catch (e) { phaseFailed(run, "reread", e); }
  finally { run.entryBudget = Number.POSITIVE_INFINITY; }
  run.r.reread = c.completed ? "done" : "incomplete";
  if (run.dryRun) return;
  if (c.completed) await writeNote(run.env, name, today);
  else if (c.high !== null && c.high > from) await writeNote(run.env, name, `${today}|${c.high}`);
}

async function backfillPhase(run: Run, name: string): Promise<void> {
  const raw = String(run.env.MARKETING_BACKFILL_FROM ?? "").trim();
  if (!raw) return;
  const fromMs = parseInstant(raw);
  // A value we cannot read is a request for a bulk write we cannot interpret: do not guess at it.
  if (fromMs === null || fromMs >= run.cutoverMs) {
    console.log(`[mkt-poller] phase=backfill action=refused reason="MARKETING_BACKFILL_FROM=${JSON.stringify(raw.slice(0, 40))} is not an instant before MARKETING_CUTOVER_AT"`);
    return;
  }
  const stored = await getWatermark(run.env, name);
  const before = stored ?? iso(fromMs);
  if (Date.parse(before) >= run.cutoverMs) { run.r.watermark.backfill = [before, before]; return; }
  /**
   * NEVER PAST now - SETTLE_MS. The backfill claims every instant it reaches (no settle tail), and the
   * live cursor starts exactly AT the cutover with no overlap before it -- so a backfill that reached a
   * cutover under half an hour old would vouch for events HubSpot has not finished indexing, and no
   * cursor would ever read them. It reaches the cutover a poll or two later instead.
   */
  const untilMs = Math.min(run.cutoverMs, run.now - SETTLE_MS);
  if (Date.parse(before) >= untilMs) { run.r.watermark.backfill = [before, before]; return; }
  const from = stored ? Math.max(Date.parse(before) - OVERLAP_MS, fromMs) : fromMs;
  let c: CursorResult = { high: null, completed: false };
  try { c = await runCursor(run, "backfill", from, untilMs, false); }
  catch (e) { phaseFailed(run, "backfill", e); }
  run.r.watermark.backfill = [before, await advance(run, name, before, c.high)];
}

function phaseFailed(run: Run, phase: string, e: unknown): void {
  run.r.failures++;
  console.log(`[mkt-poller] phase=${phase} action=error reason="${String(e).slice(0, 160)}" -- cursor not advanced past it`);
}

interface CursorResult { high: number | null; completed: boolean }

/**
 * Walk [fromMs, untilMs] a slice at a time. `high` is the furthest instant everything before which
 * has been handled; `completed` means the whole range was.
 *
 * `settleTail`: at the live edge nothing vouches for an instant newer than now - SETTLE_MS -- neither
 * a finished slice NOR a delivered entry. A recent entry used to pull the watermark up to itself (the
 * live edge), so the next read reached only OVERLAP_MS behind that entry and an event HubSpot indexed
 * late waited up to a day for the re-read.
 *
 * A slice that THROWS keeps what the slices before it achieved: the error is counted and the cursor
 * stops there, rather than the whole phase reporting no progress at all.
 */
async function runCursor(run: Run, phase: string, fromMs: number, untilMs: number,
    settleTail: boolean): Promise<CursorResult> {
  let cur = fromMs, high: number | null = null;
  const settleCap = run.now - SETTLE_MS;
  const up = (v: number | null) => {
    if (v === null) return;
    const w = settleTail ? Math.min(v, settleCap) : v;
    high = high === null ? w : Math.max(high, w);
  };
  for (let s = 0; s < MAX_SLICES_PER_PHASE; s++) {
    if (cur >= untilMs) return { high, completed: true };
    if (outOfBudget(run)) return { high, completed: false };
    let slice: SliceResult;
    try { slice = await runSlice(run, phase, cur, Math.min(cur + SLICE_MS, untilMs)); }
    catch (e) { phaseFailed(run, phase, e); return { high, completed: false }; }
    up(slice.handledTo);
    if (!slice.completed) return { high, completed: false };
    up(slice.end);
    if (settleTail && settleCap < slice.end) return { high, completed: true };   // reached the live edge
    cur = slice.end;
  }
  return { high, completed: cur >= untilMs };
}

interface SliceResult { end: number; handledTo: number | null; completed: boolean }

async function runSlice(run: Run, phase: string, from: number, to: number): Promise<SliceResult> {
  let end = to;
  let events: MarketingEvent[] | null;
  for (;;) {
    events = await fetchEvents(run.env, from, end);
    if (events) break;
    if (end - from <= MIN_SLICE_MS) return denseSlice(run, phase, from, end);
    end = from + Math.floor((end - from) / 2);
    console.log(`[mkt-poller] phase=${phase} action=halved from=${iso(from)} to=${iso(end)}`);
  }
  events = events.filter(e => {
    const k = eventKey(e.id, e.created);
    if (run.seenEvents.has(k)) return false;
    run.seenEvents.add(k); return true;
  });
  run.r.scanned += events.length;

  await loadCampaigns(run, campaignIdsNeeded(events));
  const plan = planEntries(events, run.campaigns, { portalId: String(PORTAL_ID) });
  for (const [k, v] of Object.entries(plan.excluded)) run.r.excluded[k] = (run.r.excluded[k] ?? 0) + v;
  await resolveContacts(run, plan.entries);

  let handledTo: number | null = null;
  for (const e of plan.entries) {
    // Everything strictly before this entry is handled: the events between the last entry and this
    // one produced nothing, and a same-millisecond sibling is re-read by the overlap regardless.
    const upTo = handledTo === null ? e.createdMs - 1 : Math.max(handledTo, e.createdMs - 1);
    if (outOfBudget(run) || run.entryBudget <= 0) return { end, handledTo: upTo, completed: false };
    run.entryBudget--;
    if ((await deliver(run, e)) === "stop") return { end, handledTo: upTo, completed: false };
    run.decided.add(decidedKey(e));
    handledTo = e.createdMs;
  }
  return { end, handledTo, completed: true };
}

/**
 * MORE THAN MAX_EVENT_PAGES OF EVENTS IN MIN_SLICE_MS -- a window this poller cannot read in one go.
 * It fails the slice (the cursor stays put) until its poison clock runs out; then it is stepped over,
 * loudly, because a window that can never be read would otherwise end the feed for every contact. The
 * events inside it are not read: that is the price, and the log and dead letter say so.
 */
async function denseSlice(run: Run, phase: string, from: number, end: number): Promise<SliceResult> {
  const why = `more than ${MAX_EVENT_PAGES * EVENTS_PAGE} events within ${MIN_SLICE_MS / 60_000} min of ${iso(from)}`;
  const p = await poisonClock(run, sliceTriesName(phase, from));
  if (!p.dead) throw new Error(`${why} (try ${p.n})`);
  count(run, "slice-too-dense");
  warn(run, `phase=${phase} stepped over ${iso(from)}..${iso(end)}: ${why}, failing since ${iso(p.firstAt)} -- those events were NOT read`);
  await recordDeadLetter(run, "marketing_email_slices", `${phase}:${from}`, why, p);
  return { end, handledTo: end, completed: true };
}

/** GET /email/public/v1/events for one window, every page. null = more pages than one slice may take. */
async function fetchEvents(env: Env, from: number, to: number): Promise<MarketingEvent[] | null> {
  const out: MarketingEvent[] = [];
  let offset: string | undefined;
  for (let p = 0; p < MAX_EVENT_PAGES; p++) {
    const q = new URLSearchParams({ startTimestamp: String(from), endTimestamp: String(to),
      excludeFilteredEvents: "true", limit: String(EVENTS_PAGE) });
    if (offset) q.set("offset", offset);
    const res = await hs(env, "GET", `/email/public/v1/events?${q.toString()}`, undefined, 2);
    for (const raw of res?.events ?? []) out.push(normalizeEvent(raw));
    if (!res?.hasMore || !res?.offset) return out;
    offset = String(res.offset);
  }
  return null;
}

/** The documented shape, coerced: ids as strings, times as numbers, whatever the JSON used. */
function normalizeEvent(raw: any): MarketingEvent {
  const sentBy = raw?.sentBy && raw.sentBy.id != null
    ? { id: String(raw.sentBy.id), created: Number(raw.sentBy.created) } : undefined;
  return { ...raw, id: String(raw?.id ?? ""), created: Number(raw?.created), type: String(raw?.type ?? ""), sentBy };
}

/**
 * One lookup per campaign per run, and a failure belongs to ITS campaign, not to the slice.
 *   - 404 (an email since deleted) is an answer -- "not a campaign we can show" -- cached as such.
 *   - Any other 4xx but 429 (a ticket, feedback or deleted-type campaign the token may not read) is an
 *     answer too, and will be the same answer next poll: cached as unreadable, counted, logged. NOT a
 *     401 or a missing-scope 403: that is the token, not the campaign, and it stops the feed.
 *   - Anything else (5xx, 429, network) stops the slice unadvanced, until that campaign's poison clock
 *     runs out; then it too is cached as unreadable and dead-lettered. Without this one campaign that
 *     HubSpot cannot serve would hold the live feed -- and the re-read and backfill behind it -- forever.
 * A campaign cached as unreadable excludes its events as "campaign-unknown".
 */
async function loadCampaigns(run: Run, ids: string[]): Promise<void> {
  for (const id of ids) {
    if (run.campaigns.has(id)) continue;
    try {
      const c = await hs(run.env, "GET", `/email/public/v1/campaigns/${encodeURIComponent(id)}`, undefined, 2);
      run.campaigns.set(id, c ? {
        id: String(c.id ?? id), name: c.name ?? undefined, subject: c.subject ?? undefined, type: c.type ?? undefined,
        contentId: c.contentId != null ? String(c.contentId) : undefined,
      } : null);
    } catch (e) {
      const status = httpStatus(e);
      if (status === 404) { run.campaigns.set(id, null); continue; }
      if (tokenProblem(e, status)) throw e;
      if (permanent4xx(e, status)) {
        run.campaigns.set(id, null); count(run, `campaign-error:${status}`);
        console.log(`[mkt-poller] campaign=${id} action=unreadable status=${status} reason="${String(e).slice(0, 120)}" -- its events are excluded`);
        continue;
      }
      const p = await poisonClock(run, campaignTriesName(id));
      if (!p.dead) throw e;
      run.campaigns.set(id, null); count(run, "campaign-unreadable");
      console.log(`[mkt-poller] campaign=${id} action=dead-lettered tries=${p.n} reason="${String(e).slice(0, 120)}" -- its events are excluded`);
      await recordDeadLetter(run, "marketing_email_campaigns", id, String(e).slice(0, 160), p);
    }
  }
}

/**
 * Recipient email -> HubSpot contact id, 100 at a time, staff never asked about. An address with no
 * contact is cached as null and skipped: there is no card it could belong to.
 */
async function resolveContacts(run: Run, entries: PlannedEntry[]): Promise<void> {
  const want = [...new Set(entries.map(e => e.recipientEmail))]
    .filter(m => !run.contactOf.has(m) && !isStaffEmail(m, run.staff, run.internal));
  for (let i = 0; i < want.length; i += 100) await readContactsByEmail(run, want.slice(i, i + 100));
}

/**
 * ONE MALFORMED ADDRESS MUST NOT BLOCK NINETY-NINE GOOD ONES. A batch read by email answers 400 for the
 * whole chunk when one input is bad, and would do so every poll: the chunk is split until the bad
 * address stands alone, and an address HubSpot refuses on its own is an unknown recipient.
 */
async function readContactsByEmail(run: Run, emails: string[]): Promise<void> {
  let res: any;
  try {
    res = await hs(run.env, "POST", "/crm/v3/objects/contacts/batch/read",
      { idProperty: "email", properties: ["email"], inputs: emails.map(id => ({ id })) }, 2);
  } catch (e) {
    const status = httpStatus(e);
    if (status === 404) res = { results: [] };          // "none of these exist" is an answer, not a failure
    else if (!permanent4xx(e, status)) throw e;
    else if (emails.length > 1) {
      const half = Math.ceil(emails.length / 2);
      await readContactsByEmail(run, emails.slice(0, half));
      await readContactsByEmail(run, emails.slice(half));
      return;
    } else {
      count(run, "recipient-unreadable");
      console.log(`[mkt-poller] recipient=${emails[0]} action=unreadable status=${status} -- treated as an unknown recipient`);
      res = { results: [] };
    }
  }
  const found = new Map<string, string>();
  for (const c of res?.results ?? [])
    found.set(String(c?.properties?.email ?? "").trim().toLowerCase(), String(c.id));
  for (const m of emails) run.contactOf.set(m, found.get(m) ?? null);
}

type Step = "done" | "stop";
const decidedKey = (e: PlannedEntry) => `${e.object}|${e.id}|${e.recipientEmail}`;
const isDeadNote = (note: string | null) => String(note ?? "").split("|")[2] === "dead";

/** One planned entry onto one Contact card. "stop" leaves it (and everything after it) for next time. */
async function deliver(run: Run, e: PlannedEntry): Promise<Step> {
  const { env, r } = run;
  const log = (action: string, extra = "") =>
    console.log(`[mkt-poller] ${e.object}=${e.id} action=${action}${extra ? " " + extra : ""}`);

  if (run.decided.has(decidedKey(e))) return "done";
  r.planned++;
  if (isStaffEmail(e.recipientEmail, run.staff, run.internal)) { r.skipped++; count(run, "staff"); return "done"; }
  const contactId = run.contactOf.get(e.recipientEmail) ?? null;
  if (!contactId) { r.skipped++; count(run, "unknown-recipient"); return "done"; }
  if (run.canary && !run.canary.has(contactId)) { r.skipped++; count(run, "outside-canary"); return "done"; }

  const peek = await peekActivityToMonday(env, e.object, e.id, "contact", contactId);
  if (peek === "have") { r.skipped++; count(run, "already-written"); return "done"; }
  if (peek === "unknown") { r.failures++; log("blocked", 'reason="idempotency store unreadable"'); return "stop"; }
  /**
   * A DEAD LETTER STAYS DEAD. Checked before the card lookup, so an entry already dead-lettered that
   * the overlap or the re-read reaches again costs one read -- not a card lookup, a claim, a possible
   * stall on its own reservation, and a create that could land an entry /activity-dead-letters says
   * was never written. Read only for entries not yet written: the common "have" never pays for it.
   */
  const tries = await readNote(env, triesName(e, contactId));
  if (isDeadNote(tries)) { r.skipped++; count(run, "dead-lettered-earlier"); return "done"; }

  let card: { id: string } | undefined;
  try { card = (await findItemByColumn(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, contactId, POLL_RATE_WAITS))[0]; }
  catch (err) {
    r.failures++; log("card-lookup-failed", `contact=${contactId} reason="${String(err).slice(0, 100)}"`);
    return "stop";
  }
  if (!card) {
    // A new contact's card can lag its confirmation email by minutes. Wait -- but not forever.
    if (run.now - e.createdMs < NO_CARD_GRACE_MS) { log("waiting", `contact=${contactId} reason="no card yet"`); return "stop"; }
    r.skipped++; count(run, "no-card");
    log("abandoned", `reason=no-card contact=${contactId} age=${Math.round((run.now - e.createdMs) / 60_000)}min`);
    return "done";
  }

  if (run.dryRun) {
    run.used++; r.wouldWrite++;
    if (r.sample.length < 25)
      r.sample.push({ object: e.object, id: e.id, contactId, cardId: String(card.id), title: e.title, timestamp: e.timestamp });
    return "done";
  }

  // Too little time left to claim, maybe walk, create AND settle: leave it for the next poll, untouched.
  if (run.deadline - Date.now() < CREATE_RESERVE_MS) {
    log("deferred", 'reason="too little of the poll budget left to create and settle"');
    return "stop";
  }

  const claim = await claimActivityToMonday(env, e.object, e.id, "contact", contactId);
  if (claim.status === "have") { r.skipped++; count(run, "already-written"); return "done"; }
  /**
   * AN IN-FLIGHT RESERVATION IS A FAILURE, and counts as one. Behind the lock nothing else is writing,
   * so "creating" means an earlier attempt of OURS reserved and never settled (a create whose response
   * was lost, a cut-off invocation). It holds the cursor like any failure -- visible in failures= and
   * on the poison clock, instead of a silent stall that reported failures=0 for hours.
   */
  if (claim.status === "creating") return failed(run, e, contactId, "reservation-in-flight (an earlier attempt never settled)");
  if (claim.status === "blocked") { r.failures++; log("blocked", 'reason="idempotency store unavailable"'); return "stop"; }
  if (claim.tookOverStale) {
    // A previous attempt reserved and never settled: its write may have landed. Look before writing.
    const seen = await alreadyOnCard(env, String(card.id), e.object, e.id,
      { deadlineMs: run.deadline, maxRateWaits: POLL_RATE_WAITS });
    if (seen === "present") {
      await settleActivityToMonday(env, e.object, e.id, "contact", contactId, "already-on-card");
      r.skipped++; count(run, "already-on-card"); return "done";
    }
    if (seen === "unknown") return failed(run, e, contactId, "stale reservation and the card's markers could not be read");
  }

  try {
    const created = await gql(env,
      `mutation ($i: ID!, $a: String!, $t: String!, $s: String!, $c: String!, $ts: ISO8601DateTime!, $u: String) {
         create_timeline_item(item_id:$i, custom_activity_id:$a, title:$t, summary:$s, content:$c,
                              timestamp:$ts, url:$u) { id } }`,
      { i: card.id, a: run.typeId, t: e.title, s: e.summary, c: e.content, ts: e.timestamp, u: e.url ?? null },
      1, POLL_RATE_WAITS);
    const timelineId = String(created?.create_timeline_item?.id ?? "created");
    await settleActivityToMonday(env, e.object, e.id, "contact", contactId, timelineId);
    run.used++; r.written++;
    log("created", `item=${card.id} contact=${contactId} timeline=${timelineId}`);
    await appendLedger(run, [timelineId, card.id, e.object, e.id, contactId].join("|"));
    return "done";
  } catch (err) {
    /**
     * RATE-LIMITED PROVABLY NEVER RAN (monday.ts), so the reservation is released and the next poll
     * simply retries. Leaving it would force a stale takeover in 15 minutes, and that walks the whole
     * card -- the one read that can come back "unknown" on a busy prospect and stall the feed.
     */
    if ((err as Error)?.name === MONDAY_RATE_LIMITED) {
      await releaseActivity(env, h2mReservationKey(e.object, e.id, "contact", contactId));
      r.failures++; log("rate-limited", 'reason="monday rate limit; released, next poll retries"');
      return "stop";
    }
    // Anything else was SENT and may have landed: the reservation stands, the stale path decides later.
    unresolvedActivityToMonday(e.object, e.id, "contact", contactId, err);
    return failed(run, e, contactId, String(err).slice(0, 160));
  }
}

/**
 * THE POISON CLOCK for one repeating failure (an entry, a campaign, a slice): count this failure and
 * say whether it is now poison -- POISON_TRIES failures spanning at least POISON_MIN_AGE_MS. The note
 * is "<tries>|<firstFailureMs>[|dead]". A dry run reads it but never writes it.
 */
async function poisonClock(run: Run, name: string)
    : Promise<{ n: number; firstAt: number; dead: boolean; earlier?: boolean }> {
  const [n0, first0, mark] = String((await readNote(run.env, name)) ?? "").split("|");
  const firstAt = Number(first0) || run.now;
  if (mark === "dead") return { n: Number(n0) || 0, firstAt, dead: true, earlier: true };
  const n = (Number(n0) || 0) + 1;
  const dead = n >= POISON_TRIES && run.now - firstAt >= POISON_MIN_AGE_MS;
  if (!run.dryRun) await writeNote(run.env, name, dead ? `${n}|${firstAt}|dead` : `${n}|${firstAt}`);
  return { n, firstAt, dead };
}

/** Into /activity-dead-letters, where every other stuck activity is listed. Fails soft. */
async function recordDeadLetter(run: Run, object: string, hubspotId: string, reason: string,
    p: { n: number; firstAt: number }): Promise<void> {
  run.r.deadLettered++;
  if (run.dryRun || !activityRetryBound(run.env)) return;
  try {
    await deadLetterStub(run.env).record({ object, hubspotId, reason, attempts: p.n, firstSeenMs: p.firstAt,
      diedAtMs: run.now, terminalReason: `marketing poller: ${reason}` });
  } catch (err) { console.log(`[mkt-poller] ${object}=${hubspotId} action=deadletter-failed reason="${String(err).slice(0, 90)}"`); }
}

/**
 * A FAILURE THAT BELONGS TO THIS ENTRY. Normally it stops the poll where it is. But an entry that fails
 * every time would stop the watermark forever and silently end the whole feed, so once its poison
 * clock runs out it is dead-lettered -- visible in /activity-dead-letters -- and stepped over. Nothing
 * is written for it (its reservation, if any, stands), so no duplicate can follow.
 */
async function failed(run: Run, e: PlannedEntry, contactId: string, reason: string): Promise<Step> {
  run.r.failures++;
  const p = await poisonClock(run, triesName(e, contactId));
  if (p.earlier) { run.r.skipped++; count(run, "dead-lettered-earlier"); return "done"; }
  if (p.dead) {
    await recordDeadLetter(run, e.object, `${e.id}:contact:${contactId}`, reason, p);
    console.log(`[mkt-poller] ${e.object}=${e.id} action=dead-lettered contact=${contactId} tries=${p.n} reason="${reason}"`);
    return "done";
  }
  console.log(`[mkt-poller] ${e.object}=${e.id} action=failed contact=${contactId} tries=${p.n} reason="${reason}"`);
  return "stop";
}

/**
 * THE ROLLBACK LEDGER. The registry is one Durable Object per key and cannot be listed, so without
 * this there is no clean way to find -- let alone delete -- what the poller wrote. Pages per UTC hour
 * (mkt-ledger:<hour>, then :1, :2 ... once a page nears LEDGER_PAGE_CHARS), rows
 * "timelineId|cardId|object|eventKey|contactId", readable through GET /marketing-ledger?hour=YYYY-MM-DDTHH.
 *
 * A PAGE THAT CANNOT BE READ IS NEVER WRITTEN. readNote's soft null would make a storage blip look like
 * an empty page and the next write would replace the rows earlier polls saved; the strict read skips
 * to the next page instead. Fails soft otherwise: the entry is already written and settled, and losing
 * a ledger row must never undo that -- the "created" log line carries the same row.
 */
async function appendLedger(run: Run, row: string): Promise<void> {
  const hour = iso(Date.now()).slice(0, 13);
  if (!run.ledger || run.ledger.hour !== hour) run.ledger = await openLedgerPage(run, hour, 0);
  if (run.ledger && run.ledger.text.length + row.length + 1 > LEDGER_PAGE_CHARS)
    run.ledger = await openLedgerPage(run, hour, run.ledger.page + 1);
  if (!run.ledger) { console.log(`[mkt-poller] action=ledger-lost hour=${hour} row="${row}"`); return; }
  run.ledger.text += (run.ledger.text ? "\n" : "") + row;
  if (!(await writeNote(run.env, ledgerName(hour, run.ledger.page), run.ledger.text)))
    console.log(`[mkt-poller] action=ledger-lost hour=${hour} row="${row}"`);
}

async function openLedgerPage(run: Run, hour: string, fromPage: number): Promise<Run["ledger"]> {
  for (let page = fromPage; page < LEDGER_PAGES; page++) {
    let text: string | null;
    try { text = await readNoteStrict(run.env, ledgerName(hour, page)); }
    catch (e) {
      console.log(`[mkt-poller] action=ledger-page-unreadable page=${ledgerName(hour, page)} reason="${String(e).slice(0, 90)}" -- not overwriting it`);
      continue;
    }
    if (text === null) return { hour, page, text: "" };
    if (text.length < LEDGER_PAGE_CHARS) return { hour, page, text };
  }
  return null;
}

/** Every ledger page for one UTC hour ("YYYY-MM-DDTHH"), parsed. A page may be absent between others. */
export async function readLedger(env: Env, hour: string): Promise<string[][]> {
  const rows: string[][] = [];
  for (let page = 0; page < LEDGER_PAGES; page++) {
    const text = (await readNote(env, ledgerName(hour, page))) ?? "";
    if (text) rows.push(...text.split("\n").map(l => l.split("|")));
  }
  return rows;
}
