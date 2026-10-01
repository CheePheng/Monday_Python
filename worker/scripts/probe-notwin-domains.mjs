/**
 * PHASE 3 + 6 — READ ONLY. For each id-less Accounts card with no monday twin, does a HubSpot
 * Company exist for that exact normalised domain, and if so why does it have no canonical card?
 *
 * Nothing is created, changed or deleted. HubSpot is only ever searched.
 *
 * The gate being evaluated is mayCreateCrmCard():
 *   sync_owner "wm" or "other"  -> refused outright
 *   sync_owner "crm"            -> allowed
 *   unstamped                   -> allowed only if createdate >= CRM_CUTOVER_AT
 * CRM_CUTOVER_AT is a deployed secret this script cannot read, so unstamped records are reported by
 * createdate and the gate's verdict for them is stated as conditional rather than guessed.
 */
import fs from "node:fs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const v = Object.fromEntries(fs.readFileSync(HERE + "../.dev.vars", "utf8").split(/\r?\n/)
  .filter(l => l.includes("=")).map(l => { const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const hs = async (path, body) => {
  for (let a = 0; a < 5; a++) {
    const r = await fetch("https://api.hubapi.com" + path, { method: "POST",
      headers: { authorization: "Bearer " + v.HUBSPOT_ACCESS_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (r.ok) return { ok: true, json: await r.json() };
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 2500 * (a + 1))); continue; }
    return { ok: false, status: r.status, text: (await r.text()).slice(0, 160) };
  }
  return { ok: false, status: 0, text: "retries exhausted" };
};

const inv = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/idless-company-cards.json", "utf8"));
const noTwin = inv.cards.filter(c => c.bucket === "C_no_twin");
console.log(`no-twin id-less cards: ${noTwin.length}`);

const BAD_DOMAIN = /^$|^[^.]*$|\s/;                       // empty, no dot, or containing whitespace
const usable = noTwin.filter(c => !BAD_DOMAIN.test(c.domain));
const malformed = noTwin.filter(c => BAD_DOMAIN.test(c.domain));
console.log(`  usable domains ${usable.length}, malformed/ambiguous ${malformed.length}`);

/**
 * HubSpot search, domains batched with IN.
 *
 * PAGINATED TO EXHAUSTION, and a chunk that cannot be completed marks EVERY domain in it as
 * unavailable rather than absent. A truncated page and an empty result look identical from here, and
 * treating "I could not finish looking" as "there is nothing there" is how 490 domains would be
 * declared HubSpot-less on the strength of a failed request.
 */
const found = new Map();                                   // domain -> [companies]
const unavailable = new Set();                             // domains whose search could not be completed
const domains = [...new Set(usable.map(c => c.domain))];
console.log(`  distinct domains to look up: ${domains.length}`);
const CHUNK = 50;
for (let i = 0; i < domains.length; i += CHUNK) {
  const chunk = domains.slice(i, i + CHUNK);
  const seenIds = new Set();
  let after, pages = 0, ok = true;
  for (;;) {
    const body = { limit: 100,
      properties: ["domain", "name", "sales_user", "createdate", "sync_owner", "hs_object_id"],
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "IN", values: chunk }] }] };
    if (after) body.after = after;
    const res = await hs("/crm/v3/objects/companies/search", body);
    if (!res.ok) { ok = false; console.log(`   chunk ${i}: ${res.status} ${res.text}`); break; }
    for (const r of res.json.results ?? []) {
      if (seenIds.has(r.id)) continue;                     // dedupe by company id across pages
      seenIds.add(r.id);
      const d = String(r.properties?.domain ?? "").toLowerCase();
      if (!found.has(d)) found.set(d, []);
      found.get(d).push({ id: r.id, name: r.properties?.name ?? "", sync_owner: r.properties?.sync_owner ?? "",
        sales_user: r.properties?.sales_user ?? "", createdate: r.properties?.createdate ?? "" });
    }
    after = res.json.paging?.next?.after;
    pages++;
    if (!after) break;
    if (pages > 60) { ok = false; console.log(`   chunk ${i}: paging did not terminate`); break; }
  }
  if (!ok) for (const d of chunk) unavailable.add(d);
  if (i && i % 200 === 0) console.log(`   ${i}/${domains.length}`);
}
console.log(`  domains whose search could not be completed: ${unavailable.size}`);

