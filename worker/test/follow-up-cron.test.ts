import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

/**
 * The 02.2 follow-up reminder's cron, through the real scheduled() handler: it RETURNS the run (the full cron
 * budget, like the 15-minute poll), does nothing unless FOLLOW_UP_REMINDER is armed on the CRM Worker, and never
 * touches the Task poller's "*\/5" expression.
 */

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
const fur = vi.hoisted(() => ({ runFollowUpReminders: vi.fn() }));
const tasks = vi.hoisted(() => ({ pollTasks: vi.fn(async () => ({})), reconcileRecentTasks: vi.fn(async () => ({})) }));
vi.mock("../src/follow-up-reminder", async (orig) => ({ ...(await orig<any>()), ...fur }));
vi.mock("../src/task-poller", () => tasks);

const worker = (await import("../src/index")).default;
const { FOLLOW_UP_CRON } = await import("../src/follow-up-reminder");

const on = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", DRY_RUN: "false" } as unknown as Env;
const ectx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const cron = (c: string) => ({ cron: c, scheduledTime: Date.now() }) as unknown as ScheduledEvent;

beforeEach(() => { vi.clearAllMocks(); fur.runFollowUpReminders.mockReset().mockResolvedValue({ flagged: 0 }); });

describe("the follow-up reminder cron", () => {
  it("RETURNS the run: scheduled() settles only when the run has", async () => {
    let finish!: () => void;
    fur.runFollowUpReminders.mockReturnValueOnce(new Promise<any>(res => { finish = () => res({ flagged: 1 }); }));
    let settled = false;
    const p = worker.scheduled(cron(FOLLOW_UP_CRON), on, ectx()).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(fur.runFollowUpReminders).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finish();
    await p;
    expect(settled).toBe(true);
  });

  it.each([
    ["switch off", { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "false" }],
    ["switch absent", { ENABLE_CRM: "true" }],
    ["the WM Worker (no ENABLE_CRM)", { FOLLOW_UP_REMINDER: "true" }],
  ])("%s: does nothing", async (_n, env) => {
    await worker.scheduled(cron(FOLLOW_UP_CRON), env as unknown as Env, ectx());
    expect(fur.runFollowUpReminders).not.toHaveBeenCalled();
  });

  it("a run that throws is logged, never an unhandled rejection", async () => {
    fur.runFollowUpReminders.mockRejectedValueOnce(new Error("boom"));
    await expect(worker.scheduled(cron(FOLLOW_UP_CRON), on, ectx())).resolves.toBeUndefined();
  });

  it("is not the Task poller's expression, and that one still only polls tasks", async () => {
    expect(FOLLOW_UP_CRON).not.toBe("*/5 * * * *");
    await worker.scheduled(cron("*/5 * * * *"), on, ectx());
    expect(fur.runFollowUpReminders).not.toHaveBeenCalled();
    expect(tasks.pollTasks).toHaveBeenCalledTimes(1);
  });
});
