/**
 * REMOVE DUPLICATE HUBSPOT ACTIVITY ENTRIES FROM MONDAY TIMELINES. Dry run unless --apply.
 *
 * Every entry the sync writes carries one marker, `[hubspot:<object>:<id>]`. A card should hold each
 * marker at most once. It often holds two: until the 2026-09-23 build, the first delivery ran in the
 * webhook's waitUntil, which Cloudflare cancels ~30 s after the response, and a cancellation between a
 * create and its settle made the next pass write the entry again (136 of 160 deliveries measured since
 * the 2026-09-22 deploy). The historical import has its own share. This removes the extras.
 *
 * WHAT COUNTS AS ONE OF OURS. Nothing else on a card is ever a candidate, whatever it contains:
 *   - an entry of type "custom" whose custom_activity_id is OUR type for the marker's object --
 *     MONDAY_ACTIVITY_TYPE in src/activities.ts (HubSpot Email / Note / Call / Meeting / Task), copied
 *     below and checked against that file at start. A rep's own note, email or call is a native type
 *     with no custom_activity_id, so it can never qualify;
 *   - whose content carries exactly one `[hubspot:<object>:<id>]` marker (the last line timelinePayload
 *     and backfill-activities.mjs write), for an object named in --types. --types scopes the MARKERS as
 *     well as the cards: a notes-only canary touches [hubspot:notes:*] and nothing else (the 2026-09-23
 *     "notes" smoke plan would also have deleted 58 task and 16 email copies);
 *   - that belongs to THIS card. Every entry is read with its item { id }, and one naming another item
 *     is ignored and counted. timeline(id) was checked to return only the item's own entries (4 cards,
 *     2026-09-24), so this is defence in depth, not a known problem.
 *
 * WHAT IS DELETED. The copies of one marker on one card are split into classes by a fingerprint of all
 * a rep can see -- {type, custom_activity_id, title, content, created_at}. The timeline id is left out
 * because it is expected to differ (the fingerprint of plan-email-cleanup.mjs). Then:
 *   - IDENTICAL. Within a class one copy is kept and the rest are deleted. They are byte-identical, date
 *     included, so which one survives cannot matter; the lowest id is kept, so a re-run keeps the same
 *     one. (The old rule compared title + content only, so a copy dated differently could be "identical"
 *     and the survivor was whichever random UUID sorted first.)
 *   - BODYLESS BESIDE A BODY -- the DEDUPE_ONLY rule of the earlier email plan. When a class has a body
 *     (its content minus the header lines From/To/Direction/HubSpot owner/Sequence and the marker line,
 *     bodyOf in plan-email-cleanup.mjs), a class with NO body is deleted too, but only when it has the
 *     same title and created_at as that body class AND every line it shows is also on it -- so nothing
 *     a rep could see goes away. A task's Status/Due/Completed lines count as body here, on purpose:
 *     they are what a task copy says, so two task copies that differ there are divergent, never dropped.
 *   - ANY OTHER DIFFERENCE IS DIVERGENT: every class keeps its copy, and the marker is listed in the
 *     report under its card for a person to look at. (The old rule compared every copy to the lowest id
 *     only, so a bodyless copy with the lowest id hid two identical body copies behind it.)
 *   - THE LAST COPY OF A MARKER IS NEVER DELETED, whatever the rules above say. A plan that would is
 *     dropped for that marker and counted as guardTripped, because it could only mean a bug here.
 * HubSpot is never touched. monday's timeline API has no undo, so the dry run writes the full plan
 * (card, marker, kept ids, deleted ids and why) for review first.
 *
 * IN --apply, EACH CARD IS READ TWICE. The plan comes from the first read. Immediately before deleting,
 * the card's timeline is read again in full and the plan recomputed, and only ids in BOTH plans -- still
 * present, still qualifying -- are deleted. A re-read that fails or cannot walk to the end deletes
 * nothing (fail closed) and the card is saved for --retry. A first read that is incomplete is treated
 * the same way: no deletion is decided from a partial timeline.
 *
 * THE KEEPER IS CHECKED BY ID -- BEFORE, DURING, AFTER AND LATER (added 2026-09-27). A census of 21,701 (card,
 * marker) pairs these deletes touched found 373 whose KEPT copy no longer exists either, so that activity had no
 * copy left on the card. The census found them hours after the deletes, and the mechanism on monday's side is not
 * known. Two reads agreeing proves nothing about a keeper: monday keeps listing a deleted entry for hours (a
 * "ghost": deleting one answers NOT_FOUND), so both reads can keep a ghost and delete the real copy. So in --apply
 * (the canary included), after the re-read, timeline_item(id) is asked:
 *   - BEFORE the deletes. Each class of a marker that keeps a copy has its keeper resolved. A ghost keeper is
 *     replaced by the lowest id of its class that does resolve, which is then kept, not deleted; only the
 *     others both reads saw go. A class none of whose copies resolves is not deleted from (there is nothing real
 *     to delete), a bodyless class goes only when a body class covering it has a real keeper, and a check that
 *     cannot tell (asked 3 times) deletes nothing it guards: keeper-unconfirmed when no class has a real keeper,
 *     partly unconfirmed (outcome keeper-ok-partial afterwards) when another class does; the card goes on the
 *     --retry list. When no kept copy of the marker resolves, nothing of that group is deleted: keeper-missing,
 *     handed off -- unless a bodyless copy still resolves, which is body-missing (only the body is gone; restore
 *     would skip that pair, since a copy is there, so it is counted and not handed off).
 *   - AFTER EVERY BATCH of DELETE_PARALLEL deletes, the keepers of the groups in that batch, and after the card
 *     every keeper of every group that had a delete sent. One that no longer resolves makes the group keeper-lost
 *     (printed at once). --max-lost is tested after each of those checks, before the next batch goes out, so the
 *     run overshoots it by at most about DELETE_PARALLEL x --concurrency keepers, however big a card is.
 *   - LATER. A keeper monday removes a little after the delete still reads keeper-ok at once. So every card is
 *     checked again --late-check seconds (default 45) after its last delete, while the run carries on with other
 *     cards, and at the end the run waits until --final-check seconds (default 300) after its last delete and
 *     checks every keeper it relied on once more. A loss found then is keeper-lost-late: handed off, and counted
 *     toward --max-lost like any other. A group still unknown at the final check is keeper-unverified: handed off
 *     as state "unknown" and listed under toVerify. A group whose keepers all resolved at least 5 minutes
 *     (SETTLED_MS) after its card's last delete is `settled` (a lost one is settled once handed off). Every other
 *     group this run sent a delete for is checked again at the start of the next run (below).
 *   - THE LOOKUP ITSELF. Everything above rests on timeline_item answering NOT_FOUND for an entry that is deleted
 *     but still listed; the live check behind that was on an id deleted long before. So every id
 *     delete_timeline_item answers OK for is looked up at once (and again for up to ~9 s): it must be absent. One
 *     that still resolves HALTS the run ("timeline_item is not authoritative") and hands that card's groups off
 *     as "unknown" for a person to look at. Until one delete has proved it, the run sends ONE delete at a time,
 *     on one card at a time, and the canary prints the result, so the one-delete canary proves it first.
 *   - HAND-OFF. Every keeper-lost(-late), keeper-missing, keeper-unverified and not-authoritative group is written
 *     as it happens to docs/rollout/<date>-timeline-dedupe-lost-<HHMMSS>.json, an array of census rows { card,
 *     kind, marker, state: "LOST" (or "unknown": could not tell), knownIds: every id seen for that marker on that
 *     card, ... }: the --census input of restore-timeline-entries.mjs, as it is (it takes the LOST rows and counts
 *     the unknown ones). That script checks every known id and the listing again before it writes, so a pair that
 *     still has a copy somewhere is skipped there. Each row is also appended to a .jsonl beside it, the durable
 *     record the .json can be rebuilt from.
 * EVERY DELETE IS RECORDED BEFORE IT IS SENT: its id goes into the card's entry.deleting (and entry.lastSentAt)
 * and the report is saved, then the request goes out. entry.deleted / failed / alreadyGone say how each one ended,
 * so an id in deleting and in none of those was sent by a run killed before the answer.
 *
 * EARLIER RUNS' DELETES ARE CHECKED AT START, dry run included. Every group of an earlier applied report written
 * with this intent log (intentLog) that had a delete sent -- answered or not, so a run killed mid-card is covered,
 * and a Ctrl-C'd or aborted one -- and is not settled, in that report or in a *-timeline-dedupe-verify*.json, has
 * its keepers (keepers, else keep) resolved again. Absent: handed off as keeper-lost-late; still unknown: handed
 * off as "unknown". The results go to a <date>-timeline-dedupe-verify-start-<HHMMSS>.json, and --apply refuses
 * once when more than --max-lost of those groups are lost. Skipped in a dry run while a writing run holds the lock.
 * Reports from before the intent log are the damage census's; --verify checks one of those by hand.
 *
 * --verify <applied report>. Read only, nothing deleted: resolves again every keeper of every group that report
 * sent a delete for (keepers, or keep in an older report, where keep can name a ghost -- restore checks the
 * listing before it writes), hands off the ones absent or unknown, and writes
 * docs/rollout/<date>-timeline-dedupe-verify[-HHMMSS].json. Run it hours after a run, and again later if needed.
 * It exits 3 when a keeper is lost, 0 otherwise.
 *
 * CARDS AN EARLIER RUN ALREADY CLEANED ARE SKIPPED, unless --include-cleaned: a card an earlier
 * *-timeline-dedupe-[retry-][canary-]applied*.json report shows a delete SENT for (deleting, deleted, alreadyGone
 * or failed). A report written before the intent log cannot show a delete that went out and was never answered,
 * so in one of those any entry counts. A card that was only planned -- the run stopped before its deletes,
 * keeper-missing, divergent only -- stays fresh, so a --from resume covers it. --retry skips cleaned cards too, so
 * re-checking a card whose deletes failed or stopped part-way takes --retry <report> --include-cleaned. Going
 * over a card again is where the losses were: 12% of the pairs two runs saw, 26% of those the --retry run
 * re-checked, 0.7% on fresh cards. They are counted (skippedCleaned). A report that cannot be parsed refuses
 * --apply, since its cards would be taken for fresh ones.
 *
 * ONE WRITING RUN AT A TIME. --apply and --canary take docs/rollout/.timeline-dedupe.lock, and refuse while
 * another run holds it (saying which pid, host, user and since when, and, on this host, whether that pid still
 * runs). On exit it is removed only if it is still this run's (same pid, host and since): a lock deleted by hand
 * and re-taken by a second run is that run's. The first Ctrl-C stops the run like any stop (no new delete is
 * sent, the deletes in flight are answered and checked, the delayed checks run at once -- early, so they settle
 * nothing and the next run checks those groups again -- and the report is saved); a second quits at once and
 * says what was left unchecked.
 *
 * FAILURES ARE KEPT BY CARD ID. erroredCards, incompleteCards (one row per card) and the cards whose deletes
 * failed are saved in the report, and --retry <report.json> re-checks exactly those cards (no HubSpot
 * enumeration) under the same rules. A row with no kind (an old report) has its kind read from the card's board;
 * a card whose board cannot be read has nothing deleted, since a loss there could not be handed off. monday calls
 * are retried only when a second try can succeed -- rate limit, complexity budget, network, 5xx. A GraphQL
 * validation or resolver error fails at once, because the same document gets the same answer (the old helper
 * slept ~63 s per failing delete to learn that); a 401/403 or a spent daily limit stops the run.
 *
 * --canary. With --apply, deletes at most ONE entry in the whole run, then stops and prints the card, the
 * kept id(s), the deleted id, what timeline_item says of the deleted id, and the keeper checks right after and
 * --final-check seconds later, so a person can open the card in monday and see the result -- delete_timeline_item
 * had never run anywhere before this script. Without --apply it stops at the first card with something to delete
 * and prints what the canary would do.
 *
 * WHICH CARDS: every card that is a destination of a HubSpot activity of the chosen types -- found from
 * HubSpot's own associations (list API, so no 10,000 search ceiling), then matched to cards by HubSpot
 * ID, in a fixed sorted order. The historical import covered all history, so the default scope is all
 * history. A card holding duplicates whose association has since been removed in HubSpot is not found.
 *
 * THE SINGLE-DESTINATION RULE (added 2026-09-30; --apply refuses without --single-destination). Copies of one
 * activity on different cards are LINKED on monday's side: monday copies an entry made on a Contact card onto the
 * Accounts/Deals linked to it at that moment, the Worker writes it on every associated card as well, and a
 * delete_timeline_item on one copy can remove copies on OTHER cards -- which ones cannot be predicted. Measured on
 * the applied runs: a marker deleted on ONE card lost nothing (0 of 16,601 pairs); deleted on 2-5+ cards, 3.6-22%
 * of pairs lost entries on cards no delete was sent to (the 2026-09-26 run on five company cards: seven linked
 * contact cards are short >= 76 activities). So, per group (the copies of one marker on one card):
 *   - its activity's OWN current HubSpot destinations are kept from step 1 (marker -> contacts / companies / deals;
 *     --retry reads them per marker), and each record's cards from step 2;
 *   - it may be deleted from ONLY when that activity has exactly one destination record across all three boards,
 *     that record has exactly one card, and the group is on that card. A record whose card is not found still
 *     counts (an idless card is invisible to the id lookup, and monday may have copied the entry onto it);
 *   - a card that is not a current destination of the activity is never deleted from (a stale copy);
 *   - a marker any earlier *timeline-dedupe*applied*.json report, a *-timeline-*census*.json (the 2026-09-28 damage
 *     census) or a *-timeline-dedupe-lost-*.json hand-off shows on another card is held;
 *   - marketing entries stay excluded, as before.
 * Held groups are listed on their card as heldBySingleDestination, with the reason, and never reach the re-read, the
 * keeper checks or the deletes. A dry run without the flag plans with the old rule and prints how many groups the
 * new one would allow and hold (plan.singleDestination; every group carries its verdict as singleDestination).
 *
 * RUN AFTER THE NEW WORKER IS DEPLOYED, or the old build keeps writing new duplicates behind it. --apply
 * refuses unless it is live (lib/repair-preflight.mjs requireNewBuild), and unless MONDAY_API_TOKEN is the
 * integration user the Worker writes as (requireIntegrationToken).
 *
 *   node scripts/dedupe-timeline.mjs [--single-destination]            # dry run over everything
 *   node scripts/dedupe-timeline.mjs --types notes --apply --single-destination --canary   # delete ONE, then look
 *   node scripts/dedupe-timeline.mjs --apply --single-destination      # delete the extras the rule allows
 *   node scripts/dedupe-timeline.mjs --retry <report.json> [--apply --single-destination]  # finish those cards
 *   node scripts/dedupe-timeline.mjs --verify <applied report.json>    # re-check its keepers by id, hours later
 *   options: --types emails,calls   (default emails,calls,notes,meetings,tasks; scopes cards AND markers)
 *            --boards contacts,companies,deals      --limit-cards N (with --verify: its first N cards)
 *            --from <kind:card>  resume at that card (the report's nextKey; by key, so cards dropping out
 *                                between runs cannot shift the list)      --start N  the same by position
 *            --concurrency N (default 2, max 16; 1 with --canary). Deletes within a card run 5 at a time.
 *            --max-lost N  stop deleting once more than N groups are keeper-lost (default 5; 0 = at the first)
 *            --late-check S  re-check each card's keepers S seconds after its last delete (default 45)
 *            --final-check S  the last check, S seconds after the run's last delete (default 300; below 300 it
 *                             settles nothing, so the next run checks those groups again)
 *            --include-cleaned  also re-check the cards an earlier applied report sent deletes for
 *            --single-destination  plan (and, with --apply, delete) under the single-destination rule; REQUIRED
 *                                  by --apply
 *            --monday-rps N  at most N monday calls a second (default: unpaced)   --hubspot-rps N (default 4)
 *   An option this build does not know refuses the run (the card limit is --limit-cards, not --limit).
 *
 * Needs HUBSPOT_CRM_APP_TOKEN and MONDAY_API_TOKEN in worker/.dev.vars (CRM_WORKER_URL optional). Prints no
 * credential.
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CRM_WORKER_URL, requireIntegrationToken, requireNewBuild } from "./lib/repair-preflight.mjs";

/**
 * MARKETING EMAIL ENTRIES ARE NEVER DEDUPED HERE. Their markers ([hubspot:marketing_email*:<event key>])
 * now match MARKER, but they are built from the legacy Email Events API, not from a CRM object, and
 * restore-timeline-entries.mjs has no path to recreate one. Deleting a "duplicate" this script could not
 * restore is how an entry is lost for good -- so they are refused as --types and skipped in planCard.
 * The marketing poller's own durable registry is what keeps them single.
 */
