import type { Env } from "./types";

// monday's `items_page_by_column_values` (how every path asks "is there already a card for this HubSpot
// record?") is EVENTUALLY CONSISTENT — a card created seconds ago can be invisible to it. Three paths can
// create a card for the same record:
//   1. the app's create endpoint      (create-records.ts findOrCreateCard)
//   2. the HubSpot -> monday sync     (sync.ts syncHubspotRecord -> reconcileRecord)
//   3. the association pass           (associations.ts ensureTargetCard)
// Before this registry, a search miss let a second path create a DUPLICATE card — e.g. the app creates a
// contact, HubSpot's contact.creation webhook arrives ~a second later, its search misses the just-created
// card, and the sync creates another one. Each path now records the card it created here (a Durable Object
// keyed by board + HubSpot id, which IS strongly consistent) and checks it BEFORE the search.
//
// This is an optimization layer, never a gate: every call fails open, so a Durable Object hiccup degrades
// back to today's behaviour rather than blocking a card from being created.

function cardStub(env: Env, boardId: string, hubspotId: string) {
  return env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(`card:${boardId}:${hubspotId}`));
}

/** The monday card id we already created for this HubSpot record, or null if we have no record of one. */
export async function lookupCard(env: Env, boardId: string, hubspotId: string): Promise<string | null> {
  try {
    return await cardStub(env, boardId, hubspotId).getCard();
  } catch (e) {
    console.log(`[card-registry] lookup board=${boardId} hs=${hubspotId} error="${String(e).slice(0, 120)}"`);
    return null; // fail open — fall back to the column search
  }
}

/** Record the card that now represents this HubSpot record, so no other path creates a second one. */
export async function rememberCard(env: Env, boardId: string, hubspotId: string, itemId: string): Promise<void> {
  try {
    await cardStub(env, boardId, hubspotId).setCard(itemId, Date.now());
  } catch (e) {
    console.log(`[card-registry] remember board=${boardId} hs=${hubspotId} item=${itemId} error="${String(e).slice(0, 120)}"`);
  }
}
