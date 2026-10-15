import { describe, it, expect } from "vitest";
import { readScript, readScriptSource } from "../scripts/read-source.mjs";
import {
  parseRelease, releasePlan, releaseWaiver, isTwin, personEntriesMirrored, waivesTimeline, mirrorSurvived,
  RELEASE_BUCKETS, HELD_BUCKETS, CANDIDATE_BUCKETS, ORPHAN_WAIVER_BUCKETS, LIFTABLE_PROTECTION,
} from "../scripts/lib/cleanup-release.mjs";

/**
 * THE --release APPROVAL LIST OF cleanup-extra-cards.mjs (2026-10-05).
 *
 * The 2026-09-30 plan holds 80 id-less Accounts cards for review; the user decided to delete all of them, nine only
 * after a fix. The release file is that decision. It may lift the plan's review hold and waive a few named reasons
 * -- and nothing else: a bad file refuses the whole run, A and B (the fixed ones) waive no orphan reason, a deal is
 * never waived, and anything not named holds.
 *
 * .mjs, not .ts: the module has no .d.mts, and the tsconfig only type-checks test/**\/*.ts.
 */

const HELD_A = "2857200440", HELD_B = "2862637701", HELD_C = "2857184159", HELD_D = "2854825212";
const HELD_UNKNOWN = "2857000001";      // held for an unknown plan class: protected "unknown"
const HELD_REAL = "2857000002";         // held for review AND another id-less card's real company card
const NOT_ON_RECON = "2857000003";      // held for review, but not on the reconciliation's idless list
const CAND = "2854825999";              // a candidate (the plan calls it safe)
const CAND_SURVIVOR = "2855725789";     // a candidate that is also protected as a survivor
const OUTSIDE = "2999999999";           // not in the id-less plan at all

const ctx = (over = {}) => ({
  planIds: new Set([HELD_A, HELD_B, HELD_C, HELD_D, HELD_UNKNOWN, HELD_REAL, NOT_ON_RECON, CAND, CAND_SURVIVOR]),
  reconIdless: new Set([HELD_A, HELD_B, HELD_C, HELD_D, HELD_UNKNOWN, HELD_REAL, CAND, CAND_SURVIVOR, OUTSIDE]),
  heldIds: new Set([HELD_A, HELD_B, HELD_C, HELD_D, HELD_UNKNOWN, HELD_REAL, NOT_ON_RECON]),
  candidateIds: new Set([CAND, CAND_SURVIVOR]),
  protectedWhy: new Map([
    ...[HELD_A, HELD_B, HELD_C, HELD_D, NOT_ON_RECON].map(id => [id, new Set(["review"])]),
    [HELD_UNKNOWN, new Set(["unknown"])],
    [HELD_REAL, new Set(["review", "the real company card of an id-less duplicate"])],
    [CAND_SURVIVOR, new Set(["the survivor for HubSpot company 1234567890"])],
  ]),
  ...over,
});
const GOOD = [
  { card: HELD_A, bucket: "A" }, { card: HELD_B, bucket: "B", note: "contact linked to the real card" },
  { card: HELD_C, bucket: "C" }, { card: HELD_D, bucket: "D" }, { card: CAND, bucket: "L" },
];
const file = (cards = GOOD, over = {}) => JSON.stringify({
  decidedBy: "Woody", decidedAt: "2026-10-05T03:30:00Z", decision: "delete all 80 held id-less Accounts after fixing 9",
  cards, ...over,
});
const parse = (text, over) => parseRelease(text, ctx(over));
/** The refusal message, or a failure if the file was accepted. */
const refusal = (text, over) => {
  try { parse(text, over); } catch (e) { return e.message; }
  throw new Error("expected the release to be refused");
};

describe("parseRelease: a valid approval list", () => {
  it("returns the decision, each card's bucket (and note), and counts per bucket", () => {
    const r = parse(file());
    expect(r).toMatchObject({ decidedBy: "Woody", decidedAt: "2026-10-05T03:30:00Z", decision: expect.stringContaining("after fixing 9") });
    expect(r.cards).toEqual([
      { card: HELD_A, bucket: "A" }, { card: HELD_B, bucket: "B", note: "contact linked to the real card" },
      { card: HELD_C, bucket: "C" }, { card: HELD_D, bucket: "D" }, { card: CAND, bucket: "L" },
    ]);
    expect(r.counts).toEqual({ A: 1, B: 1, C: 1, D: 1, L: 1 });
  });

  it("reads a file written with a BOM, and keeps only card, bucket and note of each entry", () => {
    const r = parse(`${String.fromCharCode(0xfeff)}${file([{ card: HELD_C, bucket: "C", name: "Zkqcip", extra: 1 }])}`);
    expect(r.cards).toEqual([{ card: HELD_C, bucket: "C" }]);
    // Only the one character U+FEFF is skipped, and only at the start: not text that spells it, not a second one.
    expect(refusal(`FEFF${file()}`)).toMatch(/not valid JSON/);
    expect(refusal(`${String.fromCharCode(0xfeff).repeat(2)}${file()}`)).toMatch(/not valid JSON/);
  });

  it("takes a date, or a time with Z or an offset, as decidedAt", () => {
    for (const decidedAt of ["2026-10-05", "2026-10-05T11:30:00+08:00", "2026-10-05T03:30:00.123Z", "2026-10-05T03:30Z"])
      expect(parse(file(GOOD, { decidedAt })).decidedAt, decidedAt).toBe(decidedAt);
  });

  it("names the buckets it knows, and which are for held cards and which for candidates", () => {
    expect(RELEASE_BUCKETS).toEqual(["A", "B", "C", "D", "L"]);
    expect(HELD_BUCKETS).toEqual(["A", "B", "C", "D"]);
    expect(CANDIDATE_BUCKETS).toEqual(["L"]);
    expect(ORPHAN_WAIVER_BUCKETS).toEqual(["C", "D", "L"]);
    expect(LIFTABLE_PROTECTION).toBe("review");
  });
});

