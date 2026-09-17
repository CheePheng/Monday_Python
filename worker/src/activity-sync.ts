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
  associatedDestinations, DEST_BOARD, MAX_ASSOC_PAGES,
  type Destination, type DestKind,
} from "./activity-destinations";
import {
  MONDAY_ACTIVITY_TYPE, HUBSPOT_OBJECT_FOR_NATIVE, CONTACT_ASSOC_TYPE,
  eligibleForHubspot, qualifiesAsFollowUp, timelinePayload, taskTimestamp, type HsActivity,
} from "./activities";
import type { ActivityOutcome } from "./activity-retry";
import {
  claimActivityToHubspot, settleActivityToHubspot, unresolvedActivityToHubspot,
  claimActivityToMonday, settleActivityToMonday, unresolvedActivityToMonday,
  claimHubspotAsRepresented, releaseActivity, h2mReservationKey,
  lastOwnerCycle, rememberOwnerCycle,
} from "./activity-registry";

/** HubSpot activity objectTypeId -> object name. Routed explicitly, never inferred. */
export const ACTIVITY_BY_TYPEID: Record<string, string> = {
  "0-49": "emails", "0-48": "calls", "0-46": "notes", "0-47": "meetings",
};
export const ACTIVITY_BY_NAME: Record<string, string> = {
  email: "emails", call: "calls", note: "notes", meeting_event: "meetings", task: "tasks",
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
/**
 * SCOPE FOR A DESTINATION, which is not the same question as scope for a contact.
 *
 * The allowlist began life contact-shaped, and comparing a Company or Deal id against a CONTACT
 * allowlist can only ever be false — so a canary would resolve all three destinations, silently drop
 * two of them, and "pass" having proven nothing about the fan-out it exists to test. Each kind is
 * therefore matched against its own variable.
 */
export function destInCanaryScope(env: Env, kind: "contact" | "company" | "deal", hubspotId: string): boolean {
  const c = String(env.ACTIVITY_CANARY_HUBSPOT_CONTACT_ID ?? "").trim();
  const co = String(env.ACTIVITY_CANARY_HUBSPOT_COMPANY_ID ?? "").trim();
  const d = String(env.ACTIVITY_CANARY_HUBSPOT_DEAL_ID ?? "").trim();
  const m = String(env.ACTIVITY_CANARY_MONDAY_ITEM_ID ?? "").trim();
  if (!c && !co && !d && !m) return true;                      // no allowlist: full scope
  const want = kind === "contact" ? c : kind === "company" ? co : d;
  return !!want && hubspotId === want;
}

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
  tasks: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority",
    "hs_task_type", "hs_task_completion_date", "hubspot_owner_id", "hs_object_source_user_id"],
};

/**
 * The marker stamped into every HubSpot object we create from a monday entry, and the pattern that
 * reads it back. Secondary bounce guard — see resolveContactAndCard's caller.
 */
export const mondayOriginMarker = (timelineId: string) => `[monday timeline ${timelineId}]`;
/**
 * DELIBERATELY SHAPE-AGNOSTIC about the id. An earlier version demanded 8+ hex characters, which
 * would have matched a UUID and silently missed anything else monday hands out — and a guard that
 * stops matching produces no error, just the duplicate it exists to prevent. The literal prefix is
 * what identifies the marker; the id is only carried along.
 */
const MONDAY_ORIGIN_RE = /\[monday timeline ([A-Za-z0-9_-]{1,64})\]/;
export function mondayOriginOf(text: unknown): string | null {
  return MONDAY_ORIGIN_RE.exec(String(text ?? ""))?.[1] ?? null;
}

/**
 * BOUNDED RETRY for visibility, not for writes.
 *
 * A contact and its first email are routinely created in the same second, and HubSpot's association
 * can be briefly unreadable, so the activity webhook often arrives before the link or the card
 * exists. Releasing the reservation and "waiting for redelivery" does NOT fix that: this work runs in
 * waitUntil and the webhook was already acknowledged 200, so HubSpot has no reason to send it again.
 *
 * So resolve with a few short waits instead. Only the LOOKUP is retried — never a create, which must
 * never be repeated. Total ~22s, comfortably inside the detached task's budget.
 */
const RESOLVE_BACKOFF_MS = [0, 2_000, 5_000, 15_000];

