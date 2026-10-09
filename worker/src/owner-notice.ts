/**
 * THE OWNER NOTICE: tell a contact's owner, once per assignment, that the contact is now theirs. OWNER_NOTICE.
 *
 * THE WORKER DECIDES; THE BOARD'S WORKFLOW NOTIFIES ("option A", chosen 2026-10-09). "The board's workflow" here
 * is the account-level monday workflow "#06 [Owner Notice] Email new contact owner" (5031811440, in the CRM
 * workspace, run as ask ada), and it does ALL the notifying: "When 通知状态 changes to 待通知 -> send the email to
 * the card's Contact owner -> write that owner's email into 上次通知Owner -> set 通知状态 to 已通知". It sends from
 * the Outlook mailbox askada@dkmeco.com.sg -- the business chose that over giving this Worker a mailbox; a monday
 * workflow can only use its OWNER's mail account, which is why it is ask ada's -- and has no Lark step yet (hiffer
 * may add one). Tested 2026-10-09, including a 待通知 written with this Worker's own token: it fires. What a
 * workflow cannot do is the DECISION -- "is HubSpot's owner a new assignment nobody has told?" needs HubSpot's
 * assignment time and a comparison of two values -- so that, and only that, is done here: the Worker sets
 * 通知状态 to 待通知 (ObjectSpec.ownerNotice statusCol / pending). It NEVER writes 上次通知Owner -- the workflow
 * records there whom it told, and the Worker only reads it -- and it never sets 已通知.
 *
 * ONCE PER ASSIGNMENT, BECAUSE MONDAY FIRES ON EVERY WRITE. The old reminders fired on "When Contact owner
 * changes", and the sync writes that cell twice for one reassignment ~0.5 s apart: the same email went out twice
 * on 2 and 5 Oct. So 待通知 is written at most once for one assignment -- the CYCLE "<owner id>|<assigned date>":
 * notices run one at a time in the durable queue, under a per-contact lock besides, and a run writes nothing when
 *   - 上次通知Owner already names the owner: the workflow told them ("already");
 *   - the durable note already holds this cycle: it was flagged before. This is also what covers monday serving
 *     a stale read of the status right after our own write ("already").
 * 通知状态 IS READ BY ITS INDEX, never its text: monday reports an UNSET status cell with a label's text and a
 * null index -- the phantom status that wrote OTHER / 5无意向 into thousands of HubSpot records -- so a null index
 * is empty whatever the text says.
 *
 * THE WORKFLOW SENDS TO THE CARD, NOT TO HUBSPOT: to whoever the card's Contact owner shows when it runs, and it
 * records THAT person in 上次通知Owner. The card shows HubSpot's owner only once the contact's own sync has written
 * it, and a bulk reassignment's notices were queued ahead of those syncs. Replayed through the real webhook and
 * queue (owner-notice-race.test.ts), 40 contacts moved from Desmond to Myla in one batch flagged 25 cards that still
 * showed Desmond: he would have had 25 "new contact" emails and his address in 上次通知Owner, and Myla would never
 * have been told (the note already held her assignment). So 待通知 is written only when the card's Contact owner
 * holds EXACTLY the monday user the sync puts there for HubSpot's owner. Until it does the run is "busy" --
 * retried, nothing remembered -- and asks the queue for the contact's sync, in case nothing else is bringing it (an
 * inline sync that failed, or was cut off). An owner with no monday account leaves that cell empty, so the workflow
 * would have nobody to send to: never flagged ("no-user").
 *
 * EVERY FLAG IS CHECKED. A flag the workflow never finishes -- the workflow switched off, out of its automation
 * quota, its Outlook connection lapsed: the likeliest ways this design fails -- used to read "flagged", then
 * "already" for every later run of the same assignment, and nothing ever said its owner had not been told. So the
 * queue runs a flagged notice once more, behind everything waiting (deferred-sync-do.ts): the workflow normally
 * finishes in seconds ("already"). While THIS assignment's own 待通知 still stands the run is "waiting" -- retried,
 * nothing written -- and once that flag is older than FLAG_STUCK_MS it is "stuck", loudly. Every later run of the
 * same assignment answers the same way, never a bare "already" over a flag that never finished.
 *
 * A WAITING FLAG NEVER COVERS A NEWER ASSIGNMENT. 通知状态 reading 待通知 for an assignment the note does not hold
 * means the workflow has not finished an EARLIER flag -- and it may already have picked that flag's owner as its
 * recipient, or have stopped before its last step (its Outlook step failing, say, or a Lark step once there is
 * one). Taking it as covering the new owner, and remembering the new cycle, swallowed that owner for good: not
 * even a status reset by hand could bring them back ("already"). So nothing is remembered against a waiting flag.
 * A fresh one is "pending", retried until the workflow has recorded whom it told -- this owner: "already"; anyone
 * else: flagged. One older than FLAG_STUCK_MS is "stuck": logged loudly, not retried, not remembered.
 *
 * A FLAG'S AGE is its status value's changed_at -- which monday does not always give. It stamps a {label} write
 * like the Worker's (seen 2026-10-09), but status cells holding a bare {"index":N} with no changed_at exist on
 * the live board, from other writers. So when it is missing, the age is the time of the Worker's LAST FLAG (activity-registry NoticeNote.flag: recorded BEFORE each
 * write, so a write that landed but lost its response, a note save that failed or a run killed mid-write still
 * dates it, and kept by every later settlement) -- but only while that flag can be the one still standing: NOT
 * once 上次通知Owner names its owner. The workflow has then finished that flag, and a 待通知 standing now is a
 * later one -- the Worker's own write that lost its response, someone else's -- set at a time nobody knows: taking
 * the old flag's time for it called a 10-second-old flag "stuck", which is final, and its owner was never told.
 * Neither known: no age, and the run stays "pending" (retried, bounded by the queue, whose last line for it then
 * says how to recover the card).
 *
 * A STUCK CARD DOES NOT RECOVER ON ITS OWN: the notice runs only when a trigger queues it (below), never when
 * 通知状态 changes -- the monday webhook ignores that column (ignoredColumns) -- and every run while it stands is
 * "stuck" again. A person recovers it: check whom the workflow already told (上次通知Owner, and its run history),
 * fix the workflow (its Outlook / Lark steps), then on that card clear 通知状态 and set it to 待通知 by hand. The
 * workflow then emails whoever the card's Contact owner shows -- even someone it already told -- and records them
 * in 上次通知Owner.
 *
 * ONLY A NEW ASSIGNMENT IS ANNOUNCED. HubSpot fires an owner propertyChange for writes that change nothing (an
 * import or a workflow re-setting the same owner), and a card that predates the notice records nobody told -- so
 * "the owner differs from the one last told" alone would email Myla about a contact she has owned since June.
 * HubSpot resets hubspot_owner_assigneddate on every real (re)assignment, so the notice also requires that
 * assignment to be recent (NOTICE_WINDOW_MS); an older one is only remembered ("baseline").
 *
 * HUBSPOT DECIDES, READ INSIDE THE LOCK AND AGAIN JUST BEFORE THE WRITE: nothing is taken from the caller, and a
 * monday rate-limit wait in between (up to a minute) cannot let an assignment HubSpot has already replaced be the
 * one flagged. A change between the two reads is decided again from the top, a few times at most ("busy"). The
 * lock is RENEWED, never re-taken, right before the write: a run that overran its hold writes nothing once another
 * run has had the contact. A contact HubSpot no longer has (404) is final: "no-owner".
 *
 * WHERE IT RUNS: in the DEFERRED_SYNC queue (DeferredItem.notice). A webhook's own work is cut off about 30 s
 * after its response and a notice can wait on monday longer than that; the queue has minutes, runs entries one at
 * a time, and retries a notice that answered "busy", "pending", "waiting" or "error" -- an "error" for longer
 * (NOTICE_ERROR_GRACE_MS), so a monday or HubSpot outage of a few minutes does not lose it. Every trigger only
 * enqueues (queueOwnerNotices): the owner-change webhook -- behind its own batch's contact overflow, so a bulk
 * reassignment's notices run after the syncs that put the new owner on the cards, and ahead of the batch's
 * deal-association reads, so those cannot use up its time -- every card the Worker creates on this board, and a
 * contact created from the monday form once its card is paired with the new record. A burst for one contact is
 * one entry (the queue deduplicates). Only the webhook runs a notice the queue did not take, inline, as a best
 * effort, once its batch's own syncs have finished (runOwnerNoticesInline) -- and nothing retries that run: its
 * "busy", "pending" or "error" is logged as lost. A card's birth never waits on one.
 *
 * NEVER THROWS, never writes anything but 通知状态 -- and that only with 待通知 -- and writes nothing at all, not
 * even its own note or a queued sync, under DRY_RUN. Logs owner ids, never an address.
 */
