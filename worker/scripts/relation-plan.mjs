/**
 * THE PER-CONTACT RELATION DECISION for the historical backfill. Extracted from backfill-crm.mjs so
 * it can be tested, because inline is how it acquired three defects at once in a guard nobody could
 * exercise without running a 94,000-record pass against production.
 *
 * THIS PASS IS ADDITIVE-ONLY. IT NEVER REMOVES A LINK. That is the central design decision and it is
 * not a detail of the ceiling arithmetic — it is the reason the ceiling arithmetic is simple.
 *
 * WHY, and the argument is about evidence rather than caution. The write monday offers is
 *   change_multiple_column_values(column_values: { <relCol>: { item_ids: want } })
 * which REPLACES the relation cell rather than appending to it. So `want` is not "what to add", it is
 * "what the cell will contain", and anything absent from it is deleted. Building `want` purely from
 * HubSpot's current associations therefore deletes every link HubSpot does not presently assert — and
 * HubSpot not asserting a link is NOT evidence that the link is wrong:
 *
 *   - MEASURED 2026-09-11: 414 of the 27,952 Accounts cards carry NO HubSpot ID. `want` is built by
 *     resolving HubSpot company ids through an index keyed by that column, so a link to one of those
 *     414 can never appear in `want` — not rarely, but structurally, on every contact that holds one.
 *     HubSpot has never heard of the card and cannot have an opinion about it, so the link's absence
 *     from `want` is OUR blind spot, not evidence of a removal. Every such link is someone's own work.
 *   - A bulk pass carries no per-record user intent. The agreed project rule is that removing a
 *     relation requires positive intent; 94,000 cards reconciled in one sweep is the opposite of that.
 *   - The harms are wildly asymmetric. A retained stale link is visibly wrong and a human can fix it.
 *     A deleted manual link destroys information recorded nowhere else, 94,000 times over, silently.
 *
 * So `want` = the links the card ALREADY has, plus the HubSpot-derived links it is missing. Removal,
 * if it is ever wanted, belongs in a separate pass that can show its evidence and export what it
 * would drop — not in a seed.
 *
 * WHAT IS STILL MEASURED: `extra` reports the links not backed by any current HubSpot association.
 * Refusing to act on the divergence is not a reason to be ignorant of its size.
 *
 * THE CEILING. monday's board_relation columns are PAIRED, so every contact -> account link also
 * grows the ACCOUNT card's cell, and that cell stops accepting links at about 750 (measured: the card
 * for HubSpot company 37258070678, which has 2,007 associated contacts, took 751 attempts and settled
 * holding 750 before monday began rejecting every further write; each rejection then fell to an
 * isolate retry costing ~2 minutes). Exactly TWO cards are at or above 740 as of 2026-09-11:
 * 2855677250 with 750 links and 2855584566 with 745 — both of which the FIRST relations run drove
 * there, because its cap looked only at the count at pass start, when both held zero.
 * So additions are refused at a ceiling, on the PROJECTED cell size, with two rules:
 *
 *   RULE 1 — THE UP-FRONT BOARD READ ALREADY COUNTS EVERY EXISTING LINK, so an already-linked
 *     association must not be charged again. Charging it double-counts, and the measured consequence
 *     is sharp: an account holding 600 links, scanned across its own already-linked contacts, is
 *     refused from contact #141 onward (600 + 140 = 740). It does not run away to 1,200 — the guard
 *     refuses before it increments, so the projection plateaus exactly ON the ceiling and then rejects
 *     everything, which is quieter and worse. The bug punishes precisely the large accounts the
 *     ceiling was raised from 200 to 740 to rescue.
 *
 *   RULE 2 — RETENTION IS NOT AN ADDITION. An existing link is kept whatever the projected count says.
 *     The ceiling exists to stop us ADDING to a full cell; it must never remove from one.
 *
 * WHY THIS FUNCTION MUTATES `counts`: the charge happens in the same place the decision is made,
 * rather than being returned as deltas for the caller to apply — "caller forgets to apply the delta"
 * is rule 1 all over again. The mutation is confined to the branch that actually writes.
 *
 * COUNTS ARE KEYED BY MONDAY ITEM ID, not by HubSpot company id, because the thing with a limit is the
 * Accounts CARD's relation cell.
 *
 * KNOWN, ACCEPTED IMPRECISION: charging happens when a write is DECIDED, not when monday confirms it.
 * A failed write leaves the projection one too high, which can only ever skip an addition, never
 * create a wrong link — and the pass is idempotent, so a re-run reads the true counts from the board.
 */

