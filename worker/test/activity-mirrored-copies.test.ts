import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import { readWranglerConfig } from "../scripts/read-wrangler.mjs";
import type { Env } from "../src/types";

/**
 * ACTIVITY_SKIP_MIRRORED_COPIES: monday's own copy of a Contact entry on a linked Account/Deal is found,
 * not written a second time -- and nothing about it can ever cost a MISSING entry.
 *
 * Measured 2026-09-30: monday CRM copies each timeline entry created on a Contact card onto the Accounts
 * and Deals linked to it AT THAT MOMENT (never onto links added later). The Worker also writes every
 * associated Company/Deal, so a linked Account held two copies (email 403677013705: Contact 2855768299,
 * Account 2855639522). The mock monday below behaves the same way: a create on a Contact card is copied,
 * with its own id, onto every card that Contact links at that moment.
 *
 * The first, rejected fix (scratchpad dup-fix.patch) skipped on the LINK alone. These tests port its six
 * cases onto the rule that replaced it -- the Company/Deal card is READ, and only "present" skips -- plus
 * the three late-link cases its adversarial review found, where a link-only skip loses the entry.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));

const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  const stale = new Set<string>();               // keys whose next claim takes over an abandoned reservation
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (stale.has(k)) { stale.delete(k); inflight.add(k); return { status: "proceed", tookOverStale: true }; }
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed", tookOverStale: false };
  };
  return {
    settled, inflight, stale, h2m,
    m2hReservationKey: (t: string) => `act:m2h:${t}`, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string) =>
      claim(h2m(o, i, k, d))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) => {
      settled.set(h2m(o, i, k, d), t); inflight.delete(h2m(o, i, k, d));
    }),
    unresolvedActivityToMonday: vi.fn(),
    claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(),
    unresolvedActivityToHubspot: vi.fn(), claimHubspotAsRepresented: vi.fn(),
    releaseActivity: vi.fn(), lastOwnerCycle: vi.fn(async () => null), rememberOwnerCycle: vi.fn(),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);

const { syncHubspotActivity } = await import("../src/activity-sync");
const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

const REP = "103855693312", REP_EMAIL = "rep@dkmeco.com";
const CUSTOMER = "120972797972", CUSTOMER2 = "120972797999";
const COMPANY = "33268028506", DEAL = "31410001";
const ACT = "403677013705";
const MARKER = `[hubspot:emails:${ACT}]`;

const CARD: Record<string, string> = {
  [REP]: "2855754772", [CUSTOMER]: "2855768299", [CUSTOMER2]: "2855768300",
  [COMPANY]: "2855639522", [DEAL]: "2859614572",
};
const BOARD_OF: Record<string, string> = {
  [REP]: CRM_CONTACTS.boardId, [CUSTOMER]: CRM_CONTACTS.boardId, [CUSTOMER2]: CRM_CONTACTS.boardId,
  [COMPANY]: CRM_ACCOUNTS.boardId, [DEAL]: CRM_DEALS.boardId,
};
const CONTACT_CARDS = new Set([CARD[REP], CARD[CUSTOMER], CARD[CUSTOMER2]]);

// ---- the simulated monday
let assoc: Record<"contacts" | "companies" | "deals", string[]>;
let links: Record<string, string[]>;               // contact card -> linked Account/Deal cards, NOW
let cardExists: Record<string, boolean>;
let timelines: Map<string, { id: string; content: string }[]>;
let created: string[];                             // cards the WORKER wrote (create_timeline_item)
let mondayCopies: boolean;                         // monday copies a contact entry onto its linked cards
let asyncCopies: boolean;                          // ... but only once flushCopies() runs (lands later)
let pending: (() => void)[];
let linkReadFails: boolean;
let unreadable: Map<string, Error>;                // card -> the error its timeline read throws
let endless: Set<string>;                          // cards whose timeline never ends
let seq: number;

const add = (card: string, e: { id: string; content: string }) =>
  timelines.set(card, [...(timelines.get(card) ?? []), e]);
const flushCopies = () => { pending.splice(0).forEach(f => f()); };
const copiesOn = (card: string) => (timelines.get(card) ?? []).filter(e => e.content.includes(MARKER)).length;
const gqlCalls = (frag: string, card?: string) => monday.gql.mock.calls
  .filter(c => String(c[1]).includes(frag) && (card === undefined || String((c[2] as any)?.i) === card));
const logs = () => logSpy.mock.calls.map(c => String(c[0]));
const key = (kind: string, id: string) => reg.h2m("emails", ACT, kind, id);

const base = { ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z" };
const ON = { ...base, ACTIVITY_SKIP_MIRRORED_COPIES: "true" } as unknown as Env;
const OFF = base as unknown as Env;

function reset() {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear(); reg.stale.clear();
  assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [DEAL] };
  links = { [CARD[CUSTOMER]]: [CARD[COMPANY], CARD[DEAL]] };
  cardExists = Object.fromEntries(Object.keys(CARD).map(k => [k, true]));
  timelines = new Map(); created = []; pending = [];
  mondayCopies = true; asyncCopies = false; linkReadFails = false;
  unreadable = new Map(); endless = new Set(); seq = 0;

  monday.findItemByColumn.mockImplementation(async (_e: Env, board: string, _c: string, value: string) =>
    CARD[value] && BOARD_OF[value] === board && cardExists[value] ? [{ id: CARD[value] }] : []);
  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) {
      const card = String(v.i), content = String(v.c);
      created.push(card);
      const id = `tl${++seq}`;
      add(card, { id, content });
      if (mondayCopies && CONTACT_CARDS.has(card)) {
        const to = [...(links[card] ?? [])];                 // the links that exist AT THIS MOMENT
        const copy = () => to.forEach(t => add(t, { id: `mc${++seq}`, content }));
        if (asyncCopies) pending.push(copy); else copy();
      }
      return { create_timeline_item: { id } };
    }
    if (q.includes("linked_item_ids")) {
      if (linkReadFails) throw new Error("monday 500: boom");
      return { items: (v.i as string[]).map(id => ({ id, column_values: [{ linked_item_ids: links[id] ?? [] }] })) };
    }
    if (q.includes("timeline_items_page")) {
      const card = String(v.i);
      if (unreadable.has(card)) throw unreadable.get(card);
      if (endless.has(card)) {
        const n = v.c ? Number(String(v.c).slice(1)) + 1 : 1;
        return { timeline: { timeline_items_page: { cursor: `p${n}`, timeline_items: [{ id: `o${n}`, content: "other" }] } } };
      }
      return { timeline: { timeline_items_page: { cursor: null,
        timeline_items: (timelines.get(card) ?? []).map(e => ({ id: e.id, content: e.content })) } } };
    }
    return { items: [{ column_values: [{ text: "" }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: REP_EMAIL }] };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({
        id: i.id, properties: { email: i.id === REP ? REP_EMAIL : `c${i.id}@example.com` } })) };
    if (path === "/crm/v3/objects/companies/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { domain: "customer.example" } })) };
    if (path.startsWith("/crm/v3/objects/emails/")) return {
      properties: { hs_timestamp: "2026-09-30T09:34:20Z", hs_email_subject: "Quotation",
        hs_email_direction: "EMAIL", hs_email_from_email: REP_EMAIL },
    };
    for (const k of ["contacts", "companies", "deals"] as const)
      if (path.includes(`/associations/${k}`)) return { results: assoc[k].map(id => ({ toObjectId: id })) };
    return { properties: {} };
  });
}
beforeEach(reset);

// ============================================================ the six cases of the rejected patch

describe("flag on: monday's copy on a linked Account/Deal is found, not written again", () => {
  it("writes the Contact once; the linked Company and Deal settle on monday's copy", async () => {
    expect(await syncHubspotActivity(ON, "emails", ACT)).toBe("created");
    expect(created).toEqual([CARD[CUSTOMER]]);                      // flag off: [contact, company, deal]
    for (const c of [CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]]) expect(copiesOn(c)).toBe(1);

    // settled on the COPY's own timeline id, as a create settles on its own -- not a synthetic label
    const copyId = (card: string) => timelines.get(card)!.find(e => e.content.includes(MARKER))!.id;
    expect(reg.settled.get(key("company", COMPANY))).toBe(copyId(CARD[COMPANY]));
    expect(reg.settled.get(key("deal", DEAL))).toBe(copyId(CARD[DEAL]));
    expect(copyId(CARD[COMPANY])).toMatch(/^mc/);

    // items(ids) answers 25 by default; an activity can have up to 50 contact cards
    expect(String(gqlCalls("linked_item_ids")[0][1])).toMatch(/items\(ids: \$i, limit: 100\)/);
    expect(gqlCalls("linked_item_ids")).toHaveLength(1);           // one link read per pass, not per card
    expect(logs().filter(l => l.includes("action=mirrored-present"))).toHaveLength(2);

    // a later pass answers "have" everywhere: no link read, no card read, no write
    monday.gql.mockClear();
    expect(await syncHubspotActivity(ON, "emails", ACT)).toBe("skipped");
    expect(created).toEqual([CARD[CUSTOMER]]);
    expect(gqlCalls("linked_item_ids")).toHaveLength(0);
    expect(gqlCalls("timeline_items_page")).toHaveLength(0);
  });

  /** The shape of every duplicate seen on 2026-09-30: contacts at delivery, the company 30 s later. */
  it("the reconcile that first sees a late Company association finds monday's copy and writes nothing", async () => {
    assoc = { contacts: [CUSTOMER], companies: [], deals: [] };
    await syncHubspotActivity(ON, "emails", ACT);                  // deliver
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    await syncHubspotActivity(ON, "emails", ACT);                  // reconcile at +30 s
    await syncHubspotActivity(ON, "emails", ACT);                  // reconcile at +5 min
    expect(created).toEqual([CARD[CUSTOMER]]);
    expect(copiesOn(CARD[COMPANY])).toBe(1);
  });

  it("still writes a Company whose card is NOT linked to the Contact card, without reading it", async () => {
    links = {};
    await syncHubspotActivity(ON, "emails", ACT);
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]].sort());
    expect(gqlCalls("timeline_items_page")).toHaveLength(0);       // no extra cost for an unlinked card
  });

  /** Staff are not written, so nothing is copied from their card: the Company must get its own entry. */
  it("still writes a Company linked only to a staff Contact that was not written", async () => {
    assoc = { contacts: [REP], companies: [COMPANY], deals: [] };
    links = { [CARD[REP]]: [CARD[COMPANY]] };
    await syncHubspotActivity(ON, "emails", ACT);
    expect(created).toEqual([CARD[COMPANY]]);
    expect(gqlCalls("linked_item_ids")).toHaveLength(0);           // no holding contact: nothing to read
  });

  /** Fail open: an unreadable link costs at most the old duplicate, never a missing Account entry. */
  it("writes every destination when the links cannot be read", async () => {
    linkReadFails = true;
    await syncHubspotActivity(ON, "emails", ACT);
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]].sort());
    expect(logs().filter(l => l.includes("action=mirror-check-unknown"))).toHaveLength(2);
  });

  it.each([["absent", undefined], ['"false"', "false"], ['"TRUE" (not the literal "true")', "TRUE"]])(
    "flag %s: every destination is written and nothing new is read", async (_n, flag) => {
      const env = { ...base, ...(flag === undefined ? {} : { ACTIVITY_SKIP_MIRRORED_COPIES: flag }) } as unknown as Env;
      await syncHubspotActivity(env, "emails", ACT);
      expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]].sort());
      expect(copiesOn(CARD[COMPANY])).toBe(2);                     // today's duplicate, unchanged
      expect(gqlCalls("linked_item_ids")).toHaveLength(0);
      expect(gqlCalls("timeline_items_page")).toHaveLength(0);
    });
});

