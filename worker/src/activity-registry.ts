/**
 * DURABLE IDEMPOTENCY FOR ACTIVITY SYNC, in both directions.
 *
 * WHY A RESERVATION AND NOT A LOOKUP. The POC created duplicate HubSpot records by asking HubSpot
 * whether it had already stored the activity: its SEARCH INDEX IS ASYNCHRONOUS, so a note written
 * seconds earlier was not findable and the retry created a second copy — observed twice, on a real
 * contact. Any design that decides "have I done this?" by querying the destination is unsafe here;
 * monday's own column search is eventually consistent for the same reason, which is what the card
 * registry already exists to work around.
 *
 * So the decision is made in strongly-consistent storage BEFORE the write, on the existing
 * CREATE_IDEMPOTENCY Durable Object. Two namespaces:
 *
 *   act:m2h:<monday timeline item id>   monday native activity -> HubSpot
 *   act:h2m:<hubspot object>:<id>       HubSpot engagement     -> monday
 *
 * THREE WAYS THIS DELIBERATELY DIFFERS FROM THE CARD REGISTRY. It reuses the same Durable Object, and
 * the first version of this file reused its POLICY too, which was wrong on every count:
 *
 *  1. IT FAILS CLOSED. card-registry falls back to "proceed" when the DO is unreachable, because a
 *     duplicate card is recoverable while a record with no card is invisible to everyone. The
 *     asymmetry inverts here: a duplicate is a customer-facing communication record in a CRM people
 *     read to decide what to say next, while a delayed activity is merely late. When the guard is
 *     unavailable we therefore do NOT write.
 *
 *  2. SETTLED MAPPINGS NEVER EXPIRE. claimCard/finishCard put a 24h cleanup alarm on the entry, which
 *     suits a creation reservation and is actively wrong here: a webhook redelivered 25 hours later
 *     would find no mapping and duplicate the activity. A longer retention only moves that date —
 *     any finite window is a day on which the pairing silently vanishes and an old timeline entry
 *     reads as brand new, and a communication history outlives any window we would choose. Settled
 *     pairs therefore go through `rememberPermanent`, which also CANCELS the alarm the reservation
 *     scheduled. Only unsettled reservations expire.
 *
 *  3. A LOST RESPONSE DOES NOT RELEASE. If the create request fails after HubSpot already stored the
 *     object, releasing the reservation and retrying duplicates it. The reservation is left standing
 *     instead, and RESERVE_STALE_MS is long enough for HubSpot's index to catch up so a reconcile can
 *     tell which happened. Being stuck for a quarter of an hour is cheap; a duplicate is forever.
 */
import type { Env } from "./types";
import type { CardClaim } from "./create-idempotency-do";

/**
 * SETTLED PAIRS NEVER EXPIRE, and a long retention is not an acceptable substitute.
 *
 * Any finite retention is a date on which the mapping silently disappears; the next wake-up on that
 * contact then reads an old timeline entry as brand new and pushes a duplicate communication record.
 * A communication history routinely outlives any window we would pick, and the failure surfaces long
 * after anyone would connect it to a retention constant. Only unsettled RESERVATIONS expire.
 */

/**
 * How long an unsettled reservation blocks a retry. Deliberately far longer than the card registry's
 * 30s: this is the window in which "did the create actually land?" is unanswerable, and HubSpot's
 * search index needs minutes, not seconds, before it can answer.
 */
const RESERVE_STALE_MS = 15 * 60_000;

export type ActivityClaim =
  | { status: "have"; id: string }   // already synced — this is the counterpart's id
  | { status: "creating" }           // in flight, or an unresolved create: do NOT write
  /** Reservation held: write, then settle().
   *  `tookOverStale` = we inherited an ABANDONED reservation, so a previous attempt may already have
   *  written. The caller must check the destination before creating, or a lost response becomes a
   *  duplicate — measured: 906 of 1,382 post-cutover email entries duplicated this way under the
   *  load of the historical import. */
  | { status: "proceed"; tookOverStale: boolean }
  | { status: "blocked" };           // guard unavailable: fail closed, retry later

