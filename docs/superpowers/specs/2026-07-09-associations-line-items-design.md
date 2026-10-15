# HubSpot Associations + Line Items → monday — Design

**Status:** Approved (2026-07-09). Direction: HubSpot → monday **only** (no reverse).

## Goal

Sync HubSpot **associations** and **deal line items** into monday, on top of the existing field sync:
- **Deal** → Associated Company, Associated Contact, Associated Line Items (as subitems).
- **Company** → Associated Contact.
- **Contact** → Associated Company, Associated Deal.

## Prerequisites (scopes)

Line items are **403 without a scope**. Both apps need `crm.objects.line_items.read`:
1. **Private App** (the Worker's `HUBSPOT_ACCESS_TOKEN`, `pat-na2-…`) — **user adds** it in HubSpot → Settings → Integrations → Private Apps → Scopes. Required for the Worker to *read* line items. *(Association reads for companies/contacts/deals already work — no new scope.)*
2. **Webhook app** (`app-hsmeta.json`) — scope added in this design; needs `hs project upload` + **re-install**. Required only if we want line-item *edits* to fire webhooks.

## Architecture — a separate "associations pass"

Associations don't fit the field-based `ObjectSpec` (they're related records, and line items are structured rows). Add a **one-directional pass** that runs *after* the normal field reconcile in the deal/company/contact sync paths. Because it's HubSpot-authoritative it does **not** touch Sync-State / direction logic (no reverse, no loop concerns).

**New HubSpot helpers (`hubspot.ts`):**
- `getAssociatedIds(fromObject, id, toObject) → string[]` — HubSpot v4 associations (`/crm/v4/objects/{from}/{id}/associations/{to}`, returns `toObjectId`s). Verified working.
- `getRecordsByIds(object, ids[], props) → HsRecord[]` — batch read (`/crm/v3/objects/{object}/batch/read`) for the associated names / line-item fields.

**New monday helpers (`monday.ts`):**
- `getSubitems(parentItemId) → MondayItem[]` (name + column_values incl. the id column).
- `createSubitem(parentItemId, name, cv)` (`create_subitem`); subitem column writes reuse `setColumns` (a subitem is an item); subitem removal reuses `deleteItem`.

**Config (`config.ts` / `types.ts`):** an optional `associations` block on `ObjectSpec` describing, per associated type, the target monday column (for company/contact/deal name lists) or the subitems mapping (for line items).

**Reconcile (`sync.ts`):** a new `syncAssociations(spec, rec, item, ctx, opts, budget)` called after `reconcileRecord` in the deal / contact / company paths. Runs on webhook syncs **and** the backup reconcile.

## monday columns to create (auto-created via the admin token; ids captured into config)

**Deal parent** `5029480547`: `Associated Company` (text), `Associated Contact` (text), `Line Items Summary` (long-text), `Line Items Count` (numbers), `Line Items Total Value` (numbers).

**Deal subitems** `5029480548`: `HubSpot Line Item ID` (text — dedup key), `Unit Price` (numbers), `Quantity` (numbers), `Amount` (numbers), `Net Price` (numbers), `Service Date` (date), `Unit Discount` (numbers), `Description` (long-text). Subitem **name** = line-item name.

**Company** `5029639440`: `Associated Contact` (text). **Contact** `5029639630`: `Associated Company` (text), `Associated Deal` (text).

## Data flow

**Deal:** fetch associated company ids → batch-read names → write comma-joined names to `Associated Company` (or **clear** if none); same for contacts. Line items: fetch line-item ids → batch-read fields → reconcile subitems (below) → rebuild parent `Line Items Summary` (e.g. `Name | Qty: 1 | Unit Price: 1500 | Net Price: 1500`), `Count`, `Total Value` (sum of amounts).

**Company:** associated contacts → `Associated Contact`. **Contact:** associated companies → `Associated Company`; associated deals → `Associated Deal`.

Association value is keyed on the **HubSpot Record ID** (never name); names are display only.

## Line-item subitems (dedup + removal)

- Index the deal card's existing subitems by the `HubSpot Line Item ID` column.
- Each HubSpot line item: subitem with that id exists → **update**; else → **create** one subitem (name = line-item name, columns mapped).
- A subitem whose Line Item ID is no longer on the deal → **delete the subitem** (recoverable ~30 days, consistent with the existing deal delete-sync). *(Not marking a Status column — keeps it consistent and clean.)*
- Never match subitems by name.

## Refresh + webhooks (documented limitation)

HubSpot association-change events are unreliable, so associations/line-items **refresh whenever the object's normal webhook fires** (any deal field change re-pulls associations + line items) **and** on the **backup reconcile** (10-min light + daily full). Optionally, line-item `object.propertyChange` webhooks (needs the app scope + a subscription) make a line-item *edit* instant; otherwise a line-item edit that doesn't touch a deal field syncs on the next backup tick (≤10 min). **This is acceptable and must be documented.**

## Logging

Structured, e.g.:
```
source=hubspot object=deal id=12345 association=companies count=1 action=updated-monday
source=hubspot object=deal id=12345 association=line_items count=2 action=updated-subitems
source=hubspot object=deal id=12345 line_item_id=999 subitem=567 action=updated-subitem
source=hubspot object=company id=777 association=contacts count=0 action=cleared-monday
```
`action ∈ created | updated | skipped | cleared | removed | error`.

## Testing (repo uses vitest)

1. Deal with 1 company + 1 contact + 1 line item. 2. Deal with multiple line items. 3. Existing line item qty/price change updates the **same** subitem. 4. Line item removed → subitem removed safely. 5. Company with 1 contact. 6. Contact with 1 company + 1 deal. 7. No associations → column cleared. 8. Missing monday column → log warning, don't crash. 9. Backup reconcile repairs stale association columns + subitems. 10. monday edits do NOT push associations/subitems back to HubSpot.

## Constraints / non-goals

- No project rewrite; existing field sync + delete sync untouched. No board-routing changes.
- Association fields are **HubSpot → monday only** (no reverse) — monday edits to association text/subitems are never pushed back (risk of mislinking).
- Never match by name — HubSpot Record ID / Line Item ID are the keys.

## Resolved in the plan (not a spec gap)

The **exact HubSpot property names** for Net Price / Service Date / Unit Discount couldn't be inspected (403). The plan's **first task** re-inspects a real line item (after the private-app scope is added) and pins the exact property names before the field mapping.
