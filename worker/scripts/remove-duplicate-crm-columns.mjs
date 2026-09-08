/**
 * Delete the two Contacts columns that carry no information.
 *
 * 1. "Lead Status" (color_mm6zb4tc) -> HubSpot `hs_lead_status`, set on 450 of 94,205 contacts
 *    (0.5%, measured live 2026-09-08). It is a THIRD English status ladder next to
 *    "Lifecycle Stage" (100% filled) and "状态" (69% filled), and its presence is most of why the
 *    board's status columns are hard to tell apart.
 *
 * 2. "Priority" (monday's native High/Medium/Low) -> NO HubSpot field maps to it. Never written,
 *    never read, cannot ever populate. HubSpot's real priority is `priority__c` (优先级), a
 *    response-time SLA (P1_2小时内 … P4_持续跟进) which keeps its own column.
 *
 * NOT DELETED, deliberately: "Lifecycle Stage" and "状态" are the SAME eight-step ladder in English
 * and Chinese, but they have DRIFTED — sampling contacts at Lifecycle Stage "1.NEW" found one at
 * 状态 "7购买有意向". Each therefore holds assessments the other lacks. Reconciling them is a
 * data decision for the sales team, not a column deletion.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/remove-duplicate-crm-columns.mjs --plan
 *   MONDAY_API_TOKEN=<token> node scripts/remove-duplicate-crm-columns.mjs --apply
 *
 * Deleting a monday column deletes its cell data irreversibly, so --plan prints the live title,
 * type and a non-empty-cell count for each target and changes nothing. --apply refuses any column
 * whose cells are not all empty.
 */
const API = "https://api.monday.com/v2";
const CONTACTS = "5028000495";

export const TARGETS = [
  {
    id: "color_mm6zb4tc", expectTitle: "Lead Status",
    why: "hs_lead_status - 0.5% filled in HubSpot; third redundant English status ladder",
  },
  {
    id: null, matchTitle: "Priority", expectType: "status",
    why: "monday native High/Medium/Low - no HubSpot field maps to it, can never populate",
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

/** How many cards actually have a value in this column? Guards against deleting live data. */
export function countFilled(items, columnId) {
  let n = 0;
  for (const it of items) {
    const cell = (it.column_values ?? []).find(c => c.id === columnId);
    if (cell && cell.value !== null && cell.value !== undefined && cell.value !== "") n++;
  }
  return n;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }

  const board = (await gql(token,
    "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } "
    + "items_page(limit: 500) { items { id column_values { id value } } } } }",
    { b: [CONTACTS] })).boards[0];
  const items = board.items_page.items;
  console.log(`Contacts ${CONTACTS}: ${board.columns.length} columns, ${items.length} cards inspected\n`);

  for (const t of TARGETS) {
    const col = t.id
      ? board.columns.find(c => c.id === t.id)
      : board.columns.find(c => c.title === t.matchTitle && c.type === t.expectType);
    if (!col) { console.log(`  absent   ${t.id ?? t.matchTitle} - already gone, nothing to do`); continue; }
    if (t.expectTitle && col.title !== t.expectTitle) {
      console.log(`  SKIP     ${col.id} is titled "${col.title}", expected "${t.expectTitle}" - not touching it`);
      continue;
    }
    const filled = countFilled(items, col.id);
    if (!apply) {
      console.log(`  WOULD delete  ${col.id.padEnd(24)} ${col.type.padEnd(8)} "${col.title}"  ${filled} non-empty cell(s)`);
      console.log(`                 ${t.why}`);
      continue;
    }
    if (filled > 0) {
      console.log(`  REFUSED  ${col.id} "${col.title}" has ${filled} non-empty cell(s) - re-run --plan and decide deliberately`);
      continue;
    }
    await gql(token, "mutation ($b: ID!, $i: String!) { delete_column(board_id: $b, column_id: $i) { id } }",
      { b: CONTACTS, i: col.id });
    console.log(`  deleted  ${col.id.padEnd(24)} "${col.title}"`);
  }
  if (!apply) console.log("\n--plan only. Nothing deleted. Re-run with --apply.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("remove-duplicate-crm-columns.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
