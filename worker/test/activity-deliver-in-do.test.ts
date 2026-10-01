import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  afterOutcome, nextDelayMs, scheduleFor, scheduleDelivery,
  DELIVER_SCHEDULE_MS, RECONCILE_SCHEDULE_MS, RETRY_SCHEDULE_MS, type PendingActivity,
} from "../src/activity-retry";
import type { Env } from "../src/types";

/**
 * THE FIRST DELIVERY OF A HUBSPOT ACTIVITY RUNS ON ITS DURABLE OBJECT, NOT IN THE WEBHOOK.
 *
 * Measured 2026-09-23 on the live CRM boards: of 160 (email, card) deliveries since the previous
 * deploy, 136 held exactly two copies. Always ONE destination of a multi-recipient email -- email
 * 401599611617 landed once on two of its contacts and twice on the third, in a single delivery. The
 * webhook ran the delivery in waitUntil, which Cloudflare cancels ~30 s after the response; writing an
 * email to several cards on ~96k-item boards takes longer than that. A cancellation between a create
 * and its settle left that destination's reservation unsettled, the next pass wrote it again, and every
 * destination after it was never written at all.
 *
 * So: the webhook only records the job; the alarm, which waitUntil does not bound, delivers it.
 */

const sync = vi.hoisted(() => ({ syncHubspotActivity: vi.fn() }));
vi.mock("../src/activity-sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/activity-sync")>();
  return { ...real, syncHubspotActivity: sync.syncHubspotActivity, activitySyncEnabled: () => true };
});
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

const { handleHubspot } = await import("../src/webhooks");
const { ActivityRetry } = await import("../src/activity-retry-do");

/** A real ActivityRetry per name, over in-memory storage, so schedule() and alarm() are the real code. */
function doNamespace(opts: { failSchedule?: boolean } = {}) {
  const instances = new Map<string, { do: any; map: Map<string, any>; alarmAt: number | null }>();
  const make = (name: string) => {
    const map = new Map<string, any>();
    const self: any = { map, alarmAt: null };
    const ctx = {
      storage: {
        get: async (k: string) => map.get(k), put: async (k: string, v: any) => { map.set(k, v); },
        delete: async (k: string) => { map.delete(k); }, deleteAll: async () => { map.clear(); },
        setAlarm: async (t: number) => { self.alarmAt = t; }, deleteAlarm: async () => { self.alarmAt = null; },
        getAlarm: async () => self.alarmAt,
      },
      blockConcurrencyWhile: async (fn: () => any) => fn(),
    };
    self.do = new (ActivityRetry as any)(ctx, env);
    instances.set(name, self);
    return self;
  };
  const env = {
    ENABLE_ACTIVITY_SYNC: "true",
    ACTIVITY_RETRY: {
      idFromName: (n: string) => n,
      get: (n: string) => {
        if (opts.failSchedule) return { schedule: async () => { throw new Error("DO unreachable"); } };
        const inst = instances.get(n) ?? make(n);
        return { schedule: (j: PendingActivity) => inst.do.schedule(j), record: async () => {} };
      },
    },
  } as unknown as Env;
  return { env, instances };
}

const waits: Promise<unknown>[] = [];
const ectx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } as unknown as ExecutionContext;
async function fireEmailCreation(env: Env, id = "401599611617") {
  waits.length = 0;
  const res = await handleHubspot(new Request("https://w.example/webhooks/hubspot", {
    method: "POST",
    body: JSON.stringify([{ subscriptionType: "object.creation", objectTypeId: "0-49", objectId: Number(id), portalId: 39939588 }]),
  }), env, ectx);
  await Promise.all(waits);
  return res;
}

beforeEach(() => { vi.clearAllMocks(); sync.syncHubspotActivity.mockResolvedValue("created"); });

