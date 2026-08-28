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
