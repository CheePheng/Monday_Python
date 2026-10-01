/**
 * ACTIVITY SYNC — HubSpot engagements <-> monday's native per-Contact Emails & Activities timeline.
 *
 * This file holds the DECISIONS (what maps to what, what counts as follow-up). The I/O lives in
 * activity-sync.ts, so every rule below is a pure function a test can reach without credentials.
 *
 * WHAT THE POC ESTABLISHED, because each constraint here is a measured fact rather than a preference:
 *
 *   monday cannot create a NATIVE Email/Call/Meeting. `create_timeline_item` requires a
 *   `custom_activity_id`, so synced HubSpot activity can only appear as a custom type we define. The
 *   four types below were created for that purpose.
 *
 *   monday has NO UPDATE MUTATION for timeline items — only create, read and delete. Activities are
 *   therefore IMMUTABLE in v1: an edited HubSpot email is not re-pushed, because the only way to
 *   "edit" is delete-and-recreate, which changes the timeline id and orphans the mapping. A
 *   communication log is append-only in spirit anyway.
 *
 *   HubSpot's SEARCH INDEX IS ASYNCHRONOUS. Searching for a body marker to decide "did I already
 *   create this?" returns nothing for a record written seconds earlier, so a retry creates a
 *   DUPLICATE — measured, twice, in the POC. Idempotency must come from a durable reservation, never
 *   from asking HubSpot whether the record exists. See activity-registry.ts.
 */
import type { Ctx } from "./types";

/**
 * "HubSpot Marketing Email" (PAPERPLANE, MEDIUM_TURQUOISE) -- created 2026-09-30 by
 * `node scripts/create-marketing-activity-type.mjs --apply`; a dry re-run of that script confirmed this
 * id is the only type of that name on the account.
 *
 * Setting it switches nothing on: ENABLE_MARKETING_EMAIL_SYNC still gates the poller. Blanking it is a
 * safe way to stop marketing writes without a flag change -- the poller then REFUSES and logs why, since
 * create_timeline_item requires a custom_activity_id and writing under any other type would file
 * marketing mail as "HubSpot Email", exactly the confusion with sequence sends the label exists to end.
 */
export const MARKETING_ACTIVITY_TYPE_ID = "e30a1386-45a1-446d-aadf-b033dfd9ac22";

/** The monday custom activity types created 2026-09-16 for synced HubSpot activity. */
export const MONDAY_ACTIVITY_TYPE: Record<string, string> = {
  emails: "eaca46da-4695-4386-8dd4-a3fa088d31ce",    // HubSpot Email
  notes: "ca35c3ab-476a-4718-9b38-67ee945593d4",     // HubSpot Note
  calls: "1e0d9eca-222b-4f8b-85c8-4f7947e83595",     // HubSpot Call
  meetings: "7314447b-685c-4c58-9e38-80ad162d8fc4",  // HubSpot Meeting
  tasks: "5f0e2267-8cea-45fa-bb54-2b1a29324a34",     // HubSpot Task — created 2026-09-16
  // HubSpot marketing email events (marketing-emails.ts). ONE type for all four objects: they are one
  // kind of thing to a rep, and the object name already separates them for the registry and markers.
  marketing_emails: MARKETING_ACTIVITY_TYPE_ID,
  marketing_email_opens: MARKETING_ACTIVITY_TYPE_ID,
  marketing_email_clicks: MARKETING_ACTIVITY_TYPE_ID,
  marketing_email_events: MARKETING_ACTIVITY_TYPE_ID,
};

/**
 * WHEN A TASK BELONGS IN THE TIMELINE.
 *
 * hs_timestamp on a task is its DUE DATE, not when anything happened — so using it directly would
 * file a task completed in July under its October deadline, and a timeline sorted by "when did this
 * happen" would be wrong about the one thing it is for. A completed task is dated by its completion;
 * an open one has nothing to have happened yet, so its deadline is the best available anchor.
 *
 * Both dates are kept in the body regardless: the deadline is information a rep wants even after the
 * work is done.
 */
