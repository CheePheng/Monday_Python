/**
 * Corrected reporting over the saved id-less inventory. READ ONLY, no API calls, no mutation.
 *
 * Three fixes over the first report:
 *  1. CARDS vs PAIRS. The first version built a Set of skipped card ids and incremented once per
 *     card, so it reported cards while claiming to report the 403 skipped email pairs. Several
 *     pairs can sit on one card, so the two numbers are genuinely different and both are wanted.
 *  2. "entries in total" was the sum of TOTAL timeline entries, labelled as if it were email
 *     entries. Timeline entries, distinct email markers and cards-carrying-email are three
 *     different quantities and are now reported separately.
 *  3. The scan's board read had no repeated-cursor guard or de-duplication. Rather than assume it
 *     was harmless, the saved rows are checked for duplicate card ids here.
 */
import fs from "node:fs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const inv = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/idless-company-cards.json", "utf8"));
const man = JSON.parse(fs.readFileSync(HERE + "../../docs/rollout/email-cleanup-manifest-v2.json", "utf8"));

// ---- fix 3: did the unguarded pagination actually cost anything?
const ids = inv.cards.map(c => c.card);
const dupes = ids.length - new Set(ids).size;
console.log("================ SCAN INTEGRITY");
console.log(`  id-less cards recorded      ${ids.length}`);
console.log(`  duplicate card ids          ${dupes}   <- unguarded pagination would show up here`);
console.log(`  incomplete timelines        ${inv.cards.filter(c => c.incomplete).length}`);

// ---- fix 1: cards by bucket, and PAIRS by bucket, counted separately
const bucketOf = new Map(inv.cards.map(c => [c.card, c.bucket]));
const skips = man.manifest.filter(m => m.action === "SKIP");

const cardBuckets = {}, pairBuckets = {};
const manifestCards = new Set(skips.map(s => s.card));
for (const card of manifestCards) {
  const b = bucketOf.get(card) ?? "E_not_in_inventory";
  cardBuckets[b] = (cardBuckets[b] ?? 0) + 1;
}
for (const s of skips) {                                    // one increment PER PAIR, not per card
  const b = bucketOf.get(s.card) ?? "E_not_in_inventory";
  pairBuckets[b] = (pairBuckets[b] ?? 0) + 1;
}

const allCardBuckets = {};
for (const c of inv.cards) allCardBuckets[c.bucket] = (allCardBuckets[c.bucket] ?? 0) + 1;

console.log("\n================ A. ALL id-less Accounts cards, by bucket");
for (const [k, n] of Object.entries(allCardBuckets).sort()) console.log(`  ${k.padEnd(24)} ${n}`);
console.log(`  TOTAL                    ${inv.cards.length}`);

console.log("\n================ B. The manifest's skipped population");
console.log("  distinct CARDS by bucket");
for (const [k, n] of Object.entries(cardBuckets).sort()) console.log(`    ${k.padEnd(22)} ${n}`);
const cardSum = Object.values(cardBuckets).reduce((a, b) => a + b, 0);
console.log(`    sum                    ${cardSum}   ${cardSum === 395 ? "(matches the 395 expected)" : "** expected 395 **"}`);

console.log("  skipped email PAIRS by bucket");
for (const [k, n] of Object.entries(pairBuckets).sort()) console.log(`    ${k.padEnd(22)} ${n}`);
const pairSum = Object.values(pairBuckets).reduce((a, b) => a + b, 0);
console.log(`    sum                    ${pairSum}   ${pairSum === 403 ? "(matches the 403 expected)" : "** expected 403 **"}`);

// ---- fix 2: three separate quantities, no longer one mislabelled number
const withEmail = inv.cards.filter(c => c.emailMarkers > 0);
const totalMarkers = inv.cards.reduce((a, c) => a + c.emailMarkers, 0);
const totalEntries = inv.cards.reduce((a, c) => a + c.timelineCount, 0);
console.log("\n================ C. What is actually ON these cards");
console.log(`  cards carrying >=1 HubSpot Email marker   ${withEmail.length}`);
console.log(`  distinct HubSpot Email markers on them    ${totalMarkers}`);
console.log(`  TOTAL timeline entries across all cards   ${totalEntries}`);
console.log(`  cards with an empty timeline              ${inv.cards.filter(c => c.timelineCount === 0).length}`);

// what would be at stake per bucket if these were ever merged away
console.log("\n================ D. History at stake, by bucket");
for (const b of Object.keys(allCardBuckets).sort()) {
  const rows = inv.cards.filter(c => c.bucket === b);
  console.log(`  ${b.padEnd(24)} cards ${String(rows.length).padStart(4)}`
    + `  carrying email ${String(rows.filter(r => r.emailMarkers > 0).length).padStart(4)}`
    + `  email markers ${String(rows.reduce((a, r) => a + r.emailMarkers, 0)).padStart(5)}`
    + `  timeline entries ${String(rows.reduce((a, r) => a + r.timelineCount, 0)).padStart(5)}`);
}
