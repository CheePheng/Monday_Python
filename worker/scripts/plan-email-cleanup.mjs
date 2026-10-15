/**
 * PHASE A + E — prove the duplicate copies are genuinely identical, and emit a dry-run remediation
 * manifest. READ ONLY: this script has no mutation path at all.
 *
 * Deleting a "duplicate" is only safe if the copies really are the same activity. Two entries that
 * share a [hubspot:emails:<id>] marker could still differ in title, body or timestamp — a second
 * copy written by a later code version, say — and dropping one would then lose something a rep can
 * see. So every copy in every duplicated group is re-read in full and fingerprinted on what the user
 * actually sees, with the timeline id deliberately EXCLUDED because it is expected to differ.
 */
import fs from "node:fs";
import crypto from "node:crypto";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const v = Object.fromEntries(fs.readFileSync(HERE + "../.dev.vars", "utf8").split(/\r?\n/)
  .filter(l => l.includes("=")).map(l => { const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const gql = async (query, variables) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 4) return null;
    } catch { if (a === 4) return null; }
    await new Promise(s => setTimeout(s, 2500 * (a + 1)));
  }
  return null;
};

const inv = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/email-inventory.json", "utf8"));
const CUT = Date.parse(inv.cutover);
const OUR_EMAIL_TYPE = "eaca46da-4695-4386-8dd4-a3fa088d31ce";
const HEADER = /^(From|To|Direction|HubSpot owner|Sequence \d+)/;
const MAX_PAGES = 200;

const post = inv.groups.filter(g => Date.parse(g.rows[0].ts) >= CUT);
const dupGroups = post.filter(g => g.rows.length > 1);
const cardsNeeded = [...new Set(dupGroups.map(g => `${g.kind}|${g.card}`))];
console.log(`post-cutover pairs ${post.length}, duplicated ${dupGroups.length}, cards to re-read ${cardsNeeded.length}`);

/** Full walk of one card, deduped by id, with the same guards the inventory used. */
async function walk(card) {
  const byId = new Map();
  const seen = new Set();
  let cursor = null, pages = 0;
  for (;;) {
    const q = cursor
      ? `query ($i:ID!, $c:String!) { timeline(id:$i) { timeline_items_page(limit:100, cursor:$c) { cursor timeline_items { id type title content created_at custom_activity_id } } } }`
      : `query ($i:ID!) { timeline(id:$i) { timeline_items_page(limit:100) { cursor timeline_items { id type title content created_at custom_activity_id } } } }`;
    const r = await gql(q, cursor ? { i: card, c: cursor } : { i: card });
    if (!r) return { incomplete: "api-fail", byId };
    const page = r.timeline?.timeline_items_page;
    if (!page) return { incomplete: "no-page", byId };
    for (const t of page.timeline_items ?? []) byId.set(t.id, t);
    pages++;
    cursor = page.cursor ?? null;
    if (!cursor) return { incomplete: null, byId };
    if (seen.has(cursor)) return { incomplete: "repeated-cursor", byId };
    seen.add(cursor);
    if (pages >= MAX_PAGES) return { incomplete: "page-budget", byId };
  }
}

