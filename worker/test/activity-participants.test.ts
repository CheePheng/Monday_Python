import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";

/**
 * WHICH CARD DOES AN ACTIVITY BELONG ON? — the regression suite for the production incident of
 * 2026-09-16.
 *
 * Activities were enabled globally at 09:39:25Z and rolled back twelve minutes later. In that window
 * forty outbound campaign emails were filed on the SENDER's own monday card and not one reached the
 * customer it was sent to. The cause was a single line: the code took the FIRST associated contact,
 * and HubSpot associates an email with every participant — the rep and the customer both — with the
 * rep first.
 *
 * It survived a canary because the canary's email was created through the API with exactly ONE
 * association. A real email has two. Every test below therefore uses a realistic multi-participant
 * activity, which is the only shape that can catch this.
 *
 * The rule is NOT about direction. "Skip the sender" is right for outbound and precisely backwards
 * for inbound, where the sender is the customer. It is about who is STAFF, which HubSpot answers
 * through its owners list.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));

const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  // Mirrors the real key: contact keeps its original three-part shape so pre-existing durable
  // mappings stay readable; company and deal get their own namespace.
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed" };
  };
  return {
    settled, inflight,
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

const REP = "103855693312";        // Myla — a real HubSpot OWNER, and also a Contact
const REP_EMAIL = "mylamestiola@dkmeco.com";
const CUSTOMER = "553287164663";
const CUSTOMER_2 = "553287165631";
const ACT = "400364899020";

/** contact id -> monday card id. A contact with no entry here has no card. */
const CARDS: Record<string, string> = {
  [REP]: "2855754772", [CUSTOMER]: "2860111111", [CUSTOMER_2]: "2860222222",
};
const EMAILS: Record<string, string> = {
  [REP]: REP_EMAIL, [CUSTOMER]: "acyxou@findevcanada.ca", [CUSTOMER_2]: "ttpkpz-ezr@xcellinkgroup.com",
};

let associated: string[] = [];
let created: { card: string }[] = [];
let ownersFail = false;
/** ids the contacts/batch/read fake was asked to classify — the canary blind-spot detector. */
let classified: string[] = [];
/** association pages, to prove the lookup walks past page one. */
let assocPages: string[][] | null = null;

const env = {
  ENABLE_ACTIVITY_SYNC: "true",
  ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z",
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear();
  associated = [REP, CUSTOMER];      // the real shape: sender FIRST, as HubSpot returns it
  created = [];
  ownersFail = false;
  classified = [];
  assocPages = null;

  monday.findItemByColumn.mockImplementation(async (_e: Env, _b: string, _c: string, value: string) => {
    const card = CARDS[value];
    return card ? [{ id: card }] : [];
  });
  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) {
      created.push({ card: String(v.i) });
      return { create_timeline_item: { id: `tl${created.length}` } };
    }
    if (q.includes("change_multiple_column_values")) return { change_multiple_column_values: { id: v.i } };
    return { items: [{ column_values: [{ text: "" }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.startsWith("/crm/v3/owners")) {
      if (ownersFail) throw new Error("HubSpot 503 on owners");
      return { results: [{ id: "OW", email: REP_EMAIL }] };     // the rep IS an owner
    }
    if (path === "/crm/v3/objects/contacts/batch/read") {
      classified = (body?.inputs ?? []).map((i: any) => String(i.id));
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: EMAILS[i.id] } })) };
    }
    if (path.startsWith("/crm/v3/objects/emails/")) return {
      properties: { hs_timestamp: "2026-09-16T09:49:00Z", hs_email_subject: "Executive Dinner",
        hs_email_direction: "EMAIL", hs_email_from_email: REP_EMAIL },
    };
    if (path.includes("/associations/contacts")) {
      if (assocPages) {                                    // multi-page mode
        const n = Number(/after=(\d+)/.exec(path)?.[1] ?? 0);
        const page = assocPages[n] ?? [];
        const more = n + 1 < assocPages.length;
        return { results: page.map(id => ({ toObjectId: id })),
                 paging: more ? { next: { after: String(n + 1) } } : undefined };
      }
      return { results: associated.map(id => ({ toObjectId: id })) };
    }
    return { properties: {} };
  });
});

afterEach(() => { vi.useRealTimers(); });

const cardsWritten = () => created.map(c => c.card).sort();

