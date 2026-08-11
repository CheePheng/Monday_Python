# Two-Way Line-Item Sync — Design

**Date:** 2026-08-04
**Status:** Approved (pending user spec review)
**Branch:** `feat/deals-single-board`

## Problem

Editing a line item's unit price (or any attribute) directly on the monday board reverts to HubSpot's value on the next sync ("changed to 90, it went back to 99"). Two root causes, both verified in code:

1. **`reverseLineItems` (monday→HubSpot) only *creates*.** It builds a HubSpot line item for a subitem whose "HubSpot Line Item ID" column is **empty**, then stamps the id back. For a subitem that already has an id — the normal edit case — it does **nothing**. There is no patch path. (`worker/src/associations.ts:68`)
2. **`syncLineItems` (HubSpot→monday) overwrites the subitem columns from HubSpot on every forward tick.** (`worker/src/associations.ts:188`) So a monday-side edit that never reached HubSpot gets pulled back to the stale HubSpot value.

Additionally, the line-item subitem fields carry **no `reverse` flag** (unlike deal/company fields), so there is no per-field two-way model for line items at all, and **the monday subitems board (5029480548) has no webhook**, so a board-direct subitem edit fires nothing to the Worker.

## Goal

Make every rep-editable line-item attribute sync **both directions**, in real time, whether edited on the monday board's subitem cells **or** in the Deal Cockpit app — without the revert, and without a snapshot store.

## Decisions (locked with the user)

- **Edit surfaces:** both the monday board (subitem cells) and the Deal Cockpit app.
- **Board detection:** real-time — **add a new webhook on the subitems board** (not polling).
- **Authority model:** **event-source-wins.** A monday subitem event ⇒ monday is the source ⇒ patch HubSpot. A HubSpot line-item event (and the cron) ⇒ HubSpot is the source ⇒ forward-overwrite the subitem. No snapshot needed because real-time webhooks on both sides always identify the source of a change.
- **Currency (`hs_line_item_currency_code`):** deal-owned, **forward-only**. The monday Currency cell is display-only; excluded from reverse patches. Its display refreshes via the existing forward pass (line-item webhook / ≤10-min cron) whenever the deal currency changes — no special forward call is added (forcing one would risk clobbering an unsynced edit).
- **Removals:** **not synced from the board.** HubSpot (or the app, via `deleteLineItem`) stays the source of truth for a line item's *existence*. A subitem hard-deleted only on the board will reappear on the next forward sync — documented, expected behavior.

## Architecture — three trigger paths

| Trigger | Source of truth | Action | Status |
|---|---|---|---|
| **monday subitem webhook** (new) | monday | reverse: create (no id) / patch (has id) the HubSpot line item | **new** |
| **HubSpot line-item webhook** + **cron reconcile** | HubSpot | forward `syncLineItems` overwrites the subitem | unchanged |
| **App Line Items tab** (`/app/line-item`) | app → HubSpot | already full CRUD (create + writeback, patch, delete) | audit only |

Why this is clean: `syncMondayItem` (the deal-edit path) **does not** run the forward line-item overwrite (it calls `reconcileRecord` + `reverseAssociations` + `reverseLineItems`, never `syncAssociations`/`syncLineItems` — verified at `sync.ts:497-503`). The forward overwrite runs **only** on HubSpot-sourced events and the cron (`sync.ts:232`, `sync.ts:379`). So once a board edit patches HubSpot, the next forward tick reads the *new* value and stays consistent. The revert exists today purely because nothing patches HubSpot.

## Component 1 — New subitems-board webhook

