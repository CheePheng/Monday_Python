/**
 * ONE-TIME HISTORICAL IMPORT — every HubSpot Company and Contact into the monday CRM boards.
 *
 * Approved 2026-09-09: the earlier "no historical import" rule is superseded. The Philippines team is
 * to start logging activity against Contacts and Companies in monday next week, so the whole database
 * has to be visible there. Scale measured live: 26,171 Companies and ~94,290 Contacts.
 *
 * WHY A SCRIPT AND NOT THE WORKER. The obvious move — wind `CRM_CUTOVER_AT` back and let the webhook
 * path do it — is wrong twice over. Nothing would trigger it (there is no CRM cron, and both specs set
 * skipFullReconcile), and `CRM_CUTOVER_AT` also governs `canClaimCrmOwnership`, so moving it would hand
 * write ownership of ~120k HubSpot records to this Worker as a side effect of wanting to READ them into
 * monday. Those two concerns are deliberately separated: this import only seeds monday. It PATCHes
 * nothing in HubSpot and stamps no `sync_owner`. Claim-on-edit for historical records is next week's
 * task and its own decision.
 *
 * WHY IT REUSES THE WORKER'S OWN CODE. `buildCtx`, `propertiesForSpec`, `buildColumnValues`, `itemName`
 * and `targetGroup` are imported from src/ via an esbuild bundle, not reimplemented. A card seeded here
 * must be byte-identical to one the live sync would have created, or the first incremental reconcile
 * sees a diff on every field of every one of 120k cards and rewrites the entire board. Reimplementing
 * the mapping would guarantee that; importing it makes it impossible.
 *
 * IDENTITY IS THE HUBSPOT ID, NEVER A NAME. Dedup is by the board's HubSpot ID column, indexed once up
 * front. A record whose id is already on the board is SKIPPED — the incremental path owns updates, this
 * script only creates. Two contacts can share a name and two companies can share a domain (57 share
 * qcc.com), so nothing here matches on either.
 *
 * RESTART-SAFE. Progress (HubSpot's opaque `after` cursor plus counters) is written after every page,
 * so a crash, a rate-limit stall or a Ctrl-C resumes where it stopped. Even with the state file
 * deleted, re-running is safe: the monday index is rebuilt and already-imported records skip.
 *
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/backfill-crm.mjs --preflight
 *   … node scripts/backfill-crm.mjs --object companies --limit 50 --apply
 *   … node scripts/backfill-crm.mjs --object companies --apply
 *   … node scripts/backfill-crm.mjs --object contacts   --apply
 *
 * Default mode is PLAN: it reads both systems and reports exactly what it would create, writing
 * nothing. `--apply` is required to create. `--limit N` stops after N creates, which is how to prove
 * the first 50 look right before committing to 120k.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { planContactLinks, CAPPED, NO_ACCOUNT_CARD, ALREADY_CORRECT } from "./relation-plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Set by --only-hs. Module-scoped because hsPage is the one funnel every record passes through, so
 *  filtering there cannot be bypassed by a code path that forgets to apply it. */
let ONLY_HS = null;
const MONDAY_API = "https://api.monday.com/v2";
const HS_API = "https://api.hubapi.com";

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = {
    object: "", apply: false, preflight: false, selftest: false, reset: false,
    limit: Infinity, batch: 10, itemsPage: 500, state: "", retryFailed: false, createMissing: false,
    // 6 create-batches in flight. Chosen from the live measurement rather than guessed: the sequential
    // run held at 102 cards/min with the throttle never once widening, so monday's limiter was not the
    // constraint — its per-mutation latency was. 6 is deliberately short of the ~10 that would clear a
    // 100-record HubSpot page in a single round, leaving room for the adaptive throttle to react
    // before we are anywhere near the complexity budget.
    concurrency: 6,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--apply") a.apply = true;
    else if (k === "--preflight") a.preflight = true;
    else if (k === "--selftest") a.selftest = true;
    else if (k === "--reset") a.reset = true;
    else if (k === "--retry-failed") a.retryFailed = true;
    else if (k === "--create-missing") a.createMissing = true;
    else if (k === "--relation-cap") a.relationCap = Number(argv[++i]);
    else if (k === "--object") a.object = argv[++i];
    else if (k === "--limit") a.limit = Number(argv[++i]);
    // A stratified canary: run the REAL pass against a handful of chosen cards rather than a copy of
    // it. canary-relations.mjs picks the ids and verifies the before/after cells; the write path here
    // is byte-for-byte the one the full run uses, which is the entire point of a canary.
    else if (k === "--only") a.only = new Set(String(argv[++i]).split(/[,\s]+/).filter(Boolean));
    // Restrict the CREATE pass to specific HubSpot record ids. `--limit` takes "the first N in list
    // order", which is not a sample of anything; a canary needs records chosen for what they exercise.
    else if (k === "--only-hs") a.onlyHs = new Set(String(argv[++i]).split(/[,\s]+/).filter(Boolean));
    else if (k === "--batch") a.batch = Number(argv[++i]);
    else if (k === "--concurrency") a.concurrency = Math.max(1, Number(argv[++i]));
    else if (k === "--state") a.state = argv[++i];
  }
  if (!a.state && a.object) a.state = join(ROOT, "scripts", `.backfill-${a.object}.json`);
  if (a.onlyHs) ONLY_HS = a.onlyHs;
  return a;
}

// ---------------------------------------------------------------- credentials

/**
 * Read the two tokens from the environment, falling back to worker/.dev.vars.
 *
 * The fallback exists because `$env:MONDAY_API_TOKEN="…"` typed into an interactive PowerShell session
 * is NOT inherited by a separately spawned process, so an agent running this script cannot see it —
 * the variable is real, just not where the script looks. `.dev.vars` is Cloudflare's own convention for
 * local Worker secrets, is already listed in worker/.gitignore, and is what `wrangler dev` reads, so
 * one file serves both. It never enters git and never has to be pasted into a chat.
 *
 * Format is KEY=VALUE per line; `#` comments and surrounding quotes are tolerated.
 */
