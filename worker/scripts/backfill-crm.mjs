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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MONDAY_API = "https://api.monday.com/v2";
const HS_API = "https://api.hubapi.com";

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = {
    object: "", apply: false, preflight: false, selftest: false, reset: false,
    limit: Infinity, batch: 10, itemsPage: 500, state: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--apply") a.apply = true;
    else if (k === "--preflight") a.preflight = true;
    else if (k === "--selftest") a.selftest = true;
    else if (k === "--reset") a.reset = true;
    else if (k === "--object") a.object = argv[++i];
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--batch") a.batch = Number(argv[++i]);
    else if (k === "--state") a.state = argv[++i];
  }
  if (!a.state && a.object) a.state = join(ROOT, "scripts", `.backfill-${a.object}.json`);
  return a;
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
    `export { CRM_CONTACTS, CRM_ACCOUNTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
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

/** True for the errors that mean "slow down" rather than "this request is wrong". */
function isThrottleError(status, body) {
  if (status === 429 || status === 503 || status === 502) return true;
  const s = JSON.stringify(body ?? "").toLowerCase();
  return s.includes("complexity") || s.includes("rate limit") || s.includes("too many requests")
    || s.includes("budget exhausted");
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
    if (isThrottleError(res.status, body) && attempt < 6) {
      throttle.gapMs = Math.min(throttle.max, Math.max(throttle.gapMs * 2, 500));
      const backoff = Number(body?.error_data?.retry_in_seconds ?? 0) * 1000 || 2000 * 2 ** attempt;
      console.log(`  [throttle] monday pushed back (http ${res.status}); waiting ${Math.round(backoff / 1000)}s,`
        + ` request gap now ${throttle.gapMs}ms`);
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
    console.log(`  [isolate] a batch of ${batch.length} failed; retrying individually`);
  }
  for (const one of batch) await flush(token, spec, [one], result);
}

// ---------------------------------------------------------------- hubspot side

/** One page of records with every property the spec maps. `after` is HubSpot's opaque cursor. */
async function hsPage(token, object, props, after, pageSize = 100) {
  const q = new URLSearchParams({ limit: String(pageSize), properties: props.join(","), archived: "false" });
  if (after) q.set("after", after);
  const body = await hubspot(token, `/crm/v3/objects/${object}?${q}`);
  return {
    records: (body.results ?? []).map(r => ({ id: String(r.id), properties: r.properties ?? {} })),
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

async function runImport(M, H, mod, spec, args) {
  const { propertiesForSpec, buildColumnValues, itemName, targetGroup } = mod;
  const props = propertiesForSpec(spec);
  const ctx = args.ctx;

  console.log(`\n=== ${args.apply ? "IMPORT" : "PLAN"} ${spec.object} -> board ${spec.boardId} ===`);
  console.log(`  fetching ${props.length} HubSpot properties per record`);

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

  let after = result.after, batch = [], pages = 0;
  const t0 = Date.now();
  do {
    const page = await hsPage(H, spec.object, props, after);
    pages++;
    for (const rec of page.records) {
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

      if (result.created + batch.length >= args.limit) break;
      if (batch.length >= args.batch) {
        if (args.apply) await flush(M, spec, batch, result);
        else result.created += batch.length;
        batch = [];
      }
    }
    after = page.after;
    result.after = after;
    if (args.apply) saveState(args.state, result);

    const rate = result.scanned / Math.max(1, (Date.now() - t0) / 1000);
    console.log(`  page ${pages}: scanned ${result.scanned}, ${args.apply ? "created" : "would create"} ${result.created},`
      + ` skipped ${result.skipped}, failed ${result.failed.length}  (${rate.toFixed(0)}/s)`);

    if (result.created >= args.limit) { console.log(`  reached --limit ${args.limit}`); break; }
  } while (after);

  if (batch.length) {
    if (args.apply) await flush(M, spec, batch, result);
    else result.created += batch.length;
  }
  if (args.apply) { result.after = after; saveState(args.state, result); }

  console.log(`\n--- ${spec.object} ${args.apply ? "IMPORTED" : "PLANNED"} ---`);
  console.log(`  scanned in HubSpot : ${result.scanned}`);
  console.log(`  ${args.apply ? "created" : "would create"} : ${result.created}`);
  console.log(`  skipped (already carded) : ${result.skipped}`);
  console.log(`  refused (no target group) : ${result.refusedNoGroup}`);
  console.log(`  FAILED : ${result.failed.length}`);
  for (const f of result.failed.slice(0, 20))
    console.log(`      ${f.hsId} ${f.name ? JSON.stringify(f.name) + " " : ""}${f.reason}`);
  if (result.failed.length > 20) console.log(`      … and ${result.failed.length - 20} more (see ${args.state})`);
  if (!after) console.log(`  HubSpot pagination COMPLETE (no further cursor)`);
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

  console.log("  indexing Accounts cards by HubSpot company id…");
  const { index: accounts } = await indexBoard(M, CRM_ACCOUNTS, args.itemsPage);
  console.log(`  ${accounts.size} Accounts cards carry a HubSpot ID`);
  if (!accounts.size) throw new Error("no Accounts cards have HubSpot IDs — run --object companies first");

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
      const linked = (it.column_values.find(c => c.id === rel)?.linked_item_ids ?? []).map(String);
      cards.push({ itemId: it.id, hsId, linked });
    }
    cursor = page.cursor;
    if (cards.length % 5000 === 0 && cards.length) console.log(`  read ${cards.length} contact cards…`);
  } while (cursor);
  console.log(`  ${cards.length} contact cards carry a HubSpot ID`);

  const byHsId = new Map(cards.map(c => [c.hsId, c]));
  const result = {
    withAssociations: 0, alreadyCorrect: 0, written: 0, noAccountCard: 0,
    multiCompany: 0, failed: [], missingCompanyIds: new Set(),
  };
  const pending = [];

  for (let i = 0; i < cards.length; i += 100) {
    const chunk = cards.slice(i, i + 100);
    const res = await fetch(`${HS_API}/crm/v4/associations/contacts/companies/batch/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: chunk.map(c => ({ id: c.hsId })) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A whole chunk failing is a transport problem, not a data problem: record it and continue so
      // one bad chunk cannot abandon the other 93,900 contacts.
      result.failed.push({ chunk: `${i}-${i + chunk.length}`, reason: `http ${res.status} ${JSON.stringify(body).slice(0, 200)}` });
      continue;
    }
    for (const r of body.results ?? []) {
      const card = byHsId.get(String(r.from?.id ?? ""));
      if (!card) continue;
      const companyIds = (r.to ?? []).map(t => String(t.toObjectId)).filter(x => /^\d+$/.test(x));
      if (!companyIds.length) continue;
      result.withAssociations++;
      if (companyIds.length > 1) result.multiCompany++;

      const want = [];
      for (const cid of companyIds) {
        const acct = accounts.get(cid);
        if (acct) want.push(acct[0]);            // [0]: duplicates are reported by --preflight
        else result.missingCompanyIds.add(cid);
      }
      if (!want.length) { result.noAccountCard++; continue; }

      const same = want.length === card.linked.length && want.every(x => card.linked.includes(x));
      if (same) { result.alreadyCorrect++; continue; }
      pending.push({ itemId: card.itemId, want });
    }

    if (pending.length >= args.batch) {
      if (args.apply) await flushRelations(M, CRM_CONTACTS, rel, pending.splice(0, pending.length), result);
      else { result.written += pending.length; pending.length = 0; }
    }
    if ((i / 100) % 10 === 0)
      console.log(`  ${Math.min(i + 100, cards.length)}/${cards.length} contacts checked,`
        + ` ${args.apply ? "linked" : "would link"} ${result.written}`);
    if (result.written >= args.limit) { console.log(`  reached --limit ${args.limit}`); break; }
  }
  if (pending.length) {
    if (args.apply) await flushRelations(M, CRM_CONTACTS, rel, pending, result);
    else result.written += pending.length;
  }

  console.log(`\n--- RELATIONS ${args.apply ? "WRITTEN" : "PLANNED"} ---`);
  console.log(`  contacts with a HubSpot company association : ${result.withAssociations}`);
  console.log(`  relation already correct (no write needed)   : ${result.alreadyCorrect}`);
  console.log(`  ${args.apply ? "relations written" : "would write"}  : ${result.written}`);
  console.log(`  contacts linked to >1 company               : ${result.multiCompany}`);
  console.log(`  skipped: associated company has no Accounts card : ${result.noAccountCard}`);
  console.log(`  distinct HubSpot company ids with no card   : ${result.missingCompanyIds.size}`);
  console.log(`  FAILED : ${result.failed.length}`);
  for (const f of result.failed.slice(0, 10)) console.log(`      ${f.chunk ?? f.itemId}: ${f.reason}`);
  if (result.missingCompanyIds.size)
    console.log(`  (a non-zero "no card" count means --object companies has not finished)`);
  return result;
}

