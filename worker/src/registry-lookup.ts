import { lookupCardOwner } from "./card-registry";
import type { Env } from "./types";

/**
 * A READ-ONLY answer to exactly one question: does the card registry hold a HubSpot record for this
 * monday card?
 *
 * It exists for one decision — whether deleting an Item-Association orphan Account would be a no-op
 * or would trigger restoreDeletedCard — and is written to be deletable the moment that decision is
 * made. It imports ONE registry function, and that function only reads.
 *
 * DELIBERATELY NARROW, because a diagnostic route on a production Worker is permanent attack surface
 * until someone removes it:
 *   - its own secret, never TRIGGER_SECRET, so a leak here cannot drive /import or /run
 *   - POST only, so a URL cannot carry the answer into a log or a referrer
 *   - one board, named here rather than taken from the request
 *   - a numeric card id, so nothing else can be addressed
 *   - a response of three fields, never the registry's contents
 *   - no HubSpot call, no monday call, no write of any kind is reachable from this file
 */

/** Only the Accounts board, and only because that is where the orphan cleanup happens. */
const ALLOWED_BOARDS = new Set(["5028000496"]);

export interface RegistryLookupResult {
  cardId: string;
  mappingPresent: boolean;
  hubspotId?: string;
}

/** Constant-time-ish comparison, so a wrong secret cannot be discovered a character at a time. */
function secretMatches(provided: string, expected: string): boolean {
  if (!expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function handleRegistryLookup(env: Env, req: Request): Promise<Response> {
  const secret = (env as any).DIAGNOSTIC_SECRET as string | undefined;
  // Absent secret is a REFUSAL, not an open door: a Worker deployed without it must not answer.
  if (!secret) return new Response("forbidden", { status: 403 });
  if (!secretMatches(req.headers.get("x-diagnostic-secret") ?? "", secret))
    return new Response("forbidden", { status: 403 });

  const body: any = await req.json().catch(() => ({}));
  const boardId = String(body?.boardId ?? "");
  const cardId = String(body?.cardId ?? "");
  if (!ALLOWED_BOARDS.has(boardId))
    return Response.json({ error: "board not permitted for registry lookup" }, { status: 400 });
  if (!/^\d+$/.test(cardId))
    return Response.json({ error: "cardId must be a numeric string" }, { status: 400 });

  const hubspotId = await lookupCardOwner(env, boardId, cardId);
  // The card id is echoed so a caller cannot mistake one answer for another; nothing else is returned.
  const out: RegistryLookupResult = hubspotId
    ? { cardId, mappingPresent: true, hubspotId }
    : { cardId, mappingPresent: false };
  console.log(`[registry-lookup] board=${boardId} card=${cardId} present=${out.mappingPresent}`);
  return Response.json(out);
}
