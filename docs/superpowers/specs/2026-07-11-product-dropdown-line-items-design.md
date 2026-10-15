# Product picker for line items (no new board) — Design

**Date:** 2026-07-11
**Status:** Approved

## Goal

When adding a line-item **subitem** on the raw monday board, pick a product from a searchable **"Product"
dropdown** holding all HubSpot product names (the catalog). The reverse line-item sync maps the picked name
to the HubSpot product and creates the HubSpot line item **tied to that product** (inherits its price). No
new board.

## Context

- HubSpot has **446 products** (name, price, SKU). HubSpot's own "Add line item" searches the product
  library by name/SKU (screenshot confirmed) — we mirror the name search via a monday dropdown.
- Reverse line-item sync already exists and already sends `hs_product_id` when a subitem's product-id column
  is set (`text_mm54hbvj`). The vibe app can set that id directly (robust). This adds the raw-board path.

## Confirmed decisions

1. **No new board** — use a single "Product" dropdown column on the subitems board.
2. It's **name-based** (the dropdown stores the product name). Accepted trade-off: fragile on duplicate or
   renamed products; the vibe-app id path (`text_mm54hbvj`) stays as the robust option.

## Architecture

### 1. "Product" single-select dropdown on the subitems board (5029480548)

- A `dropdown` column with `limit_select: true` (a line item = one product), seeded with all 446 product
  **names**. Kept fresh by a periodic re-seed (products change rarely; the vibe app's live `/app/search`
  covers instant search there).

### 2. `SubitemSpec.productNameCol`

Point it at the new dropdown column.

### 3. `reverseLineItems` resolves the picked product

For each id-less subitem, when creating the HubSpot line item, resolve the product in priority order:
- `productIdCol` (`text_mm54hbvj`) set -> use that id directly (vibe app / robust).
- else `productNameCol` set -> `findProductByName(name)` (HubSpot products search, exact-name match) -> use
  its id + price.
Then `createLineItem` with `hs_product_id` (+ `price` from the product); also write the product's Unit Price
(and name if the subitem is unnamed) back onto the subitem for display. Falls back to a plain custom line
item when nothing resolves.

### 4. `findProductByName` (hubspot.ts)

`POST /crm/v3/objects/products/search { query: name, properties: [name, price], limit: 20 }`, return the
result whose `name` matches exactly (first if several), else null.

## Testing

- **Unit:** `reverseLineItems` — a subitem with a `productNameCol` value resolves to the product id and sets
  `hs_product_id`; an exact-name miss creates a plain line item; the `productIdCol` path still wins when set.
- **Live:** on a deal subitem, pick a product name in the Product dropdown -> a HubSpot line item appears on
  the deal tied to that product (correct price); the subitem shows the product's unit price.

## Out of scope

- Searching products by SKU/description in monday (a dropdown only searches its labels = names).
- Instant catalog freshness on the board (periodic re-seed; the vibe app is live via `/app/search`).