function stub(env: Env, key: string) {
  return env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(key));
}
const m2hKey = (timelineItemId: string) => `act:m2h:${timelineItemId}`;
/**
 * ONE KEY PER (ACTIVITY, CONTACT), not per activity.
 *
 * A HubSpot activity is associated with EVERY participant — an outbound email carries both the rep
 * and the customer — so one activity legitimately becomes several monday timeline entries, on
 * several cards. Keyed by activity alone, the first card to be written marked the whole activity
 * settled and every remaining participant was silently skipped: the customer, whose timeline is the
 * entire point, would never receive it.
 */
const h2mKey = (object: string, hubspotId: string, destKind: string, destId: string) =>
  /**
   * CONTACT KEEPS ITS ORIGINAL THREE-PART SHAPE, deliberately. Mappings written before Companies and
   * Deals became destinations are already in durable storage; changing their spelling would make
   * every one of them unreadable, and an unreadable mapping does not fail — it reads as "never
   * synced" and writes the entry a second time. The new kinds get their own namespace instead, so
   * nothing has to be migrated and nothing can collide.
   */
  destKind === "contact"
    ? `act:h2m:${object}:${hubspotId}:${destId}`
    : `act:h2m:${object}:${hubspotId}:${destKind}:${destId}`;

async function claim(env: Env, key: string): Promise<ActivityClaim> {
  try {
    const c: CardClaim = await stub(env, key).claimCard(Date.now(), RESERVE_STALE_MS, true);   // never expires
    if (c.status === "have") return { status: "have", id: c.itemId };
    if (c.status === "creating") return { status: "creating" };
    return { status: "proceed", tookOverStale: c.tookOverStale === true };
  } catch (e) {
    // FAIL CLOSED. Writing without the guard is how duplicates are made.
    console.log(`[activity-registry] ${key} action=blocked reason="idempotency store unavailable: ${String(e).slice(0, 90)}"`);
    return { status: "blocked" };
  }
}

/** Record the counterpart id permanently, cancelling the reservation's cleanup alarm. */
async function settle(env: Env, key: string, counterpartId: string): Promise<void> {
  try { await stub(env, key).rememberPermanent(counterpartId); }
  catch (e) { console.log(`[activity-registry] ${key} action=settle-failed reason="${String(e).slice(0, 90)}"`); }
}

/**
 * Mark a HubSpot activity as ALREADY REPRESENTED in monday, without having created anything there.
 *
 * THE FIRST BOUNCE. Pushing a native monday Call into HubSpot makes HubSpot fire object.creation for
 * it, and that event is indistinguishable from a rep's own call. The structural echo guard does not
 * help: it only stops OUR monday writes travelling back, and this event is about a HubSpot object we
 * genuinely created. Without claiming the h2m side at the moment of creation, the bounce lands a
 * custom "HubSpot Call" beside the native Call it came from — one activity shown twice, on the first
 * try rather than in some loop.
 */
export async function claimHubspotAsRepresented(env: Env, object: string, hubspotId: string,
    contactId: string, mondayTimelineId: string): Promise<void> {
  await settle(env, h2mKey(object, hubspotId, "contact", contactId), `monday:${mondayTimelineId}`);
}

/**
 * The create threw. LEAVE THE RESERVATION STANDING — the write may well have landed, and releasing
 * here is what turns a lost response into a duplicate. It expires after RESERVE_STALE_MS, by which
 * point a reconcile (or the destination's own index) can establish what really happened.
 */
function markUnresolved(key: string, err: unknown): void {
  console.log(`[activity-registry] ${key} action=unresolved`
    + ` reason="create failed after reserving; NOT releasing, the write may have landed"`
    + ` error="${String(err).slice(0, 90)}"`);
}

// ---------------------------------------------------------------- monday -> HubSpot
export const claimActivityToHubspot = (env: Env, timelineItemId: string) =>
  claim(env, m2hKey(timelineItemId));
export const settleActivityToHubspot = (env: Env, timelineItemId: string, hubspotId: string) =>
  settle(env, m2hKey(timelineItemId), hubspotId);
export const unresolvedActivityToHubspot = (timelineItemId: string, err: unknown) =>
  markUnresolved(m2hKey(timelineItemId), err);

// ---------------------------------------------------------------- HubSpot -> monday
export const claimActivityToMonday = (env: Env, object: string, hubspotId: string,
    destKind: string, destId: string) => claim(env, h2mKey(object, hubspotId, destKind, destId));
export const settleActivityToMonday = (env: Env, object: string, hubspotId: string,
    destKind: string, destId: string, timelineItemId: string) =>
  settle(env, h2mKey(object, hubspotId, destKind, destId), timelineItemId);
