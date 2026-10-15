/**
 * LIVE MEASUREMENT of the Accounts board's relation cells and of the links the historical backfill
 * could not reproduce. READ-ONLY.
 *
 * Written because two numbers were being carried forward that are no longer true. The "2,007 and
 * 1,581 oversized accounts" figure came from HubSpot's num_associated_contacts, not from monday's
 * cell size, and 1,581 was fake.com — a company this project deleted on 2026-09-11. Quoting it as
 * current state is exactly the kind of stale-fact error that cost this project hours earlier, so it
 * gets replaced with a measurement rather than a correction.
 *
 * It also answers the question that decides whether the backfill may write a full replacement:
 *
 *   HOW MANY CONTACT CARDS HOLD A LINK THE BACKFILL CANNOT REPRODUCE?
 *
 * `want` is built by looking up each HubSpot company id in an index of Accounts cards keyed by their
 * HubSpot ID column. An Accounts card with NO HubSpot ID can therefore never appear in `want` — so a
 * full-replacement write deletes any link to it, structurally, not occasionally. Every such link is
 * either a salesperson's manual work or a card this integration has not adopted. This script counts
 * them before anything writes.
 *
 *   node scripts/measure-relation-cells.mjs
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
const ACCOUNTS_REL_COL = "account_contact";
const CONTACTS_BOARD = "5028000495";
const CONTACTS_ID_COL = "text_mm6t71dj";
const CONTACTS_REL_COL = "contact_account";
const CEILING = 740;
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

// ---------------------------------------------------------------- 1. the Accounts board
console.log("=== ACCOUNTS BOARD — cell sizes and HubSpot ID coverage ===");
const cardHsId = new Map();      // item id -> HubSpot company id ("" when the card carries none)
const oversized = [];
let cards = 0, withId = 0, withoutId = 0, totalLinks = 0;
{
  let cursor = null;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: ACCOUNTS_BOARD, c: cursor, ids: [ACCOUNTS_ID_COL, ACCOUNTS_REL_COL] }
    )).boards[0].items_page;
    for (const it of page.items) {
      const hsId = (it.column_values.find(c => c.id === ACCOUNTS_ID_COL)?.text ?? "").trim();
      const n = (it.column_values.find(c => c.id === ACCOUNTS_REL_COL)?.linked_item_ids ?? []).length;
      cards++; totalLinks += n;
      cardHsId.set(String(it.id), hsId);
      if (hsId) withId++; else withoutId++;
      if (n >= CEILING) oversized.push({ itemId: it.id, name: it.name, hsId, links: n });
    }
    cursor = page.cursor;
    if (cards % 10000 === 0) console.log(`  ${cards}…`);
  } while (cursor);
}
console.log(`  cards                      ${cards}`);
console.log(`  carry a HubSpot ID         ${withId}`);
console.log(`  NO HubSpot ID              ${withoutId}   <- can never appear in the backfill's \`want\``);
console.log(`  total links held           ${totalLinks}`);
console.log(`\n  cards at or above the ${CEILING} ceiling: ${oversized.length}`);
for (const o of oversized.sort((a, b) => b.links - a.links))
  console.log(`      ${o.links} links  card ${o.itemId}  hs=${o.hsId || "(none)"}  ${JSON.stringify(o.name).slice(0, 60)}`);

// The next few below the ceiling, because those are the ones a long pass could push over it.
const near = [];
{
  let cursor = null;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: ACCOUNTS_BOARD, c: cursor, ids: [ACCOUNTS_ID_COL, ACCOUNTS_REL_COL] }
    )).boards[0].items_page;
    for (const it of page.items) {
      const n = (it.column_values.find(c => c.id === ACCOUNTS_REL_COL)?.linked_item_ids ?? []).length;
      if (n >= 100 && n < CEILING)
        near.push({ itemId: it.id, name: it.name, links: n,
          hsId: (it.column_values.find(c => c.id === ACCOUNTS_ID_COL)?.text ?? "").trim() });
    }
    cursor = page.cursor;
  } while (cursor);
}
console.log(`\n  cards holding 100..${CEILING - 1} links: ${near.length}`);
for (const o of near.sort((a, b) => b.links - a.links).slice(0, 15))
  console.log(`      ${o.links} links  card ${o.itemId}  hs=${o.hsId || "(none)"}  ${JSON.stringify(o.name).slice(0, 60)}`);

// ---------------------------------------------------------------- 2. links the backfill cannot reproduce
/**
 * THE NUMBER THAT DECIDES THE WRITE SEMANTICS. For every Contacts card, split its current links into
 * those pointing at an Accounts card the backfill can name (the card carries a HubSpot ID) and those
 * pointing at one it cannot. The second group is destroyed by a full-replacement write.
 */
console.log(`\n=== CONTACTS BOARD — links a full-replacement write could not reproduce ===`);
let contacts = 0, linkedContacts = 0, linksTotal = 0, linksToIdlessCard = 0, linksToUnknownCard = 0;
const affected = [];
{
  let cursor = null;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: CONTACTS_BOARD, c: cursor, ids: [CONTACTS_ID_COL, CONTACTS_REL_COL] }
    )).boards[0].items_page;
    for (const it of page.items) {
      contacts++;
      const linked = (it.column_values.find(c => c.id === CONTACTS_REL_COL)?.linked_item_ids ?? []).map(String);
      if (!linked.length) continue;
      linkedContacts++;
      linksTotal += linked.length;
      const bad = [];
      for (const target of linked) {
        if (!cardHsId.has(target)) { linksToUnknownCard++; bad.push(`${target}:absent`); continue; }
        if (!cardHsId.get(target)) { linksToIdlessCard++; bad.push(`${target}:no-hubspot-id`); }
      }
      if (bad.length && affected.length < 25)
        affected.push({ itemId: it.id, name: it.name, linked: linked.length, bad });
    }
    cursor = page.cursor;
    if (contacts % 20000 === 0) console.log(`  ${contacts}…`);
  } while (cursor);
}
console.log(`  contact cards                         ${contacts}`);
console.log(`  hold at least one Account link        ${linkedContacts}`);
console.log(`  links held in total                   ${linksTotal}`);
console.log(`  links to an Accounts card with NO HubSpot ID : ${linksToIdlessCard}`);
console.log(`  links to a card absent from the board        : ${linksToUnknownCard}`);
console.log(`  => ${linksToIdlessCard + linksToUnknownCard} links the backfill cannot reproduce,`
  + ` and would DELETE under full-replacement semantics`);
for (const a of affected)
  console.log(`      contact ${a.itemId} ${JSON.stringify(a.name).slice(0, 40)} holds ${a.linked}: ${a.bad.join(", ")}`);

const out = join(ROOT, "scripts", ".measure-relation-cells.json");
writeFileSync(out, JSON.stringify({
  accounts: { cards, withId, withoutId, totalLinks, oversized, near: near.sort((a, b) => b.links - a.links).slice(0, 50) },
  contacts: { contacts, linkedContacts, linksTotal, linksToIdlessCard, linksToUnknownCard, affectedSample: affected },
}, null, 2), "utf8");
console.log(`\nwritten to ${out}`);
