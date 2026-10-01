/**
 * BRING EXISTING CARDS IN LINE WITH HUBSPOT, THROUGH THE WORKER ITSELF. Dry run unless --apply.
 *
 * Why this exists. Cards written by older builds carry values today's build would never write:
 * 7,094 of 8,632 Deals showed the Close Date one day early (no localDate until 2026-09-23), 525 Deals
 * "Last interaction" and 113 Accounts "Created date" likewise; Deals Created date was empty on 8,654
 * cards, P&S Net price on 9,965, the P&S derived Account link on 9,786; Accounts Last Activity Date was
 * stale on 5,974. A card is only rewritten when its record next changes in HubSpot, so none of these
 * heal by themselves.
 *
 * How. Every id goes to POST /resync with forceForward:true (false with --no-force) -- the Worker's own engine, which writes
 * ONLY the columns that differ, never moves a card between groups, never writes HubSpot (column-level
 * specs only), and applies today's rules (localDate, peopleClear, the seatless-owner rule). With
 * dryRun:true the same engine runs with every write suppressed and answers what it WOULD do, so the dry
 * run is sized by the code that will perform the repair, not by a re-implementation of it.
 *
 * NOT for People columns (scripts/resync-people-columns.mjs does those far more cheaply) and not for
 * missing cards (catchup-after-deploy.mjs cards), though the Worker may card a record the new gate
 * allows. Both dry run and --apply need the NEW build (the dryRun flag does not exist on the old one)
 * and TRIGGER_SECRET in worker/.dev.vars.
 *
 * Scale: one request carries up to 10 ids and costs the Worker ~3 reads + the writes per id. Deals
 * (~8.7k) and P&S (~10k) take a few hours at the default pace; run one object at a time, never beside
 * another repair (they share one monday API budget), and after the automation question is settled --
 * a bulk forward write can wake monday automations that watch those columns.
 *
 *   node scripts/refresh-forward.mjs --object deals                  # dry run, whole board
 *   node scripts/refresh-forward.mjs --object deals --apply
 *   node scripts/refresh-forward.mjs --object contacts --no-force --ids-file stale.txt   # see below
 *   options: --ids 1,2,3 | --ids-file f.txt   only these records (an empty list is refused, never "all")
 *            --no-force   send forceForward:false -- the ORDINARY sync, exactly what a webhook runs: it
 *                         writes a card only when HubSpot changed since its Sync State, so it does not
 *                         revert a person's pending monday edit UNLESS HubSpot has itself changed since
 *                         the card's last sync -- then it forwards every differing column, that edit's
 *                         included, as any webhook would. Right for records a dropped webhook left stale
 *                         (scripts/find-stale-lad.mjs lists them); forceForward is for drift the old
 *                         engine stamped over, and would overwrite pending edits on these regardless.
 *            --after ID   resume after record ID (the report's lastDoneId) -- by id, so a record merged
 *                         or deleted between runs cannot shift the list and skip one
 *            --batch N    ids per request, 1-10 (default 5)      --limit N   stop after N records
 *            --parallel N requests in flight, 1-16 (default 1)
 *            --timeout-min N  client wait per request, 1-60 (default 15)
 *            --skip-done R    skip ids report R (same object and mode) already settled; send the rest,
 *                             including its failures -- the way to resume a run that had errors
 *   The report lists every id's answer, and tallies them by the engine's own action word
 *   (updated-monday, skipped-in-sync, created-monday, ...), so the dry run says what --apply would change.
 *
 * The report is saved after every batch to docs/rollout/<date>-refresh-<object>-<plan|applied>.json.
 * No credential or secret-bearing URL is ever printed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as fetchWithAgent } from "undici";
import { DEFAULT_CRM_WORKER_URL, requireNewBuild } from "./lib/repair-preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const H = v.HUBSPOT_CRM_APP_TOKEN, T = v.TRIGGER_SECRET;
// No trailing slash: "…workers.dev//resync" is not the route and would 404 every request.
const WORKER = (v.CRM_WORKER_URL || DEFAULT_CRM_WORKER_URL).replace(/\/+$/, "");
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
/** A flag that is present must carry a value: a trailing `--ids` must never widen the run to everything. */
const need = k => {
  const x = arg(k);
  if (x === undefined || x === "" || String(x).startsWith("--")) { console.error(`${k} needs a value`); process.exit(2); }
  return x;
};
for (const k of ["--object", "--ids", "--ids-file", "--after", "--batch", "--limit", "--parallel", "--timeout-min", "--skip-done"]) if (argv.includes(k)) need(k);
const APPLY = argv.includes("--apply");
/** forceForward unless --no-force. Recorded in the report, and --skip-done refuses to mix the two. */
const FORCE = !argv.includes("--no-force");
const OBJECT = arg("--object");
const OBJECTS = ["contacts", "companies", "deals", "line_items"];
if (!OBJECTS.includes(OBJECT)) { console.error(`--object must be one of ${OBJECTS.join("|")}`); process.exit(2); }
if (!H) { console.error("missing HUBSPOT_CRM_APP_TOKEN in .dev.vars"); process.exit(1); }
if (!T) { console.error("needs TRIGGER_SECRET in .dev.vars (the value set on the CRM Worker) -- dry run too"); process.exit(1); }
const BATCH = Math.min(Math.max(Number(arg("--batch", 5)) || 5, 1), 10);
/**
 * Requests in flight at once (1-8, default 1). Measured 2026-09-27: one request at a time did ~6 records a
 * minute (each id costs the Worker a few monday calls at ~2.5 s each), so Deals alone took a day. Batches
 * hold DIFFERENT ids, and each id is one card, so parallel batches never touch the same card.
 */
