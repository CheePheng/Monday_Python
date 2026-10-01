/**
 * PUT BACK THE HUBSPOT ACTIVITY ENTRIES THE TIMELINE DEDUPE REMOVED ENTIRELY. Dry run unless --apply / --canary.
 *
 * WHY. dedupe-timeline.mjs deletes the extra copies of a `[hubspot:<object>:<id>]` marker on a card and is built
 * never to delete the last one. On monday's side, though, deleting one copy sometimes took EVERY copy on that
 * card with it. Example: Contacts card 2855768833 no longer holds any copy of emails 249725616858,
 * 249734315755 and 81048586859 (the 2025 "Hello from Theobald" thread), although HubSpot still has all three and
 * still links them to that contact. The read-only damage census (damage-census.json: one row per (card, marker)
 * a dedupe run deleted from, state alive | LOST | unknown) lists them. This script puts back the LOST ones, one
 * entry per (card, marker), and nothing else.
 *
 * THE WORKER CANNOT DO IT. /resync-activity refuses anything older than ACTIVITY_CUTOVER_AT (2026-09-16T11:16:48Z),
 * and most of what was lost is history the backfill placed. So this script writes the entry itself, and it has to
 * write it EXACTLY as the original writer did. Otherwise the next dedupe finds two different copies of one
 * marker ("divergent"), and a rep sees an entry that reads differently from its siblings on the account and deal.
 *   - WHICH WRITER. The backfill's own checkpoint (scripts/.backfill-activities-state.json, `processed`) lists
 *     every activity the backfill finished, and those are rebuilt the backfill's way. Everything else is the
 *     live Worker's: activityIsLive (dated or created at/after the cutover), or any task, since the Task poller
 *     places tasks whatever their date. An activity in neither group has both dates before the cutover but is
 *     missing from the checkpoint. Only the backfill writes those, so it is built the backfill's way and
 *     flagged (writerFlag). The checkpoint and activityIsLive are FIRM (the backfill never writes at/after the
 *     cutover); the task rule and the neither-group rule are fallbacks, which a surviving copy may overrule.
 *   - THE BUILDERS ARE VERBATIM COPIES. payloadFor + strip + PROPS from scripts/backfill-activities.mjs
 *     (:294-316, :76, :62-70; summary "" at :357). For the live path: timelinePayload + taskTimestamp from
 *     src/activities.ts (:157-181, :45-48), plus PROPS, strip and the timelinePayload call from
 *     src/activity-sync.ts (:138-147, :180-181, :488-508). The backfill cannot be imported because it runs when
 *     loaded, and the Worker is TypeScript, so they are copied. At start each copy is compared with its source
 *     text (function bodies via Function.prototype.toString, whitespace-insensitive) and so are the placement
 *     rules (below). Any drift refuses --apply and prints a WARNING on a dry run.
 *   - A SURVIVING COPY IS THE PROOF. Neither builder's output depends on the card, only on the activity. So a
 *     copy of the same marker still alive on ANOTHER card (its id comes from the census or the dedupe reports)
 *     is exactly what the writer produced. When one is found, it is read (timeline_item) and compared on type,
 *     title, content and created_at (to the second):
 *       it matches the chosen writer's build: go.
 *       it matches the OTHER writer's build: WHICH writer placed a card can differ for one activity (the
 *         backfill indexed its cards once, at its start; the Task poller and the post-2026-09-23 catch-up fill
 *         cards it missed). So the copy decides only when the rule was a fallback (not in the checkpoint and no
 *         post-cutover date, or a task by the poller rule), and writerBy says so. When the rule is firm (the
 *         checkpoint, or activityIsLive), the pair is HELD (held-writer-conflict) with both titles: the builds
 *         differ exactly where a subject is missing, so a wrong pick would give this card the wrong title.
 *       it is the pre-2026-09-23 live build (emails with no body, because hs_email_text was not requested then):
 *         the current live build goes out, with the body -- the copy the dedupe keeps when both exist. That is NOT
 *         an exact restore (this card's lost copy was probably bodyless too), so it has its own outcome,
 *         would-create-body-upgrade / created-body-upgrade, for the person approving to see. On a firm
 *         backfill rule it is held-writer-conflict instead.
 *       it matches neither: HELD (held-sibling-differs). The report says which fields differ, e.g. HubSpot
 *         changed since then, such as a new owner id.
 *     monday keeps content as HTML text ("&" comes back as "&amp;", ">" as "&gt;"), so "matches" means equal once
 *     the entities are decoded. That was checked against 57 surviving entries of all five types on 2026-09-27:
 *     every one equals its rebuild (see `shown`). monday also drops leading whitespace from the content: an entry
 *     with no header line (a note or meeting without an owner) is built "\n<body>..." and stored "<body>...", so
 *     content is compared without it (see `shownContent`; 1 of 942 sampled entries needed it). What is SENT is
 *     always the writer's content, unchanged: monday trims the restore as it trimmed the original.
 *   - NO SURVIVING COPY (sibling none-found) means nothing shows that HubSpot's record is still what the writer
 *     read. Activities do change later: meetings get rescheduled, tasks get completed (a new timestamp and
 *     Status/Completed lines). So HubSpot's hs_lastmodifieddate is compared with the earliest moment the
 *     original can have been written (max of ACTIVITY_CUTOVER_AT and hs_createdate: neither writer wrote before
 *     the cutover, and the backfill's checkpoint startedAt is not a safe bound because a --reset discards an
 *     earlier start). Modified after that, the property history (propertiesWithHistory, GET) of every property
 *     the writer reads is looked at: any value set after that moment -- a first value only when it arrived more
 *     than INITIAL_GRACE_MS later, since an API-made activity gets its properties seconds after creation --
 *     HOLDS the pair (held-changed-since-write, naming the properties). No history to judge by holds it too
 *     (held-unproven). The report keeps what was judged under `unproven`.
 *
 * WHAT IS SKIPPED OR HELD, never written, every one reported with its reason:
 *   - the card is gone, archived, on another board, or carries no HubSpot ID;
 *   - the activity no longer exists in HubSpot, or HubSpot no longer links it to that card's record;
 *   - the writer's own rules would not file it on that card: a staff contact (an owner's email) for either
 *     writer; for the live writer, also the business's own company (an owner email domain) and an activity that
 *     originated from a monday timeline entry;
 *   - no usable timestamp; content with an unclosed "<" + letter, "/", "!" or "?" ("<b", "</x", "<!--", "<?"),
 *     where monday would cut the text off and drop the marker with it (strip() removed every closed tag, so any
 *     such "<" left in the content opens a construct that never closes);
 *   - STILL PRESENT. First, every timeline id any dedupe report or the census knows for that (card, marker) must
 *     answer NOT_FOUND to timeline_item(id). Any id that resolves means skip. Second, a full walk of the card's
 *     timeline listing must not show the marker. Both are checked again right before a create (the listing
 *     walked again when the cached walk is over LISTING_MAX_AGE_MS old).
 *   - A LOSSY LISTING (held-lossy-listing unless --allow-lossy). Past one page (~50 entries) the listing's
 *     cursor is an offset that advances by rows returned while pages overlap, so a share of the entries on a big
 *     card (measured: 244+ of 1085 on card 2855606710, ~22%) is never returned, and always the same ones. BOTH
 *     checks are blind to those: the dedupe reports' ids came from the same listing, so a copy the listing
 *     always hides is unknown to the by-id check as well. The walk counts rows returned (the card's real size)
 *     against distinct rows; when they differ it walks again at page size 40 and keeps the union (a few more
 *     rows). A card is lossy when it took more than one page or rows went unseen; the report gives, per card,
 *     rowsReturned, distinctRows, unseenRows, pages and lossy. On such a card a person must look in monday's UI
 *     for an existing copy, then pass --allow-lossy (with --cards for that card);
 *   - restored before: every earlier *-timeline-restore-applied*.json is read, and a writing run refuses to
 *     start when one cannot be parsed (it would lose that run's new ids). An entry it created that still
 *     resolves is skipped (skipped-already-restored). One that no longer resolves is held
 *     (held-previous-restore-gone), because something removed it and a person should look before a second
 *     copy goes out. A create that was sent but whose answer was lost is held too
 *     (held-previous-create-uncertain): create-uncertain, and any item saved as create-sent (or with
 *     createSentAt) but no newId -- a run killed mid-create.
 *   - a task created or modified within the Worker's daily Task sweep window (SWEEP_WINDOW_DAYS in
 *     src/task-poller.ts) is flagged (taskSweepWindow): the sweep (ignoreCutover + verifyExisting, on the same
 *     lossy listing) may place that entry on its own. Look at the card before and after.
 *
 * WRITING (--apply: every item that passes; --canary: exactly ONE entry, then stop). Both refuse unless
 * MONDAY_API_TOKEN is the integration user 104118038 (lib/repair-preflight.mjs requireIntegrationToken), and
 * both take docs/rollout/.timeline-restore.lock (refused while another run holds it; removed on exit). This
 * does not go through the Worker, so requireNewBuild does not apply. The create is the originals' mutation
 * (create_timeline_item: item, custom_activity_id, title, summary "", content, timestamp = the original
 * time). The item is saved as create-sent (createSentAt) BEFORE the request, and its newId the moment monday
 * answers with one, so no later failure -- an abort, a crash, Ctrl-C -- can lose a create that went out. It is
 * sent ONCE, and re-sent only when monday proves it did not run: HTTP 429, or a rate/complexity/concurrency/
 * budget refusal below 500 with no error raised while executing (no error `path`). A GraphQL parse/validation
 * error is not-run too, and not retried. Anything else -- a network failure, a timeout, a 5xx, an execution
 * error inside a 200 -- may have landed, so it is never repeated: the card is walked again; if the marker is
 * there its id is recorded, and if not the item ends create-uncertain and a re-run holds it. Every create is
 * then read back with timeline_item(newId), and the new id is recorded together with whether monday kept the
 * marker and stored what was sent (as shown). One (card, marker) is never created twice in a run. 401/403/daily
 * limit stops the run; the items already in flight finish and are recorded. The first Ctrl-C does the same; a
 * second quits at once.
 *
 * HubSpot is only ever read (GET, nothing else). No credential or secret-bearing URL is printed.
 *
 *   node scripts/restore-timeline-entries.mjs --census <damage-census.json>               # dry run: what it would create
 *   node scripts/restore-timeline-entries.mjs --census <file> --limit 3                   # dry run, first 3 pairs
 *   node scripts/restore-timeline-entries.mjs --census <file> --cards 2855768833 --canary # create ONE, then stop and look
 *   node scripts/restore-timeline-entries.mjs --census <file> --apply                     # create them all
 *   options: --cards a,b            only these card ids
 *            --markers-file <path>  only these: one per line, "[hubspot:emails:1]" (that marker on every card) or
 *                                   "<card> [hubspot:emails:1]" (that pair); # comments; a JSON array of the same
 *            --limit N              the first N (card, marker) pairs, in (card, marker) order
 *            --concurrency N        cards in flight, default 2, max 6 (1 with --canary)
 *            --allow-lossy          also restore on cards whose listing is lossy -- only after a person has
 *                                   looked at each such card in monday for an existing copy
 * An empty selection is refused, never read as "all". The report is saved after every item (written to a .tmp
 * file and renamed over it, so a kill never leaves it half-written) to
 * docs/rollout/<date>-timeline-restore-<plan|applied>[-HHMMSS].json, and an earlier one is never overwritten.
 * The dry run applies every hold the writing run would, so the plan is what --apply would do.
 * Re-running the same command resumes: restored pairs are skipped, failed ones are tried again.
 *
 * Needs HUBSPOT_CRM_APP_TOKEN and MONDAY_API_TOKEN in worker/.dev.vars.
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireIntegrationToken } from "./lib/repair-preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROLLOUT = join(ROOT, "..", "docs", "rollout");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** ACTIVITY_CUTOVER_AT: backfill-activities.mjs:48, the deploy's --var, TASK_POLL_SEED in src/task-poller.ts. */
export const CUTOVER_ISO = "2026-09-16T11:16:48Z";
const CUTOVER = Date.parse(CUTOVER_ISO);
/** A property's FIRST value counts as a later change only when it arrived this long after the earliest write. */
const INITIAL_GRACE_MS = 5 * 60_000;
/** The pre-create re-check walks the card again when its cached walk is older than this. */
const LISTING_MAX_AGE_MS = 5 * 60_000;
/** A monday timeline entry id. Anything else in a report (e.g. a string spread into characters) is not one. */
const TIMELINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SWEEP_WINDOW_DAYS in src/task-poller.ts, READ from that file at start (see sourceDrift); 365 until then. */
let SWEEP_WINDOW_DAYS = 365;

