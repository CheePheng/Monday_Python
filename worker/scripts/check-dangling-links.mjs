/**
 * THE 71 LINKS WHOSE TARGET IS NOT ON THE ACCOUNTS BOARD. READ-ONLY.
 *
 * measure-relation-cells.mjs found 564 links a full-replacement write could not reproduce: 493 to an
 * Accounts card carrying no HubSpot ID, and 71 to an item id that is not on the Accounts board at all.
 *
 * The first group is settled — the backfill is additive-only and preserves them. The second group is
 * a NEW question that additive-only creates rather than answers: if those 71 targets are DELETED
 * items, then preserving them means writing a dangling item id back into `item_ids`, and if monday
 * rejects such a write the whole contact fails — every real link on that card included. A guard
 * against deleting a person's work must not become a guard that blocks the pass.
 *
 * Deleted is the likely answer and there is a specific suspect: this project deleted the fake.com
 * Accounts card (2856600500) earlier the same day, and 1,581 contacts had been associated with it.
 *
 * monday returns a deleted item from items(ids:) WITH state "deleted" rather than omitting it — a
 * fact that already produced one false alarm in this project — so state is the thing to read, not
 * presence.
 *
 *   node scripts/check-dangling-links.mjs
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
const ACCOUNTS_BOARD = "5028000496";
const ACCOUNTS_ID_COL = "text_mm6tsnwx";
const CONTACTS_BOARD = "5028000495";
const CONTACTS_REL_COL = "contact_account";
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

// ---- every live Accounts card id
console.log("indexing Accounts board item ids…");
const onBoard = new Set();
{
  let cursor = null;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String) { boards(ids: [$b]) {
         items_page(limit: 500, cursor: $c) { cursor items { id } } } }`,
      { b: ACCOUNTS_BOARD, c: cursor })).boards[0].items_page;
    for (const it of page.items) onBoard.add(String(it.id));
    cursor = page.cursor;
  } while (cursor);
}
console.log(`  ${onBoard.size} live Accounts cards\n`);

// ---- every contact link whose target is not among them
console.log("scanning Contacts for links to targets that are not on the Accounts board…");
const danglingByTarget = new Map();      // target item id -> contact card ids holding it
let contacts = 0;
{
  let cursor = null;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name column_values(ids: $ids) {
             id ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: CONTACTS_BOARD, c: cursor, ids: [CONTACTS_REL_COL] })).boards[0].items_page;
    for (const it of page.items) {
      contacts++;
      for (const t of (it.column_values[0]?.linked_item_ids ?? []).map(String)) {
        if (onBoard.has(t)) continue;
        if (!danglingByTarget.has(t)) danglingByTarget.set(t, []);
        danglingByTarget.get(t).push({ contact: it.id, name: it.name });
      }
    }
    cursor = page.cursor;
    if (contacts % 20000 === 0) console.log(`  ${contacts}…`);
  } while (cursor);
}
const targets = [...danglingByTarget.keys()];
console.log(`  ${contacts} contacts scanned`);
console.log(`  ${targets.length} distinct off-board targets, held by`
  + ` ${[...danglingByTarget.values()].reduce((n, a) => n + a.length, 0)} links\n`);

// ---- what ARE those targets? deleted, archived, or on another board entirely
console.log("resolving each target…");
const resolved = [];
for (let i = 0; i < targets.length; i += 100) {
  const chunk = targets.slice(i, i + 100);
  const d = await monday(
    `query ($i: [ID!], $c: [String!]) { items(ids: $i) {
       id name state board { id name } column_values(ids: $c) { id text } } }`,
    { i: chunk, c: [ACCOUNTS_ID_COL] });
  const got = new Map((d.items ?? []).map(it => [String(it.id), it]));
  for (const t of chunk) {
    const it = got.get(t);
    resolved.push({
      target: t,
      links: danglingByTarget.get(t).length,
      state: it ? it.state : "NOT RETURNED AT ALL",
      board: it?.board ? `${it.board.id} ${it.board.name}` : "?",
      name: it?.name ?? "",
      hsId: (it?.column_values ?? []).find(c => c.id === ACCOUNTS_ID_COL)?.text ?? "",
    });
  }
}

const byState = {};
for (const r of resolved) byState[r.state] = (byState[r.state] ?? 0) + r.links;
console.log(`\n=== OFF-BOARD TARGETS BY STATE (link counts) ===`);
for (const [s, n] of Object.entries(byState)) console.log(`  ${s.padEnd(22)} ${n} links`);

console.log(`\n=== EVERY OFF-BOARD TARGET ===`);
for (const r of resolved.sort((a, b) => b.links - a.links))
  console.log(`  item ${r.target}  links=${String(r.links).padStart(4)}  state=${r.state}`
    + `  board=${r.board}  hs=${r.hsId || "(none)"}  ${JSON.stringify(r.name).slice(0, 44)}`);

const FAKE_CARD = "2856600500";
const fake = resolved.find(r => r.target === FAKE_CARD);
console.log(`\n  the deleted fake.com card ${FAKE_CARD}: ${fake ? `${fake.links} links still point at it` : "not among these targets"}`);

const out = join(ROOT, "scripts", ".dangling-links.json");
writeFileSync(out, JSON.stringify({ contacts, resolved, danglingByTarget: Object.fromEntries(danglingByTarget) }, null, 2), "utf8");
console.log(`\nwritten to ${out}`);
