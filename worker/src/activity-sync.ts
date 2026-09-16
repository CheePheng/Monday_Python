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
    const contactId = (assoc?.results ?? []).map((r: any) => String(r.toObjectId))[0];
    if (!contactId) { await settleActivityToMonday(env, object, hubspotId, "no-contact"); return log("skipped", 'reason="no associated contact"'); }

    const card = (await findItemByColumn(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, contactId))[0];
    if (!card) { await settleActivityToMonday(env, object, hubspotId, "no-card"); return log("skipped", `reason="contact ${contactId} has no monday card"`); }

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

    await maybeMarkFollowUp(env, card.id, activity);
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
async function maybeMarkFollowUp(env: Env, itemId: string, activity: HsActivity): Promise<void> {
  try {
    const d = await gql(env,
      `query ($i: [ID!]) { items(ids: $i) { column_values(ids: ["${OWNER_COL}", "${OWNER_ASSIGNED_COL}", "${QUALIFYING_COL}"]) { id text } } }`,
      { i: [itemId] }, 2);
    const cv = d?.items?.[0]?.column_values ?? [];
    const val = (id: string) => String(cv.find((c: any) => c.id === id)?.text ?? "").trim();
    const assignedMs = Date.parse(val(OWNER_ASSIGNED_COL));
    if (!Number.isFinite(assignedMs)) return;   // never assigned: no cycle to satisfy

    // Owner comparison is by HUBSPOT owner id, resolved from the activity, never the monday People
    // cell — owners without a monday account would otherwise never qualify. The card's HubSpot owner
    // is not on the board, so the activity's own owner is compared against the contact's owner as
    // recorded in HubSpot at fetch time; see qualifiesAsFollowUp.
    const ownerId = String(activity.ownerId ?? activity.sourceUserId ?? "");
    if (!qualifiesAsFollowUp(activity, { contactOwnerId: ownerId, ownerAssignedAtMs: assignedMs })) return;

    const day = String(activity.timestamp ?? "").slice(0, 10);
    if (!day || val(QUALIFYING_COL) === day) return;   // already recorded: no churn
    await gql(env,
      `mutation ($b: ID!, $i: ID!, $c: JSON!) {
         change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
      { b: CRM_CONTACTS.boardId, i: itemId, c: JSON.stringify({ [QUALIFYING_COL]: { date: day } }) }, 2);
    console.log(`[activity] item=${itemId} action=qualified date=${day}`);
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

    for (const entry of native) await pushOne(env, itemId, contactId, entry, log);
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
    await settleActivityToHubspot(env, entry.id, String(created?.id ?? ""));
    log("pushed", `timeline=${entry.id} -> ${object}/${created?.id} contact=${contactId}`);
  } catch (e) {
    unresolvedActivityToHubspot(entry.id, e);
    log("error", `timeline=${entry.id} reason="${String(e).slice(0, 140)}"`);
  }
}
