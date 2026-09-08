/**
 * Create the Contacts columns the reviewed mapping sheet needs but the board lacks.
 *
 * Additive only — this script never deletes. Defaults to --plan; --apply creates.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/add-crm-columns.mjs --plan
 *   MONDAY_API_TOKEN=<token> node scripts/add-crm-columns.mjs --apply
 *
 * Idempotent by TITLE: a column with the same title is left alone, so re-running adds nothing.
 * NOTE: titles here MUST track scripts/rename-crm-columns.mjs. They were renamed on 2026-09-08 to
 * match the HubSpot Create Contact form labels, and a stale title here would silently re-create a
 * duplicate column on the next --apply.
 */
const API = "https://api.monday.com/v2";
const CONTACTS = "5028000495";

/** HubSpot `priority__c` (优先级) — the exact 4 SLA options, verified live 2026-09-08.
 *  Deliberately its OWN column: monday's native Priority is High/Medium/Low, a different concept
 *  with ZERO label overlap. Mapping HubSpot's SLA into it would be the industry mistake again. */
/** HubSpot `sales_person` - all 4 options, verified live. Value == label for every one, so no label
 *  dictionary is needed and no extra schema fetch is added. */
/** HubSpot `lifecyclestage` for THIS portal - the exact 10 customised stages, verified live. */
const LIFECYCLE_LABELS = [
  "1.NEW",
  "2.Information error or incomplete/Send email for promotion",
  "3.Competitors",
  "4.Returning customers/Have purchased from other channels",
  "5.No intention",
  "6.Not in contact/Pending further contact",
  "7.Intention to purchase",
  "8.The customer generating the transaction",
  "9.False or spam information",
  "10.Other",
];

const SALES_PERSON_LABELS = ["Elaine Rivera", "Emily You", "Myla Mestiola", "Rick Avery Antonio"];

const PRIORITY_LABELS = ["P1_2小时内", "P2_1周内", "P3_2周内", "P4_持续跟进"];

export const PLANNED = [
  {
    title: "Owner assigned date", type: "date", after: "multiple_person_mm6zap53",
    why: "hubspot_owner_assigneddate — verified populated; HubSpot resets it on reassignment, so it is the trigger field for the future 24-hour follow-up reminder",
  },
  {
    title: "Last Activity Date", type: "date", after: "text_mm6tmzgq",
    why: "notes_last_updated is a DATETIME; the existing 'Last Activity Date' column is TEXT and would show a raw ISO string. monday cannot retype, so a new date column is the only route",
  },
  {
    title: "优先级", type: "status", after: "color_mm6zb4tc", labels: PRIORITY_LABELS,
    why: "priority__c, seeded with its exact 4 SLA labels. Native Priority (High/Medium/Low) stays untouched",
  },
  {
    title: "Lifecycle Stage", type: "status", after: "color_mm6zb4tc", labels: LIFECYCLE_LABELS,
    why: "lifecyclestage - this portal has a heavily customised Chinese pipeline (生命周期阶段管道). Populated on real records and previously unmapped. Its option VALUES are a mix of semantic strings (lead/opportunity/customer) and raw numeric ids (1028988526), so a label dictionary is REQUIRED or monday would display the ids",
  },
  {
    title: "Sales Person", type: "status", after: "text_mm6sakj3", labels: SALES_PERSON_LABELS,
    why: "sales_person - a 4-option picker on the HubSpot Create Contact form with no monday home. Its option VALUES equal its labels, so the seeded list is exact",
  },
];

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }

  const cols = (await gql(token, "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }",
    { b: [CONTACTS] })).boards[0].columns;
  const byTitle = new Set(cols.map(c => c.title));
  console.log(`Contacts board ${CONTACTS}: ${cols.length} columns\n`);

  for (const p of PLANNED) {
    if (byTitle.has(p.title)) { console.log(`  skip     "${p.title}" already exists`); continue; }
    if (!apply) {
      console.log(`  WOULD create  ${p.type.padEnd(8)} "${p.title}"`);
      console.log(`                 ${p.why}`);
      continue;
    }
    const hasLabels = Array.isArray(p.labels);
    const q = "mutation ($b: ID!, $t: String!, $ct: ColumnType!, $a: ID!"
      + (hasLabels ? ", $d: JSON!" : "")
      + ") { create_column(board_id: $b, title: $t, column_type: $ct, after_column_id: $a"
      + (hasLabels ? ", defaults: $d" : "") + ") { id title type } }";
    const v = { b: CONTACTS, t: p.title, ct: p.type, a: p.after };
    if (hasLabels) v.d = JSON.stringify({ labels: Object.fromEntries(p.labels.map((l, i) => [String(i + 1), l])) });
    const r = (await gql(token, q, v)).create_column;
    console.log(`  created  ${r.id.padEnd(24)} ${r.type.padEnd(8)} "${r.title}"`);
  }
  if (!apply) console.log("\n--plan only. Nothing was created. Re-run with --apply.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("add-crm-columns.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
