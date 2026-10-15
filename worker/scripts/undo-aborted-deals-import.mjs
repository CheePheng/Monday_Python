/**
 * Undo the aborted 2026-09-15 Deals import: delete ONLY the cards it created, and strip ONLY the
 * GUID-shaped status labels it minted.
 *
 * WHAT WENT WRONG. The coarse Stage column was mapped to a dictionary covering HubSpot's default
 * pipeline only, so every Salesforce-pipeline deal wrote its raw stage GUID and — because monday
 * writes set create_labels_if_missing — minted a status label named after it. The import was stopped
 * at 70 cards with 8 GUID labels on a column that degrades above ~19.
 *
 * Re-running the import would NOT repair those 70: backfill-crm.mjs skips any HubSpot id already on
 * the board, by design. So they have to go, and the import recreates them correctly.
 *
 * WHAT IS PROTECTED, and how:
 *   - the 40-deal CANARY. Its HubSpot ids come from the pre-import baseline, not from a guess about
 *     creation time, and any card whose id is in that set is refused outright.
 *   - the 6 Deals cards with NO HubSpot id (46 baseline - 40 canary). Never touched: a card with no
 *     id was not created by an import and is somebody's manual row.
 *   - the five real status labels (New / Proposal / Negotiation / Won / Lost) and anything else
 *     non-GUID-shaped. Only 8-4-4-4-12 hex is removed.
 *   - Line Items, Client Projects and the live WM board: not addressed at all.
 *
 *   node scripts/undo-aborted-deals-import.mjs                 # plan
 *   node scripts/undo-aborted-deals-import.mjs --apply
 */
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEALS = "5028000494";
const ID_COL = "text_mm76kxz4";      // CRM_DEALS.idCol
const STAGE_COL = "deal_stage";
const BASELINE = join(ROOT, "scripts", ".deals-baseline.json");
const KEEP_LABELS = ["New", "Proposal", "Negotiation", "Won", "Lost"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPLY = process.argv.includes("--apply");
const env = Object.fromEntries(fs.readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)
  .filter(l => l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));

async function gql(query, variables = {}) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: env.MONDAY_API_TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json();
  if (b.errors) throw new Error(`monday: ${JSON.stringify(b.errors).slice(0, 300)}`);
  return b.data;
}

// --- the protected set, from the baseline rather than from a timestamp guess -----------------
if (!fs.existsSync(BASELINE)) {
  console.error(`no baseline at ${BASELINE} — refusing to guess which cards are the canary's.`);
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const canary = new Set((baseline.boards?.[DEALS]?.hubspotIds ?? []).map(String));
if (canary.size !== 40) {
  console.error(`baseline lists ${canary.size} canary ids, expected 40 — refusing to proceed.`);
  process.exit(1);
}
console.log(`baseline protects ${canary.size} canary HubSpot ids, board was ${baseline.boards[DEALS].items} items\n`);

// --- 1. cards -------------------------------------------------------------------------------
const all = [];
let cursor = null;
for (;;) {
  const q = cursor
    ? `query ($c: String!) { next_items_page(cursor: $c, limit: 200) { cursor items { id name column_values(ids: ["${ID_COL}"]) { text } } } }`
    : `query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 200) { cursor items { id name column_values(ids: ["${ID_COL}"]) { text } } } } }`;
  const d = await gql(q, cursor ? { c: cursor } : { b: [DEALS] });
  const page = cursor ? d.next_items_page : d.boards[0].items_page;
  all.push(...page.items);
  cursor = page.cursor;
  if (!cursor) break;
}

const noId = all.filter(it => !(it.column_values?.[0]?.text ?? "").trim());
const keep = all.filter(it => canary.has((it.column_values?.[0]?.text ?? "").trim()));
const doomed = all.filter(it => {
  const hsId = (it.column_values?.[0]?.text ?? "").trim();
  return hsId && !canary.has(hsId);
});

console.log(`board holds ${all.length} cards:`);
console.log(`  ${keep.length} canary (protected)`);
console.log(`  ${noId.length} with no HubSpot id (protected — manual rows)`);
console.log(`  ${doomed.length} created by the aborted import (to delete)`);
if (keep.length !== canary.size) {
  console.error(`\nREFUSING: expected all ${canary.size} canary cards present, found ${keep.length}.`);
  process.exit(1);
}

// --- 2. labels ------------------------------------------------------------------------------
const col = (await gql(`query { boards(ids: [${DEALS}]) { columns(ids: ["${STAGE_COL}"]) { id title settings_str } } }`))
  .boards[0].columns[0];
const settings = JSON.parse(col.settings_str || "{}");
const labels = settings.labels ?? {};
const guidIdx = Object.entries(labels).filter(([, name]) => GUID.test(String(name)));
const keptIdx = Object.entries(labels).filter(([, name]) => !GUID.test(String(name)));
console.log(`\n"${col.title}" holds ${Object.keys(labels).length} labels:`);
console.log(`  keeping ${keptIdx.length}: ${keptIdx.map(([, n]) => JSON.stringify(n)).join(", ")}`);
console.log(`  removing ${guidIdx.length} GUID-shaped`);
for (const [, n] of KEEP_LABELS.map(n => [null, n]))
  if (!Object.values(labels).includes(n)) console.log(`  note: native label ${JSON.stringify(n)} is not present`);

if (!APPLY) {
  console.log(`\nPLAN only — nothing deleted. Re-run with --apply.`);
  process.exit(0);
}

// Cards first: removing a label still referenced by a card would leave those cells blank-but-set.
let deleted = 0;
for (const it of doomed) {
  await gql(`mutation ($i: ID!) { delete_item(item_id: $i) { id } }`, { i: it.id });
  if (++deleted % 10 === 0) console.log(`  deleted ${deleted}/${doomed.length}`);
}
console.log(`  deleted ${deleted} card(s)`);

/**
 * THE LABELS CANNOT BE REMOVED FROM HERE, and that is an API limit rather than an oversight.
 * `change_column_metadata` accepts only `title` and `description` in API 2026-07 — introspected, not
 * assumed — and there is no other mutation that edits a status column's label set. Deleting and
 * recreating the column is not an option either: every one of Zmark's automations references the
 * column id `deal_stage`, so a new column would silently orphan all of them.
 *
 * So the GUID labels are reported for manual removal. Leaving them is SAFE but untidy: with
 * `strictDict` on the spec, nothing can ever write an unmapped stage again, so the set is now frozen
 * at its current size instead of growing toward the ~19 ceiling.
 */
console.log(`\ncards done. The ${guidIdx.length} GUID labels must be removed BY HAND:`);
console.log(`  monday -> Deals board -> "${col.title}" column -> Edit Labels -> delete these:`);
for (const [id, name] of guidIdx) console.log(`     id ${String(id).padStart(3)}  ${name}`);
console.log(`  Leave every other label alone — "Discovery" (id 15) is referenced by automation`);
console.log(`  31010011, and ids 0-5 are the five native labels the coarse mapping writes.`);
console.log(`\nNot urgent: strictDict means no further label can ever be created by the sync.`);
