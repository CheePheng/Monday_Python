# Sync All Companies — Phase 1 (company cards) — Design

**Date:** 2026-07-30
**Status:** draft for review
**Part of:** "sync all HubSpot companies to the Company Follow Up board" (Phase 2 = company→contact associations, separate spec).

## Goal

Get all ~25,579 HubSpot companies onto the monday Company Follow Up board (5029639440) as cards, and keep
them current — **without** breaking the live deal/contact sync. Cards only in this phase (no associations).

## Constraints established from the code + live data

- **HubSpot `/search` caps at 10,000 results**, so `searchAll`/`searchModifiedIds` cannot enumerate 25k.
  The bulk import must use the **list API** (`GET /crm/v3/objects/companies?after=…`), which pages all of them.
- **`recInScope`** ([sync.ts:388](worker/src/sync.ts#L388)) gates every company to `sales_user` +
  created-after-cutoff and is **shared with contacts** — relaxing it must be company-scoped.
- **The 03:00 full reconcile** (`runAll` → `syncSpec` → `searchAll`) can't carry 25k and only sees 10k;
  companies must come out of it. The **10-min incremental** (`searchModifiedIds`, recently-modified only)
  scales and stays.
- Companies use `groupBy: { singleGroup }`, so every company places into one group (no routing needed).
- monday Enterprise allows 100,000 items/board — 25,579 is well within it.

## Design

### 1. Two spec flags (company-scoped, so contacts/deals are untouched)

`worker/src/types.ts` — `ObjectSpec`:
```ts
  includeAll?: boolean;        // ignore the sales_user/createdate scope gate (sync EVERY record)
  skipFullReconcile?: boolean; // exclude from the 03:00 full sweep (too large / search-capped)
```
`worker/src/config.ts` — `COMPANIES_MYLA` gains `includeAll: true, skipFullReconcile: true`. Contacts and
deals get neither, so their behaviour is byte-for-byte unchanged.

### 2. Spec-aware scope

`recInScope` takes the spec and short-circuits when `includeAll`:
```ts
function recInScope(spec: ObjectSpec, rec: {...}): boolean {
  if (spec.includeAll) return true;
  if (!(rec.properties.sales_user ?? "").trim()) return false;
  return (Date.parse(rec.properties.createdate ?? "") || 0) >= CREATED_AFTER_MS;
}
```
Its one caller (`syncHubspotRecord`) passes `spec`. So a company webhook now upserts regardless of
sales_user/date; contacts keep the gate.

### 3. Incremental drops the gate for `includeAll` specs

`searchModifiedIds` builds its filter from `spec.includeAll ? [] : spec.searchFilters` (plus the
modified-date filter it already adds). So the 10-min incremental picks up **any** recently-modified
company. (Result sets stay well under 10k because the window is minutes.)

### 4. Full reconcile skips `skipFullReconcile` specs

`runAll`: `for (const spec of ALL_SPECS) { if (spec.skipFullReconcile) continue; … }`. The daily sweep
keeps doing deals + contacts; companies are served by the incremental + webhooks + the one-time import.

### 5. List-API pagination helper

`worker/src/hubspot.ts`:
```ts
// Plain list pagination (NOT search) — the only way past search's 10,000-result ceiling.
export async function listPage(env: Env, object: string, after: string | undefined, properties: string[], limit = 100):
  Promise<{ records: HsRecord[]; next?: string }>
```
Calls `GET /crm/v3/objects/${object}?limit=&after=&properties=` and returns the page + `paging.next.after`.

### 6. Bulk-import endpoint (drives the one-time load through the real card path)

`worker/src/index.ts` — `GET /import?object=companies&after=<cursor>`, gated by the existing
`X-Trigger-Secret` header (same as `/run`). One page per call:
```
listPage(companies, after, propertiesForSpec(COMPANIES_MYLA), 100)
  -> for each rec: ensureCardForRecord(env, COMPANIES_MYLA, ctx, rec, liveOpts)   // deduped via registry; NO association pass
  -> return { after: next, done: !next, created, existing, processed }
```
~100 companies/call ≈ 200–300 subrequests (well under the 1,000 cap); ~256 calls for 25k. Uses
`ensureCardForRecord` so a card that already exists (the current 682) is adopted, never duplicated.

### 7. Import driver (`scratchpad/import-companies.cjs`)

Loops: `GET /import?object=companies&after=<cursor>` with the trigger secret, following `after` until
`done`, logging running totals + backing off on any 429/complexity. Resumable — re-invoking with the last
cursor continues; safe to re-run from scratch (ensureCardForRecord dedupes).

### 8. Ongoing

New/changed companies flow via **webhooks** (instant) and the **incremental** (every 10 min, relaxed
filter) as backstop. No full sweep for companies (dropped in step 4).

**Webhooks confirmed working (live-tested 2026-07-30):** a company property change fired a webhook that
reached the worker in seconds (`[webhook] source=hubspot events=company:… action=received`). It's currently
`skipped reason="out of scope"` only because of today's filter — once `includeAll` is set (step 1/2), that
same instant webhook upserts the company. **No HubSpot subscription work is needed.**

## Testing

| Change | Test |
|---|---|
| `recInScope(spec, rec)` spec-aware | ✅ unit (pure): `includeAll` → always true; contacts keep the gate |
| `runAll` skips `skipFullReconcile` | ✅ unit: the spec list it iterates excludes companies |
| `searchModifiedIds` filter relaxation | ✅ unit if the filter-build is extracted; else tsc + review |
| `listPage`, `/import` endpoint | I/O — verified live during the import (dry count first) |

Worker `tsc` + `vitest` green. **Regression guard:** existing contact/deal `recInScope` and full-reconcile
tests must still pass unchanged — that's the proof the relaxation is company-only.

## Risks & mitigations

- **Live-sync blast radius:** every changed line is behind a company-only flag; contacts/deals unchanged and
  tested. Deploy the code, confirm the 10-min incremental + deals/contacts still green, *then* import.
- **Import runtime:** ~25k throttled writes = hours; driven + monitored, resumable, dedupe-safe.
- **No-domain companies (2,442):** import anyway; board name is `companies <id>` (readable in-app via the
  name cascade).
- **Losing the company full-sweep safety net:** accepted; incremental + webhooks cover ongoing.

## Non-goals (Phase 1)

- Company→contact associations and the ~50k contact cards / ~160k links (Phase 2).
- Any app change (the future "Companies tab" is a separate feature).
- Relaxing contacts or deals in any way.
