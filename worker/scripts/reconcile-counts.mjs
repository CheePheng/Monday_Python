/**
 * READ ONLY. Reconcile monday against HubSpot by IDENTITY, never by count.
 *
 * Hiffer's 2026-09-21 10:00 snapshot: HubSpot 95,979 / 28,619 / 8,665 against monday 95,921 / 29,907 /
 * 8,668. The temptation is to delete until the numbers agree. That would be wrong in both directions:
 * Contacts is monday-SHORT by 58 (cards missing, not surplus), and the Accounts surplus is a known
 * population of cards manufactured by monday's Item Association — some of which carry email history
 * that exists nowhere else.
 *
 * So this classifies every discrepancy and writes a manifest. It has NO deletion path.
 */
import fs from "node:fs";

const TOKEN = process.env.MONDAY_API_TOKEN, HS = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN || !HS) { console.log("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN required"); process.exit(1); }

const gql = async (q, v) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query: q, variables: v }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 4) { console.log("  mErr", JSON.stringify(j.errors).slice(0, 250)); return null; }
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
const hsPost = async (p, b) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch("https://api.hubapi.com" + p, { method: "POST",
        headers: { authorization: `Bearer ${HS}`, "content-type": "application/json" },
        body: JSON.stringify(b), signal: AbortSignal.timeout(90000) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2500 * (a + 1))); continue; }
      return await r.json();
    } catch { if (a === 3) return null; }
  }
  return null;
};

/**
 * Every HubSpot id of an object — via the LIST endpoint, NOT search.
 *
 * THE SEARCH API STOPS AT 10,000 AND SAYS NOTHING. The first run of this script used it and reported
 * "10000 HubSpot companies" against 28,632 carded ids, which then made 18,598 live companies look like
 * DEAD records whose monday cards were candidates for deletion. Acting on that would have deleted
 * eighteen thousand valid Account cards. The list endpoint pages past the cap.
 */
async function allHubspotIds(object) {
  const ids = new Set();
  let after = undefined;
  for (let p = 0; p < 2000; p++) {
    const r = await hsGet(`/crm/v3/objects/${object}?limit=100&properties=hs_object_id${after ? `&after=${after}` : ""}`);
    for (const x of r?.results ?? []) ids.add(String(x.id));
    after = r?.paging?.next?.after;
    if (!after) break;
  }
  return ids;
}

/** A completeness assertion, because a truncated read is indistinguishable from a real discrepancy. */
function assertPlausible(object, got, mondayWithId) {
  if (got === 10000) throw new Error(`${object}: exactly 10000 ids returned — that is the search cap, not a count`);
  if (got < mondayWithId * 0.5) throw new Error(`${object}: only ${got} ids for ${mondayWithId} carded monday cards — read looks truncated`);
}

async function mondayCards(board, idCol, extraCols = []) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 400; p++) {
    const cols = [idCol, ...extraCols].map(c => `"${c}"`).join(",");
    const q = cursor
      ? `query ($c:String!) { boards(ids:["${board}"]) { items_page(limit:500, cursor:$c) { cursor items { id name created_at column_values(ids:[${cols}]) { id text ... on BoardRelationValue { linked_item_ids } } } } } }`
      : `query { boards(ids:["${board}"]) { items_page(limit:500) { cursor items { id name created_at column_values(ids:[${cols}]) { id text ... on BoardRelationValue { linked_item_ids } } } } } }`;
    const d = await gql(q, cursor ? { c: cursor } : {});
    const pg = d?.boards?.[0]?.items_page;
    if (!pg) break;
    for (const it of pg.items) {
      const cv = Object.fromEntries(it.column_values.map(c => [c.id, c]));
      out.push({ card: it.id, name: it.name, created: it.created_at,
        hsId: String(cv[idCol]?.text ?? "").trim(), cv });
    }
    cursor = pg.cursor;
    if (!cursor) break;
  }
  return out;
}

const REPORT = { takenAt: new Date().toISOString(), boards: {} };

