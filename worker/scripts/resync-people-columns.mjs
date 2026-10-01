/**
 * BRING EVERY PEOPLE COLUMN ON THE FOUR CRM BOARDS BACK IN LINE WITH HUBSPOT. monday writes only.
 *
 * The old engine filled a People cell only when it was EMPTY; once it held anyone, HubSpot changes never
 * reached it. So Sales User and owner cells drifted: 41% of filled Contacts Sales User cells showed the
 * wrong person on 2026-09-23 (a HubSpot workflow reassigned ~5,300 contacts that morning), a second
 * person could survive in an owner cell, and the P&S Deal Owner column was never backfilled at all.
 * The new engine keeps them right from here on; this repairs what is already wrong.
 *
 * THE EXPECTED CELL IS EXACTLY WHAT THE WORKER WOULD WRITE, or the Worker undoes the repair: every write
 * here fires a monday webhook, and the new engine answers our own (integration-user) edits forward-only --
 * it re-derives the cell from HubSpot and rewrites it if it disagrees. So this computes the cell the way
 * the engine's People mapping does (src/mapping.ts formatValue "people", with src/sync.ts buildCtx's
 * lookups), step for step:
 *   HubSpot owner id -> that owner's email, lowercased (getOwners: archived owners read FIRST, active
 *   second, so an active record wins) -> the monday user with that email, lowercased (getUsersByEmail:
 *   users(limit:500), disabled users included) -> exactly that one person. When the owner has no email,
 *   or the email has no monday seat (joan zhang, 小优, archived owners), the cell is EMPTY -- the business's
 *   decision on 2026-09-23: "leave their sales user empty ... once they have [a seat], add them in".
 *
 * SHARED OWNER EMAILS ARE COUNTED, NOT EMPTIED. Nine HubSpot owners share one mailbox, Ida Liang's (the
 * department owners: Commercial, 华东销售, 华北销售, ...). buildCtx DROPS such an email from ownerIdByEmail
 * -- but that is the REVERSE map (a monday person back to an owner id), used only when a person edits a
 * cell. The forward mapping does not consult it: formatValue resolves each of those owners to Ida Liang's
 * seat ("Forward display is unaffected", sync.ts), and the column-level diff (reconcile.ts fieldDiffs)
 * would put her back into any cell emptied here. So those cells expect Ida Liang, exactly as the Worker
 * does; they are counted per column as sharedEmail, and the shared emails and their owner ids are listed
 * in the report. If the Worker's forward rule ever changes, this must change with it.
 *
 * WRITES, 8 cards per request (the throughput optimum measured during the historical import), without the
 * old failure mode: one rejected card used to fail the whole aliased mutation, which was re-sent six
 * times (re-firing the seven good writes' webhooks each time) and then aborted the run with no record.
 * Now a request is retried only when nothing in it can have applied (HTTP 429/5xx, rate limit,
 * complexity, network). If some aliases fail, the ones that succeeded are recorded as applied and ONLY
 * the failed cards are re-sent, each on its own; one that still fails is recorded with monday's error and
 * the run moves on. Three chunks in a row with nothing applied, or a 401/403, stop the run.
 *
 * RESUMABLE. The report is written after every chunk: per board, the item ids applied, the failures with
 * their errors, and how far the run got. An aborted run is resumed by running it again -- the diff is
 * recomputed from live data, so every cell already written reads as correct and is not written again.
 * Apply reports carry the time in their name, so a resumed run never overwrites the record of the first;
 * a second dry run the same day gets the time appended rather than replacing the first plan.
 *
 * MUST RUN ONLY AFTER THE NEW WORKER IS DEPLOYED: the old engine answers each write by moving the card back
 * to "Active Contacts", and the new build is placeOnly, so it never moves them back. --apply refuses unless
 * the new build is live (lib/repair-preflight.mjs requireNewBuild) and MONDAY_API_TOKEN is the integration
 * user the Worker writes as (requireIntegrationToken) -- a person's token would make every correction that
 * person's edit, which the engine pushes to HubSpot.
 *
 *   node scripts/resync-people-columns.mjs                 # dry run: counts per board and column
 *   node scripts/resync-people-columns.mjs --apply         # write the corrections
 *   node scripts/resync-people-columns.mjs --board 5028000495   # one board only
 *   node scripts/resync-people-columns.mjs --columns multiple_person_mm76ygkp,multiple_person_mm7d2qk6,multiple_person_mm7df31a --apply
 *                                                               # Sales User only (Contact owner feeds workflows)
 *
 * Needs HUBSPOT_CRM_APP_TOKEN and MONDAY_API_TOKEN in worker/.dev.vars (CRM_WORKER_URL optional). Prints no
 * credential.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CRM_WORKER_URL, requireIntegrationToken, requireNewBuild } from "./lib/repair-preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const H = v.HUBSPOT_CRM_APP_TOKEN, M = v.MONDAY_API_TOKEN;
if (!H || !M) { console.error("missing HUBSPOT_CRM_APP_TOKEN or MONDAY_API_TOKEN"); process.exit(1); }
const APPLY = process.argv.includes("--apply");
const flag = k => {
  const i = process.argv.indexOf(k);
  if (i < 0) return null;
  const x = process.argv[i + 1];
  if (x === undefined || x === "" || x.startsWith("--")) { console.error(`${k} needs a value`); process.exit(2); }
  return x;
};
const ONLY = flag("--board");
/**
 * --columns: repair only these People columns. Contacts "Contact owner" (multiple_person_mm6zap53) feeds
 * monday workflows 1940356127 / 1940358460 / 1940358614 (column audit 2026-09-17), which may re-stamp the
 * reminder anchor or notify on a change -- so Sales User can be repaired first and Contact owner on its own,
 * once what those workflows do is known. Without --columns, every People column is repaired.
 */
