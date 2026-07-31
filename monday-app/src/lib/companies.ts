import type { Assoc } from "./assoc";

/** Seed carried from the Companies tab to open a pre-linked new deal (matches CompanyDrawer's onCreateDeal). */
export interface NewDealSeed {
  company: { hubspotId: string; name: string };
  contact?: { hubspotId: string; name: string };
}

/** NewDealSeed -> DealDrawer `initialAssoc`. Each seed is a plain Assoc ({label, hubspotId}); DealDrawer's
 * resolveAssocs calls ensureCard on save — identical to picking the record in the AssociationPicker. */
export function buildDealSeed(seed: NewDealSeed): { contacts?: Assoc[]; companies?: Assoc[] } {
  const out: { contacts?: Assoc[]; companies?: Assoc[] } = {
    companies: [{ label: seed.company.name, hubspotId: seed.company.hubspotId }],
  };
  if (seed.contact) out.contacts = [{ label: seed.contact.name, hubspotId: seed.contact.hubspotId }];
  return out;
}

/** Group-format a numeric string; blank -> "—"; non-numeric -> the raw string. */
export function fmtNumber(v: string): string {
  if (!v?.trim()) return "—";
  const n = Number(v);
  return isFinite(n) ? n.toLocaleString() : v;
}

/** A value or an em dash when blank. */
export function orDash(v: string): string { return v?.trim() ? v : "—"; }

/** Short calendar date; blank/invalid -> "—". */
export function fmtCompanyDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