export function taskTimestamp(p: Record<string, unknown>): string | undefined {
  const done = String(p.hs_task_completion_date ?? "").trim();
  return done || (String(p.hs_timestamp ?? "").trim() || undefined);
}

/**
 * Native monday entry type -> the HubSpot object to create. ANYTHING ABSENT HERE IS IGNORED, and the
 * most important absence is `email`.
 *
 * Surveyed across 400 Contacts cards before global enablement: 39 of the 45 native entries were
 * type "email", and every one was a monday WORKFLOW NOTIFICATION — "New Contact Assigned to You —
 * <name>", addressed to the rep, auto-logged into Emails & Activities because Gmail is bound to
 * monday. Mapping `email` would copy that internal notification traffic into HubSpot as customer
 * communication, on a CRM people read to decide what to say next. Reps send real mail from HubSpot,
 * which already arrives through the HubSpot -> monday direction, so nothing is lost by refusing it.
 *
 * Note the asymmetry with `activity`: it maps to CALLS, so a future decision to admit `email` must
 * NOT simply add it here — it would need its own object and direction handling.
 */
export const HUBSPOT_OBJECT_FOR_NATIVE: Record<string, "notes" | "calls"> = {
  note: "notes",
  activity: "calls",   // monday's "Call summary" surfaces as type "activity"
};

/** HubSpot association type ids (HUBSPOT_DEFINED) from an activity to a Contact. */
export const CONTACT_ASSOC_TYPE: Record<string, number> = { notes: 202, calls: 194 };

/**
 * MAY this monday timeline entry be pushed to HubSpot?
 *
 * THE ECHO GUARD, and it is structural rather than bookkeeping: a native entry (made by a person in
 * monday) has `custom_activity_id == null`; everything this integration writes carries one, because
 * `create_timeline_item` REQUIRES it. So our own copies can never satisfy this test and a loop cannot
 * form — even if every stored mapping were lost. Bookkeeping-based guards fail exactly when state is
 * lost, which is when they are most needed.
 */
