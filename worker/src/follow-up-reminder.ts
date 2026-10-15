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
 * and the board's workflow #07 (30) or #07b (60) emails the card's Contact owner (CC ZMark) and sets 已提醒. ALL the
 * timing and every condition live here: a monday workflow cannot time half-hours (it counts in days), so the
 * workflow only sends, the moment this flags the card -- the same split as the owner notice (#06).
 *
 * Run every 5 minutes by its own cron (index.ts), so a reminder lands 30-35 / 60-65 minutes after the assignment.
 * Each run asks HubSpot for the contacts assigned 30-90 minutes ago with Lifecycle 1.NEW and a term, created
 * recently enough to be new leads, oldest assignment first -- one search, a handful of results -- and decides each
 * with `reminderDue`, which is pure: first on the search's values, then, before anything is written, on the record
 * READ FRESH. HubSpot's search index lags its writes by minutes, so a call logged just before the run, or a
 * reassignment, would otherwise still be reminded about.
 *
 * WHOM #07 MAILS IS THE CARD'S Contact owner, not HubSpot's: a card is flagged only once that cell shows exactly the
 * monday user the sync puts there for HubSpot's owner (the owner notice's rule, owner-notice.ts). Until it does the
 * run waits ("wait-owner") -- nothing noted, the next run looks again -- so a card still showing the previous owner
 * never mails them. An owner with no monday account leaves that cell empty, and the card is flagged all the same
 * (logged `seat=none`): #07 has no To then, and only its CC, ZMark, can be told.
 *
 * NEVER TWICE. #07 mails on every change INTO a trigger label, so for one assignment and checkpoint the label is
 * written at most once:
 *   - ONE RUN AT A TIME: a run lock (RUN_LOCK), renewed -- never re-taken -- right before each card's write, so a run
 *     that overran its hold writes nothing once another run has taken over;
 *   - A DURABLE NOTE per contact, assignment and checkpoint (activity-registry watermark; fails closed: a note that
 *     cannot be read or saved means no write), saved "pending:<time>" BEFORE the write -- that time taken at the
 *     write, never at the run's start -- and "sent:<time>" after it;
 *   - THE LABEL IS ONE ATTEMPT (gql retries=1): a write whose response was lost is never re-sent. Only a rate-limit
 *     refusal -- monday's proof it never ran (MondayRateLimitedError) -- releases the note for the next run; any
 *     other failure leaves it "pending";
 *   - A "PENDING" NOTE IS RESOLVED FROM THE CARD, never re-flagged blind, once older than PENDING_SETTLE_MS:
 *     跟进提醒 changed since the note's time (our label, or #07's 已提醒 after it) means the write landed -- noted
 *     "sent", nothing written; an empty cell, or one unchanged since before the note, means it did not -- flagged
 *     now; a label monday gives no change time for is left alone, loudly ("unresolved").
 * A new assignment (a new stamp) is a new cycle with its own two reminders.
 *
 * Never writes HubSpot, never writes any column but 跟进提醒, writes nothing under DRY_RUN -- no note, no lock. Logs
 * ids only.
 */
import type { Env, RunOpts } from "./types";
import { hs } from "./hubspot";
import { findItemByColumn, getUsersByEmail, gql, MondayRateLimitedError, setColumns } from "./monday";
import { lookupCard } from "./card-registry";
import { acquireLock, getWatermark, releaseLock, renewLock, setWatermark } from "./activity-registry";
import { CRM_CONTACTS } from "./config/crm";
import { changedMs, ownerColOf, ownerEmail, peopleOfCell, statusOfCell } from "./owner-notice";

