/**
 * Does every CRM mapping write a payload the live monday column can actually accept?
 *
 * A dead column id is caught by verify-crm-columns.mjs. This catches the other half: a column that
 * EXISTS but whose TYPE cannot hold what formatValue emits. Both are silent in unit tests, because
 * the spec's declared type is checked against nothing real.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/audit-crm-column-types.mjs
 *
 * Exit 0 = every mapping is type-compatible. Exit 1 = at least one would fail at write time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** What each FieldSpec type emits (mapping.ts formatValue) -> which monday column types accept it. */
const ACCEPTS = {
  text:      ["text", "long-text", "long_text"],
  long_text: ["long_text", "long-text"],
  numbers:   ["numbers", "numeric"],
  status:    ["status", "color"],
  dropdown:  ["dropdown"],
  date:      ["date"],
  people:    ["people", "multiple-person", "multiple_person"],
  phone:     ["phone"],
  email:     ["email"],
  link:      ["link"],
};

const SPECS = [
  { name: "CRM_CONTACTS", board: "5028000495", label: "Contacts" },
  { name: "CRM_ACCOUNTS", board: "5028000496", label: "Accounts" },
];

async function gql(token, query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

export function parseFields(specBlock) {
  return [...specBlock.matchAll(/\{ hs: "([^"]+)", col: "([^"]+)", type: "([^"]+)"([^}]*)\}/g)]
    .map(([, hs, col, type, rest]) => ({
      hs, col, type,
      dir: /reverse: true/.test(rest) ? "two-way"
        : /appReverse: true/.test(rest) ? "app-save" : "->monday",
      labels: (rest.match(/labels: "([^"]+)"/) || [])[1],
    }));
}

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "config", "crm.ts"), "utf8");
  let bad = 0;

  for (const s of SPECS) {
    const i = src.indexOf(`export const ${s.name}`);
    const fields = parseFields(src.slice(i, src.indexOf("\n};", i)));
    const cols = (await gql(token, "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }",
      { b: [s.board] })).boards[0].columns;
    const live = new Map(cols.map(c => [c.id, c]));

    console.log(`\n=== ${s.label} (${s.board}) — ${fields.length} field mappings ===`);
    for (const f of fields) {
      const col = live.get(f.col);
      if (!col) { console.log(`  DEAD      ${f.hs.padEnd(28)} ${f.col} does not exist`); bad++; continue; }
      const ok = (ACCEPTS[f.type] ?? []).includes(col.type);
      const mark = ok ? "ok  " : "TYPE";
      if (!ok) bad++;
      console.log(`  ${mark}      ${f.hs.padEnd(28)} spec=${f.type.padEnd(10)} monday=${col.type.padEnd(16)}`
        + `${f.dir.padEnd(9)} "${col.title}"${f.labels ? `  [${f.labels}]` : ""}`);
    }
  }

  if (bad) { console.error(`\nFAIL: ${bad} mapping(s) would fail at write time.`); process.exit(1); }
  console.log("\nOK: every mapping is type-compatible with its live monday column.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("audit-crm-column-types.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
