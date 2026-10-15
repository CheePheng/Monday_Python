/**
 * Delete the Contacts columns that no HubSpot field can ever fill.
 *
 * "Priority" (status5, monday's native High/Medium/Low) -> NO HubSpot property maps to it, in either
 * direction. It is a board-template leftover: never written, never read, permanently blank. HubSpot's
 * real priority is `priority__c` (优先级), a response-time SLA (P1_2小时内 … P4_持续跟进) which has its
 * own column (color_mm70ahh7) with the exact 4 SLA labels. Same word, different concept, zero label
 * overlap - which is why they are two columns and only one of them is real.
 *
 * NOT DELETED, deliberately - all three status ladders stay:
 *   "Lifecycle Stage" (lifecyclestage, 100% filled) and "状态" (leadstatus, 69%) are the SAME
 *   eight-step ladder in English and Chinese, and they have DRIFTED - sampling contacts at Lifecycle
 *   Stage "1.NEW" found one at 状态 "7购买有意向". Each holds assessments the other lacks, so deleting
 *   either loses real data; reconciling them is a sales-team decision, not a column deletion.
 *   "Lead Status" (hs_lead_status) is only 0.5% filled and was briefly cut on that basis, which was
 *   wrong: it is PINNED TO THE CONTACT SIDEBAR in this portal. Sidebar membership is the portal
 *   owner's statement that the field is wanted, and it outranks today's fill rate.
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
    id: "status5", expectTitle: "Priority", expectType: "status",
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
