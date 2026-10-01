import type { AssocSpec, Budget, Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts, SubitemSpec, WriteAuth } from "./types";
import {
  createLineItem, deleteAssociation, getAllAssociatedIds, getAssociatedIds, getAssociatedPage, getAssociatedVia,
  getRecord, getRecordsByIds, patchLineItem, propertiesForSpec, putAssociation, putAssociationTypes,
  type AssociationType, type AssocPage,
} from "./hubspot";
import { createItem, createSubitem, deleteItem, findItemIdsByColumn, getItem, getItemStates, getItemsColumnText, getLinkedItemIds, getParentItemId, getSubitems, setColumns, updateItem } from "./monday";
import { relationEditKey, removedSince } from "./relation-edit";
import { DEALS, LINE_ITEM_SUBITEMS, specByObject } from "./config";
import { buildSubitemReversePatch, subitemFieldByCol, readSubitemEvent } from "./line-item-reverse";
import { ensureCardForRecord, cardIdOf } from "./ensure-card";
import { buildColumnValues, formatValue, itemName } from "./mapping";
import { targetGroup } from "./routing";
import { colText } from "./dedup";
import { ensureHubspotWriteAuth, lineItemOwnerSpec, lineItemWriteAuth } from "./write-auth";
import { authorizeCreate, authorizeWrite, canClaimCrmOwnership, withBirthOwnership, type ClaimBasis } from "./ownership";

/** HubSpot -> monday association pass. One-directional: it reflects HubSpot associations onto the monday
 * item (name columns) and deal line items onto subitems. It NEVER writes HubSpot. Each association is
 * isolated so one failure (e.g. line_items 403 before the scope is added) doesn't block the others. */
export async function syncAssociations(env: Env, spec: ObjectSpec, rec: HsRecord, item: MondayItem,
    ctx: Ctx, opts: RunOpts, budget: Budget): Promise<void> {
  for (const a of spec.associations ?? []) {
    try {
      const { ids, truncated } = a.via
        ? await getAssociatedVia(env, spec.object, rec.id, a.via, a.toObject, a.viaPrimary)
        : await getAssociatedPage(env, spec.object, rec.id, a.toObject);
      if (a.subitems) { await syncLineItems(env, a, ids, item.id, ctx, opts, budget, spec.object, rec.id); continue; }
      // A "Connect Boards" column links the actual cards; the text column (if kept) shows readable names.
      if (a.relationCol) await syncRelationColumn(env, spec, a, ids, item, ctx, opts, budget, truncated);
      if (a.col) await syncNameColumn(env, spec, a, ids, rec, item, opts, budget);
    } catch (e) {
      console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} action=error reason="${String(e).slice(0, 140)}"`);
    }
  }
}

/** See the bound in unlinkRemovedCards. Exported so a test pins the number. Judged per CLICK (the largest
 *  single event composed into the run) and only over cards that still exist. */
export const MAX_UNLINKS_PER_EDIT = 5;
/** The same bound for ADDS, for the same reason -- see pushAddedCards. Exported so a test pins it. */
export const MAX_LINKS_PER_EDIT = 5;

/** HubSpot's own "Primary" deal -> company label (HUBSPOT_DEFINED typeId 5), verified live against this
 *  portal -- the same constant getAssociatedVia's tie-break reads. See fillDealCompany. */
const DEAL_COMPANY_PRIMARY: AssociationType = { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 };

/** What the column-level webhook path hands the reverse pass. The diff fields are documented on
 *  MondayEdit, which is where they come from. */
export interface ReverseScope {
  /** The relation columns the person actually edited: a cell nobody touched is never re-asserted. */
  onlyCols?: Set<string>;
  /** "human-edit" so a person's claim can reach an older record. */
  basis?: ClaimBasis;
  unlinked?: Record<string, string[]>;
  linked?: Record<string, string[]>;
  largestEvent?: Record<string, { added: number; removed: number }>;
  byAutomation?: boolean;
  /** For logs only. The G3 re-check keys on the "person" actor class, never on this id, so a caller
   *  that omits it loses nothing (see relation-edit.ts). */
  actor?: string;
}

/** The person's edit of one relation cell, or null when it cannot be told (no usable before-value). */
interface CellEdit { added: string[]; removed: string[] }
const cellEditOf = (scope: ReverseScope, col: string): CellEdit | null => {
  const added = scope.linked?.[col];
  return added === undefined ? null : { added, removed: scope.unlinked?.[col] ?? [] };
};

/** The pending-edit key a reverse pass re-checks. Always the PERSON class: our own token's runs are
 *  self-origin and never reach the reverse pass, and an automation's relation edit is suppressed. */
const personKey = (item: MondayItem, col: string): string => relationEditKey(item.id, col, "person");

/** A cap judged per click: the largest single event composed into the run, never more than `n`. */
const perClick = (n: number, largest: number | undefined): number => Math.min(n, largest ?? n);

/**
 * REVERSE association pass (monday -> HubSpot). TWO SHAPES, chosen by who is asking.
 *
 * 1. THE COLUMN-LEVEL EDIT PATH (`scope.onlyCols`, a CRM webhook for a person's relation edit). Since
 *    2026-09-28 it acts on what the person CHANGED and on nothing else:
 *    - G1: it pushes only the cards the edit ADDED (monday's previousValue -> value, composed over the
 *      person's coalesced events -- see linkedCardIds), never the rest of the cell, so a stale link that
 *      was already sitting there is never re-asserted. At most MAX_LINKS_PER_EDIT per edit. An event
 *      without a usable before-value pushes nothing: it does not fall back to the whole cell.
 *    - UNLINKS, since 2026-09-23, need THREE independent agreements before anything is deleted:
 *        1. monday's own webhook says the person removed that card (unlinkedCardIds) -- intent, never
 *           inferred from a read, because a lagging or failed read looks exactly like "every link
 *           removed" and acting on it would delete real associations across many records;
 *        2. the current card read agrees it is no longer linked -- so a re-link in the meantime wins;
 *        3. no OTHER card still linked in that cell points at the same HubSpot record -- a duplicate
 *           card for the same company must not take the real association with it.
 *      and, G4, the removed card must still be ACTIVE: a card that left the cell because it was deleted
 *      or archived was not unlinked by anyone (see unlinkRemovedCards). That is decided FIRST, before
 *      any cap or budget, so a deleted card is never a refusal and never snaps the cell back.
 *    - G2: any refusal (ownership, a cap, no before-value, a partial HubSpot read) or HubSpot rejection
 *      SNAPS THE CELL BACK at once, instead of leaving a link on screen that HubSpot does not have. The
 *      snap-back undoes only the person's own diff, judged against HubSpot's current set; only an edit
 *      whose diff cannot be told rewrites the whole cell, and then only if every id resolves. See
 *      snapBackRelation.
 *    - G3: the add comes from the diff, not from re-reading the cell (a forward pass may already have
 *      taken it back out), and is re-checked against a later removal just before the PUT.
 *    - PAIRED CELLS: when one click arrives on both paired cards, only the first event carries the card;
 *      the webhook drops it from the paired side's diff, so the pair is decided once (isPairedEcho).
 *    - An automation's relation edit never pushes (logged), and our own token's echoes never reach here.
 *    - A DERIVED relation (`via`) is dispatched to its own, much narrower rule: fillDealCompany.
 *
 * 2. THE WHOLE-CELL PATH (no scope): the record-level WM specs and the drawer save. Additive and
 *    set-only, exactly as it always was: any monday-linked record HubSpot lacks is PUT, nothing is ever
 *    deleted, and a derived relation is skipped. Kept byte-for-byte so the live WM Worker is unchanged.
 *
 * Our own token's writes (and monday's paired echo of them, which is attributed to the same token)
 * never reach either path: selfOrigin skips reverseAssociations entirely.
 *
 * P2-1 RETIRED, 2026-09-08. putAssociation/deleteAssociation take `fromSpec` + `auth` and call the same
 * assertMayWrite as patchRecord, so an ownership-declaring spec is guarded per call instead of banned
 * wholesale. The auth is claimed LAZILY, exactly like the field path: only once there is a real
 * association to write. Discovering associations, or finding them already in sync, never stamps it.
 */
export async function reverseAssociations(env: Env, spec: ObjectSpec, rec: HsRecord, item: MondayItem,
    opts: RunOpts, budget: Budget, scope?: ReverseScope): Promise<void> {
  if (!scope?.onlyCols) return reverseWholeCells(env, spec, rec, item, opts, budget);
  if (scope.byAutomation) {
    // An automation is a rule someone configured, not a person choosing this link, and it can fire in
    // bulk across a board. Suppressed rather than snapped back: the automation would only re-link, and
    // the next forward pass reconciles the cell with HubSpot either way.
    console.log(`source=monday object=${spec.object} id=${rec.id} item=${item.id}`
      + ` action=reverse-assoc-suppressed reason="relation edited by a monday automation, not a person"`);
    return;
  }
  // Resolved once per pass and shared across relation columns so a second column cannot trigger a
  // second claim -- but the allow-check is RE-EVALUATED at every use (see relationWriteRefusal).
  const authRef: { auth?: WriteAuth } = {};
  for (const a of spec.associations ?? []) {
    const col = a.relationCol;
    if (!col || !scope.onlyCols.has(col)) continue;
    // A DERIVED relation has no inverse of its own: `via` means the link was computed by walking through
    // another object, so the association it shows does not exist in HubSpot's model at all. It gets its
    // own rule rather than the generic one -- putAssociation(line_items -> companies) is not merely wrong,
    // HubSpot defines no such type.
    if (a.via) { await reverseDerivedRelation(env, spec, a, col, rec, item, opts, budget, scope); continue; }
    const target = specByObject(env, a.toObject);
    if (!target) continue;
    const refusals: string[] = [];
    for (const step of [unlinkRemovedCards, pushAddedCards]) {
      try {
        const why = await step(env, spec, a, col, target, rec, item, opts, budget, scope, authRef);
        if (why) refusals.push(why);
      } catch (e) {
        // HubSpot rejected it, or assertMayWrite threw. Either way the cell now shows something HubSpot
        // does not hold, so it is healed below rather than left to look saved.
        refusals.push(`HubSpot rejected the change: ${String(e).slice(0, 140)}`);
        console.log(`reverse-assoc error ${spec.object}/${rec.id} ${a.toObject}: ${String(e).slice(0, 160)}`);
      }
    }
    if (refusals.length)
      await snapBackRelation(env, spec, a, rec, item, opts, budget, cellEditOf(scope, col), refusals.join("; "));
  }
}

/** The whole-cell, additive pass: record-level specs (WM) and the drawer save. Unchanged behaviour. */
async function reverseWholeCells(env: Env, spec: ObjectSpec, rec: HsRecord, item: MondayItem,
    opts: RunOpts, budget: Budget): Promise<void> {
  let auth: WriteAuth | undefined;
  for (const a of spec.associations ?? []) {
    if (!a.relationCol) continue;
    // No person's diff to act on here, so a derived relation is simply not written back.
    if (a.via) continue;
    try {
      const target = specByObject(env, a.toObject);
      if (!target) continue;
      const linkedCards = await getLinkedItemIds(env, item.id, a.relationCol);
      if (!linkedCards.length) continue;
      const hsIdByCard = await getItemsColumnText(env, linkedCards, target.idCol);
      const want = [...new Set(Object.values(hsIdByCard).filter(id => /^\d+$/.test(id)))];
      if (!want.length) continue;
      const current = new Set(await getAssociatedIds(env, spec.object, rec.id, a.toObject));
      const missing = want.filter(hsId => !current.has(hsId));
      if (!missing.length) {
        console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject} linked=${want.length} added=0 action=already-associated`);
        continue;
      }
      // Claim ONLY now, with a real link to write. Resolved once and reused across associations so a
      // second relation column cannot trigger a second claim — but RE-CHECKED every iteration, which is
      // the part that matters: caching the auth AND its allow-check together let a refusal on the first
      // association fall through to a write on the second, because `!auth` was then false. Caught by
      // test/crm-associations.test.ts on a two-association spec.
      if (spec.ownership) {
        if (!auth) auth = await ensureHubspotWriteAuth(env, spec, budget, rec, opts);
        if (auth && !auth.allowed) {
          console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject}`
            + ` action=reverse-assoc-refused reason="${auth.reason}"`);
          continue;
        }
      }
      let added = 0;
      for (const hsId of missing) {
        if (budget.left <= 0) break;
        await putAssociation(env, spec.object, rec.id, a.toObject, hsId, opts, spec, auth);
        budget.left--; added++;
      }
      console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject} linked=${want.length} added=${added} action=reverse-associated`);
    } catch (e) {
      console.log(`reverse-assoc error ${spec.object}/${rec.id} ${a.toObject}: ${String(e).slice(0, 160)}`);
    }
  }
}

