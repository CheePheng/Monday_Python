/**
 * DELETE THE EXTRA MONDAY CARDS THE 2026-09-30 RECONCILIATION FOUND, AND ONLY THE ONES A PLAN CALLED SAFE.
 * Dry run unless --apply.
 *
 * WHY. The 2026-09-30 count reconciliation (monday cards vs HubSpot records) left four lists of cards that
 * stand for nothing, or for something another card already stands for:
 *   accounts-idless  1,301 Accounts cards with no HubSpot ID, all made by monday's CRM "Account association"
 *                    setting (auto-link contacts to Accounts by email domain, ON until 2026-09-30).
 *   accounts-dups    21 extra Accounts cards that repeat the HubSpot ID of a survivor card (5 companies).
 *   contacts         4 cards whose HubSpot contact was MERGED into another that has its own card, and 1
 *                    id-less test card.
 *   deals            id-less template samples and test deals.
 * Four classifiers and their skeptics wrote a plan per list (read from --plan-dir):
 *   accounts-idless-classified.json, accounts-dups-plan.json, contacts-plan.json, deals-plan.json, and for
 *   accounts-idless also skeptic-idless/q-review-candidates.json. This script acts only on what those plans
 *   call safe, WITH THE SKEPTICS' CORRECTIONS APPLIED (below), and re-checks every item right before acting.
 *
 * WHAT A DELETE DOES ON THIS SYSTEM (read from src/, 2026-09-30).
 *   - delete_item moves the card to monday's Trash, restorable there for 30 days. Every id this script
 *     deletes is recorded (report.restoreList and the -deleted.jsonl journal), so the Trash can be searched.
 *   - All four CRM specs set restoreOnDelete (src/config/crm.ts), so the Worker's delete branch
 *     (webhooks.ts isDeletionEvent -> restore-card.ts restoreDeletedCard) sees every delete. It finds the
 *     card's HubSpot id from the webhook payload's ID column, else from its own reverse index
 *     hsof:<board>:<item>, which only finishCard writes (a card the Worker created or adopted as its first
 *     search hit). The delete branch never WRITES HubSpot (it GETs the record), and it runs BEFORE the self-origin check, so
 *     deleting with the integration token does NOT stop a restore. What makes a delete safe is the kind of
 *     card deleted:
 *       ID COLUMN BLANK (all accounts-idless, deals and the contacts test card): never paired, so nothing is
 *         indexed -> "unattributable", logged, nothing written anywhere. The cards stay deleted. "Never paired"
 *         is RE-PROVEN per card, not assumed: every hsof writer had the id on the card, so an id-less card with
 *         an entry had its id blanked -- and deleting THAT card restores its record into a brand-new card. So
 *         the card's activity log, from its own create_pulse row, must show no write to the ID column ever.
 *       DEALS: restore is defined for contacts and companies only; deals answer "unsupported-object". But a
 *         Deals card WITH an ID comes back through the next HubSpot event or sweep (ensureCardForRecord), so
 *         this script refuses any Deals card that carries an ID.
 *       A DUPLICATE (accounts-dups): the extras were adopted by domain, a path that writes no hsof, so the
 *         delete is most likely unattributable. If the id does resolve, the restore excludes the dead card
 *         and its search finds the SURVIVOR, which it only refreshes forward (monday writes only). A new card
 *         could be born only if no active card held the id, so a survivor is never deleted (refused below).
 *         Deleted, not archived, and the ID is NOT blanked first: deleted cards leave the ID search (checked
 *         on two cards), while blanking is inert (the ID column is on the Worker's ignore list, and the hsof
 *         entry, if any, stays) and costs 21 writes that leave id-less orphans behind.
 *       A MERGED CONTACT (contacts): three of the four are indexed, so the restore runs. It reads the stale id
 *         from HubSpot, gets the SURVIVOR record back, and adopts the survivor's existing card: no new card, no
 *         HubSpot write. So each one needs its survivor card alive, holding the survivor id, and the merge
 *         still in place in HubSpot.
 *   - HubSpot is never written: the delete branch makes only HubSpot GETs; a deleted card dropping out of a
 *     linked card's relation cell is not an unlink (G4, associations.ts: removed cards that are no longer
 *     active are skipped), and a relation echo caused by the integration user is self-origin besides. The
 *     token must therefore be the integration user 104118038 (requireIntegrationToken), so every echo is ours.
 *   Latent Worker bugs that do not change the outcome here, left for later: getItem returns deleted cards as
 *   alive, and ensureCardForRecord's second search does not exclude the dead card, so a restore racing a
 *   stale search index can re-register a dead card id (it never creates a duplicate) -- which is why the first-hit
 *   checks read the raw, unfiltered search. An ATTRIBUTABLE restore also ends in a forward runAssociations pass
 *   for the record, which may card its uncarded HubSpot associations (monday writes only, the same as any
 *   HubSpot event for that record would do); the post-checks watch only the deleted card's own id.
 *
 * THE SKEPTICS' CORRECTIONS, APPLIED.
 *   accounts-idless: 1,287 were "safe"; the skeptic showed the TOUCHED-BY-PERSON rule only saw rep notes that
 *     mirror onto the Account. One rule for all: a card whose delete would leave a contact with no Account
 *     while that contact has a deal, a person's edit (since 08-01) or HubSpot activity (notes_last_updated
 *     >= 09-01) goes to review with the 14. That is the 66 in q-review-candidates.json (Niimbot, Kitronyx and
 *     Ocusun -- the only company record of three HubSpot deals -- and Nuvoton among them), so 1,221 remain.
 *     The same rule is RE-DERIVED live at every re-check, so a contact worked since the plan also holds its
 *     Account back. Subvertron 2858206655 is deleted WITHOUT relinking its contacts: both are the stale merged
 *     cards the contacts group deletes. The optional "link the contact to the real card first" for 10
 *     duplicates is not done here: it creates a HubSpot association, which is the user's call. (Once a person
 *     has made such a fix, --release, below, is how the held card is deleted.)
 *   accounts-dups: delete, never blank (for the reason above, not a re-stamp risk: the 24 h mdcreate entry is
 *     long gone and these cards predate CRM_CREATE_CUTOFF_AT). The ING extras 2857066000 and 2857058153 hold
 *     two HubSpot call entries the survivor lacks; they are held until the survivor 2855725789 carries both
 *     markers (copy them first, or delete those two by hand once their loss is accepted). The Goldman Sachs
 *     extra's contact link 2856339061 is NOT moved (HubSpot never had it) and does not hold that extra back.
 *   contacts: the call pre-step for 2855867843 lands on three cards (contact, Account, Deal) and moves their
 *     Last Activity Date; this script does not run it, it only checks the marker is on the survivor card
 *     2866109946 before deleting. TEST-20260910 waits for hiffer, 张测试 is kept, test link test stays uncarded.
 *   deals: only the id-less cards. test-deal-0917 waits for hiffer (confirmFirst); xtopup and 广汽汇理 need a
 *     person to create them in HubSpot first (the Create form does not send links, so they are checked in
 *     HubSpot, not on the card). The junk HubSpot deal 350443684547 '新的 deal' (card 2868278032) is not in
 *     any list and is left alone: it has an ID, so deleting its card only brings the card back.
 *
 * EVERY ITEM IS RE-CHECKED RIGHT BEFORE ACTING. The plan chooses; only a fresh read authorises. In --apply each
 * item is read twice: in the batched pass that sizes the run, and again, alone, immediately before its delete.
 * Both reads must pass. A read that cannot tell (a timeline it could not walk, a card monday did not return)
 * holds the item. The checks, per kind:
 *   every card      still active (deleted/archived = already-gone, skipped), on its board, same name, no file,
 *                   no subitem, no update (deals: none added since the plan), and no person's edit in the board
 *                   activity log -- accounts: ever (since 09-01, the classifiers' window); contacts/deals: since
 *                   the plan. A person is any user but 104118038 and the automation actors (negative ids); a
 *                   Last Activity Date stamp by the workflow running as hiffer (104231431) is not a person.
 *   accounts-idless still id-less, and its ID column never written (log from its create_pulse row, which must
 *                   be in the 09-01 window); no deal link (board_relation_mm76cv3c / account_deal mirror); no
 *                   contact link the plan did not know; every timeline entry by the integration user; a
 *                   DUPLICATE's real card still active and holding its id; and the live orphan-contact rule above
 *                   (a linked contact monday or HubSpot does not return holds; it does not pass).
 *   accounts-dups   born in the log window; still holds the company id; the survivor active, holding it, and the
 *                   Worker's first search hit IN THE RAW, UNFILTERED ORDER (the Worker does not filter by state,
 *                   so a lingering dead card ahead of it would be adopted instead); no other live card holds it;
 *                   the company still exists in HubSpot; no contact link the survivor lacks (except the
 *                   documented one); every timeline entry also on the survivor (same [hubspot:...] marker, or
 *                   same type/title/time when unmarked).
 *   contacts        merged: still holds the stale id; HubSpot still resolves it to the survivor; the survivor
 *                   card active, holding the survivor id, and the only raw search hit; no other card (any state)
 *                   holds the stale id; no deal link; linked only to id-less Accounts; every timeline marker (and
 *                   the plan's pre-step markers) on the survivor.
 *                   id-less: still id-less and its ID column never written since its birth; no links, no
 *                   timeline entry.
 *   deals           still id-less; no line item; linked only to id-less cards; no timeline entry by a person
 *                   since the plan.
 *
 * AFTER EACH DELETE. The card must read state=deleted, or the run HALTS. For a card that carried a HubSpot id
 * the run then waits --settle seconds (the Worker's restore) and HALTS if the ID search shows any live card it
 * does not know for that id (a restore created one), if the survivor left the search or (Accounts) stopped being
 * its first raw hit, or if the HubSpot association count of the survivor record changed. It then waits (~30 s
 * more) for the dead card to leave the RAW search; if it lingers, that is a warning, and the company's other
 * extras are held for this run. A released card deleted on a timeline waiver is checked against its contact cards
 * after the delete (--release, below). One card at a time, --pause seconds apart, one company at a time.
 *
 * --groups contacts-card (never in the default set). The contacts plan recommends carding 11 HubSpot contacts a
 * HubSpot import left uncarded. With --apply each goes, one id per request, to the Worker's existing POST
 * /resync (the route catchup-after-deploy.mjs cards uses: syncHubspotRecord -> ensureCardForRecord, deduped by
 * the card registry). Re-checked first: still in HubSpot under the same id, sync_owner not wm/hold, still no
 * card. Afterwards exactly one card must hold the id, or the run HALTS. The dry run never calls the Worker.
 *
 * --release <file> (accounts-idless only; the user's decision of 2026-10-05). The plan holds 80 id-less Accounts
 * for review (the 14 TOUCHED-BY-PERSON, the skeptic's 4 named and 62 listed). The user reviewed them and approved
 * deleting all 80, nine of them only after a fix. The release file is that approval, card by card -- the only way
 * a held card becomes deletable, and it never skips a check:
 *     { "decidedBy": "...", "decidedAt": "<ISO, with a zone>", "decision": "...",
 *       "cards": [ { "card": "<monday item id>", "bucket": "A"|"B"|"C"|"D"|"L", "note": "..." }, ... ] }
 *   A  the only company of a HubSpot deal. FIXED FIRST: the company created in HubSpot and the contact linked to
 *      the new real card.
 *   B  a duplicate of a real Account card. FIXED FIRST: the contact linked to the real card.
 *   C  a rep works the contact; the user accepts that the contact loses this (junk) Account link.
 *   D  the contact has only HubSpot activity; accepted as C.
 *   L  a card the plan called safe that the LIVE orphan-contact rule now holds (its contact was worked after
 *      09-30); accepted as C and D.
 *   THE WHOLE RUN IS REFUSED, before any read of monday, unless every entry is a numeric card id, listed once, with
 *   one of those buckets; in the id-less plan AND on the reconciliation's idless list; A-D only for a card the plan
 *   holds, L only for one it already calls safe; and protected for nothing but the plan's review hold (a real
 *   company card of a duplicate, a survivor or an unknown class refuses). decidedBy, decidedAt and decision are
 *   required. The file's sha256 goes in report.planFiles.release, the parsed list in report.release.
 *   A released held card moves into the candidates (in id order, item.release = its bucket) and loses its review
 *   protection, so the candidate-AND-protected guard and the reconciliation check run on it like any candidate;
 *   DELETABLE gains the released cards and nothing else (checked, or the run is refused). L cards are only tagged.
 *   WAIVERS. A release drops only these reasons, only on a released card, by ONE function (lib/cleanup-release.mjs
 *   releaseWaiver, called from waiveReleased) on the first read and the --apply second read alike:
 *     C, D, L  orphaned-contact-person-edit:*, orphaned-contact-hubspot-activity:*, orphaned-contact-hubspot-unread:*
 *              -- never orphaned-contact-has-deal:* or orphaned-contact-hubspot-deal:*: a deal makes it an A.
 *     A, B     no orphan-contact reason: the rule must pass on its own, which is the proof the fix landed.
 *     all      timeline-entry-not-ours:N, only when every entry on the Account not by the integration user has a
 *              twin on a contact card linked to it NOW (active, not a merged stale card): the same entry id, the
 *              same non-empty [hubspot:...] marker set, or for an unmarked entry the same fingerprint. Those
 *              contact timelines are read on every read (facts.personEntries, facts.personEntriesMirrored); one
 *              not read whole keeps the reason. (monday mirrors a contact's entry onto its Account under a NEW
 *              entry id, so in practice the marker set or the fingerprint is what matches.)
 *   NEVER WAIVED: not-returned, gone, wrong-board, renamed-since-plan, a file/subitem/update, born-before-log-window,
 *   creator, has-hubspot-id-now, deal-link, contact-link-not-in-plan, a person's edit on the Account itself,
 *   activity-log-does-not-reach-birth, id-column-was-written, timeline-unreadable, linked-contact-not-returned,
 *   real-company-card-gone -- and any reason not named above, so a check added later holds too. A released card's
 *   row carries released: <bucket>, planHeld (why the plan held it) and waived: [...]; a hold shows what is left.
 *   AFTER A DELETE THAT WAIVED timeline-entry-not-ours. That waiver deletes the Account's copy of a person's entries
 *   on one assumption: the contact's copy survives the Account's trip to the Trash. Unproven: monday LINKS the
 *   copies of one activity, and deleting copies has removed entries on cards no delete was sent to
 *   (src/activity-sync.ts, dedupe-timeline.mjs), and no whole-card trash so far was checked against its contacts'
 *   timelines. Bucket C accepts losing the Account LINK, not the notes, and a person's note is not a Worker
 *   entry restore-timeline-entries.mjs can rebuild. So after such a delete the run waits --settle seconds, reads the
 *   contact cards the second read's waiver relied on again (uncached), and HALTS unless each was read whole and every
 *   waived entry still has its twin there (lib mirrorSurvived; the evidence is ids, markers and fingerprints, kept
 *   off the report). The row carries postChecks and mirrorAfterDelete { ok, lost, unreadable }; the journal a
 *   mirror-check line. A check --settle seconds after the delete cannot see a slower cascade, hence the order:
 *   THE FIRST --apply OF A RELEASE IS A CANARY OF ONE CARD THAT WAIVES A TIMELINE ENTRY: a release file listing only
 *   that card (e.g. Zkqcip 2855240915, C, twins on contact 2855240904), run once the plan's own candidates are done,
 *   so it is the first eligible card. Then open its contact card in monday, some minutes later, and confirm the
 *   person's entries are still there before releasing the rest. --canary with --release says whether it tried that
 *   path; a canary of a card that waived only an orphan reason (2854825212, D, is first in id order) did not.
 *
 *   node scripts/cleanup-extra-cards.mjs                                     # dry run, the four delete groups
 *   node scripts/cleanup-extra-cards.mjs --groups accounts-dups --canary --apply   # ONE delete, checked, then stop
 *   node scripts/cleanup-extra-cards.mjs --groups accounts-idless --apply --limit 50
 *   node scripts/cleanup-extra-cards.mjs --groups accounts-idless --release <file>            # dry run, with the release
 *   node scripts/cleanup-extra-cards.mjs --groups accounts-idless --release <one-card file> --canary --apply   # first
 *   node scripts/cleanup-extra-cards.mjs --groups accounts-idless --release <file> --apply    # after the look in monday
 *   node scripts/cleanup-extra-cards.mjs --groups contacts-card --apply
 *   options: --groups a,b    accounts-idless,accounts-dups,contacts,deals (default) and/or contacts-card
 *            --release F     the user's approval list for id-less Accounts the plan holds (above); needs
 *                            accounts-idless in --groups
 *            --limit N       stop after N deletes/creates (a dry run: after N found)
 *            --canary        with --apply: act on ONE item, run every post-check, print it, stop;
 *                            without: stop at the first eligible item and print what the canary would do
 *            --pause S       seconds between actions, 0-60 (default 2)
 *            --settle S      seconds to wait for the restore after an ID-bearing delete, and before the contact
 *                            re-check after a released delete that waived a timeline entry, 5-300 (default 20)
 *            --plan-dir D    where the plan files are (default: the 2026-09-30 session's cleanup folder)
 *            --reconcile-dir D  the count reconciliation's companies/contacts/deals.json; a plan candidate not on
 *                            its list refuses the run (default: the same session's count-reconcile folder)
 *            --report-dir D  where the report goes (default docs/rollout)
 *   A re-run is safe: a deleted card reads state=deleted and is skipped as already-gone.
 *
 * THE REPORT is saved after every item to <report-dir>/<date>-cleanup-extra-cards-<plan|applied>.json (an
 * earlier one is never overwritten; the time is appended): every item's plan verdict, both reads' reasons,
 * outcome, and deleted[] / restoreList[] / created[]. --apply also appends each delete, before it is sent and
 * after, to <date>-cleanup-extra-cards-deleted.jsonl, so a killed run still shows what it sent. --apply takes
 * docs/rollout/.cleanup-extra-cards.lock and refuses while another run holds it; the first Ctrl-C stops after
 * the current item, a second quits at once. --apply refuses unless the new CRM build is live and
 * MONDAY_API_TOKEN is the integration user (lib/repair-preflight.mjs).
 *
 * Needs MONDAY_API_TOKEN and HUBSPOT_CRM_APP_TOKEN in worker/.dev.vars, and TRIGGER_SECRET for contacts-card
 * --apply (CRM_WORKER_URL optional). Reads HubSpot only (GET, search, batch/read). Prints ids and names only:
 * no credential, no secret-bearing URL, no email or phone, no timeline content.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CRM_WORKER_URL, INTEGRATION_USER_ID, requireIntegrationToken, requireNewBuild } from "./lib/repair-preflight.mjs";
import { LIFTABLE_PROTECTION, RELEASE_BUCKETS, mirrorSurvived, parseRelease, personEntriesMirrored, releasePlan, releaseWaiver, waivesTimeline } from "./lib/cleanup-release.mjs";
import { BELL_COL } from "./check-activity-doorbell.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const M = v.MONDAY_API_TOKEN, H = v.HUBSPOT_CRM_APP_TOKEN, T = v.TRIGGER_SECRET;
// No trailing slash: "…workers.dev//resync" is not the route and would 404 every request.
const WORKER = (v.CRM_WORKER_URL || DEFAULT_CRM_WORKER_URL).replace(/\/+$/, "");

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const SWITCHES = new Set(["--apply", "--canary"]);
const VALUED = new Set(["--groups", "--limit", "--pause", "--settle", "--plan-dir", "--report-dir", "--reconcile-dir", "--release"]);
/** A flag that is present must carry a value, and an unknown flag is refused: a typo must never widen a run. */
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (SWITCHES.has(a)) continue;
  if (VALUED.has(a)) {
    const x = argv[i + 1];
    if (x === undefined || x === "" || String(x).startsWith("--")) { console.error(`${a} needs a value`); process.exit(2); }
    i++; continue;
  }
  console.error(`unknown option ${a}`); process.exit(2);
}
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes("--apply");
const CANARY = argv.includes("--canary");
const ORDER = ["accounts-idless", "accounts-dups", "contacts", "deals", "contacts-card"];
const DEFAULT_GROUPS = ["accounts-idless", "accounts-dups", "contacts", "deals"];
const asked = argv.includes("--groups") ? String(arg("--groups")).split(",").map(s => s.trim()).filter(Boolean) : DEFAULT_GROUPS;
const unknownGroups = asked.filter(g => !ORDER.includes(g));
if (!asked.length || unknownGroups.length) { console.error(`--groups takes ${ORDER.join(",")}${unknownGroups.length ? ` (not ${unknownGroups.join(",")})` : ""}`); process.exit(2); }
const GROUPS = ORDER.filter(g => asked.includes(g));          // a fixed order, whatever order they were typed in
/** --release: the user's approval list for held id-less Accounts. It releases nothing in any other group. */
const RELEASE_FILE = argv.includes("--release") ? resolve(String(arg("--release"))) : null;
if (argv.filter(a => a === "--release").length > 1) { console.error("--release takes one file, once"); process.exit(2); }
if (RELEASE_FILE && !GROUPS.includes("accounts-idless")) {
  console.error("--release approves accounts-idless cards only: add accounts-idless to --groups"); process.exit(2);
}
/** Whole numbers only. The raw text is checked: Number("1e3") passes. */
const whole = (k, d, lo, hi) => {
  if (!argv.includes(k)) return d;
  const x = String(arg(k));
  if (!/^\d+$/.test(x) || Number(x) < lo || Number(x) > hi) { console.error(`${k} needs a whole number ${lo}-${hi}`); process.exit(2); }
  return Number(x);
};
const LIMIT = whole("--limit", Infinity, 1, 1_000_000);
const PAUSE_MS = whole("--pause", 2, 0, 60) * 1000;
const SETTLE_MS = whole("--settle", 20, 5, 300) * 1000;
const PLAN_DIR = resolve(arg("--plan-dir", "C:/Users/PC/AppData/Local/Temp/claude/c--Users-PC-Downloads-DKM-Project-Monday-Python/85678929-2bad-44c8-ae70-3715f1ac1066/scratchpad/cleanup"));
/** The 2026-09-30 count reconciliation the plans were built from: no card outside its lists is ever acted on. */
const RECONCILE_DIR = resolve(arg("--reconcile-dir", "C:/Users/PC/AppData/Local/Temp/claude/c--Users-PC-Downloads-DKM-Project-Monday-Python/85678929-2bad-44c8-ae70-3715f1ac1066/scratchpad/count-reconcile"));
const ROLLOUT = join(ROOT, "..", "docs", "rollout");
const REPORT_DIR = resolve(arg("--report-dir", ROLLOUT));
if (!M || !H) { console.error("missing MONDAY_API_TOKEN or HUBSPOT_CRM_APP_TOKEN in .dev.vars"); process.exit(1); }
if (APPLY && GROUPS.includes("contacts-card") && !T) { console.error("contacts-card --apply needs TRIGGER_SECRET in .dev.vars (the value set on the CRM Worker)"); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const uniq = xs => [...new Set(xs.map(String))];
const INTEGRATION = INTEGRATION_USER_ID;                   // "ask ada", the user the Worker writes as
/** The hiffer-owned automations that stamp a date when a timeline entry arrives: not a person's edit. */
const WORKFLOW_USER = "104231431";
/**
 * Contacts / Accounts / Deals Last Activity Date -- and, since 2026-09-30, the Contacts "Activity bell
 * (sync)", which the bell workflow stamps as that same user on every Emails & Activities entry. Without it
 * every bell stamp counted as a person's edit, so a card whose only activity was a timeline entry read as
 * person-edited (the safe direction -- fewer deletions -- but it skewed every classification after 09-30).
 * Imported, so it cannot drift from webhooks.ts ACTIVITY_BELL_COL (activity-doorbell.test.ts pins that).
 */
const LAD_COLS = new Set(["date_mm7054jz", "date_mm7dtzwm", "date__1", BELL_COL]);
const B = {
  contacts:  { board: "5028000495", idCol: "text_mm6t71dj" },
  companies: { board: "5028000496", idCol: "text_mm6tsnwx" },
  deals:     { board: "5028000494", idCol: "text_mm76kxz4" },
};
const ACC_DEAL_REL = "board_relation_mm76cv3c", ACC_DEAL_MIRROR = "account_deal";
const DEAL_COMPANY_REL = "board_relation_mm76wp4e", DEAL_LINE_ITEM_REL = "board_relation_mm76btmt";
/** The window the Accounts classifiers read the activity log over: every card in scope was born after it. */
const ACCOUNTS_EVER = "2026-09-01T00:00:00Z";
/** The skeptic's window for a person's edit on a contact an Account delete would orphan. */
const CONTACT_EDIT_SINCE = "2026-08-01T00:00:00Z";
const HS_ACTIVITY_SINCE = "2026-09-01";

// ------------------------------------------------------------------ report
const startedAt = new Date().toISOString();
const stamp = startedAt.slice(11, 19).replace(/:/g, "");
try { mkdirSync(REPORT_DIR, { recursive: true }); } catch { /* the write below says why */ }
let OUT = join(REPORT_DIR, `${startedAt.slice(0, 10)}-cleanup-extra-cards-${APPLY ? "applied" : "plan"}.json`);
if (existsSync(OUT)) OUT = OUT.replace(/\.json$/, `-${stamp}.json`);   // never overwrite an earlier report
const JOURNAL = join(REPORT_DIR, `${startedAt.slice(0, 10)}-cleanup-extra-cards-deleted.jsonl`);
const report = {
  script: "cleanup-extra-cards", apply: APPLY, canary: CANARY, groups: GROUPS, limit: Number.isFinite(LIMIT) ? LIMIT : null,
  startedAt, planDir: PLAN_DIR, planFiles: {}, baselines: {}, integrationToken: null,
  corrections: [
    "accounts-idless: the 14 TOUCHED-BY-PERSON plus the skeptic's 66 (q-review-candidates.json) go to review; the orphan-contact rule is re-derived live",
    "accounts-idless: Niimbot 2858872440, Kitronyx 2857200440, Ocusun 2857206485 (only company of a HubSpot deal) and Nuvoton 2857190665 held",
    "accounts-idless: Subvertron 2858206655 deleted without relinking (its contacts are the stale merged cards of the contacts group)",
    "accounts-dups: delete, never blank; an extra holding timeline entries the survivor lacks waits until the survivor carries them",
    "contacts: deleting with the integration token does not stop a restore; merged cards need a live survivor card and the HubSpot merge in place",
    "deals: id-less only; confirmFirst and create-in-HubSpot cards held; 350443684547 '新的 deal' left alone (it has an ID)",
  ],
  release: null,
  tally: {}, holdReasons: {}, waivedReasons: {}, items: [], deleting: [], deleted: [], restoreList: [], failed: [], creating: [], created: [],
  warnings: [],
};
function save() {
  report.savedAt = new Date().toISOString();
  const text = JSON.stringify(report, null, 1);
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, text);
  // Written whole and renamed, so a kill mid-write never leaves a report that cannot be parsed. On Windows a
  // reader holding the file open can refuse the rename: tried 5 times, then written in place.
  for (let t = 0; t < 5; t++) { try { renameSync(tmp, OUT); return; } catch { sleepSync(150); } }
  writeFileSync(OUT, text); try { unlinkSync(tmp); } catch { /* left beside it */ }
}
const journal = row => { if (APPLY) appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); };
function record(item, outcome, extra = {}) {
  const row = { group: item.group, kind: item.kind, id: item.id, name: item.name, outcome, ...extra, at: new Date().toISOString() };
  report.items.push(row);
  const t = (report.tally[item.group] ??= {});
  t[outcome] = (t[outcome] ?? 0) + 1;
  for (const r of extra.reasons ?? []) {
    const k = String(r).split(":")[0];
    const h = (report.holdReasons[item.group] ??= {});
    h[k] = (h[k] ?? 0) + 1;
  }
  for (const r of extra.waived ?? []) {                      // --release: what the read behind this row waived
    const k = String(r).split(":")[0];
    const w = (report.waivedReasons[item.group] ??= {});
    w[k] = (w[k] ?? 0) + 1;
  }
  save();
  return row;
}
/** A released card's row says so: its bucket, why the plan held it, what this read waived (and, after a second
 *  read, what the first one waived), and this read's facts (ids and counts: the mirror evidence included), so a
 *  released card that still holds shows why. Any other card's row is unchanged. */
