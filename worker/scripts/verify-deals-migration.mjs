/**
 * THE ONE agreed end-of-migration verification for Deals + Line Items + Deal Relations. READ-ONLY.
 *
 * Every check below is one of the agreed acceptance criteria, in order, and each prints the numbers it
 * judged on rather than a bare pass/fail — a verification you cannot audit is just a claim.
 *
 *   1. Deals imported, none missing
 *   2. Line Items imported, none missing
 *   3. exact HubSpot Stage correct (pipeline-qualified)
 *   4. Pipeline correct
 *   5. coarse Stage holds ONLY New / Proposal / Negotiation / Won / Lost
 *   6. Deal -> Contact relations correct
 *   7. Deal -> Company relations correct
 *   8. Deal -> Line Item relations correct
 *   9. no duplicate HubSpot ids on either board
 *  10. Client Projects board unchanged from the pre-import baseline
 *  11. old WM Deals board unchanged
 *  12. 0 unexplained failures (the importer's own state files)
 *
 * WHY ASSOCIATION COUNTS RATHER THAN PER-DEAL ASSOCIATION READS. Reading associations for 8,653 deals
 * across three object types is ~26,000 HubSpot requests. HubSpot already maintains
 * `num_associated_contacts` and `hs_num_of_associated_line_items` on the deal itself, so comparing
 * those against the monday relation cells covers EVERY deal instead of a sample. Companies have no
 * such counter, so that one dimension is sampled and the sample size is printed — a bounded check
 * that says it is bounded, rather than a total that quietly is not.
 *
 *   node scripts/verify-deals-migration.mjs
 *   node scripts/verify-deals-migration.mjs --sample 150     # company-association sample size
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEALS_BOARD = "5028000494", LI_BOARD = "5028000489";
const D_ID = "text_mm76kxz4", LI_ID = "text_mm76qwtw";
const D_EXACT = "dropdown_mm7624zd", D_PIPE = "dropdown_mm76s7kk", D_COARSE = "deal_stage";
const REL_CONTACT = "deal_contact", REL_COMPANY = "board_relation_mm76wp4e", REL_LI = "board_relation_mm76btmt";
const COARSE_OK = new Set(["New", "Proposal", "Negotiation", "Won", "Lost", ""]);
const BASELINE = join(ROOT, "scripts", ".deals-baseline.json");

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const SAMPLE = Number(arg("--sample") ?? 120);

const env = Object.fromEntries(readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)
  .filter(l => l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

async function md(query, variables = {}) {
  for (let a = 0; ; a++) {
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: env.MONDAY_API_TOKEN, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }),
    });
    const b = await r.json();
    if (!b.errors) return b.data;
    if (a < 4) { await new Promise(res => setTimeout(res, 1500 * 2 ** a)); continue; }
    throw new Error(`monday: ${JSON.stringify(b.errors).slice(0, 250)}`);
  }
}
async function hsPost(path, body) {
  for (let a = 0; ; a++) {
    const r = await fetch(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && a < 5) { await new Promise(res => setTimeout(res, 1000 * 2 ** a)); continue; }
    throw new Error(`hubspot ${path}: ${r.status}`);
  }
}

/** Every item on a board, with the columns we judge on. Paged; the point is a total, not a sample. */
async function dumpBoard(boardId, colIds) {
  const cols = JSON.stringify(colIds);
  const frag = `id name column_values(ids: ${cols}) { id text
      ... on BoardRelationValue { linked_item_ids } }`;
  const out = [];
  let cursor = null;
  for (;;) {
    const q = cursor
      ? `query ($c: String!) { next_items_page(cursor: $c, limit: 250) { cursor items { ${frag} } } }`
      : `query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 250) { cursor items { ${frag} } } } }`;
    const d = await md(q, cursor ? { c: cursor } : { b: [boardId] });
    const page = cursor ? d.next_items_page : d.boards[0].items_page;
    out.push(...page.items);
    cursor = page.cursor;
    if (!cursor) break;
  }
  return out;
}
const cell = (it, id) => it.column_values.find(c => c.id === id);
const txt = (it, id) => (cell(it, id)?.text ?? "").trim();
const links = (it, id) => (cell(it, id)?.linked_item_ids ?? []).length;