export const unresolvedActivityToMonday = (object: string, hubspotId: string, destKind: string,
    destId: string, err: unknown) => markUnresolved(h2mKey(object, hubspotId, destKind, destId), err);

/**
 * HAS THIS ALREADY BEEN WRITTEN? A READ, never a reservation.
 *
 * For the marketing poller, which re-reads overlapping windows by design and would otherwise spend a
 * monday card lookup (and a reservation) on every event it has already delivered. Only a SETTLED
 * mapping answers "have"; an in-flight reservation reads "absent" here and is still caught by the claim
 * that follows, which is the real guard. A failed read is "unknown" -- the caller must not write on it.
 */
export async function peekActivityToMonday(env: Env, object: string, hubspotId: string,
    destKind: string, destId: string): Promise<"have" | "absent" | "unknown"> {
  try { return (await stub(env, h2mKey(object, hubspotId, destKind, destId)).getCard()) ? "have" : "absent"; }
  catch { return "unknown"; }
}

/**
 * A SINGLE-HOLDER LOCK, OWNER-CHECKED.
 *
 * Two polls over the same window (the cron and an on-demand run, or a cron that overran) would not
 * duplicate anything -- the registry sees to that -- but they would contend for the same reservations
 * and each stall on the other's "creating". Held for at most `holdMs`; a crashed holder's lock goes
 * stale and is taken over. `owner` is the run's own id and only that run may release it: an overrunning
 * poll that freed the lock unconditionally would free the NEWER poll's lock and let a third start.
 * FAILS CLOSED: an unreachable store means no poll, not an unguarded one.
 */
export async function acquireLock(env: Env, name: string, holdMs: number, owner: string): Promise<boolean> {
  try { return await stub(env, `lock:${name}`).claimLock(Date.now(), holdMs, owner); }
  catch (e) {
    console.log(`[activity-registry] lock:${name} action=blocked reason="${String(e).slice(0, 90)}"`);
    return false;
  }
}
/**
 * RENEW A LOCK THIS RUN STILL HOLDS, and only then (CreateIdempotency.renewLock). For a run about to write after a
 * long wait: acquireLock would also grant a lock whose record is GONE -- taken over by another run, which finished
 * and released it meanwhile -- and the overrunning run would then write beside that run's finished work. Refused
 * when the lock is gone or names another run. FAILS CLOSED, like acquireLock: an unreachable store is no renewal.
 */
export async function renewLock(env: Env, name: string, owner: string): Promise<boolean> {
  try { return await stub(env, `lock:${name}`).renewLock(Date.now(), owner); }
  catch (e) {
    console.log(`[activity-registry] lock:${name} action=renew-blocked reason="${String(e).slice(0, 90)}"`);
    return false;
  }
}
export async function releaseLock(env: Env, name: string, owner: string): Promise<void> {
  try {
    if (!(await stub(env, `lock:${name}`).releaseLock(owner)))
      console.log(`[activity-registry] lock:${name} action=release-skipped reason="held by a newer run (this one overran its hold)"`);
  } catch (e) { console.log(`[activity-registry] lock:${name} action=release-failed reason="${String(e).slice(0, 90)}"`); }
}

/**
 * SOFT durable notes -- a retry counter, a ledger page. Unlike the watermark these FAIL SOFT: losing
 * one costs a diagnostic, never a duplicate, so a storage blip must not stop the work they describe.
 */
export async function readNote(env: Env, name: string): Promise<string | null> {
  try { return await stub(env, `note:${name}`).getCard(); }
  catch { return null; }
}
/**
 * A note read that TELLS ABSENT FROM UNREADABLE: null only when nothing is stored, a throw when the
 * store could not answer. For the one note whose read decides what a write overwrites (the rollback
 * ledger): readNote's soft null there would make a storage blip look like an empty page, and the next
 * write would replace the rows earlier polls saved.
 */
export async function readNoteStrict(env: Env, name: string): Promise<string | null> {
  try { return await stub(env, `note:${name}`).getCard(); }
  catch (e) { throw new Error(`note ${name} unreadable: ${String(e).slice(0, 90)}`); }
}
export async function writeNote(env: Env, name: string, value: string): Promise<boolean> {
  try { await stub(env, `note:${name}`).rememberPermanent(value); return true; }
  catch (e) {
    console.log(`[activity-registry] note:${name} action=save-failed reason="${String(e).slice(0, 90)}"`);
    return false;
  }
}

