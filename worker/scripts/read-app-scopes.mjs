/**
 * Read the CRM HubSpot app's declared scopes, so a test can cross-check them against the specs.
 *
 * WHY THIS EXISTS — it is the 2026-09-15 outage, written down as code.
 *
 * `CRM_DEALS` and `CRM_LINE_ITEMS` were added to `CRM_SPECS` in one commit. `buildCtx` loads a label
 * dictionary for every dictionary ANY spec in the deployment references, so from the first deploy
 * carrying those specs, every CONTACT and COMPANY webhook started reading `/crm/v3/pipelines/deals`
 * and deal property schemas. The app had no deals scope. The 403 threw, the throw escaped, and live
 * Contacts/Companies sync stopped dead on a deploy that changed nothing about contacts or companies.
 *
 * The two halves that drifted live in different directories and nothing compared them:
 *   1. which objects the deployment's specs cover   -> worker/src/config/crm.ts
 *   2. which scopes the app is granted              -> hubspot-crm-webhook-sync/.../app-hsmeta.json
 *
 * Same failure shape as the mapped-but-unsubscribed bug that read-subscriptions.mjs exists to catch:
 * two files that must agree, with nothing checking that they do. This is the other half.
 *
 * Lives in .mjs for the same reason as read-subscriptions.mjs — the worker tsconfig targets the
 * Workers runtime and has no node:fs types.
 *
 *   node scripts/read-app-scopes.mjs        # print the declared scopes
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const META = join(dirname(fileURLToPath(import.meta.url)),
  "..", "..", "hubspot-crm-webhook-sync", "src", "app", "app-hsmeta.json");

/**
 * HubSpot object name (as ObjectSpec.object spells it) -> the scopes a spec for it requires.
 * `read` is needed to fetch records; `schema` to read property options, which is what buildCtx does
 * for EVERY spec at startup — that is why a spec for an object you never sync still needs its schema
 * scope. `write` only when the spec pushes values back.
 */
export const SCOPES_FOR = {
  contacts: { read: "crm.objects.contacts.read", schema: "crm.schemas.contacts.read", write: "crm.objects.contacts.write" },
  companies: { read: "crm.objects.companies.read", schema: "crm.schemas.companies.read", write: "crm.objects.companies.write" },
  deals: { read: "crm.objects.deals.read", schema: "crm.schemas.deals.read", write: "crm.objects.deals.write" },
  line_items: { read: "crm.objects.line_items.read", schema: "crm.schemas.line_items.read", write: "crm.objects.line_items.write" },
};

/** @returns {{required: string[], optional: string[], has: (s: string) => boolean}} */
export function readAppScopes() {
  const auth = JSON.parse(readFileSync(META, "utf8")).config.auth;
  const required = auth.requiredScopes ?? [];
  const optional = auth.optionalScopes ?? [];
  const all = new Set([...required, ...optional]);
  return { required, optional, has: (s) => all.has(s) };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("read-app-scopes.mjs");
if (invokedDirectly) {
  const s = readAppScopes();
  console.log(`${s.required.length} required scopes:`);
  for (const x of s.required) console.log(`  ${x}`);
  if (s.optional.length) console.log(`${s.optional.length} optional: ${s.optional.join(", ")}`);
}
