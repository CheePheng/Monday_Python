export type DatePreset =
  | "today" | "yesterday" | "thisWeek" | "thisWeekSoFar" | "lastWeek" | "last7"
  | "thisMonth" | "thisMonthSoFar" | "lastMonth" | "last30" | "last90" | "thisYear" | "custom";

export interface DateRange { gte?: number; lte?: number } // epoch ms; a missing bound is open-ended

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisWeek", label: "This week" },
  { value: "thisWeekSoFar", label: "This week so far" },
  { value: "lastWeek", label: "Last week" },
  { value: "last7", label: "Last 7 days" },
  { value: "thisMonth", label: "This month" },
  { value: "thisMonthSoFar", label: "This month so far" },
  { value: "lastMonth", label: "Last month" },
  { value: "last30", label: "Last 30 days" },
  { value: "last90", label: "Last 90 days" },
  { value: "thisYear", label: "This year" },
  { value: "custom", label: "Custom range" },
];

const DAY = 86400000;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfDay = (t: number) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };
// Monday-start week: JS getDay() 0=Sun..6=Sat -> days since Monday = (getDay()+6)%7.
const startOfWeek = (t: number) => { const s = startOfDay(t); return s - ((new Date(s).getDay() + 6) % 7) * DAY; };
const ymd = (y: number, m: number, d: number) => new Date(y, m, d).getTime(); // local midnight

/** Resolve a preset to an epoch-ms range. `now` is injected for testability. */
export function dateRange(preset: DatePreset, now: number, custom?: { from?: string; to?: string }): DateRange {
  const d = new Date(now);
  switch (preset) {
    case "today": return { gte: startOfDay(now), lte: endOfDay(now) };
    case "yesterday": return { gte: startOfDay(now - DAY), lte: endOfDay(now - DAY) };
    case "thisWeek": { const s = startOfWeek(now); return { gte: s, lte: s + 7 * DAY - 1 }; }
    case "thisWeekSoFar": return { gte: startOfWeek(now), lte: now };
    case "lastWeek": { const s = startOfWeek(now) - 7 * DAY; return { gte: s, lte: s + 7 * DAY - 1 }; }
    case "last7": return { gte: now - 7 * DAY, lte: now };
    case "thisMonth": return { gte: ymd(d.getFullYear(), d.getMonth(), 1), lte: endOfDay(ymd(d.getFullYear(), d.getMonth() + 1, 0)) };
    case "thisMonthSoFar": return { gte: ymd(d.getFullYear(), d.getMonth(), 1), lte: now };
    case "lastMonth": return { gte: ymd(d.getFullYear(), d.getMonth() - 1, 1), lte: endOfDay(ymd(d.getFullYear(), d.getMonth(), 0)) };
    case "last30": return { gte: now - 30 * DAY, lte: now };
    case "last90": return { gte: now - 90 * DAY, lte: now };
    case "thisYear": return { gte: ymd(d.getFullYear(), 0, 1), lte: now };
    case "custom": {
      const parse = (s: string) => { const [y, m, day] = s.split("-").map(Number); return ymd(y, m - 1, day); };
      const r: DateRange = {};
      if (custom?.from) r.gte = startOfDay(parse(custom.from));
      if (custom?.to) r.lte = endOfDay(parse(custom.to));
      return r;
    }
  }
}
