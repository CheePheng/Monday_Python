/**
 * The durable queue that drains an oversized webhook batch's overflow. Storage and alarm only — the
 * policy lives in deferred-sync.ts, the same split used by idempotency and the activity retry.
 *
 * ONE INSTANCE, deliberately: its serialization IS the rate control. See deferred-sync.ts.
 */
import { DurableObject } from "cloudflare:workers";
import type { Budget, Env } from "./types";
import { webhookOpts } from "./run-opts";
import { deleteHubspotObject, recheckDanglingClears, syncHubspotObject } from "./sync";
import {
  deferKey, WAVE, WAVE_GAP_MS, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_QUEUE,
  type DeferredItem,
} from "./deferred-sync";

export interface EnqueueResult { queued: number; duplicate: number; dropped: number; depth: number }

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
   * flight is OWED AGAIN, because that pass may already have read what this arm is about.
   */
  async enqueue(items: DeferredItem[]): Promise<EnqueueResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const q = (await this.ctx.storage.get<DeferredItem[]>("q")) ?? [];
      const seen = new Set(q.slice(Math.min(this.inFlight, q.length)).map(deferKey));
      let queued = 0, duplicate = 0, dropped = 0;
      for (const it of items) {
        const k = deferKey(it);
        if (seen.has(k)) { duplicate++; continue; }
        if (q.length >= MAX_QUEUE) { dropped++; continue; }
        q.push({ type: it.type, id: it.id, ...(it.deleted ? { deleted: true } : {}), ...(it.recheck ? { recheck: true } : {}) });
        seen.add(k);
        queued++;
      }
      await this.ctx.storage.put("q", q);
      // Only arm if nothing is already armed: a burst of spills must not keep pushing the wave out.
      if (q.length && (await this.ctx.storage.getAlarm()) == null)
        await this.ctx.storage.setAlarm(Date.now() + FIRST_DELAY_MS);
      if (dropped)
        console.log(`[deferred] action=over-capacity dropped=${dropped} depth=${q.length}`
          + ` reason="queue ceiling ${MAX_QUEUE} reached; a bulk load this size should be run deliberately"`);
      return { queued, duplicate, dropped, depth: q.length };
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
    try {
      for (const it of wave) {
        try {
          if (it.deleted) await deleteHubspotObject(this.env, it.type, it.id, opts, budget);
          else if (it.recheck) await recheckDanglingClears(this.env, it.type, it.id, opts, budget);
          else await syncHubspotObject(this.env, it.type, it.id, opts, budget);
          ok++;
        } catch (e) {
          /**
           * BOUNDED. A record that keeps failing is abandoned with a loud line rather than circulating
           * forever: an endless queue would keep re-reading the same broken record and crowd out the
           * work behind it, which is a worse outcome than one visible loss.
           */
          const attempts = (it.attempts ?? 0) + 1;
          if (attempts < MAX_ATTEMPTS) retry.push({ ...it, attempts });
          else console.log(`[deferred] ${it.type}=${it.id}${it.recheck ? " recheck" : ""} action=abandoned attempts=${attempts}`
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
