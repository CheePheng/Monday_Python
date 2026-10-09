import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRecord, deleteAssociation, getOwners, getPropertyOptions, getRecord, hs, hsRateLimitRetryOn, hsRetry,
  hsRetryDeadlineOf, hsRetryWait, patchRecord, putAssociation, searchContactByEmail, searchObjects, withHsRetryDeadline,
} from "../src/hubspot";
import { CRM_CONTACTS } from "../src/config/crm";
import type { Env, RunOpts, WriteAuth } from "../src/types";
import { listSources, readCode, readFixture, readSource } from "../scripts/read-source.mjs";

/**
 * HS_RATE_LIMIT_RETRY: HUBSPOT RATE-LIMIT RESILIENCE IN hs() (hubspot.ts hsRateLimited / hsRetryWait), against
 * the REAL hubspot.ts with only `fetch` stubbed.
 *
 * Measured live 2026-10-05: reps bulk-edited dozens of Contacts cards at once, and ~40% of the person-edit
 * pushes failed with
 *   "hubspot GET /crm/v3/properties/contacts/hs_lead_status: 429 ... ten_secondly_rolling limit"
 * (and GET /crm/v3/properties/line_items/..., GET /crm/v3/owners/...): the context build's reads and the
 * record read (getRecord, retries=1: one attempt, no wait at all) threw on HubSpot's 10-second limit, and
 * the push was dropped. With the switch on, a GET waits as HubSpot's headers say and tries again; any other
 * method gets that retry only on a 429 and only when its caller already retries it; every retry hs() makes
 * today is still made, and no later than today makes it -- so the switch never gives up sooner than off,
 * except on HubSpot's daily limit, at any age of the invocation; what still fails throws exactly the error it
 * always threw. With the switch off, hs() is 3064076's loop, byte for byte.
 */

const ON = { HS_RATE_LIMIT_RETRY: "true", ENABLE_CRM: "true", HUBSPOT_ACCESS_TOKEN: "x" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 30 };
const auth = (forId: string): WriteAuth => ({ allowed: true, reason: "stamped crm", forId });

const RATE_BODY = JSON.stringify({ status: "error", message: "You have reached your ten_secondly_rolling limit.",
  errorType: "RATE_LIMIT", correlationId: "c033cdaa-2c40-4a64-ae48-b4cec88dad24", policyName: "TEN_SECONDLY_ROLLING" });
const DAILY_BODY = JSON.stringify({ status: "error", message: "You have reached your daily limit.",
  errorType: "RATE_LIMIT", policyName: "DAILY" });
const TEN_SECONDLY_HEADERS = {
  "X-HubSpot-RateLimit-Interval-Milliseconds": "10000", "X-HubSpot-RateLimit-Max": "190",
  "X-HubSpot-RateLimit-Remaining": "0", "X-HubSpot-RateLimit-Daily": "1000000",
  "X-HubSpot-RateLimit-Daily-Remaining": "999000",
};
/** HubSpot's 429 for the ten-second window, as it sends it. */
const tenSecondly = (): Response => new Response(RATE_BODY, { status: 429, headers: TEN_SECONDLY_HEADERS });
/** HubSpot's 429 for the DAILY limit: the remaining-today header at 0, and the body says so. */
const dailySpent = (): Response => new Response(DAILY_BODY, { status: 429, headers: {
  ...TEN_SECONDLY_HEADERS, "X-HubSpot-RateLimit-Daily-Remaining": "0" } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const contact = { id: "394787683005", properties: { lifecyclestage: "lead", lastmodifieddate: "2026-10-05T03:10:00Z" } };

let replies: (Response | Error | (() => Response))[] = [];
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
  const r = replies.shift();
  if (!r) throw new Error("no reply queued");
  if (r instanceof Error) throw r;
  return typeof r === "function" ? r() : r;
});

let slept: number[] = [];
const realSleep = hsRetry.sleep;
const realRandom = hsRetry.random;
let logs: string[];
const logged = (re: RegExp) => logs.some(l => re.test(l));
let originalFetch: typeof fetch;