export const WRITE = "write";
export const ALREADY_CORRECT = "alreadyCorrect";
export const CAPPED = "capped";
export const NO_ACCOUNT_CARD = "noAccountCard";

/**
 * @param {object}   a
 * @param {string[]} a.companyIds  HubSpot company ids associated with this contact
 * @param {string[]} a.linked      monday item ids currently in the contact card's relation cell
 * @param {Map<string, number>} a.counts     monday item id -> links that cell holds. MUTATED on write.
 * @param {Map<string, string[]>} a.accounts HubSpot company id -> Accounts card item ids
 * @param {number}   a.ceiling     refuse to ADD a link to a cell already holding this many
 * @returns {{want: string[], outcome: string, added: string[], capped: string[], missing: string[], extra: string[]}}
 */
export function planContactLinks({ companyIds, linked, counts, accounts, ceiling }) {
  const existing = [...new Set((linked ?? []).map(String))];
  const existingSet = new Set(existing);

  // RULE 2, expressed structurally rather than as a check: every existing link is in `want` from the
  // outset, so no later branch can drop one. `want` can only grow from here.
  const want = existing.slice();
  const wantSet = new Set(want);

  const added = [];
  const capped = [];
  const missing = [];
  const backed = new Set();       // existing links that a current HubSpot association accounts for

  // Deduplicated: HubSpot returning the same company twice would otherwise charge it twice.
  for (const cid of new Set((companyIds ?? []).map(String))) {
    const acct = (accounts.get(cid) ?? []).map(String);
    if (!acct.length) { missing.push(cid); continue; }

    /**
     * WHEN ONE COMPANY HAS SEVERAL ACCOUNTS CARDS, PREFER THE ONE THIS CONTACT IS ALREADY LINKED TO.
     *
     * Taking acct[0] blindly was defensible while the pass replaced cells — it was merely wrong — but
     * under additive-only it is worse: the card the contact already holds is retained AND acct[0] is
     * added, so the contact ends up showing two Accounts cards for one company. Whichever card lands
     * at index 0 depends on board read order, so the duplication is not even deterministic.
     *
     * Duplicates are a live possibility rather than a hypothetical: reconcile-orphan-accounts.mjs
     * adopts an orphan card by stamping it with a HubSpot ID that an import-created twin may already
     * carry, and it deliberately REFUSES to delete a twin holding relations (--delete-twins is
     * opt-in). Preferring the linked card means this pass never fights that script's decision.
     */
    const itemId = acct.find(x => existingSet.has(x)) ?? acct[0];

    if (existingSet.has(itemId)) { backed.add(itemId); continue; }   // already there, nothing to do
    if (wantSet.has(itemId)) continue;                               // two company ids, one card

    // RULE 1: only a genuinely NEW link is charged against the ceiling.
    if ((counts.get(itemId) ?? 0) >= ceiling) { capped.push(cid); continue; }
    want.push(itemId);
    wantSet.add(itemId);
    added.push(itemId);
  }

  // Reported, never acted on. See the header: these are the links HubSpot does not presently assert,
  // which for an id-less Accounts card it structurally cannot.
  const extra = existing.filter(x => !backed.has(x));

  if (!added.length) {
    if (want.length) return { want, outcome: ALREADY_CORRECT, added, capped, missing, extra };
    return { want, outcome: capped.length ? CAPPED : NO_ACCOUNT_CARD, added, capped, missing, extra };
  }

  // From here a write WILL be queued, so the projection moves — and only for the new links.
  for (const itemId of added) counts.set(itemId, (counts.get(itemId) ?? 0) + 1);

  return { want, outcome: WRITE, added, capped, missing, extra };
}