const released = (it, vd, first = null) => !it.release ? {} : {
  released: it.release, ...(it.planHeld ? { planHeld: it.planHeld } : {}), waived: vd?.waived ?? [],
  ...(first ? { waivedFirstRead: first.waived ?? [] } : {}), facts: vd?.facts ?? {},
};
const releasedTag = (it, vd) => !it.release ? "" : ` [released ${it.release}${vd?.waived?.length ? `; waived ${vd.waived.join(", ")}` : ""}]`;
/**
 * --release --canary: did this canary try the timeline waiver, the one delete checked against the contact cards
 * afterwards? A canary that did not (a plan candidate, or a card that waived only an orphan reason) leaves that path
 * untried and says so: the header's order is ONE card that waives a timeline entry first, then a look at its contact.
 * `row` is the canary's report row (--apply), for the check's outcome.
 */
function canaryReleaseNote(it, vd, row = null) {
  if (!it.release) return "release: the canary is not a released card (it is the first eligible item, in the run's order) -- the release is untried";
  if (!waivesTimeline(vd?.waived))
    return `release: the canary (${it.release}) waived no timeline entry, so the check after a timeline waiver is untried -- canary one card that waives one (a release file listing only it) before the rest`;
  const at = (vd.mirrorEvidence?.contacts ?? []).join(",") || "?";
  if (!APPLY) return `release: the canary waives a timeline entry; --apply --canary would re-check contact card(s) ${at} after the delete -- then open them in monday before releasing the rest`;
  return row?.mirrorAfterDelete?.ok
    ? `release: the canary waived a timeline entry and contact card(s) ${at} still hold every twin -- open them in monday and confirm the person's entries are there before releasing the rest`
    : "release: the canary waived a timeline entry and the check after the delete did not pass (see the HALT) -- do not release the rest";
}