// ============================================================ late links (the adversarial review)

describe("a link that appears AFTER the Contact entry was written", () => {
  /** Live 2026-09-30: Contact 2869369651 was linked to Account 2855651068 at 08:00Z, after four emails
   *  had been written to it; the Account holds exactly one copy of each -- its own direct write. */
  it("reconcile after a late company association + late link still writes the Company", async () => {
    links = {};
    assoc = { contacts: [CUSTOMER], companies: [], deals: [] };
    await syncHubspotActivity(ON, "emails", ACT);                   // deliver: contact only, no link yet
    links = { [CARD[CUSTOMER]]: [CARD[COMPANY]] };                  // forward sync links the cards
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    await syncHubspotActivity(ON, "emails", ACT);                   // reconcile at +30 s
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());
    expect(copiesOn(CARD[COMPANY])).toBe(1);
    expect(logs().some(l => l.includes("action=mirror-check-absent") && l.includes(`item=${CARD[COMPANY]}`))).toBe(true);
  });

  it("an Account card that did not exist at delivery is still written on the retry", async () => {
    links = {};
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    cardExists[COMPANY] = false;
    vi.useFakeTimers();
    const p = syncHubspotActivity(ON, "emails", ACT);              // contact written, company has no card
    await vi.advanceTimersByTimeAsync(30_000);
    const out1 = await p;
    vi.useRealTimers();
    cardExists[COMPANY] = true;                                     // card created by the object sync ...
    links = { [CARD[CUSTOMER]]: [CARD[COMPANY]] };                  // ... and linked
    await syncHubspotActivity(ON, "emails", ACT);                   // ActivityRetry, +1..+60 min
    expect(out1).toBe("unresolved");
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());
    expect(copiesOn(CARD[COMPANY])).toBe(1);
  });

  /** Task sweep / /resync-activity: verifyExisting reads the Company card, finds it ABSENT -- and must then write it. */
  it("verifyExisting: a Company card verified ABSENT is written even though it is linked to the Contact", async () => {
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    links = { [CARD[CUSTOMER]]: [CARD[COMPANY]] };
    add(CARD[CUSTOMER], { id: "hist1", content: `x\n${MARKER}` });  // the historical import put it there
    await syncHubspotActivity(ON, "emails", ACT, { verifyExisting: true });
    expect(created).toEqual([CARD[COMPANY]]);                       // contact present; company verified absent
    expect(gqlCalls("timeline_items_page", CARD[COMPANY])).toHaveLength(1);   // verified once, not re-asked
    expect(reg.settled.get(key("company", COMPANY))).toMatch(/^tl/);
  });
});

