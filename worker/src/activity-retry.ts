/**
 * DURABLE RETRY FOR THE ONE RACE THAT CAN LOSE AN ACTIVITY.
 *
 * WHAT WAS STILL BROKEN. syncHubspotActivity retries the contact/card LOOKUP for ~22 seconds inside
 * the invocation, then gives up and logs `unresolved`. That in-process retry covers the ordinary case
 * — a contact and its first email created in the same second — but it is not durability. Nothing
 * redelivers the webhook: the work runs in waitUntil and the request was already acknowledged 200, so
 * an activity whose card is still invisible at 22 seconds was simply gone. Silently: a missing line in
 * a timeline looks exactly like a rep who did not write anything.
 *
 * WHY A DURABLE OBJECT ALARM AND NOT CLOUDFLARE QUEUES. Queues is the textbook answer and it is the
 * wrong shape for three of the requirements here:
 *
 *  1. "Do not destroy pending jobs merely because the feature is disabled." A Queues consumer must
 *     ack or retry every message, and a retry counts against max_retries — so deferring while
 *     ENABLE_ACTIVITY_SYNC is off either burns the retry budget or dead-letters work because of a
 *     config flag. An alarm defers by simply being set later: no attempt consumed, nothing to lose.
 *
 *  2. A consumer is a NEW WORKER ENTRY POINT, running with the same env as the webhook handler. On
 *     2026-09-15 widening what a shared handler touched took live Contacts and Companies sync down
 *     for an hour. An alarm on a class nothing else uses cannot reach that code.
 *
 *  3. Queues is an account-level resource on a shared company account; this Worker already owns a
 *     Durable Object namespace, and the same strongly-consistent store already holds the mapping that
 *     decides "have I already synced this?". Keeping the pending job beside it means the two are
 *     reasoned about in one primitive rather than two.
 *
 * Queues would win on throughput, batching and a built-in dead-letter queue. Throughput is not a
 * concern — this is a rare fallback for a race that resolves in seconds virtually always — and the
 * dead-letter half is replaced by an explicit capped index, readable over /activity-dead-letters.
 *
 * THIS MODULE IS PURE POLICY, in the same split the card idempotency already uses (idempotency.ts
 * decides, create-idempotency-do.ts stores). The decisions are the part that must be tested, and they
 * are testable here without a Workers runtime.
 */
import type { Env } from "./types";
import type { ActivityRetry } from "./activity-retry-do";

/**
 * What one attempt at syncing a HubSpot activity into monday concluded.
 *
 * The distinction that matters is RETRYABLE vs NOT, and specifically that `error` is not retryable:
 * it is raised after the create request was already sent, so the write may well have landed. Queueing
 * it would be the duplicate this whole subsystem exists to prevent.
 */
export type ActivityOutcome =
  | "created"      // a monday timeline entry was written
  | "skipped"      // a settled decision that will not change: pre-cutover, monday-origin, out of scope
  | "creating"     // another delivery holds the reservation right now
  | "unresolved"   // the contact or its card was not visible — the race this module exists for
  | "blocked"      // the idempotency store was unreachable
  | "error"        // the create threw AFTER being sent; it may have landed. NEVER retried here.
  /** ACTIVITY_SKIP_MIRRORED_COPIES only, and only on a job's first delivery: a linked Company/Deal was
   *  deliberately NOT claimed or written in this pass, so monday's own copy has time to land before the
   *  card is checked. Nothing failed and nothing is reserved for it -- another pass must come. */
  | "deferred";

const RETRYABLE: ReadonlySet<ActivityOutcome> =
  new Set<ActivityOutcome>(["unresolved", "blocked", "creating", "deferred"]);
export const shouldRetry = (o: ActivityOutcome): boolean => RETRYABLE.has(o);

/**
 * Bounded, not infinite. A contact that genuinely never gets a monday card — deleted, filtered out of
 * the board, or never synced at all — must stop costing work and must become visible as a failure
 * rather than a permanent background hum.
 */
export const RETRY_SCHEDULE_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/**
 * Two looks, then stop. Associations are attached within seconds by anything automated; five minutes
 * is generous for a person doing it by hand. Beyond that this becomes polling, and polling every
 * activity forever to catch an edit someone might make next week is not worth what it costs.
 */
export const RECONCILE_SCHEDULE_MS: readonly number[] = [30_000, 5 * 60_000];

