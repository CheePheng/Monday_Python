/**
 * CATCH UP WHAT THE OLD CRM ENGINE REFUSED, BY ASKING THE NEW ONE TO DO IT. Read-only unless --apply.
 *
 * Two gaps the 2026-09-23 build closes going forward, but cannot close backwards on its own:
 *
 *   cards       HubSpot records with no monday card. The old creation gate carded only records created
 *               after the CRM cutover, so new leads created by forms and imports in between never got one.
 *   activities  HubSpot activities the old cutover rule dropped. It judged an activity by hs_timestamp
 *               alone, so an email CREATED after ACTIVITY_CUTOVER_AT but dated earlier (an inbox import)
 *               was refused: 819 emails on 2026-09-23.
 *
 * This script only FINDS them. Every write is made by the deployed Worker through /resync and
 * /resync-activity -- the same code a webhook runs, with the card registry's dedup and, for activities,
 * verifyExisting plus the durable reservation -- so a re-run is safe and never writes a second copy.
 *
 * MUST RUN ONLY AFTER THE NEW WORKER IS DEPLOYED: the routes do not exist on the old build. --apply
 * refuses unless the new build answers (lib/repair-preflight.mjs requireNewBuild, which probes /resync
 * without the secret).
 *
 * A REQUEST THAT CANNOT SUCCEED ENDS THE RUN. A 400 (a body the route rejects), 401/403 (the wrong
 * TRIGGER_SECRET -- the WM one, say), 404 (the route is not deployed) or 409 "activity sync is off" is
 * the same answer for every id, so the run stops at the first one, saves the report and exits non-zero,
 * instead of re-sending each id alone (~1,600 doomed requests for the 819 emails). Only a 5xx, 429 or
 * network failure is retried id by id, and an id that still fails is recorded, never dropped.
 *
 * THE REPORT IS WRITTEN AS IT GOES -- after every batch, with lastSentAt -- so an aborted or cut-off run
 * still says exactly which ids were sent and what the Worker answered. It never overwrites an earlier
 * report: when today's name is taken, the time is appended. --retry <report.json> re-sends
 * the ids whose answer was not a settled outcome (created / created-monday / updated-monday / skipped /
 * skipped-in-sync / adopted- / already...): unresolved, creating, blocked, error, request-failed, and
 * ids the run never reached. Run it at least 15 MINUTES after the report's last send: a reservation the
 * Worker left standing (it never releases one whose write may have landed) goes stale only after
 * RESERVE_STALE_MS = 15 min (src/activity-registry.ts), and before that the same ids answer "creating"
 * again. --apply refuses an earlier retry.
 *
 *   node scripts/catchup-after-deploy.mjs cards                       # dry run: records with no card
 *   node scripts/catchup-after-deploy.mjs cards --apply
 *   node scripts/catchup-after-deploy.mjs activities                  # dry run: the refused activities
 *   node scripts/catchup-after-deploy.mjs activities --apply
 *   node scripts/catchup-after-deploy.mjs activities --retry <report.json> [--apply]   # >= 15 min later
 *   options:  --since <ISO>   cards: records created from here (default 2026-09-16T00:00:00Z)
 *             --objects a,b   cards: contacts,companies,deals (default) / line_items allowed
 *                             activities: emails,calls,meetings,notes (default)
 *                             --retry: only these objects of the report
 *             --all           activities: every activity since the cutover, not just the refused ones
 *             --batch <n>     ids per Worker request, 1-10 (default 5)
 *             --parallel <n>  requests in flight at once, 1-8 (default 1)
 *
 * Needs in worker/.dev.vars: HUBSPOT_CRM_APP_TOKEN, MONDAY_API_TOKEN, and for --apply TRIGGER_SECRET
 * (CRM_WORKER_URL optional). No credential or secret-bearing URL is ever printed.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as fetchWithAgent } from "undici";
import { DEFAULT_CRM_WORKER_URL, requireNewBuild } from "./lib/repair-preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const H = v.HUBSPOT_CRM_APP_TOKEN, M = v.MONDAY_API_TOKEN, T = v.TRIGGER_SECRET;
// No trailing slash: "…workers.dev//resync" is not the route and would 404 every request.
const WORKER = (v.CRM_WORKER_URL || DEFAULT_CRM_WORKER_URL).replace(/\/+$/, "");
const MODE = process.argv[2];
const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RETRY = arg("--retry", null);
if (MODE !== "cards" && MODE !== "activities") {
  console.error("usage: node scripts/catchup-after-deploy.mjs cards|activities [--apply] [--since ISO] [--objects a,b] [--all] [--batch n] [--retry report.json]");
  process.exit(2);
}
if (process.argv.includes("--retry") && (!RETRY || RETRY.startsWith("--"))) {
  console.error("--retry needs the path of an earlier catch-up report"); process.exit(2);
}
if (!H || !M) { console.error("missing HUBSPOT_CRM_APP_TOKEN or MONDAY_API_TOKEN in .dev.vars"); process.exit(1); }
if (APPLY && !T) { console.error("--apply needs TRIGGER_SECRET in .dev.vars (the value set on the CRM Worker)"); process.exit(1); }

/**
 * ACTIVITY_CUTOVER_AT, the instant the deployed CRM Worker judges activities by. It is NOT in
 * wrangler.jsonc `vars`: on this Worker it is passed with `--var` on the deploy command, so this constant
 * must match the value in that command, and the two must be kept in sync -- if the deployed value moved,
 * the "refused" set below would be wrong without any error. It is also the Task poller's seed
 * (TASK_POLL_SEED in src/task-poller.ts), so that file is read as a cross-check.
 */
