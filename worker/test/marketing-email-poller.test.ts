import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { MONDAY_ACTIVITY_TYPE } from "../src/activities";
import { MARKETING_OBJECTS, eventKey } from "../src/marketing-emails";

/**
 * THE MARKETING EMAIL POLLER -- I/O, with every dependency replaced by an in-memory fake.
 *
 * What these pin, in the order the critic raised them: nothing runs unless every gate says so; the
 * cursors only move over work that landed; first-open/first-click is claim-once across polls; staff,
 * unknown recipients and card-less contacts are handled without stalling or guessing; a per-poll cap;
 * a poison event cannot end the feed; a canary cannot hide production work; a dry run writes nothing.
 */

const NOW = Date.parse("2026-09-30T12:00:00Z");
const CUTOVER = "2026-09-29T00:00:00Z";
const TYPE = "11111111-2222-3333-4444-555555555555";

const st = vi.hoisted(() => ({
  events: [] as any[],
  campaigns: {} as Record<string, any>,
  campaignFail: null as null | string,
  campaignFailById: {} as Record<string, string>,
  badEmails: new Set<string>(),
  contacts: {} as Record<string, string>,     // email -> contact id
  cards: {} as Record<string, string>,        // contact id -> card id
  eventCalls: [] as URLSearchParams[],
  hsCalls: [] as string[],
  creates: [] as any[],
  createFail: [] as Array<Error | null>,
  eventsHandler: null as null | ((q: URLSearchParams) => any),
}));

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));
const sync = vi.hoisted(() => ({
  activitySyncEnabled: (e: any) => e.ENABLE_ACTIVITY_SYNC === "true",
  staffEmails: vi.fn(),
  alreadyOnCard: vi.fn(),
}));
const retry = vi.hoisted(() => ({ activityRetryBound: () => true, record: vi.fn(),
  deadLetterStub: () => ({ record: (x: any) => retry.record(x) }) }));
