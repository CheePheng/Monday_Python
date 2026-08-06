import { phoneDigits } from "./mapping";

export interface PhoneCard { itemId: string; hubspotId: string; phone: string }

/**
 * Historical contacts whose monday card carries a phone but whose HubSpot record has none.
 *
 * The automatic per-record backfill only fires when a contact is reconciled (webhook / incremental), and
 * contacts are `skipFullReconcile` — nothing sweeps them — so existing records need this bounded migration.
 * Pure so the candidate rule is testable without touching either API.
 *
 * Safety, mirroring the reconcile path exactly:
 *  - needs a monday value (empty monday never writes),
 *  - needs an id-matched HubSpot record that was actually FOUND (never matched by name),
 *  - skips any record that already has a phone (never overwrites real data),
 *  - digit-compared, so formatting differences are not treated as "missing".
 */
export function phoneBackfillCandidates(
  cards: PhoneCard[], hubspotPhoneById: Record<string, string | null | undefined>,
): PhoneCard[] {
  const out: PhoneCard[] = [];
  for (const c of cards) {
    if (!c.hubspotId || !phoneDigits(c.phone)) continue;      // no id, or nothing to write
    if (!(c.hubspotId in hubspotPhoneById)) continue;         // record not found in HubSpot -> never guess
    if (phoneDigits(hubspotPhoneById[c.hubspotId] ?? "")) continue; // already has a phone -> never overwrite
    out.push(c);
  }
  return out;
}