/** Only the literal "true", and only on the CRM Worker. */
export function followUpReminderOn(env: { ENABLE_CRM?: string; FOLLOW_UP_REMINDER?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.FOLLOW_UP_REMINDER === "true";
}

/** The cron that runs it: every 5 minutes. A plain step expression on purpose: the first one, a minute list
 *  ("1,6,11,...,56"), deployed and was listed by Cloudflare but NEVER FIRED (watched 07:07-07:38 UTC on 2026-10-12,
 *  while "*\/15" fired on time). On the CRM Worker index.ts runs this, never the task poller, on "*\/5"; a Worker
 *  without ENABLE_CRM (the WM one) still polls tasks on it. */
export const FOLLOW_UP_CRON = "*/5 * * * *";

export const FOLLOW_UP = {
  /** Contacts 跟进提醒 (status; ObjectSpec.followUpCol). Labels: 0 30分钟未跟进, 2 60分钟未跟进, 1 已提醒 (the workflow's). */
  statusCol: CRM_CONTACTS.followUpCol!,
  labels: { 30: "30分钟未跟进", 60: "60分钟未跟进" } as Record<30 | 60, string>,
  term: /docusign|hubspot/i,
  lifecycle: "lead",                 // 1.NEW
  newLeadMs: 24 * 60 * 60_000,       // created within this long before the assignment
  lookbackMs: 90 * 60_000,           // assignments older than this are not reminded (a missed run is not news)
};

/** A "pending" note younger than this may belong to a write still landing -- monday can commit a write after the
 *  reply to it timed out -- and is left alone; an older one is resolved from the card. */
export const PENDING_SETTLE_MS = 3 * 60_000;
/** monday stamps changed_at by its own clock; a note's time is taken just before its write. */
const CLOCK_SKEW_MS = 5_000;
/**
 * THE RUN LOCK: one run at a time. Renewed right before each card's write, so its hold only has to outlast one
 * card's reads and write -- a few monday calls, each allowed one rate-limit wait -- and a run that dies holding it
 * (a deploy) keeps the runs after it out for no longer than this.
 */
const RUN_LOCK = "follow-up";
export const RUN_LOCK_HOLD_MS = 6 * 60_000;
/** No card is started after this much of a run: the run five minutes on takes the rest. */
export const RUN_DEADLINE_MS = 3.5 * 60_000;
/** monday rate-limit waits allowed per monday call (the owner notice's allowance). */
const MAX_RATE_WAITS = 1;
/** The search reads at most this many pages of 100. */
const SEARCH_PAGES = 5;
const MINUTE = 60_000;
const PROPS = ["hubspot_owner_id", "hubspot_owner_assigneddate", "createdate", "utm_term", "lifecyclestage",
  "notes_last_updated"];

export interface Candidate {
  id: string;
  owner: string;
  assigned: string;          // HubSpot's raw stamp; the cycle key uses its time
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

const candidateOf = (id: string, p: Record<string, unknown>): Candidate => ({
  id, owner: String(p.hubspot_owner_id ?? ""), assigned: String(p.hubspot_owner_assigneddate ?? ""),
  created: String(p.createdate ?? ""), term: String(p.utm_term ?? ""), lifecycle: String(p.lifecyclestage ?? ""),
  lastActivity: String(p.notes_last_updated ?? ""),
});

/** The contacts assigned 30-90 minutes ago that match on HubSpot's side, oldest assignment first; reminderDue
 *  decides the rest. `unread`: how many matched beyond the last page read. */
async function candidates(env: Env, now: number): Promise<{ list: Candidate[]; unread: number }> {
  const list: Candidate[] = [];
  let after: string | undefined;
  let total = 0;
  for (let page = 0; page < SEARCH_PAGES; page++) {
    const res = await hs(env, "POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [
        { propertyName: "hubspot_owner_assigneddate", operator: "GTE", value: String(now - FOLLOW_UP.lookbackMs) },
        { propertyName: "hubspot_owner_assigneddate", operator: "LTE", value: String(now - 30 * MINUTE) },
        { propertyName: "lifecyclestage", operator: "EQ", value: FOLLOW_UP.lifecycle },
        { propertyName: "utm_term", operator: "HAS_PROPERTY" },
        // Young enough to be a new lead (reminderDue applies the exact 24 h): without it a bulk reassignment of old
        // 1.NEW contacts could fill every page, and a new lead behind them was never read.
        { propertyName: "createdate", operator: "GTE", value: String(now - FOLLOW_UP.lookbackMs - FOLLOW_UP.newLeadMs) },
        // No activity filter here: an activity BEFORE the assignment does not count, so reminderDue compares dates.
      ] }],
      // Unsorted, HubSpot returns the oldest records first. The oldest assignment is the nearest to leaving the window.
      sorts: [{ propertyName: "hubspot_owner_assigneddate", direction: "ASCENDING" }],
      properties: PROPS, limit: 100, ...(after ? { after } : {}),
    });
    for (const r of res?.results ?? []) list.push(candidateOf(String(r.id), r.properties ?? {}));
    total = Number(res?.total) || 0;
    after = res?.paging?.next?.after;
    if (!after) break;
  }
  return { list, unread: after ? Math.max(total - list.length, 1) : 0 };
}