const reg = vi.hoisted(() => {
  const marks = new Map<string, string>(), settled = new Map<string, string>(),
    reserved = new Set<string>(), notes = new Map<string, string>();
  const k = (o: string, id: string, kind: string, d: string) => `act:h2m:${o}:${id}:${d}`;
  return {
    marks, settled, reserved, notes, k, stale: new Set<string>(),
    getWatermark: vi.fn(async (_e: any, n: string) => marks.get(n) ?? null),
    setWatermark: vi.fn(async (_e: any, n: string, v: string) => { marks.set(n, v); }),
    peekActivityToMonday: vi.fn(async (_e: any, o: string, id: string, kind: string, d: string) =>
      settled.has(k(o, id, kind, d)) ? "have" : "absent"),
    claimActivityToMonday: vi.fn(async (_e: any, o: string, id: string, kind: string, d: string) => {
      const key = k(o, id, kind, d);
      if (settled.has(key)) return { status: "have", id: settled.get(key) };
      if (reserved.has(key)) return { status: "creating" };
      reserved.add(key);
      return { status: "proceed", tookOverStale: reg.stale.has(key) };
    }),
    settleActivityToMonday: vi.fn(async (_e: any, o: string, id: string, kind: string, d: string, t: string) => {
      settled.set(k(o, id, kind, d), t); reserved.delete(k(o, id, kind, d));
    }),
    unresolvedActivityToMonday: vi.fn(),
    releaseActivity: vi.fn(async (_e: any, key: string) => { reserved.delete(key); }),
    h2mReservationKey: (o: string, id: string, kind: string, d: string) => k(o, id, kind, d),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => {}),
    readNote: vi.fn(async (_e: any, n: string) => notes.get(n) ?? null),
    strictFail: new Set<string>(),
    readNoteStrict: vi.fn(async (_e: any, n: string) => {
      if (reg.strictFail.has(n)) throw new Error(`note ${n} unreadable: DO blip`);
      return notes.get(n) ?? null;
    }),
    writeNote: vi.fn(async (_e: any, n: string, v: string) => { notes.set(n, v); return true; }),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
// internalDomains is the REAL helper: the staff rule is only as good as the domains it derives.
vi.mock("../src/activity-sync", async (orig) => ({ ...sync, internalDomains: (await orig<any>()).internalDomains }));
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/activity-retry", () => retry);

const P = await import("../src/marketing-email-poller");
const { pollMarketingEmails, OVERLAP_MS, NO_CARD_GRACE_MS, POISON_TRIES, WM_LIVE, WM_BACKFILL, NOTE_REREAD,
  ledgerName } = P;

const env = (over: Record<string, string | undefined> = {}): Env => ({
  ENABLE_CRM: "true", ENABLE_MARKETING_EMAIL_SYNC: "true", ENABLE_ACTIVITY_SYNC: "true",
  DRY_RUN: "false", MARKETING_CUTOVER_AT: CUTOVER, ...over,
} as unknown as Env);
const poll = (e: Env = env(), o: Parameters<typeof pollMarketingEmails>[1] = {}) =>
  pollMarketingEmails(e, { nowMs: NOW, ...o });

let seq = 0;
const at = (iso: string) => Date.parse(iso);
/** A send to `to` at `sentIso`, and the events that follow it. */
const sendTo = (to: string, sentIso: string, id = "s" + (++seq)) => ({ id, created: at(sentIso) });
const ev = (type: string, to: string, sent: { id: string; created: number }, createdIso: string, over: any = {}) =>
  ({ id: "e" + (++seq), type, recipient: to, created: at(createdIso), emailCampaignId: 100, sentBy: sent, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of [reg.marks, reg.settled, reg.notes]) m.clear();
  reg.reserved.clear(); reg.stale.clear(); reg.strictFail.clear();
  Object.assign(st, { events: [], campaignFail: null, campaignFailById: {}, badEmails: new Set(), contacts: {},
    cards: {}, eventCalls: [], hsCalls: [], creates: [], createFail: [], eventsHandler: null });
  st.campaigns = { "100": { id: 100, name: "Dinner confirm 2", subject: "Your Place Is Confirmed",
    type: "BATCH_EMAIL", contentId: 555 } };
  MONDAY_ACTIVITY_TYPE.marketing_emails = TYPE;
  sync.staffEmails.mockReset().mockResolvedValue(new Set(["rep@dkmeco.com", "owner@gmail.com"]));
  sync.alreadyOnCard.mockReset().mockResolvedValue("absent");
  reg.acquireLock.mockReset().mockResolvedValue(true);
  reg.getWatermark.mockImplementation(async (_e: any, n: string) => reg.marks.get(n) ?? null);

  hubspot.hs.mockReset().mockImplementation(async (_e: Env, method: string, path: string, body?: any) => {
    st.hsCalls.push(`${method} ${path.split("?")[0]}`);
    if (path.startsWith("/email/public/v1/events")) {
      const q = new URLSearchParams(path.split("?")[1]);
      st.eventCalls.push(q);
      if (st.eventsHandler) return st.eventsHandler(q);
      const s = Number(q.get("startTimestamp")), en = Number(q.get("endTimestamp"));
      return { hasMore: false, events: st.events.filter(e => e.created >= s && e.created <= en) };
    }
    if (path.startsWith("/email/public/v1/campaigns/")) {
      if (st.campaignFail) throw new Error(st.campaignFail);
      const id = path.split("/").pop()!;
      if (st.campaignFailById[id]) throw new Error(st.campaignFailById[id]);
      if (!st.campaigns[id]) throw new Error(`hubspot GET ${path}: 404 not found`);
      return st.campaigns[id];
    }
    if (path === "/crm/v3/objects/contacts/batch/read") {
      if (body.inputs.some((i: any) => st.badEmails.has(i.id)))
        throw new Error(`hubspot POST ${path}: 400 {"message":"Invalid input email"}`);
      return { results: body.inputs.filter((i: any) => st.contacts[i.id])
        .map((i: any) => ({ id: st.contacts[i.id], properties: { email: i.id } })) };
    }
    throw new Error(`unexpected hs ${method} ${path}`);
  });
  monday.findItemByColumn.mockReset().mockImplementation(async (_e: Env, _b: string, _c: string, id: string) =>
    st.cards[id] ? [{ id: st.cards[id] }] : []);
  monday.gql.mockReset().mockImplementation(async (_e: Env, _q: string, v: any) => {
    const f = st.createFail.shift();
    if (f) throw f;
    st.creates.push(v);
    return { create_timeline_item: { id: "T" + st.creates.length } };
  });
});

/** A customer with a contact and a card. */
const customer = (email: string, contactId: string, cardId: string) => {
  st.contacts[email] = contactId; st.cards[contactId] = cardId;
};

describe("the gates: nothing runs unless every one says so", () => {
  const nothingCalled = () => {
    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(monday.gql).not.toHaveBeenCalled();
    expect(monday.findItemByColumn).not.toHaveBeenCalled();
    expect(reg.acquireLock).not.toHaveBeenCalled();
    expect(reg.getWatermark).not.toHaveBeenCalled();
    expect(sync.staffEmails).not.toHaveBeenCalled();
  };

  it.each([undefined, "false", "TRUE", "1"])("ENABLE_MARKETING_EMAIL_SYNC=%j -> zero calls", async (v) => {
    const r = await poll(env({ ENABLE_MARKETING_EMAIL_SYNC: v }));
    expect(r.status).toBe("disabled");
    nothingCalled();
  });

  it("the activity kill switch stops it too", async () => {
    const r = await poll(env({ ENABLE_ACTIVITY_SYNC: "false" }));
    expect(r.status).toBe("disabled");
    expect(r.reason).toMatch(/ENABLE_ACTIVITY_SYNC/);
    nothingCalled();
  });

  /** WM shares this source. It must never poll, whatever else its config says. */
  it("the Work Management Worker (no ENABLE_CRM) never polls", async () => {
    const r = await poll(env({ ENABLE_CRM: undefined }));
    expect(r.status).toBe("refused");
    nothingCalled();
  });

  it("refuses while the monday activity type does not exist yet, and says why", async () => {
    MONDAY_ACTIVITY_TYPE.marketing_emails = "";
    const log = vi.spyOn(console, "log");
    const r = await poll();
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/activity type/);
    expect(log.mock.calls.flat().join("\n")).toMatch(/\[mkt-poller\] action=refused reason=".*activity type/);
    nothingCalled();
  });

  it.each([undefined, "", "soon", "2026"])("MARKETING_CUTOVER_AT=%j fails closed", async (v) => {
    const r = await poll(env({ MARKETING_CUTOVER_AT: v }));
    expect(r.status).toBe("refused");
    nothingCalled();
  });

  it("a poll already in progress means this one does nothing", async () => {
    reg.acquireLock.mockResolvedValueOnce(false);
    const r = await poll();
    expect(r.status).toBe("busy");
    expect(hubspot.hs).not.toHaveBeenCalled();
  });

  it("the lock is released however the poll ends", async () => {
    reg.getWatermark.mockRejectedValueOnce(new Error("durable object unreachable"));
    await expect(poll()).rejects.toThrow(/unreachable/);
    expect(reg.releaseLock).toHaveBeenCalled();
  });
});

describe("the live cursor", () => {
  it("the first run starts AT the cutover -- never before it, never 'now'", async () => {
    await poll();
    expect(Number(st.eventCalls[0].get("startTimestamp"))).toBe(at(CUTOVER));
  });

  it("re-reads OVERLAP_MS behind a stored watermark", async () => {
    reg.marks.set(WM_LIVE, "2026-09-30T08:00:00.000Z");
    await poll();
    expect(Number(st.eventCalls[0].get("startTimestamp"))).toBe(at("2026-09-30T08:00:00Z") - OVERLAP_MS);
  });

  it("asks HubSpot without bot-filtered events, 1000 at a time", async () => {
    await poll();
    expect(st.eventCalls[0].get("excludeFilteredEvents")).toBe("true");
    expect(st.eventCalls[0].get("limit")).toBe("1000");
  });

  it("follows offset paging to the end of a window", async () => {
    const s = sendTo("a@x.com", "2026-09-30T09:00:00Z");
    customer("a@x.com", "1", "C1");
    st.eventsHandler = (q) => q.get("offset")
      ? { hasMore: false, events: [ev("DELIVERED", "a@x.com", s, "2026-09-30T09:01:00Z")] }
      : { hasMore: true, offset: "page2", events: [] };
    const r = await poll();
    expect(st.eventCalls.some(q => q.get("offset") === "page2")).toBe(true);
    expect(r.written).toBe(1);
  });

  it("halves a window that holds more events than one slice may take", async () => {
    let calls = 0;
    st.eventsHandler = (q) => {
      calls++;
      const span = Number(q.get("endTimestamp")) - Number(q.get("startTimestamp"));
      return span > 3_600_000 ? { hasMore: true, offset: String(calls), events: [] } : { hasMore: false, events: [] };
    };
    await poll();
    expect(st.eventCalls.some(q => Number(q.get("endTimestamp")) - Number(q.get("startTimestamp")) <= 3_600_000)).toBe(true);
  });

  it("writes a DELIVERED send once, on the contact's card, under the marketing type, and advances", async () => {
    const s = sendTo("cust@x.com", "2026-09-30T09:00:00Z");
    customer("cust@x.com", "501", "CARD-501");
    st.events = [ev("DELIVERED", "cust@x.com", s, "2026-09-30T09:00:30Z")];
    const r = await poll();

    expect(r.written).toBe(1);
    expect(st.creates[0]).toMatchObject({ i: "CARD-501", a: TYPE, ts: new Date(s.created).toISOString() });
    expect(st.creates[0].t).toBe("Marketing email: Your Place Is Confirmed");
    expect(st.creates[0].u).toBe("https://app-na2.hubspot.com/email/39939588/details/555/performance");
    expect(reg.settled.get(reg.k(MARKETING_OBJECTS.send, eventKey(s.id, s.created), "contact", "501"))).toBe("T1");
    expect(reg.marks.get(WM_LIVE)).toBeDefined();
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeGreaterThanOrEqual(at("2026-09-30T09:00:30Z"));
  });

  it("looks the contact up BY EMAIL, and each campaign once per run", async () => {
    const s1 = sendTo("a@x.com", "2026-09-30T09:00:00Z"), s2 = sendTo("b@x.com", "2026-09-30T09:00:00Z");
    customer("a@x.com", "1", "C1"); customer("b@x.com", "2", "C2");
    st.events = [ev("DELIVERED", "a@x.com", s1, "2026-09-30T09:01:00Z"), ev("DELIVERED", "b@x.com", s2, "2026-09-30T09:02:00Z")];
    await poll();
    const batch = hubspot.hs.mock.calls.find(c => c[2] === "/crm/v3/objects/contacts/batch/read")!;
    expect(batch[3]).toMatchObject({ idProperty: "email" });
    expect(st.hsCalls.filter(c => c.startsWith("GET /email/public/v1/campaigns/"))).toHaveLength(1);
  });

  it("a second poll over the same events writes nothing", async () => {
    const s = sendTo("cust@x.com", "2026-09-30T09:00:00Z");
    customer("cust@x.com", "501", "CARD-501");
    st.events = [ev("DELIVERED", "cust@x.com", s, "2026-09-30T09:00:30Z")];
    await poll();
    reg.marks.clear();                               // even a full rewind
    const r = await poll();
    expect(r.written).toBe(0);
    expect(st.creates).toHaveLength(1);
    expect(r.excluded["already-written"]).toBe(1);
  });

  /** Claim-once: the FIRST open and the FIRST click, across polls, however many HubSpot reports. */
  it("first open and first click are written once each, even as later ones keep arriving", async () => {
    const s = sendTo("cust@x.com", "2026-09-30T08:00:00Z");
    customer("cust@x.com", "501", "CARD-501");
    st.events = [ev("OPEN", "cust@x.com", s, "2026-09-30T08:10:00Z"), ev("CLICK", "cust@x.com", s, "2026-09-30T08:11:00Z", { url: "https://u" })];
    await poll();
    st.events.push(ev("OPEN", "cust@x.com", s, "2026-09-30T10:00:00Z"), ev("CLICK", "cust@x.com", s, "2026-09-30T10:01:00Z", { url: "https://v" }));
    reg.marks.clear();
    await poll();
    expect(st.creates.map(c => c.t)).toEqual(["Marketing email opened: Your Place Is Confirmed",
      "Marketing email clicked: Your Place Is Confirmed"]);
  });
});

describe("who gets an entry", () => {
  it("staff -- owners and the company's domains -- are never written and never even looked up", async () => {
    const s1 = sendTo("rep@dkmeco.com", "2026-09-30T09:00:00Z"), s2 = sendTo("x@dkmeco.com.sg", "2026-09-30T09:00:00Z");
    customer("rep@dkmeco.com", "7", "C7"); customer("x@dkmeco.com.sg", "8", "C8");
    st.events = [ev("DELIVERED", "rep@dkmeco.com", s1, "2026-09-30T09:01:00Z"), ev("DELIVERED", "x@dkmeco.com.sg", s2, "2026-09-30T09:02:00Z")];
    const r = await poll();
    expect(r.written).toBe(0);
    expect(r.excluded.staff).toBe(2);
    expect(hubspot.hs.mock.calls.some(c => c[2] === "/crm/v3/objects/contacts/batch/read")).toBe(false);
  });

  it("FAILS CLOSED when the staff list cannot be read: nothing written, cursor unchanged", async () => {
    sync.staffEmails.mockRejectedValueOnce(new Error("owners 500"));
    customer("cust@x.com", "501", "CARD-501");
    st.events = [ev("DELIVERED", "cust@x.com", sendTo("cust@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:00:30Z")];
    const r = await poll();
    expect(r.written).toBe(0);
    expect(r.failures).toBe(1);
    expect(st.eventCalls).toHaveLength(0);
    expect(reg.setWatermark).not.toHaveBeenCalled();
  });

  it("a recipient with no HubSpot contact is skipped, and the cursor moves past them", async () => {
    st.events = [ev("DELIVERED", "stranger@x.com", sendTo("stranger@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:00:30Z")];
    const r = await poll();
    expect(r.written).toBe(0);
    expect(r.excluded["unknown-recipient"]).toBe(1);
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeGreaterThanOrEqual(at("2026-09-30T09:00:30Z"));
  });

  it("the canary scope writes only its contacts, and keeps its OWN cursor", async () => {
    customer("a@x.com", "1", "C1"); customer("b@x.com", "2", "C2");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z"),
                 ev("DELIVERED", "b@x.com", sendTo("b@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:02:00Z")];
    const r = await poll(env({ MARKETING_CANARY_CONTACT_IDS: "2" }));
    expect(st.creates.map(c => c.i)).toEqual(["C2"]);
    expect(r.excluded["outside-canary"]).toBe(1);
    expect(reg.marks.has(WM_LIVE)).toBe(false);            // production cursor untouched
    expect(reg.marks.has(WM_LIVE + ":canary")).toBe(true);
    // ...so lifting the canary later still delivers contact 1, and does not repeat contact 2.
    await poll();
    expect(st.creates.map(c => c.i)).toEqual(["C2", "C1"]);
  });

  it("the canary is NOT the activity canary: ACTIVITY_CANARY_* does not scope marketing", async () => {
    customer("a@x.com", "1", "C1");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
    const r = await poll(env({ ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "999" }));
    expect(r.written).toBe(1);
  });
});

describe("a card that is not there yet", () => {
  it("waits (stops without advancing past it) while the event is under an hour old", async () => {
    st.contacts["new@x.com"] = "900";                       // contact, but no card yet
    const created = NOW - 10 * 60_000;
    st.events = [ev("DELIVERED", "new@x.com", { id: "s-new", created: created - 1000 }, new Date(created).toISOString())];
    const r = await poll();
    expect(r.written).toBe(0);
    const wm = reg.marks.get(WM_LIVE);
    expect(wm === undefined || Date.parse(wm) < created).toBe(true);
  });

  it("gives up after the grace period: skipped, logged as abandoned, cursor moves on", async () => {
    st.contacts["gone@x.com"] = "901";
    const created = NOW - NO_CARD_GRACE_MS - 60_000;
    st.events = [ev("DELIVERED", "gone@x.com", { id: "s-gone", created: created - 1000 }, new Date(created).toISOString())];
    const log = vi.spyOn(console, "log");
    const r = await poll();
    expect(r.excluded["no-card"]).toBe(1);
    expect(log.mock.calls.flat().join("\n")).toContain("action=abandoned reason=no-card");
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeGreaterThanOrEqual(created);
  });
});

describe("the per-poll cap and stopping on failure", () => {
  const five = () => {
    for (let i = 1; i <= 5; i++) {
      customer(`c${i}@x.com`, String(i), `C${i}`);
      st.events.push(ev("DELIVERED", `c${i}@x.com`, sendTo(`c${i}@x.com`, "2026-09-30T09:00:00Z"), `2026-09-30T09:0${i}:00Z`));
    }
  };

  it("never writes more than MARKETING_MAX_WRITES_PER_POLL, and resumes where it stopped", async () => {
    five();
    const r = await poll(env({ MARKETING_MAX_WRITES_PER_POLL: "2" }));
    expect(r.written).toBe(2);
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeLessThan(at("2026-09-30T09:03:00Z"));
    await poll(env({ MARKETING_MAX_WRITES_PER_POLL: "2" }));
    await poll(env({ MARKETING_MAX_WRITES_PER_POLL: "2" }));
    expect(st.creates.map(c => c.i)).toEqual(["C1", "C2", "C3", "C4", "C5"]);
  });

  it("defaults to 60 writes a poll", () => expect(P.maxWritesPerPoll(env())).toBe(60));

  it("an on-demand limit can only LOWER the cap", async () => {
    five();
    expect((await poll(env(), { maxWrites: 1 })).written).toBe(1);
    expect(P.maxWritesPerPoll(env({ MARKETING_MAX_WRITES_PER_POLL: "abc" }))).toBe(60);
  });

  it("stops at the first failed write and does not advance past it", async () => {
    five();
    st.createFail = [null, new Error("monday 500: boom")];
    const r = await poll();
    expect(r.written).toBe(1);
    expect(r.failures).toBe(1);
    expect(st.creates.map(c => c.i)).toEqual(["C1"]);       // C3..C5 not attempted
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeLessThan(at("2026-09-30T09:02:00Z"));
    // The failed create may have landed: its reservation STANDS.
    expect(reg.unresolvedActivityToMonday).toHaveBeenCalled();
    expect(reg.releaseActivity).not.toHaveBeenCalled();
  });

  it("a monday rate limit releases the reservation (it provably never ran) and stops", async () => {
    five();
    const e = new Error("rate-limited"); e.name = "MondayRateLimitedError";
    st.createFail = [e];
    const r = await poll();
    expect(r.written).toBe(0);
    expect(reg.releaseActivity).toHaveBeenCalledTimes(1);
    expect(reg.writeNote.mock.calls.some(c => String(c[1]).startsWith("mkt-tries:"))).toBe(false);   // not poison
    await poll();
    expect(st.creates.map(c => c.i)).toEqual(["C1", "C2", "C3", "C4", "C5"]);
  });

  it("an in-flight reservation defers rather than writes -- and COUNTS as a failure, on the poison clock", async () => {
    five();
    const s1 = st.events[0].sentBy;
    const key = eventKey(s1.id, s1.created);
    reg.reserved.add(reg.k(MARKETING_OBJECTS.send, key, "contact", "1"));
    const log = vi.spyOn(console, "log");
    const r = await poll();
    expect(r.written).toBe(0);
    expect(st.creates).toHaveLength(0);
    expect(r.failures).toBe(1);                                  // used to report failures=0 while stalled
    expect(log.mock.calls.flat().join("\n")).toMatch(/action=failed .*reservation-in-flight/);
    expect(reg.notes.get(`mkt-tries:${MARKETING_OBJECTS.send}:${key}:1`)).toBe(`1|${NOW}`);
  });

  it("a campaign lookup that fails (not a 404) stops the slice without advancing", async () => {
    five();
    st.campaignFail = "hubspot GET /email/public/v1/campaigns/100: 500 oops";
    const r = await poll();
    expect(r.written).toBe(0);
    expect(r.failures).toBeGreaterThan(0);
    // The empty day BEFORE the failing slice is kept (a throw no longer discards earlier slices'
    // progress); nothing at or after the first unhandled event is claimed.
    const wm = reg.marks.get(WM_LIVE);
    expect(wm === undefined || Date.parse(wm) < at("2026-09-30T09:01:00Z")).toBe(true);
  });

  it("a campaign that 404s is excluded, and the cursor moves on", async () => {
    customer("a@x.com", "1", "C1");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z", { emailCampaignId: 404 })];
    const r = await poll();
    expect(r.excluded["campaign-unknown"]).toBe(1);
    expect(reg.setWatermark).toHaveBeenCalled();
  });
});

describe("stale reservations", () => {
  const one = () => {
    customer("a@x.com", "1", "C1");
    const s = sendTo("a@x.com", "2026-09-30T09:00:00Z");
    st.events = [ev("DELIVERED", "a@x.com", s, "2026-09-30T09:01:00Z")];
    reg.stale.add(reg.k(MARKETING_OBJECTS.send, eventKey(s.id, s.created), "contact", "1"));
    return s;
  };

  it("an inherited reservation checks the card first; already there -> settle, no second copy", async () => {
    one();
    sync.alreadyOnCard.mockResolvedValueOnce("present");
    const r = await poll();
    expect(st.creates).toHaveLength(0);
    expect(r.excluded["already-on-card"]).toBe(1);
  });

  it("and if the card cannot be read, it does NOT write", async () => {
    one();
    sync.alreadyOnCard.mockResolvedValueOnce("unknown");
    const r = await poll();
    expect(st.creates).toHaveLength(0);
    expect(r.failures).toBe(1);
  });

  it("a fresh reservation never walks the card", async () => {
    customer("a@x.com", "1", "C1");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
    await poll();
    expect(sync.alreadyOnCard).not.toHaveBeenCalled();
  });
});

describe("poison events", () => {
  it("an entry that keeps failing is dead-lettered and stepped over, so the feed survives", async () => {
    customer("a@x.com", "1", "C1"); customer("b@x.com", "2", "C2");
    const sa = sendTo("a@x.com", "2026-09-30T09:00:00Z");
    st.events = [ev("DELIVERED", "a@x.com", sa, "2026-09-30T09:01:00Z"),
                 ev("DELIVERED", "b@x.com", sendTo("b@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:02:00Z")];
    const tries = `mkt-tries:${MARKETING_OBJECTS.send}:${eventKey(sa.id, sa.created)}:1`;
    reg.notes.set(tries, `${POISON_TRIES - 1}|${NOW - 2 * 3_600_000}`);
    st.createFail = [new Error("monday 400: invalid content")];
    const r = await poll();
    expect(r.deadLettered).toBe(1);
    expect(retry.record).toHaveBeenCalledWith(expect.objectContaining({ object: MARKETING_OBJECTS.send,
      hubspotId: `${eventKey(sa.id, sa.created)}:contact:1` }));
    expect(st.creates.map(c => c.i)).toEqual(["C2"]);        // the feed carried on
    expect(reg.notes.get(tries)).toMatch(/\|dead$/);
  });

  it("but not before it has failed for a while: a burst of fast failures only counts", async () => {
    customer("a@x.com", "1", "C1");
    const sa = sendTo("a@x.com", "2026-09-30T09:00:00Z");
    st.events = [ev("DELIVERED", "a@x.com", sa, "2026-09-30T09:01:00Z")];
    const tries = `mkt-tries:${MARKETING_OBJECTS.send}:${eventKey(sa.id, sa.created)}:1`;
    reg.notes.set(tries, `${POISON_TRIES + 3}|${NOW - 60_000}`);
    st.createFail = [new Error("monday 500")];
    const r = await poll();
    expect(r.deadLettered).toBe(0);
    expect(reg.notes.get(tries)).toBe(`${POISON_TRIES + 4}|${NOW - 60_000}`);
  });
});

describe("dry run", () => {
  const setup = () => {
    customer("a@x.com", "1", "C1");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
  };
  const nothingDurable = () => {
    expect(monday.gql).not.toHaveBeenCalled();
    expect(reg.claimActivityToMonday).not.toHaveBeenCalled();
    expect(reg.settleActivityToMonday).not.toHaveBeenCalled();
    expect(reg.setWatermark).not.toHaveBeenCalled();
    expect(reg.writeNote).not.toHaveBeenCalled();
    expect(reg.acquireLock).not.toHaveBeenCalled();
  };

  it("DRY_RUN=true reads, plans and reports -- and writes nothing, not even a cursor", async () => {
    setup();
    const r = await poll(env({ DRY_RUN: "true" }));
    expect(r.dryRun).toBe(true);
    expect(r.wouldWrite).toBe(1);
    expect(r.sample[0]).toMatchObject({ cardId: "C1", contactId: "1" });
    nothingDurable();
  });

  it("an explicit dryRun forces it even on a live Worker", async () => {
    setup();
    const r = await poll(env({ DRY_RUN: "false" }), { dryRun: true });
    expect(r.wouldWrite).toBe(1);
    nothingDurable();
  });
});

describe("backfill and the daily re-read", () => {
  it("live work runs BEFORE the backfill, and the backfill gets only what is left of the cap", async () => {
    customer("live@x.com", "1", "C1"); customer("old@x.com", "2", "C2");
    st.events = [ev("DELIVERED", "old@x.com", sendTo("old@x.com", "2026-09-20T09:00:00Z"), "2026-09-20T09:01:00Z"),
                 ev("DELIVERED", "live@x.com", sendTo("live@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
    const r = await poll(env({ MARKETING_BACKFILL_FROM: "2026-09-19T00:00:00Z", MARKETING_MAX_WRITES_PER_POLL: "1" }));
    expect(r.written).toBe(1);
    expect(st.creates[0].i).toBe("C1");
    await poll(env({ MARKETING_BACKFILL_FROM: "2026-09-19T00:00:00Z", MARKETING_MAX_WRITES_PER_POLL: "1" }));
    expect(st.creates.map(c => c.i)).toEqual(["C1", "C2"]);
  });

  it("the backfill walks empty days forward, and stops at the cutover", async () => {
    await poll(env({ MARKETING_BACKFILL_FROM: "2026-09-25T00:00:00Z" }));
    expect(reg.marks.get(WM_BACKFILL)).toBe(new Date(at(CUTOVER)).toISOString());
    st.eventCalls = [];
    reg.writeNote.mockClear();
    await poll(env({ MARKETING_BACKFILL_FROM: "2026-09-25T00:00:00Z" }));
    expect(st.eventCalls.every(q => Number(q.get("startTimestamp")) >= at(CUTOVER) - OVERLAP_MS)).toBe(true);
  });

  it("no backfill unless MARKETING_BACKFILL_FROM is a real instant before the cutover", async () => {
    for (const v of [undefined, "", "yesterday", "2026-10-01T00:00:00Z"]) {
      st.eventCalls = [];
      await poll(env({ MARKETING_BACKFILL_FROM: v }));
      expect(st.eventCalls.every(q => Number(q.get("startTimestamp")) >= at(CUTOVER))).toBe(true);
    }
    expect(reg.marks.has(WM_BACKFILL)).toBe(false);
  });

  it("re-reads the last 48 hours once a day, whatever the watermark says", async () => {
    reg.marks.set(WM_LIVE, new Date(NOW - 60 * 60_000).toISOString());
    const cut = env({ MARKETING_CUTOVER_AT: "2026-09-01T00:00:00Z" });
    await poll(cut);
    const reread = (qs: URLSearchParams[]) => qs.filter(q => Number(q.get("startTimestamp")) === NOW - 48 * 3_600_000);
    expect(reread(st.eventCalls)).toHaveLength(1);
    expect(reg.notes.get(NOTE_REREAD)).toBe("2026-09-30");
    st.eventCalls = [];
    await poll(cut);
    expect(reread(st.eventCalls)).toHaveLength(0);
  });

  it("the re-read finds an event indexed late, behind the watermark", async () => {
    customer("late@x.com", "3", "C3");
    reg.marks.set(WM_LIVE, new Date(NOW - 60 * 60_000).toISOString());
    st.events = [ev("DELIVERED", "late@x.com", sendTo("late@x.com", "2026-09-29T20:00:00Z"), "2026-09-29T20:01:00Z")];
    const r = await poll(env({ MARKETING_CUTOVER_AT: "2026-09-01T00:00:00Z" }));
    expect(r.written).toBe(1);
    expect(r.reread).toBe("done");
  });
});

describe("the rollback ledger and the log line", () => {
  it("records every created entry, readable by hour", async () => {
    customer("a@x.com", "1", "C1");
    const s = sendTo("a@x.com", "2026-09-30T09:00:00Z");
    st.events = [ev("DELIVERED", "a@x.com", s, "2026-09-30T09:01:00Z")];
    await poll();
    const hour = new Date().toISOString().slice(0, 13);
    expect(reg.notes.get(ledgerName(hour))).toBe(`T1|C1|${MARKETING_OBJECTS.send}|${eventKey(s.id, s.created)}|1`);
    expect(await P.readLedger(env(), hour)).toEqual([["T1", "C1", MARKETING_OBJECTS.send, eventKey(s.id, s.created), "1"]]);
  });

  it("ends with one structured summary line", async () => {
    const log = vi.spyOn(console, "log");
    await poll();
    expect(log.mock.calls.flat().join("\n"))
      .toMatch(/\[mkt-poller\] scanned=\d+ planned=\d+ written=\d+ wouldWrite=\d+ skipped=\d+ failures=\d+ dead=\d+ watermark=/);
  });
});

/* ============================================================== the review's findings, one by one */

const H = 3_600_000;

describe("the cutover can never open a gap nobody reads", () => {
  it("refuses a cutover in the FUTURE -- events between now and then would be read by nobody", async () => {
    const r = await poll(env({ MARKETING_CUTOVER_AT: "2026-10-05T00:00:00Z", MARKETING_BACKFILL_FROM: "2026-09-28T00:00:00Z" }));
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/in the future/);
    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(reg.setWatermark).not.toHaveBeenCalled();
    expect(P.marketingGate(env({ MARKETING_CUTOVER_AT: "2026-09-30T11:00:00Z" }), NOW).ok).toBe(true);
  });

  it("the backfill never vouches past now - SETTLE_MS, even with a cutover minutes old", async () => {
    const cut = env({ MARKETING_CUTOVER_AT: "2026-09-30T11:50:00Z", MARKETING_BACKFILL_FROM: "2026-09-30T00:00:00Z" });
    customer("gap@x.com", "7", "C7");
    // Between now - SETTLE_MS and the cutover: the backfill owns it, but must not claim it yet.
    st.events = [ev("DELIVERED", "gap@x.com", sendTo("gap@x.com", "2026-09-30T11:39:00Z"), "2026-09-30T11:40:00Z")];
    await poll(cut);
    expect(st.creates).toHaveLength(0);
    expect(Date.parse(reg.marks.get(WM_BACKFILL)!)).toBeLessThanOrEqual(NOW - P.SETTLE_MS);
    // Half an hour later it is settled, and the backfill -- not a lucky overlap -- delivers it.
    await poll(cut, { nowMs: NOW + 30 * 60_000 });
    expect(st.creates.map(c => c.i)).toEqual(["C7"]);
    expect(reg.marks.get(WM_BACKFILL)).toBe("2026-09-30T11:50:00.000Z");
  });

  it("a cutover moved PAST the stored live watermark does not jump the gap: it reads on, loudly", async () => {
    reg.marks.set(WM_LIVE, "2026-09-30T06:00:00.000Z");
    customer("mid@x.com", "8", "C8");
    st.events = [ev("DELIVERED", "mid@x.com", sendTo("mid@x.com", "2026-09-30T08:00:00Z"), "2026-09-30T08:01:00Z")];
    const r = await poll(env({ MARKETING_CUTOVER_AT: "2026-09-30T10:00:00Z" }));
    expect(Number(st.eventCalls[0].get("startTimestamp"))).toBe(at("2026-09-30T06:00:00Z") - OVERLAP_MS);
    expect(st.creates.map(c => c.i)).toEqual(["C8"]);
    expect(r.warnings.join("\n")).toMatch(/later than the stored live watermark/);
  });
});

describe("a failure that repeats cannot hold the feed forever", () => {
  it("a campaign answering 400 is an ANSWER about that campaign: excluded, counted, and the feed moves on", async () => {
    customer("a@x.com", "1", "C1"); customer("b@x.com", "2", "C2");
    st.campaignFailById["400"] = "hubspot GET /email/public/v1/campaigns/400: 400 {\"message\":\"unsupported type\"}";
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z", { emailCampaignId: 400 }),
                 ev("DELIVERED", "b@x.com", sendTo("b@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:02:00Z")];
    for (let i = 0; i < 3; i++) await poll();                 // persistent -- the same answer every poll
    expect(st.creates.map(c => c.i)).toEqual(["C2"]);
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeGreaterThanOrEqual(at("2026-09-30T09:02:00Z"));
  });

  it("but a MISSING-SCOPE 403 is the token, not the campaign: it stops the feed and excludes nothing", async () => {
    customer("a@x.com", "1", "C1");
    st.campaignFailById["100"] = 'hubspot GET /email/public/v1/campaigns/100: 403 {"category":"MISSING_SCOPES"}';
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
    const r = await poll();
    expect(r.failures).toBeGreaterThan(0);
    expect(Object.keys(r.excluded).some(k => k.startsWith("campaign"))).toBe(false);
    const wm = reg.marks.get(WM_LIVE);
    expect(wm === undefined || Date.parse(wm) < at("2026-09-30T09:01:00Z")).toBe(true);
    expect(reg.notes.has(P.campaignTriesName("100"))).toBe(false);   // not on a poison clock either
  });

  it("a campaign that keeps failing with a 5xx is poisoned, dead-lettered and stepped over", async () => {
    customer("a@x.com", "1", "C1");
    st.campaignFailById["100"] = "hubspot GET /email/public/v1/campaigns/100: 500 oops";
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
    const first = await poll();
    expect(first.failures).toBeGreaterThan(0);
    expect(reg.notes.get(P.campaignTriesName("100"))).toBe(`1|${NOW}`);
    reg.notes.set(P.campaignTriesName("100"), `${POISON_TRIES - 1}|${NOW - 2 * H}`);
    const r = await poll();
    expect(r.excluded["campaign-unreadable"]).toBe(1);
    expect(r.deadLettered).toBe(1);
    expect(retry.record).toHaveBeenCalledWith(expect.objectContaining({ object: "marketing_email_campaigns", hubspotId: "100" }));
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeGreaterThanOrEqual(at("2026-09-30T09:01:00Z"));
  });

  it("one malformed recipient does not block the other ninety-nine: the batch is split down to it", async () => {
    customer("a@x.com", "1", "C1"); customer("b@x.com", "2", "C2");
    st.badEmails.add("bad@@x.com");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z"),
                 ev("DELIVERED", "bad@@x.com", sendTo("bad@@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:02:00Z"),
                 ev("DELIVERED", "b@x.com", sendTo("b@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:03:00Z")];
    const r = await poll();
    expect(st.creates.map(c => c.i)).toEqual(["C1", "C2"]);
    expect(r.excluded["recipient-unreadable"]).toBe(1);
    expect(r.excluded["unknown-recipient"]).toBe(1);
    expect(r.failures).toBe(0);
  });

  it("a slice too dense to read fails until its poison clock runs out, then is stepped over LOUDLY", async () => {
    st.eventsHandler = () => ({ hasMore: true, offset: "more", events: [] });
    const first = await poll();
    expect(first.failures).toBeGreaterThan(0);
    expect(reg.marks.has(WM_LIVE)).toBe(false);
    const name = P.sliceTriesName("live", at(CUTOVER));
    expect(reg.notes.get(name)).toBe(`1|${NOW}`);
    reg.notes.set(name, `${POISON_TRIES - 1}|${NOW - 2 * H}`);
    const r = await poll();
    expect(r.excluded["slice-too-dense"]).toBe(1);
    expect(r.warnings.join("\n")).toMatch(/NOT read/);
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeGreaterThan(at(CUTOVER));
    expect(Date.parse(reg.marks.get(WM_LIVE)!) - at(CUTOVER)).toBeLessThanOrEqual(P.MIN_SLICE_MS);
  });

  it("an entry stuck on its own reservation is dead-lettered by AGE, not after hours of polls", async () => {
    customer("a@x.com", "1", "C1"); customer("b@x.com", "2", "C2");
    const sa = sendTo("a@x.com", "2026-09-30T09:00:00Z");
    st.events = [ev("DELIVERED", "a@x.com", sa, "2026-09-30T09:01:00Z"),
                 ev("DELIVERED", "b@x.com", sendTo("b@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:02:00Z")];
    const key = eventKey(sa.id, sa.created);
    reg.reserved.add(reg.k(MARKETING_OBJECTS.send, key, "contact", "1"));
    reg.notes.set(`mkt-tries:${MARKETING_OBJECTS.send}:${key}:1`, `${POISON_TRIES - 1}|${NOW - P.POISON_MIN_AGE_MS - 60_000}`);
    const r = await poll();
    expect(r.deadLettered).toBe(1);
    expect(st.creates.map(c => c.i)).toEqual(["C2"]);        // the rest of the feed carried on
  });

  it("a dead-lettered entry reached again (overlap, re-read) is skipped BEFORE any card lookup, and stops nothing", async () => {
    customer("a@x.com", "1", "C1"); customer("b@x.com", "2", "C2");
    const sa = sendTo("a@x.com", "2026-09-30T09:00:00Z");
    st.events = [ev("DELIVERED", "a@x.com", sa, "2026-09-30T09:01:00Z"),
                 ev("DELIVERED", "b@x.com", sendTo("b@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:02:00Z")];
    reg.notes.set(`mkt-tries:${MARKETING_OBJECTS.send}:${eventKey(sa.id, sa.created)}:1`, `6|${NOW - 5 * H}|dead`);
    const r = await poll();
    expect(r.excluded["dead-lettered-earlier"]).toBe(1);
    expect(monday.findItemByColumn.mock.calls.some(c => c[3] === "1")).toBe(false);
    expect(reg.claimActivityToMonday.mock.calls.some(c => c[4] === "1")).toBe(false);
    expect(st.creates.map(c => c.i)).toEqual(["C2"]);
    expect(r.failures).toBe(0);
  });
});

describe("the watermark and the wall clock", () => {
  it("a recent entry never pulls the live watermark past now - SETTLE_MS", async () => {
    customer("fresh@x.com", "9", "C9");
    st.events = [ev("DELIVERED", "fresh@x.com", { id: "s-fresh", created: NOW - 6 * 60_000 }, new Date(NOW - 5 * 60_000).toISOString())];
    const r = await poll();
    expect(r.written).toBe(1);
    expect(Date.parse(reg.marks.get(WM_LIVE)!)).toBeLessThanOrEqual(NOW - P.SETTLE_MS);
    st.eventCalls = [];
    await poll();
    expect(Number(st.eventCalls[0].get("startTimestamp"))).toBeLessThanOrEqual(NOW - P.SETTLE_MS - OVERLAP_MS);
  });

  it("MARKETING_MAX_WRITES_PER_POLL=\"0\" PAUSES writes -- it no longer means the default 60", async () => {
    expect(P.maxWritesPerPoll(env({ MARKETING_MAX_WRITES_PER_POLL: "0" }))).toBe(0);
    const r = await poll(env({ MARKETING_MAX_WRITES_PER_POLL: "0" }));
    expect(r.status).toBe("disabled");
    expect(r.reason).toMatch(/paused/);
    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(reg.acquireLock).not.toHaveBeenCalled();
  });

  it("the lock is owner-checked: released with the same run id it was taken with", async () => {
    await poll();
    const owner = (reg.acquireLock.mock.calls[0] as unknown[])[3];
    expect(String(owner)).toMatch(/^\d+-/);
    expect(reg.releaseLock).toHaveBeenCalledWith(expect.anything(), "marketing-email-poll", owner);
  });

  it("no claim starts with less than CREATE_RESERVE_MS of the budget left", async () => {
    for (let i = 1; i <= 2; i++) {
      customer(`c${i}@x.com`, String(i), `C${i}`);
      st.events.push(ev("DELIVERED", `c${i}@x.com`, sendTo(`c${i}@x.com`, "2026-09-30T09:00:00Z"), `2026-09-30T09:0${i}:00Z`));
    }
    let clock = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const base = monday.gql.getMockImplementation()!;
    monday.gql.mockImplementation(async (...a: any[]) => {
      const out = await (base as any)(...a);
      clock += P.POLL_BUDGET_MS - 60_000;                   // the first create ate almost the whole budget
      return out;
    });
    try {
      const r = await poll();
      expect(st.creates.map(c => c.i)).toEqual(["C1"]);
      expect(reg.claimActivityToMonday).toHaveBeenCalledTimes(1);
      expect(r.failures).toBe(0);                             // a budget stop, not a failure
    } finally { spy.mockRestore(); }
  });

  it("the create and the card lookup sit through fewer monday rate-limit waits than the default", async () => {
    customer("a@x.com", "1", "C1");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
    await poll();
    expect(monday.findItemByColumn.mock.calls[0][4]).toBe(P.POLL_RATE_WAITS);
    const create = monday.gql.mock.calls.find(c => String(c[1]).includes("create_timeline_item"))!;
    expect(create.slice(3)).toEqual([1, P.POLL_RATE_WAITS]);
  });
});

describe("the ledger never loses rows it could not read", () => {
  const one = () => {
    customer("a@x.com", "1", "C1");
    st.events = [ev("DELIVERED", "a@x.com", sendTo("a@x.com", "2026-09-30T09:00:00Z"), "2026-09-30T09:01:00Z")];
  };
  const hour = () => new Date().toISOString().slice(0, 13);

  it("an UNREADABLE page is left alone; the row goes to the next page", async () => {
    one();
    reg.notes.set(ledgerName(hour()), "T0|C0|marketing_emails|k_0|0");
    reg.strictFail.add(ledgerName(hour()));
    await poll();
    expect(reg.notes.get(ledgerName(hour()))).toBe("T0|C0|marketing_emails|k_0|0");
    expect(reg.notes.get(ledgerName(hour(), 1))).toMatch(/^T1\|C1\|/);
    expect((await P.readLedger(env(), hour())).map(r => r[0])).toEqual(["T0", "T1"]);
  });

  it("a full page spills to the next, so no hour outgrows one Durable Object value", async () => {
    one();
    reg.notes.set(ledgerName(hour()), "x".repeat(P.LEDGER_PAGE_CHARS - 3));
    await poll();
    expect(reg.notes.get(ledgerName(hour()))!.length).toBe(P.LEDGER_PAGE_CHARS - 3);
    expect(reg.notes.get(ledgerName(hour(), 1))).toMatch(/^T1\|/);
  });
});

describe("the re-read is bounded and resumable, and does not hold the backfill", () => {
  it("stops at MAX_REREAD_ENTRIES, records where, resumes there -- and the backfill still ran", async () => {
    reg.marks.set(WM_LIVE, new Date(NOW - H).toISOString());
    const cut = env({ MARKETING_CUTOVER_AT: "2026-09-01T00:00:00Z", MARKETING_BACKFILL_FROM: "2026-08-31T00:00:00Z" });
    const n = P.MAX_REREAD_ENTRIES + 5;
    for (let i = 0; i < n; i++) {
      const to = `nobody${i}@x.com`;                          // unknown recipients: cheap, but each one counts
      st.events.push(ev("DELIVERED", to, { id: `s-rr${i}`, created: NOW - 40 * H + i * 1000 },
        new Date(NOW - 40 * H + i * 1000 + 500).toISOString()));
    }
    const r1 = await poll(cut);
    expect(r1.reread).toBe("incomplete");
    expect(reg.notes.get(NOTE_REREAD)).toMatch(/^2026-09-30\|\d+$/);
    expect(reg.marks.get(WM_BACKFILL)).toBe("2026-09-01T00:00:00.000Z");
    const pos = Number(reg.notes.get(NOTE_REREAD)!.split("|")[1]);
    st.eventCalls = [];
    const r2 = await poll(cut);
    expect(r2.reread).toBe("done");
    expect(reg.notes.get(NOTE_REREAD)).toBe("2026-09-30");
    expect(st.eventCalls.some(q => Number(q.get("startTimestamp")) === pos)).toBe(true);
  });
});