describe("parseRelease refuses the WHOLE file on any problem", () => {
  it("refuses a file that is not JSON, or not a JSON object", () => {
    expect(refusal("{ cards: [")).toMatch(/not valid JSON/);
    expect(refusal("")).toMatch(/not valid JSON/);
    for (const t of ["[]", "null", '"cards"', "42"]) expect(refusal(t), t).toMatch(/must be a JSON object/);
  });

  it("refuses a missing or empty decidedBy or decision, and a decidedAt that is not ISO with a zone", () => {
    expect(refusal(file(GOOD, { decidedBy: undefined }))).toMatch(/decidedBy must be a non-empty string/);
    expect(refusal(file(GOOD, { decidedBy: "  " }))).toMatch(/decidedBy must be a non-empty string/);
    expect(refusal(file(GOOD, { decision: "" }))).toMatch(/decision must be a non-empty string/);
    expect(refusal(file(GOOD, { decision: 1 }))).toMatch(/decision must be a non-empty string/);
    for (const decidedAt of [undefined, "", "yesterday", "2026-10-05T11:30:00", "05/10/2026", "2026-13-45", 1759635000000])
      expect(refusal(file(GOOD, { decidedAt })), String(decidedAt)).toMatch(/decidedAt .* is not an ISO date or time with a zone/);
  });

  it("refuses cards that are missing, not an array, or empty", () => {
    // Through `over`, not the first argument: file(undefined) would fall back to GOOD.
    for (const cards of [undefined, null, {}, "2857200440", []])
      expect(refusal(file(GOOD, { cards })), JSON.stringify(cards)).toMatch(/^1 problem: cards must be a non-empty array$/);
  });

  it("refuses an entry that is not an object", () => {
    for (const x of [null, "2857200440", ["2857200440", "A"], 5])
      expect(refusal(file([...GOOD, x])), JSON.stringify(x)).toMatch(/cards\[5\] is not an object/);
  });

  it("refuses a card id that is not a numeric string -- a number included", () => {
    for (const card of [2857200440, "", " 2857200440", "2857200440a", "-2857200440", "2.85e9", null, undefined])
      expect(refusal(file([{ card, bucket: "C" }])), JSON.stringify(card)).toMatch(/\.card .* is not a numeric string/);
    // What the file holds is shown short: a refusal must stay one readable line.
    expect(refusal(file([{ card: "x".repeat(500), bucket: "C" }]))).toBe(`1 problem: cards[0].card "${"x".repeat(36)}... is not a numeric string`);
  });

  it("refuses a card listed twice, whether with the same bucket or another", () => {
    expect(refusal(file([...GOOD, { card: HELD_C, bucket: "C" }]))).toMatch(new RegExp(`card ${HELD_C} is listed twice \\(cards\\[2\\] and cards\\[5\\]\\)`));
    expect(refusal(file([...GOOD, { card: HELD_D, bucket: "C" }]))).toMatch(/is listed twice/);
  });

  it("refuses a bucket that is not exactly A, B, C, D or L", () => {
    for (const bucket of ["E", "a", "c", "", " C", null, undefined, ["C"], 1])
      expect(refusal(file([{ card: HELD_C, bucket }])), JSON.stringify(bucket)).toMatch(/bucket .* is not one of A, B, C, D, L/);
  });

  it("refuses a note that is not a string", () => {
    for (const note of [5, null, { text: "x" }])
      expect(refusal(file([{ card: HELD_C, bucket: "C", note }])), JSON.stringify(note)).toMatch(/note must be a string/);
  });

  it("refuses a card that is not in the id-less plan, or not on the reconciliation's idless list", () => {
    expect(refusal(file([{ card: OUTSIDE, bucket: "C" }]))).toMatch(new RegExp(`card ${OUTSIDE} is not in the id-less plan`));
    expect(refusal(file([{ card: NOT_ON_RECON, bucket: "C" }]))).toMatch(new RegExp(`card ${NOT_ON_RECON} is not on the reconciliation's idless list`));
    // Both lists are needed: a card on the reconciliation but outside the plan is refused, and the other way round.
    expect(refusal(file([{ card: OUTSIDE, bucket: "C" }]))).not.toMatch(/not on the reconciliation/);
    expect(refusal(file([{ card: NOT_ON_RECON, bucket: "C" }]))).not.toMatch(/not in the id-less plan/);
  });

  it("gives L only to a card the plan already calls safe", () => {
    for (const card of [HELD_A, HELD_B, HELD_C, HELD_D])
      expect(refusal(file([{ card, bucket: "L" }])), card).toMatch(new RegExp(`card ${card} is held by the plan: only A, B, C, D releases it, not L`));
    expect(parse(file([{ card: CAND, bucket: "L" }])).cards).toEqual([{ card: CAND, bucket: "L" }]);
  });

  it("gives A, B, C or D only to a card the plan holds", () => {
    for (const bucket of HELD_BUCKETS) {
      expect(refusal(file([{ card: CAND, bucket }])), bucket).toMatch(new RegExp(`card ${CAND} is already a plan candidate: only L may be given to it, not ${bucket}`));
      expect(parse(file([{ card: HELD_C, bucket }])).cards, bucket).toEqual([{ card: HELD_C, bucket }]);
    }
  });

  it("refuses a card in the plan that is neither held nor a candidate, or (a broken plan) both", () => {
    const stray = "2857000009";
    expect(refusal(file([{ card: stray, bucket: "C" }]), { planIds: new Set([...ctx().planIds, stray]), reconIdless: new Set([stray]) }))
      .toMatch(/is neither held nor a candidate in the plan/);
    expect(refusal(file([{ card: HELD_C, bucket: "C" }]), { candidateIds: new Set([CAND, HELD_C]) }))
      .toMatch(/is both held and a candidate in the plan/);
  });

  it("refuses a card protected for anything but the plan's review hold", () => {
    expect(refusal(file([{ card: HELD_UNKNOWN, bucket: "C" }]))).toMatch(new RegExp(`card ${HELD_UNKNOWN} is protected \\(unknown\\)`));
    // A review hold does not excuse a second protection: the real company card of another duplicate.
    expect(refusal(file([{ card: HELD_REAL, bucket: "B" }]))).toMatch(/is protected \(the real company card of an id-less duplicate\)/);
    expect(refusal(file([{ card: CAND_SURVIVOR, bucket: "L" }]))).toMatch(/is protected \(the survivor for HubSpot company 1234567890\)/);
    // The protection may come as one string or an array too.
    expect(refusal(file([{ card: HELD_C, bucket: "C" }]), { protectedWhy: new Map([[HELD_C, "the survivor card of merged contact 1"]]) }))
      .toMatch(/is protected \(the survivor card of merged contact 1\)/);
    expect(refusal(file([{ card: HELD_C, bucket: "C" }]), { protectedWhy: new Map([[HELD_C, ["review", "keep"]]]) })).toMatch(/is protected \(keep\)/);
    // Review alone, or no protection at all, is fine.
    expect(parse(file([{ card: HELD_C, bucket: "C" }]), { protectedWhy: new Map([[HELD_C, "review"]]) }).cards).toHaveLength(1);
    expect(parse(file([{ card: HELD_C, bucket: "C" }]), { protectedWhy: new Map() }).cards).toHaveLength(1);
  });

  it("refuses all of a file for one bad entry, and lists every problem it found", () => {
    const msg = refusal(file([...GOOD, { card: OUTSIDE, bucket: "C" }, { card: CAND, bucket: "A" }], { decision: "" }));
    expect(msg).toMatch(/^3 problems: /);
    expect(msg).toContain("decision must be a non-empty string");
    expect(msg).toContain(`card ${OUTSIDE} is not in the id-less plan`);
    expect(msg).toContain(`card ${CAND} is listed twice`);
    expect(refusal(file([{ card: OUTSIDE, bucket: "C" }]))).toMatch(/^1 problem: /);
    // A long list is cut, and says how much was left out (each stray card here is two problems).
    const many = Array.from({ length: 20 }, (_, i) => ({ card: String(3000000000 + i), bucket: "C" }));
    expect(refusal(file(many), { reconIdless: new Set() })).toMatch(/^40 problems: .*; \.\.\. and 25 more$/);
  });

  it("refuses to judge without the plan's sets", () => {
    expect(() => parseRelease(file())).toThrow(/needs planIds, reconIdless, heldIds, candidateIds and protectedWhy/);
    expect(() => parseRelease(file(), { ...ctx(), reconIdless: undefined })).toThrow(/needs/);
    expect(() => parseRelease(file(), { ...ctx(), protectedWhy: {} })).toThrow(/needs/);
  });
});

