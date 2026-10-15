/**
 * Read a worker source file as text, for STRUCTURAL tests.
 *
 * Some guarantees are about the shape of the code rather than its behaviour, and those are exactly the
 * ones behavioural tests cannot see. Two live examples in this repo:
 *   - only run-opts.ts may derive `writeHubspot` (scan-write-mode.mjs) — a duplicate is invisible
 *     because each copy is individually correct;
 *   - restore-card.ts must delegate card creation to the gated sync path and never create a card
 *     itself, or the no-historical-import guarantee moves out from behind mayCreateCrmCard.
 *
 * Lives in .mjs because the worker tsconfig targets the Workers runtime and has no node:fs types —
 * same reason as read-wrangler.mjs and scan-write-mode.mjs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * LINE ENDINGS ARE NORMALISED TO "\n".
 *
 * These tests assert on multi-line source fragments — `indexOf("if (selfOrigin)\n    return ...")` —
 * and this working tree is MIXED: 41 of 150 source files are CRLF and the rest are LF, because git
 * normalises to LF on commit while the checkout and various editors do not agree on the way back.
 * Whether a structural guarantee holds has nothing to do with which line ending the file happens to
 * carry today, but without this an ordinary edit that flips a file's endings fails a test that is
 * nominally about the selfOrigin guard, sending the reader hunting through logic that never changed.
 *
 * Normalising here rather than converting the 41 files keeps the fix in one place and survives the
 * next checkout, which would simply reintroduce them.
 */
export function readSource(relPath) {
  return readFileSync(join(SRC, relPath), "utf8").replace(/\r\n/g, "\n");
}

/** The same file with block and line comments removed, so an assertion can target executable code.
 *  Comments are where the reasoning belongs; forbidding a WORD outright would punish documenting it. */
export function readCode(relPath) {
  return strip(readSource(relPath));
}

/** Every .ts file under src/, as paths relative to it ("webhooks.ts", "config/crm.ts"), sorted. For the
 *  structural tests that must hold across the whole codebase ("only webhooks.ts names this column"). */
export function listSources() {
  return readdirSync(SRC, { recursive: true }).map(p => String(p).split("\\").join("/"))
    .filter(p => p.endsWith(".ts")).sort();
}

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/**
 * The same, for the one-off migration scripts in this directory.
 *
 * They need structural cover for the same reason src/ does, and more urgently: a script that writes to
 * 94,000 production records has guarantees that live in its SHAPE — that flushRelations re-reads each
 * cell before replacing it, that an invalid --relation-cap throws instead of disabling the ceiling —
 * and neither is reachable from a unit test, because the script is a top-level-await program that
 * bundles the Worker with esbuild and needs live credentials to do anything at all.
 */
export function readScript(relPath) {
  return strip(readFileSync(join(SCRIPTS, relPath), "utf8").replace(/\r\n/g, "\n"));
}

/** `scripts/<relPath>` WITH its comments -- for the few tests about what a script's help promises. */
export function readScriptSource(relPath) {
  return readFileSync(join(SCRIPTS, relPath), "utf8").replace(/\r\n/g, "\n");
}

/** `test/fixtures/<relPath>` parsed as JSON -- captured live shapes (e.g. board_automations) that a
 *  classifier must be tested against, since hand-made fixtures drift from what monday really sends. */
export function readFixture(relPath) {
  return JSON.parse(readFileSync(join(SCRIPTS, "..", "test", "fixtures", relPath), "utf8"));
}

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
