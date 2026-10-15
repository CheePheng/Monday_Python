/**
 * READ ONLY. Classify the 809 orphan/canonical Account pairs, and establish what the 403 blocked
 * email pairs look like on the CANONICAL card. No mutation path exists in this file.
 *
 * The question each pair has to answer is not "do these look like duplicates" but "does the orphan
 * hold anything the canonical does not". A domain match is a reason to look, never a reason to
 * delete. Anything that cannot be read to completion is A5, never A1.
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

const HEADER = /^(From|To|Direction|HubSpot owner|Sequence \d+)/;
const bodyOf = (c) => String(c ?? "").split("\n")
  .filter(l => l.trim() && !HEADER.test(l.trim()) && !/^\[hubspot:/.test(l.trim())).join(" ").trim();
const OUR_EMAIL = "eaca46da-4695-4386-8dd4-a3fa088d31ce";
const MAX_PAGES = 200;

/** Walk one card's timeline to completion, guarded and de-duplicated. */
async function walk(card) {
  const byId = new Map(); const seen = new Set();
  let cur = null, pages = 0;
  for (;;) {
    const q = cur
      ? `query ($i:ID!, $c:String!) { timeline(id:$i) { timeline_items_page(limit:100, cursor:$c) { cursor timeline_items { id type title content created_at custom_activity_id } } } }`
      : `query ($i:ID!) { timeline(id:$i) { timeline_items_page(limit:100) { cursor timeline_items { id type title content created_at custom_activity_id } } } }`;
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
    if (pages >= MAX_PAGES) return { incomplete: "page-budget", entries: [] };
  }
  return { incomplete: null, entries: [...byId.values()] };
}

const COLS = ["text_mm6tsnwx", "company_domain", "account_contact", "board_relation_mm76cv3c",
              "text_mm6t1q4h", "multiple_person_mm6z8mwy", "text_mm6tccd0", "link_mm6zyad8"];
async function cardFacts(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 25) {
    const d = await gql(`query ($i:[ID!]) { items(ids:$i) { id name created_at
      column_values(ids:[${COLS.map(c => `"${c}"`).join(",")}]) { id text } } }`, { i: ids.slice(i, i + 25) });
    for (const it of d?.items ?? [])
      out.set(it.id, { name: it.name, created: it.created_at,
        cv: Object.fromEntries(it.column_values.map(c => [c.id, (c.text ?? "").trim()])) });
  }
  return out;
}

const inv = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/idless-company-cards.json", "utf8"));
const pairs = inv.cards.filter(c => c.bucket === "A_one_canonical_twin")
  .map(c => ({ orphan: c.card, orphanName: c.name, domain: c.domain,
               canonical: c.twins[0].card, canonicalHsId: c.twins[0].hsId, canonicalName: c.twins[0].name }));
console.log(`orphan/canonical pairs to classify: ${pairs.length}`);

const facts = await cardFacts([...new Set(pairs.flatMap(p => [p.orphan, p.canonical]))]);
console.log(`card facts read: ${facts.size}`);

