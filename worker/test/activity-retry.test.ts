import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  nextDelayMs, shouldRetry, stepForAlarm, afterOutcome, scheduleIfUnresolved,
  RETRY_SCHEDULE_MS, DISABLED_RECHECK_MS, MAX_DEFERRED_MS, DEAD_LETTER_CAP,
  retryName, DEAD_LETTER_NAME, type PendingActivity, type ActivityOutcome,
} from "../src/activity-retry";
import type { Env } from "../src/types";

/**
 * DURABLE RETRY — the gap that remained after the in-invocation backoff.
 *
 * The ~22s lookup retry covers the ordinary race. What it cannot do is survive the invocation: the
 * webhook was answered 200 from inside waitUntil, so nothing redelivers it, and an activity whose
 * card is still invisible at 22 seconds was previously gone for good — silently, because a missing
 * timeline line looks exactly like a rep who wrote nothing.
 *
 * Everything below is driven through the REAL ActivityRetry alarm calling the REAL
 * syncHubspotActivity, against in-memory fakes for storage, HubSpot and monday. The create-once
 * property is the whole point, so a fake registry that always says "proceed" would prove nothing —
 * the registry fake implements the durable contract.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const mondayApi = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn() }));

// The Workers base class, stubbed so the real DO can be constructed under plain node.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

const reg = vi.hoisted(() => {
  const settled = new Map<string, string>();
  const inflight = new Set<string>();
  const cycles = new Map<string, string>();
  // Mirrors the real key: contact keeps its original three-part shape so pre-existing durable
  // mappings stay readable; company and deal get their own namespace.
  const h2m = (o: string, i: string, k: string, d: string) =>
    k === "contact" ? `act:h2m:${o}:${i}:${d}` : `act:h2m:${o}:${i}:${k}:${d}`;
  const m2h = (t: string) => `act:m2h:${t}`;
  const claim = (k: string) => {
    if (settled.has(k)) return { status: "have", id: settled.get(k)! };
    if (inflight.has(k)) return { status: "creating" };
    inflight.add(k);
    return { status: "proceed" };
  };
  const settle = (k: string, v: string) => { settled.set(k, v); inflight.delete(k); };
  return {
    settled, inflight, cycles,
    m2hReservationKey: m2h, h2mReservationKey: h2m,
    claimActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string) =>
      claim(h2m(o, i, k, d))),
    settleActivityToMonday: vi.fn(async (_e: Env, o: string, i: string, k: string, d: string, t: string) =>
      settle(h2m(o, i, k, d), t)),
    unresolvedActivityToMonday: vi.fn(),
    claimActivityToHubspot: vi.fn(async (_e: Env, t: string) => claim(m2h(t))),
    settleActivityToHubspot: vi.fn(async (_e: Env, t: string, h: string) => settle(m2h(t), h)),
    unresolvedActivityToHubspot: vi.fn(),
    claimHubspotAsRepresented: vi.fn(async (_e: Env, o: string, i: string, c: string, m: string) =>
      settle(h2m(o, i, "contact", c), `monday:${m}`)),
    releaseActivity: vi.fn(async (_e: Env, k: string) => { inflight.delete(k); }),
    lastOwnerCycle: vi.fn(async (_e: Env, c: string) => cycles.get(c) ?? null),
    rememberOwnerCycle: vi.fn(async (_e: Env, c: string, v: string) => { cycles.set(c, v); }),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => mondayApi);
vi.mock("../src/activity-registry", () => reg);

const { ActivityRetry } = await import("../src/activity-retry-do");
const { syncHubspotActivity } = await import("../src/activity-sync");

const CONTACT = "550936454903";
const CARD = "2859742407";
const ACT = "400330119878";

// ---------------------------------------------------------------- fakes

/** Minimal DurableObjectState: one key-value map and one alarm. */
function fakeCtx() {
  const map = new Map<string, any>();
  const self = {
    alarmAt: null as number | null,
    storage: {
      get: async (k: string) => map.get(k),
      put: async (k: string, v: any) => { map.set(k, v); },
      delete: async (k: string) => { map.delete(k); },
      deleteAll: async () => { map.clear(); },
      setAlarm: async (t: number) => { self.alarmAt = t; },
      deleteAlarm: async () => { self.alarmAt = null; },
      getAlarm: async () => self.alarmAt,
    },
    blockConcurrencyWhile: async (fn: () => any) => fn(),
    map,
  };
  return self;
}

