import { describe, it, expect } from "vitest";
import { readScript } from "../scripts/read-source.mjs";
import {
  applyRefusal, unknownFlags, destinationVerdict, destinationsOf, markerCards, cardsByRecord, keepAllowed,
  emptyDestinations, markerOf, HOLD_REASONS, SINGLE_DESTINATION, NOT_RESTORABLE,
} from "../scripts/dedupe-timeline.mjs";

/**
 * THE SINGLE-DESTINATION RULE of dedupe-timeline.mjs (2026-09-30).
 *
 * monday links the copies of one activity across cards: delete_timeline_item on one copy can remove copies on OTHER
 * cards. A marker deleted on one card lost nothing (0 of 16,601 pairs); deleted on 2-5+ cards it lost 3.6-22%, on
 * cards no delete was sent to. So a group may only go on the single current HubSpot destination card of its
 * activity, and never where an earlier run or the census saw the marker on another card.
 *
 * .mjs, not .ts: the script has no .d.mts, and the tsconfig only type-checks test/**\/*.ts.
 */

const CONTACT = "2856209156", COMPANY = "2855585307", DEAL = "2856000001";
const EMAIL = "[hubspot:emails:81042366018]";
/** dest from plain arrays. */
const dest = ({ contacts = [], companies = [], deals = [] } = {}) =>
  ({ contacts: new Set(contacts), companies: new Set(companies), deals: new Set(deals) });
/** cardsOf from { "kind:record": [cards] }; a missing key = not known. */
const lookup = map => (kind, rec) => map[`${kind}:${rec}`];
const verdict = over => destinationVerdict({
  kind: "contacts", card: CONTACT, marker: EMAIL,
  dest: dest({ contacts: ["101"] }), cardsOf: lookup({ "contacts:101": [CONTACT] }), elsewhere: new Map(),
  ...over,
});

describe("--apply needs --single-destination (a pasted old command cannot run the old rule)", () => {
  it("refuses --apply without the flag, the canary and a retry included, and says what to add", () => {
    for (const argv of [["--apply"], ["--apply", "--canary"], ["--types", "notes", "--apply", "--canary"],
      ["--retry", "r.json", "--apply"], ["--apply", "--include-cleaned", "--from", "contacts:1"]]) {
      const why = applyRefusal(argv);
      expect(why, argv.join(" ")).toMatch(/^refusing --apply without --single-destination/);
      expect(why).toContain(`add ${SINGLE_DESTINATION}`);
    }
  });

  it("lets --apply run with the flag, and every dry run without it", () => {
    expect(applyRefusal(["--apply", SINGLE_DESTINATION])).toBeNull();
    expect(applyRefusal([SINGLE_DESTINATION, "--canary", "--apply"])).toBeNull();
    for (const argv of [[], ["--canary"], ["--boards", "contacts,deals", "--limit-cards", "200"], ["--verify", "x.json"]])
      expect(applyRefusal(argv), argv.join(" ")).toBeNull();
  });

  it("refuses an option it does not know, so --limit (not --limit-cards) cannot run over every card", () => {
    expect(unknownFlags(["--boards", "contacts,deals", "--from", "contacts:2856254854", "--limit", "200"])).toEqual(["--limit"]);
    expect(unknownFlags(["--single-destinaton", "--apply"])).toEqual(["--single-destinaton"]);
    expect(unknownFlags(["--types=notes"])).toEqual(["--types=notes"]);
    expect(unknownFlags(["--apply", SINGLE_DESTINATION, "--canary", "--types", "notes", "--boards", "contacts",
      "--limit-cards", "5", "--start", "0", "--from", "contacts:1", "--concurrency", "2", "--max-lost", "0",
      "--late-check", "45", "--final-check", "300", "--retry", "r.json", "--verify", "v.json", "--include-cleaned",
      "--monday-rps", "2", "--hubspot-rps", "4"])).toEqual([]);
  });
});