for (const [key, B] of Object.entries({
  accounts: { board: "5028000496", name: "Accounts/Companies", object: "companies", idCol: "text_mm6tsnwx",
              extra: ["company_domain", "account_contact", "board_relation_mm76cv3c", "text_mm6tccd0"] },
  deals:    { board: "5028000494", name: "Deals", object: "deals", idCol: "text_mm76kxz4",
              extra: ["deal_contact", "board_relation_mm76wp4e", "text_mm7668db"] },
})) {
  console.log(`\n================ ${B.name}`);
  const [cards, hsIds] = await Promise.all([mondayCards(B.board, B.idCol, B.extra), allHubspotIds(B.object)]);

  const withId = cards.filter(c => /^\d+$/.test(c.hsId));
  const blank = cards.filter(c => !/^\d+$/.test(c.hsId));
  assertPlausible(B.object, hsIds.size, withId.length);
  const byHsId = new Map();
  for (const c of withId) { if (!byHsId.has(c.hsId)) byHsId.set(c.hsId, []); byHsId.get(c.hsId).push(c); }
  const dupes = [...byHsId.entries()].filter(([, v]) => v.length > 1);
  const orphanedIds = [...byHsId.keys()].filter(id => !hsIds.has(id));      // monday points at a dead record
  const missingFromMonday = [...hsIds].filter(id => !byHsId.has(id));       // HubSpot record with no card

  console.log(`   monday cards                 ${cards.length}`);
  console.log(`   HubSpot records              ${hsIds.size}`);
  console.log(`   cards carrying an id         ${withId.length}`);
  console.log(`   cards with BLANK id          ${blank.length}`);
  console.log(`   distinct HubSpot ids on cards${String(byHsId.size).padStart(7)}`);
  console.log(`   DUPLICATE ids (>1 card)      ${dupes.length}  (${dupes.reduce((a, [, v]) => a + v.length - 1, 0)} surplus cards)`);
  console.log(`   ids pointing at a DEAD record${String(orphanedIds.length).padStart(7)}`);
  console.log(`   HubSpot records with NO card ${missingFromMonday.length}`);
  const accounted = blank.length + dupes.reduce((a, [, v]) => a + v.length - 1, 0) + orphanedIds.length - missingFromMonday.length;
  console.log(`   ---`);
  console.log(`   surplus explained            ${accounted}   (actual delta ${cards.length - hsIds.size})`);

  REPORT.boards[key] = {
    board: B.board, mondayCards: cards.length, hubspotRecords: hsIds.size,
    withId: withId.length, blankId: blank.length, distinctIds: byHsId.size,
    duplicateIds: dupes.map(([id, v]) => ({ hsId: id, cards: v.map(c => c.card) })),
    deadIds: orphanedIds.map(id => ({ hsId: id, cards: byHsId.get(id).map(c => c.card) })),
    missingFromMonday: missingFromMonday.slice(0, 500),
    missingFromMondayCount: missingFromMonday.length,
    blankIdCards: blank.slice(0, 2000).map(c => ({
      card: c.card, name: c.name, created: c.created,
      domain: String(c.cv.company_domain?.text ?? "").trim(),
      syncState: String(c.cv.text_mm6tccd0?.text ?? c.cv.text_mm7668db?.text ?? "").trim(),
      relContacts: (c.cv.account_contact?.linked_item_ids ?? c.cv.deal_contact?.linked_item_ids ?? []).length,
      relOther: (c.cv.board_relation_mm76cv3c?.linked_item_ids ?? c.cv.board_relation_mm76wp4e?.linked_item_ids ?? []).length,
    })),
  };

  if (orphanedIds.length) {
    console.log(`\n   cards pointing at a HubSpot record that no longer exists:`);
    for (const id of orphanedIds.slice(0, 10))
      console.log(`      hs ${id} -> card(s) ${byHsId.get(id).map(c => `${c.card} "${String(c.name).slice(0, 28)}"`).join(", ")}`);
  }
  if (blank.length && blank.length <= 20) {
    console.log(`\n   blank-id cards:`);
    for (const c of blank) console.log(`      ${c.card} "${String(c.name).slice(0, 34)}" created=${String(c.created).slice(0, 10)}`
      + ` rel=${(c.cv.deal_contact?.linked_item_ids ?? c.cv.account_contact?.linked_item_ids ?? []).length}`);
  }
}

const out = "C:/Users/PC/Downloads/DKM_Project/Monday_Python-crm/docs/rollout/2026-09-21-count-reconciliation.json";
fs.writeFileSync(out, JSON.stringify(REPORT, null, 1));
console.log(`\nwrote ${out} — READ ONLY, no deletion path in this script.`);