function readCredentials() {
  const out = {
    MONDAY_API_TOKEN: process.env.MONDAY_API_TOKEN ?? "",
    HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN ?? "",
  };
  const path = join(ROOT, ".dev.vars");
  if ((!out.MONDAY_API_TOKEN || !out.HUBSPOT_ACCESS_TOKEN) && existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (!(key in out) || out[key]) continue;          // env wins over the file
      out[key] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

// ---------------------------------------------------------------- the worker's own code

/**
 * Bundle src/ for Node and import the real functions.
 *
 * esbuild's JS API rather than its CLI: since the Node 18 fix for CVE-2024-27980, spawning the `.cmd`
 * shim without `shell: true` fails with EINVAL on Windows.
 *
 * sync.ts pulls in card-registry, which references Durable Objects — harmless here because nothing at
 * module scope touches a Worker global, and this script never calls a registry function. It does mean
 * the Worker's CREATE_IDEMPOTENCY registry knows nothing about cards seeded here, which is fine and
 * deliberate: ensureCardForRecord falls back to a findItemByColumn search precisely so it adopts cards
 * created outside the registry instead of duplicating them (ensure-card.ts:45-46).
 */
async function loadWorker() {
  const dir = mkdtempSync(join(tmpdir(), "backfill-"));
  const out = join(dir, "worker.mjs");
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, [
    `export { buildCtx } from ${JSON.stringify(join(ROOT, "src", "sync.ts"))};`,
    `export { propertiesForSpec } from ${JSON.stringify(join(ROOT, "src", "hubspot.ts"))};`,
    `export { buildColumnValues, itemName } from ${JSON.stringify(join(ROOT, "src", "mapping.ts"))};`,
    `export { targetGroup } from ${JSON.stringify(join(ROOT, "src", "routing.ts"))};`,
    `export { CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
  ].join("\n"), "utf8");
  buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
  const mod = await import(pathToFileURL(out).href);
  return { mod, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

// ---------------------------------------------------------------- transport

/** Adaptive throttle. monday's budget is complexity-per-minute, not requests-per-second, so a fixed
 *  sleep is either wasteful or insufficient; this widens the gap only when monday pushes back. */
const throttle = { gapMs: 120, min: 60, max: 8000 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function pace() {
  const wait = throttle.gapMs - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/**
 * True for errors that mean "try again" rather than "this request is wrong".
 *
 * Covers two different things deliberately:
 *  - THROTTLING (429/503/502, complexity, budget) — back off and the same request will succeed.
 *  - monday's own INTERNAL ERRORS. These arrive as HTTP **200** with {"message":"Internal Server
 *    Error"} inside the GraphQL errors array, which is why the first version missed them entirely: it
 *    only inspected the status for server faults. 21 contacts were recorded as permanent failures
 *    during the 2026-09-09 import for a fault that had nothing to do with their data — they would
 *    have succeeded on a retry. A transient server fault must never be indistinguishable from
 *    "monday rejected this value".
 */
function isRetryableError(status, body) {
  if (status === 429 || status === 503 || status === 502 || status === 500) return true;
  const s = JSON.stringify(body ?? "").toLowerCase();
  return s.includes("complexity") || s.includes("rate limit") || s.includes("too many requests")
    || s.includes("budget exhausted") || s.includes("internal server error")
    || s.includes("service unavailable") || s.includes("timeout");
}

async function monday(token, query, variables = {}, attempt = 0) {
  await pace();
  let res, body;
  try {
    res = await fetch(MONDAY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }),
    });
    body = await res.json();
  } catch (e) {
    if (attempt >= 5) throw new Error(`monday network: ${String(e)}`);
    await sleep(1000 * 2 ** attempt);
    return monday(token, query, variables, attempt + 1);
  }
  if (!res.ok || body.errors || body.error_message) {
    if (isRetryableError(res.status, body) && attempt < 6) {
      throttle.gapMs = Math.min(throttle.max, Math.max(throttle.gapMs * 2, 500));
      const backoff = Number(body?.error_data?.retry_in_seconds ?? 0) * 1000 || 2000 * 2 ** attempt;
      const why = JSON.stringify(body.errors ?? body.error_message ?? "").slice(0, 80);
      console.log(`  [retry ${attempt + 1}/6] monday http ${res.status} ${why}; waiting`
        + ` ${Math.round(backoff / 1000)}s, request gap now ${throttle.gapMs}ms`);
      await sleep(backoff);
      return monday(token, query, variables, attempt + 1);
    }
    throw new Error(`monday: http ${res.status} ${JSON.stringify(body.errors ?? body.error_message ?? body).slice(0, 400)}`);
  }
  // A successful run slowly reclaims speed, so one burst of throttling does not slow the whole import.
  throttle.gapMs = Math.max(throttle.min, Math.round(throttle.gapMs * 0.9));
  return body.data;
}

async function hubspot(token, path, attempt = 0) {
  const res = await fetch(`${HS_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`hubspot: http ${res.status} on ${path}`);
    await sleep(2000 * 2 ** attempt);
    return hubspot(token, path, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`hubspot: http ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// ---------------------------------------------------------------- state

const loadState = p => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const saveState = (p, s) => writeFileSync(p, JSON.stringify(s, null, 2), "utf8");

// ---------------------------------------------------------------- monday side

/** hubspotId -> [itemId]. An ARRAY so pre-existing duplicates are reported rather than hidden. */
async function indexBoard(token, spec, pageSize) {
  const index = new Map();
  let cursor = null, items = 0, blank = 0;
  do {
    const page = (await monday(token,
      `query ($b: ID!, $c: String, $n: Int!, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: $n, cursor: $c) {
           cursor items { id column_values(ids: $ids) { id text } } } } }`,
      { b: spec.boardId, c: cursor, n: pageSize, ids: [spec.idCol] })).boards[0].items_page;
    for (const it of page.items) {
      const hsId = (it.column_values.find(c => c.id === spec.idCol)?.text ?? "").trim();
      if (!hsId) { blank++; continue; }
      if (!index.has(hsId)) index.set(hsId, []);
      index.get(hsId).push(it.id);
    }
    items += page.items.length;
    cursor = page.cursor;
    if (items % 5000 === 0 && items) console.log(`  indexed ${items} existing cards…`);
  } while (cursor);
  return { index, items, blank };
}

/**
 * Create up to `batch.length` cards in ONE monday request, using aliased mutations.
 *
 * `create_labels_if_missing: true` matches what the Worker sends. It is load-bearing for an import:
 * the boards were seeded with the label sets that existed at the time, and HubSpot values encountered
 * across 120k records will include ones nobody has seen. NOTE the ceiling this leans on — status
 * columns 500 above roughly 19 labels on this account. Every status-mapped property was checked in
 * --preflight for exactly that reason; the largest is `leadstatus` at 14 options.
 */
async function createBatch(token, spec, batch) {
  const decls = batch.map((_, i) => `$n${i}: String!, $v${i}: JSON!`).join(", ");
  const calls = batch.map((_, i) =>
    `c${i}: create_item(board_id: $b, group_id: $g, item_name: $n${i}, column_values: $v${i},`
    + ` create_labels_if_missing: true) { id }`).join("\n    ");
  const vars = { b: spec.boardId, g: batch[0].group };
  batch.forEach((r, i) => { vars[`n${i}`] = r.name; vars[`v${i}`] = JSON.stringify(r.cv); });
  const data = await monday(token, `mutation ($b: ID!, $g: String!, ${decls}) {\n    ${calls}\n  }`, vars);
  return batch.map((r, i) => ({ hsId: r.hsId, itemId: data?.[`c${i}`]?.id ?? null }));
}

/**
 * Flush a batch, degrading to one-at-a-time if the batch fails.
 *
 * monday rejects an entire mutation document when any part of it is invalid, so one malformed record
 * would otherwise lose the nine good ones beside it — and at this scale a handful of records WILL carry
 * something unexpected. Retrying individually isolates the bad one, records it with its reason, and
 * keeps the import moving. That is the "able to continue after an individual record failure"
 * requirement, and it is why failures are collected rather than thrown.
 */
async function flush(token, spec, batch, result) {
  if (!batch.length) return;
  try {
    for (const r of await createBatch(token, spec, batch)) {
      if (r.itemId) { result.created++; result.createdIds.push([r.hsId, r.itemId]); }
      else result.failed.push({ hsId: r.hsId, reason: "monday returned no id for this alias" });
    }
    return;
  } catch (e) {
    if (batch.length === 1) {
      result.failed.push({ hsId: batch[0].hsId, name: batch[0].name, reason: String(e).slice(0, 300) });
      return;
    }
    console.log(`  [isolate] a batch of ${batch.length} failed; checking what already landed`);
  }
  // THE ISOLATE PATH MUST FIRST ASK WHAT ALREADY LANDED. An aliased mutation is NOT atomic: monday can
  // create several items and then fail the request, which returns an error for the whole document.
  // Blindly retrying all ten then re-creates whatever had already committed. That produced 758
  // duplicate HubSpot ids on the 2026-09-09 Contacts import while recording only 21 failures — most
  // isolate retries SUCCEEDED, so nothing was logged and the duplicates stayed invisible until the
  // board was verified. One search per record, on a rare path, is a cheap price for idempotency.
  const landed = await alreadyCarded(token, spec, batch.map(b => b.hsId));
  if (landed.size) console.log(`  [isolate] ${landed.size} of ${batch.length} already exist — not re-creating`);
  for (const one of batch) {
    if (landed.has(String(one.hsId))) { result.created++; continue; }   // committed by the failed mutation
    await flush(token, spec, [one], result);
  }
}

/**
 * Which of these HubSpot ids ALREADY have a card? Asked only on the isolate path.
 *
 * `items_page_by_column_values` is monday's own search over the HubSpot ID column, so it is
 * authoritative about what landed — including anything a partially-applied mutation committed.
 */
async function alreadyCarded(token, spec, hsIds) {
  const found = new Set();
  for (const hsId of hsIds) {
    try {
      const data = await monday(token,
        `query ($b: ID!, $c: String!, $v: [String!]) {
           items_page_by_column_values(limit: 2, board_id: $b,
             columns: [{ column_id: $c, column_values: $v }]) { items { id } } }`,
        { b: spec.boardId, c: spec.idCol, v: [String(hsId)] });
      if ((data?.items_page_by_column_values?.items ?? []).length) found.add(String(hsId));
    } catch { /* an unanswerable check falls through to the retry, which is the safe direction */ }
  }
  return found;
}

// ---------------------------------------------------------------- hubspot side

/** One page of records with every property the spec maps. `after` is HubSpot's opaque cursor. */
async function hsPage(token, object, props, after, pageSize = 100) {
  const q = new URLSearchParams({ limit: String(pageSize), properties: props.join(","), archived: "false" });
  if (after) q.set("after", after);
  const body = await hubspot(token, `/crm/v3/objects/${object}?${q}`);
  return {
    // ONLY_HS is applied HERE because hsPage is the single funnel every record passes through, so a
    // caller cannot bypass the canary's record selection by forgetting to filter.
    records: (body.results ?? []).map(r => ({ id: String(r.id), properties: r.properties ?? {} }))
      .filter(r => !ONLY_HS || ONLY_HS.has(r.id)),
    after: body.paging?.next?.after ?? null,
  };
}

async function hsTotal(token, object) {
  const res = await fetch(`${HS_API}/crm/v3/objects/${object}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filterGroups: [], properties: ["hs_object_id"], limit: 1 }),
  });
  const body = await res.json().catch(() => ({}));
  return Number(body.total ?? -1);
}

// ---------------------------------------------------------------- preflight

/**
 * The checks worth making BEFORE writing 120k cards, each earned by something that has already gone
 * wrong on this project:
 *
 *  - A DEAD COLUMN ID. A spec naming a column the board does not have makes monday reject the ENTIRE
 *    change_multiple_column_values mutation, which froze every card on the Accounts board once
 *    already. At import scale it would fail every create instead of every update.
 *  - STATUS LABEL HEADROOM. Status columns 500 above ~19 labels here, every write sets
 *    create_labels_if_missing, and an import is the one event that surfaces every historical value at
 *    once. So the option count of each status-mapped property is compared against the ceiling.
 *  - THE ACTUAL GAP. HubSpot's total against how many cards already carry a HubSpot ID, so "how much
 *    work is this" is measured rather than assumed.
 *  - PRE-EXISTING DUPLICATES. Two cards with the same HubSpot ID mean something already went wrong,
 *    and importing on top of it would obscure the evidence.
 */
