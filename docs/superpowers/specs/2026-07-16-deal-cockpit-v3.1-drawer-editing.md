# Deal Cockpit v3.1 — Drawer, editing & instant sync

**Date:** 2026-07-16
**Status:** Approved design (pending user spec review)

## Context

Sales reps live in the Deal Cockpit app. The v2 editor is a cramped 720px centered modal, the association
picker fires a search on every keystroke with no debounce / spinner / cancellation, line items are a flat
input list, and the create form throws every CRM field at the rep at once. v3.1 restructures the editing
experience into a **right-side drawer** (keeping the pipeline visible), fixes the picker, turns line items
into a real quotation table with amount-or-% discounts, and makes a progressive create form — while keeping
**all sync webhook-instant**. This is the second of the roadmap rounds (v3.2 = quick actions / Kanban / KPIs
/ saved views; v3.3 = scale).

## Decisions (confirmed)

- **Unified drawer** replaces the centered modal for both create and edit (the modal is retired).
- **Proper percentage discounts:** a new monday "Discount %" subitem column + a Worker field mapping to
  HubSpot `hs_discount_percentage`, so a % is stored as a real percentage in HubSpot and round-trips.
- **Everything webhook-instant:** no app action may depend on the 10-minute cron. The drawer triggers an
  immediate deal reconcile on save via a new `POST /app/sync-deal` endpoint (below). The cron stays a backup.
- **Hard-blocking validation stays name + stage + numeric amount.** Company/close-date are shown first but
  not blocking (reps often lack them early).

## Architecture — the drawer

Replaces `DealModal`. A right-anchored panel (~520px; near-full-width under ~720px viewport) that slides in.
**No blocking backdrop** — the table/Kanban stays visible and clickable on the left, so clicking another deal
switches the drawer (routed through the existing unsaved-changes guard). Close via ✕ or **Esc**. A tab strip:

```
Overview · Associations · Line Items · Updates · Sync
```

- **Create mode:** opens empty on *Overview*, advanced fields collapsed. Associations + Line Items are
  usable pre-save (staged in memory, saved together — same model as today). *Updates* and *Sync* tabs are
  hidden until the deal exists (they need a HubSpot id / item id).
- **Edit mode:** opens populated; all five tabs available.

New components: `views/DealDrawer.tsx` (shell + tab state + the save sequence, adapted from the current
`DealModal` save), and one small component per tab (`tabs/OverviewTab.tsx`, `tabs/AssociationsTab.tsx`,
`tabs/LineItemsTab.tsx`, `tabs/SyncTab.tsx`; Updates reuses `UpdatesPanel`). `DealModal.tsx` is deleted;
`BoardView` renders `<DealDrawer>` instead.

### Overview tab — progressive form
Primary (always shown): Deal name, Sales User, Deal stage, Amount, Currency, Close date. **Advanced
(collapsed behind a "More details" toggle):** Deal type, Priority, Vendors, Deal owner. Reuses the existing
`FormFields` + `validateDealForm`; the Pipeline field is already gone (v3.0). Save disabled until valid.

### Associations tab — the fixed picker
Rework `AssociationPicker`:
- **300ms debounce** on input (a `useDebouncedSearch` hook).
- **Loading spinner** while a request is in flight.
- **Request cancellation** via `AbortController` — a newer keystroke aborts the older request so out-of-order
  responses can't render stale results (a real bug today).
- **Keyboard nav:** ↑/↓ move a highlight through results, Enter selects, Esc closes the list.
- Results show name with **email (contacts) / domain (companies) prominent**, and an "Existing HubSpot
  record" label vs the "+ New" action.
- **Duplicate warning:** before creating a new contact/company, check the current results for an
  email match (contacts) or domain/name match (companies); if found, warn "A similar record exists — link it
  instead?" with a one-click link.
- Selected records render as removable chips (already present).
Search cancellation needs the Worker request to be abortable client-side; `searchHubspot` gains an optional
`AbortSignal`.

### Line Items tab — quotation table
Replace the flat list with a table: **Product · Qty · Unit price · Discount · Line total · ✕**.
- Product add via a debounced search dropdown (same hook as the picker).
- **Discount cell has a $ / % toggle** per line. `$` edits the per-unit amount (HubSpot `discount`); `%` edits
  the percentage (HubSpot `hs_discount_percentage`). Toggling clears the other so exactly one is ever set.
- **Line total:** `$` → `qty × (unitPrice − discount)`; `%` → `qty × unitPrice × (1 − pct/100)`; clamped ≥ 0.
- Footer: **subtotal** (Σ qty×unitPrice), **discount total** (subtotal − grand total), **grand total**, and
  **"Use total as deal amount"**.
- Deleting a **synced** line item (has a HubSpot Line Item ID) asks for confirmation first.

