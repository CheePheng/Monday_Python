/**
 * BLAST RADIUS of the 100-association read cap. READ-ONLY.
 *
 * getAssociatedIds reads `/associations/{to}?limit=100` and does NOT page. For any company with more
 * than 100 contacts, syncRelationColumn therefore builds `want` from only the first 100, and because
 * the write is a FULL REPLACEMENT of a PAIRED column, every previously-linked contact outside that
 * 100 has its own Company cell cleared. The relation backfill then re-adds some, and the next sync
 * clears them again — which is the set/clear oscillation visible in the activity log.
 *
 * None of the four existing guards catches it: `want` is 100 items so it is not empty, every id the
 * capped read returned did resolve, the cards are old, and the sets genuinely differ.
 *
 * This counts how many Accounts cards are affected and how many contact links are at stake.
 * A card sitting at EXACTLY 100 is the truncation signature.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
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
async function hs(path, body) {
  const r = await fetch("https://api.hubapi.com" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

console.log("scanning the Accounts board for cards with >= 100 contact links…");
const big = [];
let cards = 0, cursor = null;
do {
  const page = (await monday(
    `query ($b: ID!, $c: String, $ids: [String!]) {
       boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
         cursor items { id name column_values(ids: $ids) {
           id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
    { b: "5028000496", c: cursor, ids: ["text_mm6tsnwx", "account_contact"] })).boards[0].items_page;
  for (const it of page.items) {
    cards++;
    const n = (it.column_values.find(c => c.id === "account_contact")?.linked_item_ids ?? []).length;
    if (n >= 100) big.push({ itemId: it.id, name: it.name, links: n,
      hsId: (it.column_values.find(c => c.id === "text_mm6tsnwx")?.text ?? "").trim() });
  }
  cursor = page.cursor;
} while (cursor);
console.log(`  ${cards} cards, ${big.length} hold >= 100 contact links\n`);

// What HubSpot actually says each of those companies has.
const ids = big.filter(b => b.hsId).map(b => b.hsId);
const truth = new Map();
for (let i = 0; i < ids.length; i += 100) {
  const r = await hs("/crm/v3/objects/companies/batch/read",
    { properties: ["num_associated_contacts", "name"], inputs: ids.slice(i, i + 100).map(id => ({ id })) });
  for (const rec of r.body.results ?? [])
    truth.set(String(rec.id), Number(rec.properties?.num_associated_contacts ?? 0));
}

let atExactly100 = 0, shortfall = 0, affectedCards = 0;
console.log("card            links  HubSpot  shortfall  company");
for (const b of big.sort((a, b2) => b2.links - a.links)) {
  const real = truth.get(b.hsId) ?? 0;
  const miss = Math.max(0, real - b.links);
  if (b.links === 100) atExactly100++;
  if (miss > 0) { affectedCards++; shortfall += miss; }
  console.log(`${b.itemId}  ${String(b.links).padStart(5)}  ${String(real).padStart(7)}  ${String(miss).padStart(9)}  ${JSON.stringify(b.name).slice(0, 40)}`);
}
console.log(`\n  cards sitting at EXACTLY 100 (the truncation signature) : ${atExactly100}`);
console.log(`  cards holding fewer links than HubSpot asserts          : ${affectedCards}`);
console.log(`  contact links currently MISSING from monday             : ${shortfall}`);
console.log(`\n  Note: a card above 100 was written by the relation backfill, which pages properly.`);
console.log(`  It will be truncated to 100 the next time the live Worker syncs that company.`);
