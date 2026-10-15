import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../src/types";
import { CRM_ACCOUNTS, CRM_CONTACTS } from "../src/config/crm";

/**
 * ANY ACTIVITY IS WORK (NO_ACTIVITY_RELEASE; the business's rule since 2026-10-10). Every path that puts an
 * activity on a Contacts card -- or sends one from it -- takes the card out of "No Activity" when the activity is
 * recent. This file pins the shared rule (releaseOnActivity) and the monday side of it: a note or call logged on
 * the card in monday, sent to HubSpot by syncMondayTimeline. (The HubSpot -> monday side is
 * no-activity-follow-up.test.ts; a monday Update is no-activity-monday-update.test.ts; marketing sends are
 * marketing-email-poller.test.ts.)
 */

const hubspot = vi.hoisted(() => ({ hs: vi.fn() }));
const monday = vi.hoisted(() => ({ gql: vi.fn(), findItemByColumn: vi.fn(), moveItem: vi.fn() }));
const reg = vi.hoisted(() => ({
  claimActivityToHubspot: vi.fn(), settleActivityToHubspot: vi.fn(), unresolvedActivityToHubspot: vi.fn(),
  claimHubspotAsRepresented: vi.fn(),
}));
vi.mock("../src/hubspot", () => hubspot);
vi.mock("../src/monday", () => monday);
vi.mock("../src/activity-registry", () => reg);

const { releaseOnActivity, WORK_RECENT_MS } = await import("../src/no-activity");
const { syncMondayTimeline } = await import("../src/activity-sync");

const CARD = "2856382447";
const CONTACT = "463919511251";
const NO_ACTIVITY = "group_mm7cj2yx";
const on = { ENABLE_CRM: "true", NO_ACTIVITY_RELEASE: "true", ENABLE_ACTIVITY_SYNC: "true", DRY_RUN: "false",
  ACTIVITY_CUTOVER_AT: "2026-09-01T00:00:00Z" } as unknown as Env;
const live: Pick<RunOpts, "dryRun"> = { dryRun: false };
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

let group = NO_ACTIVITY;
let entries: any[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  group = NO_ACTIVITY;
  entries = [];
  monday.moveItem.mockResolvedValue(undefined);
  monday.gql.mockImplementation(async (_e: Env, q: string) => {
    if (q.includes("group { id }")) return { items: [{ group: { id: group } }] };
    if (q.includes("timeline(")) return { timeline: { timeline_items_page: { cursor: null, timeline_items: entries } } };
    if (q.includes("column_values(ids:")) return { items: [{ column_values: [{ text: CONTACT }] }] };
    return {};
  });
  hubspot.hs.mockImplementation(async (_e: Env, method: string) => (method === "POST" ? { id: "N1" } : {}));
  reg.claimActivityToHubspot.mockResolvedValue({ status: "proceed" });
  reg.settleActivityToHubspot.mockResolvedValue(undefined);
  reg.claimHubspotAsRepresented.mockResolvedValue(undefined);
});

const moved = () => monday.moveItem.mock.calls.map(c => [c[2], c[3]]);

