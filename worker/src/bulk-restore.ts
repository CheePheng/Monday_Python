/**
 * BULK CORRECTIONS MUST NOT APPLY A STALE PLAN.
 *
 * A bulk correction computes its plan once and then applies it for hours. Anything that changes at
 * the source in between gets CLOBBERED by the planned value — the writer arrives holding a number it
 * read before lunch and overwrites the truth with it.
 *
 * Measured, not hypothesised: on 2026-09-18 a 160-minute restoration of 12,997 Contacts' Last
 * Activity Date overwrote 8 of them with values HubSpot had already moved past. The webhook had
 * correctly updated monday mid-run; the restoration then wrote the pre-run value on top. Because
 * this Worker has no cron, nothing healed them afterwards.
 *
 * The rule enforced here: THE PLAN CHOOSES THE RECORD, THE SOURCE CHOOSES THE VALUE. A planned value
 * is never written. It is kept only so a caller can report how often the plan had gone stale.
 */

/** One record a bulk correction intends to touch. `planned` is advisory and is never written. */
export interface RestoreJob {
  /** target record id (a monday item) */
  card: string;
  /** authoritative source record id (a HubSpot object) */
  sourceId: string;
  /** what the plan believed the source said, when the plan was built */
  planned: string;
}

export type RestoreAction =
  | "skipped-already-correct"
  | "written"
  | "mapping-mismatch"
  | "exhausted";

export interface RestoreResult {
  card: string;
  sourceId: string;
  action: RestoreAction;
  /** what the plan thought the value was */
  planned: string;
  /** what the source actually said at write time */
  source: string;
  /** what the target held before we touched it */
  before: string;
  /** what the target holds now */
  after: string;
  attempts: number;
  /** true when the plan had gone stale — the reason this module exists */
  plannedWasStale: boolean;
  note?: string;
}

export interface RestoreDeps {
  /** authoritative value, re-read immediately before the write */
  readSource(sourceId: string): Promise<string>;
  /** the target's current value */
  readTarget(card: string): Promise<string>;
  /** the source id the target card claims, so a re-pointed card is never written by mistake */
  readMapping(card: string): Promise<string>;
  write(card: string, value: string): Promise<void>;
}

/**
 * Correct ONE record, re-reading both sides around the write.
 *
 * Deliberately value-based rather than timestamp-based: two systems' clocks and their notions of
 * "modified" do not agree closely enough to arbitrate a write, and the values are what we actually
 * care about. Timestamps are evidence; values are the decision.
 */
export async function restoreOne(
  deps: RestoreDeps,
  job: RestoreJob,
  maxAttempts = 3,
): Promise<RestoreResult> {
  const base = { card: job.card, sourceId: job.sourceId, planned: job.planned };

  // A card that no longer claims this source id must not be written at all: the plan's pairing is
  // the one thing a re-read cannot re-derive, so it is checked rather than assumed.
  const mapping = await deps.readMapping(job.card);
  if (mapping !== job.sourceId)
    return { ...base, action: "mapping-mismatch", source: "", before: "", after: "",
      attempts: 0, plannedWasStale: false,
      note: `card claims source ${mapping || "(none)"}, plan expected ${job.sourceId}` };

  let attempts = 0, source = "", before = "", after = "";
  while (attempts < maxAttempts) {
    attempts++;
    source = await deps.readSource(job.sourceId);   // authoritative, RE-READ, never job.planned
    before = await deps.readTarget(job.card);

    // The webhook may already have done this. Writing anyway would be a pointless mutation, and on a
    // column that is an activity doorbell every pointless write costs a downstream sync.
    if (before === source)
      return { ...base, action: "skipped-already-correct", source, before, after: before,
        attempts, plannedWasStale: job.planned !== source };

    await deps.write(job.card, source);

    after = await deps.readTarget(job.card);
    const sourceAfter = await deps.readSource(job.sourceId);
    if (after === sourceAfter)
      return { ...base, action: "written", source, before, after,
        attempts, plannedWasStale: job.planned !== source };
    // The source moved while we were writing. Go again with whatever it says now rather than
    // declaring victory on a value that is already out of date.
  }
  return { ...base, action: "exhausted", source, before, after, attempts,
    plannedWasStale: job.planned !== source,
    note: `source kept changing across ${maxAttempts} attempts` };
}

/** Run a whole plan through {@link restoreOne}, one record at a time, and summarise. */
export async function restorePlan(
  deps: RestoreDeps,
  jobs: RestoreJob[],
  onResult?: (r: RestoreResult) => void,
  maxAttempts = 3,
): Promise<{ results: RestoreResult[]; written: number; skipped: number; problems: RestoreResult[]; staleplans: number }> {
  const results: RestoreResult[] = [];
  for (const job of jobs) {
    const r = await restoreOne(deps, job, maxAttempts);
    results.push(r);
    onResult?.(r);
  }
  return {
    results,
    written: results.filter(r => r.action === "written").length,
    skipped: results.filter(r => r.action === "skipped-already-correct").length,
    problems: results.filter(r => r.action === "mapping-mismatch" || r.action === "exhausted"),
    staleplans: results.filter(r => r.plannedWasStale).length,
  };
}
