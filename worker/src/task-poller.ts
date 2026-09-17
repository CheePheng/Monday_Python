/**
 * HUBSPOT TASKS, POLLED — because the push webhook for them cannot exist here.
 *
 * object.creation for `task` needs crm.objects.tasks.read, and HubSpot refuses that scope to this app
 * type outright: "isn't available to this app — contact HubSpot support to request access". Build #11
 * failed on it. So there is no webhook to wait for, and no amount of retrying the manifest changes
 * that.
 *
 * What DOES work, proven before this was written: the ordinary private-app token reads
 * /crm/v3/objects/tasks/search, filtered and sorted by hs_lastmodifieddate. So the Worker asks
 * periodically instead of being told. Volume makes this cheap rather than clever — fifteen tasks were
 * created in the whole of the last month, and the sales team's future tasks are meant to be
 * monday-native anyway. This exists so a task an ADMIN creates in HubSpot is not silently lost.
 *
 * WHY THE WATERMARK IS hs_lastmodifieddate AND NOT THE TASK'S OWN TIMESTAMP. A task's hs_timestamp is
 * its DUE DATE, which is routinely in the past — this portal has a task modified on 2026-08-20 whose
 * due date is 2024-12-19. Keyed on that, a freshly edited task would look ancient and never be seen.
 * Modification time is the only field that answers "what is new to me?".
 */
import type { Env } from "./types";
import { hs } from "./hubspot";
import { getWatermark, setWatermark } from "./activity-registry";
import { syncHubspotActivity } from "./activity-sync";

/**
 * THE SEED IS THE ACTIVITY CUTOVER, not the moment this was written.
 *
 * Fixed in source either way — "now" on first run would drop every task modified between writing
 * this and switching the cron on, into a gap nobody would ever look for. But the cutover is the
 * RIGHT fixed point, and the reason is a case the later seed misses entirely: a task with a FUTURE
 * due date, modified in that window, is skipped by the historical backfill (its timestamp is after
 * the cutover, so the backfill considers it live sync's problem) AND never seen by a poller that
 * starts later. Invisible to both, permanently.
 *
 * Re-reading the wider window is close to free. Everything the backfill already placed is caught by
 * verifyExisting against the card's own marker, and the durable mapping is settled rather than
 * duplicated. Reading too much costs a marker check; reading too little costs a task nobody knows
 * is missing.
 */
export const TASK_POLL_SEED = "2026-09-16T11:16:48Z";   // == ACTIVITY_CUTOVER_AT

/**
 * Re-read a little before the watermark each time. A task modified in the same second the previous
 * run finished can otherwise fall exactly between two windows; re-reading a few of them costs one
 * marker check each, and destination-level idempotency turns the repeat into nothing.
 */
export const OVERLAP_MS = 10 * 60_000;

/** Bounded per invocation, so a large edit burst is spread over several polls instead of one long run. */
export const MAX_PER_POLL = 200;

export interface PollResult {
  scanned: number; written: number; unchanged: number; failures: number;
  watermarkBefore: string; watermarkAfter: string;
}

/**
 * One pass. Ordered by modification time ascending, so the watermark can advance to the last task
 * that actually SUCCEEDED and no further: a failure in the middle leaves everything after it unseen
 * rather than silently skipped.
 */
export async function pollTasks(env: Env): Promise<PollResult> {
  const before = (await getWatermark(env, "tasks")) ?? TASK_POLL_SEED;
  const since = new Date(Date.parse(before) - OVERLAP_MS).toISOString();
  const r: PollResult = { scanned: 0, written: 0, unchanged: 0, failures: 0,
    watermarkBefore: before, watermarkAfter: before };

  let after: string | undefined;
  let highWater = before;
  let stop = false;

  for (let page = 0; page < 10 && !stop; page++) {
    const res = await hs(env, "POST", "/crm/v3/objects/tasks/search", {
      filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: since }] }],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      properties: ["hs_lastmodifieddate"],
      limit: 100, ...(after ? { after } : {}),
    }, 2);

    const rows: any[] = res?.results ?? [];
    for (const t of rows) {
      if (r.scanned >= MAX_PER_POLL) { stop = true; break; }
      r.scanned++;
      const modified = String(t.properties?.hs_lastmodifieddate ?? "");
      try {
        /**
         * THE NARROW BYPASS. ignoreCutover is set ONLY here: a task's position in the timeline is its
         * due or completion date, which is usually long past, so the activity cutover — written to
         * stop a bulk history push through the live path — would reject every task the poller finds.
         * Email, call, note and meeting webhooks are untouched by this and still obey it.
         *
         * verifyExisting is the other half: the historical backfill writes timeline entries WITHOUT
         * creating live durable mappings, so without checking the card itself the first poll after
         * the migration would faithfully duplicate everything the backfill had already placed.
         */
        const outcome = await syncHubspotActivity(env, "tasks", String(t.id),
          { ignoreCutover: true, verifyExisting: true });
        if (outcome === "created") r.written++;
        else if (outcome === "skipped") r.unchanged++;
        else { r.failures++; stop = true; break; }      // ordered: stop rather than step over it
        if (modified) highWater = modified;
      } catch (e) {
        r.failures++;
        console.log(`[task-poller] task=${t.id} action=error reason="${String(e).slice(0, 120)}"`);
        stop = true; break;
      }
    }
    after = res?.paging?.next?.after;
    if (!after) break;
  }

  /**
   * Only ever forward, only as far as work that actually landed — and only CLAIMED once the store
   * has confirmed it. setWatermark throws on failure and that is deliberately not caught: reporting
   * an advance that was never persisted would tell an operator progress was saved when the next run
   * will silently redo it.
   */
  if (Date.parse(highWater) > Date.parse(before)) {
    await setWatermark(env, "tasks", highWater);
    r.watermarkAfter = highWater;
  }
  console.log(`[task-poller] scanned=${r.scanned} written=${r.written} unchanged=${r.unchanged}`
    + ` failures=${r.failures} watermark=${r.watermarkBefore} -> ${r.watermarkAfter}`);
  return r;
}
