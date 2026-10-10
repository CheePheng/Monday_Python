import type { Env } from "./types";
import type { CardClaim, CreateSnapshot, PendingEdit } from "./create-idempotency-do";
import type { CardWatch, ConvergeOutcome, EditMark, MarkInput, WatchBase, WatchReply, WatchReq } from "./card-watch";

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
    return { status: "proceed", tookOverStale: true }; // fail open — the column search below is the check
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

/**
 * How long a create may stay "creating", or a settling creator go without a heartbeat, before it is
 * presumed dead. The same 30 s the claim has always used (claimCard's default), named so the settle
 * check below cannot drift from it.
 */
export const CREATE_CLAIM_STALE_MS = 30_000;

/**
 * Reserve the right to create a HubSpot record for this monday row.
 *
 * `defer`: the edit this event carries. When the row's record is still being made the edit is QUEUED
 * for its creator to replay rather than dropped -- see PendingEdit. Omitted, the call is byte-for-byte
 * the old one.
 */
export async function claimHubspotForItem(env: Env, boardId: string, itemId: string,
    defer?: PendingEdit): Promise<CardClaim> {
  try {
    const stub = itemStub(env, boardId, itemId);
    return await (defer ? stub.claimCard(Date.now(), CREATE_CLAIM_STALE_MS, false, defer) : stub.claimCard(Date.now()));
  } catch (e) {
    console.log(`[md-create] claim board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`);
    return { status: "proceed", tookOverStale: true }; // fail open — state unknown, so treat as stale
  }
}

/**
 * Settle this row's claim on the record it now has.
 *
 * Without `settle`: exactly as before (the WM adoption paths, and a create whose id write-back failed).
 * With it, the create's own settle protocol -- see CreateIdempotency.settleCreate; "renew" and "link"
 * return the edits that queued while the record was being made (and the notes beside them). A "hold"
 * and every "renew" also name the card, so the row can watch its own create window and settle the card
 * itself should this creator stop (CreateIdempotency.alarm); a "hold" carries what the creator knew
 * (`snapshot`) for whoever has to. Fails open to "nothing queued": a Durable Object hiccup degrades to
 * the old behaviour, never to a blocked create.
 */
export async function finishHubspotForItem(env: Env, boardId: string, itemId: string, hubspotId: string,
    settle?: "hold" | "renew" | "release" | "link",
    o?: { baseline?: string; ack?: number; snapshot?: CreateSnapshot }): Promise<PendingEdit[]> {
  try {
    const stub = itemStub(env, boardId, itemId);
    if (!settle) { await stub.finishCard(hubspotId, Date.now()); return []; }
    const watch = settle === "hold" || settle === "renew"
      ? { watch: { boardId, itemId, staleMs: CREATE_CLAIM_STALE_MS } } : {};
    return (await stub.settleCreate(hubspotId, Date.now(), settle, { ...(o ?? {}), ...watch })) ?? [];
  } catch (e) {
    console.log(`[md-create] finish board=${boardId} item=${itemId}${settle ? ` mode=${settle}` : ""} error="${String(e).slice(0, 120)}"`);
    return [];
  }
}

/**
 * Where is this row in its create window? See CreateIdempotency.createWindow: `settling` while a live
 * creator is still bringing the card into line; otherwise any `leftovers` (and `snapshot`) a stalled or
 * dead creator left, handed to this caller, and the `baseline` this Worker last wrote on the card.
 * `note`: this caller's event is our own token's, noted for the window (see noteCreateWindowEdit). Fails
 * open to "not settling, nothing left": an unreadable state syncs exactly as before.
 */
export async function createWindowOf(env: Env, boardId: string, itemId: string, note?: PendingEdit):
    Promise<{ settling: boolean; baseline?: string; leftovers?: PendingEdit[]; snapshot?: CreateSnapshot }> {
  try {
    const stub = itemStub(env, boardId, itemId);
    return (await (note ? stub.createWindow(Date.now(), CREATE_CLAIM_STALE_MS, note)
      : stub.createWindow(Date.now(), CREATE_CLAIM_STALE_MS))) ?? { settling: false };
  } catch (e) {
    console.log(`[md-create] window-check board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`);
    return { settling: false };
  }
}

/**
 * Note, for this row's create window, an edit whose event never reaches a claim: our own token's (the
 * provenance gate refuses it first), or an automation's the webhook drops (the coarse Stage). Kept only
 * while the window is open, and never replayed: it stops a replay sending that writer's value as the
 * person's edit it overwrote. See CreateIdempotency.noteEdit. Fails open: a note that cannot be written
 * leaves the replay as it was.
 */
export async function noteCreateWindowEdit(env: Env, boardId: string, itemId: string, e: PendingEdit): Promise<void> {
  try { await itemStub(env, boardId, itemId).noteEdit(Date.now(), CREATE_CLAIM_STALE_MS, e); }
  catch (err) { console.log(`[md-create] note board=${boardId} item=${itemId} error="${String(err).slice(0, 120)}"`); }
}
export async function forgetHubspotForItem(env: Env, boardId: string, itemId: string): Promise<void> {
  try { await itemStub(env, boardId, itemId).forgetCard(); }
  catch (e) { console.log(`[md-create] forget board=${boardId} item=${itemId} error="${String(e).slice(0, 120)}"`); }
}

