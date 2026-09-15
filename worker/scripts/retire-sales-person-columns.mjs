/**
 * Retire the three assignment columns the team stopped using — Contacts board 5028000495.
 *
 * 2026-09-15, after the requirements meeting: sales assignment happens on "Sales User" and nothing
 * else. These three go:
 *
 *   multiple_person_mm76qtz7  "Sales Person"           people    <- hs sales_person, built 2026-09-14
 *   color_mm701ff2            "Sales Person (legacy)"  status    <- hs sales_person, the original
 *   dropdown_mm70mxfy         "Sales User (legacy)"    dropdown  <- hs sales_user, superseded
 *
 * THIS SCRIPT DESTROYS CELL DATA ON PURPOSE, which is exactly why it is not part of
 * remove-duplicate-crm-columns.mjs: that script refuses any column with a non-empty cell, and that
 * guard is correct for the accidental-leftover columns it was written for. These three are full
 * (~6.4k, ~6.5k and ~48.9k cells respectively) and are being discarded deliberately. Keeping the two
 * scripts apart keeps the safe default safe.
 *
 * WHAT IS *NOT* DESTROYED: HubSpot's `sales_person` property. 6,543 contacts still carry it and this
 * script makes no HubSpot call of any kind. The monday columns were a projection of it; deleting a
 * projection is not deleting the source. If the team ever wants Sales Person back on a board, the
 * data to rebuild it from is still in HubSpot.
 *
 * ORDER, and the reason this script refuses to run out of order:
 *   1. board permission re-pointed at Contact owner + Sales User   <- guarded below, live
 *   2. the three mappings removed from src/config/crm.ts
 *   3. the CRM Worker DEPLOYED without them                        <- must be done before step 4
 *   4. this script
 * Step 3 before step 4 is not a preference. monday rejects an ENTIRE
 * change_multiple_column_values mutation that names an unknown column, so a deployed spec pointing at
 * a deleted column stops every card on the board from updating — the text_mm6sdvkq incident,
 * 2026-09-08. A script cannot check what a Worker has deployed, so that step is on the operator; the
 * two preconditions that CAN be checked mechanically are checked.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/retire-sales-person-columns.mjs            # plan only
 *   MONDAY_API_TOKEN=<token> node scripts/retire-sales-person-columns.mjs --apply
 */
import fs from "node:fs";

const API = "https://api.monday.com/v2";
const CONTACTS = "5028000495";

/** The column that assignment moved TO. Deleting a column still named here would narrow who can edit
 *  what, so its presence in the live permission is the precondition, not an assumption. */
const KEEP = { salesUser: "multiple_person_mm76ygkp", contactOwner: "multiple_person_mm6zap53" };

export const TARGETS = [
  { id: "multiple_person_mm76qtz7", expectTitle: "Sales Person",          expectType: "people",
    why: "People column built 2026-09-14 for permissions; superseded before it was ever used for them" },
  { id: "color_mm701ff2",           expectTitle: "Sales Person (legacy)", expectType: "status",
    why: "the original 4-option Sales Person status; unmapped since the People migration" },
  { id: "dropdown_mm70mxfy",        expectTitle: "Sales User (legacy)",   expectType: "dropdown",
    why: "the owner-id dropdown Sales User used before it became a People column" },
];

