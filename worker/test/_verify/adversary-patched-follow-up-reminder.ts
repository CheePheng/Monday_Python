/**
 * ADVERSARY LENS -- NOT PRODUCTION CODE. A copy of worker/src/follow-up-reminder.ts (uncommitted rewrite, 2026-10-12)
 * with ONLY the minimal fixes the adversary simulation proposes, marked "FIX-n", so the same simulation can be run
 * against it (ADV_IMPL=patched) to show they close what it found:
 *
 *   FIX-1 the lapsed lock: renew the lock again right before the label (after the clear, which can take minutes);
 *         take the label's one rate-limit wait HERE, not inside gql (gql(..., 1, 0); on a refusal: wait, renew, re-stamp,
 *         re-send once), so no attempt is sent without a fresh lock; and release a note only while the lock is still
 *         this run's (a newer run may have flagged and noted "sent").
 *   FIX-2 the slow #07: never flag while 跟进提醒 shows the OTHER checkpoint's label that #07 has not finished yet
 *         (waits up to OTHER_SETTLE_MS), so no 已提醒 for it can arrive after this key's note.
 *   FIX-3 the skew window: the note records the change time the deciding run SAW; a stale note counts as landed only
 *         on a change strictly newer than that.
 *   FIX-4 the late clear: the clear is ONE attempt (not setColumns' three); a clear whose reply was lost sends no label
 *         this run (the note stays "pending", a later run reads the card).
 *   FIX-5 the settle window: the "pending" note is (re-)stamped immediately before the label request, so its age is the
 *         label's age -- FIX-1's single label request makes that the age of its only send.
 *
 * Everything else is byte-for-byte the rewrite's logic. Imports point at ../../src.
 */
import type { Env, RunOpts } from "../../src/types";
import { hs } from "../../src/hubspot";
import { findItemByColumn, getUsersByEmail, gql, MondayRateLimitedError } from "../../src/monday";
import { lookupCard } from "../../src/card-registry";
import { acquireLock, getWatermark, releaseLock, renewLock, setWatermark } from "../../src/activity-registry";
import { CRM_CONTACTS } from "../../src/config/crm";
import { changedMs, ownerColOf, ownerEmail, peopleOfCell, statusOfCell } from "../../src/owner-notice";

export function followUpReminderOn(env: { ENABLE_CRM?: string; FOLLOW_UP_REMINDER?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.FOLLOW_UP_REMINDER === "true";
}
export const FOLLOW_UP_CRON = "*/5 * * * *";
export const FOLLOW_UP = {
  statusCol: CRM_CONTACTS.followUpCol!,
  labels: { 30: "30分钟未跟进", 60: "60分钟未跟进" } as Record<30 | 60, string>,
  term: /docusign|hubspot/i,
  lifecycle: "lead",
  newLeadMs: 24 * 60 * 60_000,
  lookbackMs: 90 * 60_000,
};
/** Knobs for comparing two forms of FIX-1/FIX-5 (test code only): ADV_LABEL_WAITS = rate-limit waits inside the label
 *  request (0: none; 1: the rewrite's one), ADV_SETTLE_MIN = PENDING_SETTLE_MS in minutes. */
const LABEL_LOOP = (process.env.ADV_LABEL_WAITS ?? "loop") === "loop";   // DEFAULT: the one wait done HERE (renew, re-stamp, re-send)
const LABEL_WAITS = LABEL_LOOP ? 0 : Number(process.env.ADV_LABEL_WAITS);
export const PENDING_SETTLE_MS = Number(process.env.ADV_SETTLE_MIN ?? 3) * 60_000;
const CLOCK_SKEW_MS = 5_000;
const RUN_LOCK = "follow-up";
export const RUN_LOCK_HOLD_MS = 6 * 60_000;
export const RUN_DEADLINE_MS = 3.5 * 60_000;
const MAX_RATE_WAITS = 1;
/** FIX-2: how long the other checkpoint's label may wait on #07 before it is taken as stuck. */
const OTHER_SETTLE_MS = 10 * 60_000;
const SEARCH_PAGES = 5;
const MINUTE = 60_000;
const PROPS = ["hubspot_owner_id", "hubspot_owner_assigneddate", "createdate", "utm_term", "lifecyclestage",
  "notes_last_updated"];

export interface Candidate { id: string; owner: string; assigned: string; created: string; term: string; lifecycle: string; lastActivity: string }
export type Due = { checkpoint: 30 | 60 } | { skip: string };

function ms(raw: string): number {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
}

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
        { propertyName: "createdate", operator: "GTE", value: String(now - FOLLOW_UP.lookbackMs - FOLLOW_UP.newLeadMs) },
      ] }],
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

async function readContact(env: Env, id: string): Promise<Candidate | null> {
  let rec: any;
  try { rec = await hs(env, "GET", `/crm/v3/objects/contacts/${id}?properties=${PROPS.join(",")}`, undefined, 2); }
  catch (e) {
    if (/: 404\b/.test(String(e))) return null;
    throw e;
  }
  return candidateOf(id, rec?.properties ?? {});
}

