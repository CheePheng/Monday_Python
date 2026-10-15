/**
 * READ ONLY. Classify every bucket of the monday/HubSpot count mismatch. NO DELETION PATH.
 *
 * Produces the approval manifest: what is provably safe to retire, what must be migrated first, and
 * what must be left alone. Reconciles by IDENTITY — a count is never a reason to delete a record.
 *
 * Uses the HubSpot LIST endpoint throughout. Search caps at 10,000 silently, and on the first attempt
 * that made 18,598 live companies look deleted.
 */
import fs from "node:fs";

const TOKEN = process.env.MONDAY_API_TOKEN, HS = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN || !HS) { console.log("tokens required"); process.exit(1); }

const gql = async (q, v) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query: q, variables: v }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 4) { console.log("  mErr", JSON.stringify(j.errors).slice(0, 220)); return null; }
    } catch { if (a === 4) return null; }
    await new Promise(s => setTimeout(s, 2000 * (a + 1)));
  }
  return null;
};
const hsGet = async (p) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.hubapi.com" + p,
        { headers: { authorization: `Bearer ${HS}` }, signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2500 * (a + 1))); continue; }
      return await r.json();
    } catch { if (a === 4) return null; }
  }
  return null;
};

/** All ids + createdate, via LIST (not search — see the header). */
async function hubspotAll(object) {
  const out = new Map();
  let after = undefined;
  for (let p = 0; p < 3000; p++) {
    const r = await hsGet(`/crm/v3/objects/${object}?limit=100&properties=createdate${after ? `&after=${after}` : ""}`);
    for (const x of r?.results ?? []) out.set(String(x.id), String(x.properties?.createdate ?? ""));
    after = r?.paging?.next?.after;
    if (!after) break;
  }
  if (out.size === 10000) throw new Error(`${object}: exactly 10000 — that is the search cap, not a count`);
  return out;
}

async function cards(board, cols) {
  const out = [];
  let cur = null;
  for (let p = 0; p < 400; p++) {
    const sel = cols.map(c => `"${c}"`).join(",");
    const q = cur
      ? `query ($c:String!) { boards(ids:["${board}"]) { items_page(limit:500, cursor:$c) { cursor items { id name created_at updated_at column_values(ids:[${sel}]) { id text ... on BoardRelationValue { linked_item_ids } ... on MirrorValue { display_value } } } } } }`
      : `query { boards(ids:["${board}"]) { items_page(limit:500) { cursor items { id name created_at updated_at column_values(ids:[${sel}]) { id text ... on BoardRelationValue { linked_item_ids } ... on MirrorValue { display_value } } } } } }`;
    const d = await gql(q, cur ? { c: cur } : {});
    const pg = d?.boards?.[0]?.items_page;
    if (!pg) break;
    for (const it of pg.items)
      out.push({ card: it.id, name: it.name, created: it.created_at, updated: it.updated_at,
        cv: Object.fromEntries(it.column_values.map(c => [c.id, c])) });
    cur = pg.cursor;
    if (!cur) break;
  }
  return out;
}
/** Timeline entry count — the history that exists ONLY in monday and cannot be recovered. */
async function timelineCount(cardId) {
  let n = 0, cur = null, seen = new Set();
  for (let p = 0; p < 40; p++) {
    const q = cur
      ? `query ($i:ID!, $c:String!) { timeline(id:$i) { timeline_items_page(limit:100, cursor:$c) { cursor timeline_items { id } } } }`
      : `query ($i:ID!) { timeline(id:$i) { timeline_items_page(limit:100) { cursor timeline_items { id } } } }`;
    const d = await gql(q, cur ? { i: cardId, c: cur } : { i: cardId });
    const pg = d?.timeline?.timeline_items_page;
    if (!pg) return n;
    n += (pg.timeline_items ?? []).length;
    cur = pg.cursor;
    if (!cur || seen.has(cur)) break;
    seen.add(cur);
  }
  return n;
}
const txt = (c, id) => String(c.cv[id]?.text ?? "").trim();
const rel = (c, id) => (c.cv[id]?.linked_item_ids ?? []);

