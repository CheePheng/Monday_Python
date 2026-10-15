/**
 * WHICH CARDS SHOW A STALE LAST ACTIVITY DATE THAT AN ORDINARY SYNC WOULD FIX? READ-ONLY.
 *
 * Why this exists. Until the 2026-09-30 fix, the second HubSpot event of every logged activity (the
 * notes_last_updated propertyChange, 2-12 s after the association event) was coalesced into the first
 * one's in-flight sync and dropped, so Last Activity Date reached only 77% of Contacts, 67% of Accounts
 * and 4 of 5 Deals. Those cards stay stale until the record next changes. This lists them so they can
 * be refreshed through the Worker itself:
 *
 *   node scripts/refresh-forward.mjs --object contacts --no-force --ids-file <the file this writes>
 *
 * THE RULE, and why it is two-sided. A card is listed when
 *   (a) its Last Activity Date differs from HubSpot's notes_last_updated, read as the Asia/Shanghai day
 *       (the columns are localDate fields: mapping.ts dateCell), AND
 *   (b) HubSpot's record is NEWER than the card's Sync State.
 * (b) is what makes a plain, non-forced sync act: the engine forwards HubSpot only when it changed since
 * the card was last synced. A card that differs but is NOT newer would be read as a person's pending
 * monday edit and left alone -- fixing that needs forceForward, which can also revert real pending edits,
 * so those are counted and written to a separate "-needs-force" file for a human, never to the main list.
 * What --no-force does NOT promise: once HubSpot is newer than Sync State (every card on the main list),
 * the ordinary sync forwards every column that differs -- including one a person edited whose
 * column-level push has not landed yet. That is exactly what an ordinary webhook would do to the card;
 * it does not revert an edit UNLESS HubSpot has itself changed since the card's last sync.
 *
 * HUBSPOT EMPTY is its own bucket, in neither file. A card still showing a date (stamped by the old
 * automations #09/#10) where notes_last_updated is empty can be fixed by NO sync, forced or not: the
 * engine never clears a monday value from an empty HubSpot one (reconcile.ts fieldDiffs, "we don't fight
 * monday"). Listed, it would only inflate both files and invite a forceForward that fixes nothing.
 *
 *   node scripts/find-stale-lad.mjs                       # all three objects
 *   options: --object contacts|companies|deals            one object
 *            --limit N                                    stop after N cards per object (a trial)
 *            --out-dir DIR                                where the ids files go (default docs/rollout)
 *
 * Writes <date>-stale-lad-<object>-ids.txt (one HubSpot id per line), <date>-stale-lad-<object>-needs-force.txt
 * and <date>-stale-lad-summary.json -- NEVER over an earlier run's: if any of today's names exists, this
 * run's files all carry a -HHMMSS suffix (the rule refresh-forward.mjs and wake-timelines.mjs follow). Needs MONDAY_API_TOKEN and HUBSPOT_CRM_APP_TOKEN in worker/.dev.vars.
 * Sends monday queries and HubSpot reads only (batch/read is a POST that reads). Prints no secrets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Must match src/config/crm.ts (find-stale-lad.test.ts pins every value against the specs). */
export const STALE_OBJECTS = {
  contacts:  { board: "5028000495", idCol: "text_mm6t71dj", ladCol: "date_mm7054jz", syncStateCol: "text_mm6twy4w", modifiedProp: "lastmodifieddate" },
  companies: { board: "5028000496", idCol: "text_mm6tsnwx", ladCol: "date_mm7dtzwm", syncStateCol: "text_mm6tccd0", modifiedProp: "hs_lastmodifieddate" },
  deals:     { board: "5028000494", idCol: "text_mm76kxz4", ladCol: "date__1",       syncStateCol: "text_mm7668db", modifiedProp: "hs_lastmodifieddate" },
};
export const LAD_PROP = "notes_last_updated";
/** Asia/Shanghai: UTC+8, no daylight saving -- the same constant mapping.ts uses. */
const OFFSET_MS = 8 * 3_600_000;

