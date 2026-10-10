import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { decideClaim, type CreateState, type CreateResult, type Claim } from "./idempotency";
import { webhookOpts } from "./run-opts";
import { retryMarkedEdits, settleAbandonedCreate, settleCardWatch } from "./sync";
import {
  STAMP_NOTE_WINDOW_MS, VERIFY_DELAY_MS, eventTypeOfObject, holdWindowMs, nextAlarmAt,
  reduceAlarm, reduceBeginConverge, reduceBeginRetry, reduceClearMarks, reduceFinishConverge, reduceMarkEdits,
  reduceSupersede, reduceWatchCells, stampSuspicious, timeOf, watchRetryOn,
  type CardWatch, type ConvergeOutcome, type EditMark, type MarkInput, type StampNote, type WatchBase, type WatchReply,
  type WatchReq,
} from "./card-watch";
import { spillDeferred } from "./deferred-sync";
import { getItemsColumnText, setColumns } from "./monday";

/** A Sync State stamp to read back (the card watch's register): restore `hw` if the card holds an older one.
 *  `tries`: read-backs that failed (a rate-limited restamp is never waited out: it is tried again, VERIFY_TRIES times). */
interface StampVerify { hw: string; syncCol: string; boardId: string; itemId: string; dueAt: number; tries?: number }
const VERIFY_TRIES = 3;
const VERIFY_RETRY_MS = 15_000;

/** Self-clean stored state 24h after the last claim/save. Exported only so a test can pin sync.ts's
 *  create-window gate (CREATE_WINDOW_MS) to it: a row's queue can be read for as long as the row lives. */
export const RETENTION_MS = 24 * 60 * 60_000;

/**
 * A CREATE WINDOW THIS ROW IS WATCHING (monday-row create keys only): the card to settle if its creator
 * stops. Stored from the creator's hold (and every heartbeat) until the window is known to be closed --
 * a release that acknowledged the whole queue, a link, a plain finish, or this row's alarm finding
 * nothing left to do. While it is stored the row's alarm is this window's, not the 24 h cleanup's (see
 * alarm). `staleMs` is the heartbeat limit the claim uses (CREATE_CLAIM_STALE_MS, passed in by
 * card-registry so this file needs nothing from it); `attempts` counts failed takeovers.
 */
export interface SettleWatch { boardId: string; itemId: string; staleMs: number; attempts?: number }
/** How long after a hold goes stale (or a queue is left without one) the row's alarm acts. */
const WATCH_MARGIN_MS = 5_000;
/** A takeover whose sync throws (a monday rate limit, a HubSpot 5xx) is retried after these delays, then
 *  given up -- loudly, and with the queue still stored for whoever reads the row next. */
const WATCH_RETRY_MS = [60_000, 5 * 60_000];

/**
 * Card-registry entry: either a settled card id, or an in-progress reservation.
 *
 * Monday-row create keys (`mdcreate:`) only:
 *   - `settlingAt`: the HubSpot record EXISTS and its id is recorded, and its creator is still bringing
 *     the new card into line (see settleCreate). It is a HEARTBEAT, renewed at each step of the creator,
 *     so a creator that stalls or dies lets it go stale within CREATE_CLAIM_STALE_MS of its last sign
 *     of life -- and the row's own alarm, set for that moment, then settles the card in its place (see
 *     alarm), so nothing waits on an event that may never come.
 *   - `baseline`: the Sync State this Worker last wrote on the card for this record (the id write-back's,
 *     then the settle's; an adoption's). A read that lags monday cannot show it, so an edit replayed on
 *     such a read borrows it rather than reading HubSpot as "newer" than an empty cell.
 */
interface CardEntry { itemId?: string; creatingAt?: number; settlingAt?: number; baseline?: string }

/**
 * A monday edit that reached a card while its HubSpot record DID NOT EXIST YET -- the create was in
 * flight -- so there was nothing to send it to (monday-row create keys only). WHAT was edited and by
 * WHOM, never the value: it is replayed from a fresh read of the card, so HubSpot is sent what is on
 * screen when the replay runs, not what an event carried.
 *
 * The queue fills only while the record is being made (`creatingAt`). Once the record exists, an edit
 * is sent by its own event, as on any linked card, and nothing queues. Entries stay stored until
 * someone has replayed them: the creator (settleCreate "release" with `ack`), or -- when the creator
 * stalls or dies -- the row's own alarm (see alarm), or whoever reads the row first (claimCard "have",
 * or createWindow).
 *
 * Only a PERSON's entry is replayed. An automation's is recorded so the creator can log it and show the
 * column as HubSpot has it (the old skip-and-drop, made visible); our own token's events never get here
 * -- the provenance gate refuses them before any claim.
 */
export interface PendingEdit {
  cols: string[];
  name?: boolean;
  actorClass: "person" | "automation" | "integration";
  actor?: string;
  at: number;
  /**
   * A NOTE, not an edit: who ELSE wrote these cells while the window was open -- our own token (an echo,
   * or "ask ada"), or an automation whose event the webhook drops before any sync (the coarse Stage). Its
   * event never reaches a claim, so without a note the queue could not see it, and a replay would send
   * that writer's value as the person's edit it overwrote. Never replayed itself. See noteEdit.
   */
  note?: boolean;
}
/** A runaway queue must not grow a Durable Object without bound; the replay reads the card anyway. */
const MAX_PENDING = 50;

/**
 * WHAT A CREATOR KNEW WHEN IT MADE THE RECORD (monday-row create keys only): stored with its hold, and
 * kept until the create window is settled -- by the creator's own round, or by whoever settles the card
 * in its place (this row's alarm, or the first sync to find the creator gone). With it, that stand-in
 * runs the creator's round (sync.ts settleRound) instead of the ordinary engine, which cannot tell a
 * person's edit on the new card from HubSpot's create-time value and copies the latter over the former.
 */
