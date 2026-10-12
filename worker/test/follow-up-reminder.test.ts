import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../src/types";

/**
 * 02.2 FOLLOW-UP REMINDER (FOLLOW_UP_REMINDER): hiffer's rule of 2026-10-12 as agreed with the user -- 30 and 60
 * minutes after the owner assignment, any hour; new leads only (created within the 24 h before the assignment);
 * term contains hubspot/docusign in any case; Lifecycle 1.NEW; Last Activity Date empty -> flag 跟进提醒 once per
 * assignment and checkpoint for workflow #07 to email the owner (CC ZMark).
 *
 * reminderDue is pure and tested directly. runFollowUpReminders runs for real with HubSpot's search, the card
 * lookup, the monday write and the durable note store mocked, so every claim is about calls actually made.
 */

const hub = vi.hoisted(() => ({ hs: vi.fn() }));
const md = vi.hoisted(() => ({ findItemByColumn: vi.fn(), setColumns: vi.fn() }));
const reg = vi.hoisted(() => ({ lookupCard: vi.fn() }));
const notes = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getWatermark: vi.fn(async (_env: unknown, name: string) => store.has(name) ? store.get(name)! : null),
    setWatermark: vi.fn(async (_env: unknown, name: string, value: string) => { store.set(name, value); }),
  };
});
vi.mock("../src/hubspot", () => hub);
vi.mock("../src/monday", () => md);
vi.mock("../src/card-registry", () => reg);
vi.mock("../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { reminderDue, runFollowUpReminders, followUpReminderOn, FOLLOW_UP } = await import("../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");          // the assignment

const lead = (o: Partial<Record<string, string>> = {}) => ({
  id: "9001", owner: "77", assigned: new Date(T0).toISOString(), created: new Date(T0 - 5 * MIN).toISOString(),
  term: "docusign", lifecycle: "lead", lastActivity: "", ...o,
});
const searchReturns = (...contacts: ReturnType<typeof lead>[]) =>
  hub.hs.mockResolvedValue({ results: contacts.map(c => ({ id: c.id, properties: {
    hubspot_owner_id: c.owner, hubspot_owner_assigneddate: c.assigned, createdate: c.created, utm_term: c.term,
    lifecyclestage: c.lifecycle, notes_last_updated: c.lastActivity || null } })) });

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  reg.lookupCard.mockResolvedValue("5551");
  md.findItemByColumn.mockResolvedValue([]);
  md.setColumns.mockResolvedValue(undefined);
});

describe("reminderDue (pure)", () => {
  it.each([
    [29, null], [30, 30], [45, 30], [59, 30], [60, 60], [75, 60], [90, 60], [91, null],
  ])("%i minutes after the assignment -> %s", (mins, want) => {
    const d = reminderDue(lead(), T0 + (mins as number) * MIN);
    expect("checkpoint" in d ? d.checkpoint : null).toBe(want);
  });

  it.each(["docusign", "DocuSign", "docusign下载", "HubSpot CRM", "hubspot", "sumsub+hubspot"])(
    "term %j matches", (term) => expect(reminderDue(lead({ term }), T0 + 31 * MIN)).toEqual({ checkpoint: 30 }));

  it.each(["tableau", "minitab", "", "docu sign"])("term %j does not", (term) =>
    expect(reminderDue(lead({ term }), T0 + 31 * MIN)).toHaveProperty("skip"));

  it("new leads only: created more than 24 h before the assignment is history, ignored", () => {
    expect(reminderDue(lead({ created: new Date(T0 - 25 * 60 * MIN).toISOString() }), T0 + 31 * MIN))
      .toEqual({ skip: "not a new lead" });
    expect(reminderDue(lead({ created: new Date(T0 - 23 * 60 * MIN).toISOString() }), T0 + 31 * MIN))
      .toEqual({ checkpoint: 30 });
  });

  it("a lead created at 23:50 and assigned at 23:55 is still reminded after midnight (no calendar 'today' gap)", () => {
    const assigned = Date.parse("2026-10-12T15:55:00Z");    // 23:55 MYT
    const c = lead({ created: "2026-10-12T15:50:00Z", assigned: new Date(assigned).toISOString() });
    expect(reminderDue(c, assigned + 31 * MIN)).toEqual({ checkpoint: 30 });   // 00:26 MYT the next day
  });

  it("Lifecycle other than 1.NEW, activity logged after the assignment, or no owner: no reminder", () => {
    expect(reminderDue(lead({ lifecycle: "marketingqualifiedlead" }), T0 + 31 * MIN)).toHaveProperty("skip");
    expect(reminderDue(lead({ lastActivity: new Date(T0 + 10 * MIN).toISOString() }), T0 + 31 * MIN))
      .toEqual({ skip: "followed up since the assignment" });
    expect(reminderDue(lead({ lastActivity: new Date(T0).toISOString() }), T0 + 31 * MIN))
      .toEqual({ skip: "followed up since the assignment" });       // at the very moment of the assignment counts
    expect(reminderDue(lead({ owner: "" }), T0 + 31 * MIN)).toEqual({ skip: "no owner" });
  });

  it("OPTION A: activity only BEFORE the (re)assignment does not count -- the new owner is still reminded", () => {
    expect(reminderDue(lead({ lastActivity: new Date(T0 - 20 * MIN).toISOString() }), T0 + 31 * MIN))
      .toEqual({ checkpoint: 30 });
    expect(reminderDue(lead({ lastActivity: String(T0 - 1) }), T0 + 61 * MIN)).toEqual({ checkpoint: 60 });
  });

  it("an epoch-ms assignment stamp works as well as an ISO one", () =>
    expect(reminderDue(lead({ assigned: String(T0) }), T0 + 61 * MIN)).toEqual({ checkpoint: 60 }));
});

