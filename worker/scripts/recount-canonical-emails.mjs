/**
 * READ ONLY. Recompute E0-E5 for the 403 blocked email pairs, and re-derive canary candidates under
 * the stronger rules.
 *
 * THE BUG THIS FIXES: the first pass keyed markers as Map<emailId, entry>, so a SECOND copy of the
 * same email silently overwrote the first. E3 and E4 — the duplicate buckets — were therefore
 * unreachable, and reporting them as zero was an artifact of the data structure, not a finding.
 * Markers are arrays here.
 *
 * The candidate rules are also tightened: a canonical id must EQUAL the expected one rather than
 * merely exist, and business fields are compared for CONFLICT, not just for emptiness.
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
const normDomain = (s) => String(s ?? "").trim().toLowerCase().split(/[\s|,]/)[0]
  .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].replace(/\.$/, "");

async function walk(card) {
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
}

/** emailId -> ARRAY of copies. The whole point of this rewrite. */
const markersOf = (entries) => {
  const m = new Map();
  for (const t of entries) {
    const hit = String(t.content ?? "").match(/\[hubspot:emails:(\d+)\]/);
    if (!hit) continue;
    if (!m.has(hit[1])) m.set(hit[1], []);
    m.get(hit[1]).push({ id: t.id, body: bodyOf(t.content).length });
  }
  return m;
};

const cls = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/twin-account-classification.json", "utf8"));
const man = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/email-cleanup-manifest-v2.json", "utf8"));
const skips = man.manifest.filter(m => m.action === "SKIP");
const pairByOrphan = new Map(cls.pairs.map(p => [p.orphan, p]));

// only the canonical cards involved in the 403 blocked pairs need re-walking
const canonicals = [...new Set(skips.map(s => pairByOrphan.get(s.card)?.canonical).filter(Boolean))];
console.log(`canonical cards to re-walk: ${canonicals.length}`);

const marks = new Map(), bad = new Set();
const t0 = Date.now();
for (let i = 0; i < canonicals.length; i++) {
  const r = await walk(canonicals[i]);
  if (r.incomplete) bad.add(canonicals[i]); else marks.set(canonicals[i], markersOf(r.entries));
  if (i && i % 50 === 0) {
    const rate = i / ((Date.now() - t0) / 1000);
    console.log(`  ${i}/${canonicals.length}  eta ${Math.round((canonicals.length - i) / rate / 60)} min`);
  }
}

const E = { E0_absent: 0, E1_one_bodyless: 0, E2_one_with_body: 0,
            E3_dup_all_bodyless: 0, E4_dup_with_body: 0, E5_ambiguous: 0 };
const rows = [];
for (const s of skips) {
  const p = pairByOrphan.get(s.card);
  if (!p || bad.has(p.canonical) || !marks.has(p.canonical)) { E.E5_ambiguous++;
    rows.push({ orphan: s.card, email: s.email, state: "E5_ambiguous" }); continue; }
  const copies = marks.get(p.canonical).get(s.email) ?? [];
  const withBody = copies.filter(c => c.body > 0).length;
  let state;
  if (copies.length === 0) state = "E0_absent";
  else if (copies.length === 1) state = withBody ? "E2_one_with_body" : "E1_one_bodyless";
  else state = withBody ? "E4_dup_with_body" : "E3_dup_all_bodyless";
  E[state]++;
  rows.push({ orphan: s.card, canonical: p.canonical, hubspotCompanyId: p.canonicalHsId, email: s.email,
    canonicalCopies: copies.length, canonicalTimelineIds: copies.map(c => c.id),
    bodyPresent: withBody, bodyless: copies.length - withBody, state });
}
console.log("\n================ E0-E5, recomputed with per-copy arrays");
for (const [k, n] of Object.entries(E)) console.log(`  ${k.padEnd(24)} ${n}`);
console.log(`  sum ${Object.values(E).reduce((a, b) => a + b, 0)} (expected ${skips.length})`);
const dupRows = rows.filter(r => r.canonicalCopies > 1);
console.log(`\n  canonical cards carrying DUPLICATE copies of a blocked email: ${dupRows.length}`);
for (const r of dupRows.slice(0, 8))
  console.log(`     canonical ${r.canonical} email ${r.email} copies=${r.canonicalCopies} bodies=${r.bodyPresent}`);

