import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env, RunOpts } from "../../src/types";

/**
 * REVIEW REPRO (wiring lens) -- WIRING-1: two overlapping cron runs flag the SAME checkpoint twice.
 *
 * Nothing serialises runs of FOLLOW_UP_CRON: scheduled() returns the run (index.ts:166-172), Cloudflare gives a
 * scheduled invocation up to 15 minutes of wall time, and every monday call in the run may sit through a rate-limit
 * wait (gql: up to 65 s, then a 3 s back-off, per call). The "never twice" note is a READ (getWatermark,
 * follow-up-reminder.ts:141) followed much later by a WRITE (setWatermark pending, :157) -- not an atomic claim --
 * and between the two sits the card lookup, which falls back to findItemByColumn (a monday query).
 *
 * Run A (tick :31) is waiting on monday for the card; run B (tick :36) reads the note (absent), flags the card;
 * A's lookup then returns and A flags it again: two "status changes to 30分钟未跟进" -> workflow #07 emails twice.
 *
 * Same mocks as test/follow-up-reminder.test.ts; nothing here touches HubSpot or monday.
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
const T0 = Date.parse("2026-10-12T02:00:00Z");          // the assignment

const lead = () => ({ id: "9001", properties: {
  hubspot_owner_id: "77", hubspot_owner_assigneddate: new Date(T0).toISOString(),
  createdate: new Date(T0 - 5 * MIN).toISOString(), utm_term: "docusign", lifecyclestage: "lead",
  notes_last_updated: null } });

/** The label writes (not the clears) the runs made, in order. */
const labelWrites = () => md.setColumns.mock.calls
  .map(c => (c[3] as Record<string, any>)[FOLLOW_UP.statusCol])
  .filter(v => v && typeof v === "object" && "label" in v)
  .map(v => v.label);

beforeEach(() => {
  vi.clearAllMocks();
  notes.store.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  hub.hs.mockResolvedValue({ results: [lead()] });
  md.setColumns.mockResolvedValue(undefined);
});

describe("WIRING-1: overlapping runs, one checkpoint, two flags", () => {
  it("REPRO: run A waits on monday for the card while run B flags it; A then flags the same checkpoint again", async () => {
    reg.lookupCard.mockResolvedValue(null);                 // no registry entry: the id-column search decides
    let answerA!: (items: { id: string }[]) => void;
    md.findItemByColumn
      .mockImplementationOnce(() => new Promise(res => { answerA = res; }))   // run A: inside a monday rate-limit wait
      .mockResolvedValue([{ id: "5551" }]);                                   // run B: answered at once

    const runA = runFollowUpReminders(ON, live, T0 + 31 * MIN);              // tick :31
    await vi.waitFor(() => expect(answerA).toBeDefined());                  // A has READ the note (absent) and is waiting
    expect(notes.getWatermark).toHaveBeenCalledTimes(1);

    const b = await runFollowUpReminders(ON, live, T0 + 36 * MIN);           // tick :36, A still running
    expect(b.flagged).toBe(1);
    expect(notes.store.get(`fur:9001:${new Date(T0).toISOString()}:30`)).toMatch(/^sent:/);

    answerA([{ id: "5551" }]);                                               // A's lookup returns
    const a = await runA;
    expect(a.flagged).toBe(1);                                              // ...and A flags it AGAIN

    // Two label writes of the same checkpoint for the same assignment: workflow #07 fires (and emails) twice.
    expect(labelWrites()).toEqual(["30分钟未跟进", "30分钟未跟进"]);
    // A even overwrote B's "sent" note with its own pending/sent: nothing compared before writing.
    const writes = notes.setWatermark.mock.calls.map(c => String(c[2]).split(":")[0]);
    expect(writes).toEqual(["pending", "sent", "pending", "sent"]);
  });

  it("control: the same two runs NOT overlapping write once (the note is only a guard between sequential runs)", async () => {
    reg.lookupCard.mockResolvedValue("5551");
    await runFollowUpReminders(ON, live, T0 + 31 * MIN);
    await runFollowUpReminders(ON, live, T0 + 36 * MIN);
    expect(labelWrites()).toEqual(["30分钟未跟进"]);
  });
});