// ------------------------------------------------------------------ monday (reads; delete_item only on --apply)
const DELETE_ITEM = `mutation ($i: ID!) { delete_item(item_id: $i) { id } }`;
const TRANSIENT = /complexity|rate.?limit|budget|too many requests|throttl|concurren|temporar|timed? ?out|internal server error|service unavailable/i;
/**
 * ONE monday call. Retries only what a second try can fix (429 / 5xx, rate or complexity limits, network),
 * waiting as long as monday asks. A 401/403 or a spent daily limit is marked `abort`: every later call would
 * fail the same way. The only mutation this script can send is delete_item, and only under --apply.
 */
async function monday(query, variables = {}, attempt = 0) {
  if (/^\s*mutation\b/i.test(query) && !(APPLY && query === DELETE_ITEM))
    throw Object.assign(new Error("refusing a monday mutation: only delete_item, only with --apply"), { abort: true });
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
    const askedWait = Number((Array.isArray(errs) ? errs : []).find(e => e?.extensions?.retry_in_seconds)?.extensions?.retry_in_seconds)
      || Number(/reset in (\d+)/i.exec(text)?.[1]) || 0;
    await sleep(askedWait ? Math.min(askedWait + 1, 65) * 1000 : 3000 * (attempt + 1));
    return monday(query, variables, attempt + 1);
  }
  throw Object.assign(new Error(`monday ${r.status}: ${text.slice(0, 240)}`), { abort });
}

const ITEMS_Q = `query ($i: [ID!], $c: [String!]) { items(ids: $i, limit: 100) {
  id name state created_at creator_id board { id }
  column_values(ids: $c) { id text ... on BoardRelationValue { linked_item_ids } ... on MirrorValue { display_value } }
  updates(limit: 25) { id creator_id created_at } assets { id created_at } subitems { id created_at } } }`;
/** Cards by id, 25 per query. items(ids:) silently stops at 25 rows without `limit`, and returns non-active
 *  cards too, with their state -- which is what tells a deleted card from a live one. */
async function readItems(ids, cols) {
  const out = new Map();
  const list = uniq(ids);
  for (let i = 0; i < list.length; i += 25) {
    const d = await monday(ITEMS_Q, { i: list.slice(i, i + 25), c: cols.length ? cols : ["name"] });
    for (const it of d.items ?? []) {
      out.set(String(it.id), {
        id: String(it.id), name: it.name ?? "", state: it.state ?? null, board: it.board?.id != null ? String(it.board.id) : null,
        created_at: it.created_at ?? null, creator: it.creator_id != null ? String(it.creator_id) : null,
        cols: Object.fromEntries((it.column_values ?? []).map(cv => [cv.id, { text: String(cv.text ?? "").trim(),
          linked: (cv.linked_item_ids ?? []).map(String), display: String(cv.display_value ?? "").trim() }])),
        updates: (it.updates ?? []).map(u => ({ id: String(u.id), creator: String(u.creator_id ?? ""), created_at: u.created_at ?? "" })),
        assets: (it.assets ?? []).map(a => ({ id: String(a.id), created_at: a.created_at ?? "" })),
        subitems: (it.subitems ?? []).map(s => ({ id: String(s.id), created_at: s.created_at ?? "" })),
      });
    }
  }
  return out;
}
async function readStates(ids) {
  const out = new Map();
  const list = uniq(ids);
  for (let i = 0; i < list.length; i += 50) {
    const d = await monday(`query ($i: [ID!]) { items(ids: $i, limit: 100) { id state } }`, { i: list.slice(i, i + 50) });
    for (const it of d.items ?? []) out.set(String(it.id), it.state ?? null);
  }
  return out;
}
const linked = (card, col) => card?.cols?.[col]?.linked ?? [];
const textOf = (card, col) => card?.cols?.[col]?.text ?? "";

/** Board activity-log rows since `from`, per item, 25 items per query, paged. */
async function readLogs(board, ids, from) {
  const out = new Map();
  const list = uniq(ids);
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    for (let page = 1; ; page++) {
      if (page > 60) throw new Error(`activity log of board ${board} did not end within 60 pages`);
      const d = await monday(`query ($b: [ID!], $i: [ID!], $f: ISO8601DateTime, $p: Int) { boards(ids: $b) {
        activity_logs(item_ids: $i, from: $f, limit: 500, page: $p) { id event user_id created_at data } } }`,
        { b: [board], i: chunk, f: from, p: page });
      const logs = d.boards?.[0]?.activity_logs ?? [];
      for (const l of logs) {
        let data = {}; try { data = JSON.parse(l.data); } catch { /* keep the row, without its column */ }
        const item = String(data.pulse_id ?? data.item_id ?? "");
        if (!item) continue;
        const row = { at: new Date(Number(l.created_at) / 10000).toISOString(), user: String(l.user_id ?? ""), event: l.event, col: data.column_id ?? "" };
        (out.get(item) ?? out.set(item, []).get(item)).push(row);
      }
      if (logs.length < 500) break;
    }
  }
  return out;
}
const isAutomation = u => /^-\d+$/.test(String(u ?? ""));
const isPersonRow = r => r.user !== INTEGRATION && !isAutomation(r.user) && !(r.user === WORKFLOW_USER && LAD_COLS.has(r.col));

const MARKER = /\[hubspot:([a-z_]+):([A-Za-z0-9_-]+)\]/g;
const TIMELINE_Q = `query ($i: ID!, $c: String) { timeline(id: $i) { timeline_items_page(limit: 100, cursor: $c) {
  cursor timeline_items { id type custom_activity_id title content created_at user { id } } } } }`;
/** A card's whole timeline, reduced to what the checks need: author, time, markers and a fingerprint.
 *  Content is read only to find markers; it is never stored or printed. */
