/**
 * WHY DOES AN ACCOUNTS CARD HAVE A DOMAIN BUT NO HUBSPOT ID OR LINK?
 *
 * Asked on 2026-09-09 against live cards (example.com, ukmarketreport.com, qk.ilongyu.com.cn,
 * hubspot.com, vml.com, zkqcip.com) showing a filled Company domain, a filled Contacts relation, a
 * BLANK HubSpot ID and Link, and a Sync State still reading "not synced — needs domain".
 *
 * That Sync State string is the tell: `sync.ts` writes it in exactly ONE place — the branch where
 * `adoptionKey` returned "". So the adoption path DID run, and at that moment the card had no usable
 * domain. Everything after that is about which of four things is true NOW, and only the live board and
 * portal can say which:
 *
 *   1. The spec's column id no longer exists on the board. Demonstrated failure mode here: the deleted
 *      `text_mm6tafj5` (Industry) froze every card on THIS board, because monday rejects the entire
 *      change_multiple_column_values mutation when it names an unknown column. A dead `adoptBy.col`
 *      is quieter — adoptionKey finds no cell, returns "", and the card is stamped "needs domain"
 *      forever no matter what a rep types.
 *   2. The cell holds something adoptionKey REFUSES: a public email provider (PA-1), or a value that
 *      is not a hostname ("ABC Trading Sdn Bhd"). Both are correct refusals, but they are invisible on
 *      the card, which just says "needs domain".
 *   3. adoptionKey is happy, but no webhook has fired since the domain was filled, so nothing has
 *      re-run the adoption. Shows up here as "WOULD ADOPT" on a card that has not — stale, not broken.
 *   4. adoptionKey is happy and HubSpot holds no company at that domain, so the card needs a CREATE
 *      rather than an adoption.
 *
 * It also surfaces the AMBIGUOUS case the live code cannot see: searchCompanyByDomain passes `limit: 1`
 * and silently takes the first hit, so two HubSpot companies sharing a domain adopt an arbitrary one.
 * This queries with limit 10 and flags it.
 *
 * `adoptionKey` is IMPORTED FROM THE REAL SOURCE via an esbuild bundle, never re-implemented. The whole
 * question is "what does the deployed predicate decide about this exact cell", so a paraphrase would be
 * worse than useless — it could disagree with production and send the diagnosis down the wrong path.
 *
 *   MONDAY_API_TOKEN=… HUBSPOT_ACCESS_TOKEN=… node scripts/diagnose-accounts-adoption.mjs
 *
 * Read-only. It queries monday and HubSpot and writes nothing to either.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD = "5028000496";           // CRM Accounts
const CONTACTS_BOARD = "5028000495";  // for the webhook listing only

/** The columns CRM_ACCOUNTS actually names, read from the spec source rather than retyped here — a
 *  spec change must not leave this script quietly checking the wrong columns. */
function specCols() {
  const src = readFileSync(join(ROOT, "src", "config", "crm.ts"), "utf8");
  const block = src.slice(src.indexOf("export const CRM_ACCOUNTS"));
  const pick = k => (block.match(new RegExp(`${k}:\\s*"([^"]+)"`)) ?? [])[1] ?? "";
  const adopt = block.match(/adoptBy:\s*\{\s*kind:\s*"(\w+)",\s*col:\s*"([^"]+)"/) ?? [];
  return {
    idCol: pick("idCol"), syncStateCol: pick("syncStateCol"), linkCol: pick("linkCol"),
    adoptKind: adopt[1] ?? "", adoptCol: adopt[2] ?? "",
  };
}

/** Bundle the real adopt.ts so the script decides with production's own predicate.
 *
 *  esbuild's JS API, NOT its CLI: since the Node 18 fix for CVE-2024-27980, spawning a `.cmd` shim
 *  without `shell: true` fails outright with EINVAL on Windows, and `shell: true` would then need
 *  every path quoted. Importing the module sidesteps both and needs no temp binary lookup. */
