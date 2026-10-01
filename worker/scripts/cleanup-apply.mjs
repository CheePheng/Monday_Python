/**
 * Apply ONLY the approved safe cleanup. Every deletion re-reads its card immediately before acting and
 * FAILS CLOSED on any change since the manifest was built.
 *
 *   node --env-file=.dev.vars scripts/cleanup-apply.mjs --plan
 *   node --env-file=.dev.vars scripts/cleanup-apply.mjs --apply
 *
 * SCOPE, and nothing outside it:
 *   A. 3 blank-id Deals confirmed to hold nothing
 *   B. 5 duplicate Account cards from the 4 groups that need no migration
 *   C. 8 duplicate Account cards from the groups blocked only on display fields — the canonical card is
 *      first refreshed FROM HUBSPOT (not from the duplicate: HubSpot is the source of truth, and the
 *      duplicate's value is itself only a copy)
 *
 * NEVER touched: the 5 groups blocked on real relations/history, their 21 cards, the 7 ambiguous Deals,
 * all 1,301 id-less Accounts, and every Contact.
 */
import fs from "node:fs";

const TOKEN = process.env.MONDAY_API_TOKEN, HS = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN || !HS) { console.log("tokens required"); process.exit(1); }
const APPLY = process.argv.includes("--apply");

const gql = async (q, v) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query: q, variables: v }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 4) { console.log("      mErr", JSON.stringify(j.errors).slice(0, 200)); return null; }
    } catch { if (a === 4) return null; }
    await new Promise(s => setTimeout(s, 2000 * (a + 1)));
  }
  return null;
};
const hsGet = async (p) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch("https://api.hubapi.com" + p,
        { headers: { authorization: `Bearer ${HS}` }, signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2500 * (a + 1))); continue; }
      return await r.json();
    } catch { if (a === 3) return null; }
  }
  return null;
};

const MAN = JSON.parse(fs.readFileSync(
  "C:/Users/PC/Downloads/DKM_Project/Monday_Python-crm/docs/rollout/2026-09-22-cleanup-manifest.json", "utf8"));

const DEAL_BOARD = "5028000494", ACC_BOARD = "5028000496";
const DEAL_ID = "text_mm76kxz4", ACC_ID = "text_mm6tsnwx";

/** Approved list A — by id AND name, so a mis-keyed id cannot delete the wrong card. */
const SAFE_DEALS = [
  { card: "2862544051", name: "Incoming form answer" },
  { card: "2862590391", name: "测试" },
  { card: "2771854513", name: "test-0918-hkz" },
];
/** Groups blocked ONLY on display fields — promoted after refreshing the canonical FROM HubSpot. */
const COSMETIC_ONLY = new Set(["205195307718", "345510440690", "345751960262", "345644947181",
                               "345883270854", "345848916698", "345749478096", "345961007842"]);

async function timelineCount(cardId) {
  let n = 0, cur = null;
  for (let p = 0; p < 30; p++) {
    const q = cur ? `query ($i:ID!, $c:String!) { timeline(id:$i) { timeline_items_page(limit:100, cursor:$c) { cursor timeline_items { id } } } }`
                  : `query ($i:ID!) { timeline(id:$i) { timeline_items_page(limit:100) { cursor timeline_items { id } } } }`;
    const d = await gql(q, cur ? { i: cardId, c: cur } : { i: cardId });
    const pg = d?.timeline?.timeline_items_page;
    if (!pg) return n;
    n += (pg.timeline_items ?? []).length;
    cur = pg.cursor;
    if (!cur) break;
  }
  return n;
}
async function readCard(card, cols) {
  const d = await gql(`query ($i:[ID!]) { items(ids:$i) { id name column_values(ids:[${cols.map(c => `"${c}"`).join(",")}]) { id text ... on BoardRelationValue { linked_item_ids } } } }`,
    { i: [card] });
  const it = d?.items?.[0];
  if (!it) return null;
  return { id: it.id, name: it.name, cv: Object.fromEntries(it.column_values.map(c => [c.id, c])) };
}
const txt = (c, id) => String(c?.cv[id]?.text ?? "").trim();
const rel = (c, id) => (c?.cv[id]?.linked_item_ids ?? []);
const del = async (board, card) => {
  if (!APPLY) return "would-delete";
  const r = await gql(`mutation ($i:ID!) { delete_item(item_id:$i) { id } }`, { i: card });
  return r?.delete_item?.id ? "deleted" : "FAILED";
};

const log = [];
let deleted = 0, refused = 0, updated = 0;

// ---------------------------------------------------------------- A. blank-id Deals
console.log("================ A. blank-id Deals (3 approved)\n");
for (const t of SAFE_DEALS) {
  const c = await readCard(t.card, [DEAL_ID, "deal_contact", "board_relation_mm76wp4e",
    "board_relation_mm76btmt", "deal_value"]);
  const why = [];
  if (!c) why.push("card no longer exists");
  else {
    if (c.name !== t.name) why.push(`name changed: "${c.name}" != "${t.name}"`);
    if (txt(c, DEAL_ID)) why.push(`HubSpot id appeared: ${txt(c, DEAL_ID)}`);
    if (rel(c, "board_relation_mm76wp4e").length) why.push("an Account relation appeared");
    if (rel(c, "board_relation_mm76btmt").length) why.push("a Line Item relation appeared");
    const v = txt(c, "deal_value");
    if (v && v !== "0") why.push(`a deal value appeared: ${v}`);
    const tl = await timelineCount(t.card);
    if (tl > 0) why.push(`${tl} timeline entries appeared`);
  }
  if (why.length) {
    console.log(`   REFUSED ${t.card} "${t.name}" — ${why.join("; ")}`);
    refused++; log.push({ kind: "deal", card: t.card, action: "refused", why });
    continue;
  }
  const contacts = rel(c, "deal_contact");
  const r = await del(DEAL_BOARD, t.card);
  if (r === "deleted") deleted++;
  console.log(`   ${r} ${t.card} "${t.name}"` + (contacts.length ? `  (removed link to Contact card(s) ${contacts.join(",")})` : ""));
  log.push({ kind: "deal", card: t.card, name: t.name, action: r, removedContactLinks: contacts });
}

