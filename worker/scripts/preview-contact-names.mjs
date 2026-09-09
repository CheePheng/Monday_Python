/**
 * How many of the 94,318 Contacts will land on the board with a PLACEHOLDER name?
 *
 * itemName falls back to `${object} ${id}` when every nameProp is empty (mapping.ts:66-69), which is
 * correct — monday rejects an empty item name, so a fallback is the only option and this one is at
 * least traceable back to the record. But the fallback is invisible until it is on the board, and a
 * board where thousands of rows read "contacts 548911732425" is a surprise worth having in advance:
 * the Philippines team's whole job is finding a contact by name.
 *
 * Counts only. Decides and changes nothing.
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
const count = async filters => {
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ filterGroups: filters, properties: ["hs_object_id"], limit: 1 }),
  });
  const b = await r.json().catch(() => ({}));
  if (b.status === "error") throw new Error(JSON.stringify(b).slice(0, 200));
  return Number(b.total ?? -1);
};

const total = await count([]);
const noFirst = await count([{ filters: [{ propertyName: "firstname", operator: "NOT_HAS_PROPERTY" }] }]);
const noLast = await count([{ filters: [{ propertyName: "lastname", operator: "NOT_HAS_PROPERTY" }] }]);
// Both missing -> itemName falls back. AND within one filter group.
const neither = await count([{ filters: [
  { propertyName: "firstname", operator: "NOT_HAS_PROPERTY" },
  { propertyName: "lastname", operator: "NOT_HAS_PROPERTY" },
] }]);
const noEmail = await count([{ filters: [{ propertyName: "email", operator: "NOT_HAS_PROPERTY" }] }]);
// The genuinely unusable ones: no name AND no email means the card shows a placeholder and offers no
// other way to identify the person.
const neitherNorEmail = await count([{ filters: [
  { propertyName: "firstname", operator: "NOT_HAS_PROPERTY" },
  { propertyName: "lastname", operator: "NOT_HAS_PROPERTY" },
  { propertyName: "email", operator: "NOT_HAS_PROPERTY" },
] }]);

const pct = n => `${((100 * n) / total).toFixed(1)}%`;
console.log(`contacts total                    ${String(total).padStart(6)}`);
console.log(`no firstname                      ${String(noFirst).padStart(6)}  ${pct(noFirst)}`);
console.log(`no lastname                       ${String(noLast).padStart(6)}  ${pct(noLast)}`);
console.log(`NEITHER -> placeholder card name  ${String(neither).padStart(6)}  ${pct(neither)}`);
console.log(`no email                          ${String(noEmail).padStart(6)}  ${pct(noEmail)}`);
console.log(`no name AND no email              ${String(neitherNorEmail).padStart(6)}  ${pct(neitherNorEmail)}`);
console.log(`\n${neither} card(s) will read "contacts <hubspot id>" on the board.`);
console.log(`Of those, ${neither - neitherNorEmail} still carry an email, so the Email column identifies them.`);
