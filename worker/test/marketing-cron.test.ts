import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { readCode } from "../scripts/read-source.mjs";

/**
 * THE 15-MINUTE CRON AND THE ON-DEMAND ROUTE, driven through the real scheduled() and fetch() handlers.
 *
 * The one property that matters most is that the cron RETURNS the poll: Cloudflare guarantees the
 * cron budget only to the promise scheduled() returns, and waitUntil is documented at ~30 seconds --
 * long enough to start a monday write, not always long enough to settle it.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));

const mkt = vi.hoisted(() => ({ pollMarketingEmails: vi.fn(), readLedger: vi.fn() }));
const tasks = vi.hoisted(() => ({ pollTasks: vi.fn(async () => ({})), reconcileRecentTasks: vi.fn(async () => ({})) }));
const lad = vi.hoisted(() => ({
  sweepLastActivity: vi.fn(async () => ({ status: "ran" })),
  ladSweepEnabled: (env: any) => env.ENABLE_CRM === "true" && env.ENABLE_LAD_SWEEP === "true",
}));
vi.mock("../src/marketing-email-poller", () => mkt);
vi.mock("../src/task-poller", () => tasks);
vi.mock("../src/lad-sweep", async (orig) => ({ sweepDeadline: (await orig<any>()).sweepDeadline, ...lad }));

const worker = (await import("../src/index")).default;

const crm = { ENABLE_CRM: "true", TRIGGER_SECRET: "s", DRY_RUN: "false" } as unknown as Env;
const wm = { TRIGGER_SECRET: "s", DRY_RUN: "false" } as unknown as Env;
const ectx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const cron = (c: string) => ({ cron: c, scheduledTime: Date.now() }) as unknown as ScheduledEvent;

beforeEach(() => {
  vi.clearAllMocks();
  mkt.pollMarketingEmails.mockReset().mockResolvedValue({ status: "ran" });
  lad.sweepLastActivity.mockReset().mockResolvedValue({ status: "ran" });
});

describe("the */15 cron", () => {
  it("RETURNS the poll: scheduled() does not settle until the poll has", async () => {
    let finish!: () => void;
    mkt.pollMarketingEmails.mockReturnValueOnce(new Promise<any>(res => { finish = () => res({ status: "ran" }); }));
    const c = ectx();
    let settled = false;
    const p = worker.scheduled(cron("*/15 * * * *"), crm, c).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(mkt.pollMarketingEmails).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);                   // still waiting on the poll
    expect((c as any).waitUntil).not.toHaveBeenCalled();
    finish();
    await p;
    expect(settled).toBe(true);
  });

  it("a poll that throws is logged, never an unhandled rejection", async () => {
    mkt.pollMarketingEmails.mockRejectedValueOnce(new Error("watermark unreadable"));
    await expect(worker.scheduled(cron("*/15 * * * *"), crm, ectx())).resolves.toBeUndefined();
  });

  it("runs the marketing poller -- not the Task poller or the Task sweep -- and no LAD sweep while its flag is off", async () => {
    await worker.scheduled(cron("*/15 * * * *"), crm, ectx());
    expect(tasks.pollTasks).not.toHaveBeenCalled();
    expect(tasks.reconcileRecentTasks).not.toHaveBeenCalled();
    expect(lad.sweepLastActivity).not.toHaveBeenCalled();
  });

  it("the Work Management Worker never polls, even if handed the expression", async () => {
    await worker.scheduled(cron("*/15 * * * *"), wm, ectx());
    expect(mkt.pollMarketingEmails).not.toHaveBeenCalled();
  });

  it.each(["*/5 * * * *", "0 4 * * *", "*/7 * * * *"])("%s does not start the marketing poller", async (c) => {
    await worker.scheduled(cron(c), crm, ectx());
    expect(mkt.pollMarketingEmails).not.toHaveBeenCalled();
  });

  it("structurally: the branch returns both promises and never detaches either", () => {
    const code = readCode("index.ts");
    expect(code).toContain('if (event.cron === "*/15 * * * *")');
    expect(code).toContain("const marketing = pollMarketingEmails(env)");
    expect(code).toContain("return marketing.then(sweep)");
    expect(code).not.toMatch(/waitUntil\(\s*(pollMarketingEmails|sweepLastActivity)/);
  });
});

