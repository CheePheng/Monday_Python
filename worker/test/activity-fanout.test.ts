import { describe, it, expect, vi, beforeEach } from "vitest";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "../src/config/crm";
import type { Env } from "../src/types";

/**
 * ONE ACTIVITY, THREE KINDS OF DESTINATION.
 *
 * monday is becoming the CRM the sales team actually works in — only a couple of admin seats will
 * keep HubSpot — so a rep looking at an Account or a Deal has to see the conversation that happened
 * on it without opening HubSpot. HubSpot associates an activity with every CRM object it touched, so
 * one email legitimately belongs on a Contact, a Company and a Deal at once.
 *
 * Two rules pull in opposite directions here, and the tests exist to keep them apart:
 *   - the staff filter stops a rep's own CONTACT card collecting the mail they sent
 *   - it must NOT remove an explicitly associated Company or Deal, because that association is a
 *     record of what happened, and the sender's staff status says nothing about it
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));

const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
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

const REP = "103855693312", REP_EMAIL = "rep@dkmeco.com";
const CUSTOMER = "553287164663";
const COMPANY = "16824787545";
const DEAL = "31410001";
const ACT = "400364899020";

const CARD: Record<string, string> = {           // hubspot id -> monday card, per board
  [REP]: "2855754772", [CUSTOMER]: "2860111111", [COMPANY]: "2860999111", [DEAL]: "2860999222",
};
const BOARD_OF: Record<string, string> = {
  [REP]: CRM_CONTACTS.boardId, [CUSTOMER]: CRM_CONTACTS.boardId,
  [COMPANY]: CRM_ACCOUNTS.boardId, [DEAL]: CRM_DEALS.boardId,
};

let assoc: Record<"contacts" | "companies" | "deals", string[]>;
let created: { card: string }[] = [];
let missingCards: string[] = [];

const env = { ENABLE_ACTIVITY_SYNC: "true", ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear();
  assoc = { contacts: [REP, CUSTOMER], companies: [COMPANY], deals: [DEAL] };
  created = []; missingCards = [];

  // The card lookup is board-aware: asking the Accounts board for a contact id must find nothing.
  monday.findItemByColumn.mockImplementation(async (_e: Env, board: string, _c: string, value: string) => {
    if (missingCards.includes(value)) return [];
    return CARD[value] && BOARD_OF[value] === board ? [{ id: CARD[value] }] : [];
  });
  monday.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) {
      created.push({ card: String(v.i) });
      return { create_timeline_item: { id: `tl${created.length}` } };
    }
    return { items: [{ column_values: [{ text: "" }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string, body?: any) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OW", email: REP_EMAIL }] };
    if (path === "/crm/v3/objects/contacts/batch/read")
      return { results: (body?.inputs ?? []).map((i: any) => ({
        id: i.id, properties: { email: i.id === REP ? REP_EMAIL : `c${i.id}@example.com` } })) };
    if (path.startsWith("/crm/v3/objects/emails/")) return {
      properties: { hs_timestamp: "2026-09-16T09:49:00Z", hs_email_subject: "Quarterly review",
        hs_email_direction: "EMAIL", hs_email_from_email: REP_EMAIL },
    };
    for (const k of ["contacts", "companies", "deals"] as const)
      if (path.includes(`/associations/${k}`))
        return { results: assoc[k].map(id => ({ toObjectId: id })) };
    return { properties: {} };
  });
});

const written = () => created.map(c => c.card).sort();

describe("fan-out across Contacts, Accounts and Deals", () => {
  /** The whole point: one activity, one entry on each associated record, on three different boards. */
  it("writes the contact, the company and the deal", async () => {
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(written()).toEqual([CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]].sort());
  });

  /**
   * THE TWO RULES KEPT APART. The rep is excluded from the CONTACT side — that is the incident this
   * filter exists for — but the Company and Deal associations survive, because HubSpot recorded them
   * and the sender's staff status has nothing to say about an Account timeline.
   */
  it("excludes staff from the contact side without dropping the company or deal", async () => {
    await syncHubspotActivity(env, "emails", ACT);
    expect(written()).not.toContain(CARD[REP]);
    expect(written()).toContain(CARD[COMPANY]);
    expect(written()).toContain(CARD[DEAL]);
  });

  /** An activity whose only contact is staff still belongs on the Account and Deal it was about. */
  it("still writes company and deal when every contact is staff", async () => {
    assoc = { contacts: [REP], companies: [COMPANY], deals: [DEAL] };
    expect(await syncHubspotActivity(env, "emails", ACT)).toBe("created");
    expect(written()).toEqual([CARD[COMPANY], CARD[DEAL]].sort());
  });

  /** EXPLICIT ASSOCIATIONS ONLY. A Company is never reached by walking from the Contact — if HubSpot
   *  did not link it, nothing here invents the link. */
  it("does not invent a company the activity is not associated with", async () => {
    assoc = { contacts: [CUSTOMER], companies: [], deals: [] };
    await syncHubspotActivity(env, "emails", ACT);
    expect(written()).toEqual([CARD[CUSTOMER]]);
  });

  it("writes nothing anywhere when there is no association at all", async () => {
    // Fake timers: with nothing associated this walks the full bounded backoff, which is the point —
    // an activity with no CRM object yet is usually a race, not a permanent state.
    vi.useFakeTimers();
    assoc = { contacts: [], companies: [], deals: [] };
    const p = syncHubspotActivity(env, "emails", ACT);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await p;
    vi.useRealTimers();

    expect(outcome).toBe("unresolved");
    expect(created).toEqual([]);
  });
});

