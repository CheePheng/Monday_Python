/**
 * The durable queue that drains an oversized webhook batch's overflow. Storage and alarm only — the
 * policy lives in deferred-sync.ts, the same split used by idempotency and the activity retry.
 *
 * ONE INSTANCE, deliberately: its serialization IS the rate control. See deferred-sync.ts.
 */
import { DurableObject } from "cloudflare:workers";
import type { Budget, Env } from "./types";
import type { Ctx } from "./types";
import { webhookOpts } from "./run-opts";
import { deleteHubspotObject, getCtxCached, recheckDanglingClears, syncHubspotObject } from "./sync";
import { noticeOwnerChange, NOTICE_BUSY_GRACE_MS, NOTICE_ERROR_GRACE_MS, type NoticeOutcome } from "./owner-notice";
import {
  deferKey, WAVE, WAVE_GAP_MS, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_QUEUE,
  type DeferredItem,
} from "./deferred-sync";

/** `droppedKeys`: the deferKey of each item refused at the ceiling (the TAIL of the batch), so a caller with a
 *  fallback runs it for exactly those (spillDeferredLeftover). */
export interface EnqueueResult { queued: number; duplicate: number; dropped: number; depth: number; droppedKeys: string[] }

/** An owner notice still retryable once its grace has run out: an attempt like any failure, its clocks kept
 *  (`clocked`: the entry with them). */
class NoticeStillBusy extends Error {
  constructor(message: string, readonly clocked: DeferredItem) { super(message); }
}

/**
 * The last line of an owner notice the queue gives up on: what is lost, and what a person does about it. A notice
 * still "pending" past its grace is a 待通知 of unknown age -- monday gave no changed_at and it is not the Worker's
 * own open flag, or the workflow already finished that one -- which is never called "stuck" (that needs an age),
 * so this is where its recovery is said: a bare "abandoned" left a wedged card looking like a queue hiccup.
 */
function noticeGivenUp(r: NoticeOutcome, forMs: number, graceMs: number): string {
  const s = `owner notice ${r} for ${Math.round(forMs / 1000)} s, past its ${graceMs / 1000} s grace`;
  const recover = "check this card's 上次通知Owner and the board's workflow run history first -- setting 待通知 again"
    + " mails whoever the card's Contact owner shows, even someone already told -- then fix the workflow, and on this"
    + " card clear 通知状态 and set it to 待通知 by hand";
  if (r === "pending")
    return `${s}: 通知状态 has stood at 待通知 for an earlier assignment all this time, of unknown age (monday gave`
      + ` no changed_at): the board's workflow did not finish it, or someone else set it. This assignment is NOT`
      + ` flagged and nothing re-runs it. To recover: ${recover}`;
  if (r === "waiting")
    return `${s}: this assignment's own 待通知 still stands -- the board's workflow has not finished it. To recover: ${recover}`;
  if (r === "error")
    return `${s}: it kept failing (its [owner-notice] lines say why), and nothing re-runs it. To recover, once the`
      + ` cause is fixed: if this card's Contact owner was not told, ${recover}`;
  return `${s}: the card's Contact owner never showed HubSpot's owner (its sync kept failing?), or the contact's`
    + ` notice lock stayed held. Nothing re-runs it`;
}

export class DeferredSync extends DurableObject<Env> {
  /**
   * How many entries at the HEAD of the stored queue the running wave is processing (0 between waves).
   *
   * A wave's passes wait on HubSpot and monday, and enqueue is delivered while they do. Two things went
   * wrong there, both proven against this DO (deferred-sync.test.ts, "work armed while a wave is running"):
   *   - enqueue counted an entry the wave was ALREADY PROCESSING as "waiting", so the same record armed
   *     again (hiffer's 6 -> 5 re-check, while the 10 -> 6 one was reading HubSpot) was reported a duplicate
   *     -- though the pass that "covered" it had read HubSpot before the 6 -> 5 clear;
   *   - alarm() wrote back the queue it had read when it STARTED, overwriting whatever enqueue appended
   *     meanwhile, or wiping it with deleteAll when that queue had been empty.
   * The head is safe to describe by a count: enqueue only appends, and only alarm() removes.
   *
   * In memory only, deliberately. If the instance is lost mid-wave, so is the wave: the runtime retries the
   * alarm and the entries are still in storage (nothing is removed until a wave finishes), so a fresh
   * instance treating them as waiting is right -- they will be run again, after whatever armed them.
   */
  private inFlight = 0;

