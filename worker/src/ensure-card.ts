import type { Ctx, Env, HsRecord, ObjectSpec, RunOpts } from "./types";
import { createItem, findItemByColumn, getItem } from "./monday";
import { buildColumnValues, itemName } from "./mapping";
import { targetGroup } from "./routing";
import { claimCard, finishCard, forgetCard } from "./card-registry";

/** What happened when a path asked for a record's card. Explicit, because callers need to tell "we made
 * one" (count it, spend budget) apart from "someone else is making it" (do nothing this pass). */
export type EnsureCard =
  | { status: "existing"; itemId: string }        // a card already existed (registry or column search)
  | { status: "created"; itemId: string | null }  // we created it; itemId is null under dryRun
  | { status: "skipped" };                        // another path holds the reservation, or no target group

/** THE single way any path may obtain the monday card for a HubSpot record.
 *
 * Every caller previously did its own "search the id column, create if missing", and because that search is
 * eventually consistent, two paths running seconds apart both missed and both created — one HubSpot record,
 * two monday cards. This funnels all of them through one strongly-consistent reservation instead.
 */
export async function ensureCardForRecord(env: Env, spec: ObjectSpec, ctx: Ctx, rec: HsRecord,
    opts: RunOpts): Promise<EnsureCard> {
  const { boardId } = spec;
  const claim = await claimCard(env, boardId, rec.id);

  if (claim.status === "have") {
    // Verify it still exists — a rep can delete the card, and a stale mapping would hand back a dead id
    // that then breaks every relation-column write that includes it.
    if (await getItem(env, claim.itemId)) return { status: "existing", itemId: claim.itemId };
    console.log(`${spec.object}/${rec.id} registered card ${claim.itemId} is gone — re-creating`);
    await forgetCard(env, boardId, rec.id);
  } else if (claim.status === "creating") {
    console.log(`${spec.object}/${rec.id} card creation already in flight — skipping to avoid a duplicate`);
    return { status: "skipped" };
  }

  try {
    // Reservation held. The column search is still worth one look: it finds cards made before the registry
    // existed (or by anything outside it), so we adopt rather than duplicate.
    const existing = (await findItemByColumn(env, boardId, spec.idCol, rec.id))[0];
    if (existing) { await finishCard(env, boardId, rec.id, existing.id); return { status: "existing", itemId: existing.id }; }

    const group = targetGroup(rec, spec);
    if (!group) { await forgetCard(env, boardId, rec.id); return { status: "skipped" }; }
    const cv = buildColumnValues(rec, spec, ctx);   // stamps the HubSpot id + link + derived people columns
    cv[spec.syncStateCol] = rec.properties[spec.modifiedProp] ?? "";
    const itemId = await createItem(env, boardId, group, itemName(rec, spec), cv, opts);
    if (itemId) await finishCard(env, boardId, rec.id, itemId);
    else await forgetCard(env, boardId, rec.id);    // dry-run wrote nothing — don't hold the reservation
    return { status: "created", itemId };
  } catch (e) {
    await forgetCard(env, boardId, rec.id);         // never wedge the record behind a failed attempt
    throw e;
  }
}

/** Convenience for callers that only want an id (null when nothing usable came back). */
export function cardIdOf(r: EnsureCard): string | null {
  return r.status === "skipped" ? null : r.itemId;
}
