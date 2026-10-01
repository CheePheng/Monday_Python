/**
 * Create the three monday columns the CRM release needs. ADDITIVE ONLY — this script creates and
 * never deletes, retypes or renames anything.
 *
 *   node --env-file=.dev.vars scripts/create-crm-columns.mjs --plan    # read-only (default)
 *   node --env-file=.dev.vars scripts/create-crm-columns.mjs --apply
 *
 * IDEMPOTENT: existing columns are read first and a matching title+type is left alone, so re-running
 * never produces a duplicate column. monday cannot retype a column, so a duplicate would have to be
 * deleted by hand — which is exactly the mess this check exists to avoid.
 */

const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN) { console.log("MONDAY_API_TOKEN is required (even for --plan, which reads existing columns)"); process.exit(1); }
const APPLY = process.argv.includes("--apply");

export const WANTED = [
  {
    board: "5028000489", boardName: "Products & Services",
    title: "Net price", type: "numbers",
    // NO unit symbol: 7,144 of 9,970 line items are CNY and 2,815 USD, and the row's own Currency
    // column already says which. A "$" here would misprice three quarters of the board on sight.
    settings: {},
    why: "HubSpot line_item.amount — HubSpot's OWN label for it is \"Net price\". Calculated by HubSpot "
       + "(includes discounts), so it is mapped one-way and never recomputed locally.",
  },
  {
    board: "5028000496", boardName: "Accounts/Companies",
    title: "Last Activity Date", type: "date", settings: {},
    why: "HubSpot company notes_last_updated — the same property, and the same column title, that "
       + "Contacts already uses (date_mm7054jz). One-way; HubSpot maintains it.",
  },
  {
    board: "5028000494", boardName: "Deals",
    title: "Created date", type: "date", settings: {},
    why: "HubSpot deal createdate. NOT monday's Creation Log, which records when the CARD was made — "
       + "every Deals card was made during the 2026-09-14/15 import, so it would claim all 8,665 deals "
       + "were created that week.",
  },
  {
    board: "5028000496", boardName: "Accounts/Companies",
    title: "Sales User (People)", type: "people", settings: {},
    why: "HubSpot sales_user resolved owner-id -> owner email -> monday user, matching the Contacts "
       + "precedent (multiple_person_mm76ygkp). FORWARD-ONLY: nine HubSpot owner ids share one email in "
       + "this portal, so a reverse write could not tell them apart and would reassign records.",
  },
  {
    board: "5028000494", boardName: "Deals",
    title: "Sales User (People)", type: "people", settings: {},
    why: "Same as Accounts. The existing dropdown_mm76ncf5 carries reverse:true today; the People "
       + "column deliberately does NOT, because the shared-email collapse makes the inverse ambiguous.",
  },
];

const gql = async (query, variables) => {
  for (let a = 0; a < 4; a++) {
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: TOKEN, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    if (!j.errors) return j.data;
    if (a === 3) { console.log("  monday errors:", JSON.stringify(j.errors).slice(0, 400)); return null; }
    await new Promise(s => setTimeout(s, 1500 * (a + 1)));
  }
  return null;
};

const created = [];
for (const w of WANTED) {
  const d = await gql(`query ($i:[ID!]) { boards(ids:$i) { id name columns { id title type } } }`, { i: [w.board] });
  const cols = d?.boards?.[0]?.columns ?? [];
  const hit = cols.find(c => c.title.trim().toLowerCase() === w.title.toLowerCase() && c.type === w.type);
  console.log(`\n${w.boardName} (${w.board}) — "${w.title}" [${w.type}]`);
  console.log(`   ${w.why}`);
  if (hit) { console.log(`   ALREADY EXISTS as ${hit.id} — nothing to do`); created.push({ ...w, id: hit.id, existed: true }); continue; }
  // A same-title column of a DIFFERENT type is a red flag, not something to work around silently.
  const clash = cols.find(c => c.title.trim().toLowerCase() === w.title.toLowerCase());
  if (clash) { console.log(`   REFUSING: "${w.title}" already exists as ${clash.id} with type ${clash.type}, not ${w.type}`); continue; }
  if (!APPLY) { console.log(`   WOULD CREATE (re-run with --apply)`); continue; }
  const res = await gql(
    `mutation ($b:ID!, $t:String!, $ct:ColumnType!, $d:JSON) {
       create_column(board_id:$b, title:$t, column_type:$ct, defaults:$d) { id title type }
     }`,
    { b: w.board, t: w.title, ct: w.type, d: JSON.stringify(w.settings) });
  const c = res?.create_column;
  if (!c) { console.log(`   FAILED`); continue; }
  console.log(`   CREATED ${c.id}`);
  created.push({ ...w, id: c.id, existed: false });
}

console.log(`\n================ column ids for src/config/crm.ts`);
for (const c of created) console.log(`   ${c.boardName.padEnd(22)} ${c.title.padEnd(20)} ${c.id}${c.existed ? "  (pre-existing)" : ""}`);
if (!APPLY) console.log("\n--plan only. Nothing was created. Re-run with --apply.");
