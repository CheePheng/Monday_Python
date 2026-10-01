import type { Budget, Env, MondayEdit, ObjectSpec } from "./types";
import { LINE_ITEM_SUBITEMS, specByBoard, specByObject } from "./config";
import { createNote, getAssociatedIds } from "./hubspot";
import { getItem, getUserById } from "./monday";
import { colText } from "./dedup";
import { webhookOpts } from "./run-opts";
import { actorLabel, isAutomationActor } from "./actor-label";
import { askAdaUiEditsOn, classifyMondayActor, isOwnEcho, mondayActorLabel, uiLookupDue } from "./ui-actor";
import { deleteHubspotObject, getCtxCached, syncHubspotObject, syncMondayItem } from "./sync";
import { noteCreateWindowEdit } from "./card-registry";
import { coarseStageField, exactStageField } from "./reconcile";
import { reverseSubitemEdit } from "./associations";
import { isReverseSubitemEvent, readSubitemEvent } from "./line-item-reverse";
import { isDeletionEvent, restoreDeletedCard } from "./restore-card";
import { CRM_CONTACTS } from "./config/crm";
import { scheduleDelivery, scheduleIfUnresolved, scheduleReconcile } from "./activity-retry";
import { spillDeferred, type DeferredItem } from "./deferred-sync";
import {
  drainRelationEvents, isPairedEcho, recordRelationEvent, relationEditKey, type ActorClass, type RelationDiff,
} from "./relation-edit";
import {
  ACTIVITY_BY_NAME, ACTIVITY_BY_TYPEID, activitySyncEnabled,
  syncHubspotActivity, syncMondayTimeline, resetHelperOnReassignment,
} from "./activity-sync";

/** monday "Last Activity Date" on CRM Contacts. The doorbell until 2026-09-30; see ACTIVITY_WAKE_COLS. */
export const LAST_ACTIVITY_DATE_COL = "date_mm7054jz";
/**
 * "Activity bell (sync)" -- a hidden date column on CRM Contacts (created 2026-09-30), and nothing but a
 * trigger. monday WORKFLOW 1940472437 ("When an activity is created in Emails & Activities -> Set date:
 * Activity bell (sync)") stamps THIS column; the legacy recipes #09 (38839624) and #10 (38841239) that
 * stamped Last Activity Date are both off. So Last Activity Date is HubSpot-owned again
 * (notes_last_updated, forward only) and no entry of ours can move it or silence reminders #03/#04/#05.
 * As captured 2026-09-30 the workflow filters on "Activity type: Note", so a Call summary does NOT ring
 * it; scripts/check-activity-doorbell.mjs reports that as BELL-PARTIAL until the filter is widened.
 *
 * THE WORKER NEVER WRITES IT. No spec maps it and nothing else names it (activity-doorbell.test.ts
 * pins both), so every change of it is monday's automation -- arriving as the automation user (-4) or as
 * the automation's owner -- and never an echo of ours that could ring on every HubSpot-side update.
 */
export const ACTIVITY_BELL_COL = "date_mm7pw446";
/**
 * THE WAKE-UP COLUMNS: a change of either reads that contact's timeline (see the branch in handleMonday).
 * Last Activity Date stays in the set for safety -- an automation still pointed at it, or #09/#10 put
 * back, keeps working -- and its only other writer is our own forward sync of notes_last_updated, which costs
 * one timeline read and creates nothing (the durable registry decides what is new).
 */
export const ACTIVITY_WAKE_COLS: ReadonlySet<string> = new Set([LAST_ACTIVITY_DATE_COL, ACTIVITY_BELL_COL]);

/**
 * THE SECOND DOORBELL: a PERSON touching a Contacts card reads that card's timeline too.
 *
 * WHY IT EXISTS. monday has no webhook for a timeline entry (the WebhookEventType enum has none), so a
 * rep's native Note or Call reaches HubSpot only when something rings a wake-up column. Until
 * 2026-09-30 automations #09 (38839624) and #10 (38841239) did it by stamping Last Activity Date -- for
 * OUR entries too, which would have let every marketing entry silence reminders #03/#04/#05. So both
 * are off and workflow 1940472437 stamps the dedicated bell (ACTIVITY_BELL_COL) instead; between the
 * switch-off (09:00:42Z) and the bell nothing rang at all (POST /wake-timeline is the catch-up).
 *
 * A BACKUP, not the doorbell. The bell is meant to be the complete signal -- but while its filter is
 * Note only, this is the ONLY thing that carries a rep's Call summary, and then only when the rep also
 * changes a column, posts an update or renames the card on the same visit. A repeat ring costs one timeline read and creates nothing (the durable registry decides what
 * is new). scripts/check-activity-doorbell.mjs reports whether the bell automation is live.
 *
 * Only a person rings: our own token's writes are echoes (and would ring on every HubSpot-side
 * update), and an automation's edit follows a person's edit that already rang. Coalesced per item so a
 * burst of edits reads the timeline once.
 *
 * `spec`/`ev` (the webhook passes both): with ASK_ADA_UI_EDITS on, an event of our token user that
 * monday's log proves was a UI action rings like any person's (isOwnEcho, ui-actor.ts). Without them,
 * or with the flag off, this is isIntegrationActor exactly.
 */
export async function ringOnPersonEdit(env: Env, itemId: string, actorId: string,
    spec?: ObjectSpec, ev?: unknown): Promise<void> {
  if (!actorId || isAutomationActor(actorId)) return;
  if (await isOwnEcho(env, spec, ev ?? { userId: actorId })) return;
  console.log(`[webhook] source=monday item=${itemId} user=${actorId} action=activity-wake reason="person edit on a Contacts card"`);
  await coalesce(`tl:${itemId}`, () => syncMondayTimeline(env, itemId));
}

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

/**
 * STAGE_COARSE_REVERSE: the stage columns of a spec whose native coarse Stage (Deals `deal_stage`) a
 * PERSON may edit through to HubSpot. See coarseStageEdit in reconcile.ts for what such an edit sends.
 *
 * NULL -- and then nothing below changes a thing -- unless the flag is the literal "true" and the spec is
 * column-level with a coarse Stage field. The field stays `oneWay` in the spec either way: with the flag
 * off it is in ignoredColumns() and every event on it is dropped, which is today's behaviour exactly.
 */
