/**
 * PHASE-2 AUDIT — Deals, Line Items and Activities. READ-ONLY: it measures and reports, it writes
 * nothing to either system.
 *
 * The monday side of this audit comes from the Platform MCP (board schemas and, critically, the
 * automation configs — the API cannot tell you that an automation reads `deal_stage`). This script
 * covers what the MCP cannot: HubSpot's own schemas, the historical record counts that decide whether
 * a backfill is an afternoon or a week, and the association CARDINALITY that decides whether a
 * board_relation column is even the right shape.
 *
 * WHY CARDINALITY IS THE HEADLINE NUMBER. The Contacts/Companies phase was nearly derailed by a
 * cardinality fact discovered late: one company had 2,007 associated contacts and monday stops
 * accepting links into a relation cell at ~751. Measuring the distribution FIRST this time is the
 * whole point of auditing before building.
 *
 *   node scripts/audit-deals-phase.mjs
 *   node scripts/audit-deals-phase.mjs --sample 2000     # cap the per-record association reads
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
const args = { sample: Infinity };
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--sample") args.sample = Number(process.argv[++i]);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/** Total object count, without paging the whole object store. */
async function total(object) {
  const r = await hs(`/crm/v3/objects/${object}/search`, { limit: 1, properties: ["hs_object_id"] });
  return r.ok ? (r.body.total ?? "?") : `http ${r.status}`;
}

const report = { generatedAt: new Date().toISOString() };

// ---------------------------------------------------------------- 1. schemas
/**
 * The property schema, ordered so the answer to "what type must the monday column be?" is mechanical.
 * `calculated` is called out separately because a calculated property is one-way BY CONSTRUCTION —
 * HubSpot recomputes it and a reverse write is either rejected or silently lost.
 */