describe("releasePlan: released held cards become candidates, in id order, and nothing else moves", () => {
  const item = (id, extra = {}) => ({ group: "accounts-idless", kind: "idless-account", id, name: `n${id}`, ...extra });
  const before = () => ({
    candidates: [item("2854825999"), item("2855000000"), item("2859000000")],
    held: [item("2854825212", { planReason: "skeptic review: HSACT" }), item("2857184159", { planReason: "plan: TOUCHED-BY-PERSON" }),
      item("2858000000", { planReason: "skeptic review: X" })],
  });
  const release = cards => ({ cards });

  it("moves the released held cards, tagged with their bucket and why the plan held them, in id order", () => {
    const p = before();
    const r = releasePlan(p, release([{ card: "2857184159", bucket: "C" }, { card: "2854825212", bucket: "D" }, { card: "2855000000", bucket: "L" }]));
    expect(r.candidates.map(c => c.id)).toEqual(["2854825212", "2854825999", "2855000000", "2857184159", "2859000000"]);
    expect(r.candidates.find(c => c.id === "2854825212")).toEqual({ ...item("2854825212"), release: "D", planHeld: "skeptic review: HSACT" });
    expect(r.candidates.find(c => c.id === "2857184159")).toMatchObject({ release: "C", planHeld: "plan: TOUCHED-BY-PERSON" });
    expect(r.candidates.find(c => c.id === "2857184159")).not.toHaveProperty("planReason");
    // L is only a tag on a card that already was a candidate; the others are untouched.
    expect(r.candidates.find(c => c.id === "2855000000")).toEqual({ ...item("2855000000"), release: "L" });
    expect(r.candidates.find(c => c.id === "2854825999")).toEqual(item("2854825999"));
    expect(r.held.map(h => h.id)).toEqual(["2858000000"]);
    expect(r.moved).toEqual(["2854825212", "2857184159"]);
    expect(r.tagged).toEqual(["2855000000"]);
  });

  it("orders ids as numbers, not as text", () => {
    const r = releasePlan({ candidates: [item("10000000000")], held: [item("9999999999", { planReason: "x" })] },
      release([{ card: "9999999999", bucket: "C" }]));
    expect(r.candidates.map(c => c.id)).toEqual(["9999999999", "10000000000"]);
  });

  it("leaves its inputs as they were", () => {
    const p = before(), copy = JSON.parse(JSON.stringify(p));
    releasePlan(p, release([{ card: "2857184159", bucket: "C" }, { card: "2855000000", bucket: "L" }]));
    expect(p).toEqual(copy);
  });

  it("throws, instead of moving anything, when a card is not where its bucket says", () => {
    expect(() => releasePlan(before(), release([{ card: "2857184159", bucket: "L" }]))).toThrow(/not where its bucket says/);
    expect(() => releasePlan(before(), release([{ card: "2855000000", bucket: "C" }]))).toThrow(/not where its bucket says/);
    expect(() => releasePlan(before(), release([{ card: "2999999999", bucket: "D" }]))).toThrow(/not where its bucket says/);
    expect(() => releasePlan(before(), release([{ card: "2857184159", bucket: "E" }]))).toThrow(/not where its bucket says/);
  });
});

