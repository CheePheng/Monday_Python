/**
 * THE --release APPROVAL LIST OF cleanup-extra-cards.mjs (accounts-idless only): ITS PURE HALF.
 *
 * WHY. The 2026-09-30 plan holds 80 id-less Accounts cards for review (the 14 TOUCHED-BY-PERSON, the skeptic's 4
 * named and 62 listed). On 2026-10-05 the user reviewed them and decided to delete all 80, nine only after a fix.
 * The release file is that decision, card by card, and it is the only way a held card can become deletable:
 *
 *   { "decidedBy": string, "decidedAt": ISO string, "decision": string,
 *     "cards": [ { "card": "<monday item id>", "bucket": "A"|"B"|"C"|"D"|"L", "note": string? }, ... ] }
 *
 *   A  the only company of a HubSpot deal. FIXED FIRST: the company is created in HubSpot and the contact linked
 *      to the new real card.
 *   B  a duplicate of a real Account card. FIXED FIRST: the contact is linked to the real card.
 *   C  a rep works the contact; the user accepts that the contact loses this (junk) Account link.
 *   D  the contact has only HubSpot activity; accepted as C.
 *   L  a card the plan called safe but which the LIVE orphan-contact rule now holds (its contact was worked after
 *      2026-09-30); accepted as C and D.
 *
 * WHAT A RELEASE DOES NOT DO. It never skips a check. Every check still runs, on both reads; a release can only
 * WAIVE a reason a check found, and only the few releaseWaiver names. For A and B it waives no orphan-contact
 * reason at all: the rule must pass on its own, and that is the proof the fix landed. A deal on the contact is
 * never waived for any bucket (a deal makes it an A, which needs the fix first). Anything not named -- including
 * every reason a future check may add -- holds.
 *
 * AND A TIMELINE WAIVER IS CHECKED AFTER THE DELETE. It rests on one assumption: that the contact's copy of a
 * person's entry outlives the Account. monday LINKS the copies of one activity, and deleting copies has taken
 * entries off cards no delete was sent to, so the script re-reads those contact cards after each such delete and
 * halts unless every entry still has its twin there (waivesTimeline, mirrorSurvived).
 *
 * Nothing runs at import time and nothing here reads a file, monday or HubSpot: the script reads the release file
 * and the plans, and passes the plan's sets in. That is what lets every refusal be tested without a token.
 */

export const RELEASE_BUCKETS = Object.freeze(["A", "B", "C", "D", "L"]);
/** A card the plan HOLDS may be released only as one of these. */
export const HELD_BUCKETS = Object.freeze(["A", "B", "C", "D"]);
/** A card the plan already calls safe (a candidate) may be released only as L. */
export const CANDIDATE_BUCKETS = Object.freeze(["L"]);
/** The buckets whose orphan-contact losses the user accepted. */
export const ORPHAN_WAIVER_BUCKETS = Object.freeze(["C", "D", "L"]);
/** The one protection a release lifts: the plan's own review hold. Any other refuses the run. */
export const LIFTABLE_PROTECTION = "review";

/**
 * The orphan-contact reasons a C, D or L release waives, exactly as checkIdlessAccounts writes them (one contact
 * card id after the colon). orphaned-contact-has-deal and orphaned-contact-hubspot-deal are deliberately absent.
 * Anchored, so a reason with another suffix or none at all is not waived.
 */
const ORPHAN_WAIVABLE = /^orphaned-contact-(?:person-edit|hubspot-activity|hubspot-unread):\d+$/;
const NOT_OURS = /^timeline-entry-not-ours:([1-9]\d*)$/;
/** A time stamp with a zone, or a date. A time without a zone is local, and an audit record must not be. */
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const MAX_LISTED = 15;
/** The byte-order mark some Windows editors and PowerShell put before the JSON (U+FEFF). */
const BOM = String.fromCharCode(0xfeff);

