/**
 * If a nameless Contact's card is named from the email LOCAL PART, how many cards end up sharing a
 * name?
 *
 * The proposal is matthew.ng@gmail.com -> "matthew.ng", which is cleaner. The risk runs the other way
 * though: a contact with no first or last name is disproportionately likely to be a ROLE address
 * (info@, sales@, admin@), and stripping the domain collapses info@a.com and info@b.com into two
 * cards both called "info". For a board whose purpose is finding a specific contact, an ambiguous name
 * is worse than an ugly unique one — so this measures the collision rate before the choice is made,
 * rather than discovering it on 3,841 live cards.
 *
 * Reads only the contacts that would actually be affected: those with neither firstname nor lastname.
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

const emails = [];
let after;
for (let page = 0; page < 80; page++) {
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      filterGroups: [{ filters: [
        { propertyName: "firstname", operator: "NOT_HAS_PROPERTY" },
        { propertyName: "lastname", operator: "NOT_HAS_PROPERTY" },
        { propertyName: "email", operator: "HAS_PROPERTY" },
      ] }],
      properties: ["email"], limit: 100, ...(after ? { after } : {}),
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
    }),
  });
  const b = await r.json().catch(() => ({}));
  if (b.status === "error") { console.log("search error: " + JSON.stringify(b).slice(0, 200)); break; }
  for (const rec of b.results ?? []) {
    const e = String(rec.properties?.email ?? "").trim();
    if (e) emails.push(e);
  }
  after = b.paging?.next?.after;
  if (!after) break;
}

console.log(`nameless contacts WITH an email, sampled: ${emails.length}\n`);

const localOf = e => { const at = e.indexOf("@"); return at > 0 ? e.slice(0, at) : e; };
const tally = (list, label) => {
  const counts = new Map();
  for (const x of list) counts.set(x.toLowerCase(), (counts.get(x.toLowerCase()) ?? 0) + 1);
  const dup = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  const inDupGroups = dup.reduce((s, [, n]) => s + n, 0);
  console.log(`${label}`);
  console.log(`  distinct values          ${counts.size}`);
  console.log(`  values used by >1 card   ${dup.length}`);
  console.log(`  cards sharing a name     ${inDupGroups}  (${((100 * inDupGroups) / list.length).toFixed(1)}%)`);
  if (dup.length) {
    console.log(`  worst offenders:`);
    for (const [val, n] of dup.slice(0, 12)) console.log(`      ${String(n).padStart(4)}x  ${JSON.stringify(val)}`);
  }
  console.log("");
  return inDupGroups;
};

const sharedLocal = tally(emails.map(localOf), "IF NAMED BY LOCAL PART (before @):");
const sharedFull = tally(emails, "IF NAMED BY THE FULL EMAIL:");

console.log("verdict:");
console.log(`  local part leaves ${sharedLocal} card(s) with an ambiguous name`);
console.log(`  full email leaves ${sharedFull} card(s) with an ambiguous name`);
console.log(`  difference: ${sharedLocal - sharedFull} extra ambiguous cards from stripping the domain`);
