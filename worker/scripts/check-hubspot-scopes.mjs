/**
 * What can the HubSpot private-app token actually read? READ-ONLY.
 *
 * WHY THIS EXISTS. On 2026-09-15 the CRM Worker was deployed carrying the Deals and Line Items specs
 * for the first time. buildCtx loads a label dictionary for every dictionary any spec references, so
 * from that deploy on EVERY contact webhook began fetching deal pipelines and deal property schemas —
 * and the token has no deals scopes. The fetch threw, the throw escaped, and every contact webhook
 * ended in action=error. Live Contacts sync stopped on a deploy that changed nothing about Contacts.
 *
 * A missing scope is invisible until something reads it, so read everything the specs will read and
 * report it as a table. Run this BEFORE deploying a spec for a new object, and before the Deals
 * historical import — which needs the same scopes from a script instead of from the Worker.
 *
 *   node scripts/check-hubspot-scopes.mjs
 */
import fs from "node:fs";

const env = Object.fromEntries(fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split(/\r?\n/).filter(l => l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));

/**
 * IT MUST BE THE DEPLOYED APP'S TOKEN, AND NOTHING ELSE.
 *
 * This script existed during the 2026-09-15 outage and did not prevent it, for a reason worth stating
 * plainly: it probed `HUBSPOT_ACCESS_TOKEN` from .dev.vars, which belongs to a DIFFERENT, BROADER
 * HubSpot app than the one the CRM Worker runs as. It would have reported "every read the CRM specs
 * make is permitted" while the deployed Worker was 403ing on every webhook. A preflight that checks
 * the wrong credential is worse than no preflight: it manufactures confidence.
 *
 * So probe the CRM app's own token, and REFUSE TO RUN without it rather than fall back to the broad
 * one. The fallback IS the bug. Put the app's token in worker/.dev.vars (git-ignored) as
 * HUBSPOT_CRM_APP_TOKEN — the value shown on the private app's page, the same one held by the
 * Worker's HUBSPOT_ACCESS_TOKEN secret.
 */
const TOKEN = env.HUBSPOT_CRM_APP_TOKEN;
if (!TOKEN) {
  console.error("HUBSPOT_CRM_APP_TOKEN is missing from worker/.dev.vars.\n");
  console.error("This check is only meaningful against the token the DEPLOYED CRM Worker uses.");
  console.error("HUBSPOT_ACCESS_TOKEN in that file belongs to a different, broader app — probing it is");
  console.error("what let the 2026-09-15 outage happen with this script already in the repo.");
  console.error("Refusing to probe the wrong credential and report a false pass.");
  process.exit(2);
}

/** Every read the four CRM specs make, grouped by the object whose scope grants it. */
const PROBES = [
  ["contacts", "GET /crm/v3/objects/contacts?limit=1"],
  ["contacts", "GET /crm/v3/properties/contacts/leadstatus"],
  ["companies", "GET /crm/v3/objects/companies?limit=1"],
  ["companies", "GET /crm/v3/properties/companies/type"],
  ["owners", "GET /crm/v3/owners?limit=1"],
  ["deals", "GET /crm/v3/objects/deals?limit=1"],
  ["deals", "GET /crm/v3/properties/deals/dealtype"],
  ["deals", "GET /crm/v3/properties/deals/hs_priority"],
  ["deals", "GET /crm/v3/pipelines/deals"],
  ["line_items", "GET /crm/v3/objects/line_items?limit=1"],
  ["line_items", "GET /crm/v3/properties/line_items/hs_pricing_model"],
];

console.log("probing what the token can read…\n");
const failedObjects = new Set();
for (const [object, probe] of PROBES) {
  const path = probe.slice(4);
  const r = await fetch(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const ok = r.ok;
  if (!ok) failedObjects.add(object);
  let detail = "";
  if (!ok) {
    const b = await r.json().catch(() => ({}));
    detail = `  ${String(b.message ?? "").slice(0, 90)}`;
  }
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(r.status).padEnd(4)} ${object.padEnd(11)} ${path}${detail}`);
}

console.log("");
if (!failedObjects.size) { console.log("Every read the CRM specs make is permitted."); process.exit(0); }
console.log(`BLOCKED OBJECTS: ${[...failedObjects].join(", ")}`);
console.log("\nConsequences, in the order they bite:");
console.log("  1. buildCtx throws while loading dictionaries -> EVERY webhook for EVERY object fails,");
console.log("     including contacts and companies, because the context is built once for all specs.");
console.log("  2. The historical import runs the same buildCtx from a script and fails the same way.");
console.log("\nFix: grant the private app the missing read scopes in HubSpot, then re-run this.");
process.exit(1);