describe("releaseWaiver: only the named reasons, only for their buckets", () => {
  const ORPHAN_ACCEPTED = ["orphaned-contact-person-edit:2856412955", "orphaned-contact-hubspot-activity:2856412955",
    "orphaned-contact-hubspot-unread:2856412955"];
  const DEAL = ["orphaned-contact-has-deal:2856421916", "orphaned-contact-hubspot-deal:2856421916"];
  const NEVER = [
    "not-returned-by-monday", "wrong-board:5028000495", "renamed-since-plan", "file:1", "subitem:2", "update:1",
    "born-before-log-window:2026-08-31T23:00:00Z", "creator:104231431", "has-hubspot-id-now", "deal-link",
    "contact-link-not-in-plan:2856000001", "person-edit:104239547@2026-10-01T02:00:00.000Z", "activity-log-does-not-reach-birth",
    "id-column-was-written:104118038@2026-09-11T07:09:20.000Z", "timeline-unreadable", "linked-contact-not-returned:2856412955",
    "real-company-card-gone",
    // a reason no check writes today, and near-misses of the waivable ones
    "a-check-added-later:1", "orphaned-contact-person-edit:", "orphaned-contact-person-edit:abc", "orphaned-contact-person-edit:1:2",
    "orphaned-contact-hubspot-activity", "xorphaned-contact-hubspot-unread:1", "timeline-entry-not-ours", "timeline-entry-not-ours:0",
    "timeline-entry-not-ours:2x", "timeline-entries-survivor-lacks:notes:1",
  ];
  const MIRRORED = { personEntries: 2, personEntriesMirrored: true };

  it("C, D and L drop the accepted orphan-contact losses, and keep everything else", () => {
    for (const bucket of ["C", "D", "L"]) {
      const r = releaseWaiver(bucket, [...ORPHAN_ACCEPTED, "deal-link"], {});
      expect(r.waived, bucket).toEqual(ORPHAN_ACCEPTED);
      expect(r.remaining, bucket).toEqual(["deal-link"]);
    }
  });

  it("never drops a deal on the contact, for any bucket: a deal makes it an A, fixed first", () => {
    for (const bucket of RELEASE_BUCKETS) expect(releaseWaiver(bucket, DEAL, MIRRORED), bucket).toEqual({ remaining: DEAL, waived: [] });
  });

  it("A and B drop no orphan-contact reason: the rule must pass on its own, the proof the fix landed", () => {
    for (const bucket of ["A", "B"]) expect(releaseWaiver(bucket, [...ORPHAN_ACCEPTED, ...DEAL], MIRRORED), bucket)
      .toEqual({ remaining: [...ORPHAN_ACCEPTED, ...DEAL], waived: [] });
  });

  it("drops timeline-entry-not-ours:N for every bucket, only when exactly those N entries are mirrored", () => {
    for (const bucket of RELEASE_BUCKETS) {
      expect(releaseWaiver(bucket, ["timeline-entry-not-ours:2"], MIRRORED), bucket).toEqual({ remaining: [], waived: ["timeline-entry-not-ours:2"] });
      for (const facts of [{}, undefined, null, { personEntries: 2 }, { personEntries: 2, personEntriesMirrored: false },
        { personEntries: 2, personEntriesMirrored: "true" }, { personEntries: 2, personEntriesMirrored: 1 },
        { personEntries: 3, personEntriesMirrored: true }, { personEntries: "2", personEntriesMirrored: true },
        { personEntriesMirrored: true }])
        expect(releaseWaiver(bucket, ["timeline-entry-not-ours:2"], facts).remaining, `${bucket} ${JSON.stringify(facts)}`).toEqual(["timeline-entry-not-ours:2"]);
    }
  });

  it("never drops anything else, whatever the bucket and the facts", () => {
    for (const bucket of RELEASE_BUCKETS) expect(releaseWaiver(bucket, NEVER, { ...MIRRORED, personEntries: 0 }), bucket)
      .toEqual({ remaining: NEVER, waived: [] });
    expect(releaseWaiver("C", [{ toString: () => "orphaned-contact-person-edit:1" }, 7, null], MIRRORED).waived).toEqual([]);
  });

  it("an unknown bucket drops nothing", () => {
    for (const bucket of ["E", "c", "", undefined, null])
      expect(releaseWaiver(bucket, [...ORPHAN_ACCEPTED, "timeline-entry-not-ours:2"], MIRRORED).waived, String(bucket)).toEqual([]);
  });

  it("keeps the order of what it keeps and of what it drops", () => {
    const reasons = ["person-edit:1@x", ORPHAN_ACCEPTED[1], "timeline-entry-not-ours:2", "deal-link", ORPHAN_ACCEPTED[0]];
    expect(releaseWaiver("D", reasons, MIRRORED)).toEqual({
      remaining: ["person-edit:1@x", "deal-link"], waived: [ORPHAN_ACCEPTED[1], "timeline-entry-not-ours:2", ORPHAN_ACCEPTED[0]],
    });
  });

  it("refuses reasons that are not a list, rather than read them as none", () => {
    for (const reasons of [undefined, null, "timeline-unreadable", { 0: "x" }])
      expect(() => releaseWaiver("C", reasons, {}), JSON.stringify(reasons)).toThrow(TypeError);
  });
});

