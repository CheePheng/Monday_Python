/**
 * REMOVE CARDS THAT DUPLICATE A HUBSPOT ID, KEEPING THE MOST VALUABLE ONE.
 *
 * WHY DUPLICATES APPEAR AT ALL, given the import dedups on the HubSpot ID column: the import builds
 * that index ONCE at startup, and a full pass takes hours. Anything carded during the run — by the
 * live Worker reacting to a HubSpot webhook, or by a monday-originated create — is invisible to the
 * snapshot, so the import creates a second card for it.
 *
 * Observed exactly once on the Companies pass, and worth writing down because the mechanism is not
 * obvious: monday card 2855724118 was created at 12:53:51 with domain cnnamesolution.net; the live
 * Worker created HubSpot company 345354021576 from it at 12:54:16 and stamped the card at 12:54:33;
 * the import, whose index dated from 09:37, reached that company at 13:41 and made card 2855705902.
 * Nothing malfunctioned — the index was simply four hours old.
 *
 * WHICH CARD SURVIVES, in priority order:
 *   1. more RELATIONS — a Connect Boards link is real work that deleting would destroy, and the
 *      import never creates relations, so a card with links is never the import's copy;
 *   2. more NON-EMPTY mapped cells — the better-populated card;
 *   3. OLDER created_at — likelier to be the one a human has seen, and the one the Worker's
 *      idempotency registry points at.
 * The loser is deleted. If two cards tie on all three, NOTHING is deleted and the pair is reported:
 * a genuinely ambiguous merge is the caller's decision, not this script's.
 *
 * Deleting the loser is safe with respect to the Worker's registry even when the registry pointed at
 * it: ensureCardForRecord falls back to a findItemByColumn search on the HubSpot ID column
 * (ensure-card.ts:45-46) precisely so it adopts an existing card rather than duplicating.
 *
 *   node scripts/dedupe-crm-cards.mjs                    # plan both boards, writes nothing
 *   node scripts/dedupe-crm-cards.mjs --apply
 *   node scripts/dedupe-crm-cards.mjs --object contacts --apply
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

async function loadSpecs() {
  const dir = mkdtempSync(join(tmpdir(), "dedupe-"));
  const out = join(dir, "w.mjs"), entry = join(dir, "e.ts");
  writeFileSync(entry, `export { CRM_CONTACTS, CRM_ACCOUNTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`, "utf8");
  buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
  return { mod: await import(pathToFileURL(out).href), cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function monday(token, query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) {
    if (attempt < 4) { await sleep(1500 * 2 ** attempt); return monday(token, query, variables, attempt + 1); }
    throw new Error(`monday: http ${r.status} ${JSON.stringify(b.errors ?? b).slice(0, 300)}`);
  }
  return b.data;
}

async function run(M, spec, apply) {
  const label = spec.object === "contacts" ? "CONTACTS" : "ACCOUNTS";
  const relCol = spec.associations?.find(a => a.relationCol)?.relationCol;
  const ids = [...new Set([spec.idCol, spec.syncStateCol, ...(relCol ? [relCol] : []),
    ...spec.fields.map(f => f.col)].filter(Boolean))];

  console.log(`\n=== ${label} — board ${spec.boardId} ===`);
  const cards = [];
  let cursor = null;
  do {
    const page = (await monday(M,
      `query ($b: ID!, $c: String, $ids: [String!]) {
         boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
           cursor items { id name created_at column_values(ids: $ids) {
             id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
      { b: spec.boardId, c: cursor, ids })).boards[0].items_page;
    for (const it of page.items) {
      const cells = {};
      for (const cv of it.column_values) cells[cv.id] = cv.text ?? "";
      const rel = it.column_values.find(c => c.linked_item_ids);
      const hsId = (cells[spec.idCol] ?? "").trim();
      if (!hsId) continue;
      cards.push({
        itemId: it.id, name: it.name, createdAt: it.created_at, hsId,
        relations: (rel?.linked_item_ids ?? []).length,
        filled: Object.values(cells).filter(x => String(x).trim()).length,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  console.log(`  ${cards.length} cards carry a HubSpot ID`);

  const groups = new Map();
  for (const c of cards) {
    if (!groups.has(c.hsId)) groups.set(c.hsId, []);
    groups.get(c.hsId).push(c);
  }
  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log(`  ${dupes.length} HubSpot ID(s) appear on more than one card`);
  if (!dupes.length) return { dupes: 0, deleted: 0, ambiguous: 0 };

  let deleted = 0, ambiguous = 0;
  for (const [hsId, group] of dupes) {
    const ranked = [...group].sort((a, b) =>
      b.relations - a.relations
      || b.filled - a.filled
      || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const keep = ranked[0], drop = ranked.slice(1);
    const tied = drop.some(d =>
      d.relations === keep.relations && d.filled === keep.filled
      && Date.parse(d.createdAt) === Date.parse(keep.createdAt));

    console.log(`\n  HubSpot ${hsId}`);
    for (const c of ranked)
      console.log(`      ${c === keep ? "KEEP  " : "delete"} card ${c.itemId}  ${c.relations} rel,`
        + ` ${c.filled} filled cells, created ${c.createdAt}  ${JSON.stringify(c.name).slice(0, 40)}`);

    if (tied) {
      ambiguous++;
      console.log(`      -> AMBIGUOUS: cards are indistinguishable on relations, fill and age — not deleting`);
      continue;
    }
    if (!apply) continue;
    for (const d of drop) {
      await monday(M, `mutation ($i: ID!) { delete_item(item_id: $i) { id } }`, { i: d.itemId });
      deleted++;
      console.log(`      deleted ${d.itemId}`);
    }
  }
  return { dupes: dupes.length, deleted, ambiguous };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--object");
  const only = i >= 0 ? process.argv[i + 1] : "";
  const { MONDAY_API_TOKEN: M } = creds();
  if (!M) { console.error("MONDAY_API_TOKEN required (env or worker/.dev.vars)"); process.exit(1); }

  const { mod, cleanup } = await loadSpecs();
  try {
    const specs = only === "contacts" ? [mod.CRM_CONTACTS]
      : only === "companies" ? [mod.CRM_ACCOUNTS]
      : [mod.CRM_ACCOUNTS, mod.CRM_CONTACTS];
    let totals = { dupes: 0, deleted: 0, ambiguous: 0 };
    for (const spec of specs) {
      const r = await run(M, spec, apply);
      totals = { dupes: totals.dupes + r.dupes, deleted: totals.deleted + r.deleted, ambiguous: totals.ambiguous + r.ambiguous };
    }
    console.log(`\n=== ${apply ? "APPLIED" : "PLAN"} ===`);
    console.log(`  duplicate HubSpot IDs : ${totals.dupes}`);
    console.log(`  cards ${apply ? "deleted" : "that would be deleted"} : ${apply ? totals.deleted : totals.dupes - totals.ambiguous}`);
    console.log(`  ambiguous, left alone : ${totals.ambiguous}`);
    if (!apply) console.log(`  (nothing written — add --apply)`);
  } finally { cleanup(); }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