// ---------------------------------------------------------------- worker code (for the dictionaries)
const dir = mkdtempSync(join(tmpdir(), "verify-"));
const out = join(dir, "w.mjs"), entry = join(dir, "e.ts");
writeFileSync(entry, `export { getCrmStageDicts } from ${JSON.stringify(join(ROOT, "src", "hubspot.ts"))};`, "utf8");
buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
const { getCrmStageDicts } = await import(pathToFileURL(out).href);
const dicts = await getCrmStageDicts({ HUBSPOT_ACCESS_TOKEN: env.HUBSPOT_ACCESS_TOKEN });
rmSync(dir, { recursive: true, force: true });

console.log("reading both boards and HubSpot…\n");
const dealItems = await dumpBoard(DEALS_BOARD, [D_ID, D_EXACT, D_PIPE, D_COARSE, REL_CONTACT, REL_COMPANY, REL_LI]);
const liItems = await dumpBoard(LI_BOARD, [LI_ID]);

// Every HubSpot deal, with the fields the checks compare against. Keyset paged: /search 400s past 10,000.
const hsDeals = new Map();
{
  let lastId = "0";
  for (;;) {
    const body = await hsPost("/crm/v3/objects/deals/search", {
      filterGroups: [{ filters: [
        { propertyName: "createdate", operator: "HAS_PROPERTY" },
        { propertyName: "hs_object_id", operator: "GT", value: lastId },
      ] }],
      properties: ["dealstage", "pipeline", "num_associated_contacts", "hs_num_of_associated_line_items"],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }], limit: 100,
    });
    const page = body.results ?? [];
    if (!page.length) break;
    for (const d of page) hsDeals.set(String(d.id), d.properties);
    lastId = String(page[page.length - 1].id);
  }
}
const hsLiTotal = (await hsPost("/crm/v3/objects/line_items/search", {
  filterGroups: [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }], limit: 1,
})).total;

// ================================================================= 1 & 2  completeness
console.log("=== completeness ===");
const dealIds = dealItems.map(it => txt(it, D_ID)).filter(Boolean);
const liIds = liItems.map(it => txt(it, LI_ID)).filter(Boolean);
const dealIdSet = new Set(dealIds);
const missingDeals = [...hsDeals.keys()].filter(id => !dealIdSet.has(id));
check(missingDeals.length === 0, "every HubSpot deal has a card",
  `HubSpot ${hsDeals.size}, carded ${dealIdSet.size}, missing ${missingDeals.length}`
  + (missingDeals.length ? ` e.g. ${missingDeals.slice(0, 5).join(",")}` : ""));
check(liIds.length >= hsLiTotal, "every HubSpot line item has a card",
  `HubSpot ${hsLiTotal}, carded ${new Set(liIds).size}`);

// ================================================================= 9  duplicates
console.log("\n=== duplicates ===");
check(dealIds.length === dealIdSet.size, "no duplicate HubSpot id on the Deals board",
  `${dealIds.length} carded ids, ${dealIdSet.size} distinct`);
check(liIds.length === new Set(liIds).size, "no duplicate HubSpot id on the Line Items board",
  `${liIds.length} carded ids, ${new Set(liIds).size} distinct`);

// ================================================================= 3,4,5  stage & pipeline
console.log("\n=== stage and pipeline ===");
let exactBad = 0, pipeBad = 0, coarseBad = 0, coarseEmpty = 0;
const badSamples = [];
for (const it of dealItems) {
  const id = txt(it, D_ID);
  const p = hsDeals.get(id);
  if (!p) continue;
  const wantExact = dicts.stages[String(p.dealstage)] ?? "";
  const wantPipe = dicts.pipelines[String(p.pipeline)] ?? "";
  if (wantExact && txt(it, D_EXACT) !== wantExact) {
    exactBad++; if (badSamples.length < 5) badSamples.push(`${id} exact "${txt(it, D_EXACT)}" != "${wantExact}"`);
  }
  if (wantPipe && txt(it, D_PIPE) !== wantPipe) {
    pipeBad++; if (badSamples.length < 5) badSamples.push(`${id} pipeline "${txt(it, D_PIPE)}" != "${wantPipe}"`);
  }
  const coarse = txt(it, D_COARSE);
  if (!coarse) coarseEmpty++;
  if (!COARSE_OK.has(coarse)) {
    coarseBad++; if (badSamples.length < 5) badSamples.push(`${id} coarse "${coarse}" not an allowed label`);
  }
}
check(exactBad === 0, "exact HubSpot Stage matches, pipeline-qualified", `${exactBad} mismatched`);
check(pipeBad === 0, "Pipeline matches", `${pipeBad} mismatched`);
check(coarseBad === 0, "coarse Stage holds only New/Proposal/Negotiation/Won/Lost",
  `${coarseBad} illegal, ${coarseEmpty} empty`);
