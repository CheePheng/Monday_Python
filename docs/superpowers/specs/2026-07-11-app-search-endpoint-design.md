# Worker /app/search endpoint (live HubSpot picker for the vibe app) — Design

**Date:** 2026-07-11
**Status:** Approved

## Goal

Let the monday vibe app search the FULL HubSpot dataset (92k contacts, 25k companies, the product library)
when building a deal, and pick any existing contact/company/product — without pre-syncing 100k+ records to
monday. Only the picked records land on monday (on-demand). Products chosen become line items that carry
`hs_product_id` so they inherit HubSpot pricing.

## Context

- Boards can't hold 92k contacts / 25k companies; the vibe app has no HubSpot access on its own.
- Reverse sync already exists: monday Connect-Boards links → HubSpot associations (live), monday subitems →
  HubSpot line items (built, dark behind `LINE_ITEM_WRITE`). On-demand card creation already brings a
  linked-but-missing contact/company onto monday (forward pass).
- The write token is read-only on line_items and lacks products scope (products search 403s today).

## Confirmed decisions

1. **Live-search HubSpot**, pull only the selected records to monday.
2. Line items are picked from the **HubSpot Product Library**.

## Architecture

### 1. `GET /app/search` (new Worker route)

- Query: `?type=contacts|companies|products&q=<text>&limit=<n≤20>`.
- Auth: header `X-App-Secret: <env.APP_SECRET>` (or reuse `TRIGGER_SECRET`); 403 otherwise.
- CORS: respond to `OPTIONS` preflight + `Access-Control-Allow-Origin: *`, `-Headers: X-App-Secret` (the
  app calls cross-origin).
- Body: `POST /crm/v3/objects/{type}/search` with `{ query: q, properties, limit }` (HubSpot full-text
  `query`). Map to `{ results: [{ id, name, secondary }] }`:
  - contacts: name = `firstname lastname` (fallback email); secondary = email.
  - companies: name = `name`; secondary = `domain`.
  - products: name = `name`; secondary = `price`.
- products returns a clear 403-passthrough note until `crm.objects.products.read` is granted.

### 2. Product → line item carries `hs_product_id`

- The vibe app adds a subitem for a chosen product and stores the product id in a subitem text column
  (`HubSpot Product ID`, new — or reuse an existing spare text column).
- `reverseLineItems` (already built) also sends `hs_product_id` when that column is set, so HubSpot links the
  line item to the product (inherits price/name).

### 3. Vibe app (prompt update)

Contacts/Companies/Line-item pickers call `/app/search`; on select, find-or-create the contact/company card
on its monday board (by HubSpot id) + link via Connect Boards; product → line-item subitem (name, price,
product id). No change to the create-on-monday behavior; reverse sync propagates to HubSpot.

### 4. Scopes (user, on the private/write app)

- `crm.objects.products.read` — search products.
- `crm.objects.line_items.write` — create line items (already needed for the dark line-item reverse).

## Testing

- **Unit:** the endpoint auth (403 without the secret), CORS preflight, and the HubSpot-result → `{id,name,
  secondary}` mapping per type (mock the HubSpot search); `reverseLineItems` includes `hs_product_id` when
  the product-id column is set.
- **Live:** `GET /app/search?type=contacts&q=docusign` returns matches; after the product scope is added,
  `type=products` returns catalog items; a product picked in the app creates a HubSpot line item tied to the
  product.

## Out of scope

- Paging beyond the first `limit` results (search is type-ahead; a tighter query narrows it).
- Writing contacts/companies from the app (the app find-or-creates monday cards; the existing sync enriches).
