// Does every HubSpot property name the CRM specs map actually EXIST?
// HubSpot silently ignores an unknown property on a READ — no error, no warning, the key is simply
// absent — so a typo is indistinguishable from an empty field. At 94k contacts that means one column
// imports blank for every record and nothing ever reports it. Preflight checks the monday side only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const dir = mkdtempSync(join(tmpdir(), "props-"));
const out = join(dir, "w.mjs"), entry = join(dir, "e.ts");
writeFileSync(entry, [
  `export { propertiesForSpec } from ${JSON.stringify(join(ROOT, "src", "hubspot.ts"))};`,
  `export { CRM_CONTACTS, CRM_ACCOUNTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
].join("\n"), "utf8");
buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
const mod = await import(pathToFileURL(out).href);

for (const [spec, object] of [[mod.CRM_ACCOUNTS, "companies"], [mod.CRM_CONTACTS, "contacts"]]) {
  // The full property list for the object, in one request — cheaper and more complete than probing
  // each name, and it also lets us report the property TYPE we are actually reading.
  const r = await fetch(`https://api.hubapi.com/crm/v3/properties/${object}`, {
    headers: { Authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN },
  });
  const body = await r.json();
  const live = new Map((body.results ?? []).map(p => [p.name, p]));

  const wanted = mod.propertiesForSpec(spec);
  const missing = wanted.filter(n => !live.has(n));
  console.log(`\n=== ${object} — ${wanted.length} properties requested per record ===`);
  console.log(`  HubSpot exposes ${live.size} properties on this object`);
  if (missing.length) {
    console.log(`  *** ${missing.length} REQUESTED PROPERTY NAME(S) DO NOT EXIST — they would import blank, silently ***`);
    for (const n of missing) console.log(`        ${n}`);
  } else {
    console.log(`  every requested property exists`);
  }

  // Also surface anything HubSpot marks read-only or calculated among the ones we intend to WRITE
  // back, since a reverse write to those 400s and wedges the card.
  const reversible = spec.fields.filter(f => f.reverse).map(f => f.hs);
  const bad = reversible.filter(n => {
    const p = live.get(n);
    return p && (p.modificationMetadata?.readOnlyValue === true || p.calculated === true);
  });
  console.log(`  reversible fields: ${reversible.length}`);
  if (bad.length) {
    console.log(`  *** ${bad.length} REVERSIBLE FIELD(S) ARE READ-ONLY OR CALCULATED IN HUBSPOT ***`);
    for (const n of bad) {
      const p = live.get(n);
      console.log(`        ${n}  readOnlyValue=${p.modificationMetadata?.readOnlyValue} calculated=${p.calculated}`);
    }
  } else {
    console.log(`  none of the reversible fields is read-only or calculated`);
  }
}
try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