/** The contact as HubSpot holds it now -- not as its search index last saw it. null: HubSpot has no such contact. */
async function readContact(env: Env, id: string): Promise<Candidate | null> {
  let rec: any;
  try { rec = await hs(env, "GET", `/crm/v3/objects/contacts/${id}?properties=${PROPS.join(",")}`, undefined, 2); }
  catch (e) {
    if (/: 404\b/.test(String(e))) return null;
    throw e;
  }
  return candidateOf(id, rec?.properties ?? {});
}

/** A card cell as read here: a status cell with its index, a People cell with its people (owner-notice's shape). */
type Cell = { id?: string; text?: string | null; value?: string | null; index?: number | null;
  persons_and_teams?: { id?: string | number; kind?: string }[] | null };

/** The card's side, in one read: 跟进提醒 (its index and changed_at) and the Contact owner, whom #07 mails. null: no
 *  such card. */
async function readCells(env: Env, item: string): Promise<{ status?: Cell; owner?: Cell } | null> {
  const ownerCol = ownerColOf(CRM_CONTACTS);
  if (!ownerCol) throw new Error("the Contacts spec maps no owner People column: whom #07 mails cannot be checked");
  const d = await gql(env,
    `query ($i: [ID!]) { items(ids: $i) { column_values(ids: ["${FOLLOW_UP.statusCol}", "${ownerCol}"]) {
       id text value ... on StatusValue { index } ... on PeopleValue { persons_and_teams { id kind } } } } }`,
    { i: [item] }, 2, MAX_RATE_WAITS);
  if (!d?.items?.length) return null;
  const cells: Cell[] = d.items[0]?.column_values ?? [];
  return { status: cells.find(c => c?.id === FOLLOW_UP.statusCol), owner: cells.find(c => c?.id === ownerCol) };
}

/**
 * Whether a write made at or after `since` has reached 跟进提醒. true: the cell holds a label set since then -- ours,
 * or #07's 已提醒 after it (nothing else writes this column). false: it is empty -- read by its index, so an unset
 * cell's phantom text is ignored -- or unchanged since before then. null: it holds a label monday gives no change
 * time for, or `since` is no time at all.
 */
export function landedSince(cell: Cell | undefined, since: number): boolean | null {
  if (!Number.isFinite(since)) return null;
  if (!statusOfCell(cell)) return false;
  const changed = changedMs(cell?.value);
  if (!Number.isFinite(changed)) return null;
  return changed >= since - CLOCK_SKEW_MS;
}

/**
 * The monday user the sync writes into the card's Contact owner for a HubSpot owner -- the person #07 mails; null:
 * none (no monday account, or HubSpot has no such owner). Each owner's email, and monday's user list, are read once
 * a run.
 */
function usersOf(env: Env): (owner: string) => Promise<string | null> {
  const emails = new Map<string, string | null>();
  let users: Record<string, string> | null = null;
  return async (owner) => {
    if (!emails.has(owner)) emails.set(owner, await ownerEmail(env, undefined, owner));
    const email = emails.get(owner);
    if (!email) return null;
    users ??= await getUsersByEmail(env, MAX_RATE_WAITS);
    return users[email] ?? null;
  };
}

/** One run: its lock's id, its clock, and its owner lookups. */
interface Run { id: string; now: () => number; userOf: (owner: string) => Promise<string | null> }

/** What one contact came to. Only "flagged" wrote the label. */
type Outcome = "flagged" | "already" | "resolved" | "skip" | "no-card" | "wait-owner" | "unresolved" | "dry-run"
  | "lost-lock" | "error";

