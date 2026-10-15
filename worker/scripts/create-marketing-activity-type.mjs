/**
 * CREATE the monday custom activity type "HubSpot Marketing Email" -- once, on purpose.
 *
 * create_timeline_item requires a custom_activity_id, so marketing email entries need a type of their
 * own. Filing them under "HubSpot Email" would put automated marketing sends beside the sequence copies
 * of the same campaign under one label -- the very confusion the separate type exists to end. The
 * existing five types were made through this same API mutation; no UI step is needed.
 *
 * DRY BY DEFAULT: without --apply it only READS the account's custom activities and says what it would
 * do. It is idempotent -- if a type with this exact name already exists it prints that id and creates
 * nothing, so a second run cannot make a twin.
 *
 * After --apply, paste the printed id into MARKETING_ACTIVITY_TYPE_ID in src/activities.ts. Until then
 * the marketing poller refuses to write, and says so in its log.
 *
 *   node scripts/create-marketing-activity-type.mjs            # dry run: read and report
 *   node scripts/create-marketing-activity-type.mjs --apply    # create it (a monday account-wide write)
 *
 * Needs MONDAY_API_TOKEN in worker/.dev.vars. Prints no secrets.
 */
import { readFileSync } from "node:fs";

const NAME = "HubSpot Marketing Email";
// Enum values verified against the live schema 2026-09-30 (CustomActivityIcon / CustomActivityColor).
// PAPERPLANE: it is mail that was sent. MEDIUM_TURQUOISE: distinct from HubSpot Email's CELTIC_BLUE.
const ICON = "PAPERPLANE";
const COLOR = "MEDIUM_TURQUOISE";
const APPLY = process.argv.includes("--apply");

const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
const TOKEN = env.MONDAY_API_TOKEN;
if (!TOKEN) { console.error("MONDAY_API_TOKEN is missing from worker/.dev.vars"); process.exit(1); }

async function gql(query, variables = {}) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { Authorization: TOKEN, "Content-Type": "application/json", "API-Version": "2024-10" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errors || body.error_message)
    throw new Error(`monday ${r.status}: ${JSON.stringify(body.errors ?? body.error_message ?? body).slice(0, 300)}`);
  return body.data;
}

async function main() {
  const existing = (await gql("query { custom_activity { id name icon_id color } }")).custom_activity ?? [];
  console.log(`custom activity types on this account: ${existing.length}`);
  for (const t of existing) console.log(`  ${t.id}  ${t.name}  (${t.icon_id}, ${t.color})`);

  const same = existing.filter(t => String(t.name).trim() === NAME);
  if (same.length) {
    console.log(`\n"${NAME}" already exists${same.length > 1 ? ` ${same.length} TIMES -- pick one and delete the rest` : ""}: ${same.map(t => t.id).join(", ")}`);
    console.log(`Set MARKETING_ACTIVITY_TYPE_ID = "${same[0].id}" in src/activities.ts. Nothing created.`);
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY RUN: would create "${NAME}" (icon ${ICON}, color ${COLOR}). Re-run with --apply to create it.`);
    return;
  }

  const created = (await gql(
    `mutation ($n: String!) { create_custom_activity(name: $n, icon_id: ${ICON}, color: ${COLOR}) { id name } }`,
    { n: NAME })).create_custom_activity;
  console.log(`\ncreated "${created?.name}": ${created?.id}`);
  console.log(`Now set MARKETING_ACTIVITY_TYPE_ID = "${created?.id}" in src/activities.ts, and the drift-checked`);
  console.log("copies stay untouched: the repair scripts deliberately do not list the marketing type.");
}

main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
