/**
 * CLASSIFY EVERY HubSpot Company this Worker created, not a sample of them.
 *
 * The earlier duplicate check covered 40 of 1,207 records and found none — which is not a basis for
 * "only one is bad". This classifies all of them.
 *
 * Duplicates are resolved LOCALLY: every company domain in the portal is fetched once (one property
 * per record, ~270 paged requests) and indexed by normalised domain, so 1,207 duplicate questions cost
 * no extra calls instead of 1,207 searches.
 *
 * Classification per record:
 *   duplicate  - another company already holds the same normalised domain (adoption should have matched)
 *   synthetic  - a reserved/placeholder domain that should never have become a company key
 *   suspicious - no domain at all, or a contact fan-out far above the norm
 *   blank-name - created with no name (cosmetic, but says the source card had none either)
 *   legitimate - none of the above
 *
 * Read-only. It classifies and reports; it changes nothing.
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
const ID_COL = "text_mm6tsnwx";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Reserved / placeholder domains that must never identify a company. Evidence-led: fake.com came from
 * 2,006 Salesforce-migration placeholder emails (003q8…@fake.com), and example.com is the same class.
 *
 * `na` WAS IN THIS LIST AND WAS WRONG. It flagged na.denso.com — North America Denso, a real company
 * domain — as synthetic. Regional subdomain prefixes (na, eu, apac, us, cn) are ordinary, so matching
 * on them produces false accusations against real records. A placeholder-domain check must only match
 * tokens that cannot plausibly be a real organisation.
 *
 * Anchored to the REGISTRABLE label as well as the leading label, so "fake.com" matches while
 * "fakedoors.com" (a real business) does not.
 */
const SYNTHETIC = /(^|\.)(fake|testing|invalid|localhost|nomail|noemail|dummy|placeholder|notprovided|noemailprovided)\.|^(localhost|invalid|test|example|none|unknown)\.|^(test|example|none|fake|invalid|localhost)$/;

const norm = d => String(d ?? "").trim().toLowerCase()
  .replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/[.\s]+$/, "");

async function hs(path, body, attempt = 0) {
  const r = await fetch("https://api.hubapi.com" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 6) {
    await sleep(2000 * 2 ** attempt);
    return hs(path, body, attempt + 1);
  }
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

async function monday(query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.data) {
    if (attempt < 6) { await sleep(2000 * 2 ** attempt); return monday(query, variables, attempt + 1); }
    throw new Error(`monday: ${JSON.stringify(b.errors ?? b).slice(0, 200)}`);
  }
  return b.data;
}

// ---- 1. every company in the portal, indexed by normalised domain
console.log("indexing every HubSpot company domain…");
const byDomain = new Map();
const allById = new Map();
let after;
for (let p = 0; p < 600; p++) {
  const q = new URLSearchParams({ limit: "100", properties: "domain,name,createdate,sync_owner", archived: "false" });
  if (after) q.set("after", after);
  const r = await hs(`/crm/v3/objects/companies?${q}`);
  if (!r.ok) { console.log(`  list failed: http ${r.status}`); break; }
  for (const rec of r.body.results ?? []) {
    const id = String(rec.id);
    const d = norm(rec.properties?.domain);
    const row = { id, domain: d, name: (rec.properties?.name ?? "").trim(), createdate: rec.properties?.createdate ?? "", owner: rec.properties?.sync_owner ?? "" };
    allById.set(id, row);
    if (d) { if (!byDomain.has(d)) byDomain.set(d, []); byDomain.get(d).push(row); }
  }
  after = r.body.paging?.next?.after;
  if (allById.size % 5000 === 0) console.log(`  ${allById.size}…`);
  if (!after) break;
}
console.log(`  ${allById.size} companies, ${byDomain.size} distinct domains\n`);

