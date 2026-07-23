import type { Env } from "./types";
import type { CardClaim } from "./create-idempotency-do";

// monday's `items_page_by_column_values` (how every path asks "is there already a card for this HubSpot
// record?") is EVENTUALLY CONSISTENT — a card created seconds ago is invisible to it. Several paths create
// cards for the same record (the app's create endpoint, the HubSpot->monday sync, the association pass, and
// the deal path's createFromMonday), so a search miss let a second path create a DUPLICATE card.
//
// This registry is a strongly-consistent RESERVATION keyed by board + HubSpot id, held in a Durable Object.
// `claimCard` decides and marks "creating" atomically, so two paths in the same window cannot both create.
// It fails open: a Durable Object hiccup degrades to the old search-only behaviour rather than blocking.

function cardStub(env: Env, boardId: string, hubspotId: string) {
  return env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(`card:${boardId}:${hubspotId}`));
}

/** Reserve the right to create this record's card (or learn that it already exists / is being created). */
export async function claimCard(env: Env, boardId: string, hubspotId: string): Promise<CardClaim> {
  try {
    return await cardStub(env, boardId, hubspotId).claimCard(Date.now());
  } catch (e) {
    console.log(`[card-registry] claim board=${boardId} hs=${hubspotId} error="${String(e).slice(0, 120)}"`);
    return { status: "proceed" }; // fail open — fall back to the column search
  }
}

/** Settle the reservation with the card that now represents this record. */
export async function finishCard(env: Env, boardId: string, hubspotId: string, itemId: string): Promise<void> {
  try { await cardStub(env, boardId, hubspotId).finishCard(itemId, Date.now()); }
  catch (e) { console.log(`[card-registry] finish board=${boardId} hs=${hubspotId} item=${itemId} error="${String(e).slice(0, 120)}"`); }
}

/** Drop the reservation / stale mapping (create failed, or the card was deleted in monday). */
export async function forgetCard(env: Env, boardId: string, hubspotId: string): Promise<void> {
  try { await cardStub(env, boardId, hubspotId).forgetCard(); }
  catch (e) { console.log(`[card-registry] forget board=${boardId} hs=${hubspotId} error="${String(e).slice(0, 120)}"`); }
}

/** Read-only: the card id we know for this record (no reservation). Null when we have none. */
export async function lookupCard(env: Env, boardId: string, hubspotId: string): Promise<string | null> {
  try { return await cardStub(env, boardId, hubspotId).getCard(); }
  catch (e) {
    console.log(`[card-registry] lookup board=${boardId} hs=${hubspotId} error="${String(e).slice(0, 120)}"`);
    return null;
  }
}
