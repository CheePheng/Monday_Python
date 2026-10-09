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
import { isPublicEmailDomain } from "./adopt";
import { normalizeDomain } from "./normalize";
import { gql, findItemByColumn } from "./monday";
import { releaseWorkedCard, WORK_RECENT_MS } from "./no-activity";
import { webhookOpts } from "./run-opts";
/** MondayRateLimitedError's name -- see monday.ts. */
const MONDAY_RATE_LIMITED = "MondayRateLimitedError";
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
 * IS THIS ACTIVITY THE LIVE SYNC'S TO WRITE? Yes if EITHER its own date OR the moment the HubSpot object
 * was created falls after the cutover. Refused only when BOTH predate it -- that is exactly what the
 * historical import already carried.
 *
 * It used to test the activity's own date (hs_timestamp) alone, and that lost real customer mail at
 * scale: when reps connected their inboxes on 2026-09-21/22, HubSpot imported their existing emails as
 * NEW objects carrying OLD dates -- 819 emails, 25% of all email since the cutover, 795 of them 30-365
 * days old. Created after the import finished, dated before the cutover: the import never saw them and
 * the live sync refused them, so they reached no card at all.
 *
 * Creation date alone would be wrong the other way: a task or meeting created BEFORE the cutover but due
 * after it was deliberately deferred by the import ("post-cutover, deferred: 718"), and would then be
 * refused by both. The union covers both gaps. Re-processing something the import did write is caught
 * by the durable registry and the on-card marker check, exactly as a re-delivered webhook is.
 */
