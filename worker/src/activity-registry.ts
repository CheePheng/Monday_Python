/**
 * DURABLE IDEMPOTENCY FOR ACTIVITY SYNC, in both directions.
 *
 * WHY A RESERVATION AND NOT A LOOKUP. The POC created duplicate HubSpot records by asking HubSpot
 * whether it had already stored the activity: its SEARCH INDEX IS ASYNCHRONOUS, so a note written
 * seconds earlier was not findable, and the retry created a second copy. Measured twice, on a real
 * contact. Any design that decides "have I done this?" by querying the destination is unsafe on both
 * sides here — monday's `items_page_by_column_values` is eventually consistent for the same reason,
 * which is what the card registry already exists to work around.
 *
 * So the decision is made in strongly-consistent storage BEFORE the write, using the same
 * CREATE_IDEMPOTENCY Durable Object and the same claim/finish shape as cards. Two namespaces:
 *
 *   act:m2h:<monday timeline item id>   monday native activity -> HubSpot
 *   act:h2m:<hubspot object>:<id>       HubSpot engagement     -> monday
 *
 * FAILS OPEN, matching card-registry: a Durable Object hiccup degrades to "proceed", because a
 * duplicate activity is recoverable by hand while a sync that silently stops is not. The asymmetry is
 * deliberate and is the same judgement the card registry already makes.
 *
 * The h2m direction ALSO has a cheap second guard — the monday timeline is read-your-writes
 * consistent, so an existing entry can simply be seen. The reservation still matters for concurrent
 * deliveries of the same webhook, which the read cannot serialise.
 */
import type { Env } from "./types";
import type { CardClaim } from "./create-idempotency-do";

const m2hStub = (env: Env, timelineItemId: string) =>
  env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(`act:m2h:${timelineItemId}`));
const h2mStub = (env: Env, object: string, hubspotId: string) =>
  env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(`act:h2m:${object}:${hubspotId}`));

/** Reserve the right to push this monday timeline entry into HubSpot. */
export async function claimActivityToHubspot(env: Env, timelineItemId: string): Promise<CardClaim> {
  try {
    return await m2hStub(env, timelineItemId).claimCard(Date.now());
  } catch (e) {
    console.log(`[activity-registry] claim m2h=${timelineItemId} error="${String(e).slice(0, 120)}"`);
    return { status: "proceed" };
  }
}

/** Settle it with the HubSpot activity that now represents it. */
export async function finishActivityToHubspot(env: Env, timelineItemId: string, hubspotId: string): Promise<void> {
  try { await m2hStub(env, timelineItemId).finishCard(hubspotId, Date.now()); }
  catch (e) { console.log(`[activity-registry] finish m2h=${timelineItemId} hs=${hubspotId} error="${String(e).slice(0, 120)}"`); }
}

/**
 * Release a reservation whose write never happened.
 *
 * Without this, a HubSpot create that throws leaves the entry pinned as "creating" until the DO's
 * staleness window expires, and the activity is silently skipped in the meantime. Releasing turns a
 * failed attempt into a retryable one instead of a quiet gap.
 */
export async function releaseActivityToHubspot(env: Env, timelineItemId: string): Promise<void> {
  try { await m2hStub(env, timelineItemId).finishCard("", 0); }
  catch { /* best effort: the staleness window is the backstop */ }
}

export async function claimActivityToMonday(env: Env, object: string, hubspotId: string): Promise<CardClaim> {
  try {
    return await h2mStub(env, object, hubspotId).claimCard(Date.now());
  } catch (e) {
    console.log(`[activity-registry] claim h2m=${object}:${hubspotId} error="${String(e).slice(0, 120)}"`);
    return { status: "proceed" };
  }
}

export async function finishActivityToMonday(env: Env, object: string, hubspotId: string,
    timelineItemId: string): Promise<void> {
  try { await h2mStub(env, object, hubspotId).finishCard(timelineItemId, Date.now()); }
  catch (e) { console.log(`[activity-registry] finish h2m=${object}:${hubspotId} error="${String(e).slice(0, 120)}"`); }
}

export async function releaseActivityToMonday(env: Env, object: string, hubspotId: string): Promise<void> {
  try { await h2mStub(env, object, hubspotId).finishCard("", 0); }
  catch { /* best effort */ }
}