/** OUR custom activity types: MONDAY_ACTIVITY_TYPE in src/activities.ts == ACTIVITY_TYPE in backfill-activities.mjs. */
export const OUR_TYPE = {
  emails: "eaca46da-4695-4386-8dd4-a3fa088d31ce",
  notes: "ca35c3ab-476a-4718-9b38-67ee945593d4",
  calls: "1e0d9eca-222b-4f8b-85c8-4f7947e83595",
  meetings: "7314447b-685c-4c58-9e38-80ad162d8fc4",
  tasks: "5f0e2267-8cea-45fa-bb54-2b1a29324a34",
};
/** The names the two copied builders use for that table. */
const ACTIVITY_TYPE = OUR_TYPE, MONDAY_ACTIVITY_TYPE = OUR_TYPE;

/** The census's board kinds. idCol is checked against src/config/crm.ts at start. */
export const BOARD = {
  contacts:  { board: "5028000495", idCol: "text_mm6t71dj", assoc: "contacts" },
  companies: { board: "5028000496", idCol: "text_mm6tsnwx", assoc: "companies" },
  deals:     { board: "5028000494", idCol: "text_mm76kxz4", assoc: "deals" },
};
/**
 * The objects this script can rebuild -- each from /crm/v3/objects/{object}/{id}. The marketing email
 * objects are deliberately ABSENT: their entries come from the legacy Email Events API, there is no CRM
 * object to rebuild them from, so a "LOST" marketing marker is refused rather than guessed at.
 *
 * The id stays DIGITS ONLY. Every CRM object id is numeric, and this script WRITES: a marker such as
 * [hubspot:emails:abc] is a malformed input to report, never an id to fetch and rebuild an entry from.
 * Only the --markers-file parse below reads the wider [A-Za-z0-9_-]+, so that a marketing marker reaches
 * its own refusal rather than a generic "cannot read".
 */
export const MARKER_RE = /^\[hubspot:(emails|calls|notes|meetings|tasks):(\d+)\]$/;
export const MARKETING_MARKER_RE = /^\[hubspot:marketing_email[a-z_]*:[A-Za-z0-9_-]+\]$/;