/**
 * THE LAST ACTIVITY BACKSTOP rides the same cron (lad-sweep.ts). AFTER the poll, never beside it -- its
 * syncs must not share a moment (or the subrequest ceiling's peak) with the poll's create-then-settle --
 * with whatever time the cron has left, and awaited with it, for the same reason the poll is.
 */
describe("the */15 cron and the Last Activity sweep", () => {
  const on = { ...crm, ENABLE_LAD_SWEEP: "true" } as unknown as Env;

  it("runs AFTER the poll when ENABLE_LAD_SWEEP is \"true\" -- never beside its creates -- and scheduled() waits for BOTH", async () => {
    let endPoll!: () => void, endSweep!: () => void;
    mkt.pollMarketingEmails.mockReturnValueOnce(new Promise<any>(res => { endPoll = () => res({ status: "ran" }); }));
    lad.sweepLastActivity.mockReturnValueOnce(new Promise<any>(res => { endSweep = () => res({ status: "ran" }); }));
    const c = ectx();
    let settled = false;
    const p = worker.scheduled(cron("*/15 * * * *"), on, c).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(mkt.pollMarketingEmails).toHaveBeenCalledTimes(1);
    expect(lad.sweepLastActivity).not.toHaveBeenCalled();       // not while the poll can still be creating
    endPoll();
    await new Promise(r => setTimeout(r, 10));
    expect(lad.sweepLastActivity).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);                                // the sweep is still running
    endSweep();
    await p;
    expect(settled).toBe(true);
    expect((c as any).waitUntil).not.toHaveBeenCalled();
  });

  it("the sweep's deadline is what the cron has left: never a sync start past 13 minutes after it fired", async () => {
    const { SWEEP_BUDGET_MS, SWEEP_LATEST_START_MS } = await vi.importActual<any>("../src/lad-sweep");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.parse("2026-09-30T12:00:00Z");
      vi.setSystemTime(t0);
      // A long poll: ten minutes of creates, then a last settle.
      mkt.pollMarketingEmails.mockImplementationOnce(async () => { vi.setSystemTime(t0 + 11 * 60_000); return { status: "ran" }; });
      await worker.scheduled(cron("*/15 * * * *"), on, ectx());
      expect((lad.sweepLastActivity.mock.calls[0] as any[])[1]).toEqual({ deadlineMs: t0 + SWEEP_LATEST_START_MS });
      // A quick poll: the sweep keeps its own five minutes.
      lad.sweepLastActivity.mockClear();
      vi.setSystemTime(t0);
      mkt.pollMarketingEmails.mockImplementationOnce(async () => { vi.setSystemTime(t0 + 60_000); return { status: "ran" }; });
      await worker.scheduled(cron("*/15 * * * *"), on, ectx());
      expect((lad.sweepLastActivity.mock.calls[0] as any[])[1]).toEqual({ deadlineMs: t0 + 60_000 + SWEEP_BUDGET_MS });
    } finally { vi.useRealTimers(); }
  });

  it("a sweep that throws cannot take the poll down, nor leave an unhandled rejection", async () => {
    lad.sweepLastActivity.mockRejectedValueOnce(new Error("watermark unreadable"));
    await expect(worker.scheduled(cron("*/15 * * * *"), on, ectx())).resolves.toBeUndefined();
    expect(mkt.pollMarketingEmails).toHaveBeenCalledTimes(1);
  });

  it("a poll that throws cannot take the sweep down", async () => {
    mkt.pollMarketingEmails.mockRejectedValueOnce(new Error("boom"));
    await expect(worker.scheduled(cron("*/15 * * * *"), on, ectx())).resolves.toBeUndefined();
    expect(lad.sweepLastActivity).toHaveBeenCalledTimes(1);
  });

  it("never on the Work Management Worker, even with the flag and the expression", async () => {
    await worker.scheduled(cron("*/15 * * * *"), { ...wm, ENABLE_LAD_SWEEP: "true" } as unknown as Env, ectx());
    expect(lad.sweepLastActivity).not.toHaveBeenCalled();
  });

  it.each(["*/5 * * * *", "0 4 * * *", "*/10 * * * *"])("%s does not start it", async (c) => {
    await worker.scheduled(cron(c), { ...on, DRY_RUN: "true" } as unknown as Env, ectx());
    expect(lad.sweepLastActivity).not.toHaveBeenCalled();
  });
});

