import type { Budget, Env, ObjectSpec } from "./types";
import { LINE_ITEM_SUBITEMS, specByBoard } from "./config";
import { createNote, getAssociatedIds } from "./hubspot";
import { getItem, getUserById } from "./monday";
import { colText } from "./dedup";
import { webhookOpts } from "./run-opts";
import { actorLabel, isIntegrationActor } from "./actor-label";
import { deleteHubspotObject, getCtxCached, syncHubspotObject, syncMondayItem } from "./sync";
import { reverseSubitemEdit } from "./associations";
import { isReverseSubitemEvent, readSubitemEvent } from "./line-item-reverse";
import { isDeletionEvent, restoreDeletedCard } from "./restore-card";
import { CRM_CONTACTS } from "./config/crm";
import { scheduleIfUnresolved } from "./activity-retry";
import { spillDeferred, type DeferredItem } from "./deferred-sync";
import {
  ACTIVITY_BY_NAME, ACTIVITY_BY_TYPEID, activitySyncEnabled,
  syncHubspotActivity, syncMondayTimeline, resetHelperOnReassignment,
} from "./activity-sync";

/** monday "Last Activity Date" on CRM Contacts — the activity wake-up doorbell. See the branch below. */
const ACTIVITY_WAKE_COL = "date_mm7054jz";

/** Columns whose monday-side change must NOT trigger a reconcile:
 *  - our own bookkeeping (Sync State / HubSpot ID / Link) — echoes of our own writes;
 *  - one-way HubSpot->monday fields (e.g. Created date) — a monday edit has nothing to push back, so
 *    reconciling on it is pure waste. A bulk fill of such a column would otherwise storm the
 *    reconciler with one full single-record sync per card. The daily sweep still heals manual edits. */
export function ignoredColumns(spec: ObjectSpec): Set<string> {
  const out = new Set<string>([spec.syncStateCol, spec.idCol, spec.linkCol].filter(Boolean) as string[]);
  for (const f of spec.fields) if (f.oneWay) out.add(f.col);
  return out;
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
    Date.now(), ownerId, spec.object, hsId, webhookOpts(env));
  console.log(`[webhook] source=monday-update item=${u.itemId} object=${spec.object}/${hsId} note=${noteId} action=created`);
}

/**
 * Is this monday webhook request authentic?
 *
 * monday gives a board webhook NO cryptographic signature unless the hook was created with an
 * INTEGRATION APP's OAuth token — confirmed against current monday documentation. Ours were created
 * with a personal API token, so there is no `Authorization` JWT to verify and no signature to check.
 * (`MONDAY_SIGNING_SECRET` has sat in Env since the beginning, read by nothing, describing a mechanism
 * that cannot exist for these hooks. It is a comment, not a control.)
 *
 * So the interim control is a CAPABILITY URL: the hook is registered at
 * `/webhooks/monday/<32 random bytes>` and anything without that secret is refused. This is a shared
 * secret, not a signature — weaker in two specific ways, and worth naming rather than glossing:
 * a URL can leak through proxy and access logs, and it proves only "the caller knows the secret",
 * never "monday sent this, about this board". What it does buy, today, with no OAuth round-trip, is
 * turning "anyone who guesses the path" into "anyone who has 32 random bytes".
 *
 * FAILS OPEN WHEN UNCONFIGURED, CLOSED WHEN CONFIGURED. This handler is SHARED with the live
 * Work-Management Worker, whose hooks are registered at the bare path and must keep working untouched.
 * Only the CRM Worker gets MONDAY_WEBHOOK_KEY, and only there does the check bite. Making it
 * unconditional would take the WM sync offline the moment it deployed.
 */
export function mondayAuth(url: URL, env: Env): { ok: boolean; reason: string } {
  const key = (env.MONDAY_WEBHOOK_KEY ?? "").trim();
  if (!key) return { ok: true, reason: "unconfigured" };   // WM path — byte-for-byte unchanged
  const m = url.pathname.match(/^\/webhooks\/monday\/([^/]+)\/?$/);
  const presented = m ? decodeURIComponent(m[1]) : (url.searchParams.get("k") ?? "");
  return safeEq(presented, key)
    ? { ok: true, reason: m ? "path-key" : "query-key" }
    : { ok: false, reason: presented ? "bad-key" : "missing-key" };
}