import type { Ctx, Env, ObjectSpec } from "./types";
import { hs } from "./hubspot";
import { findItemByColumn, getUsersByEmail, gql } from "./monday";
import { lookupCard } from "./card-registry";
import {
  acquireLock, lastNoticedCycle, recordNoticeFlag, releaseLock, rememberNoticedCycle, renewLock,
  type NoticeFlag, type NoticeNote,
} from "./activity-registry";
import { specByObject } from "./config";
import { webhookOpts } from "./run-opts";
import { spillDeferred, spillDeferredLeftover } from "./deferred-sync";

/** An assignment older than this is not news: remembered, nobody told. HubSpot stamps the assignment time on
 *  every real (re)assignment, and the queue reaches it within a minute or two. */
export const NOTICE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The per-contact lock -- a second guard behind the queue's one-at-a-time, for the inline fallback. The hold
 * covers an ordinary run: the HubSpot reads, the card read, the write and ONE monday rate-limit wait (15-65 s).
 * It does not bound a run, which can hit more than one: each monday call inside the lock allows a wait of its own
 * (MAX_RATE_WAITS) -- the card read, monday's user list when there is no cached one, the write -- every
 * re-decision (MAX_ROUNDS) reads the card again, and the HubSpot reads retry on their own. What keeps an overrun
 * safe is the RENEWAL right before the write: owner-checked, never a re-take, so a run that outlasted its hold
 * and lost the contact to another run writes nothing.
 */
