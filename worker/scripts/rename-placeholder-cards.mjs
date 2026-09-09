/**
 * RENAME CARDS THAT ALREADY LANDED WITH A PLACEHOLDER NAME.
 *
 * Needed because a naming change only reaches an existing card on that card's next webhook, and
 * webhooks are the only live path here (no CRM cron, skipFullReconcile on both specs). Without this
 * pass the 4,237 Accounts cards imported as "companies <id>" would keep those names essentially
 * forever — most of them are never touched again.
 *
 * It computes the wanted name with the Worker's OWN itemName, so this pass and the live sync can never
 * disagree. That matters more than it sounds: if they disagreed, every card renamed here would show a
 * name diff on its next webhook and be renamed back, silently undoing the whole pass.
 *
 * ONLY renames, and only where the CURRENT name is a placeholder of the form "<object> <id>". A card a
 * human has titled is never touched, even if itemName would now produce something different — a rep's
 * own words outrank a derived label.
 *
 *   node scripts/rename-placeholder-cards.mjs --object companies
 *   node scripts/rename-placeholder-cards.mjs --object companies --apply
 *
 * DEPLOY THE WORKER FIRST. If the running Worker still has the old naming, it will rename these cards
 * back on their next webhook and this pass is wasted.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HS_API = "https://api.hubapi.com";

function creds() {
  const out = { MONDAY_API_TOKEN: process.env.MONDAY_API_TOKEN ?? "", HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN ?? "" };
  try {
    for (const line of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] in out && !out[m[1]]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* rely on the environment */ }
  return out;
}

async function loadWorker() {
  const dir = mkdtempSync(join(tmpdir(), "rename-"));
  const out = join(dir, "w.mjs"), entry = join(dir, "e.ts");
  writeFileSync(entry, [
    `export { propertiesForSpec } from ${JSON.stringify(join(ROOT, "src", "hubspot.ts"))};`,
    `export { itemName } from ${JSON.stringify(join(ROOT, "src", "mapping.ts"))};`,
    `export { CRM_CONTACTS, CRM_ACCOUNTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
  ].join("\n"), "utf8");
  buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
  return { mod: await import(pathToFileURL(out).href), cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

const throttle = { gapMs: 120 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

async function monday(token, query, variables = {}, attempt = 0) {
  const wait = throttle.gapMs - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) {
    const s = JSON.stringify(b.errors ?? b).toLowerCase();
    if (attempt < 5 && (r.status === 429 || r.status >= 500 || s.includes("complexity") || s.includes("rate limit"))) {
      throttle.gapMs = Math.min(8000, Math.max(throttle.gapMs * 2, 500));
      await sleep(2000 * 2 ** attempt);
      return monday(token, query, variables, attempt + 1);
    }
    throw new Error(`monday: http ${r.status} ${JSON.stringify(b.errors ?? b).slice(0, 250)}`);
  }
  throttle.gapMs = Math.max(60, Math.round(throttle.gapMs * 0.9));
  return b.data;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--object");
  const which = i >= 0 ? process.argv[i + 1] : "companies";
  const cIdx = process.argv.indexOf("--concurrency");
  const concurrency = cIdx >= 0 ? Math.max(1, Number(process.argv[cIdx + 1])) : 4;

  const { MONDAY_API_TOKEN: M, HUBSPOT_ACCESS_TOKEN: H } = creds();
  if (!M || !H) { console.error("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN required"); process.exit(1); }

  const { mod, cleanup } = await loadWorker();
  try {
    const spec = which === "contacts" ? mod.CRM_CONTACTS : mod.CRM_ACCOUNTS;
    // The exact placeholder itemName produces when every name source is empty.
    const placeholder = new RegExp(`^${spec.object}\\s+\\d+$`);
    console.log(`=== ${apply ? "RENAME" : "PLAN"} ${spec.object} placeholder cards on board ${spec.boardId} ===`);

    const cards = [];
    let cursor = null;
    do {
      const page = (await monday(M,
        `query ($b: ID!, $c: String, $ids: [String!]) {
           boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
             cursor items { id name column_values(ids: $ids) { id text } } } } }`,
        { b: spec.boardId, c: cursor, ids: [spec.idCol] })).boards[0].items_page;
      for (const it of page.items) {
        const hsId = (it.column_values.find(c => c.id === spec.idCol)?.text ?? "").trim();
        if (hsId && placeholder.test(it.name.trim())) cards.push({ itemId: it.id, name: it.name.trim(), hsId });
      }
      cursor = page.cursor;
    } while (cursor);
    console.log(`  ${cards.length} card(s) carry a placeholder name`);
    if (!cards.length) return;

    // Fetch the records and ask the Worker's own itemName what each card SHOULD be called.
    const props = mod.propertiesForSpec(spec);
    const plan = [];
    let unchanged = 0;
    for (let k = 0; k < cards.length; k += 100) {
      const chunk = cards.slice(k, k + 100);
      const r = await fetch(`${HS_API}/crm/v3/objects/${spec.object}/batch/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props, inputs: chunk.map(c => ({ id: c.hsId })) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { console.log(`  hubspot batch failed (http ${r.status}) for ${chunk.length} card(s)`); continue; }
      const byId = new Map((body.results ?? []).map(x => [String(x.id), { id: String(x.id), properties: x.properties ?? {} }]));
      for (const c of chunk) {
        const rec = byId.get(c.hsId);
        if (!rec) { console.log(`  ${c.hsId}: no longer in HubSpot — skipped`); continue; }
        const want = mod.itemName(rec, spec);
        // Still a placeholder means the record genuinely has no usable name source (78 companies have
        // neither name nor domain). Leave it: renaming it to the same thing is a wasted write.
        if (want === c.name) { unchanged++; continue; }
        plan.push({ ...c, want });
      }
    }
    console.log(`  ${plan.length} would be renamed, ${unchanged} have no usable name source and stay as-is\n`);
    for (const p of plan.slice(0, 15)) console.log(`      ${p.itemId}  ${JSON.stringify(p.name)} -> ${JSON.stringify(p.want)}`);
    if (plan.length > 15) console.log(`      … and ${plan.length - 15} more`);

    if (!apply) { console.log(`\n(nothing written — add --apply)`); return; }

    let done = 0, failed = 0;
    for (let k = 0; k < plan.length; k += concurrency) {
      const group = plan.slice(k, k + concurrency);
      await Promise.all(group.map(async p => {
        try {
          await monday(M, `mutation ($b: ID!, $i: ID!, $n: String!) {
            change_simple_column_value(board_id: $b, item_id: $i, column_id: "name", value: $n) { id } }`,
            { b: spec.boardId, i: p.itemId, n: p.want });
          done++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.log(`      FAILED ${p.itemId}: ${String(e).slice(0, 140)}`);
        }
      }));
      if ((k / concurrency) % 25 === 0) console.log(`  renamed ${done}/${plan.length} (failed ${failed})`);
    }
    console.log(`\n=== RENAMED ${done}, FAILED ${failed} ===`);
  } finally { cleanup(); }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
