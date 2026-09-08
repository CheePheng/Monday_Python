/**
 * Which source files derive `writeHubspot` for themselves?
 *
 * run-opts.ts calls itself "THE SINGLE PLACE that decides whether writes actually happen". On
 * 2026-09-08 that was false: webhooks.ts carried its own `liveOpts` returning `{ writeHubspot: live }`
 * and never read WRITE_HUBSPOT. On the CRM deployment webhooks are the ONLY live path — no crons, both
 * CRM specs skipFullReconcile — so the Phase B HubSpot kill switch was inert exactly where every real
 * write happens, and the ownership gate was doing the job people believed the flag was doing.
 *
 * A duplicate is invisible to every behavioural test, because each copy is individually correct. Only
 * a source scan catches it. Consumed by test/deploy-config.test.ts; lives here as .mjs because the
 * worker tsconfig targets the Workers runtime and has no node:fs types.
 *
 *   node scripts/scan-write-mode.mjs        # prints offenders, exits 1 if any
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A TYPE declaration (`writeHubspot: boolean`) is fine; an object literal assigning it is not. */
const DECLARATION = /writeHubspot\??\s*:\s*boolean/g;
const ASSIGNMENT = /writeHubspot\s*:/;

/** @returns {string[]} file names (relative to src/) that compute writeHubspot themselves. */
export function scanWriteMode(srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src")) {
  const offenders = [];
  const walk = (dir, prefix = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, `${prefix}${e.name}/`); continue; }
      if (!e.name.endsWith(".ts") || e.name === "run-opts.ts") continue;
      if (ASSIGNMENT.test(readFileSync(p, "utf8").replace(DECLARATION, ""))) offenders.push(`${prefix}${e.name}`);
    }
  };
  walk(srcDir);
  return offenders;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("scan-write-mode.mjs");
if (invokedDirectly) {
  const bad = scanWriteMode();
  if (!bad.length) { console.log("OK: only run-opts.ts decides writeHubspot."); process.exit(0); }
  console.error(`FAIL: ${bad.length} file(s) derive writeHubspot independently of run-opts.ts:`);
  for (const f of bad) console.error(`  src/${f}`);
  process.exit(1);
}