const LOCK_HOLD_MS = 90_000;
const LOCK_TRIES = 6;
const LOCK_WAIT_MS = 2_000;
/** monday rate-limit waits allowed per monday call of a run -- the card search before the lock included (gql's
 *  default is 6, about 6.5 minutes, which held the queue's whole wave). */
const MAX_RATE_WAITS = 1;
/** Decisions per run: when HubSpot names a different assignment just before the write, decide again -- this often. */
const MAX_ROUNDS = 3;

/**
 * HOW LONG THE BOARD'S WORKFLOW MAY TAKE TO FINISH A FLAG before a 待通知 still standing is called STUCK -- timed
 * by the status value's own changed_at, or, when monday gives none, by the Worker's own flag time (the header,
 * "A FLAG'S AGE"). The workflow runs in seconds; a few minutes covers a slow Outlook step (or a Lark one, once
 * added). Past this it stopped before its last step and will not finish on its own, so waiting longer cannot
 * help: the run says so loudly ("stuck") instead of retrying.
 */
export const FLAG_STUCK_MS = 5 * 60_000;

/**
 * HOW LONG THE QUEUE LETS A NOTICE ANSWER "BUSY", "PENDING" OR "WAITING" BEFORE A RETRY COUNTS AS AN ATTEMPT
 * (deferred-sync-do.ts). All three are waits that end on their own, and the queue's retries come ~10-20 s apart:
 *   - a run killed inside the lock -- a deploy restarting the queue's Durable Object mid-wave -- leaves the lock
 *     standing for its whole LOCK_HOLD_MS: three counted "busy"s all landed inside that one hold, and the notice
 *     was abandoned for a lock nobody held any more;
 *   - a card waiting for the sync that shows its new owner ("busy" too) waits seconds, a deep queue aside;
 *   - a flag "pending" or "waiting" on the workflow resolves when it finishes, and is "stuck" (final) once
 *     FLAG_STUCK_MS old.
 * So they are free until the entry has been in them for longer than the longer of the lock's hold and the stuck
 * threshold, plus a minute's margin -- every waiting flag whose age is known is then answered, finished or stuck,
 * before the grace runs out -- and counted as usual after that, so a contact that really stays busy (or a flag of
 * unknown age that stays pending) is still abandoned, boundedly, with a last line that says how to recover it.
 */
export const NOTICE_BUSY_GRACE_MS = Math.max(LOCK_HOLD_MS, FLAG_STUCK_MS) + 60_000;

/**
 * HOW LONG THE QUEUE RETRIES A NOTICE THAT ANSWERED "ERROR" BEFORE A RETRY COUNTS AS AN ATTEMPT. An error is a
 * failure to read or write (monday or HubSpot down, the note's store unreachable), and unlike a sync a lost notice
 * is never repaired by a later event: counted at once, three retries ~12 s apart abandoned it in a ~40 s outage.
 * Free for this long, counted after -- still bounded.
 */
export const NOTICE_ERROR_GRACE_MS = 15 * 60_000;