// ============================================================ "unknown" fails OPEN here

describe("a Company/Deal card that cannot be read is written", () => {
  const rateLimited = Object.assign(new Error("monday 429: rate-limited after 1 waits"), { name: "MondayRateLimitedError" });
  it.each([["a failed read", new Error("monday 500: timeline")], ["a rate-limited read", rateLimited]])(
    "%s is unknown, and unknown writes", async (_n, err) => {
      assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
      unreadable.set(CARD[COMPANY], err);
      expect(await syncHubspotActivity(ON, "emails", ACT)).toBe("created");
      expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());   // worst case: the old duplicate
      expect(reg.settled.get(key("company", COMPANY))).toMatch(/^tl/);
      expect(logs().some(l => l.includes("action=mirror-check-unknown") && l.includes(`item=${CARD[COMPANY]}`))).toBe(true);
    });

  it("the read is bounded: a timeline longer than the budget is unknown after 30 pages, and written", async () => {
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    endless.add(CARD[COMPANY]);
    await syncHubspotActivity(ON, "emails", ACT);
    expect(gqlCalls("timeline_items_page", CARD[COMPANY])).toHaveLength(30);
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());
  });

  /** alreadyOnCard's own callers are unchanged: the stale takeover still FAILS CLOSED on "unknown". */
  it("a stale takeover on the Company still fails closed on its own unknown read", async () => {
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    reg.stale.add(key("company", COMPANY));
    unreadable.set(CARD[COMPANY], new Error("monday 500: timeline"));
    expect(await syncHubspotActivity(ON, "emails", ACT)).toBe("unresolved");
    expect(created).toEqual([CARD[CUSTOMER]]);
  });

  it("a stale takeover whose own read says absent writes without asking the card twice", async () => {
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    links = { [CARD[CUSTOMER]]: [CARD[COMPANY]] };
    mondayCopies = false;
    reg.stale.add(key("company", COMPANY));
    await syncHubspotActivity(ON, "emails", ACT);
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());
    expect(gqlCalls("timeline_items_page", CARD[COMPANY])).toHaveLength(1);
  });
});

