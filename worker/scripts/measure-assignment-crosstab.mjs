/**
 * SALES PERSON x CONTACT OWNER, and what a People-column migration would actually cost. READ-ONLY.
 *
 * Two questions decide the design, and neither can be answered by reasoning:
 *
 * 1. IS THE LEADER ALREADY THE OWNER? The meeting described the Philippines team's workaround as
 *    "把所有的这个 contact，然后呢，owner 呢全部统一送给那个 Mila" — assign every contact's owner to
 *    Myla, then use a second field to hand the actual work to a rep. IF that is what the data shows,
 *    leader visibility ALREADY works through Contact Owner and no extra permission column is needed:
 *    Myla sees them because she owns them, the rep sees them because they are the Sales Person. A
 *    fourth "Sales Access" column would then be solving a problem that does not exist.
 *
 * 2. WHAT GOES BLANK? Moving Sales User from a dropdown to a People column means every value with no
 *    monday account renders as an EMPTY cell. That is accepted — but "accepted" should be a decision
 *    taken against a number, not a shrug, because the same records currently show a readable name.
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
  if (!b.data) throw new Error(JSON.stringify(b.errors ?? b).slice(0, 300));
  return b.data;
}

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
const users = await monday(`query { users(limit: 500) { id name email enabled } }`);
const byEmail = new Map((users.users ?? []).map(u => [String(u.email ?? "").toLowerCase(), u]));

// ---------------------------------------------------------------- 1. Sales Person x Contact Owner
console.log("=== SALES PERSON x CONTACT OWNER ===");
const cross = {};
let after, scanned = 0;
do {
  const r = await hs("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "sales_person", operator: "HAS_PROPERTY" }] }],
    properties: ["sales_person", "hubspot_owner_id"], limit: 100,
    sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], ...(after ? { after } : {}),
  });
  if (!r.ok) { console.log(`  search failed http ${r.status}`); break; }
  for (const rec of r.body.results ?? []) {
    const sp = String(rec.properties?.sales_person ?? "").trim() || "(none)";
    const ow = String(rec.properties?.hubspot_owner_id ?? "").trim();
    const owName = ow ? (owners[ow]?.name || `owner ${ow}`) : "(no owner)";
    cross[sp] ??= {};
    cross[sp][owName] = (cross[sp][owName] ?? 0) + 1;
    scanned++;
  }
  after = r.body.paging?.next?.after;
} while (after && scanned < 12000);
console.log(`  ${scanned} contacts with sales_person examined\n`);
for (const [sp, owns] of Object.entries(cross)) {
  const tot = Object.values(owns).reduce((a, b) => a + b, 0);
  console.log(`  Sales Person = ${JSON.stringify(sp)}  (${tot})`);
  for (const [ow, n] of Object.entries(owns).sort((a, b) => b[1] - a[1]).slice(0, 6))
    console.log(`      owner ${ow.padEnd(26)} ${n}`);
}

/**
 * THE DECISIVE RATIO. If the leader owns the rep's contacts, leader visibility is already a
 * consequence of Contact Owner and needs no new column.
 */
console.log("\n  --- is the leader already the owner? ---");
for (const [sp, owns] of Object.entries(cross)) {
  if (sp === "(none)") continue;
  const tot = Object.values(owns).reduce((a, b) => a + b, 0);
  const byMyla = owns["Myla Mestiola"] ?? 0;
  const bySelf = owns[sp] ?? 0;
  console.log(`  ${sp.padEnd(22)} owned by Myla ${String(byMyla).padStart(5)} (${(100 * byMyla / tot).toFixed(0)}%)`
    + `   owned by themselves ${String(bySelf).padStart(5)} (${(100 * bySelf / tot).toFixed(0)}%)`);
}

// ---------------------------------------------------------------- 2. what a People column loses
console.log("\n=== WHAT GOES BLANK IF SALES USER BECOMES A PEOPLE COLUMN ===");
const seen = new Map();
after = undefined; let scanned2 = 0;
do {
  const r = await hs("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "sales_user", operator: "HAS_PROPERTY" }] }],
    properties: ["sales_user"], limit: 100,
    sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], ...(after ? { after } : {}),
  });
  if (!r.ok) break;
  for (const rec of r.body.results ?? []) {
    const val = String(rec.properties?.sales_user ?? "").trim();
    if (val) seen.set(val, (seen.get(val) ?? 0) + 1);
    scanned2++;
  }
  after = r.body.paging?.next?.after;
} while (after);
let ok = 0, blank = 0;
const blankRows = [];
for (const [val, n] of seen) {
  const o = owners[val];
  const u = o ? byEmail.get(o.email) : undefined;
  if (u) ok += n;
  else { blank += n; blankRows.push({ name: o?.name ?? `(unknown owner ${val})`, email: o?.email ?? "", contacts: n }); }
}
console.log(`  ${scanned2} contacts carry sales_user, ${seen.size} distinct values`);
console.log(`  would RESOLVE to a monday person : ${ok}`);
console.log(`  would render BLANK               : ${blank}   <- currently show a readable name`);
for (const b of blankRows.sort((a, b2) => b2.contacts - a.contacts).slice(0, 15))
  console.log(`      ${String(b.contacts).padStart(6)}  ${b.name.padEnd(28)} ${b.email || "(no owner email)"}`);

// ---------------------------------------------------------------- 3. monday teams
console.log("\n=== MONDAY TEAMS (can a People column hold one?) ===");
const teams = await monday(`query { teams { id name users { id name } } }`);
for (const t of teams.teams ?? [])
  console.log(`  team ${String(t.id).padEnd(10)} ${JSON.stringify(t.name).padEnd(34)} ${t.users?.length ?? 0} members`);
const ph = (teams.teams ?? []).find(t => /philip|pinas|ph\b/i.test(t.name ?? ""));
console.log(`\n  a Philippines team ${ph ? `EXISTS: ${ph.id} ${JSON.stringify(ph.name)} (${ph.users?.length ?? 0} members)` : "does NOT exist yet"}`);

const out = join(ROOT, "scripts", ".assignment-crosstab.json");
writeFileSync(out, JSON.stringify({ cross, salesUser: { scanned: scanned2, resolvable: ok, blank, blankRows },
  teams: (teams.teams ?? []).map(t => ({ id: t.id, name: t.name, members: t.users?.length ?? 0 })) }, null, 2), "utf8");
console.log(`\nwritten to ${out}`);
