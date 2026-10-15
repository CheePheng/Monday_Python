/**
 * REVERT THE PHANTOM STATUS VALUES THIS INTEGRATION WROTE INTO HUBSPOT.
 *
 * monday renders an UNSET status cell with its index-5 label, and the old engine read that text as a
 * real value: its record-level backfill filled empty HubSpot properties on CRM-owned records with
 *   companies.type        = OTHER        (Accounts "Type",        index 5 = "Other")
 *   contacts.hs_lead_status = UNQUALIFIED (Contacts "Lead Status", index 5 = "Unqualified")
 *   contacts.leadstatus   = 5无意向       (Contacts "状态",         index 5 = "5无意向")
 * The engine no longer reads a phantom (dedup.ts colText). This undoes what it already wrote.
 *
 * A value is reverted ONLY when all of these hold -- most OTHER / UNQUALIFIED / 5无意向 values are real
 * (Salesforce sync, the HubSpot UI, a 2025 import) and must never be touched:
 *   1. its CURRENT HubSpot value was written by this app (history sourceType INTEGRATION,
 *      sourceId 52247773) -- anything later (a person, a merge, a workflow) wins and is left alone;
 *   2. the record is CRM-owned (sync_owner=crm), the only records the backfill could write;
 *   3. EVERY monday card carrying that HubSpot id has the status cell genuinely UNSET (index null). One
 *      id can have several cards (the Accounts board has an id on 11); if ANY of them shows a real
 *      choice, or a cell cannot be read, the record is left alone and listed. (The old read kept
 *      whichever card came back last.)
 *
 * WHAT IT IS RESTORED TO: the value from before this app, found by walking the property history PAST
 * every entry this app wrote (sourceType INTEGRATION, sourceId 52247773) to the newest one written by
 * anyone else. The old rule took history[1] whoever wrote it, so a record this app wrote twice was
 * "restored" to the phantom itself -- a no-op reported as a revert (8 companies and 8 contacts on
 * 2026-09-23). Outcomes:
 *   - someone else wrote a value before us  -> restore it (listed separately: "to a prior value");
 *   - someone else wrote the SAME phantom value before us -> it is theirs: left alone;
 *   - NOBODY else ever wrote the property   -> SKIPPED by default. There is no value by anyone else to go
 *     back to, and this run does not invent one. Measured 2026-09-24 on the first 200 planned rows of
 *     each case: EVERY one has this shape -- a history of only our own write(s) -- because HubSpot records
 *     no entry for a property that was simply never set. So by default this reverts almost nothing.
 *     --clear-never-set restores those to EMPTY (the property's state before our first write), which is
 *     the repair the phantom actually needs; it is a flag because it is a decision, not an inference.
 *
 * AT WRITE TIME, EACH BATCH OF 100 IS RE-READ FIRST: the record's current history entry must be the very
 * one planned (same value, writer and timestamp) and every card's cell still unset, or that record is
 * skipped as changed -- so a value a person set during the minutes the plan took is never overwritten.
 * The log is written after every batch, so an abort (a 400 on the batch update ends the run) still leaves
 * the record of what was applied; apply logs carry the time in their name, and no log is ever overwritten. A re-run is idempotent: a reverted record no longer matches the search.
 *
 * MUST RUN ONLY AFTER THE NEW WORKER IS DEPLOYED. On the old engine, clearing the value in HubSpot fires a
 * webhook whose sync reads the phantom text again and writes it straight back. --apply refuses unless
 * the new build is live (lib/repair-preflight.mjs requireNewBuild).
 *
 *   node scripts/repair-phantom-status.mjs                      # dry run: counts and samples, writes nothing
 *   node scripts/repair-phantom-status.mjs --clear-never-set    # dry run of the full repair
 *   node scripts/repair-phantom-status.mjs --apply [--clear-never-set]
 *
 * Needs HUBSPOT_CRM_APP_TOKEN and MONDAY_API_TOKEN in worker/.dev.vars (CRM_WORKER_URL optional).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CRM_WORKER_URL, requireNewBuild } from "./lib/repair-preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = {};
for (const l of readFileSync(join(ROOT, ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) v[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const H = v.HUBSPOT_CRM_APP_TOKEN, M = v.MONDAY_API_TOKEN;
if (!H || !M) { console.error("missing HUBSPOT_CRM_APP_TOKEN or MONDAY_API_TOKEN in .dev.vars"); process.exit(1); }
const APPLY = process.argv.includes("--apply");
const CLEAR_NEVER_SET = process.argv.includes("--clear-never-set");
const OUR_APP = "52247773";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Refuse before reading anything when the run could write: see lib/repair-preflight.mjs.
if (APPLY) {
  try { await requireNewBuild(v.CRM_WORKER_URL || DEFAULT_CRM_WORKER_URL); }
  catch (e) { console.error(`refusing --apply: ${e.message}`); process.exit(1); }
  console.log("pre-flight: the new CRM build is live");
}

async function hs(path, init = {}, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com${path}`, { ...init,
    headers: { Authorization: `Bearer ${H}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if ((r.status === 429 || r.status >= 500) && attempt < 5) { await sleep(2000 * (attempt + 1)); return hs(path, init, attempt + 1); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`hubspot ${path}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
/** A READ. Anything short of clean data -- no data, or data WITH errors -- is retried, then thrown. */
async function monday(query, variables = {}, attempt = 0) {
  const r = await fetch("https://api.monday.com/v2", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: M, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!j.data || j.errors) {
    if (attempt < 5) { await sleep(2000 * (attempt + 1)); return monday(query, variables, attempt + 1); }
    throw new Error(JSON.stringify(j.errors ?? j).slice(0, 200));
  }
  return j.data;
}