/**
 * The budget-and-claim check for a relation write, on the edited record. Claimed at most once per pass,
 * and the allow-check RE-EVALUATED on every call: caching both together once let a refusal on the first
 * association fall through to a write on the second (test/crm-associations.test.ts). Returns the
 * refusal reason, or null when the write may go ahead.
 *
 * THE BUDGET IS CHECKED BEFORE THE CLAIM, and it must cover the claim too. A claim is itself a HubSpot
 * write (sync_owner), so claiming with nothing left to spend on the association would make the record
 * CRM's with nothing written -- exactly what the lazy-claim rule ("only once there is a real association
 * to write") exists to prevent.
 */
async function relationWriteRefusal(env: Env, spec: ObjectSpec, rec: HsRecord, opts: RunOpts,
    budget: Budget, scope: ReverseScope, authRef: { auth?: WriteAuth }): Promise<string | null> {
  const willClaim = !!spec.ownership && !authRef.auth && canClaimCrmOwnership(rec, spec.ownership, scope.basis);
  if (budget.left < (willClaim ? 2 : 1)) return "write budget exhausted before the first write";
  if (!spec.ownership) return null;
  if (!authRef.auth) authRef.auth = await ensureHubspotWriteAuth(env, spec, budget, rec, opts, scope.basis);
  return authRef.auth && !authRef.auth.allowed ? authRef.auth.reason : null;
}

/**
 * G4: the cards that still EXIST. A card whose state does not come back is treated as not active: the
 * cost of that is a missed unlink, the cost of the opposite is a deleted HubSpot association.
 */
async function activeCards(env: Env, spec: ObjectSpec, itemId: string, a: AssocSpec, cards: string[],
    action = "unlink-skipped-inactive-card"): Promise<string[]> {
  const states = await getItemStates(env, cards);
  const inactive = cards.filter(c => states[c] !== "active");
  if (inactive.length)
    console.log(`source=monday object=${spec.object} item=${itemId} relation=${a.toObject} cards=${inactive.join(",")}`
      + ` states=${inactive.map(c => states[c] ?? "unknown").join(",")} action=${action}`
      + ` reason="the card was deleted or archived, not unlinked; restore owns it, and it never deletes an association"`);
  return cards.filter(c => states[c] === "active");
}

type RelationStep = (env: Env, spec: ObjectSpec, a: AssocSpec, col: string, target: ObjectSpec,
  rec: HsRecord, item: MondayItem, opts: RunOpts, budget: Budget, scope: ReverseScope,
  authRef: { auth?: WriteAuth }) => Promise<string | null>;

/**
 * UNLINK what the person removed, under the three agreements in reverseAssociations -- and never for a
 * card that stopped existing.
 *
 * G4, A DELETED CARD NEVER DELETES AN ASSOCIATION. board_relation columns are paired, so deleting or
 * archiving a card removes it from every cell it was linked in, and monday reports each of those as an
 * ordinary relation change attributed to whoever deleted it. Read naively, that is "the person unlinked
 * it" -- while restoreDeletedCard is bringing the same card back from HubSpot, because a monday delete
 * must never delete anything in HubSpot. On the Deals <-> Line Items pair it would also detach the line
 * item from its deal in HubSpot and CHANGE THE DEAL AMOUNT. So each removed card's own state is read,
 * and only an ACTIVE card can unlink.
 *
 * The state is read BEFORE the cap and the budget, on purpose. A person bulk-deleting six contacts off
 * one Account produces six removals that coalesce into one run; judged before the state read, that is
 * "six links removed in one edit" -- a refusal, and a snap-back racing restoreDeletedCard for the very
 * same cards. Skipping a deleted card is not a refusal and does not snap the cell back: restore owns
 * putting the card back.
 *
 * A BOUND, because one thing is unproven: whether monday caps the link list it puts in a webhook. If it
 * did, a large cell (an Account holds 100+ contacts) could appear to lose dozens of links in one event.
 * A person removes one or two links per click; a click claiming more than MAX_UNLINKS_PER_EDIT of
 * cards that still exist is refused and the cell snaps back, so nothing in HubSpot is lost.
 */