export function coarseStageCols(env: Env, spec: ObjectSpec): { coarse: string; exact?: string } | null {
  if (env.STAGE_COARSE_REVERSE !== "true" || !spec.columnLevelReverse) return null;
  const coarse = coarseStageField(spec);
  return coarse ? { coarse: coarse.col, exact: exactStageField(spec)?.col } : null;
}

/**
 * A person's edits of the two stage columns of one card, in the order they arrived, until the run that
 * sends them drains them. Both columns share ONE coalesceLatest queue per card (flag on only), and
 * coalesceLatest re-runs the FIRST event's closure, so the columns edited in between are carried here.
 * An edit that brings both in one run is resolved as one change, in which the exact stage wins.
 */
const pendingStageCols = new Map<string, Set<string>>();
function drainStageCols(itemId: string): string[] {
  const s = pendingStageCols.get(itemId);
  pendingStageCols.delete(itemId);
  return s ? [...s] : [];
}

async function hmacB64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
export function safeEq(a: string, b: string): boolean {
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

/**
 * Like coalesce, but THE LATEST EDIT WINS instead of the first.
 *
 * `coalesce` hands a second event the first one's promise. That is right for de-duplicating a create,
 * and wrong for an edit: if a person changes the same column twice while the first sync is running,
 * the first sync may already have read the card, and the second value would never be sent. Here a
 * second event marks the key for ONE more run after the current one finishes; that run re-reads the
 * card, so what reaches HubSpot is the value on screen now. Any number of events during a run collapse
 * into that single trailing run. Best-effort per isolate, like coalesce.
 *
 * `rerunAfterError` (the HubSpot-event and bell keys): a run that THROWS still honours the pending
 * re-run. Without it a transient 429/5xx on the first sync dropped exactly the later event this helper
 * exists to keep -- the notes_last_updated propertyChange, or the second rung note -- and handed it the
 * first run's rejection instead. Each failed run is logged here; the promise rejects only when the LAST
 * run failed (a trailing run that succeeded has done the work). The monday md:* column queues keep the
 * original stop-on-throw: their drain semantics (relation-edit.ts, pendingRemovedPeople) were proven
 * against it, and a re-run there is not free.
 */
const latest = new Map<string, { again: boolean; p: Promise<void> }>();
export function coalesceLatest(key: string, run: () => Promise<unknown>,
    o: { rerunAfterError?: boolean } = {}): Promise<void> {
  const cur = latest.get(key);
  if (cur) {
    cur.again = true;
    console.log(`[webhook] action=coalesced-rerun key=${key} reason="edit arrived mid-sync; will re-read and send the latest"`);
    return cur.p;
  }
  const entry = { again: false, p: Promise.resolve() };
  entry.p = (async () => {
    try {
      if (!o.rerunAfterError) {
        await run();
        while (entry.again) { entry.again = false; await run(); }
        return;
      }
      for (;;) {
        let failed: { e: unknown } | null = null;
        try { await run(); } catch (e) { failed = { e }; }
        if (!entry.again) { if (failed) throw failed.e; return; }
        if (failed) console.log(`[webhook] action=error-then-rerun key=${key}`
          + ` reason="${String(failed.e).slice(0, 120)}; a later event is pending, re-reading"`);
        entry.again = false;
      }
    } finally { latest.delete(key); }
  })();
  latest.set(key, entry);
  return entry.p;
}

// ------------------------------- monday -------------------------------

/**
 * The linked item ids in a monday board_relation value, or null if the value cannot be read.
 *
 * Shapes observed live on the CRM boards (activity log, 2026-09-23): a linked cell is
 * `{"linkedPulseIds":[{"linkedPulseId":N},...],"changed_at":...}`; an EMPTIED cell is `{}` or
 * `{"changed_at":...}` with the key simply absent. So an object without `linkedPulseIds` is empty --
 * reading it as "unreadable" would have silently ignored every "remove the last link".
 */
function linkedIds(v: unknown): Set<string> | null {
  if (v === null || v === undefined) return new Set();
  let o: any = v;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { return null; } }
  if (o === null) return new Set();
  if (typeof o !== "object") return null;
  if (!("linkedPulseIds" in o)) return new Set();
  if (!Array.isArray(o.linkedPulseIds)) return null;
  return new Set(o.linkedPulseIds.map((x: any) => String(x?.linkedPulseId ?? "")).filter((s: string) => /^\d+$/.test(s)));
}

/**
 * The monday PERSON ids a People-column event removed: in `previousValue`, not in `value`. null when
 * the event did not carry the before-side, so the caller can tell "removed nobody" from "cannot tell".
 * An emptied cell arrives as null, `{}` or `{changed_at}` -- all read as "no one".
 */
export function removedPersonIds(ev: any): string[] | null {
  if (!ev || typeof ev !== "object" || !("previousValue" in ev)) return null;
  const persons = (v: any): Set<string> | null => {
    if (v === null || v === undefined) return new Set();
    let o: any = v;
    if (typeof o === "string") { try { o = JSON.parse(o); } catch { return null; } }
    if (typeof o !== "object") return null;
    if (!("personsAndTeams" in o)) return new Set();
    if (!Array.isArray(o.personsAndTeams)) return null;
    return new Set(o.personsAndTeams.filter((p: any) => p?.kind === "person").map((p: any) => String(p.id)));
  };
  const before = persons(ev.previousValue), after = persons(ev.value);
  if (!before || !after) return null;
  return [...before].filter(id => !after.has(id));
}

/** Removed people per item+column, accumulated until the run that consumes them (coalesceLatest keeps
 *  the FIRST event's closure for its re-runs, so the edits in between would otherwise be lost). */
const pendingRemovedPeople = new Map<string, { ids: Set<string>; known: boolean }>();

/**
 * What a person UNLINKED in a relation column: in monday's `previousValue` and not in `value`.
 *
 * Deliberately built only from monday's own before/after, never from a card read. The old reason for
 * never syncing an unlink was that inferring one from a read is unsafe -- a lagging or failed read looks
 * exactly like "every link removed", and acting on it would delete real associations across many
 * records. An explicit before/after cannot do that. If either side is missing or unreadable the answer
 * is "nothing", so the failure mode is a missed unlink, never an invented one.
 */