async function preflight(M, H, mod, specs) {
  const STATUS_CEILING = 19;
  let problems = 0;
  for (const spec of specs) {
    const label = spec.object === "contacts" ? "CONTACTS" : "ACCOUNTS";
    console.log(`\n=== PREFLIGHT ${label} — board ${spec.boardId} ===`);

    const cols = (await monday(M, "query ($b: [ID!]) { boards(ids: $b) { name items_count columns { id title type } } }",
      { b: [spec.boardId] })).boards[0];
    const live = new Map(cols.columns.map(c => [c.id, c]));
    console.log(`  board "${cols.name}" currently holds ${cols.items_count} items`);

    const missing = [];
    for (const id of [spec.idCol, spec.syncStateCol, spec.linkCol].filter(Boolean))
      if (!live.has(id)) missing.push(`bookkeeping ${id}`);
    for (const f of spec.fields) if (!live.has(f.col)) missing.push(`${f.hs} -> ${f.col}`);
    if (missing.length) {
      problems += missing.length;
      console.log(`  *** ${missing.length} MAPPED COLUMN(S) DO NOT EXIST — every create would fail ***`);
      for (const m of missing) console.log(`        ${m}`);
    } else {
      console.log(`  all ${spec.fields.length} mapped columns + bookkeeping columns exist`);
    }

    const statusFields = spec.fields.filter(f => f.type === "status");
    for (const f of statusFields) {
      const p = await hubspot(H, `/crm/v3/properties/${spec.object}/${f.hs}`);
      const n = (p.options ?? []).length;
      const flag = n > STATUS_CEILING ? "*** OVER THE ~19-LABEL STATUS CEILING ***"
        : n > STATUS_CEILING - 5 ? "(little headroom)" : "";
      if (n > STATUS_CEILING) problems++;
      console.log(`  status ${f.hs.padEnd(18)} ${String(n).padStart(3)} HubSpot options  ${flag}`);
    }

    const total = await hsTotal(H, spec.object);
    const { index, items, blank } = await indexBoard(M, spec, 500);
    const dupes = [...index.entries()].filter(([, v]) => v.length > 1);
    console.log(`  HubSpot ${spec.object}: ${total}`);
    console.log(`  monday cards: ${items} (${index.size} carry a HubSpot ID, ${blank} do not)`);
    console.log(`  TO IMPORT: ~${Math.max(0, total - index.size)}`);
    if (dupes.length) {
      problems += dupes.length;
      console.log(`  *** ${dupes.length} HubSpot ID(S) APPEAR ON MORE THAN ONE CARD ***`);
      for (const [hsId, ids] of dupes.slice(0, 10)) console.log(`        ${hsId} -> cards ${ids.join(", ")}`);
    } else {
      console.log(`  no duplicate HubSpot IDs`);
    }
    if (blank) console.log(`  note: ${blank} card(s) have no HubSpot ID — Accounts awaiting domain adoption look like this`);
  }
  console.log(problems ? `\nPREFLIGHT FOUND ${problems} PROBLEM(S) — fix before --apply.`
                       : `\nPREFLIGHT CLEAN.`);
  return problems;
}

// ---------------------------------------------------------------- import

/**
 * Re-create only the records a previous pass RECORDED AS FAILED.
 *
 * The alternative is a full re-scan: the import skips already-carded records, so re-running from a
 * reset cursor would eventually reach the failures — after paging all 94,318 contacts out of HubSpot
 * again for the sake of ~130 records. This reads their ids straight from the state file instead.
 *
 * Needed because a fix that lands mid-run cannot help the run in flight: each pass bundles src/ at
 * startup, so the process that recorded these failures is still executing the code that caused them.
 * The 2026-09-09 case was over-length phone numbers failing the entire card.
 *
 * Idempotent: anything already carded is skipped, so running it twice creates nothing the second time.
 */
async function runRetryFailed(M, H, mod, spec, args) {
  const { propertiesForSpec, buildColumnValues, itemName, targetGroup } = mod;
  const prior = loadState(args.state);
  const ids = [...new Set((prior?.failed ?? []).map(f => String(f.hsId)).filter(Boolean))];
  console.log(`\n=== ${args.apply ? "RETRY" : "PLAN RETRY"} ${spec.object}: ${ids.length} previously-failed record(s) ===`);
  if (!ids.length) { console.log("  nothing recorded as failed — nothing to do"); return; }

  const { index } = await indexBoard(M, spec, args.itemsPage);
  const todo = ids.filter(id => !index.has(id));
  console.log(`  ${ids.length - todo.length} already carded (a previous retry, or the live Worker), ${todo.length} to create`);
  if (!todo.length) return;

  const props = propertiesForSpec(spec);
  const result = { created: 0, failed: [], createdIds: [] };
  let batch = [];
  const drain = async (final = false) => {
    const ready = () => batch.length >= args.batch || (final && batch.length > 0);
    while (ready()) {
      const chunks = [];
      while (chunks.length < args.concurrency && ready()) chunks.push(batch.splice(0, args.batch));
      if (args.apply) await Promise.all(chunks.map(c => flush(M, spec, c, result)));
      else result.created += chunks.reduce((n, c) => n + c.length, 0);
    }
  };

  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const res = await fetch(`${HS_API}/crm/v3/objects/${spec.object}/batch/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props, inputs: chunk.map(id => ({ id })) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      result.failed.push({ hsId: chunk.join(","), reason: `hubspot batch http ${res.status}` });
      continue;
    }
    for (const rec of body.results ?? []) {
      const r = { id: String(rec.id), properties: rec.properties ?? {} };
      const group = targetGroup(r, spec);
      if (!group) continue;
      const cv = buildColumnValues(r, spec, ctxOf(args));
      cv[spec.syncStateCol] = r.properties[spec.modifiedProp] ?? "";
      batch.push({ hsId: r.id, name: itemName(r, spec), group, cv });
      await drain();
    }
    // A record HubSpot no longer returns was deleted or archived after the failure was recorded;
    // that is a legitimate outcome, not an error, so it is simply reported.
    const returned = new Set((body.results ?? []).map(x => String(x.id)));
    for (const id of chunk) if (!returned.has(id)) console.log(`  ${id}: no longer in HubSpot — skipped`);
  }
  await drain(true);

  console.log(`\n--- RETRY ${args.apply ? "DONE" : "PLANNED"} ---`);
  console.log(`  ${args.apply ? "created" : "would create"} : ${result.created}`);
  console.log(`  still failing : ${result.failed.length}`);
  for (const f of result.failed.slice(0, 20)) console.log(`      ${f.hsId} ${f.reason}`);
  if (args.apply && result.failed.length === 0 && prior) {
    // Clear the failure list so a later verification pass does not re-report records that are now fine.
    prior.failed = [];
    saveState(args.state, prior);
    console.log(`  cleared the failure list in ${args.state}`);
  }
}

const ctxOf = args => args.ctx;

/**
 * CREATE EVERY RECORD THAT HAS NO CARD, computed by diffing HubSpot against the board.
 *
 * The authoritative close-out for a migration, and deliberately independent of the progress file.
 * --retry-failed depends on a `failed` list that a successful retry CLEARS (and that a --reset would
 * discard), so it cannot answer "is the board complete?" — only "did the recorded failures get
 * another try?". This asks the only question that matters at the end: which HubSpot ids are absent
 * from the board's HubSpot ID column?
 *
 * It also closes the gap the 2026-09-10 close-out exposed: 108 records failed, the retry ran, the
 * list was cleared, and nothing in the state file could then prove whether those 108 existed.
 *
 * Ids are paged with ONE property (hs_object_id), so scanning 94,318 contacts costs ~950 cheap
 * requests rather than a full property read; only the genuinely missing records are then fetched in
 * full and created.
 */
async function runCreateMissing(M, H, mod, spec, args) {
  const { propertiesForSpec, buildColumnValues, itemName, targetGroup } = mod;
  console.log(`\n=== ${args.apply ? "CREATE MISSING" : "PLAN MISSING"} ${spec.object} ===`);

  const { index } = await indexBoard(M, spec, args.itemsPage);
  console.log(`  board holds ${index.size} distinct HubSpot id(s)`);

  console.log(`  listing every HubSpot ${spec.object} id…`);
  const all = [];
  let after;
  for (let page = 0; page < 2000; page++) {
    const q = new URLSearchParams({ limit: "100", properties: "hs_object_id", archived: "false" });
    if (after) q.set("after", after);
    const body = await hubspot(H, `/crm/v3/objects/${spec.object}?${q}`);
    for (const r of body.results ?? []) all.push(String(r.id));
    after = body.paging?.next?.after ?? null;
    if (all.length % 20000 === 0 && all.length) console.log(`    listed ${all.length}…`);
    if (!after) break;
  }
  console.log(`  HubSpot holds ${all.length} ${spec.object}`);

  const missing = all.filter(id => !index.has(id));
  console.log(`  MISSING FROM THE BOARD: ${missing.length}`);
  if (!missing.length) { console.log(`  the board is complete — nothing to create`); return { missing: 0, created: 0, failed: [] }; }
  for (const id of missing.slice(0, 20)) console.log(`      ${id}`);
  if (missing.length > 20) console.log(`      … and ${missing.length - 20} more`);
  if (!args.apply) { console.log(`\n(nothing written — add --apply)`); return { missing: missing.length, created: 0, failed: [] }; }

  const props = propertiesForSpec(spec);
  const result = { created: 0, failed: [], createdIds: [] };
  let batch = [];
  const drain = async (final = false) => {
    const ready = () => batch.length >= args.batch || (final && batch.length > 0);
    while (ready()) {
      const chunks = [];
      while (chunks.length < args.concurrency && ready()) chunks.push(batch.splice(0, args.batch));
      await Promise.all(chunks.map(c => flush(M, spec, c, result)));
    }
  };

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const res = await fetch(`${HS_API}/crm/v3/objects/${spec.object}/batch/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props, inputs: chunk.map(id => ({ id })) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { result.failed.push({ hsId: chunk.join(","), reason: `hubspot batch http ${res.status}` }); continue; }
    for (const rec of body.results ?? []) {
      const r = { id: String(rec.id), properties: rec.properties ?? {} };
      const group = targetGroup(r, spec);
      if (!group) continue;
      const cv = buildColumnValues(r, spec, ctxOf(args));
      cv[spec.syncStateCol] = r.properties[spec.modifiedProp] ?? "";
      batch.push({ hsId: r.id, name: itemName(r, spec), group, cv });
      await drain();
    }
  }
  await drain(true);

  console.log(`\n--- MISSING CREATED ---`);
  console.log(`  created : ${result.created}`);
  console.log(`  FAILED  : ${result.failed.length}`);
  for (const f of result.failed.slice(0, 20)) console.log(`      ${f.hsId} ${String(f.reason).slice(0, 160)}`);
  return { missing: missing.length, created: result.created, failed: result.failed };
}

