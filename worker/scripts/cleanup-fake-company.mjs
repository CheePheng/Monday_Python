/**
 * APPROVED CLEANUP — HubSpot Company 345685052118 (fake.com) and monday Accounts card 2856600500.
 *
 * That company was created by this integration on 2026-09-10, four seconds after a monday card carrying
 * the placeholder domain appeared, by the write-back path the provenance guard now closes. It has a
 * blank name and 1,581 contact associations that assert 1,581 real people work at "fake.com". The
 * domain itself came from 2,006 Salesforce-migration placeholder emails (003q8…@fake.com).
 *
 * DELETES THE COMPANY RATHER THAN STRIPPING 1,581 ASSOCIATIONS, and the reason is reversibility:
 * HubSpot's recycle bin restores a deleted company, while an individually removed association has no
 * undo. Stripping first would perform 1,581 irreversible operations to reach the same end state one
 * reversible operation reaches. The exported pair list remains the belt-and-braces.
 *
 * NO CONTACT IS TOUCHED, in either system. All 1,581 were verified to hold another company association,
 * so every one keeps its real employer.
 *
 *   node scripts/cleanup-fake-company.mjs            # plan + verify preconditions, writes nothing
 *   node scripts/cleanup-fake-company.mjs --apply
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
const COMPANY_ID = "345685052118";
const CARD_ID = "2856600500";
const EXPORT = join(ROOT, "scripts", ".cleanup-plan-synthetic.json");
const apply = process.argv.includes("--apply");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hs(path, body, method, attempt = 0) {
  const r = await fetch("https://api.hubapi.com" + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 6) {
    await sleep(2000 * 2 ** attempt); return hs(path, body, method, attempt + 1);
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
    throw new Error(`monday: ${JSON.stringify(b.errors ?? b).slice(0, 250)}`);
  }
  return b.data;
}

// ---------------- preconditions. Refuse rather than proceed on a surprise.
console.log("=== PRECONDITIONS ===");
const exported = JSON.parse(readFileSync(EXPORT, "utf8"));
const target = exported.targets.find(t => t.companyId === COMPANY_ID);
if (!target) { console.error(`  the export does not contain ${COMPANY_ID} — refusing`); process.exit(1); }
console.log(`  export holds ${target.associatedContactIds.length} contact ids for this company`);

const pre = await hs(`/crm/v3/objects/companies/${COMPANY_ID}?properties=name,domain,sync_owner,num_associated_contacts`);
if (!pre.ok) { console.error(`  company ${COMPANY_ID} not readable (http ${pre.status}) — refusing`); process.exit(1); }
const p = pre.body.properties ?? {};
console.log(`  company ${COMPANY_ID}: domain=${JSON.stringify(p.domain)} name=${JSON.stringify(p.name ?? "")}`
  + ` sync_owner=${p.sync_owner} contacts=${p.num_associated_contacts}`);
// Identity check: never delete on an id alone. The domain and our own ownership stamp must both agree.
if (p.domain !== "fake.com") { console.error(`  domain is not fake.com — refusing`); process.exit(1); }
if (p.sync_owner !== "crm") { console.error(`  not stamped sync_owner=crm — refusing`); process.exit(1); }

const sampleIds = target.associatedContactIds.slice(0, 100);
const preAssoc = await hs("/crm/v4/associations/contacts/companies/batch/read", { inputs: sampleIds.map(id => ({ id })) });
let withOther = 0;
for (const row of preAssoc.body.results ?? []) {
  if ((row.to ?? []).some(x => String(x.toObjectId) !== COMPANY_ID)) withOther++;
}
console.log(`  sampled ${sampleIds.length} contacts: ${withOther} hold another company (expect all)`);
if (withOther !== sampleIds.length) {
  console.error(`  some sampled contacts would be left with NO company — refusing (plan said 0)`);
  process.exit(1);
}

if (!apply) { console.log("\nPLAN ONLY — preconditions pass. Re-run with --apply to execute."); process.exit(0); }

// ---------------- step 1: delete the HubSpot company
console.log("\n=== STEP 1: delete the HubSpot company ===");
const del = await hs(`/crm/v3/objects/companies/${COMPANY_ID}`, undefined, "DELETE");
console.log(`  DELETE /companies/${COMPANY_ID} -> http ${del.status}`);
if (!del.ok && del.status !== 404) { console.error(`  delete failed — stopping BEFORE touching monday`); process.exit(1); }

// ---------------- step 2: verify it is gone before touching monday
console.log("\n=== STEP 2: verify the company is gone ===");
await sleep(3000);
const after = await hs(`/crm/v3/objects/companies/${COMPANY_ID}`);
console.log(`  GET /companies/${COMPANY_ID} -> http ${after.status} ${after.status === 404 ? "(gone, as intended)" : "STILL PRESENT"}`);
if (after.status !== 404) { console.error(`  company still readable — stopping before the monday card`); process.exit(1); }

// ---------------- step 3: the monday card
console.log("\n=== STEP 3: delete the monday Accounts card ===");
try {
  const d = await monday(`mutation ($i: ID!) { delete_item(item_id: $i) { id } }`, { i: CARD_ID });
  console.log(`  delete_item ${CARD_ID} -> ${JSON.stringify(d.delete_item?.id ?? null)}`);
} catch (e) { console.log(`  delete_item failed: ${String(e).slice(0, 200)}`); }

// ---------------- step 4: verification
console.log("\n=== STEP 4: VERIFICATION ===");

const contactsAlive = await hs("/crm/v3/objects/contacts/batch/read",
  { properties: ["email"], inputs: sampleIds.map(id => ({ id })) });
console.log(`  sampled contacts still present : ${(contactsAlive.body.results ?? []).length}/${sampleIds.length}`);

const postAssoc = await hs("/crm/v4/associations/contacts/companies/batch/read", { inputs: sampleIds.map(id => ({ id })) });
let keptCompany = 0, stillFake = 0;
for (const row of postAssoc.body.results ?? []) {
  const ids = (row.to ?? []).map(x => String(x.toObjectId));
  if (ids.some(x => x !== COMPANY_ID)) keptCompany++;
  if (ids.includes(COMPANY_ID)) stillFake++;
}
console.log(`  still hold their OTHER company : ${keptCompany}/${sampleIds.length}`);
console.log(`  still linked to the deleted co : ${stillFake} (expect 0)`);

// HubSpot's SEARCH index trails the object store by seconds, so a search run immediately after a
// delete can still return the deleted record — the first run of this script reported "1 (expect 0)"
// for that reason alone, and re-querying moments later returned 0. Retry until it settles rather than
// reporting a phantom failure. The authoritative check is the 404 in step 2, not this.
let onDomain = "?";
for (let i = 0; i < 5; i++) {
  const byDomain = await hs("/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: "fake.com" }] }],
    properties: ["name"], limit: 10,
  });
  onDomain = byDomain.body.total ?? "?";
  if (onDomain === 0) break;
  await sleep(4000);
}
console.log(`  companies still on domain fake.com : ${onDomain} (expect 0; search index can lag)`);

const crmOwned = await hs("/crm/v3/objects/companies/search", {
  filterGroups: [{ filters: [{ propertyName: "sync_owner", operator: "EQ", value: "crm" }] }],
  properties: ["name"], limit: 1,
});
console.log(`  companies stamped sync_owner=crm   : ${crmOwned.body.total ?? "?"}`);

// monday KEEPS RETURNING A DELETED ITEM, with state "deleted" — it does not omit it from items().
// Asserting on presence therefore reports a false alarm on a successful delete, which is exactly what
// the first run of this script did. The state is the fact; existence is not.
const card = await monday(`query ($i: [ID!]) { items(ids: $i) { id name state } }`, { i: [CARD_ID] });
const st = (card.items ?? [])[0]?.state ?? "absent";
console.log(`  monday card ${CARD_ID} : state=${st} ${st === "deleted" || st === "absent" ? "(gone, as intended)" : "STILL ACTIVE"}`);

console.log(`\n  NOT touched: any Contact, in either system.`);
console.log(`  Rollback: restore the company from HubSpot's recycle bin (90 days); if its associations do`);
console.log(`  not return with it, ${EXPORT} re-creates all ${target.associatedContactIds.length} pairs.`);
