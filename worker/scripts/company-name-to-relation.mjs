/**
 * Make the Connect Boards relation THE "Company name" field on Contacts, and retire the text column.
 *
 * THE MEETING DECISION (2026-09-08). The Contacts board carried two columns answering "which company":
 * a free-text "Company name" (text_mm70apjj, mirroring HubSpot's `company` string) and a Connect Boards
 * relation titled "Accounts" (contact_account) holding the real, clickable link to the Account card.
 * The text one cannot be clicked, filtered against the Accounts board, or kept honest. The relation
 * becomes the single answer and takes the clearer name.
 *
 * ORDER IS LOAD-BEARING, and this repo has the scar. monday rejects an ENTIRE
 * change_multiple_column_values mutation that names an unknown column, so a spec field pointing at a
 * deleted column freezes EVERY card on the board — the text_mm6sdvkq incident. So:
 *
 *   1. remove the `company` mapping from CRM_CONTACTS                     <- done in code
 *   2. remove its now-orphaned HubSpot propertyChange subscription        <- done in the app manifest
 *   3. deploy, so the LIVE worker no longer references the column         <- done before running this
 *   4. only then delete the column, and rename the relation               <- THIS SCRIPT
 *
 * The script REFUSES to run if step 1 was skipped: it greps the built spec for the column id first.
 *
 * HubSpot's `company` property is NOT touched. HubSpot still owns and populates it, and it is still
 * what auto-creates companies from an email domain. Only the monday mirror goes away.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/company-name-to-relation.mjs --plan
 *   MONDAY_API_TOKEN=<token> node scripts/company-name-to-relation.mjs --apply
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.monday.com/v2";
const CONTACTS = "5028000495";
const ACCOUNTS = "5028000496";
const TEXT_COL = "text_mm70apjj";        // the free-text "Company name" being retired
const RELATION_COL = "contact_account";  // the Connect Boards relation being renamed
const NEW_TITLE = "Company name";

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

/** Executable code only — a comment naming the retired column is documentation, not a reference. */
export function specStillReferences(src, colId) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return code.includes(colId);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }

  // GUARD: never delete a column the shipped spec still names.
  const specPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "config", "crm.ts");
  if (specStillReferences(readFileSync(specPath, "utf8"), TEXT_COL)) {
    console.error(`ABORT: src/config/crm.ts still references ${TEXT_COL} in executable code.`);
    console.error("Remove the mapping and DEPLOY before deleting the column, or every card on the");
    console.error("board stops updating (monday rejects the whole mutation on an unknown column).");
    process.exit(1);
  }
  console.log(`spec check: no executable reference to ${TEXT_COL} — safe to proceed\n`);

  const board = (await gql(token,
    "query ($b: [ID!]) { boards(ids: $b) { columns { id title type settings_str } "
    + "items_page(limit: 500) { items { id name column_values { id text } } } } }",
    { b: [CONTACTS] })).boards[0];
  const text = board.columns.find(c => c.id === TEXT_COL);
  const rel = board.columns.find(c => c.id === RELATION_COL);
  if (!rel) { console.error(`ABORT: relation column ${RELATION_COL} not found`); process.exit(1); }

  // The relation must actually point at the Accounts board, or renaming it to "Company name" would be
  // a lie and the association writes would land nowhere useful.
  const boardIds = (() => { try { return JSON.parse(rel.settings_str || "{}").boardIds ?? []; } catch { return []; } })();
  if (!boardIds.map(String).includes(ACCOUNTS)) {
    console.error(`ABORT: ${RELATION_COL} points at ${JSON.stringify(boardIds)}, not the Accounts board ${ACCOUNTS}`);
    process.exit(1);
  }
  console.log(`relation ${RELATION_COL} "${rel.title}" -> Accounts board ${ACCOUNTS}  OK`);

  const filled = text
    ? board.items_page.items
        .map(it => ({ name: it.name, v: (it.column_values.find(c => c.id === TEXT_COL) || {}).text }))
        .filter(x => x.v)
    : [];
  console.log(`text column ${TEXT_COL}: ${text ? `present, ${filled.length}/${board.items_page.items.length} filled` : "already gone"}`);
  for (const f of filled.slice(0, 10)) console.log(`   "${f.name}" = ${JSON.stringify(f.v)}`);
  if (filled.length) console.log("   (these values remain in HubSpot's `company` property — nothing is lost)");

  if (!apply) {
    if (text) console.log(`\nWOULD delete ${TEXT_COL}`);
    if (rel.title !== NEW_TITLE) console.log(`WOULD rename ${RELATION_COL} "${rel.title}" -> "${NEW_TITLE}" (id preserved)`);
    console.log("\n--plan only. Nothing changed. Re-run with --apply.");
    return;
  }

  // Rename FIRST: if the rename fails we still have both columns and a clear board, rather than a
  // board with neither a text column nor a correctly-named relation.
  if (rel.title !== NEW_TITLE) {
    await gql(token,
      "mutation ($b: ID!, $i: String!, $t: String!) { change_column_title(board_id: $b, column_id: $i, title: $t) { id title } }",
      { b: CONTACTS, i: RELATION_COL, t: NEW_TITLE });
    console.log(`\nrenamed ${RELATION_COL} "${rel.title}" -> "${NEW_TITLE}"`);
  }
  if (text) {
    await gql(token, "mutation ($b: ID!, $i: String!) { delete_column(board_id: $b, column_id: $i) { id } }",
      { b: CONTACTS, i: TEXT_COL });
    console.log(`deleted ${TEXT_COL} (the free-text Company name)`);
  }
  console.log(`\nContacts board now answers "which company" once, as a link to board ${ACCOUNTS}.`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("company-name-to-relation.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
