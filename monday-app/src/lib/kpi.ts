import type { DealRow } from "./filter";

export interface Kpis {
  pipeline: { currency: string; total: number }[];
  active: number;
  won: number;
  winRate: number;
}

const isWon = (s: string) => /won/i.test(s);
const isLost = (s: string) => /lost/i.test(s);

export function computeKpis(rows: DealRow[]): Kpis {
  const open = rows.filter(r => !isWon(r.stage) && !isLost(r.stage));
  const by = new Map<string, number>();
  for (const r of open) {
    const n = Number(r.amount);
    if (isFinite(n) && n) by.set(r.currency || "?", (by.get(r.currency || "?") ?? 0) + n);
  }
  const pipeline = [...by.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => b.total - a.total);
  const won = rows.filter(r => isWon(r.stage)).length;
  const lost = rows.filter(r => isLost(r.stage)).length;
  return {
    pipeline,
    active: open.length,
    won,
    winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
  };
}
