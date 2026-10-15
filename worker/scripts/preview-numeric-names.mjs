/**
 * Of the nameless Contacts that will be renamed from their email, how many end up with a purely
 * NUMERIC name?
 *
 * The email local part is a big improvement for maggie.lin@… or bensonhuang@…. It is a much smaller
 * one for 1728351212@qq.com, where the card goes from "contacts 548818911972" to "1728351212" — still
 * an opaque number, just a shorter and more searchable one (it matches the Email column and a rep can
 * search it, which the monday item id never could).
 *
 * Worth measuring rather than guessing, because it decides whether the rule needs a further fallback
 * or is simply an honest reflection of how these contacts are identified in the source data.
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
for (let p = 0; p < 80; p++) {
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
  if (b.status === "error") { console.log("search error: " + JSON.stringify(b).slice(0, 160)); break; }
  for (const rec of b.results ?? []) {
    const e = String(rec.properties?.email ?? "").trim();
    if (e) emails.push(e);
  }
  after = b.paging?.next?.after;
  if (!after) break;
}

const local = e => { const at = e.indexOf("@"); return at > 0 ? e.slice(0, at) : e; };
const domain = e => { const at = e.indexOf("@"); return at > 0 ? e.slice(at + 1).toLowerCase() : ""; };

let numeric = 0, alpha = 0, shortish = 0;
const byDomain = new Map();
for (const e of emails) {
  const l = local(e);
  if (/^\d+$/.test(l)) { numeric++; byDomain.set(domain(e), (byDomain.get(domain(e)) ?? 0) + 1); }
  else alpha++;
  if (l.length <= 3) shortish++;
}

console.log(`nameless contacts with an email: ${emails.length}\n`);
console.log(`  local part is PURELY NUMERIC : ${numeric}  (${((100 * numeric) / emails.length).toFixed(1)}%)`);
console.log(`  local part has letters       : ${alpha}  (${((100 * alpha) / emails.length).toFixed(1)}%)`);
console.log(`  local part <= 3 chars        : ${shortish}`);
console.log(`\nwhere the numeric ones live:`);
for (const [d, n] of [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
  console.log(`    ${String(n).padStart(5)}  @${d}`);
