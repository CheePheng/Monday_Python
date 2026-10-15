/**
 * CATCH UP THE monday NOTES AND CALLS THAT NOTHING RANG FOR. Dry run unless --apply.
 *
 * Why this exists. A rep's native Note or Call on a Contacts card reaches HubSpot only when a wake-up
 * column changes (webhooks.ts ACTIVITY_WAKE_COLS). Automations #09/#10 were switched off at
 * 2026-09-30T09:00:42Z, and until the bell workflow 1940472437 stamped the Activity bell (date_mm7pw446),
 * nothing rang (and a Call summary still does not ring a Note-only bell):
 * ~28 notes and calls a day stopped reaching HubSpot. This finds the Contacts cards that have such
 * entries since --since and, with --apply, asks the Worker to read them (POST /wake-timeline) -- the
 * same syncMondayTimeline a ring runs, so an entry already pushed is found in the durable registry and
 * nothing is created twice. Repeating a run is safe.
 *
 * HOW IT FINDS CARDS, AND WHAT IT CANNOT SEE. monday has no board-wide query for timeline entries and
 * records NO board activity-log line for one (verified 2026-09-30: card 2859742407's 09:22:16 note left
 * none). So cards are CANDIDATES from read-only signals, and each candidate's own timeline is then read
 * to see whether it really has an eligible native entry (no custom activity id, type note or "activity"
 * = Call summary, not a marketing entry) created since --since:
 *   board-log        any Contacts activity-log event since --since (a rep's edit, a bell ring) -- NOT the
 *                    integration user's, whose thousands of forward writes say nothing about a rep's note
 *   recent-activity  cards where Last Activity Date / the bell was stamped by an automation or a person
 *                    in the --lookback-days before --since: where Emails & Activities entries were being
 *                    created -- reps' current cards
 *   updated-at       (--scan-updated) every card whose updated_at >= --since. Reads the whole board
 *                    (~96k cards, ~200 pages), and it is UNVERIFIED whether a timeline entry moves
 *                    updated_at at all -- a widening, not a guarantee
 *   --items a,b,c    explicit cards
 * Read in that order of trust: --items, then recent-activity (reps' current cards), then board-log, so
 * --max-reads is never spent on the noisiest signal first. Each card's timeline is read the way the
 * Worker reads it (TIMELINE_PAGE entries a page, up to TIMELINE_MAX_PAGES, newest first) -- a card
 * listed here is one syncMondayTimeline reaches; the report still marks any the Worker answered
 * nothing-to-sync for (`workerFoundNothing`).
 * NOT FOUND: an entry on a card that no signal above touched. The report says how many candidates each
 * signal gave, so the size of what is left to chance is visible rather than implied away.
 *
 *   node scripts/wake-timelines.mjs                         # dry run: lists cards, calls nothing
 *   node scripts/wake-timelines.mjs --apply                 # POST /wake-timeline, 20 cards a request
 *                   WRITES HUBSPOT (notes and calls) even when the Worker's DRY_RUN / WRITE_HUBSPOT say
 *                   otherwise: the activity push is gated by ENABLE_ACTIVITY_SYNC alone, like a ring
 *   options: --since ISO (default 2026-09-30T09:00:00Z)   --lookback-days N (default 7)
 *            --scan-updated   --items a,b,c   --max-reads N (timeline reads, default 3000)
 *            --out FILE       the report (default docs/rollout/...)
 *
 * Needs MONDAY_API_TOKEN (and for --apply TRIGGER_SECRET) in worker/.dev.vars. Sends monday queries
 * only, never a mutation; the only write is the Worker's, behind --apply. Prints no secrets. The
 * report goes to docs/rollout/<date>-wake-timelines-<plan|applied>.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTACTS_BOARD = "5028000495";
export const DEFAULT_SINCE = "2026-09-30T09:00:00Z";
/** Last Activity Date and the Activity bell -- webhooks.ts ACTIVITY_WAKE_COLS. */
export const WAKE_COLS = ["date_mm7054jz", "date_mm7pw446"];
/** The monday user the Worker writes as (lib/repair-preflight.mjs); its own stamps say nothing about reps. */
export const INTEGRATION_USER_ID = "104118038";
export const BATCH = 20;
/** activity-sync.ts TIMELINE_PAGE / TIMELINE_MAX_PAGES: read a timeline exactly as the Worker does. */
export const TIMELINE_PAGE = 25;
export const TIMELINE_MAX_PAGES = 4;
/** monday's native types the Worker pushes (activities.ts HUBSPOT_OBJECT_FOR_NATIVE). */
const NATIVE_TYPES = new Set(["note", "activity"]);

