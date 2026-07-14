export interface TotalInput { quantity?: string; unitPrice?: string; discount?: string }
const n = (v?: string) => { const x = Number(v); return isFinite(x) ? x : 0; };
export function lineTotal(li: TotalInput): number { return Math.max(0, n(li.quantity) * (n(li.unitPrice) - n(li.discount))); }
export function lineItemsTotal(items: TotalInput[]): number { return items.reduce((s, li) => s + lineTotal(li), 0); }
