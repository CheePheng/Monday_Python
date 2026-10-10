/**
 * THE OVERFLOW OF AN OVERSIZED WEBHOOK BATCH — policy and producer.
 *
 * WHAT WAS ACTUALLY BROKEN. handleHubspot processes a bounded slice of each webhook batch and logs
 * the rest as `action=deferred ... reason="batch > 15; backup catches overflow"`. On the Work
 * Management Worker that sentence is true: it runs a ten-minute incremental cron that re-reads
 * recently modified records. On THIS Worker it is not — it has no SYNC crons (its only cron is the 15-minute one,
 * which dispatches the marketing poller and nothing else; deploy-config.test.ts pins it), so no sweep
 * ever re-reads a record and the overflow was simply discarded.
 *
 * It is not a small remainder either. HubSpot delivered batches of ~47 contact events during a bulk
 * update, so roughly two thirds of each batch was being dropped, with a log line that read as though
 * something else would pick them up. A dropped change is invisible: the card keeps its old values and
 * nothing anywhere records that it is stale.
 *
 * WHY A QUEUE IN ONE DURABLE OBJECT, NOT A DO PER RECORD. The per-record shape used by the activity
 * retry is wrong here: an import produces thousands of overflow events at once, and a DO each would
 * mean thousands of alarms firing together against HubSpot and monday — trading silent data loss for
 * a self-inflicted rate-limit storm. A single serialized queue drained in small waves gives exactly
 * the property the webhook path is protecting: a bounded number of records in flight at a time.
 *
 * And not a cron, because a cron re-reads everything on a timer whether or not anything overflowed.
 * The queue only exists when a batch actually exceeded the limit.
 */
import type { Env, PassScope } from "./types";
import type { DeferredSync } from "./deferred-sync-do";

// Deals and line items since 2026-09-23 -- see the spill in webhooks.ts.
export type DeferredType = "contact" | "company" | "deal" | "line_item";

export interface DeferredItem {
  type: DeferredType;
  id: string;
  deleted?: boolean;
  /**
   * A LIFECYCLE RE-CHECK, not an update (sync.ts armRecheck, queued before every backward move's clear): the
   * wave runs recheckDanglingClears for it -- finish a clear whose set never followed, and nothing else.
   * Never a forward pass: one run at a fixed ~15 s after the move overwrote a person's next edit still on its
   * way, because HubSpot bumps the record's lastmodifieddate by itself ~7 s after every stage change.
   */
  recheck?: boolean;
  /**
   * AN OWNER NOTICE, not an update (OWNER_NOTICE): the wave runs owner-notice.ts noticeOwnerChange for this
   * contact -- reads its owner from HubSpot and, if a recent assignment has been neither told nor flagged, sets
   * the card's 通知状态 to 待通知 for the board's own workflow to send (the Worker never writes 上次通知Owner) --
   * and nothing else. Every notice runs here, never inline: a webhook's work is cut off ~30 s after its response,
   * and a notice can wait on monday's rate limit longer than that; this queue also runs them one at a time, so two
   * notices for one contact can never interleave. A notice that ends "busy", "pending", "waiting" or "error" is
   * retried, and one that ends "flagged" is run once more to check the workflow finished it (see the alarm).
   */
  notice?: boolean;
  attempts?: number;
  /**
   * A NOTICE ONLY: when this entry first answered "busy", "pending" or "waiting" (epoch ms) -- kept until the entry
   * settles, whatever it answers in between. Until it is older than owner-notice.ts NOTICE_BUSY_GRACE_MS -- the
   * longer of the notice lock's hold and a waiting flag's stuck threshold, plus a margin -- such a retry does not
   * count as an attempt: a run killed inside the lock (a deploy restarting this queue mid-wave) holds it for the
   * whole hold, a card can wait seconds for the sync that shows its new owner, a flag pending on the board's
   * workflow waits for it to finish -- and three quick counted retries abandoned the notice inside any of them.
   */
  busySince?: number;
  /**
   * A NOTICE ONLY: when this entry first answered "error" (epoch ms), kept the same way. An error retry is free
   * until it is older than owner-notice.ts NOTICE_ERROR_GRACE_MS: counted at once, three retries ~12 s apart lost
   * the notice for good in a ~40 s monday or HubSpot outage, and no later event ever brings a notice back.
   */
  errorSince?: number;
  /**
   * NOT STORED: a request that only ASKS for this work to be coming -- a busy owner notice asking for its
   * contact's sync. Deduplicated against the running wave's own entries as well as the waiting ones: queued again
   * beside a pass that is running (enqueue's usual "owed again"), the failing sync's retry was dropped for the
   * fresh entry each wave, its attempts reset, and it ran ~40 times instead of MAX_ATTEMPTS.
   */
  ensure?: boolean;
  /**
   * AN UPDATE ONLY (STALE_FORWARD_GATE): what the HubSpot events behind it named (PassScope), carried from the
   * webhook batch that spilled it. Absent = UNSCOPED (every differing two-way cell's history is read). Two waiting
   * updates of one record merge: unscoped wins, otherwise the union, the newest event per property.
   */
  scope?: PassScope;
  /**
   * THE CARD WATCH'S WORK, not an update (STALE_FORWARD_GATE): `id` is then the monday ITEM id and `type` the spec's
   * event type. "converge": sync.ts settleCardWatch -- the cells whose holds ended are judged and converged;
   * "retry": sync.ts retryMarkedEdits -- a person's edit whose run died is sent again (STALE_FORWARD_RETRY).
   */
  watch?: { boardId: string; kind: "converge" | "retry" };
}

