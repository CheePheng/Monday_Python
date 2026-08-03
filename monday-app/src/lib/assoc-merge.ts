import type { Assoc } from "./assoc";

/** Merge the monday relation cards (which carry itemId) with the record's live HubSpot associations.
 * Every HubSpot record NOT already present by hubspotId is added as a staged Assoc (label + hubspotId,
 * no itemId — resolved to a card on Save by resolveAssocs). Deduped by hubspotId. Pure/testable.
 * This is what makes the drawer show ALL associations (not just the possibly-lagging monday relation). */
export function mergeAssoc(
  mondayCards: { itemId: string; hubspotId: string; label: string }[],
  hubspotRecs: { hubspotId: string; name: string }[],
): Assoc[] {
  const out: Assoc[] = mondayCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.label }));
  const seen = new Set(mondayCards.map(c => c.hubspotId).filter(Boolean));
  for (const r of hubspotRecs) {
    if (!r.hubspotId || seen.has(r.hubspotId)) continue;
    seen.add(r.hubspotId);
    out.push({ label: r.name, hubspotId: r.hubspotId });
  }
  return out;
}
