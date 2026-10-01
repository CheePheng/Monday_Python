import { describe, it, expect, vi } from "vitest";
import { restoreOne, restorePlan, type RestoreDeps, type RestoreJob } from "../src/bulk-restore";

/**
 * THE RACE THIS MODULE EXISTS FOR, reproduced.
 *
 * The 2026-09-18 restoration built a plan, then spent 160 minutes applying it. For 8 of 12,997
 * Contacts HubSpot moved on mid-run, the webhook correctly updated monday, and the restoration then
 * wrote its pre-run value on top. Nothing healed them, because this Worker has no cron.
 *
 * Every test below is that scenario from a different angle. The invariant under test is always the
 * same: the plan may choose the record, but only the source may choose the value.
 */

/** A fake pair of systems whose values can be moved mid-test, exactly as HubSpot did. */
function world(opts: {
  source?: Record<string, string>;
  target?: Record<string, string>;
  mapping?: Record<string, string>;
  /** called before each source read, so a test can move HubSpot underneath the writer */
  onSourceRead?: (id: string, reads: number) => void;
}) {
  const source = { ...(opts.source ?? {}) };
  const target = { ...(opts.target ?? {}) };
  const mapping = { ...(opts.mapping ?? {}) };
  const writes: Array<{ card: string; value: string }> = [];
  let sourceReads = 0;
  const deps: RestoreDeps = {
    readSource: vi.fn(async (id: string) => { opts.onSourceRead?.(id, ++sourceReads); return source[id] ?? ""; }),
    readTarget: vi.fn(async (card: string) => target[card] ?? ""),
    readMapping: vi.fn(async (card: string) => mapping[card] ?? ""),
    write: vi.fn(async (card: string, value: string) => { writes.push({ card, value }); target[card] = value; }),
  };
  return { deps, source, target, mapping, writes };
}

const JOB: RestoreJob = { card: "CARD1", sourceId: "HS1", planned: "2026-08-31" };

describe("a plan that went stale before the write", () => {
  it("writes what the source says NOW, never the planned value", async () => {
    const w = world({ source: { HS1: "2026-09-18" },      // HubSpot moved after the plan was built
                      target: { CARD1: "2026-08-31" }, mapping: { CARD1: "HS1" } });
    const r = await restoreOne(w.deps, JOB);

    expect(r.action).toBe("written");
    expect(r.after).toBe("2026-09-18");
    expect(w.writes).toEqual([{ card: "CARD1", value: "2026-09-18" }]);
    expect(w.writes.some(x => x.value === "2026-08-31")).toBe(false);   // the bug, asserted absent
    expect(r.plannedWasStale).toBe(true);
  });

  /** The exact production case: the webhook already corrected monday, and the plan is behind. */
  it("does not clobber a target the webhook already brought up to date", async () => {
    const w = world({ source: { HS1: "2026-09-18" },
                      target: { CARD1: "2026-09-18" },    // webhook got here first
                      mapping: { CARD1: "HS1" } });
    const r = await restoreOne(w.deps, JOB);

    expect(r.action).toBe("skipped-already-correct");
    expect(w.writes).toHaveLength(0);                     // not one pointless doorbell ring
    expect(r.plannedWasStale).toBe(true);
  });
});

describe("the source moving DURING the write", () => {
  it("retries with the newest value instead of declaring a stale success", async () => {
    // HubSpot reads: 1st "A" (pre-write), 2nd "B" (post-write check) -> mismatch -> go again.
    const w = world({ source: { HS1: "A" }, target: { CARD1: "old" }, mapping: { CARD1: "HS1" },
      onSourceRead: (id, n) => { if (n === 2) w.source[id] = "B"; } });
    const r = await restoreOne(w.deps, JOB);

    expect(r.action).toBe("written");
    expect(r.after).toBe("B");
    expect(r.attempts).toBe(2);
    expect(w.writes.map(x => x.value)).toEqual(["A", "B"]);   // converged, did not stop at "A"
  });

  it("gives up rather than looping forever when the source never settles", async () => {
    let n = 0;
    const w = world({ source: { HS1: "v0" }, target: { CARD1: "old" }, mapping: { CARD1: "HS1" },
      onSourceRead: (id) => { w.source[id] = `v${++n}`; } });
    const r = await restoreOne(w.deps, JOB, 3);

    expect(r.action).toBe("exhausted");
    expect(r.attempts).toBe(3);
    expect(r.note).toContain("kept changing");
  });
});