describe("an activity lands on the counterparty's card, never on staff's", () => {
  /** The exact production case: outbound, rep first in the association list. */
  it("outbound rep -> customer writes ONLY the customer's card", async () => {
    associated = [REP, CUSTOMER];
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER]]);
    expect(cardsWritten()).not.toContain(CARDS[REP]);
  });

  /**
   * AND THE SAME ANSWER INBOUND. This is why the rule cannot be "skip the sender": here the sender IS
   * the customer, so that rule would have kept the rep's card and dropped the customer's — the very
   * failure inverted.
   */
  it("inbound customer -> rep also writes ONLY the customer's card", async () => {
    associated = [CUSTOMER, REP];
    hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
      if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: REP_EMAIL }] };
      if (path === "/crm/v3/objects/contacts/batch/read")
        return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: EMAILS[i.id] } })) };
      if (path.startsWith("/crm/v3/objects/emails/")) return {
        properties: { hs_timestamp: "2026-09-16T09:49:00Z", hs_email_subject: "Re: Executive Dinner",
          hs_email_direction: "INCOMING_EMAIL", hs_email_from_email: EMAILS[CUSTOMER] },
      };
      if (path.includes("/associations/contacts")) return { results: associated.map(id => ({ toObjectId: id })) };
      return { properties: {} };
    });

    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER]]);
  });

  /** Several real participants all deserve the entry — that is the point of fanning out. */
  it("writes every customer participant", async () => {
    associated = [REP, CUSTOMER, CUSTOMER_2];
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER], CARDS[CUSTOMER_2]].sort());
  });

  /** Internal mail between colleagues belongs on nobody's customer timeline. */
  it("writes nothing when every participant is staff", async () => {
    associated = [REP];
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("skipped");
    expect(created).toEqual([]);
  });
});

describe("one entry per card, exactly once", () => {
  /**
   * THE KEY HAD TO CHANGE. Keyed by activity alone, the first card written marked the whole activity
   * settled and every remaining participant was silently skipped — so the customer, whose timeline is
   * the entire point, would have received nothing.
   */
  it("a redelivery adds nothing, and each card is keyed separately", async () => {
    associated = [REP, CUSTOMER, CUSTOMER_2];
    await syncHubspotActivity(env, "emails", ACT);
    await syncHubspotActivity(env, "emails", ACT);

    expect(cardsWritten()).toEqual([CARDS[CUSTOMER], CARDS[CUSTOMER_2]].sort());
    expect([...reg.settled.keys()].sort()).toEqual([
      `act:h2m:emails:${ACT}:${CUSTOMER}`, `act:h2m:emails:${ACT}:${CUSTOMER_2}`,
    ].sort());
  });

  /** A participant whose card exists is written even when another participant's does not. */
  it("one missing card does not stop the others, and stays retryable", async () => {
    const GHOST = "999999999";                       // associated, but has no monday card
    EMAILS[GHOST] = "ghost@elsewhere.com";
    associated = [REP, CUSTOMER, GHOST];

    vi.useFakeTimers();
    const p = syncHubspotActivity(env, "emails", ACT);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await p;

    expect(cardsWritten()).toEqual([CARDS[CUSTOMER]]);
    expect(outcome).toBe("unresolved");              // so the durable retry picks the ghost up later
    delete EMAILS[GHOST];
  });
});

describe("the canary must be able to see the staff participant", () => {
  /**
   * THE BLIND SPOT THAT SURVIVED THE FIRST FIX. Scope used to FILTER the associations before
   * classification. With the allowlist set to the customer, the rep vanished before the staff check
   * ever ran — so the classifier saw one participant, and the canary reproduced precisely the
   * one-sided shape that let the incident through a green canary in the first place.
   *
   * A canary that cannot see the rep cannot prove the rep was excluded. Scope now decides only
   * WHETHER to look; classification sees everyone, and scope is re-applied to the WRITES.
   */
  it("classifies the full association set even when the allowlist names only the customer", async () => {
    const canary = { ...env, ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: CUSTOMER } as Env;
    associated = [REP, CUSTOMER];

    expect(await syncHubspotActivity(canary, "emails", ACT)).toBe("created");

    // the evidence the live canary has to produce: the rep WAS on the classifier's input
    expect(classified.sort()).toEqual([REP, CUSTOMER].sort());
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER]]);
    expect(cardsWritten()).not.toContain(CARDS[REP]);
  });

  /** An activity that does not involve the canary contact at all is dropped before any classification
   *  work — the allowlist must stay cheap for the rest of the portal. */
  it("skips an unrelated activity without classifying anything", async () => {
    const canary = { ...env, ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "777777777" } as Env;
    associated = [REP, CUSTOMER];

    expect(await syncHubspotActivity(canary, "emails", ACT)).toBe("skipped");
    expect(classified).toEqual([]);
    expect(created).toEqual([]);
  });

  /** And a customer outside the allowlist is classified but not written — scope applies to the
   *  writes, so the canary cannot leak onto other people's cards. */
  it("classifies everyone but writes only the allowlisted customer", async () => {
    const canary = { ...env, ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: CUSTOMER } as Env;
    associated = [REP, CUSTOMER, CUSTOMER_2];

    expect(await syncHubspotActivity(canary, "emails", ACT)).toBe("created");
    expect(classified.sort()).toEqual([REP, CUSTOMER, CUSTOMER_2].sort());
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER]]);
  });
});

