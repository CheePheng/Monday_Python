import type { DealRow } from "./filter";
export type SortKey = "name" | "stage" | "amount" | "closeDate" | "company" | "contact" | "createdAt";

const num = (v?: string) => { const n = Number(v); return isFinite(n) ? n : 0; };

/** Pure, non-mutating sort of deal rows. amount is numeric; createdAt compares as ISO timestamps (so
 * desc = newest first); the rest compare as strings. */
export function sortDeals(rows: DealRow[], key: SortKey, dir: "asc" | "desc"): DealRow[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (key === "amount") return (num(a.amount) - num(b.amount)) * sign;
    const av = String(a[key] ?? ""), bv = String(b[key] ?? "");
    return av.localeCompare(bv) * sign;
  });
}
