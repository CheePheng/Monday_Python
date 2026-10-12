/**
 * Every column a CRM spec names must exist on its board. Read-only.
 *
 * THE INCIDENT THIS IS FOR (text_mm6sdvkq, 2026-09-08): monday rejects an ENTIRE
 * change_multiple_column_values mutation that names an unknown column. One spec field pointing at a
 * deleted column therefore does not degrade that one field — it stops EVERY card on that board from
 * updating, silently, because the Worker sees an error per card and nothing else changes.
 *
 * So whenever a column is deleted, this is the check that proves the deployment survived it. It
 * covers `fields[].col` and `associations[].relationCol` on all four CRM specs, plus the per-spec
 * bookkeeping columns (hubspotIdCol, syncStateCol and friends) that are named the same way.
 *
 *   node scripts/verify-spec-columns-exist.mjs
 *
 * Exits non-zero if anything is missing, so it can gate a deploy.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const API = "https://api.monday.com/v2";

function token() {
  if (process.env.MONDAY_API_TOKEN) return process.env.MONDAY_API_TOKEN;
  try {
    const line = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split(/\r?\n/).find(l => l.startsWith("MONDAY_API_TOKEN="));
    if (line) return line.slice("MONDAY_API_TOKEN=".length).trim().replace(/^"|"$/g, "");
  } catch { /* fall through */ }
  return "";
}

/** The specs come from the TypeScript source, so this checks what is actually deployed rather than a
 *  hand-maintained second copy of the column list. esbuild is already a dev dependency. */
async function loadSpecs() {
  const out = new URL("../.specs.bundle.mjs", import.meta.url);
  execFileSync(process.execPath, [
    new URL("../node_modules/esbuild/bin/esbuild", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    new URL("../src/config/crm.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    "--bundle", "--format=esm", "--platform=neutral", `--outfile=${out.pathname.replace(/^\/([A-Za-z]:)/, "$1")}`,
  ], { stdio: "pipe" });
  const mod = await import(out.href);
  fs.unlinkSync(out);
  return mod.CRM_SPECS;
}

/** Every column id a spec names, paired with where it was named (so a failure says what to fix). */
export function specColumnRefs(spec) {
  const refs = [];
  for (const f of spec.fields ?? []) if (f.col) refs.push({ col: f.col, where: `field ${f.hs}` });
  for (const a of spec.associations ?? [])
    if (a.relationCol) refs.push({ col: a.relationCol, where: `association -> ${a.toObject}` });
  // The bookkeeping columns, named on ObjectSpec rather than in `fields`. `idCol` is the dedup key and
  // `syncStateCol` the write watermark — if either went missing the board would not merely stop
  // updating, it would start creating duplicate cards.
  for (const key of ["idCol", "syncStateCol", "linkCol", "ownerCol", "followUpCol"])
    if (spec[key]) refs.push({ col: spec[key], where: key });
  if (spec.ownership?.col) refs.push({ col: spec.ownership.col, where: "ownership" });
  // The owner notice's two columns (ObjectSpec.ownerNotice): its 待通知 write names 通知状态, and a dead one stops
  // every notice the same way.
  if (spec.ownerNotice?.statusCol) refs.push({ col: spec.ownerNotice.statusCol, where: "ownerNotice.statusCol" });
  if (spec.ownerNotice?.lastToldCol) refs.push({ col: spec.ownerNotice.lastToldCol, where: "ownerNotice.lastToldCol" });
  return refs;
}

async function main() {
  const tok = token();
  if (!tok) { console.error("MONDAY_API_TOKEN is required (env or worker/.dev.vars)"); process.exit(1); }
  const specs = await loadSpecs();

  const ids = [...new Set(specs.map(s => String(s.boardId)))];
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: tok, "API-Version": "2026-07" },
    body: JSON.stringify({
      query: `query ($b: [ID!]) { boards(ids: $b) { id name columns { id title type } } }`,
      variables: { b: ids },
    }),
  });
  const body = await res.json();
  if (body.errors) { console.error(JSON.stringify(body.errors).slice(0, 400)); process.exit(1); }
  const byBoard = new Map(body.data.boards.map(b => [String(b.id), b]));

  let missing = 0;
  for (const spec of specs) {
    const board = byBoard.get(String(spec.boardId));
    if (!board) { console.log(`MISSING BOARD ${spec.boardId} for ${spec.object}`); missing++; continue; }
    const live = new Set(board.columns.map(c => c.id));
    const refs = specColumnRefs(spec);
    const bad = refs.filter(r => !live.has(r.col));
    console.log(`${bad.length ? "FAIL" : "ok  "}  ${String(spec.object).padEnd(11)} board ${spec.boardId} `
      + `"${board.name}"  ${refs.length} refs / ${board.columns.length} live columns`);
    for (const r of bad) { console.log(`        MISSING ${r.col}  (${r.where})`); missing++; }
  }

  if (missing) {
    console.log(`\n${missing} missing column reference(s). A deployment in this state stops every card`
      + " on the affected board from updating. Fix the spec BEFORE deploying.");
    process.exit(1);
  }
  console.log("\nEvery column referenced by every CRM spec exists on its board.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("verify-spec-columns-exist.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