const CASES = [
  { object: "companies", prop: "type", phantom: "OTHER", board: "5028000496", idCol: "text_mm6tsnwx", col: "color_mm6zwhwt" },
  { object: "contacts", prop: "hs_lead_status", phantom: "UNQUALIFIED", board: "5028000495", idCol: "text_mm6t71dj", col: "color_mm6zb4tc" },
  { object: "contacts", prop: "leadstatus", phantom: "5无意向", board: "5028000495", idCol: "text_mm6t71dj", col: "color_mm70v2cd" },
];

/** Every CRM-owned record holding the phantom value. Asserts it stays under search's silent 10k cap. */
async function candidates(c) {
  const ids = [];
  let after;
  do {
    const r = await hs(`/crm/v3/objects/${c.object}/search`, { method: "POST", body: JSON.stringify({
      filterGroups: [{ filters: [
        { propertyName: c.prop, operator: "EQ", value: c.phantom },
        { propertyName: "sync_owner", operator: "EQ", value: "crm" },
      ] }], properties: ["hs_object_id"], limit: 100, ...(after ? { after } : {}) }) });
    if (r.total >= 10000) throw new Error(`${c.object}.${c.prop}: ${r.total} matches reaches search's 10,000 cap -- narrow the filter`);
    for (const x of r.results ?? []) ids.push(String(x.id));
    after = r.paging?.next?.after;
    await sleep(120);
  } while (after);
  return ids;
}

/** Property history, newest first, per record. */
async function histories(c, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const r = await hs(`/crm/v3/objects/${c.object}/batch/read`, { method: "POST", body: JSON.stringify({
      propertiesWithHistory: [c.prop], inputs: ids.slice(i, i + 50).map(id => ({ id })) }) });
    for (const x of r.results ?? []) out[String(x.id)] = x.propertiesWithHistory?.[c.prop] ?? [];
    await sleep(150);
  }
  return out;
}

/**
 * EVERY card's status cell for each HubSpot id -- a list, not the last one read. index null = unset =
 * phantom; undefined = the cell could not be read. Pages past 500 cards per 50 ids instead of truncating.
 */
async function cellIndex(c, ids) {
  const out = {};
  const sel = `cursor items { id column_values(ids:["${c.idCol}","${c.col}"]) { id text ... on StatusValue { index } } }`;
  for (let i = 0; i < ids.length; i += 50) {
    let d = await monday(`query($b:ID!,$c:String!,$v:[String]!){ items_page_by_column_values(board_id:$b, limit:500,
        columns:[{column_id:$c, column_values:$v}]){ ${sel} } }`, { b: c.board, c: c.idCol, v: ids.slice(i, i + 50) });
    let page = d.items_page_by_column_values;
    for (;;) {
      for (const it of page?.items ?? []) {
        const idv = it.column_values.find(x => x.id === c.idCol)?.text?.trim();
        const st = it.column_values.find(x => x.id === c.col);
        if (idv) (out[idv] ??= []).push({ item: it.id, index: st ? (st.index ?? null) : undefined, text: st?.text ?? "" });
      }
      if (!page?.cursor) break;
      d = await monday(`query($c:String!){ next_items_page(limit:500, cursor:$c){ ${sel} } }`, { c: page.cursor });
      page = d.next_items_page;
    }
    await sleep(300);
  }
  return out;
}

