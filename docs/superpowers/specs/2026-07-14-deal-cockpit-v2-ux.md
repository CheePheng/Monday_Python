# Deal Cockpit v2 — UX upgrade (sole sales interface)

**Date:** 2026-07-14
**Status:** Approved design (pending user spec review)

## Context

Sales reps will use the Deal Cockpit Board View app as their **only** interface — they won't open monday's
main table. So the app must support a rep's full daily workflow: see who each deal is with, triage by
value/date, work deals through stages, quote line items, keep data fresh, and remove junk. This round closes
the gaps that currently force a fallback to monday/HubSpot. Builds on the shipped app (`monday-app/`) and
the Worker `/app/*` endpoints. Almost entirely front-end; two small Worker touch-points.

## Decisions (confirmed)

- **Unassigned drag:** in Kanban, cards in the Unassigned column are **not draggable**; show a hint
  ("Assign a Sales User first"). A deal only leaves Unassigned when it gets a sales user (unchanged rule).
- **Delete:** archives the HubSpot deal (removed from both systems) + a confirm dialog. No separate
  "Close Lost" this round (stage change / Kanban covers that).

## 1. Table gaps (🔴)

- **Company/Contact names.** After loading deals, collect the `linked_item_ids` from the two relation
  columns across all deals, batch-resolve them to names once via a new `getItemNames(itemIds)` in
  `monday-client.ts` (returns `{ itemId → name }` from a single `items(ids:[...]) { id name }` query), and
  fill `DealRow.company` / `DealRow.contact`. Fixes the "—" columns and makes them searchable.
- **Sorting.** New pure `sortDeals(rows, key, dir)` in `monday-app/src/lib/sort.ts` (keys: name, stage,
  amount(numeric), closeDate(date), company, contact). Clicking a `BoardView` header toggles asc/desc;
  default closeDate ascending. Unit-tested.
- **Search widened.** Extend `filterDeals` in `lib/filter.ts` so `q` matches name **+ company + contact**
  (case-insensitive). Unit-tested.
- **Delete a deal.** Trash action in the modal footer (and a row hover action). Confirm dialog. Flow: if
  the deal has a HubSpot id → `POST`/`DELETE /app/deal {hubspotDealId}` (Worker archives the HubSpot deal),
  then `deleteItem(cardId)`; if unsynced (no HubSpot id) → just `deleteItem`. Reload after.

## 2. Kanban pipeline view

- **Toggle** Table ⇄ Board in the toolbar (state only; default Table).
- New `monday-app/src/views/KanbanView.tsx`. Columns = the stage groups (from `board.meta.groups`, via
  `stageOptions`) **plus** an "Unassigned" column. Add `groupId` to `DealRow` (`toRow`) so cards place by
  monday group (the placement source of truth). Each column shows a count + summed amount; cards show
  avatar, name, amount, company.
- **Drag** a card between **stage** columns → `moveToGroup(cardId, targetGroupId)` (optimistic; revert on
  error). Moving the group reverse-syncs `dealstage` to HubSpot via the existing group-reverse — **no new
  endpoint**. Cards in/へ the Unassigned column are not draggable (per decision; show the hint).
- Uses a lightweight HTML5 drag-and-drop (no new dependency).

## 3. Speed & freshness

- **Fast edit open.** Add `getDeal(itemId)` (single-item query) to `monday-client.ts`; `DealModal` edit
  hydration uses it instead of `getDeals()` (which re-fetched every deal).
- **Refresh.** A refresh button in the toolbar (calls `board.reload`) + auto-refresh on
  `window` focus/`visibilitychange` (debounced) so HubSpot-side changes appear.
- **Unsaved-changes guard.** `DealModal` tracks a `dirty` flag (any field/assoc/line-item change); closing
  or backdrop-click when dirty asks to confirm.

## 4. Richer line items

- Add **description, discount, service date** to `LineItemsEditor` rows. Extend `SUB_COLS` in
  `board-config.ts` with `discount: numeric_mm53pkyf`, `serviceDate: date_mm53chbv` (description
  `long_text_mm53a511` already present). `lineItemToSubitemColumns` maps them (description already; add
  discount/serviceDate). The app's `updateHubspotLineItem` call includes `description`, `discount`,
  `service_date` (endpoint already forwards arbitrary properties — no endpoint change for update).
- **Worker create path:** ensure `reverseLineItems` (worker/src/associations.ts) maps
  description/discount/service_date from the subitem columns to the HubSpot line item on create (the fields
  already exist in `LINE_ITEM_SUBITEMS.fields`; verify/extend the mapping).

## 5. Create net-new contacts / companies (not just attach existing)