export const NOT_RESTORABLE = new Set(["marketing_emails", "marketing_email_opens", "marketing_email_clicks", "marketing_email_events"]);

/**
 * THE SINGLE-DESTINATION RULE (2026-09-30; see the header). Pure, so the tests can pin it without a network.
 *
 * Copies of one activity on different cards are LINKED on monday's side: a delete on one card can take a copy on
 * another card with it. Deleting a marker on ONE card lost nothing (0 of 16,601 pairs); deleting it on 2-5+ cards
 * lost 3.6-22%, on cards no delete was sent to. So a group may go only when the activity has exactly one current
 * HubSpot destination, that destination has exactly one card, and the group is on that card -- and when no earlier
 * applied run, census or hand-off shows the same marker on any other card.
 */
export const SINGLE_DESTINATION = "--single-destination";
export const DESTINATION_KINDS = ["contacts", "companies", "deals"];
const ACTIVITY_MARKER = /^\[hubspot:([a-z_]+):([A-Za-z0-9_-]+)\]$/;
/** The marker the Worker and the backfill write for one HubSpot activity (timelinePayload's last line). */
export const markerOf = (type, id) => `[hubspot:${type}:${id}]`;
/** Why a group is held: every value destinationVerdict can return, in the order it tests them. */
export const HOLD_REASONS = ["marketing", "unknown-activity", "not-a-destination", "multi-destination",
  "destination-unresolved", "duplicate-destination-cards", "seen-elsewhere"];

/**
 * --apply (the canary included) runs only under --single-destination: an old command pasted from a note, which
 * would run the rule that lost keepers, refuses instead. Returns the refusal, or null. A dry run needs no flag.
 */
export function applyRefusal(argv) {
  if (!argv.includes("--apply") || argv.includes(SINGLE_DESTINATION)) return null;
  return `refusing --apply without ${SINGLE_DESTINATION}. This build deletes a duplicate only on the single`
    + " current HubSpot destination card of its activity; the rule without it deleted linked copies on several cards"
    + " and lost entries on cards no delete was sent to (2026-09-26 and 2026-09-30). Dry-run first (no flag needed:"
    + ` it prints how many groups the rule allows and holds), then add ${SINGLE_DESTINATION} to the --apply command.`;
}

export const emptyDestinations = () => ({ contacts: new Set(), companies: new Set(), deals: new Set() });
/**
 * ONE ACTIVITY'S CURRENT DESTINATIONS, per board kind, from a HubSpot v3 row's inline associations. A Set per kind:
 * HubSpot lists one record once per association type. The inline list is capped (paging.next): the caller reads
 * the rest and adds it to the same sets.
 */
export function destinationsOf(activity) {
  const d = emptyDestinations();
  for (const kind of DESTINATION_KINDS)
    for (const x of activity?.associations?.[kind]?.results ?? []) if (x?.id != null) d[kind].add(String(x.id));
  return d;
}

/**
 * MARKERS SEEN ON CARDS: marker -> every card an earlier document shows it on. A document is a dedupe report
 * ({ cards: [{ card, groups, divergent, heldBySingleDestination }] }) or census / hand-off rows ([{ card, marker }],
 * or { rows: [...] }). Every group counts, planned or sent: the marker had a copy on that card.
 */
export function markerCards(docs, into = new Map()) {
  const add = (marker, card) => {
    if (typeof marker !== "string" || card == null || card === "") return;
    (into.get(marker) ?? into.set(marker, new Set()).get(marker)).add(String(card));
  };
  for (const doc of docs) {
    const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.rows) ? doc.rows : null;
    if (rows) { for (const r of rows) add(r?.marker, r?.card); continue; }
    for (const c of doc?.cards ?? [])
      for (const g of [].concat(c?.groups ?? [], c?.divergent ?? [], c?.heldBySingleDestination ?? [])) add(g?.marker, c?.card);
  }
  return into;
}

/**
 * THE VERDICT ON ONE GROUP (the copies of one marker on one card): { allow, reason, ... }. Held unless ALL of:
 *   - the marker names a CRM activity (a marketing entry is never deleted: nothing can rebuild one);
 *   - the activity's current destinations are known (`dest`: { contacts, companies, deals } of record ids);
 *   - this card is one of them -- a copy on a card the activity is no longer associated with is stale, and is never
 *     deleted from (not-a-destination; checked first, so a stale copy is reported as such);
 *   - it has exactly ONE destination record across all three boards. A record whose card cannot be found still
 *     counts: an idless card is invisible to the id lookup, and monday may have copied the entry onto it;
 *   - that record's cards are known and are exactly this one card;
 *   - no earlier document (`elsewhere`: marker -> cards) shows the marker on any other card.
 * `cardsOf(kind, recordId)` answers the record's cards (ids), or undefined when they could not be read.
 */
export function destinationVerdict({ kind, card, marker, dest, cardsOf, elsewhere }) {
  const self = String(card);
  const hold = (reason, more = {}) => ({ allow: false, reason, ...more });
  const m = ACTIVITY_MARKER.exec(String(marker ?? ""));
  if (m && (NOT_RESTORABLE.has(m[1]) || m[1].startsWith("marketing_email"))) return hold("marketing");
  if (!m || !dest) return hold("unknown-activity");
  const records = DESTINATION_KINDS.flatMap(k => [...(dest[k] ?? [])].map(id => ({ kind: k, id: String(id) })));
  // Only a record on this card's own board can make it a destination.
  const own = records.filter(r => r.kind === kind).map(r => {
    const cs = cardsOf(kind, r.id);
    return Array.isArray(cs) ? [...new Set(cs.map(String))] : undefined;
  });
  const isDestination = own.some(cs => cs?.includes(self)) ? true : own.every(Array.isArray) ? false : null;
  const base = { records: records.length, isDestination };
  if (isDestination === false) return hold("not-a-destination", base);
  if (records.length !== 1) return hold("multi-destination", base);
  if (isDestination === null) return hold("destination-unresolved", base);
  if (own[0].length !== 1) return hold("duplicate-destination-cards", { ...base, destinationCards: own[0].sort() });
  const others = [...(elsewhere?.get(String(marker)) ?? [])].map(String).filter(c => c !== self).sort();
  if (others.length) return hold("seen-elsewhere", { ...base, otherCards: others.slice(0, 10), otherCardCount: others.length });
  return { allow: true, reason: "allow", ...base };
}

/**
 * Keep only the allowed markers in a card's plan (planCard's { groups, classes }), groups and classes both: the
 * re-read, the keeper checks and the deletes all start from these, so none of them can reach a held marker.
 */
export function keepAllowed(p, allowed) {
  p.groups = p.groups.filter(g => allowed.has(g.marker));
  for (const marker of [...p.classes.keys()]) if (!allowed.has(marker)) p.classes.delete(marker);
  return p;
}

/**
 * ONE ID LOOKUP'S CARDS, per record asked: Map(record -> card ids), from an items_page_by_column_values page read
 * with the ID column's text. null when the answer cannot be trusted whole -- a page that did not end, or a card whose
 * ID reads as none of the values asked -- so none of those records' cards count as known (their groups are held).
 */
export function cardsByRecord(page, asked) {
  const want = new Set(asked.map(String)), by = new Map(asked.map(id => [String(id), []]));
  if (!page || page.cursor) return null;
  for (const it of page.items ?? []) {
    const text = String(it?.column_values?.[0]?.text ?? "").trim();
    if (!want.has(text)) return null;
    if (!by.get(text).includes(String(it.id))) by.get(text).push(String(it.id));
  }
  return by;
}

/** Every flag this script reads. Anything else refuses: a mistyped --limit-cards must not run over every card. */
export const KNOWN_FLAGS = new Set(["--apply", "--canary", "--types", "--boards", "--limit-cards", "--start", "--from",
  "--concurrency", "--max-lost", "--late-check", "--final-check", "--retry", "--verify", "--include-cleaned",
  SINGLE_DESTINATION, "--monday-rps", "--hubspot-rps"]);
export const unknownFlags = argv => argv.filter(a => a.startsWith("--") && !KNOWN_FLAGS.has(a));

