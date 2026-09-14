/**
 * BUILD THE DEALS + LINE ITEMS COLUMN SCHEMA.
 *
 * Phase 0 created plain `text` stubs on both boards for properties that are numeric, date or
 * enumeration in HubSpot. monday cannot retype a column, so each one has to be replaced by a real
 * typed column. Every stub is EMPTY on every item (the Deals board holds 6 monday-CRM template cards
 * and the Line Items board 2 placeholders), so replacing them destroys nothing — but that is asserted
 * here per column rather than assumed, and the script refuses if any stub turns out to hold data.
 *
 * THE REPLACEMENT REUSES THE STUB'S TITLE, and deletes before creating. Leaving both would put
 * "Vendors" next to "Vendors" on a board whose users just lost half a day to a column they could not
 * find — the same naming trap as "Company name" and the two "Deals" columns.
 *
 * DROPDOWN/STATUS COLUMNS ARE CREATED WITHOUT PRESET LABELS. Every sync write sets
 * create_labels_if_missing, so the vocabulary arrives with the data and cannot drift from HubSpot's.
 * Presetting 85 Vendor or 42 Stage labels by hand would be a second source of truth that starts
 * accurate and rots.
 *
 *   node scripts/build-deals-schema.mjs            # plan only, writes nothing
 *   node scripts/build-deals-schema.mjs --apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const apply = process.argv.includes("--apply");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function q(query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.data) {
    if (attempt < 5) { await sleep(1500 * 2 ** attempt); return q(query, variables, attempt + 1); }
    throw new Error(`monday: ${JSON.stringify(b.errors ?? b).slice(0, 300)}`);
  }
  return b.data;
}

const DEALS = "5028000494";
const LINE_ITEMS = "5028000489";

/** stub column id -> [new title, new type]. The title is carried over deliberately. */
const PLAN = {
  [DEALS]: {
    replace: [
      ["text_mm6tk0kt", "Sales User", "dropdown"],
      ["text_mm6tqv5g", "Deal Pipeline", "dropdown"],
      ["text_mm6tqq08", "Vendors-厂商来源", "dropdown"],
      ["text_mm6t56f4", "Currency", "dropdown"],
      ["text_mm6termq", "Deal Type", "dropdown"],
      ["text_mm6tf8hs", "Priority", "status"],
    ],
    // Redundant, not replaced: the card NAME already is dealname, and Deal Value already is `amount`.
    drop: ["text_mm6tk32c", "text_mm6t5a5x"],
    create: [
      ["HubSpot ID", "text"],
      ["HubSpot Link", "link"],
      ["Sync State", "text"],
      ["HubSpot Stage", "dropdown"],
      ["Primary Account", "text"],
    ],
  },
  [LINE_ITEMS]: {
    replace: [
      ["text_mm739x8p", "Product Subcategory", "dropdown"],
      ["text_mm73j5g9", "Is Active", "status"],
      ["text_mm738n4x", "Service Date", "date"],
      ["text_mm73t7v9", "Billing frequency", "dropdown"],
      ["text_mm73gvej", "Billing start date", "date"],
      ["text_mm73zrcw", "Tax rate", "dropdown"],
      ["text_mm735shw", "Unit discount", "numbers"],
      ["text_mm73bz1v", "Pricing model", "dropdown"],
      ["text_mm73axh0", "Unit price", "numbers"],
      ["text_mm73j3sh", "Quantity", "numbers"],
      ["text_mm7371qb", "Unit cost", "numbers"],
      ["text_mm73ck1s", "Deposit", "numbers"],
    ],
    drop: [],
    create: [
      ["HubSpot ID", "text"],
      ["HubSpot Link", "link"],
      ["Sync State", "text"],
      ["Brand ISV", "dropdown"],       // the existing "Brand ISV" is a NUMBERS column; see below
      ["Family", "dropdown"],          // the existing "Family" status holds monday-template labels
      ["Currency", "dropdown"],
    ],
  },
};

/**
 * `product_and_service_price` is a NUMBERS column retitled "Brand ISV", and `product_and_service_type`
 * is a status titled "Family" whose two labels (Service, Inventory) appear nowhere in HubSpot. Both
 * are monday-CRM template columns that someone renamed without retyping. They are NOT deleted here:
 * they are monday-native template columns, deleting them is out of scope for a sync change, and the
 * new typed columns carry the real data. Their titles are disambiguated instead.
 */