export function activityIsLive(env: Env, p: Record<string, unknown>): boolean {
  return afterCutover(env, p.hs_timestamp) || afterCutover(env, p.hs_createdate);
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
  // hs_email_text is the BODY. Without it a synced email reaches monday as a subject line and a pair
  // of addresses, which is not enough for a rep to work from — the whole point of the migration is
  // that they never open HubSpot. The historical importer has always requested it; the live path did
  // not, so history had bodies and anything synced after the cutover did not.
  // Text, not HTML: strip() removes tags but leaves the CSS inside a <style> block as visible text,
  // so an HTML marketing email would render as a wall of stylesheet. The importer proved text alone
  // across 38,144 entries.
  emails: ["hs_timestamp", "hs_createdate", "hs_email_subject", "hs_email_direction", "hs_email_status",
    "hs_email_from_email", "hs_email_to_email", "hubspot_owner_id", "hs_sequence_id",
    "hs_object_source_user_id", "hs_email_text"],
  calls: ["hs_timestamp", "hs_createdate", "hs_call_title", "hs_call_body", "hs_call_direction", "hubspot_owner_id",
    "hs_object_source_user_id"],
  notes: ["hs_timestamp", "hs_createdate", "hs_note_body", "hubspot_owner_id", "hs_object_source_user_id"],
  meetings: ["hs_timestamp", "hs_createdate", "hs_meeting_title", "hs_meeting_body", "hubspot_owner_id",
    "hs_object_source_user_id"],
  tasks: ["hs_timestamp", "hs_createdate", "hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority",
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

export async function staffEmails(env: Env): Promise<Set<string>> {
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
/** Test-only: forget the cached owner list, so each test is judged on the owners it sets. */
export function resetStaffEmailCache(): void { ownerEmails = null; }

/**
 * THE COMPANY'S OWN DOMAINS: every domain a HubSpot owner's email uses, minus public mail providers.
 *
 * Derived from the owner list rather than hardcoded, so a new office domain is covered the day its
 * first owner is added. Public providers are removed so a rep on a gmail.com address cannot turn
 * every gmail.com company into "internal".
 */
export function internalDomains(staff: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const e of staff) {
    const d = normalizeDomain(e.split("@")[1] ?? "");
    if (d && !isPublicEmailDomain(d)) out.add(d);
  }
  return out;
}

/**
 * Company destinations that are the business ITSELF, not a customer, so an activity is not filed there.
 *
 * HubSpot auto-associates every email to the company matching the sender's domain, so the internal
 * "Test" company (16824787545, www.dkmeco.com, monday item 2855573545) became a destination for 2,310 of
 * the 3,054 eligible post-cutover activities -- 76% of everything synced. Every colleague's mail landed
 * on one Account: noise, a privacy problem, and a large share of the account-wide monday timeline write
 * capacity. The contact-card staff rule never covered it, because it only ever looked at contacts.
 *
 * FAILS OPEN, deliberately and unlike the staff read: if the domains cannot be read, the company stays a
 * destination. Filing a customer's email in one extra place is recoverable; silently dropping it is not.
 */
async function internalCompanyIds(env: Env, companyIds: string[], staff: Set<string>): Promise<Set<string>> {
  const internal = internalDomains(staff);
  if (!companyIds.length || !internal.size) return new Set();
  try {
    const r = await hs(env, "POST", "/crm/v3/objects/companies/batch/read",
      { properties: ["domain"], inputs: companyIds.map(id => ({ id })) }, 2);
    const out = new Set<string>();
    for (const c of r?.results ?? []) {
      const d = normalizeDomain(String(c?.properties?.domain ?? ""));
      if (d && internal.has(d)) out.add(String(c.id));
    }
    return out;
  } catch (e) {
    console.log(`[activity] action=internal-company-check-failed reason="${String(e).slice(0, 100)}" -- keeping all companies`);
    return new Set();
  }
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
/**
 * deferMirrorCheck — ACTIVITY_SKIP_MIRRORED_COPIES only, set by the ActivityRetry Durable Object on a
 * job's FIRST delivery and nowhere else (mayDeferMirror). A Company/Deal card linked to a Contact card
 * written by THIS pass is neither claimed nor written; the pass answers "deferred" and the next one, at
 * +MIRROR_SETTLE_MS, checks the card once monday's copy has had time to land.
 */
export interface SyncActivityOpts { ignoreCutover?: boolean; verifyExisting?: boolean; deferMirrorCheck?: boolean }

/**
 * Is this activity already represented on that card, according to the card itself?
 *
 * THREE ANSWERS, NOT TWO. This check is the last thing standing between a lost write response and a
 * duplicate, so "I could not tell" must never be reported as "absent" — that is the answer that
 * makes the caller write a second copy. Returning a bare boolean did exactly that: a failed read and
 * an exhausted page budget both came back `false`.
 *
 * The pagination needs guarding as well as bounding. monday's timeline pages OVERLAP — measured on a
 * production card, 36 pages returned 1,339 distinct entries and 449 repeated rows — so a page budget
 * covers far fewer distinct entries than its arithmetic suggests, and a cursor that stops advancing
 * would otherwise burn the whole budget on one page and then report "absent".
 */
export type CardCheck = "present" | "absent" | "unknown";

const MARKER_PAGES = 120;   // ~12k rows; generous because overlap means pages repeat themselves

/**
 * `bound` is for a caller racing a wall clock (the marketing poller, inside one cron invocation): a
 * `deadlineMs` after which the walk answers "unknown" instead of reading on, and a lower cap on monday
 * rate-limit waits per page. "unknown" is the fail-closed answer, so stopping early can never cause a
 * write. Omitted, the walk behaves exactly as it always has.
 */
export async function alreadyOnCard(env: Env, cardId: string, object: string,
    hubspotId: string, bound: { deadlineMs?: number; maxRateWaits?: number } = {}): Promise<CardCheck> {
  return (await scanCardForMarker(env, cardId, object, hubspotId, bound, false)).state;
}

/**
 * THE WALK BEHIND alreadyOnCard, which can also hand back the id of the entry it found.
 *
 * `withId` exists for the mirrored-copy check alone: settling a destination on monday's copy must record
 * that copy's timeline id, exactly as a create records its own. Without it the query is, byte for byte,
 * the one alreadyOnCard has always sent. `maxPages` lowers the page budget for a caller whose "unknown"
 * is cheap (the mirrored-copy check writes on it); omitted, it is MARKER_PAGES as before.
 */
async function scanCardForMarker(env: Env, cardId: string, object: string, hubspotId: string,
    bound: { deadlineMs?: number; maxRateWaits?: number; maxPages?: number }, withId: boolean):
    Promise<{ state: CardCheck; timelineId?: string }> {
  const marker = `[hubspot:${object}:${hubspotId}]`;
  const maxPages = bound.maxPages ?? MARKER_PAGES;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let p = 0; p < maxPages; p++) {
    if (bound.deadlineMs !== undefined && Date.now() > bound.deadlineMs) {
      console.log(`[activity] card=${cardId} ${object}=${hubspotId} action=marker-check-deadline`
        + ` reason="caller's time budget ran out after ${p} pages"`);
      return { state: "unknown" };
    }
    let page: any;
    try {
      const d: any = await gql(env,
        `query ($i: ID!, $c: String) { timeline(id: $i) { timeline_items_page(limit: 100, cursor: $c) {
            cursor timeline_items { ${withId ? "id content" : "content"} } } } }`, { i: cardId, c: cursor }, 2, bound.maxRateWaits ?? 6);
      page = d?.timeline?.timeline_items_page;
    } catch (e) {
      console.log(`[activity] card=${cardId} ${object}=${hubspotId} action=marker-check-failed`
        + ` reason="${String(e).slice(0, 90)}"`);
      return { state: "unknown" };            // fail CLOSED: the caller must not write on this
    }
    if (!page) return { state: "unknown" };   // no page at all is not evidence of absence
    for (const e of page.timeline_items ?? [])
      if (String(e?.content ?? "").includes(marker))
        return { state: "present", timelineId: e?.id != null && e.id !== "" ? String(e.id) : undefined };
    cursor = page.cursor ?? null;
    if (!cursor) return { state: "absent" };  // walked the whole timeline: genuinely not there
    if (seenCursors.has(cursor)) {
      console.log(`[activity] card=${cardId} ${object}=${hubspotId} action=marker-check-stalled`
        + ` reason="pagination repeated a cursor after ${p + 1} pages"`);
      return { state: "unknown" };
    }
    seenCursors.add(cursor);
  }
  console.log(`[activity] card=${cardId} ${object}=${hubspotId} action=marker-check-truncated`
    + ` reason="timeline longer than ${maxPages} pages"`);
  return { state: "unknown" };                // budget exhausted with pages still to come
}

// ============================================================ monday's own copy onto linked cards

/**
 * "true" stops the Worker writing a SECOND copy of a HubSpot activity onto an Account/Deal card that
 * monday has already copied it onto. Anything else -- including absent, the shipped "false" -- is the
 * behaviour before this existed, call for call.
 *
 * WHY. monday CRM copies each timeline entry created on a Contact card onto the Accounts and Deals linked
 * to that Contact AT THAT MOMENT (never onto links added later). The Worker also writes every activity
 * on each associated Company/Deal card, so a linked Account ended up with two copies (three, when monday
 * then copied the Worker's own Account entry back). Measured 2026-09-30: ~79 emails -> 138 extra copies
 * on 37 cards. Cosmetic -- but removing them afterwards is not: copies of one activity are LINKED, and
 * deleting one can take copies on other cards with it. Not making them is the only safe cleanup.
 *
 * THE RULE, and it is built so it can only ever cost the old duplicate, never a missing entry:
 *  - Only a Company/Deal card LINKED (contact_account / contact_deal) to a Contact card that HOLDS this
 *    activity -- written by this pass or settled by an earlier one -- is examined at all.
 *  - That card is then READ (the marker, bounded), and only "present" -- the copy is really there -- is
 *    settled and skipped, on the copy's own timeline id, so later passes answer "have".
 *  - "absent" and "unknown" write exactly as before. For THIS check "unknown" FAILS OPEN: a card we
 *    could not read gets its write, and the worst case is the duplicate we had. (alreadyOnCard's other
 *    callers fail closed, because there "unknown" may hide a write of our own.)
 *  - A link we could not read is "unknown" too: write.
 */
export const skipMirroredCopies = (env: Env) => env.ACTIVITY_SKIP_MIRRORED_COPIES === "true";

/** The Contacts board's native relation columns monday copies a Contact's timeline entries along. */
const CONTACT_LINK_COLS = ["contact_account", "contact_deal"];

/**
 * THE MIRRORED-COPY READ IS BOUNDED, because "unknown" is cheap here (it writes). The largest Accounts
 * measured take ~27 pages to walk end to end; beyond MIRROR_CHECK_PAGES, MIRROR_CHECK_MS or one monday
 * rate-limit wait the answer is "unknown" and the card is written, as it always was.
 */
const MIRROR_CHECK_PAGES = 30;
const MIRROR_CHECK_MS = 20_000;
const MIRROR_CHECK_RATE_WAITS = 1;

/**
 * For the Contact cards that hold this activity: linked Account/Deal card id -> EVERY one of those
 * Contact cards linking it (a Set, not the first seen -- which of them was written by this pass decides
 * whether the check waits). null when the links cannot be read: the caller then writes, as before.
 */
async function linkedFromContactCards(env: Env, contactCardIds: string[]):
    Promise<Map<string, Set<string>> | null> {
  const out = new Map<string, Set<string>>();
  if (!contactCardIds.length) return out;
  try {
    // `limit` is load-bearing: items(ids:) silently answers only the first 25 without it.
    for (let i = 0; i < contactCardIds.length; i += 100) {
      const d = await gql(env,
        `query ($i: [ID!]) { items(ids: $i, limit: 100) { id column_values(ids: ${JSON.stringify(CONTACT_LINK_COLS)}) {
            ... on BoardRelationValue { linked_item_ids } } } }`, { i: contactCardIds.slice(i, i + 100) }, 2);
      for (const it of d?.items ?? [])
        for (const cv of it?.column_values ?? [])
          for (const linked of cv?.linked_item_ids ?? []) {
            const k = String(linked);
            if (!out.has(k)) out.set(k, new Set());
            out.get(k)!.add(String(it.id));
          }
    }
    return out;
  } catch (e) {
    console.log(`[activity] action=mirror-link-read-failed reason="${String(e).slice(0, 100)}"`
      + " -- linked Company/Deal cards are written as before");
    return null;
  }
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
    if (!opts.ignoreCutover && !activityIsLive(env, p))
      return fin("skipped", `reason="before ACTIVITY_CUTOVER_AT" ts=${p.hs_timestamp} created=${p.hs_createdate}`);

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

    // The business's OWN company is not a destination either -- see internalCompanyIds.
    const companyIds = dests.filter(d => d.kind === "company").map(d => d.hubspotId);
    const internalCos = companyIds.length
      ? await internalCompanyIds(env, companyIds, await staffEmails(env).catch(() => new Set<string>()))
      : new Set<string>();
    if (internalCos.size) staff.push(...[...internalCos].map(id => `company:${id}`));
    let targets = dests.filter(d =>
      (d.kind !== "contact" || keepContacts.includes(d.hubspotId))
      && !(d.kind === "company" && internalCos.has(d.hubspotId)));
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
      // Same precedence as scripts/backfill-activities.mjs, so a live email and an imported one of
      // the same email produce the same entry. hs_email_text last: it is the only one an email has.
      body: strip(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body ?? p.hs_task_body
        ?? p.hs_email_text),
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

    /**
     * MONDAY'S OWN COPY (ACTIVITY_SKIP_MIRRORED_COPIES) -- see skipMirroredCopies for the rule. Flag off,
     * `mirror` is false and nothing below reads, logs or decides anything new.
     *
     * Contacts come first in `targets` (DEST_KINDS order), so by the time a Company or Deal is reached
     * every Contact card of this activity has been written, settled or passed over. Were that order ever
     * to change, a Company would simply see fewer holding Contacts and be written: the safe direction.
     */
    const mirror = skipMirroredCopies(env);
    const holding = new Set<string>();       // Contact cards holding this activity (written now or settled)
    const writtenNow = new Set<string>();    // ... the ones THIS pass wrote
    let links: Map<string, Set<string>> | null | undefined;   // undefined: not read yet
    /** The holding Contact cards linked to this card; null = links unreadable. Read once, lazily. */
    const linkersOf = async (cardId: string): Promise<Set<string> | null> => {
      if (!holding.size) return new Set();
      if (links === undefined) links = await linkedFromContactCards(env, [...holding]);
      if (links === null) return null;
      return new Set([...(links.get(cardId) ?? [])].filter(c => holding.has(c)));
    };
    const note = (action: string, extra: string) =>
      console.log(`[activity] source=hubspot ${object}=${hubspotId} action=${action} ${extra}`);
    let deferred = 0;

    for (const d of targets) {
      const card = cards.get(keyOf(d));
      if (!card) {
        fin("unresolved", `reason="${d.kind} ${d.hubspotId} has no card after bounded retry"`);
        retryable ??= "unresolved";
        continue;
      }
      const linkedKind = mirror && d.kind !== "contact";
      /** Set once a read of THIS card has already said "absent": the mirrored-copy check would only
       *  repeat it, and with verifyExisting a verified absence must be written, full stop. */
      let knownAbsent = false;

      /**
       * ASK THE CARD, not just the mapping. The historical backfill placed entries without creating
       * mappings, so for anything it already imported the mapping says "never synced" while the card
       * plainly disagrees. Settling here makes the next pass cheap and stops the duplicate.
       */
      if (opts.verifyExisting) {
        const seen = await alreadyOnCard(env, card.id, object, hubspotId);
        if (seen === "present") {
          if (mirror && d.kind === "contact") holding.add(card.id);
          await settleActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId, "already-on-card");
          fin("skipped", `${d.kind}=${d.hubspotId} reason="already on the card from the historical import"`);
          continue;
        }
        if (seen === "unknown") {             // could not establish: retry rather than risk a copy
          retryable ??= "unresolved";
          fin("unresolved", `${d.kind}=${d.hubspotId} reason="could not read the card's markers"`);
          continue;
        }
        knownAbsent = true;
      }

      /**
       * HOLD IT BACK, UNCLAIMED, when a Contact card linked to it was written a moment ago: monday's copy
       * may not have landed yet, and a check now would read "absent" and write the duplicate anyway.
       * Nothing is reserved, so the next pass (+MIRROR_SETTLE_MS, a full delivery) starts clean.
       */
      if (linkedKind && opts.deferMirrorCheck && !opts.verifyExisting && writtenNow.size) {
        const by = await linkersOf(card.id);
        const fresh = by ? [...by].filter(c => writtenNow.has(c)) : [];
        if (fresh.length) {
          deferred++;
          note("mirror-check-deferred", `item=${card.id} ${d.kind}=${d.hubspotId} via=${fresh.join(",")}`
            + ` reason="linked contact card written this pass; checking once monday's copy has landed"`);
          continue;
        }
      }

      const claim = await claimActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId);
      if (claim.status === "have") { if (mirror && d.kind === "contact") holding.add(card.id); continue; }
      if (claim.status === "creating") { retryable ??= "creating"; continue; }
      if (claim.status === "blocked") { retryable ??= "blocked"; continue; }

      /**
       * WE INHERITED AN ABANDONED RESERVATION, so a previous attempt may already have written and
       * merely lost its response. Look at the card before writing again, whatever the caller asked
       * for — the retry and webhook paths do not set verifyExisting, and this is the one moment a
       * duplicate can be made. Measured: under the historical import's load this produced 906
       * duplicated entries of 1,382 post-cutover emails.
       *
       * Only on the stale path: a fresh reservation cannot have a lost write behind it, so the
       * common case still costs no extra read.
       */
      if (claim.tookOverStale) {
        const seen = await alreadyOnCard(env, card.id, object, hubspotId);
        if (seen === "present") {
          if (mirror && d.kind === "contact") holding.add(card.id);
          await settleActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId, "already-on-card");
          fin("skipped", `${d.kind}=${d.hubspotId} reason="stale reservation, but the entry is already on the card"`);
          continue;
        }
        // Cannot tell, and a previous attempt may have written: writing now is how the duplicate is
        // made. Leave it for a later pass, when the read may succeed or the mapping may have settled.
        if (seen === "unknown") {
          retryable ??= "unresolved";
          fin("unresolved", `${d.kind}=${d.hubspotId} reason="stale reservation and the card could not be read"`);
          continue;
        }
        knownAbsent = true;
      }

      /**
       * HAS monday ALREADY COPIED IT HERE? Asked only of a Company/Deal card linked to a Contact card that
       * holds this activity, and answered by the card itself. Only "present" skips -- settled on the
       * copy's id, as a create settles on its own -- and every other answer writes, as before.
       */
      if (linkedKind && !knownAbsent) {
        const by = await linkersOf(card.id);
        if (by === null) {
          note("mirror-check-unknown", `item=${card.id} ${d.kind}=${d.hubspotId} reason="contact links unreadable; writing"`);
        } else if (by.size) {
          const via = [...by].join(",");
          const seen = await scanCardForMarker(env, card.id, object, hubspotId, {
            deadlineMs: Date.now() + MIRROR_CHECK_MS, maxPages: MIRROR_CHECK_PAGES,
            maxRateWaits: MIRROR_CHECK_RATE_WAITS }, true);
          if (seen.state === "present") {
            const found = seen.timelineId ?? "already-on-card";
            await settleActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId, found);
            note("mirrored-present", `item=${card.id} ${d.kind}=${d.hubspotId} timeline=${found} via=${via}`
              + ` reason="monday already copied it from a linked contact card; not writing a second copy"`);
            continue;
          }
          note(seen.state === "absent" ? "mirror-check-absent" : "mirror-check-unknown",
            `item=${card.id} ${d.kind}=${d.hubspotId} via=${via} reason="${seen.state === "absent"
              ? "no copy on the card (linked after the contact entry, or not landed); writing"
              : "card could not be read within the bound; writing"}"`);
        }
      }

      try {
        const created = await gql(env,
          `mutation ($i: ID!, $a: String!, $t: String!, $s: String!, $c: String!, $ts: ISO8601DateTime!) {
             create_timeline_item(item_id:$i, custom_activity_id:$a, title:$t, summary:$s, content:$c,
                                  timestamp:$ts) { id } }`,
          { i: card.id, a: payload.custom_activity_id, t: payload.title, s: payload.summary,
            c: payload.content, ts: payload.timestamp }, 1);
        const timelineId = created?.create_timeline_item?.id;
        await settleActivityToMonday(env, object, hubspotId, d.kind, d.hubspotId, String(timelineId ?? "created"));
        if (mirror && d.kind === "contact") { holding.add(card.id); writtenNow.add(card.id); }
        wrote++;
        fin("created", `item=${card.id} ${d.kind}=${d.hubspotId} timeline=${timelineId}`);
      } catch (e) {
        /**
         * RATE-LIMITED IS RETRYABLE, NOT "ERROR". Filing it as "error" -- the old behaviour -- meant never
         * retried: under repair load (catch-up, dedupe and People re-sync share one monday budget) the
         * entry was simply lost. The reservation is deliberately NOT released even though the request
         * most likely never ran: the retry schedule reaches the 15-minute stale takeover, which checks
         * the card before writing, so a mis-classified reply can still never become a second copy.
         */
        // By name, not instanceof: survives a bundler boundary and a mocked monday module alike.
        if ((e as Error)?.name === MONDAY_RATE_LIMITED) {
          retryable ??= "unresolved";
          fin("unresolved", `${d.kind}=${d.hubspotId} reason="monday rate limit; will retry after the reservation goes stale"`);
          continue;
        }
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
    /**
     * A HELD-BACK DESTINATION OUTRANKS "error": it was never attempted, and "deferred" brings the next
     * delivery back in MIRROR_SETTLE_MS. An errored destination's reservation still stands, so that pass
     * reads "creating" for it and writes nothing -- the same protection "unresolved" relies on above.
     */
    if (deferred)
      return fin("deferred", `held=${deferred} reason="linked Company/Deal cards checked on the next pass"`,
        "mirror-held");
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

    // The owner reached out: the card is worked, so it leaves "No Activity" (NO_ACTIVITY_RELEASE) -- for RECENT
    // outreach only (WORK_RECENT_MS: a replayed old email is not today's work). Before the helper's no-churn
    // return below: a second outbound email on the same day is still a new piece of work, and the nightly sweep
    // may have put the card back since the first. Never throws.
    const sentAt = Date.parse(String(activity.timestamp ?? ""));
    if (Number.isFinite(sentAt) && Date.now() - sentAt <= WORK_RECENT_MS)
      await releaseWorkedCard(env, CRM_CONTACTS, itemId, undefined,
        `the owner's outbound ${activity.object === "calls" ? "call" : "email"} synced`, webhookOpts(env));

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
 * Woken by a wake-up column (the Activity bell, or Last Activity Date -- webhooks.ts ACTIVITY_WAKE_COLS),
 * a person's edit, or POST /wake-timeline: read ONE contact's timeline and push anything native we have
 * not pushed before.
 *
 * The date is only a doorbell. It is never read as the activity, and never used for qualification —
 * the durable registry decides what is new, so repeated wake-ups cost one timeline read and create
 * nothing twice.
 *
 * Returns the outcome as a short line (the same words it logs), for the catch-up route to report.
 */
/**
 * Timeline entries per page (monday's own default, 25) and pages per wake. scripts/wake-timelines.mjs
 * reads with the same two numbers (wake-timeline.test.ts pins it), so a card the script finds work on
 * is a card this read reaches.
 */
export const TIMELINE_PAGE = 25;
export const TIMELINE_MAX_PAGES = 4;

export async function syncMondayTimeline(env: Env, itemId: string): Promise<string> {
  const log = (action: string, extra = "") => {
    const line = `action=${action}${extra ? " " + extra : ""}`;
    console.log(`[activity] source=monday item=${itemId} ${line}`);
    return line;
  };
  try {
    // PAGED, newest first. One default page (25) was all this read, so on a contact flooded with
    // marketing or HubSpot entries a rep's note could sit past it and never be pushed. Pages go on only
    // while every entry read is still after the activity cutover -- older ones are never pushed -- so an
    // ordinary card still costs one read.
    const entries: any[] = [];
    let cursor: string | null = null;
    for (let p = 0; p < TIMELINE_MAX_PAGES; p++) {
      const d = await gql(env,
        `query ($i: ID!, $l: Int, $c: String) { timeline(id: $i) { timeline_items_page(limit: $l, cursor: $c) {
            cursor timeline_items { id type title content custom_activity_id created_at } } } }`,
        { i: itemId, l: TIMELINE_PAGE, c: cursor }, 2);
      const page = d?.timeline?.timeline_items_page;
      const items: any[] = page?.timeline_items ?? [];
      entries.push(...items);
      cursor = page?.cursor ? String(page.cursor) : null;
      if (!cursor || !items.length || items.some(e => !afterCutover(env, e?.created_at))) break;
    }
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

    let pushed = 0;
    for (const entry of fresh) if (await pushOne(env, itemId, contactId, entry, log)) pushed++;
    return `action=done pushed=${pushed} fresh=${fresh.length} contact=${contactId}`;
  } catch (e) {
    return log("error", `reason="${String(e).slice(0, 140)}"`);
  }
}

/**
 * IS THIS monday ENTRY ALREADY IN HUBSPOT? For a stale m2h reservation only (pushOne), so the common
 * path pays nothing.
 *
 * The search is narrow on purpose: the contact's own notes/calls whose hs_timestamp is the entry's
 * created_at (which is what pushOne writes, +-1 s), then the origin marker in the body decides -- a
 * timestamp alone could be a rep's own note from the same second. More than one page of candidates,
 * a failed search or an entry with no usable date is "unknown", and the caller creates nothing.
 * HubSpot's search index lags seconds; a reservation goes stale only after 15 minutes.
 */
async function alreadyInHubspot(env: Env, object: string, bodyProp: string, contactId: string, entry: any)
    : Promise<{ state: "present"; id: string } | { state: "absent" } | { state: "unknown"; why: string }> {
  const ts = Date.parse(String(entry?.created_at ?? ""));
  if (!Number.isFinite(ts)) return { state: "unknown", why: "entry has no usable created_at" };
  const marker = mondayOriginMarker(String(entry.id));
  try {
    const r = await hs(env, "POST", `/crm/v3/objects/${object}/search`, {
      filterGroups: [{ filters: [
        { propertyName: "associations.contact", operator: "EQ", value: contactId },
        { propertyName: "hs_timestamp", operator: "GTE", value: ts - 1000 },
        { propertyName: "hs_timestamp", operator: "LTE", value: ts + 1000 },
      ] }],
      properties: [bodyProp], limit: 100,
    }, 2);
    const hit = (r?.results ?? []).find((x: any) => String(x?.properties?.[bodyProp] ?? "").includes(marker));
    if (hit?.id) return { state: "present", id: String(hit.id) };
    if (r?.paging?.next?.after) return { state: "unknown", why: "more candidates than one page" };
    return { state: "absent" };
  } catch (e) {
    return { state: "unknown", why: String(e).slice(0, 80) };
  }
}

/** True only when this call created the HubSpot object. */
async function pushOne(env: Env, itemId: string, contactId: string, entry: any,
    log: (a: string, e?: string) => unknown): Promise<boolean> {
  const object = HUBSPOT_OBJECT_FOR_NATIVE[String(entry.type)];
  if (!object) return false;

  const claim = await claimActivityToHubspot(env, entry.id);
  if (claim.status === "have") return false;                 // already pushed — the common case
  if (claim.status === "creating") { log("skipped", `timeline=${entry.id} reason="mid-create"`); return false; }
  if (claim.status === "blocked") { log("deferred", `timeline=${entry.id} reason="idempotency store unavailable"`); return false; }
  const bodyProp = object === "notes" ? "hs_note_body" : "hs_call_body";

  /**
   * WE INHERITED AN ABANDONED RESERVATION: an earlier create may have landed and lost its response (a
   * timeout under load; a settle that failed, which settle only logs). The HubSpot -> monday side has
   * checked the destination here since the 906 doubled emails (see alreadyOnCard); this side did not,
   * and the wake-ups on one card multiplied on 2026-09-30 -- the bell with its trailing re-read, the
   * person doorbell, our own Last Activity Date writes, POST /wake-timeline catch-ups. So look in
   * HubSpot for the marker the body carries before creating again. Found: settle to it. Cannot tell:
   * create NOTHING -- the reservation (ours now) goes stale again and a later wake re-checks.
   */
  if (claim.tookOverStale) {
    const seen = await alreadyInHubspot(env, object, bodyProp, contactId, entry);
    if (seen.state === "present") {
      await settleActivityToHubspot(env, entry.id, seen.id);
      log("skipped", `timeline=${entry.id} -> ${object}/${seen.id} reason="stale reservation, but it is already in HubSpot"`);
      return false;
    }
    if (seen.state === "unknown") {
      log("deferred", `timeline=${entry.id} reason="stale reservation and HubSpot could not be checked: ${seen.why}"`);
      return false;
    }
  }

  try {
    const text = strip(entry.content) || strip(entry.title) || "(no content)";
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
    return true;
  } catch (e) {
    unresolvedActivityToHubspot(entry.id, e);
    log("error", `timeline=${entry.id} reason="${String(e).slice(0, 140)}"`);
    return false;
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