const isOurs = e => e?.sourceType === "INTEGRATION" && String(e?.sourceId) === OUR_APP;
/**
 * The state before the phantom: the first entry below the current one that is NOT one of this app's
 * PHANTOM writes -- or null if there is none. It stops at this app's own NON-phantom write instead of
 * walking past it: that entry is the old engine pushing a rep's real monday choice (the field is
 * reverse:true), and walking past it restored a value nobody had wanted since. Such a record is sent
 * to review, never auto-restored (see oursRealBeforePhantom below).
 */
function priorState(h, phantom) {
  for (let i = 1; i < h.length; i++) {
    if (isOurs(h[i]) && String(h[i].value ?? "") === phantom) continue;     // an earlier phantom write of ours
    return h[i];
  }
  return null;
}
const sameEntry = (a, b) => !!a && !!b && String(a.value) === String(b.value) && a.sourceType === b.sourceType
  && String(a.sourceId) === String(b.sourceId) && String(a.timestamp) === String(b.timestamp);

const at = new Date().toISOString();
const log = { at, apply: APPLY, clearNeverSet: CLEAR_NEVER_SET, cases: [] };
// Apply logs carry the time, and a taken dry-run name gets it appended: a log is never overwritten.
let out = join(ROOT, "..", "docs", "rollout",
  `phantom-status-${APPLY ? `applied-${at.slice(0, 19).replace(/:/g, "")}` : `plan-${at.slice(0, 10)}`}.json`);
if (existsSync(out)) out = out.replace(/\.json$/, `-${at.slice(11, 19).replace(/:/g, "")}.json`);
const save = () => writeFileSync(out, JSON.stringify(log, null, 1));

