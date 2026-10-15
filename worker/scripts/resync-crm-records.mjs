/**
 * Re-push HubSpot field values onto EXISTING monday CRM cards. FORWARD ONLY — it makes ZERO HubSpot
 * writes of any kind.
 *
 * WHY THIS HAD TO EXIST (2026-09-15). The CRM specs set `skipFullReconcile: true` and the CRM Worker
 * has no cron, so webhooks are the ONLY thing that ever updates a card. That is fine until the Worker
 * stops processing them: on 2026-09-15 a deploy shipped the Deals specs to a token with no deals
 * scope, every contact and company webhook died in buildCtx, and roughly an hour of changes simply
 * never landed. Nothing in the system repairs that — a missed webhook is missed forever, because the
 * watermark that would have advanced never advanced and no sweep ever revisits the record.
 *
 * So this is the manual incremental pass: name the records, and it re-applies what the Worker would
 * have written. It reuses the Worker's own buildCtx / buildColumnValues / itemName / updateItem via an
 * esbuild bundle rather than reimplementing them, for the same reason backfill-crm.mjs does — a second
 * implementation of the mapping would drift from the first, silently.
 *
 * WHAT IT DOES NOT REPAIR, stated plainly rather than left to be discovered:
 *   - ASSOCIATIONS. Connect-Boards links are driven by `object.associationChange` webhooks, which were
 *     lost in the same window. This script writes mapped FIELDS only. Association drift needs the
 *     relations pass (backfill-crm.mjs --object deal-relations, or the contacts/companies relation
 *     pass), and a field re-sync will NOT surface it.
 *   - MISSING CARDS. A record with no card is reported and skipped, never created. Card creation is
 *     gated by mayCreateCrmCard/CRM_CUTOVER_AT on purpose; bypassing that from a recovery script is
 *     exactly the kind of quiet policy change that should never ride along with an incident fix.
 *     Use backfill-crm.mjs, deliberately, if cards genuinely need creating.
 *
 *   node scripts/resync-crm-records.mjs --object contacts --since 2026-09-15T04:54:59Z
 *   node scripts/resync-crm-records.mjs --object contacts --since 2026-09-15T04:54:59Z --apply
 *   node scripts/resync-crm-records.mjs --object companies --ids 123,456 --apply
 *
 * PLAN BY DEFAULT: without --apply it reads both systems and prints what it would write.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes("--apply");
const OBJECT = arg("--object") ?? "contacts";
const SINCE = arg("--since");
const IDS = (arg("--ids") ?? "").split(/[,\s]+/).filter(Boolean);
const LIMIT = Number(arg("--limit") ?? Infinity);

if (!["contacts", "companies"].includes(OBJECT)) {
  console.error(`--object must be contacts|companies (got ${OBJECT})`); process.exit(1);
}
if (!SINCE && !IDS.length) {
  console.error("one of --since <iso8601> or --ids <id,id,…> is required"); process.exit(1);
}

const env = Object.fromEntries(readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)
  .filter(l => l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
if (!env.HUBSPOT_ACCESS_TOKEN || !env.MONDAY_API_TOKEN) {
  console.error("worker/.dev.vars must carry HUBSPOT_ACCESS_TOKEN and MONDAY_API_TOKEN"); process.exit(1);
}

/** The Worker's own code, bundled — never a reimplementation. */
async function loadWorker() {
  const dir = mkdtempSync(join(tmpdir(), "resync-"));
  const out = join(dir, "worker.mjs"), entry = join(dir, "entry.ts");
  writeFileSync(entry, [
    `export { buildCtx } from ${JSON.stringify(join(ROOT, "src", "sync.ts"))};`,
    `export { propertiesForSpec } from ${JSON.stringify(join(ROOT, "src", "hubspot.ts"))};`,
    `export { buildColumnValues, itemName } from ${JSON.stringify(join(ROOT, "src", "mapping.ts"))};`,
    `export { findItemIdsByColumn, updateItem } from ${JSON.stringify(join(ROOT, "src", "monday.ts"))};`,
    `export { CRM_CONTACTS, CRM_ACCOUNTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
  ].join("\n"), "utf8");
  buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
  const mod = await import(pathToFileURL(out).href);
  return { mod, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

async function hsPost(path, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.hubapi.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && attempt < 5) {
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt)); continue;
    }
    throw new Error(`hubspot ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

/**
 * Records to repair. KEYSET pagination on hs_object_id, never HubSpot's `after` cursor: /search
 * answers HTTP 400 on the request that would cross 10,000 results, and a loop that treats that as
 * end-of-data reports a complete run over a fraction of the rows. That bug has been shipped twice in
 * this repo already; it is not getting shipped a third time.
 */
async function recordsSince(spec, props) {
  const out = [];
  let lastId = "0";
  for (;;) {
    const body = await hsPost(`/crm/v3/objects/${OBJECT}/search`, {
      filterGroups: [{ filters: [
        { propertyName: spec.modifiedProp, operator: "GT", value: String(Date.parse(SINCE)) },
        { propertyName: "hs_object_id", operator: "GT", value: lastId },
      ] }],
      properties: props,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      limit: 100,
    });
    const page = body.results ?? [];
    if (!page.length) break;
    out.push(...page);
    lastId = String(page[page.length - 1].id);
    if (out.length >= LIMIT) break;
  }
  return out;
}

async function recordsByIds(props) {
  const body = await hsPost(`/crm/v3/objects/${OBJECT}/batch/read`, {
    properties: props,
    inputs: IDS.map(id => ({ id })),
  });
  return body.results ?? [];
}

const { mod, cleanup } = await loadWorker();
try {
  const spec = OBJECT === "contacts" ? mod.CRM_CONTACTS : mod.CRM_ACCOUNTS;
  const workerEnv = {
    HUBSPOT_ACCESS_TOKEN: env.HUBSPOT_ACCESS_TOKEN, MONDAY_API_TOKEN: env.MONDAY_API_TOKEN,
    DRY_RUN: APPLY ? "false" : "true", WRITE_HUBSPOT: "false", ENABLE_CRM: "true",
  };
  const opts = { dryRun: !APPLY, writeHubspot: false, maxWrites: Number.POSITIVE_INFINITY };

  console.log(`resync ${OBJECT} -> board ${spec.boardId}   ${APPLY ? "APPLY" : "PLAN (no writes)"}`);
  const ctx = await mod.buildCtx(workerEnv, [spec]);
  const props = mod.propertiesForSpec(spec);

  const recs = SINCE ? await recordsSince(spec, props) : await recordsByIds(props);
  console.log(`  ${recs.length} HubSpot ${OBJECT} to consider\n`);
  if (!recs.length) { console.log("nothing to do."); process.exit(0); }

  // Resolve cards in batches of 100 — items_page_by_column_values caps there.
  const cardOf = {};
  for (let i = 0; i < recs.length; i += 100) {
    const chunk = recs.slice(i, i + 100).map(r => String(r.id));
    Object.assign(cardOf, await mod.findItemIdsByColumn(workerEnv, spec.boardId, spec.idCol, chunk));
  }

  let updated = 0, missing = 0, failed = 0;
  for (const rec of recs) {
    const itemId = cardOf[String(rec.id)];
    if (!itemId) {
      missing++;
      console.log(`  NO CARD  ${rec.id}  ${rec.properties.email ?? rec.properties.domain ?? ""}`
        + `  created ${rec.properties.createdate ?? "?"}`);
      continue;
    }
    const cv = mod.buildColumnValues(rec, spec, ctx);
    cv[spec.syncStateCol] = rec.properties[spec.modifiedProp] ?? "";
    try {
      await mod.updateItem(workerEnv, spec.boardId, itemId, mod.itemName(rec, spec), cv, opts);
      updated++;
    } catch (e) {
      failed++;
      console.log(`  FAILED   ${rec.id} -> item ${itemId}: ${String(e).slice(0, 160)}`);
    }
  }

  console.log(`\n${APPLY ? "updated" : "would update"} ${updated}, no card ${missing}, failed ${failed}`);
  if (missing) console.log("  records with no card are NOT created here — see the header.");
  if (!APPLY) console.log("\nPLAN only. Re-run with --apply to write.");
  process.exit(failed ? 1 : 0);
} finally {
  cleanup();
}