/** Only the literal "true", and only on the CRM Worker. */
export function ownerNoticeOn(env: { ENABLE_CRM?: string; OWNER_NOTICE?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.OWNER_NOTICE === "true";
}

/**
 * What one run decided. "flagged" is the only one that wrote 通知状态 (and remembers it), and the queue checks it
 * once more. "already" and "baseline" settled the assignment without a write, and remember it. "busy" (the lock is
 * held, the owner kept changing, or the card does not show the owner yet), "pending" (an earlier flag still waits
 * on the workflow), "waiting" (THIS assignment's own flag still waits on it) and "error" are retried by the queue --
 * when the queue ran it: an inline run's "busy", "pending" and "error" are lost, and logged so
 * (runOwnerNoticesInline). "stuck", "no-user", "no-email", "no-owner" and "no-card" are final. Nothing else
 * remembers anything -- except that whenever 上次通知Owner names the owner, the assignment is remembered as told,
 * whatever the run answers ("waiting" or "stuck" when this assignment's own flag still stands).
 */
export type NoticeOutcome = "off" | "no-owner" | "no-email" | "no-user" | "no-card" | "already" | "pending" | "waiting"
  | "stuck" | "flagged" | "baseline" | "dry-run" | "busy" | "error";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** HubSpot's assignment time as epoch ms (an ISO string, or epoch ms on older reads); NaN when absent. */
function assignedMs(raw: unknown): number {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
}

/** One assignment: the owner, and HubSpot's own stamp of when -- the raw string, exactly as HubSpot returns it. A
 *  new stamp is a new assignment, even of the same owner; a no-op owner write is the same cycle again. */
const cycleOf = (o: { owner: string; assigned: string }) => `${o.owner}|${o.assigned}`;
const ownerOfCycle = (cycle: string | undefined) => (cycle ?? "").split("|")[0];

/**
 * The owner's email, lowercased: the cached owner list when there is one, else HubSpot's owner API. Only ever
 * compared with 上次通知Owner and looked up among monday's users -- never written anywhere, never logged.
 *
 * ONLY A 404 MEANS "NO SUCH OWNER". Anything else the owner API throws -- a 429 or 5xx that outlasted hs()'s
 * retries, a network failure -- is rethrown to the run's catch: "error", which the queue retries. Swallowing it
 * answered "no-email", which the queue counts as done, so one HubSpot blip on this read -- most likely in the very
 * 429 burst a bulk reassignment brings, when the wave's owner list could not be built either -- lost the notice.
 */
async function ownerEmail(env: Env, ctx: Ctx | undefined, owner: string): Promise<string | null> {
  let email = String(ctx?.ownersById?.[owner]?.email ?? "").trim().toLowerCase();
  if (!email) {
    // No cached list, or an owner added since it was cached. A 404, or an owner with no email: nobody to tell.
    const o = await hs(env, "GET", `/crm/v3/owners/${owner}`, undefined, 2)
      .catch(e => { if (/: 404\b/.test(String(e))) return null; throw e; });
    email = String(o?.email ?? "").trim().toLowerCase();
  }
  return email || null;
}

/**
 * The monday user the sync writes into the card's Contact owner for this owner's email -- the person the board's
 * workflow will send to. The cached user list when there is one (the very list the sync resolves the cell with),
 * else monday's own, read once with the lock's single rate-limit wait. null: no monday account.
 */
async function mondayUserOf(env: Env, ctx: Ctx | undefined, email: string): Promise<string | null> {
  const users = ctx?.mondayUsersByEmail ?? await getUsersByEmail(env, MAX_RATE_WAITS);
  return users[email] ?? null;
}

/** A card cell as the notice reads it: status cells with their index, People cells with their people. */
type Cell = { id?: string; text?: string | null; value?: string | null; index?: number | null;
  persons_and_teams?: { id?: string | number; kind?: string }[] | null };

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

/**
 * The label a status cell holds; "" when it is unset. Judged by its INDEX (read with `... on StatusValue { index }`):
 * an unset cell can report a label's text beside a null index -- monday's phantom status -- so the text counts
 * only when there is a real index behind it.
 */
export function statusOfCell(cell: { text?: string | null; index?: number | null } | null | undefined): string {
  return cell && cell.index != null ? String(cell.text ?? "").trim() : "";
}

/** When monday last changed a cell, from its value's own changed_at (epoch ms); NaN when it does not say. */
function changedMs(value: string | null | undefined): number {
  try { return Date.parse(String(JSON.parse(value ?? "null")?.changed_at ?? "")); }
  catch { return NaN; }
}

/** The people a People cell holds, as "<kind>:<id>": monday's persons_and_teams, else its value's personsAndTeams. */
export function peopleOfCell(cell: Cell | null | undefined): string[] {
  let pt = cell?.persons_and_teams;
  if (!pt) {
    try { pt = JSON.parse(cell?.value ?? "null")?.personsAndTeams ?? null; }
    catch { pt = null; }
  }
  return (pt ?? []).map(p => `${p?.kind ?? ""}:${p?.id ?? ""}`);
}

/** The People column the sync writes HubSpot's owner into -- the card's Contact owner, whom the workflow sends to. */
export function ownerColOf(spec: ObjectSpec): string | undefined {
  return spec.fields.find(f => f.hs === "hubspot_owner_id" && f.type === "people")?.col;
}

/** Anything address-shaped, out of a line that is about to be logged (an error can quote what it failed on). */
const noAddresses = (s: string) => s.replace(/[^\s"'<>()]+@[^\s"'<>()]+/g, "<address>");

/** The card: the registry's pairing, else a search of the board's id column -- with the run's one rate-limit wait. */
async function findCard(env: Env, spec: ObjectSpec, contactId: string): Promise<string | null> {
  const known = await lookupCard(env, spec.boardId, contactId);
  if (known) return known;
  return (await findItemByColumn(env, spec.boardId, spec.idCol, contactId, MAX_RATE_WAITS))[0]?.id ?? null;
}

/** HubSpot's owner of the contact, and when it was assigned. null: HubSpot has no such contact (404) -- final. */
async function readOwner(env: Env, contactId: string): Promise<{ owner: string; assigned: string } | null> {
  let rec: any;
  try {
    rec = await hs(env, "GET",
      `/crm/v3/objects/contacts/${contactId}?properties=hubspot_owner_id,hubspot_owner_assigneddate`, undefined, 2);
  } catch (e) {
    if (/: 404\b/.test(String(e))) return null;
    throw e;
  }
  return { owner: String(rec?.properties?.hubspot_owner_id ?? "").trim(),
    assigned: String(rec?.properties?.hubspot_owner_assigneddate ?? "").trim() };
}

/** What a person does about a standing 待通知 -- after checking whom the workflow already told. */
const RECOVER = `first check this card's 上次通知Owner and the workflow's run history -- whom it already told --`
  + ` because setting 待通知 again mails whoever the card's Contact owner shows, even someone already told; then fix`
  + ` the workflow (its Outlook / Lark steps), then on this card clear 通知状态 and set it to 待通知 by hand -- the`
  + ` workflow then emails whoever the card's Contact owner shows and records them in 上次通知Owner`;

/**
 * Decide whether HubSpot's current owner of `contactId` is a NEW assignment nobody has told and no flag already
 * covers -- and if so, once the card shows that owner, set the card's 通知状态 to 待通知 for the board's workflow to
 * send. At most once per assignment; the checks, in order, are the header's. Never throws.
 */
export async function noticeOwner(env: Env, ctx: Ctx | undefined, spec: ObjectSpec,
    input: { contactId: string; itemId?: string; why: string }, now = () => Date.now()): Promise<NoticeOutcome> {
  const cfg = spec.ownerNotice;
  if (!cfg || !ownerNoticeOn(env)) return "off";
  const { contactId, why } = input;
  const dryRun = webhookOpts(env).dryRun;
  let itemId = input.itemId;
  // Owner ids only in the log, never an address.
  const log = (action: NoticeOutcome, extra = "") => {
    console.log(`[owner-notice] contact=${contactId} item=${itemId ?? "-"} action=${action} why="${why}"${extra ? " " + extra : ""}`);
    return action;
  };
  // Whom the workflow sends to is the card's Contact owner: a spec that maps none cannot be checked, so is never flagged.
  const ownerCol = ownerColOf(spec);
  if (!ownerCol) return log("off", 'reason="the spec maps no owner People column: whom the workflow would tell cannot be checked"');
  /** The durable note (activity-registry NoticeNote): read once the lock is held, before anything is settled. */
  let noted: NoticeNote | null = null;
  // An assignment settled WITHOUT a flag is recorded too, so the note reads the same whichever way it went -- and
  // KEEPS the Worker's last flag (NoticeNote.flag), which only a later write replaces: a settlement that wrote
  // nothing used to erase the only age an undated stuck 待通知 had. One the note already holds is not written again
  // (every check of a waiting flag would). Nothing at all under DRY_RUN.
  const remember = async (cycle: string) => {
    if (!dryRun && noted?.cycle !== cycle) await rememberNoticedCycle(env, contactId, cycle, now(), noted?.flag);
  };
  const gone = () => log("no-owner", 'reason="HubSpot has no such contact (404): nobody to tell"');
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

    // Read LOUDLY (a throw is "error", retried by the queue): "unreadable" must never pass for "never flagged".
    noted = await lastNoticedCycle(env, contactId);
    let cur = await readOwner(env, contactId);
    for (let round = 1; ; round++) {
      if (!cur) return gone();
      const cycle = cycleOf(cur);
      if (!cur.owner) return log("no-owner");
      const email = await ownerEmail(env, ctx, cur.owner);
      if (!email) return log("no-email", `owner=${cur.owner}`);
      const at = assignedMs(cur.assigned);
      if (!(Number.isFinite(at) && now() - at <= NOTICE_WINDOW_MS)) {
        await remember(cycle);
        return log("baseline", `owner=${cur.owner} assigned=${Number.isFinite(at) ? new Date(at).toISOString() : "-"}`
          + ` reason="not a new assignment (older than ${NOTICE_WINDOW_MS / 3_600_000} h): remembered, nobody told"`);
      }

      // The card's side, in one read: whom the workflow last told, whether a flag is waiting (and since when), and
      // whom the card shows as Contact owner -- the person the workflow sends to.
      const d = await gql(env,
        `query ($i: [ID!]) { items(ids: $i) { column_values(ids: ["${cfg.lastToldCol}", "${cfg.statusCol}", "${ownerCol}"]) {
           id text value ... on StatusValue { index } ... on PeopleValue { persons_and_teams { id kind } } } } }`,
        { i: [itemId] }, 2, MAX_RATE_WAITS);
      if (!d?.items?.length) return log("no-card", `owner=${cur.owner} reason="the card is gone"`);
      const cells: Cell[] = d.items[0]?.column_values ?? [];
      const cell = (id: string) => cells.find(c => c?.id === id);
      const toldCell = cell(cfg.lastToldCol);
      const statusCell = cell(cfg.statusCol);
      const told = emailOfCell(toldCell?.value, toldCell?.text);
      const standing = statusOfCell(statusCell) === cfg.pending;
      const changed = changedMs(statusCell?.value);
      const flag = noted?.flag;
      // THIS ASSIGNMENT'S OWN FLAG, STILL STANDING (the header, "EVERY FLAG IS CHECKED"), and how old it is: the
      // Worker's own time for it -- or the value's changed_at when that is later (someone set it again since); never
      // an earlier changed_at, which cannot be the time of a value the Worker wrote after it.
      const own = standing && flag?.cycle === cycle;
      const ownAge = own ? now() - (Number.isFinite(changed) ? Math.max(changed, flag!.at) : flag!.at) : NaN;
      const ownLine = own ? ` flag_age_s=${Math.round(ownAge / 1000)} flag_age_from=${Number.isFinite(changed) ? "changed_at" : "note"}` : "";

      if (told === email) {
        await remember(cycle);
        // Told -- but our own 待通知 for it still stands: the workflow has not reached its last step (已通知).
        if (own && ownAge > FLAG_STUCK_MS)
          return log("stuck", `owner=${cur.owner}${ownLine} reason="上次通知Owner names this owner -- the workflow told`
            + ` them -- but 通知状态 has read ${cfg.pending} for longer than ${FLAG_STUCK_MS / 60_000} min: the workflow did`
            + ` not reach its last step (${cfg.done}), and every later owner of this contact waits on it, never flagged,`
            + ` until a person clears it. Remembered as told; NOT retried. To recover: fix the workflow's last step, then`
            + ` set this card's 通知状态 to ${cfg.done} by hand -- NOT to ${cfg.pending}, which would mail this owner again"`);
        if (own) return log("waiting", `owner=${cur.owner}${ownLine} reason="上次通知Owner names this owner -- the`
          + ` workflow told them -- and it has not set ${cfg.done} yet: checked again"`);
        return log("already", `owner=${cur.owner} reason="上次通知Owner names this owner: the workflow told them"`);
      }
      if (noted?.cycle === cycle) {
        if (own && ownAge > FLAG_STUCK_MS)
          return log("stuck", `owner=${cur.owner}${ownLine} reason="this assignment's own flag has read ${cfg.pending}`
            + ` for longer than ${FLAG_STUCK_MS / 60_000} min and 上次通知Owner does not name this owner: the board's`
            + ` workflow did not finish it, so this owner may NOT have been told. Not flagged again (once per assignment)`
            + ` and NOT retried, and nothing re-runs it when the status changes. To recover: ${RECOVER}"`);
        if (own) return log("waiting", `owner=${cur.owner}${ownLine} reason="this assignment is flagged and the board's`
          + ` workflow has not finished it yet: checked again until it has (or is stuck)"`);
        return log("already", `owner=${cur.owner} reason="this assignment was settled already"`);
      }
      if (standing) {
        // A flag is waiting that THIS assignment did not settle: the workflow has not finished an earlier one, and may
        // already have picked its owner. Never taken to cover this owner, never remembered against (the header).
        // Its age (the header, "A FLAG'S AGE"): the value's changed_at; else the Worker's last flag time -- while
        // that flag can still be the one standing, i.e. 上次通知Owner does not name its owner; else unknown.
        let since = changed;
        let from = Number.isFinite(changed) ? "changed_at" : "-";
        // Whether 上次通知Owner names the owner of the Worker's last flag: "yes" -- the workflow finished it, so the
        // 待通知 standing now is a later one, of unknown age.
        let flagTold = "-";
        if (!Number.isFinite(since) && flag) {
          const flagOwner = ownerOfCycle(flag.cycle);
          // A failed read leaves the age unknown -- "pending" -- never a guess that could make it "stuck".
          const flagEmail = flagOwner === cur.owner ? email : await ownerEmail(env, ctx, flagOwner).catch(() => null);
          if (flagEmail) flagTold = told === flagEmail ? "yes" : "no";
          if (flagTold === "no") { since = flag.at; from = "note"; }
        }
        const waited = Number.isFinite(since) ? `${Math.round((now() - since) / 1000)}` : "-";
        const earlier = `noted_owner=${ownerOfCycle(noted?.cycle) || "-"} flag_owner=${ownerOfCycle(flag?.cycle) || "-"}`
          + ` flag_told=${flagTold} flag_age_s=${waited} flag_age_from=${from}`;
        if (Number.isFinite(since) && now() - since > FLAG_STUCK_MS)
          return log("stuck", `owner=${cur.owner} ${earlier} reason="通知状态 has read ${cfg.pending} for longer than`
            + ` ${FLAG_STUCK_MS / 60_000} min: the board's workflow did not finish its last flag. This assignment is NOT`
            + ` flagged, NOT remembered and NOT retried, and nothing re-runs it when the status changes. To recover:`
            + ` ${RECOVER}"`);
        return log("pending", `owner=${cur.owner} ${earlier} reason="通知状态 already reads ${cfg.pending} for an earlier`
          + ` assignment: retried until the workflow has recorded whom it told; nothing remembered"`);
      }

      // WHOM THE WORKFLOW WOULD TELL: the card's Contact owner must already hold exactly HubSpot's owner.
      const user = await mondayUserOf(env, ctx, email);
      if (!user)
        return log("no-user", `owner=${cur.owner} reason="the owner has no monday account: the card's Contact owner`
          + ` stays empty, and the board's workflow would have nobody to send to"`);
      const shown = peopleOfCell(cell(ownerCol));
      if (shown.length !== 1 || shown[0] !== `person:${user}`) {
        const seen = `owner=${cur.owner} card_shows=${shown.join(",") || "nobody"} wants=person:${user}`;
        if (dryRun) return log("dry-run", `${seen} reason="DRY_RUN: the card's Contact owner does not show this owner`
          + ` yet; a live run would wait for its sync"`);
        // Its sync is most likely queued or running already; if nothing is bringing it, this is. `ensure`: one the
        // queue is running right now counts as coming -- queued fresh beside it, it reset that sync's attempts each
        // wave, and a sync that kept failing ran ~40 times instead of 3. The queue runs it ahead of this notice's
        // retry. Fails soft.
        await spillDeferred(env, [{ type: "contact", id: contactId, ensure: true }]).catch(() => false);
        return log("busy", `${seen} reason="the card's Contact owner does not show this owner yet, and the workflow`
          + ` mails whoever it shows: not flagged, nothing remembered; the contact's sync is queued and the queue retries"`);
      }
      if (dryRun) return log("dry-run", `owner=${cur.owner} reason="DRY_RUN: would set 通知状态 to ${cfg.pending}"`);

      // The card read above can sit through a monday rate-limit wait: confirm HubSpot still names this assignment
      // before flagging it, and decide again from the top if it does not.
      const again = await readOwner(env, contactId);
      if (!again) return gone();
      if (again.owner !== cur.owner || again.assigned !== cur.assigned) {
        if (round >= MAX_ROUNDS) return log("busy", `owner=${again.owner} reason="the owner kept changing; retried by the queue"`);
        cur = again;
        continue;
      }
      // Still ours? RENEWED, never re-taken: a run that overran its hold must not write beside a run that took the
      // contact over meanwhile -- not even one that has finished and released it (the record is gone then, and a
      // re-take would be granted).
      if (!(await renewLock(env, lockName, runId)))
        return log("busy", `owner=${cur.owner} reason="the lock passed to another run before the write"`);
      // THE FLAG'S OWN RECORD, BEFORE THE WRITE (activity-registry recordNoticeFlag): its time is this flag's age
      // should monday give the value no changed_at, and it must outlive a lost response, a failed note save or a
      // killed run. Not recorded: not written -- the throw is "error", and the queue retries.
      const flagged: NoticeFlag = { cycle, at: now() };
      await recordNoticeFlag(env, contactId, noted, flagged);
      // 通知状态 alone -- never 上次通知Owner, which is the workflow's. retries=1: a lost response must not write
      // twice. If this one landed after all (the run said "error" and settled nothing), the queue's retry finds 待通知
      // waiting, dated by the flag just recorded -- "pending" until the workflow has recorded the owner ("already"),
      // "stuck" if it never does -- and writes nothing.
      await gql(env,
        `mutation ($b: ID!, $i: ID!, $c: JSON!) {
           change_multiple_column_values(board_id: $b, item_id: $i, column_values: $c) { id } }`,
        { b: spec.boardId, i: itemId, c: JSON.stringify({ [cfg.statusCol]: { label: cfg.pending } }) }, 1, MAX_RATE_WAITS);
      await rememberNoticedCycle(env, contactId, cycle, now(), flagged);
      return log("flagged", `owner=${cur.owner}`);
    }
  } catch (e) {
    return log("error", `reason="${noAddresses(String(e)).slice(0, 140)}"`);
  } finally {
    if (lockOwner) await releaseLock(env, lockName, lockOwner);
  }
}

/**
 * THE QUEUE'S ENTRY POINT (DeferredSync, DeferredItem.notice): resolve this deployment's Contacts spec and run the
 * notice. `ctx` is optional: without it the owner's address comes from HubSpot's owner API, and the monday user
 * from monday's own list. `why` is only logged. Never throws.
 */
export async function noticeOwnerChange(env: Env, contactId: string, ctx?: Ctx, why = "queued"): Promise<NoticeOutcome> {
  if (!ownerNoticeOn(env)) return "off";
  const spec = specByObject(env, "contacts");
  if (!spec?.ownerNotice) return "off";
  return noticeOwner(env, ctx, spec, { contactId, why });
}

/**
 * EVERY TRIGGER ENQUEUES -- AND ONLY ENQUEUES. Cheap -- one call to the queue -- so it can sit on any path: the
 * owner-change webhook, a card the Worker creates, a contact created from the monday form. Returns the ids the
 * queue did NOT take (no binding, unreachable, or the tail of the batch a full queue dropped), and logs them.
 *
 * NEVER RUNS ONE INLINE. A card's birth used to wait on a notice run inline whenever the queue did not take it --
 * ~10 s of lock retries when the contact's lock was held, a minute or more per monday rate-limit wait -- holding
 * the record's associations, a Deal Cockpit request or a create's coalesce queue behind it. `then` says what
 * becomes of those not taken: "lost" (a card's birth, a monday-born contact) or "inline" (the owner-change webhook
 * runs them itself, runOwnerNoticesInline, once its batch's own syncs have finished). Never throws.
 */
export async function queueOwnerNotices(env: Env, contactIds: string[], why: string,
    then: "lost" | "inline" = "lost"): Promise<string[]> {
  if (!ownerNoticeOn(env) || !contactIds.length) return [];
  const ids = [...new Set(contactIds)];
  let left = ids;
  try {
    left = (await spillDeferredLeftover(env, ids.map(id => ({ type: "contact" as const, id, notice: true })))).map(i => i.id);
  } catch { /* none taken */ }
  const notTaken = new Set(left);
  const queued = ids.filter(id => !notTaken.has(id));
  if (queued.length) console.log(`[owner-notice] contacts=${queued.join(",")} action=queued why="${why}"`);
  if (!notTaken.size) return [];
  console.log(`[owner-notice] contacts=${[...notTaken].join(",")} action=not-queued why="${why}"`
    + ` reason="the queue did not take them (unavailable, or full): ${then === "inline"
      ? "run inline once the batch's own syncs have finished" : "lost -- nothing re-runs them"}"`);
  return ids.filter(id => notTaken.has(id));
}

/**
 * THE WEBHOOK'S FALLBACK, for the notices the queue did not take (queueOwnerNotices "inline"): run them here, one
 * after another -- ONLY once the batch's own inline syncs have finished. Started beside those syncs (as they were),
 * a notice read the card before its contact's sync had put the new owner on it: "busy", and lost. `ctx`: the
 * batch's cached owner and user lists, so a run reads neither HubSpot's owner API nor monday's user list itself.
 *
 * AN INLINE RUN IS NOT RETRIED. Its "busy", "pending" or "error" -- which noticeOwner logs as the queue's to retry --
 * is final here, with nothing left to bring it back: each gets one more line saying it is lost. ("waiting" is not:
 * the assignment is flagged; only the check of the workflow is skipped.) Never throws.
 */
export async function runOwnerNoticesInline(env: Env, contactIds: string[], why: string, ctx?: Ctx): Promise<void> {
  if (!ownerNoticeOn(env) || !contactIds.length) return;
  console.log(`[owner-notice] contacts=${contactIds.join(",")} action=inline why="${why}"`
    + ` reason="the queue did not take them (unavailable, or full)"`);
  for (const id of contactIds) {
    const r = await noticeOwnerChange(env, id, ctx, `inline: ${why}`);
    if (r === "busy" || r === "pending" || r === "error")
      console.log(`[owner-notice] contact=${id} action=lost`
        + ` reason="ran inline because the queue did not take it; ${r} is not retried"`);
  }
}