const isSetLike = x => !!x && typeof x.has === "function";
const words = x => (x == null ? [] : typeof x === "string" ? [x] : [...x].map(String));
/** A value from the file, shown in a refusal: as JSON, and short (the file is the user's own text). */
const show = x => { const s = JSON.stringify(x); return s === undefined ? String(x) : s.length > 40 ? `${s.slice(0, 37)}...` : s; };

/**
 * PARSE AND VALIDATE A RELEASE FILE against the plan, all or nothing. Throws an Error that lists every problem
 * found (the first MAX_LISTED, then a count). The caller refuses the whole run on it.
 *
 *   text          the file's text (a leading BOM is ignored: Windows editors and PowerShell write one)
 *   planIds       every card of the id-less plan (accounts-idless-classified.json)
 *   reconIdless   the 2026-09-30 reconciliation's idless list (companies.json), the plan's own input
 *   heldIds       the cards the plan holds in accounts-idless
 *   candidateIds  the cards the plan already calls safe in accounts-idless
 *   protectedWhy  card id -> EVERY reason it is protected for (a Set, an array, or one string)
 *
 * Returns { decidedBy, decidedAt, decision, cards: [{ card, bucket, note? }], counts: { A, B, C, D, L } }.
 */
export function parseRelease(text, { planIds, reconIdless, heldIds, candidateIds, protectedWhy } = {}) {
  if (![planIds, reconIdless, heldIds, candidateIds].every(isSetLike) || !protectedWhy || typeof protectedWhy.get !== "function")
    throw new Error("parseRelease needs planIds, reconIdless, heldIds, candidateIds and protectedWhy");
  let data;
  const raw = String(text ?? "");
  try { data = JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw); } catch { throw new Error("the release file is not valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the release file must be a JSON object");

  const problems = [];
  for (const k of ["decidedBy", "decision"])
    if (typeof data[k] !== "string" || !data[k].trim()) problems.push(`${k} must be a non-empty string`);
  if (typeof data.decidedAt !== "string" || !ISO.test(data.decidedAt) || !Number.isFinite(Date.parse(data.decidedAt)))
    problems.push(`decidedAt ${show(data.decidedAt)} is not an ISO date or time with a zone`);
  if (!Array.isArray(data.cards) || !data.cards.length) {
    problems.push("cards must be a non-empty array");
    throw refusal(problems);
  }

  const seen = new Map();
  data.cards.forEach((x, i) => {
    const at = `cards[${i}]`;
    if (!x || typeof x !== "object" || Array.isArray(x)) { problems.push(`${at} is not an object`); return; }
    const { card, bucket, note } = x;
    if (typeof card !== "string" || !/^\d+$/.test(card)) { problems.push(`${at}.card ${show(card)} is not a numeric string`); return; }
    const tag = `card ${card}`;
    if (seen.has(card)) { problems.push(`${tag} is listed twice (cards[${seen.get(card)}] and ${at})`); return; }
    seen.set(card, i);
    const known = RELEASE_BUCKETS.includes(bucket);
    if (!known) problems.push(`${tag}: bucket ${show(bucket)} is not one of ${RELEASE_BUCKETS.join(", ")}`);
    if (note !== undefined && typeof note !== "string") problems.push(`${tag}: note must be a string`);
    const inPlan = planIds.has(card);
    if (!inPlan) problems.push(`${tag} is not in the id-less plan`);
    if (!reconIdless.has(card)) problems.push(`${tag} is not on the reconciliation's idless list`);
    const held = heldIds.has(card), candidate = candidateIds.has(card);
    if (held && candidate) problems.push(`${tag} is both held and a candidate in the plan`);
    else if (held) { if (known && !HELD_BUCKETS.includes(bucket)) problems.push(`${tag} is held by the plan: only ${HELD_BUCKETS.join(", ")} releases it, not ${bucket}`); }
    else if (candidate) { if (known && !CANDIDATE_BUCKETS.includes(bucket)) problems.push(`${tag} is already a plan candidate: only L may be given to it, not ${bucket}`); }
    else if (inPlan) problems.push(`${tag} is neither held nor a candidate in the plan`);
    const other = words(protectedWhy.get(card)).filter(w => w !== LIFTABLE_PROTECTION);
    if (other.length) problems.push(`${tag} is protected (${other.join("; ")}): a release lifts only the plan's review hold`);
  });
  if (problems.length) throw refusal(problems);

  const cards = data.cards.map(({ card, bucket, note }) => ({ card, bucket, ...(note !== undefined ? { note } : {}) }));
  return {
    decidedBy: data.decidedBy, decidedAt: data.decidedAt, decision: data.decision, cards,
    counts: Object.fromEntries(RELEASE_BUCKETS.map(b => [b, cards.filter(c => c.bucket === b).length])),
  };
}
function refusal(problems) {
  const more = problems.length > MAX_LISTED ? `; ... and ${problems.length - MAX_LISTED} more` : "";
  return new Error(`${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.slice(0, MAX_LISTED).join("; ")}${more}`);
}

