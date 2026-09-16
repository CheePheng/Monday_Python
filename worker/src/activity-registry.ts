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
  | { status: "proceed" }            // reservation held: write, then settle()
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
const h2mKey = (object: string, hubspotId: string, contactId: string) =>
  `act:h2m:${object}:${hubspotId}:${contactId}`;

async function claim(env: Env, key: string): Promise<ActivityClaim> {
  try {
    const c: CardClaim = await stub(env, key).claimCard(Date.now(), RESERVE_STALE_MS);
    if (c.status === "have") return { status: "have", id: c.itemId };
    return c.status === "creating" ? { status: "creating" } : { status: "proceed" };
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
  await settle(env, h2mKey(object, hubspotId, contactId), `monday:${mondayTimelineId}`);
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
export const claimActivityToMonday = (env: Env, object: string, hubspotId: string, contactId: string) =>
  claim(env, h2mKey(object, hubspotId, contactId));
export const settleActivityToMonday = (env: Env, object: string, hubspotId: string, contactId: string,
    timelineItemId: string) => settle(env, h2mKey(object, hubspotId, contactId), timelineItemId);
export const unresolvedActivityToMonday = (object: string, hubspotId: string, contactId: string,
    err: unknown) => markUnresolved(h2mKey(object, hubspotId, contactId), err);

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
