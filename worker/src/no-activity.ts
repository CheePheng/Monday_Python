/**
 * LEAVING "No Activity - 未跟进" WHEN THE CARD IS WORKED. NO_ACTIVITY_RELEASE; see ObjectSpec.leaveWhenWorked.
 *
 * THE BUG IT FIXES (reported 2026-10-09). The CRM Contacts board's own automations put contacts INTO "No
 * Activity" -- a nightly sweep moved 459 there on 8 Oct -- and nothing took them out again when a rep did the
 * work. Elaine Rivera moved Ivan's Lifecycle to 10.Other and Lead Status to In Progress on 5 Oct; both
 * reached HubSpot, the card stayed in "No Activity", and hiffer dragged it out by hand on 9 Oct. The rule that
 * runs on every column change ran 200 times in the 18 hours before that and moved no card.
 *
 * THE ONE MOVE THE WORKER MAKES. Everything else about groups is the board's (types.ts GroupBy.placeOnly): on
 * 2026-09-23 the sync was emptying "No Activity" into "Active Contacts" whenever a card in it was updated, and
 * the fix was to stop moving cards at all. This module is the deliberate, narrow exception: only out of
 * `from`, only into `to`, and only when the card has just been worked.
 *
 * WORKED IS A CHANGE, NOT A STATE. A card is released by the pass that brings the work -- the owner's outbound
 * email or call arriving (activity-sync.ts), or a pass that changes a `notWorked` status column to a label the
 * list does not name -- never by finding a worked value already sitting on it. A state rule would fight the
 * nightly sweep: the sweep ignores Lead Status, so it puts a card with an Open Deal status back, and a state
 * rule would move it out again on the very next update, every night. With a change rule the card stays where
 * the sweep put it until someone works it again.
 *
 * NEVER THROWS. A move that fails is a log line, and the card stays where it was: the next worked change
 * tries again, and a sync must never fail because a card could not change group.
 */
import type { Env, ObjectSpec, RunOpts } from "./types";
import { gql, moveItem } from "./monday";

/**
 * Outreach older than this releases nothing. The activity path also delivers REPLAYS -- /resync-activity, the
 * catch-up scripts, a retried delivery -- and an email from three weeks ago is not today's work: the nightly
 * sweep may well have put the card back since, on fresher evidence.
 */
export const WORK_RECENT_MS = 24 * 60 * 60_000;

/** Only the literal "true", and only on the CRM Worker: the WM boards have no such group and no such rule. */
export function noActivityReleaseOn(env: { ENABLE_CRM?: string; NO_ACTIVITY_RELEASE?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.NO_ACTIVITY_RELEASE === "true";
}

/** Is `label` a WORKED value of status column `col`: non-empty and not one of the column's not-worked labels?
 *  A column the spec does not list never is. */
export function isWorkedLabel(spec: ObjectSpec, col: string, label: string | null | undefined): boolean {
  const notWorked = spec.leaveWhenWorked?.notWorked[col];
  if (!notWorked) return false;
  const text = String(label ?? "").trim();
  return !!text && !notWorked.includes(text);
}

/** The columns among `changes` -- each a column a pass CHANGED, with the label it now shows -- that moved to
 *  a worked value. */
export function workedColumns(spec: ObjectSpec, changes: { col: string; label: string | null | undefined }[]): string[] {
  return [...new Set(changes.filter(c => isWorkedLabel(spec, c.col, c.label)).map(c => c.col))];
}

/**
 * Move the card from `from` to `to`, when -- and only when -- it is in `from` now. `groupId` is the group the
 * caller already read the card in; pass undefined to have it read here. Returns true when the card was moved
 * (or would have been, in a dry run).
 */
export async function releaseWorkedCard(env: Env, spec: ObjectSpec, itemId: string, groupId: string | undefined,
    why: string, opts: Pick<RunOpts, "dryRun">): Promise<boolean> {
  const rule = spec.leaveWhenWorked;
  if (!rule || !noActivityReleaseOn(env)) return false;
  const where = `[no-activity] board=${spec.boardId} item=${itemId}`;
  try {
    let group = groupId;
    if (group === undefined) {
      const d = await gql(env, `query ($i: [ID!]) { items(ids: $i) { group { id } } }`, { i: [itemId] }, 2);
      group = d?.items?.[0]?.group?.id ? String(d.items[0].group.id) : "";
    }
    if (group !== rule.from) return false;
    await moveItem(env, spec.boardId, itemId, rule.to, opts as RunOpts);
    console.log(`${where} action=released from=${rule.from} to=${rule.to}${opts.dryRun ? " result=dry-run" : ""}`
      + ` reason="${why}"`);
    return true;
  } catch (e) {
    console.log(`${where} action=release-failed reason="${String(e).slice(0, 140)}" worked="${why}"`);
    return false;
  }
}

/**
 * The pass-level entry point: release the card when any of `changes` moved a status column to a worked value.
 * `changes` must hold only columns this pass actually changed -- see "WORKED IS A CHANGE" above.
 */
export async function releaseOnWorkedChanges(env: Env, spec: ObjectSpec, itemId: string, groupId: string | undefined,
    changes: { col: string; label: string | null | undefined }[], source: string,
    opts: Pick<RunOpts, "dryRun">): Promise<boolean> {
  if (!spec.leaveWhenWorked || !noActivityReleaseOn(env)) return false;
  const cols = workedColumns(spec, changes);
  if (!cols.length) return false;
  const shown = cols.map(c => `${c}="${String(changes.find(x => x.col === c)?.label ?? "").trim()}"`).join(" ");
  return releaseWorkedCard(env, spec, itemId, groupId, `${source}: ${shown}`, opts);
}
