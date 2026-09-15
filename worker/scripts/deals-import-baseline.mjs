/**
 * Snapshot the boards the Deals historical import must and must not touch. READ-ONLY.
 *
 * Run BEFORE the import and again AFTER it, then diff. Two of the required end-of-import checks are
 * "old WM Deals board unchanged" and "board 5028000491 unchanged", and neither can be answered after
 * the fact — an unchanged board looks exactly like a board that was changed and changed back unless
 * you wrote the number down first.
 *
 * It also records the HubSpot ids already present on the CRM Deals and Line Items boards. Those are
 * the 40-deal canary and its line items, which the import must SKIP rather than duplicate; comparing
 * the id sets afterwards proves the skip happened instead of assuming it.
 *
 *   node scripts/deals-import-baseline.mjs                       # writes scripts/.deals-baseline.json
 *   node scripts/deals-import-baseline.mjs --out scripts/.after.json
 *   node scripts/deals-import-baseline.mjs --compare scripts/.deals-baseline.json --out scripts/.after.json
 *
 * Output defaults under scripts/ as a dotfile, which worker/.gitignore's `scripts/.*` already covers.
 * That rule exists because a committed resume cursor or snapshot can resurrect stale state on another
 * checkout; a snapshot of board counts is exactly that kind of artifact.
 */
import fs from "node:fs";

const API = "https://api.monday.com/v2";

/** Every board this operation can plausibly touch, and what it is to us. */
const BOARDS = [
  // idCol values taken from CRM_DEALS / CRM_LINE_ITEMS in src/config/crm.ts — the same dedup key the
  // import itself uses, so "already present" here means exactly what it means to the importer.
  { id: "5028000494", role: "CRM Deals — the import target",         idCol: "text_mm76kxz4" },
  { id: "5028000489", role: "CRM Line Items — the import target",    idCol: "text_mm76qwtw" },
  { id: "5028000495", role: "CRM Contacts — paired relation side",   idCol: null },
  { id: "5028000496", role: "CRM Accounts — paired relation side",   idCol: null },
  { id: "5028000491", role: "MUST NOT CHANGE — 31010017's target",   idCol: null },
  { id: "5029480547", role: "MUST NOT CHANGE — live WM Deals board", idCol: null },
];

function token() {
  if (process.env.MONDAY_API_TOKEN) return process.env.MONDAY_API_TOKEN;
  try {
    const line = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split(/\r?\n/).find(l => l.startsWith("MONDAY_API_TOKEN="));
    if (line) return line.slice("MONDAY_API_TOKEN=".length).trim().replace(/^"|"$/g, "");
  } catch { /* fall through */ }
  return "";
}

async function gql(tok, query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: tok, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** All HubSpot ids held in `idCol` on a board. Paged, because the point is an exact set. */
async function hubspotIds(tok, boardId, idCol) {
  const ids = [];
  let cursor = null;
  for (;;) {
    const q = cursor
      ? `query ($c: String!) { next_items_page(cursor: $c, limit: 500) { cursor items { id column_values(ids: ["${idCol}"]) { text } } } }`
      : `query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 500) { cursor items { id column_values(ids: ["${idCol}"]) { text } } } } }`;
    const d = await gql(tok, q, cursor ? { c: cursor } : { b: [boardId] });
    const page = cursor ? d.next_items_page : d.boards[0].items_page;
    for (const it of page.items) {
      const t = (it.column_values?.[0]?.text ?? "").trim();
      if (t) ids.push(t);
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  return ids;
}

async function main() {
  const tok = token();
  if (!tok) { console.error("MONDAY_API_TOKEN is required (env or worker/.dev.vars)"); process.exit(1); }
  const outPath = arg("--out") ?? "scripts/.deals-baseline.json";
  const comparePath = arg("--compare");

  const d = await gql(tok, `query ($b: [ID!]) { boards(ids: $b) { id name items_count } }`,
    { b: BOARDS.map(b => b.id) });
  const live = new Map(d.boards.map(b => [String(b.id), b]));

  const snap = { boards: {} };
  for (const b of BOARDS) {
    const board = live.get(b.id);
    if (!board) { console.log(`  MISSING BOARD ${b.id}`); continue; }
    const rec = { name: board.name, role: b.role, items: board.items_count };
    if (b.idCol) {
      const ids = await hubspotIds(tok, b.id, b.idCol);
      rec.hubspotIds = ids;
      rec.withHubspotId = ids.length;
    }
    snap.boards[b.id] = rec;
    console.log(`  ${b.id}  ${String(board.items_count).padStart(7)} items  ${board.name}`);
    console.log(`            ${b.role}${rec.withHubspotId != null ? `  (${rec.withHubspotId} carry a HubSpot id)` : ""}`);
  }

  fs.writeFileSync(outPath, JSON.stringify(snap, null, 2));
  console.log(`\nwritten to ${outPath}`);

  if (!comparePath) return;
  const before = JSON.parse(fs.readFileSync(comparePath, "utf8"));
  console.log(`\n=== diff vs ${comparePath} ===`);
  let bad = 0;
  for (const b of BOARDS) {
    const was = before.boards[b.id], now = snap.boards[b.id];
    if (!was || !now) continue;
    const delta = now.items - was.items;
    const mustNotChange = b.role.startsWith("MUST NOT CHANGE");
    const flag = mustNotChange && delta !== 0 ? "VIOLATION" : delta === 0 ? "unchanged" : `+${delta}`;
    if (mustNotChange && delta !== 0) bad++;
    console.log(`  ${b.id}  ${was.items} -> ${now.items}  ${flag}   ${was.name}`);
    if (was.hubspotIds && now.hubspotIds) {
      const wasSet = new Set(was.hubspotIds);
      const kept = was.hubspotIds.filter(x => now.hubspotIds.includes(x)).length;
      const added = now.hubspotIds.filter(x => !wasSet.has(x)).length;
      const dupes = now.hubspotIds.length - new Set(now.hubspotIds).size;
      console.log(`            pre-existing ids kept ${kept}/${was.hubspotIds.length}, new ${added}, DUPLICATE ids ${dupes}`);
      if (kept !== was.hubspotIds.length || dupes) bad++;
    }
  }
  if (bad) { console.log(`\n${bad} problem(s).`); process.exit(1); }
  console.log("\nNo board that had to stay unchanged changed, and no duplicate HubSpot id.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("deals-import-baseline.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