/**
 * Release a reservation once something has PROVEN the write never happened.
 *
 * Not called on a failed create — see markUnresolved. This is for a reconcile that has looked and
 * found nothing, which is the only safe basis for allowing a retry.
 */
export async function releaseActivity(env: Env, key: string): Promise<void> {
  try { await stub(env, key).forgetCard(); }
  catch (e) { console.log(`[activity-registry] ${key} action=release-failed reason="${String(e).slice(0, 90)}"`); }
}
export const m2hReservationKey = m2hKey;
export const h2mReservationKey = h2mKey;

/**
 * The owner-assignment cycle last seen for a contact, as "<ownerId>|<hubspot_owner_assigneddate>".
 *
 * Stored so a genuine reassignment can be told apart from an ordinary update, or from an integration
 * echo writing the same owner back. Permanent for the same reason activity mappings are: were it to
 * expire, the next contact update would look like a reassignment and wipe a legitimately satisfied
 * helper, restarting a reminder cycle against a rep who had already done the work.
 */
const cycleKey = (contactId: string) => `act:owner:${contactId}`;

export async function lastOwnerCycle(env: Env, contactId: string): Promise<string | null> {
  try { return await stub(env, cycleKey(contactId)).getCard(); }
  catch { return null; }   // unreadable: treat as first sighting, which clears nothing
}

export async function rememberOwnerCycle(env: Env, contactId: string, cycle: string): Promise<void> {
  try { await stub(env, cycleKey(contactId)).rememberPermanent(cycle); }
  catch (e) { console.log(`[activity-registry] ${cycleKey(contactId)} action=cycle-save-failed reason="${String(e).slice(0, 90)}"`); }
}

/**
 * THE LAST OWNER ASSIGNMENT THE NOTICE SETTLED FOR A CONTACT (owner-notice.ts): the cycle
 * "<hubspot_owner_id>|<hubspot_owner_assigneddate>", stored with the time it was recorded.
 *
 * WHY THE WORKER KEEPS ITS OWN NOTE. The card says who the board's workflow last TOLD (上次通知Owner) and whether a
 * flag is WAITING (通知状态 待通知) -- but monday can serve both a moment stale right after our own write of
 * 待通知, and a stale read of an empty status is exactly what would flag the same assignment twice. A note in this
 * strongly-consistent store, written right after the write, is what makes the notice once per assignment. It is
 * also where an assignment that was settled WITHOUT a flag is recorded -- one too old to be news, one the
 * workflow already told -- so the record reads the same whichever way it went. NEVER one an earlier flag still
 * waiting on the workflow was taken to cover: that flag may already be on its way to the previous owner, or
 * stuck, and a cycle recorded against it was an owner never told (owner-notice.ts, "pending" / "stuck").
 *
 * Keyed by the ASSIGNMENT, not the owner: HubSpot stamps a new assigneddate on every real (re)assignment, so
 * A -> B -> A is three cycles and each is decided on its own, while a no-op owner write is the same cycle again.
 *
 * `flag`: THE WORKER'S LAST WRITE OF 待通知 for this contact -- the assignment it was for, and when -- recorded just
 * BEFORE that write (recordNoticeFlag), and replaced only by a later write: every settlement carries it over.
 * That time is the only age the Worker's own flag may have: monday does not always stamp a status value with
 * changed_at, and the two cells written through the API that were read on 2026-10-09 carried none -- the Worker
 * writes 待通知 through the API. Two ways it used to be lost, each leaving a standing 待通知 aged by the wrong flag:
 *   - it was written only AFTER the write, with the settlement, so a write that landed but lost its response, a
 *     note save that failed, or a run killed in between left the PREVIOUS flag's time in its place;
 *   - a settlement that writes nothing ("already", "baseline") replaced the whole note, flag and all.
 * A note saved while the field was `flagged` (the settlement was the flag, at its time) reads as that flag.
 *
 * The READ FAILS LOUD: "unreadable" and "nothing settled yet" are different answers, and mistaking the first for
 * the second flags an assignment that was already flagged. The caller then answers "error", and the queue retries.
 * The settlement's WRITE FAILS SOFT (logged): it follows the decision it records, and the card's own columns still
 * stand. The flag's own record FAILS LOUD (recordNoticeFlag): no 待通知 is written without it.
 */
