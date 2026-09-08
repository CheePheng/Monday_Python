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
  return readSource(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
