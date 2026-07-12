import type { Budget, Env, ObjectSpec, RunOpts } from "./types";
import { SPEC_BY_BOARD } from "./config";
import { createNote, getAssociatedIds } from "./hubspot";
import { getItem, getUserById } from "./monday";
import { colText } from "./dedup";
import { deleteHubspotObject, getCtxCached, syncHubspotObject, syncMondayItem } from "./sync";

// Webhooks write for real when the Worker is live; a small per-webhook budget is plenty (1 record).
function liveOpts(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  return { dryRun: !live, writeHubspot: live, maxWrites: 30 };
}

async function hmacB64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Coalesce concurrent duplicate events within an isolate: if the same deal/item is already being
// processed, return the in-flight promise instead of kicking off a second create/update. This closes
// the window where two webhooks for the same BRAND-NEW record arrive together and both create a card
// (the id-column search hasn't found anything yet for either). Best-effort per isolate; cross-isolate
// bursts still converge via the id-column dedup + the cron backup, never a duplicate that survives.
const inFlight = new Map<string, Promise<unknown>>();
export function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    console.log(`[webhook] action=coalesced key=${key} reason="duplicate event already in flight"`);
    return existing;
  }
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ------------------------------- monday -------------------------------

/** Parse a monday create_update webhook event -> { itemId, userId, text }, or null for other events. */
export function extractUpdate(ev: any): { itemId: string; userId: string; text: string } | null {
  if (String(ev?.type ?? "") !== "create_update") return null;
  const itemId = String(ev.pulseId ?? ev.itemId ?? "");
  const text = String(ev.textBody ?? ev.body ?? "").trim();
  if (!itemId || !text) return null;
  return { itemId, userId: String(ev.userId ?? ""), text };
}

/** A monday Update -> a Note on the matching HubSpot record, prefixed with the author. */
async function syncMondayUpdate(env: Env, spec: ObjectSpec, ev: any): Promise<void> {
  const u = extractUpdate(ev);
  if (!u) return;
  const item = await getItem(env, u.itemId);
  const hsId = item ? colText(item, spec.idCol) : "";
  if (!hsId) {
    console.log(`[webhook] source=monday-update item=${u.itemId} action=skipped reason="not linked to HubSpot"`);
    return;
  }
  const ctx = await getCtxCached(env);
  let author = "a monday user";
  let ownerId: string | undefined;
  if (u.userId) {
    const mu = await getUserById(env, u.userId);
    if (mu) { if (mu.name) author = mu.name; ownerId = mu.email ? ctx.ownerIdByEmail[mu.email.toLowerCase()] : undefined; }
  }
  const noteId = await createNote(env, `Update by ${author} (via monday): ${u.text}`,
    Date.now(), ownerId, spec.object, hsId, liveOpts(env));
  console.log(`[webhook] source=monday-update item=${u.itemId} object=${spec.object}/${hsId} note=${noteId} action=created`);
}

