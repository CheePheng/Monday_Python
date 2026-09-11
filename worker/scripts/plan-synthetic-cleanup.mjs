/**
 * CLEANUP PLAN for the two synthetic Companies the Worker created. READ-ONLY — it plans and exports,
 * it changes nothing.
 *
 * Both were created from monday cards carrying a placeholder domain, seconds after the card appeared,
 * by the write-back path the provenance guard now closes:
 *   fake.com  345685052118  1,581 contact associations, blank name
 *   none.com  345759179464      1 contact association, name "None at this time"
 *
 * WHY AN EXPORT COMES FIRST, and this is the part that decides whether the cleanup is reversible.
 * Deleting a HubSpot COMPANY is recoverable — it goes to the recycle bin. Removing an ASSOCIATION is
 * not: there is no undo and no bin for it. So every (contact -> company) pair is written to disk
 * before anything is proposed, which is what makes re-creating them possible if the removal turns out
 * to be wrong. A plan that cannot be undone is not a plan.
 *
 * It also checks something that changes the impact materially: whether each contact has ANOTHER company
 * association. A contact whose only company is fake.com ends up with no company at all — correct, since
 * they never worked there, but it must be stated rather than discovered.
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
const TARGETS = [
  { id: "345685052118", domain: "fake.com", card: "2856600500" },
  { id: "345759179464", domain: "none.com", card: "2857074947" },
];
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
    throw new Error(`monday: ${JSON.stringify(b.errors ?? b).slice(0, 200)}`);
  }
  return b.data;
}

const plan = { generatedAt: new Date().toISOString(), targets: [] };

for (const t of TARGETS) {
  console.log(`\n================ ${t.domain}  (HubSpot ${t.id}) ================`);

  const co = await hs(`/crm/v3/objects/companies/${t.id}?properties=name,domain,createdate,sync_owner,num_associated_contacts,hs_object_source_label,hubspot_owner_id`);
  if (!co.ok) { console.log(`  cannot read company: http ${co.status}`); continue; }
  const p = co.body.properties ?? {};
  console.log(`  name              ${JSON.stringify(p.name ?? "")}`);
  console.log(`  domain            ${JSON.stringify(p.domain ?? "")}`);
  console.log(`  created           ${p.createdate}`);
  console.log(`  source            ${p.hs_object_source_label}   sync_owner=${p.sync_owner}`);
  console.log(`  owner             ${p.hubspot_owner_id ?? "(none)"}`);
  console.log(`  HubSpot says      ${p.num_associated_contacts} associated contacts`);

  // --- every associated contact, paged
  const contactIds = [];
  let after;
  do {
    const q = new URLSearchParams({ limit: "500" });
    if (after) q.set("after", after);
    const r = await hs(`/crm/v4/objects/companies/${t.id}/associations/contacts?${q}`);
    if (!r.ok) { console.log(`  association read failed: http ${r.status}`); break; }
    for (const row of r.body.results ?? []) contactIds.push(String(row.toObjectId));
    after = r.body.paging?.next?.after;
  } while (after);
  console.log(`  associations read  ${contactIds.length}`);

  // --- do those contacts have ANOTHER company? decides whether they end up with none.
  let alsoElsewhere = 0, onlyHere = 0;
  const sample = [];
  for (let i = 0; i < contactIds.length; i += 100) {
    const chunk = contactIds.slice(i, i + 100);
    const r = await hs("/crm/v4/associations/contacts/companies/batch/read", { inputs: chunk.map(id => ({ id })) });
    if (!r.ok) continue;
    for (const row of r.body.results ?? []) {
      const others = (row.to ?? []).map(x => String(x.toObjectId)).filter(x => x !== t.id);
      if (others.length) alsoElsewhere++; else onlyHere++;
      if (sample.length < 8) sample.push({ contact: String(row.from?.id ?? ""), otherCompanies: others.length });
    }
  }
  console.log(`  of those contacts: ${alsoElsewhere} have another company, ${onlyHere} would be left with NONE`);
  for (const s of sample) console.log(`      contact ${s.contact}  other companies: ${s.otherCompanies}`);

  // --- the monday card behind it
  let card = null;
  try {
    const d = await monday(
      `query ($i: [ID!]) { items(ids: $i) { id name created_at
         column_values(ids: ["text_mm6tsnwx","company_domain","account_contact"]) {
           id text ... on BoardRelationValue { linked_item_ids } } } }`,
      { i: [t.card] });
    card = d.items?.[0] ?? null;
  } catch (e) { console.log(`  monday card read failed: ${String(e).slice(0, 100)}`); }
  if (card) {
    const cells = {};
    for (const cv of card.column_values) cells[cv.id] = cv.text ?? "";
    const rel = card.column_values.find(c => c.linked_item_ids);
    console.log(`  monday card ${card.id} ${JSON.stringify(card.name)} created ${card.created_at}`);
    console.log(`      HubSpot ID cell  ${JSON.stringify(cells["text_mm6tsnwx"])}`);
    console.log(`      domain cell      ${JSON.stringify(cells["company_domain"])}`);
    console.log(`      linked contacts  ${(rel?.linked_item_ids ?? []).length}`);
  }

  plan.targets.push({
    companyId: t.id, domain: t.domain, name: p.name ?? "", createdate: p.createdate,
    associatedContactIds: contactIds, onlyCompanyForNContacts: onlyHere, alsoElsewhere,
    mondayCardId: t.card,
    mondayLinkedContacts: card ? (card.column_values.find(c => c.linked_item_ids)?.linked_item_ids ?? []).length : null,
  });
}

const out = join(ROOT, "scripts", ".cleanup-plan-synthetic.json");
writeFileSync(out, JSON.stringify(plan, null, 2), "utf8");
console.log(`\n================ EXPORT ================`);
console.log(`  every (contact -> company) pair written to:`);
console.log(`  ${out}`);
console.log(`  This file is the ONLY way to re-create the associations: HubSpot's recycle bin restores a`);
console.log(`  deleted COMPANY, but there is no undo for a removed ASSOCIATION.`);
