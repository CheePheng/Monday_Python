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
 *  2. SETTLED MAPPINGS OUTLIVE A DAY. claimCard/finishCard put a 24h cleanup alarm on the entry,
 *     which suits a creation reservation and is actively wrong for this: a webhook redelivered 25
 *     hours later would find no mapping and duplicate the activity. Settled pairs are stored through
 *     `rememberOwner`, whose retention the caller chooses — the same mechanism the reverse card index
 *     uses for the same reason.
 *
 *  3. A LOST RESPONSE DOES NOT RELEASE. If the create request fails after HubSpot already stored the
 *     object, releasing the reservation and retrying duplicates it. The reservation is left standing
 *     instead, and RESERVE_STALE_MS is long enough for HubSpot's index to catch up so a reconcile can
 *     tell which happened. Being stuck for a quarter of an hour is cheap; a duplicate is forever.
 */
import type { Env } from "./types";
import type { CardClaim } from "./create-idempotency-do";

/** Settled pairs must survive redelivery, reprocessing and a quiet weekend. */
const MAPPING_RETENTION_MS = 400 * 24 * 60 * 60_000;

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
const h2mKey = (object: string, hubspotId: string) => `act:h2m:${object}:${hubspotId}`;

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

/** Record the counterpart id. Long retention: a redelivery next week must still find this. */
async function settle(env: Env, key: string, counterpartId: string): Promise<void> {
  try { await stub(env, key).rememberOwner(counterpartId, Date.now(), MAPPING_RETENTION_MS); }
  catch (e) { console.log(`[activity-registry] ${key} action=settle-failed reason="${String(e).slice(0, 90)}"`); }
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
export const claimActivityToMonday = (env: Env, object: string, hubspotId: string) =>
  claim(env, h2mKey(object, hubspotId));
export const settleActivityToMonday = (env: Env, object: string, hubspotId: string, timelineItemId: string) =>
  settle(env, h2mKey(object, hubspotId), timelineItemId);
export const unresolvedActivityToMonday = (object: string, hubspotId: string, err: unknown) =>
  markUnresolved(h2mKey(object, hubspotId), err);

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
