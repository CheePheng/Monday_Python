/**
 * Pre-deploy check: does every column the CRM specs reference still exist on the live boards?
 *
 * WHY THIS EXISTS. On 2026-09-08 the "Company name" column (text_mm6sdvkq) was deleted from the
 * Contacts board by someone working directly in monday, while CRM_CONTACTS still mapped `company` to
 * it. monday rejects a whole change_multiple_column_values mutation when it names an unknown column,
 * so that one dead reference would have stopped every Contact card from updating — and no unit test
 * could see it, because the board lives outside the repo.
 *
 * Board schemas change without touching git. Run this before any deploy, and after anyone edits a board.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/verify-crm-columns.mjs
 *
 * Exit 0 = every reference is live. Exit 1 = at least one dead reference (do not deploy).
 * Also lists live columns that nothing maps to, so "this stays empty" is a deliberate choice.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://api.monday.com/v2";

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

/** Column ids a spec block references, by role. Parsed from source so it cannot drift from the specs. */
export function columnRefs(specBlock) {
  const refs = new Map();
  const add = (id, role) => { if (id) refs.set(id, role); };
  for (const [, key, id] of specBlock.matchAll(/(idCol|syncStateCol|linkCol):\s*"([^"]+)"/g)) add(id, key);
  for (const [, id] of specBlock.matchAll(/relationCol:\s*"([^"]+)"/g)) add(id, "relationCol");
  for (const [, hs, id] of specBlock.matchAll(/\{ hs: "([^"]+)", col: "([^"]+)"/g)) add(id, `field ${hs}`);
  const adopt = specBlock.match(/adoptBy: \{ kind: "[a-z]+", col: "([^"]+)"/);
  if (adopt) add(adopt[1], "adoptBy");
  return refs;
}

function specBlock(src, name) {
  const i = src.indexOf(`export const ${name}`);
  if (i < 0) throw new Error(`spec ${name} not found`);
  return src.slice(i, src.indexOf("\n};", i));
}

const BOARDS = [
  { id: "5028000495", label: "Contacts", spec: "CRM_CONTACTS" },
  { id: "5028000496", label: "Accounts", spec: "CRM_ACCOUNTS" },
];

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }

  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "config", "crm.ts"), "utf8");
  let dead = 0;

  for (const b of BOARDS) {
    const refs = columnRefs(specBlock(src, b.spec));
    const cols = (await gql(token, "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }",
      { b: [b.id] })).boards[0].columns;
    const live = new Map(cols.map(c => [c.id, c]));

    console.log(`\nboard ${b.id} (${b.label}) — ${refs.size} references, ${cols.length} live columns`);
    for (const [id, role] of refs) {
      if (live.has(id)) console.log(`   ok    ${id.padEnd(26)} ${role.padEnd(24)} "${live.get(id).title}"`);
      else { console.log(`   DEAD  ${id.padEnd(26)} ${role.padEnd(24)} <-- COLUMN NO LONGER EXISTS`); dead++; }
    }
    const unmapped = cols.filter(c => !refs.has(c.id));
    if (unmapped.length) {
      console.log(`   -- ${unmapped.length} live column(s) nothing maps to (empty unless filled by hand):`);
      for (const c of unmapped) console.log(`      ${c.type.padEnd(15)} "${c.title}"`);
    }
  }

  if (dead) {
    console.error(`\nFAIL: ${dead} dead column reference(s). monday rejects an entire column-values ` +
      `mutation naming an unknown column, so affected cards would stop updating. Do not deploy.`);
    process.exit(1);
  }
  console.log("\nOK: every column the CRM specs reference exists on its board.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("verify-crm-columns.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
