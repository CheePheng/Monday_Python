/**
 * THE CONTACTS ASSIGNMENT/PERMISSION MODEL. READ-ONLY — it measures and reports, it changes nothing.
 *
 * The Philippines team needs monday item-level visibility: each rep sees the Contacts assigned to
 * them, and the leader sees the whole team's. monday's "restricted to assigned people" board
 * permission can only be configured against a PEOPLE column, which is why the two existing assignment
 * fields cannot serve it:
 *
 *   Contact owner   multiple_person_mm6zap53  people    <- hubspot_owner_id, appReverse
 *   Sales Person    color_mm701ff2            status    <- sales_person, reverse
 *   Sales User      dropdown_mm70mxfy         dropdown  <- sales_user, forward-only
 *
 * THE QUESTION THAT DECIDES THE MIGRATION is not "can we make a People column" — it is how much of
 * the existing assignment data can actually LAND in one. A People column can only hold a monday user,
 * so anyone without a monday account cannot be represented at all; the meeting acknowledged this
 * ("有些人没有账号") and the answer was that those people must be given accounts. That is a decision
 * about humans, not a migration detail, so the number has to be known before anything is built.
 *
 * AND THE RISK NOBODY HAS RAISED YET. Switching a 94,000-item board to "restricted to assigned
 * people" makes every record with NO assignee invisible to everyone except admins. This project has
 * already hit that once: ObjectSpec.unassignedShared exists precisely so unassigned WM deals stay
 * visible to a team under that permission mode. This script counts how many Contacts would disappear.
 *
 *   node scripts/measure-assignment-fields.mjs
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hs(path, body, attempt = 0) {
  const r = await fetch("https://api.hubapi.com" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 5) {
    await sleep(1500 * 2 ** attempt); return hs(path, body, attempt + 1);
  }
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}
async function monday(query, variables = {}) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.data) throw new Error(JSON.stringify(b.errors ?? b).slice(0, 250));
  return b.data;
}

/** One search, one number. `total` is what we want; the results are irrelevant. */
async function count(filters) {
  const r = await hs("/crm/v3/objects/contacts/search",
    { filterGroups: [{ filters }], properties: ["hs_object_id"], limit: 1 });
  return r.ok ? (r.body.total ?? -1) : -1;
}

const report = { generatedAt: new Date().toISOString() };

