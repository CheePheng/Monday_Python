/**
 * EXACT, READ-ONLY inventory of our HubSpot Email timeline entries. Writes nothing, anywhere.
 *
 * ENUMERATION. Cards are selected by monday's own `updated_at`, ordered `__last_updated__` desc and
 * stopped at the activity cutover. A timeline write bumps the parent item's updated_at — verified on
 * card 2860521683, created 09-16, whose updated_at matches its 09-18T09:55 entry — so every card
 * that received a post-cutover entry is in this set. Last Activity Date is deliberately NOT the
 * selector: the restoration moved thousands of those dates BACKWARDS to older HubSpot values, so it
 * would now miss cards it should catch.
 *
 * TRAVERSAL. monday's timeline pages overlap (measured: 36 pages, 1,339 distinct entries, 449
 * repeated rows), so every card is walked with a seenCursors guard and deduped by timeline-item id.
 * A card whose walk cannot be completed is marked INCOMPLETE and never counted as "no entries".
 */
import fs from "node:fs";

const APPLY_NOTHING = true;                       // this script has no write path at all
const CUTOVER = Date.parse("2026-09-16T11:16:48Z");
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const v = Object.fromEntries(fs.readFileSync(HERE + "../.dev.vars", "utf8").split(/\r?\n/)
  .filter(l => l.includes("=")).map(l => { const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));

const BOARDS = [
  { kind: "contact", board: "5028000495", label: "Contacts" },
  { kind: "company", board: "5028000496", label: "Accounts/Companies" },
  { kind: "deal",    board: "5028000494", label: "Deals" },
];
const HEADER = /^(From|To|Direction|HubSpot owner|Sequence \d+)/;
const MAX_PAGES = 200;

const stats = { repeatedCursor: 0, apiFail: 0, noPage: 0, truncated: 0, overlapRows: 0,
                maxPages: 0, maxEntries: 0 };

const gql = async (query, variables) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 4) return null;
    } catch { if (a === 4) return null; }
    await new Promise(s => setTimeout(s, 2500 * (a + 1)));
  }
  return null;
};

// ---------------------------------------------------------------- 1. enumerate candidate cards
async function cardsTouchedSinceCutover(board) {
  const ids = [];
  let cursor = null;
  for (;;) {
    const q = cursor
      ? `query ($c:String!) { next_items_page(limit:500, cursor:$c) { cursor items { id updated_at } } }`
      : `query { boards(ids:["${board}"]) { items_page(limit:500,
           query_params:{order_by:[{column_id:"__last_updated__", direction:desc}]}) {
           cursor items { id updated_at } } } }`;
    const r = await gql(q, cursor ? { c: cursor } : {});
    if (!r) { stats.apiFail++; break; }
    const page = cursor ? r.next_items_page : r.boards[0].items_page;
    let stop = false;
    for (const it of page.items) {
      if (Date.parse(it.updated_at) < CUTOVER) { stop = true; break; }
      ids.push(it.id);
    }
    cursor = page.cursor;
    if (stop || !cursor) break;
  }
  return ids;
}

// ---------------------------------------------------------------- 2. walk cards
//
// FIRST PAGES ARE ALIAS-BATCHED, six cards per request. Measured earlier on this account: alias
// batching reads at 15.1ms/id against 47.8 sequential, while running plain requests in parallel gave
// 43-45 — monday serialises per account even for reads, so what pays is removing round trips.
// The overwhelming majority of cards fit in one page; only those that come back with a cursor need
// an individual continuation, so the expensive path is walked rarely.
const FIRST_PAGE_BATCH = 6;

/** Continue a card that had more than one page, from the cursor its first page returned. */
async function continueCard(card, byId, firstCursor) {
  const seenCursors = new Set([firstCursor]);
  let cursor = firstCursor, pages = 1, overlap = 0;
  for (;;) {
    const r = await gql(
      `query ($i:ID!, $c:String!) { timeline(id:$i) { timeline_items_page(limit:100, cursor:$c) { cursor timeline_items { id content created_at } } } }`,
      { i: card, c: cursor });
    if (!r) { stats.apiFail++; return { incomplete: "api-fail", pages, overlap }; }
    const page = r.timeline?.timeline_items_page;
    if (!page) { stats.noPage++; return { incomplete: "no-page", pages, overlap }; }
    for (const t of page.timeline_items ?? []) {
      if (byId.has(t.id)) overlap++;
      byId.set(t.id, t);
    }
    pages++;
    cursor = page.cursor ?? null;
    if (!cursor) return { incomplete: null, pages, overlap };
    if (seenCursors.has(cursor)) { stats.repeatedCursor++; return { incomplete: "repeated-cursor", pages, overlap }; }
    seenCursors.add(cursor);
    if (pages >= MAX_PAGES) { stats.truncated++; return { incomplete: "page-budget", pages, overlap }; }
  }
}