const PARALLEL = Math.min(Math.max(Number(arg("--parallel", 1)) || 1, 1), 16);
/**
 * Client wait per request (--timeout-min, default 15, max 60). Measured 2026-09-27: with writes a request
 * of 5 deals often ran past the old 280 s limit (165 of the first 260 answered TimeoutError), and a request
 * the client gives up on is cancelled inside the Worker. The wait is set on the CONNECTION too: Node's fetch
 * otherwise abandons any answer slower than 300 s whatever the signal says (UND_ERR_HEADERS_TIMEOUT).
 */
const TIMEOUT_MS = Math.min(Math.max(Number(arg("--timeout-min", 15)) || 15, 1), 60) * 60_000;
const LONG_WAIT = new Agent({ headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });
const AFTER = argv.includes("--after") ? need("--after") : null;
if (AFTER !== null && !/^\d+$/.test(AFTER)) { console.error("--after needs a record id"); process.exit(2); }
const LIMIT = Number(arg("--limit", 0)) || Infinity;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Both modes: the dryRun flag and forceForward exist only on the new build.
try { await requireNewBuild(WORKER); }
catch (e) { console.error(`refusing to run: ${e.message}`); process.exit(1); }

async function hs(path, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${H}` } });
  if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2500 * (attempt + 1)); return hs(path, attempt + 1); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`hubspot ${path.split("?")[0]}: ${r.status}`);
  return j;
}

// ------------------------------------------------------------------ the ids, sorted, so --start is stable
let ids;
if (argv.includes("--ids") || argv.includes("--ids-file")) {
  const raw = argv.includes("--ids") ? need("--ids") : readFileSync(need("--ids-file"), "utf8");
  ids = raw.split(/[,\s]+/).filter(x => /^\d+$/.test(x));
  if (!ids.length) { console.error("no numeric ids in the list -- refusing to fall back to the whole board"); process.exit(2); }
} else {
  ids = [];
  let after;
  do {   // the LIST endpoint: search stops at 10,000 without saying so
    const r = await hs(`/crm/v3/objects/${OBJECT}?limit=100&properties=hs_object_id${after ? `&after=${after}` : ""}`);
    for (const x of r.results ?? []) ids.push(String(x.id));
    after = r.paging?.next?.after;
  } while (after);
}
ids = [...new Set(ids)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
/**
 * --skip-done <report>: leave out the ids an earlier run of the SAME object and mode already settled, and
 * send everything else -- the ids it never reached AND the ones that failed or were cut off. "Settled" is
 * an engine action word that is not a failure; anything unrecognised is sent again (a forward refresh
 * only writes what differs, so a repeat is harmless, a skip is not).
 */
if (argv.includes("--skip-done")) {
  const prev = JSON.parse(readFileSync(need("--skip-done"), "utf8"));
  if (prev.object !== OBJECT) { console.error(`--skip-done: that report is for ${prev.object}, not ${OBJECT}`); process.exit(2); }
  if (Boolean(prev.apply) !== APPLY) {
    console.error(`--skip-done: that report is ${prev.apply ? "an --apply run" : "a dry run"}; this run is ${APPLY ? "--apply" : "a dry run"}`);
    process.exit(2);
  }
  // Reports from before --no-force existed were all forced.
  if ((prev.force ?? true) !== FORCE) {
    console.error(`--skip-done: that report was ${prev.force ?? true ? "forced" : "--no-force"}; this run is ${FORCE ? "forced" : "--no-force"}`);
    process.exit(2);
  }
  const settled = o => /\baction=/.test(String(o)) && !/^(error|request-failed)|\baction=(error|unresolved|deferred|failed)|timeout/i.test(String(o));
  const done = new Set(Object.entries(prev.results ?? {}).filter(([, o]) => settled(o)).map(([id]) => id));
  const before = ids.length;
  ids = ids.filter(id => !done.has(id));
  console.log(`--skip-done: ${before - ids.length} already settled in that report, ${ids.length} to send`);
}
const rest = AFTER === null ? ids : ids.filter(id => BigInt(id) > BigInt(AFTER));
const todo = rest.slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);
console.log(`${OBJECT}: ${ids.length} records; this run ${todo.length}${AFTER ? ` after ${AFTER}` : ""}  ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`
  + `  ${FORCE ? "forceForward" : "--no-force (ordinary sync)"}`);

// ------------------------------------------------------------------ send
const startedAt = new Date().toISOString();
let out = join(ROOT, "..", "docs", "rollout",
  `${startedAt.slice(0, 10)}-refresh-${OBJECT}${FORCE ? "" : "-noforce"}-${APPLY ? "applied" : "plan"}${AFTER ? `-after${AFTER}` : ""}.json`);
if (existsSync(out)) out = out.replace(/\.json$/, `-${startedAt.slice(11, 19).replace(/:/g, "")}.json`);   // never overwrite
const report = { object: OBJECT, apply: APPLY, force: FORCE, startedAt, total: ids.length, after: AFTER ?? undefined,
  lastDoneId: AFTER ?? undefined, tally: {}, errors: [], results: {} };
/** The engine's own action word: /resync answers with its log line "[webhook] source=.. id=.. action=<a> ..". */
const outcomeOf = o => /\baction=(\S+)/.exec(String(o ?? ""))?.[1] ?? String(o ?? "").split(/[:\s]/)[0];
const save = () => writeFileSync(out, JSON.stringify(report, null, 2));

/** A status that is the same for every id ends the run: retrying it per id is only noise. */
const FATAL = new Set([400, 401, 403, 404, 409]);
async function post(batch, attempt = 0) {
  const r = await fetchWithAgent(`${WORKER}/resync`, { method: "POST", dispatcher: LONG_WAIT,
    headers: { "Content-Type": "application/json", "x-trigger-secret": T },
    body: JSON.stringify({ object: OBJECT, ids: batch, forceForward: FORCE, dryRun: !APPLY }),
    signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (FATAL.has(r.status)) { const e = new Error(`/resync answered ${r.status}`); e.fatal = true; throw e; }
  if (!r.ok) {
    if (attempt < 3) { await sleep(10_000 * (attempt + 1)); return post(batch, attempt + 1); }
    throw new Error(`/resync answered ${r.status} after retries`);
  }
  const j = await r.json();
  if (j.dryRun !== !APPLY) { const e = new Error("the Worker did not honour dryRun -- stopping"); e.fatal = true; throw e; }
  return j.results ?? {};
}

try {
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  /**
   * lastDoneId is the end of the unbroken run of FINISHED batches from the start -- not simply the last batch
   * to answer. With several in flight they finish out of order, and --after <lastDoneId> must never step
   * past a batch that is still unanswered when the run stops.
   */
  const finished = new Array(batches.length).fill(false);
  let next = 0, prefix = -1, answered = 0, fatal = null;
  const worker = async () => {
    while (!fatal && next < batches.length) {
      const b = next++, batch = batches[b];
      let res;
      try { res = await post(batch); }
      catch (e) {
        if (e.fatal) { fatal ??= e; return; }
        res = Object.fromEntries(batch.map(id => [id, `request-failed: ${String(e).slice(0, 80)}`]));
      }
      for (const [id, o] of Object.entries(res)) {
        const k = outcomeOf(o);
        report.tally[k] = (report.tally[k] ?? 0) + 1;
        report.results[id] = String(o).slice(0, 300);
        if (/^(error|request-failed)/.test(String(o))) report.errors.push({ id, result: String(o).slice(0, 200) });
      }
      finished[b] = true;
      while (prefix + 1 < batches.length && finished[prefix + 1]) prefix++;
      if (prefix >= 0) report.lastDoneId = batches[prefix][batches[prefix].length - 1];
      save();
      if (answered++ % 20 === 0) console.log(`  ${Object.keys(report.results).length}/${todo.length}  ${JSON.stringify(report.tally)}`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (fatal) throw fatal;
  report.done = true;
} catch (e) {
  report.stoppedBecause = String(e.message ?? e);
  console.error(`stopped: ${report.stoppedBecause} (resume with --after ${report.lastDoneId ?? "(none yet)"})`);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`\n${JSON.stringify(report.tally)}  errors ${report.errors.length}`
    + (report.errors.length ? `\nre-send the errored ids with --ids-file (they are listed in report.errors)` : "")
    + `\nreport: ${out}`
    + (APPLY ? "" : "\n(dry run -- the Worker wrote nothing; add --apply to write)"));
  if (report.stoppedBecause) process.exit(1);
}