export function unlinkedCardIds(ev: any): string[] {
  if (!ev || typeof ev !== "object" || !("previousValue" in ev)) return [];
  const before = linkedIds(ev.previousValue);
  const after = linkedIds(ev.value);
  if (!before || !after) return [];
  return [...before].filter(id => !after.has(id));
}

/**
 * What a person LINKED in a relation column: in monday's `value` and not in `previousValue`. The mirror
 * of unlinkedCardIds, and the only thing the reverse pass may push as a new association (G1).
 *
 * Why not the whole cell, as before: a cell that has drifted from HubSpot -- a link removed in HubSpot
 * the forward pass has not caught up with, a card linked by an old import -- would be re-asserted in
 * HubSpot the moment the person touched the cell for any reason. Only the card they just added is
 * their intent.
 *
 * NULL, not [], when the before/after is missing or unreadable, because here the difference matters:
 * [] means "added nothing" (an unlink-only edit), null means "cannot tell", and the caller refuses the
 * push and snaps the cell back rather than guessing from the cell.
 *
 * A LITERAL `previousValue: null` IS "CANNOT TELL" HERE -- on the add side only. The shapes recorded
 * live for an empty relation cell are `{}` and `{changed_at}`; null has never been seen, so what it
 * means is an assumption either way. Reading it as "empty before" would make every card in `value` an
 * add, which is the whole-cell push G1 forbids (up to MAX_LINKS_PER_EDIT stale links re-asserted). Read
 * as "cannot tell", the worst case is one refused, visibly snapped-back first link on a never-set cell,
 * logged (action=relation-before-unknown) so the live shape can settle it. The unlink side keeps reading
 * null as empty: there it can only mean "removed nothing", the safe direction.
 */
export function linkedCardIds(ev: any): string[] | null {
  if (!ev || typeof ev !== "object" || !("previousValue" in ev)) return null;
  if (ev.previousValue === null || ev.previousValue === "null") return null;
  const before = linkedIds(ev.previousValue);
  const after = linkedIds(ev.value);
  if (!before || !after) return null;
  return [...after].filter(id => !before.has(id));
}

/** Both sides of one relation event, or null when it carried no usable before-value. */
function relationDiff(ev: any): RelationDiff | null {
  const added = linkedCardIds(ev);
  return added === null ? null : { added, removed: unlinkedCardIds(ev) };
}

/**
 * A person's relation diff with the PAIRED ECHO taken out: a card whose change on its own cell already
 * arrived for this same person is that click's other half, owned by the first event (see isPairedEcho
 * in relation-edit.ts). Dropped here, before anything is recorded, so the paired side never reaches the
 * reverse pass for that card -- not to push, not to claim, not to snap back.
 */
function withoutPairedEchoes(diff: RelationDiff | null, itemId: string, actor: string): RelationDiff | null {
  if (!diff) return null;
  const keep = (op: "link" | "unlink", cards: string[]) => cards.filter(c => {
    if (!isPairedEcho(op, itemId, c, actor)) return true;
    console.log(`[webhook] source=monday item=${itemId} card=${c} op=${op} user=${actor}`
      + ` action=paired-echo-dropped reason="the same click already arrived on the paired card, which owns it"`);
    return false;
  });
  return { added: keep("link", diff.added), removed: keep("unlink", diff.removed) };
}

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
  /**
   * TWO KEYS MAY BE LIVE AT ONCE. monday never returns a webhook's URL and Cloudflare never returns a
   * secret, so once the first key's value was not kept anywhere, registering hooks on another board
   * would have meant rotating it -- and re-creating every working hook on every board in the same
   * breath. MONDAY_WEBHOOK_KEY_2 lets new hooks (Deals, Products & Services, 2026-09-24) carry their
   * own key while the existing ones keep theirs. Either matches; each is compared in constant time.
   */
  const keys = [env.MONDAY_WEBHOOK_KEY, env.MONDAY_WEBHOOK_KEY_2].map(k => (k ?? "").trim()).filter(Boolean);
  if (!keys.length) return { ok: true, reason: "unconfigured" };   // WM path — byte-for-byte unchanged
  const m = url.pathname.match(/^\/webhooks\/monday\/([^/]+)\/?$/);
  const presented = m ? decodeURIComponent(m[1]) : (url.searchParams.get("k") ?? "");
  return keys.some(k => safeEq(presented, k))
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
  // THE PERSON DOORBELL (ringOnPersonEdit): detached, and IN ADDITION to whatever the event itself does.
  // CRM Contacts only -- no Work Management board has a timeline this Worker pushes -- and never for a
  // wake-up column, whose own branch below already reads the timeline.
  if (spec.boardId === CRM_CONTACTS.boardId && !ACTIVITY_WAKE_COLS.has(columnId) && !isDeletionEvent(type)
      && activitySyncEnabled(env))
    ectx.waitUntil(ringOnPersonEdit(env, itemId, String(ev.userId ?? ""), spec, ev)
      .catch(e => console.log(`[activity] source=monday item=${itemId} action=error reason="${String(e).slice(0, 140)}"`)));
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
    // Work-Management follow-up boards, which run this same code with ENABLE_CRM unset, and a rep's
    // deliberate deletion would silently reappear on a business-critical board. Previously such an
    // event fell through to syncMondayItem and was a safe no-op ("item not found (deleted)"); that
    // safety has to be preserved explicitly now.
    //
    // `restoreOnDelete` is the ONLY thing carrying that guarantee, and as of 2026-09-22 it is the only
    // thing that CAN. This comment used to add "and besides, WM specs declare no ownership, so
    // mayCreateCrmCard is a pass-through there" — true then, false now that WM declares ownership to
    // refuse crm-stamped records. The belt survived; the braces were an accident of configuration.
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
  // columns that branch drops (it is one-way). It is a DOORBELL, never data: the date is not read as the
  // activity and never decides qualification. The Worker reads that one contact's timeline and the
  // durable registry decides what is new, so repeated wake-ups cost one read and create nothing twice.
  //
  // WHOEVER RANG. No actor check, unlike the person doorbell: the bell is written by a monday
  // automation (user -4, or the automation's owner) and never by the Worker. Our own Last Activity Date
  // writes still ring, harmlessly. The marketing poller's entries ring the bell too whenever its filter
  // admits them (an "Any activity" bell fires on every E&A entry) and cannot loop: they are custom-type
  // entries, which eligibleForHubspot refuses before anything is written.
  //
  // LATEST WINS (coalesceLatest), not first: a ring means a NEW entry exists. Handed the in-flight read
  // instead, a second note logged while the first was being pushed would never be read -- that read had
  // already happened. Any number of rings during a read collapse into one trailing re-read.
  //
  // Repeat activity on the same day: PROVEN FOR THE LEGACY RECIPES ONLY. monday emitted
  // update_column_value for an UNCHANGED value there -- "2026-09-16 -> 2026-09-16" events on one card,
  // and '2026-09-30' -> '2026-09-30' by -4 / 104231431 on date_mm7054jz -- so the 2nd and 3rd note of a
  // day rang. For the workflow's "Set date" on the bell it is UNVERIFIED (no bell stamp was logged in
  // its first hours): canary two Notes and a Call on one card on one day before relying on it.
  if (ACTIVITY_WAKE_COLS.has(columnId) && spec.boardId === CRM_CONTACTS.boardId) {
    if (!activitySyncEnabled(env)) {
      console.log(`[webhook] source=monday item=${itemId} col=${columnId} action=ignored reason="ENABLE_ACTIVITY_SYNC is off"`);
      return new Response("ok");
    }
    console.log(`[webhook] source=monday item=${itemId} col=${columnId} user=${ev.userId ?? ""} action=activity-wake`);
    ectx.waitUntil(coalesceLatest(`tl-bell:${itemId}`, () => syncMondayTimeline(env, itemId), { rerunAfterError: true })
      .catch(e => console.log(`[activity] source=monday item=${itemId} action=error reason="${String(e).slice(0, 140)}"`)));
    return new Response("ok");
  }

  // LOOP GUARD: value columns still flow through (value-diff no-ops an echo), but bookkeeping and
  // one-way columns are dropped outright -- the native coarse Stage too, unless STAGE_COARSE_REVERSE is on.
  const stageCols = coarseStageCols(env, spec);
  if (columnId && ignoredColumns(spec).has(columnId) && columnId !== stageCols?.coarse) {
    console.log(`[webhook] source=monday item=${itemId} type=${type} col=${columnId} action=ignored reason="bookkeeping/one-way column"`);
    return new Response("ok");
  }

  // ASK_ADA_UI_EDITS (flag on only): see routeAskAdaAware. With the flag off, every event is routed
  // inline, exactly as before.
  if (askAdaUiEditsOn(env)) {
    await routeAskAdaAware(env, ectx, spec, ev, stageCols);
    return new Response("ok");
  }
  await routeMondayEdit(env, ectx, spec, ev, stageCols);
  return new Response("ok"); // respond fast so monday doesn't retry
}

