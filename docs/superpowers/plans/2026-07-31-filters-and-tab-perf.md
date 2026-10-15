# Tab Filters + Fast Tab Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HubSpot-style filters to both tabs (Companies: owner + create date + last activity, server-side; Deals: create date, client-side) and stop the Deals view from fully reloading on every tab switch.

**Architecture:** One pure date-range engine (`lib/date-range.ts`) produces epoch-ms ranges that feed both HubSpot search filters (Companies) and a client-side row filter (Deals). Companies filtering extends `companySearchBody` with an AND'd filter group + a new `/app/owners` endpoint. The tab-switch perf fix lifts `useBoard()` from `BoardView` to `App` so the deals data survives route changes.

**Tech Stack:** React 18 + TS + Vite + vitest; Cloudflare Worker (TS) + vitest; HubSpot CRM search.

**Spec:** `docs/superpowers/specs/2026-07-31-filters-and-tab-perf-design.md`

**Toolchain (must follow):**
- Worker typecheck: `./node_modules/.bin/tsc --noEmit` from `worker/` — never `npx tsc`.
- Worker tests: `./node_modules/.bin/vitest run` from `worker/`.
- App: `npm test` / `npm run build` from `monday-app/`. `noUnusedLocals` is ON.
- Commit code from the repo root. Do NOT commit `docs/`. Do NOT deploy/push (Task 10 handles the worker deploy).

---

## File structure

**App**
- `monday-app/src/lib/date-range.ts` (+ `.test.ts`) — preset → `{gte,lte}` ms engine.
- `monday-app/src/lib/filter.ts` (+ `.test.ts`) — `createdRange` on `DealFilter`/`filterDeals`.
- `monday-app/src/views/DateRangeFilter.tsx` — reusable date dropdown (+ custom range).
- `monday-app/src/worker-client.ts` — `listCompanies` filter args + `getOwners`.
- `monday-app/src/App.tsx` — lift `useBoard()`, pass `board` to `BoardView`.
- `monday-app/src/views/BoardView.tsx` — take `board` prop; add the Create-date filter.
- `monday-app/src/views/CompaniesView.tsx` — owner + create + last-activity filters.
- `monday-app/src/styles.css` — date-filter custom-range styles.

**Worker**
- `worker/src/hubspot.ts` — `companySearchBody` filters + `mapOwners`; widen `listCompanies` args.
- `worker/src/index.ts` — `/app/companies` filter params; add `GET /app/owners`.
- `worker/test/companies.test.ts` — filter-group + owners tests (append).

---

## Task 1: Date-range engine (`lib/date-range.ts`)

**Files:**
- Create: `monday-app/src/lib/date-range.ts`
- Test: `monday-app/src/lib/date-range.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `monday-app/src/lib/date-range.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run (from `monday-app/`): `npm test -- date-range`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/date-range.ts`**

Create `monday-app/src/lib/date-range.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run (from `monday-app/`): `npm test -- date-range`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/date-range.ts monday-app/src/lib/date-range.test.ts
git commit -m "feat(app): date-range preset engine for filters"
```

---

## Task 2: Deals client-side create-date filter (`lib/filter.ts`)

**Files:**
- Modify: `monday-app/src/lib/filter.ts`
- Test: `monday-app/src/lib/filter.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `monday-app/src/lib/filter.test.ts` (create it if absent with the import):