export interface CreateSnapshot {
  /** Each two-way cell (by column id, and "~name" for the item name) as the create read it, normalised as
   *  sync.ts cellKey normalises it: a cell that differs now was changed while the record was being made. */
  built: Record<string, string>;
  /** What the create sent (its payload). A late replay checks HubSpot still holds it (hubspotMovedOn). */
  sent: Record<string, string>;
  /**
   * The creator's own event: the columns it named, and whose it was. The webhook folds a later event on
   * the same column into a re-run of THIS one (coalesceLatest), and that re-run dies with the creator.
   */
  trigger?: { cols: string[]; name?: boolean; actorClass: "person" | "automation"; actor?: string };
  /** When the record was held (ms). */
  at: number;
}

export type CardClaim =
  /**
   * A card already exists for this record. Monday-row create keys only:
   *   - `settling`: its creator is alive and still bringing the card into line. The caller applies its
   *     own edit (the record exists) but leaves the rest of the card to the creator.
   *   - `pending`: edits that queued while the record was being made and that nobody has replayed -- the
   *     creator stalled or died. Whoever reads "have" first takes them, so they are applied late rather
   *     than never. Never handed out while `settling`: they are the creator's then. Notes ride along.
   *   - `snapshot`: the create window was never settled (see CreateSnapshot), taken with the queue: the
   *     reader settles the card in the creator's place.
   *   - `baseline`: see CardEntry.
   */
  | { status: "have"; itemId: string; pending?: PendingEdit[]; snapshot?: CreateSnapshot; settling?: boolean; baseline?: string }
  /** Another path is creating it right now — do NOT create. `deferred`: the edit passed in was queued
   *  for that creator to replay (monday-row create keys only). */
  | { status: "creating"; deferred?: boolean }
  /**
   * Reservation held by us; create and then finishCard().
   *
   * `tookOverStale` distinguishes the TWO very different ways a caller gets here. A fresh
   * reservation means nobody has ever tried. Taking over an ABANDONED one means a previous attempt
   * reserved, and we do not know whether its write landed — a create whose response was lost leaves
   * exactly this trace. Treating the two alike is what turns one lost response into a duplicate, so
   * a caller that can check its destination must do so before writing in the stale case.
   */
  | { status: "proceed"; tookOverStale: boolean };

/** One instance per idempotency key (via idFromName). Stores a single CreateState. `claim` serializes its
 * read-modify-write with blockConcurrencyWhile so two concurrent same-key requests can't both proceed —
 * the whole point of the DO (blockConcurrencyWhile is available on every DO backend, unlike the async KV
 * transaction() which isn't guaranteed on SQLite-backed classes). Every claim/save refreshes a 24h cleanup
 * alarm, so no key (completed, partial, or abandoned) lingers forever, while same-day retries are covered.
 * (A monday-row create key borrows that alarm while its create window is open: see SettleWatch.) */
