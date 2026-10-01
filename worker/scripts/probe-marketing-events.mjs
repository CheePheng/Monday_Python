/**
 * PROBE: what does HubSpot's legacy Email Events API ACTUALLY return for this portal?
 *
 * marketing-emails.ts and marketing-email-poller.ts were written against HubSpot's documentation, because
 * every marketing endpoint answered 403 MISSING_SCOPES until the `content` scope (build #14) is approved.
 * Run this the day it is, BEFORE switching the poller on. It answers the open questions in one pass:
 *
 *   1. Does GET /email/public/v1/events answer 200 at all? (403 = the scope is still not approved.)
 *   2. The real event JSON: the id's ALPHABET (the marker regex is [A-Za-z0-9_-]+; the poller hex-encodes
 *      anything else), `created` as ms, `sentBy` {id, created}, `filteredEvent`, BOUNCE category/response,
 *      CLICK url, and the STATUSCHANGE shape (source, portalSubscriptionStatus, subscriptions, bounced).
 *   3. The SORT ORDER within a window and across offset pages (the poller sorts anyway; this says whether
 *      it has to).
 *   4. Bot filtering: opens/clicks with excludeFilteredEvents=true vs false, to compare against the
 *      analytics "excluding bots" figures (the critic's 2.5x warning).
 *   5. The campaign lookup: which fields /email/public/v1/campaigns/{id} returns -- type, name, subject,
 *      contentId -- and every campaign `type` seen, to settle the allowlist.
 *   6. The earliest month HubSpot still holds events for (bounds the backfill).
 *   7. That contacts/batch/read with idProperty=email resolves a real recipient.
 *
 * READ-ONLY: GET requests, plus the one contacts batch READ (a POST that reads). Nothing is written to
 * HubSpot or monday. The token is never printed. Recipient addresses are masked on screen; the raw JSON
 * (which does contain them) is saved to your temp directory, not the repo.
 *
 *   node scripts/probe-marketing-events.mjs [--days 3] [--pages 3]
 *
 * Needs HUBSPOT_CRM_APP_TOKEN in worker/.dev.vars -- the CRM app's token, the one the Worker holds.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
const TOKEN = env.HUBSPOT_CRM_APP_TOKEN;
if (!TOKEN) { console.error("HUBSPOT_CRM_APP_TOKEN is missing from worker/.dev.vars"); process.exit(1); }

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DAYS = Number(arg("--days", 3)) || 3;
const PAGES = Number(arg("--pages", 3)) || 3;
const BASE = "https://api.hubapi.com";

async function get(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}
async function readContacts(emails) {
  const r = await fetch(BASE + "/crm/v3/objects/contacts/batch/read", {
    method: "POST",   // a batch READ: HubSpot has no GET form of it
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ idProperty: "email", properties: ["email"], inputs: emails.map(id => ({ id })) }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const mask = e => String(e ?? "").replace(/^(.).*?(@.*)$/, "$1***$2");
const classes = s => [/[a-z]/.test(s) && "a-z", /[A-Z]/.test(s) && "A-Z", /\d/.test(s) && "0-9",
  ...[...new Set(String(s).replace(/[A-Za-z0-9]/g, ""))].map(c => JSON.stringify(c))].filter(Boolean).join(" ");
const tally = (xs) => xs.reduce((m, x) => (m[x] = (m[x] ?? 0) + 1, m), {});

async function events(start, end, excludeFiltered, pages) {
  const all = []; const pageOrder = [];
  let offset;
  for (let p = 0; p < pages; p++) {
    const q = new URLSearchParams({ startTimestamp: String(start), endTimestamp: String(end), limit: "1000",
      excludeFilteredEvents: String(excludeFiltered) });
    if (offset) q.set("offset", offset);
    const r = await get(`/email/public/v1/events?${q}`);
    if (r.status !== 200) return { status: r.status, body: r.body, all, pageOrder };
    const evs = r.body?.events ?? [];
    pageOrder.push(evs.length ? [evs[0].created, evs[evs.length - 1].created] : null);
    all.push(...evs);
    if (!r.body?.hasMore || !r.body?.offset) return { status: 200, all, pageOrder, hasMore: false };
    offset = String(r.body.offset);
  }
  return { status: 200, all, pageOrder, hasMore: true };
}

async function main() {
  const now = Date.now(), start = now - DAYS * 86_400_000;

  console.log(`=== 1. Email Events API, last ${DAYS} day(s) ===`);
  const live = await events(start, now, true, PAGES);
  if (live.status !== 200) {
    console.log(`  ${live.status}: ${JSON.stringify(live.body).slice(0, 300)}`);
    if (live.status === 403) console.log("  -> the marketing scope is still not approved on the CRM app. Nothing more to learn yet.");
    process.exit(3);
  }
  const evs = live.all;
  console.log(`  ${evs.length} events${live.hasMore ? ` (stopped at ${PAGES} pages; more exist)` : ""}`);
  console.log("  by type:", JSON.stringify(tally(evs.map(e => e.type))));

  console.log("\n=== 2. Shapes ===");
  console.log("  id alphabet:", JSON.stringify(tally(evs.map(e => classes(String(e.id))))));
  console.log("  id lengths:", JSON.stringify(tally(evs.map(e => String(e.id).length))));
  console.log("  every id matches [A-Za-z0-9-]:", evs.every(e => /^[A-Za-z0-9-]+$/.test(String(e.id))));
  console.log("  created is a ms number:", evs.every(e => typeof e.created === "number" && e.created > 1e12));
  console.log("  (id, created) unique:", new Set(evs.map(e => `${e.id}|${e.created}`)).size === evs.length,
    " id alone unique:", new Set(evs.map(e => e.id)).size === evs.length);
  console.log("  sentBy present, by type:", JSON.stringify(tally(evs.filter(e => e.sentBy?.id).map(e => e.type))));
  console.log("  filteredEvent present, by type:", JSON.stringify(tally(evs.filter(e => "filteredEvent" in e).map(e => `${e.type}=${e.filteredEvent}`))));
  const keysBy = {};
  for (const e of evs) for (const k of Object.keys(e)) (keysBy[e.type] ??= new Set()).add(k);
  for (const [t, ks] of Object.entries(keysBy)) console.log(`  ${t} keys: ${[...ks].sort().join(", ")}`);
  const one = t => evs.find(e => e.type === t);
  for (const t of ["DELIVERED", "BOUNCE", "OPEN", "CLICK", "STATUSCHANGE", "SPAMREPORT"]) {
    const e = one(t);
    if (e) console.log(`  sample ${t}:`, JSON.stringify({ ...e, recipient: mask(e.recipient) }).slice(0, 600));
  }
  console.log("  BOUNCE categories:", JSON.stringify(tally(evs.filter(e => e.type === "BOUNCE").map(e => e.category))));
  const sc = evs.filter(e => e.type === "STATUSCHANGE");
  console.log("  STATUSCHANGE sources:", JSON.stringify(tally(sc.map(e => e.source))),
    "status:", JSON.stringify(tally(sc.map(e => e.portalSubscriptionStatus))), "bounced:", JSON.stringify(tally(sc.map(e => e.bounced))));

  console.log("\n=== 3. Sort order ===");
  const c = evs.map(e => e.created);
  const asc = c.every((v, i) => i === 0 || c[i - 1] <= v), desc = c.every((v, i) => i === 0 || c[i - 1] >= v);
  console.log(`  ascending=${asc} descending=${desc} pages(first,last created)=${JSON.stringify(live.pageOrder)}`);

  console.log("\n=== 4. Bot filtering ===");
  const raw = await events(start, now, false, PAGES);
  const cnt = (xs, t) => xs.filter(e => e.type === t).length;
  console.log(`  OPEN   excludeFiltered=true ${cnt(evs, "OPEN")}  false ${cnt(raw.all, "OPEN")}`);
  console.log(`  CLICK  excludeFiltered=true ${cnt(evs, "CLICK")}  false ${cnt(raw.all, "CLICK")}`);
  const sends = new Set(evs.filter(e => e.type === "OPEN").map(e => `${e.sentBy?.id}|${e.recipient}`));
  console.log(`  unique (send, recipient) opens, bots excluded: ${sends.size}`);

  console.log("\n=== 5. Campaigns ===");
  const ids = [...new Set(evs.map(e => e.emailCampaignId).filter(v => v != null))];
  const camps = [];
  for (const id of ids.slice(0, 15)) {
    const r = await get(`/email/public/v1/campaigns/${id}`);
    camps.push({ id, status: r.status, body: r.body });
    const b = r.body ?? {};
    console.log(`  ${id}: ${r.status} type=${b.type} appName=${b.appName} contentId=${b.contentId} name=${JSON.stringify(b.name)} subject=${JSON.stringify(b.subject)}`);
  }
  if (camps[0]?.body) console.log("  campaign keys:", Object.keys(camps[0].body).sort().join(", "));
  console.log("  types seen:", JSON.stringify(tally(camps.map(x => x.body?.type))));

  console.log("\n=== 6. Earliest month with events ===");
  let earliest = null;
  for (let y = 2023; y <= new Date().getUTCFullYear() && !earliest; y++)
    for (let m = 0; m < 12 && !earliest; m++) {
      const s = Date.UTC(y, m, 1), e = Date.UTC(y, m + 1, 1);
      if (s > now) break;
      const r = await get(`/email/public/v1/events?startTimestamp=${s}&endTimestamp=${e}&limit=1`);
      if (r.status === 200 && (r.body?.events ?? []).length) earliest = new Date(s).toISOString().slice(0, 7);
    }
  console.log(`  earliest month: ${earliest ?? "none found since 2023-01"}`);

  console.log("\n=== 7. Recipient -> contact by email ===");
  const sample = [...new Set(evs.map(e => String(e.recipient ?? "").toLowerCase()).filter(Boolean))].slice(0, 5);
  const cr = await readContacts(sample);
  console.log(`  ${cr.status}: asked ${sample.length}, resolved ${(cr.body?.results ?? []).length}`
    + `, errors ${JSON.stringify((cr.body?.errors ?? []).map(e => e.category)).slice(0, 200)}`);

  const out = join(tmpdir(), `marketing-events-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify({ window: [start, now], events: evs, unfiltered: raw.all.length, campaigns: camps, earliest }, null, 1));
  console.log(`\nraw JSON (contains recipient addresses -- do not commit): ${out}`);
}

main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