let aborted = null;
try {
  for (const c of CASES) {
    const ids = await candidates(c);
    const hist = await histories(c, ids);
    const cells = await cellIndex(c, ids);
    const plan = [];
    const skip = { notOurs: 0, priorIsPhantom: [], neverSetByAnyoneElse: [], realChoiceOnMonday: [], cellUnreadable: [], noCard: [],
      oursRealBeforePhantom: [] };
    let multiCard = 0;
    for (const id of ids) {
      const h = hist[id] ?? [];
      const cur = h[0];
      if (!cur || String(cur.value) !== c.phantom || !isOurs(cur)) { skip.notOurs++; continue; }
      const cs = cells[id] ?? [];
      if (!cs.length) { skip.noCard.push(id); continue; }
      if (cs.some(x => x.index === undefined)) { skip.cellUnreadable.push({ id, cards: cs.map(x => x.item) }); continue; }
      if (cs.some(x => x.index !== null)) {        // a rep really picked a label, on at least one card
        skip.realChoiceOnMonday.push({ id, cards: cs.map(x => ({ item: x.item, index: x.index, text: x.text })) });
        continue;
      }
      if (cs.length > 1) multiCard++;
      let prior = priorState(h, c.phantom);
      // Our own earlier write of a REAL value (a rep's monday choice the old engine pushed): a person decides.
      if (prior && isOurs(prior) && String(prior.value ?? "") !== "") {
        skip.oursRealBeforePhantom.push({ id, value: prior.value, at: prior.timestamp }); continue;
      }
      if (prior && isOurs(prior)) prior = null;          // our own earlier CLEAR: the pre-phantom state is empty
      if (prior && String(prior.value ?? "") === c.phantom) { skip.priorIsPhantom.push(id); continue; }
      if (!prior && !CLEAR_NEVER_SET) { skip.neverSetByAnyoneElse.push(id); continue; }
      plan.push({ id, items: cs.map(x => x.item), restore: prior ? String(prior.value ?? "") : "",
        from: prior ? `${prior.sourceType}${prior.sourceId ? ` ${prior.sourceId}` : ""} at ${prior.timestamp}` : "never set by anyone but this app",
        wroteAt: cur.timestamp, cur: { value: cur.value, sourceType: cur.sourceType, sourceId: cur.sourceId, timestamp: cur.timestamp } });
    }
    const toValue = plan.filter(p => p.restore !== "");
    console.log(`\n${c.object}.${c.prop} = ${c.phantom}`);
    console.log(`  CRM-owned records holding it: ${ids.length}`);
    console.log(`  to revert: ${plan.length}  (to empty: ${plan.length - toValue.length}, to a prior value: ${toValue.length}); `
      + `${multiCard} of them have several cards, every one unset`);
    console.log(`  left alone: written by someone else ${skip.notOurs}, same value set by someone else before us ${skip.priorIsPhantom.length}, `
      + `rep's real choice on monday (on any card) ${skip.realChoiceOnMonday.length}, cell unreadable ${skip.cellUnreadable.length}, `
      + `no card ${skip.noCard.length}`);
    if (skip.oursRealBeforePhantom.length)
      console.log(`  FOR REVIEW, not reverted: this app wrote a real value before the phantom ${skip.oursRealBeforePhantom.length}`
        + ` (listed in the plan under skip.oursRealBeforePhantom)`);
    if (skip.neverSetByAnyoneElse.length)
      console.log(`  NOT reverted: never set by anyone but this app ${skip.neverSetByAnyoneElse.length} -- pass --clear-never-set to clear them`);
    for (const p of toValue.slice(0, 10))
      console.log(`    REVIEW ${c.object}/${p.id} (cards ${p.items.join(",")}) -> restore ${JSON.stringify(p.restore)}, written by ${p.from}`);
    for (const p of plan.filter(x => x.restore === "").slice(0, 3))
      console.log(`    e.g. ${c.object}/${p.id} (cards ${p.items.join(",")}) written ${p.wroteAt} -> restore "" (${p.from})`);
    const entry = { ...c, candidates: ids.length, plan, skip };
    log.cases.push(entry);
    save();

    if (APPLY && plan.length) {
      Object.assign(entry, { applied: [], skippedAtWrite: [], batchErrors: [] });
      for (let i = 0; i < plan.length; i += 100) {
        const batch = plan.slice(i, i + 100);
        // RE-READ right before writing: the planned entry must still be current, every cell still unset.
        const fresh = await histories(c, batch.map(p => p.id));
        const freshCells = await cellIndex(c, batch.map(p => p.id));
        const go = [];
        for (const p of batch) {
          const now = (fresh[p.id] ?? [])[0];
          const cs = freshCells[p.id] ?? [];
          if (!sameEntry(now, p.cur)) entry.skippedAtWrite.push({ id: p.id, why: "HubSpot value changed since the plan", now: now ? { value: now.value, sourceType: now.sourceType, timestamp: now.timestamp } : null });
          else if (!cs.length || cs.some(x => x.index !== null)) entry.skippedAtWrite.push({ id: p.id, why: "a card's status changed since the plan" });
          else go.push(p);
        }
        if (go.length) {
          const update = list => hs(`/crm/v3/objects/${c.object}/batch/update`, { method: "POST", body: JSON.stringify({
            inputs: list.map(p => ({ id: p.id, properties: { [c.prop]: p.restore } })) }) });
          let r;
          try { r = await update(go); }
          catch (e) {
            // One rejected record 400s the whole batch -- and would again on every re-run. Fall back to one
            // at a time, record each refusal with HubSpot's message, and carry on.
            entry.batchErrors.push({ batch: i / 100, sent: go.length, updated: 0, errors: String(e).slice(0, 300), fellBackToSingles: true });
            r = { results: [] };
            for (const p of go) {
              try { const one = await update([p]); r.results.push(...(one?.results ?? [])); }
              catch (e1) { (entry.rejected ??= []).push({ id: p.id, error: String(e1).slice(0, 200) }); }
              await sleep(120);
            }
          }
          const done = new Set((r?.results ?? []).map(x => String(x.id)));
          for (const p of go) if (done.has(p.id)) entry.applied.push(p.id);
          if (r?.errors?.length)
            entry.batchErrors.push({ batch: i / 100, sent: go.length, updated: done.size, errors: JSON.stringify(r.errors).slice(0, 400) });
        }
        save();
        await sleep(400);
      }
      console.log(`  APPLIED: ${entry.applied.length} reverted, ${entry.skippedAtWrite.length} changed since the plan and left alone`
        + `${entry.batchErrors.length ? `, ${entry.batchErrors.length} batch(es) with errors -- see the log` : ""}`);
    }
  }
} catch (e) {
  aborted = String(e?.message ?? e).slice(0, 300);
  log.aborted = aborted;
}
log.done = !aborted;
save();
if (aborted) console.error(`\nABORTED: ${aborted}\nWhat was applied before it is in the log; a re-run skips what is already reverted.`);
console.log(`\n${APPLY ? "applied" : "plan"} written to ${out}`);
if (aborted) process.exit(1);
