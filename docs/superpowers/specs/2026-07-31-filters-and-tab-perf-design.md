# Deal Cockpit — Tab Filters + Fast Tab Switching (design)

**Date:** 2026-07-31
**Status:** Design approved; ready for implementation plan.

## Context

The Deal Cockpit app now has two tabs (Deals, Companies). Two issues to address together:

1. **Slow tab switch.** `useBoard()` (which loads *all* deals + resolves every linked
   company/contact name — ~8–10 sequential monday calls) lives *inside* `BoardView`. React
   Router unmounts `BoardView` when the user is on `/companies`, so returning to Deals re-runs
   the entire load. Companies feels fast because it is server-side and paged.
2. **No filters.** Both tabs need HubSpot-style filtering. Companies must filter **server-side**
   (25k rows can't be filtered in the browser); Deals filter **client-side** (all rows loaded).

## Goal

- **Fast tab switching:** the Deals view keeps its loaded data across tab switches (instant after
  the first load).
- **Companies filters:** Company owner, Create date (range presets + custom), Last activity date
  (range presets + custom) — applied server-side via the `/app/companies` HubSpot search.
- **Deals filter:** a Create date filter (range presets + custom) applied client-side to the
  already-loaded rows, alongside the existing Stage / Sales user / My deals.

## Non-goals (v1)

- No Companies filters beyond owner / create date / last activity (no industry/type/lead-status).
- No Close-date filter on Deals (only Create date).
- No saved/named filter views; no multi-select on a single filter (one owner, one date range).
- No preserving Companies-view state across tab switches (Companies is cheap to re-fetch; only
  the heavy Deals view is persisted).

## Part 1 — Fast tab switching (lift `useBoard` to `App`)

Move `const board = useBoard()` from `BoardView` up to `App`, and pass `board` as a prop to
`BoardView`. `App` never unmounts on a route change, so the deals + resolved names persist across
tab switches; Deals loads once (its default landing tab) and is instant thereafter.

- `App.tsx`: call `useBoard()`, render `<BoardView board={board} />`. `CompaniesView` is unchanged
  (it has no `useBoard`).
- `BoardView.tsx`: `Props { board: BoardState }`; delete the internal `const board = useBoard()`.
  Everything else (drawers, `setAutoRefreshPaused`, `finishSave`, KPIs, filters) is unchanged —
  it already consumes `board` as a local, so only its source changes.
- Behavior preserved: the visibility-change auto-refresh and the drawer's refresh-pause still work
  (they're methods on the `board` object, now created one level up).

## Part 2 — Shared date-range engine (`lib/date-range.ts`)

A pure, unit-tested module both tabs use.

```ts
export type DatePreset =
  | "today" | "yesterday" | "thisWeek" | "thisWeekSoFar" | "lastWeek" | "last7"
  | "thisMonth" | "thisMonthSoFar" | "lastMonth" | "last30" | "last90" | "thisYear" | "custom";

export interface DateRange { gte?: number; lte?: number } // epoch ms; open-ended if a bound is absent

/** Resolve a preset to an epoch-ms range. `now` is injected for testability. For "custom", pass
 * `custom = { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }` (start-of-day gte, end-of-day lte). */
export function dateRange(preset: DatePreset, now: number, custom?: { from?: string; to?: string }): DateRange;

export const DATE_PRESETS: { value: DatePreset; label: string }[]; // for the dropdown, in display order
```

- Presets (weeks start **Monday**; documented, trivially flippable): today, yesterday, thisWeek
  (Mon 00:00 → Sun 23:59:59.999), thisWeekSoFar (Mon → now), lastWeek, last7 (now−7d → now),
  thisMonth (1st → end of month), thisMonthSoFar (1st → now), lastMonth, last30, last90, thisYear
  (Jan 1 → now), custom.
- The **same ms `DateRange`** feeds HubSpot filters (create/activity are epoch ms) and the Deals
  client filter (`Date.parse(row.createdAt)`), so there is one range implementation.
- Note: for always-past fields (created/activity), "thisWeek" and "thisWeekSoFar" yield identical
  results; both are kept for parity with HubSpot's list. This is intentional, not a bug.

## Part 3 — Companies filters (server-side)

### Worker

`companySearchBody(args)` gains optional filter inputs and builds **one AND'd filter group**:

- `args` adds: `ownerId?: string`, `created?: DateRange`, `activity?: DateRange`.
- Filters (all in a single `filterGroups[0].filters`, which AND together):
  - owner → `{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }`
  - created gte/lte → `{ propertyName: "createdate", operator: "GTE"/"LTE", value: <ms> }` (one per bound present)
  - activity gte/lte → `{ propertyName: "notes_last_updated", operator: "GTE"/"LTE", value: <ms> }`
    (HubSpot's **Last Activity Date** for companies is `notes_last_updated`)
- Query/filter combination (the four cases):
  - **query + filters:** send both `query` and `filterGroups` (HubSpot ANDs the full-text query
    with the property filters). *Verify empirically during implementation with a live smoke; if
    HubSpot rejects the combination, fall back to a `name CONTAINS_TOKEN`/`domain CONTAINS_TOKEN`
    OR-pair inside the filter group instead of `query`.*
  - **query, no filters:** `query` only (unchanged).
  - **no query, filters:** `filterGroups` only.
  - **no query, no filters:** the existing `createdate HAS_PROPERTY` default (unchanged).
- Filtering on `notes_last_updated` needs **no change to `COMPANY_LIST_PROPS`** — a HubSpot search
  filter operates on the property directly and does not require it in the fetched `properties`.
  Last activity is filter-only in v1 (not displayed), so nothing new is fetched or mapped.
- `listCompanies` forwards the new args; the `GET /app/companies` handler parses new query params:
  `ownerId`, `createdGte`, `createdLte`, `activityGte`, `activityLte` (all optional; numeric ms).

### New: `GET /app/owners`

Returns `{ owners: [{ id, name }] }` from `ctx.ownersById` (sorted by name; blank names skipped),
to populate the Company-owner dropdown. Session-token auth + `no-store`, fails soft to
`{ owners: [] }`. Memoized client-side for the page session (like the schema fetches).

### App

- `worker-client.ts`: extend `listCompanies(token, args)` args with `ownerId?`, `created?`,
  `activity?` (`DateRange`s), serializing them to the query params above; add
  `getOwners(token): Promise<{id,name}[]>` (memoized).
- `CompaniesView`: three filter controls in the toolbar — an **owner `<select>`** (from
  `getOwners`, "All owners" default) and two **DateRangeFilter** dropdowns ("Create date",
  "Last activity"). Active filters are passed to `load()`; **changing any filter resets pagination**
  (drops accumulated pages + `after`), exactly like changing the search box. Filters + search + the
  seq-guard all compose through the existing `load(query, cursor)` (now also reading the current
  filter state via a ref, so a debounced call sees the latest filters).

## Part 4 — Deals filter (client-side)

- `lib/filter.ts`: `DealFilter` gains `createdRange?: DateRange`; `filterDeals` drops any row whose
  `Date.parse(r.createdAt)` falls outside the range (rows with no/invalid `createdAt` are excluded
  only when a range is active).
- `BoardView`: a **DateRangeFilter** "Create date" control joins the toolbar (Stage / Sales user /
  My deals). Its range is folded into the `filterDeals(...)` call. Pure client-side — no new fetch.

## Part 5 — Shared filter UI (`views/DateRangeFilter.tsx`)

One presentational component reused by both tabs:

- Props: `label: string`, `value: { preset: DatePreset | ""; custom?: { from?; to? } }`,
  `onChange(next)`.
- Renders a `dc-select`-styled dropdown: "All time" (cleared) + `DATE_PRESETS`. Selecting
  **Custom** reveals two `<input type="date">` (from / to). The parent resolves the chosen
  `{preset, custom}` to a `DateRange` via `dateRange(...)` at query time (so "today" stays correct
  across midnight without re-selecting).
- No data fetching, no date math inside — purely the control; all range logic lives in
  `lib/date-range.ts`.

## Testing

**App (vitest node):**
- `date-range`: for a fixed `now`, each preset resolves to the exact `{gte,lte}` (spot-check
  today/yesterday/thisWeek/thisWeekSoFar/lastWeek/last7/thisMonth/lastMonth/last30/thisYear/custom;
  assert the Monday week-start and that "thisWeek"⊇"thisWeekSoFar").
- `filterDeals`: `createdRange` includes in-range rows, excludes out-of-range and
  missing/invalid-`createdAt` rows; composes (AND) with existing q/stage/salesUser filters.

**Worker (vitest):**
- `companySearchBody`: owner-only, created-only, activity-only, all-three (single AND'd group with
  `notes_last_updated` for activity); query+filters keeps both `query` and `filterGroups`;
  no-query/no-filter keeps the `createdate HAS_PROPERTY` default; `COMPANY_LIST_PROPS` unchanged.
- `/app/owners` mapping: `ctx.ownersById` → sorted `[{id,name}]`, blank names skipped.

**Live smoke (implementation):** `/app/companies` with `ownerId` + a created range + a search term
returns the expected filtered set (confirms query+filterGroups combine); `/app/owners` returns the
owner list.

## File structure

**Worker**
- `worker/src/hubspot.ts` — extend `companySearchBody` (+ `listCompanies` args) with owner/created/
  activity filters (`COMPANY_LIST_PROPS` unchanged — the activity filter needs no fetched field).
- `worker/src/index.ts` — parse the new `/app/companies` filter params; add `GET /app/owners`.
- `worker/test/companies.test.ts` — filter-group + owners tests (append).

**App**
- `monday-app/src/lib/date-range.ts` (+ `.test.ts`) — the preset engine.
- `monday-app/src/views/DateRangeFilter.tsx` — the reusable dropdown control.
- `monday-app/src/lib/filter.ts` (+ `.test.ts`) — `createdRange` on `DealFilter`/`filterDeals`.
- `monday-app/src/worker-client.ts` — `listCompanies` filter args + `getOwners`.
- `monday-app/src/App.tsx` — lift `useBoard()`, pass `board` to `BoardView`.
- `monday-app/src/views/BoardView.tsx` — take `board` as a prop; add the Create-date control.
- `monday-app/src/views/CompaniesView.tsx` — owner + create-date + last-activity controls, wired
  into `load()` with pagination reset.
- `monday-app/src/styles.css` — minor styles for the date dropdown's custom-range row.

## Decisions (settled)

- **Perf fix:** lift `useBoard` to `App` (Option A) — persists Deals across tab switches with the
  smallest, most idiomatic change; rejected keeping-both-mounted (wasteful hidden effects) and a
  module cache (stale-cache trap).
- **Companies filters are server-side** (HubSpot search filter groups); **Deals is client-side**
  (rows already loaded).
- **One date-range engine** in ms feeds both HubSpot filters and the Deals client filter.
- **Last Activity Date** = `notes_last_updated`. **Owner** = `hubspot_owner_id`. Week start = Monday.
- Deals **Create-date** filter is included per the original request (the checkbox reply named only
  the Companies filters; flagged for veto).
