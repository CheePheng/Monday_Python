/**
 * READ ONLY pre-flight for a single orphan-Account retirement. It has NO deletion path and never will
 * until every gate below can be answered from evidence.
 *
 * FAILS CLOSED. Each gate must return a definite pass; "unknown" is a refusal, not a shrug. The two
 * gates that cannot currently be answered from here are marked MANUAL and block the run, because the
 * alternative is to quietly treat an unproven condition as satisfied.
 *
 *   node scripts/canary-preflight.mjs <orphanCardId>
 */
import fs from "node:fs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const v = Object.fromEntries(fs.readFileSync(HERE + "../.dev.vars", "utf8").split(/\r?\n/)
  .filter(l => l.includes("=")).map(l => { const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const gql = async (q, vars) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch("https://api.monday.com/v2", { method: "POST",
        headers: { "content-type": "application/json", authorization: v.MONDAY_API_TOKEN, "API-Version": "2026-07" },
        body: JSON.stringify({ query: q, variables: vars }), signal: AbortSignal.timeout(90000) });
      const j = await r.json();
      if (!j.errors) return j.data;
      if (a === 3) return null;
    } catch { if (a === 3) return null; }
    await new Promise(s => setTimeout(s, 2000 * (a + 1)));
  }
  return null;
};
const normDomain = (s) => String(s ?? "").trim().toLowerCase().split(/[\s|,]/)[0]
  .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].replace(/\.$/, "");

const orphanId = process.argv[2];
if (!orphanId) { console.log("usage: node scripts/canary-preflight.mjs <orphanCardId>"); process.exit(1); }

const rec = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/canonical-email-recount.json", "utf8"));
const base = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/post-disable-baseline.json", "utf8"));
const cand = rec.safeCandidates.find(c => c.orphan === orphanId);

/** The five orphans our own adoption pass annotated — the only ones our code ever touched, and so
 *  the only ones plausibly holding a registry pairing. Excluded by name, not by inference. */
const SENTINEL = new Set(["2854825212", "2854902122", "2855140556", "2855240915", "2855300666"]);

const gates = [];
const gate = (name, ok, detail) => { gates.push({ name, ok, detail }); };

if (!cand) { gate("candidate is on the verified safe list", false, `${orphanId} is not in canonical-email-recount.json`); }
else {
  const COLS = ["text_mm6tsnwx", "company_domain", "account_contact", "board_relation_mm76cv3c",
                "text_mm6t1q4h", "multiple_person_mm6z8mwy", "text_mm6tccd0"];
  const d = await gql(`query ($i:[ID!]) { items(ids:$i) { id name column_values(ids:[${COLS.map(c => `"${c}"`).join(",")}]) { id text } } }`,
    { i: [cand.orphan, cand.canonical] });
  const f = new Map((d?.items ?? []).map(it => [it.id,
    { name: it.name, cv: Object.fromEntries(it.column_values.map(c => [c.id, (c.text ?? "").trim()])) }]));
  const o = f.get(cand.orphan), c = f.get(cand.canonical);

  gate("not one of the five adoption-sentinel orphans", !SENTINEL.has(cand.orphan),
    SENTINEL.has(cand.orphan) ? "our adoption pass touched this card; it may hold a registry pairing" : "clean");
  gate("orphan still exists", !!o, o ? o.name : "not found");
  gate("canonical still exists", !!c, c ? c.name : "not found");
  if (o && c) {
    gate("orphan HubSpot id is empty", !o.cv.text_mm6tsnwx, o.cv.text_mm6tsnwx || "(empty)");
    gate("orphan carries no Sync State", !o.cv.text_mm6tccd0, o.cv.text_mm6tccd0 || "(empty)");
    gate("canonical HubSpot id EQUALS the expected one",
      c.cv.text_mm6tsnwx === cand.hubspotCompanyId, `${c.cv.text_mm6tsnwx} vs expected ${cand.hubspotCompanyId}`);
    gate("domains match each other and the record",
      normDomain(o.cv.company_domain) === normDomain(c.cv.company_domain)
      && normDomain(o.cv.company_domain) === cand.domain,
      `${normDomain(o.cv.company_domain)} / ${normDomain(c.cv.company_domain)} / expected ${cand.domain}`);
    gate("orphan has no Contact relation", !o.cv.account_contact, o.cv.account_contact || "(none)");
    gate("orphan has no Deal relation", !o.cv.board_relation_mm76cv3c, o.cv.board_relation_mm76cv3c || "(none)");
    let conflicts = [];
    for (const k of ["text_mm6t1q4h", "multiple_person_mm6z8mwy"]) {
      if (o.cv[k] && c.cv[k] && o.cv[k] !== c.cv[k]) conflicts.push(`${k} conflicts`);
      else if (o.cv[k] && !c.cv[k]) conflicts.push(`${k} orphan-only`);
    }
    gate("no orphan-only or conflicting business fields", conflicts.length === 0, conflicts.join(", ") || "none");

    const t = await gql(`query ($i:ID!) { timeline(id:$i) { timeline_items_page(limit:100) { cursor timeline_items { id } } } }`,
      { i: cand.orphan });
    const page = t?.timeline?.timeline_items_page;
    gate("orphan timeline is readable and EMPTY", !!page && (page.timeline_items ?? []).length === 0 && !page.cursor,
      page ? `${(page.timeline_items ?? []).length} entries` : "unreadable");
  }
}

// ---- gates that cannot be answered from here
gate("MANUAL: monday CRM Item association is still OFF", false,
  "not queryable through the public API — confirm in monday CRM Settings before mutating");
gate("MANUAL: no new id-less Accounts after a real working day", false,
  `re-run check-post-disable.mjs against baseline ${base.takenAt}; Sunday's zero result is not proof`);
gate("BLOCKED: orphan has no card-registry pairing", false,
  "lookupCardOwner is Durable Object state with no read-only endpoint; a deletion on a card that DOES "
  + "have a pairing would trigger restoreDeletedCard instead of a no-op");

console.log(`================ CANARY PRE-FLIGHT — orphan ${orphanId}`);
if (cand) console.log(`  proposed: ${cand.orphan} "${cand.orphanName}" -> canonical ${cand.canonical} `
  + `"${cand.canonicalName}" (hs ${cand.hubspotCompanyId}, ${cand.domain})\n`);
for (const g of gates) console.log(`  ${g.ok ? "PASS" : "BLOCK"}  ${g.name.padEnd(52)} ${g.detail}`);
const blocked = gates.filter(g => !g.ok);
console.log(`\n  ${blocked.length === 0 ? "ALL GATES PASS" : `${blocked.length} GATE(S) BLOCK — no mutation may occur`}`);
console.log("\n  This script has no deletion path. It never mutates anything.");
