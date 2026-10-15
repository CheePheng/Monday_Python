/**
 * THE DEALS CANARY — a small, deliberately stratified live run, verified deal by deal.
 *
 * Same shape as the relations canary that earned its cost on Contacts: selection and verification
 * live here, the WRITING is done by backfill-crm.mjs --only-hs, which is the exact code the historical
 * import will use. A canary that exercises a reimplementation proves nothing about the thing that runs.
 *
 * WON-STAGE DEALS ARE DELIBERATELY EXCLUDED, and this is a safety decision rather than a sampling one.
 * Three automations on the Deals board are still live:
 *   31010010  deal_stage -> Won  notifies EVERY board subscriber
 *   31010017  deal_stage -> Won  creates an item in board 5028000491 (not ours, not in scope)
 *   31010016  item created       sets deal_stage = New
 * 3,640 of 8,655 deals are Closed Won, so a naive "representative" sample would almost certainly fire
 * the first two. Won-stage behaviour is covered by the historical import AFTER those are disabled —
 * which is the only moment it is safe to exercise.
 *
 * 31010016 fires regardless and will clobber deal_stage on every card we create. That is the
 * automation working as designed, and it means the canary CANNOT validate the coarse deal_stage
 * column while it is live. It can validate everything else, including `HubSpot Stage`, which
 * 31010016 does not touch — and the verify step asserts exactly that split rather than glossing it.
 *
 *   node scripts/canary-deals.mjs --select
 *   node scripts/backfill-crm.mjs --object deals --apply --only-hs <ids from the file>
 *   node scripts/canary-deals.mjs --verify
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
const DEALS_BOARD = "5028000494";
const WM_DEALS_BOARD = "5029480547";          // must never be written by any of this
const ID_COL = "text_mm76kxz4";
const STAGE_COL = "dropdown_mm7624zd";
const PIPE_COL = "dropdown_mm76s7kk";
const PROB_COL = "deal_close_probability";
const REL_CONTACTS = "deal_contact";
const REL_ACCOUNTS = "board_relation_mm76wp4e";
const REL_LINE_ITEMS = "board_relation_mm76btmt";
const STATE = join(ROOT, "scripts", ".canary-deals.json");
const PER_GROUP = 8;
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
    if (attempt < 5) { await sleep(1500 * 2 ** attempt); return monday(query, variables, attempt + 1); }
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
  if ((r.status === 429 || r.status >= 500) && attempt < 5) {
    await sleep(1500 * 2 ** attempt); return hs(path, body, attempt + 1);
  }
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

// ==================================================================== VERIFY
if (mode === "verify") {
  if (!existsSync(STATE)) { console.error(`no ${STATE} — run --select first`); process.exit(1); }
  const snap = JSON.parse(readFileSync(STATE, "utf8"));
  console.log(`=== VERIFY ${snap.selected.length} canary deals (selected ${snap.selectedAt}) ===`);

  // Find each card by its HubSpot id.
  const cards = new Map();
  let cursor = null;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids display_value } } } } } }`,
      { b: DEALS_BOARD, c: cursor,
        ids: [ID_COL, STAGE_COL, PIPE_COL, PROB_COL, "deal_stage", "deal_value",
              REL_CONTACTS, REL_ACCOUNTS, REL_LINE_ITEMS] })).boards[0].items_page;
    for (const it of page.items) {
      const hsId = (it.column_values.find(c => c.id === ID_COL)?.text ?? "").trim();
      if (hsId) cards.set(hsId, it);
    }
    cursor = page.cursor;
  } while (cursor);

  const cell = (it, id) => it.column_values.find(c => c.id === id);
  const txt = (it, id) => (cell(it, id)?.text ?? "").trim();
  const links = (it, id) => (cell(it, id)?.linked_item_ids ?? []).map(String);

  let missing = 0, fieldMismatch = 0, stageOk = 0, pipeOk = 0, probOk = 0;
  let relC = 0, relA = 0, relL = 0, wantC = 0, wantA = 0, wantL = 0;
  const problems = [];

  for (const s of snap.selected) {
    const it = cards.get(s.hsId);
    if (!it) { missing++; problems.push({ hsId: s.hsId, problem: "no card was created" }); continue; }

    if (txt(it, STAGE_COL) === s.expect.stageLabel) stageOk++;
    else problems.push({ hsId: s.hsId, problem: `HubSpot Stage ${JSON.stringify(txt(it, STAGE_COL))} != ${JSON.stringify(s.expect.stageLabel)}` });

    if (txt(it, PIPE_COL) === s.expect.pipelineLabel) pipeOk++;
    else problems.push({ hsId: s.hsId, problem: `Pipeline ${JSON.stringify(txt(it, PIPE_COL))} != ${JSON.stringify(s.expect.pipelineLabel)}` });

    // 0.2 -> "20". Compared numerically: monday may render "20" or "20.0".
    const gotProb = Number(txt(it, PROB_COL) || "NaN");
    if (s.expect.probability === null || Math.abs(gotProb - s.expect.probability) < 0.001) probOk++;
    else problems.push({ hsId: s.hsId, problem: `probability ${txt(it, PROB_COL)} != ${s.expect.probability} (HubSpot stores ${s.expect.probabilityRaw})` });

    if (Number(txt(it, "deal_value") || 0) !== Number(s.expect.amount || 0)) {
      fieldMismatch++;
      problems.push({ hsId: s.hsId, problem: `amount ${txt(it, "deal_value")} != ${s.expect.amount}` });
    }

    wantC += s.expect.contacts; wantA += s.expect.companies; wantL += s.expect.lineItems;
    relC += links(it, REL_CONTACTS).length;
    relA += links(it, REL_ACCOUNTS).length;
    relL += links(it, REL_LINE_ITEMS).length;
  }

  console.log(`\n--- RESULT ---`);
  console.log(`  deals checked                  ${snap.selected.length}`);
  console.log(`  cards missing                  ${missing}`);
  console.log(`  HubSpot Stage correct          ${stageOk}/${snap.selected.length}`);
  console.log(`  Pipeline correct               ${pipeOk}/${snap.selected.length}`);
  console.log(`  probability scaled correctly   ${probOk}/${snap.selected.length}`);
  console.log(`  amount mismatches              ${fieldMismatch}`);
  console.log(`\n  relations linked / expected`);
  console.log(`    Deal -> Contacts             ${relC} / ${wantC}`);
  console.log(`    Deal -> Accounts             ${relA} / ${wantA}`);
  console.log(`    Deal -> Line Items           ${relL} / ${wantL}`);

  // ---- HubSpot associations must be UNCHANGED. monday displaying them differently is not a reason
  // to remove any, and this is the one irreversible failure mode in the whole phase.
  let assocLost = 0;
  for (const s of snap.selected) {
    for (const [to, before] of Object.entries(s.assocBefore)) {
      const r = await hs(`/crm/v4/objects/deals/${s.hsId}/associations/${to}?limit=100`);
      const now = (r.body.results ?? []).map(x => String(x.toObjectId));
      const gone = before.filter(x => !now.includes(x));
      if (gone.length) {
        assocLost += gone.length;
        problems.push({ hsId: s.hsId, problem: `LOST ${gone.length} HubSpot ${to} association(s): ${gone.join(",")}` });
      }
    }
  }
  console.log(`\n  HubSpot associations LOST      ${assocLost}   <- must be 0`);

  // ---- nothing may have been written to the live WM deals board
  const wm = await monday(`query ($b: ID!) { boards(ids: [$b]) { items_count } }`, { b: WM_DEALS_BOARD });
  const wmCount = wm.boards[0].items_count;
  console.log(`  WM deals board ${WM_DEALS_BOARD} items  ${wmCount} (was ${snap.wmDealsCount})`);

  // ---- the project board the Won automation would have written to
  const proj = await monday(`query ($b: ID!) { boards(ids: [$b]) { items_count } }`, { b: "5028000491" });
  const projCount = proj.boards[0].items_count;
  console.log(`  board 5028000491 items         ${projCount} (was ${snap.projectCount})`);

  console.log(`\n--- ASSERTIONS ---`);
  const check = (label, ok, detail = "") => console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  — ${detail}` : ""}`);
  check("every canary deal produced a card", missing === 0);
  check("no HubSpot association was removed", assocLost === 0, assocLost ? `${assocLost} lost` : "");
  check("HubSpot Stage is pipeline-qualified and correct on every deal", stageOk === snap.selected.length);
  check("Pipeline correct on every deal", pipeOk === snap.selected.length);
  check("probability scaled (HubSpot fraction -> monday percent)", probOk === snap.selected.length);
  check("no field mismatches on amount", fieldMismatch === 0);
  check("Deal -> Contacts fully linked", relC === wantC, `${relC}/${wantC}`);
  check("Deal -> Accounts fully linked", relA === wantA, `${relA}/${wantA}`);
  check("Deal -> Line Items fully linked", relL === wantL, `${relL}/${wantL}`);
  check("nothing written to the WM deals board", wmCount === snap.wmDealsCount);
  check("the Won automation created nothing in board 5028000491", projCount === snap.projectCount);

  if (problems.length) {
    console.log(`\n--- PROBLEMS (${problems.length}) ---`);
    for (const p of problems.slice(0, 40)) console.log(`  deal ${p.hsId}: ${p.problem}`);
  }
  const verdict = missing === 0 && assocLost === 0 && stageOk === snap.selected.length
    && pipeOk === snap.selected.length && probOk === snap.selected.length && fieldMismatch === 0
    && relC === wantC && relA === wantA && relL === wantL
    && wmCount === snap.wmDealsCount && projCount === snap.projectCount;
  console.log(`\n  ${verdict ? "CANARY CLEAN" : "CANARY FAILED — do not run the historical import."}`);
  writeFileSync(join(ROOT, "scripts", ".canary-deals-verify.json"),
    JSON.stringify({ missing, assocLost, stageOk, pipeOk, probOk, relC, relA, relL, problems, verdict }, null, 2), "utf8");
  process.exit(verdict ? 0 : 1);
}

// ==================================================================== SELECT
console.log("=== SELECT a stratified Deals canary ===");
console.log("pipelines and stage labels…");
const pipes = await hs("/crm/v3/pipelines/deals");
const PIPE_LABEL = {}, STAGE_LABEL = {}, STAGE_PIPE = {}, WON_STAGES = new Set();
const PREFIX = {
  "default": "Sales",
  "551f4f6c-ced0-4069-b1be-f0d3dc33bf2d": "SF-Sales",
  "d10159b0-bab4-487a-a11f-55f3a682a170": "SF-Maint",
  "08554d8d-265d-4fbf-94e2-7002cb1ecbca": "SF-Train",
  "81ee3345-1b0f-42aa-9e78-580614546602": "Shared",
};
for (const p of pipes.body.results ?? []) {
  PIPE_LABEL[String(p.id)] = String(p.label);
  for (const st of p.stages ?? []) {
    const sid = String(st.id);
    STAGE_LABEL[sid] = `${PREFIX[String(p.id)] ?? String(p.label)} / ${String(st.label)}`;
    STAGE_PIPE[sid] = String(p.id);
    // Anything that maps to the monday "Won" label triggers 31010010 and 31010017.
    if (/赢单|closed ?won|已成交/i.test(String(st.label))) WON_STAGES.add(sid);
  }
}
console.log(`  ${Object.keys(PIPE_LABEL).length} pipelines, ${Object.keys(STAGE_LABEL).length} stages,`
  + ` ${WON_STAGES.size} of them Won-like and therefore EXCLUDED`);

console.log("scanning deals…");
const groups = { "multi-contact": [], "multi-company": [], "multi-line-item": [], "bare": [], "sf-maint": [] };
let scanned = 0, after;
do {
  const q = new URLSearchParams({ limit: "100", archived: "false",
    properties: "dealname,pipeline,dealstage,amount,hs_deal_stage_probability,num_associated_contacts,hs_num_of_associated_line_items" });
  if (after) q.set("after", after);
  const r = await hs(`/crm/v3/objects/deals?${q}`);
  if (!r.ok) { console.log(`  list failed http ${r.status}`); break; }
  const batch = (r.body.results ?? []).filter(d => !WON_STAGES.has(String(d.properties?.dealstage ?? "")));
  // Association counts for the whole page in one call per direction.
  const ids = batch.map(d => ({ id: String(d.id) }));
  const assoc = {};
  for (const to of ["contacts", "companies", "line_items"]) {
    const b = await hs(`/crm/v4/associations/deals/${to}/batch/read`, { inputs: ids });
    assoc[to] = new Map((b.body.results ?? []).map(row =>
      [String(row.from?.id ?? ""), (row.to ?? []).map(x => String(x.toObjectId))]));
  }
  for (const d of batch) {
    scanned++;
    const id = String(d.id), p = d.properties ?? {};
    const c = assoc.contacts.get(id) ?? [], co = assoc.companies.get(id) ?? [], li = assoc.line_items.get(id) ?? [];
    const base = {
      hsId: id, name: p.dealname ?? "",
      assocBefore: { contacts: c, companies: co, line_items: li },
      expect: {
        stageLabel: STAGE_LABEL[String(p.dealstage)] ?? "",
        pipelineLabel: PIPE_LABEL[String(p.pipeline)] ?? "",
        probability: p.hs_deal_stage_probability != null && p.hs_deal_stage_probability !== ""
          ? Number(p.hs_deal_stage_probability) * 100 : null,
        probabilityRaw: p.hs_deal_stage_probability ?? "",
        amount: p.amount ?? "",
        contacts: c.length, companies: co.length, lineItems: li.length,
      },
    };
    if (!base.expect.stageLabel) continue;                       // unknown stage: not a canary case
    const g = c.length > 1 ? "multi-contact"
      : co.length > 1 ? "multi-company"
      : li.length > 1 ? "multi-line-item"
      : String(p.pipeline) === "d10159b0-bab4-487a-a11f-55f3a682a170" ? "sf-maint"
      : (c.length + co.length + li.length) === 0 ? "bare" : null;
    if (g && groups[g].length < PER_GROUP) groups[g].push({ ...base, group: g });
  }
  after = r.body.paging?.next?.after;
  if (Object.values(groups).every(x => x.length >= PER_GROUP)) break;
} while (after);

const selected = Object.values(groups).flat();
console.log(`  scanned ${scanned} non-Won deals\n`);
console.log("--- SAMPLE ---");
for (const [k, g] of Object.entries(groups)) console.log(`  ${k.padEnd(16)} ${g.length}`);
console.log(`  TOTAL            ${selected.length}`);
for (const [k, g] of Object.entries(groups)) {
  if (!g.length) continue;
  const s = g[0];
  console.log(`\n  e.g. ${k}: deal ${s.hsId} ${JSON.stringify(s.name).slice(0, 34)}`);
  console.log(`      stage=${JSON.stringify(s.expect.stageLabel)} pipeline=${JSON.stringify(s.expect.pipelineLabel)}`);
  console.log(`      prob=${s.expect.probabilityRaw} -> ${s.expect.probability}  amount=${s.expect.amount}`
    + `  contacts=${s.expect.contacts} companies=${s.expect.companies} lineItems=${s.expect.lineItems}`);
}

const wm = await monday(`query ($b: ID!) { boards(ids: [$b]) { items_count } }`, { b: WM_DEALS_BOARD });
const proj = await monday(`query ($b: ID!) { boards(ids: [$b]) { items_count } }`, { b: "5028000491" });
writeFileSync(STATE, JSON.stringify({
  selectedAt: new Date().toISOString(), selected,
  wmDealsCount: wm.boards[0].items_count, projectCount: proj.boards[0].items_count,
}, null, 2), "utf8");
console.log(`\n  WM deals board items now      : ${wm.boards[0].items_count} (must not change)`);
console.log(`  board 5028000491 items now    : ${proj.boards[0].items_count} (must not change)`);
console.log(`\nsnapshot written to ${STATE}`);
console.log(`\nNow run the REAL pass against only these deals:\n`);
console.log(`  node scripts/backfill-crm.mjs --object deals --apply --only-hs ${selected.map(s => s.hsId).join(",")}`);
console.log(`\nthen: node scripts/canary-deals.mjs --verify`);