/**
 * ASK_ADA_UI_EDITS (flag on only): how an event is routed when an event of our own token user may have to
 * be classified by reading monday's activity log (ui-actor.ts) -- ~6 s, at worst ~18.5 s. Two rules,
 * both from the 2026-10-01 review:
 *
 * 1. CLASSIFIED BEFORE IT JOINS ANY QUEUE. The lookup starts the moment the event arrives, and the route
 *    (routeMondayEdit: record, then join the md:* queue) runs only once the verdict is cached. The
 *    self-origin gate in runSync then reads that cached answer at once. It used to perform the lookup
 *    INSIDE the md:<item>:<col> queue, so each echo of ours on a two-way column held that cell's queue for
 *    the settle wait. coalesceLatest re-runs the FIRST event's closure, so a real person's edit of the
 *    same cell arriving meanwhile was folded into the echo's self-origin run and never pushed, with nothing
 *    logged as lost. With the lookup out of the queue, the queue is held no longer than with the flag
 *    off: for the sync alone.
 *
 * 2. RECORDED IN ARRIVAL ORDER, on the cells whose pending edits are COMPOSED: a relation cell
 *    (recordRelationEvent: add-then-remove cancels out, in arrival order) and a card's two stage
 *    columns (pendingStageCols: one shared queue, and the edit that comes last is the one sent last).
 *    An event on such a cell is routed only after every earlier event on that cell has been routed (an
 *    arrival-order barrier). Otherwise an ask ada add recorded ~6 s late would be composed AFTER a
 *    colleague's later removal of the same card, pushed last, and the link would be re-created. The
 *    barrier chains only the classify-record-enqueue step, never the sync, and each event's lookup still
 *    starts at once, so a chain of lookups costs the slowest one, not their sum.
 *    NOT for any other column. There the md:<item>:<col> queue is shared by every actor, so waiting
 *    behind our echo would fold the person's edit into the echo's run all over again (rule 1). Nor is
 *    it needed there: such a run re-reads the card, and a People column's removed ids are a union.
 *
 * monday gets its 200 at once whenever the route must wait, for a lookup or behind an earlier event. Any
 * other event (a real person's, an automation's, or ours on a column that is never looked up) on a cell
 * with nothing pending is routed inline, as before.
 * Per isolate, like every queue here (see relation-edit.ts, WHAT THIS DOES NOT GUARANTEE).
 */
async function routeAskAdaAware(env: Env, ectx: ExecutionContext, spec: ObjectSpec, ev: any,
    stageCols: { coarse: string; exact?: string } | null): Promise<void> {
  const itemId = String(ev.pulseId ?? ev.itemId ?? "");
  const columnId = ev.columnId ? String(ev.columnId) : "";
  // Everything up to inArrivalOrder below runs synchronously, so the event takes its place in its cell's
  // order in the order the requests arrived.
  const dueP = uiLookupDue(env, spec, ev);
  // The lookup starts NOW, whether or not the route has to wait its turn. It is cached per event, so the
  // route's own classification, the actor label, the doorbell and the self-origin gate all reuse it.
  const classified = dueP.then(due => (due ? isOwnEcho(env, spec, ev) : false));
  const held: Promise<unknown>[] = [];
  const hold = { waitUntil: (p: Promise<unknown>) => { held.push(p); } } as unknown as ExecutionContext;
  const route = () => classified.then(() => routeMondayEdit(env, hold, spec, ev, stageCols));
  const gate = arrivalGateKey(spec, itemId, columnId, stageCols);
  const r = gate ? inArrivalOrder(gate, route) : { waited: false, done: route() };
  const onError = (e: unknown) =>
    console.log(`[webhook] source=monday item=${itemId} action=error reason="${String(e).slice(0, 160)}"`);
  if (r.waited) console.log(`[webhook] source=monday item=${itemId} col=${columnId} user=${String(ev.userId ?? "")}`
    + ` action=arrival-order-wait reason="an earlier event on this cell is not recorded yet (its actor may still`
    + ` be being read from monday's log); this one is recorded after it, in arrival order"`);
  if (r.waited || await dueP) {
    ectx.waitUntil(r.done.then(() => Promise.allSettled(held)).catch(onError));
    return;
  }
  try { await r.done; } finally { ectx.waitUntil(Promise.allSettled(held)); }
}