/** HTML arrives in note/call/meeting bodies; a timeline entry is plain text. */
const strip = (h: unknown) =>
  String(h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * STAFF ARE NOT THE COUNTERPARTY.
 *
 * Every HubSpot activity is associated with all its participants. An outbound email from a rep to a
 * customer is associated with BOTH, and the rep exists as a Contact in this portal like anyone else.
 * The first production rollout took the first association and filed 40 outbound campaign emails on
 * the SENDER's own card; not one reached the customer whose timeline is the entire point.
 *
 * The fix cannot key on direction. "Skip the sender" is right for outbound and exactly backwards for
 * inbound, where the sender IS the customer. The stable property is who is STAFF, and HubSpot already
 * answers that: the owners list is the sales users, and a customer is never an owner.
 *
 * Cached for ten minutes per isolate. This is a small, flat read — deliberately NOT buildCtx, which
 * is the path whose 403 stopped live Contacts and Companies sync for an hour on 2026-09-15.
 */
let ownerEmails: { at: number; emails: Set<string> } | null = null;
const OWNER_CACHE_MS = 10 * 60_000;

async function staffEmails(env: Env): Promise<Set<string>> {
  if (ownerEmails && Date.now() - ownerEmails.at < OWNER_CACHE_MS) return ownerEmails.emails;
  const emails = new Set<string>();
  let after = "";
  for (let page = 0; page < 20; page++) {
    const r = await hs(env, "GET", `/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`, undefined, 2);
    for (const o of r?.results ?? []) if (o?.email) emails.add(String(o.email).trim().toLowerCase());
    after = r?.paging?.next?.after ?? "";
    if (!after) break;
  }
  ownerEmails = { at: Date.now(), emails };
  return emails;
}

/**
 * AN ABUSE CEILING, NOT A PRODUCT LIMIT.
 *
 * "All participants minus staff" has to mean ALL of them: an email to eight customers belongs on
 * eight cards, and quietly writing the first few would lose real communication history in a way
 * nobody would ever notice. This exists only to stop a pathological record — an object associated
 * with hundreds of contacts — from exhausting a single webhook's subrequest budget and taking the
 * shared handler down with it.
 *
 * Above the ceiling NOTHING is written. Partially writing and discarding the remainder is the worst
 * of both: it looks successful and is silently incomplete. Instead the activity is reported as
 * unresolved, so it travels the normal durable-retry path and ends as an inspectable terminal record
 * in the dead-letter index, where a person can decide what it was.
 */
const MAX_PARTICIPANTS = 50;

/**
 * Split the participants into the cards an activity belongs on and the colleagues it does not.
 *
 * Returns BOTH sides. The staff list is not merely discarded: it is logged, because "who did the
 * classifier see and what did it decide" is the only evidence that distinguishes a working staff
 * filter from a set of associations that never contained a colleague in the first place — which is
 * exactly the blind spot that let the production incident through a green canary.
 */
async function participantsFor(env: Env, contactIds: string[]):
    Promise<{ targets: string[]; staff: string[] }> {
  if (!contactIds.length) return { targets: [], staff: [] };
  const staffSet = await staffEmails(env);        // throws -> caller treats it as retryable
  const emailOf = new Map<string, string>();
  // HubSpot's batch read accepts at most 100 inputs. Now that the full association set is classified
  // rather than a pre-filtered slice of it, an oversized activity would otherwise fail HERE, as an
  // opaque 400, instead of at the ceiling check that exists to describe exactly that case.
  for (let i = 0; i < contactIds.length; i += 100) {
    const read = await hs(env, "POST", "/crm/v3/objects/contacts/batch/read",
      { properties: ["email"], inputs: contactIds.slice(i, i + 100).map(id => ({ id })) }, 2);
    for (const c of read?.results ?? [])
      emailOf.set(String(c.id), String(c.properties?.email ?? "").trim().toLowerCase());
  }
  const targets: string[] = [], staff: string[] = [];
  for (const id of contactIds) {
    const e = emailOf.get(id);
    // A contact with no email cannot be PROVEN to be staff, and dropping a real customer is the
    // worse error of the two, so it is kept.
    (e && staffSet.has(e) ? staff : targets).push(id);
  }
  return { targets, staff };
}

// ============================================================ HubSpot -> monday

/**
 * One HubSpot activity into the associated contact's monday timeline.
 *
 * Only ever CREATES. monday has no timeline-item update mutation, so there is nothing to reconcile if
 * the activity later changes in HubSpot — see activities.ts on immutability.
 */
/**
 * Options exist for ONE caller, the task poller, and both are deliberately narrow.
 *
 * ignoreCutover — a task's timeline position is its due or completion date, routinely long past, so
 * the cutover that exists to stop a bulk history push would reject every task the poller finds. No
 * webhook path sets this.
 *
 * verifyExisting — the historical backfill writes timeline entries WITHOUT creating live durable
 * mappings, so a poller that trusted the mapping alone would faithfully duplicate everything the
 * migration had already placed. Checking the card costs a read; not checking costs a duplicate.
 */
export interface SyncActivityOpts { ignoreCutover?: boolean; verifyExisting?: boolean }

/** Is this activity already represented on that card, according to the card itself? */
async function alreadyOnCard(env: Env, cardId: string, object: string, hubspotId: string): Promise<boolean> {
  const marker = `[hubspot:${object}:${hubspotId}]`;
  let cursor: string | null = null;
  for (let p = 0; p < 40; p++) {
    const d: any = await gql(env,
      `query ($i: ID!, $c: String) { timeline(id: $i) { timeline_items_page(limit: 100, cursor: $c) {
          cursor timeline_items { content } } } }`, { i: cardId, c: cursor }, 2);
    const page = d?.timeline?.timeline_items_page;
    if (!page) return false;
    for (const e of page.timeline_items ?? [])
      if (String(e?.content ?? "").includes(marker)) return true;
    cursor = page.cursor ?? null;
    if (!cursor) return false;
  }
  return false;
}

export async function syncHubspotActivity(env: Env, object: string, hubspotId: string,
    opts: SyncActivityOpts = {}): Promise<ActivityOutcome> {
  /**
   * EVERY EXIT REPORTS AN OUTCOME, because the durable retry has to tell three cases apart that all
   * used to look like "it did not sync": a settled decision (nothing to do), a lost race (retry), and
   * a create that threw after being sent (NEVER retry — it may have landed). Returning void made the
   * third indistinguishable from the second, which is how a retry becomes a duplicate.
   */
  const fin = (outcome: ActivityOutcome, extra = "", action: string = outcome): ActivityOutcome => {
    console.log(`[activity] source=hubspot ${object}=${hubspotId} action=${action}${extra ? " " + extra : ""}`);
    return outcome;
  };

  try {
    const props = PROPS[object] ?? ["hs_timestamp"];
    const rec = await hs(env, "GET",
      `/crm/v3/objects/${object}/${hubspotId}?properties=${encodeURIComponent(props.join(","))}`, undefined, 2);
    const p = rec?.properties ?? {};

    // CUTOVER-FORWARD. Refuse anything older than the cutover before spending a lookup on it.
    if (!opts.ignoreCutover && !afterCutover(env, p.hs_timestamp))
      return fin("skipped", `reason="before ACTIVITY_CUTOVER_AT" ts=${p.hs_timestamp}`);

    /**
     * SECONDARY BOUNCE GUARD. Creating a HubSpot Note/Call from a monday entry makes HubSpot fire
     * object.creation for it, and that event can arrive BEFORE the durable mapping finishes writing.
     * The mapping is the authoritative guard; this marker closes the gap between the create returning
     * and the claim landing. Checked per ACTIVITY, before any per-contact work: an object we made
     * from monday must not be re-created on anybody's card.
     */
    const origin = mondayOriginOf(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body);
    if (origin) return fin("skipped", `reason="originated from monday timeline ${origin}"`);

    /**
     * EVERY CRM OBJECT THE ACTIVITY TOUCHED, not just the Contact.
     *
     * monday is becoming the system the sales team actually works in, so a rep looking at an Account
     * or a Deal has to see the conversation that happened on it without opening a HubSpot seat. One
     * email legitimately belongs on a Contact, a Company and a Deal at once, and appears once on each.
     * Explicit associations only — a Company is never inferred by walking from the Contact.
     */
    let dests: Destination[] = [];
    let complete = true;
    for (const wait of RESOLVE_BACKOFF_MS) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      ({ destinations: dests, complete } = await associatedDestinations(env, object, hubspotId));
      if (dests.length) break;
    }
    if (!dests.length) return fin("unresolved", 'reason="no associated CRM object after bounded retry"');

    /**
     * A TRUNCATED ASSOCIATION LIST IS NOT AN ASSOCIATION LIST. Running out of pages with more still
     * offered yields a set that looks perfectly ordinary, so acting on it would write a confidently
     * incomplete history. Checked before the scope gate: the page we did not fetch could hold the
     * very record we are scoped to.
     */
    if (!complete)
      return fin("unresolved",
        `reason="associations exceed ${MAX_ASSOC_PAGES} pages; refusing to act on a partial set" seen=${dests.length}`,
        "abnormal-participants");

    // Scope decides only WHETHER to look. Classification below sees the full, real set.
    if (!dests.some(d => destInCanaryScope(env, d.kind, d.hubspotId)))
      return fin("skipped", `reason="no destination in canary scope" n=${dests.length}`);

    /**
     * STAFF EXCLUSION APPLIES TO CONTACT CARDS ONLY.
     *
     * A rep's own Contact card must not collect the mail they sent — that is the incident this rule
     * exists for. It says nothing about an Account or a Deal: if HubSpot linked the activity there,
     * the link is a record of what happened and the rep's staff status is irrelevant to it.
     */
    const contactIds = dests.filter(d => d.kind === "contact").map(d => d.hubspotId);
    let keepContacts: string[] = [], staff: string[] = [];
    if (contactIds.length) {
      try {
        const r = await participantsFor(env, contactIds);
        keepContacts = r.targets; staff = r.staff;
      } catch (e) {
        return fin("unresolved", `reason="cannot classify participants: ${String(e).slice(0, 90)}"`,
          "deferred");
      }
    }

    let targets = dests.filter(d => d.kind !== "contact" || keepContacts.includes(d.hubspotId));
    const show = (ds: Destination[]) => ds.map(d => `${d.kind}:${d.hubspotId}`).join(",") || "-";
    console.log(`[activity] source=hubspot ${object}=${hubspotId} action=classified`
      + ` destinations=${show(dests)} staff=${staff.join(",") || "-"} targets=${show(targets)}`);

    if (!targets.length)
      return fin("skipped", 'reason="every destination excluded (all staff)"');
    if (targets.length > MAX_PARTICIPANTS)
      return fin("unresolved",
        `reason="${targets.length} destinations exceeds the ceiling of ${MAX_PARTICIPANTS}; writing none"`,
        "abnormal-participants");

    targets = targets.filter(d => destInCanaryScope(env, d.kind, d.hubspotId));
    if (!targets.length) return fin("skipped", 'reason="no surviving destination is in canary scope"');

    const activity: HsActivity = {
      id: hubspotId, object,
      // A task is dated by when it was DONE, not by its deadline — see taskTimestamp.
      timestamp: object === "tasks" ? taskTimestamp(p) : p.hs_timestamp,
      ownerId: p.hubspot_owner_id,
      sourceUserId: p.hs_object_source_user_id,
      direction: p.hs_email_direction ?? p.hs_call_direction,
      sequenceId: p.hs_sequence_id,
    };
    const payload = timelinePayload(activity, {
      title: p.hs_email_subject ?? p.hs_call_title ?? p.hs_meeting_title ?? p.hs_task_subject
        ?? strip(p.hs_note_body).slice(0, 80) ?? undefined,
      from: p.hs_email_from_email, to: p.hs_email_to_email,
      body: strip(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body ?? p.hs_task_body),
      taskStatus: p.hs_task_status, taskType: p.hs_task_type, taskPriority: p.hs_task_priority,
      taskDue: p.hs_timestamp && object === "tasks" ? p.hs_timestamp : undefined,
      taskCompleted: p.hs_task_completion_date,
    });
    if (!payload.custom_activity_id)
      return fin("skipped", 'reason="no monday activity type for this object"');

    // Cards for every destination, on whichever board that kind lives, with the bounded backoff the
    // late-card race needs. Resolved together so the waits are shared rather than paid per card.
    const cards = new Map<string, { id: string }>();
    const keyOf = (d: Destination) => `${d.kind}:${d.hubspotId}`;
    for (const wait of RESOLVE_BACKOFF_MS) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      for (const d of targets)
        if (!cards.has(keyOf(d))) {
          const b = DEST_BOARD[d.kind];
          const c = (await findItemByColumn(env, b.boardId, b.idCol, d.hubspotId))[0];
          if (c) cards.set(keyOf(d), c);
        }
      if (cards.size === targets.length) break;
    }

    /**
     * ONE RESERVATION PER DESTINATION. Each is claimed, written and settled independently, so a
     * failure on the Company cannot mark the Contact done, and a redelivery resumes exactly where it
     * stopped.
     */
    let wrote = 0, errored = false, retryable: ActivityOutcome | null = null;
    for (const d of targets) {
      const card = cards.get(keyOf(d));
      if (!card) {
        fin("unresolved", `reason="${d.kind} ${d.hubspotId} has no card after bounded retry"`);
        retryable ??= "unresolved";
        continue;
      }

      /**
       * ASK THE CARD, not just the mapping. The historical backfill placed entries without creating
       * mappings, so for anything it already imported the mapping says "never synced" while the card
       * plainly disagrees. Settling here makes the next pass cheap and stops the duplicate.
       */
      if (opts.verifyExisting && await alreadyOnCard(env, card.id, object, hubspotId)) {
        await settleActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId, "already-on-card");
        fin("skipped", `${d.kind}=${d.hubspotId} reason="already on the card from the historical import"`);
        continue;
      }

      const claim = await claimActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId);
      if (claim.status === "have") continue;
      if (claim.status === "creating") { retryable ??= "creating"; continue; }
      if (claim.status === "blocked") { retryable ??= "blocked"; continue; }

      try {
        const created = await gql(env,
          `mutation ($i: ID!, $a: String!, $t: String!, $s: String!, $c: String!, $ts: ISO8601DateTime!) {
             create_timeline_item(item_id:$i, custom_activity_id:$a, title:$t, summary:$s, content:$c,
                                  timestamp:$ts) { id } }`,
          { i: card.id, a: payload.custom_activity_id, t: payload.title, s: payload.summary,
            c: payload.content, ts: payload.timestamp }, 1);
        const timelineId = created?.create_timeline_item?.id;
        await settleActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId, String(timelineId ?? "created"));
        wrote++;
        fin("created", `item=${card.id} ${d.kind}=${d.hubspotId} timeline=${timelineId}`);
      } catch (e) {
        unresolvedActivityToMonday(object, hubspotId, d.kind, d.hubspotId, e);
        fin("error", `${d.kind}=${d.hubspotId} reason="${String(e).slice(0, 120)}"`);
        errored = true;
        continue;
      }

      // The follow-up helper is a CONTACT concept: it answers "has the person responsible for this
      // person reached out". A Company or Deal timeline entry says nothing about that.
      if (d.kind === "contact") await maybeMarkFollowUp(env, card.id, d.hubspotId, activity);
    }

    if (retryable) return retryable;
    if (errored) return "error";
    return wrote ? "created" : fin("skipped", 'reason="nothing left to write"');
  } catch (e) {
    /**
     * PRE-CREATE ONLY. Every send now has its own catch inside the loop, so anything reaching here
     * failed while READING — the record, the association, the participant classification. Nothing
     * was written, so it is retryable, and the durable retry re-runs the whole activity: cards
     * already settled are skipped by their own claims, so nothing is written twice.
     */
    return fin("unresolved", `reason="${String(e).slice(0, 140)}"`, "failed-before-create");
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
    const assigned = String(contact?.properties?.hubspot_owner_assigneddate ?? "").trim();
    const assignedMs = Date.parse(assigned);
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
    /**
     * RECORD THE CYCLE THAT SATISFIED THIS CONTACT, at the moment the helper is written.
     *
     * Without this, the owner-reset below has no baseline: the first reassignment after a qualifying
     * follow-up would read "never seen this contact" and, refusing to clear on a first sighting, would
     * hand the new owner the previous owner's satisfied state — the exact failure the reset exists to
     * prevent, on the very first case it has to handle.
     */
    await rememberOwnerCycle(env, contactId, `${owner}|${assigned}`);
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
      // The marker the secondary bounce guard reads back — written through the shared helper so the
      // producer and the consumer can never drift apart.
      [bodyProp]: `${text}\n\n${mondayOriginMarker(entry.id)}`,
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
    if (newId) await claimHubspotAsRepresented(env, object, newId, contactId, entry.id);
    log("pushed", `timeline=${entry.id} -> ${object}/${newId} contact=${contactId}`);
  } catch (e) {
    unresolvedActivityToHubspot(entry.id, e);
    log("error", `timeline=${entry.id} reason="${String(e).slice(0, 140)}"`);
  }
}