/** HubSpot's instant as the calendar day the card should show; "" for none. Mirrors dateCell(localDate). */
export function localDay(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t + OFFSET_MS).toISOString().slice(0, 10) : raw.slice(0, 10);
}

/** A monday date cell's day, from its value JSON ({date}) or its text; "" for empty. */
export function cardDay(cv) {
  if (!cv) return "";
  try { const v = typeof cv.value === "string" ? JSON.parse(cv.value) : cv.value; if (v?.date) return String(v.date).slice(0, 10); }
  catch { /* fall back to the text */ }
  return String(cv.text ?? "").trim().slice(0, 10);
}

/**
 * "stale"            -- differs, and HubSpot changed since Sync State: a non-forced sync fixes it.
 * "differs-not-newer" -- differs, but a non-forced sync would leave it (needs forceForward; a human's call).
 * "hubspot-empty"    -- HubSpot has no date and the card has one: no sync can clear it (see above).
 * "in-line"          -- the card already shows HubSpot's day.
 */
export function classifyStale({ cardLad, hsLad, hsModified, syncState }) {
  if (cardLad === localDay(hsLad)) return "in-line";
  if (!localDay(hsLad)) return "hubspot-empty";
  const hs = Date.parse(String(hsModified ?? "")) || 0;
  const synced = Date.parse(String(syncState ?? "")) || 0;   // "not synced -- ..." or empty: never synced
  return hs > synced ? "stale" : "differs-not-newer";
}

