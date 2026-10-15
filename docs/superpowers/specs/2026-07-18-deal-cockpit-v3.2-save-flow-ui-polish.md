# Deal Cockpit v3.2 — Friendly Save Flow, Feedback & UI Polish + Regression Audit

**Status:** Design approved 2026-07-18. Ready for implementation planning.

**Scope:** monday-app (`monday-app/`) primarily; no Worker behavior changes (the existing `/app/sync-deal`
and `/app/clear-deal-fields` endpoints are reused). A full regression audit of app + Worker closes the work.

**Non-goals:** No visual redesign (refine the existing custom design system only). No new Worker endpoints.
No saved-views / virtualization (those remain future roadmap). No changes to the sync engine or the
never-clear-HubSpot rule.

---

## 1. Problem

Saving a deal is slow and jarring:

1. `DealDrawer.save()` runs ~9 sequential API calls and the last, `syncDeal`, **awaits the Worker
   reconciling the deal to HubSpot** before the save is considered done. That HubSpot round-trip is the
   bulk of the perceived wait.
2. `BoardView.onSaved` then calls `board.reload()`, which is `useBoard.load()` — it flips `loading:true`,
   so the whole board unmounts to the full-screen "Loading deals…" spinner and re-fetches all ~190 deals
   + users + linked names, just because one row changed.

Separately, the UI wants a polish pass across four areas the user selected: the table/list, the deal
drawer/form, loading & feedback, and overall consistency — **refining** the current look, not redesigning.

---

## 2. Save & sync flow (the core change)

### 2.1 Required behavior (from the user)

On monday confirming the save:
- immediately **close the drawer**
- **update only the edited row** in place
- **do not reload the full board**
- show a toast: **"Saved to monday"**

Do **not** show "Synced" until HubSpot confirmation is actually available:
- a HubSpot Deal ID exists for the (new) deal, **and**
- the Worker reports the sync completed successfully.

If the background sync fails, the row shows a **Retry** affordance — never a false "Synced".

### 2.2 Split of responsibilities

**Drawer (`DealDrawer.save()`) — monday writes only.** Unchanged set of writes, minus the HubSpot calls:
create/update item, rename, columns (incl. deliberate clears written as monday `null`), group move,
resolve staged associations → cards + relation column, persist line items → subitems. It **no longer**
calls `syncDeal` or `clearDealFields`. On full success it calls the new `onSaved` shape and returns; on any
failure it stays open and shows the step error (existing behavior, `savingRef` reset so Save can retry).

New `onSaved` payload (replaces the `(msg: string)` form):

```ts
interface SavedInfo { itemId: string; isEdit: boolean; clearProps: string[] }
// clearProps ⊆ ["amount","closedate","sales_user"] — the deliberate clears, HubSpot-side, deferred to bg sync
onSaved: (info: SavedInfo) => void
```

**Board (`useBoard`) — targeted row update + background HubSpot sync.**

```ts
type SyncStatus = "syncing" | "synced" | "error";

interface BoardState {
  // ...existing...
  syncing: Record<string, SyncStatus>;      // per-itemId transient status (client-only)
  patchRow: (itemId: string) => Promise<void>;
  finishSave: (info: SavedInfo) => Promise<void>;
}
```