describe("the webhook records the delivery; it does not run it", () => {
  it("answers 200 and schedules an immediate alarm, running no sync itself", async () => {
    const { env, instances } = doNamespace();
    const before = Date.now();
    const res = await fireEmailCreation(env);

    expect(res.status).toBe(200);
    expect(sync.syncHubspotActivity).not.toHaveBeenCalled();
    const inst = instances.get("act:retry:emails:401599611617")!;
    expect(inst.map.get("job")).toMatchObject({ mode: "deliver", object: "emails", hubspotId: "401599611617", attempts: 0 });
    expect(inst.alarmAt).toBeGreaterThanOrEqual(before);
    expect(inst.alarmAt! - Date.now()).toBeLessThanOrEqual(0);        // now, not in a minute
  });

  it("a redelivered webhook does not start a second clock", async () => {
    const { env, instances } = doNamespace();
    await fireEmailCreation(env);
    const first = { ...instances.get("act:retry:emails:401599611617")!.map.get("job") };
    await fireEmailCreation(env);
    expect(instances.get("act:retry:emails:401599611617")!.map.get("job")).toEqual(first);
    expect(sync.syncHubspotActivity).not.toHaveBeenCalled();
  });

  it("when the job cannot be recorded, it delivers inline exactly as before", async () => {
    const { env } = doNamespace({ failSchedule: true });
    await fireEmailCreation(env);
    expect(sync.syncHubspotActivity).toHaveBeenCalledTimes(1);
    expect(sync.syncHubspotActivity).toHaveBeenCalledWith(env, "emails", "401599611617");
  });

  it("an inline fallback that throws does not escape the webhook", async () => {
    sync.syncHubspotActivity.mockRejectedValue(new Error("HubSpot 502"));
    const { env } = doNamespace({ failSchedule: true });
    const res = await fireEmailCreation(env);          // Promise.all(waits) would reject if it escaped
    expect(res.status).toBe(200);
  });

  it("with no retry namespace bound, it delivers inline", async () => {
    const env = { ENABLE_ACTIVITY_SYNC: "true" } as unknown as Env;
    expect(await scheduleDelivery(env, "emails", "1")).toBe(false);
    await fireEmailCreation(env);
    expect(sync.syncHubspotActivity).toHaveBeenCalledTimes(1);
  });
});

describe("the alarm delivers, then keeps the two reconcile looks", () => {
  it("delivers once, hands over to a reconcile at +30s, and ends after both looks", async () => {
    const { env, instances } = doNamespace();
    await fireEmailCreation(env);
    const inst = instances.get("act:retry:emails:401599611617")!;

    await inst.do.alarm();                                   // the delivery
    expect(sync.syncHubspotActivity).toHaveBeenCalledTimes(1);
    expect(inst.map.get("job")).toMatchObject({ mode: "reconcile", attempts: 0 });
    expect(inst.alarmAt! - Date.now()).toBeGreaterThan(25_000);

    await inst.do.alarm();                                   // look #1
    expect(inst.map.get("job")).toMatchObject({ mode: "reconcile", attempts: 1 });
    await inst.do.alarm();                                   // look #2
    expect(inst.map.get("job")).toBeUndefined();
    expect(sync.syncHubspotActivity).toHaveBeenCalledTimes(3);
  });

  it("an unresolved delivery is retried on the ordinary schedule", async () => {
    sync.syncHubspotActivity.mockResolvedValue("unresolved");
    const { env, instances } = doNamespace();
    await fireEmailCreation(env);
    const inst = instances.get("act:retry:emails:401599611617")!;
    await inst.do.alarm();
    expect(inst.map.get("job")).toMatchObject({ mode: "deliver", attempts: 1, reason: "unresolved" });
    expect(Math.round((inst.alarmAt! - Date.now()) / 1000)).toBe(60);
  });

  /**
   * "error" = a create was sent and its result is unknown. Never retried SOON (that makes duplicates),
   * but looked at once more at 15 minutes, when the reservation is stale and the takeover checks the
   * card first (activity-stale-reservation.test.ts): a landed entry is settled, a lost one written once.
   */
  it("a create that threw is retried once, no sooner than 15 minutes, then never again", async () => {
    sync.syncHubspotActivity.mockResolvedValue("error");
    const { env, instances } = doNamespace();
    await fireEmailCreation(env);
    const inst = instances.get("act:retry:emails:401599611617")!;
    await inst.do.alarm();
    expect(inst.map.get("job")).toMatchObject({ mode: "retry", attempts: 2, reason: "error" });
    expect(inst.alarmAt! - Date.now()).toBeGreaterThanOrEqual(15 * 60_000 - 1_000);
    await inst.do.alarm();                                   // the late look errors again ...
    expect(inst.map.get("job")).toBeUndefined();             // ... and that is the end of it
    expect(sync.syncHubspotActivity).toHaveBeenCalledTimes(2);
  });

  it("an orphaned job (stored, no alarm) is re-armed by the next webhook instead of swallowing it", async () => {
    const { env, instances } = doNamespace();
    await fireEmailCreation(env);
    const inst = instances.get("act:retry:emails:401599611617")!;
    inst.alarmAt = null;                                     // the runtime killed the alarm outright
    await fireEmailCreation(env);
    expect(inst.alarmAt).not.toBeNull();
    expect(inst.map.get("job")).toMatchObject({ mode: "deliver", attempts: 0 });
  });
});