const unlinkRemovedCards: RelationStep = async (env, spec, a, col, target, rec, item, opts, budget, scope, authRef) => {
  if (!(scope.unlinked?.[col] ?? []).length) return null;
  const linkedCards = await getLinkedItemIds(env, item.id, col);
  const removedCards = (scope.unlinked?.[col] ?? []).filter(c => !linkedCards.includes(c));
  if (!removedCards.length) return null;                       // re-linked in the meantime: agreement 2
  const active = await activeCards(env, spec, item.id, a, removedCards);
  if (!active.length) return null;
  const n = perClick(active.length, scope.largestEvent?.[col]?.removed);
  if (n > MAX_UNLINKS_PER_EDIT)
    return `${n} links removed in one edit (max ${MAX_UNLINKS_PER_EDIT}); remove them in HubSpot`;

  const removedHs = await getItemsColumnText(env, active, target.idCol);
  const stillHs = new Set(Object.values(linkedCards.length
    ? await getItemsColumnText(env, linkedCards, target.idCol) : {}));
  const drop = [...new Set(Object.values(removedHs).filter(id => /^\d+$/.test(id) && !stillHs.has(id)))];
  if (!drop.length) return null;
  const refused = await relationWriteRefusal(env, spec, rec, opts, budget, scope, authRef);
  if (refused) return refused;
  let removed = 0;
  for (const hsId of drop) {
    if (budget.left <= 0) return `write budget exhausted after ${removed} of ${drop.length} unlinks`;
    await deleteAssociation(env, spec.object, rec.id, a.toObject, hsId, opts, spec, authRef.auth);
    budget.left--; removed++;
  }
  console.log(`source=monday object=${spec.object} id=${rec.id} unlink=${a.toObject} removed=${removed}`
    + ` of=${drop.length} action=reverse-unlinked`);
  return null;
};

/**
 * PUSH what the person added (G1), and nothing that was already in the cell.
 *
 * The cards come from the webhook's diff, NOT from re-reading the cell (G3): a HubSpot event can run the
 * forward pass between the click and this push, and rewrite the cell from HubSpot's set, which does not
 * have the link yet -- reading the cell then finds nothing to push and the person's link is lost.
 *
 * "Already associated" is judged on the PAGED read and a partial read is a refusal: a 100-capped read of
 * an Account with 300 contacts would call 200 existing links missing.
 *
 * Immediately before each PUT the pass re-checks whether the card has since been removed from this cell
 * (removedSince, on the shared person queue). The queued run behind this one carries that removal, so
 * skipping here is what stops a late add from re-creating a link a person removed.
 */
const pushAddedCards: RelationStep = async (env, spec, a, col, target, rec, item, opts, budget, scope, authRef) => {
  const added = scope.linked?.[col];
  if (added === undefined)
    return "the event carried no usable before-value, so what the person added cannot be told apart from what was already in the cell";
  if (!added.length) return null;
  const n = perClick(added.length, scope.largestEvent?.[col]?.added);
  if (n > MAX_LINKS_PER_EDIT)
    return `${n} links added in one edit (max ${MAX_LINKS_PER_EDIT}); link them in HubSpot`;
  const key = personKey(item, col);
  const stillWanted = (cards: string[]) => cards.some(c => !removedSince(key, c));

  const hsIdByCard = await getItemsColumnText(env, added, target.idCol);
  const cardsByHs = new Map<string, string[]>();
  for (const c of added) {
    const h = hsIdByCard[c] ?? "";
    if (/^\d+$/.test(h)) cardsByHs.set(h, [...(cardsByHs.get(h) ?? []), c]);
  }
  const unsynced = added.filter(c => !/^\d+$/.test(hsIdByCard[c] ?? ""));
  if (unsynced.length)
    console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject} cards=${unsynced.join(",")}`
      + ` action=reverse-assoc-skipped reason="linked card has no HubSpot id yet"`);
  if (!cardsByHs.size) return null;

  const current = await getAllAssociatedIds(env, spec.object, rec.id, a.toObject);
  if (current.truncated)
    return "HubSpot's association read is partial, so which of the added links are missing cannot be proven";
  const have = new Set(current.ids);
  const absent = [...cardsByHs.keys()].filter(h => !have.has(h));
  // Checked before the claim as well as before each PUT: an add that has already been taken back must
  // not even stamp ownership.
  const missing = absent.filter(h => stillWanted(cardsByHs.get(h)!));
  if (!missing.length) {
    console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject} added=${added.length} pushed=0`
      + ` action=${absent.length ? "reverse-assoc-superseded" : "already-associated"}`);
    return null;
  }
  const refused = await relationWriteRefusal(env, spec, rec, opts, budget, scope, authRef);
  if (refused) return refused;
  let pushed = 0;
  for (const hsId of missing) {
    if (!stillWanted(cardsByHs.get(hsId)!)) {
      console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject} to=${hsId}`
        + ` action=reverse-assoc-superseded reason="removed again before it was sent"`);
      continue;
    }
    if (budget.left <= 0) return `write budget exhausted after ${pushed} of ${missing.length} links`;
    await putAssociation(env, spec.object, rec.id, a.toObject, hsId, opts, spec, authRef.auth);
    budget.left--; pushed++;
  }
  console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject} added=${added.length}`
    + ` pushed=${pushed} action=reverse-associated`);
  return null;
};

/**
 * G2, SNAP-BACK: a refused or rejected relation edit is undone AT ONCE, instead of the cell showing what
 * the person picked -- which reads as saved -- until some unrelated HubSpot event happens to run the
 * forward pass, possibly days later, possibly never.
 *
 * IT UNDOES THE PERSON'S DIFF, NOT THE CELL (undoRelationEdit). Each card the person added that HubSpot
 * does not link is taken back out, and each still-existing card they removed that HubSpot still links
 * is put back; every other card in the cell is left exactly as it is. The first version rewrote the
 * whole cell from HubSpot's set, which needs every associated id resolved to a card -- and that
 * resolution (findItemIdsByColumn) returns at most 100. On an Account with 150 contacts one refused add
 * wrote 130 cards and stripped 20 real links from it and, through the pairing, from 20 Contact cards,
 * which the 100-capped forward pass could then never repair. It also created missing cards on demand,
 * racing restoreDeletedCard into duplicates. The diff needs neither: it only ever touches the cards the
 * person touched, which are already cards.
 *
 * ONLY WHEN THE DIFF CANNOT BE TOLD (no usable before-value) is the whole cell rewritten, through
 * syncRelationColumn in snap-back mode: clearsFromEmpty and shrinksFreshCard are skipped (both guard a
 * LAGGING READ racing a create; here the trigger is a known refusal, and an empty HubSpot set is then
 * the answer), no card is created, and the write is refused unless EVERY id resolved.
 *
 * In both modes a truncated HubSpot read writes nothing: a partial read must never drive a write.
 * Our own write fires a monday event under our own token, which is self-origin: it can never push.
 */
async function snapBackRelation(env: Env, spec: ObjectSpec, a: AssocSpec, rec: HsRecord, item: MondayItem,
    opts: RunOpts, budget: Budget, edit: CellEdit | null, why: string): Promise<void> {
  console.log(`source=monday object=${spec.object} id=${rec.id} relation=${a.toObject} item=${item.id}`
    + ` action=reverse-refused-snap-back reason="${why.slice(0, 300)}"`);
  try {
    const set: AssocPage = a.via
      ? await getAssociatedVia(env, spec.object, rec.id, a.via, a.toObject, a.viaPrimary)
      : await getAllAssociatedIds(env, spec.object, rec.id, a.toObject);
    if (edit && !set.truncated) await undoRelationEdit(env, spec, a, set.ids, item, edit, opts, budget);
    else await syncRelationColumn(env, spec, a, set.ids, item, undefined, opts, budget, set.truncated, true);
  } catch (e) {
    console.log(`source=monday object=${spec.object} id=${rec.id} relation=${a.toObject} item=${item.id}`
      + ` action=snap-back-failed reason="${String(e).slice(0, 160)}"`);
  }
}

