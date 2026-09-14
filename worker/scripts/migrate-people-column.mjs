/**
 * POPULATE A MONDAY **PEOPLE** COLUMN FROM A HUBSPOT ASSIGNMENT PROPERTY.
 *
 * Written once for both fields, because they differ only in how the stored value reaches an owner:
 *   sales_person  holds an owner's NAME      -> resolved via peopleByName (name -> owner -> email)
 *   sales_user    holds an owner ID          -> resolved directly
 * Both end at an EMAIL and then at a monday user. A name is never matched against monday directly,
 * and a name claimed by two owners resolves to nothing — this portal has two "Rick Antonio"s.
 *
 * IT WRITES EXACTLY ONE COLUMN. The mutation payload is built from a single column id, so Contact
 * Owner, the legacy status/dropdown column and every other cell are untouchable by construction
 * rather than by care.
 *
 * IT MAKES NO HUBSPOT WRITES AT ALL. HubSpot is read-only here; `sales_person` and `sales_user` are
 * left exactly as they are, and the legacy columns keep syncing them.
 *
 * A PERSON WITH NO MONDAY ACCOUNT LEAVES THE CELL EMPTY, which the business accepted explicitly. The
 * script counts them rather than passing over them silently, because "blank" should be a number
 * someone agreed to, not a side effect nobody looked at.
 *
 * RESUMABLE AND BATCHED. It records its HubSpot cursor after every page, so an interrupted run
 * continues instead of restarting — and re-running is harmless anyway, since a card already holding
 * the right person is skipped without a write.
 *
 *   node scripts/migrate-people-column.mjs --field sales_person             # plan, writes nothing
 *   node scripts/migrate-people-column.mjs --field sales_person --apply
 *   node scripts/migrate-people-column.mjs --field sales_person --verify
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const FIELD = arg("--field") ?? "sales_person";
const apply = argv.includes("--apply");
const verifyOnly = argv.includes("--verify");
const BATCH = Number(arg("--batch") ?? 10);
const BOARD = "5028000495";
const ID_COL = "text_mm6t71dj";
const STATE = join(ROOT, "scripts", `.migrate-${FIELD}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function monday(query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.data) {
    if (attempt < 6) { await sleep(2000 * 2 ** attempt); return monday(query, variables, attempt + 1); }
    throw new Error(`monday: ${JSON.stringify(b.errors ?? b).slice(0, 250)}`);
  }
  return b.data;
}
async function hs(path, body, attempt = 0) {
  const r = await fetch("https://api.hubapi.com" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 6) {
    await sleep(2000 * 2 ** attempt); return hs(path, body, attempt + 1);
  }
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

// ---- the Worker's OWN formatValue and buildCtx, so the migration cannot drift from the sync.
const dir = mkdtempSync(join(tmpdir(), "peoplemig-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export { formatValue } from ${JSON.stringify(join(ROOT, "src", "mapping.ts"))};`,
  `export { buildCtx } from ${JSON.stringify(join(ROOT, "src", "sync.ts"))};`,
  `export { CRM_CONTACTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
].join("\n"), "utf8");
const outfile = join(dir, "bundle.mjs");
buildSync({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", logLevel: "warning" });
const mod = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

const spec = mod.CRM_CONTACTS;
const field = spec.fields.find(f => f.hs === FIELD && f.type === "people");
if (!field) { console.error(`no people field for ${FIELD} in CRM_CONTACTS`); process.exit(1); }
console.log(`field ${FIELD} -> column ${field.col}${field.peopleByName ? " (peopleByName)" : ""}`);

console.log("building sync context…");
const ctx = await mod.buildCtx({ HUBSPOT_ACCESS_TOKEN: v.HUBSPOT_ACCESS_TOKEN, MONDAY_API_TOKEN: v.MONDAY_API_TOKEN, ENABLE_CRM: "true" });
console.log(`  ${Object.keys(ctx.ownersById).length} owners, ${Object.keys(ctx.mondayUsersByEmail).length} monday users,`
  + ` ${Object.keys(ctx.ownerIdByName ?? {}).length} unambiguous owner names`);

// ---- index the board once: HubSpot id -> { itemId, currentPersonIds }
console.log("indexing the Contacts board…");
const cards = new Map();
{
  let cursor = null, n = 0;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id column_values(ids: $ids) { id text
             ... on PeopleValue { persons_and_teams { id kind } } } } } } }`,
      { b: BOARD, c: cursor, ids: [ID_COL, field.col] })).boards[0].items_page;
    for (const it of page.items) {
      const hsId = (it.column_values.find(c => c.id === ID_COL)?.text ?? "").trim();
      if (!hsId) continue;
      const pt = it.column_values.find(c => c.id === field.col)?.persons_and_teams ?? [];
      cards.set(hsId, { itemId: it.id, current: pt.map(p => String(p.id)).sort().join(",") });
      n++;
    }
    cursor = page.cursor;
    if (n % 20000 === 0 && n) console.log(`  ${n}…`);
  } while (cursor);
}
console.log(`  ${cards.size} cards carry a HubSpot ID`);

// ==================================================================== VERIFY
if (verifyOnly) {
  console.log(`\n=== VERIFY ${FIELD} ===`);
  let populated = 0, blank = 0, noCard = 0, wrong = 0, expectBlank = 0;
  const blankReasons = new Map();
  let after;
  do {
    const r = await hs("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: FIELD, operator: "HAS_PROPERTY" }] }],
      properties: [FIELD], limit: 100,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], ...(after ? { after } : {}),
    });
    if (!r.ok) break;
    for (const rec of r.body.results ?? []) {
      const card = cards.get(String(rec.id));
      if (!card) { noCard++; continue; }
      const want = mod.formatValue(field, rec.properties?.[FIELD], ctx);
      const wantIds = want ? (want.personsAndTeams ?? []).map(p => String(p.id)).sort().join(",") : "";
      if (!wantIds) {
        expectBlank++;
        blankReasons.set(rec.properties?.[FIELD] ?? "", (blankReasons.get(rec.properties?.[FIELD] ?? "") ?? 0) + 1);
        if (card.current) wrong++;                 // should be blank but is not
      } else if (card.current === wantIds) populated++;
      else wrong++;
      if (!card.current) blank++;
    }
    after = r.body.paging?.next?.after;
  } while (after);
  console.log(`  correctly populated       ${populated}`);
  console.log(`  expected blank (no user)  ${expectBlank}`);
  console.log(`  cells currently blank     ${blank}`);
  console.log(`  MISMATCHES                ${wrong}   <- must be 0`);
  console.log(`  contacts with no card     ${noCard}`);
  console.log(`\n  values that resolve to nobody:`);
  for (const [val, n] of [...blankReasons].sort((a, b) => b[1] - a[1]))
    console.log(`      ${String(n).padStart(6)}  ${JSON.stringify(val)}`);
  console.log(`\n  ${wrong === 0 ? "VERIFIED" : "MISMATCHES PRESENT"}`);
  process.exit(wrong === 0 ? 0 : 1);
}

// ==================================================================== MIGRATE
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { after: null, done: 0, written: 0, blank: 0 };
console.log(`\n${apply ? "MIGRATING" : "PLAN (nothing will be written)"} ${FIELD}`
  + (state.after ? `  — resuming from a saved cursor (${state.done} already done)` : ""));

let after = state.after, scanned = state.done, written = state.written, blank = state.blank, same = 0, noCard = 0;
const pending = [];
const flush = async () => {
  if (!pending.length) return;
  const chunk = pending.splice(0, pending.length);
  const decls = chunk.map((_, i) => `$i${i}: ID!, $v${i}: JSON!`).join(", ");
  const calls = chunk.map((_, i) =>
    `r${i}: change_multiple_column_values(board_id: $b, item_id: $i${i}, column_values: $v${i}) { id }`).join("\n    ");
  const vars = { b: BOARD };
  // ONE COLUMN ONLY. Built from field.col alone, so no other cell can be reached from here.
  chunk.forEach((p, i) => { vars[`i${i}`] = p.itemId; vars[`v${i}`] = JSON.stringify({ [field.col]: p.value }); });
  try {
    await monday(`mutation ($b: ID!, ${decls}) {\n    ${calls}\n  }`, vars);
    written += chunk.length;
  } catch (e) {
    if (chunk.length === 1) { console.log(`  FAILED item ${chunk[0].itemId}: ${String(e).slice(0, 140)}`); return; }
    console.log(`  [isolate] batch of ${chunk.length} failed; retrying individually`);
    for (const one of chunk) { pending.push(one); await flush(); }
  }
};

do {
  const r = await hs("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: FIELD, operator: "HAS_PROPERTY" }] }],
    properties: [FIELD], limit: 100,
    sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], ...(after ? { after } : {}),
  });
  if (!r.ok) { console.log(`  search failed http ${r.status}`); break; }
  for (const rec of r.body.results ?? []) {
    scanned++;
    const card = cards.get(String(rec.id));
    if (!card) { noCard++; continue; }
    const want = mod.formatValue(field, rec.properties?.[FIELD], ctx);
    if (!want) { blank++; continue; }                       // no monday account -> leave the cell empty
    const wantIds = (want.personsAndTeams ?? []).map(p => String(p.id)).sort().join(",");
    if (card.current === wantIds) { same++; continue; }      // already right -> no write
    if (apply) { pending.push({ itemId: card.itemId, value: want }); if (pending.length >= BATCH) await flush(); }
    else written++;
  }
  after = r.body.paging?.next?.after ?? null;
  if (apply) {
    await flush();
    writeFileSync(STATE, JSON.stringify({ after, done: scanned, written, blank }, null, 2), "utf8");
  }
  if (scanned % 1000 < 100) console.log(`  ${scanned} scanned, ${written} ${apply ? "written" : "would write"}, ${blank} blank, ${same} already correct`);
} while (after);
if (apply) await flush();

console.log(`\n--- ${FIELD} ${apply ? "MIGRATED" : "PLANNED"} ---`);
console.log(`  contacts scanned          ${scanned}`);
console.log(`  cells ${apply ? "written" : "to write"}            ${written}`);
console.log(`  already correct           ${same}`);
console.log(`  left blank (no account)   ${blank}`);
console.log(`  contacts with no card     ${noCard}`);
if (apply) writeFileSync(STATE, JSON.stringify({ after: null, done: scanned, written, blank, finishedAt: new Date().toISOString() }, null, 2), "utf8");