const RETITLE = [
  [LINE_ITEMS, "product_and_service_price", "Price (monday template, unused)"],
  [LINE_ITEMS, "product_and_service_type", "Type (monday template, unused)"],
];

const out = { generatedAt: new Date().toISOString(), created: {}, deleted: [], retitled: [] };

for (const [board, planned] of Object.entries(PLAN)) {
  console.log(`\n================ board ${board} ================`);
  const info = await q(`query ($b: ID!) { boards(ids: [$b]) { name columns { id title type } items_page(limit: 100) { items { id name column_values { id text } } } } }`, { b: board });
  const b0 = info.boards[0];
  const byId = new Map(b0.columns.map(c => [c.id, c]));
  console.log(`  ${b0.name}: ${b0.columns.length} columns, ${b0.items_page.items.length} items`);

  // ---- refuse if any stub we intend to remove actually holds data
  const toRemove = [...planned.replace.map(r => r[0]), ...planned.drop];
  let dirty = 0;
  for (const col of toRemove) {
    const holders = b0.items_page.items.filter(it => (it.column_values.find(c => c.id === col)?.text ?? "").trim());
    if (holders.length) {
      dirty++;
      console.log(`  REFUSING ${col} (${byId.get(col)?.title}): ${holders.length} item(s) hold data`
        + ` e.g. ${JSON.stringify(holders[0].name)}`);
    }
  }
  if (dirty) { console.log(`  ${dirty} column(s) are not empty — nothing on this board will be touched.`); continue; }
  console.log(`  all ${toRemove.length} columns to be removed are empty on every item`);

  if (!apply) {
    for (const [id, title, type] of planned.replace) console.log(`    REPLACE ${id} -> ${type} "${title}"`);
    for (const id of planned.drop) console.log(`    DROP    ${id} (${byId.get(id)?.title})`);
    for (const [title, type] of planned.create) console.log(`    CREATE  ${type} "${title}"`);
    continue;
  }

  // ---- delete first, then create with the same title: no duplicate-title window
  for (const id of [...planned.replace.map(r => r[0]), ...planned.drop]) {
    await q(`mutation ($b: ID!, $c: String!) { delete_column(board_id: $b, column_id: $c) { id } }`, { b: board, c: id });
    out.deleted.push({ board, id, title: byId.get(id)?.title });
    console.log(`    deleted ${id} (${byId.get(id)?.title})`);
  }
  for (const [id, title, type] of planned.replace) {
    const r = await q(`mutation ($b: ID!, $t: String!, $ty: ColumnType!) { create_column(board_id: $b, title: $t, column_type: $ty) { id title type } }`,
      { b: board, t: title, ty: type });
    out.created[`${board}:${title}`] = r.create_column.id;
    console.log(`    created ${r.create_column.id.padEnd(26)} ${type.padEnd(10)} "${title}"   (was ${id})`);
  }
  for (const [title, type] of planned.create) {
    const r = await q(`mutation ($b: ID!, $t: String!, $ty: ColumnType!) { create_column(board_id: $b, title: $t, column_type: $ty) { id title type } }`,
      { b: board, t: title, ty: type });
    out.created[`${board}:${title}`] = r.create_column.id;
    console.log(`    created ${r.create_column.id.padEnd(26)} ${type.padEnd(10)} "${title}"`);
  }
}

if (apply) {
  for (const [board, col, title] of RETITLE) {
    try {
      const r = await q(`mutation ($b: ID!, $c: String!, $t: String!) { change_column_title(board_id: $b, column_id: $c, title: $t) { id title } }`,
        { b: board, c: col, t: title });
      out.retitled.push({ board, col, title: r.change_column_title.title });
      console.log(`\n  retitled ${col} -> ${JSON.stringify(r.change_column_title.title)}`);
    } catch (e) { console.log(`\n  retitle ${col} failed: ${String(e).slice(0, 120)}`); }
  }
  const f = join(ROOT, "scripts", ".deals-schema.json");
  writeFileSync(f, JSON.stringify(out, null, 2), "utf8");
  console.log(`\n================ NEW COLUMN IDS ================`);
  for (const [k, id] of Object.entries(out.created)) console.log(`  ${k.padEnd(48)} ${id}`);
  console.log(`\nwritten to ${f}`);
} else {
  console.log(`\nPLAN ONLY — re-run with --apply to execute.`);
}
