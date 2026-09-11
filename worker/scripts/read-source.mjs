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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** @param {string} relPath e.g. "restore-card.ts" @returns {string} the file's raw text */
export function readSource(relPath) {
  return readFileSync(join(SRC, relPath), "utf8");
}

/** The same file with block and line comments removed, so an assertion can target executable code.
 *  Comments are where the reasoning belongs; forbidding a WORD outright would punish documenting it. */
export function readCode(relPath) {
  return strip(readSource(relPath));
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
  return strip(readFileSync(join(SCRIPTS, relPath), "utf8"));
}

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
