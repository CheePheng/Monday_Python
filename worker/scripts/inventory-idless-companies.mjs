/**
 * READ ONLY inventory of Accounts cards that carry no HubSpot id, and whether each has a safe
 * canonical twin. Writes nothing; there is no mutation path in this file.
 *
 * Matching is by NORMALISED DOMAIN only. Name is deliberately not sufficient: the pair that started
 * this investigation is "Izeno" and "iZeno", and two companies can share a name without being the
 * same record. A card whose only evidence is a similar name lands in the ambiguous bucket.
 */
import fs from "node:fs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const v = Object.fromEntries(fs.readFileSync(HERE + "../.dev.vars", "utf8").split(/\r?\n/)
  .filter(l => l.includes("=")).map(l => { const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const gql = async (q, vars) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query: q, variables: vars }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 4) return null;
    } catch { if (a === 4) return null; }
    await new Promise(s => setTimeout(s, 2500 * (a + 1)));
  }
  return null;
};

const BOARD = "5028000496", ID_COL = "text_mm6tsnwx", DOMAIN_COL = "company_domain";
/** strip scheme/path/www and lowercase, so "izeno.com - https://izeno.com" and "www.IZENO.com" agree */
const normDomain = (s) => {
  let d = String(s ?? "").trim().toLowerCase();
  d = d.split(/[\s|,]/)[0];                       // the column holds "domain - url" in places
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].replace(/\.$/, "");
  return d;
};

// ---------------------------------------------------------------- 1. every Accounts card, once
console.log("reading every Accounts card...");
const all = [];
let cursor = null;
for (;;) {
  const q = cursor
    ? `query ($c:String!) { next_items_page(limit:500, cursor:$c) { cursor items { id name created_at column_values(ids:["${ID_COL}","${DOMAIN_COL}"]) { id text } } } }`
    : `query { boards(ids:["${BOARD}"]) { items_page(limit:500) { cursor items { id name created_at column_values(ids:["${ID_COL}","${DOMAIN_COL}"]) { id text } } } } }`;
  const r = await gql(q, cursor ? { c: cursor } : {});
  if (!r) { console.log("  read failed — aborting rather than reporting a partial board"); process.exit(1); }
  const page = cursor ? r.next_items_page : r.boards[0].items_page;
  for (const it of page.items) {
    const cv = Object.fromEntries(it.column_values.map(c => [c.id, (c.text ?? "").trim()]));
    all.push({ card: it.id, name: it.name, created: it.created_at,
      hsId: cv[ID_COL] ?? "", domain: normDomain(cv[DOMAIN_COL]) });
  }
  cursor = page.cursor;
  if (!cursor) break;
  if (all.length % 5000 < 500) console.log(`  ${all.length}...`);
}
console.log(`Accounts cards: ${all.length}`);

const idless = all.filter(c => !c.hsId);
const withId = all.filter(c => c.hsId);
console.log(`  with a HubSpot id: ${withId.length}`);
console.log(`  WITHOUT one:       ${idless.length}`);

// ---------------------------------------------------------------- 2. index the id-bearing by domain
const byDomain = new Map();
for (const c of withId) {
  if (!c.domain) continue;
  if (!byDomain.has(c.domain)) byDomain.set(c.domain, []);
  byDomain.get(c.domain).push(c);
}

