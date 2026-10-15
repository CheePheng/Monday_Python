/**
 * READ-ONLY. Is the WM ownership guard inert TODAY?
 *
 * The guard changes WM's behaviour only for records whose sync_owner is "crm" or "hold", and for
 * UNSTAMPED records created after CRM_CUTOVER_AT. The cutover is in the future, so if nothing is
 * stamped yet, deploying the guard today is a behavioural no-op on WM and the deploy can be observed
 * for stability BEFORE the cutover makes it load-bearing. That is a much safer sequence than
 * deploying the guard and the cutover on the same day.
 *
 * This script is the evidence for that claim rather than the assumption. It also answers the reverse
 * question -- whether the sync_owner property even EXISTS in HubSpot -- because a guard that reads a
 * property that is not there behaves differently from one that reads an empty one.
 *
 * Writes nothing. Prints no secrets.
 *
 *   node scripts/wm-guard-preflight.mjs
 */
import { readFileSync } from "node:fs";
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
const TOKEN = v.HUBSPOT_ACCESS_TOKEN ?? process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) { console.error("no HubSpot token available"); process.exit(1); }

const hs = async (path, init = {}) => {
  const r = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await r.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* non-JSON error page */ }
  return { status: r.status, json, body };
};

/** Does the property exist at all, and what are its options? */
async function propertyState(object) {
  const { status, json } = await hs(`/crm/v3/properties/${object}/sync_owner`);
  if (status === 404) return { exists: false };
  if (status !== 200) return { exists: null, status };
  return {
    exists: true,
    type: json?.type,
    options: (json?.options ?? []).map(o => o.value),
  };
}

/**
 * Count records per sync_owner value.
 *
 * Uses SEARCH with a total-only read (limit 1) because we want counts, not records -- and search's
 * `total` is reliable for a count even though its RESULT SET silently caps at 10,000. That cap burned
 * this project once already (an 18,598-"dead id" report that would have deleted valid Accounts), so:
 * we read `total` and never paginate here.
 */
async function countBy(object, value) {
  const filter = value === null
    ? { propertyName: "sync_owner", operator: "NOT_HAS_PROPERTY" }
    : { propertyName: "sync_owner", operator: "EQ", value };
  const { status, json, body } = await hs(`/crm/v3/objects/${object}/search`, {
    method: "POST",
    body: JSON.stringify({ filterGroups: [{ filters: [filter] }], limit: 1, properties: ["hs_object_id"] }),
  });
  if (status !== 200) return { error: `${status} ${body.slice(0, 120)}` };
  return { total: json?.total ?? 0 };
}

const OBJECTS = ["contacts", "companies", "deals"];

console.log("WM OWNERSHIP-GUARD PREFLIGHT  (read-only)\n");

for (const object of OBJECTS) {
  const prop = await propertyState(object);
  if (prop.exists === false) {
    console.log(`${object.padEnd(10)} sync_owner property: ABSENT`);
    console.log(`${"".padEnd(10)}  -> every record reads as unstamped; guard falls back to the cutover date\n`);
    continue;
  }
  if (prop.exists === null) {
    console.log(`${object.padEnd(10)} sync_owner property: UNREADABLE (http ${prop.status})\n`);
    continue;
  }

  const [crm, wm, hold, blank] = await Promise.all([
    countBy(object, "crm"), countBy(object, "wm"), countBy(object, "hold"), countBy(object, null),
  ]);
  const fmt = r => (r.error ? `ERR ${r.error}` : String(r.total));
  console.log(`${object.padEnd(10)} sync_owner: present (${prop.type}) options=[${prop.options.join(",")}]`);
  console.log(`${"".padEnd(10)}  crm=${fmt(crm)}  wm=${fmt(wm)}  hold=${fmt(hold)}  unstamped=${fmt(blank)}`);

  const claimed = (crm.total ?? 0) + (hold.total ?? 0);
  console.log(`${"".padEnd(10)}  -> records whose WM behaviour the guard CHANGES today: ${claimed}`);
  console.log("");
}

console.log("Reading: a zero in the last line for every object means the guard is behaviourally");
console.log("inert on WM until CRM_CUTOVER_AT, so the deploy can be proven stable before it matters.");
