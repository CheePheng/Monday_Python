import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";

/**
 * WHAT A DRY RUN CANNOT SEE.
 *
 * `wrangler deploy --dry-run` type-checks and bundles; it does not tell you that a route you are
 * about to ship dereferences a Durable Object namespace the target Worker has never had. index.ts
 * exports ActivityRetry and DeferredSync unconditionally, but only the CRM deployment BINDS them.
 *
 * DEFERRED_SYNC was safe because Env declared it optional, so the compiler forced a guard.
 * ACTIVITY_RETRY was declared REQUIRED — a lie, on the Work Management deployment — so no guard was
 * ever demanded, and `GET /activity-dead-letters` read straight through it. That route is gated by
 * x-trigger-secret, and WM HAS TRIGGER_SECRET, so WM could serve it and throw.
 *
 * These tests pin the behaviour on a WM-shaped env: one with no ACTIVITY_RETRY at all.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any; env: any;
    constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
  },
}));

/** The Work Management binding set: a trigger secret, and no activity namespaces. */
const wmEnv = (): Env => ({
  TRIGGER_SECRET: "t",
  MONDAY_API_TOKEN: "m",
  HUBSPOT_ACCESS_TOKEN: "h",
  DRY_RUN: "false",
} as unknown as Env);

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("GET /activity-dead-letters on a Worker without ACTIVITY_RETRY", () => {
  it("answers instead of throwing", async () => {
    const worker = (await import("../src/index")).default;
    const res = await worker.fetch(
      new Request("https://w/activity-dead-letters", { headers: { "x-trigger-secret": "t" } }),
      wmEnv(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, reason: "ACTIVITY_RETRY not bound on this deployment" });
  });

  /** The guard must not become a way past the secret. */
  it("still refuses without the trigger secret", async () => {
    const worker = (await import("../src/index")).default;
    const res = await worker.fetch(
      new Request("https://w/activity-dead-letters"), wmEnv(), ctx);
    expect(res.status).toBe(403);
  });

  /** And where the namespace IS bound, the route must still read it. */
  it("reads the dead-letter index when the namespace exists", async () => {
    const listDead = vi.fn(async () => [{ object: "emails", hubspotId: "7" }]);
    const env = { ...wmEnv(), ACTIVITY_RETRY: {
      idFromName: (n: string) => n,
      get: () => ({ listDead }),
    } } as unknown as Env;

    const worker = (await import("../src/index")).default;
    const res = await worker.fetch(
      new Request("https://w/activity-dead-letters", { headers: { "x-trigger-secret": "t" } }),
      env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1, dead: [{ object: "emails", hubspotId: "7" }] });
    expect(listDead).toHaveBeenCalled();
  });
});

describe("the retry schedulers on a Worker without ACTIVITY_RETRY", () => {
  /** These are fire-and-forget by design: they sit on the webhook path and must never fail it.
   *  The outcome has to be a RETRYABLE one, or the function returns before it ever touches the
   *  binding and the test proves nothing. */
  it("scheduleIfUnresolved stays quiet", async () => {
    const { scheduleIfUnresolved, shouldRetry } = await import("../src/activity-retry");
    expect(shouldRetry("unresolved")).toBe(true);
    await expect(scheduleIfUnresolved(wmEnv(), "emails", "1", "unresolved")).resolves.toBeUndefined();
  });

  it("scheduleReconcile stays quiet", async () => {
    const { scheduleReconcile } = await import("../src/activity-retry");
    await expect(scheduleReconcile(wmEnv(), "emails", "1")).resolves.toBeUndefined();
  });

  /** ...but quiet is not the same as invisible: the log must name the real reason, not a TypeError
   *  about reading a property of undefined. */
  it("logs the missing binding by name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { scheduleIfUnresolved } = await import("../src/activity-retry");
    await scheduleIfUnresolved(wmEnv(), "emails", "1", "unresolved");
    expect(log.mock.calls.flat().join(" ")).toContain("ACTIVITY_RETRY is not bound");
    log.mockRestore();
  });

  it("activityRetryBound reports the binding honestly", async () => {
    const { activityRetryBound } = await import("../src/activity-retry");
    expect(activityRetryBound(wmEnv())).toBe(false);
    expect(activityRetryBound({ ...wmEnv(), ACTIVITY_RETRY: {} } as unknown as Env)).toBe(true);
  });
});
