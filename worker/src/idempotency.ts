// Pure state machine for create idempotency. The Durable Object persists a CreateState per key and
// delegates its decisions here so they are unit-testable without the Workers runtime.

export interface CreateSteps {
  dedup: boolean; hubspot: boolean; monday: boolean; owner: boolean; associations: boolean;
}
export interface CreateResult {
  // Top-level outcome for the progress UI. "completed" = every needed step done; "failed" = a step threw
  // (see failedStep); "in_progress" = never returned to the client (only a stored partial). The client
  // renders the completed `steps` and, on "failed", highlights `failedStep` + offers Retry (re-POST with
  // the SAME key — the server resumes from the stored partial; the client does NOT drive per-step retry).
  status: "in_progress" | "completed" | "failed";
  failedStep?: "dedup" | "hubspot" | "monday" | "owner" | "associations";
  hubspotId?: string; mondayItemId?: string; existing?: boolean;
  unassigned?: boolean; ownerMessage?: string;
  mondayLink?: string; hubspotLink?: string;
  steps: CreateSteps;
}
export interface CreateState { status: "inflight" | "done"; result: CreateResult; updatedAt: number }

export function emptyResult(): CreateResult {
  return { status: "in_progress", steps: { dedup: false, hubspot: false, monday: false, owner: false, associations: false } };
}

export type Claim =
  | { status: "done"; result: CreateResult }       // key already completed -> return stored result
  | { status: "inflight"; result: CreateResult }    // another attempt is running -> caller returns 409
  | { status: "proceed"; result: CreateResult };    // run/resume the steps from this (possibly partial) result

/** Decide what a claim on a key should do, given the stored state (if any) and now. An in-flight entry
 * older than ttlMs is treated as abandoned and reclaimable, carrying its partial result forward so the
 * retry resumes (reuses any HubSpot/monday id already created) instead of duplicating. */
export function decideClaim(state: CreateState | undefined, nowMs: number, ttlMs = 60_000): Claim {
  if (state?.status === "done") return { status: "done", result: state.result };
  if (state?.status === "inflight" && nowMs - state.updatedAt < ttlMs)
    return { status: "inflight", result: state.result };
  return { status: "proceed", result: state?.result ?? emptyResult() };
}