/** The diff-scoped snap-back. `hsIds` is HubSpot's complete current set for this relation. */
async function undoRelationEdit(env: Env, spec: ObjectSpec, a: AssocSpec, hsIds: string[], item: MondayItem,
    edit: CellEdit, opts: RunOpts, budget: Budget): Promise<void> {
  const target = specByObject(env, a.toObject);
  const col = a.relationCol!;
  if (!target || (!edit.added.length && !edit.removed.length)) return;
  const current = await getLinkedItemIds(env, item.id, col);
  const inHubspot = new Set(hsIds);
  const hsOf = await getItemsColumnText(env, [...new Set([...edit.added, ...edit.removed])], target.idCol);
  const linkedInHs = (c: string) => inHubspot.has(hsOf[c] ?? "");
  const takeOut = new Set(edit.added.filter(c => current.includes(c) && !linkedInHs(c)));
  const candidates = edit.removed.filter(c => !current.includes(c) && linkedInHs(c));
  // G4 again: a deleted card is put back by restoreDeletedCard, never by relinking a dead id here.
  const putBack = candidates.length ? await activeCards(env, spec, item.id, a, candidates, "snap-back-skipped-inactive-card") : [];
  if (!takeOut.size && !putBack.length) {
    console.log(`source=monday object=${spec.object} item=${item.id} relation=${a.toObject}`
      + ` action=snap-back-nothing-to-undo reason="the cell already agrees with HubSpot on every card the edit touched"`);
    return;
  }
  const want = [...current.filter(c => !takeOut.has(c)), ...putBack];
  if (opts.dryRun) { console.log(`DRY relation ${spec.object}/${item.id} ${a.toObject}=[${want.join(",")}]`); return; }
  await setColumns(env, spec.boardId, item.id, { [col]: { item_ids: want.map(Number) } }, opts); budget.left--;
  console.log(`source=monday object=${spec.object} item=${item.id} relation=${a.toObject} board=${spec.boardId}`
    + ` taken-out=${[...takeOut].join(",") || "-"} put-back=${putBack.join(",") || "-"} action=snapped-back-relation`);
}

// ------------------------------------------------------------------------------ born attached

/** What one birth pass did, for the single `action=born-attached` line createFromMonday logs.
 *  `links`: associations sent. `skipped`: linked cards with no HubSpot id yet. `refused`: columns
 *  refused (over the cap, budget, ownership, a HubSpot error), each snapped back. */
export interface BirthLinks { links: number; skipped: number; refused: number }

/**
 * The relation columns a birth pass may send, and why the rest may not:
 *   - `via` (derived): the link it shows was computed through another object and has no inverse;
 *   - line items: a P&S card that already has an id belongs to another deal, and linking it to this one
 *     too would put it on two deals and count its amount twice;
 *   - the createParent column: that link already rode inside the create payload.
 * CRM Deals -> deal_contact + the companies column; Contacts -> contact_account; Accounts ->
 * account_contact; Products & Services -> none.
 */
export const birthColumns = (spec: ObjectSpec): AssocSpec[] =>
  (spec.associations ?? []).filter(a => !!a.relationCol && !a.via && !a.subitems
    && a.toObject !== "line_items" && a.relationCol !== spec.createParent?.relationCol);

/**
 * BORN ATTACHED: a HubSpot record created from a monday card gets the links that card already shows.
 *
 * THE GAP (2026-10-01). A rep filling the Create form, or "+ Add", with a Contact and an Account got a
 * HubSpot Deal with NO associations. createFromMonday created the record and returned. reverseAssociations
 * runs only for a card that already has a HubSpot id, and only for a person's relation edit, so nothing
 * ever sent the links the card was born with. Nothing logged it either: the forward pass's clearsFromEmpty
 * guard kept the card showing links HubSpot did not have. A relation edit made while the create was in
 * flight was lost too, because it hit the per-item claim as "creating" and was skipped.
 *
 * WHY A READ AFTER THE CREATE, NOT THE CREATE PAYLOAD. createRecord could carry them, as createParent's
 * does, but:
 *   (a) only links readable BEFORE the create would ride along, so the in-flight edit would still be lost;
 *   (b) HubSpot's create is all-or-nothing, so one stale or merged far id would reject the whole record
 *       and the rep's form would produce nothing at all. createParent accepts that on purpose, because a
 *       parentless line item is unreachable. A Deal with one Contact missing is not;
 *   (c) the contact/company association type ids are not verified live here. The default PUT needs none.
 *
 * So it is called ONLY after a real create, and AFTER the id write-back (see createFromMonday). Every
 * relation change made before the write-back is in the cell this reads. Every change made after it reads
 * the id and takes the ordinary column-level path. Either way the link reaches HubSpot once: a PUT for a
 * pair HubSpot already links is the same single association, so a link sent by both is harmless.
 *
 * THE RULES are the column-level reverse's, applied to a cell whose whole content is new:
 *   - ADDITIVE ONLY. It never deletes; a new record has nothing to remove.
 *   - Only cards that carry a HubSpot id. The rest are logged and left on the card, with no snap-back.
 *     For Contact <-> Account the far card's own birth links back through the paired cell.
 *   - At most MAX_LINKS_PER_EDIT per column, judged on the whole cell. Over it, nothing in that column is
 *     sent (never a partial set) and the cell snaps back (G2), exactly as a person's over-cap edit does.
 *   - Re-checked against a later removal (removedSince) just before every PUT (G3).
 *   - A Deal born with exactly ONE company links it as Primary, as HubSpot's own Create Deal UI and
 *     fillDealCompany do (8,462 of 8,466 deals carry it). With several, none is picked: all unlabelled.
 *
 * NO CLAIM, AND NO NEW CLAIM BASIS. The record was born stamped for this Worker, by withBirthOwnership in
 * the very payload HubSpot just accepted, so the auth is authorizeWrite on that payload: "stamped crm",
 * bound to the new id. An ADOPTED record never comes here. Adoption does not claim, and linking a record
 * this Worker did not create is a person's edit to make, through the ordinary path.
 *
 * WHOSE CELL IT IS. This reads the whole cell and cannot tell who put a card in it, so the CALLER vouches
 * for provenance, and the create path only calls it for a create a PERSON's event started (bornAttached):
 * an automation's is suppressed, as its relation edits are. A card this Worker already made for a record
 * (whose cells the forward pass filled from HubSpot) never gets here either: createFromMonday re-stamps it
 * from the card-owner index instead of creating. Together those close the fake.com shape, a record
 * created from an echo and then given whole-cell associations taken from echo content.
 *
 * Column-level (CRM) specs only; returns null for any other, so the WM create path is unchanged. And only
 * while the BORN_ATTACHED_LINKS kill switch is on (the same literal "true" test as sync.ts birthLinksOn,
 * repeated here rather than imported so this module keeps no dependency on sync.ts): createFromMonday does
 * not call this when it is off, and this refuses too, so no future caller can send birth links past it.
 */