describe("isTwin and personEntriesMirrored: is every entry also on a linked contact card?", () => {
  const e = (id, markers = [], fp = `fp-${id}`) => ({ id, markers, fp });
  const tl = (entries, complete = true) => ({ complete, entries });

  it("an entry with the same id is its twin, whatever else differs", () => {
    expect(isTwin(e("a1", ["notes:1"], "x"), e("a1", [], "y"))).toBe(true);
    expect(isTwin(e(101), e("101"))).toBe(true);
    expect(isTwin(e(""), e("", [], "other"))).toBe(false);
  });

  it("a marked entry twins one with the same set of markers, in any order, and nothing smaller or larger", () => {
    const acct = e("acct-1", ["calls:7", "notes:9"]);
    expect(isTwin(acct, e("c-1", ["notes:9", "calls:7"]))).toBe(true);
    expect(isTwin(acct, e("c-2", ["notes:9", "calls:7", "notes:9"]))).toBe(true);
    expect(isTwin(acct, e("c-3", ["notes:9"]))).toBe(false);
    expect(isTwin(acct, e("c-4", ["notes:9", "calls:7", "emails:3"]))).toBe(false);
    expect(isTwin(acct, e("c-5", ["notes:8", "calls:7"]))).toBe(false);
  });

  it("an unmarked entry twins an unmarked one with the same fingerprint (monday mirrors under a new id)", () => {
    expect(isTwin(e("acct-1", [], "f00d"), e("contact-9", [], "f00d"))).toBe(true);
    expect(isTwin(e("acct-1", [], "f00d"), e("contact-9", [], "beef"))).toBe(false);
    expect(isTwin(e("acct-1", [], ""), e("contact-9", [], ""))).toBe(false);
    // No fingerprint at all (written out: e() would fill one in) never twins.
    expect(isTwin({ id: "acct-1", markers: [] }, { id: "contact-9", markers: [] })).toBe(false);
    expect(isTwin({ id: "acct-1" }, { id: "contact-9" })).toBe(false);
  });

  it("marked and unmarked never twin by fingerprint, either way round", () => {
    expect(isTwin(e("acct-1", [], "f00d"), e("contact-9", ["notes:1"], "f00d"))).toBe(false);
    expect(isTwin(e("acct-1", ["notes:1"], "f00d"), e("contact-9", [], "f00d"))).toBe(false);
  });

  it("is true only when every entry has a twin on at least one timeline", () => {
    const entries = [e("a1", [], "f1"), e("a2", ["meetings:5"]), e("a3")];
    const c1 = tl([e("x1", [], "f1"), e("x2", ["meetings:5"])]), c2 = tl([e("a3")]);
    expect(personEntriesMirrored(entries, [c1, c2])).toBe(true);
    expect(personEntriesMirrored(entries, [c1])).toBe(false);
    expect(personEntriesMirrored(entries, [c2])).toBe(false);
    expect(personEntriesMirrored(entries, [])).toBe(false);
  });

  it("is false when a contact timeline was not read whole, even if another one holds every twin", () => {
    const entries = [e("a1", [], "f1")];
    const holds = tl([e("x1", [], "f1")]);
    expect(personEntriesMirrored(entries, [holds, tl([], false)])).toBe(false);
    expect(personEntriesMirrored(entries, [tl([e("x1", [], "f1")], false)])).toBe(false);
    for (const bad of [null, undefined, {}, { complete: true }, { complete: "true", entries: [] }, { complete: true, entries: null }])
      expect(personEntriesMirrored(entries, [holds, bad]), JSON.stringify(bad)).toBe(false);
    expect(personEntriesMirrored(entries, undefined)).toBe(false);
    expect(personEntriesMirrored(undefined, [holds])).toBe(false);
  });

  it("no entries is vacuously mirrored, but the waiver still needs a matching count, so it waives nothing", () => {
    expect(personEntriesMirrored([], [])).toBe(true);
    expect(releaseWaiver("C", ["timeline-entry-not-ours:1"], { personEntries: 0, personEntriesMirrored: personEntriesMirrored([], []) }).waived).toEqual([]);
  });

  it("end to end: facts built from the predicate drive the waiver", () => {
    const entries = [e("a1", [], "f1"), e("a2", ["notes:4"])];
    const facts = ok => ({ personEntries: 2, personEntriesMirrored: ok });
    const yes = personEntriesMirrored(entries, [tl([e("c1", [], "f1"), e("c2", ["notes:4"])])]);
    const no = personEntriesMirrored(entries, [tl([e("c1", [], "f1")])]);
    expect(releaseWaiver("B", ["timeline-entry-not-ours:2"], facts(yes))).toEqual({ remaining: [], waived: ["timeline-entry-not-ours:2"] });
    expect(releaseWaiver("B", ["timeline-entry-not-ours:2"], facts(no))).toEqual({ remaining: ["timeline-entry-not-ours:2"], waived: [] });
  });
});

