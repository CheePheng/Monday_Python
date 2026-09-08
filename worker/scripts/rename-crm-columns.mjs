/**
 * Rename monday CRM columns so their titles match the HubSpot Create Contact / Create Company form
 * labels. Titles only — column IDs never change, so no mapping or data is affected.
 *
 * Why: the board had grown names like "Priority (HubSpot)", "Contact Owner (synced)" and
 * "Sales Users" that do not appear anywhere in HubSpot, which makes the two systems hard to compare
 * side by side. The "(synced)" suffixes existed to distinguish the people columns from text columns
 * that have since been deleted, so they are now just noise.
 *
 * KEPT deliberately: "Industry (HubSpot)" — the Accounts board also has a NATIVE Industry dropdown
 * that is intentionally unmapped, so that suffix is the only thing telling them apart.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/rename-crm-columns.mjs --plan
 *   MONDAY_API_TOKEN=<token> node scripts/rename-crm-columns.mjs --apply
 */
const API = "https://api.monday.com/v2";

export const RENAMES = [
  // board, column id, expected current title, new title
  ["5028000495", "text_mm6snp6r", "Last Name", "Last name"],
  ["5028000495", "contact_phone", "Phone", "Phone number"],
  ["5028000495", "text_mm6sakj3", "Sales Users", "Sales User"],
  ["5028000495", "multiple_person_mm6zap53", "Contact Owner (synced)", "Contact owner"],
  ["5028000495", "color_mm70ahh7", "Priority (HubSpot)", "优先级"],
  ["5028000495", "date_mm70pa4c", "Assigned Date", "Owner assigned date"],
  ["5028000495", "date_mm7054jz", "HubSpot Last Activity Date", "Last Activity Date"],

  ["5028000496", "text_mm6t1q4h", "Company Name", "Company name"],
  ["5028000496", "company_domain", "Domain", "Company domain name"],
  ["5028000496", "multiple_person_mm6z8mwy", "Company Owner (synced)", "Company owner"],
  ["5028000496", "dropdown_mm6zd1ge", "Partner With (HubSpot)", "Partner with"],
  ["5028000496", "numeric_mm6zj731", "Annual Revenue", "Annual revenue"],
  ["5028000496", "employee_count", "No. of employees", "Number of employees"],
  ["5028000496", "text_mm6twxwe", "Sales Users", "Sales User"],
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

  const live = {};
  for (const b of ["5028000495", "5028000496"]) {
    const cols = (await gql(token, "query ($b: [ID!]) { boards(ids: $b) { columns { id title } } }",
      { b: [b] })).boards[0].columns;
    live[b] = new Map(cols.map(c => [c.id, c.title]));
  }

  for (const [board, id, expected, next] of RENAMES) {
    const current = live[board].get(id);
    if (current === undefined) { console.log(`  MISSING  ${id} — column no longer exists, skipping`); continue; }
    if (current === next) { console.log(`  skip     ${id.padEnd(26)} already "${next}"`); continue; }
    if (current !== expected) {
      console.log(`  SKIP     ${id.padEnd(26)} is "${current}", expected "${expected}" — not touching it`);
      continue;
    }
    if (!apply) { console.log(`  WOULD    ${id.padEnd(26)} "${current}" -> "${next}"`); continue; }
    await gql(token,
      "mutation ($b: ID!, $i: String!, $t: String!) { change_column_title(board_id: $b, column_id: $i, title: $t) { id title } }",
      { b: board, i: id, t: next });
    console.log(`  renamed  ${id.padEnd(26)} "${current}" -> "${next}"`);
  }
  if (!apply) console.log("\n--plan only. Nothing renamed. Re-run with --apply.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("rename-crm-columns.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
