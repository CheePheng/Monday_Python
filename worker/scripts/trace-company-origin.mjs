/**
 * HOW did the Worker come to create ~1,190 HubSpot Companies during the migration?
 *
 * The guard design depends on the answer, so it has to be established rather than assumed. The
 * decisive comparison is per record:
 *
 *   monday card created BEFORE the HubSpot company  -> monday -> HubSpot create (createFromMonday)
 *   monday card created AFTER  the HubSpot company  -> HubSpot -> monday (normal forward sync)
 *
 * For the monday->HubSpot cases it also reports whether an existing HubSpot company ALREADY had that
 * domain, which would mean adoption should have matched instead of creating a second record.
 *
 * Read-only.
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
const ACCOUNTS_BOARD = "5028000496";
const ID_COL = "text_mm6tsnwx";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function monday(query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.data) {
    if (attempt < 5) { await sleep(2000 * 2 ** attempt); return monday(query, variables, attempt + 1); }
    throw new Error(`monday: ${JSON.stringify(b.errors ?? b).slice(0, 200)}`);
  }
  return b.data;
}
const hs = async (path, body) => {
  const r = await fetch("https://api.hubapi.com" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
};

// --- every HubSpot company this Worker created (sync_owner=crm is stamped only at birth by us)
const created = [];
let after;
for (let p = 0; p < 60; p++) {
  const r = await hs("/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [{ propertyName: "sync_owner", operator: "EQ", value: "crm" }] }],
    properties: ["name", "domain", "createdate", "num_associated_contacts"],
    limit: 100, sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
    ...(after ? { after } : {}),
  });
  if (!r.ok) { console.log(`hubspot search failed: ${r.status}`); break; }
  for (const rec of r.body.results ?? []) {
    created.push({
      id: String(rec.id),
      name: (rec.properties?.name ?? "").trim(),
      domain: (rec.properties?.domain ?? "").trim().toLowerCase(),
      createdate: rec.properties?.createdate ?? "",
      contacts: Number(rec.properties?.num_associated_contacts ?? 0),
    });
  }
  after = r.body.paging?.next?.after;
  if (!after) break;
}
console.log(`HubSpot companies stamped sync_owner=crm: ${created.length}\n`);

// --- the monday Accounts board, so each can be matched to its card and creation time
const cardByHsId = new Map();
let cursor = null;
do {
  const page = (await monday(
    `query ($b: ID!, $c: String, $ids: [String!]) {
       boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
         cursor items { id name created_at column_values(ids: $ids) { id text } } } } }`,
    { b: ACCOUNTS_BOARD, c: cursor, ids: [ID_COL] })).boards[0].items_page;
  for (const it of page.items) {
    const hsId = (it.column_values.find(c => c.id === ID_COL)?.text ?? "").trim();
    if (hsId) cardByHsId.set(hsId, { itemId: it.id, name: it.name, createdAt: it.created_at });
  }
  cursor = page.cursor;
} while (cursor);
console.log(`monday Accounts cards carrying a HubSpot id: ${cardByHsId.size}\n`);

const buckets = { mondayFirst: [], hubspotFirst: [], noCard: [] };
for (const c of created) {
  const card = cardByHsId.get(c.id);
  if (!card) { buckets.noCard.push(c); continue; }
  const cardMs = Date.parse(card.createdAt), hsMs = Date.parse(c.createdate);
  // A card stamped by the forward path is created at or after the company. A card that PREDATES the
  // company can only mean the company was created FROM it.
  (cardMs < hsMs - 1000 ? buckets.mondayFirst : buckets.hubspotFirst).push({ ...c, card, gapSec: (hsMs - cardMs) / 1000 });
}

console.log("=== ORIGIN ===");
console.log(`  monday card PREDATES the company (monday -> HubSpot create) : ${buckets.mondayFirst.length}`);
console.log(`  company predates the card (normal HubSpot -> monday)        : ${buckets.hubspotFirst.length}`);
console.log(`  no monday card carries this HubSpot id                      : ${buckets.noCard.length}`);

console.log(`\n=== SAMPLE: monday-first (the unintended write path) ===`);
for (const x of buckets.mondayFirst.slice(0, 12))
  console.log(`  hs ${x.id}  domain=${JSON.stringify(x.domain)}  contacts=${x.contacts}`
    + `  card ${x.card.itemId} created ${x.card.createdAt}  -> company ${x.createdate}  (+${x.gapSec.toFixed(0)}s)`);

// --- would adoption have matched an existing company instead?
console.log(`\n=== SHOULD ADOPTION HAVE MATCHED? checking domains of monday-first creates ===`);
let dupeDomain = 0, checked = 0;
for (const x of buckets.mondayFirst.slice(0, 40)) {
  if (!x.domain) continue;
  const r = await hs("/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: x.domain }] }],
    properties: ["name", "createdate"], limit: 10,
  });
  const hits = (r.body.results ?? []).filter(h => String(h.id) !== x.id);
  checked++;
  if (hits.length) {
    dupeDomain++;
    console.log(`  ${x.domain}: ${hits.length} OTHER company/companies already hold this domain`
      + ` — oldest ${hits.map(h => h.properties?.createdate ?? "?").sort()[0]}`);
  }
}
console.log(`  of ${checked} sampled, ${dupeDomain} now share a domain with a pre-existing company`);

console.log(`\n=== BLANK NAME / SYNTHETIC DOMAIN / HIGH FAN-OUT ===`);
const blank = created.filter(c => !c.name);
const synthetic = created.filter(c => /^(fake|test|example|invalid|localhost|none|noemail|nomail)\./.test(c.domain) || !c.domain);
const bigFan = created.filter(c => c.contacts >= 50).sort((a, b) => b.contacts - a.contacts);
console.log(`  blank name              : ${blank.length}`);
console.log(`  synthetic or no domain  : ${synthetic.length}`);
for (const c of synthetic.slice(0, 10)) console.log(`      ${c.id} domain=${JSON.stringify(c.domain)} contacts=${c.contacts}`);
console.log(`  >= 50 associated contacts: ${bigFan.length}`);
for (const c of bigFan.slice(0, 10)) console.log(`      ${c.id} domain=${JSON.stringify(c.domain)} contacts=${c.contacts} name=${JSON.stringify(c.name)}`);
