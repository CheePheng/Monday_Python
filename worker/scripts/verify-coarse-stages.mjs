/**
 * Every REAL HubSpot deal stage, in every pipeline, must bucket to one of the five native monday
 * Stage labels. READ-ONLY.
 *
 * The unit tests for coarseStageOf use synthetic pipelines, and the bug this exists to prevent was
 * precisely a dictionary that did not match the live portal: `stage` covered HubSpot's default
 * pipeline only, so 4 of 5 pipelines fell through to raw GUIDs and minted status labels. A synthetic
 * fixture cannot catch that class of mistake — only the real pipeline list can.
 *
 * Also counts the DEALS sitting in each bucket, because "every stage maps" and "every deal maps" are
 * different claims and it is the second one the import depends on.
 *
 *   node scripts/verify-coarse-stages.mjs
 *
 * Exits non-zero if any stage is unmapped or maps outside the five allowed labels.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)
  .filter(l => l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));

const ALLOWED = ["New", "Proposal", "Negotiation", "Won", "Lost"];

const dir = mkdtempSync(join(tmpdir(), "coarse-"));
const out = join(dir, "w.mjs"), entry = join(dir, "e.ts");
writeFileSync(entry, [
  `export { getCrmStageDicts, coarseStageOf, COARSE_STAGES } from ${JSON.stringify(join(ROOT, "src", "hubspot.ts"))};`,
].join("\n"), "utf8");
buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
const m = await import(pathToFileURL(out).href);

const workerEnv = { HUBSPOT_ACCESS_TOKEN: env.HUBSPOT_ACCESS_TOKEN };
const dicts = await m.getCrmStageDicts(workerEnv);
const stageIds = Object.keys(dicts.stages);
console.log(`${Object.keys(dicts.pipelines).length} pipelines, ${stageIds.length} stages live\n`);

let bad = 0;
for (const [pid, plabel] of Object.entries(dicts.pipelines)) {
  const mine = stageIds.filter(sid => dicts.pipelineByStage[sid] === pid);
  console.log(`${plabel}  (${mine.length} stages)`);
  for (const sid of mine) {
    const coarse = dicts.coarse[sid];
    const ok = ALLOWED.includes(coarse);
    if (!ok) bad++;
    console.log(`   ${ok ? "ok  " : "FAIL"} ${String(dicts.stages[sid]).padEnd(28)} -> ${coarse ?? "(UNMAPPED)"}`);
  }
}

// Now the stronger claim: every DEAL, not merely every stage.
console.log("\ncounting deals per bucket…");
const counts = {};
let scanned = 0, unmapped = 0;
let after;
for (;;) {
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "dealstage", operator: "HAS_PROPERTY" }] }],
      properties: ["dealstage"], limit: 100,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      ...(after ? { after } : {}),
    }),
  });
  if (!r.ok) { console.log(`  search stopped at ${scanned} (http ${r.status}) — count is partial`); break; }
  const body = await r.json();
  for (const d of body.results ?? []) {
    scanned++;
    const c = dicts.coarse[String(d.properties.dealstage)];
    if (!c) { unmapped++; if (unmapped <= 5) console.log(`  UNMAPPED deal ${d.id} stage=${d.properties.dealstage}`); }
    else counts[c] = (counts[c] ?? 0) + 1;
  }
  after = body.paging?.next?.after;
  if (!after) break;
}
console.log(`\n  ${scanned} deals scanned`);
for (const k of ALLOWED) console.log(`    ${k.padEnd(12)} ${counts[k] ?? 0}`);
console.log(`    ${"UNMAPPED".padEnd(12)} ${unmapped}`);

rmSync(dir, { recursive: true, force: true });
if (bad || unmapped) {
  console.log(`\n${bad} stage(s) and ${unmapped} deal(s) would not produce a legal label.`);
  process.exit(1);
}
console.log("\nEvery live stage and every live deal buckets to one of the five native labels.");