async function schema(object) {
  const r = await hs(`/crm/v3/properties/${object}`);
  if (!r.ok) { console.log(`  ${object}: properties unreadable (http ${r.status})`); return []; }
  return (r.body.results ?? [])
    .filter(p => !p.hidden)
    .map(p => ({
      name: p.name, label: p.label, type: p.type, fieldType: p.fieldType,
      calculated: !!p.calculated, hubspotDefined: !!p.hubspotDefined,
      readOnly: !!p.modificationMetadata?.readOnlyValue,
      options: (p.options ?? []).length,
      optionLabels: (p.options ?? []).slice(0, 40).map(o => o.label),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

for (const object of ["deals", "line_items"]) {
  console.log(`\n================ HubSpot ${object} SCHEMA ================`);
  const props = await schema(object);
  report[`${object}Properties`] = props;
  const writable = props.filter(p => !p.calculated && !p.readOnly);
  console.log(`  ${props.length} visible properties — ${writable.length} writable,`
    + ` ${props.filter(p => p.calculated).length} calculated, ${props.filter(p => p.readOnly).length} read-only`);
  const byType = {};
  for (const p of props) byType[`${p.type}/${p.fieldType}`] = (byType[`${p.type}/${p.fieldType}`] ?? 0) + 1;
  for (const [k, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`      ${k}: ${n}`);
}

// ---------------------------------------------------------------- 2. historical volume
console.log(`\n================ HISTORICAL VOLUME ================`);
const counts = {};
for (const o of ["deals", "line_items", "calls", "emails", "meetings", "notes", "tasks"]) {
  counts[o] = await total(o);
  console.log(`  ${o.padEnd(12)} ${counts[o]}`);
}
report.counts = counts;

// ---------------------------------------------------------------- 3. association cardinality
/**
 * The distribution, not the average. An average of 1.4 contacts per deal tells you nothing about the
 * deal with 300 of them, and it is the tail that breaks a relation column.
 */
async function cardinality(fromObject, toObject, ids) {
  const dist = new Map();          // n associations -> how many records have n
  let max = 0, maxId = "", pairs = 0, read = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await hs(`/crm/v4/associations/${fromObject}/${toObject}/batch/read`,
      { inputs: chunk.map(id => ({ id })) });
    if (!r.ok) { console.log(`      batch read failed: http ${r.status}`); continue; }
    const seen = new Set();
    for (const row of r.body.results ?? []) {
      const id = String(row.from?.id ?? "");
      const n = (row.to ?? []).length;
      seen.add(id);
      dist.set(n, (dist.get(n) ?? 0) + 1);
      pairs += n;
      if (n > max) { max = n; maxId = id; }
    }
    // The batch endpoint OMITS records with zero associations rather than returning an empty list,
    // so they must be counted by difference or the distribution silently loses its largest bucket.
    const zero = chunk.filter(id => !seen.has(String(id))).length;
    if (zero) dist.set(0, (dist.get(0) ?? 0) + zero);
    read += chunk.length;
  }
  return { dist, max, maxId, pairs, read };
}

const dealIds = [];
{
  let after;
  do {
    const q = new URLSearchParams({ limit: "100", properties: "hs_object_id", archived: "false" });
    if (after) q.set("after", after);
    const r = await hs(`/crm/v3/objects/deals?${q}`);
    if (!r.ok) { console.log(`  deal list failed: http ${r.status}`); break; }
    for (const d of r.body.results ?? []) dealIds.push(String(d.id));
    after = r.body.paging?.next?.after;
  } while (after && dealIds.length < args.sample);
}
console.log(`\n================ ASSOCIATION CARDINALITY ================`);
console.log(`  ${dealIds.length} deals listed${dealIds.length >= args.sample ? ` (capped by --sample ${args.sample} — NOT the whole object)` : " (all of them)"}`);

report.cardinality = {};
for (const [to, label] of [["contacts", "Deal -> Contacts"], ["companies", "Deal -> Companies"], ["line_items", "Deal -> Line Items"]]) {
  const c = await cardinality("deals", to, dealIds);
  const buckets = [...c.dist].sort((a, b) => a[0] - b[0]);
  console.log(`\n  ${label}`);
  console.log(`      records read     ${c.read}`);
  console.log(`      total pairs      ${c.pairs}`);
  console.log(`      max on one deal  ${c.max}${c.maxId ? `  (deal ${c.maxId})` : ""}`);
  console.log(`      distribution     ${buckets.map(([n, k]) => `${n}:${k}`).join("  ")}`);
  const over = buckets.filter(([n]) => n > 1).reduce((s, [, k]) => s + k, 0);
  console.log(`      deals with >1    ${over}`);
  report.cardinality[to] = { max: c.max, maxId: c.maxId, pairs: c.pairs, read: c.read, dist: buckets, over };
}

// Line Item -> Deal, the reverse direction, because it decides whether a Line Item card can carry a
// single Deal link or needs a multi-link column.
{
  const liIds = [];
  let after;
  do {
    const q = new URLSearchParams({ limit: "100", properties: "hs_object_id", archived: "false" });
    if (after) q.set("after", after);
    const r = await hs(`/crm/v3/objects/line_items?${q}`);
    if (!r.ok) break;
    for (const d of r.body.results ?? []) liIds.push(String(d.id));
    after = r.body.paging?.next?.after;
  } while (after && liIds.length < args.sample);
  const c = await cardinality("line_items", "deals", liIds);
  console.log(`\n  Line Item -> Deals`);
  console.log(`      records read     ${c.read}`);
  console.log(`      max on one item  ${c.max}${c.maxId ? `  (line item ${c.maxId})` : ""}`);
  console.log(`      distribution     ${[...c.dist].sort((a, b) => a[0] - b[0]).map(([n, k]) => `${n}:${k}`).join("  ")}`);
  report.cardinality.lineItemToDeals = { max: c.max, read: c.read };
}

// ---------------------------------------------------------------- 4. what the Deals actually hold
/**
 * Six deals on the monday board against however many are in HubSpot. Which properties are actually
 * POPULATED decides what is worth mapping: a property nobody fills is a column nobody needs.
 */
console.log(`\n================ PROPERTY FILL RATE (deals) ================`);
{
  const props = (report.dealsProperties ?? []).filter(p => !p.calculated).map(p => p.name);
  const filled = new Map();
  let n = 0;
  for (let i = 0; i < dealIds.length; i += 100) {
    const r = await hs("/crm/v3/objects/deals/batch/read",
      { properties: props.slice(0, 250), inputs: dealIds.slice(i, i + 100).map(id => ({ id })) });
    if (!r.ok) continue;
    for (const rec of r.body.results ?? []) {
      n++;
      for (const [k, val] of Object.entries(rec.properties ?? {}))
        if (val !== null && String(val).trim() !== "") filled.set(k, (filled.get(k) ?? 0) + 1);
    }
  }
  console.log(`  read ${n} deals; properties populated on at least one:`);
  for (const [k, c] of [...filled].sort((a, b) => b[1] - a[1]))
    console.log(`      ${String(c).padStart(5)}/${n}  ${k}`);
  report.dealFillRate = { read: n, filled: [...filled].sort((a, b) => b[1] - a[1]) };
}

const out = join(ROOT, "scripts", ".audit-deals-phase.json");
writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
console.log(`\nfull detail written to ${out}`);