// ---- 2. the ones we created, with their contact counts
console.log("listing companies stamped sync_owner=crm…");
const ours = [];
after = undefined;
for (let p = 0; p < 60; p++) {
  const r = await hs("/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [{ propertyName: "sync_owner", operator: "EQ", value: "crm" }] }],
    properties: ["name", "domain", "createdate", "num_associated_contacts"],
    limit: 100, sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
    ...(after ? { after } : {}),
  });
  if (!r.ok) { console.log(`  search failed: http ${r.status}`); break; }
  for (const rec of r.body.results ?? []) ours.push({
    id: String(rec.id),
    name: (rec.properties?.name ?? "").trim(),
    domain: norm(rec.properties?.domain),
    createdate: rec.properties?.createdate ?? "",
    contacts: Number(rec.properties?.num_associated_contacts ?? 0),
  });
  after = r.body.paging?.next?.after;
  if (!after) break;
}
console.log(`  ${ours.length}\n`);

// ---- 3. the monday card behind each, to separate monday-first from HubSpot-first
console.log("indexing the Accounts board…");
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
console.log(`  ${cardByHsId.size} cards carry a HubSpot id\n`);

// ---- 4. classify
const rows = [];
for (const c of ours) {
  const card = cardByHsId.get(c.id);
  const cardMs = card ? Date.parse(card.createdAt) : 0;
  const hsMs = Date.parse(c.createdate);
  const mondayFirst = !!card && cardMs < hsMs - 1000;

  const sameDomain = (c.domain ? (byDomain.get(c.domain) ?? []) : []).filter(x => x.id !== c.id);
  const tags = [];
  if (sameDomain.length) tags.push("duplicate");
  if (c.domain && SYNTHETIC.test(c.domain)) tags.push("synthetic");
  if (!c.domain) tags.push("suspicious:no-domain");
  if (c.contacts >= 50) tags.push("suspicious:fan-out");
  if (!c.name) tags.push("blank-name");
  rows.push({
    ...c, mondayFirst,
    cardId: card?.itemId ?? "", cardCreated: card?.createdAt ?? "",
    gapSec: card ? (hsMs - cardMs) / 1000 : null,
    dupeIds: sameDomain.map(x => x.id),
    dupeOldest: sameDomain.map(x => x.createdate).sort()[0] ?? "",
    classification: tags.length ? tags.join("+") : "legitimate",
  });
}

const count = pred => rows.filter(pred).length;
console.log("================ CLASSIFICATION ================");
console.log(`  total created by this Worker      : ${rows.length}`);
console.log(`    monday card came FIRST          : ${count(r => r.mondayFirst)}`);
console.log(`    HubSpot came first (normal)     : ${count(r => !r.mondayFirst)}`);
console.log("");
console.log(`  legitimate                        : ${count(r => r.classification === "legitimate")}`);
console.log(`  DUPLICATE of an existing company  : ${count(r => r.dupeIds.length > 0)}`);
console.log(`  SYNTHETIC domain                  : ${count(r => /synthetic/.test(r.classification))}`);
console.log(`  suspicious: no domain             : ${count(r => /no-domain/.test(r.classification))}`);
console.log(`  suspicious: >= 50 contacts        : ${count(r => /fan-out/.test(r.classification))}`);
console.log(`  blank name (cosmetic)             : ${count(r => !r.name)}`);

const bad = rows.filter(r => r.dupeIds.length || /synthetic|no-domain|fan-out/.test(r.classification));
console.log(`\n================ EVERY NON-LEGITIMATE RECORD (${bad.length}) ================`);
for (const r of bad.sort((a, b) => b.contacts - a.contacts)) {
  console.log(`  hs ${r.id}  contacts=${String(r.contacts).padStart(5)}  ${r.classification}`);
  console.log(`      domain=${JSON.stringify(r.domain)}  name=${JSON.stringify(r.name).slice(0, 44)}  created=${r.createdate}`);
  if (r.cardId) console.log(`      monday card ${r.cardId} created ${r.cardCreated}${r.gapSec !== null ? ` (company +${r.gapSec.toFixed(0)}s)` : ""}`);
  if (r.dupeIds.length) console.log(`      SAME DOMAIN as: ${r.dupeIds.join(", ")}  (oldest ${r.dupeOldest})`);
}

const out = join(ROOT, "scripts", ".audit-created-companies.json");
writeFileSync(out, JSON.stringify(rows, null, 2), "utf8");
console.log(`\nfull per-record detail written to ${out}`);
