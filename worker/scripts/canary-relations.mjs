/**
 * THE RELATIONS CANARY — a small, deliberately stratified live run, verified card by card.
 *
 * This code has shipped defects in four successive rounds, three of which could delete a relation.
 * Every one was found by something other than reading the code: a measurement, an adversarial
 * reviewer, or a dry run. So the last gate before 94,334 cards is not more reading — it is a hundred
 * real writes whose before-and-after state is checked byte for byte.
 *
 * IT DOES NOT CONTAIN A COPY OF THE WRITE PATH, and that is the point. Selection and verification
 * live here; the writing is done by backfill-crm.mjs --only, the exact script the full run uses. A
 * canary that exercises a reimplementation proves nothing about the thing that will run.
 *
 * WHAT IT DELIBERATELY COVERS. A random hundred would be ~89% "already correct" and would exercise
 * almost nothing, so the sample is stratified across the cases that can actually go wrong:
 *
 *   add-only        no links yet, HubSpot asserts one company      -> the ordinary case
 *   already-correct links already match                            -> must produce NO write at all
 *   multi-company   HubSpot asserts two or more companies          -> set arithmetic
 *   UNASSERTED      holds a link HubSpot does NOT assert           -> THE ONE THAT MATTERS
 *   capped          its company's card is at the link ceiling      -> must be skipped, never written
 *
 * The unasserted group is the whole reason the pass was rewritten to be additive-only: 858 contacts
 * hold exactly one such link, so under the old full-replacement logic every one of them would have
 * been left with no company at all. If a single one of those links is missing afterwards, the
 * migration is wrong and the full run must not happen.
 *
 *   node scripts/canary-relations.mjs --select            # pick the sample, snapshot the cells
 *   node scripts/backfill-crm.mjs --object relations --apply --only <ids from the file>
 *   node scripts/canary-relations.mjs --verify            # re-read and assert
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const ACCOUNTS_BOARD = "5028000496";
const ACCOUNTS_ID_COL = "text_mm6tsnwx";
const ACCOUNTS_REL_COL = "account_contact";
const CONTACTS_BOARD = "5028000495";
const CONTACTS_ID_COL = "text_mm6t71dj";
const CONTACTS_REL_COL = "contact_account";
const CEILING = 740;
const STATE = join(ROOT, "scripts", ".canary-relations.json");
const PER_GROUP = 20;

const mode = process.argv.includes("--verify") ? "verify" : "select";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function monday(query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.data) {
    if (attempt < 6) { await sleep(2000 * 2 ** attempt); return monday(query, variables, attempt + 1); }
    throw new Error(`monday: ${JSON.stringify(b.errors ?? b).slice(0, 250)}`);
  }
  return b.data;
}
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

/** Every Contacts card's relation cell, by item id. The same read the verify pass uses, so a
 *  before/after comparison is like for like. */
async function readContactCells(onlyIds) {
  const out = new Map();
  let cursor = null, seen = 0;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: CONTACTS_BOARD, c: cursor, ids: [CONTACTS_ID_COL, CONTACTS_REL_COL] })).boards[0].items_page;
    for (const it of page.items) {
      seen++;
      if (onlyIds && !onlyIds.has(String(it.id))) continue;
      out.set(String(it.id), {
        name: it.name,
        hsId: (it.column_values.find(c => c.id === CONTACTS_ID_COL)?.text ?? "").trim(),
        linked: (it.column_values.find(c => c.id === CONTACTS_REL_COL)?.linked_item_ids ?? []).map(String),
      });
    }
    cursor = page.cursor;
    if (seen % 20000 === 0) console.log(`  ${seen}…`);
  } while (cursor);
  return out;
}

