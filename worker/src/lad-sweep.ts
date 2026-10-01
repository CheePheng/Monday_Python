/**
 * THE LAST ACTIVITY BACKSTOP: a bounded sweep for the HubSpot events the webhook path dropped.
 *
 * WHY IT EXISTS. Every activity logged in HubSpot produces an association event and, 2-12 s later, a
 * notes_last_updated propertyChange for the same record. Measured 2026-09-30, Last Activity Date reached
 * the card on only 77% of Contacts, 67% of Accounts and 4 of 5 Deals: the second event was coalesced
 * into the first one's in-flight sync, which had already read the record. handleHubspot now runs the
 * latest event (coalesceLatest), but that is per isolate and best-effort, and HubSpot itself drops or
 * delays deliveries. The CRM Worker has no sync cron (deploy-config.test.ts), so a missed event used to
 * leave the card stale until the record next changed. This finds those records and runs the ORDINARY
 * sync on each.
 *
 * WHAT IT READS. Records whose notes_last_updated moved since a durable watermark -- not
 * hs_lastmodifieddate. A marketing send touches thousands of contacts' modified date (the hs_email_*
 * properties), which would bury the handful of real misses under a flood the per-run cap then takes
 * hours to walk. notes_last_updated moves only when an activity is logged, which is exactly the event
 * whose follow-up got lost. The sync it runs is the whole-record one, so anything else stale on that
 * card heals too.
 *
 * NON-FORCED, ALWAYS. syncHubspotRecord without forceForward is the webhook's own path: it writes the
 * card only when HubSpot changed since the card's Sync State, and never writes HubSpot. forceForward
 * would overwrite a person's pending monday edit, which a backstop has no business doing.
 *
 * THE SHAPE IS task-poller.ts's: the watermark only ever moves over work that landed, a failure stops
 * that object where it is, and the watermark FAILS CLOSED (unreadable = do nothing, never "start from
 * the seed"). What differs:
 *   - TWO READS, NOT ONE. NEW WORK is [watermark, settle point], paged with HubSpot's `after` cursor;
 *     it alone moves the watermark. THE OVERLAP is [watermark - OVERLAP_MS, watermark), a bounded
 *     re-check for a record indexed a moment late. One read over both used to STALL FOR GOOD: it asked
 *     for one page of at most 100 rows from the overlap's start, so once the overlap held ~100 records
 *     already synced (a sequence, a bulk task, a call import, one activity on many contacts) every row
 *     returned was one it had seen, nothing new was reached and the watermark never moved -- silently
 *     (reproduced 2026-09-30: 150 contacts in 5 minutes, 30 runs, 100 ever synced). Now a dense
 *     overlap can only cost its own re-check (stoppedBy "pages", logged), never the new work behind it.
 *   - SEEN. The (id, notes_last_updated) pairs already synced inside the overlap are remembered and
 *     stepped over at no cost. A record that changes again has a new timestamp and is synced again.
 *   - TIES. Records sharing the watermark's exact millisecond sit at the head of NEW WORK. More than
 *     NEW_PAGES pages of them, every one already seen, would stall it the same way; then the watermark
 *     steps 1 ms past them, loudly (action=tie-skipped).
 *   - POISON. One record whose sync always throws would stall its object forever; after POISON_TRIES
 *     failures spanning at least POISON_MIN_AGE_MS it is logged as dead and stepped over. The AGE is the
 *     real clock (the marketing poller's rule): three busy ticks of monday complexity limits are 30-45
 *     minutes, not a dead record. The one open failure per object lives in the seen note, so it is
 *     cleaned up by the success or dead-letter that ends it.
 *
 * BOUNDED, AND AWAITED. It runs inside the 15-minute cron AFTER the marketing poll, in the same returned
 * promise (index.ts): never beside it, so the sweep's syncs never share a moment with the poll's
 * create-then-settle, and its deadline is the cron's remaining time (sweepDeadline). Its total work is
 * bounded, not only per object: maxSweepSyncs() syncs per run across all three objects (fewer when the
 * marketing poll shares the invocation), each object given its share of the syncs and of the time, the
 * start object rotating each tick so a busy Contacts cannot starve Deals. SUBREQUESTS, worst case: a
 * sync is ~20 (getRecord, id-column search, registry, updateItem, runAssociations), a search page 1, a
 * store call 1 -- so 15 syncs + 21 pages + ~15 store calls is ~340; the 9 syncs allowed after a poll
 * in the same invocation, ~220.
 * CRM ONLY, and off unless ENABLE_LAD_SWEEP is the literal "true".
 */