const COLUMNS = flag("--columns")?.split(",").map(s => s.trim()).filter(Boolean) ?? null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Refuse before reading anything when the run could write: see lib/repair-preflight.mjs.
if (APPLY) {
  try {
    await requireNewBuild(v.CRM_WORKER_URL || DEFAULT_CRM_WORKER_URL);
    await requireIntegrationToken(M);
  } catch (e) { console.error(`refusing --apply: ${e.message}`); process.exit(1); }
  console.log("pre-flight: the new CRM build is live and the monday token is the integration user");
}

async function hs(path, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com${path}`, { headers: { Authorization: `Bearer ${H}` } });
  if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2500 * (attempt + 1)); return hs(path, attempt + 1); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`hubspot ${path.slice(0, 80)}: ${r.status}`);
  return j;
}

/**
 * ONE monday request, returned RAW: { status, data, errors }. Re-sent only when nothing in it can have
 * applied -- a network failure, HTTP 429/5xx, or a rate-limit / complexity / concurrency error with no data
 * at all -- waiting as long as monday asks when it says. Anything else comes back to the caller as is, so
 * a mutation with some failed aliases is never blindly repeated. A 401/403 is marked `abort`.
 */
const TRANSIENT = /complexity|rate.?limit|budget|too many requests|throttl|concurren|temporar|timed? ?out|internal server error|service unavailable/i;
async function mondayRaw(query, variables = {}, attempt = 0) {
  let r, j;
  try {
    r = await fetch("https://api.monday.com/v2", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: M, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(120_000) });
    j = await r.json().catch(() => null);
  } catch (e) {
    if (attempt < 6) { await sleep(2500 * (attempt + 1)); return mondayRaw(query, variables, attempt + 1); }
    return { status: 0, data: null, errors: [{ message: `network: ${String(e?.message ?? e).slice(0, 160)}` }] };
  }
  const errors = j?.errors ?? (j?.error_message ? [{ message: j.error_message, code: j.error_code }] : null);
  const text = JSON.stringify(errors ?? "");
  const abort = r.status === 401 || r.status === 403 || /not authenticated|unauthori[sz]ed|DAILY_LIMIT|daily limit/i.test(text);
  const nothingApplied = !j?.data || Object.values(j.data).every(x => x == null);
  if (!abort && nothingApplied && (r.status === 429 || r.status >= 500 || !j || TRANSIENT.test(text)) && attempt < 6) {
    const asked = Number((Array.isArray(errors) ? errors : []).find(e => e?.extensions?.retry_in_seconds)?.extensions?.retry_in_seconds)
      || Number(/reset in (\d+)/i.exec(text)?.[1]) || 0;
    await sleep(asked ? Math.min(asked + 1, 65) * 1000 : 2500 * (attempt + 1));
    return mondayRaw(query, variables, attempt + 1);
  }
  return { status: r.status, data: j?.data ?? null, errors, abort };
}
/** A READ: anything short of clean data is an error (no partial result is ever used). */
async function monday(query, variables = {}) {
  const res = await mondayRaw(query, variables);
  if (!res.data || res.errors) throw new Error(`monday ${res.status}: ${JSON.stringify(res.errors ?? res.data).slice(0, 240)}`);
  return res.data;
}

// board -> HubSpot object, HubSpot ID column, and every People column the CRM specs map (src/config/crm.ts).
const BOARDS = [
  { board: "5028000495", object: "contacts", idCol: "text_mm6t71dj",
    people: { multiple_person_mm6zap53: "hubspot_owner_id", multiple_person_mm76ygkp: "sales_user" } },
  { board: "5028000496", object: "companies", idCol: "text_mm6tsnwx",
    people: { multiple_person_mm6z8mwy: "hubspot_owner_id", multiple_person_mm7d2qk6: "sales_user" } },
  { board: "5028000494", object: "deals", idCol: "text_mm76kxz4",
    people: { deal_owner: "hubspot_owner_id", multiple_person_mm7df31a: "sales_user" } },
  { board: "5028000489", object: "line_items", idCol: "text_mm76qwtw",
    people: { multiple_person_mm79ey0p: "hubspot_owner_id" } },
].filter(b => !ONLY || b.board === ONLY)
  .map(b => COLUMNS ? { ...b, people: Object.fromEntries(Object.entries(b.people).filter(([c]) => COLUMNS.includes(c))) } : b)
  .filter(b => Object.keys(b.people).length);
if (!BOARDS.length) { console.error("no board/column matches --board / --columns"); process.exit(2); }

/**
 * THE WORKER'S OWN LOOKUPS, rebuilt the way src/hubspot.ts getOwners and src/monday.ts getUsersByEmail
 * build them. Archived owners first, then active, so an id present in both ends up with its ACTIVE record,
 * as in the Worker. Emails are lowercased and NOT trimmed, as formatValue does.
 */
const ownerEmail = {};                                // HubSpot owner id -> email (lowercased) or ""
for (const archived of [true, false]) {
  let after = "";
  do {
    const r = await hs(`/crm/v3/owners/?limit=100${archived ? "&archived=true" : ""}${after ? `&after=${after}` : ""}`);
    for (const o of r.results ?? []) ownerEmail[String(o.id)] = o.email ? String(o.email).toLowerCase() : "";
    after = r.paging?.next?.after ?? "";
  } while (after);
}
const mondayByEmail = {};
const u = await monday(`query { users(limit:500) { id email } }`);
for (const x of u.users ?? []) if (x.email) mondayByEmail[String(x.email).toLowerCase()] = String(x.id);
/** formatValue "people": owner id -> email -> monday user, or nothing. No trim, no ambiguity check -- see the header. */
const want = ownerId => {
  if (ownerId === null || ownerId === undefined || ownerId === "") return [];
  const e = ownerEmail[String(ownerId)];
  const id = e ? mondayByEmail[e] : undefined;
  return id ? [id] : [];
};
// Emails claimed by more than one owner -- the set buildCtx drops from its REVERSE map (trimmed, lowercased).
const ownersOfEmail = {};
for (const [id, e] of Object.entries(ownerEmail)) { const k = e.trim(); if (k) (ownersOfEmail[k] ??= []).push(id); }
const shared = Object.fromEntries(Object.entries(ownersOfEmail).filter(([, ids]) => ids.length > 1));
const isShared = ownerId => { const e = ownerEmail[String(ownerId ?? "")]; return !!e && !!shared[e.trim()]; };
console.log(`owners ${Object.keys(ownerEmail).length}, monday users ${Object.keys(mondayByEmail).length}, `
  + `emails shared by several owners ${Object.keys(shared).length} `
  + JSON.stringify(Object.fromEntries(Object.entries(shared).map(([e, ids]) => [e, ids.length]))));

const at = new Date().toISOString();
const report = { at, apply: APPLY, expectedRule: "src/mapping.ts formatValue people (forward), shared owner emails resolved as the Worker does",
  sharedOwnerEmails: shared, boards: [] };
let out = join(ROOT, "..", "docs", "rollout",
  `people-resync-${APPLY ? `applied-${at.slice(0, 19).replace(/:/g, "")}` : `plan-${at.slice(0, 10)}`}.json`);
if (existsSync(out)) out = out.replace(/\.json$/, `-${at.slice(11, 19).replace(/:/g, "")}.json`);   // never overwrite a report
const save = () => writeFileSync(out, JSON.stringify(report, null, 1));

const cvArg = f => JSON.stringify(JSON.stringify(f.cv));
const mutation = (board, fs) => "mutation {" + fs.map((f, k) =>
  ` m${k}: change_multiple_column_values(board_id:${board}, item_id:${f.item}, column_values:${cvArg(f)}) { id }`).join("") + " }";
/** The error monday attached to alias m<k>, if it said which one. */
const aliasError = (errors, k) => (errors ?? []).find(e => Array.isArray(e?.path) && e.path[0] === `m${k}`);

let aborted = null;
try {
  for (const b of BOARDS) {
    // 1. Every HubSpot record's owner properties (LIST endpoint: search would cap at 10,000).
    const props = [...new Set(Object.values(b.people))];
    const rec = {};
    let after = "";
    do {
      const r = await hs(`/crm/v3/objects/${b.object}?limit=100&properties=${props.join(",")}${after ? `&after=${after}` : ""}`);
      for (const x of r.results ?? []) rec[String(x.id)] = x.properties ?? {};
      after = r.paging?.next?.after ?? "";
      await sleep(80);
    } while (after);

    // 2. Every card's HubSpot id and People cells.
    const cols = [b.idCol, ...Object.keys(b.people)];
    const cards = [];
    let cursor = null;
    do {
      const sel = `items { id column_values(ids:${JSON.stringify(cols)}) { id text ... on PeopleValue { persons_and_teams { id kind } } } }`;
      const d = cursor
        ? await monday(`query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor ${sel} } }`, { c: cursor })
        : await monday(`query($b:ID!){ boards(ids:[$b]){ items_page(limit:500){ cursor ${sel} } } }`, { b: b.board });
      const page = cursor ? d.next_items_page : d.boards[0].items_page;
      cards.push(...page.items);
      cursor = page.cursor;
    } while (cursor);

    // 3. Diff -- the same set comparison as reconcile.ts fieldDiffs (persons only, sorted).
    const fixes = [];
    const stats = {};
    for (const col of Object.keys(b.people)) stats[col] = { checked: 0, wrong: 0, toClear: 0, extraPeople: 0, sharedEmail: 0, sharedEmailWrites: 0 };
    let unlinked = 0, missingInHubspot = 0;
    for (const card of cards) {
      const hid = card.column_values.find(c => c.id === b.idCol)?.text?.trim();
      if (!hid) { unlinked++; continue; }
      const r = rec[hid];
      if (!r) { missingInHubspot++; continue; }
      const cv = {};
      for (const [col, prop] of Object.entries(b.people)) {
        const have = (card.column_values.find(c => c.id === col)?.persons_and_teams ?? [])
          .filter(p => p.kind === "person").map(p => String(p.id)).sort();
        const exp = want(r[prop]);
        const viaShared = isShared(r[prop]);
        stats[col].checked++;
        if (viaShared) stats[col].sharedEmail++;
        if (have.join(",") === exp.join(",")) continue;
        stats[col].wrong++;
        if (viaShared) stats[col].sharedEmailWrites++;
        if (!exp.length) stats[col].toClear++;
        if (have.length > 1) stats[col].extraPeople++;
        cv[col] = { personsAndTeams: exp.map(id => ({ id: Number(id), kind: "person" })) };
      }
      if (Object.keys(cv).length) fixes.push({ item: card.id, cv });
    }

    console.log(`\n${b.object} board ${b.board}: ${cards.length} cards (${unlinked} with no HubSpot id, ${missingInHubspot} whose record is gone)`);
    for (const [col, s] of Object.entries(stats))
      console.log(`  ${col.padEnd(26)} ${b.people[col].padEnd(17)} wrong ${s.wrong} of ${s.checked}  (clear: ${s.toClear}, had >1 person: ${s.extraPeople}`
        + `, owner email shared by several owners: ${s.sharedEmail}, of them written: ${s.sharedEmailWrites})`);
    console.log(`  cards to write: ${fixes.length}`);
    const entry = { board: b.board, object: b.object, cards: cards.length, stats, writes: fixes.length };
    report.boards.push(entry);
    save();

    // 4. Write, 8 cards per request; a failed alias is retried alone, never with its good neighbours.
    if (APPLY && fixes.length) {
      Object.assign(entry, { applied: [], failed: [], chunksDone: 0, chunks: Math.ceil(fixes.length / 8) });
      let emptyRun = 0;
      for (let i = 0; i < fixes.length; i += 8) {
        const chunk = fixes.slice(i, i + 8);
        const res = await mondayRaw(mutation(b.board, chunk));
        if (res.abort) throw new Error(`monday refused the token (${res.status}): ${JSON.stringify(res.errors).slice(0, 160)}`);
        const retry = [];
        let appliedHere = 0;
        chunk.forEach((f, k) => {
          if (res.data?.[`m${k}`]?.id) { entry.applied.push(f.item); appliedHere++; }
          else retry.push({ f, first: aliasError(res.errors, k)?.message ?? JSON.stringify(res.errors ?? "no data").slice(0, 160) });
        });
        for (const { f, first } of retry) {
          const one = await mondayRaw(mutation(b.board, [f]));
          if (one.abort) throw new Error(`monday refused the token (${one.status}): ${JSON.stringify(one.errors).slice(0, 160)}`);
          if (one.data?.m0?.id) { entry.applied.push(f.item); appliedHere++; }
          else entry.failed.push({ item: f.item, cv: f.cv, error: String(one.errors?.[0]?.message ?? first).slice(0, 200) });
        }
        emptyRun = appliedHere ? 0 : emptyRun + 1;
        entry.chunksDone++;
        save();
        if (emptyRun >= 3) throw new Error(`three chunks in a row applied nothing (last: ${entry.failed.at(-1)?.error ?? "?"})`);
        if (entry.chunksDone % 50 === 0) console.log(`    ${Math.min(i + 8, fixes.length)}/${fixes.length}  failed ${entry.failed.length}`);
      }
      console.log(`  APPLIED ${entry.applied.length}, failed ${entry.failed.length}`);
    }
  }
} catch (e) {
  aborted = String(e?.message ?? e).slice(0, 300);
  report.aborted = aborted;
}
report.done = !aborted;
save();
if (aborted) console.error(`\nABORTED: ${aborted}\nEverything applied so far is in the report; run again to resume (the diff is recomputed).`);
console.log(`\nreport: ${out}`);
if (aborted) process.exit(1);