// POST /webhooks/monday  (and /webhooks/monday/<key> when MONDAY_WEBHOOK_KEY is set)
// Handles the subscription challenge, then item-created / name-changed / column-changed / moved / update.
export async function handleMonday(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
  // Refused BEFORE the body is parsed and before the challenge is echoed: an unauthenticated caller
  // must learn nothing and cause nothing, including a successful webhook handshake.
  const auth = mondayAuth(new URL(req.url), env);
  if (!auth.ok) {
    console.log(`[webhook] source=monday action=rejected reason="${auth.reason}"`);
    return new Response("unauthorized", { status: 401 });
  }
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
  const spec = specByBoard(env, boardId);   // EXCLUSIVE: undefined for a board this deployment does not own

  // monday SUBITEM (line-item) edits reverse to HubSpot. When we subscribe to change_subitem_* on the
  // PARENT deals board, monday DELIVERS each edit as a GENERIC "update_column_value"/"update_name" event
  // whose boardId is the HIDDEN subitems board (5029480548) and which carries parentItemId (confirmed from
  // live payloads). The delivered type is the same one a main-board edit uses, so `boardId` — not the type
  // string — is the unambiguous signal. Intercept here BEFORE normal deal handling (else the subitem id
  // would be treated as a deal). Coalesce PER SUBITEM+COLUMN so two rapid different-column edits don't
  // collapse and drop one.
  if (boardId === LINE_ITEM_SUBITEMS.boardId || isReverseSubitemEvent(type)) {
    const s = readSubitemEvent(ev);
    if (s.subitemId) {
      const actorId = String(ev.userId ?? "");
      console.log(`[webhook] source=monday subitem=${s.subitemId} type=${type}${s.columnId ? ` col=${s.columnId}` : ""} user=${actorId} action=received-subitem`);
      // Resolve WHO inside waitUntil so the webhook still returns immediately (cached per isolate).
      ectx.waitUntil(actorLabel(env, actorId).then(a =>
        console.log(`[actor] source=monday subitem=${s.subitemId} col=${s.columnId} ${a}`)).catch(() => {}));
      const coKey = s.columnId ? `sub:${s.subitemId}:${s.columnId}` : `sub:${s.subitemId}:name`;
      ectx.waitUntil(coalesce(coKey, () => reverseSubitemEdit(env, ev, webhookOpts(env), { left: 30 }))
        .catch(e => console.log(`[webhook] source=monday subitem=${s.subitemId} action=error reason="${String(e).slice(0, 160)}"`)));
      return new Response("ok");
    }
  }

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
  // A rep DELETED or ARCHIVED the card. monday is never allowed to delete the HubSpot record — the card
  // is restored from HubSpot instead. Must be intercepted HERE: the generic path below calls
  // syncMondayItem, whose getItem returns null for a deleted item, so it logged "item not found" and the
  // card stayed gone forever. Restoration still goes through mayCreateCrmCard, so a pre-cutover record
  // is refused and this cannot become a historical import.
  if (isDeletionEvent(type)) {
    // OPT-IN PER SPEC. Without this the branch would arm card resurrection on the LIVE
    // Work-Management follow-up boards, which run this same code with ENABLE_CRM unset. Their specs
    // declare no `ownership`, and mayCreateCrmCard opens with `if (!o) return true` — so the
    // no-import gate is a pass-through there and a rep's deliberate deletion would silently reappear
    // on a business-critical board. Previously such an event fell through to syncMondayItem and was a
    // safe no-op ("item not found (deleted)"); that safety has to be preserved explicitly now.
    if (!spec.restoreOnDelete) {
      console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type}`
        + ` action=ignored reason="board does not opt into restore-on-delete"`);
      return new Response("ok");
    }
    console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type} user=${ev.userId ?? ""} action=received-deletion`);
    const delBudget: Budget = { left: 30 };
    ectx.waitUntil(coalesce(`del:${itemId}`,
      () => restoreDeletedCard(env, spec, itemId, ev, webhookOpts(env), delBudget))
      .catch(e => console.log(`[webhook] source=monday item=${itemId} action=error reason="${String(e).slice(0, 160)}"`)));
    return new Response("ok");
  }
  // ACTIVITY WAKE-UP, checked BEFORE the ignore branch because Last Activity Date is one of the
  // columns that branch drops. It is a DOORBELL, never data: the date is not read as the activity and
  // never decides qualification. The Worker reads that one contact's timeline and the durable
  // registry decides what is new, so the ~2 wake-ups each activity produces (the E&A automation and
  // the workflow both write this column) cost one read and create nothing twice.
  //
  // Proven reliable for repeat activity on the same day: monday emits update_column_value even when
  // the value is UNCHANGED — four "2026-09-16 -> 2026-09-16" events were observed on one card — so
  // the second and third activity of a day still ring the bell.
  if (columnId === ACTIVITY_WAKE_COL && spec.boardId === CRM_CONTACTS.boardId) {
    if (!activitySyncEnabled(env)) {
      console.log(`[webhook] source=monday item=${itemId} col=${columnId} action=ignored reason="ENABLE_ACTIVITY_SYNC is off"`);
      return new Response("ok");
    }
    console.log(`[webhook] source=monday item=${itemId} col=${columnId} action=activity-wake`);
    ectx.waitUntil(syncMondayTimeline(env, itemId)
      .catch(e => console.log(`[activity] source=monday item=${itemId} action=error reason="${String(e).slice(0, 140)}"`)));
    return new Response("ok");
  }

  // LOOP GUARD: value columns still flow through (value-diff no-ops an echo), but bookkeeping and
  // one-way columns are dropped outright.
  if (columnId && ignoredColumns(spec).has(columnId)) {
    console.log(`[webhook] source=monday item=${itemId} type=${type} col=${columnId} action=ignored reason="bookkeeping/one-way column"`);
    return new Response("ok");
  }

  const actorId = String(ev.userId ?? "");
  console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type}${columnId ? ` col=${columnId}` : ""} user=${actorId} action=received`);
  // WHO made this edit. Every write WE make is attributed to the integration's own token user, so without
  // this a log cannot tell a rep's edit from the sync's echo — the ambiguity behind the 2026-08-28
  // owner-reassignment question. Resolved inside waitUntil (cached) to keep the webhook response fast.
  ectx.waitUntil(actorLabel(env, actorId).then(a =>
    console.log(`[actor] source=monday board=${boardId} item=${itemId}${columnId ? ` col=${columnId}` : ""} ${a}`)).catch(() => {}));
  const budget: Budget = { left: 30 };
  // PROVENANCE. Resolved BEFORE the sync, not alongside it in waitUntil, because every monday->HubSpot
  // mutation depends on the answer: an event our own token caused is an echo and carries no user
  // intent. 1,207 HubSpot Companies were created from such echoes during the historical import. Only
  // CRM specs are gated — the live Work-Management boards keep their existing behaviour exactly.
  // coalesce by item id so rapid edits (or our own write-back echoes) can't race into a duplicate.
  ectx.waitUntil(coalesce(`md:${itemId}`, async () => {
    const selfOrigin = !!spec.suppressSelfOriginWrites && await isIntegrationActor(env, actorId);
    if (selfOrigin) console.log(`[webhook] source=monday item=${itemId}`
      + ` action=self-origin reason="caused by our own token — HubSpot writes suppressed"`);
    return syncMondayItem(env, boardId, itemId, webhookOpts(env), budget, false, selfOrigin);
  }).catch(e => console.log(`[webhook] source=monday item=${itemId} action=error reason="${String(e).slice(0, 160)}"`)));
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

/**
 * ACTIVITY creation events (email / call / note / meeting_event), pulled out SEPARATELY from
 * extractObjectEvents so the two never share a code path.
 *
 * Creation only. monday has no timeline-item update mutation, so a propertyChange on an activity is
 * something we could not act on; matching it would create work with no possible outcome.
 *
 * Deliberately strict about identifying the object — objectTypeId first, then the explicit name.
 * extractObjectEvents has a fallback that treats a payload carrying NEITHER subscriptionType NOR
 * objectTypeId as a deal (monday's Workflow "send webhook" sends that shape). Nothing here may
 * inherit that guess: an activity mistaken for a deal would be a lookup for a deal that does not
 * exist, on every activity anyone logs, and silent because a missing deal is an ordinary outcome.
 */
export function extractActivityEvents(body: any): { object: string; id: string }[] {
  const arr = Array.isArray(body) ? body : [body];
  const out = new Map<string, { object: string; id: string }>();
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const sub = String(e.subscriptionType ?? e.eventType ?? "");
    /**
     * CREATION, AND ALSO ASSOCIATION CHANGE.
     *
     * Creation alone was right while the only destination was "the associated Contact". It is not
     * right now that one activity fans out to a Contact, a Company and a Deal: an activity whose
     * associations are attached AFTER it is created — an automation, or an API flow that posts the
     * record first and links it second — fires creation while it is still associated with nothing,
     * and the destinations added a moment later would never be written. Observed directly while
     * proving the fan-out: a note created bare and associated afterwards reached the Contact and
     * missed the Company and Deal entirely.
     *
     * Re-running is safe and nearly free: every destination has its own durable mapping, so the ones
     * already written are skipped and only genuinely new ones are created.
     *
     * propertyChange is still excluded — monday has no timeline-item update mutation, so an edited
     * activity is something we could not act on.
     */
    if (!sub.endsWith("creation") && !sub.endsWith("associationChange")) continue;
    const object = ACTIVITY_BY_TYPEID[String(e.objectTypeId ?? "")]
      ?? ACTIVITY_BY_NAME[String(e.objectType ?? "").toLowerCase()];
    if (!object) continue;
    const raw = e.objectId ?? e.hs_object_id ?? e.id;
    if (raw != null && /^\d+$/.test(String(raw))) out.set(`${object}:${raw}`, { object, id: String(raw) });
  }
  return [...out.values()];
}

/**
 * Contacts whose OWNER may have just changed.
 *
 * Deliberately narrow: only object.propertyChange on hubspot_owner_id, which is a subscription the
 * app already holds. Every other contact event is an ordinary edit and must not be able to reach the
 * helper reset — the whole point of the reset is that it fires on reassignment and nothing else.
 *
 * "May have": this only says an owner property was written. Whether that was a real change or an echo
 * of our own reverse sync is decided in resetHelperOnReassignment against HubSpot's stored state, not
 * here — a webhook cannot tell the two apart.
 */
export function extractOwnerChangeContactIds(body: any): string[] {
  const arr = Array.isArray(body) ? body : [body];
  const out = new Set<string>();
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const sub = String(e.subscriptionType ?? e.eventType ?? "");
    if (!sub.endsWith("propertyChange")) continue;
    if (String(e.propertyName ?? "") !== "hubspot_owner_id") continue;
    const objTypeId = String(e.objectTypeId ?? "");
    const objName = String(e.objectType ?? "").toLowerCase();
    // Contacts only. A company or deal owner change has no follow-up helper to reset.
    if (objTypeId ? objTypeId !== "0-1" : !sub.startsWith("contact") && objName !== "contact") continue;
    const raw = e.objectId ?? e.hs_object_id ?? e.id;
    if (raw != null && /^\d+$/.test(String(raw))) out.add(String(raw));
  }
  return [...out];
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

  // ACTIVITY EVENTS ARE ROUTED SEPARATELY and never reach the object path below. Nothing on this
  // branch builds a label dictionary or touches an ObjectSpec: a 403 raised while assembling
  // dictionaries is exactly what escaped this handler on 2026-09-15 and stopped Contacts and
  // Companies sync for an hour, and activity events now land on this same endpoint. Each is fired
  // independently so one failure cannot take the batch — or the contact/company events sharing it —
  // down with it.
  const activityEvents = extractActivityEvents(body);
  if (activityEvents.length) {
    if (!activitySyncEnabled(env)) {
      console.log(`[webhook] source=hubspot activities=${activityEvents.length} action=ignored reason="ENABLE_ACTIVITY_SYNC is off"`);
    } else {
      console.log(`[webhook] source=hubspot activities=${activityEvents.map(a => `${a.object}:${a.id}`).join(",")} action=received`);
      for (const a of activityEvents)
        // The outcome decides whether this activity needs a DURABLE retry. The in-invocation
        // backoff covers the ordinary race; when it still cannot find the contact or card, nothing
        // would ever redeliver this webhook — waitUntil already answered 200 — so the job is
        // persisted here instead of being logged and lost.
        ectx.waitUntil(syncHubspotActivity(env, a.object, a.id)
          .then(outcome => scheduleIfUnresolved(env, a.object, a.id, outcome))
          .catch(e => console.log(`[activity] source=hubspot ${a.object}=${a.id} action=error reason="${String(e).slice(0, 140)}"`)));
    }
  }

  // OWNER REASSIGNMENT -> reset the follow-up helper. Fired independently, on the same reasoning as
  // the activity branch above: it must not be able to fail the contact sync sharing this batch.
  if (activitySyncEnabled(env)) {
    for (const cid of extractOwnerChangeContactIds(body))
      ectx.waitUntil(resetHelperOnReassignment(env, cid)
        .catch(e => console.log(`[activity] source=owner contact=${cid} action=error reason="${String(e).slice(0, 140)}"`)));
  }

  if (!events.length && !liIds.length) {
    if (activityEvents.length) return new Response("ok");
    console.log(`[webhook] source=hubspot action=ignored reason="no object id found" body=${raw.slice(0, 240)}`);
    return new Response("ok");
  }

  console.log(`[webhook] source=hubspot events=${events.map(e => `${e.deleted ? "del:" : ""}${e.type}:${e.id}`).join(",")}${liIds.length ? ` line_items=${liIds.join(",")}` : ""} action=received`);
  const opts = webhookOpts(env);
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
    /**
     * THE OVERFLOW GOES SOMEWHERE NOW.
     *
     * This used to log "backup catches overflow" and drop the remainder. That sentence is true on the
     * Work Management Worker, which runs a ten-minute incremental cron; it was never true here, where
     * crons are disabled for Phase 1, so `scheduled()` never fires. With HubSpot delivering ~47
     * contact events per batch during a bulk update, roughly two thirds of each batch was discarded
     * behind a reassuring log line — and a dropped change is invisible, because the card simply keeps
     * its old values.
     *
     * Contacts and Companies only. Deals and line items keep their existing behaviour exactly, and
     * the spill is a no-op on the Work Management deployment, which has no such binding and whose
     * cron already covers this ground.
     */
    if (events.length > MAX) {
      const overflow = events.slice(MAX);
      const spill: DeferredItem[] = overflow
        .filter(e => e.type === "contact" || e.type === "company")
        .map(e => ({ type: e.type as "contact" | "company", id: e.id, deleted: e.deleted }));
      console.log(`[webhook] source=hubspot action=deferred count=${overflow.length}`
        + ` spilling=${spill.length} reason="batch > ${MAX}; overflow queued durably"`);
      await spillDeferred(env, spill);
    }
    // coalesce by object type+id(+delete) so a burst of events for one record can't race into a duplicate.
    await Promise.all(events.slice(0, MAX).map(ev =>
      coalesce(`hs:${ev.type}:${ev.id}:${ev.deleted ? "d" : "u"}`, () =>
        ev.deleted ? deleteHubspotObject(env, ev.type, ev.id, opts, budget)
                   : syncHubspotObject(env, ev.type, ev.id, opts, budget))
        .catch(e => console.log(`[webhook] source=hubspot ${ev.type}=${ev.id} action=error reason="${String(e).slice(0, 160)}"`))));
  })());
  return new Response("ok"); // respond fast so HubSpot doesn't retry
}