// ============================================================ every holding Contact, and the deferral

describe("every Contact that links the card counts, and a fresh write is checked after it lands", () => {
  it("only a Contact that HOLDS the activity makes the card worth reading (in-flight elsewhere does not)", async () => {
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    reg.inflight.add(key("contact", CUSTOMER));                     // another delivery is writing the contact
    expect(await syncHubspotActivity(ON, "emails", ACT)).toBe("creating");
    expect(created).toEqual([CARD[COMPANY]]);                       // written, exactly as before
    expect(gqlCalls("timeline_items_page")).toHaveLength(0);
  });

  it("deferMirrorCheck: a Company linked to a Contact written THIS pass is neither claimed nor written", async () => {
    asyncCopies = true;                                              // monday's copy lands a moment later
    expect(await syncHubspotActivity(ON, "emails", ACT, { deferMirrorCheck: true })).toBe("deferred");
    expect(created).toEqual([CARD[CUSTOMER]]);
    expect(reg.claimActivityToMonday.mock.calls.map(c => c[3])).toEqual(["contact"]);   // company/deal unclaimed
    expect(logs().filter(l => l.includes("action=mirror-check-deferred"))).toHaveLength(2);

    flushCopies();                                                   // +30 s: the copy has landed
    expect(await syncHubspotActivity(ON, "emails", ACT)).toBe("skipped");
    expect(created).toEqual([CARD[CUSTOMER]]);
    for (const c of [CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]]) expect(copiesOn(c)).toBe(1);
  });

  /** Why the deferral exists: checked a moment after the Contact write, the copy is not there yet. */
  it("without the deferral a copy that has not landed reads absent and is written (the old duplicate)", async () => {
    asyncCopies = true;
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    await syncHubspotActivity(ON, "emails", ACT);
    flushCopies();
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());
    expect(copiesOn(CARD[COMPANY])).toBe(2);
  });

  /** A Set, not the first Contact seen: CUSTOMER (settled long ago) comes first, CUSTOMER2 was written now. */
  it("a card linked by an old Contact AND a just-written one is deferred", async () => {
    assoc = { contacts: [CUSTOMER, CUSTOMER2], companies: [COMPANY], deals: [] };
    links = { [CARD[CUSTOMER]]: [CARD[COMPANY]], [CARD[CUSTOMER2]]: [CARD[COMPANY]] };
    reg.settled.set(key("contact", CUSTOMER), "tl-old");
    add(CARD[CUSTOMER], { id: "tl-old", content: `x\n${MARKER}` });
    asyncCopies = true;
    expect(await syncHubspotActivity(ON, "emails", ACT, { deferMirrorCheck: true })).toBe("deferred");
    expect(created).toEqual([CARD[CUSTOMER2]]);
    expect(reg.claimActivityToMonday.mock.calls.some(c => c[3] === "company")).toBe(false);
    const line = logs().find(l => l.includes("action=mirror-check-deferred"))!;
    expect(line).toContain(`via=${CARD[CUSTOMER2]}`);

    flushCopies();
    await syncHubspotActivity(ON, "emails", ACT);
    expect(created).toEqual([CARD[CUSTOMER2]]);
    expect(copiesOn(CARD[COMPANY])).toBe(1);
  });

  it("a Contact settled by an EARLIER pass is not a reason to wait: the card is checked now", async () => {
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    links = { [CARD[CUSTOMER]]: [CARD[COMPANY]] };
    reg.settled.set(key("contact", CUSTOMER), "tl-old");
    add(CARD[CUSTOMER], { id: "tl-old", content: `x\n${MARKER}` });
    add(CARD[COMPANY], { id: "mc-old", content: `x\n${MARKER}` });  // monday's copy, from back then
    expect(await syncHubspotActivity(ON, "emails", ACT, { deferMirrorCheck: true })).toBe("skipped");
    expect(created).toEqual([]);
    expect(reg.settled.get(key("company", COMPANY))).toBe("mc-old");
  });

  it("verifyExisting never defers, and a pass with a retryable destination reports that, not deferred", async () => {
    asyncCopies = true;
    assoc = { contacts: [CUSTOMER], companies: [COMPANY], deals: [] };
    await syncHubspotActivity(ON, "emails", ACT, { deferMirrorCheck: true, verifyExisting: true });
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());     // verified absent -> written

    reset();
    assoc = { contacts: [CUSTOMER, CUSTOMER2], companies: [COMPANY], deals: [] };
    links = { [CARD[CUSTOMER2]]: [CARD[COMPANY]] };
    reg.inflight.add(key("contact", CUSTOMER));                     // "creating": the pass must come back anyway
    expect(await syncHubspotActivity(ON, "emails", ACT, { deferMirrorCheck: true })).toBe("creating");
    expect(created).toEqual([CARD[CUSTOMER2]]);
  });

  it("flag off: deferMirrorCheck is ignored", async () => {
    asyncCopies = true;
    expect(await syncHubspotActivity(OFF, "emails", ACT, { deferMirrorCheck: true })).toBe("created");
    expect(created.sort()).toEqual([CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]].sort());
  });
});