const ACTIVITY_CUTOVER = "2026-09-16T11:16:48Z";
{
  let seed = null;
  try { seed = /TASK_POLL_SEED\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "src", "task-poller.ts"), "utf8"))?.[1] ?? null; }
  catch { /* unreadable: reported below */ }
  if (!seed) console.log("note: could not read TASK_POLL_SEED from src/task-poller.ts to cross-check ACTIVITY_CUTOVER");
  else if (seed !== ACTIVITY_CUTOVER) {
    console.error(`${APPLY ? "refusing --apply" : "WARNING"}: ACTIVITY_CUTOVER here is ${ACTIVITY_CUTOVER} but TASK_POLL_SEED `
      + `(== ACTIVITY_CUTOVER_AT) is ${seed} -- confirm the value on the deploy command and fix whichever is wrong`);
    if (APPLY) process.exit(1);
  }
}
const SINCE = arg("--since", "2026-09-16T00:00:00Z");
const BATCH = Math.min(Math.max(Number(arg("--batch", 5)) || 5, 1), 10);
/** Requests in flight at once (1-8). Each id holds its own reservation in the Worker, so parallel sends of
 *  DIFFERENT ids cannot collide; one id is never in two batches. */
const PARALLEL = Math.min(Math.max(Number(arg("--parallel", 1)) || 1, 1), 8);
/** Client wait per request (--timeout-min, default 15, max 120). The Worker keeps working while the
 *  caller stays connected, so an email whose cards have very long timelines needs more than 15 min. */
const TIMEOUT_MS = Math.min(Math.max(Number(arg("--timeout-min", 15)) || 15, 1), 120) * 60_000;
/**
 * THE WAIT HAS TO BE SET ON THE CONNECTION, NOT ONLY ON THE SIGNAL. Node's fetch gives up on any response
 * whose headers take longer than 300 s ("fetch failed", UND_ERR_HEADERS_TIMEOUT), whatever AbortSignal it
 * was handed -- so --timeout-min above 5 did nothing, and the heavy emails failed at 5 min every time.
 * Measured 2026-09-27. This agent makes the connection wait as long as the signal does.
 */
const LONG_WAIT = new Agent({ headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });
const RETRY_AFTER_MS = 15 * 60_000;   // == RESERVE_STALE_MS in src/activity-registry.ts
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ms = iso => { const t = Date.parse(iso); if (Number.isNaN(t)) throw new Error(`not a date: ${iso}`); return t; };

// Refuse before reading anything when the run could write: see lib/repair-preflight.mjs.
if (APPLY) {
  try { await requireNewBuild(WORKER); }
  catch (e) { console.error(`refusing --apply: ${e.message}`); process.exit(1); }
  console.log("pre-flight: the new CRM build is live");
}