async function runImport(M, H, mod, spec, args) {
  const { propertiesForSpec, buildColumnValues, itemName, targetGroup } = mod;
  const props = propertiesForSpec(spec);
  const ctx = args.ctx;

  console.log(`\n=== ${args.apply ? "IMPORT" : "PLAN"} ${spec.object} -> board ${spec.boardId} ===`);
  console.log(`  fetching ${props.length} HubSpot properties per record`);
  console.log(`  ${args.batch} creates per request, ${args.concurrency} request(s) in flight`);

  if (args.reset && existsSync(args.state)) { unlinkSync(args.state); console.log("  progress reset"); }
  const prior = loadState(args.state);
  if (prior) console.log(`  RESUMING: ${prior.created} created, ${prior.skipped} skipped, ${prior.failed.length} failed`);

  const result = prior ?? {
    object: spec.object, boardId: spec.boardId, after: null,
    created: 0, skipped: 0, scanned: 0, refusedNoGroup: 0,
    failed: [], createdIds: [], startedAt: new Date().toISOString(),
  };
  result.createdIds = [];   // keep the state file small; counts are what matter across restarts

  console.log("  indexing existing cards by HubSpot ID…");
  const { index } = await indexBoard(M, spec, args.itemsPage);
  console.log(`  ${index.size} records already carded`);

  let after = result.after, batch = [], pages = 0, stop = false;
  const t0 = Date.now();

  /**
   * Send whatever is queued, in chunks of exactly args.batch, up to args.concurrency chunks at once.
   *
   * ALWAYS chunked, never "flush the array". The first version flushed `batch` whole, and a defect in
   * the limit check let it grow to 271 — which monday rejected as one 271-alias mutation, so the
   * isolate path then created all 271 one at a time. A batch is a request-size decision and must be
   * enforced here rather than depending on the caller having queued a sane number.
   *
   * WHY CONCURRENCY AND NOT A BIGGER BATCH. Measured on the live Companies run: 102 cards/minute,
   * which projects to 15.4 hours for 94,318 Contacts. The bottleneck is not HTTP round-trips —
   * monday executes the aliases inside one mutation SEQUENTIALLY, so a 10-alias create costs about
   * ten creates' worth of server time (~6s observed). Enlarging the batch therefore buys almost
   * nothing, while running several batches at once multiplies throughput directly.
   *
   * Safe to parallelise because creates are independent: each card is keyed by its own HubSpot ID, no
   * chunk reads what another writes, and nothing depends on ordering. The counters and the failure
   * list are plain single-threaded mutations. `pace()` spaces request STARTS rather than serialising
   * them, so it caps the launch rate without capping how many are in flight — and the adaptive
   * throttle still widens that spacing the moment monday pushes back. It never has: zero throttle
   * events across 4,406 creates, so there is real headroom under monday's complexity budget.
   */
  const drain = async (final = false) => {
    const ready = () => batch.length >= args.batch || (final && batch.length > 0);
    while (ready()) {
      const chunks = [];
      while (chunks.length < args.concurrency && ready()) chunks.push(batch.splice(0, args.batch));
      if (args.apply) await Promise.all(chunks.map(c => flush(M, spec, c, result)));
      else result.created += chunks.reduce((n, c) => n + c.length, 0);
    }
  };

  do {
    // The cursor that FETCHED this page, kept so an early stop does not skip the rest of it.
    const pageCursor = after;
    const page = await hsPage(H, spec.object, props, after);
    pages++;
    for (const rec of page.records) {
      // CHECKED BEFORE CONSUMING THE RECORD, so --limit lands exactly on the limit and the record
      // that would have exceeded it is left for the next run rather than half-processed.
      if (result.created + batch.length >= args.limit) { stop = true; break; }
      result.scanned++;
      if (index.has(rec.id)) { result.skipped++; continue; }
      const group = targetGroup(rec, spec);
      if (!group) { result.refusedNoGroup++; continue; }
      const cv = buildColumnValues(rec, spec, ctx);
      // The Worker stamps Sync State with HubSpot's own last-modified on create (ensure-card.ts:61).
      // Replicating it is REQUIRED, not cosmetic: decideDirection compares that timestamp to decide
      // which side is newer, and a card seeded without it reads as "monday is newer" on the very next
      // webhook — which would make the import look like 120k monday-side edits.
      cv[spec.syncStateCol] = rec.properties[spec.modifiedProp] ?? "";
      batch.push({ hsId: rec.id, name: itemName(rec, spec), group, cv });
      await drain();
    }
    // Drain the page's remainder BEFORE saving the cursor, so a saved cursor always means "everything
    // up to here is really in monday". Without that, a crash between the two loses records silently.
    await drain(true);

    // An early stop rewinds to this page's own cursor. Advancing would strand the records we did not
    // consume: nothing else scans them, and only a from-scratch re-run would ever pick them up.
    result.after = stop ? pageCursor : page.after;
    if (args.apply) saveState(args.state, result);

    const rate = result.scanned / Math.max(1, (Date.now() - t0) / 1000);
    console.log(`  page ${pages}: scanned ${result.scanned}, ${args.apply ? "created" : "would create"} ${result.created},`
      + ` skipped ${result.skipped}, failed ${result.failed.length}  (${rate.toFixed(0)}/s)`);

    after = page.after;
    if (stop) { console.log(`  reached --limit ${args.limit} — stopping with the cursor rewound to this page`); break; }
  } while (after);

  console.log(`\n--- ${spec.object} ${args.apply ? "IMPORTED" : "PLANNED"} ---`);
  console.log(`  scanned in HubSpot : ${result.scanned}`);
  console.log(`  ${args.apply ? "created" : "would create"} : ${result.created}`);
  console.log(`  skipped (already carded) : ${result.skipped}`);
  console.log(`  refused (no target group) : ${result.refusedNoGroup}`);
  console.log(`  FAILED : ${result.failed.length}`);
  for (const f of result.failed.slice(0, 20))
    console.log(`      ${f.hsId} ${f.name ? JSON.stringify(f.name) + " " : ""}${f.reason}`);
  if (result.failed.length > 20) console.log(`      … and ${result.failed.length - 20} more (see ${args.state})`);
  // `stop` matters here: a --limit run that happens to stop on the final page still has more to do.
  if (!after && !stop) console.log(`  HubSpot pagination COMPLETE (no further cursor)`);
  else console.log(`  MORE REMAINS — re-run the same command to continue from the saved cursor`);
  return result;
}

// ---------------------------------------------------------------- pass 3: relations

/**
 * PASS 3 — the Contact <-> Company relation, from the real HubSpot associations.
 *
 * Runs only after both boards are seeded, because it can only link to Accounts cards that exist.
 *
 * Reads associations through the BATCH endpoint (100 contacts per request). The per-record endpoint
 * the Worker uses is right for one webhook and hopeless here — 94k requests instead of ~940.
 *
 * IDEMPOTENT VIA THE TYPED FIELD. Existing links are read as `BoardRelationValue.linked_item_ids`,
 * never as `.text`, which is ALWAYS null for a board_relation column — a fact that already cost this
 * project one wrong diagnosis (a working relation was read as a silent write failure). Comparing the
 * id sets means a re-run writes nothing where the relation is already correct.
 *
 * Only the CONTACT side is written. monday mirrors a Connect Boards link automatically, so the
 * Accounts-side Contacts relation populates itself; writing both would double the work and risk the
 * two sides disagreeing mid-run.
 */