describe("records the plan should not touch", () => {
  it("refuses a card that no longer claims the planned source id, and writes nothing", async () => {
    const w = world({ source: { HS1: "2026-09-18" }, target: { CARD1: "2026-08-31" },
                      mapping: { CARD1: "SOMEONE_ELSE" } });
    const r = await restoreOne(w.deps, JOB);

    expect(r.action).toBe("mapping-mismatch");
    expect(w.writes).toHaveLength(0);
    expect(w.deps.readSource).not.toHaveBeenCalled();     // not even read, let alone written
  });

  it("touches ONLY the cards named in the plan", async () => {
    const w = world({
      source: { HS1: "2026-09-18", HS2: "2026-09-01", HS3: "2026-07-07" },
      target: { CARD1: "2026-08-31", CARD2: "2026-09-01", CARD3: "2026-01-01", BYSTANDER: "keep me" },
      mapping: { CARD1: "HS1", CARD2: "HS2", CARD3: "HS3", BYSTANDER: "HS9" },
    });
    const jobs: RestoreJob[] = [
      { card: "CARD1", sourceId: "HS1", planned: "2026-08-31" },
      { card: "CARD2", sourceId: "HS2", planned: "2026-09-01" },
      { card: "CARD3", sourceId: "HS3", planned: "2026-07-07" },
    ];
    const summary = await restorePlan(w.deps, jobs);

    expect(summary.written).toBe(2);                        // CARD1 and CARD3
    expect(summary.skipped).toBe(1);                        // CARD2 already correct
    expect(summary.problems).toHaveLength(0);
    expect(new Set(w.writes.map(x => x.card))).toEqual(new Set(["CARD1", "CARD3"]));
    expect(w.target.BYSTANDER).toBe("keep me");
  });
});

describe("the ordinary case still works", () => {
  it("writes a record whose plan was accurate", async () => {
    const w = world({ source: { HS1: "2026-08-31" }, target: { CARD1: "2026-09-18" },
                      mapping: { CARD1: "HS1" } });
    const r = await restoreOne(w.deps, JOB);

    expect(r.action).toBe("written");
    expect(r.after).toBe("2026-08-31");
    expect(r.plannedWasStale).toBe(false);
  });

  it("clears the target when the source has no value", async () => {
    const w = world({ source: { HS1: "" }, target: { CARD1: "2026-09-18" }, mapping: { CARD1: "HS1" } });
    const r = await restoreOne(w.deps, { card: "CARD1", sourceId: "HS1", planned: "" });

    expect(r.action).toBe("written");
    expect(w.writes).toEqual([{ card: "CARD1", value: "" }]);
    expect(r.after).toBe("");
  });

  it("counts how often the plan had gone stale, so a long run can be judged afterwards", async () => {
    const w = world({
      source: { HS1: "2026-09-18", HS2: "2026-09-01" },
      target: { CARD1: "2026-08-31", CARD2: "2026-08-01" },
      mapping: { CARD1: "HS1", CARD2: "HS2" },
    });
    const summary = await restorePlan(w.deps, [
      { card: "CARD1", sourceId: "HS1", planned: "2026-08-31" },   // stale
      { card: "CARD2", sourceId: "HS2", planned: "2026-09-01" },   // accurate
    ]);
    expect(summary.staleplans).toBe(1);
  });
});