// ---- candidates under the stronger rules, verified FRESH
console.log("\n================ canary candidates, re-verified now");
const COLS = ["text_mm6tsnwx", "company_domain", "account_contact", "board_relation_mm76cv3c",
              "text_mm6t1q4h", "multiple_person_mm6z8mwy"];
const pool = cls.pairs.filter(p => p.bucket === "A1_nothing_unique" && p.orphanEntries === 0
  && !p.orphanRelContacts && !p.orphanRelDeals && (p.uniqueFields ?? []).length === 0).slice(0, 40);
const ids = pool.flatMap(p => [p.orphan, p.canonical]);
const facts = new Map();
for (let i = 0; i < ids.length; i += 25) {
  const d = await gql(`query ($i:[ID!]) { items(ids:$i) { id name column_values(ids:[${COLS.map(c => `"${c}"`).join(",")}]) { id text } } }`,
    { i: ids.slice(i, i + 25) });
  for (const it of d?.items ?? [])
    facts.set(it.id, { name: it.name, cv: Object.fromEntries(it.column_values.map(c => [c.id, (c.text ?? "").trim()])) });
}

const safe = [];
for (const p of pool) {
  const o = facts.get(p.orphan), c = facts.get(p.canonical);
  if (!o || !c) continue;
  const reasons = [];
  if (o.cv.text_mm6tsnwx) reasons.push("orphan now HAS a HubSpot id");
  if (c.cv.text_mm6tsnwx !== p.canonicalHsId) reasons.push(`canonical id changed (${c.cv.text_mm6tsnwx} vs expected ${p.canonicalHsId})`);
  if (normDomain(o.cv.company_domain) !== normDomain(c.cv.company_domain)) reasons.push("domains no longer match");
  if (normDomain(o.cv.company_domain) !== p.domain) reasons.push("orphan domain drifted from the inventory");
  if (o.cv.account_contact) reasons.push("orphan gained a Contact relation");
  if (o.cv.board_relation_mm76cv3c) reasons.push("orphan gained a Deal relation");
  // CONFLICT, not just orphan-only: both filled and disagreeing (name excepted — domain-stem naming)
  for (const k of ["text_mm6t1q4h", "multiple_person_mm6z8mwy"])
    if (o.cv[k] && c.cv[k] && o.cv[k] !== c.cv[k]) reasons.push(`conflicting ${k}`);
    else if (o.cv[k] && !c.cv[k]) reasons.push(`orphan-only ${k}`);
  if (reasons.length) continue;
  safe.push({ orphan: p.orphan, orphanName: o.name, canonical: p.canonical, canonicalName: c.name,
    hubspotCompanyId: c.cv.text_mm6tsnwx, domain: normDomain(c.cv.company_domain),
    canonicalEntries: p.canonicalEntries });
}
console.log(`  re-verified safe candidates: ${safe.length} of ${pool.length} checked`);
for (const s of safe.slice(0, 5))
  console.log(`    orphan ${s.orphan} "${String(s.orphanName).slice(0, 18)}" -> canonical ${s.canonical}`
    + ` "${String(s.canonicalName).slice(0, 18)}" hs=${s.hubspotCompanyId} domain=${s.domain}`
    + ` canonicalEntries=${s.canonicalEntries}`);

fs.writeFileSync(HERE + "../../docs/rollout/canonical-email-recount.json",
  JSON.stringify({ takenAt: new Date().toISOString(), E, rows, safeCandidates: safe }, null, 1));
console.log("\nwrote docs/rollout/canonical-email-recount.json (READ ONLY)");
