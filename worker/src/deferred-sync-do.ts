/**
 * The durable queue that drains an oversized webhook batch's overflow. Storage and alarm only — the
 * policy lives in deferred-sync.ts, the same split used by idempotency and the activity retry.
 *
 * ONE INSTANCE, deliberately: its serialization IS the rate control. See deferred-sync.ts.
 */
import { DurableObject } from "cloudflare:workers";
import type { Budget, Env } from "./types";
import { webhookOpts } from "./run-opts";
import { deleteHubspotObject, syncHubspotObject } from "./sync";
import {
  deferKey, WAVE, WAVE_GAP_MS, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_QUEUE,
  type DeferredItem,
} from "./deferred-sync";

export interface EnqueueResult { queued: number; duplicate: number; dropped: number; depth: number }

export class DeferredSync extends DurableObject<Env> {
  /**
   * Append overflow, skipping anything already waiting.
   *
   * DEDUPLICATION IS THE POINT OF THE KEY. A bulk update fires the same record in several consecutive
   * batches, and without this the queue would hold the same contact a dozen times and re-sync it a
   * dozen times — the burst amplified rather than absorbed.
   */
  async enqueue(items: DeferredItem[]): Promise<EnqueueResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const q = (await this.ctx.storage.get<DeferredItem[]>("q")) ?? [];
      const seen = new Set(q.map(deferKey));
      let queued = 0, duplicate = 0, dropped = 0;
      for (const it of items) {
        const k = deferKey(it);
        if (seen.has(k)) { duplicate++; continue; }
        if (q.length >= MAX_QUEUE) { dropped++; continue; }
        q.push({ type: it.type, id: it.id, ...(it.deleted ? { deleted: true } : {}) });
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
    const q = (await this.ctx.storage.get<DeferredItem[]>("q")) ?? [];
    // deleteAlarm() explicitly, not just deleteAll(): the two are separate, and leaving a stale alarm
    // behind would make enqueue's "already armed?" check refuse to schedule the next wave.
    if (!q.length) { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return; }

    const wave = q.slice(0, WAVE);
    const rest = q.slice(WAVE);
    const opts = webhookOpts(this.env);
    const budget: Budget = { left: 30 };
    const retry: DeferredItem[] = [];
    let ok = 0;

    for (const it of wave) {
      try {
        if (it.deleted) await deleteHubspotObject(this.env, it.type, it.id, opts, budget);
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
        else console.log(`[deferred] ${it.type}=${it.id} action=abandoned attempts=${attempts}`
          + ` reason="${String(e).slice(0, 120)}"`);
      }
    }

    const next = [...rest, ...retry];
    await this.ctx.storage.put("q", next);
    if (next.length) await this.ctx.storage.setAlarm(Date.now() + WAVE_GAP_MS);
    else { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); }
    console.log(`[deferred] action=wave done=${ok} requeued=${retry.length} remaining=${next.length}`);
  }
}
