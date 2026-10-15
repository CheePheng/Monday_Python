import type { Assoc } from "./assoc";

/** Append fetched associated companies to the current staged list, deduped by hubspotId. Never removes,
 * so a company the user deleted stays gone. Returns the same array reference when nothing is added. */
export function mergeAssociatedCompanies(current: Assoc[], fetched: { hubspotId: string; name: string }[]): Assoc[] {
  const have = new Set(current.map(a => a.hubspotId).filter(Boolean));
  const additions: Assoc[] = fetched
    .filter(f => f.hubspotId && !have.has(f.hubspotId))
    .map(f => ({ hubspotId: f.hubspotId, label: f.name || f.hubspotId }));
  return additions.length ? [...current, ...additions] : current;
}