/**
 * THE FIRST DELIVERY RUNS HERE, NOT IN THE WEBHOOK.
 *
 * It used to run in the webhook's waitUntil, which Cloudflare cancels about 30 seconds after the
 * response. An email to several people is written to its destinations one after another, each costing
 * a card lookup on a ~96k-item board, a reservation, a create and a settle -- routinely more than 30
 * seconds. A cancellation that lands between a create and its settle leaves the reservation unsettled;
 * the next pass then takes it over and writes the entry again, and every destination after it is never
 * written at all. Measured on 2026-09-23: of 160 (email, card) deliveries since the previous deploy,
 * 136 held exactly two copies, and the copy was always on ONE destination of a multi-recipient email --
 * the one being written when the invocation was cut off.
 *
 * An alarm is not bound by waitUntil's limit, and it is the path retries already take, so moving the
 * first attempt here changes WHERE it runs and nothing about WHAT runs. The first slot is 0 -- deliver
 * now -- and the rest is the ordinary retry schedule, so an unresolved first attempt is retried exactly
 * as before.
 */
export const DELIVER_SCHEDULE_MS: readonly number[] = [0, ...RETRY_SCHEDULE_MS];

export const scheduleFor = (mode?: PendingMode) =>
  mode === "reconcile" ? RECONCILE_SCHEDULE_MS
    : mode === "deliver" ? DELIVER_SCHEDULE_MS
    : RETRY_SCHEDULE_MS;

/** How often a job re-checks whether the feature has come back on. Not an attempt. */
export const DISABLED_RECHECK_MS = 60 * 60_000;

/**
 * The only bound on deferral while the feature is off. Long enough that switching the canary off over
 * a weekend loses nothing, short enough that a job cannot outlive anyone's memory of it.
 */
export const MAX_DEFERRED_MS = 7 * 24 * 60 * 60_000;

/** Most recent terminal failures kept for inspection. Capped: this is a diagnostic, not a log store. */
export const DEAD_LETTER_CAP = 200;

/**
 * WHY A RECONCILE IS NOT A RETRY, even though it rides the same rails.
 *
 * A retry exists because something FAILED. A reconcile runs after a perfectly successful sync,
 * because HubSpot fires object.creation the moment an activity exists — which for an automation or an
 * API flow that posts the record first and links it second is BEFORE it is associated with anything.
 * We proved this directly: a note created bare and associated a moment later reached the Contact and
 * missed the Company and the Deal entirely, permanently, because "created" is a settled decision.
 *
 * object.associationChange was meant to cover exactly this and does not deliver — declared, accepted
 * by HubSpot, reauthorized, and still silent, tested twice against real notes. So rather than wait for
 * a webhook that is not coming, we simply look again: once after thirty seconds, once after five
 * minutes, and then stop. Destination-level idempotency makes a look cost nothing when nothing has
 * changed, and adds exactly one entry when a Company or Deal has since been attached.
 */
export type PendingMode = "retry" | "reconcile" | "deliver";

export interface PendingActivity {
  /** Absent means "retry", so jobs written before reconciles existed still read correctly. */
  mode?: PendingMode;
  object: string;        // "emails" | "calls" | "notes" | "meetings"
  hubspotId: string;
  reason: string;        // the outcome that caused the last scheduling
  attempts: number;      // attempts COMPLETED so far
  firstSeenMs: number;   // when the webhook first failed to resolve — the deferral clock
  /** True once this job's first delivery has held a linked Company/Deal back (outcome "deferred").
   *  Absent on every job written before, and on every job while ACTIVITY_SKIP_MIRRORED_COPIES is off. */
  mirrorDeferred?: boolean;
}

/**
 * How long a held-back Company/Deal waits for monday's copy of the Contact entry. The reconcile's
 * first look uses the same delay for the same reason: long enough for monday's side to land.
 */
export const MIRROR_SETTLE_MS = RECONCILE_SCHEDULE_MS[0];

/**
 * MAY THIS PASS HOLD A LINKED COMPANY/DEAL BACK? Only the FIRST delivery of a job, and only once.
 *
 * monday copies a Contact's timeline entry onto the Accounts/Deals linked to it, but a card checked a
 * second after the Contact write may not show the copy yet -- and then the check says "absent" and the
 * Worker writes the duplicate anyway. Holding those destinations for MIRROR_SETTLE_MS fixes the timing.
 * Once only: the next pass carries `mirrorDeferred`, so it checks and writes, and the job keeps its whole
 * retry budget because the deferral does not spend an attempt.
 */
export const mayDeferMirror = (job: PendingActivity, flagOn: boolean): boolean =>
  flagOn && job.mode === "deliver" && job.attempts === 0 && !job.mirrorDeferred;

