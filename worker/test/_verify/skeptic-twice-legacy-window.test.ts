import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * SKEPTIC of twice-new-1-legacy-key. Same world and the same verbatim 445405b module as twice-new-legacy-key.test.ts.
 * Probes HOW WIDE the deploy-transition exposure is, and which contacts it can reach:
 *   - the claim says checkpoint 30 is re-flagged for contacts 445405b flagged "within 60 min" before the rewrite's
 *     first run; a checkpoint-30 flag is made at age >= 30 and stays due only below age 60, so the window is < 30 min;
 *   - a contact worked since the assignment is never re-flagged (the rewrite's fresh GET skips it).
 */

const H = vi.hoisted(() => ({ world: null as any }));
vi.mock("../../src/hubspot", () => ({ hs: (...a: any[]) => H.world.hs(...a) }));
vi.mock("../../src/card-registry", () => ({ lookupCard: (...a: any[]) => H.world.lookupCard(...a) }));
vi.mock("../../src/activity-registry", () => ({
  getWatermark: (...a: any[]) => H.world.reg.getWatermark(...a),
  setWatermark: (...a: any[]) => H.world.reg.setWatermark(...a),
  acquireLock: (...a: any[]) => H.world.reg.acquireLock(...a),
  renewLock: (...a: any[]) => H.world.reg.renewLock(...a),
  releaseLock: (...a: any[]) => H.world.reg.releaseLock(...a),
}));

import { makeWorld, drive, tickTo, iso, MIN, T0, type World } from "./twice-world";
const rewrite = await import("../../src/follow-up-reminder");
const deployed = await import("./twice-legacy-445405b");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true", MONDAY_API_TOKEN: "t" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
let W: World;
const emails = (label: string) => W.w.emails.filter(e => e.label === label).length;
const runDeployed = async (min: number) => { await tickTo(T0 + min * MIN); return drive(deployed.runFollowUpReminders(ON, live, Date.now())); };
const runRewrite = async (min: number) => { await tickTo(T0 + min * MIN); return drive(rewrite.runFollowUpReminders(ON, live, () => Date.now())); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  W = makeWorld();
  H.world = W;
  vi.stubGlobal("fetch", (u: unknown, i: unknown) => W.fetchMonday(u, i));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("skeptic: the deploy-transition window of the legacy key", () => {
  it("REPRO at the far edge: 445405b flags cp30 at +31, the rewrite's FIRST run is at +56 -- still re-flagged", async () => {
    await runDeployed(31);
    expect(emails("30分钟未跟进")).toBe(1);
    await runRewrite(56);
    expect(emails("30分钟未跟进"), "a deploy 25 min after 445405b's flag must not mail the 30 again").toBe(1);   // FAILS: 2
  });

  it("BOUND: the rewrite's first run at +61 (30 min after the flag) no longer re-flags cp30 -- only the legit 60 goes out", async () => {
    await runDeployed(31);
    await runRewrite(61);
    expect(emails("30分钟未跟进")).toBe(1);
    expect(emails("60分钟未跟进")).toBe(1);
  });

  it("BOUND: 445405b flags cp60 at +61, the rewrite's first run at +91 -- the assignment is too old, nothing re-sent", async () => {
    await runDeployed(31);
    await runDeployed(61);
    await runRewrite(91);
    expect(emails("60分钟未跟进")).toBe(1);
  });

  it("SPARED: a lead its owner worked after 445405b's reminder (call logged at +33) is not re-flagged at +36", async () => {
    await runDeployed(31);
    W.w.record["9001"] = { lastActivity: iso(T0 + 33 * MIN) };   // the record (fresh GET) moves; the search index lags
    await runRewrite(36);
    expect(emails("30分钟未跟进")).toBe(1);
  });
});
