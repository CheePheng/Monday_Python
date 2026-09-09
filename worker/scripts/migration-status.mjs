/**
 * One command for "where is the migration right now?".
 *
 * Replaces the ad-hoc queries this migration kept needing — import progress, failure breakdown by
 * REASON rather than a bare count, placeholder-named cards still outstanding, and whether an importer
 * or rename process is actually alive. Written as a file rather than inline because inline GraphQL in
 * a shell string had its "$" escaping mangled once already, and monday answered with an HTML error
 * page that was very hard to read.
 *
 *   node scripts/migration-status.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
try {
  for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* fall back to env */ }
const M = v.MONDAY_API_TOKEN ?? process.env.MONDAY_API_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Retries, and treats a MISSING `data` as retryable rather than crashing.
 *
 * Needed because a status check runs while two importers and a rename pass are already hammering
 * monday, so transient throttling is normal. monday does not always answer with a GraphQL error
 * object either — under load it can return an HTML error page, which parses to {} and made the first
 * version of this script die on `b.data.boards`. A read-only status tool must never be the thing
 * that fails.
 */
const monday = async (query, variables = {}, attempt = 0) => {
  let b = {};
  try {
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: M, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }),
    });
    b = await r.json().catch(() => ({}));
  } catch { /* network blip: fall through to the retry below */ }
  if (!b.data) {
    if (attempt < 6) { await sleep(2000 * 2 ** attempt); return monday(query, variables, attempt + 1); }
    throw new Error(`monday returned no data after retries: ${JSON.stringify(b.errors ?? b).slice(0, 200)}`);
  }
  return b.data;
};

function state(object) {
  const p = join(ROOT, "scripts", `.backfill-${object}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function processes() {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'backfill-crm|rename-placeholder|supervise-migration' } | " +
      "ForEach-Object { ($_.CommandLine -split '\\\\')[-1] }"], { encoding: "utf8", timeout: 30000 });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return ["(process check unavailable)"]; }
}

const TOTALS = { contacts: 94318, companies: 26174 };

console.log("=== RUNNING PROCESSES ===");
for (const p of processes()) console.log("  " + p);
if (!processes().length) console.log("  (none)");

for (const object of ["companies", "contacts"]) {
  const s = state(object);
  console.log(`\n=== ${object.toUpperCase()} IMPORT ===`);
  if (!s) { console.log("  no state file"); continue; }
  const mins = (Date.now() - Date.parse(s.startedAt)) / 60000;
  const rate = s.created / Math.max(1, mins);
  const failed = (s.failed ?? []).length;
  console.log(`  created ${s.created}   scanned ${s.scanned}/${TOTALS[object]}`
    + `  (${((100 * s.scanned) / TOTALS[object]).toFixed(1)}%)   skipped ${s.skipped}`);
  console.log(`  failed  ${failed}   rate ${rate.toFixed(0)}/min   cursor ${s.after ? "active" : "EXHAUSTED"}`);
  if (s.after) console.log(`  ETA     ${((TOTALS[object] - s.scanned) / rate / 60).toFixed(1)} h at this rate`);
  if (failed) {
    const kinds = new Map();
    for (const f of s.failed) {
      const r = String(f.reason);
      const k = /invalid value/.test(r) ? "monday rejected a column value (phone class)"
        : /http 4\d\d/.test(r) ? r.slice(0, 70) : r.slice(0, 70);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    console.log(`  failure reasons:`);
    for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${n}x  ${k}`);
  }
}

// Placeholder-named cards left, per board. This is the rename pass's real progress measure — its own
// stdout is buffered when piped, so the board is the source of truth.
const BOARDS = [
  { id: "5028000496", label: "Accounts", re: /^companies \d+$/ },
  { id: "5028000495", label: "Contacts", re: /^contacts \d+$/ },
];
for (const b of BOARDS) {
  let cursor = null, total = 0, placeholder = 0;
  do {
    const page = (await monday(
      `query ($b: ID!, $c: String) { boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
         cursor items { name } } } }`, { b: b.id, c: cursor })).boards[0].items_page;
    for (const it of page.items) { total++; if (b.re.test(it.name.trim())) placeholder++; }
    cursor = page.cursor;
  } while (cursor);
  console.log(`\n=== ${b.label} BOARD (${b.id}) ===`);
  console.log(`  ${total} cards, ${placeholder} still placeholder-named`);
}
