/**
 * DEAL ASSOCIATION CARDINALITY AND LABELS. READ-ONLY.
 *
 * The Phase 2 audit could not measure this: the Service Key was 403 on deals, so Deal -> Company was
 * INFERRED from the monday board's mirror column rather than read from HubSpot. The Create Deal UI
 * shows it is a first-class association with its own label field, marked required and defaulting to
 * "Primary" — which makes the inference wrong in a way that changes the design. This measures it.
 *
 * THE QUESTIONS THAT DECIDE THE SCHEMA:
 *   1. How many companies does a deal actually have? If it is nearly always one, a "pick the Primary"
 *      rule is a formality. If many have two or more, it is load-bearing.
 *   2. Are the association LABELS actually populated? The UI marks the Company label required, but a
 *      required field in a create form says nothing about 8,651 historical records imported from
 *      Salesforce. A selection rule keyed on a label nobody set would silently fall through to its
 *      fallback on every record.
 *   3. Same for contacts, where the label is optional and defaults to "No label".
 *
 * v4 batch read returns each association WITH its associationTypes, so labels cost no extra request.
 *
 *   node scripts/measure-deal-associations.mjs
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
  if ((r.status === 429 || r.status >= 500) && attempt < 6) {
    await sleep(2000 * 2 ** attempt); return hs(path, body, attempt + 1);
  }
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

// ---- every deal id
console.log("listing deals…");
const deals = [];
{
  let after;
  do {
    const q = new URLSearchParams({ limit: "100", properties: "pipeline,dealstage", archived: "false" });
    if (after) q.set("after", after);
    const r = await hs(`/crm/v3/objects/deals?${q}`);
    if (!r.ok) { console.log(`  list failed http ${r.status}`); break; }
    for (const d of r.body.results ?? []) deals.push({ id: String(d.id), pipeline: d.properties?.pipeline ?? "" });
    after = r.body.paging?.next?.after;
    if (deals.length % 2000 === 0) console.log(`  ${deals.length}…`);
  } while (after);
}
console.log(`  ${deals.length} deals\n`);

const byPipeline = {};
for (const d of deals) byPipeline[d.pipeline || "(none)"] = (byPipeline[d.pipeline || "(none)"] ?? 0) + 1;

/**
 * Reads one association direction for every deal, keeping BOTH the count distribution and the label
 * histogram. Records with zero associations are omitted from `results` by this endpoint, so they are
 * counted by difference rather than assumed — the same trap that made the Contacts pass report 42,899
 * normal records as errors.
 */
async function measure(toObject) {
  const dist = new Map();
  const labels = new Map();
  const labelledRecords = new Map();   // how many DEALS have at least one association with this label
  let pairs = 0, max = 0, maxId = "", seenTotal = 0;
  const multi = [];
  for (let i = 0; i < deals.length; i += 100) {
    const chunk = deals.slice(i, i + 100);
    const r = await hs(`/crm/v4/associations/deals/${toObject}/batch/read`,
      { inputs: chunk.map(d => ({ id: d.id })) });
    if (!r.ok) { console.log(`  ${toObject}: batch failed http ${r.status}`); continue; }
    const seen = new Set();
    for (const row of r.body.results ?? []) {
      const id = String(row.from?.id ?? "");
      seen.add(id);
      seenTotal++;
      const to = row.to ?? [];
      dist.set(to.length, (dist.get(to.length) ?? 0) + 1);
      pairs += to.length;
      if (to.length > max) { max = to.length; maxId = id; }
      if (to.length > 1 && multi.length < 20)
        multi.push({ deal: id, n: to.length, labels: to.map(t => (t.associationTypes ?? []).map(a => a.label ?? `type:${a.typeId}`).join("|")) });
      const here = new Set();
      for (const t of to)
        for (const a of t.associationTypes ?? []) {
          const key = a.label ?? `(unlabelled type ${a.typeId}/${a.category})`;
          labels.set(key, (labels.get(key) ?? 0) + 1);
          here.add(key);
        }
      for (const k of here) labelledRecords.set(k, (labelledRecords.get(k) ?? 0) + 1);
    }
    const zero = chunk.filter(d => !seen.has(d.id)).length;
    if (zero) dist.set(0, (dist.get(0) ?? 0) + zero);
  }
  return { dist, labels, labelledRecords, pairs, max, maxId, seenTotal, multi };
}

const report = { generatedAt: new Date().toISOString(), deals: deals.length, byPipeline, directions: {} };

for (const to of ["companies", "contacts", "line_items"]) {
  console.log(`=== Deal -> ${to} ===`);
  const m = await measure(to);
  const buckets = [...m.dist].sort((a, b) => a[0] - b[0]);
  const withAny = buckets.filter(([n]) => n > 0).reduce((s, [, k]) => s + k, 0);
  const withMulti = buckets.filter(([n]) => n > 1).reduce((s, [, k]) => s + k, 0);
  console.log(`  deals with at least one : ${withAny} of ${deals.length}`);
  console.log(`  deals with MORE than one: ${withMulti}`);
  console.log(`  total pairs             : ${m.pairs}`);
  console.log(`  max on one deal         : ${m.max}${m.maxId ? ` (deal ${m.maxId})` : ""}`);
  console.log(`  distribution            : ${buckets.map(([n, k]) => `${n}:${k}`).join("  ")}`);
  console.log(`  association LABELS (pair count / deals carrying it):`);
  if (!m.labels.size) console.log(`      (none returned at all)`);
  for (const [k, n] of [...m.labels].sort((a, b) => b[1] - a[1]))
    console.log(`      ${String(n).padStart(6)} / ${String(m.labelledRecords.get(k) ?? 0).padStart(6)}  ${k}`);
  if (m.multi.length) {
    console.log(`  examples with more than one:`);
    for (const x of m.multi.slice(0, 6)) console.log(`      deal ${x.deal}: ${x.n} -> [${x.labels.join("] [")}]`);
  }
  console.log("");
  report.directions[to] = {
    withAny, withMulti, pairs: m.pairs, max: m.max, maxId: m.maxId,
    dist: buckets, labels: [...m.labels], labelledRecords: [...m.labelledRecords], multiExamples: m.multi,
  };
}

const out = join(ROOT, "scripts", ".measure-deal-associations.json");
writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
console.log(`written to ${out}`);