// ------------------------------------------------------------------------------------------ I/O
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const v = {};
  for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  const M = v.MONDAY_API_TOKEN, H = v.HUBSPOT_CRM_APP_TOKEN;
  if (!M || !H) { console.error("needs MONDAY_API_TOKEN and HUBSPOT_CRM_APP_TOKEN in worker/.dev.vars"); process.exit(1); }
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const only = arg("--object");
  if (only && !STALE_OBJECTS[only]) { console.error(`--object must be one of ${Object.keys(STALE_OBJECTS).join("|")}`); process.exit(2); }
  const LIMIT = Number(arg("--limit", 0)) || Infinity;
  const OUT = resolve(arg("--out-dir", join(ROOT, "..", "docs", "rollout")));
  mkdirSync(OUT, { recursive: true });

  async function md(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { Authorization: M, "Content-Type": "application/json", "API-Version": "2024-10" },
        body: JSON.stringify({ query, variables }) });
      const j = await r.json().catch(() => ({}));
      const err = JSON.stringify(j.errors ?? j.error_message ?? "");
      if ((r.status === 429 || /complexity|rate.?limit|budget/i.test(err)) && attempt < 8) { await sleep(15_000 * (attempt + 1)); continue; }
      if (!r.ok || j.errors || j.error_message) throw new Error(`monday ${r.status}: ${err.slice(0, 200)}`);
      return j.data;
    }
  }
  async function hsRead(object, ids, props) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${object}/batch/read`, { method: "POST",
        headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: props, inputs: ids.map(id => ({ id })) }) });
      if ((r.status === 429 || r.status >= 500) && attempt < 6) { await sleep(2500 * (attempt + 1)); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 207) throw new Error(`hubspot batch/read ${object}: ${r.status}`);
      return j.results ?? [];
    }
  }

  const startedAt = new Date().toISOString();
  const date = startedAt.slice(0, 10);
  // NEVER OVERWRITE: one suffix for the whole run, so its ids, needs-force and summary files stay a set.
  const base = Object.keys(STALE_OBJECTS).flatMap(o => [`${date}-stale-lad-${o}-ids.txt`, `${date}-stale-lad-${o}-needs-force.txt`])
    .concat(`${date}-stale-lad-summary.json`);
  const suffix = base.some(f => existsSync(join(OUT, f))) ? `-${startedAt.slice(11, 19).replace(/:/g, "")}` : "";
  const named = f => join(OUT, f.replace(/(\.[a-z]+)$/, `${suffix}$1`));
  const summary = { at: new Date().toISOString(), rule: "card LAD != localDay(notes_last_updated) AND hs modified > Sync State", objects: {} };
  for (const [object, o] of Object.entries(STALE_OBJECTS)) {
    if (only && object !== only) continue;
    const cards = [];
    let cursor = null;
    do {
      const cols = `column_values(ids: ["${o.idCol}", "${o.ladCol}", "${o.syncStateCol}"]) { id text value }`;
      const d = cursor
        ? await md(`query ($c: String!) { next_items_page(limit: 500, cursor: $c) { cursor items { id ${cols} } } }`, { c: cursor })
        : await md(`query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 500) { cursor items { id ${cols} } } } }`, { b: [o.board] });
      const page = cursor ? d.next_items_page : d.boards[0].items_page;
      for (const it of page.items) {
        const cv = Object.fromEntries(it.column_values.map(c => [c.id, c]));
        const hsId = String(cv[o.idCol]?.text ?? "").trim();
        if (/^\d+$/.test(hsId)) cards.push({ item: it.id, hsId, lad: cardDay(cv[o.ladCol]), sync: String(cv[o.syncStateCol]?.text ?? "") });
      }
      cursor = page.cursor;
      if (cards.length >= LIMIT) break;
    } while (cursor);
    const todo = cards.slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);
    console.log(`${object}: ${todo.length} linked cards read`);

    const tally = { "in-line": 0, stale: 0, "differs-not-newer": 0, "hubspot-empty": 0, "missing-in-hubspot": 0 };
    const stale = [], needsForce = [], sample = [];
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const recs = await hsRead(object, [...new Set(batch.map(c => c.hsId))], [LAD_PROP, o.modifiedProp]);
      const byId = new Map(recs.map(r => [String(r.id), r.properties ?? {}]));
      for (const c of batch) {
        const p = byId.get(c.hsId);
        if (!p) { tally["missing-in-hubspot"]++; continue; }
        const k = classifyStale({ cardLad: c.lad, hsLad: p[LAD_PROP], hsModified: p[o.modifiedProp], syncState: c.sync });
        tally[k]++;
        if (k === "stale") { stale.push(c.hsId); if (sample.length < 5) sample.push({ ...c, hsDay: localDay(p[LAD_PROP]), hsModified: p[o.modifiedProp] }); }
        if (k === "differs-not-newer") needsForce.push(c.hsId);
      }
      if ((i / 100) % 50 === 0) console.log(`  ${Math.min(i + 100, todo.length)}/${todo.length} ${JSON.stringify(tally)}`);
    }
    const idsFile = named(`${date}-stale-lad-${object}-ids.txt`);
    const forceFile = named(`${date}-stale-lad-${object}-needs-force.txt`);
    writeFileSync(idsFile, [...new Set(stale)].join("\n") + (stale.length ? "\n" : ""));
    writeFileSync(forceFile, [...new Set(needsForce)].join("\n") + (needsForce.length ? "\n" : ""));
    summary.objects[object] = { cards: todo.length, tally, idsFile, forceFile, sample };
    console.log(`${object}: ${JSON.stringify(tally)}`);
    if (tally["hubspot-empty"]) console.log(`  ${tally["hubspot-empty"]} show a date HubSpot does not have (old #09/#10 stamps):`
      + " no sync clears them, forced or not -- in neither file.");
    console.log(`  fix (dry run first): node scripts/refresh-forward.mjs --object ${object} --no-force --ids-file "${idsFile}"`);
    if (needsForce.length) console.log(`  ${needsForce.length} differ but are NOT newer than Sync State: a non-forced sync leaves them. Listed in`
      + `\n  "${forceFile}" for a human -- forceForward would also revert any real pending monday edit.`);
  }
  const sumFile = named(`${date}-stale-lad-summary.json`);
  writeFileSync(sumFile, JSON.stringify(summary, null, 2));
  console.log(`summary: ${sumFile}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