describe("all participants means all of them", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `9000${i}`);

  /** More than the old hard-coded five. Silently writing the first few would lose real communication
   *  history in a way nobody would notice. */
  it("fans out to more than five customers", async () => {
    const ids = many(8);
    for (const id of ids) { CARDS[id] = `card${id}`; EMAILS[id] = `c${id}@example.com`; }
    associated = [REP, ...ids];

    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(cardsWritten()).toEqual(ids.map(i => CARDS[i]).sort());
    for (const id of ids) { delete CARDS[id]; delete EMAILS[id]; }
  });

  /**
   * Above the abuse ceiling NOTHING is written. Partially writing and discarding the rest is the
   * worst option: it looks successful and is silently incomplete.
   */
  /** HubSpot's batch read takes at most 100 inputs, so classifying the full set has to chunk. Without
   *  it an oversized activity fails as an opaque 400 instead of at the ceiling built to describe it. */
  it("chunks the classification read past a hundred participants", async () => {
    const ids = many(140);
    for (const id of ids) { CARDS[id] = `card${id}`; EMAILS[id] = `c${id}@example.com`; }
    associated = [REP, ...ids];
    const batches: number[] = [];
    const inner = hubspot.hs.getMockImplementation()!;
    hubspot.hs.mockImplementation(async (e: any, m: string, path: string, body?: any) => {
      if (path === "/crm/v3/objects/contacts/batch/read") batches.push((body?.inputs ?? []).length);
      return inner(e, m, path, body);
    });

    await syncHubspotActivity(env, "emails", ACT);
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches)).toBeLessThanOrEqual(100);
    for (const id of ids) { delete CARDS[id]; delete EMAILS[id]; }
  });

  it("writes nothing at all when the participant count is pathological", async () => {
    const ids = many(60);
    for (const id of ids) { CARDS[id] = `card${id}`; EMAILS[id] = `c${id}@example.com`; }
    associated = [REP, ...ids];

    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("unresolved");   // -> durable retry -> terminal
    expect(created).toEqual([]);
    for (const id of ids) { delete CARDS[id]; delete EMAILS[id]; }
  });

  /** The association lookup asked for one page of ten. Ten is an ordinary number of recipients, so
   *  that truncation was real — and invisible, because the dropped entries were simply absent. */
  it("walks every association page", async () => {
    const p1 = [REP, CUSTOMER], p2 = [CUSTOMER_2];
    assocPages = [p1, p2];

    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(classified.sort()).toEqual([REP, CUSTOMER, CUSTOMER_2].sort());
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER], CARDS[CUSTOMER_2]].sort());
  });

  /**
   * RUNNING OUT OF PAGES IS NOT AN ANSWER. A truncated set looks perfectly ordinary — a shorter list,
   * with nothing to mark it short — so acting on it would write a confidently incomplete result. It
   * fails closed instead, writing nothing and travelling the durable-retry path to a terminal record.
   */
  it("writes nothing when the associations exceed the page ceiling", async () => {
    // eleven pages, each still offering another: one more than MAX_ASSOC_PAGES
    assocPages = Array.from({ length: 11 }, (_, i) => [i === 0 ? CUSTOMER : `page${i}`]);
    for (let i = 1; i < 11; i++) { CARDS[`page${i}`] = `card${i}`; EMAILS[`page${i}`] = `p${i}@example.com`; }

    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("unresolved");
    expect(created).toEqual([]);
    expect(classified).toEqual([]);          // it refuses before spending a classification read
    for (let i = 1; i < 11; i++) { delete CARDS[`page${i}`]; delete EMAILS[`page${i}`]; }
  });

  /** The same contact on two pages, or twice on one, must not produce two entries on its card. */
  it("deduplicates repeated association ids", async () => {
    assocPages = [[REP, CUSTOMER], [CUSTOMER, REP]];

    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(classified.sort()).toEqual([REP, CUSTOMER].sort());
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER]]);
  });
});

describe("classification must not be guessed", () => {
  /**
   * If the owners list cannot be read we do NOT fall back to "write to everyone" — that is precisely
   * what filled the rep's card in production. It is reported as retryable instead, and the durable
   * retry tries again once HubSpot answers.
   */
  it("refuses to write when staff cannot be identified", async () => {
    ownersFail = true;
    /**
     * A FRESH ISOLATE, deliberately. The owners list is cached for ten minutes, so a warm isolate
     * rightly rides out a transient HubSpot failure without noticing it — which is why this has to
     * re-import the module to reach the cold path, and why the first assertion below would otherwise
     * pass for the wrong reason.
     */
    vi.resetModules();
    const cold = await import("../src/activity-sync");
    expect(await cold.syncHubspotActivity(env, "emails", ACT)).toBe("unresolved");
    expect(created).toEqual([]);
  });

  /** The other half of that cache: once read, a later owners outage does not stop the sync. */
  it("keeps working from cache when a later owners read fails", async () => {
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");   // warms the cache
    created = []; reg.settled.clear(); reg.inflight.clear();
    ownersFail = true;
    expect(await syncHubspotActivity(env, "emails", "400364899021")).toBe("created");
    expect(cardsWritten()).toEqual([CARDS[CUSTOMER]]);
  });

  /** A contact with no email cannot be PROVEN to be staff, and dropping a real customer is the worse
   *  of the two errors, so it is kept. */
  it("keeps a participant whose email is unknown", async () => {
    const NOEMAIL = "888888888";
    CARDS[NOEMAIL] = "2860333333";
    associated = [REP, NOEMAIL];
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(cardsWritten()).toEqual([CARDS[NOEMAIL]]);
    delete CARDS[NOEMAIL];
  });
});