/** Read the first page of up to FIRST_PAGE_BATCH cards in ONE request. */
async function firstPages(cards) {
  const decl = cards.map((_, k) => `$i${k}:ID!`).join(", ");
  const body = cards.map((_, k) =>
    `t${k}: timeline(id:$i${k}) { timeline_items_page(limit:100) { cursor timeline_items { id content created_at } } }`).join("\n  ");
  const variables = {};
  cards.forEach((c, k) => { variables[`i${k}`] = c; });
  const d = await gql(`query (${decl}) {\n  ${body}\n}`, variables);
  return cards.map((card, k) => {
    if (!d) { stats.apiFail++; return { card, incomplete: "api-fail", byId: new Map(), cursor: null }; }
    const page = d[`t${k}`]?.timeline_items_page;
    if (!page) { stats.noPage++; return { card, incomplete: "no-page", byId: new Map(), cursor: null }; }
    const byId = new Map();
    for (const t of page.timeline_items ?? []) byId.set(t.id, t);
    return { card, incomplete: null, byId, cursor: page.cursor ?? null };
  });
}

/** Walk a whole chunk: one batched request, then individual continuations where needed. */
async function walkChunk(cards) {
  const out = [];
  for (const r of await firstPages(cards)) {
    if (r.incomplete) { out.push({ card: r.card, incomplete: r.incomplete, entries: [] }); continue; }
    let pages = 1, overlap = 0, incomplete = null;
    if (r.cursor) {
      const cont = await continueCard(r.card, r.byId, r.cursor);
      pages = cont.pages; overlap = cont.overlap; incomplete = cont.incomplete;
    }
    if (incomplete) { out.push({ card: r.card, incomplete, entries: [] }); continue; }
    stats.overlapRows += overlap;
    stats.maxPages = Math.max(stats.maxPages, pages);
    stats.maxEntries = Math.max(stats.maxEntries, r.byId.size);
    out.push({ card: r.card, incomplete: null, entries: [...r.byId.values()] });
  }
  return out;
}

/** One card, walked completely — used for the retry pass. */
async function walkCard(card) {
  const [r] = await walkChunk([card]);
  return r;
}

const bodyOf = (content) => String(content).split("\n")
  .filter(l => l.trim() && !HEADER.test(l.trim()) && !/^\[hubspot:/.test(l.trim())).join(" ").trim();

// ---------------------------------------------------------------- 3. run
const groups = new Map();            // "kind|card|emailId" -> { kind, card, email, rows:[] }
const incomplete = [];
const perBoard = {};

for (const b of BOARDS) {
  const ids = await cardsTouchedSinceCutover(b.board);
  console.log(`${b.label}: ${ids.length} cards touched since the cutover`);
  perBoard[b.kind] = { label: b.label, scanned: 0, complete: 0, incomplete: 0 };
  const t0 = Date.now();
  for (let i = 0; i < ids.length; i += FIRST_PAGE_BATCH) {
    for (const res of await walkChunk(ids.slice(i, i + FIRST_PAGE_BATCH))) {
      perBoard[b.kind].scanned++;
      if (res.incomplete) { incomplete.push({ kind: b.kind, card: res.card, why: res.incomplete }); perBoard[b.kind].incomplete++; continue; }
      perBoard[b.kind].complete++;
      for (const t of res.entries) {
        const m = String(t.content ?? "").match(/\[hubspot:emails:(\d+)\]/);
        if (!m) continue;
        const key = `${b.kind}|${res.card}|${m[1]}`;
        if (!groups.has(key)) groups.set(key, { kind: b.kind, card: res.card, email: m[1], rows: [] });
        groups.get(key).rows.push({ id: t.id, ts: t.created_at, body: bodyOf(t.content).length });
      }
    }
    if (i && i % 600 === 0) {
      const done = Math.min(i + FIRST_PAGE_BATCH, ids.length);
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`   ${b.label}: ${done}/${ids.length}  ${rate.toFixed(1)} cards/s  eta ${Math.round((ids.length - done) / rate / 60)} min`);
    }
  }
}

// retry the incomplete ones once before finalising
if (incomplete.length) {
  console.log(`\nretrying ${incomplete.length} incomplete card(s)...`);
  const still = [];
  for (const rec of incomplete) {
    const res = await walkCard(rec.card);
    if (res.incomplete) { still.push(rec); continue; }
    perBoard[rec.kind].incomplete--; perBoard[rec.kind].complete++;
    for (const t of res.entries) {
      const m = String(t.content ?? "").match(/\[hubspot:emails:(\d+)\]/);
      if (!m) continue;
      const key = `${rec.kind}|${rec.card}|${m[1]}`;
      if (!groups.has(key)) groups.set(key, { kind: rec.kind, card: rec.card, email: m[1], rows: [] });
      groups.get(key).rows.push({ id: t.id, ts: t.created_at, body: bodyOf(t.content).length });
    }
  }
  incomplete.length = 0; incomplete.push(...still);
}

