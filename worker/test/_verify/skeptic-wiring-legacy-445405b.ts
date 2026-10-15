// skeptic-wiring: VERBATIM copy of worker/src/follow-up-reminder.ts at 445405b (HEAD; deployed as 428e8a01),
// produced by `git show HEAD:worker/src/follow-up-reminder.ts` with only the import paths rewritten (./x -> ../../src/x).
/**
 * 02.2 FOLLOW-UP REMINDER (FOLLOW_UP_REMINDER) -- the rule hiffer set on 2026-10-12, as agreed with the user:
 *
 *   - 30 and 60 minutes after the owner assignment (HubSpot `hubspot_owner_assigneddate`), at any hour;
 *   - NEW leads only: created within the 24 hours before that assignment. hiffer wrote "created today"; a rolling
 *     day keeps the intent (history is ignored) without losing a lead created at 23:50 whose 30 minutes end after
 *     midnight;
 *   - its term (`utm_term`, the Contacts "term" column) contains "hubspot" or "docusign", in any case;
 *   - Lifecycle Stage is 1.NEW (`lifecyclestage` "lead");
 *   - nothing logged SINCE THE ASSIGNMENT: Last Activity Date (`notes_last_updated`) empty or earlier than it. The
 *     user's choice ("option A", 2026-10-12): a contact that had activity before being (re)assigned is still
 *     reminded when its new owner logs nothing.
 *
 * Then the card's 跟进提醒 is set to 30分钟未跟进 or 60分钟未跟进 -- at most once per assignment and checkpoint --
 * and the board's workflow #07 emails the Contact owner (CC ZMark) and sets 已提醒. ALL the timing and every
 * condition live here: a monday workflow cannot time half-hours (it counts in days), so the workflow only sends,
 * the moment this flags the card -- the same split as the owner notice (#06).
 *
 * Run every 5 minutes by its own cron (index.ts), so a reminder lands 30-35 / 60-65 minutes after the assignment.
 * Each run asks HubSpot for the contacts assigned 30-90 minutes ago with Lifecycle 1.NEW and a term -- one search,
 * a handful of results -- and decides each with `reminderDue`, which is pure.
 *
 * NEVER TWICE. A reminder is noted durably (activity-registry watermark, fails closed) BEFORE the card is written,
 * keyed by contact, assignment stamp and checkpoint: a note that cannot be read or saved means no write. A write
 * that fails releases its note, so the next run retries it; a note left "pending" by a run that died is retried
 * once it is older than PENDING_RETRY_MS. A new assignment (a new stamp) is a new cycle with its own two reminders.
 *
 * Never writes HubSpot, never writes any column but 跟进提醒, writes nothing under DRY_RUN. Logs ids only.
 */
import type { Env, RunOpts } from "../../src/types";
import { hs } from "../../src/hubspot";
import { findItemByColumn, setColumns } from "../../src/monday";
import { lookupCard } from "../../src/card-registry";
import { getWatermark, setWatermark } from "../../src/activity-registry";
import { CRM_CONTACTS } from "../../src/config/crm";

/** Only the literal "true", and only on the CRM Worker. */
export function followUpReminderOn(env: { ENABLE_CRM?: string; FOLLOW_UP_REMINDER?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.FOLLOW_UP_REMINDER === "true";
}

/** The cron that runs it: every 5 minutes, offset by one minute so it never shares a tick with the 15-minute
 *  marketing poll (:00/:15/:30/:45), and NOT "*\/5", which index.ts reserves for the (unscheduled) task poller. */
export const FOLLOW_UP_CRON = "1,6,11,16,21,26,31,36,41,46,51,56 * * * *";

export const FOLLOW_UP = {
  /** Contacts 跟进提醒 (status), created 2026-10-12. Labels: 0 30分钟未跟进, 2 60分钟未跟进, 1 已提醒 (the workflow's). */
  statusCol: "color_mm82ccsb",
  labels: { 30: "30分钟未跟进", 60: "60分钟未跟进" } as Record<30 | 60, string>,
  term: /docusign|hubspot/i,
  lifecycle: "lead",                 // 1.NEW
  newLeadMs: 24 * 60 * 60_000,       // created within this long before the assignment
  lookbackMs: 90 * 60_000,           // assignments older than this are not reminded (a missed run is not news)
};
const PENDING_RETRY_MS = 10 * 60_000;
const MINUTE = 60_000;

export interface Candidate {
  id: string;
  owner: string;
  assigned: string;          // HubSpot's raw stamp: part of the cycle key
  created: string;
  term: string;
  lifecycle: string;
  lastActivity: string;
}
export type Due = { checkpoint: 30 | 60 } | { skip: string };

/** epoch ms from HubSpot's ISO string or epoch-ms string; NaN when absent. */
function ms(raw: string): number {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
}

/** Which reminder is due for this contact now, or why none. Pure. */
export function reminderDue(c: Candidate, now: number): Due {
  if (!c.owner.trim()) return { skip: "no owner" };
  const assigned = ms(c.assigned), created = ms(c.created);
  if (!Number.isFinite(assigned)) return { skip: "no assignment time" };
  if (!Number.isFinite(created) || assigned - created > FOLLOW_UP.newLeadMs) return { skip: "not a new lead" };
  if (!FOLLOW_UP.term.test(c.term ?? "")) return { skip: "term has neither hubspot nor docusign" };
  if ((c.lifecycle ?? "").trim() !== FOLLOW_UP.lifecycle) return { skip: "lifecycle is not 1.NEW" };
  const activity = ms(c.lastActivity);
  if (Number.isFinite(activity) && activity >= assigned) return { skip: "followed up since the assignment" };
  const age = now - assigned;
  if (age > FOLLOW_UP.lookbackMs) return { skip: "assignment too old" };
  if (age >= 60 * MINUTE) return { checkpoint: 60 };
  if (age >= 30 * MINUTE) return { checkpoint: 30 };
  return { skip: "not 30 minutes yet" };
}

/** The contacts assigned 30-90 minutes ago that match on HubSpot's side; reminderDue decides the rest. */
async function candidates(env: Env, now: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await hs(env, "POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [
        { propertyName: "hubspot_owner_assigneddate", operator: "GTE", value: String(now - FOLLOW_UP.lookbackMs) },
        { propertyName: "hubspot_owner_assigneddate", operator: "LTE", value: String(now - 30 * MINUTE) },
        { propertyName: "lifecyclestage", operator: "EQ", value: FOLLOW_UP.lifecycle },
        { propertyName: "utm_term", operator: "HAS_PROPERTY" },
        // No activity filter here: an activity BEFORE the assignment does not count, so reminderDue compares dates.
      ] }],
      properties: ["hubspot_owner_id", "hubspot_owner_assigneddate", "createdate", "utm_term", "lifecyclestage", "notes_last_updated"],
      limit: 100, ...(after ? { after } : {}),
    });
    for (const r of res?.results ?? []) {
      const p = r.properties ?? {};
      out.push({ id: String(r.id), owner: String(p.hubspot_owner_id ?? ""), assigned: String(p.hubspot_owner_assigneddate ?? ""),
        created: String(p.createdate ?? ""), term: String(p.utm_term ?? ""), lifecycle: String(p.lifecyclestage ?? ""),
        lastActivity: String(p.notes_last_updated ?? "") });
    }
    after = res?.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