async function runRelations(M, H, mod, args) {
  const { CRM_CONTACTS, CRM_ACCOUNTS } = mod;
  const rel = CRM_CONTACTS.associations?.find(a => a.toObject === "companies")?.relationCol;
  if (!rel) throw new Error("CRM_CONTACTS declares no companies relation column");

  console.log(`\n=== ${args.apply ? "RELATIONS" : "PLAN RELATIONS"} — contacts.${rel} -> Accounts cards ===`);

  /**
   * ONE PASS OVER THE ACCOUNTS BOARD, building both maps it needs.
   *
   * This used to be two full paginations of the same 27,952 cards, taken minutes apart: indexBoard for
   * the HubSpot-ID index, then a second walk for the relation-cell counts. The second read already
   * selects everything the first does, so the split bought nothing and cost consistency — a card
   * created between the two reads landed in one map and not the other, and the two maps then disagreed
   * about whether an account existed. It also doubled the window in which the live Worker can create
   * cards this pass will never see. Measured: ~70 new Accounts cards in a ten-minute window.
   */
  console.log("  indexing Accounts cards and their relation-cell sizes (one pass)…");

  /**
   * THE LINK CEILING — where monday actually stops accepting links into a relation cell.
   *
   * board_relation columns are PAIRED, so every contact -> account write also grows the ACCOUNT's own
   * cell. Measured live on 2026-09-11: HubSpot company 37258070678 has 2,007 associated contacts, and
   * its Accounts card accepted links up to 751 before monday began rejecting every further write.
   * Each rejection fell to the isolate path, which retried all 10 records individually with
   * exponential backoff — roughly two minutes burnt per contact.
   *
   * THE FIRST VERSION OF THIS GUARD CAPPED AT 200 AND THAT WAS WRONG. 200 was a guess made while the
   * pass was stalling; the platform's real limit is ~750. Capping at 200 abandoned roughly 2,705
   * relations monday would have accepted without complaint — a self-inflicted data gap, not a
   * platform one. 740 sits just under the measured 751 and gives up nothing real.
   *
   * Only 13 companies in this portal exceed even 200 contacts (2,007 / 1,581 / 1,105 / 639 / 555 /
   * 423 / 303 / 297 / 250 / 238 / …), so the ceiling now binds on two or three of them rather than 13.
   * For those, skipping remains the better product answer as well as the faster one: a relation cell
   * holding 751 links is unusable to the salesperson it exists for, and the association stays intact
   * in HubSpot, which is where that many-to-one fact belongs.
   *
   * The counter starts from ONE up-front read of the whole Accounts board and then tracks our own
   * queued links, so the ceiling is enforced against the PROJECTED size at no per-record cost.
   */
  /**
   * VALIDATED, because `Number(undefined)` is NaN and `n >= NaN` is ALWAYS FALSE — so a bare
   * `--relation-cap` with no value, or a typo'd one, silently disabled the ceiling completely rather
   * than failing. That is the worst possible failure mode for a guard: the flag that exists to make
   * it stricter is the flag that removes it. `??` does not catch it either, since NaN is not nullish.
   */
  const LINK_CEILING = Number(args.relationCap ?? 740);
  if (!Number.isFinite(LINK_CEILING) || LINK_CEILING <= 0)
    throw new Error(`--relation-cap must be a positive number; got ${JSON.stringify(args.relationCap)}`
      + ` (an invalid value would disable the link ceiling entirely, not tighten it)`);
  console.log(`  reading current link counts on the Accounts board (ceiling ${LINK_CEILING})…`);
  // KEYED BY MONDAY ITEM ID, not HubSpot company id: the thing that fills up is the Accounts CARD's
  // relation cell. Keying it by what actually has the limit also lets planContactLinks give a slot
  // back when a replacement write drops a link, with no itemId -> companyId reverse index.
  const links = new Map();
  const accounts = new Map();            // HubSpot company id -> Accounts card item ids
  {
    const relAcct = CRM_ACCOUNTS.associations?.find(a => a.relationCol)?.relationCol;
    let cursor = null, checked = 0, blank = 0;
    do {
      const page = (await monday(M,
        `query ($b: ID!, $c: String, $n: Int!, $ids: [String!]) {
           boards(ids: [$b]) { items_page(limit: $n, cursor: $c) {
             cursor items { id column_values(ids: $ids) {
               id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
        { b: CRM_ACCOUNTS.boardId, c: cursor, n: args.itemsPage, ids: [CRM_ACCOUNTS.idCol, relAcct] }
      )).boards[0].items_page;
      for (const it of page.items) {
        const n = (it.column_values.find(c => c.id === relAcct)?.linked_item_ids ?? []).length;
        links.set(String(it.id), n);
        checked++;
        const hsId = (it.column_values.find(c => c.id === CRM_ACCOUNTS.idCol)?.text ?? "").trim();
        if (!hsId) { blank++; continue; }
        if (!accounts.has(hsId)) accounts.set(hsId, []);
        accounts.get(hsId).push(String(it.id));
      }
      cursor = page.cursor;
    } while (cursor);
    const atCeiling = [...links.values()].filter(n => n >= LINK_CEILING).length;
    console.log(`  ${checked} Accounts cards, ${accounts.size} distinct HubSpot ids, ${blank} with none`);
    console.log(`  ${atCeiling} of ${checked} already hold >= ${LINK_CEILING} links`
      + ` — NEW links to those are skipped (existing ones are always kept)`);
    if (!accounts.size) throw new Error("no Accounts cards have HubSpot IDs — run --object companies first");
  }

  // Every Contacts card with a HubSpot id, plus whatever it is already linked to.
  const cards = [];
  let cursor = null;
  do {
    const page = (await monday(M,
      `query ($b: ID!, $c: String, $n: Int!, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: $n, cursor: $c) {
           cursor items { id column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: CRM_CONTACTS.boardId, c: cursor, n: args.itemsPage, ids: [CRM_CONTACTS.idCol, rel] }
    )).boards[0].items_page;
    for (const it of page.items) {
      const hsId = (it.column_values.find(c => c.id === CRM_CONTACTS.idCol)?.text ?? "").trim();
      if (!hsId) continue;
      if (args.only && !args.only.has(String(it.id))) continue;
      const linked = (it.column_values.find(c => c.id === rel)?.linked_item_ids ?? []).map(String);
      cards.push({ itemId: it.id, hsId, linked });
    }
    cursor = page.cursor;
    if (cards.length % 5000 === 0 && cards.length) console.log(`  read ${cards.length} contact cards…`);
  } while (cursor);
  console.log(`  ${cards.length} contact cards carry a HubSpot ID`
    + (args.only ? ` (restricted to the ${args.only.size} --only ids)` : ""));
  if (args.only && cards.length !== args.only.size)
    console.log(`  WARNING: ${args.only.size - cards.length} of the --only ids were not found on the board`);

  const byHsId = new Map(cards.map(c => [c.hsId, c]));
  const result = {
    withAssociations: 0, alreadyCorrect: 0, written: 0, noAccountCard: 0,
    multiCompany: 0, failed: [], missingCompanyIds: new Set(), oversizedAccount: 0,
    cappedOnly: 0, cappedCompanies: new Map(),
    preservedExtra: 0, contactsWithExtra: 0,
    rescuedMidRun: 0, assocReadErrors: 0, noCompanyReported: 0,
  };
  const pending = [];
  const drainRelations = async (final = false) => {
    const ready = () => pending.length >= args.batch || (final && pending.length > 0);
    while (ready()) {
      const chunks = [];
      while (chunks.length < args.concurrency && ready()) chunks.push(pending.splice(0, args.batch));
      if (args.apply) await Promise.all(chunks.map(c => flushRelations(M, CRM_CONTACTS, rel, c, result, links, LINK_CEILING)));
      else result.written += chunks.reduce((n, c) => n + c.length, 0);
    }
  };

  for (let i = 0; i < cards.length; i += 100) {
    const chunk = cards.slice(i, i + 100);
    const res = await fetch(`${HS_API}/crm/v4/associations/contacts/companies/batch/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: chunk.map(c => ({ id: c.hsId })) }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body === null) {
      // A whole chunk failing is a transport problem, not a data problem: record it and continue so
      // one bad chunk cannot abandon the other 93,900 contacts. An UNPARSEABLE body counts too — it
      // used to fall through as `{}` and silently drop all 100 contacts as if they had no companies.
      result.failed.push({ chunk: `${i}-${i + chunk.length}`, reason: `http ${res.status} ${JSON.stringify(body).slice(0, 200)}` });
      continue;
    }
    /**
     * PARTIAL FAILURES ARE COUNTED, not inferred from the absence of a row — but "no companies" is
     * NOT a failure, and HubSpot reports it as one.
     *
     * This endpoint answers 207 MULTI-STATUS when any input "fails", and 207 passes `res.ok`, so a
     * real partial failure was previously invisible: a missing row could mean either "no companies"
     * or "this input errored", and up to 100 contacts per chunk could be dropped with the pass
     * reporting nothing wrong.
     *
     * THE FIRST VERSION OF THIS CHECK TREATED EVERY PER-INPUT ERROR AS A FAILURE, AND THE DRY RUN
     * CAUGHT IT. HubSpot represents "this contact has no associated company" as a per-input error
     * with subCategory crm.associations.NO_ASSOCIATIONS_FOUND — 99 of the first 100 contacts scanned.
     * Counting those as failures would have reported tens of thousands of perfectly normal records as
     * broken and buried any genuine error among them. So the benign category is classified out, and
     * only what remains is a failure worth reporting.
     */
    const errs = body.errors ?? [];
    const benign = errs.filter(e =>
      e?.subCategory === "crm.associations.NO_ASSOCIATIONS_FOUND" || e?.category === "OBJECT_NOT_FOUND");
    const real = errs.filter(e => !benign.includes(e));
    result.noCompanyReported += benign.length;
    if (real.length || (body.numErrors ?? 0) > errs.length) {
      // The second clause matters: if numErrors exceeds the errors array we were given, the shortfall
      // is unexplained and must not be assumed benign.
      const n = Math.max(real.length, (body.numErrors ?? 0) - benign.length);
      result.assocReadErrors += n;
      result.failed.push({
        chunk: `${i}-${i + chunk.length}`,
        reason: `http ${res.status} with ${n} unexplained per-input error(s): ${JSON.stringify(real).slice(0, 200)}`,
      });
    }
    for (const r of body.results ?? []) {
      const card = byHsId.get(String(r.from?.id ?? ""));
      if (!card) continue;
      const companyIds = (r.to ?? []).map(t => String(t.toObjectId)).filter(x => /^\d+$/.test(x));
      if (!companyIds.length) continue;
      result.withAssociations++;
      if (companyIds.length > 1) result.multiCompany++;

      /**
       * ADDITIVE-ONLY, and projected against the ceiling. The arithmetic lives in
       * scripts/relation-plan.mjs and is unit-tested, because the version written inline here shipped
       * three defects at once: it charged already-linked associations against the ceiling
       * (double-counting every existing link), it dropped capped accounts out of `want` — which
       * DELETES them, since the write replaces the cell rather than appending — and it never gave a
       * slot back when a replacement removed a link.
       *
       * The third of those is now moot: this pass no longer removes anything at all. `item_ids`
       * replaces the cell, so a `want` built purely from HubSpot's current associations would delete
       * every link HubSpot does not presently assert — including links to the 414 Accounts cards that
       * carry no HubSpot ID and therefore CANNOT appear in `want`. Those are salespeople's own work.
       * See the header of relation-plan.mjs for the full argument.
       */
      const plan = planContactLinks({
        companyIds, linked: card.linked, counts: links, accounts, ceiling: LINK_CEILING,
      });
      for (const cid of plan.missing) result.missingCompanyIds.add(cid);
      for (const cid of plan.capped) {
        result.oversizedAccount++;
        result.cappedCompanies.set(cid, (result.cappedCompanies.get(cid) ?? 0) + 1);
      }
      // Measured, never acted on: links this pass preserves because HubSpot does not assert them.
      if (plan.extra.length) { result.preservedExtra += plan.extra.length; result.contactsWithExtra++; }
      // Separated deliberately: "their company has no card" is an unfinished import, while "their
      // company is full" is a permanent platform limit. Reporting both as noAccountCard would have
      // read as import breakage.
      if (plan.outcome === CAPPED) { result.cappedOnly++; continue; }
      if (plan.outcome === NO_ACCOUNT_CARD) { result.noAccountCard++; continue; }
      if (plan.outcome === ALREADY_CORRECT) { result.alreadyCorrect++; continue; }
      pending.push({ itemId: card.itemId, want: plan.want });
    }

    // Chunked to exactly args.batch, for the same reason the create path is: monday rejects an
    // over-large aliased mutation document outright, and `pending` can hold a whole 100-contact chunk.
    await drainRelations();

    if ((i / 100) % 10 === 0)
      console.log(`  ${Math.min(i + 100, cards.length)}/${cards.length} contacts checked,`
        + ` ${args.apply ? "linked" : "would link"} ${result.written}`
        + `${result.failed.length ? `, ${result.failed.length} failed` : ""}`);
    if (result.written >= args.limit) { console.log(`  reached --limit ${args.limit}`); break; }

    /**
     * STOP ON SYSTEMATIC FAILURE rather than grinding through 94,000 records against a broken write
     * path. Each isolated failure costs ~126s of retry backoff and ratchets the global throttle, so
     * "keep going and report at the end" is not a cheap default — 40 consecutive failures is already
     * over an hour spent learning nothing. A run that stops here is trivially resumable: the pass is
     * idempotent and re-reads real state.
     *
     * Consecutive, not cumulative: isolated failures scattered across a long run are the isolate path
     * working as intended, while an unbroken streak means the write itself is wrong.
     */
    if ((result.consecutiveFailures ?? 0) >= 40)
      throw new Error(`${result.consecutiveFailures} consecutive relation writes failed —`
        + ` stopping rather than continuing. Last: ${result.failed.at(-1)?.reason ?? "?"}`);
  }
  await drainRelations(true);

  console.log(`\n--- RELATIONS ${args.apply ? "WRITTEN" : "PLANNED"} ---`);
  console.log(`  contacts with a HubSpot company association : ${result.withAssociations}`);
  console.log(`  relation already correct (no write needed)   : ${result.alreadyCorrect}`);
  console.log(`  ${args.apply ? "relations written" : "would write"}  : ${result.written}`);
  console.log(`  contacts linked to >1 company               : ${result.multiCompany}`);
  console.log(`  skipped: associated company has no Accounts card : ${result.noAccountCard}`);
  console.log(`  distinct HubSpot company ids with no card   : ${result.missingCompanyIds.size}`);
  console.log(`  skipped: account at monday's link ceiling   : ${result.oversizedAccount} pairs`
    + ` across ${result.cappedCompanies.size} accounts`);
  console.log(`  contacts left with NO link solely because of it : ${result.cappedOnly}`);
  // This pass is additive-only, so these are PRESERVED, not removed. The figure exists so the size of
  // the monday/HubSpot divergence is known rather than guessed, should a reconciliation ever be asked
  // for — it would need its own audited pass and an export of exactly what it intends to drop.
  console.log(`  links preserved that HubSpot does not assert : ${result.preservedExtra}`
    + ` on ${result.contactsWithExtra} contacts (NOT removed — this pass never removes)`);
  // links is keyed by monday item id, so the held count is looked up through the accounts index.
  for (const [cid, n] of [...result.cappedCompanies].sort((a, b) => b[1] - a[1]).slice(0, 20))
    console.log(`      HubSpot company ${cid}: ${n} contacts unlinked`
      + ` (card ${accounts.get(cid)?.[0] ?? "?"} holds ${links.get(String(accounts.get(cid)?.[0])) ?? "?"})`);
  // Links that appeared between the contacts scan and the write, unioned in at flush time rather than
  // replaced away. A non-zero figure is the mid-run window doing real damage under snapshot-only.
  console.log(`  links rescued by the pre-write re-read : ${result.rescuedMidRun}`);
  // Benign: HubSpot reports "no associated company" as a per-input error. Counted separately so it
  // can never be mistaken for breakage, and so the total reconciles against the contact count.
  console.log(`  HubSpot reported "no company" for       : ${result.noCompanyReported} contacts`);
  console.log(`  UNEXPLAINED per-input read errors       : ${result.assocReadErrors}`);
  // An account marked full by repeated write rejections rather than by the up-front count. A non-zero
  // figure means the projection was a lower bound there — usually the live Worker linking past it.
  console.log(`  accounts marked full by write rejection: ${result.markedFull ?? 0}`);
  console.log(`  FAILED : ${result.failed.length}`);
  for (const f of result.failed.slice(0, 10)) console.log(`      ${f.chunk ?? f.itemId}: ${f.reason}`);
  if (result.missingCompanyIds.size)
    console.log(`  (a non-zero "no card" count means --object companies has not finished)`);
  return result;
}

/**
 * Write several relation columns in one request, degrading to one-at-a-time on failure.
 *
 * RE-READS EACH CELL IMMEDIATELY BEFORE WRITING IT, and this is what makes "additive-only" true in
 * the strong sense rather than only against a stale snapshot.
 *
 * `card.linked` is read during the contacts scan, which takes tens of minutes, and the write lands at
 * the end of it. In that window the live Worker is creating cards and linking relations, and a human
 * may add one in the UI — and because the write REPLACES the cell, any link that appeared after our
 * read is absent from `want` and would be destroyed. Preserving what we READ is not the same as
 * preserving what is THERE; only a read at write time gets that right.
 *
 * The cost is one query per batch, not per record — roughly 10% overhead at --batch 10 — and it pays
 * for itself whenever the re-read shows the cell already holds everything we wanted, which skips the
 * write and the webhook it would have produced.
 *
 * Links discovered here are deliberately NOT charged against the projection: they were made by
 * someone else, and the up-front counter never saw them. The projection is already a lower bound for
 * exactly this reason — the live Worker links without any ceiling of its own — so the ceiling is
 * best-effort by nature. Overshooting it costs a monday rejection that the isolate path already
 * handles; undershooting costs real relations, which it does not.
 */
async function flushRelations(M, spec, rel, pending, result, links, ceiling) {
  if (!pending.length) return;

  try {
    const fresh = await monday(M,
      `query ($i: [ID!], $c: [String!]) { items(ids: $i) {
         id column_values(ids: $c) { id ... on BoardRelationValue { linked_item_ids } } } }`,
      { i: pending.map(p => p.itemId), c: [rel] });
    const nowLinked = new Map((fresh.items ?? []).map(it =>
      [String(it.id), (it.column_values?.[0]?.linked_item_ids ?? []).map(String)]));
    for (const p of pending) {
      const current = nowLinked.get(String(p.itemId));
      if (!current) continue;                       // item unreadable; write what we planned
      const union = [...new Set([...current, ...p.want.map(String)])];
      if (union.length > p.want.length)
        result.rescuedMidRun += union.length - p.want.length;
      void union;
      p.alreadySatisfied = union.length === current.length;
    }
  } catch (e) {
    // A failed re-read must not abandon the batch: fall through and write the planned set. That is the
    // pre-existing behaviour, so this can only ever be as good as before, never worse.
    console.log(`  [flush] pre-write re-read failed, writing the planned set: ${String(e).slice(0, 120)}`);
  }

  // Nothing left to do for cells that already contain everything we intended.
  const satisfied = pending.filter(p => p.alreadySatisfied);
  if (satisfied.length) {
    result.alreadyCorrect += satisfied.length;
    pending = pending.filter(p => !p.alreadySatisfied);
    if (!pending.length) return;
  }

  const decls = pending.map((_, i) => `$i${i}: ID!, $v${i}: JSON!`).join(", ");
  const calls = pending.map((_, i) =>
    `r${i}: change_multiple_column_values(board_id: $b, item_id: $i${i}, column_values: $v${i}) { id }`).join("\n    ");
  const vars = { b: spec.boardId };
  pending.forEach((p, i) => {
    vars[`i${i}`] = p.itemId;
    vars[`v${i}`] = JSON.stringify({ [rel]: { item_ids: p.want.map(Number) } });
  });
  try {
    await monday(M, `mutation ($b: ID!, ${decls}) {\n    ${calls}\n  }`, vars);
    result.written += pending.length;
    result.consecutiveFailures = 0;
  } catch (e) {
    if (pending.length === 1) {
      const one = pending[0];
      result.failed.push({ itemId: one.itemId, reason: String(e).slice(0, 300) });
      result.consecutiveFailures = (result.consecutiveFailures ?? 0) + 1;

      /**
       * A REJECTED WRITE NOW FEEDS BACK INTO THE PROJECTION. This is the mechanism behind the original
       * stall, and it was never fixed by raising the ceiling — only by not needing it.
       *
       * The projection can be too LOW as well as too high: the live Worker links into these same cells
       * with no ceiling of its own, so our read-once counter is a lower bound. When it is low we write
       * into a full cell, and monday answers HTTP **200** with {"message":"Internal Server Error"} —
       * indistinguishable from a transient fault, so isRetryableError correctly treats it as retryable
       * and spends 2+4+8+16+32+64 = 126s of backoff. That is precisely the measured "~2 minutes per
       * contact". The batch then isolates and pays it again per item.
       *
       * The damage was never the 126s; it was that NOTHING RECORDED THE CELL AS FULL, so every one of
       * that account's remaining contacts repeated the penalty — days, for the 2,007-contact account,
       * with no abort. Each retry also ratchets the GLOBAL throttle x2 toward 8s, decaying only 10%
       * per success, so one full cell drags the entire pass down with it.
       *
       * Since the full-cell error is indistinguishable from a transient one, this does not try to
       * parse it. It counts failures per account and, on the third, marks the account unavailable.
       * Three strikes bounds the cost at ~6 minutes per full account instead of days, and a
       * transient fault has to be unlucky three times on the same account to trip it — at which
       * point declining to add more links to that one account is the right call anyway.
       */
      if (links) {
        result.failuresByAccount ??= new Map();
        for (const itemId of one.want.map(String)) {
          const n = (result.failuresByAccount.get(itemId) ?? 0) + 1;
          result.failuresByAccount.set(itemId, n);
          if (n >= 3 && Number.isFinite(links.get(itemId) ?? 0)) {
            links.set(itemId, Infinity);
            result.markedFull = (result.markedFull ?? 0) + 1;
            console.log(`  [ceiling] account card ${itemId} failed ${n} writes in a row —`
              + ` treating its cell as full; no further links will be added to it`);
          }
        }
      }
      return;
    }
    console.log(`  [isolate] a relation batch of ${pending.length} failed; retrying individually`);
    for (const one of pending) await flushRelations(M, spec, rel, [one], result, links, ceiling);
  }
}

// ---------------------------------------------------------------- pass 4: deal relations

/**
 * PASS 4 — the Deal's three relations: Contacts, Accounts and Line Items.
 *
 * THE CANARY IS WHY THIS EXISTS. The create pass writes column VALUES only; relations were always a
 * separate pass, and for Contacts that was `--object relations`. Nobody had written the Deals
 * equivalent, so the 40-deal canary produced 40 correct cards with 0/22 contacts, 0/40 accounts and
 * 0/44 line items linked — a historical import would have created 8,655 deals with no relationships
 * at all, on boards whose entire purpose is showing them.
 *
 * ADDITIVE-ONLY, by reusing planContactLinks unchanged rather than reimplementing the rule. That
 * function is what five rounds of defects on the Contacts pass produced: `want` starts as the links
 * the card already has and can only grow, so a full-replacement write can never drop one. Calling it
 * once per relation column gets all three directions for free, with the same guarantee.
 *
 * NO TRUNCATION RISK HERE, which is worth stating because it is the bug that was clearing Contacts
 * links two days ago: measured maxima are 9 contacts, 2 companies and 12 line items per deal, all far
 * inside the 100-association page, so the read is never partial. The ceiling is kept at 740 anyway —
 * a company can carry 154 deals, and the guard costs nothing when it does not bind.
 */
async function runDealRelations(M, H, mod, args) {
  const { CRM_DEALS, CRM_CONTACTS, CRM_ACCOUNTS, CRM_LINE_ITEMS } = mod;
  const CEILING = 740;

  const DIRS = [
    { to: "contacts",   spec: CRM_CONTACTS,   rel: CRM_DEALS.associations.find(a => a.toObject === "contacts").relationCol },
    { to: "companies",  spec: CRM_ACCOUNTS,   rel: CRM_DEALS.associations.find(a => a.toObject === "companies").relationCol },
    { to: "line_items", spec: CRM_LINE_ITEMS, rel: CRM_DEALS.associations.find(a => a.toObject === "line_items").relationCol },
  ];

  console.log(`\n=== ${args.apply ? "DEAL RELATIONS" : "PLAN DEAL RELATIONS"} ===`);
  for (const d of DIRS) {
    console.log(`  indexing ${d.to} board ${d.spec.boardId}…`);
    d.index = (await indexBoard(M, d.spec, args.itemsPage)).index;
    d.counts = new Map();
    console.log(`    ${d.index.size} cards carry a HubSpot ID`);
  }

  // Every Deals card with a HubSpot id, plus what each relation column already holds.
  const cards = [];
  {
    let cursor = null;
    do {
      const page = (await monday(M,
        `query ($b: ID!, $c: String, $n: Int!, $ids: [String!]) {
           boards(ids: [$b]) { items_page(limit: $n, cursor: $c) {
             cursor items { id column_values(ids: $ids) {
               id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
        { b: CRM_DEALS.boardId, c: cursor, n: args.itemsPage,
          ids: [CRM_DEALS.idCol, ...DIRS.map(d => d.rel)] })).boards[0].items_page;
      for (const it of page.items) {
        const hsId = (it.column_values.find(c => c.id === CRM_DEALS.idCol)?.text ?? "").trim();
        if (!hsId) continue;
        if (args.onlyHs && !args.onlyHs.has(hsId)) continue;
        const linked = {};
        for (const d of DIRS)
          linked[d.to] = (it.column_values.find(c => c.id === d.rel)?.linked_item_ids ?? []).map(String);
        cards.push({ itemId: it.id, hsId, linked });
      }
      cursor = page.cursor;
    } while (cursor);
  }
  console.log(`  ${cards.length} Deals cards carry a HubSpot ID`
    + (args.onlyHs ? ` (restricted to the ${args.onlyHs.size} --only-hs ids)` : ""));

  const byHsId = new Map(cards.map(c => [c.hsId, c]));
  const result = { written: 0, alreadyCorrect: 0, failed: [], preservedExtra: 0,
    rescuedMidRun: 0, assocReadErrors: 0, noCompanyReported: 0, markedFull: 0,
    linked: { contacts: 0, companies: 0, line_items: 0 },
    missing: { contacts: new Set(), companies: new Set(), line_items: new Set() } };

  for (let i = 0; i < cards.length; i += 100) {
    const chunk = cards.slice(i, i + 100);
    const want = new Map(chunk.map(c => [c.itemId, { itemId: c.itemId, cols: {} }]));

    for (const d of DIRS) {
      const res = await fetch(`${HS_API}/crm/v4/associations/deals/${d.to}/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: chunk.map(c => ({ id: c.hsId })) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body === null) {
        result.failed.push({ chunk: `${i}-${i + chunk.length}/${d.to}`, reason: `http ${res.status}` });
        continue;
      }
      for (const row of body.results ?? []) {
        const card = byHsId.get(String(row.from?.id ?? ""));
        if (!card) continue;
        const ids = (row.to ?? []).map(t => String(t.toObjectId)).filter(x => /^\d+$/.test(x));
        if (!ids.length) continue;
        const plan = planContactLinks({
          companyIds: ids, linked: card.linked[d.to],
          counts: d.counts, accounts: d.index, ceiling: CEILING,
        });
        for (const m of plan.missing) result.missing[d.to].add(m);
        result.preservedExtra += plan.extra.length;
        if (plan.added.length) {
          want.get(card.itemId).cols[d.rel] = plan.want;
          result.linked[d.to] += plan.added.length;
        }
      }
    }

    const pending = [...want.values()].filter(p => Object.keys(p.cols).length);
    if (!args.apply) { result.written += pending.length; }
    else for (let j = 0; j < pending.length; j += args.batch)
      await flushDealRelations(M, CRM_DEALS, pending.slice(j, j + args.batch), result);

    if ((i / 100) % 5 === 0)
      console.log(`  ${Math.min(i + 100, cards.length)}/${cards.length} deals checked,`
        + ` ${args.apply ? "wrote" : "would write"} ${result.written}`);
  }

  console.log(`\n--- DEAL RELATIONS ${args.apply ? "WRITTEN" : "PLANNED"} ---`);
  console.log(`  deals ${args.apply ? "written" : "to write"} : ${result.written}`);
  for (const d of DIRS)
    console.log(`  links added -> ${d.to.padEnd(11)}: ${result.linked[d.to]}`
      + `   (targets with no card: ${result.missing[d.to].size})`);
  console.log(`  links preserved that HubSpot does not assert : ${result.preservedExtra} (NOT removed)`);
  console.log(`  FAILED : ${result.failed.length}`);
  for (const f of result.failed.slice(0, 10)) console.log(`      ${f.chunk ?? f.itemId}: ${f.reason}`);
  return result;
}

/** Write several deals' relation columns in one request, degrading to one-at-a-time on failure.
 *  Mirrors flushRelations, including its pre-write re-read: the Deals board has the same paired
 *  columns and the same mid-run window in which the live Worker or a person can add a link. */
async function flushDealRelations(M, spec, pending, result) {
  if (!pending.length) return;
  const cols = [...new Set(pending.flatMap(p => Object.keys(p.cols)))];
  try {
    const fresh = await monday(M,
      `query ($i: [ID!], $c: [String!]) { items(ids: $i) {
         id column_values(ids: $c) { id ... on BoardRelationValue { linked_item_ids } } } }`,
      { i: pending.map(p => p.itemId), c: cols });
    const now = new Map((fresh.items ?? []).map(it => [String(it.id), it.column_values ?? []]));
    for (const p of pending) {
      const cur = now.get(String(p.itemId));
      if (!cur) continue;
      for (const [col, ids] of Object.entries(p.cols)) {
        const live = (cur.find(c => c.id === col)?.linked_item_ids ?? []).map(String);
        const union = [...new Set([...live, ...ids.map(String)])];
        if (union.length > ids.length) result.rescuedMidRun += union.length - ids.length;
        p.cols[col] = union;
      }
    }
  } catch (e) {
    console.log(`  [flush] pre-write re-read failed, writing the planned set: ${String(e).slice(0, 120)}`);
  }

  const decls = pending.map((_, i) => `$i${i}: ID!, $v${i}: JSON!`).join(", ");
  const calls = pending.map((_, i) =>
    `r${i}: change_multiple_column_values(board_id: $b, item_id: $i${i}, column_values: $v${i}) { id }`).join("\n    ");
  const vars = { b: spec.boardId };
  pending.forEach((p, i) => {
    vars[`i${i}`] = p.itemId;
    vars[`v${i}`] = JSON.stringify(Object.fromEntries(
      Object.entries(p.cols).map(([col, ids]) => [col, { item_ids: ids.map(Number) }])));
  });
  try {
    await monday(M, `mutation ($b: ID!, ${decls}) {\n    ${calls}\n  }`, vars);
    result.written += pending.length;
  } catch (e) {
    if (pending.length === 1) {
      result.failed.push({ itemId: pending[0].itemId, reason: String(e).slice(0, 300) });
      return;
    }
    console.log(`  [isolate] a deal-relation batch of ${pending.length} failed; retrying individually`);
    for (const one of pending) await flushDealRelations(M, spec, [one], result);
  }
}

// ---------------------------------------------------------------- selftest

/**
 * Prove the payload builder against a synthetic record with NO network at all.
 *
 * Worth having because the expensive failure mode of this script is not crashing, it is succeeding
 * while writing subtly wrong values into 120k cards. This shows the exact monday payload one record
 * produces, using the Worker's own mapping code, so it can be eyeballed before any token is involved.
 */
function selftest(mod) {
  const { buildColumnValues, itemName, targetGroup, propertiesForSpec,
          CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS } = mod;
  const ctx = {
    labels: {
      contactStatus: { "1New": "1新增" }, contactPriority: { "P1_2小时内": "P1_2小时内" },
      leadStatus: { NEW: "New" }, lifecycleStage: { lead: "Lead" }, contactSource: { Others: "其他" },
      contactVendor: {}, contactSalesPerson: { "Emily You": "Emily You" }, contactDepartment: {},
      contactCountries: {}, contactCity: {}, contactLeadSourceSub: {}, salesUser: { "12345": "Emily You" },
      companyType: {}, partnerWith: {},
      // DEALS. Two of the three 赢单 stage ids are included deliberately, so the fixture shows they
      // render DIFFERENTLY — that qualification is the whole reason a reverse stage write is safe.
      crmStage: {
        "cd8b9086-9983-4f82-bdf0-83dfd3fd96ef": "SF-Sales / 赢单",
        "d0e83c62-647f-4511-bc00-4b92a752c690": "SF-Maint / 赢单",
        qualifiedtobuy: "Sales / Qualified To Buy",
      },
      crmPipeline: { default: "Sales Pipeline", "551f4f6c-ced0-4069-b1be-f0d3dc33bf2d": "Salesforce - Sales" },
      stage: { "d0e83c62-647f-4511-bc00-4b92a752c690": "Won" },
      dealtype: { newbusiness: "New Business" }, priority: { high: "High" },
      vendor: { "37Docusign": "37Docusign" },
      liBrand: { Docusign: "Docusign" }, liFamily: { "1 产品": "1 产品" }, liSubcategory: {},
      liPricingModel: { flat: "Flat" }, liBillingFreq: { annually: "Annually" },
      liTaxRate: { "15274908": "GST 9%" }, liIsActive: { true: "Yes" }, liCurrency: { USD: "USD" },
    },
    ownersById: { 12345: { name: "Emily You", email: "emily@dkmeco.com" } },
    mondayUsersByEmail: { "emily@dkmeco.com": "777" },
    mondayEmailByUserId: { 777: "emily@dkmeco.com" },
    ownerIdByEmail: { "emily@dkmeco.com": "12345" },
    portalId: "39939588",
  };
  const cases = [
    [CRM_CONTACTS, { id: "548911732425", properties: {
      firstname: "Shandy", lastname: "Febiarisma", email: "shandy@example.com", jobtitle: "Analyst",
      phone: "+60123456789", leadstatus: "1New", priority__c: "P1_2小时内", hs_lead_status: "NEW",
      lifecyclestage: "lead", leadsource: "Others", hubspot_owner_id: "12345",
      createdate: "2026-09-09T03:13:03.285Z", lastmodifieddate: "2026-09-09T03:40:07.689Z",
    } }],
    [CRM_ACCOUNTS, { id: "21751102241", properties: {
      name: "HubSpot", domain: "hubspot.com", city: "Cambridge", state: "MA",
      annualrevenue: "1000000", numberofemployees: "7000",
      createdate: "2024-01-01T00:00:00Z", hs_lastmodifieddate: "2026-09-01T00:00:00Z",
    } }],
    // A contact with NO name at all — common across 94k records, and monday rejects an empty item name.
    [CRM_CONTACTS, { id: "999", properties: { email: "noname@example.com", lastmodifieddate: "2026-09-01T00:00:00Z" } }],
    // A DEAL in the Salesforce-Maintenance pipeline. Two things to read in the output: the STAGE must
    // render "SF-Maint / 赢单" and NOT the Sales pipeline's identically-labelled 赢单, and the
    // PROBABILITY must show 20, not 0.2 — HubSpot stores a fraction against a column rendering `%`,
    // and the board's Forecast Value formula multiplies that error into money.
    [CRM_DEALS, { id: "41579845025", properties: {
      dealname: "早川-分析-新增1minitab3年", pipeline: "551f4f6c-ced0-4069-b1be-f0d3dc33bf2d",
      dealstage: "d0e83c62-647f-4511-bc00-4b92a752c690", amount: "15600",
      hs_deal_stage_probability: "0.2", closedate: "2026-12-31T06:07:05.882Z",
      dealtype: "newbusiness", hs_priority: "high", deal_currency_code: "USD",
      vendorschang_shang_lai_yuan: "37Docusign", sales_user: "12345", hubspot_owner_id: "12345",
      hs_lastmodifieddate: "2026-09-11T06:09:27.260Z",
    } }],
    [CRM_LINE_ITEMS, { id: "343193001717", properties: {
      name: "Docusign-Business Pro Edition-Envelope Subscription", hs_sku: "DS-BP-ENV",
      quantity: "1", price: "2400", hs_cost_of_goods_sold: "1800", discount: "0",
      brand_isv: "Docusign", family: "1 产品", hs_pricing_model: "flat",
      recurringbillingfrequency: "annually", hs_tax_rate_group_id: "15274908",
      is_active: "true", hs_line_item_currency_code: "USD",
      service_date: "2026-10-01", hs_lastmodifieddate: "2026-09-10T08:02:04.278Z",
    } }],
  ];
  for (const [spec, rec] of cases) {
    const cv = buildColumnValues(rec, spec, ctx);
    cv[spec.syncStateCol] = rec.properties[spec.modifiedProp] ?? "";
    console.log(`\n--- ${spec.object} ${rec.id} ---`);
    console.log(`  item_name : ${JSON.stringify(itemName(rec, spec))}`);
    console.log(`  group     : ${JSON.stringify(targetGroup(rec, spec))}`);
    console.log(`  properties requested: ${propertiesForSpec(spec).length}`);
    console.log(`  column_values (${Object.keys(cv).length}):`);
    for (const [k, v] of Object.entries(cv)) console.log(`      ${k.padEnd(24)} ${JSON.stringify(v)}`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { mod, cleanup } = await loadWorker();
  try {
    if (args.selftest) return selftest(mod);

    const creds = readCredentials();
    const M = creds.MONDAY_API_TOKEN;
    const H = creds.HUBSPOT_ACCESS_TOKEN;
    if (!M || !H) {
      console.error("Missing credentials:");
      console.error(`  MONDAY_API_TOKEN     ${M ? "ok" : "MISSING"}`);
      console.error(`  HUBSPOT_ACCESS_TOKEN ${H ? "ok" : "MISSING"}`);
      console.error("");
      console.error("Provide them EITHER as environment variables in the same process that runs this");
      console.error("script, OR in worker/.dev.vars (git-ignored, Cloudflare's own local-secret file):");
      console.error("  MONDAY_API_TOKEN=eyJ...");
      console.error("  HUBSPOT_ACCESS_TOKEN=pat-na2-...");
      console.error("");
      console.error("(--selftest needs neither: it shows the payload one record produces, offline.)");
      process.exit(1);
    }
    const { CRM_CONTACTS, CRM_ACCOUNTS, CRM_DEALS, CRM_LINE_ITEMS, buildCtx } = mod;
    // object name -> spec. Deals and Line Items joined 2026-09-14; the create path is entirely
    // spec-driven, so they need no code of their own beyond this table.
    const SPECS = {
      contacts: CRM_CONTACTS, companies: CRM_ACCOUNTS,
      deals: CRM_DEALS, line_items: CRM_LINE_ITEMS,
    };

    if (args.preflight) {
      const problems = await preflight(M, H, mod, [CRM_ACCOUNTS, CRM_CONTACTS]);
      process.exitCode = problems ? 1 : 0;
      return;
    }
    if (!["contacts", "companies", "relations", "deals", "line_items", "deal-relations"].includes(args.object)) {
      console.error('--object must be "companies", "contacts", "relations", "deals", "line_items" or "deal-relations".');
      console.error("Run them IN THAT ORDER: relations can only link to Accounts cards that exist,");
      console.error("and line_items reference the deals they belong to.");
      process.exit(1);
    }
    if (args.object === "relations") {
      if (!args.apply) console.log("\nPLAN MODE — nothing will be written. Add --apply to write relations.");
      await runRelations(M, H, mod, args);
      return;
    }
    // Deals carry THREE relations (Contacts, Accounts, Line Items), so they get their own pass rather
    // than sharing the Contacts one. The 40-deal canary is what surfaced its absence: 40 correct cards
    // with 0/22, 0/40 and 0/44 links.
    if (args.object === "deal-relations") {
      if (!args.apply) console.log("\nPLAN MODE — nothing will be written. Add --apply to write relations.");
      await runDealRelations(M, H, mod, args);
      return;
    }
    const spec = SPECS[args.object];

    // The Worker's own context: owner map (including archived owners, or 481 contacts render a raw
    // owner id as a label), monday users by email, and every label dictionary the specs reference.
    console.log("building sync context (owners, monday users, label dictionaries)…");
    args.ctx = await buildCtx({ HUBSPOT_ACCESS_TOKEN: H, MONDAY_API_TOKEN: M, ENABLE_CRM: "true" });
    console.log(`  ${Object.keys(args.ctx.ownersById).length} HubSpot owners,`
      + ` ${Object.keys(args.ctx.mondayUsersByEmail).length} monday users,`
      + ` ${Object.keys(args.ctx.labels).length} label dictionaries`);

    if (!args.apply) console.log("\nPLAN MODE — nothing will be written. Add --apply to create cards.");
    if (args.createMissing) await runCreateMissing(M, H, mod, spec, args);
    else if (args.retryFailed) await runRetryFailed(M, H, mod, spec, args);
    else await runImport(M, H, mod, spec, args);
  } finally {
    cleanup();
  }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