export async function pushBirthAssociations(env: Env, spec: ObjectSpec, recordId: string,
    birthProps: Record<string, string>, item: MondayItem, opts: RunOpts, budget: Budget): Promise<BirthLinks | null> {
  if (!spec.columnLevelReverse || env.BORN_ATTACHED_LINKS !== "true") return null;
  const out: BirthLinks = { links: 0, skipped: 0, refused: 0 };
  const rec: HsRecord = { id: recordId, properties: { ...birthProps } };
  const auth = spec.ownership ? authorizeWrite(rec, spec.ownership) : undefined;
  const tag = `source=monday object=${spec.object} id=${recordId} item=${item.id}`;
  for (const a of birthColumns(spec)) {
    const col = a.relationCol!;
    const target = specByObject(env, a.toObject);
    if (!target) continue;
    // The cards a refusal takes back out of the cell: never the unsynced ones, which were not refused.
    let offered: string[] = [];
    let why: string | null = null;
    try {
      const cards = await getLinkedItemIds(env, item.id, col);
      if (!cards.length) continue;
      offered = cards;
      if (cards.length > MAX_LINKS_PER_EDIT) {
        why = `${cards.length} links on a new card (max ${MAX_LINKS_PER_EDIT}); link them in HubSpot`;
      } else {
        const hsIdByCard = await getItemsColumnText(env, cards, target.idCol);
        const cardsByHs = new Map<string, string[]>();
        for (const c of cards) {
          const h = hsIdByCard[c] ?? "";
          if (/^\d+$/.test(h)) cardsByHs.set(h, [...(cardsByHs.get(h) ?? []), c]);
        }
        const unsynced = cards.filter(c => !/^\d+$/.test(hsIdByCard[c] ?? ""));
        if (unsynced.length) {
          out.skipped += unsynced.length;
          console.log(`${tag} reverse=${a.toObject} basis=birth cards=${unsynced.join(",")}`
            + ` action=birth-assoc-skipped reason="linked card has no HubSpot id yet"`);
        }
        offered = cards.filter(c => !unsynced.includes(c));
        if (cardsByHs.size) why = await sendBirthLinks(env, spec, a, col, recordId, item, cardsByHs,
          cards.length, opts, budget, auth, out);
      }
    } catch (e) {
      // A HubSpot rejection, or a failed monday read. Either way the cell may show a link HubSpot lacks.
      why = `the link could not be sent: ${String(e).slice(0, 140)}`;
    }
    if (!why) continue;
    out.refused++;
    console.log(`${tag} reverse=${a.toObject} basis=birth action=birth-assoc-refused reason="${why.slice(0, 300)}"`);
    if (offered.length)
      await snapBackRelation(env, spec, a, rec, item, opts, budget, { added: offered, removed: [] }, why);
  }
  return out;
}

/** One column's PUTs for pushBirthAssociations. Returns the refusal reason, or null when every card that
 *  is still wanted was sent. */
async function sendBirthLinks(env: Env, spec: ObjectSpec, a: AssocSpec, col: string, recordId: string,
    item: MondayItem, cardsByHs: Map<string, string[]>, linked: number, opts: RunOpts, budget: Budget,
    auth: WriteAuth | undefined, out: BirthLinks): Promise<string | null> {
  if (auth && !auth.allowed) return auth.reason;
  const key = personKey(item, col);
  const hsIds = [...cardsByHs.keys()];
  const primary = spec.object === "deals" && a.toObject === "companies" && hsIds.length === 1;
  let pushed = 0;
  for (const hsId of hsIds) {
    if (cardsByHs.get(hsId)!.every(c => removedSince(key, c))) {
      console.log(`source=monday object=${spec.object} id=${recordId} reverse=${a.toObject} to=${hsId} basis=birth`
        + ` action=birth-assoc-superseded reason="removed again before it was sent"`);
      continue;
    }
    if (budget.left <= 0) return `write budget exhausted after ${pushed} of ${hsIds.length} links`;
    if (primary)
      await putAssociationTypes(env, spec.object, recordId, a.toObject, hsId, [DEAL_COMPANY_PRIMARY], opts, spec, auth);
    else
      await putAssociation(env, spec.object, recordId, a.toObject, hsId, opts, spec, auth);
    budget.left--; pushed++; out.links++;
  }
  console.log(`source=monday object=${spec.object} id=${recordId} item=${item.id} reverse=${a.toObject} basis=birth`
    + ` linked=${linked} pushed=${pushed}${primary ? " label=primary" : ""} action=birth-associated`);
  return null;
}

/**
 * The derived relation: its one permitted HubSpot edit (fillDealCompany), else a snap-back.
 *
 * G4 applies here too, and FIRST: deleting or archiving an Account card removes it from the derived
 * cell of every line item it showed on, and each of those arrives as "the person removed this Account".
 * That is not an edit of the line item at all, so a card that no longer exists is dropped from the diff
 * before anything else, and an edit left with nothing in it is not a refusal -- no snap-back per line
 * item, racing restoreDeletedCard for the same Account.
 */
async function reverseDerivedRelation(env: Env, spec: ObjectSpec, a: AssocSpec, col: string, rec: HsRecord,
    item: MondayItem, opts: RunOpts, budget: Budget, scope: ReverseScope): Promise<void> {
  const removed = scope.unlinked?.[col] ?? [];
  let eff = scope;
  if (removed.length) {
    const alive = await activeCards(env, spec, item.id, a, removed);
    if (alive.length !== removed.length) {
      eff = { ...scope, unlinked: { ...scope.unlinked, [col]: alive } };
      if (!alive.length && scope.linked?.[col]?.length === 0) return;   // only deletions: nothing to decide
    }
  }
  let why: string | null;
  try {
    why = await fillDealCompany(env, spec, a, col, rec, item, opts, budget, eff);
  } catch (e) {
    why = `HubSpot rejected the change: ${String(e).slice(0, 140)}`;
  }
  if (why) await snapBackRelation(env, spec, a, rec, item, opts, budget, cellEditOf(eff, col), why);
}

/** Deals whose company an A1 fill is deciding right now, in this isolate. See fillDealCompany. */
const dealsBeingFilled = new Set<string>();

/**
 * P&S "Accounts/Companies" (A1): FILL THE DEAL'S COMPANY, IF IT HAS NONE. Returns the refusal reason, or
 * null when it wrote (or there was nothing to do).
 *
 * The cell is derived: line item -> its deal -> the deal's companies, because HubSpot defines no
 * line_item <-> company association at all. So a rep picking an Account on a line item has exactly one
 * honest HubSpot meaning, and only in one situation: its single deal has NO company yet, and the rep is
 * saying which. Then the DEAL is associated to that company as HubSpot's Primary (typeId 5), and the
 * deal's associationChange webhook refreshes every one of its line items' derived cells.
 *
 * Everything else is refused and snapped back, deliberately:
 *   - the deal already has a company: re-pointing it moves EVERY line item on the deal, and the Deal
 *     card is where a person can see that; doing it from one line item would surprise the other eleven;
 *   - a cleared cell, several Accounts, or a swap: there is no line-item association to remove, and
 *     removing the deal's company from a line item is the same surprise;
 *   - a line item on no deal, or on two: no single deal to write;
 *   - the deal refused by ownership (decided on the DEAL, the record written, with a person's
 *     human-edit claim), a HubSpot error, the budget, or PS_ACCOUNT_REVERSE off.
 * No path here ever calls a line_items <-> companies endpoint; hubspot.ts refuses one outright.
 *
 * TWO RACES, both closed the same way as on the ordinary path:
 *   - G3: the Account removed again while this pass reads. Re-checked (removedSince) before the claim
 *     and again right before the PUT; a superseded fill is not a refusal, and the queued run behind
 *     this one carries the removal. Without it the PUT went out, the trailing run refused the removal,
 *     and its snap-back re-showed the company the person had just taken off.
 *   - Two line items of ONE company-less deal filled at once (two reps, two Accounts): both would read
 *     "no company" and both PUT Primary, leaving two companies or a moved label -- the very re-point A1
 *     forbids. Serialised per deal in this isolate (the second is refused and snapped back), and the
 *     deal's companies re-read right before the PUT, which narrows the cross-isolate window to one read.
 */
