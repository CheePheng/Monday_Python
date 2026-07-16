export interface TotalInput {
  quantity?: string; unitPrice?: string; discount?: string;
  discountMode?: "amount" | "percent"; discountPct?: string;
}
const n = (v?: string) => { const x = Number(v); return isFinite(x) ? x : 0; };
export function lineTotal(li: TotalInput): number {
  const gross = n(li.quantity) * n(li.unitPrice);
  const net = li.discountMode === "percent"
    ? gross * (1 - n(li.discountPct) / 100)
    : n(li.quantity) * (n(li.unitPrice) - n(li.discount));
  return Math.max(0, net);
}
export function lineItemsTotal(items: TotalInput[]): number { return items.reduce((s, li) => s + lineTotal(li), 0); }