console.log("=== POPULATION ===");
const total = await count([{ propertyName: "hs_object_id", operator: "HAS_PROPERTY" }]);
const hasOwner = await count([{ propertyName: "hubspot_owner_id", operator: "HAS_PROPERTY" }]);
const hasPerson = await count([{ propertyName: "sales_person", operator: "HAS_PROPERTY" }]);
const hasUser = await count([{ propertyName: "sales_user", operator: "HAS_PROPERTY" }]);
const bothPU = await count([
  { propertyName: "sales_person", operator: "HAS_PROPERTY" },
  { propertyName: "sales_user", operator: "HAS_PROPERTY" },
]);
// The number that decides whether a permission change is safe at all.
const noneOfThem = await count([
  { propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" },
  { propertyName: "sales_person", operator: "NOT_HAS_PROPERTY" },
  { propertyName: "sales_user", operator: "NOT_HAS_PROPERTY" },
]);
const noOwnerNoPerson = await count([
  { propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" },
  { propertyName: "sales_person", operator: "NOT_HAS_PROPERTY" },
]);
console.log(`  contacts total                         ${total}`);
console.log(`  have Contact Owner (hubspot_owner_id)  ${hasOwner}`);
console.log(`  have Sales Person  (sales_person)      ${hasPerson}`);
console.log(`  have Sales User    (sales_user)        ${hasUser}`);
console.log(`  have BOTH person + user                ${bothPU}`);
console.log(`  have NONE of the three                 ${noneOfThem}`);
console.log(`  have neither Owner nor Sales Person    ${noOwnerNoPerson}`);
Object.assign(report, { total, hasOwner, hasPerson, hasUser, bothPU, noneOfThem, noOwnerNoPerson });

console.log("\n=== sales_person: the 4-option enumeration ===");
const spProp = await hs("/crm/v3/properties/contacts/sales_person");
const spOptions = (spProp.body.options ?? []).map(o => ({ value: o.value, label: o.label }));
report.salesPersonOptions = [];
for (const o of spOptions) {
  const n = await count([{ propertyName: "sales_person", operator: "EQ", value: o.value }]);
  report.salesPersonOptions.push({ ...o, contacts: n });
  console.log(`  ${String(n).padStart(6)}  ${JSON.stringify(o.value)}`);
}

console.log("\n=== who can actually go in a People column ===");
const owners = {};
{
  let after;
  do {
    const q = new URLSearchParams({ limit: "100" });
    if (after) q.set("after", after);
    const r = await hs(`/crm/v3/owners?${q}`);
    for (const o of r.body.results ?? [])
      owners[String(o.id)] = { name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim(), email: (o.email ?? "").toLowerCase() };
    after = r.body.paging?.next?.after;
  } while (after);
}
const users = await monday(`query { users(limit: 500) { id name email } }`);
const byEmail = new Map((users.users ?? []).map(u => [String(u.email ?? "").toLowerCase(), u]));
console.log(`  ${Object.keys(owners).length} HubSpot owners, ${(users.users ?? []).length} monday users`);

/**
 * RESOLUTION IS BY EMAIL, NEVER BY DISPLAY NAME — a name match would silently assign the wrong person,
 * and this portal already contains two distinct owners both called "Rick Antonio".
 *
 * The two fields resolve very differently, and that asymmetry is the finding:
 *   sales_user   stores a HubSpot OWNER ID  -> owner -> email -> monday user. Clean and mechanical.
 *   sales_person stores a DISPLAY NAME      -> there is no id and no email anywhere in the value.
 */
console.log("\n  sales_person values -> monday user (by matching the name to a HubSpot owner's email):");
report.salesPersonResolution = [];
for (const o of spOptions) {
  const owner = Object.entries(owners).find(([, x]) => x.name && x.name.toLowerCase() === o.label.toLowerCase());
  const u = owner ? byEmail.get(owner[1].email) : undefined;
  report.salesPersonResolution.push({ label: o.label, ownerEmail: owner?.[1].email ?? "", mondayUserId: u?.id ?? "" });
  console.log(`    ${o.label.padEnd(24)} owner=${(owner?.[1].email ?? "NO OWNER MATCH").padEnd(32)} monday=${u ? u.name : "NO MONDAY ACCOUNT"}`);
}

console.log("\n  sales_user: how many DISTINCT owner ids are in use, and can each be a monday person?");
{
  const seen = new Map();
  let after, scanned = 0;
  do {
    const r = await hs("/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "sales_user", operator: "HAS_PROPERTY" }] }],
      properties: ["sales_user"], limit: 100,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], ...(after ? { after } : {}),
    });
    for (const rec of r.body.results ?? []) {
      const val = String(rec.properties?.sales_user ?? "").trim();
      if (val) seen.set(val, (seen.get(val) ?? 0) + 1);
      scanned++;
    }
    after = r.body.paging?.next?.after;
    if (scanned >= 10000) break;          // enough to enumerate the distinct set; counts are a sample
  } while (after);
  console.log(`    scanned ${scanned} contacts carrying sales_user; ${seen.size} distinct values`);
  let resolvable = 0, contactsResolvable = 0, unresolvable = 0, contactsUnresolvable = 0;
  const rows = [];
  for (const [val, n] of [...seen].sort((a, b) => b[1] - a[1])) {
    const o = owners[val];
    const u = o ? byEmail.get(o.email) : undefined;
    if (u) { resolvable++; contactsResolvable += n; } else { unresolvable++; contactsUnresolvable += n; }
    rows.push({ value: val, name: o?.name ?? "(unknown owner)", email: o?.email ?? "", mondayUser: u?.name ?? "", contacts: n });
  }
  report.salesUser = { distinct: seen.size, resolvable, unresolvable, contactsResolvable, contactsUnresolvable, rows: rows.slice(0, 80) };
  console.log(`    ${resolvable} distinct values map to a monday user  (${contactsResolvable} contacts in the sample)`);
  console.log(`    ${unresolvable} distinct values DO NOT             (${contactsUnresolvable} contacts in the sample)`);
  console.log(`\n    the ones with NO monday account — these people cannot go in a People column at all:`);
  for (const r2 of rows.filter(x => !x.mondayUser).slice(0, 25))
    console.log(`      ${String(r2.contacts).padStart(5)} contacts  ${r2.name.padEnd(26)} ${r2.email || "(no email on the owner)"}`);
}

const out = join(ROOT, "scripts", ".assignment-fields.json");
writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
console.log(`\nwritten to ${out}`);