type Cell = { id?: string; text?: string | null; value?: string | null; index?: number | null;
  persons_and_teams?: { id?: string | number; kind?: string }[] | null };

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

/** FIX-3: `seen` -- the change time the deciding run read; a change no newer than it is not this write landing. */
export function landedSince(cell: Cell | undefined, since: number, seen = NaN): boolean | null {
  if (!Number.isFinite(since)) return null;
  if (!statusOfCell(cell)) return false;
  const changed = changedMs(cell?.value);
  if (!Number.isFinite(changed)) return null;
  if (Number.isFinite(seen) && changed <= seen) return false;
  return changed >= since - CLOCK_SKEW_MS;
}

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

interface Run { id: string; now: () => number; userOf: (owner: string) => Promise<string | null> }
type Outcome = "flagged" | "already" | "resolved" | "skip" | "no-card" | "wait-owner" | "wait-07" | "unresolved" | "dry-run"
  | "lost-lock" | "error";
const clip = (e: unknown) => String(e).replace(/[^\s"'<>()]+@[^\s"'<>()]+/g, "<address>").slice(0, 160);

async function remindOne(env: Env, opts: RunOpts, run: Run, c: Candidate, checkpoint: 30 | 60, t: number):
    Promise<Outcome> {
  const at = ms(c.assigned);
  const key = `fur:${c.id}:${at}:${checkpoint}`;
  const label = FOLLOW_UP.labels[checkpoint];
  let item: string | null = null;
  const log = (action: Outcome, extra: string): Outcome => {
    console.log(`[follow-up] contact=${c.id} checkpoint=${checkpoint} item=${item ?? "-"} action=${action} ${extra}`);
    return action;
  };
  try {
    const note = await getWatermark(env, key);
    const parts = note?.startsWith("pending:") ? note.slice("pending:".length).split(":") : null;   // FIX-3
    const pending = parts ? Number(parts[0]) : null;
    const seenBefore = parts && parts[1] !== undefined ? Number(parts[1]) : NaN;
    if (note && pending === null) return "already";
    if (pending !== null && run.now() - pending < PENDING_SETTLE_MS) return "already";

    item = (await lookupCard(env, CRM_CONTACTS.boardId, c.id))
      ?? (await findItemByColumn(env, CRM_CONTACTS.boardId, CRM_CONTACTS.idCol, c.id, MAX_RATE_WAITS))[0]?.id ?? null;
    if (!item) return log("no-card", 'reason="no Contacts card for this contact yet: the next run tries again"');

    const fresh = await readContact(env, c.id);
    if (!fresh) return log("skip", 'reason="HubSpot has no such contact (404)"');
    if (ms(fresh.assigned) !== at)
      return log("skip", 'reason="reassigned since the search: the next run decides the new assignment"');
    const again = reminderDue(fresh, t);
    if ("skip" in again) return log("skip", `reason="read fresh: ${again.skip}"`);

    const cells = await readCells(env, item);
    if (!cells) return log("no-card", 'reason="the card is gone"');
    const shown = statusOfCell(cells.status);

    if (pending !== null) {
      const landed = landedSince(cells.status, pending, seenBefore);
      if (landed === null)
        return log("unresolved", `noted=${pending} label="${shown}" reason="unknown"`);
      if (landed) {
        if (!opts.dryRun) await setWatermark(env, key, `sent:${run.now()}`);
        return log("resolved", `label="${shown}" reason="an earlier run's write landed: noted as sent, nothing written"`);
      }
    }

    // FIX-2: the other checkpoint's label still waiting on #07 -- its 已提醒 could land after this key's note.
    const otherLabel = FOLLOW_UP.labels[checkpoint === 30 ? 60 : 30];
    const seen = changedMs(cells.status?.value);
    if (shown === otherLabel && run.now() - seen < OTHER_SETTLE_MS)
      return log("wait-07", `label="${shown}" reason="#07 has not finished the other reminder yet: nothing noted"`);

    const want = await run.userOf(fresh.owner);
    const people = peopleOfCell(cells.owner);
    if (want ? !(people.length === 1 && people[0] === `person:${want}`) : people.length > 0)
      return log("wait-owner", `owner=${fresh.owner} card_shows=${people.join(",") || "nobody"}`);
    const who = `owner=${fresh.owner}${want ? "" : " seat=none"}`;
    if (opts.dryRun) return log("dry-run", `label="${label}" ${who}`);

    if (!(await renewLock(env, RUN_LOCK, run.id)))
      return log("lost-lock", 'reason="the run lock passed to another run: this run writes nothing more"');

    const stamp = run.now();
    await setWatermark(env, key, `pending:${stamp}${Number.isFinite(seen) ? `:${seen}` : ""}`);   // FIX-3
    // FIX-1: a release only while the lock is still ours.
    const release = async () => {
      if (await renewLock(env, RUN_LOCK, run.id)) await setWatermark(env, key, "").catch(() => undefined);
    };
    if (shown === label) {
      // FIX-4: the clear in ONE attempt too. setColumns re-sends (retries=3), and a re-sent clear whose first attempt
      // commits late can empty the cell AFTER the label and #07's 已提醒 -- erasing the only proof the label landed.
      try {
        await gql(env,
          `mutation ($b: ID!, $i: ID!, $c: JSON!) {
             change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`,
          { b: CRM_CONTACTS.boardId, i: item, c: JSON.stringify({ [FOLLOW_UP.statusCol]: null }) }, 1, MAX_RATE_WAITS);
      } catch (e) {
        if (e instanceof MondayRateLimitedError) { await release(); throw e; }
        return log("unresolved", `noted=${stamp} reason="the clear failed with no proof it did not land (${clip(e)}):`
          + ` no label this run -- a later run reads the card"`);
      }
      // FIX-1: the clear can take minutes: renewed again right before the label, or nothing more is written.
      if (!(await renewLock(env, RUN_LOCK, run.id)))
        return log("lost-lock", 'reason="the run lock passed to another run during the clear: the label is not sent"');
      // FIX-5: re-stamped right before the label, so PENDING_SETTLE_MS counts from the label's send, not the clear's.
      await setWatermark(env, key, `pending:${run.now()}${Number.isFinite(seen) ? `:${seen}` : ""}`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await gql(env,
          `mutation ($b: ID!, $i: ID!, $c: JSON!) {
             change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`,
          { b: CRM_CONTACTS.boardId, i: item, c: JSON.stringify({ [FOLLOW_UP.statusCol]: { label } }) }, 1, LABEL_WAITS);   // FIX-1
        break;
      } catch (e) {
        if (e instanceof MondayRateLimitedError && LABEL_LOOP && attempt === 0) {
          // The refusal proves it never ran: wait as gql would, then -- still this run's? -- note afresh and re-send once.
          const s = /retry_in_seconds"?\s*:\s*(\d+)/i.exec(String(e))?.[1] ?? /reset in (\d+)/i.exec(String(e))?.[1];
          await new Promise(r => setTimeout(r, Math.min(s ? Number(s) + 1 : 15, 65) * 1000));
          if (!(await renewLock(env, RUN_LOCK, run.id)))
            return log("lost-lock", 'reason="the lock passed to another run during the rate-limit wait: the label is not re-sent"');
          await setWatermark(env, key, `pending:${run.now()}${Number.isFinite(seen) ? `:${seen}` : ""}`);   // FIX-5
          continue;
        }
        if (e instanceof MondayRateLimitedError) {
          await release();
          return log("error", 'reason="monday refused the label (rate-limited), so it never ran: released for the next run"');
        }
        return log("unresolved", `noted=${stamp} reason="the label write failed with no proof it did not land (${clip(e)})"`);
      }
    }
    await setWatermark(env, key, `sent:${run.now()}`).catch(e => console.log(`[follow-up] contact=${c.id}`
      + ` checkpoint=${checkpoint} item=${item} action=note-unsaved reason="${clip(e)}"`));
    return log("flagged", `label="${label}" ${who}${shown ? ` was="${shown}"` : ""}`);
  } catch (e) {
    return log("error", `reason="${clip(e)}"`);
  }
}

export interface ReminderStats {
  candidates: number; flagged: number; already: number; skipped: number; noCard: number; errors: number;
  resolved: number; waiting: number; unresolved: number; deferred: number; unread?: number; busy?: boolean;
}
const COUNTED: Partial<Record<Outcome, "flagged" | "already" | "resolved" | "skipped" | "noCard" | "waiting"
  | "unresolved" | "errors">> = {
  flagged: "flagged", already: "already", resolved: "resolved", skip: "skipped", "no-card": "noCard",
  "wait-owner": "waiting", "wait-07": "waiting", unresolved: "unresolved", error: "errors",
};

export async function runFollowUpReminders(env: Env, opts: RunOpts,
    clock: number | (() => number) = () => Date.now()): Promise<ReminderStats> {
  const now = typeof clock === "number" ? () => clock : clock;
  const stats: ReminderStats = { candidates: 0, flagged: 0, already: 0, skipped: 0, noCard: 0, errors: 0,
    resolved: 0, waiting: 0, unresolved: 0, deferred: 0 };
  if (!followUpReminderOn(env)) return stats;
  const run: Run = { id: crypto.randomUUID(), now, userOf: usersOf(env) };
  const started = now();
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
    if (found?.unread) stats.unread = found.unread;
    for (let i = 0; i < list.length; i++) {
      const t = now();
      const due = reminderDue(list[i], t);
      if ("skip" in due) { stats.skipped++; continue; }
      const late = t - started > RUN_DEADLINE_MS;
      const out = late ? null : await remindOne(env, opts, run, list[i], due.checkpoint, t);
      if (late || out === "lost-lock") {
        stats.deferred = list.slice(i).filter(c => !("skip" in reminderDue(c, t))).length;
        console.log(`[follow-up] action=stopped deferred=${stats.deferred}`);
        break;
      }
      const k = COUNTED[out!];
      if (k) stats[k]++;
    }
  } finally {
    if (locking) await releaseLock(env, RUN_LOCK, run.id);
  }
  console.log(`[follow-up] action=run ${JSON.stringify(stats)}`);
  return stats;
}