async function fillDealCompany(env: Env, spec: ObjectSpec, a: AssocSpec, col: string, rec: HsRecord,
    item: MondayItem, opts: RunOpts, budget: Budget, scope: ReverseScope): Promise<string | null> {
  const added = scope.linked?.[col];
  const removed = scope.unlinked?.[col] ?? [];
  if (added && !added.length && !removed.length) return null;         // nothing changed in this run
  if (env.PS_ACCOUNT_REVERSE !== "true")
    return "the Account is derived from the line item's deal; PS_ACCOUNT_REVERSE is off, so change it on the Deal";
  if (a.via !== "deals" || a.toObject !== "companies")
    return `no reverse is defined for a ${a.toObject} link derived via ${a.via}`;
  if (added === undefined) return "the event carried no usable before-value";
  if (removed.length || added.length !== 1)
    return `only adding exactly one Account can be sent (added ${added.length}, removed ${removed.length}); change it on the Deal`;

  const accounts = specByObject(env, "companies");
  const dealSpec = specByObject(env, "deals");
  if (!accounts || !dealSpec) return "companies/deals are not boards of this deployment";
  const companyId = (await getItemsColumnText(env, added, accounts.idCol))[added[0]] ?? "";
  if (!/^\d+$/.test(companyId)) return "the picked Account card has no HubSpot id yet";

  const deals = await getAllAssociatedIds(env, spec.object, rec.id, "deals");
  if (deals.truncated || deals.ids.length !== 1)
    return `the line item is on ${deals.truncated ? "an unreadable number of" : deals.ids.length} deal(s), not exactly one`;
  const dealId = deals.ids[0];
  if (dealsBeingFilled.has(dealId))
    return `another line item is filling deal ${dealId}'s company right now; change it on the Deal`;
  dealsBeingFilled.add(dealId);
  try {
    const key = personKey(item, col);
    const superseded = () => {
      if (!removedSince(key, added[0])) return false;
      console.log(`source=monday object=${spec.object} id=${rec.id} item=${item.id} deal=${dealId}`
        + ` action=fill-deal-company-superseded reason="the Account was removed again before it was sent"`);
      return true;
    };
    const hasCompany = async () => {
      const c = await getAllAssociatedIds(env, "deals", dealId, "companies");
      return c.truncated || c.ids.length > 0;
    };
    if (await hasCompany())
      return `deal ${dealId} already has a company; change it on the Deal, where every line item it moves is visible`;

    const deal = await getRecord(env, "deals", dealId, propertiesForSpec(dealSpec));
    if (!deal) return `deal ${dealId} is not readable`;
    if (superseded()) return null;
    // Budget before the claim, and enough for the claim AND the PUT (see relationWriteRefusal).
    const willClaim = !!dealSpec.ownership && canClaimCrmOwnership(deal, dealSpec.ownership, "human-edit");
    if (budget.left < (willClaim ? 2 : 1)) return "write budget exhausted";
    const auth = await ensureHubspotWriteAuth(env, dealSpec, budget, deal, opts, "human-edit");
    if (auth && !auth.allowed) return `deal ${dealId}: ${auth.reason}`;
    if (superseded()) return null;
    if (await hasCompany())
      return `deal ${dealId} gained a company while this was being decided; change it on the Deal`;
    await putAssociationTypes(env, "deals", dealId, "companies", companyId, [DEAL_COMPANY_PRIMARY], opts, dealSpec, auth);
    budget.left--;
  } finally {
    dealsBeingFilled.delete(dealId);
  }
  console.log(`source=monday object=${spec.object} id=${rec.id} item=${item.id} deal=${dealId} company=${companyId}`
    + ` action=filled-deal-company label=primary`);
  return null;
}

// HubSpot COMPUTES these from price/quantity/discount — don't send them on a line-item create.
const LI_CALCULATED = new Set(["amount", "hs_pre_discount_amount"]);

/** How long to leave a brand-new id-less subitem alone, so the app's own /app/line-item create (which is
 * idempotent and carries the full field set) wins instead of racing this pass into a duplicate. */
const APP_CREATE_GRACE_MS = 90_000;

/** REVERSE line-item pass (monday subitems -> HubSpot line items). id-keyed + additive: creates a HubSpot
 * line item only for a subitem with an EMPTY "HubSpot Line Item ID", then stamps the returned id back so
 * the forward pass treats it as synced (no duplicate). Never deletes. Requires crm.objects.line_items.write. */
export async function reverseLineItems(env: Env, sub: SubitemSpec, parentItem: MondayItem,
    dealHubspotId: string, opts: RunOpts, budget: Budget): Promise<void> {
  const subitems = await getSubitems(env, parentItem.id);
  // The app creates the subitem FIRST and then calls POST /app/line-item to create the HubSpot line item
  // and stamp its id back. Saving a deal also fires a monday column webhook that lands here in the middle
  // of that — and creating one now yields TWO line items on the deal, doubling its total. Leave brand-new
  // id-less subitems to the app; if it never finishes, a later pass (10-min backup / daily) picks them up.
  const now = Date.now();
  const idless = subitems.filter(s => {
    if (colText(s, sub.idCol)) return false;                    // already has a HubSpot Line Item ID
    const age = now - (Date.parse(s.created_at) || 0);
    if (age < APP_CREATE_GRACE_MS) {
      console.log(`source=monday reverse-line-item deal=${dealHubspotId} subitem=${s.id} action=deferred reason="created ${Math.round(age / 1000)}s ago; the app may still be creating its line item"`);
      return false;
    }
    return true;
  });
  if (!idless.length) return;
  // Dedup guard (webhook coalescing is per-isolate; two isolates could double-create): adopt an existing
  // same-name line item already on this deal instead of creating a second one.
  const byName: Record<string, string> = {};
  try {
    const liIds = await getAssociatedIds(env, "deals", dealHubspotId, "line_items");
    const lis = liIds.length ? await getRecordsByIds(env, "line_items", liIds, ["name"]) : [];
    for (const li of lis) { const n = (li.properties.name ?? "").trim(); if (n && !(n in byName)) byName[n] = li.id; }
  } catch { /* best-effort dedup */ }
  for (const s of idless) {
    if (budget.left <= 0) break;
    const name = (s.name ?? "").trim();
    if (name && byName[name]) { // a matching line item already exists -> adopt it, never duplicate
      const liId = byName[name]; delete byName[name];
      await setColumns(env, sub.boardId, s.id, { [sub.idCol]: liId }, opts); budget.left--;
      console.log(`source=monday reverse-line-item deal=${dealHubspotId} subitem=${s.id} line_item=${liId} action=adopted`);
      continue;
    }
    const props: Record<string, string> = {};
    if (name) props["name"] = name;
    for (const f of sub.fields) {
      if (LI_CALCULATED.has(f.hs)) continue;
      const v = colText(s, f.col).trim();
      if (v) props[f.hs] = f.type === "date" ? v.slice(0, 10) : v;
    }
    // Picked from the HubSpot product library (the vibe app sets the product id) -> link the line item.
    if (sub.productIdCol) { const pid = colText(s, sub.productIdCol).trim(); if (pid) props["hs_product_id"] = pid; }
    if (!props["name"] && !props["price"]) continue; // nothing meaningful to create
    try {
      // BORN OWNED. A line item created here belongs to whichever deployment made it, stamped inside
      // the create payload exactly as records are — an unstamped one would fall to the cutover
      // fallback and could be picked up by the other side.
      const liSpec = lineItemOwnerSpec(env);
      const liId = await createLineItem(env, withBirthOwnership(props, liSpec?.ownership),
        dealHubspotId, opts, liSpec, liSpec?.ownership ? authorizeCreate(liSpec.ownership) : undefined);
      budget.left--;
      if (liId) await setColumns(env, sub.boardId, s.id, { [sub.idCol]: liId }, opts);
      console.log(`source=monday reverse-line-item deal=${dealHubspotId} subitem=${s.id} line_item=${liId} action=created`);
    } catch (e) {
      console.log(`reverse-line-item error deal=${dealHubspotId} subitem=${s.id}: ${String(e).slice(0, 140)} (needs crm.objects.line_items.write?)`);
    }
  }
}

/** company/contact/deal associations -> comma-joined names in a parent text column (cleared when none). */
async function syncNameColumn(env: Env, spec: ObjectSpec, a: AssocSpec, ids: string[], rec: HsRecord,
    item: MondayItem, opts: RunOpts, budget: Budget): Promise<void> {
  const recs = await getRecordsByIds(env, a.toObject, ids, a.nameProps);
  const names = recs.map(r => a.nameProps.map(p => r.properties[p] ?? "").join(" ").trim())
    .filter(Boolean).join(", ");
  if (colText(item, a.col!) === names) {
    console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} count=${ids.length} action=skipped`);
    return;
  }
  if (opts.dryRun) { console.log(`DRY assoc ${spec.object}/${rec.id} ${a.toObject}='${names}'`); return; }
  await setColumns(env, spec.boardId, item.id, { [a.col!]: names }, opts); budget.left--;
  console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} count=${ids.length} board=${spec.boardId} item=${item.id} action=${names ? "updated-monday" : "cleared-monday"}`);
}

export const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

