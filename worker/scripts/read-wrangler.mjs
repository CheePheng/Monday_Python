/**
 * Read the deployable wrangler.jsonc so tests can assert on the ACTUAL deployment config.
 *
 * Lives in a .mjs helper because the Worker tsconfig has no Node types — the test suite runs in Node
 * and can use fs happily, but tsc would reject `node:fs` inside src/ or test/. Same pattern as
 * register-crm-webhooks.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Parse JSONC: strip `//` line comments (not inside strings) and trailing commas. */
export function parseJsonc(raw) {
  const stripped = raw
    .split("\n")
    .map(line => {
      let inStr = false, esc = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (!inStr && c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
}

/** The parsed wrangler.jsonc that `wrangler deploy` would actually use. */
export function readWranglerConfig() {
  const here = dirname(fileURLToPath(import.meta.url));
  return parseJsonc(readFileSync(join(here, "..", "wrangler.jsonc"), "utf8"));
}