import type { Budget, Env, ObjectSpec } from "./types";
import { hs } from "./hubspot";
import { specByObject } from "./config";
import { legacyDealRouting, syncHubspotRecord } from "./sync";
import { writeModeFor, maxWritesFor } from "./run-opts";
import { getWatermark, setWatermark, readNote, writeNote, acquireLock, releaseLock } from "./activity-registry";

export const LAD_SWEEP_OBJECTS = ["contacts", "companies", "deals"] as const;
export type LadSweepObject = typeof LAD_SWEEP_OBJECTS[number];
/** HubSpot's own "Last Activity Date" -- what Contacts date_mm7054jz, Accounts date_mm7dtzwm and Deals date__1 show. */
export const LAD_PROP = "notes_last_updated";
/**
 * Where a cursor starts when none is stored: just before the 2026-09-30 switch-off of automations #09/#10
 * (09:00:42Z), the day the loss was measured. Fixed in source, like TASK_POLL_SEED -- "now" on the first
 * run would skip every record missed between that and the deploy.
 */
export const LAD_SWEEP_SEED = "2026-09-30T09:00:00Z";
/** Re-read this far behind the watermark: a record indexed a moment after the last search. */
export const OVERLAP_MS = 30 * 60_000;
/** The newest few minutes are the webhooks' (their second event lands 2-12 s after the first). */
export const SETTLE_MS = 5 * 60_000;
/** Syncs per object per run, at most -- its share of the run's total (maxSweepSyncs) is often less. */
export const MAX_PER_OBJECT = 10;
/** Syncs per run across all three objects: alone in the cron, and after a marketing poll in the same invocation. */
export const MAX_SYNCS_PER_RUN = 15;
export const MAX_SYNCS_WITH_MARKETING = 9;
/** HubSpot search pages per read. NEW WORK pages until its share is found; THE OVERLAP is a re-check. */
export const SEARCH_PAGE = 100;
export const NEW_PAGES = 5;
export const OVERLAP_PAGES = 2;
/** Wall-clock budget of one sweep, when the cron leaves that much. */
export const SWEEP_BUDGET_MS = 5 * 60_000;
/**
 * No sync STARTS later than this after the cron fired. The marketing poll runs first and may use its
 * whole ten minutes (plus a create it had already begun); a sync started at 13 min still has two
 * minutes before the 15-minute cron limit and the next tick's lock takeover (LOCK_HOLD_MS).
 */
export const SWEEP_LATEST_START_MS = 13 * 60_000;
export const LOCK_HOLD_MS = 14 * 60_000;
export const POISON_TRIES = 3;
export const POISON_MIN_AGE_MS = 60 * 60_000;
/** The seen note stays far below a Durable Object value's 128 KiB (~45 bytes an entry). */
export const MAX_SEEN = 2000;
const LOCK_NAME = "lad-sweep";
const TICK_MS = 15 * 60_000;

export const watermarkName = (o: string) => `lad-sweep:${o}`;
export const seenName = (o: string) => `lad-sweep-seen:${o}`;