const M = { takenAt: new Date().toISOString() };
const ACC = { board: "5028000496", idCol: "text_mm6tsnwx" };
const DEA = { board: "5028000494", idCol: "text_mm76kxz4" };

// ================================================================ fresh totals
console.log("================ 1. FRESH RECONCILIATION (list endpoint)\n");
const [hsC, hsCo, hsD] = await Promise.all([hubspotAll("contacts"), hubspotAll("companies"), hubspotAll("deals")]);
const accCards = await cards(ACC.board, [ACC.idCol, "company_domain", "account_contact",
  "board_relation_mm76cv3c", "text_mm6tccd0", "text_mm6t1q4h", "multiple_person_mm6z8mwy", "text_mm707cf3"]);
const deaCards = await cards(DEA.board, [DEA.idCol, "deal_contact", "board_relation_mm76wp4e",
  "board_relation_mm76btmt", "text_mm7668db", "deal_value", "deal_stage"]);
const conCards = await cards("5028000495", ["text_mm6t71dj"]);

const idsOf = (cs, col) => { const m = new Map();
  for (const c of cs) { const v = txt(c, col); if (/^\d+$/.test(v)) { if (!m.has(v)) m.set(v, []); m.get(v).push(c); } }
  return m; };
const accById = idsOf(accCards, ACC.idCol), deaById = idsOf(deaCards, DEA.idCol),
      conById = idsOf(conCards, "text_mm6t71dj");

for (const [label, hsMap, byId, all] of [["Contacts", hsC, conById, conCards],
    ["Companies/Accounts", hsCo, accById, accCards], ["Deals", hsD, deaById, deaCards]]) {
  const missing = [...hsMap.keys()].filter(id => !byId.has(id));
  const dead = [...byId.keys()].filter(id => !hsMap.has(id));
  const dupes = [...byId.entries()].filter(([, v]) => v.length > 1);
  console.log(`${label}`);
  console.log(`   HubSpot ${hsMap.size}   monday ${all.length}   delta ${all.length - hsMap.size}`);
  console.log(`   blank-id ${all.length - [...byId.values()].flat().length}   duplicate-id groups ${dupes.length}`
    + ` (+${dupes.reduce((a, [, v]) => a + v.length - 1, 0)} surplus)   dead ids ${dead.length}   missing from monday ${missing.length}`);
  // WHEN were the missing ones created? If they postdate the import, the deployed Worker cards them
  // automatically and hand-importing is wasted work that races the webhook.
  if (missing.length) {
    const dates = missing.map(id => hsMap.get(id)).filter(Boolean).sort();
    const after = dates.filter(d => Date.parse(d) > Date.parse("2026-09-16T00:00:00Z")).length;
    console.log(`   missing created AFTER the 2026-09-16 cutover: ${after}/${dates.length}`
      + `   oldest ${String(dates[0]).slice(0, 10)}   newest ${String(dates[dates.length - 1]).slice(0, 10)}`);
  }
  M[label] = { hubspot: hsMap.size, monday: all.length, missing, dead,
    dupes: dupes.map(([id, v]) => ({ hsId: id, cards: v.map(c => c.card) })) };
  console.log("");
}

