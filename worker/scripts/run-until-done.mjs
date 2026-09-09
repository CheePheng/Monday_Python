/**
 * Run one historical-import phase to completion, resuming across process restarts.
 *
 * WHY THIS EXISTS. 26,173 Companies and 94,318 Contacts take far longer than any single shell
 * invocation available here survives, and backfill-crm.mjs deliberately exits when its own run ends
 * rather than looping forever. This driver re-invokes it until HubSpot's cursor is exhausted, so a
 * phase finishes unattended instead of needing a human to retype the same command five times.
 *
 * IT ADDS NO IMPORT LOGIC. It spawns the same scripts with the same flags; every decision about what
 * to create still belongs to backfill-crm.mjs. That matters because a driver that reimplemented any
 * part of the import could drift from the verified path.
 *
 * CIRCUIT BREAKER. It stops rather than grinding on when failures stop looking isolated:
 *   - a pass that creates NOTHING while the cursor is still active (no forward progress);
 *   - cumulative failures above --max-failures (default 200);
 *   - a failure RATE above 2% once at least 500 records have been attempted.
 * That is the "failures become systematic instead of isolated" condition — the point at which a human
 * should look, rather than discovering an hour later that 90k records failed the same way.
 *
 *   node scripts/run-until-done.mjs companies
 *   node scripts/run-until-done.mjs contacts --max-failures 500
 *
 * Progress is readable at any time from scripts/.backfill-<object>.json; this also appends a line per
 * pass to scripts/.migration-log.txt so a detached run leaves a trail.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const object = process.argv[2];
if (!["companies", "contacts", "relations"].includes(object)) {
  console.error('usage: node scripts/run-until-done.mjs <companies|contacts|relations> [--max-failures N] [--max-passes N]');
  process.exit(1);
}
const numArg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const maxFailures = numArg("--max-failures", 200);
const maxPasses = numArg("--max-passes", 60);
const statePath = join(HERE, `.backfill-${object}.json`);
const logPath = join(HERE, ".migration-log.txt");

const log = line => {
  const stamped = `${new Date().toISOString()}  ${object}  ${line}`;
  console.log(stamped);
  try { appendFileSync(logPath, stamped + "\n"); } catch { /* logging must never kill the run */ }
};

const readState = () => {
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return null; }
};

/** Run backfill-crm.mjs once, streaming its output through. Resolves with its exit code. */
const onePass = () => new Promise(resolve => {
  const child = spawn(process.execPath,
    [join(HERE, "backfill-crm.mjs"), "--object", object, "--apply"],
    { cwd: join(HERE, ".."), stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", code => resolve(code ?? 0));
  child.on("error", e => { log(`spawn error: ${String(e)}`); resolve(1); });
});

// `relations` is a single pass by construction — it walks the whole board in one go and keeps no
// cursor — so looping it would redo the same work. Run it once and report.
if (object === "relations") {
  log("single pass (relations keeps no cursor)");
  const code = await onePass();
  log(`exit ${code}`);
  process.exit(code);
}

let pass = 0;
for (;;) {
  pass++;
  if (pass > maxPasses) { log(`STOPPING: hit --max-passes ${maxPasses}`); process.exit(1); }

  const before = readState();
  const createdBefore = before?.created ?? 0;
  log(`pass ${pass} starting (created so far: ${createdBefore})`);

  const code = await onePass();
  const after = readState();
  if (!after) { log(`STOPPING: no state file after pass ${pass} (exit ${code})`); process.exit(1); }

  const created = after.created, failed = (after.failed ?? []).length;
  const gained = created - createdBefore;
  log(`pass ${pass} done: exit ${code}, created ${created} (+${gained}), failed ${failed}, cursor ${after.after ? "active" : "EXHAUSTED"}`);

  if (!after.after) { log(`COMPLETE: cursor exhausted at ${created} created, ${failed} failed`); process.exit(0); }

  // --- circuit breaker
  if (failed > maxFailures) {
    log(`STOPPING: ${failed} cumulative failures exceeds --max-failures ${maxFailures}`);
    process.exit(1);
  }
  const attempted = created + failed;
  if (attempted >= 500 && failed / attempted > 0.02) {
    log(`STOPPING: failure rate ${(100 * failed / attempted).toFixed(1)}% over ${attempted} attempts`
      + ` — this is systematic, not isolated`);
    process.exit(1);
  }
  if (gained === 0) {
    // The cursor is still active but nothing was created. Either every remaining record is already
    // carded (fine, but then the cursor should advance) or something is refusing everything. Either
    // way another identical pass is unlikely to differ.
    log(`STOPPING: a full pass created nothing while the cursor was still active — no forward progress`);
    process.exit(1);
  }
}