// ==================================================================== VERIFY
if (mode === "verify") {
  if (!existsSync(STATE)) { console.error(`no ${STATE} — run --select first`); process.exit(1); }
  const snap = JSON.parse(readFileSync(STATE, "utf8"));
  const ids = new Set(snap.selected.map(s => s.itemId));
  console.log(`=== VERIFY ${snap.selected.length} canary contacts (selected ${snap.selectedAt}) ===`);
  console.log("re-reading the Contacts board…");
  const after = await readContactCells(ids);

  let lost = 0, gained = 0, unchanged = 0, missingCard = 0;
  const problems = [];
  for (const s of snap.selected) {
    const now = after.get(s.itemId);
    if (!now) { missingCard++; problems.push({ ...s, problem: "card not found after the run" }); continue; }
    const before = new Set(s.before);
    const nowSet = new Set(now.linked);
    const removed = s.before.filter(x => !nowSet.has(x));
    const added = now.linked.filter(x => !before.has(x));
    if (removed.length) {
      lost += removed.length;
      problems.push({ ...s, problem: `LOST ${removed.length} link(s): ${removed.join(", ")}`, nowLinked: now.linked });
    }
    if (added.length) gained += added.length;
    if (!removed.length && !added.length) unchanged++;
  }

  console.log(`\n--- RESULT ---`);
  console.log(`  contacts checked                 ${snap.selected.length}`);
  console.log(`  links GAINED                     ${gained}`);
  console.log(`  links LOST                       ${lost}   <- must be 0`);
  console.log(`  unchanged                        ${unchanged}`);
  console.log(`  cards not found                  ${missingCard}`);

  // Per-group, because a zero overall could hide a group that was never exercised.
  const byGroup = {};
  for (const s of snap.selected) {
    const now = after.get(s.itemId);
    const nowSet = new Set(now?.linked ?? []);
    const removed = s.before.filter(x => !nowSet.has(x));
    const added = (now?.linked ?? []).filter(x => !new Set(s.before).has(x));
    byGroup[s.group] ??= { n: 0, gained: 0, lost: 0, unchanged: 0 };
    byGroup[s.group].n++;
    byGroup[s.group].gained += added.length;
    byGroup[s.group].lost += removed.length;
    if (!added.length && !removed.length) byGroup[s.group].unchanged++;
  }
  console.log(`\n--- BY GROUP ---`);
  for (const [g, x] of Object.entries(byGroup))
    console.log(`  ${g.padEnd(16)} n=${String(x.n).padStart(3)}  gained=${String(x.gained).padStart(3)}`
      + `  lost=${String(x.lost).padStart(3)}  unchanged=${String(x.unchanged).padStart(3)}`);

  // THE ASSERTIONS. Each names the specific defect it would catch.
  console.log(`\n--- ASSERTIONS ---`);
  const check = (label, ok, detail = "") =>
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  — ${detail}` : ""}`);

  check("no link was removed from any card (R2b / R3c: full-replacement deletion)", lost === 0,
    lost ? `${lost} lost` : "");
  const unasserted = snap.selected.filter(s => s.group === "unasserted");
  const unassertedKept = unasserted.every(s => {
    const nowSet = new Set(after.get(s.itemId)?.linked ?? []);
    return s.unassertedLinks.every(x => nowSet.has(x));
  });
  check(`all ${unasserted.length} unasserted links survived (the additive-only guarantee)`, unassertedKept);
  const correct = snap.selected.filter(s => s.group === "already-correct");
  const correctUntouched = correct.every(s => {
    const now = after.get(s.itemId)?.linked ?? [];
    return now.length === s.before.length && s.before.every(x => now.includes(x));
  });
  check(`all ${correct.length} already-correct cards were left completely alone`, correctUntouched);
  const capped = snap.selected.filter(s => s.group === "capped");
  const cappedUnchanged = capped.every(s => {
    const nowSet = new Set(after.get(s.itemId)?.linked ?? []);
    return !s.cappedCardIds.some(x => nowSet.has(x));
  });
  check(`none of the ${capped.length} capped contacts was linked to a full account`, cappedUnchanged);
  const addOnly = snap.selected.filter(s => s.group === "add-only");
  const addOnlyGained = addOnly.filter(s => (after.get(s.itemId)?.linked ?? []).length > s.before.length).length;
  check(`add-only group actually gained links (the pass did real work)`, addOnlyGained > 0,
    `${addOnlyGained}/${addOnly.length} gained`);

  if (problems.length) {
    console.log(`\n--- PROBLEMS (${problems.length}) ---`);
    for (const p of problems.slice(0, 40))
      console.log(`  contact ${p.itemId} [${p.group}] ${JSON.stringify(p.name).slice(0, 32)}: ${p.problem}`
        + `\n      before: ${JSON.stringify(p.before)}\n      after : ${JSON.stringify(p.nowLinked ?? [])}`);
  }
  const verdict = lost === 0 && unassertedKept && correctUntouched && cappedUnchanged && addOnlyGained > 0;
  console.log(`\n  ${verdict ? "CANARY CLEAN — the full run is justified." : "CANARY FAILED — do not run the full pass."}`);
  writeFileSync(join(ROOT, "scripts", ".canary-relations-verify.json"),
    JSON.stringify({ gained, lost, unchanged, byGroup, problems, verdict }, null, 2), "utf8");
  process.exit(verdict ? 0 : 1);
}

// ==================================================================== SELECT
console.log("=== SELECT a stratified canary sample ===");

console.log("indexing the Accounts board…");
const accounts = new Map();        // hsId -> [itemId]
const cellSize = new Map();        // itemId -> links held
{
  let cursor = null;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: ACCOUNTS_BOARD, c: cursor, ids: [ACCOUNTS_ID_COL, ACCOUNTS_REL_COL] })).boards[0].items_page;
    for (const it of page.items) {
      cellSize.set(String(it.id),
        (it.column_values.find(c => c.id === ACCOUNTS_REL_COL)?.linked_item_ids ?? []).length);
      const hsId = (it.column_values.find(c => c.id === ACCOUNTS_ID_COL)?.text ?? "").trim();
      if (!hsId) continue;
      if (!accounts.has(hsId)) accounts.set(hsId, []);
      accounts.get(hsId).push(String(it.id));
    }
    cursor = page.cursor;
  } while (cursor);
}
console.log(`  ${cellSize.size} cards, ${accounts.size} distinct HubSpot ids`);

