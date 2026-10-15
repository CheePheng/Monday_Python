/**
 * Move named Contacts cards out of "No Activity - 未跟进" into "Active Contacts", with an audit record.
 *
 * One-off repair for cards that were worked while sitting in No Activity, under the rule agreed on
 * 2026-10-09: a card leaves No Activity when its owner sends an outbound email or makes a call, or a
 * person moves Lifecycle off 1.NEW or sets a Lead Status. Each card is re-read live and moved only if it
 * is STILL in No Activity -- a card someone already moved is left alone.
 *
 *   node scripts/release-no-activity.mjs <itemId,itemId,...> [--apply] [--out <file.json>]
 *
 * Dry run unless --apply. Moves only; never edits a column, never touches HubSpot.
 */
import fs from "node:fs";

const BOARD = "5028000495";
const NO_ACTIVITY = "group_mm7cj2yx";
const ACTIVE = "topics";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const outAt = argv.indexOf("--out");
const OUT = outAt >= 0 ? argv[outAt + 1] : null;
const ids = (argv.find(a => /^\d+(,\d+)*$/.test(a)) ?? "").split(",").filter(Boolean);
if (!ids.length) { console.error("usage: release-no-activity.mjs <itemId,...> [--apply] [--out file]"); process.exit(2); }

const v = {};
for (const l of fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gql(query, variables) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json().catch(() => null);
    if (j?.data && !j.errors) return j.data;
    await sleep(3000 * (a + 1));
  }
  throw new Error("monday call failed");
}

const d = await gql(`query ($i: [ID!]) { items(ids: $i, limit: 100) { id board { id } group { id } } }`, { i: ids });
const record = { at: new Date().toISOString(), apply: APPLY, board: BOARD, from: NO_ACTIVITY, to: ACTIVE, results: [] };
for (const id of ids) {
  const it = d.items.find(x => x.id === id);
  if (!it) { record.results.push({ id, action: "skip", reason: "not found" }); continue; }
  if (it.board.id !== BOARD) { record.results.push({ id, action: "skip", reason: "not on the Contacts board" }); continue; }
  if (it.group.id !== NO_ACTIVITY) { record.results.push({ id, action: "skip", reason: `already in ${it.group.id}` }); continue; }
  if (!APPLY) { record.results.push({ id, action: "would-move" }); continue; }
  await gql(`mutation ($i: ID!, $g: String!) { move_item_to_group(item_id: $i, group_id: $g) { id } }`, { i: id, g: ACTIVE });
  record.results.push({ id, action: "moved" });
  await sleep(300);
}
for (const r of record.results) console.log(r.id, r.action, r.reason ?? "");
if (OUT) fs.writeFileSync(OUT, JSON.stringify(record, null, 1));
console.log(APPLY ? "APPLIED" : "DRY RUN -- nothing moved");
