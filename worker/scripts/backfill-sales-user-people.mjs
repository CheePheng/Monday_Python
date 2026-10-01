/**
 * Populate the NEW visible "Sales User" People columns on Accounts and Deals from HubSpot.
 *
 * The columns were created 2026-09-21, after the historical import, so they are empty on every existing
 * card. This is a one-time monday-only backfill.
 *
 *   node --env-file=.dev.vars scripts/backfill-sales-user-people.mjs --plan
 *   node --env-file=.dev.vars scripts/backfill-sales-user-people.mjs --apply --accounts
 *   node --env-file=.dev.vars scripts/backfill-sales-user-people.mjs --apply --deals --limit 200
 *
 * HUBSPOT IS THE SOURCE, NEVER THE LEGACY DROPDOWN. The dropdown holds a resolved owner NAME; deriving
 * the People value from it would launder a display string back into an identity, and two of this
 * portal's owners share a name (Myla Mestiola 164317533/1739141284, Chiho Miyagawa 81603620/81653327,
 * Alex Day 35285677/1846798699). The owner id on the HubSpot record is the only unambiguous input.
 *
 * WRITES MONDAY ONLY. No HubSpot call in this file is anything but a GET or a batch/read POST.
 *
 * IDEMPOTENT AND RESUMABLE: a card whose People cell already holds the right person is skipped, and the
 * HubSpot id is re-read immediately before the write so a card that changed hands since the scan is
 * failed closed rather than overwritten.
 */

