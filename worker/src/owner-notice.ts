/**
 * THE OWNER NOTICE: tell a contact's owner, once per assignment, that the contact is now theirs. OWNER_NOTICE.
 *
 * WHY THE WORKER WRITES A COLUMN INSTEAD OF SENDING MAIL. The board already sends its assignment emails through
 * monday's own Gmail connection (askada@asiadt.com), and the business chose to keep it that way rather than
 * give this Worker a mailbox (2026-10-09). What monday cannot do is the decision: "is HubSpot's owner someone
 * other than the person last told?" -- a workflow cannot compare two columns. So the Worker makes exactly that
 * decision and writes the owner's email into 上次通知Owner (ObjectSpec.ownerNoticeCol, the column hiffer added
 * for this), and the board's automation "When 上次通知Owner changes -> send email" does the sending. Lark is
 * hiffer's own automation on the same trigger, and nothing here knows about it.
 *
 * WHY THIS ENDS THE DUPLICATE EMAILS. The old reminders fired on "When Contact owner changes", and the sync
 * writes that cell more than once for one reassignment: the same email went out twice, half a second apart, on
 * 2 and 5 Oct. This column is written at most once per owner: the notices run one at a time in the durable
 * queue, under a per-contact lock besides, and write only when the last owner told is someone else.
 *
 * ONLY A NEW ASSIGNMENT IS ANNOUNCED. HubSpot fires an owner propertyChange for writes that change nothing (an
 * import or a workflow re-setting the same owner), and a card can carry no record of who was told -- so "the
 * owner differs from what we last told" alone would email Myla about a contact she has owned since June. HubSpot
 * resets hubspot_owner_assigneddate on every real (re)assignment, so the notice also requires that assignment to
 * be recent (NOTICE_WINDOW_MS); an older one is only remembered.
 *
 * HUBSPOT DECIDES, READ INSIDE THE LOCK AND AGAIN JUST BEFORE THE WRITE: nothing is taken from the caller, and a
 * monday rate-limit wait in between (up to a minute) cannot let an owner HubSpot has already replaced be
 * announced.
 *
 * WHERE IT RUNS: in the DEFERRED_SYNC queue (DeferredItem.notice), never inline. A webhook's own work is cut off
 * about 30 s after its response and a notice can wait on monday longer than that; the queue has minutes, runs
 * entries one at a time, and retries a notice that found the contact busy. Every trigger only enqueues
 * (queueOwnerNotices): the owner-change webhook, a card the Worker creates, and a contact created from the monday
 * form once its HubSpot record exists. A burst for one contact is one entry (the queue deduplicates).
 *
 * NEVER THROWS, never writes anything but that one column, and writes nothing at all under DRY_RUN.
 */
import type { Ctx, Env, ObjectSpec } from "./types";
import { hs } from "./hubspot";
import { findItemByColumn, gql } from "./monday";
import { lookupCard } from "./card-registry";
import { acquireLock, lastNoticedOwner, releaseLock, rememberNoticedOwner } from "./activity-registry";
import { specByObject } from "./config";
import { webhookOpts } from "./run-opts";
import { spillDeferred } from "./deferred-sync";

/** An assignment older than this is not news: remembered, nobody told. HubSpot stamps the assignment time on
 *  every real (re)assignment, and the queue reaches it within a minute or two. */
export const NOTICE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The per-contact lock -- a second guard behind the queue's one-at-a-time, for the inline fallback. Long enough
 * to cover the two HubSpot reads, one monday rate-limit wait (the calls inside allow at most one, 15-65 s) and
 * the write; renewed right before the write, so a run that overran it never writes beside the run that took over.
 */
const LOCK_HOLD_MS = 90_000;
const LOCK_TRIES = 6;
const LOCK_WAIT_MS = 2_000;
/** monday rate-limit waits allowed per call inside the lock (gql's default is 6, about 6.5 minutes). */
const MAX_RATE_WAITS = 1;
/** Decisions per run: when HubSpot names a different owner just before the write, decide again -- this often. */
const MAX_ROUNDS = 3;

