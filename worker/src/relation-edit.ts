/**
 * RELATION EDITS IN FLIGHT: what has been added to and removed from a relation cell, per item + column +
 * ACTOR CLASS, since the reverse pass last consumed it.
 *
 * WHY THIS EXISTS (G3, 2026-09-28). A HubSpot event for the same record can run the forward pass in the
 * gap between a person's click and the reverse pass pushing it. The forward pass rewrites the relation
 * cell from HubSpot's set -- which does not have the new link yet -- so the card leaves the cell again,
 * and the old reverse pass, which decided what to push by READING THE CELL, then found nothing to push.
 * The person's link was lost without a trace.
 *
 * TWO WAYS TO CLOSE IT were on the table:
 *   (a) push the add from the webhook's own before/after instead of re-reading the cell, serialise the
 *       edits per item + column, and re-check just before writing; or
 *   (b) a ~120 s "pending add" window in syncRelationColumn that keeps just-added cards.
 * (a) is what is built. (b) would have to be SHARED STATE: the forward pass runs in the HubSpot webhook's
 * request, usually a different isolate from the monday webhook that knows about the add, so a per-isolate
 * window protects nothing, and a durable one is a Durable Object round-trip on every forward relation
 * write. It would also freeze a genuine HubSpot-side removal for two minutes, and pick an arbitrary
 * number that is either too short for a slow queue or too long for a rep watching the cell. (a) needs no
 * shared state for the race itself -- the add never depended on the cell -- and what state it does keep
 * is only needed to ORDER the edits on one cell.
 *
 * KEYED BY ACTOR *CLASS*, NOT BY USER. Every person shares one queue per cell, so a late add by one rep
 * cannot re-create a link another rep removed a moment later: the removal is composed into the same
 * pending edit, or seen by the re-check before the PUT. Our own token is a class of its own on purpose:
 * its writes (the forward pass, a snap-back) fire relation events too, and they remove exactly the card
 * a person just added -- composed into the persons' queue, that removal would cancel the add. Under their
 * own key they are drained by their own run, which is self-origin and pushes nothing. Automations are a
 * third class for the same reason (they never push either). Because the reverse pass only ever runs for
 * the "person" class, it needs no user id to find its key -- so the re-check cannot silently vanish for a
 * caller that forgot to pass one.
 *
 * WHAT THIS DOES NOT GUARANTEE. The store is PER ISOLATE, like coalesce/coalesceLatest in webhooks.ts.
 * Two events for one cell that land in two isolates are not ordered against each other at all: if an add
 * and the later removal of the same card run in different isolates, the removal's DELETE can execute
 * before the add's PUT, and the link ends up re-created in HubSpot (and then shown again by the
 * associationChange forward pass). Each event is still pushed only from its own diff, and the unlink
 * still needs its own card read to agree, but nothing orders the two. Closing that needs a Durable
 * Object per item + column; it is accepted as a narrow window (two opposite clicks on one card within
 * the same second or two, split across isolates) rather than paid for on every relation edit.
 */

export interface RelationDiff { added: string[]; removed: string[] }
/** The net edit since the last drain. `known` is false when any event lacked a usable before-value.
 *  `largestAdd` / `largestRemove` are the sizes of the biggest SINGLE event composed into it: the
 *  per-edit caps judge one click, not six quick one-card clicks that queued behind a running pass. */
export interface NetRelationEdit {
  added: string[]; removed: string[]; known: boolean; largestAdd: number; largestRemove: number;
}

/** Who caused a relation event, as coarsely as the ordering needs. See the header. */
export type ActorClass = "person" | "integration" | "automation";

interface Pending { added: Set<string>; removed: Set<string>; known: boolean; largestAdd: number; largestRemove: number }
const pending = new Map<string, Pending>();

export const relationEditKey = (itemId: string, col: string, cls: ActorClass): string =>
  `${itemId}:${col}:${cls}`;

/**
 * Fold one event into the pending edit, IN ARRIVAL ORDER. The composition is set arithmetic on the
 * cell's before-state: removing a card just added cancels the add (the cell is back where it started)
 * rather than becoming an unlink, and re-adding a card just removed cancels the removal. So
 * add-then-remove is NOTHING -- never a late add that re-creates a link a person removed.
 * `null` means the event carried no usable before-value.
 */
