/**
 * How many HubSpot Companies have NO name, and what shape are their domains?
 *
 * Decides how much machinery a domain-derived card name actually needs. "Strip to the domain stem" is
 * easy for hubspot.com and ambiguous for qk.ilongyu.com.cn — but only if records like that exist, so
 * this counts them rather than designing for imagined input.
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
const search = async (filters, props, after) => {
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
    method: "POST",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      filterGroups: [{ filters }], properties: props, limit: 100,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], ...(after ? { after } : {}),
    }),
  });
  return r.json();
};

const total = (await search([{ propertyName: "hs_object_id", operator: "HAS_PROPERTY" }], ["name"])).total;
const noName = (await search([{ propertyName: "name", operator: "NOT_HAS_PROPERTY" }], ["name"])).total;
const noNameNoDomain = (await search([
  { propertyName: "name", operator: "NOT_HAS_PROPERTY" },
  { propertyName: "domain", operator: "NOT_HAS_PROPERTY" },
], ["name"])).total;

console.log(`companies total                 ${String(total).padStart(6)}`);
console.log(`no name                         ${String(noName).padStart(6)}  ${((100 * noName) / total).toFixed(1)}%`);
console.log(`no name AND no domain           ${String(noNameNoDomain).padStart(6)}`);
console.log(`no name but HAS a domain        ${String(noName - noNameNoDomain).padStart(6)}  <- these gain a real name\n`);

// Collect their domains so the suffix shapes are measured, not guessed.
const domains = [];
let after;
for (let p = 0; p < 60; p++) {
  const b = await search([
    { propertyName: "name", operator: "NOT_HAS_PROPERTY" },
    { propertyName: "domain", operator: "HAS_PROPERTY" },
  ], ["domain"], after);
  for (const r of b.results ?? []) {
    const d = String(r.properties?.domain ?? "").trim().toLowerCase();
    if (d) domains.push(d);
  }
  after = b.paging?.next?.after;
  if (!after) break;
}
console.log(`sampled ${domains.length} domains from nameless companies\n`);

const labelCount = new Map();
const multiSuffix = [];
const KNOWN_MULTI = /\.(com|net|org|co|gov|edu|ac|biz)\.[a-z]{2}$/;
for (const d of domains) {
  const n = d.split(".").length;
  labelCount.set(n, (labelCount.get(n) ?? 0) + 1);
  if (KNOWN_MULTI.test(d)) multiSuffix.push(d);
}
console.log("dot-separated label counts:");
for (const [n, c] of [...labelCount.entries()].sort((a, b) => a[0] - b[0]))
  console.log(`  ${n} labels: ${c}`);
console.log(`\nmulti-part public suffixes (com.my / co.uk / com.cn ...): ${multiSuffix.length}`);
for (const d of multiSuffix.slice(0, 15)) console.log(`    ${d}`);
console.log(`\ndeep subdomains (4+ labels): ${(labelCount.get(4) ?? 0) + (labelCount.get(5) ?? 0)}`);
for (const d of domains.filter(x => x.split(".").length >= 4).slice(0, 15)) console.log(`    ${d}`);
console.log(`\nfirst 25 domains as-is:`);
for (const d of domains.slice(0, 25)) console.log(`    ${d}`);
