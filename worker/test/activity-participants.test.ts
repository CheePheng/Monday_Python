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
  const h2m = (o: string, i: string, c: string) => `act:h2m:${o}:${i}:${c}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed" };
  };
  return {
    settled, inflight,
    m2hReservationKey: (t: string) => `act:m2h:${t}`, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, c: string) => claim(h2m(o, i, c))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, c: string, t: string) => {
      settled.set(h2m(o, i, c), t); inflight.delete(h2m(o, i, c));
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
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({ id: i.id, properties: { email: EMAILS[i.id] } })) };
    if (path.startsWith("/crm/v3/objects/emails/")) return {
      properties: { hs_timestamp: "2026-09-16T09:49:00Z", hs_email_subject: "Executive Dinner",
        hs_email_direction: "EMAIL", hs_email_from_email: REP_EMAIL },
    };
    if (path.includes("/associations/contacts"))
      return { results: associated.map(id => ({ toObjectId: id })) };
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