export interface LadObjectResult {
  scanned: number; synced: number; seen: number; failures: number; deadLettered: number;
  watermark: [string, string];
  /** Syncs this object was allowed this run (its share of the run's total). */
  cap?: number;
  stoppedBy?: "cap" | "deadline" | "budget" | "failure" | "pages";
  tieSkipped?: boolean;
  skipped?: string;
  error?: string;
}
export interface LadSweepResult {
  status: "ran" | "disabled" | "refused" | "busy" | "no-time";
  reason?: string;
  dryRun: boolean;
  objects: Partial<Record<LadSweepObject, LadObjectResult>>;
}

export interface LadSweepOpts { nowMs?: number; deadlineMs?: number }

/** Only the literal "true", and only on the CRM Worker. The Work Management Worker shares this source. */
export function ladSweepGate(env: Env): { ok: true } | { ok: false; status: "disabled" | "refused"; reason: string } {
  if (env.ENABLE_CRM !== "true") return { ok: false, status: "refused", reason: "not the CRM Worker" };
  if (env.ENABLE_LAD_SWEEP !== "true") return { ok: false, status: "disabled", reason: "ENABLE_LAD_SWEEP is not \"true\"" };
  return { ok: true };
}
export const ladSweepEnabled = (env: Env) => ladSweepGate(env).ok;

/** The run's total syncs: fewer when the marketing poll shares this invocation's subrequests. */
export const maxSweepSyncs = (env: Env) =>
  env.ENABLE_MARKETING_EMAIL_SYNC === "true" ? MAX_SYNCS_WITH_MARKETING : MAX_SYNCS_PER_RUN;

/** The sweep's deadline when it runs after the poll: its own budget, or what the cron has left. */
export const sweepDeadline = (cronStartMs: number, nowMs: number) =>
  Math.min(nowMs + SWEEP_BUDGET_MS, cronStartMs + SWEEP_LATEST_START_MS);

/** This tick's object order: rotated every 15 minutes, so each object goes first one tick in three. */
export function sweepOrder(nowMs: number): LadSweepObject[] {
  const k = Math.floor(nowMs / TICK_MS) % LAD_SWEEP_OBJECTS.length;
  return [...LAD_SWEEP_OBJECTS.slice(k), ...LAD_SWEEP_OBJECTS.slice(0, k)];
}

const iso = (ms: number) => new Date(ms).toISOString();

type Row = { id: string; ts: string };

/** One page of the records whose notes_last_updated lies in [since, until], oldest first, in scope. */
export async function searchLadChanged(env: Env, spec: ObjectSpec, sinceMs: number, untilMs: number,
    after?: string): Promise<{ rows: Row[]; next?: string }> {
  const window = [
    { propertyName: LAD_PROP, operator: "GTE", value: sinceMs },
    { propertyName: LAD_PROP, operator: "LTE", value: untilMs },
  ];
  // The same OR'd scope groups as searchModifiedIds (hubspot.ts); every CRM spec is includeAll today.
  const groups: Record<string, unknown>[][] = spec.includeAll
    ? [window]
    : [[...spec.searchFilters, ...window],
       ...(spec.scopeAlsoLinkedProp ? [[{ propertyName: spec.scopeAlsoLinkedProp, operator: "HAS_PROPERTY" }, ...window]] : [])];
  const page = await hs(env, "POST", `/crm/v3/objects/${spec.object}/search`, {
    filterGroups: groups.map(filters => ({ filters })),
    sorts: [{ propertyName: LAD_PROP, direction: "ASCENDING" }],
    properties: [LAD_PROP], limit: SEARCH_PAGE, ...(after ? { after } : {}),
  }, 2);
  const rows: Row[] = [];
  for (const r of page?.results ?? []) {
    const ts = String(r?.properties?.[LAD_PROP] ?? "");
    if (r?.id && Number.isFinite(Date.parse(ts))) rows.push({ id: String(r.id), ts });
  }
  const next = page?.paging?.next?.after;
  return { rows, ...(next ? { next: String(next) } : {}) };
}

