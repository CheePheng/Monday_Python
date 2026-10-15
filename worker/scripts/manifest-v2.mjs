/**
 * Manifest v2 — READ ONLY. Adds the expected destinationHubSpotId to every record, and folds in the
 * SKIP whose state was re-established by hand.
 *
 * Why the id is needed: a manifest names a CARD, but a card is a container that can be re-pointed,
 * merged or reused. The repair must be able to refuse when the card no longer stands for the record
 * the manifest meant, and it can only do that if the manifest says which record that was.
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

const ID_COL = { contact: "text_mm6t71dj", company: "text_mm6tsnwx", deal: "text_mm76kxz4" };
const old = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/email-cleanup-manifest.json", "utf8"));

// the one SKIP, re-established by hand: f01187ef is gone, 892cec00 remains, bodyless
const RESOLVED_SKIP = { card: "2855739270", email: "400770368243",
  timelineIds: ["892cec00-7e6e-4af9-8e66-0e662d8952aa"], copies: 1, bodies: [0],
  action: "REPAIR_BODY", why: "re-read 2026-09-19: one copy vanished, the remaining copy is bodyless" };

const records = old.manifest.map(m => {
  if (m.card === RESOLVED_SKIP.card && m.email === RESOLVED_SKIP.email)
    return { ...m, ...RESOLVED_SKIP, removeAfterVerify: RESOLVED_SKIP.timelineIds };
  return m;
});

// monday's items(ids:) caps at 25; alias 8 groups per request, the 3x lever proven earlier
const byKind = {};
for (const m of records) (byKind[m.kind] ??= new Set()).add(m.card);
const idOf = new Map();
for (const [kind, set] of Object.entries(byKind)) {
  const cards = [...set];
  console.log(`${kind}: reading the HubSpot id of ${cards.length} cards`);
  for (let i = 0; i < cards.length; i += 200) {
    const groups = [];
    for (let g = i; g < Math.min(i + 200, cards.length); g += 25) groups.push(cards.slice(g, g + 25));
    const decl = groups.map((_, k) => `$i${k}:[ID!]`).join(", ");
    const body = groups.map((_, k) =>
      `g${k}: items(ids:$i${k}) { id column_values(ids:["${ID_COL[kind]}"]) { text } }`).join("\n  ");
    const vars = {};
    groups.forEach((grp, k) => { vars[`i${k}`] = grp; });
    const d = await gql(`query (${decl}) {\n  ${body}\n}`, vars);
    groups.forEach((grp, k) => {
      const got = d?.[`g${k}`] ?? [];
      if (got.length !== grp.length) console.log(`   WARNING short group: asked ${grp.length}, got ${got.length}`);
      for (const it of got)
        idOf.set(`${kind}|${it.id}`, String(it.column_values?.[0]?.text ?? "").trim());
    });
  }
}

let missing = 0;
const out = records.map(m => {
  const dest = idOf.get(`${m.kind}|${m.card}`) ?? "";
  if (!dest) missing++;
  return { ...m, destinationHubSpotId: dest,
    action: dest ? m.action : "SKIP",
    why: dest ? m.why : "card carries no HubSpot id — cannot prove destination identity" };
});

const tally = {};
for (const m of out) tally[m.action] = (tally[m.action] ?? 0) + 1;
console.log("\n================ MANIFEST v2");
for (const [k, n] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(20)} ${n}`);
console.log(`  cards with no HubSpot id  ${missing}`);
console.log(`  total                     ${out.length}`);

const fails = [];
if (out.some(m => m.action !== "SKIP" && !m.destinationHubSpotId)) fails.push("an actionable record has no destination id");
if (out.some(m => m.kind === "deal" && m.action !== "SKIP")) fails.push("a Deals record is actionable");
if (out.some(m => Date.parse(m.ts) < Date.parse(old.cutover))) fails.push("a pre-cutover record is present");
if (out.filter(m => m.action === "NOOP").length !== 108) fails.push(`NOOP is ${tally.NOOP}, expected 108`);
console.log("\n================ ASSERTIONS");
console.log(fails.length ? fails.map(f => "  FAIL " + f).join("\n") : "  all pass — nothing was mutated");

fs.writeFileSync(HERE + "../../docs/rollout/email-cleanup-manifest-v2.json",
  JSON.stringify({ takenAt: new Date().toISOString(), cutover: old.cutover, version: 2,
    supersedes: "email-cleanup-manifest.json", totals: tally, manifest: out }, null, 1));
console.log("\nwrote docs/rollout/email-cleanup-manifest-v2.json (v1 left intact as evidence)");
