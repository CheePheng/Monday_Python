/**
 * POST-DISABLE BASELINE — READ ONLY.
 *
 * monday CRM -> Item association -> "Automatically associate contacts and accounts based on email
 * domain" was switched ON -> OFF by hand. This records the board's state at that moment so a later
 * read can show whether id-less Accounts stopped appearing.
 *
 * It also proves, rather than assumes, the claim the whole producer argument rests on: that EVERY
 * id-less card lacks Sync State. Our own creation paths (ensureCardForRecord and backfill-crm) both
 * set it in the same mutation, so a single id-less card WITH Sync State would break the exclusion.
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

const BOARD = "5028000496";
const ID_COL = "text_mm6tsnwx", DOMAIN = "company_domain", SYNC = "text_mm6tccd0",
      LINK = "link_mm6zyad8", REL = "account_contact";
const COLS = `["${ID_COL}","${DOMAIN}","${SYNC}","${LINK}","${REL}"]`;

// ---- full board read, guarded pagination and de-duplication (the hardening owed from last time)
console.log("reading the Accounts board...");
const byCard = new Map();
let cursor = null, pages = 0, repeats = 0;
const seenCursors = new Set();
for (;;) {
  const q = cursor
    ? `query ($c:String!) { next_items_page(limit:500, cursor:$c) { cursor items { id name created_at column_values(ids:${COLS}) { id text } } } }`
    : `query { boards(ids:["${BOARD}"]) { items_page(limit:500) { cursor items { id name created_at column_values(ids:${COLS}) { id text } } } } }`;
  const r = await gql(q, cursor ? { c: cursor } : {});
  if (!r) { console.log("FAILED — refusing to report a partial board"); process.exit(1); }
  const page = cursor ? r.next_items_page : r.boards[0].items_page;
  for (const it of page.items) {
    if (byCard.has(it.id)) { repeats++; continue; }
    const cv = Object.fromEntries(it.column_values.map(c => [c.id, (c.text ?? "").trim()]));
    byCard.set(it.id, { card: it.id, name: it.name, created: it.created_at,
      hsId: cv[ID_COL] ?? "", domain: cv[DOMAIN] ?? "", sync: cv[SYNC] ?? "",
      link: cv[LINK] ?? "", rel: cv[REL] ?? "" });
  }
  pages++;
  cursor = page.cursor;
  if (!cursor) break;
  if (seenCursors.has(cursor)) { console.log("FAILED — pagination repeated a cursor"); process.exit(1); }
  seenCursors.add(cursor);
  if (pages > 400) { console.log("FAILED — page budget exhausted"); process.exit(1); }
}
const all = [...byCard.values()];
const idless = all.filter(c => !c.hsId);
const withId = all.filter(c => c.hsId);

console.log("\n================ POST-DISABLE BASELINE");
console.log(`  taken at                      ${new Date().toISOString()}`);
console.log(`  total Accounts cards          ${all.length}   (${pages} pages, ${repeats} overlapping rows dropped)`);
console.log(`  with a HubSpot Company id     ${withId.length}`);
console.log(`  WITHOUT one                   ${idless.length}`);

const newest = [...idless].sort((a, b) => b.created.localeCompare(a.created));
console.log(`\n  newest id-less card           ${newest[0]?.card} "${String(newest[0]?.name).slice(0, 24)}"`);
console.log(`  newest id-less created_at     ${newest[0]?.created}   <- the number to watch`);

console.log("\n  newest 20 id-less cards:");
for (const c of newest.slice(0, 20))
  console.log(`    ${c.created}  ${c.card}  ${String(c.name).slice(0, 20).padEnd(22)}`
    + ` domain=${String(c.domain).split(" ")[0].slice(0, 24).padEnd(26)}`
    + ` sync=${c.sync ? "SET" : "-"} link=${c.link ? "SET" : "-"} rel=${c.rel ? "yes" : "-"}`);

// ---- the assumption the whole exclusion rests on
const idlessWithSync = idless.filter(c => c.sync);
const idlessWithLink = idless.filter(c => c.link);
console.log("\n================ PROOF: does any id-less card carry Sync State?");
console.log(`  no HubSpot id + NO Sync State  ${idless.length - idlessWithSync.length}`);
console.log(`  no HubSpot id + HAS Sync State ${idlessWithSync.length}   <- must be 0 for the exclusion to hold`);
console.log(`  no HubSpot id + HAS HubSpot link ${idlessWithLink.length}`);
for (const c of idlessWithSync.slice(0, 10))
  console.log(`     EXCEPTION ${c.card} "${c.name}" created ${c.created} sync=${c.sync}`);

// ---- Sep-11 timing, from data already held (no API cost)
const byDay = {};
for (const c of idless) (byDay[c.created.slice(0, 10)] ??= []).push(c);
const sep11 = byDay["2026-09-11"] ?? [];
console.log(`\n================ the 2026-09-11 concentration (${sep11.length} cards)`);
const perHour = {}, perTen = {}, perMin = {};
for (const c of sep11) {
  perHour[c.created.slice(11, 13)] = (perHour[c.created.slice(11, 13)] ?? 0) + 1;
  perTen[c.created.slice(11, 15) + "0"] = (perTen[c.created.slice(11, 15) + "0"] ?? 0) + 1;
  perMin[c.created.slice(11, 16)] = (perMin[c.created.slice(11, 16)] ?? 0) + 1;
}
console.log("  per hour (UTC):");
for (const [h, n] of Object.entries(perHour).sort()) console.log(`    ${h}:00  ${"#".repeat(Math.ceil(n / 5)).padEnd(20)} ${n}`);
console.log("  busiest 10-minute windows:");
for (const [t, n] of Object.entries(perTen).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`    ${t}  ${n}`);
console.log("  busiest single minutes:");
for (const [t, n] of Object.entries(perMin).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`    ${t}  ${n}`);

fs.writeFileSync(HERE + "../../docs/rollout/post-disable-baseline.json",
  JSON.stringify({ takenAt: new Date().toISOString(),
    note: "monday CRM Item association 'Automatically associate' switched OFF by hand just before this run",
    totals: { all: all.length, withId: withId.length, idless: idless.length,
      idlessWithSync: idlessWithSync.length, idlessWithLink: idlessWithLink.length },
    newestIdless: newest.slice(0, 20), byDay: Object.fromEntries(
      Object.entries(byDay).map(([d, a]) => [d, a.length])) }, null, 1));
console.log("\nwrote docs/rollout/post-disable-baseline.json (READ ONLY)");