```ts
import { describe, it, expect } from "vitest";
import { filterDeals, type DealRow } from "./filter";

const row = (id: string, createdAt?: string): DealRow =>
  ({ id, name: "D" + id, stage: "New", salesUserIds: [], createdAt });

describe("filterDeals createdRange", () => {
  const rows = [row("1", "2026-07-10T00:00:00Z"), row("2", "2026-07-20T00:00:00Z"), row("3", undefined)];
  const ms = (s: string) => Date.parse(s);
  it("keeps rows whose createdAt is within [gte,lte]", () => {
    const out = filterDeals(rows, { createdRange: { gte: ms("2026-07-15T00:00:00Z"), lte: ms("2026-07-25T00:00:00Z") } });
    expect(out.map(r => r.id)).toEqual(["2"]);
  });
  it("gte-only / lte-only are open-ended on the missing side", () => {
    expect(filterDeals(rows, { createdRange: { gte: ms("2026-07-15T00:00:00Z") } }).map(r => r.id)).toEqual(["2"]);
    expect(filterDeals(rows, { createdRange: { lte: ms("2026-07-15T00:00:00Z") } }).map(r => r.id)).toEqual(["1"]);
  });
  it("excludes rows with missing/invalid createdAt when a range is active", () =>
    expect(filterDeals(rows, { createdRange: { gte: 0 } }).map(r => r.id)).toEqual(["1", "2"]));
  it("no createdRange leaves rows untouched (all 3)", () =>
    expect(filterDeals(rows, {}).length).toBe(3));
  it("composes with other filters (AND)", () =>
    expect(filterDeals(rows, { q: "D2", createdRange: { gte: ms("2026-07-15T00:00:00Z") } }).map(r => r.id)).toEqual(["2"]));
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `monday-app/`): `npm test -- filter`
Expected: FAIL — `createdRange` not on `DealFilter`.

- [ ] **Step 3: Implement**

In `monday-app/src/lib/filter.ts`, add the import + field + filter logic. Change the top:

```ts
import type { DateRange } from "./date-range";

export interface DealRow {
  id: string; name: string; stage: string; groupId?: string; salesUserIds: string[];
  amount?: string; currency?: string; closeDate?: string; company?: string; contact?: string;
  hubspotId?: string; createdAt?: string;
}
export interface DealFilter { q?: string; stage?: string; mine?: boolean; myUserId?: string; salesUserId?: string; createdRange?: DateRange }
```

And inside `filterDeals`, before `return true;`, add:

```ts
    if (f.createdRange) {
      const t = Date.parse(r.createdAt ?? "");
      if (!Number.isFinite(t)) return false;                       // no/invalid date -> excluded when filtering
      if (f.createdRange.gte != null && t < f.createdRange.gte) return false;
      if (f.createdRange.lte != null && t > f.createdRange.lte) return false;
    }
```

- [ ] **Step 4: Run to verify it passes**

Run (from `monday-app/`): `npm test -- filter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/filter.ts monday-app/src/lib/filter.test.ts
git commit -m "feat(app): createdRange filter on filterDeals"
```

---

## Task 3: Worker company filters + owners mapper (`hubspot.ts`)

**Files:**
- Modify: `worker/src/hubspot.ts`
- Test: `worker/test/companies.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/companies.test.ts`:

```ts
import { mapOwners } from "../src/hubspot";

describe("companySearchBody filters", () => {
  it("owner + created + activity all go in ONE and'd filter group", () => {
    const b = companySearchBody({ ownerId: "77", created: { gte: 100, lte: 200 }, activity: { gte: 300 } }) as any;
    expect(b.filterGroups).toHaveLength(1);
    expect(b.filterGroups[0].filters).toEqual([
      { propertyName: "hubspot_owner_id", operator: "EQ", value: "77" },
      { propertyName: "createdate", operator: "GTE", value: 100 },
      { propertyName: "createdate", operator: "LTE", value: 200 },
      { propertyName: "notes_last_updated", operator: "GTE", value: 300 },
    ]);
    expect(b.query).toBeUndefined();
  });
  it("query + filters keeps BOTH query and filterGroups", () => {
    const b = companySearchBody({ q: "acme", ownerId: "77" }) as any;
    expect(b.query).toBe("acme");
    expect(b.filterGroups[0].filters).toEqual([{ propertyName: "hubspot_owner_id", operator: "EQ", value: "77" }]);
  });
  it("no query, no filters -> createdate HAS_PROPERTY default", () => {
    const b = companySearchBody({}) as any;
    expect(b.filterGroups).toEqual([{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }]);
    expect(b.query).toBeUndefined();
  });
  it("query only -> query, no filterGroups", () => {
    const b = companySearchBody({ q: "acme" }) as any;
    expect(b.query).toBe("acme");
    expect(b.filterGroups).toBeUndefined();
  });
});

