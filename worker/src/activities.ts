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

/** The monday custom activity types created 2026-09-16 for synced HubSpot activity. */
export const MONDAY_ACTIVITY_TYPE: Record<string, string> = {
  emails: "eaca46da-4695-4386-8dd4-a3fa088d31ce",    // HubSpot Email
  notes: "ca35c3ab-476a-4718-9b38-67ee945593d4",     // HubSpot Note
  calls: "1e0d9eca-222b-4f8b-85c8-4f7947e83595",     // HubSpot Call
  meetings: "7314447b-685c-4c58-9e38-80ad162d8fc4",  // HubSpot Meeting
};

/** monday native timeline type -> the HubSpot object a monday-origin activity becomes. */
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
export function eligibleForHubspot(entry: { custom_activity_id?: string | null; type?: string }): boolean {
  if (entry.custom_activity_id) return false;
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
 * matters: the monday workflows #03/#04/#05 stop chasing as soon as their date column is populated,
 * so counting an inbound customer reply — or an automated marketing send — as "the rep followed up"
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
