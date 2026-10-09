import type { Env } from "./types";

/**
 * HS_RATE_LIMIT_RETRY: THE SWITCH, ITS BOUNDS, AND THE INVOCATION'S RETRY DEADLINE -- the parts of hs()'s
 * rate-limit-aware retry (hubspot.ts hsRateLimited, hsRetryWait) that index.ts reads too (withHsRetryDeadline).
 * A module of its own, importing nothing at run time, so a test that mocks hubspot.ts whole still runs index.ts
 * for real. hubspot.ts re-exports all of it.
 */

/**
 * THE SWITCH: only the literal "true" arms it, and only on the CRM Worker (ENABLE_CRM "true"), so the Work
 * Management Worker -- which runs this same source -- never does, even with the var leaked onto it. Read on
 * every request, so the dashboard can flip it without a deploy.
 */
export function hsRateLimitRetryOn(env: { HS_RATE_LIMIT_RETRY?: string; ENABLE_CRM?: string }): boolean {
  return env.HS_RATE_LIMIT_RETRY === "true" && env.ENABLE_CRM === "true";
}

/**
 * THE BOUNDS (hubspot.ts hsRateLimited, hsRetryWait). Mutable only so tests need not wait them out: `sleep` and
 * `random` are the seams (ui-actor.ts's uiActorTiming precedent).
 *
 * THE SWITCH'S OWN WAITING IS BUDGETED PER INVOCATION, NOT ONLY PER CALL. A person's edit is pushed inside the
 * monday webhook's waitUntil, which Cloudflare cancels about 30 s after the response, and the push is a CHAIN of
 * HubSpot calls, each waiting on the one before: on a cold context the owners' two pages, then the deal pipelines
 * (buildCtx), then the record read, the ownership claim, the PATCH, and a backward move's further PATCHes. At 8 s
 * of the switch's waiting each, six of them end past 40 s, where with the switch off the first of them would have
 * failed at once -- logged, the cell healed, the coalesce queue's entry released. A run Cloudflare cancels
 * mid-wait does none of that: it logs nothing and leaves that entry pending (webhooks.ts coalesceLatest deletes
 * it only in its `finally`), so a later edit of the same cell would join a promise that never settles. So a
 * webhook's env carries a deadline (withHsRetryDeadline, index.ts), and no wait OF THE SWITCH'S OWN ends later
 * than invocationMs after the invocation began.
 *
 * The deadline never cuts TODAY'S waits (hubspot.ts hsRateLimited): whatever hs() off would still retry, and
 * when, it still retries then, so the switch never gives up sooner than off but on HubSpot's daily limit. Past
 * the deadline a call is exactly today's -- and so is its exposure to the waitUntil's end.
 */
export const hsRetry = {
  /** Most attempts of one call the switch makes on its own, the first included. Where its quicker waits came
   *  before today's last attempt would have, that one is made too (hubspot.ts hsRateLimited): 6 at most. */
  maxAttempts: 5,
  /** No single wait of the switch's own is longer. A Retry-After asking for more is not waited out early. */
  maxWaitMs: 3_000,
  /** Most waiting, in all, between the attempts of one call -- today's floor included, since no caller passes
   *  retries above 3 (today's waits then total 2 + 4 = 6 s at most). */
  maxTotalWaitMs: 8_000,
  /** No wait of the switch's own, in a webhook's invocation, ends later than this after it began
   *  (withHsRetryDeadline). Today's waits are not cut by it. */
  invocationMs: 20_000,
  /** No rate-limit signal: the n-th wait is baseMs * 2^(n-1), jittered x0.5..x1.5 (~0.75, 1.5, 3 s). */
  baseMs: 750,
  /** No wait is shorter (a Retry-After of 0 included). */
  minWaitMs: 250,
  sleep: (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms)),
  random: (): number => Math.random(),
};

const HS_RETRY_DEADLINE = Symbol.for("dkm-crm-sync:hs-retry-deadline");

/**
 * THE ENV A WEBHOOK'S WORK RUNS WITH (index.ts fetch, handed to handleMonday and handleHubspot): with the switch
 * on, a copy of `env` carrying the invocation's retry deadline, hsRetry.invocationMs from `nowMs`; off, `env`
 * itself -- the very same object, so nothing at all changes. Every hs() call under that invocation reads it
 * (hsRateLimited), a coalesced re-run included (it reruns the first event's closure, so it keeps the first event's
 * deadline). Only the webhooks' work runs in a waitUntil it could outlive. Every other route works while its
 * client waits, and the cron and the Durable Objects' alarms have no 30 s waitUntil either: none of them carries
 * a deadline, so their calls are bounded per call only.
 */
export function withHsRetryDeadline(env: Env, nowMs: number = Date.now()): Env {
  if (!hsRateLimitRetryOn(env)) return env;
  const copy = { ...env } as Env & Record<symbol, unknown>;
  copy[HS_RETRY_DEADLINE] = nowMs + hsRetry.invocationMs;
  return copy;
}

/** The retry deadline (epoch ms) an invocation's env carries (withHsRetryDeadline), or undefined. */
export function hsRetryDeadlineOf(env: Env): number | undefined {
  const at = (env as unknown as Record<symbol, unknown>)[HS_RETRY_DEADLINE];
  return typeof at === "number" ? at : undefined;
}
