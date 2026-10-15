/**
 * THE STORAGE AND ALARM SHELL for the durable activity retry. All decisions live in activity-retry.ts
 * — the same split create-idempotency-do.ts uses with idempotency.ts, and for the same reason: the
 * policy is the part worth testing, and it should not need a Workers runtime to run.
 *
 * One instance per activity (`act:retry:<object>:<id>`), plus one well-known instance holding the
 * terminal-failure index. An instance stores at most one job and at most one alarm, so a stuck
 * activity cannot delay any other.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import {
  stepForAlarm, afterOutcome, nextDelayMs, deadLetterStub,
  DEAD_LETTER_CAP, scheduleFor, mayDeferMirror,
  type PendingActivity, type DeadActivity,
} from "./activity-retry";
import { syncHubspotActivity, activitySyncEnabled, skipMirroredCopies } from "./activity-sync";

export class ActivityRetry extends DurableObject<Env> {
  /**
   * Record a pending activity, first delivery wins.
   *
   * AN EXISTING JOB IS LEFT EXACTLY AS IT IS. Webhook redeliveries for one activity are ordinary, and
   * each one resetting `attempts` and the alarm would turn a bounded schedule into an unbounded one
   * driven by however often HubSpot happens to resend.
   */
  async schedule(job: PendingActivity): Promise<"scheduled" | "already-pending"> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<PendingActivity>("job")) {
        /**
         * A JOB WITH NO ALARM IS NOT PENDING, IT IS ORPHANED -- an alarm the runtime killed outright
         * (wall clock, eviction, deploy) after its own retries. Since the webhook now hands every
         * delivery here, answering "already-pending" for it would swallow every later webhook for this
         * activity forever. Re-arm it instead; the job's attempt count is unchanged.
         */
        if ((await this.ctx.storage.getAlarm()) === null) {
          await this.ctx.storage.setAlarm(Date.now());
          return "scheduled" as const;
        }
        return "already-pending" as const;
      }
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(Date.now() + scheduleFor(job.mode)[0]);
      return "scheduled" as const;
    });
  }

  /** For tests and operators. */
  async peek(): Promise<PendingActivity | null> {
    return (await this.ctx.storage.get<PendingActivity>("job")) ?? null;
  }

  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<PendingActivity>("job");
    if (!job) { await this.ctx.storage.deleteAll(); return; }   // cancelled, or already settled

    try {
      const step = stepForAlarm(job, { enabled: activitySyncEnabled(this.env), nowMs: Date.now() });
      if (step.action === "die") return this.die(job, step.reason);
      if (step.action === "defer") {
        // NOT an attempt. A disabled feature must cost the job nothing but time.
        await this.ctx.storage.setAlarm(Date.now() + step.delayMs);
        console.log(`[activity-retry] ${job.object}=${job.hubspotId} action=deferred reason="ENABLE_ACTIVITY_SYNC is off"`);
        return;
      }

      // The FULL sync path, not a reimplementation of it: the flag, the cutover, the monday-origin
      // marker, the association lookup, canary scope, the card lookup and the durable create-once
      // mapping are all enforced exactly once, in the place they are already tested.
      // ACTIVITY_SKIP_MIRRORED_COPIES: only a job's first delivery may hold a linked Company/Deal back
      // (mayDeferMirror). Flag off, the call is exactly the three-argument call it has always been.
      const outcome = mayDeferMirror(job, skipMirroredCopies(this.env))
        ? await syncHubspotActivity(this.env, job.object, job.hubspotId, { deferMirrorCheck: true })
        : await syncHubspotActivity(this.env, job.object, job.hubspotId);
      const next = afterOutcome(job, outcome, Date.now());
      if (next.action === "done") {
        await this.ctx.storage.deleteAll();
        console.log(`[activity-retry] ${job.object}=${job.hubspotId} action=settled outcome=${outcome} attempts=${job.attempts + 1}`);
        return;
      }
      if (next.action === "die") return this.die({ ...job, attempts: job.attempts + 1 }, next.reason);
      await this.ctx.storage.put("job", next.job);
      await this.ctx.storage.setAlarm(Date.now() + next.delayMs);
      console.log(`[activity-retry] ${job.object}=${job.hubspotId} action=rescheduled attempt=${next.job.attempts} in=${next.delayMs}ms outcome=${outcome}`);
    } catch (e) {
      /**
       * RE-ARM DELIBERATELY RATHER THAN RETHROW. An alarm that throws is retried by the runtime on its
       * own schedule, which would spend attempts this code never counted and could run the sync more
       * often than the bounded schedule allows. Catching here keeps one clock.
       */
      const attempts = job.attempts + 1;
      const delayMs = nextDelayMs(attempts, job.mode);
      if (delayMs === null) return this.die({ ...job, attempts }, `retry threw: ${String(e).slice(0, 120)}`);
      await this.ctx.storage.put("job", { ...job, attempts, reason: "error" });
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
      console.log(`[activity-retry] ${job.object}=${job.hubspotId} action=threw attempt=${attempts} reason="${String(e).slice(0, 120)}"`);
    }
  }

  /**
   * Give up — loudly, and leaving a record.
   *
   * THE JOB IS DELETED, NOT TOMBSTONED. A tombstone would make `schedule` a no-op forever, so a
   * genuinely new delivery for the same activity months later could never start a fresh cycle. The
   * failure survives in the dead-letter index and in the log instead, where it can be looked at.
   */
  private async die(job: PendingActivity, terminalReason: string): Promise<void> {
    console.log(`[activity-retry] ${job.object}=${job.hubspotId} action=terminal`
      + ` attempts=${job.attempts} age=${Math.round((Date.now() - job.firstSeenMs) / 1000)}s`
      + ` reason="${terminalReason}"`);
    try {
      await deadLetterStub(this.env).record({ ...job, diedAtMs: Date.now(), terminalReason });
    } catch (e) {
      console.log(`[activity-retry] ${job.object}=${job.hubspotId} action=deadletter-failed reason="${String(e).slice(0, 100)}"`);
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ------------------------------------------------ the dead-letter index (one instance, no alarm)

  async record(dead: DeadActivity): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const list = (await this.ctx.storage.get<DeadActivity[]>("dead")) ?? [];
      await this.ctx.storage.put("dead", [dead, ...list].slice(0, DEAD_LETTER_CAP));
    });
  }

  async listDead(): Promise<DeadActivity[]> {
    return (await this.ctx.storage.get<DeadActivity[]>("dead")) ?? [];
  }
}
