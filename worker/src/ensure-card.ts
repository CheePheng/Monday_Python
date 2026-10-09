import type { Ctx, Env, HsRecord, ObjectSpec, RunOpts } from "./types";
import { createItem, findItemByColumn, getItem } from "./monday";
import { buildColumnValues, itemName } from "./mapping";
import { targetGroup } from "./routing";
import { claimCard, finishCard, forgetCard } from "./card-registry";
import { mayCreateCrmCard } from "./ownership";
import { ownerNoticeOn, queueOwnerNotices } from "./owner-notice";

/** CONTACT_CARD_NEEDS_OWNER: only the literal "true", and only on the CRM Worker. */
export function cardNeedsOwnerOn(env: { ENABLE_CRM?: string; CONTACT_CARD_NEEDS_OWNER?: string }): boolean {
  return env.ENABLE_CRM === "true" && env.CONTACT_CARD_NEEDS_OWNER === "true";
}

/** What happened when a path asked for a record's card. Explicit, because callers need to tell "we made
 * one" (count it, spend budget) apart from "someone else is making it" (do nothing this pass). */
export type EnsureCard =
  | { status: "existing"; itemId: string }        // a card already existed (registry or column search)
  | { status: "created"; itemId: string | null }  // we created it; itemId is null under dryRun
  | { status: "skipped" }                         // TRANSIENT: another path holds the reservation, or no
                                                  // target group. Retrying later can succeed.
  /** PERMANENT: this record is outside the CRM creation scope. Retrying can NEVER succeed until the
   *  record's ownership or the cutover changes, so callers must not present it as retryable. Kept
   *  distinct from `skipped` precisely because /app/ensure-card answers 409 "retry shortly" to that. */
  | { status: "refused"; reason: string };

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

    // NO HISTORICAL IMPORT. Reached only when no card exists, so this gates card BIRTH and never an
    // update to a card someone deliberately adopted. Placed BEFORE targetGroup/createItem so a refusal
    // costs no monday write. The reservation is released: refusing is a settled decision for this
    // record, not work in flight, so holding it would wedge the record behind a permanent "creating".
    if (!mayCreateCrmCard(rec, spec.ownership)) {
      await forgetCard(env, boardId, rec.id);
      console.log(`${spec.object}/${rec.id} action=refused-card reason="outside CRM creation scope" board=${boardId}`);
      return { status: "refused", reason: "outside CRM creation scope" };
    }

    // OWNER FIRST (2026-10-09 meeting, CONTACT_CARD_NEEDS_OWNER): a contact reaches monday only once HubSpot
    // has given it an owner. Not retryable until then, so `refused` -- and the owner-change webhook that sets
    // one syncs the contact again, which comes back here and creates the card. A FIRST card only: a card a
    // person deleted is restored whoever owns it (opts.restore), because cards already on the board stay.
    if (spec.cardNeedsOwner && cardNeedsOwnerOn(env) && opts.restore !== rec.id
        && !String(rec.properties.hubspot_owner_id ?? "").trim()) {
      await forgetCard(env, boardId, rec.id);
      console.log(`${spec.object}/${rec.id} action=refused-card reason="no owner yet: the card is created when HubSpot sets one" board=${boardId}`);
      return { status: "refused", reason: "no owner yet" };
    }

    const group = targetGroup(rec, spec);
    if (!group) { await forgetCard(env, boardId, rec.id); return { status: "skipped" }; }
    const cv = buildColumnValues(rec, spec, ctx);   // stamps the HubSpot id + link + derived people columns
    cv[spec.syncStateCol] = rec.properties[spec.modifiedProp] ?? "";
    const itemId = await createItem(env, boardId, group, itemName(rec, spec), cv, opts);
    if (itemId) await finishCard(env, boardId, rec.id, itemId);
    else await forgetCard(env, boardId, rec.id);    // dry-run wrote nothing — don't hold the reservation
    /**
     * EVERY NEW CARD ON A NOTICED BOARD QUEUES AN OWNER NOTICE (OWNER_NOTICE) -- owned or not. The queue reads
     * HubSpot afresh and decides: an unowned contact costs it one read ("no-owner"), an OLD assignment (a restored
     * card, a catch-up) is only remembered, and only a RECENT one has its card's 通知状态 flagged for the board's
     * workflow to send. NOT gated on the owner in `rec`: that is what this pass read, and an owner HubSpot set
     * while the card was being made fires an owner-change notice that finds no card yet ("no-card") -- this entry
     * is then the only one left to tell them. ONLY QUEUED -- one call to the queue -- so a card is never slowed or
     * failed by it: when the queue does not take it (unreachable, or full) it is logged lost, never run here.
     * Run inline, it held this card's return -- the record's associations, a Deal Cockpit request, a create's
     * coalesce queue -- for a whole notice: ~10 s of lock retries, a minute or more per monday rate-limit wait.
     */
    if (itemId && spec.ownerNotice && ownerNoticeOn(env))
      await queueOwnerNotices(env, [rec.id], "new card").catch(() => undefined);
    return { status: "created", itemId };
  } catch (e) {
    await forgetCard(env, boardId, rec.id);         // never wedge the record behind a failed attempt
    throw e;
  }
}

/** Convenience for callers that only want an id (null when nothing usable came back). */
export function cardIdOf(r: EnsureCard): string | null {
  return r.status === "skipped" || r.status === "refused" ? null : r.itemId;
}

/** True when retrying this call could still succeed. A refusal is terminal; everything else is not. */
export function isRetryable(r: EnsureCard): boolean {
  return r.status !== "refused";
}