/**
 * The cell whose pending edits are composed in arrival order (routeAskAdaAware, rule 2), or null. A card's
 * two stage columns form ONE cell, because they share one queue (pendingStageCols).
 */
function arrivalGateKey(spec: ObjectSpec, itemId: string, columnId: string,
    stageCols: { coarse: string; exact?: string } | null): string | null {
  if (!columnId || !itemId || !spec.columnLevelReverse) return null;
  if (stageCols && (columnId === stageCols.coarse || columnId === stageCols.exact)) return `stage:${itemId}`;
  if ((spec.associations ?? []).some(a => a.relationCol === columnId)) return `rel:${itemId}:${columnId}`;
  return null;
}

/**
 * Per cell, the last step queued on it, already settled-to-void so a failed step never blocks the next one.
 * Only the routing of an event is chained here, never the sync it schedules. Entries delete themselves.
 */
const arrivalTails = new Map<string, Promise<void>>();
function inArrivalOrder(key: string, step: () => Promise<void>): { waited: boolean; done: Promise<void> } {
  const prev = arrivalTails.get(key);
  const done = prev ? prev.then(step) : step();
  const tail = done.then(() => undefined, () => undefined);
  arrivalTails.set(key, tail);
  void tail.then(() => { if (arrivalTails.get(key) === tail) arrivalTails.delete(key); });
  return { waited: !!prev, done };
}

/**
 * The rest of a monday column / name / create event, after the branches that answer on their own: who
 * made it, which queue it joins, and the scheduled sync. Split out of handleMonday only so that
 * handleMonday can run it inline (every event, as always) or, with ASK_ADA_UI_EDITS on, through
 * routeAskAdaAware: after the event's activity-log verdict is cached, and in arrival order per relation
 * / stage cell. Either way, nothing below waits on the log. The actor is resolved by ONE classifier,
 * ui-actor.ts: classifyMondayActor for a class, isOwnEcho for the self-origin answer -- with the flag off
 * both are, call for call, the isAutomationActor/isIntegrationActor tests this code used to inline.
 */