console.log("reading the Contacts board…");
const cells = await readContactCells(null);
console.log(`  ${cells.size} contact cards`);

/**
 * Classify by walking contacts in board order and stopping as soon as every group is full. The
 * capped and unasserted groups are rare, so the walk keeps going for them after the common groups
 * fill — otherwise the sample would be all add-only and prove the least.
 */
const groups = { "add-only": [], "already-correct": [], "multi-company": [], unasserted: [], capped: [] };
const byHsId = new Map();
for (const [itemId, c] of cells) if (c.hsId) byHsId.set(c.hsId, { itemId, ...c });
const allHs = [...byHsId.keys()];
console.log(`  classifying against HubSpot associations…`);

const full = id => (cellSize.get(id) ?? 0) >= CEILING;
let scanned = 0;
for (let i = 0; i < allHs.length; i += 100) {
  const chunk = allHs.slice(i, i + 100);
  const r = await hs("/crm/v4/associations/contacts/companies/batch/read", { inputs: chunk.map(id => ({ id })) });
  for (const row of r.body.results ?? []) {
    const card = byHsId.get(String(row.from?.id ?? ""));
    if (!card) continue;
    scanned++;
    const companyIds = (row.to ?? []).map(t => String(t.toObjectId)).filter(x => /^\d+$/.test(x));
    if (!companyIds.length) continue;

    const resolved = companyIds.map(cid => ({ cid, cards: accounts.get(cid) ?? [] }));
    const linkedSet = new Set(card.linked);
    // Which of its current links does HubSpot NOT account for?
    const backed = new Set();
    for (const { cards: cds } of resolved) for (const x of cds) if (linkedSet.has(x)) backed.add(x);
    const unassertedLinks = card.linked.filter(x => !backed.has(x));
    const cappedCardIds = resolved.filter(x => x.cards.length && x.cards.every(full)).flatMap(x => x.cards);
    const wouldAdd = resolved
      .filter(x => x.cards.length && !x.cards.some(y => linkedSet.has(y)) && !x.cards.every(full))
      .map(x => x.cards.find(y => !full(y)) ?? x.cards[0]);

    const base = {
      itemId: card.itemId, name: card.name, hsId: card.hsId,
      before: card.linked, companyIds, unassertedLinks, cappedCardIds, expectAdd: wouldAdd,
    };
    // Priority order: the rare, high-value groups win when a contact qualifies for several.
    if (unassertedLinks.length && groups.unasserted.length < PER_GROUP)
      groups.unasserted.push({ ...base, group: "unasserted" });
    else if (cappedCardIds.length && groups.capped.length < PER_GROUP)
      groups.capped.push({ ...base, group: "capped" });
    else if (companyIds.length > 1 && wouldAdd.length && groups["multi-company"].length < PER_GROUP)
      groups["multi-company"].push({ ...base, group: "multi-company" });
    else if (!card.linked.length && wouldAdd.length && groups["add-only"].length < PER_GROUP)
      groups["add-only"].push({ ...base, group: "add-only" });
    else if (!wouldAdd.length && card.linked.length && !unassertedLinks.length
             && groups["already-correct"].length < PER_GROUP)
      groups["already-correct"].push({ ...base, group: "already-correct" });
  }
  if (Object.values(groups).every(g => g.length >= PER_GROUP)) break;
  if ((i / 100) % 20 === 0)
    console.log(`  ${scanned} scanned — ` + Object.entries(groups).map(([k, g]) => `${k}:${g.length}`).join(" "));
}

const selected = Object.values(groups).flat();
console.log(`\n--- SAMPLE ---`);
for (const [k, g] of Object.entries(groups)) console.log(`  ${k.padEnd(16)} ${g.length}`);
console.log(`  TOTAL            ${selected.length}`);
for (const [k, g] of Object.entries(groups)) {
  if (!g.length) continue;
  const s = g[0];
  console.log(`\n  e.g. ${k}: contact ${s.itemId} ${JSON.stringify(s.name).slice(0, 30)}`);
  console.log(`      before=${JSON.stringify(s.before)} companies=${s.companyIds.length}`
    + ` expectAdd=${JSON.stringify(s.expectAdd)} unasserted=${JSON.stringify(s.unassertedLinks)}`);
}
if (!groups.unasserted.length)
  console.log(`\n  WARNING: no unasserted-link contacts found — the group that matters most is EMPTY.`);

writeFileSync(STATE, JSON.stringify({
  selectedAt: new Date().toISOString(), ceiling: CEILING, selected,
}, null, 2), "utf8");
console.log(`\nsnapshot written to ${STATE}`);
console.log(`\nNow run the REAL pass against only these cards:\n`);
console.log(`  node scripts/backfill-crm.mjs --object relations --apply --only ${selected.map(s => s.itemId).join(",")}`);
console.log(`\nthen: node scripts/canary-relations.mjs --verify`);