const timelineCache = new Map();
async function readTimeline(card, { cache = false } = {}) {
  if (cache && timelineCache.has(card)) return timelineCache.get(card);
  const entries = new Map(); const cursors = new Set(); let cursor = null, complete = false;
  for (let p = 0; p < 100; p++) {
    const d = await monday(TIMELINE_Q, { i: card, c: cursor });
    const page = d.timeline?.timeline_items_page;
    if (!page) break;
    for (const e of page.timeline_items ?? []) entries.set(e.id, {
      id: e.id, type: e.type ?? "", custom: e.custom_activity_id ?? null, created_at: e.created_at ?? "",
      user: e.user?.id != null ? String(e.user.id) : null,
      markers: [...String(e.content ?? "").matchAll(MARKER)].map(m => `${m[1]}:${m[2]}`),
      fp: createHash("sha256").update(JSON.stringify([e.type ?? "", e.custom_activity_id ?? "", e.title ?? "", e.created_at ?? ""])).digest("hex").slice(0, 16),
    });
    cursor = page.cursor ?? null;
    if (!cursor) { complete = true; break; }
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  const list = [...entries.values()];
  const t = { complete, entries: list, markers: new Set(list.flatMap(e => e.markers)), fps: new Set(list.map(e => e.fp)) };
  if (cache) timelineCache.set(card, t);
  return t;
}
/**
 * The cards monday's own ID search returns for one value, IN ITS ORDER AND WITH THEIR STATE -- the search every
 * Worker path uses. The Worker (findItemByColumn) takes hit [0] and does NOT filter by state: a card deleted a
 * moment ago can still be returned while monday's index catches up, and ensureCardForRecord's own search does
 * not exclude it (the restore's ignoreItemId covers only the card being restored). So "the Worker's first hit"
 * and "has the deleted card left the index" are judged on this RAW list; "who holds the id" on its live part.
 * (Filtering to active here made both of those checks blind: a lingering dead card was simply never seen.)
 */
async function idSearch(board, col, value) {
  const d = await monday(`query ($b: ID!, $c: String!, $v: [String]!) {
    items_page_by_column_values(board_id: $b, limit: 25, columns: [{ column_id: $c, column_values: $v }]) { items { id state } } }`,
    { b: board, c: col, v: [String(value)] });
  return (d.items_page_by_column_values?.items ?? []).map(x => ({ id: String(x.id), state: x.state ?? "unknown" }));
}
/** Not provably gone. An unknown state counts as live: it must hold, not pass. */
const live = h => h.state !== "deleted" && h.state !== "archived";
const hitTag = h => (h ? (h.state === "active" ? h.id : `${h.id}(${h.state})`) : "none");

// ------------------------------------------------------------------ HubSpot (read only)
async function hs(path, body, attempt = 0) {
  const post = body !== undefined;
  if (post && !/\/(search|batch\/read)$/.test(path.split("?")[0])) throw new Error("read-only: HubSpot POST only to search / batch/read");
  let r;
  try {
    r = await fetch(`https://api.hubapi.com${path}`, { method: post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
      body: post ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    if (attempt < 6) { await sleep(2500 * (attempt + 1)); return hs(path, body, attempt + 1); }
    throw new Error(`hubspot network: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2500 * (attempt + 1)); return hs(path, body, attempt + 1); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`hubspot ${path.split("?")[0].replace(/\d{6,}/g, "<id>")}: ${r.status}`);
  return r.json();
}
/** Contact properties by the REQUESTED id (a merged id is not in the answer under its own id). */
async function hsContacts(ids, properties) {
  const out = new Map();
  const list = uniq(ids).filter(x => /^\d+$/.test(x));
  for (let i = 0; i < list.length; i += 100) {
    const r = await hs("/crm/v3/objects/contacts/batch/read", { inputs: list.slice(i, i + 100).map(id => ({ id })), properties });
    for (const x of r?.results ?? []) out.set(String(x.id), x.properties ?? {});
  }
  return out;
}
async function hsContactDeals(ids) {
  const out = new Map();
  const list = uniq(ids).filter(x => /^\d+$/.test(x));
  for (let i = 0; i < list.length; i += 100) {
    const r = await hs("/crm/v4/associations/contacts/deals/batch/read", { inputs: list.slice(i, i + 100).map(id => ({ id })) });
    for (const x of r?.results ?? []) out.set(String(x.from?.id), (x.to ?? []).map(t => String(t.toObjectId)));
  }
  return out;
}
async function hsAssocCount(from, id, to) {
  let n = 0, after = null;
  for (let p = 0; p < 50; p++) {
    const r = await hs(`/crm/v4/objects/${from}/${id}/associations/${to}?limit=500${after ? `&after=${after}` : ""}`);
    if (!r) return null;
    n += (r.results ?? []).length;
    after = r.paging?.next?.after;
    if (!after) return n;
  }
  return null;
}

// ------------------------------------------------------------------ the plans
function loadPlan(rel) {
  const p = join(PLAN_DIR, rel);
  if (!existsSync(p)) { console.error(`refusing to run: plan file ${p} is missing`); process.exit(1); }
  const text = readFileSync(p, "utf8");
  let j; try { j = JSON.parse(text); } catch { console.error(`refusing to run: cannot parse ${p}`); process.exit(1); }
  report.planFiles[rel] = { sha256: createHash("sha256").update(text).digest("hex"), generatedAt: j.generatedAt ?? j.summary?.generatedAt ?? null };
  return j;
}
const P = {
  idless: loadPlan("accounts-idless-classified.json"),
  dups: loadPlan("accounts-dups-plan.json"),
  contacts: loadPlan("contacts-plan.json"),
  deals: loadPlan("deals-plan.json"),
  review: GROUPS.includes("accounts-idless") ? loadPlan("skeptic-idless/q-review-candidates.json") : null,
};
/**
 * "Since the plan": its generatedAt less 2 h, because a plan's reads happen before it is written. A date-only
 * stamp counts from that midnight. Earlier is only more conservative: every item here was classified with no
 * person's activity in that window, so a row found in it is new, or a plan error -- either way it holds.
 */
function baselineOf(gen) {
  const s = String(gen ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t - 2 * 3_600_000).toISOString() : null;
}
report.baselines = { contacts: baselineOf(P.contacts.generatedAt), deals: baselineOf(P.deals.generatedAt) };
for (const [k, b] of Object.entries(report.baselines))
  if (!b && GROUPS.includes(k)) { console.error(`refusing to run: the ${k} plan has no usable generatedAt`); process.exit(1); }

const plan = Object.fromEntries(ORDER.map(g => [g, { candidates: [], held: [] }]));
const hold = (g, item, reason) => plan[g].held.push({ ...item, group: g, planReason: reason });
const IDLESS_ALL = new Set(P.idless.cards.map(c => String(c.id)));
const PROTECTED = new Map();                               // card id -> why it must never be deleted (the last reason set)
/** card id -> EVERY reason it was protected for. PROTECTED keeps one (the last), so a card held for review AND
 *  protected as another card's real company card could read as "review" alone; a release must see them all. */
const PROTECTED_WHY = new Map();
const protect = (id, why) => { PROTECTED.set(id, why); (PROTECTED_WHY.get(id) ?? PROTECTED_WHY.set(id, new Set()).get(id)).add(why); };

// accounts-idless
const SKEPTIC_NAMED = {
  "2858872440": "only company record of HubSpot deal 348349665993 (Niimbot / 武汉精臣)",
  "2857200440": "only company record of HubSpot deal 342654281437 (Kitronyx)",
  "2857206485": "only company record of HubSpot deal 343822208698 (Ocusun / 润尔眼科, Closed Won)",
  "2857190665": "its contact was edited by a person on 2026-09-30 and has HubSpot activity (Nuvoton)",
};
{
  const review = new Map((P.review ?? []).map(x => [String(x.id), (x.sig ?? []).join(" ")]));
  for (const c of [...P.idless.cards].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
    const item = { group: "accounts-idless", kind: "idless-account", id: String(c.id), name: c.name, board: B.companies.board,
      planClass: c.class, planContacts: (c.links?.contacts ?? []).map(String), realCompany: c.realCompany ?? [] };
    if (c.class === "TOUCHED-BY-PERSON") { hold("accounts-idless", item, "plan: TOUCHED-BY-PERSON (a rep works its contact; user reviews)"); protect(item.id, "review"); }
    else if (SKEPTIC_NAMED[item.id]) { hold("accounts-idless", item, `skeptic: ${SKEPTIC_NAMED[item.id]}`); protect(item.id, "review"); }
    else if (review.has(item.id)) { hold("accounts-idless", item, `skeptic review: ${review.get(item.id)}`); protect(item.id, "review"); }
    else if (!["JUNK-UNTOUCHED", "DUPLICATE-OF-REAL"].includes(c.class)) { hold("accounts-idless", item, `plan: unknown class ${c.class}`); protect(item.id, "unknown"); }
    else plan["accounts-idless"].candidates.push(item);
    for (const r of c.realCompany ?? []) for (const card of r.cards ?? []) protect(String(card), "the real company card of an id-less duplicate");
  }
}
// accounts-dups
{
  let extras = 0;
  for (const g of P.dups.groups ?? []) {
    const X = String(g.hubspotCompanyId), S = String(g.survivor?.cardId ?? "");
    if (!/^\d+$/.test(X) || !/^\d+$/.test(S)) { console.error(`refusing to run: a dups group without a company id or survivor`); process.exit(1); }
    protect(S, `the survivor for HubSpot company ${X}`);
    const siblings = (g.extras ?? []).map(e => String(e.cardId));
    for (const e of g.extras ?? []) {
      extras++;
      const allowedContacts = (P.dups.doNotMove ?? []).filter(d => String(d.extra) === String(e.cardId))
        .map(d => /contact link (\d+)/.exec(String(d.what ?? ""))?.[1]).filter(Boolean);
      const item = { group: "accounts-dups", kind: "dup-extra", id: String(e.cardId), name: e.name, board: B.companies.board,
        hubspotId: X, survivor: S, siblings, allowedContacts };
      if (String(e.hubspotIdCol ?? "") !== X) hold("accounts-dups", item, "plan: the extra's recorded id differs from its group");
      else plan["accounts-dups"].candidates.push(item);
    }
  }
  if (extras !== Number(P.dups.counts?.extrasToRemove ?? extras)) { console.error(`refusing to run: the dups plan lists ${extras} extras but counts ${P.dups.counts?.extrasToRemove}`); process.exit(1); }
}
// contacts
{
  const f = P.contacts.forCleanupScript ?? {};
  const merged = new Map((P.contacts.cardedNotInHs?.items ?? []).map(x => [String(x.card), x]));
  const idless = new Map((P.contacts.idless?.items ?? []).map(x => [String(x.card), x]));
  const pre = new Map((f.deleteAfterPreStep ?? []).map(x => [String(x.card), String(x.preStep ?? "")]));
  for (const card of [...(f.deleteNow ?? []), ...(f.deleteAfterPreStep ?? []).map(x => x.card)].map(String)) {
    if (merged.has(card)) {
      const x = merged.get(card);
      const survivorHsId = /merged into (\d+)/.exec(String(x.hubspotFate ?? ""))?.[1];
      const survivorCard = /^(\d+)/.exec(String(x.survivorCard ?? ""))?.[1];
      if (!/^DELETE/.test(String(x.recommendation ?? "")) || !survivorHsId || !survivorCard || !/^\d+$/.test(String(x.hubspotIdOnCard ?? ""))) {
        console.error(`refusing to run: contacts plan entry ${card} is not a readable merged-card delete`); process.exit(1);
      }
      const requiredMarkers = [];
      if (pre.has(card)) {
        const m = /(\w+) (\d+) -> verify on (\d+)/.exec(pre.get(card));
        if (!m || m[3] !== survivorCard) { console.error(`refusing to run: cannot read the pre-step of ${card}`); process.exit(1); }
        requiredMarkers.push(`${m[1]}:${m[2]}`);
      }
      protect(survivorCard, `the survivor card of merged contact ${survivorHsId}`);
      plan.contacts.candidates.push({ group: "contacts", kind: "merged-contact", id: card, name: x.name, board: B.contacts.board,
        hubspotId: String(x.hubspotIdOnCard), survivorHsId, survivorCard, requiredMarkers });
    } else if (idless.has(card) && idless.get(card).recommendation === "DELETE") {
      plan.contacts.candidates.push({ group: "contacts", kind: "idless-contact", id: card, name: idless.get(card).name, board: B.contacts.board });
    } else { console.error(`refusing to run: contacts plan lists ${card} for deletion but explains it nowhere`); process.exit(1); }
  }
  for (const x of f.deleteAfterConfirmation ?? []) {
    hold("contacts", { kind: "idless-contact", id: String(x.card), name: idless.get(String(x.card))?.name ?? "" }, `needs confirmation from ${x.confirmWith}`);
    protect(String(x.card), "needs confirmation");
    if (x.pairWithDealCard) protect(String(x.pairWithDealCard), `paired with ${x.card}, which needs confirmation`);
  }
  for (const x of f.keep ?? []) { hold("contacts", { kind: "keep", id: String(x.card), name: idless.get(String(x.card))?.name ?? "" }, `keep: ${x.reason}`); protect(String(x.card), "keep"); }
}
const MERGED_STALE = new Set(plan.contacts.candidates.filter(i => i.kind === "merged-contact").map(i => i.id));
// deals
for (const c of P.deals.cards ?? []) {
  const item = { group: "deals", kind: "idless-deal", id: String(c.id), name: c.name, board: B.deals.board };
  if (c.recommendation !== "delete") { hold("deals", item, `needs a person: ${c.recommendation}`); protect(item.id, "real deal"); }
  else if (c.confirmFirst) { hold("deals", item, `needs confirmation from ${String(c.confirmFirst).split(/[.\s]/)[0]}`); protect(item.id, "needs confirmation"); }
  else if (PROTECTED.has(item.id)) hold("deals", item, `protected: ${PROTECTED.get(item.id)}`);
  else plan.deals.candidates.push(item);
}
// contacts-card: only what the contacts plan recommends carding
{
  const rec = (P.contacts.hsNoCard?.items ?? []).find(x => /^CREATE CARDS/i.test(String(x.recommendation ?? "")));
  const allowed = new Set((P.contacts.forCleanupScript?.createViaCatchup ?? []).map(String));
  (rec?.hubspotIds ?? []).map(String).forEach((id, i) => {
    const item = { group: "contacts-card", kind: "card-create", id, name: rec.names?.[i] ?? "", board: B.contacts.board };
    if (allowed.has(id)) plan["contacts-card"].candidates.push(item);
    else hold("contacts-card", item, "not in forCleanupScript.createViaCatchup");
  });
  for (const x of P.contacts.forCleanupScript?.leaveUncarded ?? [])
    hold("contacts-card", { kind: "card-create", id: String(x.hubspotId), name: "" }, `leave uncarded: ${x.reason}`);
}
// The 2026-09-30 count reconciliation's own lists, the input every plan was built from. Loaded here, before the
// release, because a released card must be on them too; every candidate is checked against them further down.
const REC = (() => {
  const rec = {};
  for (const k of ["companies", "contacts", "deals"]) {
    const p = join(RECONCILE_DIR, `${k}.json`);
    if (!existsSync(p)) { console.error(`refusing to run: reconciliation list ${p} is missing (--reconcile-dir)`); process.exit(1); }
    const text = readFileSync(p, "utf8");
    try { rec[k] = JSON.parse(text); } catch { console.error(`refusing to run: cannot parse ${p}`); process.exit(1); }
    report.planFiles[`reconcile/${k}.json`] = { sha256: createHash("sha256").update(text).digest("hex") };
  }
  const ids = xs => new Set((xs ?? []).map(x => String(x?.id ?? x)));
  return {
    idless: { companies: ids(rec.companies.idless), contacts: ids(rec.contacts.idless), deals: ids(rec.deals.idless) },
    dupSets: new Map((rec.companies.dupIds ?? []).map(([h, cards]) => [String(h), new Set((cards ?? []).map(String))])),
    staleIds: ids(rec.contacts.cardedNotInHs), noCard: ids(rec.contacts.hsNoCard),
  };
})();
// --release (accounts-idless only): the user's approval list, validated WHOLE against the plan and the
// reconciliation before anything is read from monday. Any problem refuses the run; nothing is released in part.
let RELEASE = null;
const SAFE_BEFORE_RELEASE = new Set(GROUPS.flatMap(g => plan[g].candidates.filter(c => c.kind !== "card-create").map(c => c.id)));
const RELEASED_HELD = new Set();                           // held cards the release made candidates
if (RELEASE_FILE) {
  if (!existsSync(RELEASE_FILE)) { console.error(`refusing to run: release file ${RELEASE_FILE} is missing (--release)`); process.exit(1); }
  let bytes;
  try { bytes = readFileSync(RELEASE_FILE); }
  catch (e) { console.error(`refusing to run: cannot read release file ${RELEASE_FILE}: ${String(e?.message ?? e).slice(0, 120)}`); process.exit(1); }
  const ai = plan["accounts-idless"];
  let next;
  try {
    RELEASE = parseRelease(bytes.toString("utf8"), { planIds: IDLESS_ALL, reconIdless: REC.idless.companies,
      heldIds: new Set(ai.held.map(h => h.id)), candidateIds: new Set(ai.candidates.map(c => c.id)), protectedWhy: PROTECTED_WHY });
    next = releasePlan(ai, RELEASE);
  } catch (e) { console.error(`refusing to run: --release ${RELEASE_FILE}: ${e.message}`); process.exit(1); }
  // Lift the plan's review hold from each released held card -- that one protection and no other.
  for (const id of next.moved) {
    const other = [...(PROTECTED_WHY.get(id) ?? [])].filter(w => w !== LIFTABLE_PROTECTION);
    if (other.length) { console.error(`refusing to run: released card ${id} is protected (${other.join("; ")})`); process.exit(1); }
    PROTECTED.delete(id); PROTECTED_WHY.delete(id); RELEASED_HELD.add(id);
  }
  ai.candidates = next.candidates; ai.held = next.held;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  report.planFiles.release = { sha256, path: RELEASE_FILE, decidedAt: RELEASE.decidedAt };
  report.release = { file: RELEASE_FILE, sha256, ...RELEASE, movedFromHeld: next.moved.length, taggedL: next.tagged.length };
}
// A card a plan protects must never also be a candidate -- that could only be a plan or parsing error.
for (const g of GROUPS) for (const c of plan[g].candidates) {
  if (c.kind === "card-create") continue;                  // a HubSpot id, not a card
  if (PROTECTED.has(c.id)) {
    console.error(`refusing to run: ${c.id} (${g}) is a candidate AND protected (${PROTECTED.get(c.id)})`); process.exit(1);
  }
}
// Every candidate must also be on the 2026-09-30 reconciliation's own lists, the input every plan was built from:
// an id-less card on its idless list, an extra (and its survivor) in its dupIds set, a merged card's stale id on
// cardedNotInHs, a contact to card on hsNoCard. A plan that names anything else is refused whole.
{
  const { idless, dupSets, staleIds, noCard } = REC;
  const onList = c => ({
    "idless-account": () => idless.companies.has(c.id),
    "dup-extra": () => !!dupSets.get(c.hubspotId)?.has(c.id) && dupSets.get(c.hubspotId).has(c.survivor),
    "merged-contact": () => staleIds.has(c.hubspotId),
    "idless-contact": () => idless.contacts.has(c.id),
    "idless-deal": () => idless.deals.has(c.id),
    "card-create": () => noCard.has(c.id),
  }[c.kind]?.() ?? false);
  for (const g of GROUPS) for (const c of plan[g].candidates)
    if (!onList(c)) { console.error(`refusing to run: ${g} candidate ${c.id} (${c.kind}) is not on the reconciliation's list`); process.exit(1); }
}
/** The only ids deleteCard may ever send: the plans' candidates, never a protected card. */
const DELETABLE = new Set(GROUPS.flatMap(g => plan[g].candidates.filter(c => c.kind !== "card-create").map(c => c.id)));
// A release adds exactly its released held cards to DELETABLE, and nothing else: checked, not assumed.
{
  const added = [...DELETABLE].filter(id => !SAFE_BEFORE_RELEASE.has(id));
  const missing = (RELEASE?.cards ?? []).map(c => c.card).filter(id => !DELETABLE.has(id));
  if (added.length !== RELEASED_HELD.size || added.some(id => !RELEASED_HELD.has(id)) || missing.length) {
    console.error(`refusing to run: the deletable set changed by more than the release (added ${added.length}, released from the hold ${RELEASED_HELD.size}, released but not deletable ${missing.length})`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ the checks, per kind (pure reads)
const verdicts = items => new Map(items.map(it => [it.id, { reasons: [], facts: {}, gone: null }]));
/** A time at or after `since` (ISO), read as a date. Unparseable counts as recent: it must hold, not pass. */
const atOrAfter = (at, since) => { const t = Date.parse(String(at ?? "")); return !Number.isFinite(t) || t >= Date.parse(since); };
/**
 * Same board, same name, and nothing a person could have attached. `since` (deals only): the plan saw their
 * files, subitems and updates, so only ones added since the plan hold the card; everywhere else any one does.
 */
function identity(vd, card, item, since = null) {
  if (card.board !== item.board) vd.reasons.push(`wrong-board:${card.board}`);
  if (String(card.name).trim() !== String(item.name).trim()) vd.reasons.push("renamed-since-plan");
  const count = xs => (since ? xs.filter(x => atOrAfter(x.created_at, since)) : xs).length;
  const tag = since ? "-since-plan" : "";
  for (const [what, xs] of [["file", card.assets], ["subitem", card.subitems], ["update", card.updates]])
    if (count(xs)) vd.reasons.push(`${what}${tag}:${count(xs)}`);
}
function takeCard(vd, card) {
  if (!card) { vd.reasons.push("not-returned-by-monday"); return false; }
  if (card.state !== "active") { vd.gone = card.state ?? "unknown"; return false; }
  return true;
}
/**
 * A person's edit in the board activity log since `from`.
 *   requireBirth  the window claims to cover the card's whole life, so the card's own create_pulse row must be
 *                 in it; without it the log is incomplete (retention, a missed page) and silence proves nothing.
 *   idCol         ANY write to the HubSpot ID column, by anyone, holds the card. It is the only way a card that
 *                 is id-less now can have been paired, and so hold an hsof:<board>:<item> entry: every writer of
 *                 that index (finishCard: a card ensureCardForRecord created or adopted, or one createFromMonday
 *                 made a record for) had the id on the card, so an id-less card with an entry had it blanked.
 *                 Deleting such a card is NOT unattributable: the restore runs for that record, finds no card
 *                 holding its id, and ensureCardForRecord creates a new one.
 */
async function personEdits(board, ids, from, out, { idCol = null, requireBirth = false } = {}) {
  const logs = await readLogs(board, ids, from);
  for (const id of ids) {
    const rows = logs.get(id) ?? [];
    const p = rows.filter(isPersonRow);
    if (p.length) out.get(id).reasons.push(`person-edit:${uniq(p.map(r => r.user)).join("/")}@${p.map(r => r.at).sort().pop()}`);
    if (requireBirth && !rows.some(r => r.event === "create_pulse")) out.get(id).reasons.push("activity-log-does-not-reach-birth");
    if (idCol) {
      const w = rows.filter(r => r.col === idCol);
      if (w.length) out.get(id).reasons.push(`id-column-was-written:${uniq(w.map(r => r.user)).join("/")}@${w.map(r => r.at).sort().pop()}`);
    }
  }
}
/** Born inside the log window, or the window cannot be called "ever". Unparseable holds. */
function bornInWindow(vd, card, since) {
  const t = Date.parse(String(card.created_at ?? ""));
  if (!Number.isFinite(t) || t < Date.parse(since)) vd.reasons.push(`born-before-log-window:${card.created_at ?? "unknown"}`);
}
async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

async function checkIdlessAccounts(items) {
  const out = verdicts(items);
  const cards = await readItems(items.map(i => i.id), [B.companies.idCol, "account_contact", ACC_DEAL_REL, ACC_DEAL_MIRROR]);
  const alive = [];
  for (const it of items) {
    const vd = out.get(it.id), c = cards.get(it.id);
    if (!takeCard(vd, c)) continue;
    identity(vd, c, it);
    bornInWindow(vd, c, ACCOUNTS_EVER);
    if (c.creator !== INTEGRATION) vd.reasons.push(`creator:${c.creator}`);
    if (textOf(c, B.companies.idCol)) vd.reasons.push("has-hubspot-id-now");
    if (linked(c, ACC_DEAL_REL).length || c.cols[ACC_DEAL_MIRROR]?.display || textOf(c, ACC_DEAL_MIRROR)) vd.reasons.push("deal-link");
    const planned = new Set(it.planContacts);
    const now = linked(c, "account_contact");
    const added = now.filter(x => !planned.has(x));
    if (added.length) vd.reasons.push(`contact-link-not-in-plan:${added.join("/")}`);
    vd.facts.contacts = now;
    alive.push(it);
  }
  if (!alive.length) return out;
  await personEdits(B.companies.board, alive.map(i => i.id), ACCOUNTS_EVER, out, { idCol: B.companies.idCol, requireBirth: true });
  const notOursOf = new Map();                             // --release: a released card's entries not by the integration user
  await pool(alive, 4, async it => {
    const t = await readTimeline(it.id);
    if (!t.complete) out.get(it.id).reasons.push("timeline-unreadable");
    const notOurs = t.entries.filter(e => e.user !== INTEGRATION);
    if (notOurs.length) out.get(it.id).reasons.push(`timeline-entry-not-ours:${notOurs.length}`);
    out.get(it.id).facts.timelineEntries = t.entries.length;
    if (it.release && notOurs.length) notOursOf.set(it.id, { complete: t.complete, entries: notOurs });
  });
  // A DUPLICATE is only a duplicate while its real card is still there, holding the real id.
  const dups = alive.filter(i => i.planClass === "DUPLICATE-OF-REAL");
  const real = await readItems(dups.flatMap(i => i.realCompany.flatMap(r => r.cards ?? [])), [B.companies.idCol]);
  for (const it of dups) {
    const ok = it.realCompany.some(r => (r.cards ?? []).some(cid => {
      const c = real.get(String(cid));
      return c?.state === "active" && textOf(c, B.companies.idCol) === String(r.hsId);
    }));
    if (!ok) out.get(it.id).reasons.push("real-company-card-gone");
    else out.get(it.id).facts.realCards = it.realCompany.flatMap(r => r.cards ?? []);
  }
  // THE ORPHAN-CONTACT RULE (the skeptic's, re-derived live): a contact this delete would leave with no Account
  // -- no linked Account outside the id-less list -- must not have a deal, a person's edit or HubSpot activity.
  // The stale merged contact cards are skipped: the contacts group deletes them, and their activity is the survivor's.
  const contactIds = uniq(alive.flatMap(i => out.get(i.id).facts.contacts ?? [])).filter(x => !MERGED_STALE.has(x));
  const contacts = await readItems(contactIds, [B.contacts.idCol, "contact_account", "contact_deal"]);
  const orphanOf = new Map();                              // contact card -> the account cards that orphan it
  for (const it of alive) for (const cid of out.get(it.id).facts.contacts ?? []) {
    if (MERGED_STALE.has(cid)) continue;
    const c = contacts.get(cid);
    // A contact monday did not return cannot be judged: it holds, it does not pass.
    if (!c) { out.get(it.id).reasons.push(`linked-contact-not-returned:${cid}`); continue; }
    if (c.state !== "active") continue;
    if (linked(c, "contact_account").some(a => !IDLESS_ALL.has(a))) continue;
    (orphanOf.get(cid) ?? orphanOf.set(cid, []).get(cid)).push(it.id);
    if (linked(c, "contact_deal").length) out.get(it.id).reasons.push(`orphaned-contact-has-deal:${cid}`);
  }
  if (orphanOf.size) {
    const logs = await readLogs(B.contacts.board, [...orphanOf.keys()], CONTACT_EDIT_SINCE);
    const hsOf = new Map([...orphanOf.keys()].map(cid => [cid, textOf(contacts.get(cid), B.contacts.idCol)]));
    const props = await hsContacts([...hsOf.values()], ["notes_last_updated"]);
    const deals = await hsContactDeals([...hsOf.values()]);
    for (const [cid, accounts] of orphanOf) {
      const why = [];
      const p = (logs.get(cid) ?? []).filter(isPersonRow);
      if (p.length) why.push(`orphaned-contact-person-edit:${cid}`);
      const hsId = hsOf.get(cid);
      // batch/read answers under the REQUESTED id only for a live, unmerged record: a merged, archived or
      // malformed id comes back missing, and "no activity" must not be read from a record that was not read.
      if (hsId && !props.has(hsId)) why.push(`orphaned-contact-hubspot-unread:${cid}`);
      if (hsId && String(props.get(hsId)?.notes_last_updated ?? "") >= HS_ACTIVITY_SINCE) why.push(`orphaned-contact-hubspot-activity:${cid}`);
      if (hsId && (deals.get(hsId) ?? []).length) why.push(`orphaned-contact-hubspot-deal:${cid}`);
      for (const a of accounts) { out.get(a).reasons.push(...why); (out.get(a).facts.orphans ??= []).push(cid); }
    }
  }
  // --release, RELEASED CARDS ONLY: is every timeline entry on the Account not by the integration user also on a
  // contact card linked to it NOW (active, and not a merged stale card the contacts group deletes)? Read on every
  // read -- the first and the --apply second alike -- so the waiver decides from this read's own facts. The
  // contact timelines are read whole or the answer is no. Cards without a release read nothing more here.
  for (const it of alive) {
    const mine = notOursOf.get(it.id);
    if (!it.release || !mine) continue;
    const vd = out.get(it.id);
    const holders = (vd.facts.contacts ?? []).filter(cid => !MERGED_STALE.has(cid) && contacts.get(cid)?.state === "active");
    const timelines = [];
    for (const cid of holders) timelines.push(await readTimeline(cid, { cache: !APPLY }));
    vd.facts.personEntries = mine.entries.length;
    vd.facts.personEntriesMirrored = mine.complete === true && personEntriesMirrored(mine.entries, timelines);
    vd.facts.mirrorContacts = holders;
    const unread = holders.filter((cid, i) => !timelines[i].complete);
    if (unread.length) vd.facts.mirrorContactsUnreadable = unread;
    // What a timeline waiver rests on, kept on THIS read's verdict and never in the report (ids, markers and
    // fingerprints only, no content): a delete this read allows is checked against it afterwards (afterReleasedDelete).
    vd.mirrorEvidence = { entries: mine.entries.map(({ id, markers, fp }) => ({ id, markers, fp })), contacts: holders };
  }
  return out;
}

async function checkDupExtras(items) {
  const out = verdicts(items);
  const survivors = uniq(items.map(i => i.survivor));
  const cards = await readItems([...items.map(i => i.id), ...survivors], [B.companies.idCol, "account_contact", ACC_DEAL_REL, ACC_DEAL_MIRROR]);
  const search = new Map(), company = new Map();
  for (const X of uniq(items.map(i => i.hubspotId))) {
    search.set(X, await idSearch(B.companies.board, B.companies.idCol, X));
    const r = await hs(`/crm/v3/objects/companies/${X}?properties=name`);
    company.set(X, r?.id != null ? String(r.id) : null);
  }
  const alive = [];
  for (const it of items) {
    const vd = out.get(it.id), c = cards.get(it.id), s = cards.get(it.survivor);
    if (!takeCard(vd, c)) continue;
    identity(vd, c, it);
    bornInWindow(vd, c, ACCOUNTS_EVER);
    if (textOf(c, B.companies.idCol) !== it.hubspotId) vd.reasons.push("hubspot-id-changed");
    if (linked(c, ACC_DEAL_REL).length || c.cols[ACC_DEAL_MIRROR]?.display || textOf(c, ACC_DEAL_MIRROR)) vd.reasons.push("deal-link");
    if (!s || s.state !== "active" || textOf(s, B.companies.idCol) !== it.hubspotId) vd.reasons.push("survivor-not-active-or-id-changed");
    // The Worker's view: RAW hit [0], whatever its state. A dead card ahead of the survivor is what the restore
    // (and ensureCardForRecord's unfiltered second search) would adopt or re-register instead of the survivor.
    const raw = search.get(it.hubspotId), hits = raw.filter(live);
    if (raw[0]?.id !== it.survivor || raw[0]?.state !== "active") vd.reasons.push(`survivor-not-first-search-hit:${hitTag(raw[0])}`);
    const known = new Set([it.survivor, ...it.siblings]);
    const strangers = hits.filter(h => !known.has(h.id)).map(h => h.id);
    if (strangers.length) vd.reasons.push(`unknown-card-holds-id:${strangers.join("/")}`);
    if (company.get(it.hubspotId) !== it.hubspotId) vd.reasons.push("hubspot-company-missing-or-merged");
    const survContacts = new Set(linked(s, "account_contact"));
    const lacking = linked(c, "account_contact").filter(x => !survContacts.has(x) && !it.allowedContacts.includes(x));
    if (lacking.length) vd.reasons.push(`contact-link-survivor-lacks:${lacking.join("/")}`);
    vd.facts = { hubspotId: it.hubspotId, survivor: it.survivor, searchHits: raw.map(hitTag) };
    alive.push(it);
  }
  if (!alive.length) return out;
  await personEdits(B.companies.board, alive.map(i => i.id), ACCOUNTS_EVER, out, { requireBirth: true });
  for (const it of alive) {
    const vd = out.get(it.id);
    const t = await readTimeline(it.id), st = await readTimeline(it.survivor, { cache: !APPLY });
    if (!t.complete || !st.complete) { vd.reasons.push("timeline-unreadable"); continue; }
    const person = t.entries.filter(e => e.user !== INTEGRATION);
    if (person.length) vd.reasons.push(`timeline-entry-not-ours:${person.length}`);
    const lost = t.entries.filter(e => e.markers.length ? e.markers.some(m => !st.markers.has(m)) : !st.fps.has(e.fp));
    if (lost.length) vd.reasons.push(`timeline-entries-survivor-lacks:${uniq(lost.flatMap(e => e.markers.length ? e.markers : ["(unmarked)"])).join("/")}`);
  }
  return out;
}

async function checkContacts(items) {
  const out = verdicts(items);
  const merged = items.filter(i => i.kind === "merged-contact"), idless = items.filter(i => i.kind === "idless-contact");
  const cards = await readItems([...items.map(i => i.id), ...merged.map(i => i.survivorCard)], [B.contacts.idCol, "contact_account", "contact_deal"]);
  const alive = [];
  for (const it of items) {
    const vd = out.get(it.id), c = cards.get(it.id);
    if (!takeCard(vd, c)) continue;
    identity(vd, c, it);
    if (linked(c, "contact_deal").length) vd.reasons.push("deal-link");
    if (it.kind === "idless-contact") {
      if (textOf(c, B.contacts.idCol)) vd.reasons.push("has-hubspot-id-now");
      if (linked(c, "contact_account").length) vd.reasons.push("account-link");
    } else {
      if (textOf(c, B.contacts.idCol) !== it.hubspotId) vd.reasons.push("hubspot-id-changed");
      const s = cards.get(it.survivorCard);
      if (!s || s.state !== "active" || textOf(s, B.contacts.idCol) !== it.survivorHsId) vd.reasons.push("survivor-card-not-active-or-id-changed");
    }
    vd.facts.accounts = linked(c, "contact_account");
    alive.push(it);
  }
  // Merged: linked only to id-less Accounts, still merged in HubSpot, and the survivor card the only one found.
  const accts = await readItems(alive.filter(i => i.kind === "merged-contact").flatMap(i => out.get(i.id).facts.accounts), [B.companies.idCol]);
  for (const it of alive.filter(i => i.kind === "merged-contact")) {
    const vd = out.get(it.id);
    const carded = vd.facts.accounts.filter(a => { const x = accts.get(a); return !x || textOf(x, B.companies.idCol); });
    if (carded.length) vd.reasons.push(`linked-to-carded-account:${carded.join("/")}`);
    const r = await hs(`/crm/v3/objects/contacts/${it.hubspotId}?properties=hs_merged_object_ids`);
    if (String(r?.id ?? "") !== it.survivorHsId) vd.reasons.push(`hubspot-no-longer-resolves-to-survivor:${r?.id ?? "404"}`);
    // RAW, in the Worker's order: the restore reaches ensureCardForRecord(survivor record), whose unfiltered
    // search adopts hit [0]. Exactly one card, the survivor card, active -- a lingering dead card holds too.
    const hits = await idSearch(B.contacts.board, B.contacts.idCol, it.survivorHsId);
    if (hits.length !== 1 || hits[0].id !== it.survivorCard || hits[0].state !== "active") vd.reasons.push(`survivor-search:${hits.map(hitTag).join("/") || "none"}`);
    const staleHits = (await idSearch(B.contacts.board, B.contacts.idCol, it.hubspotId)).filter(h => h.id !== it.id);
    if (staleHits.length) vd.reasons.push(`another-card-holds-stale-id:${staleHits.map(hitTag).join("/")}`);
    const t = await readTimeline(it.id), st = await readTimeline(it.survivorCard);
    if (!t.complete || !st.complete) { vd.reasons.push("timeline-unreadable"); continue; }
    const person = t.entries.filter(e => e.user !== INTEGRATION);
    if (person.length) vd.reasons.push(`timeline-entry-not-ours:${person.length}`);
    const lost = t.entries.filter(e => e.markers.length ? e.markers.some(m => !st.markers.has(m)) : !st.fps.has(e.fp));
    if (lost.length) vd.reasons.push(`timeline-entries-survivor-lacks:${uniq(lost.flatMap(e => e.markers.length ? e.markers : ["(unmarked)"])).join("/")}`);
    const missingPre = it.requiredMarkers.filter(m => !st.markers.has(m));
    if (missingPre.length) vd.reasons.push(`pre-step-not-done:${missingPre.join("/")}`);
    vd.facts.survivorCard = it.survivorCard;
  }
  const idlessAlive = alive.filter(i => i.kind === "idless-contact");
  for (const it of idlessAlive) {
    const t = await readTimeline(it.id);
    if (!t.complete) out.get(it.id).reasons.push("timeline-unreadable");
    else if (t.entries.length) out.get(it.id).reasons.push(`has-timeline-entries:${t.entries.length}`);
  }
  // Contacts DO restore on delete, so an id-less contact card is safe only if it was never paired: its whole
  // log, from its birth, must show no write to the ID column (see personEdits). Read from each card's own birth.
  for (const it of idlessAlive) {
    const born = Date.parse(String(cards.get(it.id)?.created_at ?? ""));
    if (!Number.isFinite(born)) { out.get(it.id).reasons.push("created-at-unreadable"); continue; }
    const whole = verdicts([it]);
    await personEdits(B.contacts.board, [it.id], new Date(born - 3_600_000).toISOString(), whole, { idCol: B.contacts.idCol, requireBirth: true });
    // Only the birth and ID-column findings: a person's edit is judged since the plan, below, as the plan asks.
    out.get(it.id).reasons.push(...whole.get(it.id).reasons.filter(r => !r.startsWith("person-edit:")));
  }
  if (alive.length) await personEdits(B.contacts.board, alive.map(i => i.id), report.baselines.contacts, out);
  return out;
}

async function checkDeals(items) {
  const out = verdicts(items);
  const since = report.baselines.deals;
  const cards = await readItems(items.map(i => i.id), [B.deals.idCol, "deal_contact", DEAL_COMPANY_REL, DEAL_LINE_ITEM_REL]);
  const alive = [];
  for (const it of items) {
    const vd = out.get(it.id), c = cards.get(it.id);
    if (!takeCard(vd, c)) continue;
    identity(vd, c, it, since);
    if (textOf(c, B.deals.idCol)) vd.reasons.push("has-hubspot-id-now");
    if (linked(c, DEAL_LINE_ITEM_REL).length) vd.reasons.push("line-item-link");
    vd.facts.contacts = linked(c, "deal_contact"); vd.facts.companies = linked(c, DEAL_COMPANY_REL);
    alive.push(it);
  }
  const lc = await readItems(alive.flatMap(i => out.get(i.id).facts.contacts), [B.contacts.idCol]);
  const la = await readItems(alive.flatMap(i => out.get(i.id).facts.companies), [B.companies.idCol]);
  for (const it of alive) {
    const vd = out.get(it.id);
    const carded = [...vd.facts.contacts.filter(x => !lc.get(x) || textOf(lc.get(x), B.contacts.idCol)),
      ...vd.facts.companies.filter(x => !la.get(x) || textOf(la.get(x), B.companies.idCol))];
    if (carded.length) vd.reasons.push(`linked-to-carded-record:${carded.join("/")}`);
    const t = await readTimeline(it.id);
    if (!t.complete) { vd.reasons.push("timeline-unreadable"); continue; }
    const recent = t.entries.filter(e => e.user !== INTEGRATION && atOrAfter(e.created_at, since));
    if (recent.length) vd.reasons.push(`timeline-activity-since-plan:${recent.length}`);
  }
  if (alive.length) await personEdits(B.deals.board, alive.map(i => i.id), since, out);
  return out;
}

async function checkCardCreates(items) {
  const out = verdicts(items);
  const props = await hsContacts(items.map(i => i.id), ["sync_owner", "createdate"]);
  for (const it of items) {
    const vd = out.get(it.id);
    const p = props.get(it.id);
    if (!p) { vd.reasons.push("not-in-hubspot-under-this-id"); continue; }
    const owner = String(p.sync_owner ?? "").trim();
    if (["wm", "hold"].includes(owner)) vd.reasons.push(`sync_owner:${owner}`);
    const raw = await idSearch(B.contacts.board, B.contacts.idCol, it.id), hits = raw.filter(live);
    if (hits.length) { vd.gone = "carded"; vd.facts.cards = hits.map(h => h.id); }
    // A dead card still in the index is what /resync's search would adopt instead of creating one.
    else if (raw.length) vd.reasons.push(`dead-card-still-indexed:${raw.map(hitTag).join("/")}`);
  }
  return out;
}
/**
 * --release: THE ONE PLACE A RELEASE WAIVES A REASON. Every read of an id-less Account goes through CHECK below --
 * the batched first read and the --apply second read alike -- so both are waived by this same function, each from
 * its own facts. Only a card carrying item.release is touched, only its reasons change, and what was dropped is
 * kept beside them (vd.waived) for the report. A gone card stays gone: vd.gone is never read or written here.
 */
function waiveReleased(items, out) {
  for (const it of items) {
    if (!it.release) continue;
    const vd = out.get(it.id);
    const { remaining, waived } = releaseWaiver(it.release, vd.reasons, vd.facts);
    vd.reasons = remaining; vd.waived = waived;
  }
  return out;
}
const CHECK = { "accounts-idless": async items => waiveReleased(items, await checkIdlessAccounts(items)),
  "accounts-dups": checkDupExtras, contacts: checkContacts, deals: checkDeals, "contacts-card": checkCardCreates };

// ------------------------------------------------------------------ acting (--apply only)
let halted = null, stopRequested = false, acted = 0;
const halt = why => { halted ??= why; console.error(`HALT: ${why}`); };
const assocBefore = new Map();                             // survivor record -> association counts before its first delete
async function assocCounts(it) {
  if (it.kind === "dup-extra") return {
    contacts: await hsAssocCount("companies", it.hubspotId, "contacts"), deals: await hsAssocCount("companies", it.hubspotId, "deals") };
  if (it.kind === "merged-contact") return {
    companies: await hsAssocCount("contacts", it.survivorHsId, "companies"), deals: await hsAssocCount("contacts", it.survivorHsId, "deals") };
  return null;
}
const recordKey = it => it.kind === "dup-extra" ? `companies:${it.hubspotId}` : `contacts:${it.survivorHsId}`;

async function deleteCard(it) {
  if (!DELETABLE.has(it.id) || PROTECTED.has(it.id))
    throw Object.assign(new Error(`refusing to delete ${it.id}: not a plan candidate, or protected`), { abort: true });
  const rec = { id: it.id, board: it.board, group: it.group, kind: it.kind, name: it.name, hubspotId: it.hubspotId ?? null };
  report.deleting.push({ ...rec, sentAt: new Date().toISOString() }); save();
  journal({ phase: "sending", ...rec });
  let answered = null, error = null;
  try { answered = (await monday(DELETE_ITEM, { i: it.id }))?.delete_item?.id ?? null; }
  catch (e) { if (e.abort) throw e; error = String(e.message ?? e).slice(0, 200); }
  // What monday says now, whatever the answer was: a lost answer to a delete that landed still reads deleted.
  let state = null;
  for (let t = 0; t < 4; t++) {
    state = (await readStates([it.id])).get(it.id) ?? "not-returned";
    if (state === "deleted") break;
    await sleep(1500 * (t + 1));
  }
  if (state === "deleted") {
    report.deleted.push({ ...rec, at: new Date().toISOString() }); report.restoreList.push(it.id);
    journal({ phase: "deleted", ...rec }); save();
    return true;
  }
  report.failed.push({ ...rec, answered: answered != null, error, state }); journal({ phase: "failed", ...rec, state }); save();
  halt(`delete of ${it.id} ${answered != null ? "was answered" : "failed"} but the card reads ${state}`);
  return false;
}

/** After an ID-bearing delete: the restore has run by now. No card may appear that the plan does not know. */
async function afterIdDelete(it) {
  await sleep(SETTLE_MS);
  const notes = [];
  // Live hits say who holds the id now; the RAW list says whether the dead card has left monday's index yet
  // (filtered to active it never could be seen, and the wait below would end at once).
  for (let t = 0; t < 4; t++) {
    if (it.kind === "dup-extra") {
      const raw = await idSearch(B.companies.board, B.companies.idCol, it.hubspotId), hits = raw.filter(live);
      const known = new Set([it.survivor, ...it.siblings]);
      const strangers = hits.filter(h => !known.has(h.id));
      if (strangers.length) { halt(`card(s) ${strangers.map(h => h.id).join(",")} appeared for company ${it.hubspotId} after deleting ${it.id} -- a restore created one; stop and look`); return false; }
      if (!hits.some(h => h.id === it.survivor)) { halt(`survivor ${it.survivor} left the ID search for company ${it.hubspotId}`); return false; }
      if (raw[0]?.id !== it.survivor) { halt(`survivor ${it.survivor} is no longer the first ID-search hit for company ${it.hubspotId} (${hitTag(raw[0])}) after deleting ${it.id}`); return false; }
      if (!raw.some(h => h.id === it.id)) break;
    } else {
      const survRaw = await idSearch(B.contacts.board, B.contacts.idCol, it.survivorHsId), surv = survRaw.filter(live);
      const staleRaw = await idSearch(B.contacts.board, B.contacts.idCol, it.hubspotId), staleLive = staleRaw.filter(live);
      if (surv.some(h => h.id !== it.survivorCard) || staleLive.some(h => h.id !== it.id)) {
        halt(`a card appeared for contact ${it.survivorHsId}/${it.hubspotId} after deleting ${it.id} -- a restore created one; stop and look`); return false;
      }
      if (!surv.some(h => h.id === it.survivorCard)) { halt(`survivor card ${it.survivorCard} left the ID search for ${it.survivorHsId}`); return false; }
      if (!staleRaw.some(h => h.id === it.id)) break;
    }
    if (t === 3) notes.push("the deleted card was still in the ID search ~50 s later (monday's index lag)");
    else await sleep(10_000);
  }
  const before = assocBefore.get(recordKey(it)), after = await assocCounts(it);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    halt(`HubSpot associations of ${recordKey(it)} changed across the delete of ${it.id}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`); return false;
  }
  if (notes.length) report.warnings.push({ id: it.id, notes });
  return true;
}

/**
 * --release: AFTER DELETING A RELEASED CARD WHOSE READ WAIVED timeline-entry-not-ours. The waiver assumed that the
 * contact's copy of each person's entry outlives the Account. But monday LINKS the copies of one activity, deleting
 * copies has removed entries on cards no delete was sent to (src/activity-sync.ts, dedupe-timeline.mjs), and whether
 * trashing a whole card takes its linked copies along was never measured. So: wait --settle seconds, read the contact
 * cards the waiver relied on again (uncached), and HALT unless every one was read whole and every waived entry still
 * has a twin there. The evidence is the SECOND read's -- the read that allowed this very delete. A person's note is
 * not a Worker entry that restore-timeline-entries.mjs can rebuild from HubSpot, so a loss stops the run at once.
 * Returns mirrorSurvived's { ok, lost, unreadable } (ids only).
 */
async function afterReleasedDelete(it, vd) {
  const ev = vd?.mirrorEvidence;
  if (!ev?.entries?.length || !ev?.contacts?.length) {
    halt(`released card ${it.id} was deleted on a timeline waiver, but the read that allowed it kept no mirror evidence -- stop and look`);
    return { ok: false, lost: [], unreadable: [] };
  }
  await sleep(SETTLE_MS);
  const after = new Map();
  let v, readError = null;
  try {
    for (const cid of ev.contacts) after.set(cid, await readTimeline(cid));     // uncached: this read is the proof
    v = mirrorSurvived(ev.entries, after);
  } catch (e) {
    if (e.abort) throw e;
    readError = String(e?.message ?? e).slice(0, 120);
    v = { ok: false, lost: [], unreadable: ev.contacts.map(String) };
  }
  journal({ phase: "mirror-check", id: it.id, ok: v.ok, contacts: ev.contacts, entries: ev.entries.length, lost: v.lost, unreadable: v.unreadable,
    ...(readError ? { readError } : {}) });
  if (!v.ok) {
    const where = `contact card(s) ${ev.contacts.join(",")}`;
    const why = v.lost.length
      ? `${v.lost.length} of its ${ev.entries.length} waived timeline entries no longer have a twin on ${where} -- monday may take a trashed card's linked timeline copies with it`
      : `${readError ? `${where} could not be read again (${readError})` : `contact timeline(s) ${v.unreadable.join(",") || "?"} could not be read whole`}, so the twins cannot be confirmed`;
    halt(`after deleting released card ${it.id} (${it.release}): ${why}. Stop: open ${where} in monday, and if the person's entries are gone restore ${it.id} from the Trash`);
  }
  return v;
}

async function createCard(it) {
  report.creating.push({ hubspotId: it.id, sentAt: new Date().toISOString() }); save();
  let r;
  try {
    r = await fetch(`${WORKER}/resync`, { method: "POST", headers: { "Content-Type": "application/json", "x-trigger-secret": T },
      body: JSON.stringify({ object: "contacts", ids: [it.id] }), signal: AbortSignal.timeout(280_000) });
  } catch (e) { return { outcome: "request-failed", why: String(e?.message ?? e).slice(0, 80) }; }
  if ([400, 401, 403, 404, 409].includes(r.status)) { halt(`/resync answered ${r.status} -- the same for every id`); return { outcome: `http-${r.status}` }; }
  if (!r.ok) return { outcome: `http-${r.status}` };
  const j = await r.json().catch(() => ({}));
  if (j.dryRun !== false) { halt("the Worker did not run /resync as a write -- stopping"); return { outcome: "not-a-write" }; }
  const answer = String(j.results?.[it.id] ?? "");
  const word = /\baction=(\S+)/.exec(answer)?.[1] ?? answer.split(/[:\s]/)[0];   // only the word is kept: no names, no emails
  for (let t = 0; t < 5; t++) {
    await sleep(4000 * (t + 1));
    const hits = (await idSearch(B.contacts.board, B.contacts.idCol, it.id)).filter(live);
    if (hits.length > 1) { halt(`HubSpot contact ${it.id} now has ${hits.length} cards: ${hits.map(h => h.id).join(",")}`); return { outcome: "duplicate", worker: word }; }
    if (hits.length === 1) { report.created.push({ hubspotId: it.id, card: hits[0].id, worker: word, at: new Date().toISOString() }); save(); return { outcome: "created", worker: word, card: hits[0].id }; }
  }
  return { outcome: "not-carded-yet", worker: word };
}

// ------------------------------------------------------------------ pre-flight, lock
if (APPLY) {
  try {
    await requireNewBuild(WORKER);
    await requireIntegrationToken(M);
  } catch (e) { console.error(`refusing --apply: ${e.message}`); process.exit(1); }
  console.log("pre-flight: the new CRM build is live and the monday token is the integration user");
  report.integrationToken = true;
} else {
  try { report.integrationToken = String((await monday("query { me { id } }")).me?.id ?? "") === INTEGRATION; }
  catch { report.integrationToken = null; }
  if (report.integrationToken === false) console.log(`note: MONDAY_API_TOKEN is not the integration user ${INTEGRATION}; --apply would refuse`);
}
const LOCK = join(ROLLOUT, ".cleanup-extra-cards.lock");
if (APPLY) {
  let user; try { user = userInfo().username; } catch { /* pid and host still say who */ }
  const mine = { pid: process.pid, host: hostname(), user, since: startedAt, args: argv };
  try { mkdirSync(ROLLOUT, { recursive: true }); const fd = openSync(LOCK, "wx"); writeSync(fd, JSON.stringify(mine)); closeSync(fd); }
  catch (e) {
    let who = "unreadable"; try { const h = JSON.parse(readFileSync(LOCK, "utf8")); who = `pid ${h.pid} on ${h.host}${h.user ? `, user ${h.user}` : ""}, since ${h.since}`; } catch { /* still refuse */ }
    console.error(e?.code === "EEXIST" ? `refusing to run: another cleanup run holds ${LOCK} (${who}). If it is no longer running, look at its report, then delete the lock.`
      : `refusing to run: cannot take ${LOCK}: ${String(e?.message ?? e).slice(0, 120)}`);
    process.exit(1);
  }
  process.on("exit", () => {
    try { const h = JSON.parse(readFileSync(LOCK, "utf8")); if (h?.pid === mine.pid && h?.host === mine.host && h?.since === mine.since) unlinkSync(LOCK); }
    catch { /* gone, or not provably ours: it stays */ }
  });
} else if (existsSync(LOCK)) console.log(`note: a writing run holds ${LOCK} -- this plan may not reflect what it is deleting right now`);
process.on("SIGINT", () => {
  if (stopRequested) { console.error("second Ctrl-C: quitting now"); try { report.stoppedBecause = "interrupted twice"; save(); } catch { /* exit anyway */ } process.exit(130); }
  stopRequested = true; console.error("Ctrl-C: stopping after the current item (again to quit now)");
});

// ------------------------------------------------------------------ the run
console.log(`${APPLY ? (CANARY ? "APPLY --canary (one item)" : "APPLY") : "DRY RUN (reads only)"}  groups ${GROUPS.join(",")}`
  + `${Number.isFinite(LIMIT) ? `  limit ${LIMIT}` : ""}\nplans: ${PLAN_DIR}\nreport: ${OUT}`);
if (RELEASE) {
  // One line, ids and counts only: decidedBy is the user's own text, so anything shaped like an email is masked.
  const by = String(RELEASE.decidedBy).replace(/\s+/g, " ").replace(/[^\s@]+@[^\s@]+/g, "<email>").slice(0, 60);
  console.log(`release: ${RELEASE.cards.length} cards (${RELEASE_BUCKETS.map(b => `${b} ${RELEASE.counts[b]}`).join(", ")}), decided by ${by}`
    + ` at ${RELEASE.decidedAt}; ${RELEASED_HELD.size} leave the plan's hold, ${report.release.taggedL} plan candidates tagged L;`
    + ` ${RELEASE_FILE} sha256 ${report.planFiles.release.sha256.slice(0, 16)}`);
}
for (const g of GROUPS) {
  const byReason = {};
  for (const h of plan[g].held) { const k = h.planReason.split(":")[0]; byReason[k] = (byReason[k] ?? 0) + 1; }
  const freed = g === "accounts-idless" && RELEASED_HELD.size ? ` (${RELEASED_HELD.size} of them released from the plan's hold)` : "";
  console.log(`  ${g}: ${plan[g].candidates.length} safe by plan${freed}, ${plan[g].held.length} held by plan ${JSON.stringify(byReason)}`);
}
for (const g of GROUPS) for (const h of plan[g].held) record(h, "held-by-plan", { reasons: [h.planReason] });

const CHUNK = { "accounts-idless": 25, "accounts-dups": 25, contacts: 10, deals: 10, "contacts-card": 20 };
try {
  outer: for (const g of GROUPS) {
    const list = plan[g].candidates;
    const blocked = new Set();                             // dups companies whose deletes stopped part-way
    for (let i = 0; i < list.length; i += CHUNK[g]) {
      if (halted || stopRequested || acted >= LIMIT) break outer;
      const chunk = list.slice(i, i + CHUNK[g]);
      const first = await CHECK[g](chunk);
      for (const it of chunk) {
        if (halted || stopRequested || acted >= LIMIT) break outer;
        const vd = first.get(it.id);
        if (vd.gone) { record(it, it.kind === "card-create" ? "already-carded" : "already-gone", { state: vd.gone, facts: vd.facts, ...released(it, vd) }); continue; }
        if (vd.reasons.length) {
          record(it, "held-by-recheck", { reasons: vd.reasons, ...released(it, vd) });
          console.log(`  held ${g} ${it.id} ${it.name}: ${vd.reasons.join(", ")}${releasedTag(it, vd)}`);
          continue;
        }
        if (it.kind === "dup-extra" && blocked.has(it.hubspotId)) { record(it, "held-by-recheck", { reasons: ["company-blocked-earlier-in-run"] }); continue; }
        if (!APPLY) {
          record(it, it.kind === "card-create" ? "would-create" : "would-delete", { facts: vd.facts, ...released(it, vd) });
          if (it.release) console.log(`  would delete ${g} ${it.id} ${it.name}${releasedTag(it, vd)}`);
          acted++;
          if (CANARY) {
            console.log(`\ncanary (dry run): the first eligible item is ${g} ${it.kind} ${it.id} "${it.name}"`
              + `${it.hubspotId ? ` (HubSpot ${it.hubspotId})` : ""}; --apply --canary would ${it.kind === "card-create" ? "card it" : "delete it"}, run the post-checks, and stop`);
            if (RELEASE) console.log(canaryReleaseNote(it, vd));
            report.stoppedBecause = "canary (dry run)";
            break outer;
          }
          continue;
        }
        // --apply: the SECOND read, alone and immediately before acting. Both must pass.
        const second = (await CHECK[g]([it])).get(it.id);
        if (second.gone || second.reasons.length) {
          record(it, "changed-since-first-read", { state: second.gone ?? undefined, reasons: second.reasons, ...released(it, second, vd) });
          console.log(`  changed ${g} ${it.id}: ${second.gone ?? second.reasons.join(", ")}${releasedTag(it, second)}`);
          continue;
        }
        if (it.kind === "card-create") {
          const res = await createCard(it);
          acted++;
          record(it, res.outcome, { worker: res.worker, card: res.card });
          console.log(`  ${res.outcome} contact ${it.id} ${it.name}${res.card ? ` -> card ${res.card}` : ""}`);
        } else {
          const idBearing = it.kind === "dup-extra" || it.kind === "merged-contact";
          // --release: a delete the second read allowed by waiving a person's timeline entries leans on their twins
          // on the contact cards, so it is checked after the delete as an ID-bearing one is (afterReleasedDelete).
          const mirrorBearing = !!it.release && waivesTimeline(second.waived);
          if (idBearing && !assocBefore.has(recordKey(it))) assocBefore.set(recordKey(it), await assocCounts(it));
          const ok = await deleteCard(it);
          acted++;
          let post = ok, mirror = null;
          if (ok && idBearing) post = await afterIdDelete(it);
          if (ok && mirrorBearing) post = (mirror = await afterReleasedDelete(it, second)).ok;
          const checked = idBearing || mirrorBearing;
          record(it, ok ? "deleted" : "delete-failed", { postChecks: checked ? (post ? "ok" : "failed") : "n/a", ...released(it, second, vd),
            ...(mirror ? { mirrorAfterDelete: mirror } : {}) });
          console.log(`  ${ok ? "deleted" : "FAILED"} ${g} ${it.id} ${it.name}${checked ? ` (post-checks ${post ? "ok" : "FAILED"})` : ""}${releasedTag(it, second)}`);
          if (!post && it.kind === "dup-extra") blocked.add(it.hubspotId);
          const warned = report.warnings.find(w => w.id === it.id);
          if (warned && it.kind === "dup-extra") blocked.add(it.hubspotId);
        }
        if (CANARY) {
          const last = report.items[report.items.length - 1];
          console.log(`\ncanary: ${last.outcome} ${g} ${it.kind} ${it.id} "${it.name}"`
            + `${it.hubspotId ? ` (HubSpot ${it.hubspotId})` : ""}${last.postChecks ? `, post-checks ${last.postChecks}` : ""}`
            + ` -- open it in monday (Trash) and the board, then run without --canary`);
          if (RELEASE) console.log(canaryReleaseNote(it, second, last));
          report.stoppedBecause = "canary";
          break outer;
        }
        if (PAUSE_MS) await sleep(PAUSE_MS);
      }
    }
  }
  if (!halted && !report.stoppedBecause) report.stoppedBecause = stopRequested ? "interrupted" : acted >= LIMIT ? `limit ${LIMIT}` : "done";
} catch (e) {
  halt(`error: ${String(e?.message ?? e).slice(0, 240)}`);
} finally {
  if (halted) report.halted = halted;
  report.finishedAt = new Date().toISOString();
  save();
  console.log("\nper group:");
  for (const g of GROUPS) console.log(`  ${g}: ${JSON.stringify(report.tally[g] ?? {})}${report.holdReasons[g] ? `  reasons ${JSON.stringify(report.holdReasons[g])}` : ""}`
    + `${report.waivedReasons[g] ? `  waived by the release ${JSON.stringify(report.waivedReasons[g])}` : ""}`);
  console.log(`${APPLY ? `deleted ${report.deleted.length}, created ${report.created.length}, failed ${report.failed.length}` : "(dry run -- nothing was written; add --apply to act)"}`
    + `  stopped: ${halted ? `HALT ${halted}` : report.stoppedBecause}\nreport: ${OUT}`);
  if (halted) process.exit(1);
}