export interface DeadActivity extends PendingActivity { diedAtMs: number; terminalReason: string }

/** Delay before attempt n+1, or null when the schedule is exhausted. */
export function nextDelayMs(attemptsCompleted: number, mode?: PendingMode): number | null {
  const sched = scheduleFor(mode);
  return attemptsCompleted < sched.length ? sched[attemptsCompleted] : null;
}

export type AlarmStep =
  | { action: "run" }                          // conditions allow an attempt
  | { action: "defer"; delayMs: number }       // feature off: come back later, no attempt spent
  | { action: "die"; reason: string };         // give up, record it

/**
 * What the alarm should do BEFORE spending an attempt.
 *
 * The feature flag is re-read here rather than captured when the job was created, because a job
 * scheduled during the canary may fire after the canary is switched off — and a queued activity must
 * never write while the feature is disabled.
 */
export function stepForAlarm(job: PendingActivity, ctx: { enabled: boolean; nowMs: number }): AlarmStep {
  if (ctx.enabled) return { action: "run" };
  if (ctx.nowMs - job.firstSeenMs > MAX_DEFERRED_MS)
    return { action: "die", reason: "ENABLE_ACTIVITY_SYNC stayed off past the deferral limit" };
  return { action: "defer", delayMs: DISABLED_RECHECK_MS };
}

export type OutcomeStep =
  | { action: "done" }
  | { action: "retry"; job: PendingActivity; delayMs: number }
  | { action: "die"; reason: string };

/**
 * What the alarm should do AFTER an attempt.
 *
 * "done" covers every settled outcome, `created` and `skipped` alike — and critically also `error`,
 * because an error is raised after the create was sent. Retrying that is how a lost response becomes
 * a duplicate; the standing reservation, not this queue, is what covers it.
 */
export function afterOutcome(job: PendingActivity, outcome: ActivityOutcome, _nowMs: number): OutcomeStep {
  /**
   * A DELIVERY THAT SETTLED HANDS OVER TO THE RECONCILE -- the same two looks the webhook path used to
   * schedule after a created/skipped attempt. Same instance, same job slot, so one activity still has
   * exactly one clock.
   */
  if (job.mode === "deliver" && (outcome === "created" || outcome === "skipped"))
    return { action: "retry", delayMs: RECONCILE_SCHEDULE_MS[0],
      job: { ...job, mode: "reconcile", attempts: 0, reason: "association-settle" } };
  /**
   * A DELIVERY THAT HELD A LINKED COMPANY/DEAL BACK (ACTIVITY_SKIP_MIRRORED_COPIES) comes back as a
   * DELIVERY -- not a reconcile, whose two looks end "done" whatever happens -- so the held destination
   * keeps the full retry schedule behind it. The attempt is not counted, and `mirrorDeferred` makes sure
   * it cannot be held twice. A second "deferred" (impossible by mayDeferMirror) falls through to the
   * ordinary bounded retry below.
   */
  if (job.mode === "deliver" && outcome === "deferred" && !job.mirrorDeferred)
    return { action: "retry", delayMs: MIRROR_SETTLE_MS,
      job: { ...job, mirrorDeferred: true, reason: "mirror-settle" } };
  /**
   * A DELIVERY THAT ERRORED GETS ONE LATE LOOK -- at 15 minutes, never sooner.
   *
   * "error" means a create was sent and its result is unknown, so an immediate retry is exactly how a
   * duplicate is made, and that rule stands. But at 15 minutes the reservation has gone stale, and a
   * stale takeover now checks the card before writing (tookOverStale + alreadyOnCard, which fails closed
   * on "unknown"): a landed entry is found and settled, a lost one is written once. Before this, an
   * errored destination was never written at all, and nothing said so.
   */
  if (job.mode === "deliver" && outcome === "error")
    return { action: "retry", delayMs: RETRY_SCHEDULE_MS[2],
      job: { ...job, mode: "retry", attempts: 2, reason: "error" } };
  const reconciling = job.mode === "reconcile";
  /**
   * A reconcile keeps its appointment whatever the outcome. "created" and "skipped" are the ORDINARY
   * results of looking again — nothing new was attached — and treating them as "done" would cancel
   * the second look, which is the one that catches an association added a few minutes later.
   */
  if (!reconciling && !shouldRetry(outcome)) return { action: "done" };
  const attempts = job.attempts + 1;
  const delayMs = nextDelayMs(attempts, job.mode);
  if (delayMs === null)
    return reconciling
      ? { action: "done" }                                   // both looks taken; nothing failed
      : { action: "die", reason: `still "${outcome}" after ${attempts} attempts` };
  return { action: "retry", job: { ...job, attempts, reason: outcome }, delayMs };
}