export function recordRelationEvent(key: string, diff: RelationDiff | null): void {
  const acc = pending.get(key)
    ?? { added: new Set<string>(), removed: new Set<string>(), known: true, largestAdd: 0, largestRemove: 0 };
  if (!diff) acc.known = false;
  else {
    acc.largestAdd = Math.max(acc.largestAdd, diff.added.length);
    acc.largestRemove = Math.max(acc.largestRemove, diff.removed.length);
    for (const c of diff.removed) { if (acc.added.has(c)) acc.added.delete(c); else acc.removed.add(c); }
    for (const c of diff.added) { if (acc.removed.has(c)) acc.removed.delete(c); else acc.added.add(c); }
  }
  pending.set(key, acc);
}

/** Take everything pending for this key. Nothing pending is KNOWN-empty: a coalesced re-run with no
 *  new event since the last drain changed nothing, which is not the same as "cannot tell". */
export function drainRelationEvents(key: string): NetRelationEdit {
  const acc = pending.get(key);
  pending.delete(key);
  return { added: [...(acc?.added ?? [])], removed: [...(acc?.removed ?? [])], known: acc ? acc.known : true,
    largestAdd: acc?.largestAdd ?? 0, largestRemove: acc?.largestRemove ?? 0 };
}

/** THE RE-CHECK BEFORE A PUT: has `cardId` been removed from this cell since the running pass drained
 *  its edits? If so the add is stale, and the queued run behind this one will carry the removal. */
export function removedSince(key: string, cardId: string): boolean {
  return !!pending.get(key)?.removed.has(cardId);
}

// ------------------------------------------------------------------------------ paired cells

/**
 * ONE CLICK, TWO EVENTS: THE PAIRED SIDE IS NOT A SECOND DECISION.
 *
 * board_relation columns are paired (Contacts contact_account <-> Accounts account_contact, Deals
 * board_relation_mm76btmt <-> P&S board_relation_mm76w9y5). When monday reports a link change on BOTH
 * cards, attributed to the same person, judging the two sides independently goes wrong in both
 * directions: a click refused on a Contact CRM does not own would be authorised again on the Company and
 * written anyway (the refusal bypassed, and the Company claimed with a person's basis on a record they
 * never edited), and a refused far side would snap its cell back and, through the pairing, undo the
 * allowed side's edit -- or race it into HubSpot and monday disagreeing.
 *
 * So the FIRST event of a pair to arrive owns it, and the paired side drops that card from its diff:
 * no push, no claim, no snap-back. The owner writes or refuses, and heals its own cell on a refusal,
 * which the pairing mirrors onto the other card. Which of the two events is the actual click cannot be
 * read off the payload, so first-to-arrive stands in for "the initiating record" that putAssociation's
 * ownership rule is about. UNVERIFIED, and to be confirmed from a live payload before go-live: that
 * monday sends the paired event at all, and that the clicked card's event comes first. If it sends none,
 * this is inert; if the order is reversed, the pair is judged on the far record -- still one consistent
 * decision, never two.
 *
 * Keyed by the two monday card ids (sorted), the direction, and the person: the paired echo of one
 * click carries the same person, while another rep's click on the same pair is their own decision. An
 * echo is CONSUMED when seen, so a later genuine click on the other card is not swallowed. The window
 * is short because an echo follows its click within seconds; a monday that never sends the paired event
 * leaves only a tombstone that expires. Per isolate, like everything else here: two sides landing in two
 * isolates are each judged on their own, exactly as before this existed.
 */
const PAIR_ECHO_MS = 60_000;
const pairSeen = new Map<string, { from: string; at: number }>();

export function isPairedEcho(op: "link" | "unlink", itemId: string, cardId: string, actor: string,
    now = Date.now()): boolean {
  if (pairSeen.size > 5000)
    for (const [k, v] of pairSeen) if (now - v.at >= PAIR_ECHO_MS) pairSeen.delete(k);
  const key = `${op}|${[itemId, cardId].sort().join("|")}|${actor}`;
  const seen = pairSeen.get(key);
  if (seen && seen.from !== itemId && now - seen.at < PAIR_ECHO_MS) {
    pairSeen.delete(key);
    return true;
  }
  pairSeen.set(key, { from: itemId, at: now });
  return false;
}

/** Test-only: forget every tombstone, so one test's pairs cannot leak into the next. */
export function resetPairedEchoes(): void { pairSeen.clear(); }