describe("releaseOnActivity -- the shared rule", () => {
  it("a recent activity moves a Contacts card in No Activity to Active Contacts", async () => {
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, ago(5), "test", live)).toBe(true);
    expect(moved()).toEqual([[CARD, "topics"]]);
  });

  it.each([
    ["an ISO time", () => ago(30)],
    ["epoch ms", () => Date.now() - 30 * 60_000],
    ["epoch ms as a digit string", () => String(Date.now() - 30 * 60_000)],
    ["a meeting or task being scheduled for next week", () => new Date(Date.now() + 7 * 86_400_000).toISOString()],
  ])("counts %s", async (_label, at) => {
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, at(), "test", live)).toBe(true);
  });

  it.each([
    ["older than WORK_RECENT_MS", () => new Date(Date.now() - WORK_RECENT_MS - 60_000).toISOString()],
    ["unparseable", () => "yesterday-ish"],
    ["absent", () => undefined],
  ])("does not count an activity time that is %s -- and reads nothing", async (_label, at) => {
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, at() as any, "test", live)).toBe(false);
    expect(monday.gql).not.toHaveBeenCalled();
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("judges recency by the caller's clock when it passes one (the marketing poller's)", async () => {
    const pollNow = Date.parse("2026-09-30T12:00:00Z");
    const at = "2026-09-30T09:00:30Z";               // 3 h before the poll's clock, days before the real one
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, at, "test", live)).toBe(false);
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, at, "test", live, { nowMs: pollNow })).toBe(true);
  });

  it("a card already out of No Activity is left where it is", async () => {
    group = "topics";
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, ago(5), "test", live)).toBe(false);
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a group the caller already read is used, not read again", async () => {
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, ago(5), "test", live, { groupId: NO_ACTIVITY })).toBe(true);
    expect(monday.gql).not.toHaveBeenCalled();
    expect(await releaseOnActivity(on, CRM_CONTACTS, CARD, ago(5), "test", live, { groupId: "topics" })).toBe(false);
  });

  it("a caller's rate-wait budget reaches both monday calls", async () => {
    await releaseOnActivity(on, CRM_CONTACTS, CARD, ago(5), "test", live, { maxRateWaits: 2 });
    expect(monday.gql.mock.calls[0][4]).toBe(2);
    expect(monday.moveItem.mock.calls[0][5]).toBe(2);
  });

  it("only the Contacts board has the rule; switch off moves nothing; a dry run moves nothing for real", async () => {
    expect(await releaseOnActivity(on, CRM_ACCOUNTS, CARD, ago(5), "test", live)).toBe(false);
    expect(await releaseOnActivity({ ...on, NO_ACTIVITY_RELEASE: "false" } as Env, CRM_CONTACTS, CARD, ago(5), "t", live))
      .toBe(false);
    expect(await releaseOnActivity({ ENABLE_CRM: "false", NO_ACTIVITY_RELEASE: "true" } as unknown as Env,
      CRM_CONTACTS, CARD, ago(5), "t", live)).toBe(false);
    expect(monday.moveItem).not.toHaveBeenCalled();
    await releaseOnActivity(on, CRM_CONTACTS, CARD, ago(5), "test", { dryRun: true });
    expect(monday.moveItem.mock.calls[0][4]).toMatchObject({ dryRun: true });   // moveItem itself only logs
  });

  it("never throws: a failing move is a log line and the card stays", async () => {
    monday.moveItem.mockRejectedValueOnce(new Error("monday down"));
    await expect(releaseOnActivity(on, CRM_CONTACTS, CARD, ago(5), "test", live)).resolves.toBe(false);
  });
});

describe("a note or call logged on the card in monday (syncMondayTimeline)", () => {
  const note = (createdAt: string, id = "TL1") =>
    ({ id, type: "note", title: "Call notes", content: "<p>Spoke to her</p>", custom_activity_id: null, created_at: createdAt });

  it("sent to HubSpot -> the card leaves No Activity", async () => {
    entries = [note(ago(2))];
    const r = await syncMondayTimeline(on, CARD);
    expect(r).toContain("pushed=1");
    expect(moved()).toEqual([[CARD, "topics"]]);
  });

  it("several sent at once: one move", async () => {
    entries = [note(ago(2), "TL1"), note(ago(4), "TL2")];
    await syncMondayTimeline(on, CARD);
    expect(monday.moveItem).toHaveBeenCalledTimes(1);
  });

  it("an old note sent now (after the cutover, but days ago) does not move it", async () => {
    entries = [note(ago(3 * 24 * 60))];
    const r = await syncMondayTimeline(on, CARD);
    expect(r).toContain("pushed=1");
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("a note sent on an earlier pass (nothing sent now) moves nothing", async () => {
    reg.claimActivityToHubspot.mockResolvedValue({ status: "have", id: "N0" });
    entries = [note(ago(2))];
    const r = await syncMondayTimeline(on, CARD);
    expect(r).toContain("pushed=0");
    expect(monday.moveItem).not.toHaveBeenCalled();
  });

  it("switch off: the note is sent, the card stays", async () => {
    entries = [note(ago(2))];
    const r = await syncMondayTimeline({ ...on, NO_ACTIVITY_RELEASE: "false" } as Env, CARD);
    expect(r).toContain("pushed=1");
    expect(monday.moveItem).not.toHaveBeenCalled();
  });
});