const TOKEN = process.env.MONDAY_API_TOKEN;
const HS = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN || !HS) { console.log("MONDAY_API_TOKEN and HUBSPOT_ACCESS_TOKEN are required"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const LIMIT = Number((process.argv.find(a => a.startsWith("--limit=")) ?? "").split("=")[1]
  || (process.argv[process.argv.indexOf("--limit") + 1] ?? 0)) || Infinity;
const ONLY = process.argv.includes("--accounts") ? ["accounts"]
  : process.argv.includes("--deals") ? ["deals"] : ["accounts", "deals"];

const BOARDS = {
  accounts: { board: "5028000496", name: "Accounts/Companies", object: "companies",
              idCol: "text_mm6tsnwx", peopleCol: "multiple_person_mm7d2qk6" },
  deals:    { board: "5028000494", name: "Deals", object: "deals",
              idCol: "text_mm76kxz4", peopleCol: "multiple_person_mm7df31a" },
};

const gql = async (query, variables) => {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 4) { console.log("  monday errors:", JSON.stringify(j.errors).slice(0, 300)); return null; }
    } catch (e) { if (a === 4) { console.log("  monday fetch failed:", e.message); return null; } }
    await new Promise(s => setTimeout(s, 2000 * (a + 1)));
  }
  return null;
};
const hsGet = async (p) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch("https://api.hubapi.com" + p,
        { headers: { authorization: `Bearer ${HS}` }, signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (a + 1))); continue; }
      return await r.json();
    } catch { if (a === 3) return null; }
  }
  return null;
};
const hsBatchRead = async (object, ids) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${object}/batch/read`, { method: "POST",
        headers: { authorization: `Bearer ${HS}`, "content-type": "application/json" },
        body: JSON.stringify({ properties: ["sales_user"], inputs: ids.map(id => ({ id })) }),
        signal: AbortSignal.timeout(90000) });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (a + 1))); continue; }
      const j = await r.json();
      return j.results ?? [];
    } catch { if (a === 3) return []; }
  }
  return [];
};

// ---------------------------------------------------------------- identity tables
/** ownerId -> email. Archived FIRST then active, so an active owner wins a duplicate id. */
async function ownerEmails() {
  const out = {};
  for (const archived of [true, false]) {
    let after = null;
    do {
      const p = await hsGet(`/crm/v3/owners/?limit=100&archived=${archived}${after ? `&after=${after}` : ""}`);
      for (const o of p?.results ?? []) if (o.email) out[String(o.id)] = String(o.email).toLowerCase();
      after = p?.paging?.next?.after ?? null;
    } while (after);
  }
  return out;
}
/** email -> monday user id. An email shared by two monday users is DROPPED, not guessed. */
async function mondayUsers() {
  const out = {}, dupes = new Set();
  let page = 1;
  for (;;) {
    const d = await gql(`query ($p:Int!) { users(limit:200, page:$p) { id email } }`, { p: page });
    const us = d?.users ?? [];
    for (const u of us) {
      const e = String(u.email ?? "").toLowerCase();
      if (!e) continue;
      if (out[e] && out[e] !== String(u.id)) dupes.add(e);
      out[e] = String(u.id);
    }
    if (us.length < 200) break;
    page++;
  }
  for (const e of dupes) delete out[e];   // ambiguous -> fail closed
  return { byEmail: out, ambiguous: [...dupes] };
}

// ---------------------------------------------------------------- per board
async function run(key) {
  const B = BOARDS[key];
  console.log(`\n================ ${B.name} (${B.board})`);
  const owners = await ownerEmails();
  const { byEmail, ambiguous } = await mondayUsers();
  console.log(`   HubSpot owners with an email: ${Object.keys(owners).length}`
    + `   monday users by email: ${Object.keys(byEmail).length}`
    + (ambiguous.length ? `   AMBIGUOUS emails dropped: ${ambiguous.length}` : ""));

  // --- read every card's HubSpot id + current People value
  const cards = [];
  let cursor = null;
  for (let p = 0; p < 400; p++) {
    const q = cursor
      ? `query ($c:String!) { boards(ids:["${B.board}"]) { items_page(limit:500, cursor:$c) { cursor items { id column_values(ids:["${B.idCol}","${B.peopleCol}"]) { id text ... on PeopleValue { persons_and_teams { id kind } } } } } } }`
      : `query { boards(ids:["${B.board}"]) { items_page(limit:500) { cursor items { id column_values(ids:["${B.idCol}","${B.peopleCol}"]) { id text ... on PeopleValue { persons_and_teams { id kind } } } } } } }`;
    const d = await gql(q, cursor ? { c: cursor } : {});
    const pg = d?.boards?.[0]?.items_page;
    if (!pg) break;
    for (const it of pg.items) {
      const cv = Object.fromEntries(it.column_values.map(c => [c.id, c]));
      cards.push({
        card: it.id,
        hsId: String(cv[B.idCol]?.text ?? "").trim(),
        person: (cv[B.peopleCol]?.persons_and_teams ?? []).find(x => x.kind === "person")?.id ?? null,
      });
    }
    cursor = pg.cursor;
    if (!cursor) break;
  }
  console.log(`   cards read: ${cards.length}`);

  // --- HubSpot sales_user for every carded id
  const withId = cards.filter(c => /^\d+$/.test(c.hsId));
  const salesUser = new Map();
  const missing = new Set(withId.map(c => c.hsId));
  for (let i = 0; i < withId.length; i += 100) {
    const ids = [...new Set(withId.slice(i, i + 100).map(c => c.hsId))];
    for (const r of await hsBatchRead(B.object, ids)) {
      salesUser.set(String(r.id), String(r.properties?.sales_user ?? "").trim());
      missing.delete(String(r.id));
    }
    if (i && i % 2000 === 0) console.log(`      hubspot read ${i}/${withId.length}`);
  }

  // --- classify
  const t = { total: cards.length, withId: withId.length, blankId: cards.length - withId.length,
    stale: 0, hsEmpty: 0, noOwnerEmail: 0, noMondayUser: 0, alreadyCorrect: 0, wouldWrite: 0 };
  const writes = [];
  const unresolved = { owners: new Map(), emails: new Map() };
  for (const c of withId) {
    if (missing.has(c.hsId)) { t.stale++; continue; }
    const su = salesUser.get(c.hsId) ?? "";
    if (!su) { t.hsEmpty++; continue; }
    const email = owners[su];
    if (!email) { t.noOwnerEmail++; unresolved.owners.set(su, (unresolved.owners.get(su) ?? 0) + 1); continue; }
    const uid = byEmail[email];
    if (!uid) { t.noMondayUser++; unresolved.emails.set(email, (unresolved.emails.get(email) ?? 0) + 1); continue; }
    if (String(c.person) === String(uid)) { t.alreadyCorrect++; continue; }
    t.wouldWrite++;
    writes.push({ card: c.card, hsId: c.hsId, uid, ownerId: su });
  }

  console.log(`   ${"total cards".padEnd(28)} ${t.total}`);
  console.log(`   ${"carrying a HubSpot id".padEnd(28)} ${t.withId}   (blank: ${t.blankId})`);
  console.log(`   ${"HubSpot sales_user empty".padEnd(28)} ${t.hsEmpty}`);
  console.log(`   ${"already correct".padEnd(28)} ${t.alreadyCorrect}`);
  console.log(`   ${"WOULD WRITE".padEnd(28)} ${t.wouldWrite}`);
  console.log(`   ${"owner has no email".padEnd(28)} ${t.noOwnerEmail}`);
  console.log(`   ${"email has no monday user".padEnd(28)} ${t.noMondayUser}`);
  console.log(`   ${"HubSpot record gone (stale)".padEnd(28)} ${t.stale}`);
  if (unresolved.owners.size) {
    console.log("   owners with no email:");
    for (const [o, n] of [...unresolved.owners].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`      owner ${o}: ${n} cards`);
  }
  if (unresolved.emails.size) {
    console.log("   emails with no monday user:");
    for (const [e, n] of [...unresolved.emails].sort((a, b) => b[1] - a[1]).slice(0, 8))
      console.log(`      ${e.replace(/^(.{3}).*@/, "$1***@")}: ${n} cards`);
  }

  if (!APPLY) { console.log(`   --plan only; nothing written.`); return t; }

  // --- write, 8 per request (monday serialises account-wide; aliasing is the only real speed-up)
  const todo = writes.slice(0, LIMIT === Infinity ? writes.length : LIMIT);
  console.log(`\n   writing ${todo.length}${todo.length < writes.length ? ` of ${writes.length} (--limit)` : ""}...`);
  let done = 0, skipped = 0, failed = 0;
  for (let i = 0; i < todo.length; i += 8) {
    const chunk = todo.slice(i, i + 8);
    // Re-read the HubSpot id immediately before writing: a card that changed identity since the scan
    // must be skipped, never overwritten.
    const check = await gql(`query ($i:[ID!]) { items(ids:$i) { id column_values(ids:["${B.idCol}"]) { text } } }`,
      { i: chunk.map(c => c.card) });
    const now = Object.fromEntries((check?.items ?? []).map(it => [it.id, String(it.column_values[0]?.text ?? "").trim()]));
    const safe = chunk.filter(c => now[c.card] === c.hsId);
    skipped += chunk.length - safe.length;
    if (!safe.length) continue;
    const muts = safe.map((c, n) => `m${n}: change_multiple_column_values(board_id:"${B.board}", item_id:"${c.card}", `
      + `column_values: ${JSON.stringify(JSON.stringify({ [B.peopleCol]: { personsAndTeams: [{ id: Number(c.uid), kind: "person" }] } }))}) { id }`).join("\n");
    const res = await gql(`mutation {\n${muts}\n}`);
    if (res) done += safe.length; else failed += safe.length;
    if ((i / 8) % 25 === 0) console.log(`      ${done}/${todo.length} written  (skipped ${skipped}, failed ${failed})`);
  }
  console.log(`   DONE: written ${done}, skipped-changed ${skipped}, failed ${failed}`);
  return { ...t, written: done, skippedChanged: skipped, failed };
}

for (const k of ONLY) await run(k);
if (!APPLY) console.log("\n--plan only. Re-run with --apply to write.");