**Registration (one-time ops step, not code).** Register a webhook on the **line-item subitems board `LINE_ITEM_SUBITEMS.boardId` = 5029480548** (the subitems board under the deals board 5029480547 — *not* the companies board 5029639440), pointing at the existing `POST /webhooks/monday` endpoint (`https://hubspot-monday-sync.askada.workers.dev/webhooks/monday`). Create it via the monday API `create_webhook` mutation **twice** — once with `event: change_column_value` and once with `event: change_name` — both on `board_id: 5029480548` (monday's `create_webhook` takes a single event, so a webhook per event type; both point at the same URL, and `handleMonday` echoes each subscription challenge). `change_name` covers renaming a line item on the board (the subitem name → HubSpot line-item `name`). No `create_pulse` subscription (creation is folded into the first column edit, see below); no delete subscription (removals not synced). This registration is a prerequisite for the whole feature — the plan includes it as an explicit step and records the returned webhook ids.

**Routing.** `handleMonday` computes `boardId`/`itemId`, then early-returns "ignored" when the board is not in `SPEC_BY_BOARD` — and the subitems board is not a top-level spec, so it would be dropped there. Add a dedicated branch **immediately after `itemId` is parsed and before the `if (!spec || !itemId)` early return**: if `ev.boardId === LINE_ITEM_SUBITEMS.boardId`, dispatch to a new `reverseSubitemEdit(env, ev, ...)` (coalesced **per subitem+column** — `sub:<subitemId>:<columnId>`, or `:name` for renames — because the handler processes only the one column in the event; a per-subitem key would collapse two rapid different-column edits and drop one) and return fast. This branch does its own column gating (the `ignoredColumns(spec)` guard is keyed on a `spec` the subitems board lacks, so it is bypassed).

**Handler `reverseSubitemEdit`:**
1. Read `subitemId = ev.pulseId`, `columnId = ev.columnId`, `type = ev.type`.
2. **Event/column gate.**
   - If `type === "change_name"`: the target field is the line-item **`name`** (see the Name row below). Read the subitem; if it has a Line Item ID → patch HubSpot `{name}` with the same **omit-empty** and **echo** guards (compare to HubSpot's current `name`); if it has no id → ignore (the create path sets the name). Return.
   - Else (`change_column_value`): map `columnId` to a `LINE_ITEM_SUBITEMS` field. Only **reverse-eligible** columns proceed (see field table). The id column, product-id column, status column, and the forward-only columns (Amount, Pre-discount Amount, Currency) map to nothing ⇒ **ignore** and return early (this also drops our own write-back echoes and any status/"Removed" edit, satisfying "removals not synced"). Doing the gate first means the common case of a non-reverse edit costs zero API calls.
3. **Read the subitem** (fresh) to get the changed column's current value and its "HubSpot Line Item ID".
4. **Branch on the Line Item ID:**
   - **Has an id → PATCH** (no parent-deal lookup needed — the subitem already carries the Line Item ID). Patch **only the changed field** to HubSpot via `patchLineItem`. Patching only the changed field (not the whole row) preserves event-source-wins: a HubSpot-side edit to a *different* field that hasn't forward-synced to monday yet is not reverted. The patch props come from the pure `buildSubitemReversePatch` (see Testable core), which applies:
     - **Value formatting** reusing the create path's rules: `colText(subitem, f.col).trim()`, and for a `date`-type field slice to `YYYY-MM-DD` (`v.slice(0,10)`) — exactly what `reverseLineItems` create does today.
     - **Omit-empty (never clear from an emptied board cell).** If the changed field's new value is **empty**, return `null` → send **no** patch. This honors the standing "never clear HubSpot because monday is empty" rule and the sync-lag reality. Consequence (documented limitation): you cannot *remove* a value (e.g., zero out a discount) from the board — do that in the app or HubSpot. A non-empty value patches normally.
     - **Echo suppression** via the type-aware compare against HubSpot's current value (step 5).
     - **Discount pair (the one deliberate clear).** When the changed field is non-empty and is one of the discount pair, also send the sibling as `""`: editing **Unit Discount** → `{discount:<v>, hs_discount_percentage:""}`; editing **Discount %** → `{hs_discount_percentage:<v>, discount:""}`. This sibling `""` is a deliberate mode-switch clear, the sole exception to omit-empty (it mirrors the app's "blank the other on mode-switch").
   - **No id → CREATE.** The rep typed a new line item on the board. Now resolve the parent deal: get the subitem's parent item (payload `ev.parentItemId` if present, else query `items(ids:[subitemId]){ parent_item { id } }`) and its HubSpot Deal ID (`DEALS.idCol`); if the deal isn't linked to HubSpot yet ⇒ skip (a later deal sync will carry it). Then reuse the existing `reverseLineItems` create logic **unchanged** (it already sends every non-`LI_CALCULATED` field — price, quantity, service_date, discount, discount%, currency, description — plus `hs_product_id` if the product-id column is set, and applies the **app-create grace period (90s)** and **name-dedup** guards, so a board create can't race the app's `/app/line-item` create into a duplicate). Currency on create is the deal-mirrored value already in the subitem, which is correct. Stamp the returned Line Item ID back onto the subitem.
5. **Echo vs. real-edit guard — in the PATCH branch (this is what makes both directions safe).** Both directions now write the same subitem columns, so the handler must tell a genuine rep edit from a forward-sync echo. The has-id branch fetches HubSpot's **current** value for the changed field (`getRecord("line_items", lineItemId, [prop])`) and passes it into `buildSubitemReversePatch` as `hubspotCurrentValue`; the pure function compares **type-aware** (numeric compare for `numbers`, date-normalized for `date`, trimmed string otherwise) and returns `null` when they match — an echo (the forward pass just wrote the subitem *from* HubSpot, so they're equal) — versus the patch props when they differ (a real rep edit). Type-aware comparison (not raw strings) also prevents a `"90"` vs `"90.00"` ping-pong. Respect the `LINE_ITEM_WRITE` scope gate; on a write-scope error, log and let the cron sweep.

**Testable core.** The pure decision — given `(columnId, subitemColumnValue, hubspotCurrentValue)` → the props map to patch, or `null` (ignore / no-op / omit-empty) — is factored into a pure function (e.g. `buildSubitemReversePatch`) with no monday/HubSpot I/O, mirroring the existing pure `lineItemHubspotProperties`. The webhook handler is the thin I/O shell around it. All the unit tests below target this function.

**Creation timing.** A bare new subitem (name only, no price) is not created in HubSpot; creation happens on the **first reverse-eligible column edit** (step 4, no-id branch). This avoids empty line items and folds create + patch into one id-keyed handler — which is why no `create_pulse` subscription is required.

## Component 2 — Per-field ownership on the 9 subitem columns

Add a `reverse: true` flag to the editable subitem fields in `LINE_ITEM_SUBITEMS`. No type change is needed: `SubitemSpec.fields` is `FieldSpec[]`, and `FieldSpec` already declares `reverse?: boolean` (`types.ts:29`). The flag gates the **patch** path only — a `change_column_value` triggers a reverse patch only for a `reverse`-flagged column. The **create** path is unchanged: `reverseLineItems` create already sends every non-`LI_CALCULATED` field (so it does not read `reverse`), which is fine because create establishes a fresh line item with no conflict.

| Subitem column | HubSpot prop | Direction |
|---|---|---|
| Unit Price | `price` | **two-way** (`reverse: true`) |
| Quantity | `quantity` | **two-way** |
| Service Date | `service_date` | **two-way** |
| Unit Discount | `discount` | **two-way** (clears `hs_discount_percentage`) |
| Discount % | `hs_discount_percentage` | **two-way** (clears `discount`) |
| Description | `description` | **two-way** |
| Amount (Net) | `amount` | forward-only (HubSpot-calculated) |
| Pre-discount Amount | `hs_pre_discount_amount` | forward-only (HubSpot-calculated) |
| Currency | `hs_line_item_currency_code` | forward-only (deal-owned) |

**Name** (the subitem's item name, `nameProps: ["name"]`) is also **two-way**, but it is not a `fields` entry, so it carries no `reverse` flag — it is handled directly in the handler's `change_name` branch (patch HubSpot line-item `name`, with the same omit-empty + echo guards). Forward, `syncLineItems` already sets the subitem name from HubSpot.

The forward `syncLineItems` is unchanged: it keeps writing **all** columns (including the forward-only ones) HubSpot→monday. `reverse: true` is consumed only by the reverse **patch** path; it must not alter forward behavior.

## Component 3 — App-edit path audit (no expected code change)

The app already does full CRUD to HubSpot: create (`/app/line-item` create branch + id write-back), update (`patchLineItem`), delete (`deleteLineItem`). The audit **verifies** that every editable attribute the app form exposes is included in the update payload, including the **extended, app-only props** with no board column — SKU (`hs_sku`), Brand ISV, Family, Product Subcategory, Tax rate (`hs_tax_rate_group_id`), Pricing model (`hs_pricing_model`), Billing frequency, Note, Is Active, Unit cost, Deposit. Those remain two-way **through the app only**, which is correct because the board cannot display them. If the audit finds a gap, close it; otherwise no code changes here.

## Error handling & idempotency

- Reverse patch is **id-keyed** (same Line Item ID) → never duplicates.
- Reverse create reuses the **grace-period + name-dedup** guards already in `reverseLineItems`.
- Webhook handler **coalesces per subitem+column** (in-isolate) so a burst of edits to the same cell collapses to the latest; cross-isolate safety comes from id-keyed patches (same Line Item ID) + the echo guard, not from coalescing.
- A failed reverse write logs and is swept by the next forward cron pass; the `LINE_ITEM_WRITE` scope gate is honored.
- **Echo vs. real-edit guard (critical).** Every write to a subitem column now fires this webhook — including the Worker's **own forward `syncLineItems` writes** and the app's writes. Because both directions touch the same columns, the reverse handler distinguishes them by a **type-aware equality compare against HubSpot's current value** (step 6): after a forward write the subitem already equals HubSpot → skip (echo); after a real rep edit it differs → patch. This mirrors the deals board's existing "value-diff no-ops an echo" guard (`webhooks.ts:116`). Note this does **not** risk an infinite loop even without the guard — a same-value HubSpot PATCH doesn't re-fire a HubSpot webhook — but without the guard *every* forward line-item write would trigger a wasteful redundant reverse PATCH (and could ping-pong on numeric formatting). `patchLineItem` itself has no equality check, so the compare MUST be done explicitly in the handler before calling it.

## Testing

Pure/unit (Worker, vitest):
- **Column→field mapping / gate:** reverse-eligible columns map to the right HubSpot prop; id/product/status/Amount/Pre-discount/Currency columns are ignored.
- **Discount pair:** editing Unit Discount (non-empty) produces `{discount:<v>, hs_discount_percentage:""}` and vice-versa.
- **Omit-empty:** an emptied changed value returns `null` (no patch) — HubSpot is never cleared from an empty board cell; the discount-sibling `""` is the only clear ever emitted, and only alongside a non-empty primary value.
- **Value formatting:** a `date` field is sliced to `YYYY-MM-DD`; numbers pass through as trimmed strings.
- **Patch-only-changed-field:** a quantity edit patches `{quantity}` only (no `price` in the payload).
- **Create vs patch branch:** id-less (past grace) → create with full field set; has-id → patch.
- **Name reverse:** a `change_name` on a subitem with a Line Item ID patches HubSpot `{name}` (omit-empty + echo guards apply); an id-less rename is ignored.
- **Grace/dedup:** id-less subitem younger than 90s → deferred; a same-name line item already on the deal → adopted, not duplicated.
- **Echo vs real-edit:** subitem value type-aware-equal to HubSpot's current value → `null` (no patch); differing → patch. Includes a numeric case (`"90"` vs `"90.00"` treated equal) so a forward write can't ping-pong.
- **Forward unchanged:** `syncLineItems` still writes forward-only columns; `reverse` flags don't change forward output.

Manual (live, on a test deal):
1. Edit a subitem's Unit Price on the board → HubSpot line item updates in ~seconds; it does **not** revert.
2. Edit Quantity/Service Date/Description/Discount on the board → each reaches HubSpot; a HubSpot-side edit to a different field is not reverted.
3. Toggle Unit Discount ↔ Discount % on the board → the sibling clears in HubSpot.
4. Add a new subitem on the board and set its price/qty → a HubSpot line item is created on the first column edit, associated, and the id is stamped back; no duplicate vs an app create.
4a. Rename a line item on the board → the HubSpot line-item name updates; it does not revert.
5. Edit a line item in the app → still patches HubSpot (unchanged); extended props (SKU, tax, pricing model…) persist.
6. Change the deal currency → line-item Currency cell refreshes from HubSpot within the forward window; the board Currency cell edit does **not** push.
7. Hard-delete a subitem only on the board → it reappears on the next forward sync (documented); removing in HubSpot/app removes it.

## Out of scope

- Board-side line-item **removal** sync (explicitly declined).
- Snapshot/shadow reconcile and polling detection (superseded by the real-time webhook).
- Any change to how the **app** edits line items beyond closing an audit gap if one is found.
- Extended props gaining board columns (they stay app-only).
