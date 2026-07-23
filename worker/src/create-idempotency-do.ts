import { DurableObject } from "cloudflare:workers";
import { decideClaim, type CreateState, type CreateResult, type Claim } from "./idempotency";

const RETENTION_MS = 24 * 60 * 60_000; // self-clean stored state 24h after the last claim/save

/** One instance per idempotency key (via idFromName). Stores a single CreateState. `claim` serializes its
 * read-modify-write with blockConcurrencyWhile so two concurrent same-key requests can't both proceed —
 * the whole point of the DO (blockConcurrencyWhile is available on every DO backend, unlike the async KV
 * transaction() which isn't guaranteed on SQLite-backed classes). Every claim/save refreshes a 24h cleanup
 * alarm, so no key (completed, partial, or abandoned) lingers forever, while same-day retries are covered. */
export class CreateIdempotency extends DurableObject {
  async claim(nowMs: number): Promise<Claim> {
    let decision!: Claim;
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<CreateState>("state");
      decision = decideClaim(state, nowMs);
      if (decision.status === "proceed")
        await this.ctx.storage.put("state", { status: "inflight", result: decision.result, updatedAt: nowMs });
    });
    await this.ctx.storage.setAlarm(nowMs + RETENTION_MS);
    return decision;
  }
  async save(result: CreateResult, done: boolean, updatedAt: number): Promise<void> {
    await this.ctx.storage.put("state", { status: done ? "done" : "inflight", result, updatedAt });
    // Alarm is always relative to REAL now — never `updatedAt`, which a release passes as 0 to force
    // reclaimability; basing the alarm on 0 would schedule cleanup in 1970 and wipe the partial at once.
    await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
  }
  // --- monday card registry (separate instances, keyed `card:<boardId>:<hubspotId>`) ---
  // monday's items_page_by_column_values (the HubSpot-ID column search) is EVENTUALLY CONSISTENT, so a card
  // created seconds ago can be invisible to another creator. Several paths create a card for the same
  // record (the app's create endpoint, the HubSpot->monday sync, the association pass), so a search miss
  // used to let a second path create a DUPLICATE card. Each path records its card here and checks first.
  async getCard(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("card")) ?? null;
  }
  async setCard(itemId: string, nowMs: number): Promise<void> {
    await this.ctx.storage.put("card", itemId);
    await this.ctx.storage.setAlarm(nowMs + RETENTION_MS);
  }

  async alarm(): Promise<void> { await this.ctx.storage.deleteAll(); }
}