### Updates tab
The existing `UpdatesPanel` (post + list), edit mode only.

### Sync tab
Read-only: HubSpot Deal ID (or "Pending — creating in HubSpot…" when absent), last-synced timestamp (from
the deal's Sync State column, read via the existing item query), and an **Open in HubSpot** button. (Richer
"Needs retry / Conflict" statuses require Worker-side error recording — deferred to v3.2.)

## Discount % — mechanics

- **New monday subitem column** "Discount %" (type `numbers`) on the subitems board `5029480548`. Created via
  the monday API in the plan's first task (fallback: user adds it in the UI and provides the id). Its id is
  wired into `LINE_ITEM_SUBITEMS` (worker) and `SUB_COLS` (app).
- **Worker** `LINE_ITEM_SUBITEMS.fields` gains `{ hs: "hs_discount_percentage", col: "<new id>", type: "numbers" }`.
  `reverseLineItems` already iterates `sub.fields`, so the create path picks it up with no other change.
- **App** `LineItem` gains `discountMode: "amount" | "percent"` (default `amount`) and `discountPct?`;
  `lineItemToSubitemColumns` writes the active column and leaves the other empty; `persistLineItems`'s
  `updateHubspotLineItem` sends the active property with its value **and the inactive one as `""`** (so a
  mode switch clears the old value in HubSpot). `lib/totals.ts` handles both modes.

## Instant sync — `POST /app/sync-deal`

New session-authed Worker route (next to the other `/app/*` routes). Body `{ itemId }` (numeric monday item
id). It runs the Worker's existing `syncMondayItem(env, DEALS.boardId, itemId, liveOpts, budget)` — the same
function the monday webhook calls — reconciling that one deal immediately: reverse fields (incl. the v3.0
amount/currency/close-date + backfill), reverse associations, and rebuild line items. The drawer calls it
after its monday writes land, so the whole deal reaches HubSpot within ~a second, deterministically, without
depending on which columns fired a webhook or on the cron. Safe to double-fire (coalesced per isolate,
idempotent id-keyed writes). App: `worker-client.ts` gains `syncDeal(token, itemId)`; the drawer's `save()`
calls it once, after the parent create/update + associations + line items.

## Testing

- **Pure/unit (vitest):**
  - `lib/totals.ts` — `lineTotal`/`lineItemsTotal` for both discount modes (amount, percent, blanks, clamp).
  - `lib/columns.ts` — `lineItemToSubitemColumns` writes the active discount column and omits the inactive.
  - `worker/test/app-routes.test.ts` — `parseSyncDealBody` (numeric itemId; reject missing/non-numeric).
  - A `useDebouncedSearch` unit test (fake timers) covering debounce + abort-of-stale.
- **Worker:** the `/app/sync-deal` route calls `syncMondayItem` with the right args (light integration or a
  parse-level test, consistent with the existing `/app/*` tests). Existing 150 tests stay green.
- **Live (hard-refresh):** open the drawer, switch deals by clicking rows; create a deal with primary fields
  only, then via Advanced; picker debounces + cancels stale results + keyboard-selects; create a new contact
  that duplicates an existing email → warning; build a quotation with a `%` discount and a `$` discount →
  totals correct, and in HubSpot the line items show the right net price AND the % on the %-line; on save the
  deal + line items appear in HubSpot within ~a second (instant, not a cron tick); delete a synced line item
  → confirm prompt; Sync tab shows the id + last-synced.

## Files

**Worker:** `src/config.ts` (Discount % field), `src/app-routes.ts` (`parseSyncDealBody`), `src/index.ts`
(`/app/sync-deal` route), `test/app-routes.test.ts`. (A one-off column-create script/step for the new column.)
**App:** `board-config.ts` (SUB_COLS discountPct), `lib/columns.ts`, `lib/totals.ts`, `worker-client.ts`
(`syncDeal`, abort signal on `searchHubspot`), `hooks/useDebouncedSearch.ts` (new), `views/DealDrawer.tsx`
(new, replaces `DealModal`), `views/tabs/OverviewTab.tsx` / `AssociationsTab.tsx` / `LineItemsTab.tsx` /
`SyncTab.tsx` (new), `views/AssociationPicker.tsx` (debounce/spinner/cancel/keyboard/dup-warning),
`views/BoardView.tsx` (render the drawer), `styles.css` (drawer + tabs + quotation table). Delete
`views/DealModal.tsx`.

## Out of scope (v3.2 / v3.3)

Inline table quick-actions, Kanban updating group+badge together, KPIs following the filter, saved views +
per-user persistence, "Needs retry / Conflict" sync statuses (Worker error recording). v3.3: virtualization,
caching, targeted row refresh. Dropped earlier: follow-up date, overdue view, separate Activity tab.
