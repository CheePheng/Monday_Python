/**
 * Read the CRM HubSpot app's webhook subscriptions, so a test can cross-check them against the specs.
 *
 * WHY THIS EXISTS. A field needs TWO independent things to sync from HubSpot:
 *   1. a mapping in worker/src/config/crm.ts, and
 *   2. an `object.propertyChange` subscription in the app's webhooks-hsmeta.json.
 * Either half alone is a silent no-op. A mapped-but-unsubscribed property simply never updates — no
 * error, no log, nothing to notice — and this repo has hit it before (8 fields at one point). Nothing
 * cross-checked the two files, so the only way it surfaced was someone reading both by hand.
 *
 * Lives in .mjs because the worker tsconfig targets the Workers runtime and has no node:fs types —
 * same pattern as read-wrangler.mjs, scan-write-mode.mjs and read-source.mjs.
 *
 *   node scripts/read-subscriptions.mjs        # print the subscription inventory
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const META = join(dirname(fileURLToPath(import.meta.url)),
  "..", "..", "hubspot-crm-webhook-sync", "src", "app", "webhooks", "webhooks-hsmeta.json");

/** @returns {{targetUrl: string, all: object[], propsFor: (o: string) => string[], typesFor: (o: string) => string[]}} */
export function readSubscriptions() {
  const cfg = JSON.parse(readFileSync(META, "utf8")).config;
  const all = cfg.subscriptions.crmObjects ?? [];
  return {
    targetUrl: cfg.settings?.targetUrl ?? "",
    all,
    /** Property names with an object.propertyChange subscription for this object type. */
    propsFor: (objectType) => all
      .filter(s => s.objectType === objectType && s.subscriptionType === "object.propertyChange" && s.propertyName)
      .map(s => s.propertyName),
    /** Non-property subscription types (creation / deletion / associationChange) for this object. */
    typesFor: (objectType) => all
      .filter(s => s.objectType === objectType && !s.propertyName)
      .map(s => s.subscriptionType),
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("read-subscriptions.mjs");
if (invokedDirectly) {
  const s = readSubscriptions();
  console.log(`targetUrl: ${s.targetUrl}`);
  console.log(`${s.all.length} subscriptions`);
  for (const o of ["contact", "company"]) {
    const p = s.propsFor(o);
    console.log(`\n${o}: ${s.typesFor(o).join(", ")}`);
    console.log(`${o} propertyChange (${p.length}): ${p.join(", ")}`);
  }
}
