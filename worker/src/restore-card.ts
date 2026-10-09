import type { Budget, Env, ObjectSpec, RunOpts } from "./types";
import { forgetCard, forgetCardOwner, lookupCardOwner } from "./card-registry";
import { syncHubspotObject } from "./sync";

/**
 * A rep deleted (or archived) a monday card. HubSpot keeps the record; the CARD comes back.
 *
 * THE RULE, as specified: HubSpot is the only place a record may be deleted. A HubSpot deletion removes
 * the card (deleteHubspotObject, already wired). A monday deletion must NOT propagate — instead the card
 * is re-created from HubSpot, because monday is a working surface, not the system of record. Deleting a
 * card is therefore an "undo my view", never "destroy the customer".
 *
 * Two things had to be solved for this to work at all.
 *
 * 1. WHICH RECORD WAS IT? The card is gone, taking its "HubSpot ID" column with it, and monday publishes
 *    no sample payload for item_deleted — so `columnValues` may or may not be there. We therefore keep
 *    our own reverse index (card-registry: hsof:<board>:<item> -> HubSpot id, written by finishCard).
 *    The payload is still tried FIRST when it happens to carry the id column, since that also covers
 *    cards created before the reverse index existed. When neither source yields an id the deletion is
 *    unattributable: we log the payload's key names — so the first real deletion teaches us the shape —
 *    and stop. Guessing would risk restoring the wrong record.
 *
 * 2. NO HISTORICAL IMPORT. Restoration deliberately runs through the ORDINARY sync path, so
 *    `mayCreateCrmCard` still applies: a record created before CRM_CUTOVER_AT is refused exactly as it
 *    would be on any other pass. That is what keeps this feature from becoming a back-door import of
 *    94,205 contacts — the requirement is "only the new ones from now on", and new records are
 *    post-cutover, so they restore while historical ones stay out. The gate is NOT relaxed here.
 */

/** monday delivers deletions under more than one type string; archive is the same intent as delete. */
export const DELETION_EVENTS = new Set(["item_deleted", "item_archived", "delete_pulse", "archive_pulse"]);

/** spec.object -> the syncHubspotObject argument. Restore is defined for these two objects ONLY;
 *  anything else (notably "deals") must be refused rather than defaulted onto one of them. */
export const OBJECT_FOR: Record<string, "contact" | "company" | undefined> = {
  contacts: "contact",
  companies: "company",
};

export function isDeletionEvent(type: string): boolean {
  return DELETION_EVENTS.has(type);
}

/**
 * Pull the HubSpot id straight out of the webhook payload, when monday happens to include the item's
 * columns. Undocumented, so treated as a bonus rather than the mechanism. Handles both shapes monday
 * uses elsewhere: a bare string and a `{ value | text }` wrapper.
 */
export function hubspotIdFromPayload(ev: any, spec: ObjectSpec): string | null {
  const cv = ev?.columnValues ?? ev?.column_values;
  if (!cv || typeof cv !== "object") return null;
  const cell = cv[spec.idCol];
  const raw = typeof cell === "string" ? cell : cell?.value ?? cell?.text ?? cell?.label;
  const id = raw == null ? "" : String(raw).trim();
  return /^\d+$/.test(id) ? id : null;
}

/** Key names only — never values. A payload may carry customer data and this goes to the log. */
export function payloadShape(ev: any): string {
  return ev && typeof ev === "object" ? Object.keys(ev).sort().join(",") : String(ev);
}

export async function restoreDeletedCard(env: Env, spec: ObjectSpec, itemId: string, ev: any,
    opts: RunOpts, budget: Budget): Promise<string> {
  const board = spec.boardId;
  const fromPayload = hubspotIdFromPayload(ev, spec);
  const hubspotId = fromPayload ?? await lookupCardOwner(env, board, itemId);

  if (!hubspotId) {
    // Log the shape so the next occurrence can be handled without another investigation.
    console.log(`[restore] board=${board} item=${itemId} action=unattributable`
      + ` reason="no HubSpot id in payload and none recorded" payloadKeys=${payloadShape(ev)}`);
    return "unattributable";
  }

  // EXPLICIT, not a binary. `spec.object === "contacts" ? "contact" : "company"` silently mapped
  // "deals" — and anything else — onto "company", which would have handed a DEAL id to the companies
  // sync and searched the wrong board for it. Restore is defined only for the two CRM objects, so an
  // unrecognised spec must stop rather than pick a default.
  //
  // Checked BEFORE the registry is cleared. Refusing after the forgets would destroy the only record of
  // the card->record pairing on the way out, so a spec we cannot restore would also lose the ability to
  // ever attribute that card again — the same "touch nothing when we cannot act" rule the
  // unattributable branch above follows.
  const object = OBJECT_FOR[spec.object];
  if (!object) {
    console.log(`[restore] board=${board} item=${itemId} hs=${hubspotId}`
      + ` action=skipped reason="restore not defined for object ${spec.object}"`);
    return "unsupported-object";
  }

  // The registry still maps this record to the DEAD card id. Clear it, or ensureCardForRecord hands the
  // dead id straight back as "existing" and nothing is re-created. (Its own stale-id check would also
  // catch this, but only after a wasted getItem round-trip.)
  await forgetCard(env, board, hubspotId);
  await forgetCardOwner(env, board, itemId);

  console.log(`[restore] board=${board} item=${itemId} hs=${hubspotId}`
    + ` source=${fromPayload ? "payload" : "registry"} action=restoring`);

  // The ordinary single-record sync: fetches from HubSpot, and ensureCardForRecord re-creates the card
  // (or refuses it, for a pre-cutover record). It also handles the case where the record is gone from
  // HubSpot too — getRecord returns null and it logs a skip, so a legitimate HubSpot-side deletion that
  // raced the monday one does not resurrect anything.
  // Pass the dead item id: the column search is eventually consistent and would otherwise hand back
  // the very card that was just deleted, turning the restore into a write against a dead id.
  // `restore`: this record's card existed, so the owner-first rule for a record's FIRST card does not hold it
  // back (CONTACT_CARD_NEEDS_OWNER; cards already on the board stay).
  return syncHubspotObject(env, object, hubspotId, { ...opts, restore: hubspotId }, budget, itemId);
}
