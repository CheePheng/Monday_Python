import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (wiring lens) -- WIRING-4: a label that LANDED is sent again when its "sent" checkpoint does not.
 *
 * The irreversible side effect (the label write that triggers #07) comes first and its record second
 * (follow-up-reminder.ts:162 then :167). When the "sent" save fails -- a Durable Object hiccup, or the run is cut
 * off right after the write (the 15-minute scheduled wall limit) -- the note stays "pending:<run start>", and :142
 * reads any pending older than 10 minutes as "a run that died" and sends again, without looking at the card. The
 * contact is still due for checkpoint 30 until 60 minutes after the assignment, so the :46 tick re-flags it.
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
vi.mock("../../src/hubspot", () => hub);
vi.mock("../../src/monday", () => md);
vi.mock("../../src/card-registry", () => reg);
vi.mock("../../src/activity-registry", () => ({ getWatermark: notes.getWatermark, setWatermark: notes.setWatermark }));

const { runFollowUpReminders, FOLLOW_UP } = await import("../../src/follow-up-reminder");

const ON = { ENABLE_CRM: "true", FOLLOW_UP_REMINDER: "true" } as unknown as Env;
const live: RunOpts = { dryRun: false, writeHubspot: true, maxWrites: 25 };
const MIN = 60_000;
const T0 = Date.parse("2026-10-12T02:00:00Z");
const KEY = `fur:9001:${new Date(T0).toISOString()}:30`;

const labelWrites = () => md.setColumns.mock.calls
  .map(c => (c[3] as Record<string, any>)[FOLLOW_UP.statusCol])
  .filter(v => v && typeof v === "object" && "label" in v)
  .map(v => v.label);

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockResolvedValue({ results: [{ id: "9001", properties: {
    hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
    createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
    notes_last_updated: null } }] });
  reg.lookupCard.mockResolvedValue("5551");
  md.setColumns.mockResolvedValue(undefined);
});

describe("WIRING-4: the 'sent' checkpoint after the write", () => {
  it("REPRO: the label lands, the 'sent' save fails -> pending -> the :46 tick sends the same checkpoint again", async () => {
    notes.setWatermark.mockImplementationOnce(async (_e, name, value) => { notes.store.set(name, value); })   // pending
      .mockImplementationOnce(async () => { throw new Error("watermark x not saved: DO overloaded"); });    // sent

    const s31 = await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    expect(s31.errors).toBe(1);                                 // reported as an error...
    expect(labelWrites()).toEqual(["30分钟未跟进"]);             // ...though the label (and #07's email) went out
    expect(notes.store.get(KEY)).toBe(`pending:${T0 + 31 * MIN}`);

    for (const m of [36, 41]) await runFollowUpReminders(ON, live, T0 + m * MIN);
    expect(labelWrites()).toHaveLength(1);                      // pending is fresh: skipped

    const s46 = await runFollowUpReminders(ON, live, T0 + 46 * MIN);
    expect(s46.flagged).toBe(1);                                // "stale pending": retried blind
    expect(labelWrites()).toEqual(["30分钟未跟进", "30分钟未跟进"]);   // cleared then set -> #07 mails again
  });
});