// POST /webhooks/monday
// Handles the subscription challenge, then item-created / name-changed / column-changed / moved / update.
export async function handleMonday(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  let body: any = {};
  try { body = JSON.parse(raw); } catch { /* not json */ }

  // monday sends {"challenge":"..."} when the webhook is created — echo it back.
  if (body.challenge) return Response.json({ challenge: body.challenge });

  const ev = body.event ?? {};
  const boardId = String(ev.boardId ?? "");
  const itemId = String(ev.pulseId ?? ev.itemId ?? "");
  const type = String(ev.type ?? "");
  const columnId = ev.columnId ? String(ev.columnId) : "";
  const spec = SPEC_BY_BOARD[boardId];

  if (!spec || !itemId) {
    console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type} action=ignored reason="board not configured / no item"`);
    return new Response("ok");
  }
  // A posted Update ("Updates" feed) -> a Note on the matching HubSpot record (Activities). One-way.
  if (type === "create_update") {
    console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=create_update action=received`);
    ectx.waitUntil(coalesce(`upd:${ev.updateId ?? itemId}`, () => syncMondayUpdate(env, spec, ev))
      .catch(e => console.log(`[webhook] source=monday-update item=${itemId} action=error reason="${String(e).slice(0, 160)}"`)));
    return new Response("ok");
  }
  // LOOP GUARD: ignore changes we made to our own bookkeeping columns (Sync State / HubSpot ID /
  // Link). Value columns still flow through, but value-diff will no-op an echo.
  const bookkeeping = new Set([spec.syncStateCol, spec.idCol, spec.linkCol].filter(Boolean) as string[]);
  if (columnId && bookkeeping.has(columnId)) { // any column-change event on a bookkeeping column
    console.log(`[webhook] source=monday item=${itemId} type=${type} col=${columnId} action=ignored reason="own bookkeeping column"`);
    return new Response("ok");
  }

  console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type}${columnId ? ` col=${columnId}` : ""} action=received`);
  const budget: Budget = { left: 30 };
  // coalesce by item id so rapid edits (or our own write-back echoes) can't race into a duplicate.
  ectx.waitUntil(coalesce(`md:${itemId}`, () => syncMondayItem(env, boardId, itemId, liveOpts(env), budget))
    .catch(e => console.log(`[webhook] source=monday item=${itemId} action=error reason="${String(e).slice(0, 160)}"`)));
  return new Response("ok"); // respond fast so monday doesn't retry
}

// ------------------------------- hubspot -------------------------------
// POST /webhooks/hubspot — deal.creation / deal.propertyChange (name, stage, pipeline, owner, sales_user).
//
// v3 signature (HubSpot docs): base64( HMAC-SHA256( clientSecret, method + fullUrl + rawBody + timestamp ) ),
// sent in x-hubspot-signature-v3, with x-hubspot-request-timestamp for replay protection (reject > 5 min).
// Enforced only when HUBSPOT_APP_SECRET is set (= the app's client secret); when unset we accept because
// the endpoint URL is unguessable. Returns a specific reason so rejections are debuggable in the logs.
type SigVerdict = { ok: boolean; reason: string };
async function verifyHubspot(env: Env, req: Request, raw: string): Promise<SigVerdict> {
  if (!env.HUBSPOT_APP_SECRET) return { ok: true, reason: "unsigned-accepted (no HUBSPOT_APP_SECRET set)" };
  const sig = req.headers.get("x-hubspot-signature-v3");
  const ts = req.headers.get("x-hubspot-request-timestamp");
  if (!sig || !ts) return { ok: false, reason: "missing signature/timestamp header" };
  if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > 5 * 60_000)
    return { ok: false, reason: "stale or invalid timestamp (replay guard)" };
  const expected = await hmacB64(env.HUBSPOT_APP_SECRET, `${req.method}${req.url}${raw}${ts}`);
  return safeEq(expected, sig) ? { ok: true, reason: "valid" } : { ok: false, reason: "signature mismatch" };
}

export type HsObjType = "deal" | "contact" | "company";
const OBJ_BY_TYPEID: Record<string, HsObjType> = { "0-1": "contact", "0-2": "company", "0-3": "deal" };

/** Pull (objectType, id) events from any HubSpot webhook shape we might receive:
 *  - 2026 projects-app: subscriptionType "object.creation"/"object.propertyChange" + objectTypeId
 *    ("0-1" contact, "0-2" company, "0-3" deal)
 *  - legacy developer-app: subscriptionType "deal.*" / "contact.*" / "company.*" (+ objectId)
 *  - Workflow "send webhook": the object itself (no subscriptionType; id in hs_object_id — assumed deal).
 * Deduped by type+id so a batch of property-change events for one record collapses to a single sync,
 * and mixed batches (deal + contact + company) are each routed to the right object type. */
export function extractObjectEvents(body: any): { type: HsObjType; id: string; deleted?: boolean }[] {
  const arr = Array.isArray(body) ? body : [body];
  const out = new Map<string, { type: HsObjType; id: string; deleted?: boolean }>();
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const sub = String(e.subscriptionType ?? e.eventType ?? "");
    // associationChange payloads carry the changed record's type/id in from*; everything else in objectTypeId/objectId.
    const objTypeId = String(e.objectTypeId ?? e.fromObjectTypeId ?? "");
    const objName = String(e.objectType ?? "").toLowerCase();
    let type: HsObjType | undefined;
    if (sub.startsWith("deal") || objName === "deal") type = "deal";
    else if (sub.startsWith("contact") || objName === "contact") type = "contact";
    else if (sub.startsWith("company") || objName === "company") type = "company";
    else if (OBJ_BY_TYPEID[objTypeId]) type = OBJ_BY_TYPEID[objTypeId]; // generic "object.*" + objectTypeId
    else if (!sub && !objTypeId) type = "deal";                        // bare Workflow payload -> deal
    if (!type) continue;                                               // unresolvable object type -> skip
    // deletion events: subscriptionType ends in ".deletion" (object.deletion / deal.deletion / ...).
    const deleted = sub.split(".").pop() === "deletion";
    const p = e.properties ?? {};
    // fromObjectId: association-change events carry the changed record's id there (re-sync that record's
    // associations — the link columns). Everything else uses objectId/hs_object_id as before.
    let raw = e.objectId ?? e.fromObjectId ?? e.hs_object_id ?? e.dealId ?? e.vid ?? e.id ?? p.hs_object_id ?? p.dealId;
    if (raw && typeof raw === "object") raw = raw.value; // legacy {value:"123"} shape
    if (raw != null && /^\d+$/.test(String(raw)))
      out.set(`${type}:${raw}:${deleted ? "d" : "u"}`,
        deleted ? { type, id: String(raw), deleted: true } : { type, id: String(raw) });
  }
  return [...out.values()];
}

/** Back-compat helper (deal ids only) — used by tests and any deal-only caller. */
export function extractDealIds(body: any): string[] {
  return extractObjectEvents(body).filter(e => e.type === "deal").map(e => e.id);
}

/** Line-item ids from a HubSpot webhook batch (objectTypeId 0-8 / subscriptionType line_item.*). A
 * line-item property edit is routed to its parent DEAL(s) by the caller, which rebuilds the subitems. */
export function extractLineItemIds(body: any): string[] {
  const arr = Array.isArray(body) ? body : [body];
  const out = new Set<string>();
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const sub = String(e.subscriptionType ?? e.eventType ?? "");
    if (String(e.objectTypeId ?? "") !== "0-8" && !sub.startsWith("line_item")) continue;
    let raw = e.objectId ?? e.hs_object_id ?? e.id ?? (e.properties ?? {}).hs_object_id;
    if (raw && typeof raw === "object") raw = raw.value;
    if (raw != null && /^\d+$/.test(String(raw))) out.add(String(raw));
  }
  return [...out];
}

export async function handleHubspot(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  const sig = await verifyHubspot(env, req, raw);
  if (!sig.ok) {
    console.log(`[webhook] source=hubspot action=rejected reason="${sig.reason}"`);
    return new Response("forbidden", { status: 403 });
  }
  let body: any = null;
  try { body = JSON.parse(raw); } catch { /* not json */ }

  // Route each event by object type; a single batch may mix deals, contacts, companies (creations,
  // updates, deletions, and association changes), plus line-item edits routed to their parent deal.
  const events = extractObjectEvents(body);
  const liIds = extractLineItemIds(body);
  if (!events.length && !liIds.length) {
    console.log(`[webhook] source=hubspot action=ignored reason="no object id found" body=${raw.slice(0, 240)}`);
    return new Response("ok");
  }

  console.log(`[webhook] source=hubspot events=${events.map(e => `${e.deleted ? "del:" : ""}${e.type}:${e.id}`).join(",")}${liIds.length ? ` line_items=${liIds.join(",")}` : ""} action=received`);
  const opts = liveOpts(env);
  const budget: Budget = { left: 30 };
  // Subrequest safety: a large import can batch many events into one webhook. Process a bounded slice
  // per invocation (each event costs a few subrequests); the 10-min backup reconcile sweeps overflow.
  const MAX = 15;
  ectx.waitUntil((async () => {
    // Line-item edit -> re-sync its parent deal(s) (rebuilds the subitems). Async, so it runs here
    // (inside waitUntil) to keep the webhook response fast. Deduped with deal events via `coalesce`.
    for (const liId of liIds.slice(0, MAX)) {
      try {
        for (const d of await getAssociatedIds(env, "line_items", liId, "deals")) events.push({ type: "deal", id: d });
      } catch (e) { console.log(`[webhook] source=hubspot line_item=${liId} action=error reason="${String(e).slice(0, 120)}"`); }
    }
    if (events.length > MAX)
      console.log(`[webhook] source=hubspot action=deferred count=${events.length - MAX} reason="batch > ${MAX}; backup catches overflow"`);
    // coalesce by object type+id(+delete) so a burst of events for one record can't race into a duplicate.
    await Promise.all(events.slice(0, MAX).map(ev =>
      coalesce(`hs:${ev.type}:${ev.id}:${ev.deleted ? "d" : "u"}`, () =>
        ev.deleted ? deleteHubspotObject(env, ev.type, ev.id, opts, budget)
                   : syncHubspotObject(env, ev.type, ev.id, opts, budget))
        .catch(e => console.log(`[webhook] source=hubspot ${ev.type}=${ev.id} action=error reason="${String(e).slice(0, 160)}"`))));
  })());
  return new Response("ok"); // respond fast so HubSpot doesn't retry
}