async function hsPost(path, body, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com${path}`, { method: "POST",
    headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2500 * (attempt + 1)); return hsPost(path, body, attempt + 1); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`hubspot ${path}: ${r.status} ${JSON.stringify(j?.message ?? "").slice(0, 160)}`);
  return j;
}
async function monday(query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: M, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!j.data || j.errors) {
    if (attempt < 6) { await sleep(2500 * (attempt + 1)); return monday(query, variables, attempt + 1); }
    throw new Error(JSON.stringify(j.errors ?? j).slice(0, 240));
  }
  return j.data;
}

/**
 * EVERY record created in [from, to), despite search's silent 10,000-result ceiling: a window that
 * reports more than fits is halved until each half fits. Paging past 10,000 returns an error or,
 * worse, nothing -- which reads exactly like "done".
 */
async function searchCreated(object, dateProp, props, fromMs, toMs) {
  const filters = [
    { propertyName: dateProp, operator: "GTE", value: String(fromMs) },
    { propertyName: dateProp, operator: "LT", value: String(toMs) },
  ];
  const base = { filterGroups: [{ filters }], properties: props, sorts: [{ propertyName: dateProp, direction: "ASCENDING" }] };
  const probe = await hsPost(`/crm/v3/objects/${object}/search`, { ...base, limit: 1 });
  await sleep(250);
  if ((probe.total ?? 0) > 9_000 && toMs - fromMs > 60_000) {
    const mid = Math.floor((fromMs + toMs) / 2);
    return [...await searchCreated(object, dateProp, props, fromMs, mid),
            ...await searchCreated(object, dateProp, props, mid, toMs)];
  }
  const out = [];
  let after;
  do {
    const r = await hsPost(`/crm/v3/objects/${object}/search`, { ...base, limit: 200, ...(after ? { after } : {}) });
    out.push(...(r.results ?? []));
    after = r.paging?.next?.after;
    await sleep(250);                                   // search is limited to ~5 requests a second
  } while (after);
  if (out.length !== (probe.total ?? out.length))
    console.log(`  note: ${object} window returned ${out.length}, total said ${probe.total} (records changed mid-scan)`);
  return out;
}

/** The ids, of those given, that already have a card on the board -- 50 per query. */
async function carded(board, idCol, ids) {
  const have = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const d = await monday(`query ($b: ID!, $c: String!, $v: [String]!) {
      items_page_by_column_values(board_id: $b, limit: 500, columns: [{ column_id: $c, column_values: $v }]) {
        items { column_values(ids: [$c]) { text } } } }`, { b: board, c: idCol, v: slice });
    for (const it of d.items_page_by_column_values?.items ?? [])
      for (const cv of it.column_values ?? []) if (cv.text) have.add(String(cv.text).trim());
  }
  return have;
}

/**
 * The outcome word of one Worker answer. /resync answers with its whole log line ("[webhook] source=...
 * action=created-monday board=..."), /resync-activity with a bare word ("created", "unresolved"), and a
 * failure reads "error: ..." or "request-failed: ...". (The old tally split on the first space, so every
 * /resync answer counted as "[webhook]".)
 */
const outcomeOf = out => { const s = String(out ?? ""); return /\baction=(\S+)/.exec(s)?.[1] ?? s.split(/[:\s]/)[0]; };
/** Answers a re-send cannot change. Everything else -- unresolved, creating, blocked, error, request-failed,
 *  anything unrecognised, or no answer at all -- is re-sent by --retry; the Worker's dedup makes that safe. */
const SETTLED = new Set(["created", "created-monday", "created-hubspot", "adopted-hubspot",
  "updated-monday", "updated-hubspot", "skipped", "skipped-in-sync"]);
/**
 * A bare "skipped" from /resync (cards mode) is NOT settled: the Worker's permanent skips always carry a
 * reason= ("record not found", "out of scope"), while a skip with none means another path held the card
 * reservation at that moment (a creation already in flight) -- the card may still be missing.
 */
const settled = out => {
  if (out === undefined) return false;
  const k = outcomeOf(out);
  if (MODE === "cards" && k === "skipped" && !/\breason=/.test(String(out))) return false;
  return SETTLED.has(k) || k.startsWith("already");
};

/** A Worker answer that is the same for every id: the run stops on it rather than retrying id by id. */
class FatalResponse extends Error {}

/**
 * POST ids to a repair route in batches. A 5xx / 429 / network failure is retried id by id, never
 * dropped; a FatalResponse (400/401/403/404, 409 "activity sync is off") ends the whole run. Results
 * go straight into `entry.applied`, and the report is saved after every batch.
 */
async function send(path, object, ids, entry, extra = {}) {
  const tally = {}, results = {};
  entry.applied = { tally, results };
  const post = async (batch) => {
    let r;
    try {
      // A heavy email (long card timelines to check) runs past 5 min, and an aborted request can be cut
      // off inside the Worker mid-delivery, leaving that destination for the stale takeover. undici's own
      // fetch, so the agent's timeouts are the ones that apply (see LONG_WAIT).
      r = await fetchWithAgent(`${WORKER}${path}`, { method: "POST", dispatcher: LONG_WAIT,
        headers: { "Content-Type": "application/json", "x-trigger-secret": T },
        body: JSON.stringify({ object, ids: batch, ...extra }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const cause = e?.cause?.code ?? e?.cause?.name;       // "fetch failed" alone hides which failure it was
      throw new Error(`${path} network: ${String(e?.message ?? e).slice(0, 80)}${cause ? ` (${cause})` : ""}`);
    }
    const text = await r.text().catch(() => "");
    if (r.ok) {
      try { return JSON.parse(text).results ?? {}; }
      catch { throw new Error(`${path} ${r.status}: unreadable answer`); }
    }
    if ([400, 401, 403, 404].includes(r.status) || (r.status === 409 && /activity sync is off/i.test(text)))
      throw new FatalResponse(`${path} answered ${r.status} ${text.slice(0, 120)}`);
    throw new Error(`${path} ${r.status}`);
  };
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
  let next = 0, fatal = null, done = 0;
  const worker = async () => {
    while (!fatal && next < batches.length) {
      const batch = batches[next++];
      let res;
      try { res = await post(batch); }
      catch (e) {
        if (e instanceof FatalResponse) { fatal ??= e; return; }
        res = {};
        await sleep(2000);
        for (const id of batch) {
          try { Object.assign(res, await post([id])); }
          catch (e2) {
            if (e2 instanceof FatalResponse) { fatal ??= e2; return; }
            res[id] = `request-failed: ${String(e2).slice(0, 80)}`;
          }
        }
      }
      for (const [id, out] of Object.entries(res)) {
        results[id] = out;
        const k = outcomeOf(out);
        tally[k] = (tally[k] ?? 0) + 1;
      }
      report.lastSentAt = new Date().toISOString();
      save();
      if (++done % 20 === 0) console.log(`    ${Object.keys(results).length}/${ids.length}  ${JSON.stringify(tally)}`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (fatal) throw fatal;
  return { tally, results };
}

const BOARDS = {
  contacts:   { board: "5028000495", idCol: "text_mm6t71dj", dateProp: "createdate" },
  companies:  { board: "5028000496", idCol: "text_mm6tsnwx", dateProp: "createdate" },
  deals:      { board: "5028000494", idCol: "text_mm76kxz4", dateProp: "createdate" },
  line_items: { board: "5028000489", idCol: "text_mm76qwtw", dateProp: "createdate" },
};
const ACTIVITIES = ["emails", "calls", "meetings", "notes"];
const ROUTE = MODE === "cards" ? "/resync" : "/resync-activity";

const startedAt = new Date();
const report = { mode: MODE, apply: APPLY, generatedAt: startedAt.toISOString(), objects: {} };
// An earlier report is never overwritten -- --retry needs it intact -- so a taken name gets the time appended.
const hhmmss = startedAt.toISOString().slice(11, 19).replace(/:/g, "");
let out = join(ROOT, "..", "docs", "rollout", `${startedAt.toISOString().slice(0, 10)}-catchup-${MODE}`
  + `${RETRY ? `-retry-${hhmmss}` : ""}${APPLY ? "-applied" : "-plan"}.json`);
if (existsSync(out)) out = out.replace(/\.json$/, `-${hhmmss}.json`);
const save = () => writeFileSync(out, JSON.stringify(report, null, 2));
const now = Date.now() + 60_000;

try {
  if (RETRY) {
    // ------------------------------------------------------------------ --retry: the unsettled ids only
    const path = resolve(RETRY);
    const prev = JSON.parse(readFileSync(path, "utf8"));
    if (prev.mode !== MODE) { console.error(`${RETRY} is a "${prev.mode}" report, not "${MODE}"`); process.exit(2); }
    if (!prev.apply) { console.error(`${RETRY} is a dry run: nothing was sent, so there is nothing to retry -- run --apply`); process.exit(2); }
    const lastSent = Math.max(Date.parse(prev.lastSentAt ?? "") || 0, statSync(path).mtimeMs || 0);
    const waitMs = lastSent + RETRY_AFTER_MS - Date.now();
    if (waitMs > 0) {
      const msg = `the report's last send was ${Math.ceil((Date.now() - lastSent) / 60_000)} min ago; a retry needs 15 `
        + `(the Worker's reservations go stale after 15 min) -- wait ${Math.ceil(waitMs / 60_000)} more min`;
      if (APPLY) { console.error(`refusing --apply: ${msg}`); process.exit(1); }
      console.log(`note: ${msg}`);
    }
    report.retryOf = RETRY;
    const only = arg("--objects", null)?.split(",").map(s => s.trim()).filter(Boolean);
    for (const [object, e] of Object.entries(prev.objects ?? {})) {
      if (only && !only.includes(object)) continue;
      const ids = (MODE === "cards" ? e.missing : e.target) ?? [];
      const results = e.applied?.results ?? {};
      const unsettled = ids.filter(id => !settled(results[id]));
      const why = {};
      for (const id of unsettled) { const k = results[id] === undefined ? "never-sent" : outcomeOf(results[id]); why[k] = (why[k] ?? 0) + 1; }
      console.log(`\n${object}: ${ids.length} in the report, ${unsettled.length} not settled ${JSON.stringify(why)}`);
      const entry = { retriedFrom: RETRY, inReport: ids.length, unsettledBefore: why, [MODE === "cards" ? "missing" : "target"]: unsettled };
      report.objects[object] = entry;
      save();
      if (APPLY && unsettled.length) {
        const r = await send(ROUTE, object, unsettled, entry);
        console.log(`  done ${JSON.stringify(r.tally)}`);
      }
    }
  } else if (MODE === "cards") {
    const objects = arg("--objects", "contacts,companies,deals").split(",").map(s => s.trim()).filter(Boolean);
    for (const object of objects) {
      const b = BOARDS[object];
      if (!b) { console.error(`unknown object ${object}`); process.exit(2); }
      const recs = await searchCreated(object, b.dateProp, [b.dateProp, "sync_owner"], ms(SINCE), now);
      // wm / hold are not this Worker's to card -- the Worker would refuse them anyway; not sending them
      // keeps the counts honest.
      const eligible = recs.filter(r => !["wm", "hold"].includes(String(r.properties?.sync_owner ?? "").trim()));
      const have = await carded(b.board, b.idCol, eligible.map(r => String(r.id)));
      const missing = eligible.map(r => String(r.id)).filter(id => !have.has(id));
      console.log(`\n${object}: ${recs.length} created since ${SINCE}, ${recs.length - eligible.length} stamped wm/hold, `
        + `${have.size} already carded, ${missing.length} with no card`);
      const entry = { created: recs.length, excludedWmHold: recs.length - eligible.length, carded: have.size, missing };
      report.objects[object] = entry;
      save();
      if (APPLY && missing.length) {
        const r = await send(ROUTE, object, missing, entry);
        console.log(`  done ${JSON.stringify(r.tally)}`);
      }
    }
  } else {
    const objects = arg("--objects", ACTIVITIES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
    const cut = ms(ACTIVITY_CUTOVER);
    for (const object of objects) {
      if (!ACTIVITIES.includes(object)) { console.error(`unknown activity ${object}`); process.exit(2); }
      const recs = await searchCreated(object, "hs_createdate", ["hs_timestamp", "hs_createdate"], cut, now);
      // THE GAP: created after the cutover, dated before it. Everything else the live path already judged.
      const refused = recs.filter(r => { const t = Date.parse(r.properties?.hs_timestamp ?? ""); return !Number.isNaN(t) && t < cut; });
      const target = (ALL ? recs : refused).map(r => String(r.id));
      console.log(`\n${object}: ${recs.length} created since the cutover, ${refused.length} dated before it `
        + `(refused by the old rule); sending ${target.length}`);
      const entry = { createdSinceCutover: recs.length, refusedByOldRule: refused.length, target };
      report.objects[object] = entry;
      save();
      if (APPLY && target.length) {
        const r = await send(ROUTE, object, target, entry);
        console.log(`  done ${JSON.stringify(r.tally)}`);
      }
    }
  }
} catch (e) {
  if (!(e instanceof FatalResponse)) throw e;
  report.aborted = e.message;
  save();
  console.error(`\nABORTED: ${e.message}\nEvery id would get the same answer, so nothing more was sent. Fix the cause, then `
    + `re-send what is left with --retry ${out} (it includes the ids never reached).\nreport: ${out}`);
  process.exit(1);
}

report.done = true;
save();
const unsettledNow = APPLY ? Object.entries(report.objects)
  .reduce((n, [, e]) => n + ((MODE === "cards" ? e.missing : e.target) ?? []).filter(id => !settled(e.applied?.results?.[id])).length, 0) : 0;
console.log(`\nreport: ${out}${APPLY ? "" : "\n(dry run -- nothing was written; add --apply after the deploy)"}`
  + (unsettledNow ? `\n${unsettledNow} id(s) not settled -- re-send them 15+ min from now with --retry ${out} --apply` : ""));