describe("destinationVerdict: a group goes only on its activity's single current destination card", () => {
  it("allows the one case: one destination record, one card, this card, seen nowhere else", () => {
    expect(verdict()).toMatchObject({ allow: true, reason: "allow", records: 1, isDestination: true });
    // The same on a deal or a company card that is the single destination.
    expect(verdict({ kind: "deals", card: DEAL, dest: dest({ deals: ["7"] }), cardsOf: lookup({ "deals:7": [DEAL] }) }).allow).toBe(true);
    expect(verdict({ kind: "companies", card: COMPANY, dest: dest({ companies: ["9"] }), cardsOf: lookup({ "companies:9": [COMPANY] }) }).allow).toBe(true);
  });

  it("holds a contact + company email on BOTH cards: the pattern that lost linked copies", () => {
    const d = dest({ contacts: ["101"], companies: ["202"] });
    const cardsOf = lookup({ "contacts:101": [CONTACT], "companies:202": [COMPANY] });
    expect(verdict({ dest: d, cardsOf })).toMatchObject({ allow: false, reason: "multi-destination", records: 2, isDestination: true });
    expect(verdict({ kind: "companies", card: COMPANY, dest: d, cardsOf })).toMatchObject({ allow: false, reason: "multi-destination" });
    // Contact + deal, deal + company, three boards: all held.
    expect(verdict({ dest: dest({ contacts: ["101"], deals: ["7"] }), cardsOf }).reason).toBe("multi-destination");
    expect(verdict({ dest: dest({ contacts: ["101"], companies: ["202"], deals: ["7"] }), cardsOf }).reason).toBe("multi-destination");
  });

  it("holds two contacts, even when the other contact's card is unknown or missing (an idless card is invisible)", () => {
    expect(verdict({ dest: dest({ contacts: ["101", "102"] }), cardsOf: lookup({ "contacts:101": [CONTACT] }) }).reason).toBe("multi-destination");
    expect(verdict({ dest: dest({ contacts: ["101", "102"] }), cardsOf: lookup({ "contacts:101": [CONTACT], "contacts:102": [] }) }).reason)
      .toBe("multi-destination");
    // A company record with no card found still counts as a second destination.
    expect(verdict({ dest: dest({ contacts: ["101"], companies: ["202"] }), cardsOf: lookup({ "contacts:101": [CONTACT] }) }).reason)
      .toBe("multi-destination");
  });

  it("never deletes on a card that is not a current destination (a stale copy, e.g. meeting 344652484332)", () => {
    const marker = "[hubspot:meetings:344652484332]";
    // The meeting now goes to one company only; the group sits on another company's card.
    const d = dest({ companies: ["202"] });
    const cardsOf = lookup({ "companies:202": ["2855609347"] });
    expect(verdict({ kind: "companies", card: COMPANY, marker, dest: d, cardsOf }))
      .toMatchObject({ allow: false, reason: "not-a-destination", isDestination: false });
    // ...or on a contact card, while the activity has no contact at all.
    expect(verdict({ marker, dest: d, cardsOf }).reason).toBe("not-a-destination");
    // An activity with no destinations left: every copy is stale.
    expect(verdict({ marker, dest: emptyDestinations(), cardsOf }).reason).toBe("not-a-destination");
    // Stale wins over multi-destination in the report, so stale copies can be counted apart.
    expect(verdict({ dest: dest({ contacts: ["103"], companies: ["202"] }), cardsOf: lookup({ "contacts:103": ["2856209157"] }) }).reason)
      .toBe("not-a-destination");
  });

  it("the board matters: a record's card on another board never makes this card a destination", () => {
    expect(verdict({ kind: "deals", card: CONTACT, dest: dest({ contacts: ["101"] }), cardsOf: lookup({ "contacts:101": [CONTACT] }) }).reason)
      .toBe("not-a-destination");
  });

  it("holds when the destinations or the cards cannot be known", () => {
    expect(verdict({ dest: undefined })).toMatchObject({ allow: false, reason: "unknown-activity" });
    expect(verdict({ dest: null })).toMatchObject({ allow: false, reason: "unknown-activity" });
    expect(verdict({ marker: "[hubspot:emails]" }).reason).toBe("unknown-activity");
    expect(verdict({ marker: undefined }).reason).toBe("unknown-activity");
    expect(verdict({ cardsOf: lookup({}) })).toMatchObject({ allow: false, reason: "destination-unresolved", isDestination: null });
  });

  it("holds a destination with two cards (a duplicate card): deleting on one could reach the other", () => {
    expect(verdict({ cardsOf: lookup({ "contacts:101": [CONTACT, "2856209999"] }) }))
      .toMatchObject({ allow: false, reason: "duplicate-destination-cards", destinationCards: [CONTACT, "2856209999"] });
    // The same card listed twice is still one card.
    expect(verdict({ cardsOf: lookup({ "contacts:101": [CONTACT, CONTACT] }) }).allow).toBe(true);
  });

  it("holds a marker an earlier run or the census saw on another card; the same card alone is fine", () => {
    const elsewhere = new Map([[EMAIL, new Set([CONTACT, "2855632725", "2855786323"])]]);
    expect(verdict({ elsewhere })).toMatchObject({ allow: false, reason: "seen-elsewhere", otherCards: ["2855632725", "2855786323"], otherCardCount: 2 });
    expect(verdict({ elsewhere: new Map([[EMAIL, new Set([CONTACT])]]) }).allow).toBe(true);
    expect(verdict({ elsewhere: new Map([["[hubspot:emails:1]", new Set(["x"])]]) }).allow).toBe(true);
    expect(verdict({ elsewhere: undefined }).allow).toBe(true);
  });

  it("never allows a marketing entry, whatever its destinations", () => {
    for (const o of [...NOT_RESTORABLE, "marketing_email_future_kind"])
      expect(verdict({ marker: `[hubspot:${o}:aB-9_1759040820000]` })).toMatchObject({ allow: false, reason: "marketing" });
  });

  it("returns only the reasons HOLD_REASONS lists (the report's counters are keyed by them)", () => {
    const seen = new Set([
      verdict({ marker: "[hubspot:marketing_emails:x]" }), verdict({ dest: undefined }),
      verdict({ dest: emptyDestinations() }), verdict({ dest: dest({ contacts: ["101", "102"] }) }),
      verdict({ cardsOf: lookup({}) }), verdict({ cardsOf: lookup({ "contacts:101": [CONTACT, "2"] }) }),
      verdict({ elsewhere: new Map([[EMAIL, new Set(["2"])]]) }),
    ].map(v => v.reason));
    expect([...seen].sort()).toEqual([...HOLD_REASONS].sort());
  });
});