describe("runFollowUpReminders", () => {
  it("switch off: no search, no write", async () => {
    const s = await runFollowUpReminders({ ENABLE_CRM: "true" } as unknown as Env, live, T0 + 31 * MIN);
    expect(hub.hs).not.toHaveBeenCalled();
    expect(md.setColumns).not.toHaveBeenCalled();
    expect(s.flagged).toBe(0);
    expect(followUpReminderOn({ FOLLOW_UP_REMINDER: "true" })).toBe(false);   // never without ENABLE_CRM
  });

  it("asks HubSpot only for the 30-90 minute window, Lifecycle 1.NEW and a term -- activity is judged by date, here", async () => {
    searchReturns();
    const now = T0 + 31 * MIN;
    await runFollowUpReminders(ON, live, now);
    const [, method, path, body] = hub.hs.mock.calls[0];
    expect([method, path]).toEqual(["POST", "/crm/v3/objects/contacts/search"]);
    expect(body.filterGroups[0].filters).toEqual([
      { propertyName: "hubspot_owner_assigneddate", operator: "GTE", value: String(now - 90 * MIN) },
      { propertyName: "hubspot_owner_assigneddate", operator: "LTE", value: String(now - 30 * MIN) },
      { propertyName: "lifecyclestage", operator: "EQ", value: "lead" },
      { propertyName: "utm_term", operator: "HAS_PROPERTY" },
    ]);
    expect(body.properties).toContain("notes_last_updated");
  });

  it("logs one summary line every run, even with nothing to do (proof the cron is alive)", async () => {
    searchReturns();
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(logs.filter(l => l.startsWith("[follow-up] action=run "))).toHaveLength(1);
  });

  it("a lead with activity only before its reassignment is flagged for the new owner", async () => {
    searchReturns(lead({ lastActivity: new Date(T0 - 5 * MIN).toISOString() }));
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
  });

  it("flags 30分钟未跟进 once: cleared then set, the note saved before the write and marked sent after", async () => {
    searchReturns(lead());
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.flagged).toBe(1);
    expect(md.setColumns.mock.calls.map(c => c[3])).toEqual([
      { [FOLLOW_UP.statusCol]: null }, { [FOLLOW_UP.statusCol]: { label: "30分钟未跟进" } }]);
    expect(md.setColumns.mock.calls[0][2]).toBe("5551");
    const key = `fur:9001:${new Date(T0).toISOString()}:30`;
    expect(notes.setWatermark.mock.calls.map(c => [c[1], String(c[2]).split(":")[0]])).toEqual([[key, "pending"], [key, "sent"]]);
    expect(logs.some(l => /\[follow-up\] contact=9001 checkpoint=30 item=5551 action=flagged/.test(l))).toBe(true);
  });

  it("NEVER TWICE: the next runs inside the same half-hour write nothing", async () => {
    searchReturns(lead());
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    md.setColumns.mockClear();
    for (const m of [36, 41, 46, 51, 56]) await runFollowUpReminders(ON, live, T0 + m * MIN);
    expect(md.setColumns).not.toHaveBeenCalled();
  });

  it("then the 60-minute reminder fires once, and nothing after it", async () => {
    searchReturns(lead());
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    md.setColumns.mockClear();
    await runFollowUpReminders(ON, live, T0 + 61 * MIN);
    expect(md.setColumns.mock.calls.map(c => c[3])).toEqual([
      { [FOLLOW_UP.statusCol]: null }, { [FOLLOW_UP.statusCol]: { label: "60分钟未跟进" } }]);
    md.setColumns.mockClear();
    for (const m of [66, 71, 76, 81, 86]) await runFollowUpReminders(ON, live, T0 + m * MIN);
    expect(md.setColumns).not.toHaveBeenCalled();
  });

  it("a NEW assignment (a new stamp) is a new cycle with its own reminders", async () => {
    searchReturns(lead());
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    const T1 = T0 + 40 * MIN;                                    // reassigned
    searchReturns(lead({ assigned: new Date(T1).toISOString() }));
    md.setColumns.mockClear();
    await runFollowUpReminders(ON, live, T1 + 31 * MIN);
    expect(md.setColumns).toHaveBeenCalledTimes(2);
  });

  it("FAILS CLOSED: an unreadable note store writes nothing", async () => {
    searchReturns(lead());
    notes.getWatermark.mockRejectedValueOnce(new Error("watermark x unreadable: DO down"));
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.errors).toBe(1);
    expect(md.setColumns).not.toHaveBeenCalled();
  });

  it("a failed write releases its note, so the next run sends it", async () => {
    searchReturns(lead());
    md.setColumns.mockRejectedValueOnce(new Error("monday 500"));
    const s1 = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s1.errors).toBe(1);
    expect(notes.store.get(`fur:9001:${new Date(T0).toISOString()}:30`)).toBe("");
    md.setColumns.mockClear();
    const s2 = await runFollowUpReminders(ON, live, T0 + 36 * MIN);
    expect(s2.flagged).toBe(1);
  });

  it("a note left pending by a run that died is retried after 10 minutes, not before", async () => {
    searchReturns(lead());
    const key = `fur:9001:${new Date(T0).toISOString()}:30`;
    notes.store.set(key, `pending:${T0 + 31 * MIN}`);
    await runFollowUpReminders(ON, live, T0 + 36 * MIN);
    expect(md.setColumns).not.toHaveBeenCalled();
    await runFollowUpReminders(ON, live, T0 + 42 * MIN);
    expect(md.setColumns).toHaveBeenCalledTimes(2);
  });

  it("no card yet: nothing written, nothing noted -- the next run tries again", async () => {
    searchReturns(lead());
    reg.lookupCard.mockResolvedValue(null);
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s.noCard).toBe(1);
    expect(md.setColumns).not.toHaveBeenCalled();
    expect(notes.setWatermark).not.toHaveBeenCalled();
  });

  it("DRY_RUN writes nothing and notes nothing", async () => {
    searchReturns(lead());
    await runFollowUpReminders(ON, { ...live, dryRun: true }, T0 + 31 * MIN);
    expect(md.setColumns).not.toHaveBeenCalled();
    expect(notes.setWatermark).not.toHaveBeenCalled();
  });

  it("a failed search is logged, never thrown", async () => {
    hub.hs.mockRejectedValue(new Error("hubspot 429"));
    await expect(runFollowUpReminders(ON, live, T0 + 31 * MIN)).resolves.toMatchObject({ errors: 1 });
  });

  it("only the matching contact of several is flagged", async () => {
    searchReturns(lead(), lead({ id: "9002", term: "tableau" }), lead({ id: "9003", lastActivity: "2026-10-12T02:10:00Z" }));
    const s = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s).toMatchObject({ candidates: 3, flagged: 1, skipped: 2 });
  });
});
