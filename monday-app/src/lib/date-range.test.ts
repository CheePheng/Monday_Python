import { describe, it, expect } from "vitest";
import { dateRange, DATE_PRESETS } from "./date-range";

const DAY = 86400000;
// A fixed reference instant: 2026-07-15 (a Wednesday) 12:00 local.
const NOW = new Date(2026, 6, 15, 12, 0, 0, 0).getTime();
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfDay = (t: number) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };

describe("dateRange", () => {
  it("today = start..end of NOW's day", () =>
    expect(dateRange("today", NOW)).toEqual({ gte: startOfDay(NOW), lte: endOfDay(NOW) }));
  it("yesterday = start..end of the prior day", () =>
    expect(dateRange("yesterday", NOW)).toEqual({ gte: startOfDay(NOW - DAY), lte: endOfDay(NOW - DAY) }));
  it("last7 = NOW-7d .. NOW", () =>
    expect(dateRange("last7", NOW)).toEqual({ gte: NOW - 7 * DAY, lte: NOW }));
  it("last30 / last90 / thisYear end at NOW", () => {
    expect(dateRange("last30", NOW).lte).toBe(NOW);
    expect(dateRange("last90", NOW).gte).toBe(NOW - 90 * DAY);
    expect(new Date(dateRange("thisYear", NOW).gte!).getMonth()).toBe(0); // January
    expect(dateRange("thisYear", NOW).lte).toBe(NOW);
  });
  it("thisWeek starts Monday 00:00 and spans 7 days; contains NOW", () => {
    const r = dateRange("thisWeek", NOW);
    expect(new Date(r.gte!).getDay()).toBe(1);                 // Monday
    expect(new Date(r.gte!).getHours()).toBe(0);
    expect(r.lte! - r.gte!).toBe(7 * DAY - 1);
    expect(r.gte! <= NOW && NOW <= r.lte!).toBe(true);
  });
  it("thisWeekSoFar = thisWeek.gte .. NOW (subset of thisWeek)", () => {
    const wk = dateRange("thisWeek", NOW), sf = dateRange("thisWeekSoFar", NOW);
    expect(sf.gte).toBe(wk.gte);
    expect(sf.lte).toBe(NOW);
    expect(sf.gte! >= wk.gte! && sf.lte! <= wk.lte!).toBe(true);
  });
  it("lastWeek is the 7 days before thisWeek", () => {
    const wk = dateRange("thisWeek", NOW), lw = dateRange("lastWeek", NOW);
    expect(wk.gte! - lw.gte!).toBe(7 * DAY);
    expect(new Date(lw.gte!).getDay()).toBe(1);
  });
  it("thisMonth = 1st 00:00 .. last day 23:59:59.999", () => {
    const r = dateRange("thisMonth", NOW);
    expect(new Date(r.gte!).getDate()).toBe(1);
    expect(new Date(r.lte!).getMonth()).toBe(new Date(NOW).getMonth());
    expect(new Date(r.lte! + 1).getDate()).toBe(1); // day after end = 1st of next month
  });
  it("thisMonthSoFar ends at NOW; lastMonth is the previous calendar month", () => {
    expect(dateRange("thisMonthSoFar", NOW).lte).toBe(NOW);
    const lm = dateRange("lastMonth", NOW);
    expect(new Date(lm.gte!).getMonth()).toBe(new Date(NOW).getMonth() - 1);
    expect(new Date(lm.gte!).getDate()).toBe(1);
  });
  it("custom = start-of-day(from) .. end-of-day(to); open-ended when a bound is absent", () => {
    expect(dateRange("custom", NOW, { from: "2026-07-01", to: "2026-07-10" })).toEqual({
      gte: new Date(2026, 6, 1).getTime(), lte: endOfDay(new Date(2026, 6, 10).getTime()),
    });
    expect(dateRange("custom", NOW, { from: "2026-07-01" })).toEqual({ gte: new Date(2026, 6, 1).getTime() });
    expect(dateRange("custom", NOW, {})).toEqual({});
  });
  it("DATE_PRESETS lists all presets with labels", () => {
    expect(DATE_PRESETS.map(p => p.value)).toContain("thisWeekSoFar");
    expect(DATE_PRESETS.every(p => p.label.length > 0)).toBe(true);
  });
});