export function eligibleForHubspot(entry: { custom_activity_id?: string | null; type?: string; content?: unknown }): boolean {
  if (entry.custom_activity_id) return false;
  /**
   * AND A MARKETING MARKER IS NEVER NATIVE, whatever monday reports about its type.
   *
   * Every marketing entry carries a custom_activity_id, so the line above already refuses it. This is
   * the second line for the one way that could fail: an API reply that drops or nulls the type id on a
   * custom entry. A marketing entry pushed back would become a HubSpot Note on the contact, dated at the
   * send -- a fabricated "rep activity" in the CRM. The marker is written only by the marketing poller,
   * so matching it can never refuse a person's own note.
   */
  if (/\[hubspot:marketing_email[a-z_]*:/.test(String(entry.content ?? ""))) return false;
  return !!HUBSPOT_OBJECT_FOR_NATIVE[String(entry.type ?? "")];
}

export interface HsActivity {
  id: string;
  object: string;                      // emails | notes | calls | meetings
  timestamp?: string;                  // hs_timestamp
  ownerId?: string;                    // hubspot_owner_id
  sourceUserId?: string;               // hs_object_source_user_id
  direction?: string;                  // hs_email_direction / hs_call_direction
  sequenceId?: string;                 // hs_sequence_id — set only for sequence-generated mail
}

export interface FollowUpContext {
  /** The contact's CURRENT HubSpot owner id. Comparison is by owner id, never by monday user. */
  contactOwnerId: string;
  /** Owner assigned date, ms. Activity at or before this belongs to a previous cycle. */
  ownerAssignedAtMs: number;
}

/** Outbound for our purposes. HubSpot spells email direction EMAIL / INCOMING_EMAIL / FORWARDED_EMAIL. */
const OUTBOUND = new Set(["EMAIL", "OUTBOUND", "OUTGOING"]);

/**
 * Does this activity prove the CURRENT OWNER followed the contact up?
 *
 * SEPARATE FROM VISIBILITY, deliberately. Everything relevant syncs to the timeline so both systems
 * show the same history; only a subset may silence a reminder. Conflating the two is the failure that
 * matters: the monday workflows #03/#04/#05 stop chasing as soon as their date column is populated
 * (live cadence 2/3/5 days after Owner assigned date; intended 1/3/5, and only #03 changes — not
 * until the Activity sync is enabled), so counting an inbound customer reply — or an automated
 * marketing send — as "the rep followed up"
 * would silently cancel the escalation to Zmark for exactly the contacts nobody has worked. The
 * system would go quiet and look healthy.
 *
 * Every clause below is a way of being wrong that was considered and rejected:
 */
export function qualifiesAsFollowUp(a: HsActivity, ctx: FollowUpContext): boolean {
  // An activity from before this owner got the contact is the PREVIOUS owner's work. Without this a
  // reassignment inherits the old owner's history and the new owner is never chased at all.
  const ts = Date.parse(String(a.timestamp ?? ""));
  if (!Number.isFinite(ts) || ts <= ctx.ownerAssignedAtMs) return false;

  // A sequence send is the machine's work, not the salesperson's. Identified by hs_sequence_id, which
  // the POC confirmed is populated on real sequence mail — so this needs no Sequences API scope.
  if (a.sequenceId) return false;

  // ONLY REACHING OUT COUNTS. A note is the rep talking to themselves — "call him Tuesday", "waiting
  // on legal" — and a meeting object is usually a SCHEDULED one, created when the invite goes out
  // rather than when anyone is spoken to. Either would silence the chaser for work that has not
  // happened, which is the expensive direction to be wrong in. They still sync and stay visible;
  // visibility and qualification are different questions.
  //
  // Meetings can be revisited once we can prove an object represents a HELD meeting (an outcome, or
  // an end time in the past) rather than an intention. Until then, fail closed.
  if (a.object !== "emails" && a.object !== "calls") return false;

  // Inbound mail is the CUSTOMER acting. It is the strongest evidence a reply is owed, so treating it
  // as follow-up would cancel the reminder at the precise moment it is most warranted. A call with no
  // direction is refused too: a call's direction is knowable, so its absence is missing data rather
  // than an exemption.
  if (!OUTBOUND.has(String(a.direction ?? "").toUpperCase())) return false;

  // Attribution by HUBSPOT OWNER ID, never by the monday People column. Some owners have no monday
  // account at all — "Rick Avery Antonio" is the live example, 136 contacts deep — and matching on
  // the monday assignee would fail closed for them, chasing reps forever over contacts they worked.
  const actor = String(a.ownerId ?? a.sourceUserId ?? "");
  if (!actor || actor !== ctx.contactOwnerId) return false;

  return true;
}

/** The timeline payload for one HubSpot activity. Provenance is carried in the body so a human reading
 *  the card can see where an entry came from without consulting a mapping table. */
export function timelinePayload(a: HsActivity, fields: Record<string, string | undefined>) {
  const lines = [
    fields.from ? `From: ${fields.from}` : "",
    fields.to ? `To: ${fields.to}` : "",
    a.direction ? `Direction: ${a.direction}` : "",
    a.ownerId ? `HubSpot owner: ${a.ownerId}` : "",
    a.sequenceId ? `Sequence ${a.sequenceId} — informational, does not count as follow-up` : "",
    fields.taskStatus ? `Status: ${fields.taskStatus}` : "",
    fields.taskType ? `Task type: ${fields.taskType}` : "",
    fields.taskPriority && fields.taskPriority !== "NONE" ? `Priority: ${fields.taskPriority}` : "",
    fields.taskDue ? `Due: ${fields.taskDue}` : "",
    fields.taskCompleted ? `Completed: ${fields.taskCompleted}` : "",
    fields.body ? `\n${fields.body}` : "",
    `\n[hubspot:${a.object}:${a.id}]`,
  ].filter(Boolean);
  return {
    custom_activity_id: MONDAY_ACTIVITY_TYPE[a.object],
    title: (fields.title ?? "(no subject)").slice(0, 250),
    summary: (fields.summary ?? "").slice(0, 250),
    content: lines.join("\n"),
    // The ORIGINAL time, never now: the entry must land where it belongs in the history, and the
    // reminder logic compares it against Owner assigned date.
    timestamp: a.timestamp,
  };
}
