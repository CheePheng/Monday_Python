/**
 * Carry the historical import to completion regardless of what happens to the process running it.
 *
 * WHY. The first Companies run was launched before create-concurrency existed and holds ~106
 * cards/min, which leaves about 3 hours on Companies and would leave 15 hours on Contacts. Stopping it
 * is worth ~2.5 hours but requires a permission this agent does not have, and waiting on that turns a
 * throughput question into a blocking one. So this removes the question: it watches for an importer
 * process and, whenever none is running while work remains, starts one with the fast settings.
 *
 *   old process killed  -> picked up within ~20s at 6x throughput
 *   old process left to finish -> exits on its own, this notices, and Contacts still gets 6x
 *   old process crashes -> same path as being killed, no human needed
 *
 * IT WILL NOT RUN TWO IMPORTERS. That is the one way this migration could manufacture real duplicates,
 * because each importer builds its HubSpot-ID dedup index once at startup and cannot see the other's
 * creates. Two consecutive clear checks are required before launching, so the brief window while a
 * process is exiting cannot be mistaken for it being gone.
 *
 * PHASES ARE NOT CHAINED PAST COMPANIES. It finishes Companies and stops. Contacts must not start
 * until Companies has been verified and the orphan Accounts reconciled — reconciling them after the
 * Contacts relations exist would be repair rather than prevention. Those are judgement steps, so a
 * human (or the agent) decides them, not this watchdog.
 *
 *   node scripts/supervise-migration.mjs companies --concurrency 6
 *
 * Progress is in scripts/.backfill-<object>.json; this appends to scripts/.migration-log.txt.
 */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const object = process.argv[2] ?? "companies";
const extra = process.argv.slice(3);
const statePath = join(HERE, `.backfill-${object}.json`);
const logPath = join(HERE, ".migration-log.txt");

const log = line => {
  const stamped = `${new Date().toISOString()}  supervisor(${object})  ${line}`;
  console.log(stamped);
  try { appendFileSync(logPath, stamped + "\n"); } catch { /* never let logging kill the watchdog */ }
};

/** Is any backfill importer running? Uses the same CIM query the agent used, so the two agree. */
function importerRunning() {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*backfill-crm*' }; if ($p) { 'YES' } else { 'NO' }"],
      { encoding: "utf8", timeout: 30000 });
    return out.includes("YES");
  } catch (e) {
    // Fail SAFE: if the check itself breaks, assume something is running rather than risk starting a
    // second importer on top of a live one.
    log(`process check failed (${String(e).slice(0, 80)}) — assuming an importer IS running`);
    return true;
  }
}

const readState = () => { try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const runDriver = () => new Promise(resolve => {
  log(`launching run-until-done ${object} ${extra.join(" ")}`);
  const child = spawn(process.execPath, [join(HERE, "run-until-done.mjs"), object, ...extra],
    { cwd: join(HERE, ".."), stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", code => { log(`driver exited ${code}`); resolve(code ?? 0); });
  child.on("error", e => { log(`driver spawn error ${String(e)}`); resolve(1); });
});

log("started");
let clearChecks = 0;
for (let tick = 0; tick < 3000; tick++) {
  const st = readState();
  if (st && !st.after) {
    log(`COMPLETE: ${object} cursor exhausted at ${st.created} created, ${(st.failed ?? []).length} failed`);
    break;
  }
  if (importerRunning()) {
    clearChecks = 0;
    if (tick % 15 === 0) log(`waiting: an importer is running (created ${st?.created ?? "?"})`);
  } else {
    clearChecks++;
    if (clearChecks >= 2) {
      log(`no importer running and work remains (created ${st?.created ?? 0}) — taking over`);
      await runDriver();
      clearChecks = 0;
      const after = readState();
      if (after && !after.after) {
        log(`COMPLETE after takeover: ${after.created} created, ${(after.failed ?? []).length} failed`);
        break;
      }
      log(`driver stopped with work remaining — see the log above; not relaunching blindly`);
      break;   // the driver's own circuit breaker fired; a human should look
    }
  }
  await sleep(20000);
}
log("supervisor exiting");