/** Identity for deduplication. A delete, an update, a re-check and an owner notice of the same record are
 *  different work: an update's forward pass does repair a dangling clear, but a re-check cannot stand in for an
 *  update, and neither tells an owner anything. A card watch's converge and retry are keyed by the ITEM. */
export const deferKey = (i: DeferredItem) => i.watch
  ? `${i.type}:${i.id}:${i.watch.kind === "converge" ? "c" : "e"}`
  : `${i.type}:${i.id}:${i.deleted ? "d" : i.recheck ? "r" : i.notice ? "n" : "u"}`;

/** Is this deferred item an ordinary UPDATE (the only kind that carries a scope)? */
export const isUpdateItem = (i: DeferredItem): boolean => !i.deleted && !i.recheck && !i.notice && !i.watch;

/** How many records one alarm processes. Matches the webhook path's own per-invocation limit, for
 *  the same subrequest reason. */
export const WAVE = 15;
/** Gap between waves. Slow enough to be gentle on both APIs, fast enough to drain a large import in
 *  minutes rather than hours. */
export const WAVE_GAP_MS = 10_000;
/** First wave is slightly delayed so the webhook that spilled has finished its own slice first. Not a guarantee:
 *  it counts from the FIRST spill of a batch, and on CRM a batch spills before its deal-association reads (which
 *  can take seconds) and again after them (webhooks.ts), so the first wave can start while that batch is still
 *  reading or syncing -- different records, so only more concurrent API load. An alarm already armed runs sooner. */
export const FIRST_DELAY_MS = 15_000;
/** Bounded, never infinite: a record that fails this many waves is logged and abandoned. (An owner notice's busy,
 *  pending, waiting and error retries count only once their grace has run out -- DeferredItem.busySince /
 *  errorSince -- and are then bounded by this too.) */
export const MAX_ATTEMPTS = 3;
/**
 * A ceiling on stored backlog. Reaching it means something far outside normal operation — a bulk
 * import of a size we would want to run deliberately rather than absorb through webhooks — so the
 * excess is logged loudly rather than silently accepted into a queue that would take hours to drain.
 */
export const MAX_QUEUE = 5_000;

const NAME = "defer:hubspot";

/**
 * Hand the overflow to the durable queue.
 *
 * FAILS SOFT, AND IS A NO-OP WITHOUT THE BINDING. This file is shared with the Work Management
 * Worker, whose configuration has no DEFERRED_SYNC namespace and whose cron already covers the same
 * ground. Referencing a missing binding there would throw inside the webhook handler — the exact
 * class of failure that took live sync down on 2026-09-15 — so absence is treated as "not my job".
 */
/** Returns true when the queue holds the items now (queued or already waiting); false when there is no queue
 *  or it could not be reached, or it dropped any of them -- for a caller with a fallback. */
export async function spillDeferred(env: Env, items: DeferredItem[]): Promise<boolean> {
  return (await spillDeferredLeftover(env, items)).length === 0;
}

/**
 * The same hand-over, answering WHICH items the queue does not hold: every one when there is no queue or it could
 * not be reached, else exactly those it dropped at its ceiling -- always the TAIL of `items` (MAX_QUEUE). [] when
 * it holds them all, queued now or already waiting.
 *
 * WHY A LIST, NOT A YES/NO. A caller with a fallback (the owner notice runs inline) must run it for what was
 * dropped and nothing else. Told only "not all of it", the notice ran EVERY id inline, front first -- the ones the
 * queue had taken -- and the webhook's ~30 s cut-off ended the loop before it reached any it had dropped.
 */
export async function spillDeferredLeftover(env: Env, items: DeferredItem[]): Promise<DeferredItem[]> {
  if (!items.length) return [];
  const ns = env.DEFERRED_SYNC;
  if (!ns) return items;                           // Work Management deployment: the cron covers it
  try {
    const stub = ns.get(ns.idFromName(NAME)) as unknown as DurableObjectStub<DeferredSync>;
    const r = await stub.enqueue(items);
    console.log(`[deferred] action=spilled queued=${r.queued} duplicate=${r.duplicate} dropped=${r.dropped}`
      + ` depth=${r.depth}`);
    if (!r.dropped) return [];
    // A queue that says only how many it dropped (an instance from before droppedKeys, mid-deploy): once full it
    // drops every later item that is not a duplicate, so it dropped the TAIL -- answered as the last `dropped`
    // items (approximate only when a duplicate sits in that tail). Answering all of them put the ones it HAD taken
    // first in a fallback's line, ahead of the ones it dropped.
    if (!Array.isArray(r.droppedKeys)) return items.slice(-Math.min(r.dropped, items.length));
    const dropped = new Set(r.droppedKeys);
    return items.filter(i => dropped.has(deferKey(i)));
  } catch (e) {
    console.log(`[deferred] action=spill-failed count=${items.length} reason="${String(e).slice(0, 120)}"`);
    return items;
  }
}