async function main() {
  // Before anything is read: a flag this build does not know, or an --apply without the single-destination rule.
  {
    const unknown = unknownFlags(process.argv.slice(2));
    if (unknown.length) {
      console.error(`unknown option(s) ${unknown.join(", ")} -- refusing, so a mistyped flag cannot widen or change the run`
        + ` (the card limit is --limit-cards N)`);
      process.exit(2);
    }
    const refusal = applyRefusal(process.argv.slice(2));
    if (refusal) { console.error(refusal); process.exit(2); }
  }
  const SINGLE = process.argv.includes(SINGLE_DESTINATION);
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const v = {};
  for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  const H = v.HUBSPOT_CRM_APP_TOKEN, M = v.MONDAY_API_TOKEN;
  if (!H || !M) { console.error("missing HUBSPOT_CRM_APP_TOKEN or MONDAY_API_TOKEN in .dev.vars"); process.exit(1); }
  const APPLY = process.argv.includes("--apply");
  const CANARY = process.argv.includes("--canary");
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  /** A flag that is present must carry a value: a trailing `--types` must never widen the delete scope. */
  for (const k of ["--types", "--boards", "--limit-cards", "--start", "--from", "--concurrency", "--max-lost", "--late-check", "--final-check",
    "--monday-rps", "--hubspot-rps"]) {
    if (!process.argv.includes(k)) continue;
    const x = arg(k);
    if (x === undefined || x === "" || String(x).startsWith("--")) { console.error(`${k} needs a value`); process.exit(2); }
  }
  const RETRY = arg("--retry", null);
  if (process.argv.includes("--retry") && (!RETRY || RETRY.startsWith("--"))) {
    console.error("--retry needs the path of an earlier dedupe report"); process.exit(2);
  }
  const VERIFY = arg("--verify", null);
  if (process.argv.includes("--verify") && (!VERIFY || VERIFY.startsWith("--"))) {
    console.error("--verify needs the path of an applied dedupe report"); process.exit(2);
  }
  if (VERIFY && (APPLY || CANARY || RETRY)) { console.error("--verify only reads: run it without --apply, --canary or --retry"); process.exit(2); }
  const retryOf = RETRY ? JSON.parse(readFileSync(resolve(RETRY), "utf8")) : null;
  // A retry keeps the marker scope of the run it retries, unless --types narrows it explicitly.
  const TYPES = String(arg("--types", null) ?? retryOf?.types?.join(",") ?? "emails,calls,notes,meetings,tasks")
    .split(",").map(s => s.trim()).filter(Boolean);
  const BOARDS_ON = arg("--boards", "contacts,companies,deals").split(",").map(s => s.trim()).filter(Boolean);
  const LIMIT = Number(arg("--limit-cards", 0)) || Infinity;
  const START = Number(arg("--start", 0)) || 0;
  /** Resume by CARD, not by position: a card dropping out between runs shifts every later index. */
  const FROM = arg("--from", null);
  /** Whole numbers only. The raw text is checked: Number("1e3") passes. */
  for (const k of ["--max-lost", "--late-check", "--final-check"])
    if (process.argv.includes(k) && !/^\d+$/.test(String(arg(k)))) { console.error(`${k} needs a whole number >= 0`); process.exit(2); }
  /** keeper-lost groups a run tolerates; one more stops its deletes. */
  const MAX_LOST = Number(arg("--max-lost", 5));
  /** The delayed keeper checks (see the header): per card after its last delete, and once more at the end. */
  const LATE_MS = Number(arg("--late-check", 45)) * 1000;
  const FINAL_MS = Number(arg("--final-check", 300)) * 1000;
  /** A group whose keepers still resolve this long after its card's last delete is settled: later runs leave it be. */
  const SETTLED_MS = 300_000;
  const INCLUDE_CLEANED = process.argv.includes("--include-cleaned");
  const ROLLOUT = join(ROOT, "..", "docs", "rollout");
  const keyOf = c => `${c.kind}:${c.card}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /**
   * PACING. At most --monday-rps monday calls a second (default: unpaced, as before) and --hubspot-rps HubSpot calls
   * (default 4), across every worker of the run: the live Worker shares both budgets. A slot is reserved before
   * the wait, so concurrent callers queue instead of all waking at once.
   */
  for (const k of ["--monday-rps", "--hubspot-rps"])
    if (process.argv.includes(k) && !(Number(arg(k)) > 0)) { console.error(`${k} needs a number > 0`); process.exit(2); }
  const pacer = rps => {
    let nextAt = 0;
    return async () => {
      if (!(rps > 0)) return;
      const now = Date.now(), at = Math.max(now, nextAt);
      nextAt = at + 1000 / rps;
      if (at > now) await sleep(at - now);
    };
  };
  const mondaySlot = pacer(Number(arg("--monday-rps", 0)));
  const hubspotSlot = pacer(Number(arg("--hubspot-rps", 4)));
  /** Deletes within a card, and the keeper lookups after them, run this many at a time; later checks, VERIFY_PARALLEL. */
  const DELETE_PARALLEL = 5;
  const VERIFY_PARALLEL = 8;

  const BOARD = {
    contacts:  { board: "5028000495", idCol: "text_mm6t71dj" },
    companies: { board: "5028000496", idCol: "text_mm6tsnwx" },
    deals:     { board: "5028000494", idCol: "text_mm76kxz4" },
  };

  /**
   * OUR custom activity types, per marker object -- a copy of MONDAY_ACTIVITY_TYPE in src/activities.ts
   * (a script cannot import the Worker's TypeScript). Checked against that file below, so a drift stops the
   * run instead of quietly making every entry "not ours" -- or, worse, making someone else's entry ours.
   */
  const OUR_TYPE = {
    emails: "eaca46da-4695-4386-8dd4-a3fa088d31ce",
    notes: "ca35c3ab-476a-4718-9b38-67ee945593d4",
    calls: "1e0d9eca-222b-4f8b-85c8-4f7947e83595",
    meetings: "7314447b-685c-4c58-9e38-80ad162d8fc4",
    tasks: "5f0e2267-8cea-45fa-bb54-2b1a29324a34",
  };
  {
    let src = null;
    try { src = readFileSync(join(ROOT, "src", "activities.ts"), "utf8"); }
    catch (e) { console.log(`note: could not read src/activities.ts to cross-check the activity types (${String(e).slice(0, 80)})`); }
    const drift = src ? Object.entries(OUR_TYPE).filter(([o, id]) => !new RegExp(`\\b${o}:\\s*"${id}"`).test(src)) : [];
    if (drift.length) {
      console.error(`OUR_TYPE here disagrees with src/activities.ts MONDAY_ACTIVITY_TYPE for ${drift.map(d => d[0]).join(", ")}`
        + " -- update the copy in this script before running it");
      process.exit(1);
    }
  }
  const marketingTypes = TYPES.filter(t => NOT_RESTORABLE.has(t));
  if (marketingTypes.length) {
    console.error(`--types ${marketingTypes.join(",")}: marketing email entries cannot be restored, so this script never deletes them`);
    process.exit(2);
  }
  const unknownTypes = TYPES.filter(t => !OUR_TYPE[t]);
  if (unknownTypes.length) { console.error(`unknown --types ${unknownTypes.join(",")}`); process.exit(2); }

  // Refuse before reading anything when the run could write: see lib/repair-preflight.mjs.
  if (APPLY) {
    try {
      await requireNewBuild(v.CRM_WORKER_URL || DEFAULT_CRM_WORKER_URL);
      await requireIntegrationToken(M);
    } catch (e) { console.error(`refusing --apply: ${e.message}`); process.exit(1); }
    console.log("pre-flight: the new CRM build is live and the monday token is the integration user");
  }

  /**
   * ONE WRITING RUN AT A TIME. Two processes on one card can each keep a different copy and delete the other's.
   * Taken before any earlier report is read (below), so what this run learns from them cannot change under it.
   * Removed on exit, however the run ends (a Ctrl-C ends it through process.exit, so that holds for it too), but
   * only while it is still this run's: someone may have deleted it as stale and a second run taken it since.
   */
  const LOCK = join(ROLLOUT, ".timeline-dedupe.lock");
  let onInterrupt = () => process.exit(130);            // until the run can save a report; see the end of the setup
  let lockHeldElsewhere = false;
  /** On this host, whether the lock's pid still runs: a stale lock (hard kill, window closed) from a live one. */
  function holderAlive(h) {
    if (!h || h.host !== hostname() || !Number.isInteger(h.pid)) return "";
    try { process.kill(h.pid, 0); return `; pid ${h.pid} is still running on this host`; }
    catch (e) {
      return e?.code === "EPERM" ? `; pid ${h.pid} is still running on this host (as another user)`
        : `; pid ${h.pid} is NOT running on this host -- the lock looks stale`;
    }
  }
  if (APPLY || CANARY) {
    let user; try { user = userInfo().username; } catch { /* no user record: pid and host still say who */ }
    const mine = { pid: process.pid, host: hostname(), user, since: new Date().toISOString(), args: process.argv.slice(2) };
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, JSON.stringify(mine));
      closeSync(fd);
    } catch (e) {
      if (e?.code !== "EEXIST") { console.error(`refusing to run: cannot take ${LOCK}: ${String(e?.message ?? e).slice(0, 120)}`); process.exit(1); }
      let text = "", h = null;
      try { text = readFileSync(LOCK, "utf8"); h = JSON.parse(text); } catch { /* gone meanwhile, or not JSON: still refuse */ }
      const who = h ? `pid ${h.pid} on ${h.host}${h.user ? `, user ${h.user}` : ""}, since ${h.since}, args ${JSON.stringify(h.args ?? []).slice(0, 200)}`
        : (text.slice(0, 300) || "unreadable");
      console.error(`refusing to run: another dedupe run holds ${LOCK} (${who})${holderAlive(h)}. `
        + "If that process is no longer running, look at its report first, then delete the lock and run again.");
      process.exit(1);
    }
    process.on("exit", () => {
      try {
        const h = JSON.parse(readFileSync(LOCK, "utf8"));
        if (h?.pid === mine.pid && h?.host === mine.host && h?.since === mine.since) unlinkSync(LOCK);
      } catch { /* already gone, or unreadable: then it is not provably ours, so it stays */ }
    });
    process.on("SIGINT", () => onInterrupt());
  } else if (existsSync(LOCK)) {
    lockHeldElsewhere = true;
    console.log(`note: a writing run holds ${LOCK} -- this plan may not reflect what it is deleting right now`);
  }

  /**
   * CARDS ALREADY CLEANED: every card an earlier applied report (main run, --retry or canary) shows a delete sent for
   * -- any entry at all in a report from before the intent log (see the header). Skipped unless --include-cleaned.
   * The same pass collects the deletes an earlier run sent with no answer recorded (entry.deleting minus deleted /
   * failed / alreadyGone: a run killed mid-card), the intent-logged reports whose groups the check at start looks
   * at, and the groups a verify report has settled.
   */
  const APPLIED_REPORT = /-timeline-dedupe-(?:retry-)?(?:canary-)?applied.*\.json$/;
  const VERIFY_REPORT = /-timeline-dedupe-verify.*\.json$/;
  /** Every id an entry shows a delete SENT for: recorded before sending (deleting), and how each one ended. */
  const sentOf = c => new Set([...(c?.deleting ?? []), ...(c?.deleted ?? []), ...(c?.alreadyGone ?? []),
    ...(c?.failed ?? []).map(x => x?.id)].filter(x => x != null).map(String));
  const intentLogged = j => j?.intentLog === true || j?.maxLost !== undefined;
  const cleaned = new Map();                          // card id -> the first report that shows it cleaned
  const earlierUnanswered = [];                       // { file, kind, card, ids }
  const earlierReports = [];                          // { file, j, mtime }: intent-logged applied reports
  const settledElsewhere = new Set();                 // `${file}|${card}|${marker}` a verify report settled
  {
    let files = []; try { files = readdirSync(ROLLOUT).sort(); } catch { /* no folder yet */ }
    const applied = files.filter(f => APPLIED_REPORT.test(f));
    const unreadable = [];
    for (const f of applied) {
      let j; try { j = JSON.parse(readFileSync(join(ROLLOUT, f), "utf8")); } catch { unreadable.push(f); continue; }
      const logged = intentLogged(j);
      for (const c of j.cards ?? []) {
        if (c?.card == null) continue;
        const sent = sentOf(c);
        if ((!logged || sent.size) && !cleaned.has(String(c.card))) cleaned.set(String(c.card), f);
        const answered = new Set([...(c.deleted ?? []), ...(c.alreadyGone ?? []), ...(c.failed ?? []).map(x => x?.id)].map(String));
        const open = (c.deleting ?? []).map(String).filter(id => !answered.has(id));
        if (open.length) earlierUnanswered.push({ file: f, kind: c.kind, card: String(c.card), ids: open });
      }
      if (logged) { let mtime = 0; try { mtime = statSync(join(ROLLOUT, f)).mtimeMs; } catch { /* then "now" below */ } earlierReports.push({ file: f, j, mtime }); }
    }
    for (const f of files.filter(f => VERIFY_REPORT.test(f))) {
      let j; try { j = JSON.parse(readFileSync(join(ROLLOUT, f), "utf8")); }
      catch { console.log(`note: cannot parse ${f} -- the groups it settled are checked again`); continue; }
      for (const r of j.checks ?? []) if (r?.settled) settledElsewhere.add(`${r.file}|${r.card}|${r.marker}`);
    }
    if (unreadable.length && !VERIFY) {
      const msg = `cannot parse ${unreadable.join(", ")} in ${ROLLOUT} -- the cards it cleaned would be taken for fresh ones`;
      if (APPLY) { console.error(`refusing --apply: ${msg}. Repair or move the file (look for a .tmp beside it), then run again.`); process.exit(1); }
      console.log(`WARNING: ${msg}`);
    }
    if (!VERIFY) {
      console.log(`earlier applied reports: ${applied.length}, cleaned cards in them ${cleaned.size} -- `
        + (INCLUDE_CLEANED ? "re-checked (--include-cleaned)" : "those cards are skipped (--include-cleaned to re-check them)"));
      if (earlierUnanswered.length)
        console.log(`note: ${earlierUnanswered.reduce((s, x) => s + x.ids.length, 0)} delete(s) on ${earlierUnanswered.length} card(s) were sent`
          + " by an earlier run that recorded no answer (killed mid-card); listed in this report as earlierUnanswered, and their"
          + " groups' keepers are checked below");
    }
  }

  /**
   * MARKERS EARLIER RUNS SAW ON CARDS, for the single-destination rule: every marker an earlier
   * *timeline-dedupe*applied*.json report (groups, divergent, held), a *-timeline-*census*.json (the 2026-09-28
   * damage census) or a *-timeline-dedupe-lost-*.json hand-off shows on a card. A group whose marker one of them
   * shows on ANOTHER card is held (seen-elsewhere). Read in a dry run too, so the plan counts what --apply would hold;
   * --apply refuses when one cannot be parsed, or when the damage census is missing.
   */
  const ELSEWHERE_SOURCES = [
    ["applied reports", /timeline-dedupe.*applied.*\.json$/],
    ["censuses", /-timeline-.*census.*\.json$/],
    ["hand-offs", /-timeline-dedupe-lost-.*\.json$/],
  ];
  const elsewhere = new Map();                        // marker -> Set(card)
  const elsewhereFiles = {};
  if (!VERIFY) {
    let files = []; try { files = readdirSync(ROLLOUT).sort(); } catch { /* no folder yet */ }
    const bad = [];
    for (const [label, re] of ELSEWHERE_SOURCES) {
      elsewhereFiles[label] = files.filter(f => re.test(f));
      for (const f of elsewhereFiles[label]) {
        let j; try { j = JSON.parse(readFileSync(join(ROLLOUT, f), "utf8")); } catch { bad.push(f); continue; }
        markerCards([j], elsewhere);
      }
    }
    const multi = [...elsewhere.values()].filter(s => s.size > 1).length;
    console.log(`markers earlier runs saw on cards: ${elsewhere.size}, ${multi} of them on more than one card (from `
      + `${ELSEWHERE_SOURCES.map(([label]) => `${elsewhereFiles[label].length} ${label}`).join(", ")})`);
    const problems = [bad.length ? `cannot parse ${bad.join(", ")}` : "",
      elsewhereFiles.censuses.some(f => /-timeline-damage-census/.test(f)) ? "" : "no *-timeline-damage-census*.json (the 2026-09-28 census) in docs/rollout",
    ].filter(Boolean).join("; ");
    if (problems) {
      if (APPLY) {
        console.error(`refusing --apply: ${problems} -- the single-destination rule could not hold every marker an earlier`
          + " run saw on another card. Repair or restore the file, then run again.");
        process.exit(1);
      }
      console.log(`WARNING: ${problems}`);
    }
  }

  async function hs(path, attempt = 0) {
    await hubspotSlot();
    const r = await fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${H}` } });
    if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2500 * (attempt + 1)); return hs(path, attempt + 1); }
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`hubspot ${path.split("?")[0]}: ${r.status}`);
    return j;
  }

  /**
   * ONE monday call. Retries ONLY what a second try can fix: HTTP 429 / 5xx, a rate-limit, complexity or
   * concurrency error, a network failure or timeout -- waiting as long as monday asks when it says
   * (retry_in_seconds, "reset in N"). Anything else -- a GraphQL validation error, a resolver refusing an
   * id -- is thrown at once: the same document gets the same answer. A 401/403 or a spent daily limit is
   * marked `abort`, because every later call would fail the same way, so the run stops rather than erroring
   * card after card.
   */
  const TRANSIENT = /complexity|rate.?limit|budget|too many requests|throttl|concurren|temporar|timed? ?out|internal server error|service unavailable/i;
  async function monday(query, variables = {}, attempt = 0) {
    let r, j;
    await mondaySlot();
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
   * ONE ENTRY BY ID: "present" | "absent" | "unknown". Only NOT_FOUND counts as gone (checked 2026-09-27: a deleted
   * id answers HTTP 200, errors[0].extensions.code NOT_FOUND, "Timeline item not found.", data.timeline_item null);
   * any other failure is "cannot tell". 401/403/daily limit is thrown, to stop the run.
   */
  const ENTRY = `query ($i: ID!) { timeline_item(id: $i) { id } }`;
  async function entryById(id) {
    try {
      const d = await monday(ENTRY, { i: id });
      return d.timeline_item ? "present" : "absent";
    } catch (e) {
      if (e?.abort) throw e;
      return /"code":"NOT_FOUND"|Timeline item not found/.test(String(e?.message)) ? "absent" : "unknown";
    }
  }
  /** entryById, asked again after a pause while it cannot tell: a resolver hiccup must read neither as gone nor as fine. */
  async function resolveSure(id, tries = 3) {
    let s = await entryById(id);
    for (let t = 1; t < tries && s === "unknown"; t++) { await sleep(2000 * t); s = await entryById(id); }
    return s;
  }

  /**
   * SAVED AS IT GOES, so a run that is cut off (session limit, laptop sleep) loses nothing: the file always
   * holds every card finished so far, and `nextStart` is where `--start` resumes: the lowest card not yet
   * finished, so nothing is skipped even when a slow card is overtaken. A resumed run skips the cards this one
   * sent deletes for (they are already cleaned; see the header). Cards
   * that errored or could not be read in full sit below nextStart, so they are listed by id for --retry.
   * In --apply the file is also saved after every card that deleted something, and before every batch of
   * deletes is sent (entry.deleting). An earlier report is never
   * overwritten -- --retry needs it intact -- so when today's name is taken, the time is appended. Each save
   * is written whole to a .tmp beside it and renamed over it, so a kill mid-write never leaves a report the
   * next run cannot parse (on Windows a reader holding it open can refuse the rename: it is tried 5 times over
   * ~0.75 s, and only then written in place).
   */
  const stamp = new Date().toISOString();
  const hhmmss = stamp.slice(11, 19).replace(/:/g, "");
  let out = join(ROLLOUT, VERIFY ? `${stamp.slice(0, 10)}-timeline-dedupe-verify.json`
    : `${stamp.slice(0, 10)}-timeline-dedupe-${RETRY ? "retry-" : ""}${CANARY ? "canary-" : ""}`
      + `${APPLY ? "applied" : "plan"}${START ? `-from${START}` : ""}.json`);
  if (existsSync(out)) out = out.replace(/\.json$/, `-${hhmmss}.json`);
  /** A synchronous pause, for the rename retries of a synchronous save. */
  const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: retry at once */ } };
  const writeWhole = (path, text) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    for (let t = 0; ; t++) {
      try { renameSync(tmp, path); return; }
      catch {
        if (t < 4) { pause(50 * (t + 1)); continue; }
        writeFileSync(path, text); try { unlinkSync(tmp); } catch { /* best effort */ }
        return;
      }
    }
  };

  const plan = { generatedAt: stamp, apply: APPLY, canary: CANARY, retryOf: RETRY ?? undefined, intentLog: true,
    types: TYPES, activities: null, cardsChecked: 0, cardsWithDuplicates: 0, entriesToDelete: 0,
    identicalExtras: 0, bodylessExtras: 0, deleted: 0, deleteFailed: 0, noLongerQualifying: 0,
    divergentMarkers: 0, foreignItemEntries: 0, guardTripped: 0, byBoard: {}, byType: {},
    // The keeper checks (see the header). Groups before the deletes (nothing of the group deleted): keeperMissing,
    // bodyMissing, keeperUnconfirmed; keeperPartlyUnconfirmed = a class held back, another class kept. After them:
    // keeperLost (keeperLostLate of them found by the late or final check), keeperOk, keeperOkPartial,
    // keeperUnverified. keeperRechosen counts ghost keepers replaced, heldByKeeperCheck the ids the checks kept back
    // from both reads' plan. lookupProvedBy: deleted ids timeline_item then answered absent for.
    includeCleaned: INCLUDE_CLEANED, skippedCleaned: 0, maxLost: MAX_LOST,
    lateCheckSeconds: LATE_MS / 1000, finalCheckSeconds: FINAL_MS / 1000,
    keeperMissing: 0, bodyMissing: 0, keeperUnconfirmed: 0, keeperPartlyUnconfirmed: 0, keeperRechosen: 0, heldByKeeperCheck: 0,
    keeperLost: 0, keeperLostLate: 0, keeperOk: 0, keeperOkPartial: 0, keeperUnverified: 0, settledGroups: 0, unsettledGroups: 0,
    lookupProvedBy: 0, lookupUnknown: 0, lookupNotAuthoritative: undefined, finalCheck: undefined, earlierCheck: undefined,
    toVerify: [], lostFile: undefined, earlierUnanswered: earlierUnanswered.length ? earlierUnanswered : undefined,
    // The single-destination rule: enforced (only allowed groups are planned and deleted) or, in a dry run without
    // the flag, counted only. Groups and entries (the ids a group would delete) it allows and holds, holds by reason.
    singleDestination: { enforced: SINGLE, allowedGroups: 0, allowedEntries: 0, heldGroups: 0, heldEntries: 0,
      heldByReason: Object.fromEntries(HOLD_REASONS.map(r => [r, 0])), markersSeenElsewhere: elsewhere.size,
      sources: VERIFY ? undefined : elsewhereFiles },
    erroredCards: [], incompleteCards: [], cards: [] };

  /**
   * THE RESTORE HAND-OFF: census rows for restore-timeline-entries.mjs --census, one per keeper-lost(-late),
   * keeper-missing, keeper-unverified or not-authoritative group, saved as each is found, and appended to a .jsonl
   * beside it. Created only when there is one.
   */
  let lostOut = join(ROLLOUT, `${stamp.slice(0, 10)}-timeline-dedupe-lost-${hhmmss}.json`);
  if (existsSync(lostOut)) lostOut = lostOut.replace(/\.json$/, `-${process.pid}.json`);
  const lostLog = lostOut.replace(/\.json$/, ".jsonl");
  const lostRows = [];
  function handOff({ kind, card, marker, outcome, knownIds, state = "LOST", report = basename(out), ...rest }) {
    const row = { card: String(card), kind, marker, state, outcome, knownIds, ...rest, report, at: new Date().toISOString() };
    lostRows.push(row);
    plan.lostFile = lostOut;
    try { appendFileSync(lostLog, `${JSON.stringify(row)}\n`); } catch { /* the .json below still has it */ }
    writeWhole(lostOut, JSON.stringify(lostRows, null, 1));
  }

  /**
   * The groups of one report that had a delete sent, as rows to check again: keepers (the ones the run resolved
   * before deleting; keep in a report from before the keeper checks), the ids sent, every id known for the pair.
   * `onlyUnsettled` leaves out the groups settled in that report or by a verify report.
   */
  function sentGroups(file, j, mtime, onlyUnsettled) {
    const rows = [];
    for (const c of j.cards ?? []) {
      const sent = sentOf(c);
      if (c?.card == null || !sent.size) continue;
      const lastSentAt = Date.parse(c.lastSentAt ?? "") || mtime || Date.now();
      for (const g of c.groups ?? []) {
        const gSent = [].concat(g.identical ?? [], g.bodyless ?? []).map(String).filter(id => sent.has(id));
        if (!gSent.length) continue;
        if (onlyUnsettled && (g.settled || settledElsewhere.has(`${file}|${c.card}|${g.marker}`))) continue;
        const keepers = [].concat(g.keepers ?? g.keep ?? []).map(String);
        const knownIds = [...new Set([...keepers, ...[].concat(g.keep ?? [], g.identical ?? [], g.bodyless ?? []).map(String),
          ...(g.rechosen ?? []).flatMap(r => [r.ghost, r.keeper]).filter(Boolean).map(String)])].sort();
        rows.push({ file, kind: c.kind, card: String(c.card), marker: g.marker, keepers, sent: gSent, knownIds, lastSentAt });
      }
    }
    return rows;
  }

  /**
   * CHECK EARLIER DELETES' KEEPERS AGAIN (the check at start, and --verify). Each row's keepers are resolved (each
   * asked up to 3 times while it cannot tell): all present = ok, settled when the card's last delete is SETTLED_MS
   * old; one absent = lost, handed off as keeper-lost-late; otherwise unknown, handed off as state "unknown".
   * Results are pushed onto `checks`, and `progress` is called after each batch.
   */
  async function verifyGroups(rows, label, checks, progress = () => {}) {
    for (let i = 0; i < rows.length; i += VERIFY_PARALLEL) {
      await Promise.all(rows.slice(i, i + VERIFY_PARALLEL).map(async r => {
        const states = r.keepers.length ? await Promise.all(r.keepers.map(id => resolveSure(id))) : ["unknown"];
        const at = Date.now();
        const lost = r.keepers.filter((_, k) => states[k] === "absent");
        const state = lost.length ? "lost" : states.includes("unknown") ? "unknown" : "ok";
        const settled = state === "lost" || (state === "ok" && at >= r.lastSentAt + SETTLED_MS);
        checks.push({ file: r.file, kind: r.kind, card: r.card, marker: r.marker, keepers: r.keepers, state,
          ...(lost.length ? { lostKeepers: lost } : {}), settled, secondsAfterLastDelete: Math.round((at - r.lastSentAt) / 1000),
          at: new Date(at).toISOString() });
        if (state === "lost") {
          handOff({ kind: r.kind, card: r.card, marker: r.marker, outcome: "keeper-lost-late", knownIds: r.knownIds, keepers: r.keepers,
            lostKeepers: lost, sent: r.sent, report: r.file, foundBy: label,
            note: `checked again by ${label}: a copy that run kept no longer resolves` });
          console.log(`KEEPER LOST (${label}): ${r.kind} card ${r.card} ${r.marker}: kept ${lost.join(", ")} no longer resolves (${r.file})`);
        } else if (state === "unknown") {
          handOff({ kind: r.kind, card: r.card, marker: r.marker, state: "unknown", outcome: "keeper-unverified", knownIds: r.knownIds,
            keepers: r.keepers, sent: r.sent, report: r.file, foundBy: label,
            note: `checked again by ${label}: a lookup of a kept copy could not tell, 3 tries -- run --verify ${r.file} again` });
        }
      }));
      progress();
    }
    return checks;
  }
  const tally = checks => ({ groups: checks.length, ok: checks.filter(c => c.state === "ok").length,
    lost: checks.filter(c => c.state === "lost").length, unknown: checks.filter(c => c.state === "unknown").length,
    settled: checks.filter(c => c.settled).length, unsettled: checks.filter(c => !c.settled).length });
  const byKey = (a, b) => (`${a.file}|${a.card}|${a.marker}` < `${b.file}|${b.card}|${b.marker}` ? -1 : 1);

  // ------------------------------------------------------------------ --verify: re-check one report, then stop
  if (VERIFY) {
    let j;
    try { j = JSON.parse(readFileSync(resolve(VERIFY), "utf8")); }
    catch (e) { console.error(`cannot read ${VERIFY}: ${String(e?.message ?? e).slice(0, 120)}`); process.exit(2); }
    let mtime = 0; try { mtime = statSync(resolve(VERIFY)).mtimeMs; } catch { /* then "now" */ }
    const file = basename(VERIFY);
    let rows = sentGroups(file, j, mtime, false);
    if (Number.isFinite(LIMIT)) { const keep = new Set([...new Set(rows.map(r => r.card))].slice(0, LIMIT)); rows = rows.filter(r => keep.has(r.card)); }
    console.log(`--verify ${file}: ${rows.length} group(s) on ${new Set(rows.map(r => r.card)).size} card(s) had a delete sent --`
      + ` resolving their ${intentLogged(j) ? "keepers" : "planned keepers (keep: an older report, where keep can name a ghost)"} by id`);
    const report = { generatedAt: stamp, mode: "verify", verifyOf: resolve(VERIFY), totals: undefined, lostFile: undefined, checks: [] };
    const saveV = () => { report.totals = tally(report.checks); report.lostFile = plan.lostFile; report.checks.sort(byKey); writeWhole(out, JSON.stringify(report, null, 2)); };
    try { await verifyGroups(rows, "--verify", report.checks, saveV); }
    catch (e) { saveV(); console.error(`--verify stopped: ${String(e?.message ?? e).slice(0, 160)}`); console.log(`report: ${out}`); process.exit(1); }
    saveV();
    const t = report.totals;
    console.log(`\nchecked ${t.groups} group(s): keepers present ${t.ok}, LOST ${t.lost}, could not tell ${t.unknown}; settled ${t.settled}`
      + `${t.unsettled ? `, not yet settled ${t.unsettled} (checked within 5 min of the delete, or unknown -- run --verify again later)` : ""}`);
    if (lostRows.length) console.log(`${lostRows.length} group(s) handed off -- restore with: node scripts/restore-timeline-entries.mjs --census ${lostOut}`);
    console.log(`report: ${out}`);
    process.exit(t.lost ? 3 : 0);
  }

  // ------------------------------------------------------------------ 0. earlier runs' deletes nobody checked later
  {
    const rows = earlierReports.flatMap(r => sentGroups(r.file, r.j, r.mtime, true));
    if (rows.length && lockHeldElsewhere)
      console.log(`note: ${rows.length} group(s) of earlier runs are not settled; not checked now, since a writing run holds the lock`);
    else if (rows.length) {
      console.log(`earlier runs: ${rows.length} group(s) on ${new Set(rows.map(r => r.card)).size} card(s) had a delete sent and are not settled`
        + " (a run killed mid-card, stopped, or checked too early) -- resolving their keepers by id");
      const earlierOut = join(ROLLOUT, `${stamp.slice(0, 10)}-timeline-dedupe-verify-start-${hhmmss}.json`);
      const report = { generatedAt: stamp, mode: "check at start", by: basename(out), totals: undefined, checks: [] };
      const saveE = () => { report.totals = tally(report.checks); report.checks.sort(byKey); writeWhole(earlierOut, JSON.stringify(report, null, 2)); };
      try { await verifyGroups(rows, "the check at start", report.checks, saveE); }
      catch (e) { saveE(); console.error(`refusing to run: the check of earlier runs' keepers failed: ${String(e?.message ?? e).slice(0, 160)}`); process.exit(1); }
      saveE();
      const t = report.totals;
      plan.earlierCheck = { file: earlierOut, ...t };
      console.log(`earlier runs: keepers present ${t.ok}, LOST ${t.lost}, could not tell ${t.unknown}; still to settle ${t.unsettled}`
        + ` (checked again by the next run) -- ${earlierOut}`);
      if (t.lost) console.log(`WARNING: ${t.lost} earlier group(s) lost their keeper -- handed off: node scripts/restore-timeline-entries.mjs --census ${lostOut}`);
      if (APPLY && t.lost > MAX_LOST) {
        console.error(`refusing --apply this once: ${t.lost} groups of earlier runs lost their keeper, more than --max-lost ${MAX_LOST}.`
          + " Look at the hand-off and restore them first; they are settled now, so the next run goes ahead.");
        process.exit(1);
      }
    }
  }

  // ------------------------------------------------------------------ 1+2. the cards to check
  let activities = null;
  let cards = [];                                     // { kind, card }
  /**
   * EACH ACTIVITY'S OWN CURRENT DESTINATIONS, for the single-destination rule: marker -> { contacts, companies,
   * deals } (Sets of HubSpot record ids), filled by step 1 -- or, in --retry, read per marker when a card needs it.
   * The combined record sets alone (all step 2 needs) cannot say how many places one activity goes. And each
   * record's cards: `${kind}:${record}` -> card ids, filled by step 2 for the boards checked; absent = not known.
   */
  const destinations = new Map();
  const recordCards = new Map();
  /** An activity's full destinations: its inline associations and, where HubSpot capped them, the rest. */
  async function fullDestinations(type, a) {
    const d = destinationsOf(a);
    for (const kind of DESTINATION_KINDS) {
      // The inline list is capped; an activity with more gets its full list read separately.
      let aft = a.associations?.[kind]?.paging?.next?.after;
      while (aft) {
        const more = await hs(`/crm/v4/objects/${type}/${a.id}/associations/${kind}?limit=500&after=${aft}`);
        for (const x of more.results ?? []) d[kind].add(String(x.toObjectId));
        aft = more.paging?.next?.after;
      }
    }
    return d;
  }
  /** Cards by HubSpot ID, with the ID each one carries, so every card is tied to the record it belongs to. */
  const BY_ID = `query ($b: ID!, $c: String!, $v: [String]!) {
    items_page_by_column_values(board_id: $b, limit: 500, columns: [{ column_id: $c, column_values: $v }]) {
      cursor items { id column_values(ids: [$c]) { text } } } }`;
  /** --retry reads per marker what step 1 would have: undefined when it cannot (the group is then held). */
  async function destinationsFor(marker) {
    if (destinations.has(marker) || !retryOf) return destinations.get(marker);
    const m = /^\[hubspot:([a-z]+):(\d+)\]$/.exec(marker);
    let d;
    if (m && TYPES.includes(m[1])) {
      try { d = await fullDestinations(m[1], await hs(`/crm/v3/objects/${m[1]}/${m[2]}?associations=contacts,companies,deals`)); }
      catch (e) { console.log(`note: could not read the destinations of ${marker} (${String(e?.message ?? e).slice(0, 80)}) -- its groups are held`); }
    }
    destinations.set(marker, d);
    return d;
  }
  /** --retry reads per record what step 2 would have. Left unknown when it cannot. */
  const cardsTried = new Set();
  async function cardsFor(kind, record) {
    const key = `${kind}:${record}`;
    if (!retryOf || !BOARD[kind] || recordCards.has(key) || cardsTried.has(key)) return;
    cardsTried.add(key);
    try {
      const d = await monday(BY_ID, { b: BOARD[kind].board, c: BOARD[kind].idCol, v: [String(record)] });
      const by = cardsByRecord(d.items_page_by_column_values, [record]);
      if (by) recordCards.set(key, by.get(String(record)));
    } catch (e) { if (e?.abort) throw e; }
  }
  if (retryOf) {
    /**
     * --retry: exactly the cards the earlier run could not finish -- errored, incomplete, or with a delete
     * that failed. Reads the older report shape too (`errors`, no kinds: the kind is read from the card's board).
     * Nothing is enumerated from HubSpot: the point is to finish those cards, not to widen the run. (The
     * single-destination rule reads each group's activity, and its records' cards, one by one instead.)
     */
    const want = new Map();
    const add = (kind, card, why) => { if (card && !want.has(String(card))) want.set(String(card), { kind: kind ?? "unknown", card: String(card), why }); };
    for (const e of retryOf.erroredCards ?? retryOf.errors ?? []) add(e.kind, e.card, "errored");
    for (const e of retryOf.incompleteCards ?? []) add(e.kind, e.card, "incomplete");
    for (const c of retryOf.cards ?? []) if (c.failed?.length) add(c.kind, c.card, "delete failed");
    // A row with no kind: its board says which it is. Without one, nothing is deleted on it (see checkCard).
    const unknownKind = [...want.values()].filter(c => !BOARD[c.kind]);
    if (unknownKind.length) {
      const kindOfBoard = Object.fromEntries(Object.entries(BOARD).map(([k, b]) => [b.board, k]));
      for (let i = 0; i < unknownKind.length; i += 100) {
        const part = unknownKind.slice(i, i + 100);
        try {
          const d = await monday(`query ($i: [ID!]) { items(ids: $i) { id board { id } } }`, { i: part.map(c => c.card) });
          for (const it of d.items ?? []) {
            const c = part.find(x => x.card === String(it.id));
            if (c && kindOfBoard[String(it.board?.id)]) c.kind = kindOfBoard[String(it.board.id)];
          }
        } catch (e) {
          if (e?.abort) { console.error(`refusing to run: ${String(e.message).slice(0, 160)}`); process.exit(1); }
          console.log(`note: could not read the boards of ${part.length} card(s) with no kind: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
      const still = unknownKind.filter(c => !BOARD[c.kind]).length;
      console.log(`kind read from the board for ${unknownKind.length - still} of ${unknownKind.length} card(s) the report gave none`
        + `${still ? `; ${still} still unknown -- nothing is deleted on those` : ""}`);
    }
    cards = [...want.values()].filter(c => !BOARD[c.kind] || BOARDS_ON.includes(c.kind));
    console.log(`retry of ${RETRY}: ${cards.length} card(s) to re-check `
      + JSON.stringify(cards.reduce((t, c) => ({ ...t, [c.why]: (t[c.why] ?? 0) + 1 }), {})));
  } else {
    // 1. destinations, from HubSpot: each activity's own (the single-destination rule), and all of them together
    const records = { contacts: new Set(), companies: new Set(), deals: new Set() };
    activities = 0;
    for (const type of TYPES) {
      let after, n = 0;
      do {
        const q = `/crm/v3/objects/${type}?limit=100&associations=contacts,companies,deals${after ? `&after=${after}` : ""}`;
        const r = await hs(q);
        for (const a of r.results ?? []) {
          n++;
          const d = await fullDestinations(type, a);
          destinations.set(markerOf(type, a.id), d);
          for (const kind of DESTINATION_KINDS) for (const id of d[kind]) records[kind].add(id);
        }
        after = r.paging?.next?.after;
      } while (after);
      activities += n;
      console.log(`${type}: ${n} activities`);
    }
    const reach = [...destinations.values()].map(d => DESTINATION_KINDS.reduce((s, k) => s + d[k].size, 0));
    console.log(`destinations: ${records.contacts.size} contacts, ${records.companies.size} companies, ${records.deals.size} deals;`
      + ` activities with exactly one destination ${reach.filter(n => n === 1).length}, with more ${reach.filter(n => n > 1).length},`
      + ` with none ${reach.filter(n => n === 0).length}`);

    // 2. their cards, and which record each card belongs to
    for (const kind of BOARDS_ON) {
      const { board, idCol } = BOARD[kind];
      const ids = [...records[kind]];
      const seen = new Set();
      let unsure = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        const d = await monday(BY_ID, { b: board, c: idCol, v: part });
        for (const it of d.items_page_by_column_values?.items ?? [])
          if (!seen.has(it.id)) { seen.add(it.id); cards.push({ kind, card: it.id }); }
        const by = cardsByRecord(d.items_page_by_column_values, part);
        if (by) for (const [id, cs] of by) recordCards.set(`${kind}:${id}`, cs);
        else unsure += part.length;
      }
      console.log(`${kind}: ${seen.size} cards to check${unsure ? `; the cards of ${unsure} record(s) are not known for sure`
        + " (a lookup page did not end, or a card's ID read as another) -- their groups are held" : ""}`);
    }
  }
  plan.activities = activities;

  // A FIXED ORDER, so `--start` means the same card in every run (search result order is not guaranteed).
  cards.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  if (FROM) cards = cards.filter(c => keyOf(c) >= FROM);

  // ------------------------------------------------------------------ 3. each card's timeline
  const TIMELINE = `query ($i: ID!, $c: String) { timeline(id: $i) { timeline_items_page(limit: 100, cursor: $c) {
  cursor timeline_items { id type custom_activity_id title content created_at item { id } } } } }`;
  /** Every distinct entry, guarding monday's overlapping pages and a cursor that stops advancing. */
  async function timeline(card) {
    const rows = new Map(); const cursors = new Set(); let cursor = null;
    for (let p = 0; p < 200; p++) {
      const d = await monday(TIMELINE, { i: card, c: cursor });
      const page = d.timeline?.timeline_items_page;
      if (!page) return { rows, complete: false, why: "no-page" };
      for (const e of page.timeline_items ?? []) rows.set(e.id, e);
      cursor = page.cursor ?? null;
      if (!cursor) return { rows, complete: true };
      if (cursors.has(cursor)) return { rows, complete: false, why: "repeated-cursor" };
      cursors.add(cursor);
    }
    return { rows, complete: false, why: "page-budget" };
  }

  // Ids widened from \d+ for the marketing poller's event keys (random strings + created). Those entries are
  // then skipped by NOT_RESTORABLE, but they must still COUNT as markers, so an entry carrying one is never
  // mistaken for a marker-less one.
  const MARKER = /\[hubspot:([a-z_]+):([A-Za-z0-9_-]+)\]/g;
  const HEADER = /^(From|To|Direction|HubSpot owner|Sequence \d+)/;
  /** The body a rep reads: content minus the header lines and the marker line (plan-email-cleanup.mjs). */
  const bodyOf = c => String(c ?? "").split("\n")
    .filter(l => l.trim() && !HEADER.test(l.trim()) && !/^\[hubspot:/.test(l.trim())).join(" ").trim();
  const shownLines = c => new Set(String(c ?? "").split("\n").map(l => l.trim()).filter(Boolean));
  /** What the user sees. The timeline id is NOT part of it -- it is expected to differ. */
  const fingerprint = e => createHash("sha256").update(JSON.stringify({
    type: e.type ?? "", custom: e.custom_activity_id ?? "",
    title: String(e.title ?? ""), content: String(e.content ?? ""), ts: String(e.created_at ?? ""),
  })).digest("hex").slice(0, 16);
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /**
   * The deletions one read of a card supports. Pure: the same rows give the same plan, which is what lets
   * --apply recompute it from a fresh read and delete only what both reads agree on.
   */
  function planCard(card, rows) {
    // `classes`: per marker with a group, the classes behind it, for the keeper checks in --apply. Never saved:
    // the report keeps the group ({ keep, identical, bodyless }), which names the same ids.
    const out = { groups: [], divergent: [], foreignItem: 0, guardTripped: 0, classes: new Map() };
    const byMarker = new Map();
    for (const e of rows.values()) {
      if (String(e.item?.id ?? "") !== String(card)) { out.foreignItem++; continue; }   // another item's entry
      if (e.type !== "custom") continue;                                                  // native: a person's own
      const ms = [...String(e.content ?? "").matchAll(MARKER)];
      if (ms.length !== 1) continue;                                                      // none, or ambiguous
      const object = ms[0][1];
      if (NOT_RESTORABLE.has(object)) continue;                                           // no restore path
      if (!TYPES.includes(object)) continue;                                              // outside --types
      if (e.custom_activity_id !== OUR_TYPE[object]) continue;                            // not our type for it
      (byMarker.get(ms[0][0]) ?? byMarker.set(ms[0][0], []).get(ms[0][0])).push(e);
    }
    for (const [marker, es] of byMarker) {
      if (es.length < 2) continue;
      const classes = new Map();
      for (const e of es) { const fp = fingerprint(e); (classes.get(fp) ?? classes.set(fp, []).get(fp)).push(e); }
      const cls = [...classes.values()].map(c => c.sort(byId))
        .map(c => ({ keep: c[0], extras: c.slice(1), body: bodyOf(c[0].content), lines: shownLines(c[0].content) }))
        .sort((a, b) => byId(a.keep, b.keep));
      const identical = cls.flatMap(c => c.extras.map(e => e.id));
      const withBody = cls.filter(c => c.body);
      const bodyless = [];
      const coveredBy = new Map();                      // a bodyless class's keeper id -> every body class covering it
      for (const c of cls) {
        if (c.body) continue;
        const covers = withBody.filter(b => String(b.keep.title ?? "") === String(c.keep.title ?? "")
          && String(b.keep.created_at ?? "") === String(c.keep.created_at ?? "")
          && [...c.lines].every(l => b.lines.has(l)));
        if (covers.length) { bodyless.push(c.keep.id); coveredBy.set(c.keep.id, covers); }   // its extras are already in `identical`
      }
      const doomed = new Set([...identical, ...bodyless]);
      const kept = es.map(e => e.id).filter(id => !doomed.has(id)).sort();
      if (!kept.length) { out.guardTripped++; continue; }                   // never the last copy
      const survivors = cls.filter(c => !doomed.has(c.keep.id));
      if (survivors.length > 1)
        out.divergent.push({ marker, classes: survivors.length, keep: kept, bodyChars: survivors.map(c => c.body.length) });
      if (doomed.size) {
        out.groups.push({ marker, keep: kept, identical, bodyless });
        // ids: the class's copies, lowest first (ids[0] is the planned keeper); doomed: a bodyless class that goes
        // whole; covers: the indexes (in this list) of the body classes that justify that.
        out.classes.set(marker, cls.map(c => ({ ids: [c.keep.id, ...c.extras.map(e => e.id)],
          doomed: coveredBy.has(c.keep.id), covers: (coveredBy.get(c.keep.id) ?? []).map(b => cls.indexOf(b)) })));
      }
    }
    return out;
  }

  const todo = cards.slice(START, START + (Number.isFinite(LIMIT) ? LIMIT : cards.length));
  {
    const n = INCLUDE_CLEANED ? 0 : todo.filter(c => cleaned.has(String(c.card))).length;
    if (n) console.log(`${n} of the ${todo.length} card(s) in this run are already cleaned and will be skipped`);
  }
  let finished = 0;
  let stopReason = null;
  let canaryUsed = false;
  let canaryInfo = null;                              // the canary's card and group, for its line after the final check
  /** First Ctrl-C: the delayed checks stop waiting and run at once (early: they settle nothing). */
  let hurry = false;
  let lastSendAt = 0;                                 // the run's last delete sent (ms), for the final check
  const inflight = new Set();
  /** The lowest card index not yet finished: everything below it is done, whatever order they ended in. */
  const resumeAt = () => START + (inflight.size ? Math.min(...inflight) : next);
  /** The same point as a card key, for --from: survives the card list changing between runs. */
  const resumeKey = () => { const c = todo[resumeAt() - START]; return c ? keyOf(c) : undefined; };
  const save = () => writeWhole(out, JSON.stringify({ ...plan, totalCards: cards.length, start: START }, null, 2));
  const DELETE = `mutation ($id: String!) { delete_timeline_item(id: $id) { id } }`;
  // From here a writing run can save its report, so the first Ctrl-C stops it like any stop and the second quits.
  if (APPLY || CANARY) {
    let interrupts = 0;
    onInterrupt = () => {
      if (++interrupts > 1) {
        save();
        console.log("\nquitting now: the deletes in flight are NOT checked afterwards, and the delayed keeper checks do not run."
          + ` The next run checks them at its start, or: node scripts/dedupe-timeline.mjs --verify ${out}`);
        process.exit(130);
      }
      stopReason ??= "interrupted (Ctrl-C)";
      hurry = true;
      console.log("\nCtrl-C: no new delete will be sent; the ones in flight are answered and checked, and the delayed keeper checks"
        + " run now (early, so they settle nothing: the next run checks those groups again), then the report is saved."
        + " Ctrl-C again to quit at once -- the deletes in flight will then NOT be checked afterwards.");
    };
  }

  /** ONE incompleteCards row per card: a second reason is added to the first row, not counted as another card. */
  const incompleteByCard = new Map();
  function incomplete(kind, card, why, seenExtras) {
    const r = incompleteByCard.get(String(card));
    if (r) { r.why += `; ${why}`; r.seenExtras = Math.max(r.seenExtras ?? 0, seenExtras ?? 0); return; }
    const row = { kind, card, why, seenExtras };
    incompleteByCard.set(String(card), row);
    plan.incompleteCards.push(row);
  }

  /**
   * KEEPER CHECK, BEFORE A CARD'S DELETES (see the header). `both` is what both reads agree may go. Returns
   * `send`, the ids that may really be sent (in the plan's order); `byMarker`, per group with something to send,
   * the keepers that must still resolve afterwards; and `unsure`, the groups a check could not settle.
   */
  async function keepersBefore(kind, card, entry, p2, both) {
    const goSet = new Set(both);
    const groups = [...p2.classes].filter(([, cls]) => cls.some(c => c.ids.some(id => goSet.has(id))));
    const results = new Array(groups.length);
    for (let i = 0; i < groups.length; i += DELETE_PARALLEL)
      await Promise.all(groups.slice(i, i + DELETE_PARALLEL).map(async ([marker, cls], k) => {
        results[i + k] = await checkGroup(kind, card, entry, marker, cls, goSet);
      }));
    const allowed = new Set(results.flatMap(r => r.allowed));
    return { send: both.filter(id => allowed.has(id)), unsure: results.filter(r => r.unsure).length,
      byMarker: new Map(results.filter(r => r.allowed.length).map(r => [r.marker, r])) };
  }

  /**
   * One marker's classes (from the re-read): each class that stays keeps its lowest id that RESOLVES, so a ghost
   * keeper is replaced by a real copy of the same class, which is then kept, not deleted. Its findings are
   * written onto the report's group (entry.groups, the first read's; it names every id sent): outcome, keepers,
   * rechosen, held, unconfirmed.
   */
  async function checkGroup(kind, card, entry, marker, cls, goSet) {
    const g = entry.groups.find(x => x.marker === marker) ?? {};
    const G = cls.flatMap(c => c.ids).filter(id => goSet.has(id));
    const seen = [...new Set([...cls.flatMap(c => c.ids), ...[].concat(g.keep ?? [], g.identical ?? [], g.bodyless ?? [])])].sort();
    const notFound = [];
    /** The first copy of a class that resolves; null = none does; "unknown" = a check could not tell. */
    const firstReal = async c => {
      for (const id of c.ids) {
        const s = await resolveSure(id);
        if (s === "present") return id;
        if (s === "unknown") return "unknown";
        notFound.push(id);
      }
      return null;
    };
    // Per class: the copy it keeps (undefined for a bodyless class that goes whole).
    const real = [];
    for (const c of cls) real.push(c.doomed ? undefined : await firstReal(c));
    const isReal = j => typeof real[j] === "string" && real[j] !== "unknown";
    const keepers = cls.map((_, j) => j).filter(isReal).map(j => real[j]);
    const unsure = real.includes("unknown");
    if (!keepers.length) {
      // No copy this run would keep exists: nothing of the group is deleted. Before calling it missing, is a bodyless
      // copy (a class that was due to go) still there? Then only the body is gone, and restore would skip the pair.
      let bodyless = null, bodylessUnsure = false;
      if (!unsure) for (const c of cls) {
        if (!c.doomed) continue;
        const k = await firstReal(c);
        if (k === "unknown") { bodylessUnsure = true; break; }
        if (k) { bodyless = k; break; }
      }
      Object.assign(g, { held: G });
      plan.heldByKeeperCheck += G.length;
      if (bodyless) {
        Object.assign(g, { outcome: "body-missing", bodylessLeft: bodyless, notFound });
        plan.bodyMissing++;
        console.log(`BODY MISSING: ${kind} card ${card} ${marker}: no body copy resolves (${notFound.join(", ")}), the bodyless`
          + ` ${bodyless} does -- nothing deleted, not handed off (a copy is there)`);
      } else if (unsure || bodylessUnsure) {
        g.outcome = "keeper-unconfirmed";
        plan.keeperUnconfirmed++;
      } else {
        g.outcome = "keeper-missing";
        plan.keeperMissing++;
        handOff({ kind, card, marker, outcome: "keeper-missing", knownIds: seen, notFound, sent: [], deleted: [],
          note: "before any delete: no copy of this marker resolves by id, bodyless ones included; nothing of this group was deleted" });
        console.log(`KEEPER MISSING: ${kind} card ${card} ${marker}: none of ${notFound.join(", ")} resolves -- nothing deleted, handed off`);
      }
      return { marker, allowed: [], unsure: unsure || bodylessUnsure };
    }
    const spare = new Set();
    cls.forEach((c, j) => {
      // A bodyless class goes only beside a real body copy that covers it.
      if (c.doomed) { if (!c.covers.some(isReal)) c.ids.forEach(id => spare.add(id)); return; }
      // No copy of this class resolves, or a check could not tell: none of it goes.
      if (!isReal(j)) { c.ids.forEach(id => spare.add(id)); return; }
      spare.add(real[j]);
      if (real[j] !== c.ids[0]) (g.rechosen ??= []).push({ ghost: c.ids[0], keeper: real[j] });
    });
    const allowed = G.filter(id => !spare.has(id));
    const held = G.filter(id => spare.has(id));
    g.keepers = keepers;
    // One class could not be told, another has a real keeper: the rest goes, but the group was not fully checked.
    if (unsure) { g.unconfirmed = true; plan.keeperPartlyUnconfirmed++; }
    if (held.length) { g.held = held; plan.heldByKeeperCheck += held.length; }
    if (g.rechosen) plan.keeperRechosen += g.rechosen.length;
    return { marker, allowed, keepers, seen, g, unsure };
  }

  /**
   * KEEPER CHECK, AFTER DELETES: every keeper of a group that had a delete sent must still resolve. `phase`: batch
   * (after each batch of deletes, before the next goes out), card (after the card's last), late (--late-check
   * seconds on) or final (the end of the run). One that no longer resolves makes the group keeper-lost (-late when
   * found late or final), handed off at once; past --max-lost the run stops deleting.
   */
  let haltedOnLost = false;
  function testLost() {
    if (plan.keeperLost > MAX_LOST && !haltedOnLost) {
      haltedOnLost = true;
      stopReason ??= `keeper-lost ${plan.keeperLost} > --max-lost ${MAX_LOST}`;
      console.log(`\nHALT: ${plan.keeperLost} group(s) keeper-lost, more than --max-lost ${MAX_LOST} -- no further delete is sent.`
        + ` Hand-off for restore-timeline-entries.mjs --census: ${lostOut}`);
    }
  }
  async function keepersAfter(kind, card, entry, ms, phase) {
    const sent = sentOf(entry);
    const list = ms.filter(m => m.keepers && !m.lost && m.allowed.some(id => sent.has(id)));
    for (let i = 0; i < list.length; i += DELETE_PARALLEL)
      await Promise.all(list.slice(i, i + DELETE_PARALLEL).map(m => keeperAfter(kind, card, entry, m, phase, sent)));
    testLost();
  }
  async function keeperAfter(kind, card, entry, m, phase, sent) {
    const states = await Promise.all(m.keepers.map(id => resolveSure(id)));
    const at = Date.now();
    const lastSent = Date.parse(entry.lastSentAt ?? "") || at;
    const lost = m.keepers.filter((_, j) => states[j] === "absent");
    const later = phase === "late" || phase === "final";
    m.g.lastCheck = { phase, at: new Date(at).toISOString(), secondsAfterLastDelete: Math.round((at - lastSent) / 1000),
      state: lost.length ? "lost" : states.includes("unknown") ? "unknown" : "ok" };
    if (lost.length) {
      m.lost = true;
      const outcome = later ? "keeper-lost-late" : "keeper-lost";
      const sentHere = m.allowed.filter(id => sent.has(id));
      const deleted = new Set(entry.deleted ?? []), ghosts = new Set(entry.alreadyGone ?? []);
      Object.assign(m.g, { outcome, lostKeepers: lost, settled: "lost" });
      plan.keeperLost++;
      if (later) plan.keeperLostLate++;
      handOff({ kind, card, marker: m.marker, outcome, knownIds: m.seen, keepers: m.keepers, lostKeepers: lost,
        sent: sentHere, deleted: sentHere.filter(id => deleted.has(id)), alreadyGone: sentHere.filter(id => ghosts.has(id)), foundBy: `${phase} check`,
        note: later ? `${phase} check, ${m.g.lastCheck.secondsAfterLastDelete} s after the card's last delete: a copy this run kept`
            + " (and that resolved at the checks before) no longer resolves"
          : "after this run's deletes: a copy it kept (and had resolved just before) no longer resolves" });
      console.log(`KEEPER LOST${later ? ` (${phase} check, ${m.g.lastCheck.secondsAfterLastDelete} s after)` : ""}: ${kind} card ${card} ${m.marker}:`
        + ` kept ${lost.join(", ")} no longer resolves after ${sentHere.length} delete(s) (${plan.keeperLost} this run, --max-lost ${MAX_LOST})`);
      return;
    }
    if (states.includes("unknown")) {
      m.g.outcome = "keeper-unverified";
      // Unknown at the last check the run makes: hand it off as "unknown", for --verify and a person.
      if (phase === "final" && !m.unknownHandedOff) {
        m.unknownHandedOff = true;
        plan.toVerify.push({ kind, card, marker: m.marker, keepers: m.keepers });
        handOff({ kind, card, marker: m.marker, state: "unknown", outcome: "keeper-unverified", knownIds: m.seen, keepers: m.keepers,
          sent: m.allowed.filter(id => sent.has(id)), foundBy: "final check",
          note: `a lookup of a kept copy could not tell, 3 tries at the final check -- run --verify ${basename(out)}` });
      }
      return;
    }
    m.g.outcome = m.g.unconfirmed ? "keeper-ok-partial" : "keeper-ok";
    // Settled only by a check a while after the deletes, and only while the lookup is trusted.
    if (!plan.lookupNotAuthoritative && at >= lastSent + SETTLED_MS) m.g.settled = "ok";
  }

  /**
   * THE LOOKUP, CHECKED: an id delete_timeline_item just answered OK for must no longer resolve (asked up to 4 times
   * over ~9 s, in case monday lags). "absent" proves timeline_item tells a just-deleted, still-listed entry from a
   * real one; "present" means it cannot, and every keeper check would be blind.
   */
  async function goneAfterDelete(id) {
    let s;
    for (let t = 0; t < 4; t++) {
      if (t) await sleep(1500 * t);
      s = await entryById(id);
      if (s === "absent") return s;
    }
    return s;
  }
  function notAuthoritative(kind, card, entry, checks, id) {
    if (!plan.lookupNotAuthoritative) {
      stopReason = `timeline_item is not authoritative: ${id} on ${kind} card ${card} was deleted (monday answered OK) and still resolves`;
      console.log(`\nHALT: ${stopReason}. No further delete is sent; the keeper checks cannot tell a ghost from a real copy,`
        + " so this card is handed off for a person to look at.");
    }
    (plan.lookupNotAuthoritative ??= []).push({ kind, card, id });
    if (entry.handedOffUnchecked) return;
    entry.handedOffUnchecked = true;
    const sent = sentOf(entry);
    for (const m of checks.byMarker.values()) if (m.allowed.some(x => sent.has(x)))
      handOff({ kind, card, marker: m.marker, state: "unknown", outcome: "lookup-not-authoritative", knownIds: m.seen, keepers: m.keepers,
        sent: m.allowed.filter(x => sent.has(x)),
        note: `timeline_item still resolved ${id} after monday answered OK to deleting it: the keeper checks cannot be trusted on this card -- look at it in monday` });
  }
  /**
   * UNTIL ONE DELETE HAS PROVED THE LOOKUP, ONE DELETE AT A TIME, on one card at a time: a card waits while another
   * card's single delete is being proved, then either goes on at DELETE_PARALLEL or proves it itself with one.
   */
  const lookup = { proved: false, pending: null };
  async function batchGate() {
    while (!lookup.proved && lookup.pending) await lookup.pending;
    if (lookup.proved) return { size: DELETE_PARALLEL, release: () => {} };
    let done;
    lookup.pending = new Promise(r => { done = r; });
    return { size: 1, release: () => { lookup.pending = null; done(); } };
  }

  /** Cards with a delete sent, for the final check; the late queue (see the header). */
  const relied = [];
  const lateQueue = [];
  let workersDone = false;
  async function lateChecker() {
    while (!workersDone) {
      const i = lateQueue.findIndex(x => hurry || x.due <= Date.now());
      if (i < 0) { await sleep(250); continue; }
      const [x] = lateQueue.splice(i, 1);
      try { await keepersAfter(x.kind, x.card, x.entry, x.ms, "late"); save(); }
      catch (e) {
        if (e?.abort) stopReason ??= `aborted: ${String(e.message).slice(0, 160)}`;
        else console.log(`note: the late check of ${x.kind} card ${x.card} failed (the final check covers it): ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  }

  /**
   * THE SINGLE-DESTINATION RULE ON ONE CARD'S PLAN (destinationVerdict, at the top). Every group gets its verdict
   * (group.singleDestination: "allow" or why it is held), counted in plan.singleDestination. Enforced
   * (--single-destination), the held groups leave the plan and are listed on the card as heldBySingleDestination,
   * so the re-read, the keeper checks and the deletes never see them. In a dry run without the flag, only counted.
   */
  async function judge(kind, card, p) {
    const sd = plan.singleDestination;
    const held = [], allowed = new Set();
    for (const g of p.groups) {
      const dest = await destinationsFor(g.marker);
      for (const r of dest?.[kind] ?? []) await cardsFor(kind, r);
      const v = destinationVerdict({ kind, card, marker: g.marker, dest, elsewhere,
        cardsOf: (k, r) => recordCards.get(`${k}:${r}`) });
      const n = g.identical.length + g.bodyless.length;
      g.singleDestination = v.reason;
      if (v.allow) { allowed.add(g.marker); sd.allowedGroups++; sd.allowedEntries += n; continue; }
      sd.heldGroups++; sd.heldEntries += n; sd.heldByReason[v.reason] = (sd.heldByReason[v.reason] ?? 0) + 1;
      const { allow, reason, ...why } = v;
      // The activity's destination records as step 1 read them (at most 10 per board), for a person to check.
      const destinations = dest ? Object.fromEntries(DESTINATION_KINDS.filter(k => dest[k].size)
        .map(k => [k, [...dest[k]].sort().slice(0, 10)])) : undefined;
      held.push({ ...g, ...why, destinations });
    }
    if (SINGLE) keepAllowed(p, allowed);
    return { held: SINGLE ? held : [], allowed };
  }

  async function checkCard({ kind, card }) {
    // Already cleaned by an earlier applied run: not read, not counted as checked (see the header).
    if (!INCLUDE_CLEANED && cleaned.has(String(card))) { plan.skippedCleaned++; return; }
    const first = await timeline(card);
    plan.cardsChecked++;
    const p = planCard(card, first.rows);
    plan.foreignItemEntries += p.foreignItem;
    plan.guardTripped += p.guardTripped;
    if (!first.complete) {
      // Nothing is decided from a partial timeline. Saved by id, with what was seen, for --retry.
      incomplete(kind, card, first.why, p.groups.flatMap(g => [...g.identical, ...g.bodyless]).length);
      return;
    }
    // THE SINGLE-DESTINATION RULE: enforced, only the groups it allows stay in the plan.
    const sd = await judge(kind, card, p);
    const del = p.groups.flatMap(g => [...g.identical, ...g.bodyless]);
    if (p.divergent.length) plan.divergentMarkers += p.divergent.length;
    if (!del.length && !p.divergent.length && !sd.held.length) return;
    const entry = { kind, card, groups: p.groups, ...(p.divergent.length ? { divergent: p.divergent } : {}),
      ...(sd.held.length ? { heldBySingleDestination: sd.held } : {}) };
    plan.cards.push(entry);
    if (!del.length) return;
    plan.cardsWithDuplicates++;
    plan.entriesToDelete += del.length;
    plan.identicalExtras += p.groups.reduce((s, g) => s + g.identical.length, 0);
    plan.bodylessExtras += p.groups.reduce((s, g) => s + g.bodyless.length, 0);
    plan.byBoard[kind] = (plan.byBoard[kind] ?? 0) + del.length;
    for (const g of p.groups) {
      const t = g.marker.split(":")[1];
      plan.byType[t] = (plan.byType[t] ?? 0) + g.identical.length + g.bodyless.length;
    }
    if (!APPLY) {
      if (CANARY) {
        const g = p.groups[0];
        console.log(`\nCANARY (dry run) would delete ${[...g.identical, ...g.bodyless][0]} on ${kind} card ${card}`
          + ` (board ${BOARD[kind]?.board ?? "?"}) marker ${g.marker}, keeping ${g.keep.join(", ")}`);
        stopReason ??= "canary";
      }
      return;
    }
    if (!BOARD[kind]) {
      // A --retry row with no kind whose board could not be read: a loss here could not be handed off (restore
      // needs the kind), so nothing is deleted on it.
      entry.notApplied = "kind unknown";
      incomplete(kind, card, "kind unknown: the card's board could not be read, so nothing is deleted on it", del.length);
      return;
    }
    if (stopReason) {
      // The run is stopping (an abort on another card, keeper-lost past --max-lost, Ctrl-C). This card was sent
      // nothing, so it stays fresh: a --from resume covers it, and it is listed for --retry as well.
      entry.notApplied = `run stopped: ${stopReason}`;
      incomplete(kind, card, "run stopped before its deletes", del.length);
      return;
    }

    // RE-READ, RECOMPUTE, INTERSECT. Fail closed on anything short of a complete fresh read.
    let again;
    try { again = await timeline(card); }
    catch (e) { again = { complete: false, why: `re-read failed: ${String(e).slice(0, 100)}` }; if (e?.abort) throw e; }
    if (!again.complete) {
      entry.notApplied = again.why;
      incomplete(kind, card, `re-read before delete: ${again.why}`, del.length);
      return;
    }
    const p2 = planCard(card, again.rows);
    // The same rule on the re-read: a marker the first read's verdicts did not allow is dropped from it whole.
    keepAllowed(p2, sd.allowed);
    const still = new Set(p2.groups.flatMap(g => [...g.identical, ...g.bodyless]));
    const both = del.filter(id => still.has(id));
    const dropped = del.filter(id => !still.has(id));
    if (dropped.length) { entry.noLongerQualifying = dropped; plan.noLongerQualifying += dropped.length; }

    // KEEPER CHECK, BEFORE: only what both reads agree on AND whose class keeps a copy that resolves goes out.
    const checks = await keepersBefore(kind, card, entry, p2, both);
    const go = checks.send;
    const ms = [...checks.byMarker.values()];
    if (checks.unsure)
      incomplete(kind, card, `keeper check could not tell for ${checks.unsure} group(s)`, both.length - go.length);
    if (go.length) relied.push({ kind, card, entry, ms });
    /**
     * DELETES RUN A FEW AT A TIME. Measured 2026-09-27: a timeline page costs 102 of monday's 10,000,000
     * per-minute complexity budget, so the run was never budget-bound -- it was latency-bound, ~2.5 s per
     * call, one after another. Each delete targets one id that BOTH reads agreed on, so their order does
     * not matter. The canary keeps the one-at-a-time path below: it deletes exactly one entry.
     * Each batch is written into entry.deleting and SAVED before it is sent, so a run killed mid-card still
     * says what it may have deleted. After each batch: every id deleted is looked up (it must be gone), then the
     * keepers of the batch's groups; a stop (abort, keeper-lost past --max-lost, a lookup that is not
     * authoritative, Ctrl-C) sends no further batch.
     */
    if (!CANARY) {
      let abortErr = null;
      let i = 0;
      while (i < go.length && !abortErr) {
        const gate = await batchGate();
        try {
          if (stopReason) {
            entry.notApplied = `run stopped: ${stopReason}`;
            if (i) entry.stoppedDuringDeletes = true;
            incomplete(kind, card, `run stopped ${i ? "during" : "before"} its deletes`, go.length - i);
            break;
          }
          const batch = go.slice(i, i + gate.size);
          i += batch.length;
          (entry.deleting ??= []).push(...batch);
          entry.lastSentAt = new Date().toISOString();
          lastSendAt = Date.now();
          save();
          const ok = [];
          await Promise.all(batch.map(async id => {
            try { await monday(DELETE, { id }); plan.deleted++; (entry.deleted ??= []).push(id); ok.push(id); }
            catch (e) {
              // NOT_FOUND = already gone (monday's listing can briefly still show an entry just deleted): the
              // goal state, counted apart so real failures stand out.
              if (/NOT_FOUND|Timeline item not found/.test(String(e))) {
                plan.alreadyGone = (plan.alreadyGone ?? 0) + 1; (entry.alreadyGone ??= []).push(id); return;
              }
              plan.deleteFailed++; (entry.failed ??= []).push({ id, error: String(e).slice(0, 160) });
              if (e?.abort) abortErr ??= e;
            }
          }));
          if (abortErr) break;
          // THE LOOKUP, CHECKED: every id just deleted must be gone.
          await Promise.all(ok.map(async id => {
            const s = await goneAfterDelete(id);
            if (s === "absent") { plan.lookupProvedBy++; lookup.proved = true; }
            else if (s === "unknown") plan.lookupUnknown++;
            else notAuthoritative(kind, card, entry, checks, id);
          }));
          // KEEPER CHECK, PER BATCH: the groups this batch deleted from, before the next batch goes out.
          const inBatch = new Set(batch);
          await keepersAfter(kind, card, entry, ms.filter(m => m.allowed.some(id => inBatch.has(id))), "batch");
          save();
        } finally { gate.release(); }
      }
      if (abortErr) { save(); throw abortErr; }
      // KEEPER CHECK, AFTER THE CARD: every group that had a delete sent; then again, --late-check seconds on.
      if (entry.deleting?.length) {
        await keepersAfter(kind, card, entry, ms, "card");
        lateQueue.push({ kind, card, entry, ms, due: Date.parse(entry.lastSentAt) + LATE_MS });
      }
    }
    for (const id of CANARY ? go : []) {
      if (canaryUsed) break;
      if (stopReason) {
        // A Ctrl-C (or any stop) during this card's re-read or keeper check: the one delete does not go out either.
        entry.notApplied = `run stopped: ${stopReason}`;
        incomplete(kind, card, "run stopped before its deletes", go.length);
        break;
      }
      canaryUsed = true;                                 // taken before the await: one delete, whatever else runs
      (entry.deleting ??= []).push(id);
      entry.lastSentAt = new Date().toISOString();
      lastSendAt = Date.now();
      save();
      let ok = false;
      try { await monday(DELETE, { id }); plan.deleted++; (entry.deleted ??= []).push(id); ok = true; }
      catch (e) {
        plan.deleteFailed++; (entry.failed ??= []).push({ id, error: String(e).slice(0, 160) });
        if (e?.abort) { save(); throw e; }
      }
      // The one delete proves the lookup, or shows that it cannot be trusted.
      let lookupSaid = "not asked (the delete did not answer OK)";
      if (ok) {
        const s = await goneAfterDelete(id);
        if (s === "absent") { plan.lookupProvedBy++; lookup.proved = true; lookupSaid = "absent, as it must be (timeline_item tells a just-deleted entry from a real one)"; }
        else if (s === "unknown") { plan.lookupUnknown++; lookupSaid = "COULD NOT TELL -- run the canary again before a full run"; }
        else { notAuthoritative(kind, card, entry, checks, id); lookupSaid = "STILL RESOLVES -- timeline_item is NOT authoritative: do not run the dedupe"; }
      }
      // The canary stops after ONE delete, so this card's other extras are still there: list the card for
      // --retry, or a resumed run starting after it would never come back to them.
      if (go.length > 1) incomplete(kind, card, "canary stopped after one delete", go.length - 1);
      await keepersAfter(kind, card, entry, ms, "card");
      const g = p2.groups.find(x => x.identical.includes(id) || x.bodyless.includes(id));
      const m = ms.find(x => x.allowed.includes(id));
      canaryInfo = { kind, card, id, m };
      console.log(`\nCANARY: ${entry.failed ? "tried to delete" : "deleted"} ${id} on ${kind} card ${card}`
        + ` (board ${BOARD[kind]?.board ?? "?"}) marker ${g?.marker} -- ${g?.bodyless.includes(id) ? "bodyless beside a body copy" : "identical copy"};`
        + ` kept ${m?.keepers.join(", ")}${m?.g.rechosen ? ` (re-chosen: ${m.g.rechosen.map(r => `${r.ghost} is a ghost`).join(", ")})` : ""};`
        + ` timeline_item of the deleted id: ${lookupSaid}; keeper check right after the delete: ${m?.g.outcome ?? "not run"}.`
        + ` The final keeper check follows ${FINAL_MS / 1000} s after the delete. Open the card's Emails & Activities in monday and check before a full run.`);
      stopReason ??= "canary";
      break;
    }
    save();
  }

  /**
   * THE FINAL CHECK: --final-check seconds after the run's last delete, every keeper of every group the run sent a
   * delete for (and has not already found lost) is resolved once more. A first Ctrl-C cuts the wait short: the check
   * runs at once, early, and settles nothing.
   */
  async function finalCheck() {
    const items = [];
    for (const r of relied) {
      const sent = sentOf(r.entry);
      for (const m of r.ms) if (m.keepers && !m.lost && m.allowed.some(id => sent.has(id))) items.push({ ...r, m, sent });
    }
    if (!items.length) return;
    const due = lastSendAt + FINAL_MS;
    if (Date.now() < due && !hurry) {
      console.log(`\nfinal keeper check: waiting ${Math.ceil((due - Date.now()) / 1000)} s (--final-check ${FINAL_MS / 1000} after the last delete),`
        + ` then resolving the keepers of ${items.length} group(s) again. Ctrl-C checks them now.`);
      while (Date.now() < due && !hurry) await sleep(250);
    }
    const early = Date.now() < due;
    const lost0 = plan.keeperLost;
    let unknown = 0;
    for (let i = 0; i < items.length; i += VERIFY_PARALLEL) {
      await Promise.all(items.slice(i, i + VERIFY_PARALLEL).map(async x => {
        await keeperAfter(x.kind, x.card, x.entry, x.m, "final", x.sent);
        if (x.m.g.outcome === "keeper-unverified") unknown++;
      }));
      testLost();
      if ((i / VERIFY_PARALLEL) % 25 === 24) save();
    }
    plan.finalCheck = { at: new Date().toISOString(), groups: items.length, secondsAfterLastDelete: Math.round((Date.now() - lastSendAt) / 1000),
      early: early || undefined, lost: plan.keeperLost - lost0, unknown };
    save();
  }

  // Up to 16 cards at once: the monday budget allows far more (see the note at the deletes); 2 stays the
  // default so a run never starts aggressive by accident, and the canary is always 1.
  const CONCURRENCY = CANARY ? 1 : Math.min(Math.max(Number(arg("--concurrency", 2)) || 2, 1), 16);
  let next = 0;
  async function worker() {
    while (!stopReason && next < todo.length) {
      const i = next++;
      inflight.add(i);
      try { await checkCard(todo[i]); }
      catch (e) {
        plan.erroredCards.push({ kind: todo[i].kind, card: todo[i].card, error: String(e).slice(0, 160) });
        if (e?.abort) stopReason ??= `aborted: ${String(e.message).slice(0, 160)}`;
      }
      inflight.delete(i);
      finished++;
      if (finished % 250 === 0) { plan.nextStart = resumeAt(); plan.nextKey = resumeKey(); save(); }
      if ((i + 1) % 250 === 0)
        console.log(`  ${START + i + 1}/${cards.length} cards  skipped-cleaned ${plan.skippedCleaned}  dup-cards ${plan.cardsWithDuplicates}`
          + `  extras ${plan.entriesToDelete}  single-destination allow ${plan.singleDestination.allowedGroups}`
          + ` hold ${plan.singleDestination.heldGroups}${APPLY ? `  deleted ${plan.deleted}  keeper-missing ${plan.keeperMissing}`
            + `  keeper-lost ${plan.keeperLost} (late ${plan.keeperLostLate})` : ""}`);
    }
  }
  const late = APPLY ? lateChecker() : Promise.resolve();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  workersDone = true;
  await late;
  plan.nextStart = stopReason ? resumeAt() : START + todo.length;
  plan.nextKey = stopReason ? resumeKey() : undefined;
  save();
  if (APPLY) {
    try { await finalCheck(); }
    catch (e) {
      plan.finalCheck = { error: String(e?.message ?? e).slice(0, 160) };
      console.log(`the final keeper check failed (${plan.finalCheck.error}) -- the next run checks those groups at its start, or --verify ${out}`);
    }
  }

  // Totals from the groups themselves: the outcome each one ended with.
  for (const e of plan.cards) {
    const sent = sentOf(e);
    for (const g of e.groups ?? []) {
      if (g.outcome === "keeper-ok") plan.keeperOk++;
      else if (g.outcome === "keeper-ok-partial") plan.keeperOkPartial++;
      else if (g.outcome === "keeper-unverified") plan.keeperUnverified++;
      if (![].concat(g.identical ?? [], g.bodyless ?? []).some(id => sent.has(String(id)))) continue;
      if (g.settled) plan.settledGroups++;
      else plan.unsettledGroups++;
    }
  }
  plan.done = !stopReason; plan.stopReason = stopReason ?? undefined;
  save();
  const fc = plan.finalCheck;
  console.log(`\ncards checked ${plan.cardsChecked}, with duplicates ${plan.cardsWithDuplicates}, extra entries ${plan.entriesToDelete}`
    + ` (identical ${plan.identicalExtras}, bodyless beside a body ${plan.bodylessExtras}) ${JSON.stringify(plan.byBoard)} ${JSON.stringify(plan.byType)}`
    + `\ndivergent markers kept ${plan.divergentMarkers}, incomplete cards ${plan.incompleteCards.length}, card errors ${plan.erroredCards.length}`
    + `${plan.foreignItemEntries ? `, entries of another item ignored ${plan.foreignItemEntries}` : ""}`
    + `${plan.guardTripped ? `, LAST-COPY GUARD TRIPPED ${plan.guardTripped} (a bug -- look before applying)` : ""}`
    + `\nalready-cleaned cards skipped ${plan.skippedCleaned}${INCLUDE_CLEANED ? " (--include-cleaned: none skipped)" : ""}`
    + (plan.earlierCheck ? `\nearlier runs' unsettled groups checked ${plan.earlierCheck.groups}: LOST ${plan.earlierCheck.lost},`
        + ` could not tell ${plan.earlierCheck.unknown}, still to settle ${plan.earlierCheck.unsettled}` : "")
    + (APPLY ? `\ndeleted ${plan.deleted}, failed ${plan.deleteFailed}, no longer qualifying at the re-read ${plan.noLongerQualifying}`
        + `${plan.alreadyGone ? `, already gone ${plan.alreadyGone}` : ""}`
        + `\nkeeper checks -- before: keeper-missing ${plan.keeperMissing} (nothing deleted, handed off), body-missing ${plan.bodyMissing}`
        + ` (only a bodyless copy resolves; nothing deleted), keeper-unconfirmed ${plan.keeperUnconfirmed}, partly unconfirmed`
        + ` ${plan.keeperPartlyUnconfirmed}, ghost keepers re-chosen ${plan.keeperRechosen}, ids held back ${plan.heldByKeeperCheck};`
        + `\n  after: KEEPER-LOST ${plan.keeperLost} (found late ${plan.keeperLostLate}; --max-lost ${MAX_LOST}), keeper-ok ${plan.keeperOk},`
        + ` keeper-ok-partial ${plan.keeperOkPartial}, keeper-unverified ${plan.keeperUnverified};`
        + ` deleted ids looked up and gone ${plan.lookupProvedBy}, could not tell ${plan.lookupUnknown}`
        + `${plan.lookupNotAuthoritative ? `, STILL RESOLVING AFTER THE DELETE ${plan.lookupNotAuthoritative.length} (timeline_item is not authoritative)` : ""}`
        + `\n  final check: ${fc?.groups ? `${fc.groups} group(s), ${fc.secondsAfterLastDelete} s after the last delete${fc.early ? " (EARLY: Ctrl-C)" : ""},`
            + ` lost ${fc.lost}, could not tell ${fc.unknown}` : fc?.error ? `FAILED (${fc.error})` : "nothing to check"}`
        + `; groups settled ${plan.settledGroups}, not settled ${plan.unsettledGroups}${plan.unsettledGroups ? " (the next run checks them at its start)" : ""}`
             : `\n(dry run -- nothing deleted; --apply ${SINGLE_DESTINATION} deletes what the single-destination rule allows)`));
  {
    const sdp = plan.singleDestination;
    const why = Object.entries(sdp.heldByReason).filter(([, n]) => n).map(([r, n]) => `${r} ${n}`).join(", ") || "none";
    console.log(`single-destination rule (${SINGLE ? `ENFORCED: only the groups it allows were planned${APPLY ? " and sent" : ""}`
      : `NOT enforced -- a dry run without ${SINGLE_DESTINATION}, so the plan above is the old rule's`}):`
      + ` allows ${sdp.allowedGroups} group(s) / ${sdp.allowedEntries} entr${sdp.allowedEntries === 1 ? "y" : "ies"},`
      + ` holds ${sdp.heldGroups} group(s) / ${sdp.heldEntries} entr${sdp.heldEntries === 1 ? "y" : "ies"} (${why})`);
  }
  if (canaryInfo)
    console.log(`CANARY final keeper check${fc?.secondsAfterLastDelete != null ? `, ${fc.secondsAfterLastDelete} s after the delete${fc.early ? " (early: Ctrl-C)" : ""}` : ""}:`
      + ` ${canaryInfo.m?.g.outcome ?? "not run"} (kept ${canaryInfo.m?.keepers?.join(", ") ?? "?"})`);
  if (lostRows.length)
    console.log(`${lostRows.length} group(s) handed off (${lostRows.filter(r => r.state === "LOST").length} LOST,`
      + ` ${lostRows.filter(r => r.state !== "LOST").length} could not tell) -- restore with:`
      + ` node scripts/restore-timeline-entries.mjs --census ${lostOut}`);
  if (plan.toVerify.length || plan.unsettledGroups)
    console.log(`check the keepers again later with: node scripts/dedupe-timeline.mjs --verify ${out}`);
  // Cards stopped part-way through their deletes count as cleaned (deletes were sent), so a --from resume skips them.
  const sentCards = new Set(plan.cards.filter(c => sentOf(c).size).map(c => String(c.card)));
  const partly = plan.incompleteCards.filter(c => sentCards.has(String(c.card))).map(keyOf);
  if (stopReason)
    console.log(`stopped: ${stopReason}; resume with --from ${plan.nextKey ?? "(end)"}`
      + (partly.length ? ` -- that covers the cards not yet sent a delete; ${partly.length} card(s) had deletes sent and stopped part-way`
        + ` (${partly.slice(0, 8).join(", ")}${partly.length > 8 ? ", ..." : ""}), which --from skips as cleaned: re-check those, if at all,`
        + ` with --retry ${out} --include-cleaned` : ""));
  if (plan.incompleteCards.length || plan.erroredCards.length || plan.deleteFailed) {
    // A card this report shows a delete sent for counts as cleaned from now on, so its re-check needs --include-cleaned.
    const needs = plan.deleteFailed || [...plan.incompleteCards, ...plan.erroredCards].some(c => sentCards.has(String(c.card)));
    console.log(`re-check the unfinished cards with: --retry ${out}`
      + (needs ? " --include-cleaned (some had deletes sent, so a plain run skips them as cleaned)" : ""));
  }
  console.log(`report: ${out}`);
}

// Run only when invoked, so the pure rules above can be imported by the tests without side effects.
const invoked = process.argv[1] ? resolve(process.argv[1]) : "", self = fileURLToPath(import.meta.url);
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) await main();
