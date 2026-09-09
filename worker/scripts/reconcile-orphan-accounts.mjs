/**
 * ADOPT THE ACCOUNTS CARDS THAT HAVE A DOMAIN BUT NO HUBSPOT ID.
 *
 * Preflight found 7 of them on board 5028000496. They exist because the Accounts board was seeded from
 * Contact company names before adoption worked, so they carry a Company domain, a Company name, and —
 * critically — CONTACTS RELATIONS, but no HubSpot ID.
 *
 * WHY THEY MATTER TO THE IMPORT. The historical import dedups on the HubSpot ID column, so a card with
 * a blank ID is invisible to it. For any of these 7 whose domain matches a real HubSpot Company, the
 * import creates a SECOND card for that same company. That is a duplicate-by-company, not a duplicate
 * HubSpot ID, so a duplicate-ID check reports zero and misses it entirely.
 *
 * WHICH CARD SURVIVES, AND WHY IT IS THE COUNTERINTUITIVE ONE. When a twin already exists, this adopts
 * the ORPHAN and leaves the freshly imported card to be removed — not the other way round. The orphan
 * is the card carrying the Contacts relations and any manual edits; the imported twin is a clean copy
 * of HubSpot with no relations. Keeping the import and dropping the orphan would silently destroy the
 * Contact <-> Company links that already exist.
 *
 * Deleting the twin is OPT-IN (`--delete-twins`). A card deletion is irreversible from here and the
 * monday->HubSpot rule is deliberately that monday never deletes anything in HubSpot, so the default
 * is to REPORT twins and let a human confirm.
 *
 *   node scripts/reconcile-orphan-accounts.mjs                    # plan, writes nothing
 *   node scripts/reconcile-orphan-accounts.mjs --apply
 *   node scripts/reconcile-orphan-accounts.mjs --apply --delete-twins
 *
 * `companyDomainKey` is imported from src/adopt.ts, so "which domain does this cell mean" is decided by
 * the same predicate the live Worker uses — including its hostname shape check and its refusal of
 * consumer email providers.
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

async function loadWorker() {
  const dir = mkdtempSync(join(tmpdir(), "orphan-"));
  const out = join(dir, "w.mjs"), entry = join(dir, "e.ts");
  writeFileSync(entry, [
    `export { companyDomainKey } from ${JSON.stringify(join(ROOT, "src", "adopt.ts"))};`,
    `export { CRM_ACCOUNTS } from ${JSON.stringify(join(ROOT, "src", "config", "crm.ts"))};`,
  ].join("\n"), "utf8");
  buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
  return { mod: await import(pathToFileURL(out).href), cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

const PORTAL = "39939588";
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

/** Every HubSpot company on this exact domain. limit 10, NOT 1 — the live searchCompanyByDomain uses
 *  limit 1 and silently takes the first hit, so ambiguity has to be looked for deliberately. */