/**
 * THE PLAN AFTER A RELEASE (accounts-idless). A held card released as A-D moves into the candidates, tagged with
 * release = its bucket and planHeld = why the plan held it; a candidate released as L is tagged where it is.
 * Nothing else moves, and the candidates stay in the script's id order (ascending, as numbers). New arrays and
 * objects; the inputs are left untouched. Throws if a released card is not where its bucket says, which
 * parseRelease already refused -- so a throw here is a bug, and it must stop the run rather than pass.
 * Returns { candidates, held, moved: [ids moved out of held], tagged: [ids tagged L] }.
 */
export function releasePlan({ candidates, held }, release) {
  const bucketOf = new Map((release?.cards ?? []).map(c => [String(c.card), c.bucket]));
  const heldIds = new Set(held.map(h => String(h.id))), candidateIds = new Set(candidates.map(c => String(c.id)));
  for (const [card, bucket] of bucketOf) {
    const ok = HELD_BUCKETS.includes(bucket) ? heldIds.has(card) : CANDIDATE_BUCKETS.includes(bucket) && candidateIds.has(card);
    if (!ok) throw new Error(`release card ${card} (${bucket}) is not where its bucket says it is in the plan`);
  }
  const moved = held.filter(h => bucketOf.has(String(h.id)))
    .map(({ planReason, ...item }) => ({ ...item, release: bucketOf.get(String(item.id)), planHeld: planReason ?? null }));
  const kept = candidates.map(c => (bucketOf.get(String(c.id)) === "L" ? { ...c, release: "L" } : c));
  const byId = (a, b) => { const x = BigInt(a.id), y = BigInt(b.id); return x < y ? -1 : x > y ? 1 : 0; };
  return {
    candidates: [...kept, ...moved].sort(byId),
    held: held.filter(h => !bucketOf.has(String(h.id))),
    moved: moved.map(m => String(m.id)),
    tagged: kept.filter(c => c.release === "L").map(c => String(c.id)),
  };
}

/**
 * THE WAIVER: which of a released card's reasons this release accepts. Applied to every read of a released card,
 * the batched first read and the --apply second read alike, from that read's own facts.
 *   C, D, L  drop orphaned-contact-person-edit / -hubspot-activity / -hubspot-unread (the accepted loss).
 *   A, B     drop no orphan-contact reason.
 *   all      drop timeline-entry-not-ours:N only when facts.personEntriesMirrored === true for exactly N entries
 *            (personEntriesMirrored below, computed by the script for this card on this read).
 * Every other reason is kept, known or not; an unknown bucket waives nothing. Reasons keep their order.
 */
export function releaseWaiver(bucket, reasons, facts) {
  if (!Array.isArray(reasons)) throw new TypeError("releaseWaiver: reasons must be an array");
  const remaining = [], waived = [];
  const known = RELEASE_BUCKETS.includes(bucket), orphanOk = ORPHAN_WAIVER_BUCKETS.includes(bucket);
  for (const r of reasons) {
    const s = typeof r === "string" ? r : "";
    const n = NOT_OURS.exec(s);
    const mirrored = !!n && facts?.personEntriesMirrored === true && facts?.personEntries === Number(n[1]);
    (known && ((orphanOk && ORPHAN_WAIVABLE.test(s)) || mirrored) ? waived : remaining).push(r);
  }
  return { remaining, waived };
}