let deadLetters: any[] = [];
let scheduled: PendingActivity[] = [];
/** The namespace binding: every instance the code asks for, by name. */
function fakeNamespace() {
  return {
    idFromName: (n: string) => n,
    get: (n: string) => ({
      // the dead-letter index instance
      record: async (d: any) => { deadLetters.unshift(d); },
      listDead: async () => deadLetters,
      // a per-activity instance, used only by scheduleIfUnresolved in these tests
      schedule: async (job: PendingActivity) => { scheduled.push({ ...job, object: job.object }); return "scheduled"; },
      _name: n,
    }),
  };
}

let helper = "";
let createdTimeline: any[] = [];
let cardVisible = true;
let contactAssociated = true;

const baseEnv = () => ({
  ENABLE_ACTIVITY_SYNC: "true",
  ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z",
  ACTIVITY_RETRY: fakeNamespace(),
} as unknown as Env);

beforeEach(() => {
  vi.clearAllMocks();
  reg.settled.clear(); reg.inflight.clear(); reg.cycles.clear();
  deadLetters = []; scheduled = []; createdTimeline = []; helper = "";
  cardVisible = true; contactAssociated = true;

  mondayApi.findItemByColumn.mockImplementation(async () => (cardVisible ? [{ id: CARD }] : []));
  mondayApi.gql.mockImplementation(async (_e: Env, q: string, v: any) => {
    if (q.includes("create_timeline_item")) {
      createdTimeline.push(v);
      return { create_timeline_item: { id: `tl${createdTimeline.length}` } };
    }
    if (q.includes("change_multiple_column_values")) return { change_multiple_column_values: { id: v.i } };
    if (q.includes("date_mm78yd2c")) return { items: [{ column_values: [{ text: helper }] }] };
    return { items: [{ column_values: [{ text: CONTACT }] }] };
  });
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, path: string) => {
    if (path.startsWith("/crm/v3/owners")) return { results: [{ id: "OWNER", email: "rep@dkmeco.com" }] };
    if (path === "/crm/v3/objects/contacts/batch/read") return { results: [] };
    if (path.startsWith("/crm/v3/objects/emails/")) return {
      properties: { hs_timestamp: "2026-09-12T10:00:00Z", hs_email_subject: "Following up",
        hs_email_direction: "EMAIL", hubspot_owner_id: "A" },
    };
    if (path.includes("/associations/contacts"))
      return { results: contactAssociated ? [{ toObjectId: CONTACT }] : [] };
    return { properties: { hubspot_owner_id: "A", hubspot_owner_assigneddate: "2026-09-10T08:00:00Z" } };
  });
});

afterEach(() => { vi.useRealTimers(); });

const job = (over: Partial<PendingActivity> = {}): PendingActivity =>
  ({ object: "emails", hubspotId: ACT, reason: "unresolved", attempts: 0,
     firstSeenMs: Date.now(), ...over });

/** Construct the real DO with a pending job already stored. */
function withJob(env: Env, j: PendingActivity) {
  const ctx = fakeCtx();
  ctx.map.set("job", j);
  const doInstance = new (ActivityRetry as any)(ctx, env);
  return { ctx, do: doInstance as InstanceType<typeof ActivityRetry> };
}