// ---------------------------------------------------------------- 3. timelines of the id-less cards
console.log("\nreading the id-less cards' timelines...");
const HEADER = /^(From|To|Direction|HubSpot owner|Sequence \d+)/;
const timelineOf = async (card) => {
  const byId = new Map(); const seen = new Set();
  let cur = null, pages = 0;
  for (;;) {
    const q = cur
      ? `query ($i:ID!, $c:String!) { timeline(id:$i) { timeline_items_page(limit:100, cursor:$c) { cursor timeline_items { id content } } } }`
      : `query ($i:ID!) { timeline(id:$i) { timeline_items_page(limit:100) { cursor timeline_items { id content } } } }`;
    const r = await gql(q, cur ? { i: card, c: cur } : { i: card });
    if (!r) return { incomplete: "api-fail", entries: [] };
    const p = r.timeline?.timeline_items_page;
    if (!p) return { incomplete: "no-page", entries: [] };
    for (const t of p.timeline_items ?? []) byId.set(t.id, t);
    pages++;
    cur = p.cursor ?? null;
    if (!cur) break;
    if (seen.has(cur)) return { incomplete: "repeated-cursor", entries: [] };
    seen.add(cur);
    if (pages >= 200) return { incomplete: "page-budget", entries: [] };
  }
  return { incomplete: null, entries: [...byId.values()] };
};

const rows = [];
for (let i = 0; i < idless.length; i++) {
  const c = idless[i];
  const tl = await timelineOf(c.card);
  const markers = [...new Set((tl.entries ?? [])
    .map(t => (String(t.content ?? "").match(/\[hubspot:emails:(\d+)\]/) ?? [])[1]).filter(Boolean))];
  const twins = c.domain ? (byDomain.get(c.domain) ?? []) : [];
  let bucket;
  if (!c.domain) bucket = "D_no_usable_domain";
  else if (twins.length === 1) bucket = "A_one_canonical_twin";
  else if (twins.length > 1) bucket = "B_multiple_twins";
  else bucket = "C_no_twin";
  rows.push({ ...c, timelineCount: tl.entries?.length ?? 0, incomplete: tl.incomplete,
    emailMarkers: markers.length, sampleMarkers: markers.slice(0, 3),
    twins: twins.map(t => ({ card: t.card, name: t.name, hsId: t.hsId })), bucket });
  if (i && i % 50 === 0) console.log(`  ${i}/${idless.length}`);
}

// ---------------------------------------------------------------- 4. report
const tally = {};
for (const r of rows) tally[r.bucket] = (tally[r.bucket] ?? 0) + 1;
console.log("\n================ ID-LESS ACCOUNTS CARDS");
for (const [k, n] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(26)} ${n}`);
console.log(`  total ${rows.length}`);
console.log(`  incomplete timelines: ${rows.filter(r => r.incomplete).length}`);
console.log(`  carrying email entries: ${rows.filter(r => r.emailMarkers > 0).length}`
  + `  (entries in total: ${rows.reduce((a, r) => a + r.timelineCount, 0)})`);

// how the 403 skipped email pairs land across the buckets
let manifest = [];
try { manifest = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/email-cleanup-manifest-v2.json", "utf8")).manifest; } catch {}
const skipCards = new Set(manifest.filter(m => m.action === "SKIP").map(m => m.card));
const perBucket = {};
for (const r of rows) if (skipCards.has(r.card)) perBucket[r.bucket] = (perBucket[r.bucket] ?? 0) + 1;
const skippedPairs = manifest.filter(m => m.action === "SKIP").length;
console.log(`\n================ the ${skippedPairs} SKIPPED email pairs, by their card's bucket`);
for (const [k, n] of Object.entries(perBucket).sort()) console.log(`  ${k.padEnd(26)} ${n} cards`);

console.log("\nsamples per bucket:");
for (const b of Object.keys(tally).sort()) {
  const s = rows.filter(r => r.bucket === b).slice(0, 2);
  for (const r of s)
    console.log(`  [${b}] ${r.card} "${String(r.name).slice(0, 22)}" domain=${r.domain || "(none)"}`
      + ` entries=${r.timelineCount} emails=${r.emailMarkers}`
      + (r.twins.length ? ` twin=${r.twins[0].card}/${r.twins[0].hsId}` : ""));
}

fs.writeFileSync(HERE + "../../docs/rollout/idless-company-cards.json",
  JSON.stringify({ takenAt: new Date().toISOString(), board: BOARD,
    totals: tally, cards: rows }, null, 1));
console.log("\nwrote docs/rollout/idless-company-cards.json (READ ONLY run)");