// ============================================================ flag off = today, call for call

describe("flag off is today's behaviour exactly", () => {
  /** Everything observable: every monday/HubSpot request with its variables, every registry call, every log line. */
  async function trace(env: Env, prep: () => void = () => {}) {
    reset(); prep();
    const outcome = await syncHubspotActivity(env, "emails", ACT);
    return {
      outcome,
      gql: monday.gql.mock.calls.map(c => [c[1], c[2], c[3], c[4]]),
      find: monday.findItemByColumn.mock.calls.map(c => c.slice(1)),
      hs: hubspot.hs.mock.calls.map(c => c.slice(1)),
      claims: reg.claimActivityToMonday.mock.calls.map(c => c.slice(1)),
      settles: reg.settleActivityToMonday.mock.calls.map(c => c.slice(1)),
      logs: logs(),
    };
  }

  it("the same requests, registry calls and log lines whether the flag is absent, \"false\" or anything but \"true\"", async () => {
    for (const prep of [() => {}, () => { reg.stale.add(key("company", COMPANY)); }, () => { links = {}; }]) {
      const absent = await trace(OFF, prep);
      expect(await trace({ ...base, ACTIVITY_SKIP_MIRRORED_COPIES: "false" } as unknown as Env, prep)).toEqual(absent);
      expect(await trace({ ...base, ACTIVITY_SKIP_MIRRORED_COPIES: "yes" } as unknown as Env, prep)).toEqual(absent);
    }
  });

  it("and it is the pre-change sequence: three creates, settled on their own ids, no link or card read", async () => {
    const t = await trace(OFF);
    expect(t.outcome).toBe("created");
    expect(t.gql.map(g => String(g[0]).includes("create_timeline_item"))).toEqual([true, true, true]);
    expect(t.gql.map(g => (g[1] as any).i)).toEqual([CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]]);
    expect(t.settles.map(s => [s[2], s[4]])).toEqual([["contact", "tl1"], ["company", "tl4"], ["deal", "tl5"]]);
    expect(t.logs.some(l => /mirror/.test(l))).toBe(false);
  });

  it("the stale-takeover read still sends alreadyOnCard's original query, byte for byte", async () => {
    const t = await trace(OFF, () => { reg.stale.add(key("company", COMPANY)); });
    const reads = t.gql.filter(g => String(g[0]).includes("timeline_items_page"));
    expect(reads).toHaveLength(1);
    expect(reads[0][0]).toBe(`query ($i: ID!, $c: String) { timeline(id: $i) { timeline_items_page(limit: 100, cursor: $c) {
            cursor timeline_items { content } } } }`);
  });

  it("wrangler.jsonc ships the flag \"false\"", () => {
    expect(((readWranglerConfig().vars ?? {}) as Record<string, string>).ACTIVITY_SKIP_MIRRORED_COPIES).toBe("false");
  });
});