describe("waivesTimeline: does a delete lean on the twins of a person's entries?", () => {
  it("is true only when a timeline-entry-not-ours:N reason was waived", () => {
    expect(waivesTimeline(["timeline-entry-not-ours:2"])).toBe(true);
    expect(waivesTimeline(["orphaned-contact-hubspot-activity:2855240904", "timeline-entry-not-ours:1"])).toBe(true);
    // An orphan waiver alone (the D canary 2854825212 waives only that) does not touch a person's entry.
    for (const waived of [[], ["orphaned-contact-hubspot-activity:2854879632"], ["orphaned-contact-person-edit:1", "orphaned-contact-hubspot-unread:1"]])
      expect(waivesTimeline(waived), JSON.stringify(waived)).toBe(false);
  });

  it("reads anything else as no: near-misses, a string, a missing list", () => {
    for (const waived of [undefined, null, "timeline-entry-not-ours:2", ["timeline-entry-not-ours"], ["timeline-entry-not-ours:0"],
      ["timeline-entry-not-ours:2x"], [{ toString: () => "timeline-entry-not-ours:2" }], [2]])
      expect(waivesTimeline(waived), JSON.stringify(waived)).toBe(false);
  });
});

describe("mirrorSurvived: after the Account is trashed, are the twins still on the contact cards?", () => {
  // Entries and timelines as readTimeline gives them; the evidence kept for the check is id, markers and fp only.
  const e = (id, markers = [], fp = `fp-${id}`) => ({ id, markers, fp });
  const tl = (entries, complete = true) => ({ complete, entries });
  const ACCOUNT = [e("acct-1", [], "f1"), e("acct-2", ["notes:4"])];
  const CONTACT = "2855240904", OTHER = "2855240999";

  it("is ok when every entry still has its twin: by fingerprint, by marker set, or by entry id", () => {
    const kept = new Map([[CONTACT, tl([e("c-1", [], "f1"), e("c-2", ["notes:4"]), e("c-3", ["calls:9"])])]]);
    expect(mirrorSurvived(ACCOUNT, kept)).toEqual({ ok: true, lost: [], unreadable: [] });
    expect(mirrorSurvived([e("shared-9", [], "f9")], new Map([[CONTACT, tl([e("shared-9", [], "changed")])]])).ok).toBe(true);
  });

  it("is ok when a twin is left on at least one of the contact cards, as before the delete", () => {
    const after = new Map([[CONTACT, tl([e("c-1", [], "f1")])], [OTHER, tl([e("o-2", ["notes:4"])])]]);
    expect(mirrorSurvived(ACCOUNT, after)).toEqual({ ok: true, lost: [], unreadable: [] });
  });

  it("is not ok, and names what went, when the trash took a contact's copy with it", () => {
    expect(mirrorSurvived(ACCOUNT, new Map([[CONTACT, tl([e("c-1", [], "f1")])]]))).toEqual({ ok: false, lost: ["acct-2"], unreadable: [] });
    expect(mirrorSurvived(ACCOUNT, new Map([[CONTACT, tl([])]]))).toEqual({ ok: false, lost: ["acct-1", "acct-2"], unreadable: [] });
    // A twin that is still there but no longer matches -- a marker gone, or marked where it was not -- is lost too.
    expect(mirrorSurvived(ACCOUNT, new Map([[CONTACT, tl([e("c-1", ["notes:7"], "f1"), e("c-2", [], "fp-acct-2")])]])).lost).toEqual(["acct-1", "acct-2"]);
  });

  it("is not ok when a contact timeline cannot be read whole after the delete, even if another holds every twin", () => {
    const holds = tl([e("c-1", [], "f1"), e("c-2", ["notes:4"])]);
    expect(mirrorSurvived(ACCOUNT, new Map([[CONTACT, holds], [OTHER, tl([], false)]]))).toEqual({ ok: false, lost: [], unreadable: [OTHER] });
    for (const bad of [null, undefined, {}, { complete: true }, { complete: "true", entries: [] }, tl([e("c-1", [], "f1"), e("c-2", ["notes:4"])], false)])
      expect(mirrorSurvived(ACCOUNT, new Map([[CONTACT, bad]])), JSON.stringify(bad)).toMatchObject({ ok: false, unreadable: [CONTACT] });
  });

  it("is not ok without the evidence behind the waiver: no entries, or no contact cards", () => {
    expect(mirrorSurvived([], new Map([[CONTACT, tl([e("c-1", [], "f1")])]]))).toEqual({ ok: false, lost: [], unreadable: [] });
    for (const after of [new Map(), [], undefined, null, {}, "2855240904"])
      expect(mirrorSurvived(ACCOUNT, after), JSON.stringify(after)).toEqual({ ok: false, lost: ["acct-1", "acct-2"], unreadable: [] });
    expect(mirrorSurvived(undefined, new Map([[CONTACT, tl([])]])).ok).toBe(false);
  });

  it("takes [id, timeline] pairs as well as a Map, and ignores what is not a pair", () => {
    const holds = tl([e("c-1", [], "f1"), e("c-2", ["notes:4"])]);
    expect(mirrorSurvived(ACCOUNT, [[CONTACT, holds]])).toEqual({ ok: true, lost: [], unreadable: [] });
    expect(mirrorSurvived(ACCOUNT, [[CONTACT, holds], "junk", [OTHER]]).ok).toBe(true);
    expect(mirrorSurvived(ACCOUNT, [[CONTACT, holds], [OTHER, tl([], false)]]).unreadable).toEqual([OTHER]);
  });

  it("THE REVIEW CASE, end to end: the waiver lets Zkqcip go on twins the trash then takes -- the check catches it", () => {
    // Zkqcip 2855240915 (C): two of its four entries are a person's; both are mirrored on contact 2855240904.
    const before = new Map([[CONTACT, tl([e("c-1", [], "f1"), e("c-2", ["notes:4"]), e("c-7", ["emails:3"])])]]);
    const facts = { personEntries: ACCOUNT.length, personEntriesMirrored: personEntriesMirrored(ACCOUNT, [...before.values()]) };
    const { remaining, waived } = releaseWaiver("C", ["timeline-entry-not-ours:2", "orphaned-contact-hubspot-activity:2855240904"], facts);
    expect(remaining).toEqual([]);
    expect(waivesTimeline(waived)).toBe(true);                // so the delete is checked afterwards
    expect(mirrorSurvived(ACCOUNT, before).ok).toBe(true);     // nothing changed: the check passes
    // If monday's trash takes the linked copies with the Account, the contact keeps only its own entry.
    const after = new Map([[CONTACT, tl([e("c-7", ["emails:3"])])]]);
    expect(mirrorSurvived(ACCOUNT, after)).toEqual({ ok: false, lost: ["acct-1", "acct-2"], unreadable: [] });
  });
});

