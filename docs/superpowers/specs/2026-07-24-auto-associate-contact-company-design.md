# Auto-associate Contact → Company in the Deal Form — Design

**Date:** 2026-07-24
**Status:** approved for implementation

## Problem

In the deal form, picking a contact does not pull in that contact's company. The app has no way to read a
HubSpot record's associations (only search + create), so the two Association sections are independent. The
user wants: **pick a contact → its associated company is auto-added.** (Company → contacts is out of scope
by decision — companies often have many contacts.)

## Design

### Worker — a read endpoint for associations

`GET /app/associations?type=contacts&id=<hubspotId>&to=companies` (auth via `authApp`, like the other
`/app/*` routes). It:
1. `getAssociatedIds(env, type, id, to)` → associated HubSpot ids.
2. `getRecordsByIds(env, to, ids, ["name", "domain"])` → their names.
3. Returns `{ results: [{ hubspotId, name }] }`, `name = properties.name || properties.domain || ""`.

Generic in `type`/`to` (so it can serve other pairs later), but the app only calls contacts→companies now.
Read-only; fails soft (`{ results: [] }` on error) so a lookup hiccup never blocks the form.

### App — auto-stage on contact add

- `worker-client.ts`: `getRecordAssociations(token, type, id, to) → { hubspotId, name }[]`.
- `DealDrawer.tsx` holds `contacts` / `companies` state. Wrap the **contacts** section's `onChange` so that
  when a contact **with a hubspotId** appears that we haven't resolved yet, we fetch its companies and merge
  them into `companies`.

**Rules (the important part):**
- **Seed "already resolved" with the contacts loaded when the drawer opens**, so opening an existing deal
  does NOT suddenly pull in companies for its already-linked contacts. Only contacts added *after* open
  trigger a fetch.
- **Only on add.** A `useRef<Set<string>>` of resolved contact hubspotIds means each contact is resolved at
  most once. If the user then removes an auto-added company, it stays removed (we never re-add on render).
- **Dedupe** by `hubspotId`: never add a company already staged.
- A staged **"+ New"** contact has no hubspotId → nothing to fetch (correct).

**The merge is a pure, testable function** in `monday-app/src/lib/auto-associate.ts`:
```ts
// Given the current companies and the fetched associated companies, return the companies to stage:
// existing ones untouched, new ones appended, deduped by hubspotId. Never removes.
export function mergeAssociatedCompanies(current: Assoc[], fetched: { hubspotId: string; name: string }[]): Assoc[]
```
`DealDrawer` handles the async fetch + the resolved-set bookkeeping (I/O, verified by tsc); the dedupe/merge
decision is unit-tested.

## Data flow

```
pick contact (hubspotId) in the form
  -> not in resolvedRef?  -> getRecordAssociations(contacts, id, companies)
     -> mergeAssociatedCompanies(companies, fetched)  -> setCompanies(...)
     -> resolvedRef.add(id)
```

On Save, the auto-staged companies resolve to cards and link exactly like a manually-picked company (no
change to `resolveAssocs` — they're ordinary `Assoc` entries with a `hubspotId`).

## Testing

| Change | Test |
|---|---|
| `mergeAssociatedCompanies` | ✅ unit (pure): appends new, dedupes existing, never removes, empty fetch is a no-op |
| worker endpoint | parse/guard of the query params (small), else tsc + review (I/O) |
| `getRecordAssociations` / DealDrawer wiring | tsc + build + manual (I/O, this app's boundary) |

App `tsc` + `vitest` + `vite build`; worker `tsc` + `vitest`.

## Non-goals

- Company → contacts auto-link (decided out).
- Auto-linking on the standalone Contact/Company drawers (deal form only).
- Re-adding a company the user removed (respecting removal is the point).
- Any change to how associations are saved (auto-staged = normally-staged).