/** An error for a log line: addresses out, kept short. */
const clip = (e: unknown) => String(e).replace(/[^\s"'<>()]+@[^\s"'<>()]+/g, "<address>").slice(0, 160);

/** Decide one due contact and flag its card -- at most once (the header). Never throws. */
async function remindOne(env: Env, opts: RunOpts, run: Run, c: Candidate, checkpoint: 30 | 60, t: number):
    Promise<Outcome> {
  const at = ms(c.assigned);
  // Keyed by the assignment's TIME, not HubSpot's string for it: one assignment read as ISO here and as epoch ms
  // there is still one cycle.
  const key = `fur:${c.id}:${at}:${checkpoint}`;
  const label = FOLLOW_UP.labels[checkpoint];
  let item: string | null = null;
  const log = (action: Outcome, extra: string): Outcome => {
    console.log(`[follow-up] contact=${c.id} checkpoint=${checkpoint} item=${item ?? "-"} action=${action} ${extra}`);
    return action;
  };
  try {
    // Read LOUDLY (a throw is an error, and the next run tries again): "unreadable" must never pass for "never
    // flagged".
    const note = await getWatermark(env, key);
    const pending = note?.startsWith("pending:") ? Number(note.slice("pending:".length)) : null;
    if (note && pending === null) return "already";                                     // sent
    if (pending !== null && run.now() - pending < PENDING_SETTLE_MS) return "already";   // may still be landing

    item = (await lookupCard(env, CRM_CONTACTS.boardId, c.id))
      ?? (await findItemByColumn(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, c.id, MAX_RATE_WAITS))[0]?.id ?? null;
    if (!item) return log("no-card", 'reason="no Contacts card for this contact yet: the next run tries again"');

    // READ FRESH (the header): every condition again, on the record itself.
    const fresh = await readContact(env, c.id);
    if (!fresh) return log("skip", 'reason="HubSpot has no such contact (404)"');
    if (ms(fresh.assigned) !== at)
      return log("skip", 'reason="reassigned since the search: the next run decides the new assignment"');
    const again = reminderDue(fresh, t);
    if ("skip" in again) return log("skip", `reason="read fresh: ${again.skip}"`);

    const cells = await readCells(env, item);
    if (!cells) return log("no-card", 'reason="the card is gone"');
    const shown = statusOfCell(cells.status);

    // A STALE "PENDING" (the header): did its write land? Read from the card, never guessed.
    if (pending !== null) {
      const landed = landedSince(cells.status, pending);
      if (landed === null)
        return log("unresolved", `noted=${pending} label="${shown}" reason="an earlier run noted this reminder pending,`
          + ` and 跟进提醒 shows a label monday gives no change time for: whether that write landed is unknown, so`
          + ` nothing is written"`);
      if (landed) {
        if (!opts.dryRun) await setWatermark(env, key, `sent:${run.now()}`);
        return log("resolved", `label="${shown}" reason="an earlier run's write landed (跟进提醒 changed after its`
          + ` note): noted as sent, nothing written"`);
      }
      // Not landed: that run stopped before its label reached the card. Flagged now -- once.
    }

    // WHOM #07 MAILS (the header): the card's Contact owner must show HubSpot's owner -- nobody, for an owner with no
    // monday account.
    const want = await run.userOf(fresh.owner);
    const people = peopleOfCell(cells.owner);
    if (want ? !(people.length === 1 && people[0] === `person:${want}`) : people.length > 0)
      return log("wait-owner", `owner=${fresh.owner} card_shows=${people.join(",") || "nobody"}`
        + ` wants=${want ? `person:${want}` : "nobody"} reason="#07 mails the card's Contact owner, which does not show`
        + ` HubSpot's owner yet: nothing noted, the next run looks again"`);
    const who = `owner=${fresh.owner}${want ? "" : " seat=none"}`;
    if (opts.dryRun) return log("dry-run", `label="${label}" ${who}`);

    // Still this run's? RENEWED, never re-taken (the header).
    if (!(await renewLock(env, RUN_LOCK, run.id)))
      return log("lost-lock", 'reason="the run lock passed to another run: this run writes nothing more"');

    // The note BEFORE the write, stamped now. Not saved: not written (the throw is an error).
    const stamp = run.now();
    await setWatermark(env, key, `pending:${stamp}`);
    // #07 fires on a CHANGE into the label, so a cell already showing it -- an earlier cycle's flag the workflow never
    // finished -- is cleared first. A clear mails nobody, so re-sending one is harmless; one that failed means the
    // label never left, and the note is released for the next run.
    if (shown === label) {
      try { await setColumns(env, CRM_CONTACTS.boardId, item, { [FOLLOW_UP.statusCol]: null }, opts, MAX_RATE_WAITS); }
      catch (e) {
        await setWatermark(env, key, "").catch(() => undefined);
        throw e;
      }
    }
    // THE LABEL, in ONE attempt (the header): only a rate-limit refusal proves it never ran.
    try {
      await gql(env,
        `mutation ($b: ID!, $i: ID!, $c: JSON!) {
           change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`,
        { b: CRM_CONTACTS.boardId, i: item, c: JSON.stringify({ [FOLLOW_UP.statusCol]: { label } }) }, 1, MAX_RATE_WAITS);
    } catch (e) {
      if (e instanceof MondayRateLimitedError) {
        await setWatermark(env, key, "").catch(() => undefined);
        return log("error", 'reason="monday refused the label (rate-limited), so it never ran: released for the next run"');
      }
      return log("unresolved", `noted=${stamp} reason="the label write failed with no proof it did not land`
        + ` (${clip(e)}): left pending -- a run ${PENDING_SETTLE_MS / MINUTE} min on reads the card to tell"`);
    }
    // A note left "pending" here is resolved from the card by a later run, as landed: logged, never sent again.
    await setWatermark(env, key, `sent:${run.now()}`).catch(e => console.log(`[follow-up] contact=${c.id}`
      + ` checkpoint=${checkpoint} item=${item} action=note-unsaved reason="${clip(e)}: a later run reads the card"`));
    return log("flagged", `label="${label}" ${who}${shown ? ` was="${shown}"` : ""}`);
  } catch (e) {
    return log("error", `reason="${clip(e)}"`);
  }
}

export interface ReminderStats {
  candidates: number; flagged: number; already: number; skipped: number; noCard: number; errors: number;
  /** "pending" notes resolved from the card as landed: noted sent, nothing written */
  resolved: number;
  /** the card's Contact owner did not show HubSpot's owner yet: nothing noted, the next run looks again */
  waiting: number;
  /** a write that may have landed, left pending, or a pending note the card cannot settle: nothing written */
  unresolved: number;
  /** due contacts not looked at: the run reached its deadline, or lost its lock -- the next run takes them */
  deferred: number;
  /** search results beyond the last page read */
  unread?: number;
  /** another run held the lock: this one did nothing */
  busy?: boolean;
}

const COUNTED: Partial<Record<Outcome, "flagged" | "already" | "resolved" | "skipped" | "noCard" | "waiting"
  | "unresolved" | "errors">> = {
  flagged: "flagged", already: "already", resolved: "resolved", skip: "skipped", "no-card": "noCard",
  "wait-owner": "waiting", unresolved: "unresolved", error: "errors",
};

/**
 * One run: decide every candidate and flag the due ones. Never throws (each contact is caught on its own). `clock`
 * is for tests: a number is a clock that stands still.
 */
export async function runFollowUpReminders(env: Env, opts: RunOpts,
    clock: number | (() => number) = () => Date.now()): Promise<ReminderStats> {
  const now = typeof clock === "number" ? () => clock : clock;
  const stats: ReminderStats = { candidates: 0, flagged: 0, already: 0, skipped: 0, noCard: 0, errors: 0,
    resolved: 0, waiting: 0, unresolved: 0, deferred: 0 };
  if (!followUpReminderOn(env)) return stats;
  const run: Run = { id: crypto.randomUUID(), now, userOf: usersOf(env) };
  const started = now();
  // One run at a time (the header). DRY_RUN writes nothing, so takes no lock.
  const locking = !opts.dryRun;
  if (locking && !(await acquireLock(env, RUN_LOCK, RUN_LOCK_HOLD_MS, run.id))) {
    stats.busy = true;
    console.log(`[follow-up] action=run ${JSON.stringify(stats)} reason="another run holds the lock"`);
    return stats;
  }
  try {
    let found: { list: Candidate[]; unread: number } | null = null;
    try { found = await candidates(env, started); }
    catch (e) {
      console.log(`[follow-up] action=error reason="search failed: ${clip(e)}"`);
      stats.errors++;
    }
    const list = found?.list ?? [];
    stats.candidates = list.length;
    if (found?.unread) {
      stats.unread = found.unread;
      console.log(`[follow-up] action=truncated read=${list.length} unread=${found.unread} reason="more contacts`
        + ` matched than ${SEARCH_PAGES} pages hold: the oldest assignments were read first"`);
    }
    for (let i = 0; i < list.length; i++) {
      const t = now();
      const due = reminderDue(list[i], t);
      if ("skip" in due) { stats.skipped++; continue; }
      const late = t - started > RUN_DEADLINE_MS;
      const out = late ? null : await remindOne(env, opts, run, list[i], due.checkpoint, t);
      if (late || out === "lost-lock") {
        stats.deferred = list.slice(i).filter(c => !("skip" in reminderDue(c, t))).length;
        console.log(`[follow-up] action=stopped deferred=${stats.deferred} reason="${late
          ? `the run is past its ${RUN_DEADLINE_MS / 1000} s` : "the run lock passed to another run"}: the next run takes`
          + ` the rest"`);
        break;
      }
      const k = COUNTED[out!];
      if (k) stats[k]++;
    }
  } finally {
    if (locking) await releaseLock(env, RUN_LOCK, run.id);
  }
  // One line per run, empty or not: proof in the logs that the five-minute cron is alive.
  console.log(`[follow-up] action=run ${JSON.stringify(stats)}`);
  return stats;
}