describe("wired into cleanup-extra-cards.mjs (structural: the run itself needs live APIs)", () => {
  const code = readScript("cleanup-extra-cards.mjs");
  const at = s => { const i = code.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
  const count = s => code.split(s).length - 1;

  it("takes --release as a valued option, and only with accounts-idless in --groups (exit 2)", () => {
    expect(code).toMatch(/const VALUED = new Set\(\[[^\]]*"--release"[^\]]*\]\)/);
    expect(code).toContain('if (RELEASE_FILE && !GROUPS.includes("accounts-idless")) {');
    expect(code).toMatch(/add accounts-idless to --groups"\); process\.exit\(2\);/);
    expect(code).toContain('from "./lib/cleanup-release.mjs";');
  });

  it("validates the whole file before the pre-flight, the lock and the first monday read", () => {
    const parsed = at("RELEASE = parseRelease(bytes.toString(\"utf8\"), { planIds: IDLESS_ALL, reconIdless: REC.idless.companies,");
    expect(parsed).toBeLessThan(at("await requireNewBuild(WORKER);"));
    expect(parsed).toBeLessThan(at('openSync(LOCK, "wx")'));
    expect(parsed).toBeLessThan(at('await monday("query { me { id } }")'));
    expect(code).toContain("} catch (e) { console.error(`refusing to run: --release ${RELEASE_FILE}: ${e.message}`); process.exit(1); }");
    expect(at("const REC = (() => {")).toBeLessThan(parsed);
  });

  it("applies the release before the protected-candidate guard, the reconciliation check and DELETABLE", () => {
    const applied = at("next = releasePlan(ai, RELEASE);");
    expect(applied).toBeLessThan(at("is a candidate AND protected"));
    expect(at("is a candidate AND protected")).toBeLessThan(at("is not on the reconciliation's list"));
    expect(at("is not on the reconciliation's list")).toBeLessThan(at("const DELETABLE = new Set("));
    // DELETABLE gains the released held cards and nothing else, or the run is refused.
    expect(at("const SAFE_BEFORE_RELEASE = new Set(")).toBeLessThan(applied);
    expect(code).toContain("const added = [...DELETABLE].filter(id => !SAFE_BEFORE_RELEASE.has(id));");
    expect(code).toContain("if (added.length !== RELEASED_HELD.size || added.some(id => !RELEASED_HELD.has(id)) || missing.length) {");
  });

  it("lifts only the review protection, and keeps every protection reason, not just the last", () => {
    expect(code).toContain('protect(item.id, "review")');
    expect(count("PROTECTED.set(")).toBe(1);
    expect(code).toContain("const protect = (id, why) => { PROTECTED.set(id, why);");
    expect(code).toContain("const other = [...(PROTECTED_WHY.get(id) ?? [])].filter(w => w !== LIFTABLE_PROTECTION);");
    expect(code).toContain("protectedWhy: PROTECTED_WHY");
  });

  it("waives in ONE function, on both reads: every id-less Account read goes through CHECK", () => {
    expect(count("releaseWaiver(")).toBe(1);
    expect(code).toContain("const { remaining, waived } = releaseWaiver(it.release, vd.reasons, vd.facts);");
    expect(code).toContain('"accounts-idless": async items => waiveReleased(items, await checkIdlessAccounts(items)),');
    // checkIdlessAccounts is defined once and called only from that wrapper: no read can go around the waiver.
    expect(count("checkIdlessAccounts(")).toBe(2);
    expect(code).toContain("const first = await CHECK[g](chunk);");
    expect(code).toContain("const second = (await CHECK[g]([it])).get(it.id);");
  });

  it("computes the mirror facts for released cards only, from the contacts linked now", () => {
    expect(code).toContain("if (it.release && notOurs.length) notOursOf.set(it.id, { complete: t.complete, entries: notOurs });");
    expect(code).toContain("if (!it.release || !mine) continue;");
    expect(code).toContain('const holders = (vd.facts.contacts ?? []).filter(cid => !MERGED_STALE.has(cid) && contacts.get(cid)?.state === "active");');
    expect(code).toContain("vd.facts.personEntriesMirrored = mine.complete === true && personEntriesMirrored(mine.entries, timelines);");
  });

  it("records the release: the file's sha256, the parsed list, and each released row's bucket and waivers", () => {
    expect(code).toContain("report.planFiles.release = { sha256, path: RELEASE_FILE, decidedAt: RELEASE.decidedAt };");
    expect(code).toContain("report.release = { file: RELEASE_FILE, sha256, ...RELEASE,");
    expect(code).toContain('record(it, "held-by-recheck", { reasons: vd.reasons, ...released(it, vd) });');
    expect(code).toContain("...released(it, second, vd) });");
  });

  // The review of 2026-10-05: a timeline waiver deletes the Account's copy of a person's entries on the assumption
  // that the contact's copy survives the trash. monday links the copies of one activity, so that is checked.
  it("checks every delete a timeline waiver allowed, after the delete, from the second read's evidence", () => {
    expect(code).toContain("const mirrorBearing = !!it.release && waivesTimeline(second.waived);");
    const deleted = at("const ok = await deleteCard(it);");
    const checked = at("if (ok && mirrorBearing) post = (mirror = await afterReleasedDelete(it, second)).ok;");
    expect(deleted).toBeLessThan(checked);
    expect(checked).toBeLessThan(at('record(it, ok ? "deleted" : "delete-failed", { postChecks: checked ? (post ? "ok" : "failed") : "n/a",'));
    expect(code).toContain("const checked = idBearing || mirrorBearing;");
    expect(code).toContain("...(mirror ? { mirrorAfterDelete: mirror } : {}) });");
    // One call: the delete path is the only way to it.
    expect(count("afterReleasedDelete(")).toBe(2);
  });

  it("waits --settle, re-reads those contact cards UNCACHED, and HALTS unless every twin is still there", () => {
    const body = code.slice(at("async function afterReleasedDelete(it, vd) {"), at("async function createCard(it) {"));
    const order = ["const ev = vd?.mirrorEvidence;", "await sleep(SETTLE_MS);", "for (const cid of ev.contacts) after.set(cid, await readTimeline(cid));",
      "v = mirrorSurvived(ev.entries, after);", 'journal({ phase: "mirror-check",', "if (!v.ok) {", "halt(`after deleting released card ${it.id} (${it.release}): ${why}."];
    order.reduce((prev, s) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(prev); return i; }, -1);
    expect(body).not.toMatch(/cache\s*:/);                      // a cached timeline is the one read before the delete
    // No evidence is a halt, not a pass; a read that throws is a halt too (an auth failure still aborts the run).
    expect(body).toMatch(/if \(!ev\?\.entries\?\.length \|\| !ev\?\.contacts\?\.length\) \{\s*halt\(/);
    expect(body).toContain("if (e.abort) throw e;");
    expect(body).toContain("v = { ok: false, lost: [], unreadable: ev.contacts.map(String) };");
  });

  it("keeps the evidence on the read's verdict, ids, markers and fingerprints only, and off the report", () => {
    expect(code).toContain("vd.mirrorEvidence = { entries: mine.entries.map(({ id, markers, fp }) => ({ id, markers, fp })), contacts: holders };");
    // Set once in checkIdlessAccounts; read only by the check and the canary note. The report rows take facts, never it.
    expect(count("mirrorEvidence")).toBe(3);
    const row = code.slice(at("const released = (it, vd, first = null) =>"), at("const releasedTag = "));
    expect(row).not.toContain("mirrorEvidence");
  });

  it("says, on a --release canary, whether it tried the timeline waiver at all", () => {
    expect(code).toContain("if (RELEASE) console.log(canaryReleaseNote(it, vd));");
    expect(code).toContain("if (RELEASE) console.log(canaryReleaseNote(it, second, last));");
    expect(count("canaryReleaseNote(")).toBe(3);
    const note = code.slice(at("function canaryReleaseNote(it, vd, row = null) {"), at("const DELETE_ITEM ="));
    expect(note).toContain("if (!waivesTimeline(vd?.waived))");
    expect(note).toContain("return row?.mirrorAfterDelete?.ok");
  });

  it("documents the check and the canary of ONE card that waives a timeline entry, first", () => {
    const head = readScriptSource("cleanup-extra-cards.mjs").split("*/")[0];
    expect(head).toContain("AFTER A DELETE THAT WAIVED timeline-entry-not-ours.");
    expect(head).toContain("THE FIRST --apply OF A RELEASE IS A CANARY OF ONE CARD THAT WAIVES A TIMELINE ENTRY");
    expect(head).toContain("--release <one-card file> --canary --apply   # first");
    expect(head).toMatch(/--settle S {6}seconds to wait for the restore after an ID-bearing delete, and before the contact\n \* +re-check after a released delete/);
  });
});
