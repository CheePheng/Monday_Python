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
import type { Env } from "./types";
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
  attempts?: number;
}

/** Identity for deduplication. A delete, an update and a re-check of the same record are different work:
 *  an update's forward pass does repair a dangling clear, but a re-check cannot stand in for an update. */
export const deferKey = (i: DeferredItem) => `${i.type}:${i.id}:${i.deleted ? "d" : i.recheck ? "r" : "u"}`;

/** How many records one alarm processes. Matches the webhook path's own per-invocation limit, for
 *  the same subrequest reason. */
export const WAVE = 15;
/** Gap between waves. Slow enough to be gentle on both APIs, fast enough to drain a large import in
 *  minutes rather than hours. */
export const WAVE_GAP_MS = 10_000;
/** First wave is slightly delayed so the webhook that spilled has finished its own slice first. */
export const FIRST_DELAY_MS = 15_000;
/** Bounded, never infinite: a record that fails this many waves is logged and abandoned. */
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
export async function spillDeferred(env: Env, items: DeferredItem[]): Promise<void> {
  if (!items.length) return;
  const ns = env.DEFERRED_SYNC;
  if (!ns) return;                                 // Work Management deployment: the cron covers it
  try {
    const stub = ns.get(ns.idFromName(NAME)) as unknown as DurableObjectStub<DeferredSync>;
    const r = await stub.enqueue(items);
    console.log(`[deferred] action=spilled queued=${r.queued} duplicate=${r.duplicate} dropped=${r.dropped}`
      + ` depth=${r.depth}`);
  } catch (e) {
    console.log(`[deferred] action=spill-failed count=${items.length} reason="${String(e).slice(0, 120)}"`);
  }
}