const noticedKey = (contactId: string) => `notice:owner:${contactId}`;

/** The Worker's write of 待通知: the assignment it was for, and when it was sent (epoch ms). */
export interface NoticeFlag { cycle: string; at: number }
/** The note: the last assignment settled (`cycle`, "" when none yet; `at`) and the Worker's last flag (`flag`). */
export interface NoticeNote { cycle: string; at: number; flag?: NoticeFlag }

export async function lastNoticedCycle(env: Env, contactId: string): Promise<NoticeNote | null> {
  let raw: string | null;
  try { raw = await stub(env, noticedKey(contactId)).getCard(); }
  catch (e) { throw new Error(`owner notice for ${contactId} unreadable: ${String(e).slice(0, 90)}`); }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.cycle === "string") {
      const at = Number(v.at) || 0;
      const f = v.flag;
      const flag: NoticeFlag | undefined = f && typeof f.cycle === "string" && Number(f.at) > 0
        ? { cycle: f.cycle, at: Number(f.at) }
        : v.flagged === true && at > 0 ? { cycle: v.cycle, at } : undefined;
      return { cycle: v.cycle, at, ...(flag ? { flag } : {}) };
    }
  } catch { /* a bare cycle: no time known */ }
  return { cycle: raw, at: 0 };
}

/** Record a settled assignment, KEEPING the Worker's last flag (`flag`, passed back as read). Fails soft. */
export async function rememberNoticedCycle(env: Env, contactId: string, cycle: string, at = Date.now(),
    flag?: NoticeFlag): Promise<boolean> {
  try {
    await stub(env, noticedKey(contactId)).rememberPermanent(JSON.stringify({ cycle, at, ...(flag ? { flag } : {}) }));
    return true;
  } catch (e) {
    console.log(`[activity-registry] ${noticedKey(contactId)} action=save-failed reason="${String(e).slice(0, 90)}"`);
    return false;
  }
}

/**
 * Record the Worker's flag BEFORE writing 待通知, beside the settlement `settled` (the note as read; null: none
 * yet). FAILS LOUD (throws): a flag whose record could not be kept is not written -- the run answers "error" and
 * the queue retries it.
 */
export async function recordNoticeFlag(env: Env, contactId: string, settled: { cycle: string; at: number } | null,
    flag: NoticeFlag): Promise<void> {
  try {
    await stub(env, noticedKey(contactId)).rememberPermanent(
      JSON.stringify({ cycle: settled?.cycle ?? "", at: settled?.at ?? 0, flag }));
  } catch (e) { throw new Error(`owner notice flag for ${contactId} not recorded: ${String(e).slice(0, 90)}`); }
}

/**
 * A DURABLE WATERMARK, on the same strongly-consistent store everything else here uses.
 *
 * The task poller needs to remember how far it has read across Worker invocations, and that is
 * exactly the key-value the card registry already provides — so it reuses it rather than introducing
 * a third kind of state. Permanent, because a watermark that expires silently rewinds the poller to
 * its seed and re-reads years of tasks.
 */
const watermarkKey = (name: string) => `wm:${name}`;

/**
 * BOTH FAIL CLOSED, because "the store is broken" and "nothing has been recorded yet" are different
 * facts and must not produce the same answer.
 *
 * Swallowing a read error and returning null reads as "no watermark", which sends the poller back to
 * its seed and quietly replays everything — survivable here thanks to the overlap and the marker
 * check, but it is a silent rewind dressed up as a normal first run. Swallowing a WRITE error is
 * worse: the poll reports progress that was never saved.
 *
 * A genuinely absent watermark still returns null; only failure throws.
 */
export async function getWatermark(env: Env, name: string): Promise<string | null> {
  try { return await stub(env, watermarkKey(name)).getCard(); }
  catch (e) {
    throw new Error(`watermark ${name} unreadable: ${String(e).slice(0, 90)}`);
  }
}

export async function setWatermark(env: Env, name: string, value: string): Promise<void> {
  try { await stub(env, watermarkKey(name)).rememberPermanent(value); }
  catch (e) {
    throw new Error(`watermark ${name} not saved: ${String(e).slice(0, 90)}`);
  }
}
