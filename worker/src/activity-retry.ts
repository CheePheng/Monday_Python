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
  | "error";       // the create threw AFTER being sent; it may have landed. NEVER retried here.

const RETRYABLE: ReadonlySet<ActivityOutcome> = new Set<ActivityOutcome>(["unresolved", "blocked", "creating"]);
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

export const scheduleFor = (mode?: PendingMode) =>
  mode === "reconcile" ? RECONCILE_SCHEDULE_MS : RETRY_SCHEDULE_MS;

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
export type PendingMode = "retry" | "reconcile";

export interface PendingActivity {
  /** Absent means "retry", so jobs written before reconciles existed still read correctly. */
  mode?: PendingMode;
  object: string;        // "emails" | "calls" | "notes" | "meetings"
  hubspotId: string;
  reason: string;        // the outcome that caused the last scheduling
  attempts: number;      // attempts COMPLETED so far
  firstSeenMs: number;   // when the webhook first failed to resolve — the deferral clock
}

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

const stub = (env: Env, name: string) =>
  env.ACTIVITY_RETRY.get(env.ACTIVITY_RETRY.idFromName(name)) as unknown as DurableObjectStub<ActivityRetry>;

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
