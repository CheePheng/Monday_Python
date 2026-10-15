import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC CHECK (wiring lens) for WIRING-2 with REAL timing: what does it take for a run started 10 minutes after
 * another to read that run's IN-FLIGHT pending note as "a run that died"?
 *
 * Same harness as fur-wiring-6 (real monday.ts, a monday answering every request after 40 s, #07 emails then sets
 * 已提醒 3 s later), every registry entry present. Ticks: A :31 (+0.5 s), B :36 (+0.5 s), C :41 (+2 s cron delay).
 * Twelve leads assigned together: A and B leapfrog through them (each skips the other's fresh pending), so A claims
 * the last one about nine minutes into its run -- and stamps it with its START.
 */

const COL = "color_mm82ccsb";
const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const notes = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getWatermark: vi.fn(async (_env: unknown, name: string) => store.has(name) ? store.get(name)! : null),
    setWatermark: vi.fn(async (_env: unknown, name: string, value: string) => { store.set(name, value); }),
  };
});
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { runFollowUpReminders } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const LAT = 40_000;
const card = (id: string) => `55${id}`;

const cells = new Map<string, string | null>();
const emails = new Map<string, number>();

function setup(n: number) {
  const ids = Array.from({ length: n }, (_, i) => String(9001 + i));
  hub.hs.mockResolvedValue({ results: ids.map(id => ({ id, properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "HubSpot", lifecyclestage: "lead",
    notes_last_updated: null } })) });
  return ids;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0 + 31 * MIN + 500);
  notes.store.clear(); cells.clear(); emails.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  reg.lookupCard.mockImplementation(async (_e: unknown, _b: string, id: string) => card(id));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    await new Promise(res => setTimeout(res, LAT));
    const { variables } = JSON.parse(init.body);
    const item = String(variables.i);
    const v = JSON.parse(variables.c)[COL];
    const next: string | null = v === null ? null : (v?.label ?? null);
    const prev = cells.get(item) ?? null;
    cells.set(item, next);
    if (next === "30分钟未跟进" && prev !== next) {
      emails.set(item, (emails.get(item) ?? 0) + 1);
      setTimeout(() => { if (cells.get(item) === next) cells.set(item, "已提醒"); }, 3_000);
    }
    return new Response(JSON.stringify({ data: { change_multiple_column_values: { id: item } } }), { status: 200 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function threeTicks() {
  const pA = runFollowUpReminders(ON, live);
  let pB!: Promise<unknown>, pC!: Promise<unknown>;
  setTimeout(() => { pB = runFollowUpReminders(ON, live); }, 5 * MIN);                 // :36:00.5
  setTimeout(() => { pC = runFollowUpReminders(ON, live); }, 10 * MIN + 1_500);         // :41:02.0
  await vi.advanceTimersByTimeAsync(16 * MIN);
  return [await pA, await pB, await pC] as Awaited<typeof pA>[];
}

describe("WIRING-2 (skeptic): the run-start stamp under real timing", () => {
  it("INVARIANT with twelve leads due at once -> FAILS: C retakes A's last, in-flight write", async () => {
    const ids = setup(12);
    await threeTicks();
    for (const id of ids) expect({ id, emails: emails.get(card(id)) ?? 0 }).toEqual({ id, emails: 1 });
  });

  it("control: five leads due at once (the same slow monday) -> no double", async () => {
    const ids = setup(5);
    await threeTicks();
    for (const id of ids) expect({ id, emails: emails.get(card(id)) ?? 0 }).toEqual({ id, emails: 1 });
  });
});