async function routeMondayEdit(env: Env, ectx: ExecutionContext, spec: ObjectSpec, ev: any,
    stageCols: { coarse: string; exact?: string } | null): Promise<void> {
  const boardId = String(ev.boardId ?? "");
  const itemId = String(ev.pulseId ?? ev.itemId ?? "");
  const type = String(ev.type ?? "");
  const columnId = ev.columnId ? String(ev.columnId) : "";
  const actorId = String(ev.userId ?? "");
  /**
   * STAGE_COARSE_REVERSE (flag on only). WHO edited a stage column decides everything, so it is resolved
   * before the event is scheduled, like a relation edit's class:
   *   - the coarse Stage: only a PERSON's edit goes on. An automation's never pushes -- 31010016 sets
   *     Stage = New on every new card, including the ones this Worker makes from HubSpot deals, and sent
   *     on it would reset real HubSpot stages -- and our own token's writes are echoes. Both are dropped
   *     here, which is exactly what happens to every edit of this column with the flag off. An event with
   *     no attribution counts as ours (isIntegrationActor fails closed).
   *   - a person's edit of either stage column joins ONE queue per card, so the two are never sent by
   *     two runs racing each other, and a run that carries both resolves them as one change, in which the
   *     exact stage wins. Anyone else's edit of the exact column keeps its own queue, as before.
   * A person working AS our token user (ASK_ADA_UI_EDITS, proven from monday's log) is a person here.
   */
  let stageShared = false;
  if (stageCols && columnId && (columnId === stageCols.coarse || columnId === stageCols.exact)) {
    const cls: ActorClass = await classifyMondayActor(env, spec, ev);
    if (columnId === stageCols.coarse && cls !== "person") {
      console.log(`[webhook] source=monday item=${itemId} type=${type} col=${columnId} user=${actorId}`
        + ` action=ignored reason="the coarse Stage, edited by ${cls === "automation" ? "an automation" : "our own token"}:`
        + ` only a person's edit of it is sent"`);
      // Dropped here, before any claim, so a create window could not see it: NOTED for the row, so that a
      // person's queued edit of this column is not replayed carrying 31010016's New (or our echo) as theirs.
      // A no-op for a row with no window open. CREATE_WINDOW_REPLAY only: the same literal "true" test as
      // sync.ts createWindowReplayOn, repeated rather than imported (as associations.ts repeats
      // birthLinksOn's) so the webhook needs nothing more from sync.ts than the syncs it schedules.
      if (spec.columnLevelReverse && env.CREATE_WINDOW_REPLAY === "true" && spec.createFromMonday)
        ectx.waitUntil(noteCreateWindowEdit(env, boardId, itemId,
          { cols: [columnId], actorClass: cls, ...(actorId ? { actor: actorId } : {}), at: Date.now() }));
      return;
    }
    if (cls === "person") {
      stageShared = true;
      const s = pendingStageCols.get(itemId) ?? new Set<string>();
      s.add(columnId);
      pendingStageCols.set(itemId, s);
    }
  }
  console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type}${columnId ? ` col=${columnId}` : ""} user=${actorId} action=received`);
  // WHO made this edit. Every write WE make is attributed to the integration's own token user, so without
  // this a log cannot tell a rep's edit from the sync's echo — the ambiguity behind the 2026-08-28
  // owner-reassignment question. Resolved inside waitUntil (cached) to keep the webhook response fast.
  // A person working as our token user, proven from monday's log, reads who="ask ada (UI)".
  ectx.waitUntil(mondayActorLabel(env, spec, ev).then(a =>
    console.log(`[actor] source=monday board=${boardId} item=${itemId}${columnId ? ` col=${columnId}` : ""} ${a}`)).catch(() => {}));
  const budget: Budget = { left: 30 };
  // PROVENANCE. Resolved BEFORE the sync, not alongside it in waitUntil, because every monday->HubSpot
  // mutation depends on the answer: an event our own token caused is an echo and carries no user
  // intent. 1,207 HubSpot Companies were created from such echoes during the historical import. Only
  // CRM specs are gated — the live Work-Management boards keep their existing behaviour exactly.
  // coalesce by item id so rapid edits (or our own write-back echoes) can't race into a duplicate.
  // WHAT the person changed, for a column-level spec. A name event carries no columnId; a column event
  // carries exactly one. Anything else (a move, a create) names no column and so pushes nothing.
  const isNameEvent = type === "update_name" || type === "change_name";
  const isRelationCol = !!columnId && (spec.associations ?? []).some(a => a.relationCol === columnId);
  // RELATION EDITS are recorded per item + column + ACTOR CLASS and drained by the run that consumes
  // them, exactly like the removed people below -- and for the same reason: coalesceLatest keeps the
  // FIRST event's closure for its re-runs, so what the later events added or removed would otherwise be
  // lost. Every person shares the "person" queue, so one rep's late add cannot overtake another rep's
  // removal; our own token's echoes (which remove the very card a person just added, whenever a forward
  // pass lands in between) have their own, so they can never cancel a person's edit. The class needs
  // the provenance answer BEFORE recording, hence the await here (cached per isolate after the first
  // call); only column-level relation events pay it. See relation-edit.ts. Our token user's UI click
  // (ASK_ADA_UI_EDITS) joins the "person" queue; the reciprocal half monday writes on the other card has
  // no UUID in the log and stays ours, so the click is pushed once, from the card it was made on.
  const relClass: ActorClass | null = spec.columnLevelReverse && isRelationCol
    ? await classifyMondayActor(env, spec, ev)
    : null;
  const relKey = relClass ? relationEditKey(itemId, columnId, relClass) : "";
  if (relClass) {
    const diff = relationDiff(ev);
    if (!diff) console.log(`[webhook] source=monday item=${itemId} col=${columnId} user=${actorId}`
      + ` prev=${"previousValue" in ev ? JSON.stringify(ev.previousValue).slice(0, 60) : "absent"}`
      + ` action=relation-before-unknown reason="no usable before-value: nothing will be pushed, the cell snaps back"`);
    // Only a person's diff is checked for a paired echo: our own and automations' runs push nothing.
    recordRelationEvent(relKey, relClass === "person" ? withoutPairedEchoes(diff, itemId, actorId) : diff);
  }
  const isPeopleCol = !!columnId && spec.fields.some(f => f.col === columnId && f.type === "people");
  const peopleKey = `md:${itemId}:${columnId}`;
  if (spec.columnLevelReverse && isPeopleCol) {
    const r = removedPersonIds(ev);
    const acc = pendingRemovedPeople.get(peopleKey) ?? { ids: new Set<string>(), known: true };
    if (r === null) acc.known = false; else for (const id of r) acc.ids.add(id);
    pendingRemovedPeople.set(peopleKey, acc);
  }
  const byAutomation = isAutomationActor(String(ev.userId ?? ""));
  const base: MondayEdit | undefined = spec.columnLevelReverse
    ? (isNameEvent ? { cols: [], name: true } : columnId ? { cols: [columnId] } : undefined)
    : undefined;
  const edit: MondayEdit | undefined = base && byAutomation ? { ...base, byAutomation: true } : base;
  const runSync = async () => {
    // Drained FIRST, before any await, so this run owns exactly the relation edits that arrived before
    // it started; anything later lands in the pending set for the trailing re-run.
    const rel = edit && isRelationCol ? drainRelationEvents(relKey) : null;
    const stageDrained = stageShared ? drainStageCols(itemId) : [];
    // isOwnEcho = isIntegrationActor, unless ASK_ADA_UI_EDITS proves a UI action. With the flag on, the
    // verdict was cached BEFORE this run joined its queue (routeAskAdaAware), so this never waits on the
    // log here: a lookup held inside the queue swallowed a real person's edit into our echo's run.
    const selfOrigin = !!spec.suppressSelfOriginWrites && await isOwnEcho(env, spec, ev);
    if (selfOrigin) console.log(`[webhook] source=monday item=${itemId}`
      + ` action=self-origin reason="caused by our own token — HubSpot writes suppressed"`);
    // A stage run sends every stage column a person edited since the last one drained (see pendingStageCols).
    let runEdit = edit && stageDrained.length ? { ...edit, cols: stageDrained } : edit;
    if (edit && rel && columnId) {
      // `linked` is left OUT when any event lacked its before-side: "cannot tell" refuses the push and
      // snaps the cell back, where [] would have meant "added nothing".
      runEdit = { ...edit, actor: actorId, unlinked: { [columnId]: rel.removed },
        largestEvent: { [columnId]: { added: rel.largestAdd, removed: rel.largestRemove } },
        ...(rel.known ? { linked: { [columnId]: rel.added } } : {}) };
    }
    if (edit && isPeopleCol && columnId) {
      const acc = pendingRemovedPeople.get(peopleKey);
      pendingRemovedPeople.delete(peopleKey);
      // Nothing pending = nobody removed since the last run drained it (a coalesced re-run), which is
      // KNOWN, not unknown. Only an event without its before-side makes the run fall back.
      if (!acc || acc.known) runEdit = { ...edit, removedPeople: { [columnId]: [...(acc?.ids ?? [])] } };
    }
    // The actor rides separately from `edit` because an item-created event names no column and so has
    // no edit at all: without it, an automation that makes a row would read as a person making it, and
    // the new record's birth pass would push whatever its relation cells hold. See syncMondayItem.
    return syncMondayItem(env, boardId, itemId, webhookOpts(env), budget, false, selfOrigin, runEdit,
      { id: actorId, byAutomation });
  };
  const onError = (e: unknown) =>
    console.log(`[webhook] source=monday item=${itemId} action=error reason="${String(e).slice(0, 160)}"`);
  // Column-level: one queue per item+column, latest value wins. Two DIFFERENT columns edited together
  // each get their own push; the same column edited twice sends what is on screen at the end. The
  // record-level engine keeps its per-item coalesce exactly.
  //
  // A RELATION edit is serialised per item + column + ACTOR CLASS (G3). Unlinks used to run uncoalesced,
  // because a trailing re-run reused the first event's edit and would have dropped a second unlink; now
  // every run drains the edits recorded since the last one, so serialising is safe -- and it is what
  // stops a late add from overtaking a removal of the same card (per isolate: see relation-edit.ts).
  //
  // A person's STAGE edits (STAGE_COARSE_REVERSE on) share one queue per card: see pendingStageCols. A
  // queue whose run threw loses what arrived meanwhile, as every md:* queue does (stop-on-throw), and its
  // stage entries go with it -- otherwise they would ride along with the next, unrelated stage edit.
  if (spec.columnLevelReverse && edit)
    ectx.waitUntil(coalesceLatest(`md:${itemId}:${stageShared ? "~stage" : edit.name ? "~name" : edit.cols[0]}`
      + (relClass ? `:${relClass}` : ""), runSync)
      .catch(e => { if (stageShared) pendingStageCols.delete(itemId); onError(e); }));
  else
    ectx.waitUntil(coalesce(`md:${itemId}`, runSync).catch(onError));
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

/**
 * `line_item` is a DISPATCH type, not a payload type. It is deliberately absent from OBJ_BY_TYPEID
 * below, so extractObjectEvents can never manufacture one from a 0-8 payload — line-item payloads keep
 * going through extractLineItemIds, and the Work-Management fan-out to parent deals is untouched. The
 * only way a line_item event enters the queue is an explicit push in handleHubspot.
 */
export type HsObjType = "deal" | "contact" | "company" | "line_item";
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
 * DEALS WHOSE ASSOCIATIONS CHANGED — the only signal that a line item's Account has gone stale.
 *
 * A Products & Services card gets its Account by derivation: line_item -> deal -> company. So the fact
 * that invalidates it happens on the DEAL, and leaves no trace on the line item at all — re-pointing a
 * deal from Acme to Globex does not touch any line item's `hs_lastmodifieddate`. Without this the
 * derived link would be written once and then be wrong forever, which is worse than never writing it:
 * a stale Account reads as authoritative.
 *
 * Separate from extractObjectEvents deliberately. That function collapses every subscription type into
 * {type, id}, so the association-change fact is not recoverable from its output, and widening its shape
 * would touch the live Work-Management path for no reason.
 */
export function extractDealAssocChangeIds(body: any): string[] {
  const arr = Array.isArray(body) ? body : [body];
  const out = new Set<string>();
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const sub = String(e.subscriptionType ?? e.eventType ?? "");
    if (sub.split(".").pop() !== "associationChange") continue;
    // An associationChange names the changed record in from*, not in objectId — the same asymmetry
    // extractObjectEvents documents at its `fromObjectId` line.
    const typeId = String(e.fromObjectTypeId ?? e.objectTypeId ?? "");
    const name = String(e.objectType ?? "").toLowerCase();
    if (typeId !== "0-3" && name !== "deal" && !sub.startsWith("deal")) continue;
    let raw = e.fromObjectId ?? e.objectId ?? e.dealId;
    if (raw && typeof raw === "object") raw = raw.value;
    if (raw != null && /^\d+$/.test(String(raw))) out.add(String(raw));
  }
  return [...out];
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
    /**
     * An associationChange names BOTH ends (fromObjectTypeId/fromObjectId, toObjectTypeId/toObjectId),
     * not objectTypeId/objectId -- the same shape extractObjectEvents reads. The activity may be either
     * end, so both are looked at; reading only the flat fields dropped every real association event.
     */
    const ends: [unknown, unknown, unknown][] = [[e.objectTypeId, e.objectType, e.objectId ?? e.hs_object_id ?? e.id]];
    if (sub.endsWith("associationChange"))
      ends.push([e.fromObjectTypeId, undefined, e.fromObjectId], [e.toObjectTypeId, undefined, e.toObjectId]);
    for (const [typeId, typeName, raw] of ends) {
      const object = ACTIVITY_BY_TYPEID[String(typeId ?? "")] ?? ACTIVITY_BY_NAME[String(typeName ?? "").toLowerCase()];
      if (!object) continue;
      if (raw != null && /^\d+$/.test(String(raw))) out.set(`${object}:${raw}`, { object, id: String(raw) });
    }
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
/** The line items a batch reports DELETED (object.deletion on 0-8). On CRM each has its own P&S card,
 *  which must be removed -- dispatching the id as an ordinary sync only logged "record not found". */
export function extractDeletedLineItemIds(body: any): string[] {
  const arr = Array.isArray(body) ? body : [body];
  const out = new Set<string>();
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const sub = String(e.subscriptionType ?? e.eventType ?? "");
    if (String(e.objectTypeId ?? "") !== "0-8" && !sub.startsWith("line_item")) continue;
    if (!sub.endsWith("deletion")) continue;
    const raw = e.objectId ?? e.hs_object_id ?? e.id;
    if (raw != null && /^\d+$/.test(String(raw))) out.add(String(raw));
  }
  return [...out];
}

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

/**
 * Hand one HubSpot activity to its Durable Object, which delivers it outside this invocation's
 * ~30-second waitUntil window -- see DELIVER_SCHEDULE_MS for the duplicates that window produced.
 *
 * FALLBACK: when the job cannot be recorded (the namespace is unbound or unreachable), deliver inline
 * exactly as before. The outcome then decides whether a DURABLE retry is needed: nothing would ever
 * redeliver this webhook, because waitUntil already answered 200.
 */
async function deliverActivity(env: Env, object: string, id: string): Promise<void> {
  if (await scheduleDelivery(env, object, id)) return;
  try {
    const outcome = await syncHubspotActivity(env, object, id);
    await scheduleIfUnresolved(env, object, id, outcome);
    // And look again shortly: the associations may not have existed when this fired.
    if (outcome === "created" || outcome === "skipped") await scheduleReconcile(env, object, id);
  } catch (e) {
    console.log(`[activity] source=hubspot ${object}=${id} action=error reason="${String(e).slice(0, 140)}"`);
  }
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
        ectx.waitUntil(deliverActivity(env, a.object, a.id));
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
    /**
     * A LINE ITEM IS A RECORD HERE, NOT JUST A REASON TO REBUILD A DEAL.
     *
     * On Work Management a line item exists only as a SUBITEM of its deal, so re-syncing the parent
     * deal is the whole job. On CRM it has its own card on Products & Services (board 5028000489) with
     * its own Deal Owner, prices and derived Account — none of which a deal sync writes. Converting the
     * event into a deal event and stopping there is why every one of the 9,970 P&S cards has an empty
     * Deal Owner column despite the mapping being correct since 2026-09-14.
     *
     * Each deployment gets the fan-out that matches its data model, and neither gets the other's.
     */
    const lineItemSpec = specByObject(env, "line_items");
    // CRM: every line item becomes an event -- it costs no subrequest -- so the overflow spill below sees
    // all of them. Slicing first (as the WM branch must, since it reads associations per item) dropped
    // everything past the 15th without a log line.
    if (lineItemSpec) {
      const deletedLi = new Set(extractDeletedLineItemIds(body));
      for (const liId of liIds) events.push({ type: "line_item", id: liId, ...(deletedLi.has(liId) ? { deleted: true } : {}) });
    }
    for (const liId of lineItemSpec ? [] : liIds.slice(0, MAX)) {
      try {
        for (const d of await getAssociatedIds(env, "line_items", liId, "deals")) events.push({ type: "deal", id: d });
      } catch (e) { console.log(`[webhook] source=hubspot line_item=${liId} action=error reason="${String(e).slice(0, 120)}"`); }
    }

    /**
     * A DEAL CHANGING COMPANY INVALIDATES ITS LINE ITEMS' ACCOUNTS.
     *
     * The derived link points the other way to the event that breaks it: the company lives on the deal,
     * the link lives on the line item, and nothing about the line item changes when the deal is
     * re-pointed. So the deal event has to carry the invalidation across.
     *
     * CRM only, and bounded: a deal carries at most 12 line items in this portal, and the slice keeps a
     * pathological one from consuming the whole batch. A read failure logs and drops rather than
     * throwing — a missed refresh is a stale cell the next event repairs, while a throw here would take
     * down the contact and company events sharing this batch.
     */
    if (lineItemSpec) {
      for (const dealId of extractDealAssocChangeIds(body).slice(0, MAX)) {
        try {
          for (const li of await getAssociatedIds(env, "deals", dealId, "line_items"))
            events.push({ type: "line_item", id: li });
        } catch (e) {
          console.log(`[webhook] source=hubspot deal=${dealId} action=error`
            + ` reason="line-item invalidation failed: ${String(e).slice(0, 100)}"`);
        }
      }
    }
    /**
     * THE OVERFLOW GOES SOMEWHERE NOW.
     *
     * This used to log "backup catches overflow" and drop the remainder. That sentence is true on the
     * Work Management Worker, which runs a ten-minute incremental cron; it was never true here, which
     * has no SYNC crons: the CRM Worker's only cron is the 15-minute one, which dispatches the marketing poller and
     * the bounded Last Activity sweep (lad-sweep.ts, off unless ENABLE_LAD_SWEEP) -- nothing that revisits an
     * arbitrary dropped record (deploy-config.test.ts pins it). With HubSpot delivering ~47
     * contact events per batch during a bulk update, roughly two thirds of each batch was discarded
     * behind a reassuring log line — and a dropped change is invisible, because the card simply keeps
     * its old values.
     *
     * Deals and line items spill too, since 2026-09-23: the CRM app's deal and line-item subscriptions
     * make a bulk deal edit deliver exactly this kind of batch, and with no CRM cron an overflowing deal
     * was dropped the same way contacts once were. The spill is still a no-op on the Work Management
     * deployment, which has no such binding and whose cron already covers this ground.
     */
    if (events.length > MAX) {
      const overflow = events.slice(MAX);
      const spill: DeferredItem[] = overflow
        .filter(e => e.type === "contact" || e.type === "company" || e.type === "deal" || e.type === "line_item")
        .map(e => ({ type: e.type as DeferredItem["type"], id: e.id, deleted: e.deleted }));
      console.log(`[webhook] source=hubspot action=deferred count=${overflow.length}`
        + ` spilling=${spill.length} reason="batch > ${MAX}; ${env.DEFERRED_SYNC
          ? "overflow queued durably" : "no queue on this deployment; the incremental cron covers it"}"`);
      await spillDeferred(env, spill);
    }
    /**
     * ONE RUN AT A TIME PER RECORD -- and on CRM, THE LATEST EVENT WINS.
     *
     * Every activity logged in HubSpot produces an association event and, 2-12 s later, a
     * notes_last_updated propertyChange for the same record. With `coalesce` (first wins) the second
     * event was handed the first one's in-flight sync, which had already read the record -- so the new
     * date was never written. Measured 2026-09-30: Last Activity Date delivered on 77% of Contacts, 67%
     * of Accounts, 4 of 5 Deals. `coalesceLatest` still runs one sync at a time per record (so a burst
     * for a brand-new record cannot race into a duplicate card: the trailing run finds the card the
     * first one made), then ONE trailing re-run that re-reads HubSpot.
     *
     * Deletes keep `coalesce`: a second delete has nothing newer to read. The Work Management Worker
     * keeps `coalesce` for everything -- its behaviour is not this change's to alter.
     */
    const latestWins = env.ENABLE_CRM === "true";
    await Promise.all(events.slice(0, MAX).map(ev => {
      const key = `hs:${ev.type}:${ev.id}:${ev.deleted ? "d" : "u"}`;
      const run = () => ev.deleted ? deleteHubspotObject(env, ev.type, ev.id, opts, budget)
                                   : syncHubspotObject(env, ev.type, ev.id, opts, budget);
      return (!ev.deleted && latestWins ? coalesceLatest(key, run, { rerunAfterError: true }) : coalesce(key, run))
        .catch(e => console.log(`[webhook] source=hubspot ${ev.type}=${ev.id} action=error reason="${String(e).slice(0, 160)}"`));
    }));
  })());
  return new Response("ok"); // respond fast so HubSpot doesn't retry
}