function token() {
  if (process.env.MONDAY_API_TOKEN) return process.env.MONDAY_API_TOKEN;
  // Same convention as the other scripts here: the token lives only in git-ignored .dev.vars.
  try {
    const line = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split(/\r?\n/).find(l => l.startsWith("MONDAY_API_TOKEN="));
    if (line) return line.slice("MONDAY_API_TOKEN=".length).trim().replace(/^"|"$/g, "");
  } catch { /* fall through to the error below */ }
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

/**
 * The live assignee columns, read from the board's own most recent `update_board_permissions` event.
 * The Board type exposes `permissions` as a bare string ("assignee") and nothing else — the column
 * list is UI-only state, so the activity log is the only machine-readable source for it.
 * Returns null when no such event is in range, which the caller must treat as "cannot verify".
 */
export function assigneeColumnsFromLogs(logs) {
  for (const l of logs) {                       // activity_logs comes back newest-first
    if (l.event !== "update_board_permissions") continue;
    try {
      const d = JSON.parse(l.data);
      const cols = d?.value?.assignee_column_titles;
      if (Array.isArray(cols)) return { columns: cols.map(String), at: l.created_at };
    } catch { /* a malformed entry is not the newest state; keep looking */ }
  }
  return null;
}

/** How many of the sampled cards have a value here. A SAMPLE, not a total — see the caller's label. */
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
  const tok = token();
  if (!tok) { console.error("MONDAY_API_TOKEN is required (env or worker/.dev.vars)"); process.exit(1); }

  const data = await gql(tok,
    "query ($b: [ID!]) { boards(ids: $b) { name permissions columns { id title type } "
    + "activity_logs(limit: 200) { event created_at data } "
    + "items_page(limit: 500) { items { id column_values { id value } } } } }",
    { b: [CONTACTS] });
  const board = data.boards[0];
  const items = board.items_page.items;
  console.log(`Contacts ${CONTACTS} "${board.name}"  permissions=${board.permissions}`);
  console.log(`${board.columns.length} columns, ${items.length} cards sampled\n`);

  // PRECONDITION 1 — the permission must already point somewhere else.
  const perm = assigneeColumnsFromLogs(board.activity_logs ?? []);
  if (!perm) {
    console.log("CANNOT VERIFY the assignee columns: no update_board_permissions event in the last 200"
      + " activity entries. Re-point the permission in the UI (which writes one), or widen the limit.");
    if (apply) process.exit(1);
  } else {
    const ts = new Date(Number(perm.at) / 10000).toISOString();
    console.log(`assignee columns (set ${ts}): ${perm.columns.join(", ")}`);
    const stillUsed = TARGETS.filter(t => perm.columns.includes(t.id));
    if (stillUsed.length) {
      console.log(`\nREFUSING: ${stillUsed.map(t => t.id).join(", ")} still grant edit access. Deleting`
        + " one would silently narrow who can edit this board. Change the permission first.");
      process.exit(1);
    }
    for (const [name, id] of Object.entries(KEEP))
      if (!perm.columns.includes(id))
        console.log(`  note: ${name} (${id}) is NOT an assignee column`);
  }

  // PRECONDITION 2 — each target must still be the column this script thinks it is.
  console.log("");
  const doomed = [];
  for (const t of TARGETS) {
    const col = board.columns.find(c => c.id === t.id);
    if (!col) { console.log(`  absent   ${t.id} — already gone, nothing to do`); continue; }
    if (col.title !== t.expectTitle || col.type !== t.expectType) {
      console.log(`  SKIP     ${col.id} is ${col.type} "${col.title}", expected ${t.expectType} `
        + `"${t.expectTitle}" — not touching it`);
      continue;
    }
    const filled = countFilled(items, col.id);
    const pct = items.length ? ((filled / items.length) * 100).toFixed(0) : "?";
    console.log(`  ${apply ? "DELETING" : "WOULD delete"}  ${col.id.padEnd(26)} ${col.type.padEnd(9)} `
      + `"${col.title}"  ~${pct}% filled (${filled}/${items.length} sampled)`);
    console.log(`                 ${t.why}`);
    doomed.push(col);
  }

  if (!apply) {
    console.log("\n--plan only. Nothing deleted. Cell data on these columns is destroyed by --apply;"
      + " HubSpot's sales_person property is not touched either way.");
    return;
  }
  for (const col of doomed) {
    await gql(tok, "mutation ($b: ID!, $i: String!) { delete_column(board_id: $b, column_id: $i) { id } }",
      { b: CONTACTS, i: col.id });
    console.log(`  deleted  ${col.id.padEnd(26)} "${col.title}"`);
  }
  console.log(`\n${doomed.length} column(s) deleted.`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("retire-sales-person-columns.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