/** The one open failure of an object: which record, at which timestamp, how often, since when. */
type Fail = { id: string; ts: string; n: number; firstAt: number };
type SeenNote = { seen: Map<string, string>; fail: Fail | null };

/**
 * The seen note, soft: unreadable or junk reads as empty, which only costs repeated (harmless) syncs and
 * a restarted poison clock. The first shape was a bare array of pairs; it still reads.
 */
async function readSeen(env: Env, object: string, sinceMs: number): Promise<SeenNote> {
  const out: SeenNote = { seen: new Map(), fail: null };
  try {
    const raw = await readNote(env, seenName(object));
    const v = raw ? JSON.parse(raw) : null;
    const pairs = (Array.isArray(v) ? v : Array.isArray(v?.seen) ? v.seen : []) as [string, string][];
    for (const [id, ts] of pairs) if (Date.parse(ts) >= sinceMs) out.seen.set(String(id), String(ts));
    const f = v && !Array.isArray(v) ? v.fail : null;
    if (f && typeof f.id === "string" && typeof f.ts === "string" && Number.isFinite(f.n) && Number.isFinite(f.firstAt))
      out.fail = { id: f.id, ts: f.ts, n: f.n, firstAt: f.firstAt };
  } catch { /* junk note: start empty */ }
  return out;
}

export async function sweepLastActivity(env: Env, opts: LadSweepOpts = {}): Promise<LadSweepResult> {
  const runOpts = writeModeFor(env, maxWritesFor(env));
  const r: LadSweepResult = { status: "ran", dryRun: runOpts.dryRun, objects: {} };
  const gate = ladSweepGate(env);
  if (!gate.ok) {
    r.status = gate.status; r.reason = gate.reason;
    console.log(`[lad-sweep] action=${gate.status} reason="${gate.reason}"`);
    return r;
  }
  const now = opts.nowMs ?? Date.now();
  const deadline = opts.deadlineMs ?? Date.now() + SWEEP_BUDGET_MS;
  if (Date.now() >= deadline) {
    // The poll used the cron's time. Nothing is taken, not even the lock: the next tick picks it up.
    r.status = "no-time"; r.reason = "no time left in this cron";
    console.log(`[lad-sweep] action=no-time reason="${r.reason}"`);
    return r;
  }
  // A dry run writes nothing durable, the lock included (the marketing poller's rule).
  const runId = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  if (!r.dryRun && !(await acquireLock(env, LOCK_NAME, LOCK_HOLD_MS, runId))) {
    r.status = "busy"; r.reason = "another sweep holds the lock (or the lock store is unavailable)";
    console.log(`[lad-sweep] action=busy reason="${r.reason}"`);
    return r;
  }
  try {
    let left = maxSweepSyncs(env);
    const order = sweepOrder(now);
    for (let i = 0; i < order.length; i++) {
      const object = order[i];
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // EACH OBJECT ITS SHARE -- of the syncs and of the time -- and whatever an earlier one left unused
      // passes on. One shared deadline in a fixed order let ten Contacts plus ten Accounts spend most of
      // five minutes, so Deals stopped at the deadline or never started.
      const share = order.length - i;
      const cap = Math.min(MAX_PER_OBJECT, Math.ceil(left / share));
      const objDeadline = Date.now() + remaining / share;
      // A write budget PER OBJECT (MAX_WRITES each): shared, a busy Contacts run would starve Accounts and
      // Deals every tick. The caps bound the total either way.
      const budget: Budget = { left: runOpts.maxWrites };
      const x = await sweepObject(env, object, now, objDeadline, cap, runOpts, budget, r.dryRun);
      r.objects[object] = x;
      left = Math.max(0, left - x.scanned);
    }
  } finally {
    if (!r.dryRun) await releaseLock(env, LOCK_NAME, runId);
    console.log(`[lad-sweep] dryRun=${r.dryRun} ${Object.entries(r.objects).map(([o, x]) =>
      `${o}:synced=${x!.synced}/${x!.cap ?? 0},seen=${x!.seen},failures=${x!.failures},dead=${x!.deadLettered}`
      + `${x!.stoppedBy ? `,stopped=${x!.stoppedBy}` : ""}${x!.tieSkipped ? ",tie-skipped" : ""}`
      + `${x!.skipped ? `,skipped="${x!.skipped}"` : ""}`
      + `${x!.error ? `,error="${x!.error}"` : ""},wm=${x!.watermark.join("->")}`).join(" ")}`);
  }
  return r;
}