beforeEach(() => {
  vi.clearAllMocks();
  replies = [];
  slept = [];
  hsRetry.sleep = async (ms: number) => { slept.push(ms); };
  hsRetry.random = () => 0.5;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as never;
});
afterEach(() => {
  hsRetry.sleep = realSleep;
  hsRetry.random = realRandom;
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ----------------------------------------------------------------------------------------- the switch

describe("HS_RATE_LIMIT_RETRY arms only as the literal \"true\", and only on the CRM Worker", () => {
  it("on", () => expect(hsRateLimitRetryOn({ HS_RATE_LIMIT_RETRY: "true", ENABLE_CRM: "true" })).toBe(true));

  it.each(["false", "TRUE", "True", "1", "yes", "", " true", undefined])("HS_RATE_LIMIT_RETRY=%j is off", (v) =>
    expect(hsRateLimitRetryOn({ HS_RATE_LIMIT_RETRY: v, ENABLE_CRM: "true" })).toBe(false));

  it("the WM Worker (no ENABLE_CRM) stays off even with the var leaked onto it", () => {
    expect(hsRateLimitRetryOn({ HS_RATE_LIMIT_RETRY: "true" })).toBe(false);
    expect(hsRateLimitRetryOn({ HS_RATE_LIMIT_RETRY: "true", ENABLE_CRM: "false" })).toBe(false);
  });

  it("the bounds are the ones the 30 s waitUntil was budgeted with: 5 attempts, 3 s per wait, 8 s per call", () => {
    expect(hsRetry.maxAttempts).toBe(5);
    expect(hsRetry.maxWaitMs).toBe(3_000);
    expect(hsRetry.maxTotalWaitMs).toBe(8_000);
    expect(hsRetry.baseMs).toBe(750);
  });
});

// ------------------------------------------------------------------------------------- the wait, pure

describe("hsRetryWait: how long, and whether, to wait (pure)", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const WINDOW = { "X-HubSpot-RateLimit-Interval-Milliseconds": "10000", "X-HubSpot-RateLimit-Remaining": "0" };

  describe("Retry-After is honoured", () => {
    it("in seconds, exactly", () =>
      expect(hsRetryWait(h({ "Retry-After": "2" }), 429, "", 1, 0, 0.5)).toEqual({ ms: 2000, basis: "retry-after" }));

    it("as an HTTP date, exactly", () => {
      const now = Date.parse("2026-10-05T03:10:00Z");
      expect(hsRetryWait(h({ "Retry-After": "Mon, 05 Oct 2026 03:10:02 GMT" }), 503, "", 1, 0, 0.5, now))
        .toEqual({ ms: 2000, basis: "retry-after" });
    });

    it("over the window headers beside it", () =>
      expect(hsRetryWait(h({ ...WINDOW, "Retry-After": "1" }), 429, RATE_BODY, 1, 0, 0.5))
        .toEqual({ ms: 1000, basis: "retry-after" }));

    it("a Retry-After of 0 (or a date already past) still waits the floor", () => {
      expect(hsRetryWait(h({ "Retry-After": "0" }), 429, "", 1, 0, 0.5)).toEqual({ ms: 250, basis: "retry-after" });
      expect(hsRetryWait(h({ "Retry-After": "Mon, 05 Oct 2026 03:09:00 GMT" }), 429, "", 1, 0, 0.5,
        Date.parse("2026-10-05T03:10:00Z"))).toEqual({ ms: 250, basis: "retry-after" });
    });

    it("exactly the 3 s cap is still a wait", () =>
      expect(hsRetryWait(h({ "Retry-After": "3" }), 429, "", 1, 0, 0.5)).toEqual({ ms: 3000, basis: "retry-after" }));

    it("asking for more than one wait may be: give up rather than retry early", () => {
      expect(hsRetryWait(h({ "Retry-After": "3.5" }), 429, "", 1, 0, 0.5))
        .toEqual({ stop: expect.stringContaining("Retry-After 3.5") });
      expect(hsRetryWait(h({ "Retry-After": "60" }), 429, "", 1, 0, 0.5)).toHaveProperty("stop");
    });

    it("asking for more than the call has left of its 8 s: give up", () =>
      expect(hsRetryWait(h({ "Retry-After": "2.5" }), 429, "", 2, 6000, 0.5))
        .toEqual({ stop: expect.stringContaining("wait budget") }));

    it("an unparseable Retry-After is no signal: the window headers decide", () =>
      expect(hsRetryWait(h({ ...WINDOW, "Retry-After": "soon" }), 429, RATE_BODY, 1, 0, 0.5))
        .toEqual({ ms: 1000, basis: "rate-window" }));
  });

  describe("a 429 with the window spent (X-HubSpot-RateLimit-Interval-Milliseconds / Remaining 0)", () => {
    it("waits a tenth of the window at first, jittered x0.5..x1.5, so a burst's calls spread out", () => {
      expect(hsRetryWait(h(WINDOW), 429, RATE_BODY, 1, 0, 0)).toEqual({ ms: 500, basis: "rate-window" });
      expect(hsRetryWait(h(WINDOW), 429, RATE_BODY, 1, 0, 0.5)).toEqual({ ms: 1000, basis: "rate-window" });
      expect(hsRetryWait(h(WINDOW), 429, RATE_BODY, 1, 0, 0.999)).toEqual({ ms: 1499, basis: "rate-window" });
    });

    it("doubling per attempt up to the 3 s cap: ~1 s, 2 s, 3 s, 3 s across the 10 s window", () =>
      expect([1, 2, 3, 4].map(n => hsRetryWait(h(WINDOW), 429, RATE_BODY, n, 0, 0.5))).toEqual([
        { ms: 1000, basis: "rate-window" }, { ms: 2000, basis: "rate-window" },
        { ms: 3000, basis: "rate-window" }, { ms: 3000, basis: "rate-window" }]));

    it("scales with the window HubSpot names", () =>
      expect(hsRetryWait(h({ ...WINDOW, "X-HubSpot-RateLimit-Interval-Milliseconds": "20000" }), 429, RATE_BODY, 1, 0, 0.5))
        .toEqual({ ms: 2000, basis: "rate-window" }));

    it("Remaining absent beside the interval reads the same", () =>
      expect(hsRetryWait(h({ "X-HubSpot-RateLimit-Interval-Milliseconds": "10000" }), 429, "", 1, 0, 0.5))
        .toEqual({ ms: 1000, basis: "rate-window" }));

    it("but Remaining above 0 says the window is NOT what refused it: the ordinary backoff", () =>
      expect(hsRetryWait(h({ ...WINDOW, "X-HubSpot-RateLimit-Remaining": "37" }), 429, "", 1, 0, 0.5))
        .toEqual({ ms: 750, basis: "backoff" }));

    it("the window headers speak to a 429 only: a 5xx beside them is the ordinary backoff", () =>
      expect(hsRetryWait(h(WINDOW), 502, "", 1, 0, 0.5)).toEqual({ ms: 750, basis: "backoff" }));

    it("an unreadable interval is no signal", () =>
      expect(hsRetryWait(h({ ...WINDOW, "X-HubSpot-RateLimit-Interval-Milliseconds": "abc" }), 429, "", 1, 0, 0.5))
        .toEqual({ ms: 750, basis: "backoff" }));
  });

  describe("no signal (a 5xx, the network, a bare 429): ~0.75 s, 1.5 s, 3 s, jittered", () => {
    it("growing, then capped at 3 s", () =>
      expect([1, 2, 3, 4].map(n => hsRetryWait(null, 503, "", n, 0, 0.5))).toEqual([
        { ms: 750, basis: "backoff" }, { ms: 1500, basis: "backoff" }, { ms: 3000, basis: "backoff" },
        { ms: 3000, basis: "backoff" }]));

    it("jittered x0.5..x1.5", () => {
      expect(hsRetryWait(null, null, "", 1, 0, 0)).toEqual({ ms: 375, basis: "backoff" });
      expect(hsRetryWait(null, null, "", 1, 0, 0.999)).toEqual({ ms: 1124, basis: "backoff" });
      expect(hsRetryWait(h({}), 429, "", 1, 0, 0.5)).toEqual({ ms: 750, basis: "backoff" });
    });

    it("no single wait is longer than 3 s, whatever the jitter or the attempt", () => {
      for (const r of [0, 0.5, 0.999]) for (const n of [1, 2, 3, 4]) for (const head of [null, h(WINDOW)]) {
        const w = hsRetryWait(head, 429, RATE_BODY, n, 0, r);
        expect(w).toHaveProperty("ms");
        expect((w as { ms: number }).ms).toBeLessThanOrEqual(3000);
        expect((w as { ms: number }).ms).toBeGreaterThanOrEqual(250);
      }
    });
  });

  describe("stop", () => {
    it("after 5 attempts", () => {
      expect(hsRetryWait(null, 429, "", 4, 0, 0.5)).toHaveProperty("ms");
      expect(hsRetryWait(null, 429, "", 5, 0, 0.5)).toEqual({ stop: "5 attempts" });
    });

    it("at once on HubSpot's daily limit -- the header, even beside a Retry-After", () =>
      expect(hsRetryWait(h({ "X-HubSpot-RateLimit-Daily-Remaining": "0", "Retry-After": "1" }), 429, "", 1, 0, 0.5))
        .toEqual({ stop: "HubSpot's daily limit is spent", final: true }));

    it("at once on HubSpot's daily limit -- the 429's own body (policyName DAILY, or its message)", () => {
      expect(hsRetryWait(h(WINDOW), 429, DAILY_BODY, 1, 0, 0.5)).toEqual({ stop: "HubSpot's daily limit is spent", final: true });
      expect(hsRetryWait(null, 429, "You have reached your daily limit.", 1, 0, 0.5))
        .toEqual({ stop: "HubSpot's daily limit is spent", final: true });
      // The ten-second limit is not the daily one.
      expect(hsRetryWait(h(TEN_SECONDLY_HEADERS), 429, RATE_BODY, 1, 0, 0.5)).toEqual({ ms: 1000, basis: "rate-window" });
    });

    it("at once when the daily limit is spent whatever the status", () =>
      expect(hsRetryWait(h({ "X-HubSpot-RateLimit-Daily-Remaining": "0" }), 503, "", 1, 0, 0.5))
        .toEqual({ stop: "HubSpot's daily limit is spent", final: true }));

    it("never past 8 s of waiting in all: the last wait is shortened to fit, then the call gives up", () => {
      expect(hsRetryWait(h(WINDOW), 429, RATE_BODY, 3, 7000, 0.5)).toEqual({ ms: 1000, basis: "rate-window" });
      expect(hsRetryWait(h(WINDOW), 429, RATE_BODY, 3, 7900, 0.5)).toEqual({ stop: expect.stringContaining("wait budget") });
      expect(hsRetryWait(null, 503, "", 2, 8000, 0.5)).toEqual({ stop: expect.stringContaining("wait budget") });
    });
  });
});

// --------------------------------------------------------------------------------- reads, switch on

describe("switch on: a GET is retried on 429 / 5xx / the network, as HubSpot's headers say", () => {
  it("getRecord (retries=1) gets the measured 429 twice, then the record -- the push is no longer dropped", async () => {
    replies = [tenSecondly(), tenSecondly(), json(contact)];
    const rec = await getRecord(ON, "contacts", "394787683005", ["lifecyclestage"]);
    expect(rec).toEqual({ id: "394787683005", properties: contact.properties });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([1000, 2000]);                         // a tenth of the 10 s window, doubling
    expect(logged(/^\[hubspot\] action=retried-ok method=GET path=\/crm\/v3\/objects\/contacts\/394787683005\?properties=lifecyclestage attempts=3 waited_ms=3000 last=429$/)).toBe(true);
  });

  it("the context build's reads -- owners (archived page first) and a property's options -- ride it out", async () => {
    replies = [tenSecondly(), json({ results: [{ id: "1", firstName: "Myla", lastName: "Mestiola", email: "m@x" }] }),
      json({ results: [] })];
    expect(await getOwners(ON)).toEqual({ "1": { name: "Myla Mestiola", email: "m@x", archived: true } });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/crm/v3/owners/?limit=100&archived=true");
    replies = [tenSecondly(), json({ options: [{ value: "NEW", label: "New", displayOrder: 0 }] })];
    expect(await getPropertyOptions(ON, "contacts", "hs_lead_status")).toEqual({ NEW: "New" });
  });

  it("Retry-After is honoured exactly", async () => {
    replies = [json({}, 429, { "Retry-After": "1" }), json(contact)];
    await getRecord(ON, "contacts", "394787683005", ["lifecyclestage"]);
    expect(slept).toEqual([1000]);
  });

  it("a 503 and a network error are retried too, with growing waits", async () => {
    replies = [json({}, 503), new TypeError("Network connection lost."), json(contact)];
    expect(await getRecord(ON, "contacts", "394787683005", ["lifecyclestage"])).not.toBeNull();
    expect(slept).toEqual([750, 1500]);
    expect(logged(/action=retried-ok .* attempts=3 waited_ms=2250 last=network/)).toBe(true);
  });

  it("each attempt sends the identical request", async () => {
    replies = [tenSecondly(), tenSecondly(), json(contact)];
    await getRecord(ON, "contacts", "394787683005", ["lifecyclestage"]);
    const [a, b, c] = fetchMock.mock.calls;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a[0]).toBe("https://api.hubapi.com/crm/v3/objects/contacts/394787683005?properties=lifecyclestage");
    expect(a[1]).toEqual({ method: "GET", body: undefined,
      headers: { Authorization: "Bearer x", "Content-Type": "application/json" } });
  });

  it("a GET that stays rate-limited: 5 attempts, 8 s of waiting, then exactly today's error", async () => {
    replies = Array.from({ length: 10 }, () => tenSecondly);
    await expect(hs(ON, "GET", "/crm/v3/properties/contacts/hs_lead_status"))
      .rejects.toThrow(new Error(`hubspot GET /crm/v3/properties/contacts/hs_lead_status: 429 ${RATE_BODY.slice(0, 300)}`));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(slept).toEqual([1000, 2000, 3000, 2000]);             // the 4th shortened to the budget left
    expect(total(slept)).toBe(8000);
    expect(logged(/^\[hubspot\] action=gave-up method=GET path=\/crm\/v3\/properties\/contacts\/hs_lead_status attempts=5 waited_ms=8000 status=429 reason="5 attempts"$/)).toBe(true);
  });

  it("the 8 s budget can end it before the 5th attempt (Retry-After 3 s, three times)", async () => {
    replies = Array.from({ length: 10 }, () => () => json({}, 429, { "Retry-After": "3" }));
    await expect(hs(ON, "GET", "/crm/v3/owners/?limit=100")).rejects.toThrow(/: 429 /);
    expect(slept).toEqual([3000, 3000]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logged(/action=gave-up .* attempts=3 waited_ms=6000 status=429 reason="the call's wait budget/)).toBe(true);
  });

  it("whatever the jitter, a call never waits past 8 s, never more than 3 s at once, never past 5 attempts", async () => {
    const kinds: (() => Response | Error)[] = [tenSecondly, () => json({}, 503), () => new TypeError("Network connection lost.")];
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      for (const make of kinds) {
        fetchMock.mockClear();
        slept = [];
        hsRetry.random = () => r;
        replies = Array.from({ length: 10 }, () => make());
        await expect(hs(ON, "GET", "/crm/v3/objects/contacts/1")).rejects.toThrow();
        expect(fetchMock.mock.calls.length).toBe(slept.length + 1);
        expect(total(slept)).toBeLessThanOrEqual(8000);
        for (const ms of slept) { expect(ms).toBeLessThanOrEqual(3000); expect(ms).toBeGreaterThanOrEqual(250); }
        if (fetchMock.mock.calls.length <= 5) continue;
        // ...except where the switch's own five came before today's last would have: a 5xx at the lowest jitter
        // waits 375 + 750 + 1500 + 3000 ms, so its 5th attempt is at 5.625 s, and today's 3rd is at 2 + 4 = 6 s.
        // Today's rule is the floor, so that one is made too -- at 6 s, exactly when today makes it.
        expect(fetchMock.mock.calls.length).toBe(6);
        expect(total(slept)).toBe(2000 + 4000);
      }
    }
  });

  it("today's rule is the floor IN TIME: where the switch's quicker waits spent today's attempts sooner, the call still ends no sooner than today's", async () => {
    // Retry-After 0, five times: the switch's floor of 250 ms each, so its 5 attempts end by 1 s. Today's
    // three are at 0, 2 and 6 s -- so a 6th is made at 6 s, and a HubSpot back by then is answered, as today.
    replies = [...Array.from({ length: 5 }, () => json({}, 429, { "Retry-After": "0" })), json(contact)];
    expect(await hs(ON, "GET", "/crm/v3/objects/contacts/1")).toEqual(contact);
    expect(slept).toEqual([250, 250, 250, 250, 6000 - 1000]);
    expect(logged(/action=retried-ok method=GET .* attempts=6 waited_ms=6000 last=429$/)).toBe(true);
    // A pure today path (a PATCH's 5xx: only today's rule applies) owes nothing: exactly today's 3 attempts.
    fetchMock.mockClear(); slept = [];
    replies = [json({}, 503), json({}, 503), json({}, 503), json(contact)];
    await expect(hs(ON, "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY)).rejects.toThrow(/: 503 /);
    expect(slept).toEqual([2000, 4000]);
    // ...and a network error's today is 1.5 s x attempt: 1.5 + 3 s, nothing more.
    fetchMock.mockClear(); slept = [];
    replies = [new TypeError("a"), new TypeError("b"), new TypeError("c"), json(contact)];
    await expect(hs(ON, "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY)).rejects.toThrow("c");
    expect(slept).toEqual([1500, 3000]);
  });

  it("HubSpot's daily limit: stopped at once -- one attempt, no wait, today's error", async () => {
    replies = [dailySpent(), json(contact)];
    await expect(hs(ON, "GET", "/crm/v3/objects/contacts/1"))
      .rejects.toThrow(new Error(`hubspot GET /crm/v3/objects/contacts/1: 429 ${DAILY_BODY}`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(logged(/action=gave-up method=GET .* attempts=1 waited_ms=0 status=429 reason="HubSpot's daily limit is spent"/)).toBe(true);
  });

  it("the daily limit told only in the body stops it too", async () => {
    replies = [json(JSON.parse(DAILY_BODY), 429), json(contact)];
    await expect(getRecord(ON, "contacts", "1", ["x"])).rejects.toThrow(/: 429 /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 404 is an answer, not a failure: getRecord's null, no retry", async () => {
    replies = [json({ message: "not found" }, 404)];
    expect(await getRecord(ON, "contacts", "1", ["x"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("a 400 is never retried", async () => {
    replies = [json({ message: "bad" }, 400)];
    await expect(hs(ON, "GET", "/crm/v3/objects/contacts/1")).rejects.toThrow(/: 400 /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a network error that never clears rethrows the error itself, as before", async () => {
    const errs = Array.from({ length: 10 }, (_, i) => new TypeError(`Network connection lost. #${i}`));
    replies = [...errs];
    await expect(hs(ON, "GET", "/crm/v3/objects/contacts/1")).rejects.toBe(errs[4]);
    expect(slept).toEqual([750, 1500, 3000, 2750]);
    expect(logged(/action=gave-up method=GET .* attempts=5 waited_ms=8000 last=network reason="5 attempts"/)).toBe(true);
  });

  it("no wait, no log, when the first answer is good", async () => {
    replies = [json(contact)];
    await getRecord(ON, "contacts", "394787683005", ["lifecyclestage"]);
    expect(slept).toEqual([]);
    expect(logs.some(l => l.startsWith("[hubspot]"))).toBe(false);
  });
});

// -------------------------------------------------------------------------------- writes, switch on

describe("switch on: any other method gets the new retry ONLY on a 429, and only when its caller already retries it", () => {
  it("patchRecord (retries=3): a 429 -- never executed -- is retried, past its 3, within the caps", async () => {
    replies = [json({}, 429, { "Retry-After": "1" }), json({}, 429, { "Retry-After": "1" }),
      json({}, 429, { "Retry-After": "1" }), json({ id: "394787683005", properties: { lastmodifieddate: "2026-10-05T03:11:00Z" } })];
    expect(await patchRecord(ON, CRM_CONTACTS, "394787683005", { jobtitle: "Buyer" }, live, auth("394787683005")))
      .toBe("2026-10-05T03:11:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(slept).toEqual([1000, 1000, 1000]);
    // The same request every time: same URL, method, headers and body bytes.
    for (const c of fetchMock.mock.calls) expect(c).toEqual(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ properties: { jobtitle: "Buyer" } }) });
  });

  it("the measured ten-second 429 on a PATCH rides the window too", async () => {
    replies = [tenSecondly(), json({ id: "1", properties: { lastmodifieddate: "M" } })];
    expect(await patchRecord(ON, CRM_CONTACTS, "1", { jobtitle: "x" }, live, auth("1"))).toBe("M");
    expect(slept).toEqual([1000]);
  });

  it("its 5xx keeps TODAY'S retry exactly -- 2 s, and the rep's PATCH lands (it is idempotent)", async () => {
    replies = [json({ message: "down" }, 503), json({ id: "394787683005", properties: { lastmodifieddate: "M" } })];
    expect(await patchRecord(ON, CRM_CONTACTS, "394787683005", { jobtitle: "Buyer" }, live, auth("394787683005")))
      .toBe("M");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([2000]);                               // 2 s x attempt: today's wait, not the backoff's
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
    expect(logged(/^\[hubspot\] action=retried-ok method=PATCH .* attempts=2 waited_ms=2000 last=503$/)).toBe(true);
  });

  it("a 5xx that persists: today's 3 attempts (2 s, then 4 s), then today's error", async () => {
    replies = [json({ message: "down" }, 503), json({ message: "down" }, 503), json({ message: "down" }, 503)];
    await expect(patchRecord(ON, CRM_CONTACTS, "394787683005", { jobtitle: "x" }, live, auth("394787683005")))
      .rejects.toThrow(new Error('hubspot PATCH /crm/v3/objects/contacts/394787683005: 503 {"message":"down"}'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([2000, 4000]);
    expect(logged(/action=gave-up method=PATCH .* attempts=3 waited_ms=6000 status=503 reason="today's 3 attempts are spent"/)).toBe(true);
  });

  it("and so does its network error: today's 1.5 s, then the PATCH lands", async () => {
    replies = [new TypeError("Network connection lost."), json({ id: "1", properties: { lastmodifieddate: "M" } })];
    expect(await patchRecord(ON, CRM_CONTACTS, "1", { jobtitle: "x" }, live, auth("1"))).toBe("M");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([1500]);
  });

  it("a network error that persists: today's 3 attempts, then the error itself", async () => {
    const errs = [1, 2, 3].map(i => new TypeError(`Network connection lost. #${i}`));
    replies = [...errs];
    await expect(patchRecord(ON, CRM_CONTACTS, "1", { jobtitle: "x" }, live, auth("1"))).rejects.toBe(errs[2]);
    expect(slept).toEqual([1500, 3000]);
  });

  it("a Retry-After longer than one wait may be falls back to today's wait -- never a call ended sooner than today", async () => {
    replies = [json({}, 429, { "Retry-After": "4" }), json({ id: "1", properties: { lastmodifieddate: "M" } })];
    expect(await patchRecord(ON, CRM_CONTACTS, "1", { jobtitle: "x" }, live, auth("1"))).toBe("M");
    expect(slept).toEqual([2000]);                               // today's 2 s, as with the switch off
    fetchMock.mockClear(); slept = [];
    replies = Array.from({ length: 5 }, () => () => json({}, 429, { "Retry-After": "60" }));
    await expect(hs(ON, "GET", "/crm/v3/owners/?limit=100")).rejects.toThrow(/: 429 /);
    expect(fetchMock).toHaveBeenCalledTimes(3);                  // today's 3 attempts (2 s, 4 s), not 1
    expect(slept).toEqual([2000, 4000]);
  });

  it("a create's 5xx and network error: never retried, exactly as today (retries=1)", async () => {
    replies = [json({ message: "down" }, 502), json({ id: "9" })];
    await expect(createRecord(ON, CRM_CONTACTS, { email: "a@b.c" }, live, auth("(new)"))).rejects.toThrow(/: 502 /);
    const err = new TypeError("Network connection lost.");
    replies = [err, json({ id: "9" })];
    await expect(createRecord(ON, CRM_CONTACTS, { email: "a@b.c" }, live, auth("(new)"))).rejects.toBe(err);
    expect(fetchMock).toHaveBeenCalledTimes(2);                  // one attempt each
    expect(slept).toEqual([]);
    expect(logs.some(l => l.startsWith("[hubspot]"))).toBe(false);
  });

  it("a CREATE (retries=1, not idempotent) is never retried -- not even on a 429", async () => {
    replies = [json({}, 429, { "Retry-After": "1" }), json({ id: "9" })];
    await expect(createRecord(ON, CRM_CONTACTS, { email: "a@b.c" }, live, auth("(new)")))
      .rejects.toThrow(/^hubspot POST \/crm\/v3\/objects\/contacts: 429 /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(logs.some(l => l.startsWith("[hubspot]"))).toBe(false);
  });

  it("any retries=1 write likewise (a note, an activity create)", async () => {
    replies = [tenSecondly(), json({ id: "9" })];
    await expect(hs(ON, "POST", "/crm/v3/objects/notes", { properties: {} }, 1)).rejects.toThrow(/: 429 /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a search (POST, retries=3): its 429 gets the new retry, its 502 today's", async () => {
    replies = [tenSecondly(), json({ results: [] })];
    expect(await searchContactByEmail(ON, "a@b.c")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([1000]);                               // the window's tenth
    fetchMock.mockClear(); slept = [];
    replies = [json({}, 502), json({ results: [] })];
    expect(await searchContactByEmail(ON, "a@b.c")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([2000]);                               // today's
  });

  it("retries=2 already allows a retry, so its 429 is retried", async () => {
    replies = [json({}, 429, { "Retry-After": "1" }), json({ results: [{ id: "5", properties: { firstname: "A" } }], total: 1 })];
    expect((await searchObjects(ON, "contacts", "A", 5)).total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the association PUT and DELETE (retries=3) ride out a 429", async () => {
    replies = [json({}, 429, { "Retry-After": "1" }), new Response(null, { status: 204 })];
    expect(await deleteAssociation(ON, "contacts", "1", "companies", "2", live)).toBe(true);
    replies = [json({}, 429, { "Retry-After": "1" }), json({})];
    await putAssociation(ON, "contacts", "1", "companies", "2", live);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(slept).toEqual([1000, 1000]);
  });

  it("the daily limit stops a write at once too", async () => {
    replies = [dailySpent(), json({ id: "1", properties: {} })];
    await expect(patchRecord(ON, CRM_CONTACTS, "1", { jobtitle: "x" }, live, auth("1"))).rejects.toThrow(/: 429 /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------- giving up: the error of today

describe("giving up throws EXACTLY the error hs() throws today", () => {
  const OFF = { ENABLE_CRM: "true", HUBSPOT_ACCESS_TOKEN: "x" } as unknown as Env;
  const errOf = (p: Promise<unknown>) => p.then(() => { throw new Error("resolved"); }, (e: unknown) => e as Error);

  it("a GET's last 429: same class, same message, so getRecord's /: 404 / test and every log read it as before", async () => {
    replies = [tenSecondly()];
    const off = await errOf(getRecord(OFF, "contacts", "394787683005", ["lifecyclestage"]));   // 1 attempt
    replies = Array.from({ length: 5 }, () => tenSecondly);
    const on = await errOf(getRecord(ON, "contacts", "394787683005", ["lifecyclestage"]));     // 5 attempts
    expect(on).toBeInstanceOf(Error);
    expect(on.constructor).toBe(off.constructor);
    expect(on.message).toBe(off.message);
    expect(on.message).toBe(`hubspot GET /crm/v3/objects/contacts/394787683005?properties=lifecyclestage: 429 ${RATE_BODY.slice(0, 300)}`);
  });

  it("a body past 300 characters is cut exactly where today cuts it", async () => {
    const long = JSON.stringify({ message: "x".repeat(1000) });
    replies = [json(JSON.parse(long), 503)];
    const off = await errOf(hs(OFF, "GET", "/crm/v3/objects/contacts/1", undefined, 1));
    replies = Array.from({ length: 5 }, () => () => json(JSON.parse(long), 503));
    const on = await errOf(hs(ON, "GET", "/crm/v3/objects/contacts/1", undefined, 1));
    expect(on.message).toBe(off.message);
    expect(on.message).toBe(`hubspot GET /crm/v3/objects/contacts/1: 503 ${long.slice(0, 300)}`);
  });

  it("a write's 5xx: the same 3 attempts, and the same message, today's exhausted retries end on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    replies = [json({ message: "down" }, 503), json({ message: "down" }, 503), json({ message: "down" }, 503)];
    const offP = errOf(hs(OFF, "PATCH", "/crm/v3/objects/contacts/1", { properties: { a: "b" } }));
    await drive(offP);
    const off = await offP;
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(3);                  // today: 3 attempts, 2 s then 4 s
    fetchMock.mockClear();
    replies = [json({ message: "down" }, 503), json({ message: "down" }, 503), json({ message: "down" }, 503)];
    const on = await errOf(hs(ON, "PATCH", "/crm/v3/objects/contacts/1", { properties: { a: "b" } }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([2000, 4000]);
    expect(on.constructor).toBe(off.constructor);
    expect(on.message).toBe(off.message);
  });

  it("a body that cannot be read throws that failure, as today's template literal does", async () => {
    const broken = () => new Response(new ReadableStream({ start(c) { c.error(new Error("body stream broke")); } }),
      { status: 429, headers: { "Retry-After": "60" } });
    replies = [broken()];
    const off = await errOf(hs(OFF, "GET", "/crm/v3/objects/contacts/1", undefined, 1));
    replies = [broken()];
    const on = await errOf(hs(ON, "GET", "/crm/v3/objects/contacts/1", undefined, 1));
    expect(off.message).toBe("body stream broke");
    expect(on.message).toBe(off.message);
  });
});

// ------------------------------------------------------------------- switch off: byte for byte

/**
 * hs() AS IT RAN LIVE AT 3064076 (worker/src/hubspot.ts lines 8-36), copied verbatim. The structural test
 * at the end pins that src/hubspot.ts's hs() is that text plus one early return; this copy proves the
 * RUN is the same: every request, every wait, every outcome, scenario by scenario.
 */
const BASE = "https://api.hubapi.com";
async function hsAt3064076(env: Env, method: string, path: string, body?: unknown, retries = 3): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt >= retries) throw e;                 // network error: retry
      await new Promise(res => setTimeout(res, 1500 * attempt));
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
      await new Promise(res => setTimeout(res, 2000 * attempt));
      continue;
    }
    if (!resp.ok) {                                    // other 4xx (and exhausted 5xx): throw now
      throw new Error(`hubspot ${method} ${path}: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    }
    if (resp.status === 204) return undefined;          // no-content (e.g. DELETE) -> nothing to parse
    const text = await resp.text();
    return text ? JSON.parse(text) : undefined;         // tolerate any other empty-body success
  }
}

type Reply = { status: number; body?: string | null; headers?: Record<string, string> } | { network: string };
const R429: Reply = { status: 429, body: RATE_BODY, headers: TEN_SECONDLY_HEADERS };
const RDAILY: Reply = { status: 429, body: DAILY_BODY, headers: { ...TEN_SECONDLY_HEADERS, "X-HubSpot-RateLimit-Daily-Remaining": "0" } };
const R200: Reply = { status: 200, body: JSON.stringify(contact) };
const NET: Reply = { network: "Network connection lost." };

/**
 * Settle `p` under fake timers, moving the clock ONLY when the code is idle on a timer: real ticks first (a
 * body read may take several), then straight to the next timer. So every request is stamped with exactly the
 * fake time the code reached it at -- the sum of the waits before it -- and nothing else.
 */
async function drive(p: Promise<unknown>): Promise<void> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 100_000 && !done; i++) {
    await realTick();
    if (!done && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  if (!done) throw new Error("the call never settled");
}
/** One real macrotask. Node's setImmediate, which the fake timers leave alone (the Workers types do not
 *  declare it, hence the cast). */
const realTick = () => new Promise<void>(r =>
  (globalThis as unknown as { setImmediate: (cb: () => void) => void }).setImmediate(() => r()));

/** One run under fake timers: every request (and WHEN it was sent), and how the call ended. */
async function runOnce(call: () => Promise<unknown>, script: Reply[]) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const t0 = Date.now();
    const queue = [...script];
    const sent: { url: string; init: unknown; at: number }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      sent.push({ url: String(url), init: { ...init }, at: Date.now() - t0 });
      const r = queue.shift();
      if (!r) throw new Error("no reply queued");
      if ("network" in r) throw new TypeError(r.network);
      return new Response(r.body ?? null, { status: r.status, headers: r.headers });
    }) as never;
    const ended = call().then(value => ({ value }), (e: unknown) => ({ error: String(e), name: (e as Error)?.name }));
    await drive(ended);
    return { sent, ended: await ended, left: queue.length };
  } finally {
    vi.useRealTimers();
  }
}

/** Like runOnce, against a HubSpot that is DOWN for `outageMs` from the call's start -- every request in that
 *  time answered with `down` -- and answers `up` after it: an outage, as HubSpot has them (a rate-limit window,
 *  a 5xx blip, a dropped connection). Every request is stamped with when it was sent. */
async function runOutage(call: () => Promise<unknown>, down: Reply, outageMs: number, up: Reply = R200) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const t0 = Date.now();
    const sent: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      const at = Date.now() - t0;
      sent.push(at);
      const r = at < outageMs ? down : up;
      if ("network" in r) throw new TypeError(r.network);
      return new Response(r.body ?? null, { status: r.status, headers: r.headers });
    }) as never;
    const ended = call().then(value => ({ value }), (e: unknown) => ({ error: String(e) }));
    await drive(ended);
    return { sent, ended: await ended };
  } finally {
    vi.useRealTimers();
  }
}

const SCENARIOS: [string, string, string, unknown, number | undefined, Reply[]][] = [
  ["GET 200", "GET", "/crm/v3/objects/contacts/1?properties=a", undefined, 1, [R200]],
  ["GET 429, retries=1 (getRecord, the measured failure)", "GET", "/crm/v3/objects/contacts/1?properties=a", undefined, 1, [R429, R200]],
  ["GET 429 x2 then 200 (default retries)", "GET", "/crm/v3/owners/?limit=100", undefined, undefined, [R429, R429, R200]],
  ["GET 429 x3 (default retries)", "GET", "/crm/v3/properties/contacts/hs_lead_status", undefined, undefined, [R429, R429, R429, R200]],
  ["GET 503, network, 200", "GET", "/crm/v3/pipelines/deals", undefined, 3, [{ status: 503, body: "x" }, NET, R200]],
  ["GET network x3", "GET", "/crm/v3/owners/?limit=100", undefined, 3, [NET, NET, NET, R200]],
  ["GET 429 x2, retries=2", "GET", "/crm/v3/properties/contacts", undefined, 2, [R429, R429, R200]],
  ["GET daily limit x3", "GET", "/crm/v3/objects/contacts/1", undefined, 3, [RDAILY, RDAILY, RDAILY]],
  ["GET 404", "GET", "/crm/v3/objects/contacts/1", undefined, 1, [{ status: 404, body: '{"message":"nf"}' }]],
  ["GET 400", "GET", "/crm/v3/objects/contacts/1", undefined, 3, [{ status: 400, body: '{"message":"bad"}' }]],
  ["PATCH 503 x3", "PATCH", "/crm/v3/objects/contacts/1", { properties: { a: "b" } }, undefined, [{ status: 503, body: "d" }, { status: 503, body: "d" }, { status: 503, body: "d" }]],
  ["PATCH 429 then 200", "PATCH", "/crm/v3/objects/contacts/1", { properties: { a: "b" } }, 3, [R429, R200]],
  ["PATCH network then 200", "PATCH", "/crm/v3/objects/contacts/1", { properties: { a: "b" } }, 3, [NET, R200]],
  ["POST create 429, retries=1", "POST", "/crm/v3/objects/contacts", { properties: { email: "a@b.c" } }, 1, [R429, R200]],
  ["POST create network, retries=1", "POST", "/crm/v3/objects/contacts", { properties: {} }, 1, [NET, R200]],
  ["POST search 500 then 200", "POST", "/crm/v3/objects/contacts/search", { limit: 1 }, undefined, [{ status: 500, body: "" }, R200]],
  ["DELETE 204", "DELETE", "/crm/v4/objects/contacts/1/associations/companies/2", undefined, 3, [{ status: 204 }]],
  ["PUT 200, empty body", "PUT", "/crm/v4/objects/contacts/1/associations/default/companies/2", undefined, 3, [{ status: 200, body: "" }]],
];

const OFF_ENVS: [string, Record<string, string>][] = [
  ["absent", { ENABLE_CRM: "true" }],
  ["\"false\"", { ENABLE_CRM: "true", HS_RATE_LIMIT_RETRY: "false" }],
  ["\"TRUE\"", { ENABLE_CRM: "true", HS_RATE_LIMIT_RETRY: "TRUE" }],
  ["\"1\"", { ENABLE_CRM: "true", HS_RATE_LIMIT_RETRY: "1" }],
  ["\"true\" on the WM Worker (no ENABLE_CRM)", { HS_RATE_LIMIT_RETRY: "true" }],
  ["\"true\" beside ENABLE_CRM \"false\"", { ENABLE_CRM: "false", HS_RATE_LIMIT_RETRY: "true" }],
];

describe.each(OFF_ENVS)("switch off (HS_RATE_LIMIT_RETRY %s): hs() runs 3064076's loop exactly", (_label, vars) => {
  const env = { ...vars, HUBSPOT_ACCESS_TOKEN: "x" } as unknown as Env;

  it.each(SCENARIOS)("%s: the same requests, at the same moments, with the same outcome", async (_s, method, path, body, retries, script) => {
    const sleep = vi.fn(hsRetry.sleep);
    const random = vi.fn(hsRetry.random);
    hsRetry.sleep = sleep;
    hsRetry.random = random;
    const today = await runOnce(() => hsAt3064076(env, method, path, body, retries), script);
    const now = await runOnce(() => hs(env, method, path, body, retries), script);
    expect(now).toEqual(today);
    expect(sleep).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(logs.some(l => l.startsWith("[hubspot]"))).toBe(false);
  });
});

describe("the equivalence check is not vacuous", () => {
  it("switched ON, the measured getRecord 429 is retried where 3064076 threw at once", async () => {
    hsRetry.sleep = realSleep;            // the real timer wait, driven by the fake clock
    const [, method, path, body, retries, script] = SCENARIOS[1];
    const today = await runOnce(() => hsAt3064076(ON, method, path, body, retries), script);
    const now = await runOnce(() => hs(ON, method, path, body, retries), script);
    expect(today.sent).toHaveLength(1);
    expect(today.ended).toHaveProperty("error");
    expect(now.sent.map(s => s.at)).toEqual([0, 1000]);
    expect(now.ended).toEqual({ value: contact });
  });
});

// ------------------------------------------------------- switch on never gives up sooner than off

const ok = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body) });
const R503: Reply = { status: 503, body: '{"message":"down"}' };
const ra = (secs: string): Reply => ({ status: 429, body: "", headers: { "Retry-After": secs } });
const PATCH_BODY = { properties: { jobtitle: "Buyer" } };

/** Every script here SUCCEEDS with the switch off: on, it must succeed too, with the same answer. */
const PARITY: [string, string, string, unknown, number | undefined, Reply[]][] = [
  ["PATCH 503 -> 200", "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY, undefined, [R503, ok({ id: "1" })]],
  ["PATCH 503, 503 -> 200", "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY, undefined, [R503, R503, ok({ id: "1" })]],
  ["PATCH network -> 200", "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY, undefined, [NET, ok({ id: "1" })]],
  ["PATCH 429 Retry-After 4 -> 200", "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY, undefined, [ra("4"), ok({ id: "1" })]],
  ["POST search 502 -> 200", "POST", "/crm/v3/objects/contacts/search", { limit: 1 }, undefined, [{ status: 502, body: "" }, ok({ results: [] })]],
  ["POST search network, 500 -> 200", "POST", "/crm/v3/objects/contacts/search", { limit: 1 }, undefined, [NET, { status: 500, body: "" }, ok({ results: [] })]],
  ["POST batch/read 500 -> 200", "POST", "/crm/v3/objects/companies/batch/read", { inputs: [] }, undefined, [{ status: 500, body: "" }, ok({ results: [] })]],
  ["PUT association 503 -> 200", "PUT", "/crm/v4/objects/contacts/1/associations/default/companies/2", undefined, 3, [R503, ok({})]],
  ["DELETE association network -> 204", "DELETE", "/crm/v4/objects/contacts/1/associations/companies/2", undefined, 3, [NET, { status: 204 }]],
  ["GET 429 Retry-After 10 x2 -> 200 (default retries)", "GET", "/crm/v3/owners/?limit=100", undefined, undefined, [ra("10"), ra("10"), R200]],
  ["GET 503 x2 -> 200 (retries=3)", "GET", "/crm/v3/pipelines/deals", undefined, 3, [R503, R503, R200]],
  ["GET network x2 -> 200 (retries=3)", "GET", "/crm/v3/owners/?limit=100", undefined, 3, [NET, NET, R200]],
];

describe("switch on never gives up sooner than off: every request off answers, on answers the same", () => {
  it.each(PARITY)("%s", async (_s, method, path, body, retries, script) => {
    hsRetry.sleep = realSleep;            // real timer waits, on the fake clock
    const off = await runOnce(() => hsAt3064076(ON, method, path, body, retries), script);
    const on = await runOnce(() => hs(ON, method, path, body, retries), script);
    expect(off.ended).toHaveProperty("value");                   // the premise: off succeeds
    expect(on.ended).toEqual(off.ended);
    expect(on.sent.length).toBeLessThanOrEqual(hsRetry.maxAttempts);
    for (const s of on.sent) expect(s.init).toEqual(off.sent[0].init);   // the same request every time
  });

  it("and where off gives up on a write's 5xx, on gives up the same way: same attempts, same error", async () => {
    hsRetry.sleep = realSleep;
    const script = [R503, R503, R503, ok({ id: "1" })];
    const off = await runOnce(() => hsAt3064076(ON, "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY), script);
    const on = await runOnce(() => hs(ON, "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY), script);
    expect(on).toEqual(off);                                     // the same 3 requests at 0, 2 s, 6 s; the same error
  });
});

// ----------------------------------------------------------------- the invocation's retry deadline

describe("the invocation's retry deadline (withHsRetryDeadline): no retry wait ends past it", () => {
  const OFF = { ENABLE_CRM: "true", HUBSPOT_ACCESS_TOKEN: "x" } as unknown as Env;

  it("off (and on the WM Worker): the very same env object back -- nothing changes", () => {
    expect(withHsRetryDeadline(OFF, 1_000)).toBe(OFF);
    const wm = { HS_RATE_LIMIT_RETRY: "true", HUBSPOT_ACCESS_TOKEN: "x" } as unknown as Env;
    expect(withHsRetryDeadline(wm, 1_000)).toBe(wm);
    expect(hsRetryDeadlineOf(OFF)).toBeUndefined();
  });

  it("on: a copy carrying it, 20 s from the invocation's start, every binding and var unchanged", () => {
    const env = { ...ON, CREATE_IDEMPOTENCY: { idFromName: () => "x" } } as unknown as Env;
    const d = withHsRetryDeadline(env, 1_000);
    expect(d).not.toBe(env);
    expect(hsRetryDeadlineOf(d)).toBe(21_000);
    expect(hsRetryDeadlineOf(env)).toBeUndefined();              // the original is untouched
    expect(Object.keys(d)).toEqual(Object.keys(env));
    const val = (e: Env, k: string) => (e as unknown as Record<string, unknown>)[k];
    for (const k of Object.keys(env)) expect(val(d, k)).toBe(val(env, k));
    expect(hsRetryDeadlineOf({ ...d })).toBe(21_000);            // a spread of it (run-opts') keeps it
  });

  it("hsRetryWait shortens the last wait to it, and stops with less than 250 ms left", () => {
    const h = new Headers(TEN_SECONDLY_HEADERS);
    expect(hsRetryWait(h, 429, RATE_BODY, 1, 0, 0.5, 10_000, 10_600)).toEqual({ ms: 600, basis: "rate-window" });
    expect(hsRetryWait(h, 429, RATE_BODY, 1, 0, 0.5, 10_000, 10_200))
      .toEqual({ stop: "the invocation's retry deadline (20000 ms) is reached" });
    expect(hsRetryWait(new Headers({ "Retry-After": "2" }), 429, "", 1, 0, 0.5, 10_000, 11_500))
      .toEqual({ stop: "the invocation's retry deadline (20000 ms) is reached" });
    // Without one, the call's own 8 s decides, as before.
    expect(hsRetryWait(h, 429, RATE_BODY, 1, 0, 0.5, 10_000)).toEqual({ ms: 1000, basis: "rate-window" });
  });

  it("a GET kept rate-limited by an invocation 17 s old: waits only until the deadline, then today's error", async () => {
    hsRetry.sleep = realSleep;
    const r = await runOnce(() => hs(withHsRetryDeadline(ON, Date.now() - 17_000), "GET", "/crm/v3/objects/contacts/1",
      undefined, 1), Array.from({ length: 6 }, () => R429));
    expect(r.sent.map(s => s.at)).toEqual([0, 1000, 3000]);     // 1 s, 2 s -- and the 3 s left are spent
    expect(r.ended).toEqual({ error: `Error: hubspot GET /crm/v3/objects/contacts/1: 429 ${RATE_BODY}`, name: "Error" });
    expect(logged(/action=gave-up method=GET .* attempts=3 waited_ms=3000 status=429 reason="the invocation's retry deadline \(20000 ms\) is reached"/)).toBe(true);
  });

  it("TODAY'S retry is never cut by it: a PATCH 503 with 1 s left waits today's 2 s, exactly as off, and lands", async () => {
    hsRetry.sleep = realSleep;
    // A person's push 19 s into its invocation (an ask-ada push after its activity-log lookup, a coalesced
    // re-run): off retries at 21 s and the edit lands, so on must too -- a give-up here heals the cell back.
    const script = [R503, ok({ id: "1" })];
    const off = await runOnce(() => hsAt3064076(ON, "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY), script);
    const on = await runOnce(() => hs(withHsRetryDeadline(ON, Date.now() - 19_000), "PATCH",
      "/crm/v3/objects/contacts/1", PATCH_BODY), script);
    expect(on).toEqual(off);
    expect(on.sent.map(s => s.at)).toEqual([0, 2000]);
    expect(on.ended).toEqual({ value: { id: "1" } });
    // ...and well past it (25 s in), today's whole schedule is still made: 2 s, then 4 s.
    const past = await runOnce(() => hs(withHsRetryDeadline(ON, Date.now() - 25_000), "PATCH",
      "/crm/v3/objects/contacts/1", PATCH_BODY), [R503, R503, ok({ id: "1" })]);
    expect(past.sent.map(s => s.at)).toEqual([0, 2000, 6000]);
    expect(past.ended).toEqual({ value: { id: "1" } });
  });

  it("nor is today's LAST attempt: a PATCH refused (429) from 17 s to 21 s lands at 23 s, exactly as off", async () => {
    hsRetry.sleep = realSleep;
    // The switch's own waits are quicker (1 s, then the 2 s left before the deadline), so by 20 s it has made
    // today's three attempts -- all inside the outage. Today's third is at 17 + 2 + 4 = 23 s, after it: the
    // call is not over until then.
    const off = await runOutage(() => hsAt3064076(ON, "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY), R429, 4_000, ok({ id: "1" }));
    const on = await runOutage(() => hs(withHsRetryDeadline(ON, Date.now() - 17_000), "PATCH",
      "/crm/v3/objects/contacts/1", PATCH_BODY), R429, 4_000, ok({ id: "1" }));
    expect(off).toEqual({ sent: [0, 2000, 6000], ended: { value: { id: "1" } } });
    expect(on.ended).toEqual(off.ended);
    expect(on.sent).toEqual([0, 1000, 3000, 6000]);             // the switch's two, then today's last
  });

  it("no deadline (the cron, a Durable Object's alarm): bounded per call only, as before", async () => {
    hsRetry.sleep = realSleep;
    const r = await runOnce(() => hs(ON, "GET", "/crm/v3/objects/contacts/1", undefined, 1), Array.from({ length: 6 }, () => R429));
    expect(r.sent.map(s => s.at)).toEqual([0, 1000, 3000, 6000, 8000]);
  });
});

/**
 * THE GUARANTEE, EXHAUSTIVELY: with the switch on, a call gives up sooner than off only on HubSpot's daily
 * limit -- never because of the invocation's deadline, a quicker wait of the switch's own, or a short Retry-After.
 * Every outage off rides out (HubSpot down for 0-10 s from the call's start, then answering), on rides out
 * with the same answer: for each failure kind, each caller's retry count, both ends of the jitter, and an
 * invocation of every age -- none at all (the cron, a Durable Object, an operator route), fresh, and 12, 17,
 * 19.5 and 25 s old. And on stays bounded: never past 8 s of waiting, never more than 6 attempts.
 */
describe("on never gives up sooner than off, at any age of the invocation", () => {
  const KINDS: [string, Reply][] = [["ten-secondly 429", R429], ["503", R503], ["network", NET],
    ["429 Retry-After 0", ra("0")], ["429 Retry-After 1", ra("1")], ["bare 429", { status: 429, body: "" }]];
  const AGES: (number | null)[] = [null, 0, 12_000, 17_000, 19_500, 25_000];
  const OUTAGES = Array.from({ length: 21 }, (_, i) => i * 500);
  const CALLS: [string, string, string, unknown, number][] = [
    ["GET, retries=1 (getRecord)", "GET", "/crm/v3/objects/contacts/1?properties=a", undefined, 1],
    ["GET, retries=3 (a context-build read)", "GET", "/crm/v3/pipelines/deals", undefined, 3],
    ["PATCH, retries=3 (a person's push)", "PATCH", "/crm/v3/objects/contacts/1", PATCH_BODY, 3],
    ["POST search, retries=3", "POST", "/crm/v3/objects/contacts/search", { limit: 1 }, 3],
    ["POST, retries=2 (searchObjects)", "POST", "/crm/v3/objects/contacts/search", { limit: 2 }, 2],
  ];

  it.each(CALLS)("%s", async (_c, method, path, body, retries) => {
    hsRetry.sleep = realSleep;
    let compared = 0;
    for (const [kind, down] of KINDS) for (const outage of OUTAGES) {
      const off = await runOutage(() => hsAt3064076(ON, method, path, body, retries), down, outage);
      if (!("value" in off.ended)) continue;                     // off gives up: nothing to keep up with
      for (const age of AGES) for (const r of [0, 0.999]) {
        hsRetry.random = () => r;
        const on = await runOutage(() => hs(age === null ? ON : withHsRetryDeadline(ON, Date.now() - age),
          method, path, body, retries), down, outage);
        const what = `${kind}, down ${outage} ms, invocation ${age ?? "none"}, jitter ${r}`;
        expect(on.ended, what).toEqual(off.ended);
        expect(on.sent.length, what).toBeLessThanOrEqual(6);
        expect(on.sent.at(-1)!, what).toBeLessThanOrEqual(8_000);
        compared++;
      }
    }
    // Not vacuous: at the least every kind's zero-length outage, at every age and jitter -- and for a caller
    // that retries, every outage off's own schedule outlasts.
    expect(compared).toBeGreaterThanOrEqual(KINDS.length * AGES.length * 2 * (retries > 1 ? 3 : 1));
  });
});

/** Every hs(...) call in src/ (comments stripped), as its top-level argument texts. */
function hsCalls(): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const file of listSources()) {
    const code: string = readCode(file);
    for (const m of code.matchAll(/\bhs\(/g)) {
      if (/function\s*$/.test(code.slice(Math.max(0, m.index! - 12), m.index))) continue;   // its definition
      const args: string[] = [];
      let cur = "", depth = 0, quote: string | null = null;
      for (let i = m.index! + 3; i < code.length; i++) {
        const c = code[i];
        if (quote) { cur += c; if (c === "\\") cur += code[++i]; else if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
        if ("([{".includes(c)) depth++;
        if (")]}".includes(c) && depth-- === 0) break;
        if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
        cur += c;
      }
      out.push([file, [...args, cur.trim()].filter(a => a !== "")]);
    }
  }
  return out;
}

describe("structure: every caller passes hs() at most 3 retries", () => {
  it("so today's floor waits 2 + 4 = 6 s at most, inside a call's 8 s (hs-retry.ts maxTotalWaitMs)", () => {
    const calls = hsCalls();
    expect(calls.length).toBeGreaterThan(30);                    // the scan found them
    for (const [file, args] of calls) {
      expect(args.length, `${file}: hs(${args.join(", ")})`).toBeGreaterThanOrEqual(3);
      if (args.length >= 5) expect(["1", "2", "3"], `${file}: hs(${args.join(", ")})`).toContain(args[4]);
    }
  });
});

describe("structure: hs() is 3064076's hs() plus exactly one early return", () => {
  it("and nothing else in it changed", () => {
    const src = readSource("hubspot.ts");
    const start = src.indexOf("export async function hs(");
    const current = src.slice(start, src.indexOf("\n}\n", start) + 3);
    const GATE = [
      '  // HS_RATE_LIMIT_RETRY: the rate-limit-aware retry (hsRateLimited). Off -- anything but the literal "true",',
      "  // or not the CRM Worker -- every request runs through the loop below exactly as it always has.",
      "  if (hsRateLimitRetryOn(env)) return hsRateLimited(env, method, path, body, retries);",
      "",
    ].join("\n");
    expect(current).toContain(GATE);
    expect(current.replace(GATE, "")).toBe(readFixture("hs-3064076.json").text);
  });
});