describe("idempotency is per destination", () => {
  /**
   * Keyed by activity alone, the first destination written would mark the whole activity settled and
   * the other two would silently get nothing.
   */
  it("a redelivery adds nothing on any of the three", async () => {
    await syncHubspotActivity(env, "emails", ACT);
    await syncHubspotActivity(env, "emails", ACT);
    expect(written()).toEqual([CARD[CUSTOMER], CARD[COMPANY], CARD[DEAL]].sort());
  });

  /**
   * CONTACT KEEPS ITS ORIGINAL KEY SHAPE. Mappings written before Companies and Deals existed as
   * destinations are already in durable storage, and a key that no longer matches does not fail — it
   * reads as "never synced" and writes the entry a second time.
   */
  it("uses the pre-existing key for contacts and a namespaced one for the rest", async () => {
    await syncHubspotActivity(env, "emails", ACT);
    expect([...reg.settled.keys()].sort()).toEqual([
      `act:h2m:emails:${ACT}:${CUSTOMER}`,
      `act:h2m:emails:${ACT}:company:${COMPANY}`,
      `act:h2m:emails:${ACT}:deal:${DEAL}`,
    ].sort());
  });

  /** One destination missing its card must not stop the others, and must stay retryable. */
  it("a missing deal card does not block the contact or company", async () => {
    vi.useFakeTimers();
    missingCards = [DEAL];
    const p = syncHubspotActivity(env, "emails", ACT);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await p;
    vi.useRealTimers();

    expect(written()).toEqual([CARD[CUSTOMER], CARD[COMPANY]].sort());
    expect(outcome).toBe("unresolved");          // so the durable retry picks the deal up later
  });

  /** The follow-up helper is a CONTACT concept — a Company or Deal entry says nothing about whether
   *  the person responsible for a person has reached out. */
  it("only the contact destination can touch the follow-up helper", async () => {
    await syncHubspotActivity(env, "emails", ACT);
    const helperWrites = monday.gql.mock.calls.filter(c => String(c[1]).includes("date_mm78yd2c"));
    for (const call of helperWrites) {
      const v: any = call[2];
      expect([CARD[CUSTOMER], CARD[REP]]).toContain(String(v.i ?? v.b ?? CARD[CUSTOMER]));
    }
  });
});