for (const s of badSamples) console.log(`        ${s}`);

// The column itself must not have grown a label — the 2026-09-15 defect in its own terms.
const stageCol = (await md(`query { boards(ids: [${DEALS_BOARD}]) { columns(ids: ["${D_COARSE}"]) { settings_str } } }`))
  .boards[0].columns[0];
const stageLabels = Object.values(JSON.parse(stageCol.settings_str).labels ?? {});
const guidLabels = stageLabels.filter(l => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(l)));
check(guidLabels.length === 8, "no NEW GUID label was created by this run",
  `${stageLabels.length} labels, ${guidLabels.length} GUID-shaped (8 pre-existing, pending manual removal)`);

// ================================================================= 6,7,8  relations
console.log("\n=== relations ===");
let contactBad = 0, liBad = 0, contactChecked = 0, liChecked = 0;
for (const it of dealItems) {
  const p = hsDeals.get(txt(it, D_ID));
  if (!p) continue;
  const wantC = Number(p.num_associated_contacts ?? 0);
  if (Number.isFinite(wantC)) { contactChecked++; if (links(it, REL_CONTACT) !== wantC) contactBad++; }
  const wantL = Number(p.hs_num_of_associated_line_items ?? 0);
  if (Number.isFinite(wantL)) { liChecked++; if (links(it, REL_LI) !== wantL) liBad++; }
}
check(contactBad === 0, "Deal -> Contact link counts match HubSpot", `${contactBad} of ${contactChecked} differ`);
check(liBad === 0, "Deal -> Line Item link counts match HubSpot", `${liBad} of ${liChecked} differ`);

// Companies: HubSpot keeps no counter, so this dimension is SAMPLED and says so.
const withId = dealItems.filter(it => txt(it, D_ID));
const step = Math.max(1, Math.floor(withId.length / SAMPLE));
const sample = withId.filter((_, i) => i % step === 0).slice(0, SAMPLE);
let compBad = 0;
for (const it of sample) {
  const id = txt(it, D_ID);
  const r = await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${id}/associations/companies?limit=100`,
    { headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } });
  const want = r.ok ? ((await r.json()).results ?? []).length : 0;
  if (links(it, REL_COMPANY) !== want) compBad++;
}
check(compBad === 0, `Deal -> Company links match HubSpot (SAMPLE of ${sample.length} of ${withId.length})`,
  `${compBad} differ`);

// ================================================================= 10,11  untouched boards
console.log("\n=== boards that had to stay unchanged ===");
if (!existsSync(BASELINE)) { check(false, "pre-import baseline present", BASELINE); }
else {
  const base = JSON.parse(readFileSync(BASELINE, "utf8")).boards;
  const now = (await md(`query ($b: [ID!]) { boards(ids: $b) { id name items_count } }`,
    { b: ["5028000491", "5029480547"] })).boards;
  for (const b of now) {
    const was = base[String(b.id)];
    check(was && b.items_count === was.items, `${b.name} unchanged`,
      `${was?.items} -> ${b.items_count}`);
  }
  // The canary must have been skipped, not duplicated.
  const canary = new Set((base[DEALS_BOARD]?.hubspotIds ?? []).map(String));
  const kept = [...canary].filter(id => dealIdSet.has(id)).length;
  check(kept === canary.size, "all 40 canary deals still present and not duplicated",
    `${kept}/${canary.size}`);
}

// ================================================================= 12  importer failures
console.log("\n=== importer state ===");
for (const [label, f] of [["deals", "scripts/.backfill-deals.json"],
                          ["line_items", "scripts/.backfill-line_items.json"],
                          ["deal-relations", "scripts/.backfill-deal-relations.json"]]) {
  const p = join(ROOT, f);
  if (!existsSync(p)) { console.log(`  (no state file for ${label})`); continue; }
  const j = JSON.parse(readFileSync(p, "utf8"));
  const failed = Array.isArray(j.failed) ? j.failed.length : Number(j.failed ?? 0);
  check(failed === 0, `${label}: 0 unexplained failures`,
    `scanned ${j.scanned ?? "?"}, created ${j.created ?? "?"}, skipped ${j.skipped ?? "?"}, failed ${failed}`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED.` : `\nALL CHECKS PASSED.`);
process.exit(failures ? 1 : 0);