async function sweepObject(env: Env, object: LadSweepObject, now: number, deadline: number, cap: number,
    runOpts: ReturnType<typeof writeModeFor>, budget: Budget, dryRun: boolean): Promise<LadObjectResult> {
  const x: LadObjectResult = { scanned: 0, synced: 0, seen: 0, failures: 0, deadLettered: 0, watermark: ["", ""], cap };
  const spec = specByObject(env, object);
  if (!spec) { x.skipped = "object not owned by this deployment"; return x; }
  // The CRM deals board is an ordinary single-board spec; the WM multi-board route is not this sweep's.
  if (object === "deals" && legacyDealRouting(env)) { x.skipped = "deals route across boards here"; return x; }

  // FAIL CLOSED: "the store is broken" must not read as "nothing recorded yet, start from the seed".
  let before: string;
  try { before = (await getWatermark(env, watermarkName(object))) ?? LAD_SWEEP_SEED; }
  catch (e) { x.failures++; x.error = `watermark unreadable: ${String(e).slice(0, 90)}`; return x; }
  const beforeMs = Date.parse(before);
  if (!Number.isFinite(beforeMs)) { x.failures++; x.error = `watermark unparseable: ${before.slice(0, 40)}`; return x; }
  x.watermark = [before, before];

  const untilMs = now - SETTLE_MS;
  const sinceMs = beforeMs - OVERLAP_MS;
  if (untilMs <= sinceMs) return x;
  const note = await readSeen(env, object, sinceMs);
  const seen = note.seen;
  let fail = note.fail;
  let dirty = false;
  let high = beforeMs;
  let stopped = false;          // failure, deadline or budget: nothing more for this object this run
  let newUnseen = 0;            // unseen rows met in NEW WORK (a tie-skip needs there to be none)

  /** One row. `moves`: a NEW WORK row, which may carry the watermark. `limit`: this read's sync allowance. */
  const visit = async (row: Row, moves: boolean, limit: number): Promise<"next" | "stop"> => {
    const tsMs = Date.parse(row.ts);
    if (seen.get(row.id) === row.ts) { x.seen++; if (moves) high = Math.max(high, tsMs); return "next"; }
    if (moves) newUnseen++;
    if (x.scanned >= limit) { x.stoppedBy = "cap"; return "stop"; }
    if (Date.now() > deadline) { x.stoppedBy = "deadline"; stopped = true; return "stop"; }
    if (budget.left <= 0) { x.stoppedBy = "budget"; stopped = true; return "stop"; }
    x.scanned++;
    try {
      // NON-FORCED: exactly the webhook's call (no ignoreItemId, no forceForward).
      const line = await syncHubspotRecord(env, spec, row.id, runOpts, budget);
      console.log(`[lad-sweep] ${object}=${row.id} ${LAD_PROP}=${row.ts} result=${String(line).slice(0, 160)}`);
      x.synced++; seen.set(row.id, row.ts); dirty = true; if (moves) high = Math.max(high, tsMs);
      if (fail && fail.id === row.id) fail = null;
      return "next";
    } catch (e) {
      x.failures++;
      const why = String(e).slice(0, 120);
      const same = !!fail && fail.id === row.id && fail.ts === row.ts;
      const f: Fail = same ? { ...fail!, n: fail!.n + 1 } : { id: row.id, ts: row.ts, n: 1, firstAt: now };
      if (!dryRun && f.n >= POISON_TRIES && now - f.firstAt >= POISON_MIN_AGE_MS) {
        // Stepped over, loudly: one record must not hold every later one of its object forever.
        x.deadLettered++; seen.set(row.id, row.ts); fail = null; dirty = true;
        if (moves) high = Math.max(high, tsMs);
        console.log(`[lad-sweep] ${object}=${row.id} action=dead-lettered tries=${f.n}`
          + ` failingForMin=${Math.round((now - f.firstAt) / 60_000)} reason="${why}"`);
        return "next";
      }
      fail = f; dirty = true;
      console.log(`[lad-sweep] ${object}=${row.id} action=error tries=${f.n} reason="${why}" -- stopping here`);
      x.stoppedBy = "failure"; stopped = true;
      return "stop";
    }
  };
  /** Page one read with HubSpot's `after` cursor. "pages" = the page bound ran out with rows left. */
  const walk = async (from: number, to: number, pages: number, moves: boolean, limit: number)
      : Promise<"done" | "stop" | "pages"> => {
    let after: string | undefined;
    for (let p = 0; p < pages; p++) {
      const { rows, next } = await searchLadChanged(env, spec, from, to, after);
      for (const row of rows) if ((await visit(row, moves, limit)) === "stop") return "stop";
      if (!next) return "done";
      after = next;
    }
    return "pages";
  };

  try {
    // THE OVERLAP first (it is older), with at most half the allowance: a late-indexed record is rare, and
    // whatever the re-check finds must never crowd out the new work. A dense overlap ends in "pages".
    const overlapTo = Math.min(beforeMs - 1, untilMs);
    if (overlapTo >= sinceMs) {
      const o = await walk(sinceMs, overlapTo, OVERLAP_PAGES, false, Math.ceil(cap / 2));
      if (o === "pages") {
        x.stoppedBy = "pages";
        console.log(`[lad-sweep] ${object} action=overlap-dense reason="more than ${OVERLAP_PAGES * SEARCH_PAGE}`
          + ` records in the ${OVERLAP_MS / 60_000}-min overlap; the re-check stops there, new work goes on"`);
      }
    }
    if (!stopped && untilMs >= beforeMs) {
      x.stoppedBy = undefined;   // the overlap's own half-cap or page bound is not this object's stop
      const n = await walk(beforeMs, untilMs, NEW_PAGES, true, cap);
      if (n === "pages") {
        x.stoppedBy = "pages";
        if (newUnseen === 0 && high === beforeMs) {
          // Every row of every page was already seen, and all at the watermark's own millisecond.
          high = beforeMs + 1; x.tieSkipped = true;
          console.log(`[lad-sweep] ${object} action=tie-skipped at=${before} reason="more than`
            + ` ${NEW_PAGES * SEARCH_PAGE} already-synced records share this timestamp; stepping 1 ms past them"`);
        }
      }
    }
  } catch (e) {
    x.failures++; x.error = `search failed: ${String(e).slice(0, 90)}`;
  }

  // A dry run never moves a cursor: that would hide real work from the next live run.
  if (dryRun) return x;
  if (dirty) {
    const keepFrom = high - OVERLAP_MS;   // the next run's `since`: nothing older can be re-read
    const keep = [...seen].filter(([, ts]) => Date.parse(ts) >= keepFrom)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, MAX_SEEN);
    await writeNote(env, seenName(object), JSON.stringify({ seen: keep, fail }));
  }
  if (high > beforeMs) {
    // setWatermark throws on failure. Recorded as a failure, never as an advance: reporting progress
    // that was never saved would hide that the next run will redo this work (harmless, but not "done").
    try { await setWatermark(env, watermarkName(object), iso(high)); x.watermark = [before, iso(high)]; }
    catch (e) { x.failures++; x.error = `watermark not saved: ${String(e).slice(0, 90)}`; }
  }
  return x;
}