// ================================================================== the two writers, copied verbatim
/** backfill-activities.mjs:62-70 -- the properties the historical import read. */
export const PROPS_BACKFILL = {
  emails: ["hs_timestamp", "hs_email_subject", "hs_email_direction", "hs_email_from_email",
    "hs_email_to_email", "hubspot_owner_id", "hs_sequence_id", "hs_email_text"],
  calls: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_direction", "hubspot_owner_id"],
  notes: ["hs_timestamp", "hs_note_body", "hubspot_owner_id"],
  meetings: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hubspot_owner_id"],
  tasks: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority",
    "hs_task_type", "hs_task_completion_date", "hubspot_owner_id"],
};
/** src/activity-sync.ts:138-147 -- the properties the live Worker reads. */
export const PROPS_LIVE = {
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
/** One HubSpot read serves both builders; each is then handed ONLY the properties its writer requested.
 *  hs_lastmodifieddate is read for the "changed since it was written" judgement, never built from. */
const PROPS_READ = Object.fromEntries(Object.keys(PROPS_LIVE).map(t =>
  [t, [...new Set([...PROPS_BACKFILL[t], ...PROPS_LIVE[t], "hs_lastmodifieddate"])]]));
const pick = (p, keys) => Object.fromEntries(keys.filter(k => k in p).map(k => [k, p[k]]));

/** backfill-activities.mjs:76 == src/activity-sync.ts:180-181 (the same expression in both). */
const strip = (h) => String(h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** backfill-activities.mjs:294-316, verbatim. */
function payloadFor(type, id, p) {
  const ts = type === "tasks"
    ? (String(p.hs_task_completion_date ?? "").trim() || String(p.hs_timestamp ?? "").trim())
    : String(p.hs_timestamp ?? "").trim();
  const body = strip(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body ?? p.hs_task_body ?? p.hs_email_text);
  const lines = [
    p.hs_email_from_email ? `From: ${p.hs_email_from_email}` : "",
    p.hs_email_to_email ? `To: ${p.hs_email_to_email}` : "",
    p.hs_email_direction ?? p.hs_call_direction ? `Direction: ${p.hs_email_direction ?? p.hs_call_direction}` : "",
    p.hubspot_owner_id ? `HubSpot owner: ${p.hubspot_owner_id}` : "",
    p.hs_sequence_id ? `Sequence ${p.hs_sequence_id} — informational, does not count as follow-up` : "",
    p.hs_task_status ? `Status: ${p.hs_task_status}` : "",
    p.hs_task_type ? `Task type: ${p.hs_task_type}` : "",
    p.hs_task_priority && p.hs_task_priority !== "NONE" ? `Priority: ${p.hs_task_priority}` : "",
    type === "tasks" && p.hs_timestamp ? `Due: ${p.hs_timestamp}` : "",
    p.hs_task_completion_date ? `Completed: ${p.hs_task_completion_date}` : "",
    body ? `\n${body}` : "",
    `\n[hubspot:${type}:${id}]`,
  ].filter(Boolean);
  const title = p.hs_email_subject ?? p.hs_call_title ?? p.hs_meeting_title ?? p.hs_task_subject
    ?? (body ? body.slice(0, 80) : "(no subject)");
  return { ts, title: String(title).slice(0, 250), content: lines.join("\n") };
}

/** The backfill's create arguments: ACTIVITY_TYPE[type], summary "" (backfill-activities.mjs:357-361). */
export function backfillEntry(type, id, p) {
  const { ts, title, content } = payloadFor(type, id, pick(p, PROPS_BACKFILL[type]));
  return { custom_activity_id: ACTIVITY_TYPE[type], title, summary: "", content, timestamp: ts };
}

/** src/activities.ts:45-48, body verbatim. */
function taskTimestamp(p) {
  const done = String(p.hs_task_completion_date ?? "").trim();
  return done || (String(p.hs_timestamp ?? "").trim() || undefined);
}

/** src/activities.ts:157-181, body verbatim (the TypeScript signature dropped). */
function timelinePayload(a, fields) {
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

/**
 * The live Worker's entry: src/activity-sync.ts:488-508 verbatim (only the `: HsActivity` annotation dropped),
 * fed the properties that path requests. `withoutEmailBody` rebuilds what the pre-2026-09-23 build wrote, which
 * never requested hs_email_text. It is used only to recognise such a copy, never to write one.
 */
export function liveEntry(object, hubspotId, p0, withoutEmailBody = false) {
  const p = pick(p0, PROPS_LIVE[object].filter(k => !(withoutEmailBody && k === "hs_email_text")));
  const activity = {
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
  return payload;
}

// ------------------------------------------------------------------ the writers' placement rules, copied
/** src/activity-sync.ts:161 -- the live path skips an activity made FROM a monday entry (:411-412). */
const MONDAY_ORIGIN_RE = /\[monday timeline ([A-Za-z0-9_-]{1,64})\]/;
/** src/normalize.ts:3-11, body verbatim. */
function normalizeDomain(raw) {
  if (!raw) return "";
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");   // strip scheme (http://, https://, etc.)
  d = d.replace(/^www\./, "");          // strip a single leading www.
  d = d.replace(/[/?#].*$/, "");        // strip path/query/fragment
  d = d.replace(/[.\s]+$/, "");         // strip trailing dots/whitespace
  return d;
}
/** src/adopt.ts:108-116, READ from that file at start (data, not a copy); empty until then. */
let PUBLIC_EMAIL_DOMAINS = new Set();
/** src/adopt.ts:119-124, body verbatim. */
function isPublicEmailDomain(d) {
  if (!d) return false;
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return true;
  for (const p of PUBLIC_EMAIL_DOMAINS) if (d.endsWith("." + p)) return true;
  return false;
}
/** src/activity-sync.ts:222-229 (internalDomains), the business's own domains from the owners' emails. */
function internalDomains(staff) {
  const out = new Set();
  for (const e of staff) {
    const d = normalizeDomain(e.split("@")[1] ?? "");
    if (d && !isPublicEmailDomain(d)) out.add(d);
  }
  return out;
}

// ------------------------------------------------------------------ comparing an entry with a build
const sec = x => { const t = Date.parse(String(x ?? "")); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
/**
 * WHAT MONDAY SHOWS, which is not always the bytes it was sent. It keeps content as HTML text. What was sent is
 * decoded and then re-escaped, so "&" comes back as "&amp;" and ">" as "&gt;", while "&amp;" sent literally
 * comes back unchanged. Measured 2026-09-27 on 57 surviving entries: each one equals its rebuild once both
 * sides are decoded, and none equals it without decoding when the text holds "&" or ">". So two entries are the
 * same when their decoded forms are. A named entity outside this short list stays undecoded on both sides. In
 * that case a real match can read as "differs", which holds the item, and never the reverse.
 */
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const shown = s => String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  try { return String.fromCodePoint(n); } catch { return m; }
});
/** Content as shown, less the leading whitespace monday drops: a build with no header line starts "\n<body>",
 *  and monday stores it from "<body>" (measured on note 71776200225, copy cd607052 on card 2855614130). */
export const shownContent = s => shown(s).replace(/^\s+/, "");
/** The same entry a rep would see: type, title, content (as shown), and created_at to the second (monday keeps seconds). */
export const sameEntry = (e, b) => !!e && !!b && e.custom_activity_id === b.custom_activity_id
  && shown(e.title) === shown(b.title) && shownContent(e.content) === shownContent(b.content)
  && sec(e.created_at) !== null && sec(e.created_at) === sec(b.timestamp);
export function differences(e, b) {
  const out = [];
  if (e.custom_activity_id !== b.custom_activity_id) out.push(`type (copy ${e.custom_activity_id} vs built ${b.custom_activity_id})`);
  if (shown(e.title) !== shown(b.title))
    out.push(`title (copy ${JSON.stringify(String(e.title ?? "").slice(0, 60))} vs built ${JSON.stringify(String(b.title ?? "").slice(0, 60))})`);
  const a = shownContent(e.content), c = shownContent(b.content);
  if (a !== c) {
    let i = 0; while (i < a.length && i < c.length && a[i] === c[i]) i++;
    out.push(`content (copy ${a.length} chars, built ${c.length}; first difference at ${i}: copy `
      + `${JSON.stringify(a.slice(i, i + 40))} vs built ${JSON.stringify(c.slice(i, i + 40))})`);
  }
  if (sec(e.created_at) === null || sec(e.created_at) !== sec(b.timestamp))
    out.push(`created_at (copy ${e.created_at} vs built ${b.timestamp})`);
  return out;
}
const sha = s => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
/** monday cuts content at an unclosed "<" + letter, and the marker line goes with it. "</x", "<!--" and "<?"
 *  open a construct an HTML parser swallows to the end just the same. strip() removed every closed tag, so any
 *  of these that is left never closes. */
const WOULD_TRUNCATE = /<[A-Za-z\/!?]/;

// ================================================================== drift: every copy above vs its source
const squash = s => String(s).replace(/\s+/g, " ").trim();
/** The text between a function's first "{" (after `anchor`) and its matching "}". */
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const open = src.indexOf("{", at + anchor.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}
const ownBody = fn => { const s = fn.toString(); return s.slice(s.indexOf("{") + 1, s.lastIndexOf("}")); };
/** The key -> [strings] table of a PROPS literal, starting at `anchor`. */
function propsIn(src, anchor) {
  const block = bodyAfter(src, anchor);
  if (block == null) return null;
  const out = {};
  for (const m of block.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  return out;
}
/** The live call site: from `const activity...= {` to the end of the timelinePayload(...) call. */
function callSite(src, start) {
  const a = src.indexOf(start);
  if (a < 0) return null;
  const call = src.indexOf("const payload = timelinePayload(activity, {", a);
  const end = call < 0 ? -1 : src.indexOf("});", call);
  return end < 0 ? null : src.slice(a, end + 3);
}

export function sourceDrift() {
  const read = rel => { try { return readFileSync(join(ROOT, rel), "utf8"); } catch { return null; } };
  const f = {
    backfill: read("scripts/backfill-activities.mjs"), activities: read("src/activities.ts"),
    sync: read("src/activity-sync.ts"), normalize: read("src/normalize.ts"), adopt: read("src/adopt.ts"),
    crm: read("src/config/crm.ts"), poller: read("src/task-poller.ts"),
  };
  const drift = [];
  for (const [k, s] of Object.entries(f)) if (s == null) drift.push(`cannot read the source for ${k}`);
  if (drift.length) return drift;
  const same = (what, a, b) => { if (a == null || b == null || squash(a) !== squash(b)) drift.push(what); };
  const has = (what, src, snippet) => { if (!squash(src).includes(squash(snippet))) drift.push(what); };

  // the builders
  same("payloadFor vs backfill-activities.mjs", bodyAfter(f.backfill, "function payloadFor(type, id, p)"), ownBody(payloadFor));
  same("taskTimestamp vs src/activities.ts", bodyAfter(f.activities, "export function taskTimestamp("), ownBody(taskTimestamp));
  same("timelinePayload vs src/activities.ts", bodyAfter(f.activities, "export function timelinePayload("), ownBody(timelinePayload));
  same("the timelinePayload call vs src/activity-sync.ts",
    callSite(f.sync, "const activity: HsActivity = {")?.replace("const activity: HsActivity = {", "const activity = {"),
    callSite(liveEntry.toString(), "const activity = {"));
  const stripExpr = (src) => /const strip = \(h(?::\s*unknown)?\) =>\s*(String\(h \?\? ""\)[^\n]*?\.trim\(\));/.exec(src)?.[1];
  same("strip vs backfill-activities.mjs", stripExpr(f.backfill), strip.toString().split("=>")[1]);
  same("strip vs src/activity-sync.ts", stripExpr(f.sync), strip.toString().split("=>")[1]);
  same("PROPS vs backfill-activities.mjs", JSON.stringify(propsIn(f.backfill, "const PROPS =")), JSON.stringify(PROPS_BACKFILL));
  same("PROPS vs src/activity-sync.ts", JSON.stringify(propsIn(f.sync, "const PROPS: Record<string, string[]> =")), JSON.stringify(PROPS_LIVE));
  has("backfill create sends summary \"\"", f.backfill, 'title:$t${k}, summary:"", content:$c${k}, timestamp:$ts${k}');
  has("live create mutation", f.sync, "create_timeline_item(item_id:$i, custom_activity_id:$a, title:$t, summary:$s, content:$c, timestamp:$ts)");
  for (const [o, id] of Object.entries(OUR_TYPE)) {
    if (!new RegExp(`\\b${o}:\\s*"${id}"`).test(f.activities)) drift.push(`OUR_TYPE.${o} vs src/activities.ts`);
    if (!new RegExp(`\\b${o}:\\s*"${id}"`).test(f.backfill)) drift.push(`OUR_TYPE.${o} vs backfill-activities.mjs`);
  }

  // who places what, and where
  has("backfill cutover", f.backfill, `const CUTOVER = Date.parse("${CUTOVER_ISO}");`);
  has("backfill refuses at/after the cutover", f.backfill, "if (when >= CUTOVER) { c.postCutover++; continue; }");
  if ((/TASK_POLL_SEED\s*=\s*"([^"]+)"/.exec(f.poller)?.[1]) !== CUTOVER_ISO) drift.push("CUTOVER_ISO vs TASK_POLL_SEED (== ACTIVITY_CUTOVER_AT)");
  const sweepDays = Number(/export const SWEEP_WINDOW_DAYS = (\d+);/.exec(f.poller)?.[1]);
  if (Number.isInteger(sweepDays) && sweepDays > 0) SWEEP_WINDOW_DAYS = sweepDays;
  else drift.push("cannot read SWEEP_WINDOW_DAYS from src/task-poller.ts");
  has("the Task sweep bypasses the cutover and checks the card", f.poller, "{ ignoreCutover: true, verifyExisting: true });");
  has("live cutover rule (activityIsLive)", f.sync, "return afterCutover(env, p.hs_timestamp) || afterCutover(env, p.hs_createdate);");
  has("live applies the cutover unless the Task poller asks", f.sync, "if (!opts.ignoreCutover && !activityIsLive(env, p))");
  has("backfill staff emails", f.backfill, "for (const o of r.results ?? []) if (o.email) staff.add(String(o.email).toLowerCase());");
  has("backfill contact emails", f.backfill, 'contactEmail.set(String(c.id), String(c.properties?.email ?? "").toLowerCase());');
  has("backfill staff rule", f.backfill, "const isStaff = new Set(contactIds.filter((_, i) => mails[i] && staff.has(mails[i])));");
  has("backfill drops staff contacts only", f.backfill, 'dests = dests.filter(d => d.kind !== "contact" || !isStaff.has(d.hubspotId));');
  has("live staff emails", f.sync, "for (const o of r?.results ?? []) if (o?.email) emails.add(String(o.email).trim().toLowerCase());");
  has("live contact emails", f.sync, 'emailOf.set(String(c.id), String(c.properties?.email ?? "").trim().toLowerCase());');
  has("live staff rule", f.sync, "(e && staffSet.has(e) ? staff : targets).push(id);");
  has("live internalDomains", f.sync, 'const d = normalizeDomain(e.split("@")[1] ?? ""); if (d && !isPublicEmailDomain(d)) out.add(d);');
  has("live internal company test", f.sync, 'const d = normalizeDomain(String(c?.properties?.domain ?? "")); if (d && internal.has(d)) out.add(String(c.id));');
  has("live drops internal companies", f.sync, '&& !(d.kind === "company" && internalCos.has(d.hubspotId)));');
  has("live monday-origin skip", f.sync, "const origin = mondayOriginOf(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body);");
  same("MONDAY_ORIGIN_RE vs src/activity-sync.ts", /const MONDAY_ORIGIN_RE = (\/.*\/);/.exec(f.sync)?.[1], MONDAY_ORIGIN_RE.toString());
  same("normalizeDomain vs src/normalize.ts", bodyAfter(f.normalize, "export function normalizeDomain("), ownBody(normalizeDomain));
  same("isPublicEmailDomain vs src/adopt.ts", bodyAfter(f.adopt, "export function isPublicEmailDomain("), ownBody(isPublicEmailDomain));
  const pub = /const PUBLIC_EMAIL_DOMAINS = new Set\(\[([\s\S]*?)\]\);/.exec(f.adopt)?.[1];
  const domains = pub ? [...pub.matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
  if (domains.length < 10) drift.push("cannot read PUBLIC_EMAIL_DOMAINS from src/adopt.ts");
  else PUBLIC_EMAIL_DOMAINS = new Set(domains);
  for (const [kind, b] of Object.entries(BOARD))
    if (!new RegExp(`boardId:\\s*"${b.board}",\\s*idCol:\\s*"${b.idCol}"`).test(f.crm)) drift.push(`BOARD.${kind} vs src/config/crm.ts`);
  return drift;
}

// ================================================================== the run
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); return;
  }
  const APPLY = argv.includes("--apply");
  const CANARY = argv.includes("--canary");
  const WRITE = APPLY || CANARY;
  const ALLOW_LOSSY = argv.includes("--allow-lossy");
  const SWITCHES = ["--apply", "--canary", "--allow-lossy"];
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  /** A flag that is present must carry a value: a trailing `--cards` must never widen the selection. */
  for (const k of ["--census", "--markers-file", "--cards", "--limit", "--concurrency"]) {
    if (!argv.includes(k)) continue;
    const x = arg(k);
    if (x === undefined || x === "" || String(x).startsWith("--")) { console.error(`${k} needs a value`); process.exit(2); }
  }
  const known = new Set(["--census", "--markers-file", "--cards", "--limit", "--concurrency", ...SWITCHES]);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) { console.error(`unknown argument ${argv[i]} (see --help)`); process.exit(2); }
    if (!SWITCHES.includes(argv[i])) i++;
  }
  const CENSUS = arg("--census", null);
  if (!CENSUS) { console.error("--census <damage-census.json> is required"); process.exit(2); }
  // The RAW text is checked, not Number(): Number("Infinity"), Number("1e3") and Number("0x2") would all pass.
  if (argv.includes("--limit") && !/^[1-9]\d*$/.test(String(arg("--limit")))) { console.error("--limit needs a whole number > 0"); process.exit(2); }
  const LIMIT = argv.includes("--limit") ? Number(arg("--limit")) : Infinity;
  if (argv.includes("--concurrency") && !/^[1-6]$/.test(String(arg("--concurrency")))) { console.error("--concurrency is 1-6"); process.exit(2); }
  const CONC_ASKED = argv.includes("--concurrency") ? Number(arg("--concurrency")) : 2;
  const CONCURRENCY = CANARY ? 1 : CONC_ASKED;
  const CARDS = argv.includes("--cards") ? new Set(arg("--cards").split(",").map(s => s.trim()).filter(Boolean)) : null;
  if (CARDS && (!CARDS.size || [...CARDS].some(c => !/^\d+$/.test(c)))) { console.error("--cards takes monday item ids, comma-separated"); process.exit(2); }

  const v = {};
  for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  const H = v.HUBSPOT_CRM_APP_TOKEN, M = v.MONDAY_API_TOKEN;
  if (!H || !M) { console.error("missing HUBSPOT_CRM_APP_TOKEN or MONDAY_API_TOKEN in .dev.vars"); process.exit(1); }

  // Every copy checked against its source before anything is read. Drift ends a writing run.
  const drift = sourceDrift();
  if (drift.length) {
    console.error(`${WRITE ? "refusing to write" : "WARNING"}: the copied writer code no longer matches its source -- `
      + `${drift.join("; ")}. Update the copies in this script (and look at what changed) before restoring anything.`);
    if (WRITE) process.exit(1);
  }
  // Refuse before reading anything when the run could write: see lib/repair-preflight.mjs.
  if (WRITE) {
    try { await requireIntegrationToken(M); }
    catch (e) { console.error(`refusing to write: ${e.message}`); process.exit(1); }
    console.log("pre-flight: the monday token is the integration user");
  }
  // ONE writing run at a time. A second one started meanwhile would read the first one's report while it is
  // still all "pending" (which says nothing) and could create the same (card, marker). Taken before any earlier
  // report is read, so what this run learns from them cannot change under it. Removed on exit, however it ends.
  const LOCK = join(ROLLOUT, ".timeline-restore.lock");
  if (WRITE) {
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, since: new Date().toISOString(), args: argv }));
      closeSync(fd);
    } catch (e) {
      if (e?.code !== "EEXIST") { console.error(`refusing to write: cannot take ${LOCK}: ${String(e?.message ?? e).slice(0, 120)}`); process.exit(1); }
      let holder = "";
      try { holder = readFileSync(LOCK, "utf8").slice(0, 300); } catch { /* gone meanwhile: still refuse, the next start will tell */ }
      console.error(`refusing to write: another restore run holds ${LOCK} (${holder || "unreadable"}). `
        + "If that process is no longer running, look at its report first, then delete the lock and run again.");
      process.exit(1);
    }
    process.on("exit", () => { try { unlinkSync(LOCK); } catch { /* already gone */ } });
  } else if (existsSync(LOCK)) {
    console.log(`note: a writing run holds ${LOCK} -- this plan may not reflect what it is creating right now`);
  }

  // ---------------------------------------------------------------- transport
  /** dedupe-timeline.mjs monday(): retries only what a second try can fix; 401/403/daily limit -> `abort`. */
  const TRANSIENT = /complexity|rate.?limit|budget|too many requests|throttl|concurren|temporar|timed? ?out|internal server error|service unavailable/i;
  async function monday(query, variables = {}, attempt = 0) {
    let r, j;
    try {
      r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: M, "API-Version": "2026-07" },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(120_000) });
      j = await r.json().catch(() => null);
    } catch (e) {
      if (attempt < 6) { await sleep(3000 * (attempt + 1)); return monday(query, variables, attempt + 1); }
      throw new Error(`monday network: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    const errs = j?.errors ?? (j?.error_message ? [{ message: j.error_message, code: j.error_code }] : null);
    if (r.ok && j?.data && !errs) return j.data;
    const text = JSON.stringify(errs ?? j ?? `HTTP ${r.status}`);
    const abort = r.status === 401 || r.status === 403 || /DAILY_LIMIT|daily limit|not authenticated|unauthori[sz]ed/i.test(text);
    const transient = !abort && (r.status === 429 || r.status >= 500 || !j || TRANSIENT.test(text));
    if (transient && attempt < 6) {
      const asked = Number((Array.isArray(errs) ? errs : []).find(e => e?.extensions?.retry_in_seconds)?.extensions?.retry_in_seconds)
        || Number(/reset in (\d+)/i.exec(text)?.[1]) || 0;
      await sleep(asked ? Math.min(asked + 1, 65) * 1000 : 3000 * (attempt + 1));
      return monday(query, variables, attempt + 1);
    }
    const err = new Error(`monday ${r.status}${transient ? " (still failing after 6 retries)" : ""}: ${text.slice(0, 240)}`);
    err.abort = abort;
    throw err;
  }

  /**
   * THE CREATE, SENT ONCE. It never throws. { id } | { uncertain[, id] } | { failed }, and `abort` beside any of
   * them on 401/403/daily limit (the caller stops the run). `failed` means monday PROVED it did not run: the
   * answer is below 500, readable, carries errors and no result, and no error has a `path` (GraphQL gives one
   * to every error raised while executing), and the error is a known refusal before execution -- rate,
   * complexity, concurrency or budget (re-sent after the wait monday asks for, up to 6 times), or a GraphQL
   * parse/validation error (not re-sent). HTTP 429 is not-run whatever its body says. Everything else may have
   * landed -- a network failure, a timeout, a 5xx, an INTERNAL_SERVER_ERROR inside a 200 -- so it is
   * `uncertain` and is never repeated: the caller looks at the card instead.
   */
  const CREATE = `mutation ($i: ID!, $a: String!, $t: String!, $s: String!, $c: String!, $ts: ISO8601DateTime!) {
    create_timeline_item(item_id:$i, custom_activity_id:$a, title:$t, summary:$s, content:$c, timestamp:$ts) { id } }`;
  const RETRY_LATER = /complexity|rate.?limit|budget|too many requests|throttl|concurren/i;
  const INVALID_REQUEST = /parse error|doesn't exist on type|was provided invalid value|has an invalid value|is required|isn't a defined|missingRequiredArguments|undefinedField|undefinedType|argumentLiteralsIncompatible|argumentNotAccepted|variableMismatch|GRAPHQL_(?:PARSE|VALIDATION)_FAILED/i;
  const AUTH_OR_QUOTA = /DAILY_LIMIT|daily limit|not authenticated|unauthori[sz]ed/i;
  async function createOnce(variables) {
    for (let attempt = 0; ; attempt++) {
      let r, j;
      try {
        r = await fetch("https://api.monday.com/v2", { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: M, "API-Version": "2026-07" },
          body: JSON.stringify({ query: CREATE, variables }), signal: AbortSignal.timeout(120_000) });
        j = await r.json().catch(() => null);
      } catch (e) { return { uncertain: `network: ${String(e?.message ?? e).slice(0, 120)}` }; }
      const errs = j?.errors ?? (j?.error_message ? [{ message: j.error_message, code: j.error_code }] : null);
      const id = j?.data?.create_timeline_item?.id;
      if (r.ok && id && !errs) return { id: String(id) };
      const text = JSON.stringify(errs ?? j ?? `HTTP ${r.status}`);
      const list = Array.isArray(errs) ? errs : [];
      const authOrQuota = r.status === 401 || r.status === 403 || AUTH_OR_QUOTA.test(text);
      if (id) return { uncertain: `created ${id} but monday also reported: ${text.slice(0, 160)}`, id: String(id), ...(authOrQuota ? { abort: true } : {}) };
      const beforeExec = r.status < 500 && !!j && list.length > 0 && list.every(e => !e?.path) && j?.data?.create_timeline_item == null;
      if (r.status === 401 || r.status === 403 || (authOrQuota && beforeExec))
        return { failed: `monday ${r.status}: ${text.slice(0, 200)}`, abort: true };
      const retryLater = r.status === 429 || (beforeExec && RETRY_LATER.test(text));
      if (retryLater && attempt < 6) {
        const asked = Number(list.find(e => e?.extensions?.retry_in_seconds)?.extensions?.retry_in_seconds)
          || Number(/reset in (\d+)/i.exec(text)?.[1]) || 0;
        await sleep(asked ? Math.min(asked + 1, 65) * 1000 : 3000 * (attempt + 1));
        continue;
      }
      if (retryLater) return { failed: `monday still refusing after 6 tries: ${text.slice(0, 200)}` };
      if (beforeExec && list.every(e => INVALID_REQUEST.test(`${e?.message ?? ""} ${e?.extensions?.code ?? e?.code ?? ""}`)))
        return { failed: `monday rejected the request before running it: ${text.slice(0, 200)}` };
      return { uncertain: `monday ${r.status}${j ? `: ${text.slice(0, 160)}` : " (unreadable answer)"}`, ...(authOrQuota ? { abort: true } : {}) };
    }
  }

  /** HubSpot, GET only -- this script never writes HubSpot. 404 -> null. 401/403 -> `abort`. */
  async function hs(path, attempt = 0) {
    let r;
    try { r = await fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${H}` }, signal: AbortSignal.timeout(60_000) }); }
    catch (e) {
      if (attempt < 6) { await sleep(2500 * (attempt + 1)); return hs(path, attempt + 1); }
      throw new Error(`hubspot ${path.split("?")[0]} network: ${String(e?.message ?? e).slice(0, 100)}`);
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2500 * (attempt + 1)); return hs(path, attempt + 1); }
    if (r.status === 404) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(`hubspot ${path.split("?")[0]}: ${r.status}`); e.abort = r.status === 401 || r.status === 403; throw e; }
    return j;
  }

  // ---------------------------------------------------------------- the selection
  let census;
  try { census = JSON.parse(readFileSync(resolve(CENSUS), "utf8")); }
  catch (e) { console.error(`cannot read the census ${CENSUS} (still being written? try again): ${String(e.message).slice(0, 120)}`); process.exit(2); }
  const rows = Array.isArray(census) ? census : null;
  if (!rows) { console.error(`${CENSUS} is not an array of census rows`); process.exit(2); }
  const invalid = [];
  const lost = [];
  for (const r of rows) {
    if (r?.state !== "LOST") continue;
    const m = MARKER_RE.exec(String(r.marker ?? ""));
    if (!m || !/^\d+$/.test(String(r.card ?? "")) || !BOARD[r.kind]) { invalid.push(r); continue; }
    lost.push({ ...r, card: String(r.card), object: m[1], activityId: m[2] });
  }
  const unknownRows = rows.filter(r => r?.state === "unknown").length;

  let want = null;                                    // markers-file: marker -> Set(cards) | "*"
  if (argv.includes("--markers-file")) {
    const path = arg("--markers-file");
    let text;
    try { text = readFileSync(resolve(path), "utf8"); } catch (e) { console.error(`cannot read --markers-file ${path}`); process.exit(2); }
    let entries;
    try { const j = JSON.parse(text); entries = Array.isArray(j) ? j.map(String) : null; } catch { entries = null; }
    entries ??= text.split(/\r?\n/).map(l => l.replace(/#.*$/, "").trim()).filter(Boolean);
    want = new Map();
    for (const e of entries) {
      const m = /^(?:(\d+)\s*[|\s]\s*)?(\[hubspot:[a-z_]+:[A-Za-z0-9_-]+\])$/.exec(e.trim());
      if (m && MARKETING_MARKER_RE.test(m[2])) { console.error(`--markers-file: "${e.slice(0, 80)}" is a marketing email entry, which cannot be restored (no CRM object to rebuild it from)`); process.exit(2); }
      if (!m || !MARKER_RE.test(m[2])) { console.error(`--markers-file: cannot read "${e.slice(0, 80)}"`); process.exit(2); }
      if (!m[1]) want.set(m[2], "*");
      else if (want.get(m[2]) !== "*") (want.get(m[2]) ?? want.set(m[2], new Set()).get(m[2])).add(m[1]);
    }
    if (!want.size) { console.error(`--markers-file ${path} names nothing -- refusing to read that as "all"`); process.exit(2); }
  }
  const pairs = new Map();
  for (const r of lost) {
    if (CARDS && !CARDS.has(r.card)) continue;
    if (want) { const w = want.get(r.marker); if (!w || (w !== "*" && !w.has(r.card))) continue; }
    pairs.set(`${r.card}|${r.marker}`, r);         // one (card, marker) once, whatever the census repeats
  }
  let selected = [...pairs.values()].sort((a, b) => (a.card === b.card ? (a.marker < b.marker ? -1 : 1) : a.card < b.card ? -1 : 1));
  if (Number.isFinite(LIMIT)) selected = selected.slice(0, LIMIT);
  console.log(`census ${CENSUS}: ${rows.length} rows, ${lost.length} LOST (${unknownRows} unknown, not considered)`
    + `${invalid.length ? `, ${invalid.length} LOST rows unreadable (skipped, listed in the report)` : ""}; selected ${selected.length}`);
  if (!selected.length) { console.error("nothing selected -- refusing to run (an empty selection is never read as \"all\")"); process.exit(2); }

  // ---------------------------------------------------------------- what earlier runs knew
  const files = (() => { try { return readdirSync(ROLLOUT).sort(); } catch { return []; } })();
  /**
   * Every timeline id any dedupe report saw, per (card, marker) and per marker -> card. Two report shapes exist:
   * today's { keep: [id], identical: [...], bodyless: [...] } and the first plan's (2026-09-23-timeline-dedupe-
   * plan.json) { keep: "id", del: [...] }. [].concat takes a string keep whole (a spread would split it into
   * characters, which timeline_item answers INTERNAL_ERROR, not NOT_FOUND), and only id-shaped strings are kept.
   */
  const pairIds = new Map(), markerCards = new Map();
  const dedupeReports = files.filter(f => /-timeline-dedupe-.*\.json$/.test(f));
  for (const f of dedupeReports) {
    let j; try { j = JSON.parse(readFileSync(join(ROLLOUT, f), "utf8")); } catch { console.log(`note: could not read ${f}`); continue; }
    for (const c of j.cards ?? []) for (const g of c.groups ?? []) {
      const ids = [].concat(g.keep ?? [], g.identical ?? [], g.bodyless ?? [], g.del ?? []).map(String).filter(i => TIMELINE_ID_RE.test(i));
      const k = `${c.card}|${g.marker}`;
      const s = pairIds.get(k) ?? pairIds.set(k, new Set()).get(k);
      ids.forEach(i => s.add(i));
      const byCard = markerCards.get(g.marker) ?? markerCards.set(g.marker, new Map()).get(g.marker);
      const cs = byCard.get(String(c.card)) ?? byCard.set(String(c.card), new Set()).get(String(c.card));
      ids.forEach(i => cs.add(i));
    }
  }
  /** Copies the census found ALIVE, per marker: the best sibling candidates. */
  const aliveByMarker = new Map();
  for (const r of rows) if (r?.state === "alive" && r.aliveId && r.marker)
    (aliveByMarker.get(r.marker) ?? aliveByMarker.set(r.marker, []).get(r.marker)).push({ card: String(r.card), id: String(r.aliveId) });
  /**
   * Earlier restores: what they created (newIds) and what they sent without an answer (uncertain): outcome
   * create-uncertain, or createSentAt with no newId and not create-failed -- a run that died between sending and
   * recording (create-sent). A writing run refuses to start when one of these reports cannot be parsed: its new
   * ids would be forgotten, and the lossy listing is all that would stand between this run and a second copy.
   */
  const previous = new Map();
  const restoreReports = files.filter(f => /-timeline-restore-applied.*\.json$/.test(f));
  const unreadableRestores = [];
  for (const f of restoreReports) {
    let j; try { j = JSON.parse(readFileSync(join(ROLLOUT, f), "utf8")); } catch { unreadableRestores.push(f); continue; }
    for (const it of j.items ?? []) {
      const k = `${it.card}|${it.marker}`;
      const p = previous.get(k) ?? previous.set(k, { newIds: new Set(), uncertain: false, files: [] }).get(k);
      if (it.newId) p.newIds.add(String(it.newId));
      const sentNoAnswer = !it.newId && (it.outcome === "create-uncertain" || it.outcome === "create-sent"
        || (!!it.createSentAt && it.outcome !== "create-failed"));
      if (sentNoAnswer) p.uncertain = true;
      if (it.newId || sentNoAnswer) p.files.push(f);
    }
  }
  if (unreadableRestores.length) {
    const msg = `cannot parse ${unreadableRestores.map(f => join(ROLLOUT, f)).join(", ")} -- the entries that run created would be forgotten`;
    if (WRITE) { console.error(`refusing to write: ${msg}. Repair or move the file (look for a .tmp beside it), then run again.`); process.exit(1); }
    console.log(`WARNING: ${msg}; this plan may show them as would-create`);
  }
  /** The backfill's own record of what it placed. */
  let backfillDone = null;
  const CHECKPOINT = join(ROOT, "scripts", ".backfill-activities-state.json");
  try {
    const s = JSON.parse(readFileSync(CHECKPOINT, "utf8"));
    backfillDone = Object.fromEntries(Object.entries(s.processed ?? {}).map(([t, ids]) => [t, new Set(ids.map(String))]));
  } catch (e) {
    console.log(`note: no backfill checkpoint (${String(e.message).slice(0, 80)}) -- the writer is chosen by date alone`);
  }

  // ---------------------------------------------------------------- the report
  const stamp = new Date().toISOString();
  let out = join(ROLLOUT, `${stamp.slice(0, 10)}-timeline-restore-${WRITE ? "applied" : "plan"}.json`);
  if (existsSync(out)) out = out.replace(/\.json$/, `-${stamp.slice(11, 19).replace(/:/g, "")}.json`);
  const items = selected.map(r => ({ card: r.card, kind: r.kind, board: BOARD[r.kind].board, marker: r.marker,
    object: r.object, activityId: r.activityId, outcome: "pending" }));
  const report = { generatedAt: stamp, mode: WRITE ? "applied" : "plan", canary: CANARY, census: resolve(CENSUS),
    censusRows: rows.length, lostRows: lost.length, unknownRows, invalidLostRows: invalid, selected: items.length,
    filters: { cards: CARDS ? [...CARDS] : undefined, markersFile: arg("--markers-file", undefined), limit: Number.isFinite(LIMIT) ? LIMIT : undefined,
      allowLossy: ALLOW_LOSSY || undefined },
    sources: { dedupeReports, previousRestoreReports: restoreReports, backfillCheckpoint: backfillDone ? CHECKPOINT : null,
      sourceDrift: drift.length ? drift : undefined },
    tally: {}, done: false, cards: {}, items };
  /** Written whole to a .tmp beside it, then renamed over it: a kill mid-write leaves the previous save intact,
   *  never a truncated file the next run cannot parse. (A reader holding the file open on Windows can refuse
   *  the rename; then it is written in place, and a writing run refuses a report it cannot parse.) */
  const save = () => {
    report.tally = items.reduce((t, i) => ({ ...t, [i.outcome]: (t[i.outcome] ?? 0) + 1 }), {});
    const text = JSON.stringify(report, null, 1), tmp = `${out}.tmp`;
    writeFileSync(tmp, text);
    try { renameSync(tmp, out); }
    catch { writeFileSync(out, text); try { unlinkSync(tmp); } catch { /* best effort */ } }
  };
  save();

  // ---------------------------------------------------------------- monday reads
  const ENTRY = `query ($i: ID!) { timeline_item(id: $i) { id type custom_activity_id title content created_at item { id } } }`;
  /** present | absent (NOT_FOUND) | unknown. Only NOT_FOUND counts as gone; any other failure is "cannot tell". */
  async function entryById(id) {
    try {
      const d = await monday(ENTRY, { i: id });
      return d.timeline_item ? { state: "present", entry: d.timeline_item } : { state: "absent" };
    } catch (e) {
      if (e?.abort) throw e;
      if (/"code":"NOT_FOUND"|Timeline item not found/.test(String(e?.message))) return { state: "absent" };
      return { state: "unknown", error: String(e?.message ?? e).slice(0, 160) };
    }
  }
  const TIMELINE = limit => `query ($i: ID!, $c: String) { timeline(id: $i) { timeline_items_page(limit: ${limit}, cursor: $c) {
    cursor timeline_items { id type custom_activity_id title content created_at item { id } } } } }`;
  /** dedupe-timeline.mjs timeline(): every distinct row, guarding overlapping pages and a stuck cursor. It also
   *  counts the rows RETURNED (duplicates included): the cursor advances by those, so they are the card's size. */
  async function walkAt(card, limit) {
    const rows = new Map(); const cursors = new Set(); let cursor = null, pages = 0, returned = 0;
    for (; pages < 400;) {
      const d = await monday(TIMELINE(limit), { i: card, c: cursor });
      pages++;
      const page = d.timeline?.timeline_items_page;
      if (!page) return { rows, pages, returned, complete: false, why: "no-page" };
      for (const e of page.timeline_items ?? []) { returned++; rows.set(e.id, e); }
      cursor = page.cursor ?? null;
      if (!cursor) return { rows, pages, returned, complete: true };
      if (cursors.has(cursor)) return { rows, pages, returned, complete: false, why: "repeated-cursor" };
      cursors.add(cursor);
    }
    return { rows, pages, returned, complete: false, why: "page-budget" };
  }
  /**
   * The card's listing, as much of it as monday gives. When pages overlapped (returned > distinct) some rows
   * were never returned; a second walk at page size 40 returns a few of them (measured on 2855606710: 827
   * distinct at 100, 698 at 40, 841 together, of 1085), so the two are united. `unseen` is what neither walk
   * returned; `lossy` also covers a multi-page walk that showed no overlap, since nothing proves it complete.
   */
  async function walk(card) {
    const a = await walkAt(card, 100);
    const out = { rows: a.rows, pages: a.pages, returned: a.returned, complete: a.complete, why: a.why, pageSizes: [100] };
    if (a.complete && a.returned > a.rows.size) {
      const b = await walkAt(card, 40);
      for (const [id, e] of b.rows) out.rows.set(id, e);
      out.returned = Math.max(a.returned, b.returned); out.pageSizes.push(40);   // `pages` stays the 100-row walk's
    }
    out.distinct = out.rows.size;
    out.unseen = Math.max(0, out.returned - out.distinct);
    out.lossy = a.pages > 1 || out.unseen > 0;
    return out;
  }
  const own = (w, card) => [...w.rows.values()].filter(e => String(e.item?.id ?? "") === String(card));

  async function readCard(card, kind) {
    const b = BOARD[kind];
    const d = await monday(`query ($i: [ID!]) { items(ids: $i) { id state board { id } column_values(ids: ["${b.idCol}"]) { text } } }`, { i: [card] });
    const x = d.items?.[0];
    if (!x) return { ok: false, outcome: "skipped-card-gone", reason: "monday returns no item with this id" };
    if (x.state && x.state !== "active") return { ok: false, outcome: "skipped-card-gone", reason: `the card is ${x.state}` };
    if (String(x.board?.id) !== b.board)
      return { ok: false, outcome: "skipped-card-wrong-board", reason: `on board ${x.board?.id}, but the census says ${kind} (${b.board})` };
    const recordId = String(x.column_values?.[0]?.text ?? "").trim();
    if (!/^\d+$/.test(recordId)) return { ok: false, outcome: "skipped-card-no-record", reason: `HubSpot ID column reads ${JSON.stringify(recordId.slice(0, 30))}` };
    return { ok: true, recordId };
  }

  // ---------------------------------------------------------------- HubSpot reads
  let staffP = null;
  /** HubSpot owners' emails, as each writer normalised them (backfill: lowercase; live: trim + lowercase). */
  const staff = () => staffP ??= (async () => {
    const raw = []; let after = "";
    for (let page = 0; page < 20; page++) {
      const r = await hs(`/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`);
      for (const o of r?.results ?? []) if (o?.email) raw.push(String(o.email));
      after = r?.paging?.next?.after ?? "";
      if (!after) break;
    }
    const live = new Set(raw.map(e => e.trim().toLowerCase()));
    return { backfill: new Set(raw.map(e => e.toLowerCase())), live, internal: internalDomains(live) };
  })().catch(e => { staffP = null; throw e; });

  /** Is the activity still linked to that record? true | false | "incomplete" (more pages than the budget). */
  async function linkedTo(object, id, assoc, recordId) {
    let after = "";
    for (let page = 0; page < 50; page++) {
      const r = await hs(`/crm/v4/objects/${object}/${id}/associations/${assoc}?limit=500${after ? `&after=${after}` : ""}`);
      for (const a of r?.results ?? []) if (String(a?.toObjectId) === recordId) return true;
      after = r?.paging?.next?.after ?? "";
      if (!after) return false;
    }
    return "incomplete";
  }

  /** Would this writer file the activity on this card at all? A reason string when it would not. */
  async function writerExcludes(writer, it, p) {
    if (writer === "live") {
      const origin = MONDAY_ORIGIN_RE.exec(String(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body ?? ""))?.[1];
      if (origin) return `it originated from monday timeline ${origin}; the live sync never copies those back (activity-sync.ts:411)`;
    }
    if (it.kind === "contacts") {
      const s = await staff();
      const c = await hs(`/crm/v3/objects/contacts/${it.recordId}?properties=email`);
      const raw = c?.properties?.email;
      const isStaff = writer === "backfill"
        ? (() => { const m = String(raw ?? "").toLowerCase(); return !!m && s.backfill.has(m); })()
        : (() => { const e = String(raw ?? "").trim().toLowerCase(); return !!e && s.live.has(e); })();
      if (isStaff) return `contact ${it.recordId} is staff (a HubSpot owner's email); the ${writer} writer never files on a colleague's own card`;
    }
    const s = it.kind === "companies" && writer === "live" ? await staff() : null;
    if (s?.internal.size) {
      let c = null;
      try { c = await hs(`/crm/v3/objects/companies/${it.recordId}?properties=domain`); }
      catch (e) { if (e?.abort) throw e; }            // the Worker fails OPEN here: an unreadable domain keeps the company
      const d = normalizeDomain(String(c?.properties?.domain ?? ""));
      if (d && s.internal.has(d)) return `company ${it.recordId} is the business itself (${d}); the live sync no longer files there (activity-sync.ts:243)`;
    }
    return null;
  }

  /**
   * The writer the original came from, by the rule each writer placed by. `firm` when the rule rests on the
   * writer's own record or on a date the other writer refuses (the backfill never writes at/after the cutover);
   * otherwise it is a fallback, and a surviving copy may overrule it.
   */
  function ruleWriter(object, id, p) {
    const after = x => { const t = Date.parse(String(x ?? "")); return Number.isFinite(t) && t >= CUTOVER; };
    if (backfillDone?.[object]?.has(id)) return { writer: "backfill", firm: true, by: "listed in the backfill checkpoint (processed)" };
    if (after(p.hs_timestamp) || after(p.hs_createdate)) return { writer: "live", firm: true, by: "dated or created at/after ACTIVITY_CUTOVER_AT (activityIsLive)" };
    if (object === "tasks") return { writer: "live", firm: false, by: "a task: the Task poller places tasks whatever their date" };
    if (!backfillDone) return { writer: "backfill", firm: false, by: "both dates before the cutover (no checkpoint to confirm)" };
    return { writer: "backfill", firm: false, by: "both dates before the cutover", flag: "not in the backfill checkpoint -- only the backfill writes such activities, yet it did not list this one" };
  }

  /**
   * A copy of the same marker alive on ANOTHER card: what the writer actually produced. Up to 8 candidates that
   * ANSWER (present or NOT_FOUND) are looked at; one monday cannot read does not use up that budget (at most 32
   * lookups in all), so unreadable ids cannot crowd out the real copies. { hit, looked, unreadable }.
   */
  async function sibling(it) {
    const ids = [];
    for (const a of aliveByMarker.get(it.marker) ?? []) if (a.card !== it.card) ids.push(a.id);
    for (const [card, s] of markerCards.get(it.marker) ?? []) if (card !== it.card) ids.push(...s);
    let answered = 0, lookups = 0, unreadable = 0;
    const candidates = [...new Set(ids)].filter(i => TIMELINE_ID_RE.test(i));
    for (const id of candidates) {
      if (answered >= 8 || lookups >= 32) break;
      lookups++;
      const r = await entryById(id);
      if (r.state === "unknown") { unreadable++; continue; }
      answered++;
      const e = r.entry;
      if (r.state === "present" && String(e.item?.id ?? "") !== it.card && e.type === "custom"
          && e.custom_activity_id === OUR_TYPE[it.object] && String(e.content ?? "").includes(it.marker))
        return { hit: { id, card: String(e.item?.id ?? ""), entry: e }, candidates: candidates.length, looked: answered, unreadable };
    }
    return { hit: null, candidates: candidates.length, looked: answered, unreadable };
  }

  /**
   * With no surviving copy: has HubSpot changed what the writer read since it wrote? The earliest the original
   * can have been written is max(ACTIVITY_CUTOVER_AT, hs_createdate) -- neither writer wrote before the cutover.
   * Unmodified since then: unchanged. Otherwise the property history of every property the writer reads says
   * which changed after it. { changed: [props] | null (no history to judge by), ... }.
   */
  async function changedSinceWrite(it, writer, p) {
    const created = Date.parse(String(p.hs_createdate ?? ""));
    const earliest = Math.max(CUTOVER, Number.isFinite(created) ? created : CUTOVER);
    const last = Date.parse(String(p.hs_lastmodifieddate ?? ""));
    const base = { writtenNoEarlierThan: new Date(earliest).toISOString(), lastModified: p.hs_lastmodifieddate ?? null };
    if (Number.isFinite(last) && last <= earliest) return { ...base, changed: [], by: "hs_lastmodifieddate is not later" };
    const props = (writer === "backfill" ? PROPS_BACKFILL : PROPS_LIVE)[it.object].filter(k => k !== "hs_createdate");
    const r = await hs(`/crm/v3/objects/${it.object}/${it.activityId}?properties=hs_lastmodifieddate`
      + `&propertiesWithHistory=${encodeURIComponent(props.join(","))}`);
    if (!r?.propertiesWithHistory) return { ...base, changed: null, by: "HubSpot returned no property history" };
    const changed = [];
    for (const k of props) {
      const when = (r.propertiesWithHistory[k] ?? []).map(x => Date.parse(String(x?.timestamp ?? ""))).filter(Number.isFinite).sort((a, b) => a - b);
      if (when.some((t, i) => t > earliest && (i > 0 || t > earliest + INITIAL_GRACE_MS))) changed.push(k);
    }
    return { ...base, changed, by: "property history" };
  }

  // ---------------------------------------------------------------- one (card, marker)
  let stopReason = null, canaryUsed = false;
  const createdThisRun = new Set();
  /** Ctrl-C in a writing run: the first stops new creates and lets the ones in flight finish and be recorded;
   *  a second quits at once (an item then left at create-sent is held by the next run). */
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (!WRITE || ++interrupts > 1) process.exit(130);
    stopReason ??= "interrupted (Ctrl-C)";
    console.log("\nCtrl-C: no new create starts; the ones in flight finish and are recorded. Ctrl-C again to quit now.");
  });
  const finish = (it, outcome, extra = {}) => {
    Object.assign(it, extra, { outcome });
    save();
    const e = it.entry;
    console.log(`  [${outcome}] ${it.kind} ${it.card} ${it.marker}`
      + (e ? ` writer=${it.writer} type=${String(e.custom_activity_id).slice(0, 8)} title=${JSON.stringify(String(e.title).slice(0, 50))}`
        + ` len=${e.contentLength} sha=${e.contentSha} ts=${e.timestamp}` : "")
      + (it.newId ? ` newId=${it.newId}` : "")
      + (it.reason ? ` -- ${String(it.reason).slice(0, 160)}` : ""));
  };

  /** Is a copy still there? null when none is; otherwise [outcome, extra] saying which. Every known id must answer
   *  NOT_FOUND, and the card's listing (walked again when the cached walk is older than maxAgeMs) must not show
   *  the marker. */
  async function stillThere(it, ids, listing, prev, maxAgeMs) {
    for (const id of ids) {
      const r = await entryById(id);
      if (r.state === "unknown") return ["check-failed", { reason: `cannot tell whether ${id} exists: ${r.error}` }];
      if (r.state === "present") {
        if (String(r.entry.item?.id ?? "") === it.card) return ["skipped-present", { reason: `known id ${id} still resolves on this card` }];
        return ["held-known-id-elsewhere", { reason: `known id ${id} resolves on item ${r.entry.item?.id}, not this card` }];
      }
    }
    const w = await listing(maxAgeMs);
    it.check.listing = { ownEntries: w.entries, rowsReturned: w.returned, distinctRows: w.distinct, unseenRows: w.unseen,
      pages: w.pages, complete: w.complete, lossy: w.lossy, walkedAt: new Date(w.at).toISOString() };
    if (!w.complete) return ["check-failed", { reason: `the card's listing could not be walked to the end (${w.why})` }];
    const seen = w.own.find(e => String(e.content ?? "").includes(it.marker));
    if (seen) return [prev?.newIds?.has(seen.id) ? "skipped-already-restored" : "skipped-present", { reason: `the listing shows the marker in ${seen.id}` }];
    return null;
  }
  /** On a lossy card "not seen" proves nothing, by id or in the listing: held unless a person looked (--allow-lossy). */
  const lossyHold = it => {
    const l = it.check?.listing;
    if (!l?.lossy || ALLOW_LOSSY) return null;
    return ["held-lossy-listing", { reason: `the card's listing returned ${l.rowsReturned} rows over ${l.pages} pages, ${l.distinctRows} distinct `
      + `(${l.unseenRows} never returned): a copy there can be invisible to both checks. Look for ${it.marker} on the card in monday, `
      + `then run with --allow-lossy --cards ${it.card}` }];
  };

  async function processItem(it, row, card, listing) {
    const key = `${it.card}|${it.marker}`;
    const prev = previous.get(key);
    // 0. an earlier run's restore that is still standing
    for (const id of prev?.newIds ?? []) {
      const r = await entryById(id);
      if (r.state === "present" && String(r.entry.item?.id ?? "") === it.card)
        return finish(it, "skipped-already-restored", { restoredId: id, reason: `restored by ${prev.files.join(", ")}` });
      if (r.state === "unknown") return finish(it, "check-failed", { reason: `cannot read the earlier restore ${id}: ${r.error}` });
    }
    // 1. the card
    if (!card.ok) return finish(it, card.outcome, { reason: card.reason });
    it.recordId = card.recordId;
    // 2. the activity, as HubSpot has it now
    const rec = await hs(`/crm/v3/objects/${it.object}/${it.activityId}?properties=${encodeURIComponent(PROPS_READ[it.object].join(","))}`);
    if (!rec) return finish(it, "skipped-activity-gone", { reason: `HubSpot has no ${it.object} ${it.activityId} (deleted or archived)` });
    const p = rec.properties ?? {};
    // 3. still linked to that card's record
    const linked = await linkedTo(it.object, it.activityId, BOARD[it.kind].assoc, card.recordId);
    if (linked === "incomplete") return finish(it, "check-failed", { reason: "the association list is longer than 50 pages; not acting on a partial list" });
    if (!linked) return finish(it, "skipped-not-associated", { reason: `HubSpot no longer links ${it.object} ${it.activityId} to ${BOARD[it.kind].assoc} ${card.recordId}` });

    // 4. the entry, as each writer builds it, and which writer placed it
    const builds = { backfill: backfillEntry(it.object, it.activityId, p), live: liveEntry(it.object, it.activityId, p) };
    const rule = ruleWriter(it.object, it.activityId, p);
    let writer = rule.writer, writerBy = rule.by, conflict = null, bodyUpgrade = false;
    it.buildsAgree = sameEntry({ ...builds.live, created_at: builds.live.timestamp }, builds.backfill);
    if (rule.flag) it.writerFlag = rule.flag;
    const sib = await sibling(it);
    if (sib.hit) {
      const hit = sib.hit, e = hit.entry, other = writer === "backfill" ? "live" : "backfill";
      const titles = `backfill title ${JSON.stringify(String(builds.backfill.title).slice(0, 80))}, live title ${JSON.stringify(String(builds.live.title).slice(0, 80))}`;
      it.sibling = { id: hit.id, card: hit.card };
      if (sameEntry(e, builds[writer])) it.sibling.result = "match";
      else if (sameEntry(e, builds[other])) {
        it.sibling.result = "matches-the-other-writer";
        // The copy proves what was written on ITS card. A firm rule for this card is not overruled by it.
        if (rule.firm) conflict = `the rule says ${writer} (${writerBy}), but the surviving copy ${hit.id} on card ${hit.card} is exactly the `
          + `${other} build, and which writer placed THIS card cannot be told (${titles})`;
        else {
          writerBy = `the surviving copy ${hit.id} on card ${hit.card} is exactly the ${other} build (the rule said ${writer}: ${writerBy}, a fallback)`;
          writer = other;
        }
      } else if (it.object === "emails" && sameEntry(e, liveEntry(it.object, it.activityId, p, true))) {
        it.sibling.result = "pre-2026-09-23-live-build-without-body";
        if (rule.firm && writer !== "live") conflict = `the rule says ${writer} (${writerBy}), but the surviving copy ${hit.id} on card ${hit.card} `
          + `is the old live build without the email body (${titles})`;
        else {
          writerBy = `the surviving copy ${hit.id} on card ${hit.card} is the old live build, which sent no email body; restoring the current `
            + `live build WITH the body, so this is not an exact copy of it` + (writer !== "live" ? ` (the rule said ${writer}: ${writerBy}, a fallback)` : "");
          writer = "live"; bodyUpgrade = true;
        }
      } else {
        it.sibling.result = "differs";
        it.sibling.differences = differences(e, builds[writer]);
      }
    } else it.sibling = { result: "none-found", candidates: sib.candidates, looked: sib.looked, ...(sib.unreadable ? { unreadable: sib.unreadable } : {}) };
    const b = builds[writer];
    Object.assign(it, { writer, writerBy, entry: { custom_activity_id: b.custom_activity_id, title: b.title,
      contentLength: b.content.length, contentSha: sha(b.content), timestamp: b.timestamp ?? null } });
    if (conflict) return finish(it, "held-writer-conflict", { reason: conflict });
    if (it.sibling.result === "differs")
      return finish(it, "held-sibling-differs", { reason: `a surviving copy (${it.sibling.id} on ${it.sibling.card}) is not what either writer builds today: ${it.sibling.differences.join("; ")}` });
    // 4b. no surviving copy: today's build is only what was written if HubSpot has not changed since
    if (it.sibling.result === "none-found") {
      const c = await changedSinceWrite(it, writer, p);
      it.unproven = c;
      if (c.changed === null)
        return finish(it, "held-unproven", { reason: `no surviving copy to compare against; modified ${c.lastModified}, after ${c.writtenNoEarlierThan}, and ${c.by}` });
      if (c.changed.length)
        return finish(it, "held-changed-since-write", { reason: `no surviving copy to compare against, and HubSpot changed ${c.changed.join(", ")} after `
          + `${c.writtenNoEarlierThan} (the earliest the ${writer} writer can have written it), so today's build may not be what it wrote` });
    }
    if (it.object === "tasks") {
      const since = Date.now() - SWEEP_WINDOW_DAYS * 86_400_000;
      if ([p.hs_createdate, p.hs_lastmodifieddate].some(x => { const t = Date.parse(String(x ?? "")); return Number.isFinite(t) && t >= since; }))
        it.taskSweepWindow = `created or modified within the Worker's ${SWEEP_WINDOW_DAYS}-day Task sweep window (src/task-poller.ts `
          + `reconcileRecentTasks): its daily sweep may place this entry itself -- look at the card before and after`;
    }

    // 5. the writer's own placement rules
    const excluded = await writerExcludes(writer, it, p);
    if (excluded) return finish(it, "skipped-writer-excludes", { reason: excluded });
    if (!b.custom_activity_id) return finish(it, "skipped-no-type", { reason: `no custom activity type for ${it.object}` });
    if (sec(b.timestamp) === null) return finish(it, "skipped-no-timestamp", { reason: `no usable timestamp (${b.timestamp})` });
    if (WOULD_TRUNCATE.test(b.content))
      return finish(it, "held-would-truncate", { reason: `an unclosed "<" + letter, "/", "!" or "?" at ${b.content.search(WOULD_TRUNCATE)}: monday would cut the content there and drop the marker` });

    // 6. STILL MISSING? every known id NOT_FOUND, and the card's listing does not show the marker
    const ids = new Set([...(pairIds.get(key) ?? []), ...(Array.isArray(row.knownIds) ? row.knownIds.map(String) : [])]);
    it.check = { knownIds: ids.size, censusKnownIds: row.knownIds };
    if (typeof row.knownIds === "number" && ids.size < row.knownIds)
      return finish(it, "held-known-ids-mismatch", { reason: `the census knew ${row.knownIds} ids for this pair, the dedupe reports give ${ids.size}` });
    const there = await stillThere(it, ids, listing, prev, Infinity);
    if (there) return finish(it, ...there);
    if (prev?.newIds?.size)
      return finish(it, "held-previous-restore-gone", { reason: `${prev.files.join(", ")} restored it as ${[...prev.newIds].join(", ")}, which no longer exists -- look before restoring again` });
    if (prev?.uncertain)
      return finish(it, "held-previous-create-uncertain", { reason: `${prev.files.join(", ")} sent a create whose answer was lost, and no copy can be found` });
    const lossy = lossyHold(it);
    if (lossy) return finish(it, ...lossy);

    // 7. plan, or create
    if (!WRITE) return finish(it, bodyUpgrade ? "would-create-body-upgrade" : "would-create");
    if (stopReason) return finish(it, "not-reached", { reason: stopReason });
    if (createdThisRun.has(key)) return finish(it, "skipped-in-run-duplicate");
    if (CANARY && canaryUsed) return finish(it, "not-reached", { reason: "canary: one entry already created" });
    createdThisRun.add(key);                            // both taken before the next await: never twice, whatever else runs
    if (CANARY) canaryUsed = true;
    const release = () => { createdThisRun.delete(key); if (CANARY) canaryUsed = false; };
    // 7a. once more, right before sending: every known id, and the listing again when the cached walk is stale
    let again;
    try { again = await stillThere(it, ids, listing, prev, LISTING_MAX_AGE_MS) ?? lossyHold(it); }
    catch (e) { release(); throw e; }                 // nothing was sent: the canary slot and the pair are free again
    if (again) { release(); return finish(it, again[0], { ...again[1], recheck: "just before the create" }); }
    if (stopReason) { release(); return finish(it, "not-reached", { reason: stopReason }); }
    // 7b. on disk BEFORE the request: a run that dies from here on leaves a record the next run holds
    it.createSentAt = new Date().toISOString();
    it.outcome = "create-sent";
    save();
    const res = await createOnce({ i: it.card, a: b.custom_activity_id, t: b.title, s: b.summary, c: b.content, ts: b.timestamp });
    if (res.abort) stopReason ??= `aborted: ${String(res.failed ?? res.uncertain).slice(0, 160)}`;
    if (CANARY) stopReason ??= "canary: its one create was sent";
    if (res.id) { it.newId = res.id; save(); }     // recorded the moment monday gives it, before anything else can fail
    if (res.failed) return finish(it, "create-failed", { reason: `${res.failed} (it did not run; a re-run tries again)` });
    let newId = res.id ?? null, verifiedBy = "timeline_item";
    if (!newId) {
      // It may have landed. Look at the card instead of guessing, and never send it again.
      let after = null, walkError = null;
      try { after = await walk(it.card); }
      catch (e) { walkError = String(e?.message ?? e).slice(0, 120); if (e?.abort) stopReason ??= `aborted: ${walkError}`; }
      const seen = after ? own(after, it.card).find(e => String(e.content ?? "").includes(it.marker)) : null;
      if (!seen) return finish(it, "create-uncertain", { reason: `${res.uncertain}; ` + (walkError
        ? `the card could not be walked afterwards (${walkError})`
        : `the marker is not in the card's listing` + (after.lossy ? ` (lossy: ${after.unseen} of ${after.returned} rows never returned)` : "")) });
      newId = seen.id; verifiedBy = "listing";
      it.newId = newId; save();
    }
    let r = { state: "absent" };
    try {
      for (const wait of [0, 2000, 5000]) {
        if (wait) await sleep(wait);
        r = await entryById(newId);
        if (r.state === "present") break;
      }
    } catch (e) {
      // 401/403/daily limit while reading it back: monday gave the id, so it is recorded; the run stops.
      r = { state: "unknown", error: String(e?.message ?? e).slice(0, 160) };
      if (e?.abort) stopReason ??= `aborted: ${r.error}`;
    }
    if (r.state !== "present") return finish(it, "created-unverified", { newId, verifiedBy, reason: `timeline_item(${newId}) answers ${r.state}${r.error ? `: ${r.error}` : ""}` });
    const e = r.entry;
    // "AsShown": equal once monday's HTML escaping and its dropped leading whitespace are undone (see `shown`,
    // `shownContent`); raw equality is recorded beside it.
    const stored = { onCard: String(e.item?.id ?? "") === it.card, markerKept: String(e.content ?? "").includes(it.marker),
      titleAsShown: shown(e.title) === shown(b.title), contentAsShown: shownContent(e.content) === shownContent(b.content),
      contentRawEqual: String(e.content ?? "") === b.content,
      createdAt: e.created_at, createdAtExact: sec(e.created_at) === sec(b.timestamp) };
    if (!stored.onCard || !stored.markerKept)
      return finish(it, "created-marker-lost", { newId, verifiedBy, stored, reason: "monday did not keep the marker on this card -- look at it" });
    return finish(it, bodyUpgrade ? "created-body-upgrade" : "created", { newId, verifiedBy, stored, ...(res.uncertain ? { reason: res.uncertain } : {}) });
  }

  // ---------------------------------------------------------------- cards, a few at a time
  const groups = new Map();
  selected.forEach((r, i) => (groups.get(r.card) ?? groups.set(r.card, []).get(r.card)).push({ row: r, it: items[i] }));
  const queue = [...groups.entries()];
  async function doCard([cardId, list]) {
    const kind = list[0].row.kind;
    let card;
    try { card = await readCard(cardId, kind); }
    catch (e) {
      // Recorded, never thrown: a throw would end the whole process while another card's create is in flight.
      const msg = String(e?.message ?? e).slice(0, 140);
      if (e?.abort) stopReason ??= `aborted: ${msg}`;
      card = { ok: false, outcome: "check-failed", reason: `cannot read the card: ${msg}` };
    }
    /** The card's listing, walked once for its markers and again only when a caller needs it fresher. */
    let w = null;
    const listing = async (maxAgeMs = Infinity) => {
      if (w && Date.now() - w.at <= maxAgeMs) return w;
      const got = await walk(cardId);
      const mine = own(got, cardId);
      w = { at: Date.now(), own: mine, entries: mine.length, foreign: got.rows.size - mine.length, returned: got.returned,
        distinct: got.distinct, unseen: got.unseen, pages: got.pages, pageSizes: got.pageSizes, complete: got.complete,
        lossy: got.lossy, why: got.why };
      const walks = (report.cards[cardId]?.walks ?? 0) + 1;
      report.cards[cardId] = { kind, board: BOARD[kind].board, ownEntries: w.entries, rowsReturned: w.returned, distinctRows: w.distinct,
        unseenRows: w.unseen, pages: w.pages, pageSizes: w.pageSizes, complete: w.complete, lossy: w.lossy, walks,
        ...(w.foreign ? { foreignEntries: w.foreign } : {}), ...(w.why ? { why: w.why } : {}) };
      if (w.lossy && walks === 1) console.log(`  note: card ${cardId}: the listing returned ${w.returned} rows over ${w.pages} pages, ${w.distinct} distinct `
        + `(${w.unseen} never returned) -- lossy. The dedupe reports' ids came from the same listing, so neither check can see a copy it hides; `
        + `its items are ${ALLOW_LOSSY ? "restored anyway (--allow-lossy)" : "held unless --allow-lossy"}`);
      return w;
    };
    for (const { row, it } of list) {
      if (stopReason) { finish(it, "not-reached", { reason: stopReason }); continue; }
      try { await processItem(it, row, card, listing); }
      catch (e) {
        const msg = String(e?.message ?? e).slice(0, 200);
        if (e?.abort) stopReason ??= `aborted: ${msg.slice(0, 160)}`;
        // A create already sent stays on record as sent: the next run holds it rather than sending it again.
        finish(it, it.createSentAt ? (it.newId ? "created-unverified" : "create-uncertain") : "check-failed", { reason: msg });
      }
    }
  }
  const worker = async () => {
    while (queue.length && !stopReason) {
      const next = queue.shift();
      // Never reject: Promise.all would settle at once and the process end with another worker's create in flight.
      try { await doCard(next); } catch (e) { stopReason ??= `unexpected: ${String(e?.message ?? e).slice(0, 160)}`; }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const it of items) {
    if (it.outcome === "pending") it.outcome = "not-reached";
    else if (it.outcome === "create-sent") it.outcome = it.newId ? "created-unverified" : "create-uncertain";
  }

  report.done = !stopReason || stopReason.startsWith("canary");
  report.stopReason = stopReason ?? undefined;
  save();
  console.log(`\n${JSON.stringify(report.tally)}`);
  const lossy = Object.entries(report.cards).filter(([, c]) => c.lossy);
  if (lossy.length) console.log(`${lossy.length} card(s) with a lossy listing (rows returned/distinct): `
    + `${lossy.map(([c, x]) => `${c}=${x.rowsReturned}/${x.distinctRows}`).join(", ")}`
    + (ALLOW_LOSSY ? "" : " -- their items are held; look at each card in monday, then --allow-lossy --cards <card>"));
  if (stopReason && !stopReason.startsWith("canary")) console.log(`stopped: ${stopReason} -- fix it and run the same command again`);
  if (CANARY) console.log("canary: open the card's Emails & Activities in monday and check the entry before --apply"
    + " (on a lossy card, also that it is the only copy of its marker)");
  console.log(`report: ${out}${WRITE ? "" : "\n(dry run -- nothing created; --canary creates one, --apply all)"}`);
  if (stopReason && !stopReason.startsWith("canary")) process.exit(1);
}

// Run only when invoked, so the builders above can be imported (and checked against live entries) without side effects.
const invoked = process.argv[1] ? resolve(process.argv[1]) : "", self = fileURLToPath(import.meta.url);
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) await main();