/** Would writing `want` over `current` WIPE an existing set of links using an EMPTY HubSpot read?
 *
 * HubSpot's association index is eventually consistent, and an app-created deal pushes its links via
 * reverseAssociations moments after the card is written. A deal.creation webhook that lands in between
 * reads ZERO associations — and the forward pass would then clear the links the rep just picked
 * (observed live: 2 of 3 test deals lost their contact/company links this way).
 *
 * So the forward pass refuses to clear from an empty read. Trade-off: removing the LAST association in
 * HubSpot no longer clears monday on its own. The reverse pass is NOT additive-only any more -- since
 * 2026-09-23 a person's explicit unlink deletes the association, and since 2026-09-28 a refused relation
 * edit is undone at once (snapBackRelation) -- but neither of those reads "fewer links" off a lagging
 * index: the unlink comes from monday's own before/after, and the snap-back from a known refusal. The
 * snap-back normally undoes only the cards the person touched and never comes here; only when the diff
 * cannot be told does it rewrite the whole cell through syncRelationColumn in snap-back mode, which
 * skips this guard, so a refused FIRST link can still be taken back out. Removing links IN THE APP still
 * works — the drawer writes the relation column itself and calls deleteAssociation. */
export const clearsFromEmpty = (current: string[], want: string[]): boolean =>
  want.length === 0 && current.length > 0;

/** Would this write DROP links because the desired set is INCOMPLETE rather than genuinely smaller?
 *
 * `want` is built by resolving each associated HubSpot id to a monday card, and an id silently falls out
 * when (a) HubSpot's association index has only partially caught up — the create race is not all-or-nothing,
 * it can return the company but not yet the contact — or (b) the budget ran out before the missing card
 * could be created (syncRelationColumn skips on-demand creation once `budget.left <= 0`). In both cases the
 * shortfall is OUR blind spot, not a user removing a link, so writing `want` would destroy real links. A
 * genuine removal still reconciles, because then every remaining id resolves and `want.length === ids.length`. */
export const resolvedAllIds = (ids: string[], want: string[]): boolean => want.length === ids.length;

/** Would this write SHRINK a brand-new card's links?
 *
 * `resolvedAllIds` cannot see the worst case: when HubSpot's association index has only partially caught up
 * it returns a STRICT SUBSET of the ids, so every id it did return resolves cleanly and the shortfall is
 * invisible (ids=[A], want=[cardA], current=[cardA,cardB] — arithmetically identical to a genuine removal
 * of B). The one signal that separates them is the card's AGE: an app-created deal is seconds old and is
 * precisely when the index lags, whereas a real removal happens on an established card. Same 90s grace the
 * line-item reverse pass already uses. */
export const shrinksFreshCard = (createdAt: string, want: string[], current: string[], now: number): boolean =>
  want.length < current.length && (now - (Date.parse(createdAt) || 0)) < APP_CREATE_GRACE_MS;

/** company/contact/deal associations -> a monday "Connect Boards" (board_relation) column that LINKS the
 * actual cards. Resolves each associated HubSpot id to the monday card on the target board; if a target
 * card doesn't exist yet, it is created on demand (so associations always link, even for records the
 * target board's own filter would exclude). Skips when links already match. HubSpot -> monday only.
 *
 * `snapBack` is the G2 whole-cell mode (see snapBackRelation), used only when the person's diff cannot be
 * told: the write undoes a KNOWN refusal, so the two guards that exist only to second-guess a lagging
 * read -- clearsFromEmpty and shrinksFreshCard -- are skipped. The truncation guard still applies, and the
 * partial-resolution guard becomes strict (every id must resolve). The snap-back passes no `ctx`, so it
 * never creates a card: a missing one would race restoreDeletedCard into a duplicate. */
async function syncRelationColumn(env: Env, spec: ObjectSpec, a: AssocSpec, ids: string[],
    item: MondayItem, ctx: Ctx | undefined, opts: RunOpts, budget: Budget, truncated = false,
    snapBack = false): Promise<void> {
  /**
   * A TRUNCATED ASSOCIATION READ MUST NEVER DRIVE A FULL-REPLACEMENT WRITE.
   *
   * getAssociatedPage asks for 100 and does not page, so a record with more than 100 associations
   * yields the first 100 plus a cursor. Writing those as `item_ids` REPLACES the cell — and because
   * board_relation columns are PAIRED, it also strips the link from every card outside that 100,
   * on cards this pass never looked at.
   *
   * OBSERVED LIVE, which is why this exists rather than being a precaution: contact 2855936605 had
   * its Company cell set and cleared on a cycle from 2026-09-10 to 09-12, every event under this
   * integration's own token, because the relation backfill (which pages correctly) kept restoring
   * what the capped read kept removing. Measured 2026-09-14: one Accounts card is 39 links short of
   * HubSpot, and 3,473 further links sit above 100 across 25 cards — every one of which would be
   * dropped the next time its company is synced.
   *
   * The four guards below cannot see it. `want` holds 100 items so it is not empty; every id the
   * capped read returned DID resolve, so resolvedAllIds passes; the cards are not fresh; and the sets
   * genuinely differ. Those catch incomplete RESOLUTION — this is incomplete READING, one layer up,
   * and it needs its own signal.
   *
   * Refusing costs a stale cell that the next complete read repairs. Writing costs real links.
   */
  if (truncated) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject}`
      + ` read=${ids.length} action=kept-truncated reason="HubSpot returned a partial association page;`
      + ` a full-replacement write would clear every link outside it"`);
    return;
  }
  // DEPLOYMENT-SPECIFIC. With the global map, a CRM contact's relation column would be filled with
  // cards from the WM companies board — a cross-deployment write. Undefined also covers line_items,
  // which have no board, and any object this deployment does not own.
  const target = specByObject(env, a.toObject);
  if (!target) return;
  const existing = ids.length ? await findItemIdsByColumn(env, target.boardId, target.idCol, ids) : {};
  const cardByHsId: Record<string, string> = { ...existing };
  // Resolve every associated id to a monday card, creating on-demand for uncarded ones. A contact-heavy
  // company (up to 100 associated contacts) would otherwise serialize 100 single-record fetches + creates,
  // so BATCH the record fetch (one call) and create the cards with bounded concurrency. Each card is
  // independent and idempotency-guarded by its own Durable Object (ensureCardForRecord), so parallel
  // creates can't duplicate; the budget is a soft cap so a small concurrent overshoot is harmless.
  const uncarded = ids.filter(hsId => !cardByHsId[hsId]);
  if (uncarded.length && ctx && !opts.dryRun && budget.left > 0) {
    const recById: Record<string, HsRecord> = {};
    for (const r of await getRecordsByIds(env, target.object, uncarded, propertiesForSpec(target))) recById[r.id] = r;
    const CARD_CONC = 5;
    for (let i = 0; i < uncarded.length && budget.left > 0; i += CARD_CONC) {
      await Promise.all(uncarded.slice(i, i + CARD_CONC).map(async hsId => {
        if (budget.left <= 0 || cardByHsId[hsId]) return;
        const rec = recById[hsId];
        if (!rec) return;
        const id = cardIdOf(await ensureCardForRecord(env, target, ctx, rec, opts)); budget.left--;
        if (id) {
          cardByHsId[hsId] = id;
          console.log(`source=hubspot object=${target.object} id=${hsId} action=ensured-associated-card board=${target.boardId} item=${id}`);
        }
      }));
    }
  }
  const want = ids.map(hsId => cardByHsId[hsId]).filter((x): x is string => !!x);
  const current = await getLinkedItemIds(env, item.id, a.relationCol!);
  if (sameSet(current, want)) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} count=${want.length} action=skipped`);
    return;
  }
  // Never wipe existing links from an empty HubSpot read (see clearsFromEmpty) — this is the create-race guard.
  // A snap-back is exempt: its trigger is a known refusal, and an empty HubSpot set is then the answer.
  if (!snapBack && clearsFromEmpty(current, want)) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} current=${current.length} action=kept-no-clear reason="hubspot returned no associations"`);
    return;
  }
  // ...and never wipe links just because some associated id didn't resolve to a card this pass (partial
  // eventual consistency, or the budget ran out before the card could be created). See resolvedAllIds.
  // ...nor shrink a card created moments ago, where a partial (strict-subset) association read is expected
  // and looks arithmetically identical to a real removal. See shrinksFreshCard.
  if (!snapBack && shrinksFreshCard(item.created_at, want, current, Date.now())) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} ids=${ids.length} resolved=${want.length} current=${current.length} action=kept-fresh reason="card created <90s ago; association index may lag"`);
    return;
  }
  // A snap-back rewrites the whole cell with no person's edit to explain a shrink, and resolves ids to
  // cards through findItemIdsByColumn, which returns at most 100 -- so it must resolve EVERY id or write
  // nothing. The looser rule below does not hold for it: on a refused add, current is ids + 1, so 20
  // unresolved ids on a 150-link Account would be written away.
  if (snapBack && !resolvedAllIds(ids, want)) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} ids=${ids.length} resolved=${want.length} current=${current.length} action=kept-partial reason="snap-back: not every associated id resolved to a card"`);
    return;
  }
  // Only skip when the unresolved ids FULLY EXPLAIN the shrinkage. Otherwise a permanently unresolvable id
  // (e.g. a merged-away HubSpot record) would freeze the column against every legitimate removal forever.
  if (!resolvedAllIds(ids, want) && current.length - want.length <= ids.length - want.length) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} ids=${ids.length} resolved=${want.length} current=${current.length} action=kept-partial reason="not every associated id resolved to a card"`);
    return;
  }
  if (opts.dryRun) { console.log(`DRY relation ${spec.object}/${item.id} ${a.toObject}=[${want.join(",")}]`); return; }
  await setColumns(env, spec.boardId, item.id, { [a.relationCol!]: { item_ids: want.map(Number) } }, opts); budget.left--;
  console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} board=${spec.boardId} item=${item.id} linked=${want.length} action=${snapBack ? "snapped-back-relation" : "updated-relation"}`);
}