/** Mirrors activities.ts eligibleForHubspot: never one of our entries, never a marketing marker. */
export function eligibleNative(e) {
  if (!e || e.custom_activity_id) return false;
  if (/\[hubspot:marketing_email[a-z_]*:/.test(String(e.content ?? ""))) return false;
  return NATIVE_TYPES.has(String(e.type ?? ""));
}
/** The eligible native entries created at or after `sinceMs`. */
export const nativeSince = (entries, sinceMs) =>
  (entries ?? []).filter(e => eligibleNative(e) && Date.parse(e.created_at) >= sinceMs);

/** The item ids in activity-log rows, optionally only rows for these columns and not by this user. */
export function itemIdsFromLogs(logs, { columns, excludeUser } = {}) {
  const out = new Set();
  for (const l of logs ?? []) {
    if (excludeUser && String(l.user_id) === String(excludeUser)) continue;
    let d; try { d = JSON.parse(l.data); } catch { continue; }
    if (columns && !columns.includes(String(d?.column_id ?? ""))) continue;
    const id = String(d?.pulse_id ?? "");
    if (/^\d+$/.test(id)) out.add(id);
  }
  return out;
}
export const batches = (ids, n = BATCH) => Array.from({ length: Math.ceil(ids.length / n) }, (_, i) => ids.slice(i * n, i * n + n));

// ------------------------------------------------------------------------------------------ I/O
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const v = {};
  for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const APPLY = argv.includes("--apply");
  const SINCE = arg("--since", DEFAULT_SINCE);
  const sinceMs = Date.parse(SINCE);
  if (!Number.isFinite(sinceMs)) { console.error("--since needs an ISO instant"); process.exit(2); }
  const LOOKBACK_MS = (Number(arg("--lookback-days", 7)) || 0) * 86_400_000;
  const MAX_READS = Number(arg("--max-reads", 3000)) || 3000;
  const M = v.MONDAY_API_TOKEN, T = v.TRIGGER_SECRET;
  const WORKER = (v.CRM_WORKER_URL || "https://hubspot-monday-crm-sync.askada.workers.dev").replace(/\/+$/, "");
  if (!M) { console.error("needs MONDAY_API_TOKEN in worker/.dev.vars"); process.exit(1); }
  if (APPLY && !T) { console.error("--apply needs TRIGGER_SECRET in worker/.dev.vars"); process.exit(1); }

  async function md(query, variables = {}) {
    if (/^\s*mutation/i.test(query)) throw new Error("refusing a mutation");
    for (let attempt = 0; ; attempt++) {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { Authorization: M, "Content-Type": "application/json", "API-Version": "2024-10" },
        body: JSON.stringify({ query, variables }) });
      const j = await r.json().catch(() => ({}));
      const err = JSON.stringify(j.errors ?? j.error_message ?? "");
      if ((r.status === 429 || /complexity|rate.?limit|budget/i.test(err)) && attempt < 8) { await sleep(15_000 * (attempt + 1)); continue; }
      if (!r.ok || j.errors || j.error_message) throw new Error(`monday ${r.status}: ${err.slice(0, 200)}`);
      return j.data;
    }
  }
  async function logs(fromIso, toIso, columnIds) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const d = await md(`query ($b: [ID!], $f: ISO8601DateTime, $t: ISO8601DateTime, $p: Int, $c: [String]) {
        boards(ids: $b) { activity_logs(from: $f, to: $t, limit: 1000, page: $p, column_ids: $c) { data user_id created_at } } }`,
        { b: [CONTACTS_BOARD], f: fromIso, t: toIso, p: page, c: columnIds ?? null });
      const rows = d?.boards?.[0]?.activity_logs ?? [];
      out.push(...rows);
      if (rows.length < 1000) return { rows: out, complete: true };
    }
    return { rows: out, complete: false };
  }

  const signals = {};
  const candidates = new Set();
  const add = (name, ids) => { signals[name] = ids.size; for (const id of ids) candidates.add(id); };
  const nowIso = new Date().toISOString();
  // Most trusted first: the candidates are read in insertion order, and --max-reads may stop the walk.
  if (argv.includes("--items"))
    add("items", new Set(String(arg("--items", "")).split(/[,\s]+/).filter(x => /^\d+$/.test(x))));
  // activity_logs come back NEWEST FIRST, so a walk stopped at 100 pages has dropped the OLDEST events.
  if (LOOKBACK_MS > 0) {
    const back = await logs(new Date(sinceMs - LOOKBACK_MS).toISOString(), SINCE, WAKE_COLS);
    add("recent-activity", itemIdsFromLogs(back.rows, { columns: WAKE_COLS, excludeUser: INTEGRATION_USER_ID }));
    if (!back.complete) console.log("  recent-activity: stopped at 100 pages -- the OLDEST events of the lookback are not read; shorten --lookback-days");
  }
  const recent = await logs(SINCE, nowIso);
  add("board-log", itemIdsFromLogs(recent.rows, { excludeUser: INTEGRATION_USER_ID }));
  if (!recent.complete) console.log("  board-log: stopped at 100 pages -- the OLDEST events since --since are not read");
  if (argv.includes("--scan-updated")) {
    const ids = new Set();
    let cursor = null, pages = 0;
    do {
      const d = cursor
        ? await md(`query ($c: String!) { next_items_page(limit: 500, cursor: $c) { cursor items { id updated_at } } }`, { c: cursor })
        : await md(`query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 500) { cursor items { id updated_at } } } }`, { b: [CONTACTS_BOARD] });
      const page = cursor ? d.next_items_page : d.boards[0].items_page;
      for (const it of page.items) if (Date.parse(it.updated_at) >= sinceMs) ids.add(String(it.id));
      cursor = page.cursor;
      if (++pages % 40 === 0) console.log(`  scan-updated: ${pages} pages, ${ids.size} moved`);
    } while (cursor);
    add("updated-at", ids);
  }
  console.log(`since ${SINCE}: candidates ${candidates.size} ${JSON.stringify(signals)}`);

  // Read each candidate's own timeline: is there really something native since --since?
  const found = {};
  let reads = 0, unreadable = 0;
  const list = [...candidates];
  for (let i = 0; i < list.length && reads < MAX_READS; i += 5) {
    await Promise.all(list.slice(i, i + 5).map(async it => {
      reads++;
      try {
        // The Worker's read (syncMondayTimeline): same page size, same page bound, newest first.
        const entries = [];
        let cursor = null;
        for (let p = 0; p < TIMELINE_MAX_PAGES; p++) {
          const d = await md(`query ($i: ID!, $l: Int, $c: String) { timeline(id: $i) { timeline_items_page(limit: $l, cursor: $c) {
            cursor timeline_items { id type created_at custom_activity_id content user { id } } } } }`,
            { i: it, l: TIMELINE_PAGE, c: cursor });
          const page = d?.timeline?.timeline_items_page;
          const items = page?.timeline_items ?? [];
          entries.push(...items);
          cursor = page?.cursor ?? null;
          if (!cursor || !items.length || items.some(e => Date.parse(e.created_at) < sinceMs)) break;
        }
        const hits = nativeSince(entries, sinceMs);
        if (hits.length) found[it] = hits.map(e => ({ id: e.id, type: e.type, at: e.created_at, by: e.user?.id }));
      } catch { unreadable++; }
    }));
    await sleep(100);
  }
  const cards = Object.keys(found);
  console.log(`timelines read ${reads}${reads < list.length ? ` of ${list.length} (--max-reads)` : ""}, unreadable ${unreadable};`
    + ` cards with native entries since ${SINCE}: ${cards.length} (${Object.values(found).flat().length} entries)`);
  for (const c of cards.slice(0, 20)) console.log(`  ${c}  ${found[c].map(e => `${e.type}@${e.at}`).join(", ")}`);
  console.log("NOT FOUND by design: entries on cards no signal touched (monday logs no event for a timeline entry)."
    + (argv.includes("--scan-updated") ? "" : " --scan-updated widens this, if updated_at moves for an entry (unverified)."));

  const date = new Date().toISOString().slice(0, 10);
  let out = argv.includes("--out") ? resolve(arg("--out"))
    : join(ROOT, "..", "docs", "rollout", `${date}-wake-timelines-${APPLY ? "applied" : "plan"}.json`);
  if (existsSync(out)) out = out.replace(/\.json$/, `-${nowIso.slice(11, 19).replace(/:/g, "")}.json`);
  const report = { since: SINCE, apply: APPLY, signals, candidates: candidates.size, reads, unreadable, found, results: {} };
  if (APPLY && cards.length) {
    for (const b of batches(cards)) {
      const r = await fetch(`${WORKER}/wake-timeline`, { method: "POST",
        headers: { "Content-Type": "application/json", "x-trigger-secret": T }, body: JSON.stringify({ itemIds: b }) });
      if (r.status === 404) { console.error("the Worker has no /wake-timeline route -- deploy the new build first"); break; }
      if (!r.ok) { console.error(`/wake-timeline answered ${r.status}; stopping`); break; }
      const j = await r.json();
      Object.assign(report.results, j.results ?? {});
      console.log(`  woke ${Object.keys(report.results).length}/${cards.length}`);
    }
  }
  if (APPLY) {
    // Found here, "nothing" there: the two reads disagree (a filter drifted, or the card changed between).
    report.workerFoundNothing = cards.filter(c => /nothing-to-sync/.test(String(report.results[c] ?? "")));
    if (report.workerFoundNothing.length)
      console.log(`  ${report.workerFoundNothing.length} card(s) listed here were nothing-to-sync for the Worker: ${report.workerFoundNothing.slice(0, 10).join(", ")}`);
  }
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`report: ${out}${APPLY ? "" : "\n(dry run -- nothing was called; add --apply to wake these cards)"}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