export interface ReminderStats { candidates: number; flagged: number; already: number; skipped: number; noCard: number; errors: number }

/** One run: decide every candidate and flag the due ones. Never throws (each contact is caught on its own). */
export async function runFollowUpReminders(env: Env, opts: RunOpts, now = Date.now()): Promise<ReminderStats> {
  const stats: ReminderStats = { candidates: 0, flagged: 0, already: 0, skipped: 0, noCard: 0, errors: 0 };
  if (!followUpReminderOn(env)) return stats;
  let list: Candidate[];
  try { list = await candidates(env, now); }
  catch (e) {
    console.log(`[follow-up] action=error reason="search failed: ${String(e).slice(0, 140)}"`);
    stats.errors++;
    return stats;
  }
  stats.candidates = list.length;
  for (const c of list) {
    const due = reminderDue(c, now);
    if ("skip" in due) { stats.skipped++; continue; }
    const label = FOLLOW_UP.labels[due.checkpoint];
    const noteName = `fur:${c.id}:${c.assigned}:${due.checkpoint}`;
    const tag = `contact=${c.id} checkpoint=${due.checkpoint}`;
    try {
      const note = await getWatermark(env, noteName);
      if (note && !(note.startsWith("pending:") && now - Number(note.slice(8)) > PENDING_RETRY_MS)) {
        stats.already++;
        continue;
      }
      const item = (await lookupCard(env, CRM_CONTACTS.boardId, c.id))
        ?? (await findItemByColumn(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, c.id, 1))[0]?.id ?? null;
      if (!item) {
        stats.noCard++;
        console.log(`[follow-up] ${tag} action=no-card reason="no Contacts card for this contact yet: the next run tries again"`);
        continue;
      }
      if (opts.dryRun) {
        console.log(`[follow-up] ${tag} item=${item} action=dry-run label="${label}"`);
        continue;
      }
      await setWatermark(env, noteName, `pending:${now}`);
      try {
        // Cleared first, so the workflow's "changes to" trigger fires even when the cell already shows this label
        // from an earlier cycle whose workflow run never finished.
        await setColumns(env, CRM_CONTACTS.boardId, item, { [FOLLOW_UP.statusCol]: null }, opts, 1);
        await setColumns(env, CRM_CONTACTS.boardId, item, { [FOLLOW_UP.statusCol]: { label } }, opts, 1);
      } catch (e) {
        await setWatermark(env, noteName, "").catch(() => undefined);
        throw e;
      }
      await setWatermark(env, noteName, `sent:${now}`);
      stats.flagged++;
      console.log(`[follow-up] ${tag} item=${item} action=flagged label="${label}" owner=${c.owner}`);
    } catch (e) {
      stats.errors++;
      console.log(`[follow-up] ${tag} action=error reason="${String(e).replace(/[^\s"'<>()]+@[^\s"'<>()]+/g, "<address>").slice(0, 160)}"`);
    }
  }
  // One line per run, empty or not: proof in the logs that the five-minute cron is alive.
  console.log(`[follow-up] action=run ${JSON.stringify(stats)}`);
  return stats;
}
