import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "../src/types";

/**
 * HS_RATE_LIMIT_RETRY: THE INVOCATION'S RETRY DEADLINE IS SET WHERE A WEBHOOK ARRIVES (index.ts fetch), AND
 * ONLY THERE.
 *
 * The switch's own retry waits end 20 s after a webhook arrived (hs-retry.ts withHsRetryDeadline), so its work
 * -- run in a waitUntil Cloudflare cancels ~30 s on -- does not outwait that window where off would have failed
 * at once and been logged. That holds only if the two webhook handlers are given the env that carries the
 * deadline: pinned here against the real fetch handler, with the handlers stubbed to capture what they receive.
 *
 * Every other route works while its client waits (the /app API, /resync, /run, ...), with no 30 s cut-off: it
 * gets the env as it came, so the switch's retries are bounded per call only there, like the cron's. Off, every
 * route receives the very same env object it always did.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown; env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  },
}));
const hooks = vi.hoisted(() => ({
  handleMonday: vi.fn(async (..._a: unknown[]) => new Response("ok")),
  handleHubspot: vi.fn(async (..._a: unknown[]) => new Response("ok")),
  safeEq: vi.fn((a: string, b: string) => a === b),
}));
vi.mock("../src/webhooks", () => hooks);
/** The sync entry points the operator and /app routes call, stubbed to capture the env they are handed. */
const sync = vi.hoisted(() => ({
  getCtxCached: vi.fn(async (..._a: unknown[]) => ({ ownersById: {}, labels: {} })),
  syncHubspotRecord: vi.fn(async (..._a: unknown[]) => "action=in-sync"),
  runAll: vi.fn(async (..._a: unknown[]) => ({})),
}));
vi.mock("../src/sync", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/sync")>()), ...sync }));

const { hsRetryDeadlineOf } = await import("../src/hs-retry");
const worker = (await import("../src/index")).default;
const ectx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const ROUTES: [string, typeof hooks.handleMonday][] = [
  ["/webhooks/monday/key", hooks.handleMonday],
  ["/webhooks/monday", hooks.handleMonday],
  ["/webhooks/hubspot", hooks.handleHubspot],
];
const envOf = (vars: Record<string, string>) =>
  ({ ...vars, HUBSPOT_ACCESS_TOKEN: "x", DRY_RUN: "true", TRIGGER_SECRET: "s3cret" }) as unknown as Env;
const hit = (path: string, env: Env) =>
  worker.fetch(new Request(`https://w${path}`, { method: "POST", body: "{}" }), env, ectx);

/** Routes whose work runs while the client waits, each with the sync call that is handed its env. */
const IN_REQUEST: [string, string, string, string | undefined, () => unknown[] | undefined][] = [
  ["POST /resync", "POST", "/resync", JSON.stringify({ object: "contacts", ids: ["394787683005"] }),
    () => sync.syncHubspotRecord.mock.calls.at(-1)],
  ["GET /app/owners", "GET", "/app/owners", undefined, () => sync.getCtxCached.mock.calls.at(-1)],
  ["GET /run", "GET", "/run?object=contacts&mode=dry", undefined, () => sync.runAll.mock.calls.at(-1)],
];
const ask = (method: string, path: string, body: string | undefined, env: Env) =>
  worker.fetch(new Request(`https://w${path}`, { method, body, headers: { "x-trigger-secret": "s3cret" } }), env, ectx);

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("index.ts gives each webhook invocation its HubSpot retry deadline (HS_RATE_LIMIT_RETRY)", () => {
  it.each(ROUTES)("on: %s is handed a copy of env carrying a deadline 20 s from its start", async (path, handler) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const env = envOf({ ENABLE_CRM: "true", HS_RATE_LIMIT_RETRY: "true" });
    await hit(path, env);
    expect(handler).toHaveBeenCalledTimes(1);
    const got = handler.mock.calls[0][1] as Env;
    expect(got).not.toBe(env);
    expect(got).toEqual(expect.objectContaining(env));          // every var and binding, unchanged
    expect(hsRetryDeadlineOf(got)).toBe(1_000_000 + 20_000);
    expect(hsRetryDeadlineOf(env)).toBeUndefined();              // the runtime's env itself is untouched
  });

  it.each(IN_REQUEST)("on: %s works while its client waits -- it is handed the env as it came, no deadline",
    async (_label, method, path, body, call) => {
      const env = envOf({ ENABLE_CRM: "true", HS_RATE_LIMIT_RETRY: "true" });
      const res = await ask(method, path, body, env);
      expect(res.status).toBe(200);
      const args = call();
      expect(args).toBeDefined();                                // the route really reached its sync call
      expect(args![0]).toBe(env);                                // the very same object
      expect(hsRetryDeadlineOf(args![0] as Env)).toBeUndefined();
    });

  it.each([
    ["absent", { ENABLE_CRM: "true" }],
    ["\"false\"", { ENABLE_CRM: "true", HS_RATE_LIMIT_RETRY: "false" }],
    ["\"true\" on the WM Worker (no ENABLE_CRM)", { HS_RATE_LIMIT_RETRY: "true" }],
  ])("off (%s): every route is handed the very same env object, as before", async (_label, vars) => {
    for (const [path, handler] of ROUTES) {
      const env = envOf(vars);
      await hit(path, env);
      expect(handler.mock.calls.at(-1)?.[1]).toBe(env);
      expect(hsRetryDeadlineOf(env)).toBeUndefined();
    }
    const env = envOf(vars);
    await ask("GET", "/app/owners", undefined, env);
    expect(sync.getCtxCached.mock.calls.at(-1)?.[0]).toBe(env);
  });
});
