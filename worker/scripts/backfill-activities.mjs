/**
 * HISTORICAL ACTIVITY BACKFILL — HubSpot -> monday timelines, visibility only.
 *
 * Moves every historical Email, Call, Note, Meeting and Task onto the timeline of every CRM object
 * HubSpot associated it with: Contacts, Accounts/Companies and Deals. The point is that a salesperson
 * working only in monday can read the whole history of a person, an account or a deal without needing
 * a HubSpot seat.
 *
 * WHY THIS NEEDS NO DURABLE-OBJECT COORDINATION WITH THE LIVE SYNC. The live Worker refuses anything
 * whose timestamp precedes ACTIVITY_CUTOVER_AT; this script refuses anything at or after it. The two
 * therefore operate on disjoint sets of activities and cannot race for the same destination. That is
 * a property of the cutover, not an accident, and the script asserts it rather than assuming it.
 *
 * DEDUPLICATION IS BY WHAT IS ACTUALLY ON THE CARD, not by a marker search. Each destination card's
 * timeline is read ONCE and its `[hubspot:<type>:<id>]` provenance markers collected; anything
 * already present is skipped. That is exact and survives a resume mid-page — the case a checkpoint
 * alone cannot cover.
 *
 * VISIBILITY ONLY. This writes timeline entries and nothing else: no HubSpot writes of any kind, no
 * Last qualifying follow-up date, no Last Activity Date, no Owner assigned date, no reminder logic,
 * and nothing on the retired Activities board 5028000492.
 *
 *   node scripts/backfill-activities.mjs                 # PLAN: reads, writes nothing
 *   node scripts/backfill-activities.mjs --apply         # the real run
 *   node scripts/backfill-activities.mjs --apply --limit 50
 *   node scripts/backfill-activities.mjs --reset         # forget the checkpoint
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const STATE = path.join(ROOT, "scripts", ".backfill-activities-state.json");

const APPLY = process.argv.includes("--apply");
const RESET = process.argv.includes("--reset");
const LIMIT = Number((process.argv.find(a => a.startsWith("--limit")) ?? "").split(/[= ]/)[1]
  ?? process.argv[process.argv.indexOf("--limit") + 1] ?? 0) || 0;

const vars = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".dev.vars"), "utf8")
    .split(/\r?\n/).filter(l => l.includes("=")).map(l => {
      const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }));
const MT = vars.MONDAY_API_TOKEN;
const HT = vars.HUBSPOT_CRM_APP_TOKEN || vars.HUBSPOT_ACCESS_TOKEN;

/** Everything at or after this belongs to the LIVE sync. Must match the deployed ACTIVITY_CUTOVER_AT. */
const CUTOVER = Date.parse("2026-09-16T11:16:48Z");

const ACTIVITY_TYPE = {
  emails: "eaca46da-4695-4386-8dd4-a3fa088d31ce",
  notes: "ca35c3ab-476a-4718-9b38-67ee945593d4",
  calls: "1e0d9eca-222b-4f8b-85c8-4f7947e83595",
  meetings: "7314447b-685c-4c58-9e38-80ad162d8fc4",
  tasks: "5f0e2267-8cea-45fa-bb54-2b1a29324a34",
};
const BOARD = {
  contact: { id: "5028000495", idCol: "text_mm6t71dj", assoc: "contacts" },
  company: { id: "5028000496", idCol: "text_mm6tsnwx", assoc: "companies" },
  deal:    { id: "5028000494", idCol: "text_mm76kxz4", assoc: "deals" },
};
const PROPS = {
  emails: ["hs_timestamp", "hs_email_subject", "hs_email_direction", "hs_email_from_email",
    "hs_email_to_email", "hubspot_owner_id", "hs_sequence_id", "hs_email_text"],
  calls: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_direction", "hubspot_owner_id"],
  notes: ["hs_timestamp", "hs_note_body", "hubspot_owner_id"],
  meetings: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hubspot_owner_id"],
  tasks: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status", "hs_task_priority",
    "hs_task_type", "hs_task_completion_date", "hubspot_owner_id"],
};
const TYPES = ["emails", "calls", "notes", "meetings", "tasks"];

