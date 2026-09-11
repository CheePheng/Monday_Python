import type { Env } from "./types";
import { getUserById, whoAmI } from "./monday";

/**
 * Who caused a change, in a form a human can read in the logs.
 *
 * Every write this Worker makes lands in monday's activity log under the API token's OWN user, so a log
 * that only shows a numeric id cannot answer "did a person do this, or did the sync?" — the exact question
 * raised by the 2026-08-28 owner-reassignment incident. Resolving the id (and flagging our own token) makes
 * a human edit unmistakable.
 */
export function formatActor(userId: string, user: { name: string; email: string } | null, selfId: string): string {
  if (!userId) return "actor=unknown";
  if (selfId && userId === selfId) return `actor=integration user=${userId}`;   // our own API token, not a person
  if (!user) return `actor=person user=${userId}`;                              // id we couldn't resolve
  const who = [user.name, user.email].filter(Boolean).join(" ");
  return `actor=person user=${userId} who="${who}"`;
}

// Per-isolate caches: a webhook burst from one rep resolves a single time.
const userCache = new Map<string, { name: string; email: string } | null>();
let selfIdCache: string | null = null;

/**
 * Did OUR OWN integration token cause this monday event, rather than a person?
 *
 * PROVENANCE GUARD. The same signal formatActor already prints is load-bearing for authorization, not
 * just for logs: a monday event we caused ourselves is an ECHO, and an echo must never be read as a
 * user's instruction to mutate HubSpot.
 *
 * WHAT THIS PREVENTS, measured rather than theorised. During the 2026-09-09/11 historical import the
 * Worker created 1,207 HubSpot Companies — 1,207 of the 1,213 it has ever created — each one 2-26
 * seconds after a monday Accounts card appeared. monday's own activity log attributes every one of
 * those cards to user 104118038, this integration's token. The race: createItem writes the HubSpot ID
 * column, monday fires create_item within milliseconds, and the webhook's getItem read does not see
 * that column yet — so colText(item, idCol) is empty, syncMondayItem concludes "a human made a new
 * card", and createFromMonday mints a HubSpot record. Eventual consistency, the same class of fault
 * as the duplicate-card race and the 758 duplicate retries.
 *
 * FAILS CLOSED, deliberately. When the actor cannot be established (no userId on the event, or whoAmI
 * unavailable) this returns TRUE — treat it as our own. The asymmetry is the point: refusing to create
 * costs a rep one visible retry on a card that keeps all its data, while wrongly creating writes an
 * irreversible record into HubSpot and, as fake.com showed, can drag 1,581 associations with it. The
 * codebase already resolves this direction the same way in authorizeWrite.
 */
export async function isIntegrationActor(env: Env, userId: string): Promise<boolean> {
  if (!userId) return true;                     // no attribution -> cannot prove a human -> assume us
  try {
    if (selfIdCache === null) selfIdCache = (await whoAmI(env)) ?? "";
    if (!selfIdCache) return true;              // could not learn our own id -> assume us
    return userId === selfIdCache;
  } catch {
    return true;                                // unresolvable -> assume us
  }
}

/** Resolve the acting monday user to a log label. Cached; never throws (attribution must not break a sync). */
export async function actorLabel(env: Env, userId: string): Promise<string> {
  if (!userId) return "actor=unknown";
  try {
    if (selfIdCache === null) selfIdCache = (await whoAmI(env)) ?? "";
    if (!userCache.has(userId)) userCache.set(userId, await getUserById(env, userId));
    return formatActor(userId, userCache.get(userId) ?? null, selfIdCache);
  } catch {
    return `actor=person user=${userId}`;
  }
}