// ===================================================================================================
describe("the retry policy", () => {
  /** Bounded, not infinite: +1m, +5m, +15m, +1h, then stop. A contact that will never have a card
   *  must stop costing work and must become visible instead of humming forever. */
  it("follows the schedule and then terminates", () => {
    expect(RETRY_SCHEDULE_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect([0, 1, 2, 3].map(nextDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(nextDelayMs(4)).toBeNull();
  });

  /**
   * THE LINE THAT MATTERS MOST. `error` is raised AFTER the create request was sent, so the write may
   * well have landed — retrying it is exactly how a lost response becomes the duplicate this whole
   * subsystem exists to prevent. Only outcomes reached BEFORE any create may be queued.
   */
  it("never retries an outcome that may already have created something", () => {
    expect(shouldRetry("error")).toBe(false);
    expect(shouldRetry("created")).toBe(false);
    expect(shouldRetry("skipped")).toBe(false);
  });

  it("retries only the pre-create failures", () => {
    expect(["unresolved", "blocked", "creating"].map(o => shouldRetry(o as ActivityOutcome)))
      .toEqual([true, true, true]);
  });

  it("afterOutcome advances the attempt and picks the next delay", () => {
    expect(afterOutcome(job({ attempts: 0 }), "unresolved", 0))
      .toEqual({ action: "retry", job: expect.objectContaining({ attempts: 1 }), delayMs: 300_000 });
    expect(afterOutcome(job({ attempts: 3 }), "unresolved", 0).action).toBe("die");
    expect(afterOutcome(job(), "created", 0)).toEqual({ action: "done" });
    expect(afterOutcome(job(), "error", 0)).toEqual({ action: "done" });
  });

  /** A disabled feature must cost the job time, never an attempt — otherwise switching the canary off
   *  for an afternoon would silently burn the whole retry budget. */
  it("defers while the feature is off without spending an attempt", () => {
    const j = job({ firstSeenMs: 1_000 });
    expect(stepForAlarm(j, { enabled: false, nowMs: 2_000 }))
      .toEqual({ action: "defer", delayMs: DISABLED_RECHECK_MS });
    expect(stepForAlarm(j, { enabled: true, nowMs: 2_000 })).toEqual({ action: "run" });
  });

  /** But not forever: a job may not outlive anyone's memory of it. */
  it("gives up once the deferral limit passes", () => {
    const j = job({ firstSeenMs: 0 });
    expect(stepForAlarm(j, { enabled: false, nowMs: MAX_DEFERRED_MS + 1 }).action).toBe("die");
  });

  it("names one instance per activity, and one for the dead letters", () => {
    expect(retryName("emails", ACT)).toBe(`act:retry:emails:${ACT}`);
    expect(DEAD_LETTER_NAME).toBe("act:retry:dead");
  });
});

// ===================================================================================================
describe("scheduling is driven by the outcome, not by the error path", () => {
  it("the ordinary case never touches the queue", async () => {
    const env = baseEnv();
    const outcome = await syncHubspotActivity(env, "emails", ACT);
    expect(outcome).toBe("created");
    expect(createdTimeline).toHaveLength(1);
    await scheduleIfUnresolved(env, "emails", ACT, outcome);
    expect(scheduled).toEqual([]);
  });

  /** The gap this whole change closes: nothing redelivers this webhook, so it has to be persisted. */
  it("persists a pending job when the card never appears", async () => {
    vi.useFakeTimers();
    const env = baseEnv();
    cardVisible = false;
    const p = syncHubspotActivity(env, "emails", ACT);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await p;

    expect(outcome).toBe("unresolved");
    expect(createdTimeline).toEqual([]);
    await scheduleIfUnresolved(env, "emails", ACT, outcome);
    expect(scheduled).toEqual([expect.objectContaining({ object: "emails", hubspotId: ACT, attempts: 0 })]);
  });

  /**
   * THE CANARY MUST NOT GENERATE GARBAGE. While the allowlist is set, every activity in the portal
   * still reaches syncHubspotActivity. If an unrelated one on a contact with no card spent the full
   * backoff and came back "unresolved", it would be PERSISTED as a retry job — four more attempts and
   * a dead-letter entry, for work the canary must never touch. Out of scope is a settled decision
   * reached on the first pass.
   */
  it("an out-of-scope activity settles immediately and is never queued", async () => {
    vi.useFakeTimers();
    const env = { ...baseEnv(), ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "999999999" } as Env;
    cardVisible = false;                                  // the expensive path, if it were taken

    const p = syncHubspotActivity(env, "emails", ACT);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await p;

    expect(outcome).toBe("skipped");
    expect(mondayApi.findItemByColumn).not.toHaveBeenCalled();   // no card hunt at all
    // the record, then one association read per destination kind (contacts, companies, deals)
    expect(hubspot.hs).toHaveBeenCalledTimes(4);
    await scheduleIfUnresolved(env, "emails", ACT, outcome);
    expect(scheduled).toEqual([]);
  });

  it("a create that threw is NOT queued — it may have landed", async () => {
    const env = baseEnv();
    mondayApi.gql.mockImplementation(async (_e: Env, q: string) => {
      if (q.includes("create_timeline_item")) throw new Error("socket hang up");
      return { items: [{ column_values: [{ text: CONTACT }] }] };
    });
    const outcome = await syncHubspotActivity(env, "emails", ACT);
    expect(outcome).toBe("error");
    await scheduleIfUnresolved(env, "emails", ACT, outcome);
    expect(scheduled).toEqual([]);
  });
});

// ===================================================================================================
describe("the alarm", () => {
  /** The job's whole reason to exist: the card showed up late, and the activity still lands — once. */
  it("creates exactly one entry once the card appears", async () => {
    const env = baseEnv();
    const { ctx, do: retry } = withJob(env, job());
    await retry.alarm();

    expect(createdTimeline).toHaveLength(1);
    expect(ctx.map.get("job")).toBeUndefined();     // settled, nothing left to retry
    expect(ctx.alarmAt).toBeNull();
    expect(deadLetters).toEqual([]);
  });

  /**
   * THE RACE THE DURABLE MAPPING EXISTS FOR. A webhook redelivery and a queued retry can run against
   * the same activity; between them they must still produce ONE timeline entry.
   */
  it("a redelivery and a queued retry together still create exactly one entry", async () => {
    const env = baseEnv();
    const { do: retry } = withJob(env, job());
    await Promise.all([syncHubspotActivity(env, "emails", ACT), retry.alarm()]);
    await retry.alarm();                            // and a third pass, for good measure
    expect(createdTimeline).toHaveLength(1);
  });

  /** If something else completed the activity while the job waited, the job must evaporate quietly. */
  it("does nothing when the activity settled before the alarm fired", async () => {
    const env = baseEnv();
    reg.settled.set(`act:h2m:emails:${ACT}:${CONTACT}`, "tl-already-there");
    const { ctx, do: retry } = withJob(env, job());
    await retry.alarm();

    expect(createdTimeline).toEqual([]);
    expect(ctx.map.get("job")).toBeUndefined();
  });

  /**
   * CANARY ISOLATION. A job queued before the allowlist was set — or for a contact outside it — must
   * not become a back door around the canary boundary.
   */
  it("obeys the canary allowlist", async () => {
    const env = { ...baseEnv(), ACTIVITY_CANARY_HUBSPOT_CONTACT_ID: "999999999" } as Env;
    const { ctx, do: retry } = withJob(env, job());
    await retry.alarm();

    expect(createdTimeline).toEqual([]);
    expect(ctx.map.get("job")).toBeUndefined();     // a settled decision, not a retry
  });

  /**
   * FEATURE DISABLED. No writes — but the job is NOT destroyed, because a config flag must not be
   * able to delete pending work. It comes back later, with its attempt budget intact.
   */
  it("defers without writing while ENABLE_ACTIVITY_SYNC is off", async () => {
    const env = { ...baseEnv(), ENABLE_ACTIVITY_SYNC: "false" } as Env;
    const { ctx, do: retry } = withJob(env, job({ attempts: 1 }));
    await retry.alarm();

    expect(hubspot.hs).not.toHaveBeenCalled();
    expect(createdTimeline).toEqual([]);
    expect(ctx.map.get("job")).toEqual(expect.objectContaining({ attempts: 1 }));   // budget untouched
    expect(ctx.alarmAt).toBeGreaterThan(Date.now());
  });

  /** Still bounded, even while deferring. */
  it("gives up on a job that has been deferred past the limit", async () => {
    const env = { ...baseEnv(), ENABLE_ACTIVITY_SYNC: "false" } as Env;
    const { ctx, do: retry } = withJob(env, job({ firstSeenMs: Date.now() - MAX_DEFERRED_MS - 1 }));
    await retry.alarm();

    expect(ctx.map.get("job")).toBeUndefined();
    expect(deadLetters).toHaveLength(1);
  });

  /**
   * NO INFINITE RETRY, AND NO SILENT DISCARD. The failure is recorded where it can be looked at, and
   * the job is deleted rather than tombstoned so a genuinely new delivery months later can still
   * start a fresh cycle.
   */
  it("records a terminal failure and stops once the schedule is exhausted", async () => {
    vi.useFakeTimers();
    const env = baseEnv();
    cardVisible = false;
    const { ctx, do: retry } = withJob(env, job({ attempts: 3 }));

    const p = retry.alarm();
    await vi.advanceTimersByTimeAsync(30_000);
    await p;

    expect(createdTimeline).toEqual([]);
    expect(ctx.map.get("job")).toBeUndefined();
    expect(ctx.alarmAt).toBeNull();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toEqual(expect.objectContaining({
      object: "emails", hubspotId: ACT, attempts: 4,
      terminalReason: expect.stringContaining("after 4 attempts"),
    }));
  });

  /** A mid-schedule failure re-arms rather than dying, and spends exactly one attempt. */
  it("re-arms with the next delay when attempts remain", async () => {
    vi.useFakeTimers();
    const env = baseEnv();
    cardVisible = false;
    const { ctx, do: retry } = withJob(env, job({ attempts: 1 }));

    const p = retry.alarm();
    await vi.advanceTimersByTimeAsync(30_000);
    await p;

    expect(ctx.map.get("job")).toEqual(expect.objectContaining({ attempts: 2 }));
    // the third slot: 15 minutes. Asserted as a window because the alarm is set at the moment the
    // in-invocation backoff gives up, ~22s before the clock the assertion reads.
    expect(ctx.alarmAt! - Date.now()).toBeGreaterThan(900_000 - 30_000);
    expect(ctx.alarmAt! - Date.now()).toBeLessThanOrEqual(900_000);
    expect(deadLetters).toEqual([]);
  });

  /**
   * An alarm that throws would otherwise be retried by the RUNTIME on its own schedule, spending
   * attempts this code never counted. It is caught and re-armed deliberately, so there is one clock.
   *
   * Reaching it takes a throw from OUTSIDE syncHubspotActivity's own try — the registry claim, which
   * runs before it. That is the defensive case the catch exists for.
   */
  it("keeps one clock when the sync itself throws", async () => {
    const env = baseEnv();
    reg.claimActivityToMonday.mockRejectedValueOnce(new Error("durable object unreachable"));
    const { ctx, do: retry } = withJob(env, job({ attempts: 0 }));
    await retry.alarm();

    expect(ctx.map.get("job")).toEqual(expect.objectContaining({ attempts: 1 }));
    // A window, not equality: the alarm is stamped from the clock a moment before this reads it, and
    // an exact comparison fails whenever a millisecond ticks between the two.
    expect(ctx.alarmAt! - Date.now()).toBeGreaterThan(300_000 - 5_000);
    expect(ctx.alarmAt! - Date.now()).toBeLessThanOrEqual(300_000);
  });
});

// ===================================================================================================
describe("a failure BEFORE the create is retryable; one after it is not", () => {
  /**
   * THE DEFECT THIS PINS. Everything up to the create is reads — the HubSpot record, the association,
   * the card. A 503 on any of them used to be reported as "error" and therefore never retried, which
   * threw the activity away on the most ordinary outage there is.
   */
  it("a HubSpot read that fails is unresolved, and is queued", async () => {
    const env = baseEnv();
    hubspot.hs.mockRejectedValue(new Error("HubSpot 503"));
    const outcome = await syncHubspotActivity(env, "emails", ACT);

    expect(outcome).toBe("unresolved");
    // Nothing to release: a card is claimed only once it is known to exist, so a read that fails
    // before that point never took a reservation in the first place.
    expect(reg.releaseActivity).not.toHaveBeenCalled();
    expect(reg.claimActivityToMonday).not.toHaveBeenCalled();
    await scheduleIfUnresolved(env, "emails", ACT, outcome);
    expect(scheduled).toHaveLength(1);
  });

  /** And the other side of the line stays exactly as it was: never retried, reservation standing. */
  it("a create that fails is an error, and the reservation is NOT released", async () => {
    const env = baseEnv();
    mondayApi.gql.mockImplementation(async (_e: Env, q: string) => {
      if (q.includes("create_timeline_item")) throw new Error("socket hang up");
      return { items: [{ column_values: [{ text: CONTACT }] }] };
    });
    const outcome = await syncHubspotActivity(env, "emails", ACT);

    expect(outcome).toBe("error");
    expect(reg.releaseActivity).not.toHaveBeenCalled();
    expect(reg.unresolvedActivityToMonday).toHaveBeenCalled();
  });
});

// ===================================================================================================
describe("scheduling and the dead-letter index", () => {
  /** Redeliveries are ordinary. Each one resetting the alarm would turn a bounded schedule into an
   *  unbounded one driven by however often HubSpot happens to resend. */
  it("a second schedule for the same activity leaves the first job alone", async () => {
    const env = baseEnv();
    const ctx = fakeCtx();
    const retry = new (ActivityRetry as any)(ctx, env) as InstanceType<typeof ActivityRetry>;

    expect(await retry.schedule(job({ attempts: 0 }))).toBe("scheduled");
    const first = ctx.alarmAt;
    expect(await retry.schedule(job({ attempts: 0 }))).toBe("already-pending");
    expect(ctx.alarmAt).toBe(first);
  });

  it("the dead-letter index is capped", async () => {
    const env = baseEnv();
    const ctx = fakeCtx();
    const idx = new (ActivityRetry as any)(ctx, env) as InstanceType<typeof ActivityRetry>;
    for (let i = 0; i < DEAD_LETTER_CAP + 5; i++)
      await idx.record({ ...job({ hubspotId: String(i) }), diedAtMs: i, terminalReason: "x" });
    const all = await idx.listDead();
    expect(all).toHaveLength(DEAD_LETTER_CAP);
    expect(all[0].hubspotId).toBe(String(DEAD_LETTER_CAP + 4));   // newest first
  });
});