The association search only returns existing HubSpot records, so a rep can't add a brand-new prospect. Add a
**"+ New contact" / "+ New company"** action in `AssociationPicker` that opens a tiny inline form and
creates a monday card directly — the existing `createFromMonday` sync then creates the HubSpot record and
stamps its id, and the Worker's `reverseAssociations` links it to the deal once the id exists.
- **New contact form:** Name (→ item name = firstname; the Worker splits "First Last"), Email, Phone.
- **New company form:** Company name, Domain (optional). Note the board quirk: the Company board's primary
  column is the **domain**, so create with `item_name = domain || name` and set the Name column
  (`text_mm4scke9`) to the company name.
- New `createContactCard(fields)` / `createCompanyCard(fields)` in `monday-client.ts` (return the new
  itemId). The resulting `Assoc` has `hubspotId: ""` until synced; the disassociate guard already skips the
  HubSpot call for an empty id, and `boardRelationValue` links by itemId — so it works immediately.
- **Known limitation (note, not fixed here):** a monday-created contact/company inherits the board's default
  owner (Myla) in HubSpot, not the creating rep. Refining that is a separate Worker change (v2.1).

## 6. Surface errors (stop silent failures)

Replace the silent `catch {}` swallows in `AssociationPicker`, `LineItemsEditor`, and `worker-client`
calls with real feedback. Thread a `setError(msg)` from `DealModal` into the children; a failed
find-or-create, link, or line-item sync shows an inline error (and the save is not reported as success).
Search failures show a small "search unavailable" note rather than an empty dropdown. The existing
save-level error banner stays.

## 7. Input validation

New pure `validateDealForm(name, form)` in `monday-app/src/lib/validate.ts` → `{ ok, errors }`:
- **Deal name** required; **Stage** required.
- **Amount** must be numeric (digits + optional decimal) or empty; a non-numeric amount is an error.
`DealModal` disables **Create/Save** while invalid and shows the per-field messages. Unit-tested.

## 8. Line-item totals + KPI currency clarity

- **Totals:** pure `lineTotal(li)` = `quantity × unitPrice − discount` and `lineItemsTotal(items)`.
  `LineItemsEditor` shows each row's subtotal and a footer total; a "Use total as deal amount" button copies
  it into the Amount field. Unit-tested.
- **KPI currency:** `BoardView` groups Open pipeline **by currency** and renders the top currencies
  (e.g. `$120k · ¥300k`) instead of summing mixed currencies under one symbol; a small `+N more` when there
  are additional currencies.

## Worker changes (only two)

1. **`DELETE /app/deal`** — `worker/src/index.ts` route + `parseDealBody` in `app-routes.ts` (numeric
   `hubspotDealId`) + `archiveDeal(env, id, opts)` in `hubspot.ts` (`DELETE /crm/v3/objects/deals/{id}`,
   dry-run-guarded, 404-tolerant). Session-token authed like the other `/app/*` routes.
2. **Line-item fields** — `reverseLineItems` maps description/discount/service_date (create path).

## Testing

- **Pure/unit (vitest):** `sortDeals` (each key + direction, numeric vs string), widened `filterDeals`
  (company/contact match), `validateDealForm` (missing name/stage, non-numeric amount, valid), `lineTotal` /
  `lineItemsTotal` (qty×price−discount, blanks), KPI `pipelineByCurrency` grouping, `parseDealBody`
  (valid / non-numeric / missing).
- **Worker:** `archiveDeal` endpoint validation + 404-tolerance (mock), consistent with existing
  `/app/line-item` tests.
- **Live:** company/contact names show + sort + search; drag a deal across stages (verify stage updates in
  HubSpot); Unassigned card blocked with hint; delete archives in HubSpot and removes the card; edit opens
  fast; refresh picks up a HubSpot-side change; unsaved guard fires; create a **new** contact + company from
  the picker and confirm they appear in HubSpot linked to the deal; a failed action shows an error (not a
  false success); Create disabled until valid; line item with description/discount/service date + a subtotal
  that can fill Amount round-trips to HubSpot.

## Files

Front-end: `useBoard.ts` (names, groupId, refresh-on-focus), `lib/sort.ts` (new), `lib/filter.ts`
(widened search), `lib/validate.ts` (new), `lib/totals.ts` (new: lineTotal/lineItemsTotal), `lib/columns.ts`,
`board-config.ts` (discount/serviceDate SUB_COLS), `monday-client.ts` (getDeal, getItemNames,
createContactCard, createCompanyCard), `worker-client.ts` (archiveDeal), `views/BoardView.tsx` (sort,
Table/Board toggle, refresh, delete, per-currency KPI), `views/KanbanView.tsx` (new), `views/DealModal.tsx`
(single-fetch, dirty guard, delete, validation, error thread, line-item fields, totals→amount),
`views/LineItemsEditor.tsx` (description/discount/service date + subtotals), `views/AssociationPicker.tsx`
(new-record forms + error surfacing), `styles.css` (Kanban + drag styles). Worker: `index.ts`,
`app-routes.ts`, `hubspot.ts`, `associations.ts`.

## Out of scope (v2.1)

Saved views, bulk actions, keyboard shortcuts, activity timeline, mobile layout, column customization.
