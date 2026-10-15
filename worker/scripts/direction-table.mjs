/**
 * Which CRM fields are actually TWO-WAY, and which are one-way?
 *
 * Exists because "I edited it in monday and nothing happened" is almost never a broken pipeline — it is
 * usually a field that was never reverse-enabled. Printing the real answer from the spec, cross-checked
 * against the live board, settles that in one command instead of a code read.
 *
 * Direction is decided by the FieldSpec flags:
 *   reverse: true     -> a monday edit is pushed to HubSpot on any webhook
 *   appReverse: true  -> pushed ONLY on an explicit app save, never a passive reconcile
 *   oneWay: true      -> HubSpot -> monday only, and a monday edit does not even trigger a reconcile
 *   (no flag)         -> HubSpot -> monday only; a monday edit triggers a reconcile that overwrites it
 *
 * The last case is the one that surprises people: the edit is not ignored, it is REVERTED, because the
 * forward write restores HubSpot's value.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/direction-table.mjs
 *   MONDAY_API_TOKEN=<token> node scripts/direction-table.mjs --markdown
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.monday.com/v2";
const SPECS = [
  { name: "CRM_CONTACTS", board: "5028000495", label: "Contacts" },
  { name: "CRM_ACCOUNTS", board: "5028000496", label: "Accounts" },
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

/** Parse the FieldSpec literals out of the spec source, including their direction flags. */
export function parseFields(block) {
  return [...block.matchAll(/\{ hs: "([^"]+)", col: "([^"]+)", type: "([^"]+)"([^}]*)\}/g)]
    .map(([, hs, col, type, rest]) => ({
      hs, col, type,
      reverse: /reverse: true/.test(rest),
      appReverse: /appReverse: true/.test(rest),
      oneWay: /oneWay: true/.test(rest),
    }));
}

export function directionOf(f) {
  if (f.reverse) return { fwd: "yes", rev: "YES" };
  if (f.appReverse) return { fwd: "yes", rev: "app save only" };
  if (f.oneWay) return { fwd: "yes", rev: "no (edit ignored)" };
  return { fwd: "yes", rev: "no (edit REVERTED)" };
}

async function main() {
  const md = process.argv.includes("--markdown");
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "config", "crm.ts"), "utf8");

  for (const s of SPECS) {
    const i = src.indexOf(`export const ${s.name}`);
    const fields = parseFields(src.slice(i, src.indexOf("\n};", i)));
    const cols = (await gql(token, "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }",
      { b: [s.board] })).boards[0].columns;
    const live = new Map(cols.map(c => [c.id, c]));

    const rows = fields.map(f => {
      const c = live.get(f.col);
      const d = directionOf(f);
      return { hs: f.hs, col: f.col, title: c ? c.title : "*** COLUMN MISSING ***", type: c?.type ?? f.type, ...d };
    });
    const twoWay = rows.filter(r => r.rev === "YES");

    if (md) {
      console.log(`\n### ${s.label} — ${rows.length} mapped fields, ${twoWay.length} two-way\n`);
      console.log("| HubSpot property | monday column | type | HubSpot→monday | monday→HubSpot |");
      console.log("|---|---|---|---|---|");
      for (const r of rows)
        console.log(`| \`${r.hs}\` | ${r.title} | ${r.type} | ${r.fwd} | ${r.rev === "YES" ? "**YES**" : r.rev} |`);
    } else {
      console.log(`\n=== ${s.label} (${s.board}) — ${rows.length} mapped fields, ${twoWay.length} TWO-WAY ===`);
      for (const r of rows)
        console.log(`  ${r.rev === "YES" ? "<->" : " ->"}  ${r.hs.padEnd(28)}${String(r.title).padEnd(30)}${r.type.padEnd(12)}${r.rev}`);
    }

    // Columns on the board that NO mapping touches: edit them and nothing syncs, in either direction.
    const mapped = new Set(fields.map(f => f.col));
    const structural = new Set(["name", "subtasks", "unsupported", "board_relation", "mirror", "doc"]);
    const unmapped = cols.filter(c => !mapped.has(c.id) && !structural.has(c.type) && c.type !== "name");
    if (unmapped.length && !md) {
      console.log(`\n  UNMAPPED columns on this board (${unmapped.length}) — edits here sync NOWHERE:`);
      for (const c of unmapped) console.log(`       ${c.id.padEnd(26)}${c.type.padEnd(14)}${JSON.stringify(c.title)}`);
    }
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("direction-table.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