// ============================================================ owner reassignment

/**
 * CLEAR Last qualifying follow-up date WHEN, AND ONLY WHEN, THE CONTACT CHANGES HANDS.
 *
 * The helper column is a per-owner claim: "the person responsible for this contact has reached out
 * since they were made responsible". Leaving it behind on reassignment hands the new owner a
 * satisfied state they did not earn — the reminder never fires, and a customer sits with a rep who
 * has never contacted them. Nothing about that is visible: no error, no failed run, just a chase that
 * silently does not happen.
 *
 * WHY THE PAYLOAD IS NOT TRUSTED. monday emits update_column_value even for same-value writes, our
 * own reverse sync writes the owner back to HubSpot, and HubSpot fires propertyChange for writes that
 * change nothing. Treating any owner event as a reassignment would clear a legitimately satisfied
 * helper on an echo. So the decision is made against HubSpot's own state, stored durably:
 *
 *   cycle = "<hubspot_owner_id>|<hubspot_owner_assigneddate>"
 *
 * Same cycle as last seen -> an echo or an unrelated edit; the helper is preserved. A DIFFERENT cycle
 * is a genuine reassignment (both a new owner and a re-assignment to the same owner change it), and
 * only then is the column cleared. hubspot_owner_assigneddate is included because reassigning a
 * contact back to the same owner starts a new cycle that the owner id alone cannot express.
 *
 * FIRST SIGHTING CLEARS NOTHING. With no stored cycle we cannot tell a reassignment from the first
 * event we happen to observe, and the safe error is to leave a helper standing (one reminder not
 * sent) rather than to wipe one (a reminder chasing a rep who already did the work).
 */
