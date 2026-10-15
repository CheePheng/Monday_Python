/**
 * READ-ONLY. Do the records the guard silences on WM have somewhere else for a rep to work them?
 *
 * wm-guard-impact.mjs found 3,970 WM cards whose reverse sync stops when the ownership guard deploys.
 * That is only acceptable if those records are already present on the CRM boards, because the plan is
 * "reps work these on the CRM boards now". If a claimed record has NO CRM card, the guard does not
 * move the work -- it strands it: the WM card still shows, still accepts typing, and silently reverts
 * on the next forward sync, with no other board to do the job.
 *
 * So this intersects, per object, the crm-stamped HubSpot ids against the CRM board's HubSpot ID
 * column. The number that matters is the STRANDED count.
 *
 * Reads only. Writes nothing. Prints no secrets.
 *
 *   node scripts/wm-guard-landing.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
try {
  for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* fall back to env */ }
const M = v.MONDAY_API_TOKEN ?? process.env.MONDAY_API_TOKEN;
const H = v.HUBSPOT_ACCESS_TOKEN ?? process.env.HUBSPOT_ACCESS_TOKEN;
if (!M || !H) { console.error("missing monday or HubSpot token"); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function monday(query, variables = {}, attempt = 0) {
  try {
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: M, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.data) throw new Error(JSON.stringify(j).slice(0, 200));
    return j.data;
  } catch (e) {
    if (attempt >= 5) throw e;
    await sleep(1500 * (attempt + 1));
    return monday(query, variables, attempt + 1);
  }
}

async function boardIds(boardId, idCol) {
  const ids = new Set();
  let cursor = null;
  do {
    const q = cursor
      ? `query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor items{ column_values(ids:["${idCol}"]){ text } } } }`
      : `query($b:ID!){ boards(ids:[$b]){ items_page(limit:500){ cursor items{ column_values(ids:["${idCol}"]){ text } } } } }`;
    const d = await monday(q, cursor ? { c: cursor } : { b: boardId });
    const page = cursor ? d.next_items_page : d.boards[0].items_page;
    for (const it of page.items) {
      const t = (it.column_values?.[0]?.text ?? "").trim();
      if (/^\d+$/.test(t)) ids.add(t);
    }
    cursor = page.cursor;
  } while (cursor);
  return ids;
}

/**
 * Every crm-stamped id for an object.
 *
 * Uses the LIST endpoint, not search: search's RESULT SET silently caps at 10,000, and this project
 * has already produced one catastrophic report from that cap. Counts here are well under it, but the
 * list endpoint has no cap at all, so there is no reason to take the risk.
 */
async function crmStampedIds(object) {
  const out = [];
  let after = null;
  do {
    const u = new URL(`https://api.hubapi.com/crm/v3/objects/${object}`);
    u.searchParams.set("limit", "100");
    u.searchParams.set("properties", "sync_owner");
    if (after) u.searchParams.set("after", after);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${H}` } });
    const j = await r.json().catch(() => ({}));
    for (const rec of j.results ?? []) {
      if ((rec.properties?.sync_owner ?? "") === "crm") out.push(String(rec.id));
    }
    after = j.paging?.next?.after ?? null;
    await sleep(90);
  } while (after);
  return out;
}

const PAIRS = [
  { object: "companies", crmBoard: "5028000496", crmIdCol: "text_mm6tsnwx", label: "Accounts" },
  { object: "contacts",  crmBoard: "5028000495", crmIdCol: "text_mm6t71dj", label: "Contacts" },
];

console.log("WHERE DO THE SILENCED RECORDS LAND?  (read-only)\n");

for (const p of PAIRS) {
  const [stamped, onCrm] = await Promise.all([
    crmStampedIds(p.object),
    boardIds(p.crmBoard, p.crmIdCol),
  ]);
  const stranded = stamped.filter(id => !onCrm.has(id));
  console.log(`${p.object}`);
  console.log(`  crm-stamped in HubSpot:        ${stamped.length}`);
  console.log(`  cards on CRM ${p.label} board:  ${onCrm.size}`);
  console.log(`  stamped WITH a CRM card:       ${stamped.length - stranded.length}`);
  console.log(`  STRANDED (no CRM card):        ${stranded.length}`);
  if (stranded.length) console.log(`  sample stranded ids:           ${stranded.slice(0, 8).join(", ")}`);
  console.log("");
}

console.log("STRANDED = the guard stops the WM card writing back, and there is no CRM card to work");
console.log("instead. Those are the records where the deploy removes an ability without replacing it.");