// ---------------------------------------------------------------- transport, with adaptive throttle
let mondayDelay = 120;                       // ms between monday writes; raised on pushback
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const strip = (h) => String(h ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

async function hs(method, pathname, body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    let r;
    try {
      r = await fetch(`https://api.hubapi.com${pathname}`, {
        method, headers: { authorization: `Bearer ${HT}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        // A STALLED SOCKET IS NOT AN ERROR NODE WILL EVER REPORT. fetch has no default timeout, so a
        // connection that goes quiet blocks this run forever — which is exactly what it did: the job
        // sat at zero CPU and zero progress until it was killed. Every request now has a deadline.
        signal: AbortSignal.timeout(45000) });
    } catch (e) { await sleep(2000 * (i + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(`HubSpot ${r.status} ${t.slice(0, 160)}`);
    return t ? JSON.parse(t) : {};
  }
  throw new Error(`HubSpot gave up after ${tries} tries: ${pathname}`);
}

async function gql(query, variables, tries = 5) {
  for (let i = 0; i < tries; i++) {
    let r, text;
    try {
      r = await fetch("https://api.monday.com/v2", {
        method: "POST", headers: { "content-type": "application/json", authorization: MT, "API-Version": "2026-07" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(45000) });
      text = await r.text();
    } catch (e) { await sleep(2000 * (i + 1)); continue; }
    // monday answers complexity pressure with 429 or an errors[] mentioning complexity; both mean slow down.
    if (r.status === 429 || /complexity|rate limit|Too many/i.test(text)) {
      mondayDelay = Math.min(mondayDelay * 2, 4000);
      console.log(`  [throttle] backing off to ${mondayDelay}ms`);
      await sleep(mondayDelay * 4);
      continue;
    }
    const j = JSON.parse(text);
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 220));
    // Ease back down when things are healthy again.
    if (mondayDelay > 120) mondayDelay = Math.max(120, Math.round(mondayDelay * 0.9));
    return j.data;
  }
  throw new Error("monday gave up after repeated throttling");
}

// ---------------------------------------------------------------- checkpoint
const blank = () => ({
  startedAt: new Date().toISOString(),
  cursors: {}, done: {}, processed: {},
  counters: { scanned: {}, written: { contact: 0, company: 0, deal: 0 }, skippedPresent: 0,
    postCutover: 0, noAssoc: 0, staffOnly: 0, missingCard: 0, failures: 0, activitiesWritten: 0 },
  index: null,
});
let state = RESET || !fs.existsSync(STATE) ? blank() : JSON.parse(fs.readFileSync(STATE, "utf8"));
if (RESET && fs.existsSync(STATE)) fs.unlinkSync(STATE);
/**
 * WHAT HAS ALREADY BEEN DONE, kept by activity id rather than inferred.
 *
 * The first version leaned on the page cursor plus a per-card marker read. The cursor is not enough
 * on its own — a --limit run stops WITHOUT advancing it, so a second invocation replays the same page
 * — and that is exactly how this script wrote a record four times during its own canary. Reading each
 * card's markers first is exact but costs a timeline read per card, tens of thousands of them.
 *
 * An explicit set of finished activity ids is both: exact, and free to consult. It is written only
 * after a page's writes have actually landed, so an interrupted page is replayed rather than assumed
 * complete, and the marker check below covers that one replayed page.
 */
state.processed ??= {};
const processed = {};
for (const t of ["emails", "calls", "notes", "meetings", "tasks"])
  processed[t] = new Set(state.processed[t] ?? []);
const save = () => {
  for (const t of Object.keys(processed)) state.processed[t] = [...processed[t]];
  fs.writeFileSync(STATE, JSON.stringify(state));
};

// ---------------------------------------------------------------- monday card index, built once
async function buildIndex() {
  if (state.index) { console.log("index: reusing the checkpointed card index"); return state.index; }
  const index = {};
  for (const [kind, b] of Object.entries(BOARD)) {
    const map = {};
    let cursor = null, pages = 0;
    for (;;) {
      const q = cursor
        ? `query ($c:String!) { next_items_page(limit:500, cursor:$c) { cursor items { id column_values(ids:["${b.idCol}"]) { text } } } }`
        : `query ($b:[ID!]) { boards(ids:$b) { items_page(limit:500) { cursor items { id column_values(ids:["${b.idCol}"]) { text } } } } }`;
      const d = await gql(q, cursor ? { c: cursor } : { b: [b.id] });
      const page = cursor ? d.next_items_page : d.boards[0].items_page;
      for (const it of page.items ?? []) {
        const hid = String(it.column_values?.[0]?.text ?? "").trim();
        if (hid) map[hid] = it.id;
      }
      cursor = page.cursor; pages++;
      if (!cursor) break;
      if (pages % 20 === 0) console.log(`  ${kind}: ${Object.keys(map).length} cards indexed…`);
    }
    index[kind] = map;
    console.log(`index: ${kind} -> ${Object.keys(map).length} cards`);
  }
  state.index = index; save();
  return index;
}

// ---------------------------------------------------------------- per-card marker sets
const markers = new Map();                   // monday card id -> Set("emails:400123")
/**
 * READING A CARD'S EXISTING MARKERS IS ONLY NEEDED WHERE THE CHECKPOINT CANNOT HELP.
 *
 * The cursor advances only after a whole HubSpot page completes, so a clean run never revisits an
 * activity and needs no such check. A RESUME does: the page that was in flight when the run stopped
 * is replayed from its start, and those destinations may already have entries. So the check is armed
 * for exactly that first replayed page and then switched off — it costs one timeline read per card,
 * tens of thousands of them, for a guarantee the checkpoint already provides the rest of the time.
 */
let verifyMarkers = false;

async function markersFor(card) {
  if (!verifyMarkers) return markers.get(card) ?? markers.set(card, new Set()).get(card);
  if (markers.has(card)) return markers.get(card);
  const seen = new Set();
  let cursor = null;
  for (let p = 0; p < 60; p++) {
    const d = await gql(`query ($i: ID!, $c: String) { timeline(id: $i) { timeline_items_page(limit: 100, cursor: $c) {
        cursor timeline_items { content } } } }`, { i: card, c: cursor });
    const pg = d.timeline?.timeline_items_page;
    if (!pg) break;
    for (const e of pg.timeline_items ?? []) {
      const m = /\[hubspot:([a-z_]+):(\d+)\]/.exec(String(e.content ?? ""));
      if (m) seen.add(`${m[1]}:${m[2]}`);
    }
    cursor = pg.cursor;
    if (!cursor) break;
  }
  markers.set(card, seen);
  return seen;
}

// ---------------------------------------------------------------- staff (HubSpot owners)
let staff = null;
async function staffEmails() {
  if (staff) return staff;
  staff = new Set();
  let after = "";
  for (let p = 0; p < 20; p++) {
    const r = await hs("GET", `/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`);
    for (const o of r.results ?? []) if (o.email) staff.add(String(o.email).toLowerCase());
    after = r.paging?.next?.after ?? "";
    if (!after) break;
  }
  console.log(`staff: ${staff.size} HubSpot owner emails`);
  return staff;
}
const contactEmail = new Map();
async function emailsOf(ids) {
  const need = ids.filter(i => !contactEmail.has(i));
  for (let i = 0; i < need.length; i += 100) {
    const r = await hs("POST", "/crm/v3/objects/contacts/batch/read",
      { properties: ["email"], inputs: need.slice(i, i + 100).map(id => ({ id })) });
    for (const c of r.results ?? []) contactEmail.set(String(c.id), String(c.properties?.email ?? "").toLowerCase());
    for (const id of need.slice(i, i + 100)) if (!contactEmail.has(id)) contactEmail.set(id, "");
  }
  return ids.map(i => contactEmail.get(i) ?? "");
}

// ---------------------------------------------------------------- destinations, a page at a time
/**
 * ASSOCIATIONS ARE READ IN BATCHES OF A HUNDRED, not one activity at a time.
 *
 * Three association calls per activity is three quarters of a million requests across this dataset —
 * measured at roughly three seconds per activity, which is a day of wall clock spent almost entirely
 * on round trips. The batch endpoint answers the same question for a whole page in three calls, and
 * the work that remains is the writing, which is the part that genuinely has to happen.
 *
 * The batch endpoint does not paginate per input. An activity associated with more than a hundred of
 * one kind would come back truncated, so those are re-read individually rather than silently
 * accepted short — the same refusal to act on a partial set the live path makes.
 */
async function destinationsForPage(type, ids) {
  const byId = new Map(ids.map(i => [i, []]));
  for (const [kind, b] of Object.entries(BOARD)) {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const r = await hs("POST", `/crm/v4/associations/${type}/${b.assoc}/batch/read`,
        { inputs: chunk.map(id => ({ id })) });
      for (const row of r.results ?? []) {
        const from = String(row.from?.id ?? "");
        const list = byId.get(from);
        if (!list) continue;
        const to = row.to ?? [];
        if (to.length >= 100) {                      // possibly truncated: ask precisely
          const exact = await allAssociations(type, from, b.assoc);
          for (const hid of exact) list.push({ kind, hubspotId: hid });
        } else {
          for (const t of to) if (t?.toObjectId != null) list.push({ kind, hubspotId: String(t.toObjectId) });
        }
      }
    }
  }
  return byId;
}

async function allAssociations(type, id, assoc) {
  const seen = new Set();
  let after = "";
  for (let p = 0; p < 10; p++) {
    const r = await hs("GET", `/crm/v4/objects/${type}/${id}/associations/${assoc}?limit=100${after ? `&after=${after}` : ""}`);
    for (const a of r.results ?? []) if (a?.toObjectId != null) seen.add(String(a.toObjectId));
    after = r.paging?.next?.after ?? "";
    if (!after) break;
  }
  return [...seen];
}

// ---------------------------------------------------------------- payload
function payloadFor(type, id, p) {
  const ts = type === "tasks"
    ? (String(p.hs_task_completion_date ?? "").trim() || String(p.hs_timestamp ?? "").trim())
    : String(p.hs_timestamp ?? "").trim();
  const body = strip(p.hs_note_body ?? p.hs_call_body ?? p.hs_meeting_body ?? p.hs_task_body ?? p.hs_email_text);
  const lines = [
    p.hs_email_from_email ? `From: ${p.hs_email_from_email}` : "",
    p.hs_email_to_email ? `To: ${p.hs_email_to_email}` : "",
    p.hs_email_direction ?? p.hs_call_direction ? `Direction: ${p.hs_email_direction ?? p.hs_call_direction}` : "",
    p.hubspot_owner_id ? `HubSpot owner: ${p.hubspot_owner_id}` : "",
    p.hs_sequence_id ? `Sequence ${p.hs_sequence_id} — informational, does not count as follow-up` : "",
    p.hs_task_status ? `Status: ${p.hs_task_status}` : "",
    p.hs_task_type ? `Task type: ${p.hs_task_type}` : "",
    p.hs_task_priority && p.hs_task_priority !== "NONE" ? `Priority: ${p.hs_task_priority}` : "",
    type === "tasks" && p.hs_timestamp ? `Due: ${p.hs_timestamp}` : "",
    p.hs_task_completion_date ? `Completed: ${p.hs_task_completion_date}` : "",
    body ? `\n${body}` : "",
    `\n[hubspot:${type}:${id}]`,
  ].filter(Boolean);
  const title = p.hs_email_subject ?? p.hs_call_title ?? p.hs_meeting_title ?? p.hs_task_subject
    ?? (body ? body.slice(0, 80) : "(no subject)");
  return { ts, title: String(title).slice(0, 250), content: lines.join("\n") };
}

// ---------------------------------------------------------------- writing, several at a time
/**
 * WRITES RUN IN A SMALL POOL, because one at a time is not a safety property here — it is just slow.
 *
 * Measured serially at 2.1 seconds per timeline entry, almost all of it waiting on monday rather than
 * doing anything. Across this dataset that is roughly forty-six hours, which is not an overnight job;
 * it is a job that would still be running when the sales team arrives, competing with them for the
 * same API budget.
 *
 * Sixteen at a time, raised from six after measuring: monday reported no throttling at all across a
 * thousand writes, so the limit was latency rather than any budget we were near. The adaptive throttle in gql() still governs the pace — when
 * monday pushes back every worker feels it, the delay doubles, and the pool drains slower. The pool
 * changes how many requests are in flight, never how hard we push when told to stop.
 */
/**
 * WRITES GO OUT IN ALIASED BATCHES, because monday serialises them and concurrency is therefore
 * worthless here.
 *
 * Measured directly rather than assumed, and the first measurement was misleading: eight writes to
 * ONE card averaged 1,779ms each, which looked like per-item locking. Eight to eight DIFFERENT cards
 * averaged 1,834ms — no better. Sixteen across sixteen cards: 1,790ms. monday serialises timeline
 * writes account-wide, so adding workers only adds waiting.
 *
 * What does help is putting several mutations in ONE request: eight aliased create_timeline_item
 * calls came back in 10,583ms — 1,323ms each, a shade under three quarters of the single-write cost.
 * The server still does them one after another; what disappears is eight round trips.
 *
 * Variables are numbered per alias rather than interpolated into the query string. Timeline content
 * is arbitrary customer text full of quotes, newlines and backslashes; building that into GraphQL by
 * hand is how you corrupt a body or, worse, break out of it.
 */
const BATCH = 8;

async function runWrites(jobs, onDone) {
  for (let i = 0; i < jobs.length; i += BATCH) {
    const group = jobs.slice(i, i + BATCH);
    const decl = group.map((_, k) =>
      `$i${k}: ID!, $a${k}: String!, $t${k}: String!, $c${k}: String!, $ts${k}: ISO8601DateTime!`).join(", ");
    const body = group.map((_, k) =>
      `m${k}: create_timeline_item(item_id:$i${k}, custom_activity_id:$a${k}, title:$t${k}, summary:"", content:$c${k}, timestamp:$ts${k}) { id }`).join("\n  ");
    const variables = {};
    group.forEach((j, k) => {
      variables[`i${k}`] = j.card; variables[`a${k}`] = ACTIVITY_TYPE[j.type];
      variables[`t${k}`] = j.title; variables[`c${k}`] = j.content; variables[`ts${k}`] = j.ts;
    });

    let data = null, err = null;
    try {
      data = await gql(`mutation (${decl}) {\n  ${body}\n}`, variables);
    } catch (e) { err = e; }

    /**
     * A BATCH IS NOT ALL-OR-NOTHING. monday answers a partially failed batch with the aliases that
     * worked plus an errors list, so each alias is judged on its own result. Treating the batch as a
     * unit would either lose good writes or re-send them on the next run.
     */
    group.forEach((j, k) => {
      const ok = !err && data?.[`m${k}`]?.id;
      onDone(j, ok ? null : (err ?? new Error(`no id returned for m${k}`)));
    });
    if (mondayDelay > 120) await sleep(mondayDelay);
  }
}

// ---------------------------------------------------------------- the run
async function run() {
  console.log(`${APPLY ? "APPLY" : "PLAN (no writes)"}  cutover=${new Date(CUTOVER).toISOString()}`
    + `${LIMIT ? `  limit=${LIMIT}` : ""}`);
  const index = await buildIndex();
  await staffEmails();
  const c = state.counters;
  let seenThisRun = 0;

  for (const type of TYPES) {
    if (state.done[type]) { console.log(`${type}: already complete, skipping`); continue; }
    c.scanned[type] ??= 0;
    let after = state.cursors[type] ?? "";
    /**
     * The first page of each type is checked against what is actually on the cards, every run. The
     * processed set covers everything else, but it is saved only after a page completes — so a run
     * killed mid-page leaves writes on the board that the set does not know about, and this is the
     * one page where that can be true.
     */
    verifyMarkers = true;
    console.log(`\n=== ${type}${after ? ` (resuming at ${after} — verifying existing entries on the first page)` : ""}`);

    for (;;) {
      const page = await hs("GET",
        `/crm/v3/objects/${type}?limit=100&properties=${encodeURIComponent(PROPS[type].join(","))}`
        + `${after ? `&after=${after}` : ""}`);
      const recs = page.results ?? [];
      // Only activities this script owns are worth asking about: everything from the cutover onward
      // belongs to the live sync, and asking about it would be a round trip spent to throw the answer away.
      const mine = recs.filter(r => {
        const ts = type === "tasks"
          ? (String(r.properties?.hs_task_completion_date ?? "").trim() || String(r.properties?.hs_timestamp ?? "").trim())
          : String(r.properties?.hs_timestamp ?? "").trim();
        const w = Date.parse(ts);
        return Number.isFinite(w) && w < CUTOVER;
      });
      const assocByActivity = mine.length ? await destinationsForPage(type, mine.map(r => r.id)) : new Map();
      /**
       * EVERY CONTACT ON THE PAGE, RESOLVED ONCE.
       *
       * The staff check needs each contact's email address, and asking per activity cost a HubSpot
       * batch read per activity — measured at 460ms, a hundred times a page, three quarters of an
       * hour across this dataset spent re-asking questions a single call could answer.
       */
      const pageContacts = [...new Set([...assocByActivity.values()].flat()
        .filter(d => d.kind === "contact").map(d => d.hubspotId))];
      if (pageContacts.length) await emailsOf(pageContacts);

      const pending = [];
      const queued = new Map();                     // activity id -> how many writes it is waiting on
      const failedActivity = new Set();
      for (const rec of recs) {
        if (LIMIT && seenThisRun >= LIMIT) {
          if (pending.length) await runWrites(pending, (j, err) => {
            if (err) { c.failures++; failedActivity.add(j.id); console.log(`  [fail] ${j.type}/${j.id} -> ${j.kind}: ${String(err).slice(0, 110)}`); }
            else c.written[j.kind]++;
          });
          for (const id of queued.keys()) if (!failedActivity.has(id)) processed[type].add(id);
          console.log(`\nlimit ${LIMIT} reached`); save(); return;
        }
        c.scanned[type]++; seenThisRun++;
        if (processed[type].has(rec.id)) { c.skippedPresent++; continue; }
        try {
          const p = rec.properties ?? {};
          const { ts, title, content } = payloadFor(type, rec.id, p);
          const when = Date.parse(ts);
          if (!Number.isFinite(when)) { c.noAssoc++; continue; }
          // The live sync owns everything from the cutover onward. Disjoint by construction.
          if (when >= CUTOVER) { c.postCutover++; continue; }

          let dests = assocByActivity.get(rec.id) ?? [];
          if (!dests.length) { c.noAssoc++; continue; }

          const contactIds = dests.filter(d => d.kind === "contact").map(d => d.hubspotId);
          if (contactIds.length) {
            // Emails were resolved for the whole page above; this is a cache hit, not a round trip.
            const mails = await emailsOf(contactIds);
            const isStaff = new Set(contactIds.filter((_, i) => mails[i] && staff.has(mails[i])));
            const before = dests.length;
            dests = dests.filter(d => d.kind !== "contact" || !isStaff.has(d.hubspotId));
            if (before !== dests.length) c.staffOnly += before - dests.length;
          }
          if (!dests.length) continue;

          let wroteAny = false;
          for (const d of dests) {
            const card = index[d.kind]?.[d.hubspotId];
            if (!card) { c.missingCard++; continue; }
            const seen = await markersFor(card);
            if (seen.has(`${type}:${rec.id}`)) { c.skippedPresent++; continue; }
            if (!APPLY) { c.written[d.kind]++; wroteAny = true; continue; }
            // Queued, not written here: the page's writes go out together through the pool below.
            seen.add(`${type}:${rec.id}`);
            pending.push({ card, type, id: rec.id, kind: d.kind, title, content, ts });
            queued.set(rec.id, (queued.get(rec.id) ?? 0) + 1);
            wroteAny = true;
          }
          if (wroteAny) c.activitiesWritten++;
          // Nothing to write for this one — it is finished now.
          if (!queued.has(rec.id)) processed[type].add(rec.id);
        } catch (e) {
          // One bad activity must never cost the rest of its page.
          c.failures++;
          console.log(`  [fail] ${type}/${rec.id}: ${String(e).slice(0, 130)}`);
        }
      }

      // Drain this page's writes BEFORE advancing the cursor, so the checkpoint can only ever move
      // past work that is actually on the board.
      if (pending.length) await runWrites(pending, (j, err) => {
        if (err) { c.failures++; failedActivity.add(j.id); console.log(`  [fail] ${j.type}/${j.id} -> ${j.kind}: ${String(err).slice(0, 110)}`); }
        else c.written[j.kind]++;
      });
      // An activity counts as done only if EVERY destination it was waiting on landed. A partial one
      // is left unmarked so the next run finishes it, and the marker check stops it duplicating.
      for (const id of queued.keys()) if (!failedActivity.has(id)) processed[type].add(id);

      verifyMarkers = false;                        // the replayed page is behind us
      after = page.paging?.next?.after ?? "";
      state.cursors[type] = after;
      save();                                       // checkpoint after EVERY HubSpot page
      const w = c.written;
      console.log(`  ${type}: scanned=${c.scanned[type]} written c/k/d=${w.contact}/${w.company}/${w.deal}`
        + ` present=${c.skippedPresent} post=${c.postCutover} noassoc=${c.noAssoc} nocard=${c.missingCard} fail=${c.failures}`);
      if (!after) break;
    }
    state.done[type] = true; save();
  }
  console.log("\nALL TYPES COMPLETE");
}

const t0 = Date.now();
run().then(() => {
  const c = state.counters;
  console.log(`\n================ ${APPLY ? "IMPORT" : "PLAN"} SUMMARY`);
  for (const t of TYPES) console.log(`  ${t.padEnd(9)} scanned ${c.scanned[t] ?? 0}`);
  console.log(`  timeline writes  contact=${c.written.contact} company=${c.written.company} deal=${c.written.deal}`);
  console.log(`  already present  ${c.skippedPresent}`);
  console.log(`  post-cutover (live sync owns these) ${c.postCutover}`);
  console.log(`  no CRM association ${c.noAssoc}   staff destinations excluded ${c.staffOnly}`);
  console.log(`  missing monday card ${c.missingCard}   failures ${c.failures}`);
  console.log(`  activities with at least one write ${c.activitiesWritten}`);
  console.log(`  runtime ${Math.round((Date.now() - t0) / 1000)}s`);
  save();
}).catch(e => { console.error("FATAL", e); save(); process.exit(1); });
