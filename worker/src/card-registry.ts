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

/** Settle the reservation with the card that now represents this record.
 *  Writes BOTH directions: see rememberCardOwner for why the reverse index is not optional. */
export async function finishCard(env: Env, boardId: string, hubspotId: string, itemId: string): Promise<void> {
  try { await cardStub(env, boardId, hubspotId).finishCard(itemId, Date.now()); }
  catch (e) { console.log(`[card-registry] finish board=${boardId} hs=${hubspotId} item=${itemId} error="${String(e).slice(0, 120)}"`); }
  await rememberCardOwner(env, boardId, itemId, hubspotId);
}

// --- reverse index: "which HubSpot record did this monday card represent?" -------------------------
// Needed for exactly one thing, and nothing else can supply it. When a rep DELETES a card, the card —
// and with it the "HubSpot ID" column that identifies the record — is gone. monday's item_deleted
// payload is undocumented (developer.monday.com publishes no sample for it), so we cannot rely on it
// carrying columnValues. Without our own record of the pairing, a deletion is unattributable and the
// card can never be restored.
//
// Retention is 90 days, not the registry's 24h: this is read at DELETE time, which may be long after
// the card was last written. It is refreshed on every finishCard, so an actively-syncing record keeps
// extending its entry.

const OWNER_RETENTION_MS = 90 * 24 * 60 * 60_000;

function ownerStub(env: Env, boardId: string, itemId: string) {
  return env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(`hsof:${boardId}:${itemId}`));
}

/** Record that monday card `itemId` stands for HubSpot record `hubspotId`. */
export async function rememberCardOwner(env: Env, boardId: string, itemId: string, hubspotId: string): Promise<void> {
  try { await ownerStub(env, boardId, itemId).rememberOwner(hubspotId, Date.now(), OWNER_RETENTION_MS); }
  catch (e) { console.log(`[card-owner] remember board=${boardId} item=${itemId} hs=${hubspotId} error="${String(e).slice(0, 120)}"`); }
}

/** Which HubSpot record was this card? Null when we never recorded it, or the entry has expired. */
export async function lookupCardOwner(env: Env, boardId: string, itemId: string): Promise<string | null> {
  try { return await ownerStub(env, boardId, itemId).getCard(); }
  catch (e) {
    console.log(`[card-owner] lookup board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`);
    return null;
  }
}

/** Drop the reverse entry — after a restore, since the restored card has a NEW item id. */
export async function forgetCardOwner(env: Env, boardId: string, itemId: string): Promise<void> {
  try { await ownerStub(env, boardId, itemId).forgetCard(); }
  catch (e) { console.log(`[card-owner] forget board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`); }
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

// --- the mirror image: "has this monday row already been given a HubSpot record?" (createFromMonday) ---
// Same Durable Object, separate key namespace. monday emits `create_pulse` AND `change_column_value` for
// one new row; those land in different isolates, and `coalesce` is per-isolate — so without this guard
// both reach createFromMonday and each creates its own HubSpot record.

function itemStub(env: Env, boardId: string, itemId: string) {
  return env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(`mdcreate:${boardId}:${itemId}`));
}

/** Reserve the right to create a HubSpot record for this monday row. */
export async function claimHubspotForItem(env: Env, boardId: string, itemId: string): Promise<CardClaim> {
  try { return await itemStub(env, boardId, itemId).claimCard(Date.now()); }
  catch (e) {
    console.log(`[md-create] claim board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`);
    return { status: "proceed" }; // fail open
  }
}
export async function finishHubspotForItem(env: Env, boardId: string, itemId: string, hubspotId: string): Promise<void> {
  try { await itemStub(env, boardId, itemId).finishCard(hubspotId, Date.now()); }
  catch (e) { console.log(`[md-create] finish board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`); }
}
export async function forgetHubspotForItem(env: Env, boardId: string, itemId: string): Promise<void> {
  try { await itemStub(env, boardId, itemId).forgetCard(); }
  catch (e) { console.log(`[md-create] forget board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`); }
}
