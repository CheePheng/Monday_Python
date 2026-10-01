/**
 * READ-ONLY. How many cards on the LIVE WM boards does the ownership guard actually change?
 *
 * wm-guard-preflight.mjs established that 4,179 HubSpot records already carry sync_owner=crm. That is
 * the HubSpot-side count. It is NOT the blast radius: the guard only changes what a REP EXPERIENCES
 * where a crm-stamped record also has a card on a Work Management board, because that is the only
 * place a human can make an edit that the guard would newly refuse.
 *
 * So this walks the two WM follow-up boards, reads the HubSpot ID column off every card, and asks
 * HubSpot for each record's sync_owner in batches. The answer is the number of cards whose reverse
 * sync goes silent the moment the guard deploys.
 *
 * Reads only. Writes nothing to either system. Prints no secrets.
 *
 *   node scripts/wm-guard-impact.mjs
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

/** Page the whole board. items_page is the only read that does not silently cap the way items(ids:) does. */
async function allCards(boardId, idCol) {
  const out = [];
  let cursor = null;
  do {
    const q = cursor
      ? `query($c:String!){ next_items_page(limit:500, cursor:$c){ cursor items{ id name column_values(ids:["${idCol}"]){ text } } } }`
      : `query($b:ID!){ boards(ids:[$b]){ items_page(limit:500){ cursor items{ id name column_values(ids:["${idCol}"]){ text } } } } }`;
    const d = await monday(q, cursor ? { c: cursor } : { b: boardId });
    const page = cursor ? d.next_items_page : d.boards[0].items_page;
    for (const it of page.items) {
      const hsId = (it.column_values?.[0]?.text ?? "").trim();
      out.push({ mondayId: it.id, name: it.name, hsId });
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** Batch-read sync_owner. 100 per call is the documented batch ceiling. */
async function syncOwners(object, ids) {
  const owners = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${object}/batch/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: ["sync_owner"], inputs: chunk.map(id => ({ id })) }),
    });
    const j = await r.json().catch(() => ({}));
    for (const rec of j.results ?? []) owners.set(String(rec.id), rec.properties?.sync_owner ?? "");
    // Records HubSpot could not return (deleted/merged) simply stay absent; reported separately.
    await sleep(120);
  }
  return owners;
}

const BOARDS = [
  { object: "companies", boardId: "5029639440", idCol: "numeric_mm4xkk3a", label: "Company Follow Up" },
  { object: "contacts",  boardId: "5029639630", idCol: "numeric_mm4xw7rk", label: "Contact Follow Up" },
];

console.log("WM GUARD IMPACT ON LIVE WM BOARDS  (read-only)\n");

let totalSilenced = 0;
for (const b of BOARDS) {
  const cards = await allCards(b.boardId, b.idCol);
  const withId = cards.filter(c => /^\d+$/.test(c.hsId));
  const owners = await syncOwners(b.object, withId.map(c => c.hsId));

  const tally = { crm: 0, hold: 0, wm: 0, blank: 0, missing: 0 };
  for (const c of withId) {
    if (!owners.has(c.hsId)) { tally.missing++; continue; }
    const o = owners.get(c.hsId);
    if (o === "crm") tally.crm++;
    else if (o === "hold") tally.hold++;
    else if (o === "wm") tally.wm++;
    else tally.blank++;
  }

  const silenced = tally.crm + tally.hold;
  totalSilenced += silenced;

  console.log(`${b.label} (board ${b.boardId}, ${b.object})`);
  console.log(`  cards: ${cards.length}   with a HubSpot id: ${withId.length}   id-less: ${cards.length - withId.length}`);
  console.log(`  sync_owner  crm=${tally.crm}  hold=${tally.hold}  wm=${tally.wm}  unstamped=${tally.blank}  not-found-in-hubspot=${tally.missing}`);
  console.log(`  -> cards whose reverse sync GOES SILENT on deploy: ${silenced}`);
  console.log("");
}

console.log(`TOTAL WM cards affected by the guard today: ${totalSilenced}`);
console.log("");
console.log("If this is 0, the guard is invisible to reps now and only becomes load-bearing at the");
console.log("cutover -- deploy is safe to observe early. If it is not 0, that many cards stop");
console.log("reverse-syncing the moment it lands, and that has to be a deliberate, announced switch.");