describe("mapOwners", () => {
  it("maps ownersById -> sorted [{id,name}], skipping blank names", () => {
    expect(mapOwners({ "3": { name: "Zoe", email: null }, "1": { name: "Ann", email: null }, "2": { name: "", email: null } }))
      .toEqual([{ id: "1", name: "Ann" }, { id: "3", name: "Zoe" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: FAIL — new filter behavior + `mapOwners` missing.

- [ ] **Step 3: Implement**

In `worker/src/hubspot.ts`, replace the existing `companySearchBody` with the filter-aware version and add `mapOwners` after it:

```ts
export interface CompanyFilters {
  ownerId?: string;
  created?: { gte?: number; lte?: number };
  activity?: { gte?: number; lte?: number };
}

/** Build the HubSpot company search body. Pure/testable. Newest-created first. Owner/date filters go in a
 * single AND'd filter group; a full-text query (when present) is sent alongside and ANDs with it. */
export function companySearchBody(args: { q?: string; after?: string; limit?: number } & CompanyFilters): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: COMPANY_LIST_PROPS,
    limit,
  };
  const filters: Record<string, unknown>[] = [];
  if (args.ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: args.ownerId });
  if (args.created?.gte != null) filters.push({ propertyName: "createdate", operator: "GTE", value: args.created.gte });
  if (args.created?.lte != null) filters.push({ propertyName: "createdate", operator: "LTE", value: args.created.lte });
  if (args.activity?.gte != null) filters.push({ propertyName: "notes_last_updated", operator: "GTE", value: args.activity.gte });
  if (args.activity?.lte != null) filters.push({ propertyName: "notes_last_updated", operator: "LTE", value: args.activity.lte });
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  if (filters.length) body.filterGroups = [{ filters }];
  else if (!query) body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** HubSpot owners -> sorted [{id,name}] for the Company-owner filter dropdown. Pure/testable. */
export function mapOwners(ownersById: Record<string, { name: string; email: string | null }>): { id: string; name: string }[] {
  return Object.entries(ownersById)
    .filter(([, o]) => o.name?.trim())
    .map(([id, o]) => ({ id, name: o.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

Then widen `listCompanies`'s `args` type so it forwards the filters (its body is unchanged — it already spreads `args` into `companySearchBody`):

```ts
export async function listCompanies(
  env: Env,
  args: { q?: string; after?: string; limit?: number } & CompanyFilters,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Promise<{ items: CompanyHit[]; after: string | null }> {
```

(The function body stays exactly as it is.)

- [ ] **Step 4: Run to verify it passes**

Run (from `worker/`): `./node_modules/.bin/vitest run companies`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run (from `worker/`): `./node_modules/.bin/tsc --noEmit` → clean.

```bash
git add worker/src/hubspot.ts worker/test/companies.test.ts
git commit -m "feat(worker): company owner/date search filters + mapOwners"
```

---

## Task 4: Worker `/app/companies` filter params + `GET /app/owners`

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Parse the new `/app/companies` params**

In `worker/src/index.ts`, ensure `mapOwners` is added to the `./hubspot` import (alongside `listCompanies`). In the `GET /app/companies` handler, replace the body-building lines with param parsing that forwards the filters:

```ts
      if (url.pathname === "/app/companies" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const after = url.searchParams.get("after") || undefined;
        const limit = Number(url.searchParams.get("limit") ?? "25");
        const numP = (k: string) => { const v = Number(url.searchParams.get(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
        const ownerId = url.searchParams.get("ownerId") || undefined;
        const created = { gte: numP("createdGte"), lte: numP("createdLte") };
        const activity = { gte: numP("activityGte"), lte: numP("activityLte") };
        const H = { ...CORS, "Cache-Control": "no-store" };
        try {
          const ctx = await getCtxCached(env);
          const { items, after: next } = await listCompanies(
            env, { q, after, limit: Number.isFinite(limit) ? limit : 25, ownerId, created, activity },
            ctx.ownersById, ctx.labels);
          return Response.json({ results: items, after: next }, { headers: H });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/companies] error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], after: null, error: scope ? "scope" : "companies-failed" }, { headers: H });
        }
      }
```

- [ ] **Step 2: Add the `GET /app/owners` route**

Immediately after the `/app/companies` handler block, insert:

```ts
      // GET /app/owners — HubSpot owners for the Company-owner filter dropdown.
      if (url.pathname === "/app/owners" && req.method === "GET") {
        const H = { ...CORS, "Cache-Control": "no-store" };
        try {
          const ctx = await getCtxCached(env);
          return Response.json({ owners: mapOwners(ctx.ownersById) }, { headers: H });
        } catch (e) {
          console.log(`[app/owners] error="${String(e).slice(0, 140)}"`);
          return Response.json({ owners: [] }, { headers: H });
        }
      }
```

- [ ] **Step 3: Typecheck + full worker tests + commit**

Run (from `worker/`): `./node_modules/.bin/tsc --noEmit` → clean. `./node_modules/.bin/vitest run` → all pass.

```bash
git add worker/src/index.ts
git commit -m "feat(worker): /app/companies filter params + GET /app/owners"
```

---

## Task 5: App worker-client — filter args + `getOwners`

**Files:**
- Modify: `monday-app/src/worker-client.ts`

- [ ] **Step 1: Extend `listCompanies` + add `getOwners`**

In `monday-app/src/worker-client.ts`, add the import at the top:

```ts
import type { DateRange } from "./lib/date-range";
```

Replace the existing `listCompanies` with the filter-aware version and add `getOwners` after it:

```ts
export async function listCompanies(token: string, args: {
  q?: string; after?: string; limit?: number;
  ownerId?: string; created?: DateRange; activity?: DateRange;
}): Promise<{ items: Company[]; after: string | null; error?: string }> {
  const p = new URLSearchParams();
  if (args.q?.trim()) p.set("q", args.q.trim());
  if (args.after) p.set("after", args.after);
  p.set("limit", String(args.limit ?? 25));
  if (args.ownerId) p.set("ownerId", args.ownerId);
  if (args.created?.gte != null) p.set("createdGte", String(args.created.gte));
  if (args.created?.lte != null) p.set("createdLte", String(args.created.lte));
  if (args.activity?.gte != null) p.set("activityGte", String(args.activity.gte));
  if (args.activity?.lte != null) p.set("activityLte", String(args.activity.lte));
  const res = await call(token, "GET", `/app/companies?${p.toString()}`);
  return { items: res.results ?? [], after: res.after ?? null, error: res.error };
}

// Owners change ~never; memoize for the page session (a failed/empty fetch is not cached).
let ownersCache: { id: string; name: string }[] | null = null;
export async function getOwners(token: string): Promise<{ id: string; name: string }[]> {
  if (ownersCache) return ownersCache;
  const res = await call(token, "GET", "/app/owners");
  const owners: { id: string; name: string }[] = res?.owners ?? [];
  if (owners.length) ownersCache = owners;
  return owners;
}
```

- [ ] **Step 2: Typecheck + build + commit**

Run (from `monday-app/`): `npm run build` → passes.

```bash
git add monday-app/src/worker-client.ts
git commit -m "feat(app): worker-client company filter args + getOwners"
```

---

## Task 6: Reusable `DateRangeFilter` control

**Files:**
- Create: `monday-app/src/views/DateRangeFilter.tsx`

- [ ] **Step 1: Create the component**

Create `monday-app/src/views/DateRangeFilter.tsx`:

```tsx
import { DATE_PRESETS, type DatePreset } from "../lib/date-range";

export interface DateFilterValue { preset: DatePreset | ""; custom?: { from?: string; to?: string } }

/** A `dc-select`-styled date-range dropdown ("<label>: all time" cleared + presets). Selecting "Custom
 * range" reveals two date inputs. Pure control — all range math lives in lib/date-range. */
export default function DateRangeFilter({ label, value, onChange }: {
  label: string; value: DateFilterValue; onChange: (v: DateFilterValue) => void;
}) {
  return (
    <div className="dc-datefilter">
      <select className="dc-select" value={value.preset}
        onChange={e => {
          const preset = e.target.value as DatePreset | "";
          onChange({ preset, custom: preset === "custom" ? (value.custom ?? {}) : undefined });
        }}>
        <option value="">{label}: all time</option>
        {DATE_PRESETS.map(p => <option key={p.value} value={p.value}>{label}: {p.label}</option>)}
      </select>
      {value.preset === "custom" && (
        <span className="dc-daterange-custom">
          <input type="date" className="dc-input" value={value.custom?.from ?? ""}
            onChange={e => onChange({ preset: "custom", custom: { ...value.custom, from: e.target.value } })} />
          <span className="dc-mut">→</span>
          <input type="date" className="dc-input" value={value.custom?.to ?? ""}
            onChange={e => onChange({ preset: "custom", custom: { ...value.custom, to: e.target.value } })} />
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build + commit**

Run (from `monday-app/`): `npm run build` → passes (unused until wired in Tasks 8–9; builds fine).

```bash
git add monday-app/src/views/DateRangeFilter.tsx
git commit -m "feat(app): reusable DateRangeFilter control"
```

---

## Task 7: Fast tab switching — lift `useBoard` to `App`

**Files:**
- Modify: `monday-app/src/App.tsx`
- Modify: `monday-app/src/views/BoardView.tsx`

- [ ] **Step 1: Lift `useBoard` into `App`**

In `monday-app/src/App.tsx`, add the import and call `useBoard()`, passing it to `BoardView`:

```tsx
import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import mondaySdk from "monday-sdk-js";
import BoardView from "./views/BoardView";
import CompaniesView from "./views/CompaniesView";
import { ConfirmProvider } from "./confirm";
import { useBoard } from "./useBoard";

const monday = mondaySdk();

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const board = useBoard();   // lifted here so the deals data survives tab switches (App never unmounts)

  useEffect(() => {
    const apply = (t?: string) => setTheme(t === "dark" || t === "black" ? "dark" : "light");
    monday.get("context").then((res: any) => apply(res?.data?.theme));
    monday.listen("context", (res: any) => apply(res?.data?.theme));
  }, []);

  return (
    <div className="dc-root" data-theme={theme}>
      <ConfirmProvider>
        <BrowserRouter>
          <nav className="dc-topnav">
            <NavLink to="/board" className={({ isActive }) => "dc-topnav-tab" + (isActive ? " on" : "")}>Deals</NavLink>
            <NavLink to="/companies" className={({ isActive }) => "dc-topnav-tab" + (isActive ? " on" : "")}>Companies</NavLink>
          </nav>
          <Routes>
            <Route path="/board" element={<BoardView board={board} />} />
            <Route path="/companies" element={<CompaniesView />} />
            <Route path="*" element={<Navigate to="/board" replace />} />
          </Routes>
        </BrowserRouter>
      </ConfirmProvider>
    </div>
  );
}
```

- [ ] **Step 2: Make `BoardView` take `board` as a prop**

In `monday-app/src/views/BoardView.tsx`:

Change the `useBoard` import (line ~2) to a type import:

```ts
import type { BoardState } from "../useBoard";
```

Change the component signature (line ~76) and delete the internal `useBoard()` call (line ~77):

```ts
export default function BoardView({ board }: { board: BoardState }) {
  // Deliberately shadows the global window.confirm — a leftover native call would now fail to type-check.
  const confirm = useConfirm();
```

(Everything else in `BoardView` already reads the `board` local, so no other changes are needed here.)

- [ ] **Step 3: Typecheck + build + commit**

Run (from `monday-app/`): `npm run build` → passes.

**Manual check:** the Deals tab loads once; switching to Companies and back is instant (no skeleton, no refetch). (Note: `BoardView`'s local filter/sort/open-drawer state resets on tab switch — that's expected with route-swapped views; the heavy *data* is what persists.)

```bash
git add monday-app/src/App.tsx monday-app/src/views/BoardView.tsx
git commit -m "perf(app): lift useBoard to App so Deals persists across tab switches"
```

---

## Task 8: Deals Create-date filter (wire into `BoardView`)

**Files:**
- Modify: `monday-app/src/views/BoardView.tsx`

- [ ] **Step 1: Add the filter state + control**

In `monday-app/src/views/BoardView.tsx`, add imports:

```ts
import DateRangeFilter, { type DateFilterValue } from "./DateRangeFilter";
import { dateRange } from "../lib/date-range";
```

Add filter state next to the other `useState`s (after the `view` state, ~line 90):

```ts
  const [createdFilter, setCreatedFilter] = useState<DateFilterValue>({ preset: "" });
```

Change the `rows` memo and `filtersActive` (currently ~lines 160–163) to fold in the range:

```ts
  const rows = useMemo(() => {
    const createdRange = createdFilter.preset ? dateRange(createdFilter.preset, Date.now(), createdFilter.custom) : undefined;
    return sortDeals(
      filterDeals(board.rows, { q, stage: stage || undefined, mine, myUserId: board.userId, salesUserId: salesUser || undefined, createdRange }),
      sort.key, sort.dir);
  }, [board.rows, q, stage, mine, salesUser, board.userId, sort, createdFilter]);
  const filtersActive = !!(q || stage || mine || salesUser || createdFilter.preset);
```

Add the control to the toolbar — after the sales-user `<select>` (the block ending ~line 211, right before the `My deals` button):

```tsx
        <DateRangeFilter label="Created" value={createdFilter} onChange={setCreatedFilter} />
```

- [ ] **Step 2: Typecheck + build + commit**

Run (from `monday-app/`): `npm run build` → passes.

**Manual check:** on Deals, picking "Created: This month" (etc.) filters the table; "Created: all time" clears it; custom range works.

```bash
git add monday-app/src/views/BoardView.tsx
git commit -m "feat(app): Deals Create-date filter"
```

---

## Task 9: Companies filters (owner + create + last activity)

**Files:**
- Modify: `monday-app/src/views/CompaniesView.tsx`
- Modify: `monday-app/src/styles.css`

- [ ] **Step 1: Add owner + date filters wired into `load()`**

In `monday-app/src/views/CompaniesView.tsx`, add imports:

```ts
import { listCompanies, getOwners, type Company } from "../worker-client";
import { dateRange } from "../lib/date-range";
import DateRangeFilter, { type DateFilterValue } from "./DateRangeFilter";
```

(Adjust the existing `worker-client` import to include `getOwners`.)

Add filter state + refs next to the existing state (after `const seq = useRef(0);`):

```ts
  const [owners, setOwners] = useState<{ id: string; name: string }[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [createdF, setCreatedF] = useState<DateFilterValue>({ preset: "" });
  const [activityF, setActivityF] = useState<DateFilterValue>({ preset: "" });
  // Refs so the debounced load() and "Load more" always read the latest filters (same pattern as tokenRef).
  const ownerRef = useRef(""); ownerRef.current = ownerId;
  const createdRef = useRef<DateFilterValue>({ preset: "" }); createdRef.current = createdF;
  const activityRef = useRef<DateFilterValue>({ preset: "" }); activityRef.current = activityF;
```

In `load()`, build the filter args from the refs and pass them to `listCompanies` — change the `listCompanies` call to:

```ts
      const now = Date.now();
      const created = createdRef.current.preset ? dateRange(createdRef.current.preset, now, createdRef.current.custom) : undefined;
      const activity = activityRef.current.preset ? dateRange(activityRef.current.preset, now, activityRef.current.custom) : undefined;
      const r = await listCompanies(t, { q: query, after: cursor, limit: 25, ownerId: ownerRef.current || undefined, created, activity });
```

Change the debounce effect deps so a filter change also reloads (and resets pagination, since `load(q)` with no cursor replaces):

```ts
  useEffect(() => {
    const t = setTimeout(() => { void load(q); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, ownerId, createdF, activityF]);
```

Fetch the owner list once a token is available (add after the debounce effect):

```ts
  useEffect(() => { if (token) getOwners(token).then(setOwners).catch(() => {}); }, [token]);
```

Add the three controls to the toolbar — replace the `dc-toolbar` block so it includes the filters after the search box:

```tsx
      <div className="dc-toolbar">
        <div className="dc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input className="dc-input" placeholder="Search companies by name or domain" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="dc-select" value={ownerId} onChange={e => setOwnerId(e.target.value)}>
          <option value="">All owners</option>
          {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <DateRangeFilter label="Created" value={createdF} onChange={setCreatedF} />
        <DateRangeFilter label="Last activity" value={activityF} onChange={setActivityF} />
      </div>
```

- [ ] **Step 2: Add custom-range styles**

Append to `monday-app/src/styles.css`:

```css
.dc-datefilter { display: inline-flex; align-items: center; gap: 6px; }
.dc-daterange-custom { display: inline-flex; align-items: center; gap: 6px; }
.dc-daterange-custom .dc-input { width: 140px; }
```

- [ ] **Step 3: Typecheck + build + commit**

Run (from `monday-app/`): `npm test` → all pass. `npm run build` → passes.

**Manual check:** on Companies, selecting an owner / a created range / a last-activity range narrows the list server-side; changing any filter resets to page 1; "Load more" keeps the active filters; clearing returns to the full newest-first list.

```bash
git add monday-app/src/views/CompaniesView.tsx monday-app/src/styles.css
git commit -m "feat(app): Companies owner + create-date + last-activity filters"
```

---

## Task 10: Deploy worker + end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full test + build gate**

Run (from `worker/`): `./node_modules/.bin/tsc --noEmit` && `./node_modules/.bin/vitest run` → all green.
Run (from `monday-app/`): `npm test` && `npm run build` → all green.

- [ ] **Step 2: Deploy the worker**

Run (from `worker/`): `./node_modules/.bin/wrangler deploy` → new Version ID printed.

- [ ] **Step 3: Live smoke of the new endpoints** (trigger-secret auth; a small script like `scratchpad/smoke-companies.cjs`)

- `GET /app/owners` → returns a non-empty `owners` list.
- `GET /app/companies?limit=3&ownerId=<an owner id from the list>` → results all belong to that owner.
- `GET /app/companies?limit=3&createdGte=<ms 30 days ago>` → results are within the range (createdate ≥ gte).
- `GET /app/companies?q=tech&ownerId=<id>` → **confirms `query` + `filterGroups` combine** (results match the term AND the owner). *If HubSpot errors on the combination, apply the spec's fallback: replace `query` with `name`/`domain` `CONTAINS_TOKEN` filters inside the group.*

- [ ] **Step 4: App publish (user step)**

The app frontend is published to monday via `mapps code:push --client-side -d ./dist` to the board-view app (Pipeline Builder Custom, 11691779) — a manual step requiring the app API token (the user runs it, or authorizes a re-auth). Note in the handoff.

- [ ] **Step 5: Manual verification in monday** (after the app is published + board reloaded)

1. Switch Deals ↔ Companies repeatedly — Deals returns instantly (no reload).
2. Deals: Create-date filter narrows the table; custom range works.
3. Companies: owner + created + last-activity filters narrow the list; pagination resets on filter change; Load more preserves filters.

---

## Self-review checklist (run after implementing all tasks)

- Types line up across tasks: `DateRange`/`DatePreset`/`DATE_PRESETS` (date-range), `DateFilterValue` (DateRangeFilter), `CompanyFilters` (worker), `DealFilter.createdRange`, `listCompanies` args (worker + app), `getOwners`/`mapOwners`.
- `companySearchBody`'s four cases (query+filters / query-only / filters-only / neither) all covered by tests.
- `BoardView` reads `board` from its prop everywhere (no leftover `useBoard()` call); `App` owns the single `useBoard()`.
- No read-only/calculated writes; the filters are read-only queries.
- `noUnusedLocals` satisfied (no dangling imports after the `BoardView` change).