describe("the inputs the rule is fed", () => {
  it("destinationsOf keeps each activity's own records, once each, per board", () => {
    const a = { id: "5", associations: {
      contacts: { results: [{ id: "101", type: "email_to_contact" }, { id: "101", type: "email_to_contact_unlabeled" }, { id: 102 }] },
      companies: { results: [{ id: "202" }] },
    } };
    const d = destinationsOf(a);
    expect([...d.contacts]).toEqual(["101", "102"]);
    expect([...d.companies]).toEqual(["202"]);
    expect([...d.deals]).toEqual([]);
    expect(DESTINATION_KINDS_OF(destinationsOf({ id: "6" }))).toEqual({ contacts: 0, companies: 0, deals: 0 });
    expect(markerOf("emails", "81042366018")).toBe(EMAIL);
  });

  it("markerCards reads dedupe reports (groups, divergent, held) and census / hand-off rows", () => {
    const report = { cards: [
      { kind: "companies", card: COMPANY, groups: [{ marker: EMAIL }], divergent: [{ marker: "[hubspot:notes:1]" }] },
      { kind: "contacts", card: 2856209157, heldBySingleDestination: [{ marker: EMAIL }] },
      { kind: "contacts", card: null, groups: [{ marker: EMAIL }] },
    ] };
    const census = [{ card: CONTACT, kind: "contacts", marker: EMAIL, state: "LOST" }, { card: "", marker: EMAIL }];
    const m = markerCards([report, census, { rows: [{ card: DEAL, marker: "[hubspot:tasks:3]" }] }, null, {}]);
    expect([...m.get(EMAIL)].sort()).toEqual([COMPANY, CONTACT, "2856209157"].sort());
    expect([...m.get("[hubspot:notes:1]")]).toEqual([COMPANY]);
    expect([...m.get("[hubspot:tasks:3]")]).toEqual([DEAL]);
    // Accumulates into a given map.
    const into = new Map([[EMAIL, new Set(["x"])]]);
    markerCards([census], into);
    expect([...into.get(EMAIL)].sort()).toEqual([CONTACT, "x"].sort());
  });

  it("cardsByRecord ties each card to the record whose ID it carries, and gives up on anything it cannot trust", () => {
    const page = { cursor: null, items: [
      { id: "1", column_values: [{ text: "101" }] }, { id: "2", column_values: [{ text: " 101 " }] },
      { id: "1", column_values: [{ text: "101" }] }, { id: "3", column_values: [{ text: "102" }] },
    ] };
    const by = cardsByRecord(page, ["101", "102", 103]);
    expect(Object.fromEntries(by)).toEqual({ 101: ["1", "2"], 102: ["3"], 103: [] });
    expect(cardsByRecord({ ...page, cursor: "more" }, ["101", "102"])).toBeNull();
    expect(cardsByRecord({ items: [{ id: "9", column_values: [{ text: "999" }] }] }, ["101"])).toBeNull();
    expect(cardsByRecord({ items: [{ id: "9", column_values: [] }] }, ["101"])).toBeNull();
    expect(cardsByRecord(null, ["101"])).toBeNull();
  });

  it("keepAllowed drops a held marker from the groups AND the classes the deletes are built from", () => {
    const p = { groups: [{ marker: "a" }, { marker: "b" }], classes: new Map([["a", []], ["b", []], ["c", []]]) };
    keepAllowed(p, new Set(["b"]));
    expect(p.groups).toEqual([{ marker: "b" }]);
    expect([...p.classes.keys()]).toEqual(["b"]);
  });
});