const buckets = { C1_one_match: [], C2_many_matches: [], C3_no_match: [],
                  C4_search_unavailable: [], C5_malformed: [] };
for (const c of malformed) buckets.C5_malformed.push({ ...c, why: "domain empty, has no dot, or contains whitespace" });
for (const c of usable) {
  // Unavailable is checked FIRST and unconditionally. "Could not establish" must never fall through
  // into "no match"; the previous version guarded this branch with `&& false`, which disabled it.
  if (unavailable.has(c.domain)) { buckets.C4_search_unavailable.push(c); continue; }
  const m = found.get(c.domain);
  if (!m) buckets.C3_no_match.push(c);
  else if (m.length === 1) buckets.C1_one_match.push({ ...c, hubspot: m[0] });
  else buckets.C2_many_matches.push({ ...c, hubspot: m });
}

console.log("\n================ C. the 492 no-twin cards vs HubSpot");
for (const [k, arr] of Object.entries(buckets)) console.log(`  ${k.padEnd(24)} ${arr.length}`);
console.log(`  sum ${Object.values(buckets).reduce((a, b) => a + b.length, 0)} (expected ${noTwin.length})`);
if (unavailable.size) console.log(`  NOTE: ${unavailable.size} domains could not be searched to completion`);

// ---- Phase 6: for C1, why is there no canonical monday card?
const why = {};
const add = (k) => { why[k] = (why[k] ?? 0) + 1; };
for (const c of buckets.C1_one_match) {
  const h = c.hubspot;
  if (h.sync_owner === "wm") add("sync_owner=wm — the Work-Management Worker owns it; CRM must not create");
  else if (h.sync_owner === "other") add("sync_owner=other — parked by an operator; hands off");
  else if (h.sync_owner === "crm") add("sync_owner=crm — SHOULD have a card; investigate");
  else add("unstamped — allowed only if createdate >= the deployed CRM_CUTOVER_AT");
}
console.log("\n================ why the C1 companies have no canonical card");
for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

const unstamped = buckets.C1_one_match.filter(c => !c.hubspot.sync_owner);
if (unstamped.length) {
  const dates = unstamped.map(c => String(c.hubspot.createdate).slice(0, 10)).sort();
  console.log(`  unstamped createdate range: ${dates[0]} .. ${dates[dates.length - 1]}`);
  const withSales = unstamped.filter(c => c.hubspot.sales_user).length;
  console.log(`  of the unstamped, carrying sales_user: ${withSales}/${unstamped.length}`
    + "   (sales_user is the CRM search filter, so those are in scope apart from the cutover)");
}

console.log("\nsamples:");
for (const [k, arr] of Object.entries(buckets))
  for (const c of arr.slice(0, 2))
    console.log(`  [${k}] card ${c.card} "${String(c.name).slice(0, 18)}" ${c.domain}`
      + (c.hubspot ? `  hs=${Array.isArray(c.hubspot) ? c.hubspot.length + " matches" : c.hubspot.id + " " + c.hubspot.name + " owner=" + (c.hubspot.sync_owner || "(unstamped)")}` : ""));

fs.writeFileSync(HERE + "../../docs/rollout/notwin-domain-probe.json",
  JSON.stringify({ takenAt: new Date().toISOString(), totals: Object.fromEntries(
    Object.entries(buckets).map(([k, a]) => [k, a.length])), buckets }, null, 1));
console.log("\nwrote docs/rollout/notwin-domain-probe.json (READ ONLY)");