// --- THE CARD'S WATCH (STALE_FORWARD_GATE, card-watch.ts): one instance per card, `held:<board>:<item>` ----------
// Every call is FAIL-SOFT and BOUNDED (WATCH_RPC_TIMEOUT_MS): a watch that cannot be reached returns null and logs,
// and the caller falls back to its own verdicts (holds stand, candidates are left, forwards proceed). A pass must
// never fail -- or wait out a webhook's time -- because its card's watch did not answer.

function watchStub(env: Env, boardId: string, itemId: string) {
  return env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(`held:${boardId}:${itemId}`));
}

/** How long a watch RPC may take before its caller goes on without it. */
export const WATCH_RPC_TIMEOUT_MS = 3_000;

async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`no answer within ${WATCH_RPC_TIMEOUT_MS} ms`)), WATCH_RPC_TIMEOUT_MS);
  });
  try { return await Promise.race([p, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function watchCall<T>(env: Env, boardId: string, itemId: string, what: string,
    call: (stub: any) => Promise<T>, action = "watch-unreachable"): Promise<T | null> {
  try { return await bounded(call(watchStub(env, boardId, itemId))); }
  catch (e) {
    console.log(`[watch] board=${boardId} item=${itemId} action=${action} call=${what} reason="${String(e).slice(0, 120)}"`);
    return null;
  }
}

/** Tell the card's watch which cells a pass left in place (or found resolved), and learn per cell since when it is
 *  held, whether that hold ended, any live mark, and the loop breaker's word. Null: unreachable.
 *  `linkedAt`: the card was just linked to its record (an adoption, a create's write-back).
 *  `dryRun` (a /resync dry run): the same answers, READ ONLY -- a dry run never leaves anything durable behind. */
export async function watchCells(env: Env, base: WatchBase, reqs: WatchReq[],
    o: { resolved?: string[]; all?: boolean; linkedAt?: number; windowMs: number; dryRun?: boolean }):
    Promise<Record<string, WatchReply> | null> {
  if (o.dryRun) {
    if (!reqs.length) return {};
    return watchCall(env, base.boardId, base.itemId, "peekCells", stub => stub.peekCells(Date.now(), o.windowMs, base, reqs));
  }
  return watchCall(env, base.boardId, base.itemId, "watchCells",
    stub => stub.watchCells(Date.now(), o.windowMs, base, reqs, { resolved: o.resolved ?? [], all: !!o.all,
      ...(o.linkedAt !== undefined ? { linkedAt: o.linkedAt } : {}) }));
}

/** A person's (or an automation's) edit is on its way: mark its cells until its run resolves. Unreachable: logged
 *  (mark-unreachable), and the edit goes on unmarked -- its own run still pushes it. Nothing in a dry run. */
export async function markEdits(env: Env, base: WatchBase, marks: MarkInput[], dryRun = false): Promise<void> {
  if (dryRun) return;
  await watchCall(env, base.boardId, base.itemId, "markEdits",
    stub => stub.markEdits(Date.now(), base, marks), "mark-unreachable");
}

/** A retry superseded by HubSpot's later changes: its marks go (unless an event reached them after `t0`), and each
 *  cell (as it shows now: `fps`) is due for a converge at once and never rescued again. See reduceSupersede. */
export async function supersedeMarks(env: Env, base: WatchBase, fps: Record<string, string>, t0: number,
    windowMs: number): Promise<void> {
  if (!Object.keys(fps).length) return;
  await watchCall(env, base.boardId, base.itemId, "supersede", stub => stub.supersede(Date.now(), windowMs, base, fps, t0));
}

/** A run resolved: clear its marks (no event since `t0`) and the holds it settled. */
export async function clearMarks(env: Env, base: WatchBase, keys: string[], t0: number): Promise<void> {
  if (!keys.length) return;
  await watchCall(env, base.boardId, base.itemId, "clearMarks", stub => stub.clearMarks(Date.now(), keys, t0));
}

/** The converge's snapshot: `{}` when the card has no watch; null when unreachable. */
export async function beginConverge(env: Env, boardId: string, itemId: string): Promise<{ snapshot?: CardWatch } | null> {
  return watchCall(env, boardId, itemId, "beginConverge", stub => stub.beginConverge(Date.now()));
}

export async function finishConverge(env: Env, boardId: string, itemId: string, outcome: ConvergeOutcome, windowMs: number): Promise<void> {
  await watchCall(env, boardId, itemId, "finishConverge", stub => stub.finishConverge(Date.now(), windowMs, outcome));
}

/** The retry's marks (past their lease), each counted as an attempt; null when unreachable. */
export async function beginRetry(env: Env, boardId: string, itemId: string, windowMs: number):
    Promise<Record<string, EditMark> | null> {
  return watchCall(env, boardId, itemId, "beginRetry", stub => stub.beginRetry(Date.now(), windowMs));
}

/** A Sync State write on this card: `t` written between `s` and `e` (ms). See CreateIdempotency.noteStamp. A dry run
 *  wrote nothing, so it notes nothing (the register would otherwise "restore" a stamp that was never written). */
export async function noteStamp(env: Env, base: WatchBase, t: string, s: number, e: number, syncCol: string,
    dryRun = false): Promise<void> {
  if (dryRun) return;
  await watchCall(env, base.boardId, base.itemId, "noteStamp", stub => stub.noteStamp(Date.now(), base, t, s, e, syncCol));
}
