import { describe, it, expect, vi, beforeEach } from "vitest";
import { TASK_POLL_SEED, OVERLAP_MS, MAX_PER_POLL, SWEEP_MAX, SWEEP_WINDOW_DAYS } from "../src/task-poller";
import { readCode } from "../scripts/read-source.mjs";
import type { Env } from "../src/types";

/**
 * POLLING TASKS, because the push webhook for them cannot exist.
 *
 * object.creation for `task` needs crm.objects.tasks.read, and HubSpot refuses that scope to this app
 * type: "isn't available to this app — contact HubSpot support". Build #11 failed on exactly that. So
 * the Worker asks instead of being told, and these tests pin the three ways asking can go wrong:
 * reading everything on the first run, losing work at a page boundary, and duplicating what the
 * historical migration already placed.
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const sync = vi.hoisted(() => ({ syncHubspotActivity: vi.fn(), activitySyncEnabled: () => true }));
const retry = vi.hoisted(() => ({ scheduleReconcile: vi.fn() }));
const reg = vi.hoisted(() => {
  const marks = new Map<string, string>();
  return {
    marks,
    getWatermark: vi.fn(async (_e: Env, n: string) => marks.get(n) ?? null),
    setWatermark: vi.fn(async (_e: Env, n: string, v: string) => { marks.set(n, v); }),
  };
});

vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/activity-sync", () => sync);
vi.mock("../src/activity-registry", () => reg);
vi.mock("../src/activity-retry", () => retry);

const { pollTasks, reconcileRecentTasks } = await import("../src/task-poller");

const env = {} as Env;
let searched: any[] = [];
const task = (id: string, modified: string) => ({ id, properties: { hs_lastmodifieddate: modified } });

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does not drain mockResolvedValueOnce queues: an unconsumed "created" from an earlier
  // test would otherwise be served to the next one before its own value.
  sync.syncHubspotActivity.mockReset();
  hubspot.hs.mockReset();
  retry.scheduleReconcile.mockReset();
  reg.marks.clear();
  searched = [];
  sync.syncHubspotActivity.mockResolvedValue("created");
  hubspot.hs.mockImplementation(async (_e: Env, _m: string, _p: string, body?: any) => {
    searched.push(body);
    return { results: [], total: 0 };
  });
});

describe("the watermark", () => {
  /**
   * THE FIRST RUN MUST NOT READ EVERYTHING. There are 8,372 historical tasks; a poller that started
   * from zero would import the lot through the live path, which is precisely the bulk write the
   * activity cutover exists to prevent — arriving by a different door.
   */
  it("starts from the fixed seed, not from the beginning of time", async () => {
    await pollTasks(env);
    const since = searched[0].filterGroups[0].filters[0].value;
    expect(Date.parse(since)).toBe(Date.parse(TASK_POLL_SEED) - OVERLAP_MS);
    expect(Date.parse(since)).toBeGreaterThan(Date.parse("2026-09-01T00:00:00Z"));
    // and it is the migration cutover, so nothing can fall between the backfill and the poller
    expect(TASK_POLL_SEED).toBe("2026-09-16T11:16:48Z");
  });

  /**
   * AND THE SEED IS FIXED IN THE SOURCE, not taken from the clock on first run. Tasks created between
   * writing the poller and switching its schedule on would otherwise fall into a gap nobody would
   * ever look for: the watermark would start after them, so they would never be new again.
   */
  it("hard-codes the seed rather than reading the clock", () => {
    const code = readCode("task-poller.ts");
    expect(code).toContain('export const TASK_POLL_SEED = "2026-09-16T11:16:48Z"');
    expect(code).not.toMatch(/TASK_POLL_SEED\s*=\s*new Date\(\)/);
  });

  it("re-reads a little before the mark so nothing falls between two windows", async () => {
    reg.marks.set("tasks", "2026-09-20T10:00:00.000Z");
    await pollTasks(env);
    const since = searched[0].filterGroups[0].filters[0].value;
    expect(Date.parse(since)).toBe(Date.parse("2026-09-20T10:00:00.000Z") - OVERLAP_MS);
  });

  it("asks HubSpot in modification order, oldest first", async () => {
    await pollTasks(env);
    expect(searched[0].sorts).toEqual([{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }]);
  });

  it("advances the mark to the last task it processed", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [
      task("1", "2026-09-20T10:00:00.000Z"), task("2", "2026-09-20T11:00:00.000Z")] });
    const r = await pollTasks(env);
    expect(r.watermarkAfter).toBe("2026-09-20T11:00:00.000Z");
    expect(reg.marks.get("tasks")).toBe("2026-09-20T11:00:00.000Z");
  });

  /**
   * A FAILURE STOPS THE MARK WHERE IT IS. Stepping over a task that failed would make it invisible
   * forever — the next run starts after it, and nothing ever asks about it again.
   */
  it("does not advance past work that failed", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [
      task("1", "2026-09-20T10:00:00.000Z"),
      task("2", "2026-09-20T11:00:00.000Z"),
      task("3", "2026-09-20T12:00:00.000Z")] });
    sync.syncHubspotActivity
      .mockResolvedValueOnce("created")
      .mockResolvedValueOnce("unresolved")            // task 2 fails
      .mockResolvedValueOnce("created");
    const r = await pollTasks(env);

    expect(r.failures).toBe(1);
    expect(r.watermarkAfter).toBe("2026-09-20T10:00:00.000Z");   // stopped at the last success
    expect(sync.syncHubspotActivity).toHaveBeenCalledTimes(2);   // and did not carry on past it
  });

  it("never moves the mark backwards", async () => {
    reg.marks.set("tasks", "2026-09-25T00:00:00.000Z");
    hubspot.hs.mockResolvedValueOnce({ results: [task("1", "2026-09-20T10:00:00.000Z")] });
    const r = await pollTasks(env);
    expect(r.watermarkAfter).toBe("2026-09-25T00:00:00.000Z");
  });

  /**
   * "THE STORE IS BROKEN" AND "NOTHING RECORDED YET" ARE DIFFERENT FACTS.
   *
   * Returning null on a read error reads as "no watermark", which sends the poller back to its seed
   * and replays everything — survivable thanks to the overlap and the marker check, but it is a
   * silent rewind wearing the costume of a normal first run. It must fail loudly instead.
   */
  it("fails the poll when the watermark cannot be read", async () => {
    reg.getWatermark.mockRejectedValueOnce(new Error("durable object unreachable"));
    await expect(pollTasks(env)).rejects.toThrow(/unreachable/);
  });

  /**
   * And a WRITE failure is worse than a read one: the poll would report progress that was never
   * saved, so an operator believes the position advanced while the next run silently redoes it.
   */
  it("does not claim the mark advanced when saving it failed", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [task("1", "2026-09-20T10:00:00.000Z")] });
    reg.setWatermark.mockRejectedValueOnce(new Error("storage write failed"));
    await expect(pollTasks(env)).rejects.toThrow(/storage write failed/);
    expect(reg.marks.get("tasks")).toBeUndefined();       // nothing persisted, nothing claimed
  });

  /**
   * THE WATERMARK ALONE IS NOT ENOUGH FOR ASSOCIATIONS. Measured on a disposable task: attaching a
   * Company advanced hs_lastmodifieddate, attaching a Deal moments later did not. Association changes
   * move it SOMETIMES, and for the one it misses that is the same as never. So each task the poller
   * writes also gets the bounded reconcile already built for the webhook path.
   */
  it("schedules a bounded association reconcile for each task it writes", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [task("55", "2026-09-20T10:00:00.000Z")] });
    await pollTasks(env);
    expect(retry.scheduleReconcile).toHaveBeenCalledWith(env, "tasks", "55");
  });

  /** Nothing new to write means nothing to reconcile — a repeat poll must stay silent. */
  it("does not reconcile a task that was already represented", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [task("56", "2026-09-20T10:00:00.000Z")] });
    sync.syncHubspotActivity.mockResolvedValueOnce("skipped");
    await pollTasks(env);
    expect(retry.scheduleReconcile).not.toHaveBeenCalled();
  });

  /** A genuinely absent watermark is NOT an error — it is the ordinary first run. */
  it("treats an absent watermark as the seed, not as a failure", async () => {
    reg.getWatermark.mockResolvedValueOnce(null);
    const r = await pollTasks(env);
    expect(r.watermarkBefore).toBe(TASK_POLL_SEED);
  });

  it("bounds how much one poll takes on", async () => {
    const many = Array.from({ length: 150 }, (_, i) => task(String(i), "2026-09-20T10:00:00.000Z"));
    hubspot.hs.mockResolvedValue({ results: many, paging: { next: { after: "x" } } });
    const r = await pollTasks(env);
    expect(r.scanned).toBeLessThanOrEqual(MAX_PER_POLL);
  });
});