- `patchRow(itemId)` — fetch exactly one deal (`getDeal`), resolve its linked company/contact names
  (`getItemNames` on that item's linked ids), build its `DealRow`, and **upsert** it into `rows`
  (replace by id, or append if new). Never touches `loading`. Shared row-building is extracted so `load()`
  and `patchRow()` produce identical rows (see 2.4).

- `finishSave(info)` orchestrates:
  1. `setStatus(itemId, "syncing")`
  2. `await patchRow(itemId)` — the row shows the new monday values immediately, with the Syncing badge
  3. background HubSpot work, in order:
     - if `info.clearProps.length` **and** the current row has a `hubspotId` → `clearDealFields(token, hubspotId, clearProps)`
     - `const ok = await syncDeal(token, itemId)` — resolves when the Worker finished reconciling to HubSpot
     - `await patchRow(itemId)` again — picks up the HubSpot Deal ID (new deal) + updated last-synced
  4. `setStatus(itemId, confirmSynced(ok, <row.hubspotId now>))`
  5. `"synced"` auto-clears from the map after ~4s (badge fades); `"error"` persists until a retry.

  On a thrown error anywhere in step 3 → `setStatus(itemId, "error")` and a subtle error toast.

- `syncDeal` must return the Worker's success boolean. Update `worker-client.syncDeal` to return
  `res.ok === true` (today it returns void). `clearDealFields` stays void.

### 2.3 Pure, testable core

```ts
// lib/sync-status.ts
/** "Synced" is only truthful when the Worker reported success AND a HubSpot Deal ID now exists. */
export function confirmSynced(syncOk: boolean, hubspotId?: string): SyncStatus {
  return syncOk && !!hubspotId ? "synced" : "error";
}
```

```ts
// lib/rows.ts (or exported from useBoard helpers)
/** Replace the row with the same id, or append it. Pure; never mutates the input array. */
export function upsertRow(rows: DealRow[], row: DealRow): DealRow[];
```

These two functions carry the correctness and are unit-tested directly. `finishSave`/`patchRow` are thin
async wrappers over them.

### 2.4 Shared row builder

Extract the per-item mapping currently inline in `useBoard.load()` into a pure helper so `load()` and
`patchRow()` cannot drift:

```ts
function rawItemToRow(item: RawItem, names: Record<string, string>): DealRow
```

`load()` maps all items through it; `patchRow()` maps the one refetched item through it.

### 2.5 Kanban consistency

`KanbanView.drop()` currently calls `board.reload()` after `moveToGroup`, causing the same full-screen
flash. Switch it to `board.patchRow(id)`. (Group membership is the only thing that changed; a single-row
refetch reflects it.) No sync badge needed there — a drag isn't a HubSpot-affecting deal edit in the app's
model beyond what the webhook already handles; leave the badge to the drawer save path.

---

## 3. Loading & feedback

- **Skeleton rows** replace the full-screen `dc-loading` spinner: while `loading` is true (first load and
  the explicit ⟳ Refresh), render the normal panel/table chrome with ~6 shimmer rows. A new `.dc-skeleton`
  shimmer class (theme-aware). The config-error and hard-error states are unchanged.
- **Per-row sync badge** (from §2): a small pill rendered in the row's actions cell —
  `⟳ Syncing…` (muted/animated), `✓ Synced` (green, auto-fade), `⚠ Retry` (red, clickable → re-invoke
  `finishSave` for that row with empty `clearProps`). Absent when the row has no transient status.
- **Toast variants:** `toast` state becomes `{ text: string; type: "success" | "info" | "error" } | null`.
  "Saved to monday" uses `info` (neutral/blue). A background-sync failure raises an `error`-styled toast
  "HubSpot sync failed — Retry on the row" (reuses the red `dc-err` palette). Keep click-to-dismiss; add
  auto-dismiss after ~3.5s for `success`/`info` (the `error` toast persists until dismissed).

---

## 4. Table & drawer polish (refine only)

**Table (`BoardView`):**
- Long names: add `title={r.name}` (and company/contact) so truncated Chinese/English names show a native
  tooltip on hover. Keep the existing ellipsis.
- A real empty state: icon + "No deals yet" + a "Create your first deal" button that opens the create
  drawer (only when there are zero rows *and* no active filters; keep "No deals match your filters" when
  filters are active).
- Consistent right-alignment for Amount and Created; keep the sticky header.
- Minor density: verify row padding reads well with the new Created column and the sync badge.

**Drawer (`DealDrawer`):**
- Group the Overview tab into labelled sub-sections ("Deal", "Value", "People") using the existing
  `.dc-section-title`, so the now-always-visible fields read as groups rather than a long stack.
- The Sync tab surfaces the live status for the open deal (Syncing/Synced/last-synced/HubSpot Deal ID) —
  it already shows most of this; align its wording with the new badge states.
- Keep required-field markers; ensure inline validation errors are visually consistent.

**Overall:**
- Dark-mode pass on the new `.dc-skeleton` and sync-badge classes.
- Consistent `tabular-nums` on money/counts (already mostly present).
- No token/scale changes beyond what the above needs.

---

## 5. Regression audit (full)

Run and report as one pass/fail table. Covers:

**Automated:**
- `tsc --noEmit`, `vitest run`, `vite build` for `monday-app/`.
- `tsc --noEmit`, `vitest run` for `worker/`.

**Live, read-only / non-destructive:**
- Board schema + all 23 configured columns exist with correct types (both boards).
- Every monday write document validates against the live 2026-07 GraphQL schema (ghost-id probes, not
  `@skip`).
- `/app/*` auth gates: 403 unauthenticated, 204 on OPTIONS, for search / line-item / association / deal /
  sync-deal / clear-deal-fields.
- `clear-deal-fields` allowlist rejects a non-allowlisted property.
- Data integrity: monday group ↔ HubSpot `dealstage` (expect 0 drift); stage label ↔ group-title mapping;
  spot-check amount/closedate/sales_user reverse for a couple of records.

**Manual checklist (handed to the user to run in the live app):**
- Create a deal; confirm instant close + "Saved to monday" toast + row appears at top (newest-first) +
  badge goes Syncing → Synced with a HubSpot Deal ID.
- Edit a deal (change amount); confirm no full-board flash, row updates, badge confirms.
- Clear Amount and clear Close date; confirm both empty in monday and HubSpot after sync.
- Empty Sales Users; confirm the deal returns to Unassigned after sync.
- Add and remove a contact; add a line item with a % discount; confirm in HubSpot.
- Kanban drag between stages; confirm no full-screen flash.
- Filters + sort + Created column behave.

**Deliverable:** a single results table (inline or artifact), with any failure triaged.

---

## 6. Files touched

| File | Change |
|------|--------|
| `monday-app/src/useBoard.ts` | `syncing` state; `patchRow`; `finishSave`; extract `rawItemToRow`; expose new API |
| `monday-app/src/lib/sync-status.ts` | new: `SyncStatus`, `confirmSynced` |
| `monday-app/src/lib/sync-status.test.ts` | new: unit tests |
| `monday-app/src/lib/rows.ts` | new: `upsertRow` (+ `rawItemToRow` may live here) |
| `monday-app/src/lib/rows.test.ts` | new: unit tests |
| `monday-app/src/views/DealDrawer.tsx` | `save()` drops HubSpot calls; new `onSaved(SavedInfo)`; Overview sub-sections; Sync-tab wording |
| `monday-app/src/views/BoardView.tsx` | new `onSaved` handler → toast "Saved to monday" + `finishSave`; sync badge cell; skeleton loading; empty-state CTA; name tooltips; toast variants |
| `monday-app/src/views/KanbanView.tsx` | `board.reload()` → `board.patchRow(id)` |
| `monday-app/src/worker-client.ts` | `syncDeal` returns `boolean` |
| `monday-app/src/styles.css` | `.dc-skeleton` shimmer; `.dc-syncbadge` states; toast `info`/`error` variants; minor polish |

---

## 7. Testing strategy

- **TDD the pure core:** `confirmSynced` (synced only when ok && hubspotId; else error) and `upsertRow`
  (replace-by-id, append-if-new, no mutation). Written test-first.
- **Existing suites stay green** (app 74, worker 158) and grow with the two new files.
- Presentational pieces (skeleton, badge markup, tooltips) are verified via `tsc`/build + the manual
  checklist, not unit tests.

---

## 8. Rollout

Single branch, incremental commits per the plan's tasks. Deploy app to monday CDN
(`mapps code:push -c -i 16011075 -f -d ./dist` via the working cached CLI). No Worker deploy required
(no Worker changes) — but the audit still runs against the currently-deployed Worker `cd184f47`.

---

## 9. Open risk / notes

- **Background sync after drawer close:** `finishSave` runs in the board component, which stays mounted, so
  the async work survives the drawer unmounting. If the user navigates away entirely the app unloads and
  the webhook/cron remain the fallback (unchanged guarantee).
- **"Synced" honesty:** gating on `syncDeal ok && hubspotId present` means a Worker that returns ok but
  hasn't stamped an ID yet reads as "error/Retry" rather than a false "Synced" — deliberate, per the
  requirement. Retry re-runs the same path and will flip to Synced once the ID is present.
- **Credential rotation still outstanding** (Client Secret, Signing Secret, monday API token) — tracked
  separately; not part of this spec.