describe("POST /marketing-poll", () => {
  const post = (body: unknown, secret?: string) => worker.fetch(new Request("https://w/marketing-poll", {
    method: "POST", body: JSON.stringify(body),
    headers: secret ? { "x-trigger-secret": secret } : {},
  }), crm, ectx());

  it("refuses without the trigger secret", async () => {
    expect((await post({})).status).toBe(403);
    expect((await post({}, "wrong")).status).toBe(403);
    expect(mkt.pollMarketingEmails).not.toHaveBeenCalled();
  });

  it("is a DRY RUN unless the body says dryRun:false, with a small default limit", async () => {
    await post({}, "s");
    expect(mkt.pollMarketingEmails).toHaveBeenLastCalledWith(crm, { dryRun: true, maxWrites: 3 });
    await post({ dryRun: "false" }, "s");          // only the literal false writes
    expect(mkt.pollMarketingEmails).toHaveBeenLastCalledWith(crm, { dryRun: true, maxWrites: 3 });
    await post({ dryRun: false, limit: 1 }, "s");
    expect(mkt.pollMarketingEmails).toHaveBeenLastCalledWith(crm, { dryRun: false, maxWrites: 1 });
  });

  it("clamps the limit to 1..10", async () => {
    await post({ limit: 500 }, "s");
    expect(mkt.pollMarketingEmails).toHaveBeenLastCalledWith(crm, { dryRun: true, maxWrites: 10 });
    await post({ limit: -4 }, "s");
    expect(mkt.pollMarketingEmails).toHaveBeenLastCalledWith(crm, { dryRun: true, maxWrites: 1 });
  });

  it("returns the poll's result, and a failure as a 500 rather than a crash", async () => {
    const ok = await post({}, "s");
    expect(await ok.json()).toEqual({ status: "ran" });
    mkt.pollMarketingEmails.mockRejectedValueOnce(new Error("boom"));
    expect((await post({}, "s")).status).toBe(500);
  });
});

describe("GET /marketing-ledger", () => {
  const get = (q: string, secret = "s") => worker.fetch(new Request(`https://w/marketing-ledger${q}`,
    { headers: { "x-trigger-secret": secret } }), crm, ectx());

  it("needs the secret and a well-formed hour", async () => {
    expect((await get("?hour=2026-09-30T05", "x")).status).toBe(403);
    expect((await get("?hour=yesterday")).status).toBe(400);
  });

  it("returns that hour's rows", async () => {
    mkt.readLedger.mockResolvedValueOnce([["T1", "C1", "marketing_emails", "k_1", "501"]]);
    const r: any = await (await get("?hour=2026-09-30T05")).json();
    expect(r.count).toBe(1);
    expect(r.rows[0]).toEqual({ timelineId: "T1", cardId: "C1", object: "marketing_emails", eventKey: "k_1", contactId: "501" });
  });
});

/**
 * WM SHARES THIS FETCH HANDLER, and its route surface must not change: before the poller existed these
 * paths were "not found" there, even with a valid trigger secret. They still are -- and nothing is read.
 */
describe("the marketing routes do not exist on the Work Management Worker", () => {
  it("POST /marketing-poll is a 404 on WM, secret or not, and never polls", async () => {
    const r = await worker.fetch(new Request("https://w/marketing-poll", { method: "POST", body: "{}",
      headers: { "x-trigger-secret": "s" } }), wm, ectx());
    expect(r.status).toBe(404);
    expect(mkt.pollMarketingEmails).not.toHaveBeenCalled();
  });

  it("GET /marketing-ledger is a 404 on WM and reads no Durable Object", async () => {
    const r = await worker.fetch(new Request("https://w/marketing-ledger?hour=2026-09-30T05",
      { headers: { "x-trigger-secret": "s" } }), wm, ectx());
    expect(r.status).toBe(404);
    expect(mkt.readLedger).not.toHaveBeenCalled();
  });
});
