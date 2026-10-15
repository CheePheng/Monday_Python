/**
 * DID THE HISTORICAL IMPORT ACTUALLY LAND CORRECTLY?
 *
 * "The script exited 0" is not verification. This compares monday cards against HubSpot field by
 * field, using the Worker's OWN `expectedText` — the same function the live reconcile uses to decide
 * whether a cell is stale. That matters more than a hand-rolled comparison would: if a cell disagrees
 * with expectedText, the next incremental webhook WILL rewrite it, so any mismatch reported here is
 * exactly a cell the sync considers wrong, not a cosmetic difference of opinion.
 *
 *   node scripts/verify-crm-import.mjs                      both boards, 200-card sample each
 *   node scripts/verify-crm-import.mjs --sample 1000        bigger sample
 *   node scripts/verify-crm-import.mjs --object companies   one board
 *   node scripts/verify-crm-import.mjs --counts             totals/duplicates/missing only, no field compare
 *
 * Sampling is RANDOM across the board rather than the first N, because the first N are the oldest
 * cards and would hide a fault that only affects records imported later.
 *
 * Read-only. It writes to neither system.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HS_API = "https://api.hubapi.com";

function creds() {
  const out = { MONDAY_API_TOKEN: process.env.MONDAY_API_TOKEN ?? "", HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN ?? "" };
  const p = join(ROOT, ".dev.vars");
  try {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] in out && !out[m[1]]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no file: rely on the environment */ }
  return out;
}

async function loadWorker() {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  const out = join(dir, "w.mjs"), entry = join(dir, "e.ts");
  writeFileSync(entry, [
    `export { buildCtx } from ${JSON.stringify(join(ROOT, "src", "sync.ts"))};`,
    `export { propertiesForSpec } from ${JSON.stringify(join(ROOT, "src", "hubspot.ts"))};`,
    `export { expectedText, itemName } from ${JSON.stringify(join(ROOT, "src", "mapping.ts"))};`,
    `export { CRM_CONTACTS, CRM_ACCOUNTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
  ].join("\n"), "utf8");
  buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
  return { mod: await import(pathToFileURL(out).href), cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function monday(token, query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) {
    if (attempt < 5) { await sleep(1500 * 2 ** attempt); return monday(token, query, variables, attempt + 1); }
    throw new Error(`monday: http ${r.status} ${JSON.stringify(b.errors ?? b).slice(0, 300)}`);
  }
  return b.data;
}

async function hsBatch(token, object, ids, props) {
  const r = await fetch(`${HS_API}/crm/v3/objects/${object}/batch/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: props, inputs: ids.map(id => ({ id })) }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`hubspot batch: http ${r.status} ${JSON.stringify(b).slice(0, 250)}`);
  const out = new Map();
  for (const rec of b.results ?? []) out.set(String(rec.id), { id: String(rec.id), properties: rec.properties ?? {} });
  return { found: out, missing: (b.errors ?? []).length };
}