export async function resetHelperOnReassignment(env: Env, contactId: string): Promise<void> {
  if (!activitySyncEnabled(env)) return;
  if (!inCanaryScope(env, contactId, undefined)) return;
  const log = (action: string, extra = "") =>
    console.log(`[activity] source=owner contact=${contactId} action=${action}${extra ? " " + extra : ""}`);
  try {
    const contact = await hs(env, "GET",
      `/crm/v3/objects/contacts/${contactId}?properties=hubspot_owner_id,hubspot_owner_assigneddate`,
      undefined, 2);
    const owner = String(contact?.properties?.hubspot_owner_id ?? "").trim();
    const assigned = String(contact?.properties?.hubspot_owner_assigneddate ?? "").trim();
    const cycle = `${owner}|${assigned}`;

    const seen = await lastOwnerCycle(env, contactId);
    if (seen === cycle) return;                       // echo, or an edit that left ownership alone
    await rememberOwnerCycle(env, contactId, cycle);
    if (seen === null) return log("baseline", `cycle="${cycle}"`);   // first sighting: clear nothing

    const card = (await findItemByColumn(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, contactId))[0];
    if (!card) return log("skipped", 'reason="no card"');

    // Read before writing. monday emits update_column_value even for a same-value write, so clearing
    // an already-empty column would wake this board's automations for nothing.
    const d = await gql(env,
      `query ($i: [ID!]) { items(ids: $i) { column_values(ids: ["${QUALIFYING_COL}"]) { text } } }`,
      { i: [card.id] }, 2);
    if (!String(d?.items?.[0]?.column_values?.[0]?.text ?? "").trim())
      return log("noop", `item=${card.id} reason="helper already empty"`);

    // {} is monday's clear for a complex column value; "" would be rejected on a date.
    await gql(env,
      `mutation ($b: ID!, $i: ID!, $c: JSON!) {
         change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
      { b: CRM_CONTACTS.boardId, i: card.id, c: JSON.stringify({ [QUALIFYING_COL]: {} }) }, 2);
    log("reset", `item=${card.id} from="${seen}" to="${cycle}"`);
  } catch (e) {
    // Same asymmetry as everywhere else in this file: never let an activity concern break the
    // ordinary contact sync sharing this webhook.
    log("error", `reason="${String(e).slice(0, 140)}"`);
  }
}