/**
 * Is `other` (an entry on a contact card) the twin of `entry` (an entry on the Account)? The same timeline entry
 * id; or, for a marked entry, the same non-empty set of [hubspot:type:id] markers; or, for an unmarked entry, an
 * unmarked entry with the same fingerprint (type, custom activity, title, time). A marked entry never twins an
 * unmarked one by fingerprint, either way round: one of them carries a HubSpot record the other does not.
 * Entries are readTimeline's: { id, markers: ["type:id", ...], fp }.
 */
export function isTwin(entry, other) {
  if (!entry || !other) return false;
  if (entry.id != null && String(entry.id) !== "" && String(entry.id) === String(other.id ?? "")) return true;
  const a = new Set(entry.markers ?? []), b = new Set(other.markers ?? []);
  if (a.size) return a.size === b.size && [...a].every(m => b.has(m));
  return b.size === 0 && typeof entry.fp === "string" && entry.fp !== "" && entry.fp === other.fp;
}

/**
 * True only when EVERY entry has a twin on at least one of the timelines, and every timeline was read whole
 * ({ complete: true, entries: [...] }). One timeline not read whole is false, whatever the others show: it is
 * the one that could not be checked. No timelines and some entries is false. No entries is true (nothing to
 * mirror), but the waiver also needs the count to match the reason, so that can never waive anything.
 */
export function personEntriesMirrored(entries, timelines) {
  if (!Array.isArray(entries) || !Array.isArray(timelines)) return false;
  if (timelines.some(t => !t || t.complete !== true || !Array.isArray(t.entries))) return false;
  return entries.every(e => timelines.some(t => t.entries.some(f => isTwin(e, f))));
}

/** Did this read waive a timeline-entry-not-ours reason? Then the delete it allows leans on the twins of a person's
 *  entries on the contact cards, and is checked after it (mirrorSurvived). Anything but an array is no. */
export function waivesTimeline(waived) {
  return Array.isArray(waived) && waived.some(r => typeof r === "string" && NOT_OURS.test(r));
}

/**
 * AFTER THE DELETE of a released card whose read waived timeline-entry-not-ours: are the twins it relied on still
 * there? The waiver assumed the contact's copy of each person's entry outlives the Account. Copies of one activity
 * are LINKED on monday's side (src/activity-sync.ts; dedupe-timeline.mjs lost entries on cards no delete was sent
 * to), and whether trashing a whole card takes its linked copies with it was never measured -- so it is checked.
 *
 *   entries  the Account's entries not by the integration user, from the read that allowed the delete
 *            ({ id, markers, fp }, as readTimeline gives them)
 *   after    contact card id -> its timeline read again, uncached, after the delete: a Map, or [id, timeline]
 *            pairs, for the contact cards that read used
 *
 * ok only when every one of those timelines was read whole and every entry still has a twin on at least one of
 * them: the test that allowed the waiver (personEntriesMirrored), on the same cards. No entries or no contact cards
 * is not ok: the evidence behind the waiver is missing, so nothing can be confirmed.
 * Returns { ok, lost: [Account entry ids with no twin left], unreadable: [contact cards not read whole] }.
 */
export function mirrorSurvived(entries, after) {
  const list = Array.isArray(entries) ? entries : [];
  const pairs = after instanceof Map ? [...after] : Array.isArray(after) ? after.filter(p => Array.isArray(p) && p.length === 2) : [];
  const whole = t => !!t && t.complete === true && Array.isArray(t.entries);
  const unreadable = pairs.filter(([, t]) => !whole(t)).map(([cid]) => String(cid));
  const read = pairs.map(([, t]) => t).filter(whole);
  const lost = list.filter(e => !read.some(t => t.entries.some(f => isTwin(e, f)))).map(e => String(e?.id ?? ""));
  const ok = list.length > 0 && pairs.length > 0 && personEntriesMirrored(list, pairs.map(([, t]) => t));
  return { ok, lost, unreadable };
}