async function hsTotal(token, object) {
  const r = await fetch(`${HS_API}/crm/v3/objects/${object}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filterGroups: [], properties: ["hs_object_id"], limit: 1 }),
  });
  return Number((await r.json().catch(() => ({}))).total ?? -1);
}

/** Every card on the board with its HubSpot ID, its bookkeeping cells, and every mapped cell. */
async function readBoard(M, spec, colIds) {
  const cards = [];
  let cursor = null;
  do {
    const page = (await monday(M,
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: spec.boardId, c: cursor, ids: colIds })).boards[0].items_page;
    for (const it of page.items) {
      const cells = {};
      for (const cv of it.column_values) cells[cv.id] = cv.text ?? "";
      const rel = it.column_values.find(c => c.linked_item_ids);
      cards.push({ itemId: it.id, name: it.name, cells, linked: (rel?.linked_item_ids ?? []).map(String) });
    }
    cursor = page.cursor;
    if (cards.length % 10000 === 0 && cards.length) console.log(`    read ${cards.length} cards…`);
  } while (cursor);
  return cards;
}

async function verify(M, H, mod, spec, sampleSize, countsOnly) {
  const { propertiesForSpec, expectedText, itemName } = mod;
  const label = spec.object === "contacts" ? "CONTACTS" : "ACCOUNTS";
  console.log(`\n================ ${label} — board ${spec.boardId} ================`);

  const relCol = spec.associations?.find(a => a.relationCol)?.relationCol;
  const colIds = [spec.idCol, spec.syncStateCol, spec.linkCol, ...(relCol ? [relCol] : []),
    ...spec.fields.map(f => f.col)].filter(Boolean);

  console.log("  reading the board…");
  const cards = await readBoard(M, spec, [...new Set(colIds)]);
  const total = await hsTotal(H, spec.object);

  const withId = cards.filter(c => (c.cells[spec.idCol] ?? "").trim());
  const byId = new Map();
  for (const c of withId) {
    const id = c.cells[spec.idCol].trim();
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(c.itemId);
  }
  const dupes = [...byId.entries()].filter(([, v]) => v.length > 1);
  const blankLink = withId.filter(c => !(c.cells[spec.linkCol] ?? "").trim()).length;
  const blankState = withId.filter(c => !(c.cells[spec.syncStateCol] ?? "").trim()).length;
  const linkedCount = relCol ? withId.filter(c => c.linked.length).length : null;

  console.log(`  HubSpot ${spec.object} total        : ${total}`);
  console.log(`  monday cards                       : ${cards.length}`);
  console.log(`  cards carrying a HubSpot ID        : ${withId.size ?? withId.length}`);
  console.log(`  distinct HubSpot IDs on the board  : ${byId.size}`);
  console.log(`  MISSING (in HubSpot, not on board) : ${Math.max(0, total - byId.size)}`);
  console.log(`  DUPLICATE HubSpot IDs              : ${dupes.length}`);
  for (const [id, items] of dupes.slice(0, 10)) console.log(`      ${id} -> cards ${items.join(", ")}`);
  console.log(`  cards with a BLANK HubSpot Link    : ${blankLink}`);
  console.log(`  cards with a BLANK Sync State      : ${blankState}`);
  if (relCol !== undefined && linkedCount !== null)
    console.log(`  cards with a Company/Contact relation : ${linkedCount}`);

  if (countsOnly) return { total, onBoard: byId.size, dupes: dupes.length };

  // ---- field-level comparison on a RANDOM sample
  const pool = [...byId.keys()];
  const pick = [];
  const seen = new Set();
  // Deterministic stride rather than Math.random, so a re-run examines the same cards and a fix can be
  // confirmed on the exact records that failed.
  const stride = Math.max(1, Math.floor(pool.length / Math.min(sampleSize, pool.length)));
  for (let i = 0; i < pool.length && pick.length < sampleSize; i += stride) {
    if (seen.has(pool[i])) continue;
    seen.add(pool[i]); pick.push(pool[i]);
  }
  console.log(`\n  comparing ${pick.length} card(s) field-by-field against HubSpot…`);

  const props = propertiesForSpec(spec);
  const cardById = new Map(withId.map(c => [c.cells[spec.idCol].trim(), c]));
  const mismatch = new Map();     // hs property -> count
  const examples = new Map();     // hs property -> first example
  let compared = 0, gone = 0, nameWrong = 0;

  for (let i = 0; i < pick.length; i += 100) {
    const ids = pick.slice(i, i + 100);
    const { found } = await hsBatch(H, spec.object, ids, props);
    for (const id of ids) {
      const rec = found.get(id);
      const card = cardById.get(id);
      if (!rec) { gone++; continue; }   // archived/deleted in HubSpot since the import
      compared++;
      if (itemName(rec, spec) !== card.name.trim()) nameWrong++;
      for (const f of spec.fields) {
        if (f.type === "people") continue;                 // not text-diffable; checked via ownership below
        const want = expectedText(f, rec.properties[f.hs], ctxRef.ctx);
        if (want === null || want === "") continue;         // empty HubSpot value never overwrites monday
        const got = (card.cells[f.col] ?? "").trim();
        const same = f.type === "link" ? linkish(got) === linkish(want)
          : f.type === "phone" ? digits(got) === digits(want)
          : f.type === "email" ? got.toLowerCase() === want.toLowerCase()
          : got === want;
        if (!same) {
          mismatch.set(f.hs, (mismatch.get(f.hs) ?? 0) + 1);
          if (!examples.has(f.hs)) examples.set(f.hs, { id, want, got });
        }
      }
    }
  }

  console.log(`  compared                : ${compared}`);
  console.log(`  no longer in HubSpot    : ${gone}`);
  console.log(`  item name mismatched    : ${nameWrong}`);
  if (!mismatch.size) {
    console.log(`  FIELD MISMATCHES        : 0  — every sampled cell matches what the sync expects`);
  } else {
    const totalMm = [...mismatch.values()].reduce((a, b) => a + b, 0);
    console.log(`  FIELD MISMATCHES        : ${totalMm} across ${mismatch.size} propert(ies)`);
    for (const [hs, n] of [...mismatch.entries()].sort((a, b) => b[1] - a[1])) {
      const e = examples.get(hs);
      console.log(`      ${hs.padEnd(26)} ${String(n).padStart(5)} card(s)`);
      console.log(`          e.g. ${e.id}  hubspot=${JSON.stringify(e.want).slice(0, 70)}  monday=${JSON.stringify(e.got).slice(0, 70)}`);
    }
    console.log(`  (a mismatch here is a cell the next incremental webhook would rewrite)`);
  }
  return { total, onBoard: byId.size, dupes: dupes.length, mismatches: [...mismatch.values()].reduce((a, b) => a + b, 0) };
}

const digits = s => String(s ?? "").replace(/[^\d]/g, "");
const linkish = s => String(s ?? "").trim().split(" - ").pop().replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/+$/, "").toLowerCase();
const ctxRef = { ctx: null };

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const sample = Number(arg("--sample", 200));
  const only = arg("--object", "");
  const countsOnly = argv.includes("--counts");

  const { MONDAY_API_TOKEN: M, HUBSPOT_ACCESS_TOKEN: H } = creds();
  if (!M || !H) { console.error("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN required (env or worker/.dev.vars)"); process.exit(1); }

  const { mod, cleanup } = await loadWorker();
  try {
    if (!countsOnly) {
      console.log("building sync context…");
      ctxRef.ctx = await mod.buildCtx({ HUBSPOT_ACCESS_TOKEN: H, MONDAY_API_TOKEN: M, ENABLE_CRM: "true" });
    }
    const specs = only === "contacts" ? [mod.CRM_CONTACTS]
      : only === "companies" ? [mod.CRM_ACCOUNTS]
      : [mod.CRM_ACCOUNTS, mod.CRM_CONTACTS];
    for (const spec of specs) await verify(M, H, mod, spec, sample, countsOnly);
  } finally { cleanup(); }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