describe("the deliver policy", () => {
  const job = (over: Partial<PendingActivity> = {}): PendingActivity =>
    ({ mode: "deliver", object: "emails", hubspotId: "1", reason: "webhook", attempts: 0, firstSeenMs: 0, ...over });

  it("is the retry schedule with an immediate first slot", () => {
    expect(DELIVER_SCHEDULE_MS).toEqual([0, ...RETRY_SCHEDULE_MS]);
    expect(scheduleFor("deliver")[0]).toBe(0);
    expect(nextDelayMs(1, "deliver")).toBe(RETRY_SCHEDULE_MS[0]);
    expect(nextDelayMs(DELIVER_SCHEDULE_MS.length, "deliver")).toBeNull();
  });

  it("an association change is read from its from*/to* ends, either side", async () => {
    const { extractActivityEvents } = await import("../src/webhooks");
    expect(extractActivityEvents([{ subscriptionType: "object.associationChange",
      fromObjectTypeId: "0-49", fromObjectId: 401599611617, toObjectTypeId: "0-1", toObjectId: 553246071482 }]))
      .toEqual([{ object: "emails", id: "401599611617" }]);
    expect(extractActivityEvents([{ subscriptionType: "object.associationChange",
      fromObjectTypeId: "0-2", fromObjectId: 22041962312, toObjectTypeId: "0-46", toObjectId: 400990467833 }]))
      .toEqual([{ object: "notes", id: "400990467833" }]);
    // a contact<->company change names no activity at all
    expect(extractActivityEvents([{ subscriptionType: "object.associationChange",
      fromObjectTypeId: "0-1", fromObjectId: 1, toObjectTypeId: "0-2", toObjectId: 2 }])).toEqual([]);
  });

  it.each(["created", "skipped"] as const)("%s hands over to a fresh reconcile", (o) => {
    expect(afterOutcome(job(), o, 0)).toEqual({ action: "retry", delayMs: RECONCILE_SCHEDULE_MS[0],
      job: expect.objectContaining({ mode: "reconcile", attempts: 0, reason: "association-settle" }) });
  });

  it("gives up after the same number of retries as before, not more", () => {
    expect(afterOutcome(job({ attempts: RETRY_SCHEDULE_MS.length }), "unresolved", 0).action).toBe("die");
    expect(afterOutcome(job({ attempts: RETRY_SCHEDULE_MS.length - 1 }), "unresolved", 0).action).toBe("retry");
  });

  it("the other modes are unchanged", () => {
    expect(scheduleFor()).toBe(RETRY_SCHEDULE_MS);
    expect(scheduleFor("retry")).toBe(RETRY_SCHEDULE_MS);
    expect(scheduleFor("reconcile")).toBe(RECONCILE_SCHEDULE_MS);
    expect(afterOutcome({ ...job(), mode: "retry" }, "created", 0)).toEqual({ action: "done" });
  });
});
