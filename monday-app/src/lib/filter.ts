import type { DateRange } from "./date-range";

export interface DealRow {
  id: string; name: string; stage: string; groupId?: string; salesUserIds: string[];
  amount?: string; currency?: string; closeDate?: string; company?: string; contact?: string;
  hubspotId?: string; createdAt?: string;
}
export interface DealFilter { q?: string; stage?: string; mine?: boolean; myUserId?: string; salesUserId?: string; createdRange?: DateRange }

/** Filter deal rows for the table. All active filters must match (AND). Pure. */
export function filterDeals(rows: DealRow[], f: DealFilter): DealRow[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter(r => {
    if (q) {
      const hay = `${r.name} ${r.company ?? ""} ${r.contact ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.stage && r.stage !== f.stage) return false;
    if (f.mine && f.myUserId && !r.salesUserIds.includes(f.myUserId)) return false;
    if (f.salesUserId && !r.salesUserIds.includes(f.salesUserId)) return false;
    if (f.createdRange) {
      const t = Date.parse(r.createdAt ?? "");
      if (!Number.isFinite(t)) return false;                       // no/invalid date -> excluded when filtering
      if (f.createdRange.gte != null && t < f.createdRange.gte) return false;
      if (f.createdRange.lte != null && t > f.createdRange.lte) return false;
    }
    return true;
  });
}
