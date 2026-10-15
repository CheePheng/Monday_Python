import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * LENS "twice", NEW: the rewrite keys its note on the assignment's TIME (fur:<id>:<epoch ms>:<cp>), the deployed
 * 445405b on HubSpot's RAW search string (fur:<id>:<ISO>:<cp>). Neither reads the other's note. So the first runs of
 * the rewrite after its deploy re-flag every contact 445405b flagged in the last hour (checkpoint 30) or half hour
 * (checkpoint 60): the card shows 已提醒, the rewrite writes the label over it, and #07 mails the owner (CC ZMark)
 * a second time. Replayed with the ACTUAL 445405b module (twice-legacy-445405b.ts, a verbatim copy) followed by the
 * rewrite, both on the real monday.ts against the fake board running #07.
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

import { makeWorld, drive, tickTo, iso, MIN, T0, STATUS, type World } from "./twice-world";
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

describe("deploying the rewrite over notes 445405b saved", () => {
  it("445405b flags checkpoint 30 at +31; the rewrite, deployed, runs at +36: the owner must NOT be mailed again", async () => {
    await runDeployed(31);
    expect(emails("30分钟未跟进")).toBe(1);
    expect([...W.w.notes.keys()]).toEqual([`fur:9001:${iso(T0)}:30`]);   // the deployed code's key: the raw ISO stamp
    expect(W.w.cards.get("5551")!.status?.label).toBe("已提醒");
    await runRewrite(36);
    expect(emails("30分钟未跟进")).toBe(1);                                // FAILS: 2 -- re-flagged over 已提醒
  });

  it("the same for checkpoint 60: 445405b flags it at +61, the rewrite runs at +66", async () => {
    await runDeployed(31);
    await runDeployed(61);
    expect(emails("60分钟未跟进")).toBe(1);
    await runRewrite(66);
    expect(emails("60分钟未跟进")).toBe(1);                                // FAILS: 2
  });

  it("control: the rewrite after the rewrite reads its own note -- one email", async () => {
    await runRewrite(31);
    await runRewrite(36);
    expect(emails("30分钟未跟进")).toBe(1);
    expect(W.w.sent.filter(s => s.cv[STATUS]?.label)).toHaveLength(1);
  });
});