describe("how the poller calls the sync", () => {
  /**
   * BOTH OPTIONS ARE LOAD-BEARING AND BOTH ARE NARROW.
   *
   * ignoreCutover: a task's timeline position is its due or completion date, routinely long past —
   * this portal has one modified in August 2026 that is due in December 2024. Without the bypass the
   * cutover rejects every task the poller finds.
   *
   * verifyExisting: the historical backfill writes entries WITHOUT creating live mappings, so a
   * poller trusting the mapping alone would duplicate everything the migration already placed.
   */
  it("bypasses the cutover and verifies against the card", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [task("77", "2026-09-20T10:00:00.000Z")] });
    await pollTasks(env);
    expect(sync.syncHubspotActivity).toHaveBeenCalledWith(env, "tasks", "77",
      { ignoreCutover: true, verifyExisting: true });
  });

  /** The bypass belongs to tasks alone. Every webhook path must still obey the cutover. */
  it("is the only caller that bypasses the cutover", () => {
    const sourceUsers = ["webhooks.ts", "activity-retry-do.ts"]
      .map(f => readCode(f))
      .join("\n");
    expect(sourceUsers).not.toContain("ignoreCutover");
  });
});

describe("the scheduler cannot wake the wrong job", () => {
  /**
   * THE FALL-THROUGH THAT WAS THERE BEFORE. scheduled() ran runIncremental for ANY cron that was not
   * the daily sweep, so adding a five-minute trigger for the task poller would have quietly started a
   * full CRM incremental reconciliation — disabled deliberately in Phase 1, and competing with a
   * migration for the same write budget.
   */
  const code = readCode("index.ts");

  it("dispatches every schedule by name", () => {
    expect(code).toContain('if (event.cron === "*/5 * * * *")');
    expect(code).toContain('if (event.cron === "0 3 * * *")');
    expect(code).toContain('if (event.cron === "*/10 * * * *")');
  });

  it("no longer falls through to a reconciliation for unknown expressions", () => {
    // An unrecognised schedule must say so and do nothing...
    expect(code).toContain("action=ignored");
    // ...and the old shape — anything-not-the-daily-sweep runs an incremental — must be gone.
    expect(code).not.toMatch(/}\s*else\s*{\s*ectx\.waitUntil\(runIncremental/);
    expect(code).toContain('ectx.waitUntil(pollTasks(env)');
  });
});

describe("the daily sweep, for what the watermark cannot notice", () => {
  /**
   * THE CASE THE +30s/+5min RECONCILE CANNOT REACH. A task synced on Monday, its two looks long
   * finished, gains a Deal on Thursday. Because an association-only change does not reliably advance
   * hs_lastmodifieddate — measured: attaching a Company moved it, attaching a Deal moments later did
   * not — the incremental poller never returns that task, and the association simply never arrives.
   */
  it("finds a task the watermark would never return", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [task("900", "2026-06-01T00:00:00.000Z")] });
    reg.marks.set("tasks", "2026-09-20T00:00:00.000Z");     // long past that task's last modification

    const r = await reconcileRecentTasks(env);

    expect(r.scanned).toBe(1);
    expect(sync.syncHubspotActivity).toHaveBeenCalledWith(env, "tasks", "900",
      { ignoreCutover: true, verifyExisting: true });
  });

  /**
   * A WINDOW, never history. 8,372 tasks exist; scanning them daily would be some 33,000 HubSpot
   * calls to find an edit to a legacy object the team is migrating away from.
   */
  it("bounds itself to a recent window rather than all history", async () => {
    await reconcileRecentTasks(env);
    const body = searched[0];
    expect(body.filterGroups).toHaveLength(2);              // created recently OR touched recently
    const props = body.filterGroups.map((g: any) => g.filters[0].propertyName).sort();
    expect(props).toEqual(["hs_createdate", "hs_lastmodifieddate"]);
    const oldest = Math.min(...body.filterGroups.map((g: any) => Number(g.filters[0].value)));
    expect(Math.round((Date.now() - oldest) / 86_400_000)).toBe(SWEEP_WINDOW_DAYS);
  });

  it("stops at the cap if the window turns out bigger than expected", async () => {
    const many = Array.from({ length: 900 }, (_, i) => task("s" + i, "2026-09-01T00:00:00.000Z"));
    hubspot.hs.mockResolvedValue({ results: many, paging: { next: { after: "x" } } });
    const r = await reconcileRecentTasks(env);
    expect(r.scanned).toBeLessThanOrEqual(SWEEP_MAX);
  });

  /** Already-represented destinations create nothing, so a second sweep is silent. */
  it("creates nothing on a second pass", async () => {
    hubspot.hs.mockResolvedValue({ results: [task("901", "2026-09-01T00:00:00.000Z")] });
    sync.syncHubspotActivity.mockResolvedValue("skipped");
    const r = await reconcileRecentTasks(env);
    expect(r.written).toBe(0);
    expect(r.unchanged).toBe(1);
  });

  /** One bad task must not end the sweep — the rest of the window still deserves a look. */
  it("keeps going past a failure", async () => {
    hubspot.hs.mockResolvedValueOnce({ results: [
      task("a", "2026-09-01T00:00:00.000Z"), task("b", "2026-09-02T00:00:00.000Z")] });
    sync.syncHubspotActivity
      .mockRejectedValueOnce(new Error("HubSpot 500"))
      .mockResolvedValueOnce("created");
    const r = await reconcileRecentTasks(env);
    expect(r.scanned).toBe(2);
    expect(r.failures).toBe(1);
    expect(r.written).toBe(1);
  });

  /** The sweep must never touch the incremental watermark; they are independent mechanisms and
   *  conflating them would let a sweep silently rewind or advance the poller. */
  it("leaves the watermark alone", async () => {
    reg.marks.set("tasks", "2026-09-20T00:00:00.000Z");
    hubspot.hs.mockResolvedValueOnce({ results: [task("902", "2026-09-01T00:00:00.000Z")] });
    await reconcileRecentTasks(env);
    expect(reg.setWatermark).not.toHaveBeenCalled();
    expect(reg.marks.get("tasks")).toBe("2026-09-20T00:00:00.000Z");
  });

  it("runs on its own schedule, never the full CRM reconciliation's", () => {
    const code = readCode("index.ts");
    expect(code).toContain('if (event.cron === "0 4 * * *")');
    expect(code).toContain("reconcileRecentTasks(env)");
  });
});
