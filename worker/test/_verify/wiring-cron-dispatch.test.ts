import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../src/types";
// @ts-ignore -- a .mjs helper with a .d.mts beside it
import { readWranglerConfig, readWmConfig } from "../../scripts/read-wrangler.mjs";

/**
 * WIRING LENS -- the cron dispatch, end to end: the REAL scheduled() handler and the REAL follow-up-reminder module
 * (and the real activity-registry lock, on an in-memory CREATE_IDEMPOTENCY namespace). Only HubSpot's hs(), the
 * task poller and the marketing poller are mocked. Proves, for the deployed configs:
 *   - CRM Worker, armed: "*\/5" runs the reminder (one search, one run line, its lock taken and released) and never
 *     the task poller;
 *   - CRM Worker, not armed: "*\/5" does nothing at all (no search, no task poll, no line);
 *   - a Worker without ENABLE_CRM (the WM source) still task-polls on "*\/5" -- and the WM config schedules no
 *     "*\/5" anyway, so the live WM Worker never receives it;
 *   - "*\/15" never runs the reminder.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const tasks = vi.hoisted(() => ({ pollTasks: vi.fn(async () => ({})), reconcileRecentTasks: vi.fn(async () => ({})) }));
const mkt = vi.hoisted(() => ({ pollMarketingEmails: vi.fn(async () => ({})) }));
vi.mock("../../src/hubspot", async (orig) => ({ ...(await orig<any>()), hs: hub.hs }));
vi.mock("../../src/task-poller", () => tasks);
vi.mock("../../src/marketing-email-poller", async (orig) => ({ ...(await orig<any>()), ...mkt }));

const worker = (await import("../../src/index")).default;

/** CREATE_IDEMPOTENCY in memory: CreateIdempotency's lock and note methods, every call recorded by DO name. */
function fakeIdempotency() {
  const state = new Map<string, Map<string, any>>();
  const calls: { name: string; method: string; args: unknown[] }[] = [];
  const of = (n: string) => { if (!state.has(n)) state.set(n, new Map()); return state.get(n)!; };
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => {
      const s = of(name);
      const rec = (method: string, args: unknown[]) => { calls.push({ name, method, args }); };
      return {
        async claimLock(now: number, hold: number, owner: string) {
          rec("claimLock", [now, hold, owner]);
          const r = s.get("lock");
          if (r && r.owner !== owner && now - r.at < hold) return false;
          s.set("lock", { at: now, owner }); return true;
        },
        async renewLock(now: number, owner: string) {
          rec("renewLock", [now, owner]);
          const r = s.get("lock");
          if (!r || r.owner !== owner) return false;
          s.set("lock", { at: now, owner }); return true;
        },
        async releaseLock(owner: string) {
          rec("releaseLock", [owner]);
          const r = s.get("lock");
          if (!r || r.owner !== owner) return false;
          s.delete("lock"); return true;
        },
        async getCard() { rec("getCard", []); return s.get("card")?.itemId ?? null; },
        async rememberPermanent(v: string) { rec("rememberPermanent", [v]); s.set("card", { itemId: v }); },
      };
    },
  };
  return { ns, calls };
}

const ectx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const cron = (c: string) => ({ cron: c, scheduledTime: Date.now() }) as unknown as ScheduledEvent;
let logs: string[];
let fake: ReturnType<typeof fakeIdempotency>;
const runLines = () => logs.filter(l => l.startsWith("[follow-up] action=run "));
const searches = () => hub.hs.mock.calls.filter(c => c[1] === "POST" && String(c[2]).includes("/contacts/search"));

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  fake = fakeIdempotency();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  hub.hs.mockImplementation(async () => ({ total: 0, results: [] }));
});
afterEach(() => vi.restoreAllMocks());

const crm = (extra: Record<string, string> = {}) =>
  ({ ENABLE_CRM: "true", DRY_RUN: "false", CREATE_IDEMPOTENCY: fake.ns, ...extra }) as unknown as Env;

describe("index.ts dispatch, through the real reminder", () => {
  it("CRM Worker, armed: */5 runs the reminder -- one search, one run line, lock:follow-up taken and released -- never the task poller", async () => {
    await worker.scheduled(cron("*/5 * * * *"), crm({ FOLLOW_UP_REMINDER: "true" }), ectx());
    expect(searches()).toHaveLength(1);
    expect(runLines()).toHaveLength(1);
    expect(tasks.pollTasks).not.toHaveBeenCalled();
    expect(fake.calls.filter(c => c.name === "lock:follow-up").map(c => c.method)).toEqual(["claimLock", "releaseLock"]);
  });

  it("CRM Worker, not armed: */5 does nothing at all", async () => {
    for (const v of [undefined, "false", "TRUE"]) {
      await worker.scheduled(cron("*/5 * * * *"), crm(v === undefined ? {} : { FOLLOW_UP_REMINDER: v }), ectx());
    }
    expect(hub.hs).not.toHaveBeenCalled();
    expect(tasks.pollTasks).not.toHaveBeenCalled();
    expect(runLines()).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("a Worker without ENABLE_CRM (the WM source) still task-polls on */5, even with the reminder's var leaked onto it", async () => {
    const e = ectx();
    await worker.scheduled(cron("*/5 * * * *"), { FOLLOW_UP_REMINDER: "true", CREATE_IDEMPOTENCY: fake.ns } as unknown as Env, e);
    expect(tasks.pollTasks).toHaveBeenCalledTimes(1);
    expect((e.waitUntil as any).mock.calls).toHaveLength(1);
    expect(hub.hs).not.toHaveBeenCalled();
    expect(runLines()).toHaveLength(0);
  });

  it("*/15 on the armed CRM Worker never runs the reminder", async () => {
    await worker.scheduled(cron("*/15 * * * *"), crm({ FOLLOW_UP_REMINDER: "true", ENABLE_LAD_SWEEP: "false" }), ectx());
    expect(mkt.pollMarketingEmails).toHaveBeenCalledTimes(1);
    expect(searches()).toHaveLength(0);
    expect(runLines()).toHaveLength(0);
  });

  it("the deployed configs: CRM schedules */5 and */15 only; the WM config schedules no */5 and no reminder var", () => {
    expect(readWranglerConfig().triggers?.crons).toEqual(["*/15 * * * *", "*/5 * * * *"]);
    const wm = readWmConfig();
    expect(wm.triggers?.crons ?? []).not.toContain("*/5 * * * *");
    expect((wm.vars ?? {}).FOLLOW_UP_REMINDER).toBeUndefined();
    expect((wm.vars ?? {}).ENABLE_CRM).not.toBe("true");
  });
});