async function companiesByDomain(H, domain) {
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
      properties: ["name", "domain", "hs_lastmodifieddate", "sync_owner"], limit: 10,
    }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`hubspot: http ${r.status} ${JSON.stringify(b).slice(0, 200)}`);
  return b.results ?? [];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const deleteTwins = process.argv.includes("--delete-twins");
  const { MONDAY_API_TOKEN: M, HUBSPOT_ACCESS_TOKEN: H } = creds();
  if (!M || !H) { console.error("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN required (env or worker/.dev.vars)"); process.exit(1); }

  const { mod, cleanup } = await loadWorker();
  try {
    const { companyDomainKey, CRM_ACCOUNTS: spec } = mod;
    const relCol = spec.associations?.find(a => a.relationCol)?.relationCol;
    const nameCol = spec.fields.find(f => f.hs === "name")?.col;
    const domainCol = spec.adoptBy.col;
    const ids = [spec.idCol, spec.syncStateCol, spec.linkCol, domainCol, nameCol, relCol].filter(Boolean);

    console.log(`reading board ${spec.boardId}…`);
    const cards = [];
    let cursor = null;
    do {
      const page = (await monday(M,
        `query ($b: ID!, $c: String, $ids: [String!]) {
           boards(ids: [$b]) { items_page(limit: 500, cursor: $c) {
             cursor items { id name column_values(ids: $ids) {
               id text ... on BoardRelationValue { linked_item_ids } } } } } }`,
        { b: spec.boardId, c: cursor, ids })).boards[0].items_page;
      for (const it of page.items) {
        const cells = {};
        for (const cv of it.column_values) cells[cv.id] = cv.text ?? "";
        const rel = it.column_values.find(c => c.linked_item_ids);
        cards.push({ itemId: it.id, name: it.name, cells, linked: (rel?.linked_item_ids ?? []).map(String) });
      }
      cursor = page.cursor;
    } while (cursor);
    console.log(`  ${cards.length} cards`);

    const byHsId = new Map();
    for (const c of cards) {
      const id = (c.cells[spec.idCol] ?? "").trim();
      if (id) byHsId.set(id, c);
    }
    const orphans = cards.filter(c => !(c.cells[spec.idCol] ?? "").trim());
    console.log(`  ${orphans.length} card(s) have NO HubSpot ID\n`);
    if (!orphans.length) return;

    const plan = [];
    for (const o of orphans) {
      const raw = (o.cells[domainCol] ?? "").trim();
      const key = companyDomainKey(raw.includes(" - ") ? raw.split(" - ").pop() : raw);
      const rels = o.linked.length;
      console.log(`card ${o.itemId} ${JSON.stringify(o.name)}`);
      console.log(`    domain cell : ${JSON.stringify(raw) || "(empty)"}`);
      console.log(`    canonical   : ${JSON.stringify(key) || '"" (unusable)'}`);
      console.log(`    relations   : ${rels} linked contact card(s)`);

      if (!key) { console.log(`    -> SKIP: no usable domain; nothing to adopt by\n`); continue; }
      const hits = await companiesByDomain(H, key);
      if (hits.length === 0) {
        console.log(`    -> NO HUBSPOT MATCH: leave as-is. The normal create path will make a company`);
        console.log(`       for it (domain is now reversible, so the create carries the domain).\n`);
        continue;
      }
      if (hits.length > 1) {
        console.log(`    -> AMBIGUOUS: ${hits.length} HubSpot companies share this domain — refusing to guess`);
        for (const h of hits) console.log(`         ${h.id}  ${JSON.stringify(h.properties?.name ?? "")}`);
        console.log("");
        continue;
      }
      const hs = hits[0];
      const twin = byHsId.get(String(hs.id));
      console.log(`    -> ADOPT HubSpot ${hs.id} ${JSON.stringify(hs.properties?.name ?? "")}`);
      if (twin) {
        console.log(`       DUPLICATE: card ${twin.itemId} already holds this HubSpot ID`);
        console.log(`         orphan  ${o.itemId}: ${rels} relation(s)  <- keeping this one`);
        console.log(`         twin    ${twin.itemId}: ${twin.linked.length} relation(s)  <- ${deleteTwins ? "will DELETE" : "reported only, pass --delete-twins to remove"}`);
      }
      console.log("");
      plan.push({ orphan: o, hs, twin });
    }

    console.log(`=== ${apply ? "APPLYING" : "PLAN"}: ${plan.length} adoption(s) ===`);
    if (!apply) { console.log("(nothing written — add --apply)"); return; }

    for (const p of plan) {
      const cv = {
        [spec.idCol]: String(p.hs.id),
        [spec.syncStateCol]: p.hs.properties?.hs_lastmodifieddate ?? "",
        [spec.linkCol]: {
          url: `https://app.hubspot.com/contacts/${PORTAL}/record/${spec.objectTypeId}/${p.hs.id}`,
          text: "Open in HubSpot",
        },
      };
      await monday(M,
        `mutation ($b: ID!, $i: ID!, $v: JSON!) {
           change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v,
             create_labels_if_missing: true) { id } }`,
        { b: spec.boardId, i: p.orphan.itemId, v: JSON.stringify(cv) });
      console.log(`  adopted card ${p.orphan.itemId} -> HubSpot ${p.hs.id}`);

      if (p.twin && deleteTwins) {
        // Only ever the twin, only when it holds no relations the orphan lacks — a relation on the
        // twin would mean deleting it loses a link, which is the whole thing this script exists to
        // avoid. Reported instead so a human decides.
        if (p.twin.linked.length) {
          console.log(`    twin ${p.twin.itemId} NOT deleted: it holds ${p.twin.linked.length} relation(s)`);
        } else {
          await monday(M, `mutation ($i: ID!) { delete_item(item_id: $i) { id } }`, { i: p.twin.itemId });
          console.log(`    deleted duplicate card ${p.twin.itemId}`);
        }
      }
    }
    console.log(`\ndone. Re-run --preflight or verify-crm-import.mjs to confirm.`);
  } finally { cleanup(); }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