/** deal line items -> monday SUBITEMS under the deal card. Create/update by HubSpot Line Item ID,
 * mark removed subitems "Removed" (or delete if no status column). Everything lives on the subitem
 * columns — there is no parent roll-up. HubSpot -> monday only. */
async function syncLineItems(env: Env, a: AssocSpec, ids: string[], parentId: string, ctx: Ctx,
    opts: RunOpts, budget: Budget, obj: string, recId: string): Promise<void> {
  const sub = a.subitems!;
  console.log(`source=hubspot object=${obj} id=${recId} association=line_items count=${ids.length} action=sync-start`);
  const props = [...new Set([...sub.fields.map(f => f.hs), ...a.nameProps])];
  const lis = ids.length ? await getRecordsByIds(env, "line_items", ids, props) : [];
  const existing = await getSubitems(env, parentId);
  const byLi: Record<string, MondayItem> = {};
  for (const s of existing) { const k = colText(s, sub.idCol); if (k) byLi[k] = s; }

  const want = new Set<string>();
  for (const li of lis) {
    want.add(li.id);
    const name = a.nameProps.map(p => li.properties[p] ?? "").join(" ").trim() || `line_item ${li.id}`;
    const cv: Record<string, unknown> = { [sub.idCol]: li.id };
    for (const f of sub.fields) { const v = formatValue(f, li.properties[f.hs], ctx); if (v != null) cv[f.col] = v; }
    if (opts.dryRun) { console.log(`DRY line_item ${li.id} on ${parentId}`); continue; }
    const cur = byLi[li.id];
    if (cur) {
      await updateItem(env, sub.boardId, cur.id, name, cv, opts); budget.left--;
      console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${li.id} monday_subitem_id=${cur.id} action=updated-subitem`);
    } else {
      const sid = await createSubitem(env, parentId, name, cv, opts); budget.left--;
      console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${li.id} monday_parent_item_id=${parentId} monday_subitem_id=${sid} action=created-subitem`);
    }
  }
  // Removed line items: mark the subitem Status = "Removed" (safest), or delete if no status column.
  for (const s of existing) {
    const k = colText(s, sub.idCol);
    if (!k || want.has(k) || opts.dryRun) continue;
    if (sub.statusCol) {
      if (colText(s, sub.statusCol) === "Removed") continue; // already marked
      await updateItem(env, sub.boardId, s.id, s.name, { [sub.statusCol]: { label: "Removed" } }, opts); budget.left--;
    } else {
      await deleteItem(env, s.id, opts); budget.left--;
    }
    console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${k} monday_subitem_id=${s.id} action=removed-or-marked-inactive`);
  }
  console.log(`source=hubspot object=${obj} id=${recId} association=line_items count=${lis.length} action=${lis.length ? "updated-subitems" : "no-line-items"}`);
}

/**
 * REVERSE a single monday line-item subitem edit -> HubSpot (event-source-wins; monday is the source).
 * A column edit (carries columnId; API "change_column_value" OR the monday UI-integration
 * "update_column_value") -> patch the one reverse-eligible field (has id) or create the line item
 * (no id, via reverseLineItems' grace + dedup). A rename (no columnId; "change_name"/"update_name")
 * -> patch the line-item `name`. Payload-tolerant: it keys on the PRESENCE of columnId, not the exact
 * event-`type` string, so it works for both the API webhook and the monday integration webhook.
 * Echo-suppressed and omit-empty via buildSubitemReversePatch. HubSpot writes gated on LINE_ITEM_WRITE.
 */
export async function reverseSubitemEdit(env: Env, ev: any, opts: RunOpts, budget: Budget): Promise<void> {
  if (env.LINE_ITEM_WRITE !== "true") return;
  const sub = LINE_ITEM_SUBITEMS;
  const { subitemId, columnId, parentItemId } = readSubitemEvent(ev); // camelCase/snake_case tolerant
  if (!subitemId) return;

  // --- Column edit (has columnId) -> patch the changed field, or create if the row has no id yet ---
  if (columnId) {
    const f = subitemFieldByCol(columnId);
    if (!f || !f.reverse) return;                          // gate first: non-reverse column costs 0 API calls
    const item = await getItem(env, subitemId);
    if (!item) return;
    const liId = colText(item, sub.idCol);
    const value = colText(item, f.col);

    if (liId) { // PATCH the single changed field
      const cur = await getRecord(env, "line_items", liId, [f.hs]);
      const hsVal = cur ? String(cur.properties[f.hs] ?? "") : "";
      const props = buildSubitemReversePatch(columnId, value, hsVal);
      if (!props) return;                                  // echo / omit-empty
      const wa = await lineItemWriteAuth(env, liId);
      if (wa && !wa.auth.allowed) {
        console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId}`
          + ` action=refused reason="${wa.auth.reason}"`);
        return;
      }
      await patchLineItem(env, liId, props, opts, wa?.spec, wa?.auth); budget.left--;
      console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId} action=patched cols=${Object.keys(props).join(",")}`);
      return;
    }
    // No id -> CREATE via the existing reverse pass (grace period + name-dedup). Prefer the event's
    // parentItemId (subitem events carry it); fall back to a lookup only if absent.
    const parentId = parentItemId || (await getParentItemId(env, subitemId)) || "";
    if (!parentId) return;
    const parent = await getItem(env, parentId);
    if (!parent) return;
    const dealId = colText(parent, DEALS.idCol);
    if (!dealId) return;                                   // deal not linked to HubSpot yet; a later sync carries it
    await reverseLineItems(env, sub, parent, dealId, opts, budget);
    return;
  }

  // --- Rename (no columnId) -> patch HubSpot line-item `name` (omit-empty + echo; guarded no-op otherwise) ---
  const item = await getItem(env, subitemId);
  if (!item) return;
  const liId = colText(item, sub.idCol);
  if (!liId) return;                                       // no id -> the create path owns the name
  const newName = (item.name ?? "").trim();
  if (!newName) return;                                    // omit-empty
  const cur = await getRecord(env, "line_items", liId, ["name"]);
  if (cur && (String(cur.properties.name ?? "")).trim() === newName) return; // echo
  const nameAuth = await lineItemWriteAuth(env, liId);
  if (nameAuth && !nameAuth.auth.allowed) {
    console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId}`
      + ` action=refused-name reason="${nameAuth.auth.reason}"`);
    return;
  }
  await patchLineItem(env, liId, { name: newName }, opts, nameAuth?.spec, nameAuth?.auth); budget.left--;
  console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId} action=patched-name`);
}
