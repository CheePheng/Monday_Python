/**
 * READ ONLY. Has any id-less Account appeared since the Item Association toggle was switched off?
 *
 * Compares the live board against docs/rollout/post-disable-baseline.json. Deliberately a one-shot
 * check, not a poller: repeatedly asking a quiet board the same question produces the comforting
 * answer for free and proves nothing. Run it again after real traffic has passed through.
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

const base = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/post-disable-baseline.json", "utf8"));
const ID_COL = "text_mm6tsnwx", DOMAIN = "company_domain";

// newest-first; stop as soon as we are older than the baseline's newest id-less card
const cutoff = base.newestIdless[0].created;
const fresh = [];
let cursor = null, scanned = 0;
for (;;) {
  const q = cursor
    ? `query ($c:String!) { next_items_page(limit:200, cursor:$c) { cursor items { id name created_at column_values(ids:["${ID_COL}","${DOMAIN}"]) { id text } } } }`
    : `query { boards(ids:["5028000496"]) { items_page(limit:200,
         query_params:{order_by:[{column_id:"__creation_log__", direction:desc}]}) {
         cursor items { id name created_at column_values(ids:["${ID_COL}","${DOMAIN}"]) { id text } } } } }`;
  const r = await gql(q, cursor ? { c: cursor } : {});
  if (!r) { console.log("read failed — cannot report"); process.exit(1); }
  const page = cursor ? r.next_items_page : r.boards[0].items_page;
  let done = false;
  for (const it of page.items) {
    scanned++;
    if (it.created_at <= cutoff) { done = true; break; }
    const cv = Object.fromEntries(it.column_values.map(c => [c.id, (c.text ?? "").trim()]));
    if (!cv[ID_COL]) fresh.push({ card: it.id, name: it.name, created: it.created_at, domain: cv[DOMAIN] ?? "" });
  }
  cursor = page.cursor;
  if (done || !cursor) break;
}

console.log("================ POST-DISABLE CHECK");
console.log(`  baseline taken            ${base.takenAt}`);
console.log(`  baseline newest id-less   ${cutoff}  (${base.newestIdless[0].card} "${base.newestIdless[0].name}")`);
console.log(`  cards scanned newest-first ${scanned}`);
console.log(`  NEW id-less cards since    ${fresh.length}`);
for (const f of fresh) console.log(`     ${f.created}  ${f.card}  "${f.name}"  ${f.domain}`);
console.log(fresh.length === 0
  ? "\n  No new id-less Accounts since the baseline.\n"
    + "  ENCOURAGING, NOT PROOF: the board may simply have been quiet. Re-run after a working day of\n"
    + "  real email and contact traffic before treating the creator as stopped."
  : "\n  NEW id-less Accounts appeared AFTER the toggle was switched off — Item Association was not the\n"
    + "  only producer. Investigate these before any cleanup.");
