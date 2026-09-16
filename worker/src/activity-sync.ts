/**
 * ACTIVITY SYNC I/O — the two directions, behind ENABLE_ACTIVITY_SYNC.
 *
 * DELIBERATELY ISOLATED FROM THE OBJECT SYNC. Nothing here calls buildCtx, loads a label dictionary,
 * or touches an ObjectSpec's field mapping. On 2026-09-15 a 403 raised while buildCtx assembled
 * dictionaries escaped the webhook handler and stopped live Contacts and Companies sync for an hour;
 * activity events now arrive on that same endpoint, so they must not be able to re-enter that path.
 * Everything below needs only an id, a card lookup and a write.
 *
 * Both directions are wrapped so a failure is logged and swallowed: an activity that fails to sync is
 * a missing line in a timeline, while an exception escaping the handler is an outage for objects that
 * have nothing to do with activities. That asymmetry is the whole reason this file is separate.
 */
import type { Env } from "./types";
import { hs } from "./hubspot";
import { gql, findItemByColumn } from "./monday";
import { CRM_CONTACTS } from "./config/crm";
import {
  MONDAY_ACTIVITY_TYPE, HUBSPOT_OBJECT_FOR_NATIVE, CONTACT_ASSOC_TYPE,
  eligibleForHubspot, qualifiesAsFollowUp, timelinePayload, type HsActivity,
} from "./activities";
import {
  claimActivityToHubspot, settleActivityToHubspot, unresolvedActivityToHubspot,
  claimActivityToMonday, settleActivityToMonday, unresolvedActivityToMonday,
  claimHubspotAsRepresented, releaseActivity, h2mReservationKey,
} from "./activity-registry";

/** HubSpot activity objectTypeId -> object name. Routed explicitly, never inferred. */
export const ACTIVITY_BY_TYPEID: Record<string, string> = {
  "0-49": "emails", "0-48": "calls", "0-46": "notes", "0-47": "meetings",
};
export const ACTIVITY_BY_NAME: Record<string, string> = {
  email: "emails", call: "calls", note: "notes", meeting_event: "meetings",
};

/** The monday Contacts columns this file touches. Last Activity Date is READ-ONLY here: it is the
 *  wake-up signal and the existing workflows' bookkeeping field, and widening its meaning would
 *  silently change when reminders stop. */
const QUALIFYING_COL = "date_mm78yd2c";   // Last qualifying follow-up date
const OWNER_ASSIGNED_COL = "date_mm70pa4c";
const OWNER_COL = "multiple_person_mm6zap53";

export const activitySyncEnabled = (env: Env) => env.ENABLE_ACTIVITY_SYNC === "true";

/**
 * CUTOVER-FORWARD ONLY. Nothing whose ORIGINAL timestamp predates this is ever synced, in either
 * direction.
 *
 * It matters most on the monday side. The first Last Activity Date wake-up on a real contact reads a
 * timeline that may hold years of native notes and calls, none of which has a durable mapping yet —
 * so without this, "what is new?" answers "all of it" and the contact's entire history is pushed into
 * HubSpot as fresh activity. That is precisely the historical backfill we agreed not to do, arriving
 * by accident rather than by decision.
 *
 * Absent or unparseable means INFINITY: nothing qualifies, the feature is inert. Failing closed is
 * right for a value whose job is to stop a bulk write.
 */
export function activityCutoverMs(env: Env): number {
  const ms = Date.parse(String(env.ACTIVITY_CUTOVER_AT ?? ""));
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function afterCutover(env: Env, timestamp: unknown): boolean {
  const t = Date.parse(String(timestamp ?? ""));
  return Number.isFinite(t) && t >= activityCutoverMs(env);
}

/**
 * CANARY SCOPE. While set, only this contact is processed — the feature flag alone is global, so
 * turning it on for "a canary" would in fact start syncing every contact in the portal. Unset for the
 * production cutover.
 */
export function inCanaryScope(env: Env, hubspotContactId?: string, mondayItemId?: string): boolean {
  const c = String(env.ACTIVITY_CANARY_HUBSPOT_CONTACT_ID ?? "").trim();
  const m = String(env.ACTIVITY_CANARY_MONDAY_ITEM_ID ?? "").trim();
  if (!c && !m) return true;                                  // no allowlist: full scope
  if (c && hubspotContactId && String(hubspotContactId) === c) return true;
  if (m && mondayItemId && String(mondayItemId) === m) return true;
  return false;
}

const PROPS: Record<string, string[]> = {
  emails: ["hs_timestamp", "hs_email_subject", "hs_email_direction", "hs_email_status",
    "hs_email_from_email", "hs_email_to_email", "hubspot_owner_id", "hs_sequence_id",
    "hs_object_source_user_id"],
  calls: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_direction", "hubspot_owner_id",
    "hs_object_source_user_id"],
  notes: ["hs_timestamp", "hs_note_body", "hubspot_owner_id", "hs_object_source_user_id"],
  meetings: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hubspot_owner_id",
    "hs_object_source_user_id"],
};

