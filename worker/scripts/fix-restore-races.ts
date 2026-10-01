/**
 * Correct the 8 Contacts the 2026-09-18 Last Activity Date restoration overwrote with stale values.
 *
 * Runs through src/bulk-restore.ts — the same code the tests cover — so the fix and the hardening
 * are the same thing rather than two implementations that agree today.
 *
 * PLAN by default; --apply writes. HubSpot is only ever READ.
 */
import fs from "node:fs";
import { restorePlan, type RestoreDeps, type RestoreJob } from "../src/bulk-restore";

const APPLY = process.argv.includes("--apply");
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const v = Object.fromEntries(
  fs.readFileSync(HERE + "../.dev.vars", "utf8").split(/\r?\n/).filter(l => l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));

const BOARD = "5028000495", DATE_COL = "date_mm7054jz", ID_COL = "text_mm6t71dj";

const gql = async (query: string, variables: Record<string, unknown>): Promise<any> => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(90000) });
      const j = await r.json() as any;
      if (!j.errors) return j.data;
      if (a === 4) throw new Error(JSON.stringify(j.errors).slice(0, 220));
    } catch (e) { if (a === 4) throw e; }
    await new Promise(s => setTimeout(s, 2000 * (a + 1)));
  }
};
const hsRead = async (id: string): Promise<string> => {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${id}?properties=notes_last_updated`,
    { headers: { authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`hubspot ${r.status} for ${id}`);
  const j = await r.json() as any;
  return String(j.properties?.notes_last_updated ?? "").slice(0, 10);
};

/** The 8, paired card -> HubSpot id, with what the stale plan had written. */
const JOBS: RestoreJob[] = [
  { card: "2856257713", sourceId: "144102291751", planned: "2026-08-31" },
  { card: "2856406424", sourceId: "500316296902", planned: "2026-09-10" },
  { card: "2856428538", sourceId: "539852464865", planned: "2026-09-15" },
  { card: "2856429954", sourceId: "540010821318", planned: "2026-09-15" },
  { card: "2860523117", sourceId: "553216393961", planned: "2026-09-16" },
  { card: "2860532852", sourceId: "553234198263", planned: "2026-09-16" },
  { card: "2860551747", sourceId: "553209071300", planned: "2026-09-16" },
  { card: "2860598634", sourceId: "553259001533", planned: "2026-09-16" },
];

/** PLAN mode must still SIMULATE the write, or the post-write re-read never matches and every record
 *  retries to exhaustion — a dry run that reports problems it invented is worse than no dry run. */
const shadow = new Map<string, string>();

const deps: RestoreDeps = {
  readSource: hsRead,
  readTarget: async (card) => {
    if (!APPLY && shadow.has(card)) return shadow.get(card)!;
    const d = await gql(`query ($i:[ID!]) { items(ids:$i) { column_values(ids:["${DATE_COL}"]) { text } } }`, { i: [card] });
    return String(d.items?.[0]?.column_values?.[0]?.text ?? "").slice(0, 10);
  },
  readMapping: async (card) => {
    const d = await gql(`query ($i:[ID!]) { items(ids:$i) { column_values(ids:["${ID_COL}"]) { text } } }`, { i: [card] });
    return String(d.items?.[0]?.column_values?.[0]?.text ?? "").trim();
  },
  write: async (card, value) => {
    if (!APPLY) { console.log(`      [plan] would write ${JSON.stringify(value)} to ${card}`); shadow.set(card, value); return; }
    await gql(`mutation ($i:ID!, $v:JSON!) { change_column_value(board_id:${BOARD}, item_id:$i, column_id:"${DATE_COL}", value:$v) { id } }`,
      { i: card, v: JSON.stringify(value ? { date: value } : {}) });
  },
};

console.log(`${APPLY ? "APPLY" : "PLAN (no writes)"} — ${JOBS.length} Contacts, one at a time\n`);
const summary = await restorePlan(deps, JOBS, r => {
  console.log(`  ${r.card}  hs=${r.sourceId}`);
  console.log(`      planned(stale)=${r.planned}  source_now=${r.source || "(empty)"}  before=${r.before || "(empty)"}  after=${r.after || "(empty)"}`);
  console.log(`      -> ${r.action}${r.note ? "  " + r.note : ""}  attempts=${r.attempts}  planStale=${r.plannedWasStale}`);
});

console.log(`\nwritten ${summary.written}   already-correct ${summary.skipped}   problems ${summary.problems.length}   stale plans ${summary.staleplans}`);
if (summary.problems.length) for (const p of summary.problems) console.log(`  PROBLEM ${p.card}: ${p.action} ${p.note ?? ""}`);
if (!APPLY) console.log("\nre-run with --apply to write");