const results = [];
const t0 = Date.now();
for (let i = 0; i < pairs.length; i++) {
  const p = pairs[i];
  const o = await walk(p.orphan);
  const c = o.incomplete ? { incomplete: "orphan-unreadable", entries: [] } : await walk(p.canonical);

  const markersOf = (entries) => {
    const m = new Map();
    for (const t of entries) {
      const hit = String(t.content ?? "").match(/\[hubspot:emails:(\d+)\]/);
      if (hit) m.set(hit[1], { id: t.id, body: bodyOf(t.content).length });
    }
    return m;
  };
  const oMark = markersOf(o.entries), cMark = markersOf(c.entries);
  // [A-Za-z0-9_-]+: a marketing email entry's key is not all digits, and it is ours, not native.
  const oNative = o.entries.filter(t => !/\[hubspot:\w+:[A-Za-z0-9_-]+\]/.test(String(t.content ?? "")));
  const onlyOrphan = [...oMark.keys()].filter(k => !cMark.has(k));
  const onlyCanonical = [...cMark.keys()].filter(k => !oMark.has(k));

  const of_ = facts.get(p.orphan), cf = facts.get(p.canonical);
  const orphanRelContacts = (of_?.cv.account_contact ?? "").trim();
  const orphanRelDeals = (of_?.cv.board_relation_mm76cv3c ?? "").trim();
  const canonRelContacts = (cf?.cv.account_contact ?? "").trim();
  // a field the orphan fills that the canonical leaves empty (excluding the id/sync/link it can't have)
  const uniqueFields = COLS.filter(k => !["text_mm6tsnwx", "text_mm6tccd0", "link_mm6zyad8"].includes(k))
    .filter(k => (of_?.cv[k] ?? "") && !(cf?.cv[k] ?? ""));

  let bucket;
  if (o.incomplete || c.incomplete) bucket = "A5_unreadable";
  else if (!facts.get(p.canonical)?.cv.text_mm6tsnwx) bucket = "A5_canonical_lost_its_id";
  else if (orphanRelContacts || orphanRelDeals || uniqueFields.length) bucket = "A3_unique_relations_or_fields";
  else if (oNative.length) bucket = "A4_unique_native_activity";
  else if (onlyOrphan.length) bucket = "A2_only_hubspot_history_to_move";
  else bucket = "A1_nothing_unique";

  results.push({ ...p, bucket,
    orphanEntries: o.entries.length, canonicalEntries: c.entries.length,
    orphanMarkers: oMark.size, canonicalMarkers: cMark.size,
    onBoth: [...oMark.keys()].filter(k => cMark.has(k)).length,
    onlyOrphan, onlyCanonical: onlyCanonical.length,
    orphanNative: oNative.length, orphanRelContacts, orphanRelDeals, uniqueFields,
    incomplete: o.incomplete ?? c.incomplete ?? null,
    orphanMarkerDetail: Object.fromEntries(oMark), canonicalMarkerDetail: Object.fromEntries(cMark) });

  if (i && i % 50 === 0) {
    const rate = i / ((Date.now() - t0) / 1000);
    console.log(`  ${i}/${pairs.length}  ${rate.toFixed(2)} pairs/s  eta ${Math.round((pairs.length - i) / rate / 60)} min`);
  }
}

const tally = {};
for (const r of results) tally[r.bucket] = (tally[r.bucket] ?? 0) + 1;
console.log("\n================ A1-A5, the 809 twin pairs");
for (const [k, n] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(32)} ${n}`);

// ---- the 403 blocked email pairs, as they stand on the CANONICAL card
const man = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/email-cleanup-manifest-v2.json", "utf8"));
const byOrphan = new Map(results.map(r => [r.orphan, r]));
const E = { E0_absent: 0, E1_one_bodyless: 0, E2_one_with_body: 0, E3_dup_bodyless: 0,
            E4_dup_with_body: 0, E5_ambiguous: 0 };
const eRows = [];
for (const m of man.manifest.filter(x => x.action === "SKIP")) {
  const r = byOrphan.get(m.card);
  if (!r || r.incomplete) { E.E5_ambiguous++; eRows.push({ ...m, canonical: r?.canonical ?? null, state: "E5_ambiguous" }); continue; }
  const c = r.canonicalMarkerDetail[m.email];
  let state;
  if (!c) state = "E0_absent";
  else state = c.body > 0 ? "E2_one_with_body" : "E1_one_bodyless";   // markersOf keeps one per email id
  E[state]++;
  eRows.push({ orphan: m.card, canonical: r.canonical, hubspotCompanyId: r.canonicalHsId,
    email: m.email, orphanCopies: m.copies, orphanBodies: m.bodies, canonicalState: state });
}
console.log("\n================ E0-E5, the 403 blocked email pairs on their CANONICAL card");
for (const [k, n] of Object.entries(E)) console.log(`  ${k.padEnd(22)} ${n}`);
console.log(`  sum ${Object.values(E).reduce((a, b) => a + b, 0)} (expected ${man.manifest.filter(x => x.action === "SKIP").length})`);

// ---- safest eventual canary candidates
const safe = results.filter(r => r.bucket === "A1_nothing_unique" && r.orphanEntries === 0
  && !r.orphanRelContacts && !r.orphanRelDeals && !r.uniqueFields.length && r.canonicalHsId);
console.log(`\n================ safest eventual canary candidates: ${safe.length}`);
for (const s of safe.slice(0, 5))
  console.log(`  orphan ${s.orphan} "${String(s.orphanName).slice(0, 20)}"  ->  canonical ${s.canonical}`
    + ` (hs ${s.canonicalHsId}) domain=${s.domain} orphanEntries=${s.orphanEntries} canonicalEntries=${s.canonicalEntries}`);

fs.writeFileSync(HERE + "../../docs/rollout/twin-account-classification.json",
  JSON.stringify({ takenAt: new Date().toISOString(), tally, E, safeCandidates: safe.slice(0, 20),
    pairs: results, blockedEmailPairs: eRows }, null, 1));
console.log("\nwrote docs/rollout/twin-account-classification.json (READ ONLY)");