  /**
   * Append overflow, skipping anything already waiting.
   *
   * DEDUPLICATION IS THE POINT OF THE KEY. A bulk update fires the same record in several consecutive
   * batches, and without this the queue would hold the same contact a dozen times and re-sync it a
   * dozen times — the burst amplified rather than absorbed.
   *
   * "Waiting" excludes the running wave's own entries (inFlight): a record armed again while its pass is in
   * flight is OWED AGAIN, because that pass may already have read what this arm is about -- except for an item
   * that only asks for the work to be coming (DeferredItem.ensure): one running is coming.
   *
   * A FRESH TRIGGER FOR AN OWNER NOTICE ALREADY WAITING STARTS IT AFRESH: no attempts spent, no grace used up.
   * The entry is new work's only carrier (a new reassignment merged into it), and left with the attempts an outage
   * or a busy card had spent, that new owner got only what remained.
   */
  async enqueue(items: DeferredItem[]): Promise<EnqueueResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const q = (await this.ctx.storage.get<DeferredItem[]>("q")) ?? [];
      const head = Math.min(this.inFlight, q.length);
      const running = new Set(q.slice(0, head).map(deferKey));
      /** deferKey -> index of the entry waiting under it (the running wave's own excluded). */
      const waiting = new Map<string, number>();
      for (let i = head; i < q.length; i++) waiting.set(deferKey(q[i]), i);
      let queued = 0, duplicate = 0, dropped = 0;
      const droppedKeys: string[] = [];
      for (const it of items) {
        const k = deferKey(it);
        const at = waiting.get(k);
        if (at != null) {
          duplicate++;
          const w = q[at];
          if (w.notice && (w.attempts || w.busySince != null || w.errorSince != null))
            q[at] = { type: w.type, id: w.id, notice: true };
          continue;
        }
        if (it.ensure && running.has(k)) { duplicate++; continue; }
        if (q.length >= MAX_QUEUE) { dropped++; droppedKeys.push(k); continue; }
        q.push({ type: it.type, id: it.id, ...(it.deleted ? { deleted: true } : {}), ...(it.recheck ? { recheck: true } : {}),
          ...(it.notice ? { notice: true } : {}) });
        waiting.set(k, q.length - 1);
        queued++;
      }
      await this.ctx.storage.put("q", q);
      // Only arm if nothing is already armed: a burst of spills must not keep pushing the wave out.
      if (q.length && (await this.ctx.storage.getAlarm()) == null)
        await this.ctx.storage.setAlarm(Date.now() + FIRST_DELAY_MS);
      if (dropped)
        console.log(`[deferred] action=over-capacity dropped=${dropped} depth=${q.length}`
          + ` reason="queue ceiling ${MAX_QUEUE} reached; a bulk load this size should be run deliberately"`);
      return { queued, duplicate, dropped, depth: q.length, droppedKeys };
    });
  }

  /** For tests and operators. */
  async depth(): Promise<number> {
    return ((await this.ctx.storage.get<DeferredItem[]>("q")) ?? []).length;
  }

  async alarm(): Promise<void> {
    // One wave at a time. An alarm that an enqueue armed during a long wave can come due before that wave
    // ends; the running wave re-arms when it finishes (the queue is not empty), so this one has nothing to do.
    if (this.inFlight) {
      console.log(`[deferred] action=wave-overlap in_flight=${this.inFlight} reason="a wave is still running; it re-arms when done"`);
      return;
    }
    const q = (await this.ctx.storage.get<DeferredItem[]>("q")) ?? [];
    // deleteAlarm() explicitly, not just deleteAll(): the two are separate, and leaving a stale alarm
    // behind would make enqueue's "already armed?" check refuse to schedule the next wave.
    if (!q.length) { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return; }

    const wave = q.slice(0, WAVE);
    const opts = webhookOpts(this.env);
    const budget: Budget = { left: 30 };
    const retry: DeferredItem[] = [];
    let ok = 0;

    this.inFlight = wave.length;
    // One owner list for every owner notice in this wave; failing to build it only means the owner's address
    // comes from HubSpot's owner API instead.
    let noticeCtx: Promise<Ctx | undefined> | undefined;
    try {
      for (const it of wave) {
        try {
          if (it.deleted) await deleteHubspotObject(this.env, it.type, it.id, opts, budget);
          else if (it.recheck) await recheckDanglingClears(this.env, it.type, it.id, opts, budget);
          else if (it.notice) {
            /**
             * An owner notice (DeferredItem.notice). It never throws; what it answers decides:
             *   - "flagged" is RUN ONCE MORE, behind everything waiting, afresh: to read whether the board's
             *     workflow finished the flag ("already"), is still at it ("waiting") or never will ("stuck", loud).
             *     Taken as done, a flag the workflow never ran (switched off, its Outlook connection lapsed) read
             *     "flagged" and nothing ever said its owner had not been told.
             *   - "busy" -- another run holds the contact's lock, its owner kept changing, or its card does not show
             *     the new owner yet (the workflow mails whoever the card shows) -- "pending" -- 通知状态 still reads
             *     待通知 for an EARLIER assignment, the workflow not done with it -- and "waiting" -- this
             *     assignment's own 待通知 not finished yet -- are retried, so a newer owner is never just dropped.
             *     The retry goes behind everything waiting, the contact's own sync included. Until the entry has
             *     been in them for NOTICE_BUSY_GRACE_MS (the longer of the lock's hold and a flag's stuck threshold,
             *     plus a margin) a retry is NOT an attempt: a run killed inside the lock (a deploy restarting this
             *     queue mid-wave) holds it for the whole hold, and three quick counted retries all landed inside it
             *     and abandoned the notice.
             *   - "error" is retried as well -- it used to count as done -- and free for longer
             *     (NOTICE_ERROR_GRACE_MS): counted at once, a ~40 s monday or HubSpot outage lost the notice for
             *     good, and no later event ever brings one back. A retry after a write that did land is safe: it
             *     finds 待通知 waiting ("pending") or the workflow's 上次通知Owner ("already"), and writes nothing.
             * Each grace is counted from the entry's first answer of its kind (busySince, errorSince), whatever it
             * answers in between, and each is followed by counted attempts as usual: still bounded.
             */
            const r = await noticeOwnerChange(this.env, it.id,
              await (noticeCtx ??= getCtxCached(this.env).catch(() => undefined)));
            if (r === "flagged") {
              retry.push({ type: it.type, id: it.id, notice: true, busySince: Date.now() });
              console.log(`[deferred] ${it.type}=${it.id} notice action=check-flag`
                + ` reason="flagged: run once more to read whether the board's workflow finished it"`);
              continue;
            }
            if (r === "busy" || r === "pending" || r === "waiting" || r === "error") {
              const err = r === "error";
              const since = (err ? it.errorSince : it.busySince) ?? Date.now();
              const forMs = Date.now() - since;
              const grace = err ? NOTICE_ERROR_GRACE_MS : NOTICE_BUSY_GRACE_MS;
              const clocked: DeferredItem = err ? { ...it, errorSince: since } : { ...it, busySince: since };
              if (forMs < grace) {
                retry.push(clocked);
                console.log(`[deferred] ${it.type}=${it.id} notice action=${r}-retry ${err ? "error" : "busy"}_s=${Math.round(forMs / 1000)}`
                  + ` grace_s=${grace / 1000} attempts=${it.attempts ?? 0}`
                  + ` reason="${r === "busy"
                    ? "the contact's notice is busy (its lock is held, its owner kept changing, or its card does not show the owner yet)"
                    : r === "pending" ? "通知状态 still waits on the board's workflow for an earlier assignment"
                    : r === "waiting" ? "this assignment's own 待通知 still waits on the board's workflow"
                    : "the notice failed (its [owner-notice] line says why)"}: retried,`
                  + ` not counted as an attempt until the grace runs out"`);
                continue;
              }
              throw new NoticeStillBusy(noticeGivenUp(r, forMs, grace), clocked);
            }
          }
          else await syncHubspotObject(this.env, it.type, it.id, opts, budget);
          ok++;
        } catch (e) {
          /**
           * BOUNDED. A record that keeps failing is abandoned with a loud line rather than circulating
           * forever: an endless queue would keep re-reading the same broken record and crowd out the
           * work behind it, which is a worse outcome than one visible loss.
           */
          const attempts = (it.attempts ?? 0) + 1;
          // A notice past its grace keeps its clocks (DeferredItem.busySince / errorSince), so it stays counted.
          // Nothing else ever carries them, so every other entry is retried exactly as before.
          const base: DeferredItem = e instanceof NoticeStillBusy ? e.clocked : it;
          if (attempts < MAX_ATTEMPTS) retry.push({ ...base, attempts });
          else if (e instanceof NoticeStillBusy)
            // The whole line: it is the notice's last, and says how to recover the card.
            console.log(`[deferred] ${it.type}=${it.id} notice action=abandoned attempts=${attempts} reason="${e.message}"`);
          else console.log(`[deferred] ${it.type}=${it.id}${it.recheck ? " recheck" : it.notice ? " notice" : ""} action=abandoned attempts=${attempts}`
            + ` reason="${String(e).slice(0, 120)}"`);
        }
      }

      // WRITE BACK FROM THE QUEUE AS IT IS NOW, not as it was when the wave started: remove exactly the
      // entries this wave ran (the head) and keep everything enqueue appended meanwhile. A retry whose record
      // was armed again during the wave is dropped -- that fresh entry is the same work, still owed.
      const next = await this.ctx.blockConcurrencyWhile(async () => {
        const now = (await this.ctx.storage.get<DeferredItem[]>("q")) ?? [];
        const rest = [...now];
        for (const it of wave) {
          const at = rest.findIndex(x => deferKey(x) === deferKey(it));
          if (at >= 0) rest.splice(at, 1);
        }
        const owed = new Set(rest.map(deferKey));
        const kept = retry.filter(r => !owed.has(deferKey(r)));
        const out = [...rest, ...kept];
        if (out.length) {
          await this.ctx.storage.put("q", out);
          await this.ctx.storage.setAlarm(Date.now() + WAVE_GAP_MS);
        } else { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); }
        return { remaining: out.length, requeued: kept.length };
      });
      console.log(`[deferred] action=wave done=${ok} requeued=${next.requeued} remaining=${next.remaining}`);
    } finally {
      this.inFlight = 0;
    }
  }
}