// ================================================================ 2. the 17 Account duplicate pairs
console.log("\n================ 2. ACCOUNT DUPLICATE-ID PAIRS\n");
const accDupes = [...accById.entries()].filter(([, v]) => v.length > 1);
M.accountPairs = [];
for (const [hsId, group] of accDupes) {
  const enriched = [];
  for (const c of group) enriched.push({ c, tl: await timelineCount(c.card) });
  // Canonical = most timeline history, then most relations, then oldest.
  const score = (e) => e.tl * 1000 + rel(e.c, "account_contact").length * 10 + rel(e.c, "board_relation_mm76cv3c").length * 10;
  enriched.sort((a, b) => score(b) - score(a) || Date.parse(a.c.created) - Date.parse(b.c.created));
  const [keep, ...drop] = enriched;
  const uniqueOnDrop = [];
  for (const d of drop) {
    if (d.tl > 0) uniqueOnDrop.push(`${d.c.card}: ${d.tl} timeline entries`);
    for (const [col, lbl] of [["account_contact", "Contacts"], ["board_relation_mm76cv3c", "Deals"]]) {
      const extra = rel(d.c, col).filter(x => !rel(keep.c, col).includes(x));
      if (extra.length) uniqueOnDrop.push(`${d.c.card}: ${extra.length} ${lbl} relation(s) not on canonical`);
    }
    for (const [col, lbl] of [["text_mm6t1q4h", "Company name"], ["multiple_person_mm6z8mwy", "Company owner"],
                              ["company_domain", "domain"], ["text_mm707cf3", "Record source"]])
      if (txt(d.c, col) && !txt(keep.c, col)) uniqueOnDrop.push(`${d.c.card}: ${lbl}="${txt(d.c, col)}" absent on canonical`);
  }
  const cls = uniqueOnDrop.length ? "NEEDS_DATA_MIGRATION_FIRST" : "SAFE_TO_MERGE_AND_DELETE_DUPLICATE";
  M.accountPairs.push({ hsId, classification: cls, keep: keep.c.card, keepName: keep.c.name,
    keepTimeline: keep.tl, drop: drop.map(d => ({ card: d.c.card, name: d.c.name, timeline: d.tl })), uniqueOnDrop });
  console.log(`   hs ${hsId}  ${cls}`);
  console.log(`      KEEP  ${keep.c.card} "${String(keep.c.name).slice(0, 30)}" tl=${keep.tl}`
    + ` contacts=${rel(keep.c, "account_contact").length} deals=${rel(keep.c, "board_relation_mm76cv3c").length}`);
  for (const d of drop) console.log(`      DROP  ${d.c.card} "${String(d.c.name).slice(0, 30)}" tl=${d.tl}`
    + ` contacts=${rel(d.c, "account_contact").length} deals=${rel(d.c, "board_relation_mm76cv3c").length}`);
  for (const u of uniqueOnDrop) console.log(`         ! ${u}`);
}

// ================================================================ 3. the blank-id Deals
console.log("\n\n================ 3. BLANK-ID DEALS\n");
const blankDeals = deaCards.filter(c => !/^\d+$/.test(txt(c, DEA.idCol)));
M.blankDeals = [];
for (const c of blankDeals) {
  const tl = await timelineCount(c.card);
  const contacts = rel(c, "deal_contact").length, accounts = rel(c, "board_relation_mm76wp4e").length,
        lines = rel(c, "board_relation_mm76btmt").length;
  const value = txt(c, "deal_value"), stage = txt(c, "deal_stage"), sync = txt(c, "text_mm7668db");
  const testish = /^(test|测试|google deal|apple deal|amazon deal|incoming form answer)/i.test(c.name);
  const hasSubstance = tl > 0 || accounts > 0 || lines > 0 || (value && value !== "0");
  const cls = hasSubstance ? "AMBIGUOUS"
            : testish && contacts === 0 ? "CONFIRMED_TEST_SAFE_TO_DELETE"
            : testish ? "CONFIRMED_TEST_SAFE_TO_DELETE_has_contact_link"
            : "REAL_MONDAY_ONLY_RECORD";
  M.blankDeals.push({ card: c.card, name: c.name, created: c.created, updated: c.updated,
    timeline: tl, contacts, accounts, lineItems: lines, value, stage, sync, classification: cls });
  console.log(`   ${c.card} "${String(c.name).slice(0, 26).padEnd(26)}" ${cls}`);
  console.log(`      created=${String(c.created).slice(0, 10)} updated=${String(c.updated).slice(0, 10)}`
    + ` tl=${tl} contacts=${contacts} accounts=${accounts} lineItems=${lines} value="${value}" stage="${stage}" sync="${sync}"`);
}

const out = "C:/Users/PC/Downloads/DKM_Project/Monday_Python-crm/docs/rollout/2026-09-22-cleanup-manifest.json";
fs.writeFileSync(out, JSON.stringify(M, null, 1));
console.log(`\n\nwrote ${out}`);
console.log("READ ONLY — this script contains no delete_item call.");