export class CreateIdempotency extends DurableObject<Env> {
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
  // A RESERVATION, not a read-then-write: `claimCard` decides and marks "creating" inside one
  // blockConcurrencyWhile, so two paths whose lookups land in the same window cannot both create.
  /**
   * `retain`: an ACTIVITY reservation must never expire. With the 24h alarm, an unsettled reservation
   * (a create whose result was lost and could not be verified) vanished, and the next trigger -- days
   * later, say an association change -- claimed fresh, skipped the card check that only a stale
   * takeover makes, and wrote a second copy. Kept, it is taken over as stale whenever it is next
   * touched, and the takeover checks the card first. Card-registry claims keep their 24h cleanup.
   */
  /**
   * `defer` (monday-row create keys only): the edit this event carries. When the answer is "creating" --
   * the record is being made -- it is queued, INSIDE the same critical section as the decision, for the
   * creator to replay. Deciding and queueing apart would let the creator read the queue between the two
   * and the edit would be lost exactly as it was before this existed. Once the record exists nothing
   * queues: the answer is "have", and the event sends its own edit.
   */
  async claimCard(nowMs: number, staleMs = 30_000, retain = false, defer?: PendingEdit): Promise<CardClaim> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<CardEntry>("card");
      if (rec?.itemId) {
        const base = rec.baseline ? { baseline: rec.baseline } : {};
        // The creator is alive: its queue is its own to replay, and the rest of the card is its to settle.
        if (rec.settlingAt && nowMs - rec.settlingAt < staleMs)
          return { status: "have", itemId: rec.itemId, settling: true, ...base } as CardClaim;
        // Settled, or a creator that stopped: whatever it left goes to this reader.
        const left = await this.takeLeftovers(rec);
        return { status: "have", itemId: rec.itemId, ...(left.pending.length ? { pending: left.pending } : {}),
          ...(left.snapshot ? { snapshot: left.snapshot } : {}), ...base } as CardClaim;
      }
      // Another path is mid-create. Treat a very old marker as abandoned so a crash can't wedge us.
      if (rec?.creatingAt && nowMs - rec.creatingAt < staleMs) {
        if (!defer) return { status: "creating" } as CardClaim;
        await this.queuePending(defer);
        return { status: "creating", deferred: true } as CardClaim;
      }
      // An expired creatingAt means a PREVIOUS attempt reserved and never settled. Its write may
      // well have landed; the caller is told so it can look before writing again.
      const tookOverStale = !!rec?.creatingAt;
      await this.ctx.storage.put("card", { creatingAt: nowMs });
      // Edits queued behind an attempt that never settled are KEPT: this attempt's settle replays them.
      // Replaying one the new create already carries sends nothing (the replay compares the card with
      // HubSpot); dropping one it does not carry would lose it.
      if (retain) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(nowMs + RETENTION_MS);
      return { status: "proceed", tookOverStale } as CardClaim;
    });
  }

  private async queuePending(e: PendingEdit): Promise<void> {
    const q = (await this.ctx.storage.get<PendingEdit[]>("pending")) ?? [];
    q.push(e);
    await this.ctx.storage.put("pending", q.slice(-MAX_PENDING));
  }

  /**
   * Hand what a stopped creator left to a reader that is not the creator (call inside a critical section,
   * with the record known to exist and no live hold): its queue, with the notes beside it, and -- when the
   * window was never settled -- its snapshot, so the reader settles the card in the creator's place. A
   * STALE hold is cleared at the same time: that creator stalled or died. Should it come back, its next
   * heartbeat takes the hold up again -- with nothing left, since this reader has it all. Notes alone (no
   * queue, nothing unsettled) protect nothing, and are dropped.
   */
  private async takeLeftovers(rec: CardEntry): Promise<{ pending: PendingEdit[]; snapshot?: CreateSnapshot }> {
    const pending = (await this.ctx.storage.get<PendingEdit[]>("pending")) ?? [];
    const notes = (await this.ctx.storage.get<PendingEdit[]>("notes")) ?? [];
    const snapshot = await this.ctx.storage.get<CreateSnapshot>("snapshot");
    if (pending.length) await this.ctx.storage.delete("pending");
    if (notes.length) await this.ctx.storage.delete("notes");
    if (snapshot) await this.ctx.storage.delete("snapshot");
    if (rec.settlingAt)
      await this.ctx.storage.put("card", { itemId: rec.itemId, ...(rec.baseline ? { baseline: rec.baseline } : {}) });
    if (!pending.length && !snapshot) return { pending: [] };
    return { pending: [...pending, ...notes], ...(snapshot ? { snapshot } : {}) };
  }

  /** The queue and the notes, for a replay (read, not removed). */
  private async queueAndNotes(): Promise<PendingEdit[]> {
    return [...((await this.ctx.storage.get<PendingEdit[]>("pending")) ?? []),
      ...((await this.ctx.storage.get<PendingEdit[]>("notes")) ?? [])];
  }

  /**
   * NOTE WHO ELSE WROTE A CELL while this row's create window is open: the record is being made (a fresh
   * `creatingAt`), or its window is not settled yet (a snapshot), or a queue is waiting to be replayed.
   * Otherwise there is nothing a note could protect, and nothing is written. Never creates a reservation,
   * and never queues an edit: a note is never replayed, it only makes its writer the LATEST on those
   * cells, so no replay sends that value as a person's edit (sync.ts latestEntries). Answers whether it
   * was kept. See PendingEdit.note.
   */
  async noteEdit(nowMs: number, staleMs: number, e: PendingEdit): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () =>
      this.noteIfOpen(await this.ctx.storage.get<CardEntry>("card"), nowMs, staleMs, e));
  }

  private async noteIfOpen(rec: CardEntry | undefined, nowMs: number, staleMs: number, e: PendingEdit): Promise<boolean> {
    const creating = !rec?.itemId && !!rec?.creatingAt && nowMs - rec.creatingAt < staleMs;
    const open = creating || !!(await this.ctx.storage.get<CreateSnapshot>("snapshot"))
      || !!(await this.ctx.storage.get<PendingEdit[]>("pending"))?.length;
    if (!open) return false;
    const notes = (await this.ctx.storage.get<PendingEdit[]>("notes")) ?? [];
    notes.push({ ...e, note: true });
    await this.ctx.storage.put("notes", notes.slice(-MAX_PENDING));
    return true;
  }

  /**
   * SETTLE A MONDAY-ROW CREATE (monday-row keys only). The creator calls, in order:
   *
   *   "hold"    -- the record exists: store its id NOW (so a creator that dies from here on leaves "have",
   *               never a second create) and start the heartbeat. From here nothing queues; the queue
   *               stays stored, untouched, for the replay.
   *   "renew"   -- the heartbeat: the creator is still alive (a no-op for a row that is not this record's).
   *               Returns the queue WITHOUT removing it, so a creator that dies while replaying leaves it
   *               for the next reader rather than losing it.
   *   "release" -- settled: later reads are ordinary. `ack` is how many queued entries the replay ran
   *               (what "renew" returned): those are removed. Nothing can have joined the queue since the
   *               hold, and if a reader took it over meanwhile there is nothing left to remove; a count,
   *               not a flag, so a "renew" that failed (and so replayed nothing) removes nothing. Whatever
   *               is not acknowledged stays for the next reader. `baseline` is the Sync State the settle
   *               wrote; omitted, the hold's is kept.
   *   "link"    -- no create: the row was linked to a record that already existed (an adoption, or the
   *               card-owner index). Settled at once, with its baseline, and the queue is HANDED BACK for
   *               the caller to replay as edits of that record.
   *
   * `watch` (hold and renew): the card this create window belongs to. With it the row WATCHES the window:
   * its alarm is set for the moment the hold would lapse, so a creator that stops is taken over by the
   * row itself rather than by whichever event happens to come next (see alarm). A release whose round
   * did not run, or that leaves part of the queue unacknowledged, keeps the watch, and the alarm settles
   * the card shortly. Without `watch` (every caller but the create path) the calls answer and clean up
   * exactly as before.
   *
   * `snapshot` (hold): what the creator knew (CreateSnapshot), kept until the window is settled: a release
   * whose round ran (`ack`, 0 included) and took the whole queue, a link, or a takeover. "renew" and
   * "link" hand back the notes with the queue (PendingEdit.note); only the queue is counted by `ack`.
   */
  async settleCreate(itemId: string, nowMs: number, mode: "hold" | "renew" | "release" | "link",
      o: { baseline?: string; ack?: number; watch?: Omit<SettleWatch, "attempts">; snapshot?: CreateSnapshot } = {}):
      Promise<PendingEdit[]> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<CardEntry>("card");
      let out: PendingEdit[] = [];
      if (mode === "hold") {
        await this.ctx.storage.put("card", { itemId, settlingAt: nowMs, ...(o.baseline ? { baseline: o.baseline } : {}) });
        if (o.snapshot) await this.ctx.storage.put("snapshot", { ...o.snapshot });
        if (o.watch) await this.ctx.storage.put("watch", { ...o.watch });
      } else if (mode === "renew") {
        if (rec?.itemId !== itemId) return [];
        await this.ctx.storage.put("card", { ...rec, settlingAt: nowMs });
        // A live creator: its watch is current again (and a failed takeover's retry count is void).
        if (o.watch) await this.ctx.storage.put("watch", { ...o.watch });
        out = await this.queueAndNotes();
      } else if (mode === "release") {
        const rest = ((await this.ctx.storage.get<PendingEdit[]>("pending")) ?? []).slice(o.ack ?? 0);
        if (o.ack) {
          if (rest.length) await this.ctx.storage.put("pending", rest);
          else await this.ctx.storage.delete("pending");
        }
        const baseline = o.baseline ?? (rec?.itemId === itemId ? rec.baseline : undefined);
        await this.ctx.storage.put("card", { itemId, ...(baseline ? { baseline } : {}) });
        // SETTLED only when the round ran (it passes `ack`) and took the whole queue. Anything else -- a
        // round that could not run, a queue it was not given -- keeps what a takeover needs, and stays
        // watched: the alarm settles the card, as it would for a creator that stopped.
        if (o.ack !== undefined && !rest.length) {
          await this.ctx.storage.delete("notes");
          await this.ctx.storage.delete("snapshot");
          await this.ctx.storage.delete("watch");
        }
      } else {
        out = await this.queueAndNotes();
        await this.ctx.storage.delete("pending");
        await this.ctx.storage.delete("notes");
        await this.ctx.storage.delete("snapshot");
        await this.ctx.storage.put("card", { itemId, ...(o.baseline ? { baseline: o.baseline } : {}) });
        await this.ctx.storage.delete("watch");
      }
      await this.arm(nowMs);
      return out;
    });
  }

  /**
   * Set this row's one alarm for what the row is now. No watch: the 24 h cleanup, as always. A watched
   * create window: the moment its creator's hold lapses while the creator is alive; otherwise -- the hold
   * already stale, or a queue left without one -- a takeover in a few seconds, or after the retry delay
   * of one that failed.
   */
  private async arm(nowMs: number): Promise<void> {
    const watch = await this.ctx.storage.get<SettleWatch>("watch");
    if (!watch) { await this.ctx.storage.setAlarm(nowMs + RETENTION_MS); return; }
    const rec = await this.ctx.storage.get<CardEntry>("card");
    const lapses = rec?.settlingAt ? rec.settlingAt + watch.staleMs : 0;
    if (lapses > nowMs) { await this.ctx.storage.setAlarm(lapses + WATCH_MARGIN_MS); return; }
    const n = watch.attempts ?? 0;
    await this.ctx.storage.setAlarm(nowMs + (n ? WATCH_RETRY_MS[Math.min(n, WATCH_RETRY_MS.length) - 1] : WATCH_MARGIN_MS));
  }

  /**
   * Where is this monday row in its create window? Read by a sync of the now-linked card, from either
   * side (monday-row keys only):
   *   - `settling`: its creator is alive -- the caller sends its own edit, if it carries one, and leaves
   *     the rest of the card to the creator. Nothing is queued.
   *   - otherwise `leftovers`: edits that queued while the record was being made and that the creator
   *     never replayed (it stalled or died), with the notes beside them, and `snapshot` when the window was
   *     never settled. Taken by this caller, once, to settle the card from its own read; a stale hold is
   *     cleared with them. This is what stops them waiting for a 'have' read that, once monday serves the
   *     id, never comes.
   *   - `baseline` (not settling): the Sync State this Worker last wrote on the card (CardEntry). A read
   *     made before the creator's settle wrote a later one still shows the id write-back's, and judged by
   *     that, HubSpot's post-create recalculation reads as newer than every cell the settle held.
   * `note`: this caller's own event is our own token's; noted (noteEdit) in the same critical section.
   */
  async createWindow(nowMs: number, staleMs: number, note?: PendingEdit):
      Promise<{ settling: boolean; baseline?: string; leftovers?: PendingEdit[]; snapshot?: CreateSnapshot }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<CardEntry>("card");
      if (note) await this.noteIfOpen(rec, nowMs, staleMs, note);
      if (!rec?.itemId) return { settling: false };
      if (rec.settlingAt && nowMs - rec.settlingAt < staleMs) return { settling: true };
      const left = await this.takeLeftovers(rec);
      return { settling: false, ...(rec.baseline ? { baseline: rec.baseline } : {}),
        ...(left.pending.length ? { leftovers: left.pending } : {}), ...(left.snapshot ? { snapshot: left.snapshot } : {}) };
    });
  }
  async finishCard(itemId: string, nowMs: number): Promise<void> {
    await this.ctx.storage.put("card", { itemId });
    // A plain finish closes any create window this row was watching. The create path uses it to stop
    // holding after a failed id write-back, and that case keeps its old answer: the next event re-stamps
    // the card and takes the queue with it (claimCard "have").
    await this.ctx.storage.delete("watch");
    await this.ctx.storage.setAlarm(nowMs + RETENTION_MS);
  }
  /** Like finishCard but with a caller-chosen retention, for entries that must OUTLIVE a quiet day.
   *  The reverse card index (monday item id -> HubSpot id) is the case: it is read when a rep DELETES a
   *  card, which can be weeks after the card was last touched. The 24h RETENTION_MS that suits a
   *  creation reservation would have expired long before, and the deleted card could then never be
   *  matched back to its record. Same "card" key and shape, so getCard/forgetCard still apply. */
  async rememberOwner(hubspotId: string, nowMs: number, retentionMs: number): Promise<void> {
    await this.ctx.storage.put("card", { itemId: hubspotId });
    await this.ctx.storage.setAlarm(nowMs + retentionMs);
  }
  /**
   * Store a pairing that must NEVER expire, cancelling any cleanup alarm a prior claim scheduled.
   *
   * ACTIVITY MAPPINGS NEED THIS AND A LONG RETENTION WILL NOT DO. `rememberOwner`'s alarm still fires
   * eventually and `alarm()` calls deleteAll(), so any finite retention is a date on which the
   * mapping silently vanishes. For a card that is survivable — the reverse index is only read at
   * deletion time. For an activity it is not: once the monday-timeline-id -> HubSpot-id pair is gone,
   * the next wake-up on that contact sees an old entry as brand new and pushes a duplicate
   * communication record into a CRM people read to decide what to say next. A communication timeline
   * routinely outlives any retention we would pick.
   *
   * deleteAlarm() is the load-bearing half: claimCard set a 24h alarm when it reserved, and without
   * cancelling it the entry would be wiped a day later no matter what is stored here.
   */
  async rememberPermanent(counterpartId: string): Promise<void> {
    await this.ctx.storage.put("card", { itemId: counterpartId });
    await this.ctx.storage.deleteAlarm();
  }
  /** Drop the reservation (create failed / card turned out to be gone) so the next pass may retry. */
  async forgetCard(): Promise<void> { await this.ctx.storage.delete("card"); }
  async getCard(): Promise<string | null> {
    return (await this.ctx.storage.get<CardEntry>("card"))?.itemId ?? null;
  }

  /**
   * AN OWNER-CHECKED LOCK, for a poll that can outlive its own hold.
   *
   * claimCard's reservation cannot say WHO holds it, so a poll that overran its hold (a long monday
   * rate-limit wait, a slow stale takeover) would, on finishing, delete the lock a NEWER poll had
   * legitimately taken over -- and a third could then start beside the second. Here the holder's run id
   * is stored with the time, a live lock refuses anyone else, and only the holder may release it.
   * Separate "lock" key, so nothing that reads "card" can mistake one for a mapping.
   */
  async claimLock(nowMs: number, holdMs: number, owner: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<{ at: number; owner: string }>("lock");
      if (rec && rec.owner !== owner && nowMs - rec.at < holdMs) return false;
      await this.ctx.storage.put("lock", { at: nowMs, owner });
      await this.ctx.storage.setAlarm(nowMs + RETENTION_MS);
      return true;
    });
  }
  /**
   * EXTEND A LOCK THIS RUN STILL HOLDS -- NEVER TAKE ONE. claimLock grants a lock whose record is GONE, which is
   * right for a first claim and wrong for a renewal: a run that overran its hold while another took the expired lock,
   * did its work and released it (deleting the record) was granted the lock again by claimLock, and wrote beside
   * that run's finished work -- for the owner notice, a second 待通知 over the workflow's 已通知, so a second email.
   * Refused when the record is gone or names another run. Extended when it still names this one, even past its
   * hold: nobody took it over then.
   */
  async renewLock(nowMs: number, owner: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<{ at: number; owner: string }>("lock");
      if (!rec || rec.owner !== owner) return false;
      await this.ctx.storage.put("lock", { at: nowMs, owner });
      await this.ctx.storage.setAlarm(nowMs + RETENTION_MS);
      return true;
    });
  }
  /** Release only our own lock: an overrunning poll must not free one a newer poll now holds. */
  async releaseLock(owner: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = await this.ctx.storage.get<{ at: number; owner: string }>("lock");
      if (!rec || rec.owner !== owner) return false;
      await this.ctx.storage.delete("lock");
      return true;
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // THE CARD'S WATCH (STALE_FORWARD_GATE; `held:<board>:<item>` instances only). The state machine is card-watch.ts's
  // (pure, tested on its own); each method below is one critical section that applies it and re-arms the alarm.
  // ------------------------------------------------------------------------------------------------------------

  /** The Sync State stamps written on this card in the last STAMP_NOTE_WINDOW_MS. IN MEMORY ONLY: an evicted
   *  instance forgets them, and misses at most one detection (the card's next stamping pass corrects it). */
  private stampNotes: StampNote[] = [];

  private retryOn(): boolean { return watchRetryOn(this.env ?? {}); }
  private windowMs(): number { return holdWindowMs(this.env ?? {}); }

  /** Store the watch (or drop it), and arm the alarm for what it is now. Call inside a critical section. */
  private async saveWatch(w: CardWatch | undefined, now: number): Promise<void> {
    if (w) await this.ctx.storage.put("held", w);
    else await this.ctx.storage.delete("held");
    await this.armWatch(now);
  }

  private async armWatch(now: number): Promise<void> {
    const w = await this.ctx.storage.get<CardWatch>("held");
    const sv = await this.ctx.storage.get<StampVerify>("stampVerify");
    let next = nextAlarmAt(w, now, this.retryOn());
    if (sv) next = Math.min(next ?? Infinity, Math.max(sv.dueAt, now + 1));
    if (next === null || !Number.isFinite(next)) {
      if (!w && !sv) { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); }
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  /** A pass's holds, candidates and probes; see card-watch.ts reduceWatchCells. */
  async watchCells(nowMs: number, windowMs: number, base: WatchBase, reqs: WatchReq[],
      o: { resolved?: string[]; all?: boolean; linkedAt?: number }): Promise<Record<string, WatchReply>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      const { watch, replies } = reduceWatchCells(cur, base, reqs, o, nowMs, windowMs, this.retryOn());
      await this.saveWatch(watch, nowMs);
      return replies;
    });
  }

  /** The same answers, READ ONLY (a dry run: /resync dryRun): nothing is registered, resolved or stored. */
  async peekCells(nowMs: number, windowMs: number, base: WatchBase, reqs: WatchReq[]): Promise<Record<string, WatchReply>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      return reduceWatchCells(cur, base, reqs, {}, nowMs, windowMs, this.retryOn()).replies;
    });
  }

  /** A retry superseded by HubSpot's later changes; see reduceSupersede. */
  async supersede(nowMs: number, windowMs: number, base: WatchBase, fps: Record<string, string>, t0: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      await this.saveWatch(reduceSupersede(cur, base, fps, t0, nowMs, windowMs), nowMs);
    });
  }

  /** A person's (or an automation's) edits on their way; see reduceMarkEdits. */
  async markEdits(nowMs: number, base: WatchBase, marks: MarkInput[]): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      await this.saveWatch(reduceMarkEdits(cur, base, marks, nowMs), nowMs);
    });
  }

  /** A run resolved; see reduceClearMarks. */
  async clearMarks(nowMs: number, keys: string[], t0: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      if (!cur) return;
      await this.saveWatch(reduceClearMarks(cur, keys, t0, nowMs), nowMs);
    });
  }

  /** The converge's snapshot (`{}` when there is no watch). It stays queued until finishConverge. */
  async beginConverge(nowMs: number): Promise<{ snapshot?: CardWatch }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      const r = reduceBeginConverge(cur, nowMs);
      if (!r.snapshot) return {};
      await this.saveWatch(r.watch, nowMs);
      return { snapshot: r.snapshot };
    });
  }

  /** What the converge did; see reduceFinishConverge. Applied over whatever passes registered while it ran. */
  async finishConverge(nowMs: number, windowMs: number, outcome: ConvergeOutcome): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      if (!cur) return;
      await this.saveWatch(reduceFinishConverge(cur, outcome, nowMs, windowMs), nowMs);
    });
  }

  /** The retry's marks (STALE_FORWARD_RETRY); see reduceBeginRetry. */
  async beginRetry(nowMs: number, windowMs: number): Promise<Record<string, EditMark>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      const r = reduceBeginRetry(cur, nowMs, windowMs, this.retryOn());
      for (const k of r.abandoned)
        console.log(`[watch] board=${cur?.boardId} item=${cur?.itemId} col=${k} action=edit-retry-abandoned`
          + ` reason="its retries ran out: the cell converges to HubSpot"`);
      if (cur) await this.saveWatch(r.watch, nowMs);
      return r.live;
    });
  }

  /**
   * THE SYNC STATE REGISTER (R4). Called after every gated Sync State write on this card: `t` written between `s`
   * and `e`. monday has no compare-and-set, so an older stamp can land after a newer one; the two write windows say
   * when that may have happened (stampSuspicious), and then the card is read back VERIFY_DELAY_MS later and the
   * newest stamp restored (the alarm). In the meantime no verdict can be misled: our own versions are never news,
   * the typed and never-held verdicts ignore Sync State, and marks veto untyped news.
   */
  async noteStamp(nowMs: number, base: WatchBase, t: string, s: number, e: number, syncCol: string): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.recordStamp(nowMs, base, t, s, e, syncCol));
  }

  /** noteStamp's body: record the stamp, and queue a read-back when it may have been overtaken. Inside a critical
   *  section. The register's own restamp (verifyStamp) is recorded here too, so a write it overtook is caught. */
  private async recordStamp(nowMs: number, base: { boardId: string; itemId: string }, t: string, s: number, e: number,
      syncCol: string): Promise<void> {
    const tMs = timeOf(t);
    if (!Number.isFinite(tMs)) return;
    this.stampNotes = this.stampNotes.filter(n => nowMs - n.at < STAMP_NOTE_WINDOW_MS);
    const suspicious = stampSuspicious(this.stampNotes, { t: tMs, s });
    this.stampNotes.push({ t: tMs, ts: t, s, e, at: nowMs });
    if (!suspicious) return;
    const hw = this.stampNotes.reduce((a, n) => (n.t > a.t ? n : a));
    const prev = await this.ctx.storage.get<StampVerify>("stampVerify");
    const keep = prev && timeOf(prev.hw) > hw.t ? prev.hw : hw.ts;
    await this.ctx.storage.put("stampVerify", { hw: keep, syncCol, boardId: base.boardId, itemId: base.itemId,
      dueAt: prev ? Math.min(prev.dueAt, nowMs + VERIFY_DELAY_MS) : nowMs + VERIFY_DELAY_MS } satisfies StampVerify);
    console.log(`[sync-state] board=${base.boardId} item=${base.itemId} action=verify-queued`
      + ` reason="a stamp may have been overtaken: read back in ${VERIFY_DELAY_MS} ms"`);
    await this.armWatch(nowMs);
  }

  /**
   * THE WATCH'S ALARM. Decides what is due under the lock (reduceAlarm), releases it, then does the I/O:
   *   (A) a converge, queued on DEFERRED_SYNC (rate-controlled by its waves); run inline when there is no queue;
   *   (B) the marks: a retry queued (STALE_FORWARD_RETRY), or -- off -- a lease ended, and the cell falls back on
   *       its own hold clock; a mark given up makes its cell due;
   *   (C) a suspicious Sync State read back, and the newest stamp restored;
   *   (D) re-armed for what is left; (E) nothing left: cleaned up.
   */
  private async cardWatchAlarm(): Promise<void> {
    const now = Date.now();
    const W = this.windowMs();
    const retryOn = this.retryOn();
    const step = await this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.ctx.storage.get<CardWatch>("held");
      const sv = await this.ctx.storage.get<StampVerify>("stampVerify");
      const r = cur ? reduceAlarm(cur, now, W, retryOn) : undefined;
      if (cur) {
        if (r!.watch) await this.ctx.storage.put("held", r!.watch);
        else await this.ctx.storage.delete("held");
      }
      const verify = sv && sv.dueAt <= now ? sv : undefined;
      if (verify) await this.ctx.storage.delete("stampVerify");
      return { cur, r, verify };
    });
    const w = step.cur;
    const at = w ? `board=${w.boardId} item=${w.itemId}` : "";
    for (const k of step.r?.expired ?? [])
      console.log(`[watch] ${at} col=${k} action=mark-expired reason="the edit's run did not resolve within its lease;`
        + ` the cell falls back on its own hold clock"`);
    for (const k of step.r?.abandoned ?? [])
      console.log(`[watch] ${at} col=${k} action=edit-retry-abandoned reason="its retries ran out: the cell converges to HubSpot"`);
    const type = w ? eventTypeOfObject(w.object) : undefined;
    if (w && type && step.r?.converge) await this.queueOrRun(w, type, "converge");
    if (w && type && step.r?.retry) await this.queueOrRun(w, type, "retry");
    if (step.verify) await this.verifyStamp(step.verify);
    await this.ctx.blockConcurrencyWhile(() => this.armWatch(Date.now()));
  }

  /** A converge or retry for this card on DEFERRED_SYNC; without a queue (or when it refuses), run here. Never throws. */
  private async queueOrRun(w: CardWatch, type: NonNullable<ReturnType<typeof eventTypeOfObject>>, kind: "converge" | "retry"): Promise<void> {
    const at = `board=${w.boardId} item=${w.itemId}`;
    if (await spillDeferred(this.env, [{ type, id: w.itemId, watch: { boardId: w.boardId, kind } }])) {
      console.log(`[watch] ${at} action=${kind}-queued`);
      return;
    }
    console.log(`[watch] ${at} action=${kind}-inline reason="no deferred queue took it"`);
    try {
      const opts = webhookOpts(this.env);
      if (kind === "converge") await settleCardWatch(this.env, w.boardId, w.itemId, opts, { left: 30 });
      else await retryMarkedEdits(this.env, w.boardId, w.itemId, opts, { left: 30 });
    } catch (e) {
      console.log(`[watch] ${at} action=${kind}-failed reason="${String(e).slice(0, 160)}"`);
    }
  }

  /**
   * (C): the card's Sync State is older than the newest stamp written on it -- an overtaken write: restore it. The
   * restamp is itself a read-then-write with no compare-and-set, so it never waits on monday's rate limit (never sent
   * late), and it is recorded like any stamp: a newer stamp written while it was in flight makes it suspicious in
   * turn, and that one is read back and restored.
   */
  private async verifyStamp(v: StampVerify): Promise<void> {
    try {
      const shown = (await getItemsColumnText(this.env, [v.itemId], v.syncCol))[v.itemId] ?? "";
      if (timeOf(shown) >= timeOf(v.hw)) return;
      const s = Date.now();
      await setColumns(this.env, v.boardId, v.itemId, { [v.syncCol]: v.hw }, webhookOpts(this.env), 0);
      const e = Date.now();
      console.log(`[sync-state] board=${v.boardId} item=${v.itemId} action=restamped`
        + ` reason="an older stamp landed after a newer one: the newest is restored"`);
      await this.ctx.blockConcurrencyWhile(() => this.recordStamp(Date.now(), v, v.hw, s, e, v.syncCol));
    } catch (e) {
      const tries = (v.tries ?? 0) + 1;
      const again = tries < VERIFY_TRIES;
      console.log(`[sync-state] board=${v.boardId} item=${v.itemId} action=restamp-failed reason="${String(e).slice(0, 140)}"`
        + ` next="${again ? `read back again in ${VERIFY_RETRY_MS / 1000} s` : "given up: the card's next stamping pass corrects it"}"`);
      if (!again) return;
      await this.ctx.blockConcurrencyWhile(async () => {
        const prev = await this.ctx.storage.get<StampVerify>("stampVerify");
        const hw = prev && timeOf(prev.hw) > timeOf(v.hw) ? prev.hw : v.hw;
        await this.ctx.storage.put("stampVerify", { ...v, hw, tries,
          dueAt: Math.min(prev?.dueAt ?? Infinity, Date.now() + VERIFY_RETRY_MS) } satisfies StampVerify);
      });
    }
  }

  /**
   * THE ROW'S ALARM: for every row but a watched create window, the 24 h cleanup, exactly as before.
   *
   * A WATCHED CREATE WINDOW (see SettleWatch) is the exception, because of the webhook's waitUntil cap.
   * The creator runs inside a monday webhook's ~30 s waitUntil, and its birth pass and settle round wait
   * on monday's rate limit (15-65 s a hit), so it can be cut off after its hold with a person's edit still
   * queued -- the same cap behind the doubled emails. HubSpot's creation webhook lands about 2 s after the
   * create, inside the live hold, and is left to that creator. So once the creator stops nothing else is
   * on its way, and the queue used to wait for "the next event": minutes later, and by then a HubSpot
   * change forwarded the create-time value over the card, or a person's unrelated edit copied it across.
   * The row is the one party that knows when the hold lapses, so it acts then:
   *   - the creator is alive (it renewed since): the alarm follows its heartbeat (arm);
   *   - the hold is stale, or a queue was left without one: THE TAKEOVER (settleAbandonedCreate). The
   *     queue is replayed as the person's edit it is, and HubSpot's own changes -- what the skipped
   *     creation webhook would have brought -- come across: what the next sync of the card would do, a
   *     few seconds after the lapse instead of whenever that sync comes;
   *   - nothing is left (settled, or a reader took it over): the window is closed. The row keeps its id
   *     for one more retention period (the 'have' answer) and then cleans up as usual.
   * The queue is acknowledged, and the stale hold cleared, only once the takeover's sync has run. Until
   * then both stay, so a reader arriving meanwhile takes them over itself (a second replay reads the card
   * afresh and sends nothing new). A takeover whose sync throws is retried (WATCH_RETRY_MS), then given
   * up -- loudly, with the queue still stored for whoever reads the row next.
   */
  async alarm(): Promise<void> {
    // THE CARD'S WATCH (`held:` instances only, STALE_FORWARD_GATE): its own alarm. Every other instance: as before.
    if (await this.ctx.storage.get("held") !== undefined || await this.ctx.storage.get("stampVerify") !== undefined)
      return this.cardWatchAlarm();
    const watch = await this.ctx.storage.get<SettleWatch>("watch");
    if (!watch) { await this.ctx.storage.deleteAll(); return; }
    const now = Date.now();
    const step = await this.ctx.blockConcurrencyWhile(async (): Promise<WatchStep> => {
      const rec = await this.ctx.storage.get<CardEntry>("card");
      const pending = (await this.ctx.storage.get<PendingEdit[]>("pending")) ?? [];
      const snapshot = await this.ctx.storage.get<CreateSnapshot>("snapshot");
      if (rec?.itemId && rec.settlingAt && now - rec.settlingAt < watch.staleMs) return { kind: "alive" };
      if (!rec?.itemId || (!rec.settlingAt && !pending.length && !snapshot)) {
        await this.ctx.storage.delete("watch");
        return { kind: "closed" };
      }
      return { kind: "takeover", recordId: rec.itemId, settlingAt: rec.settlingAt, baseline: rec.baseline,
        pending: await this.queueAndNotes(), ...(snapshot ? { snapshot } : {}) };
    });
    if (step.kind === "takeover") await this.takeOver(watch, step);
    await this.ctx.blockConcurrencyWhile(() => this.arm(Date.now()));
  }

  /** The takeover itself; see alarm. Never throws: the outcome is recorded on the watch. */
  private async takeOver(watch: SettleWatch, step: Extract<WatchStep, { kind: "takeover" }>): Promise<void> {
    const at = `board=${watch.boardId} item=${watch.itemId} hubspot_id=${step.recordId}`;
    const queued = step.pending.filter(e => !e.note).length;
    console.log(`[md-create] ${at} queued=${queued} action=create-window-takeover`
      + ` reason="${step.settlingAt ? "its creator's hold lapsed before it settled the card" : "its creator released it unsettled"}"`);
    const take: { entries: PendingEdit[]; snapshot?: CreateSnapshot; settled?: string } =
      { entries: step.pending, ...(step.snapshot ? { snapshot: step.snapshot } : {}) };
    try {
      await settleAbandonedCreate(this.env, watch.boardId, watch.itemId, step.recordId, take,
        step.baseline, webhookOpts(this.env), { left: 30 });
    } catch (e) {
      const attempts = (watch.attempts ?? 0) + 1;
      const again = attempts <= WATCH_RETRY_MS.length;
      await this.ctx.blockConcurrencyWhile(async () => {
        const cur = await this.ctx.storage.get<SettleWatch>("watch");
        const rec = await this.ctx.storage.get<CardEntry>("card");
        // Closed meanwhile, or a creator that came back and holds the card again: theirs now.
        if (!cur || (rec?.settlingAt && rec.settlingAt !== step.settlingAt)) return;
        if (again) await this.ctx.storage.put("watch", { ...cur, attempts });
        else await this.ctx.storage.delete("watch");
      });
      console.log(`[md-create] ${at} attempt=${attempts} action=${again ? "create-window-takeover-retry" : "create-window-takeover-abandoned"}`
        + ` reason="${String(e).slice(0, 160)}"${again ? "" : " the queue stays stored for the next sync of the card"}`);
      return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      // Acknowledge what was replayed. Nothing joins the queue once the record exists, so it is either
      // still exactly that list or already empty (a reader, or a creator that came back, took it).
      const rest = ((await this.ctx.storage.get<PendingEdit[]>("pending")) ?? []).slice(queued);
      if (rest.length) await this.ctx.storage.put("pending", rest);
      else await this.ctx.storage.delete("pending");
      const rec = await this.ctx.storage.get<CardEntry>("card");
      if (rec?.settlingAt && rec.settlingAt !== step.settlingAt) return;   // a creator back: its hold stands
      // The stale hold cleared, and the Sync State the round left recorded, as a creator's release does.
      const baseline = take.settled || rec?.baseline;
      if (rec?.itemId === step.recordId && (rec.settlingAt || baseline !== rec.baseline))
        await this.ctx.storage.put("card", { itemId: rec.itemId, ...(baseline ? { baseline } : {}) });
      // Settled in the creator's place: what the hold recorded, and the notes, have served.
      await this.ctx.storage.delete("notes");
      await this.ctx.storage.delete("snapshot");
      await this.ctx.storage.delete("watch");
    });
  }
}

/** What the alarm found on a watched row; see alarm. `pending` carries the notes too (PendingEdit.note). */
type WatchStep =
  | { kind: "alive" }
  | { kind: "closed" }
  | { kind: "takeover"; recordId: string; settlingAt?: number; baseline?: string; pending: PendingEdit[];
      snapshot?: CreateSnapshot };