async function loadAdopt() {
  const dir = mkdtempSync(join(tmpdir(), "adopt-"));
  const out = join(dir, "adopt.mjs");
  buildSync({
    entryPoints: [join(ROOT, "src", "adopt.ts")],
    bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "error",
  });
  const mod = await import(pathToFileURL(out).href);
  return { mod, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

async function monday(token, query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

async function hubspot(token, path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** The same canonicalisation adoptionKey applies, used only to explain a refusal in words. */
const bareHost = s => s.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim().toLowerCase();

async function main() {
  const M = process.env.MONDAY_API_TOKEN;
  const H = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!M) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }

  const cols = specCols();
  const { mod, cleanup } = await loadAdopt();
  const { adoptionKey, isPublicEmailDomain } = mod;

  try {
    // ---- 1. DO THE SPEC'S COLUMNS STILL EXIST? The failure that froze this board once already.
    const live = (await monday(M, "query ($b: [ID!]) { boards(ids: $b) { columns { id title type } } }",
      { b: [BOARD] })).boards[0].columns;
    const byId = new Map(live.map(c => [c.id, c]));
    console.log(`=== 1. SPEC COLUMNS vs BOARD ${BOARD} ===`);
    let deadColumn = false;
    for (const [k, id] of [["adoptBy.col", cols.adoptCol], ["idCol", cols.idCol],
        ["syncStateCol", cols.syncStateCol], ["linkCol", cols.linkCol]]) {
      const c = byId.get(id);
      if (!c) deadColumn = true;
      console.log(`  ${k.padEnd(16)}${id.padEnd(22)}`
        + (c ? `OK  ${c.type.padEnd(12)}${JSON.stringify(c.title)}` : "*** MISSING ON BOARD ***"));
    }
    if (deadColumn) {
      console.log("\n  A missing column is the whole answer: adoptionKey finds no cell, returns \"\", and");
      console.log("  every card is stamped \"not synced — needs domain\" whatever a rep types.");
    }

    // ---- 2. WEBHOOKS. Nothing re-runs adoption if no event arrives.
    console.log("\n=== 2. WEBHOOK REGISTRATIONS ===");
    console.log("  monday's API never exposes a webhook's target URL, so this shows only WHICH EVENTS are");
    console.log("  subscribed. No change_column_value means filling the Domain triggers no adoption retry.");
    for (const b of [CONTACTS_BOARD, BOARD]) {
      const hooks = (await monday(M, "query ($b: ID!) { webhooks(board_id: $b) { id event config } }", { b })).webhooks ?? [];
      console.log(`  board ${b}: ${hooks.length} hook(s) — ${hooks.map(h => h.event).sort().join(", ") || "NONE"}`);
      if (!hooks.some(h => h.event === "change_column_value"))
        console.log(`     *** no change_column_value on ${b}: a filled Domain triggers no adoption retry ***`);
    }

    // ---- 3. EVERY CARD: what does the real predicate decide, and what does HubSpot hold?
    console.log("\n=== 3. CARDS ===");
    const ids = [cols.adoptCol, cols.idCol, cols.syncStateCol, cols.linkCol].filter(Boolean);
    let cursor = null, items = [];
    do {
      const page = (await monday(M,
        `query ($b: ID!, $c: String, $ids: [String!]) {
           boards(ids: [$b]) { items_page(limit: 100, cursor: $c) {
             cursor items { id name created_at column_values(ids: $ids) { id text value } } } } }`,
        { b: BOARD, c: cursor, ids })).boards[0].items_page;
      items = items.concat(page.items);
      cursor = page.cursor;
    } while (cursor);

    const cell = (it, id) => it.column_values.find(c => c.id === id);
    const tally = { linked: 0, wouldAdopt: 0, wouldCreate: 0, refused: 0, ambiguous: 0, unresolved: 0 };

    for (const it of items) {
      const hsId = (cell(it, cols.idCol)?.text ?? "").trim();
      if (hsId) { tally.linked++; continue; }   // already linked — not the reported problem

      const state = (cell(it, cols.syncStateCol)?.text ?? "").trim();
      const dc = cell(it, cols.adoptCol);
      // The exact shape adoptionKey is handed by the sync: it reads `text`, then prefers `value.url`.
      const shim = { name: it.name, column_values: [{ id: cols.adoptCol, text: dc?.text ?? "", value: dc?.value ?? null }] };
      const key = adoptionKey(shim, { adoptBy: { kind: cols.adoptKind, col: cols.adoptCol } });

      let verdict, detail;
      if (!key) {
        tally.refused++;
        let url = "";
        try { url = String(JSON.parse(dc?.value ?? "null")?.url ?? ""); } catch { /* malformed value JSON */ }
        const raw = (url || (dc?.text ?? "")).trim();
        verdict = "REFUSED by adoptionKey";
        detail = !raw ? "the cell is EMPTY (both text and value.url are blank)"
          : isPublicEmailDomain(bareHost(raw))
            ? `"${raw}" is a public email provider — PA-1 blocks it as a company key`
            : `"${raw}" is not a valid hostname`;
      } else if (!H) {
        tally.unresolved++;
        verdict = "key OK";
        detail = `would search HubSpot for domain="${key}" (set HUBSPOT_ACCESS_TOKEN to resolve)`;
      } else {
        const r = await hubspot(H, "/crm/v3/objects/companies/search", {
          filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: key }] }],
          properties: ["name", "domain", "sync_owner"], limit: 10,
        });
        const hits = r.body.results ?? [];
        if (hits.length === 1) {
          tally.wouldAdopt++;
          verdict = "WOULD ADOPT";
          detail = `domain="${key}" -> HubSpot ${hits[0].id} (${hits[0].properties?.name ?? "?"}),`
            + ` sync_owner=${JSON.stringify(hits[0].properties?.sync_owner ?? null)}`;
        } else if (hits.length === 0) {
          tally.wouldCreate++;
          verdict = "WOULD CREATE";
          detail = `no HubSpot company has domain="${key}"`;
        } else {
          tally.ambiguous++;
          verdict = "AMBIGUOUS";
          detail = `${hits.length} HubSpot companies share domain="${key}" — the live code passes limit:1`
            + ` and would adopt an ARBITRARY one: ${hits.map(h => h.id).join(", ")}`;
        }
      }
      console.log(`  card ${it.id} ${JSON.stringify(it.name).padEnd(34)} state=${JSON.stringify(state)}`);
      console.log(`      ${verdict}: ${detail}`);
    }

    console.log(`\n=== SUMMARY (${items.length} cards) ===`);
    console.log(`  already linked to HubSpot : ${tally.linked}`);
    console.log(`  WOULD ADOPT on next event : ${tally.wouldAdopt}   <- stale, not broken: the key is fine`);
    console.log(`  would create in HubSpot   : ${tally.wouldCreate}`);
    console.log(`  refused by adoptionKey    : ${tally.refused}`);
    console.log(`  AMBIGUOUS domain          : ${tally.ambiguous}`);
    if (tally.unresolved) console.log(`  unresolved (no HubSpot token): ${tally.unresolved}`);
  } finally {
    cleanup();
  }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