/** Only the literal "true", and only on the CRM Worker. */
export function ownerNoticeOn(env: { ENABLE_CRM?: string; OWNER_NOTICE?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.OWNER_NOTICE === "true";
}

export type NoticeOutcome = "off" | "no-owner" | "no-email" | "no-card" | "already" | "notified"
  | "baseline" | "dry-run" | "busy" | "error";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** HubSpot's assignment time as epoch ms (an ISO string, or epoch ms on older reads); NaN when absent. */
function assignedMs(raw: unknown): number {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
}

/** The owner's email (lowercased) and display name: the cached owner list when there is one, else HubSpot's
 *  owner API. */
async function ownerContact(env: Env, ctx: Ctx | undefined, owner: string): Promise<{ email: string; name: string } | null> {
  const known = ctx?.ownersById?.[owner];
  let email = String(known?.email ?? "").trim().toLowerCase();
  let name = String(known?.name ?? "").trim();
  if (!email) {
    // No cached list, or an owner added since it was cached. 404 or no email -> nobody to tell.
    const o = await hs(env, "GET", `/crm/v3/owners/${owner}`, undefined, 2).catch(() => null);
    email = String(o?.email ?? "").trim().toLowerCase();
    name = [o?.firstName, o?.lastName].filter(Boolean).join(" ").trim();
  }
  return email ? { email, name: name || email } : null;
}

/** The email an email cell holds, lowercased; "" for an empty or unreadable cell. */
export function emailOfCell(value: string | null | undefined, text?: string | null): string {
  try {
    const v = value ? JSON.parse(value) : null;
    const e = String(v?.email ?? "").trim().toLowerCase();
    if (e) return e;
  } catch { /* fall through to the text */ }
  // monday renders an email cell's text as "label - address" or just the address; the address is last.
  const m = String(text ?? "").match(/[^\s<>()"]+@[^\s<>()"]+/g);
  return m ? m[m.length - 1].toLowerCase() : "";
}

/** When monday last changed an email cell (its value's changed_at), epoch ms; 0 when unknown. */
function changedAtOfCell(value: string | null | undefined): number {
  try { return Date.parse(String(JSON.parse(value ?? "null")?.changed_at ?? "")) || 0; } catch { return 0; }
}

/**
 * WHO WAS TOLD LAST: the column and the durable note, whichever was written later. The note -- written right
 * after our own column write -- covers monday serving a column read a moment stale after it; the column covers a
 * note whose save failed after the write landed, and anyone else's later write of the cell.
 */
export function lastTold(cell: { value?: string | null; text?: string | null } | undefined,
    note: { email: string; at: number } | null): string {
  const shown = emailOfCell(cell?.value, cell?.text);
  if (!note?.email) return shown;
  if (!shown) return note.email.toLowerCase();
  return note.at >= changedAtOfCell(cell?.value) ? note.email.toLowerCase() : shown;
}

async function findCard(env: Env, spec: ObjectSpec, contactId: string): Promise<string | null> {
  const known = await lookupCard(env, spec.boardId, contactId);
  if (known) return known;
  return (await findItemByColumn(env, spec.boardId, spec.idCol, contactId))[0]?.id ?? null;
}

async function readOwner(env: Env, contactId: string): Promise<{ owner: string; assigned: string }> {
  const rec = await hs(env, "GET",
    `/crm/v3/objects/contacts/${contactId}?properties=hubspot_owner_id,hubspot_owner_assigneddate`, undefined, 2);
  return { owner: String(rec?.properties?.hubspot_owner_id ?? "").trim(),
    assigned: String(rec?.properties?.hubspot_owner_assigneddate ?? "").trim() };
}

/**
 * Tell HubSpot's current owner of `contactId` about it -- if they were assigned recently and are not the one last
 * told. Writes the card's 上次通知Owner once; the board's automation sends the email.
 */
export async function noticeOwner(env: Env, ctx: Ctx | undefined, spec: ObjectSpec,
    input: { contactId: string; itemId?: string; why: string }, now = () => Date.now()): Promise<NoticeOutcome> {
  const col = spec.ownerNoticeCol;
  if (!col || !ownerNoticeOn(env)) return "off";
  const { contactId, why } = input;
  const dryRun = webhookOpts(env).dryRun;
  let itemId = input.itemId;
  // Owner ids only in the log, never an address.
  const log = (action: NoticeOutcome, extra = "") => {
    console.log(`[owner-notice] contact=${contactId} item=${itemId ?? "-"} action=${action} why="${why}"${extra ? " " + extra : ""}`);
    return action;
  };
  const lockName = `notice:${contactId}`;
  let lockOwner: string | null = null;
  try {
    if (!itemId) itemId = (await findCard(env, spec, contactId)) ?? undefined;
    if (!itemId) return log("no-card", 'reason="no card yet: its creation queues a notice of its own"');

    const runId = crypto.randomUUID();
    for (let i = 0; i < LOCK_TRIES && !lockOwner; i++) {
      if (await acquireLock(env, lockName, LOCK_HOLD_MS, runId)) lockOwner = runId;
      else if (i < LOCK_TRIES - 1) await sleep(LOCK_WAIT_MS);
    }
    if (!lockOwner) return log("busy", 'reason="another run holds this contact\'s notice"');

    let cur = await readOwner(env, contactId);
    for (let round = 1; ; round++) {
      if (!cur.owner) return log("no-owner");
      const who = await ownerContact(env, ctx, cur.owner);
      if (!who) return log("no-email", `owner=${cur.owner}`);
      const at = assignedMs(cur.assigned);
      if (!(Number.isFinite(at) && now() - at <= NOTICE_WINDOW_MS)) {
        if (!dryRun) await rememberNoticedOwner(env, contactId, who.email, now());
        return log("baseline", `owner=${cur.owner} assigned=${Number.isFinite(at) ? new Date(at).toISOString() : "-"}`
          + ` reason="not a new assignment (older than ${NOTICE_WINDOW_MS / 3_600_000} h): remembered, nobody told"`);
      }

      const d = await gql(env, `query ($i: [ID!]) { items(ids: $i) { column_values(ids: ["${col}"]) { text value } } }`,
        { i: [itemId] }, 2, MAX_RATE_WAITS);
      if (!d?.items?.length) return log("no-card", `owner=${cur.owner} reason="the card is gone"`);
      const note = await lastNoticedOwner(env, contactId);
      if (lastTold(d.items[0]?.column_values?.[0], note) === who.email) {
        if (note?.email !== who.email && !dryRun) await rememberNoticedOwner(env, contactId, who.email, now());
        return log("already", `owner=${cur.owner}`);
      }
      if (dryRun) return log("dry-run", `owner=${cur.owner} reason="DRY_RUN: would write 上次通知Owner"`);

      // The column read above can sit through a monday rate-limit wait: confirm HubSpot still names this
      // assignment before announcing it, and decide again if it does not.
      const again = await readOwner(env, contactId);
      if (again.owner !== cur.owner || again.assigned !== cur.assigned) {
        if (round >= MAX_ROUNDS) return log("busy", `owner=${again.owner} reason="the owner kept changing; retried by the queue"`);
        cur = again;
        continue;
      }
      // Still ours? A run that overran its hold must not write beside the run that took over.
      if (!(await acquireLock(env, lockName, LOCK_HOLD_MS, runId)))
        return log("busy", `owner=${cur.owner} reason="the lock passed to another run before the write"`);
      // retries=1: a lost response must not write twice. If this one landed after all, the next run finds the
      // column already naming this owner, and writes nothing.
      await gql(env,
        `mutation ($b: ID!, $i: ID!, $c: JSON!) {
           change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`,
        { b: spec.boardId, i: itemId, c: JSON.stringify({ [col]: { email: who.email, text: who.name } }) }, 1, MAX_RATE_WAITS);
      await rememberNoticedOwner(env, contactId, who.email, now());
      return log("notified", `owner=${cur.owner}`);
    }
  } catch (e) {
    return log("error", `reason="${String(e).slice(0, 140)}"`);
  } finally {
    if (lockOwner) await releaseLock(env, lockName, lockOwner);
  }
}

/**
 * THE QUEUE'S ENTRY POINT (DeferredSync, DeferredItem.notice): resolve this deployment's Contacts spec and run the
 * notice. `ctx` is optional: without it the owner's address comes from HubSpot's owner API. Never throws.
 */
export async function noticeOwnerChange(env: Env, contactId: string, ctx?: Ctx): Promise<NoticeOutcome> {
  if (!ownerNoticeOn(env)) return "off";
  const spec = specByObject(env, "contacts");
  if (!spec?.ownerNoticeCol) return "off";
  return noticeOwner(env, ctx, spec, { contactId, why: "queued" });
}

/**
 * EVERY TRIGGER ENQUEUES. Cheap -- one call to the queue -- so it can sit on any path: the owner-change webhook, a
 * card the Worker creates, a contact created from the monday form. With no queue to hand it to (no binding, or
 * unreachable) the notice runs inline instead, as a best effort. Never throws.
 */
export async function queueOwnerNotices(env: Env, contactIds: string[], why: string): Promise<void> {
  if (!ownerNoticeOn(env) || !contactIds.length) return;
  const ids = [...new Set(contactIds)];
  try {
    if (await spillDeferred(env, ids.map(id => ({ type: "contact" as const, id, notice: true })))) {
      console.log(`[owner-notice] contacts=${ids.join(",")} action=queued why="${why}"`);
      return;
    }
  } catch { /* fall through to inline */ }
  console.log(`[owner-notice] contacts=${ids.join(",")} action=inline why="${why}" reason="the queue is unavailable"`);
  for (const id of ids) await noticeOwnerChange(env, id);
}