/** Write several relation columns in one request, degrading to one-at-a-time on failure. */
async function flushRelations(M, spec, rel, pending, result) {
  if (!pending.length) return;
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
  } catch (e) {
    if (pending.length === 1) {
      result.failed.push({ itemId: pending[0].itemId, reason: String(e).slice(0, 300) });
      return;
    }
    console.log(`  [isolate] a relation batch of ${pending.length} failed; retrying individually`);
    for (const one of pending) await flushRelations(M, spec, rel, [one], result);
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
  const { buildColumnValues, itemName, targetGroup, propertiesForSpec, CRM_CONTACTS, CRM_ACCOUNTS } = mod;
  const ctx = {
    labels: {
      contactStatus: { "1New": "1新增" }, contactPriority: { "P1_2小时内": "P1_2小时内" },
      leadStatus: { NEW: "New" }, lifecycleStage: { lead: "Lead" }, contactSource: { Others: "其他" },
      contactVendor: {}, contactSalesPerson: { "Emily You": "Emily You" }, contactDepartment: {},
      contactCountries: {}, contactCity: {}, contactLeadSourceSub: {}, salesUser: { "12345": "Emily You" },
      companyType: {}, partnerWith: {},
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

    const M = process.env.MONDAY_API_TOKEN;
    const H = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!M || !H) {
      console.error("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN are both required.");
      console.error("(--selftest needs neither: it shows the payload one record produces, offline.)");
      process.exit(1);
    }
    const { CRM_CONTACTS, CRM_ACCOUNTS, buildCtx } = mod;

    if (args.preflight) {
      const problems = await preflight(M, H, mod, [CRM_ACCOUNTS, CRM_CONTACTS]);
      process.exitCode = problems ? 1 : 0;
      return;
    }
    if (!["contacts", "companies", "relations"].includes(args.object)) {
      console.error('--object must be "companies", "contacts" or "relations".');
      console.error("Run them IN THAT ORDER: relations can only link to Accounts cards that exist.");
      process.exit(1);
    }
    if (args.object === "relations") {
      if (!args.apply) console.log("\nPLAN MODE — nothing will be written. Add --apply to write relations.");
      await runRelations(M, H, mod, args);
      return;
    }
    const spec = args.object === "contacts" ? CRM_CONTACTS : CRM_ACCOUNTS;

    // The Worker's own context: owner map (including archived owners, or 481 contacts render a raw
    // owner id as a label), monday users by email, and every label dictionary the specs reference.
    console.log("building sync context (owners, monday users, label dictionaries)…");
    args.ctx = await buildCtx({ HUBSPOT_ACCESS_TOKEN: H, MONDAY_API_TOKEN: M, ENABLE_CRM: "true" });
    console.log(`  ${Object.keys(args.ctx.ownersById).length} HubSpot owners,`
      + ` ${Object.keys(args.ctx.mondayUsersByEmail).length} monday users,`
      + ` ${Object.keys(args.ctx.labels).length} label dictionaries`);

    if (!args.apply) console.log("\nPLAN MODE — nothing will be written. Add --apply to create cards.");
    await runImport(M, H, mod, spec, args);
  } finally {
    cleanup();
  }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