describe("the rule is wired in where the deletes are decided (structural: the run itself needs live APIs)", () => {
  const code = readScript("dedupe-timeline.mjs");
  const at = s => { const i = code.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };

  it("refuses before reading tokens, taking the lock or the pre-flight", () => {
    const refuse = at("const refusal = applyRefusal(process.argv.slice(2));");
    expect(refuse).toBeLessThan(at('readFileSync(join(ROOT, ".dev.vars")'));
    expect(refuse).toBeLessThan(at("await requireNewBuild("));
    expect(refuse).toBeLessThan(at('openSync(LOCK, "wx")'));
    expect(at("const unknown = unknownFlags(process.argv.slice(2));")).toBeLessThan(refuse);
  });

  it("step 1 keeps each activity's own destinations, not only the combined record sets", () => {
    // readScript strips comments, so the steps are found by their code.
    const step1 = at("const records = { contacts: new Set(), companies: new Set(), deals: new Set() };");
    const own = at("destinations.set(markerOf(type, a.id), d);");
    expect(own).toBeGreaterThan(step1);
    expect(own).toBeLessThan(at("for (const kind of BOARDS_ON) {"));
    expect(code).toContain("if (by) for (const [id, cs] of by) recordCards.set(`${kind}:${id}`, cs);");
  });

  it("judges the first read before anything is planned, and filters the re-read the same way", () => {
    const check = at("async function checkCard({ kind, card }) {");
    const judged = code.indexOf("const sd = await judge(kind, card, p);", check);
    const del = code.indexOf("const del = p.groups.flatMap(g => [...g.identical, ...g.bodyless]);", check);
    expect(judged).toBeGreaterThan(check);
    expect(judged).toBeLessThan(del);
    expect(del).toBeLessThan(code.indexOf("plan.cards.push(entry);", check));
    expect(code).toContain("if (SINGLE) keepAllowed(p, allowed);");
    const reread = code.indexOf("const p2 = planCard(card, again.rows);", check);
    const filtered = code.indexOf("keepAllowed(p2, sd.allowed);", check);
    expect(filtered).toBeGreaterThan(reread);
    expect(filtered).toBeLessThan(code.indexOf("const still = new Set(p2.groups", check));
  });

  it("reads the earlier applied reports, the censuses and the hand-offs for markers seen elsewhere", () => {
    expect(code).toContain('["applied reports", /timeline-dedupe.*applied.*\\.json$/]');
    expect(code).toContain('["censuses", /-timeline-.*census.*\\.json$/]');
    expect(code).toContain("destinationVerdict({ kind, card, marker: g.marker, dest, elsewhere,");
    expect(code).toContain("cardsOf: (k, r) => recordCards.get(`${k}:${r}`) });");
  });

  it("importing the script runs nothing (main only when invoked)", () => {
    expect(code).toContain("if (process.platform === \"win32\" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) await main();");
  });
});

/** Record counts per board, for a readable assertion. */
function DESTINATION_KINDS_OF(d) {
  return { contacts: d.contacts.size, companies: d.companies.size, deals: d.deals.size };
}