// ---------------------------------------------------------------- 4. tally
const tally = (filterKind) => {
  const t = { pairs: 0, single: 0, two: 0, threePlus: 0, entries: 0, extra: 0,
              pairsNoBody: 0, pairsSomeBody: 0, bodylessRows: 0, bodyRows: 0,
              dupAllBodyless: 0, dupMixed: 0, dupAllBody: 0 };
  for (const g of groups.values()) {
    if (filterKind && g.kind !== filterKind) continue;
    if (Date.parse(g.rows[0].ts) < CUTOVER) continue;          // historical import: out of scope
    t.pairs++; t.entries += g.rows.length;
    if (g.rows.length === 1) t.single++;
    else if (g.rows.length === 2) t.two++;
    else t.threePlus++;
    if (g.rows.length > 1) {
      t.extra += g.rows.length - 1;
      const withBody = g.rows.filter(r => r.body > 0).length;
      if (withBody === 0) t.dupAllBodyless++;
      else if (withBody === g.rows.length) t.dupAllBody++;
      else t.dupMixed++;
    }
    const anyBody = g.rows.some(r => r.body > 0);
    anyBody ? t.pairsSomeBody++ : t.pairsNoBody++;
    for (const r of g.rows) r.body > 0 ? t.bodyRows++ : t.bodylessRows++;
  }
  return t;
};

const pre = [...groups.values()].filter(g => Date.parse(g.rows[0].ts) < CUTOVER);
const show = (label, t) => {
  console.log(`\n--- ${label}`);
  console.log(`  distinct (destination,email) pairs   ${t.pairs}`);
  console.log(`    exactly 1 entry                    ${t.single}`);
  console.log(`    2 entries                          ${t.two}`);
  console.log(`    3+ entries                         ${t.threePlus}`);
  console.log(`  total timeline entries               ${t.entries}`);
  console.log(`  EXTRA duplicate entries to remove    ${t.extra}`);
  console.log(`  pairs with NO body on any copy       ${t.pairsNoBody}`);
  console.log(`  pairs with at least one body         ${t.pairsSomeBody}`);
  console.log(`  bodyless timeline entries            ${t.bodylessRows}`);
  console.log(`  body-present timeline entries        ${t.bodyRows}`);
  console.log(`  duplicates, ALL copies bodyless      ${t.dupAllBodyless}`);
  console.log(`  duplicates, MIXED body/bodyless      ${t.dupMixed}   <- keep the body, drop the rest`);
  console.log(`  duplicates, ALL copies have a body   ${t.dupAllBody}`);
};

console.log("\n================ POST-CUTOVER (live sync) — the only mutation scope");
show("ALL DESTINATIONS", tally(null));
for (const b of BOARDS) show(b.label, tally(b.kind));

console.log("\n================ PRE-CUTOVER (historical import) — reference only, DO NOT TOUCH");
console.log(`  pairs ${pre.length}, entries ${pre.reduce((a, g) => a + g.rows.length, 0)},`
  + ` duplicated pairs ${pre.filter(g => g.rows.length > 1).length}`);

console.log("\n================ COMPLETENESS");
for (const b of BOARDS) {
  const p = perBoard[b.kind];
  console.log(`  ${p.label.padEnd(20)} scanned ${String(p.scanned).padStart(6)}  complete ${String(p.complete).padStart(6)}  INCOMPLETE ${p.incomplete}`);
}
console.log(`  repeated-cursor incidents            ${stats.repeatedCursor}`);
console.log(`  API/page failures                    ${stats.apiFail} / ${stats.noPage}`);
console.log(`  page-budget truncations              ${stats.truncated}`);
console.log(`  duplicate rows removed by dedupe     ${stats.overlapRows}`);
console.log(`  max pages on any card                ${stats.maxPages}`);
console.log(`  max distinct entries on any card      ${stats.maxEntries}`);
console.log(`\n  ${incomplete.length === 0 ? "EXACT — every timeline walked to completion" : `NOT EXACT — ${incomplete.length} card(s) incomplete`}`);
for (const r of incomplete.slice(0, 10)) console.log(`     ${r.kind} ${r.card} ${r.why}`);

fs.writeFileSync(HERE + "../../docs/rollout/email-inventory.json",
  JSON.stringify({ takenAt: new Date().toISOString(), cutover: new Date(CUTOVER).toISOString(),
    groups: [...groups.values()], incomplete, stats }, null, 1));
console.log(`\nwrote docs/rollout/email-inventory.json  (read-only run; APPLY_NOTHING=${APPLY_NOTHING})`);