// ---------------------------------------------------------------- bindings

/** One instance per activity, so jobs never queue behind each other. */
export const retryName = (object: string, hubspotId: string) => `act:retry:${object}:${hubspotId}`;
/** One well-known instance for the terminal-failure index. Never scheduled, never alarmed. */
export const DEAD_LETTER_NAME = "act:retry:dead";

/** True only where the retry Durable Object is actually bound, i.e. the CRM deployment. */
export const activityRetryBound = (env: Env): boolean => !!env.ACTIVITY_RETRY;

/**
 * Refuses loudly rather than dereferencing an absent namespace. The schedule helpers below already
 * swallow their failures, so on a deployment without the binding they log this reason and carry on;
 * anything that cannot tolerate that must ask activityRetryBound() first.
 */
const stub = (env: Env, name: string) => {
  const ns = env.ACTIVITY_RETRY;
  if (!ns) throw new Error("ACTIVITY_RETRY is not bound on this deployment");
  return ns.get(ns.idFromName(name)) as unknown as DurableObjectStub<ActivityRetry>;
};

export const retryStub = (env: Env, object: string, hubspotId: string) =>
  stub(env, retryName(object, hubspotId));
export const deadLetterStub = (env: Env) => stub(env, DEAD_LETTER_NAME);

/**
 * The producer. Called from the webhook path with whatever the immediate attempt concluded — NEVER
 * from the alarm, which re-arms itself; scheduling from both would give one activity two clocks.
 *
 * Fails soft on purpose. This is a fallback for a rare race; it must not be able to turn into an
 * exception on the path that serves ordinary contact and company events.
 */
/**
 * Look again shortly, because HubSpot will not tell us when the associations land.
 *
 * Deliberately fire-and-forget and deliberately quiet: this is an optimisation over a webhook that
 * does not arrive, and it must never be able to fail the request that scheduled it.
 */
export async function scheduleReconcile(env: Env, object: string, hubspotId: string,
    nowMs = Date.now()): Promise<void> {
  try {
    await retryStub(env, object, hubspotId)
      .schedule({ mode: "reconcile", object, hubspotId, reason: "association-settle", attempts: 0, firstSeenMs: nowMs });
  } catch (e) {
    console.log(`[activity-retry] ${object}=${hubspotId} action=reconcile-schedule-failed reason="${String(e).slice(0, 110)}"`);
  }
}

/**
 * THE WEBHOOK'S WHOLE JOB FOR AN ACTIVITY: record it on its Durable Object, which delivers it at once.
 * See DELIVER_SCHEDULE_MS for why the delivery must not run in the webhook itself.
 *
 * `already-pending` counts as success: that job runs the full sync, which reads the activity afresh.
 * Returns false only when nothing could be recorded, so the caller can deliver inline instead -- an
 * attempt that may be cut off still beats none.
 */
export async function scheduleDelivery(env: Env, object: string, hubspotId: string,
    nowMs = Date.now()): Promise<boolean> {
  if (!activityRetryBound(env)) return false;
  try {
    const r = await retryStub(env, object, hubspotId)
      .schedule({ mode: "deliver", object, hubspotId, reason: "webhook", attempts: 0, firstSeenMs: nowMs });
    console.log(`[activity-retry] ${object}=${hubspotId} action=${r === "scheduled" ? "delivery-queued" : "already-pending"}`);
    return true;
  } catch (e) {
    console.log(`[activity-retry] ${object}=${hubspotId} action=delivery-schedule-failed reason="${String(e).slice(0, 110)}"`);
    return false;
  }
}

export async function scheduleIfUnresolved(env: Env, object: string, hubspotId: string,
    outcome: ActivityOutcome, nowMs = Date.now()): Promise<void> {
  if (!shouldRetry(outcome)) return;
  try {
    const r = await retryStub(env, object, hubspotId)
      .schedule({ object, hubspotId, reason: outcome, attempts: 0, firstSeenMs: nowMs });
    console.log(`[activity-retry] ${object}=${hubspotId} action=${r} reason="${outcome}"`);
  } catch (e) {
    console.log(`[activity-retry] ${object}=${hubspotId} action=schedule-failed reason="${String(e).slice(0, 120)}"`);
  }
}