/** HTML arrives in note/call/meeting bodies; a timeline entry is plain text. */
const strip = (h: unknown) =>
  String(h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// ============================================================ HubSpot -> monday

/**
 * One HubSpot activity into the associated contact's monday timeline.
 *
 * Only ever CREATES. monday has no timeline-item update mutation, so there is nothing to reconcile if
 * the activity later changes in HubSpot — see activities.ts on immutability.
 */
export async function syncHubspotActivity(env: Env, object: string, hubspotId: string): Promise<void> {
  const log = (action: string, extra = "") =>
    console.log(`[activity] source=hubspot ${object}=${hubspotId} action=${action}${extra ? " " + extra : ""}`);

  const claim = await claimActivityToMonday(env, object, hubspotId);
  if (claim.status === "have") return log("skipped", `reason="already synced as ${claim.id}"`);
  if (claim.status === "creating") return log("skipped", 'reason="another delivery is mid-create"');
  if (claim.status === "blocked") return log("deferred", 'reason="idempotency store unavailable — will retry"');

  try {
    const props = PROPS[object] ?? ["hs_timestamp"];
    const rec = await hs(env, "GET",
      `/crm/v3/objects/${object}/${hubspotId}?properties=${encodeURIComponent(props.join(","))}`, undefined, 2);
    const p = rec?.properties ?? {};

    // Which contact? An activity with no contact has nowhere to go; that is normal (a deal note), not
    // an error, so it settles rather than retrying forever.
    const assoc = await hs(env, "GET",
      `/crm/v4/objects/${object}/${hubspotId}/associations/contacts?limit=10`, undefined, 2);
    // CUTOVER-FORWARD. Refuse anything older than the cutover before spending a lookup on it.
    if (!afterCutover(env, p.hs_timestamp)) {
      await settleActivityToMonday(env, object, hubspotId, "pre-cutover");
      return log("skipped", `reason="before ACTIVITY_CUTOVER_AT" ts=${p.hs_timestamp}`);
    }

    const contactId = (assoc?.results ?? []).map((r: any) => String(r.toObjectId))[0];
    // TRANSIENT, NOT PERMANENT. A contact and its first email are often created within the same
    // second, and HubSpot's association can be briefly unreadable; the webhook then arrives before the
    // link is visible. Settling that as done would lose the activity FOREVER, so the reservation is
    // released and the next delivery retries. The cost of being wrong here is one duplicate check;
    // the cost of the opposite is a permanently missing record.
    if (!contactId) {
      await releaseActivity(env, h2mReservationKey(object, hubspotId));
      return log("deferred", 'reason="no associated contact yet — will retry on redelivery"');
    }

    if (!inCanaryScope(env, contactId, undefined)) {
      await releaseActivity(env, h2mReservationKey(object, hubspotId));
      return log("skipped", `reason="outside canary scope" contact=${contactId}`);
    }

    const card = (await findItemByColumn(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, contactId))[0];
    if (!card) {
      // Same reasoning: the card may simply not exist YET (creation races the activity webhook).
      await releaseActivity(env, h2mReservationKey(object, hubspotId));
      return log("deferred", `reason="contact ${contactId} has no card yet — will retry"`);
    }

    const activity: HsActivity = {
      id: hubspotId, object,
      timestamp: p.hs_timestamp,
      ownerId: p.hubspot_owner_id,
      sourceUserId: p.hs_object_source_user_id,
      direction: p.hs_email_direction ?? p.hs_call_direction,
      sequenceId: p.hs_sequence_id,
    };
    const payload = timelinePayload(activity, {
      title: p.hs_email_subject ?? p.hs_call_title ?? p.hs_meeting_title
        ?? strip(p.hs_note_body).slice(0, 80) ?? undefined,
      from: p.hs_email_from_email, to: p.hs_email_to_email,
      body: strip(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body),
    });
    if (!payload.custom_activity_id) { await settleActivityToMonday(env, object, hubspotId, "unmapped"); return log("skipped", 'reason="no monday activity type for this object"'); }

    const created = await gql(env,
      `mutation ($i: ID!, $a: String!, $t: String!, $s: String!, $c: String!, $ts: ISO8601DateTime!) {
         create_timeline_item(item_id:$i, custom_activity_id:$a, title:$t, summary:$s, content:$c,
                              timestamp:$ts) { id } }`,
      { i: card.id, a: payload.custom_activity_id, t: payload.title, s: payload.summary,
        c: payload.content, ts: payload.timestamp }, 1);
    const timelineId = created?.create_timeline_item?.id;
    await settleActivityToMonday(env, object, hubspotId, String(timelineId ?? "created"));
    log("created", `item=${card.id} timeline=${timelineId}`);

    await maybeMarkFollowUp(env, card.id, contactId, activity);
  } catch (e) {
    // NOT released: the write may have landed and releasing is how a lost response becomes a duplicate.
    unresolvedActivityToMonday(object, hubspotId, e);
    log("error", `reason="${String(e).slice(0, 140)}"`);
  }
}

/**
 * Write Last qualifying follow-up date, but only for activity that proves the CURRENT owner reached
 * out. Needs the card's own owner and assignment date, so it reads them rather than trusting the
 * activity alone — the contact may have been reassigned since the activity happened.
 */
async function maybeMarkFollowUp(env: Env, itemId: string, contactId: string,
    activity: HsActivity): Promise<void> {
  try {
    /**
     * THE OWNER COMPARISON MUST USE THE CONTACT'S OWNER, NOT THE ACTIVITY'S.
     *
     * The first version of this passed the activity's own owner in as `contactOwnerId`, so the check
     * inside qualifiesAsFollowUp compared a value with itself and passed for ANY actor. Every
     * activity qualified, including one logged by a colleague who does not own the contact — and the
     * failure is invisible, because a reminder that stops early produces no error, just a customer
     * nobody chases.
     *
     * BOTH VALUES COME FROM HUBSPOT, and the timestamp deliberately does NOT come from monday's
     * Owner assigned date column: that column is a DATE, so it truncates to midnight, and activity
     * from earlier on the reassignment day would satisfy "after assignment" when it belongs to the
     * previous owner's cycle. hubspot_owner_assigneddate keeps the time.
     */
    const contact = await hs(env, "GET",
      `/crm/v3/objects/contacts/${contactId}?properties=hubspot_owner_id,hubspot_owner_assigneddate`,
      undefined, 2);
    const owner = String(contact?.properties?.hubspot_owner_id ?? "").trim();
    const assignedMs = Date.parse(String(contact?.properties?.hubspot_owner_assigneddate ?? ""));
    if (!owner || !Number.isFinite(assignedMs)) return;   // unowned or never assigned: no cycle to satisfy

    if (!qualifiesAsFollowUp(activity, { contactOwnerId: owner, ownerAssignedAtMs: assignedMs })) return;

    const day = String(activity.timestamp ?? "").slice(0, 10);
    if (!day) return;
    const d = await gql(env,
      `query ($i: [ID!]) { items(ids: $i) { column_values(ids: ["${QUALIFYING_COL}"]) { text } } }`,
      { i: [itemId] }, 2);
    if (String(d?.items?.[0]?.column_values?.[0]?.text ?? "").trim() === day) return;   // no churn

    await gql(env,
      `mutation ($b: ID!, $i: ID!, $c: JSON!) {
         change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
      { b: CRM_CONTACTS.boardId, i: itemId, c: JSON.stringify({ [QUALIFYING_COL]: { date: day } }) }, 2);
    console.log(`[activity] item=${itemId} action=qualified date=${day} owner=${owner}`);
  } catch (e) {
    // A missed helper write must never fail the sync: the activity is already visible, which is the
    // larger half of the value.
    console.log(`[activity] item=${itemId} action=qualify-failed reason="${String(e).slice(0, 120)}"`);
  }
}

// ============================================================ monday -> HubSpot

/**
 * Woken by a Last Activity Date change, read ONE contact's timeline and push anything native we have
 * not pushed before.
 *
 * The date is only a doorbell. It is never read as the activity, and never used for qualification —
 * the durable registry decides what is new, so repeated wake-ups (we observe roughly two per
 * activity, from the automation and the workflow that both write the column) cost one timeline read
 * and create nothing twice.
 */
export async function syncMondayTimeline(env: Env, itemId: string): Promise<void> {
  const log = (action: string, extra = "") =>
    console.log(`[activity] source=monday item=${itemId} action=${action}${extra ? " " + extra : ""}`);
  try {
    const d = await gql(env,
      `query ($i: ID!) { timeline(id: $i) { timeline_items_page { timeline_items {
          id type title content custom_activity_id created_at } } } }`,
      { i: itemId }, 2);
    const entries: any[] = d?.timeline?.timeline_items_page?.timeline_items ?? [];
    const native = entries.filter(eligibleForHubspot);
    if (!native.length) return log("nothing-to-sync", `entries=${entries.length}`);

    const card = await gql(env,
      `query ($i: [ID!]) { items(ids: $i) { column_values(ids: ["${CRM_CONTACTS.idCol}"]) { text } } }`,
      { i: [itemId] }, 2);
    const contactId = String(card?.items?.[0]?.column_values?.[0]?.text ?? "").trim();
    if (!contactId) return log("skipped", 'reason="card carries no HubSpot id"');
    if (!inCanaryScope(env, contactId, itemId)) return log("skipped", 'reason="outside canary scope"');

    // CUTOVER-FORWARD, and this is where it earns its keep. A real contact's timeline can hold years
    // of native notes and calls, none of which has a mapping yet, so without this the first wake-up
    // would read "nothing is mapped" as "everything is new" and push the whole history into HubSpot.
    const fresh = native.filter(e => afterCutover(env, e.created_at));
    if (fresh.length !== native.length)
      log("filtered", `pre-cutover=${native.length - fresh.length} of ${native.length}`);
    if (!fresh.length) return log("nothing-to-sync", 'reason="all entries predate the cutover"');

    for (const entry of fresh) await pushOne(env, itemId, contactId, entry, log);
  } catch (e) {
    log("error", `reason="${String(e).slice(0, 140)}"`);
  }
}

async function pushOne(env: Env, itemId: string, contactId: string, entry: any,
    log: (a: string, e?: string) => void): Promise<void> {
  const object = HUBSPOT_OBJECT_FOR_NATIVE[String(entry.type)];
  if (!object) return;

  const claim = await claimActivityToHubspot(env, entry.id);
  if (claim.status === "have") return;                       // already pushed — the common case
  if (claim.status === "creating") return log("skipped", `timeline=${entry.id} reason="mid-create"`);
  if (claim.status === "blocked") return log("deferred", `timeline=${entry.id} reason="idempotency store unavailable"`);

  try {
    const text = strip(entry.content) || strip(entry.title) || "(no content)";
    const bodyProp = object === "notes" ? "hs_note_body" : "hs_call_body";
    const properties: Record<string, string> = {
      hs_timestamp: entry.created_at,
      [bodyProp]: `${text}\n\n[monday timeline ${entry.id}]`,
    };
    if (object === "calls") {
      properties.hs_call_title = strip(entry.title) || "monday call";
      properties.hs_call_direction = "OUTBOUND";
    }
    // retries=1: a create must never be retried at the transport layer, or a lost response duplicates.
    const created = await hs(env, "POST", `/crm/v3/objects/${object}`, {
      properties,
      associations: [{ to: { id: contactId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: CONTACT_ASSOC_TYPE[object] }] }],
    }, 1);
    const newId = String(created?.id ?? "");
    await settleActivityToHubspot(env, entry.id, newId);
    /**
     * SUPPRESS THE FIRST BOUNCE. Creating this object makes HubSpot fire object.creation for it, and
     * that event looks exactly like a rep's own call. The structural echo guard cannot help — it only
     * stops OUR monday writes travelling back, and this is a HubSpot object we really did create. So
     * claim the other direction now, while we still know the pair: when the bounce arrives,
     * HubSpot -> monday sees it as already represented and creates nothing, instead of landing a
     * custom "HubSpot Call" beside the native Call it came from.
     */
    if (newId) await claimHubspotAsRepresented(env, object, newId, entry.id);
    log("pushed", `timeline=${entry.id} -> ${object}/${newId} contact=${contactId}`);
  } catch (e) {
    unresolvedActivityToHubspot(entry.id, e);
    log("error", `timeline=${entry.id} reason="${String(e).slice(0, 140)}"`);
  }
}
