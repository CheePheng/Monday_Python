import type { RunOpts } from "./types";

/** The env fields that decide write behaviour. Narrow on purpose so tests need no full Env. */
export interface WriteEnv {
  DRY_RUN?: string;
  WRITE_HUBSPOT?: string;
  MAX_WRITES?: string;
}

/**
 * THE SINGLE PLACE that decides whether writes actually happen.
 *
 * Previously three call sites each computed `{ dryRun: !live, writeHubspot: live }`, which made
 * `writeHubspot` nothing more than an alias for `!dryRun` — one switch, not two. That made the planned
 * Phase B (real HubSpot -> monday writes while EVERY HubSpot mutation stays blocked) impossible to
 * configure, and left three copies of the rule free to drift apart.
 *
 * `WRITE_HUBSPOT` is deliberately OPT-OUT, not opt-in. The live WM Worker runs with DRY_RUN=false and
 * no WRITE_HUBSPOT var; making it opt-in would silently switch that Worker's HubSpot writes OFF on its
 * next deploy. Only the explicit string "false" disables them.
 *
 * | DRY_RUN | WRITE_HUBSPOT | dryRun | writeHubspot | who |
 * |---------|---------------|--------|--------------|-----|
 * | "false" | unset         | false  | true         | WM production — unchanged |
 * | "true"  | "false"       | true   | false        | CRM Phase A — writes nothing at all |
 * | "false" | "false"       | false  | **false**    | CRM Phase B — real monday writes, zero HubSpot |
 * | "true"  | "true"        | true   | false        | dry-run always wins |
 */
export function writeModeFor(env: WriteEnv, maxWrites: number): RunOpts {
  const live = env.DRY_RUN === "false";
  return { dryRun: !live, writeHubspot: live && env.WRITE_HUBSPOT !== "false", maxWrites };
}

/** The same table with every write forced off, for a request that asked to be a dry run (/resync). */
export function dryRunModeFor(env: WriteEnv, maxWrites: number): RunOpts {
  return writeModeFor({ ...env, DRY_RUN: "true" }, maxWrites);
}

/**
 * Write mode for a single inbound webhook.
 *
 * Exists so the webhook path cannot drift from the table above — it did. webhooks.ts used to carry its
 * own `liveOpts` returning `{ writeHubspot: live }`, which ignored WRITE_HUBSPOT entirely. On the CRM
 * deployment that is not a cosmetic duplicate: there are no SYNC crons (the only cron, the 15-minute one, dispatches
 * the marketing poller, which writes monday timelines and never HubSpot) and both CRM specs set
 * `skipFullReconcile`, so webhooks are the only live SYNC path, and Phase B's HubSpot kill switch was
 * therefore inert precisely where every real write happens. The one thing still refusing reverse
 * writes was the ownership gate — a second line of defence being mistaken for the first.
 *
 * The budget is per EVENT (one record), not per cron tick, so it does not read MAX_WRITES.
 */
export function webhookOpts(env: WriteEnv): RunOpts {
  return writeModeFor(env, 30);
}

/** Writes/records per cron tick. 25 keeps subrequests under the free-plan 50 cap; raise via MAX_WRITES. */
export function maxWritesFor(env: WriteEnv, fallback = 25): number {
  const n = Number(env.MAX_WRITES ?? String(fallback));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
