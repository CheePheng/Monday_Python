/**
 * Find monday cards that share a HubSpot ID. READ-ONLY — reports, never deletes.
 *
 * WHY. On 2026-09-16 the throwaway contact test-hxf0915 (HubSpot 550936454903) was found on TWO
 * Contacts cards, 2859523865 (created 07:08:52Z) and 2859742407 (created 11:57:27Z), both written by
 * the integration user. The HubSpot ID column is the dedup key the whole sync turns on:
 * ensureCardForRecord takes a reservation, then findItemByColumn on that column, and is supposed to
 * make a second card impossible. Two cards means that guarantee failed at least once.
 *
 * A duplicate is not cosmetic. Every forward write picks ONE card, so the other silently drifts; the
 * relations passes link whichever they find; and a rep looking at the stale copy sees a customer
 * record that is quietly wrong. It also breaks the reminder workflows, which key off columns that
 * only one of the two copies receives.
 *
 * KNOWN CAUSE FOR AT LEAST ONE CLASS: running two importers concurrently. Each builds its monday
 * index ONCE at startup, so an import that starts before another finishes cannot see the cards the
 * other is creating, and both create. That is how djntd-ik@itclogi.com got two cards the same day.
 * Whether the live Worker can do it unprompted is the open question this scan exists to answer.
 *
 *   node scripts/find-duplicate-cards.mjs                     # Contacts
 *   node scripts/find-duplicate-cards.mjs --board 5028000496 --id-col text_mm6tsnwx
 */
import fs from "node:fs";

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const BOARD = arg("--board") ?? "5028000495";
const ID_COL = arg("--id-col") ?? "text_mm6t71dj";

const env = Object.fromEntries(fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split(/\r?\n/).filter(l => l.includes("="))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));

async function md(query, variables = {}) {
  for (let a = 0; ; a++) {
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: env.MONDAY_API_TOKEN, "API-Version": "2026-07" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (!j.errors) return j.data;
    if (a < 5) { await new Promise(res => setTimeout(res, 2000 * 2 ** a)); continue; }
    throw new Error(JSON.stringify(j.errors).slice(0, 250));
  }
}

const frag = `id name created_at column_values(ids: ["${ID_COL}"]) { text }`;
const byId = new Map();
let cursor = null, scanned = 0, noId = 0;
for (;;) {
  const q = cursor
    ? `query ($c: String!) { next_items_page(cursor: $c, limit: 250) { cursor items { ${frag} } } }`
    : `query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 250) { cursor items { ${frag} } } } }`;
  const d = await md(q, cursor ? { c: cursor } : { b: [BOARD] });
  const page = cursor ? d.next_items_page : d.boards[0].items_page;
  for (const it of page.items) {
    scanned++;
    const hsId = (it.column_values?.[0]?.text ?? "").trim();
    if (!hsId) { noId++; continue; }
    if (!byId.has(hsId)) byId.set(hsId, []);
    byId.get(hsId).push({ id: it.id, name: it.name, created_at: it.created_at });
  }
  if (scanned % 5000 < 250) console.log(`  …${scanned} scanned`);
  cursor = page.cursor;
  if (!cursor) break;
}

const dupes = [...byId.entries()].filter(([, v]) => v.length > 1);
console.log(`\nboard ${BOARD}: ${scanned} cards, ${byId.size} distinct HubSpot ids, ${noId} with no id`);
console.log(`DUPLICATED HubSpot ids: ${dupes.length}`);
console.log(`extra cards beyond the first: ${dupes.reduce((n, [, v]) => n + v.length - 1, 0)}`);

if (!dupes.length) { console.log("\nNo duplicates."); process.exit(0); }

// When were the extra copies made? Clustering by hour is what distinguishes a one-off race from a
// systemic fault — a live Worker bug scatters, a concurrent-import race clumps.
const hours = new Map();
for (const [, v] of dupes) {
  const sorted = [...v].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const extra of sorted.slice(1)) {
    const h = String(extra.created_at).slice(0, 13);
    hours.set(h, (hours.get(h) ?? 0) + 1);
  }
}
console.log(`\nextra copies by hour created:`);
for (const [h, n] of [...hours.entries()].sort()) console.log(`   ${h}:00Z   ${n}`);

console.log(`\nfirst ${Math.min(dupes.length, 25)} duplicated ids:`);
for (const [hsId, v] of dupes.slice(0, 25)) {
  const sorted = [...v].sort((a, b) => a.created_at.localeCompare(b.created_at));
  console.log(`   hubspot ${hsId}  "${String(sorted[0].name).slice(0, 34)}"`);
  for (const c of sorted) console.log(`      item ${c.id}  created ${c.created_at}`);
}
console.log("\nREAD-ONLY: nothing was changed. Decide removals deliberately, keeping the card the");
console.log("card-registry points at — deleting the registered one strands the record.");