// ---------------------------------------------------------------- B + C. duplicate Accounts
console.log("\n================ B+C. duplicate Account cards\n");
const ACC_COLS = [ACC_ID, "company_domain", "account_contact", "board_relation_mm76cv3c",
  "text_mm6t1q4h", "multiple_person_mm6z8mwy", "text_mm707cf3", "text_mm6tccd0"];

for (const pair of MAN.accountPairs) {
  const cosmetic = COSMETIC_ONLY.has(pair.hsId);
  if (pair.classification !== "SAFE_TO_MERGE_AND_DELETE_DUPLICATE" && !cosmetic) continue;

  let keep = await readCard(pair.keep, ACC_COLS);
  if (!keep || txt(keep, ACC_ID) !== pair.hsId) {
    console.log(`   REFUSED group hs ${pair.hsId} — canonical ${pair.keep} missing or its id changed`);
    refused += pair.drop.length; continue;
  }
  // C: refresh the canonical from HUBSPOT before retiring anything. The duplicate's nicer name is
  // itself only a copy of HubSpot's; taking it from the source avoids laundering a stale display value.
  if (cosmetic && APPLY) {
    const hs = await hsGet(`/crm/v3/objects/companies/${pair.hsId}?properties=name,hs_object_source_label`);
    const patch = {};
    const hsName = String(hs?.properties?.name ?? "").trim();
    const hsSrc = String(hs?.properties?.hs_object_source_label ?? "").trim();
    if (hsName && hsName !== txt(keep, "text_mm6t1q4h")) patch["text_mm6t1q4h"] = hsName;
    if (hsSrc && hsSrc !== txt(keep, "text_mm707cf3")) patch["text_mm707cf3"] = hsSrc;
    if (Object.keys(patch).length) {
      const r = await gql(`mutation ($b:ID!, $i:ID!, $v:JSON!) { change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v) { id } }`,
        { b: ACC_BOARD, i: pair.keep, v: JSON.stringify(patch) });
      if (r) {
        updated++;
        console.log(`   refreshed canonical ${pair.keep} from HubSpot: ${JSON.stringify(patch)}`);
        // RE-READ, or the per-drop guard below compares against the PRE-refresh snapshot and refuses
        // every one of these groups. Harmless (it fails closed) but it is a refusal for the wrong
        // reason, and a guard that fires on stale data is a guard nobody can trust.
        keep = await readCard(pair.keep, ACC_COLS);
        if (!keep || txt(keep, ACC_ID) !== pair.hsId) {
          console.log(`   REFUSED group hs ${pair.hsId} — canonical unreadable after refresh`);
          refused += pair.drop.length; continue;
        }
      } else { console.log(`   REFUSED group hs ${pair.hsId} — could not refresh canonical`); refused += pair.drop.length; continue; }
    }
  }

  for (const d of pair.drop) {
    const dc = await readCard(d.card, ACC_COLS);
    const why = [];
    if (!dc) why.push("already gone");
    else {
      if (txt(dc, ACC_ID) !== pair.hsId) why.push(`its HubSpot id changed to "${txt(dc, ACC_ID)}"`);
      const tl = await timelineCount(d.card);
      if (tl > 0) why.push(`${tl} timeline entries`);
      for (const [col, lbl] of [["account_contact", "Contact"], ["board_relation_mm76cv3c", "Deal"]]) {
        const extra = rel(dc, col).filter(x => !rel(keep, col).includes(x));
        if (extra.length) why.push(`${extra.length} unique ${lbl} relation(s)`);
      }
      for (const [col, lbl] of [["text_mm6t1q4h", "Company name"], ["multiple_person_mm6z8mwy", "Company owner"],
                                ["company_domain", "domain"], ["text_mm707cf3", "Record source"]])
        if (txt(dc, col) && !txt(keep, col)) why.push(`${lbl} still absent on canonical`);
    }
    if (why.length) {
      console.log(`   REFUSED ${d.card} "${String(d.name).slice(0, 24)}" (hs ${pair.hsId}) — ${why.join("; ")}`);
      refused++; log.push({ kind: "account", card: d.card, action: "refused", why });
      continue;
    }
    const r = await del(ACC_BOARD, d.card);
    if (r === "deleted") deleted++;
    console.log(`   ${r} ${d.card} "${String(d.name).slice(0, 24)}"  (canonical ${pair.keep} keeps hs ${pair.hsId})`);
    log.push({ kind: "account", card: d.card, name: d.name, hsId: pair.hsId, canonical: pair.keep, action: r });
  }
}

console.log(`\n================ ${APPLY ? "APPLIED" : "PLAN"}: deleted ${deleted}  refused ${refused}  canonical refreshed ${updated}`);
fs.writeFileSync("C:/Users/PC/Downloads/DKM_Project/Monday_Python-crm/docs/rollout/2026-09-22-cleanup-applied.json",
  JSON.stringify({ at: new Date().toISOString(), apply: APPLY, deleted, refused, updated, log }, null, 1));
if (!APPLY) console.log("--plan only. Nothing deleted.");