/** What the user sees. The timeline id is NOT part of it — it is expected to differ. */
const fingerprint = (t) => crypto.createHash("sha256").update(JSON.stringify({
  type: t.type ?? "", custom: t.custom_activity_id ?? "",
  title: String(t.title ?? ""), content: String(t.content ?? ""), ts: String(t.created_at ?? ""),
})).digest("hex").slice(0, 16);
const bodyOf = (c) => String(c).split("\n")
  .filter(l => l.trim() && !HEADER.test(l.trim()) && !/^\[hubspot:/.test(l.trim())).join(" ").trim();

// ---------------------------------------------------------------- re-read and fingerprint
const cardEntries = new Map();
let done = 0;
const t0 = Date.now();
for (const key of cardsNeeded) {
  const card = key.split("|")[1];
  const res = await walk(card);
  cardEntries.set(card, res);
  done++;
  if (done % 100 === 0) {
    const rate = done / ((Date.now() - t0) / 1000);
    console.log(`   re-read ${done}/${cardsNeeded.length}  ${rate.toFixed(1)}/s  eta ${Math.round((cardsNeeded.length - done) / rate / 60)} min`);
  }
}

const buckets = { identical: [], differing: [], unreadable: [] };
for (const g of dupGroups) {
  const res = cardEntries.get(g.card);
  if (!res || res.incomplete) { buckets.unreadable.push({ ...g, why: res?.incomplete ?? "not-read" }); continue; }
  const rows = g.rows.map(r => res.byId.get(r.id)).filter(Boolean);
  if (rows.length !== g.rows.length) { buckets.unreadable.push({ ...g, why: "entry vanished since the inventory" }); continue; }
  const fps = rows.map(fingerprint);
  const allSame = fps.every(f => f === fps[0]);
  const rec = { kind: g.kind, card: g.card, email: g.email, copies: rows.length,
    timelineIds: rows.map(r => r.id), fingerprints: fps,
    bodies: rows.map(r => bodyOf(r.content).length),
    ts: rows[0].created_at, title: String(rows[0].title ?? "").slice(0, 80),
    ourType: rows.every(r => r.custom_activity_id === OUR_EMAIL_TYPE) };
  (allSame ? buckets.identical : buckets.differing).push(rec);
}

console.log("\n================ PHASE A — duplicate fingerprint audit");
console.log(`  exact-identical copies    ${buckets.identical.length}`);
console.log(`  NON-identical copies      ${buckets.differing.length}   <- never auto-delete`);
console.log(`  unreadable / incomplete   ${buckets.unreadable.length}   <- never auto-delete`);
const notOurs = buckets.identical.filter(r => !r.ourType);
console.log(`  identical but NOT our custom HubSpot Email type: ${notOurs.length}`);
console.log("\n  the 3+ copy cases, listed in full:");
for (const r of [...buckets.identical, ...buckets.differing].filter(r => r.copies > 2))
  console.log(`     ${r.kind} card ${r.card} email ${r.email} copies ${r.copies}`
    + ` bodies ${JSON.stringify(r.bodies)} fp ${JSON.stringify(r.fingerprints)} ts ${r.ts}`);
for (const r of buckets.differing.slice(0, 10))
  console.log(`     DIFFERING ${r.kind} ${r.card} ${r.email} bodies ${JSON.stringify(r.bodies)} fp ${JSON.stringify(r.fingerprints)}`);

// ---------------------------------------------------------------- Phase B/E — the manifest
const manifest = [];
let noop = 0, dedupeOnly = 0, repairOnly = 0, dedupeAndRepair = 0, skipped = 0;
for (const g of post) {
  const dupRec = [...buckets.identical, ...buckets.differing, ...buckets.unreadable]
    .find(r => r.card === g.card && r.email === g.email && r.kind === g.kind);
  const anyBody = g.rows.some(r => r.body > 0);
  const duplicated = g.rows.length > 1;

  let action, remove = [], why = "";
  if (duplicated && buckets.differing.some(r => r === dupRec)) { action = "SKIP"; why = "copies are not identical"; skipped++; }
  else if (duplicated && buckets.unreadable.some(r => r === dupRec)) { action = "SKIP"; why = dupRec.why; skipped++; }
  else if (!duplicated && anyBody) { action = "NOOP"; why = "single copy, body present"; noop++; }
  else if (duplicated && anyBody) {
    // keep a copy that has a body, drop the rest — no recreate needed
    const keep = g.rows.find(r => r.body > 0);
    action = "DEDUPE_ONLY"; remove = g.rows.filter(r => r.id !== keep.id).map(r => r.id);
    why = "duplicated, at least one copy already has a body"; dedupeOnly++;
  } else if (!duplicated) { action = "REPAIR_BODY"; remove = [g.rows[0].id]; why = "single copy, no body"; repairOnly++; }
  else { action = "DEDUPE_AND_REPAIR"; remove = g.rows.map(r => r.id); why = "duplicated, every copy bodyless"; dedupeAndRepair++; }

  manifest.push({ kind: g.kind, card: g.card, email: g.email, copies: g.rows.length,
    timelineIds: g.rows.map(r => r.id), bodies: g.rows.map(r => r.body),
    ts: g.rows[0].ts, action, removeAfterVerify: remove, why,
    fingerprints: dupRec?.fingerprints ?? null, bodyFetchAvailable: false });
}

console.log("\n================ PHASE E — dry-run manifest");
console.log(`  NOOP (body present, single)        ${noop}`);
console.log(`  DEDUPE_ONLY (keep the good copy)   ${dedupeOnly}`);
console.log(`  REPAIR_BODY (single, bodyless)     ${repairOnly}`);
console.log(`  DEDUPE_AND_REPAIR (all bodyless)   ${dedupeAndRepair}`);
console.log(`  SKIP (unsafe / unproven)           ${skipped}`);
console.log(`  total records                      ${manifest.length}`);

// ---------------------------------------------------------------- assertions
const fails = [];
if (manifest.filter(m => m.action === "NOOP").length !== 108) fails.push(`NOOP is ${noop}, expected 108`);
if (manifest.some(m => Date.parse(m.ts) < CUT)) fails.push("a PRE-cutover entry is in the manifest");
if (manifest.some(m => m.kind === "deal")) fails.push("a Deals record is in the manifest");
if (buckets.differing.some(r => manifest.find(m => m.card === r.card && m.email === r.email && m.action !== "SKIP")))
  fails.push("a non-identical duplicate was not skipped");
console.log("\n================ ASSERTIONS");
console.log(fails.length ? fails.map(f => "  FAIL " + f).join("\n") : "  all assertions pass — and nothing was mutated");

fs.writeFileSync(HERE + "../../docs/rollout/email-cleanup-manifest.json",
  JSON.stringify({ takenAt: new Date().toISOString(), cutover: inv.cutover,
    phaseA: { identical: buckets.identical.length, differing: buckets.differing, unreadable: buckets.unreadable },
    totals: { noop, dedupeOnly, repairOnly, dedupeAndRepair, skipped }, manifest }, null, 1));
console.log("\nwrote docs/rollout/email-cleanup-manifest.json (DRY RUN — no mutation path exists in this script)");
