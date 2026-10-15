# Product dropdown for line items (no new board) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`). Tasks 1, 5 hit live monday/HubSpot — run inline.

**Goal:** A searchable "Product" dropdown on the subitems board (all 446 product names); the reverse line-item sync maps the picked name -> HubSpot product -> line item tied to that product.

---

## Task 1: Create + seed the "Product" dropdown on the subitems board

- [ ] **Step 1:** Create a single-select dropdown "Product" on board 5029480548 via API 2025-10-safe call: `create_column(board_id, title:"Product", column_type:dropdown, defaults:{"settings":{"limit_select":true}})`. Record the column id.
- [ ] **Step 2:** Seed it with all HubSpot product names (paginate `POST /crm/v3/objects/products/search` at limit 100; dedup names) via a temp item + `create_labels_if_missing` (one label per write, since single-select), then delete the temp item. Report seeded count.

---

## Task 2: findProductByName helper

**Files:** `worker/src/hubspot.ts`

- [ ] **Step 1:** `findProductByName(env, name) -> { id, name, price } | null`: `POST /crm/v3/objects/products/search { query:name, properties:["name","price"], limit:20 }`, return the result whose `name.trim() === name.trim()` (first if several), else null.
- [ ] **Step 2:** `npx tsc --noEmit` → clean.

---

## Task 3: SubitemSpec.productNameCol + config

**Files:** `worker/src/types.ts`, `worker/src/config.ts`

- [ ] **Step 1:** Add `productNameCol?: string` to `SubitemSpec`.
- [ ] **Step 2:** Set `productNameCol` on `LINE_ITEM_SUBITEMS` to the column id from Task 1.

---

## Task 4: reverseLineItems resolves the product (id, then name)

**Files:** `worker/src/associations.ts`; Test `worker/test/associations.test.ts`

- [ ] **Step 1: Failing test:** a subitem with a `productNameCol` value + a mocked `findProductByName` -> `createLineItem` props include `hs_product_id` (from the resolved product) and `price`; the `productIdCol` path still wins when both set.
- [ ] **Step 2: Implement** in `reverseLineItems`, before building props: resolve a product —
  `let productId = sub.productIdCol ? colText(s, sub.productIdCol).trim() : ""; let productPrice = "";`
  `if (!productId && sub.productNameCol) { const pn = colText(s, sub.productNameCol).trim(); if (pn) { const p = await findProductByName(env, pn); if (p) { productId = p.id; productPrice = p.price; if (!name) props["name"] = p.name; } } }`
  then `if (productId) props["hs_product_id"] = productId;` and if `productPrice && !props["price"]` set `props["price"] = productPrice`. Import `findProductByName`.
- [ ] **Step 3:** `npx tsc --noEmit && npx vitest run` → green.

---

## Task 5: Deploy + live verify

- [ ] **Step 1:** `npx wrangler deploy`.
- [ ] **Step 2 (live):** On a deal, add a subitem, pick a product name in the Product dropdown, touch the deal -> a HubSpot line item appears on the deal tied to that product (correct price). Clean up.

---

## Self-Review Notes

- **Spec coverage:** Product dropdown seeded (Task 1) ✔; name->id resolution with id-path priority (Task 4) ✔; findProductByName exact-match (Task 2) ✔; live verify (Task 5) ✔.
- **Type consistency:** `SubitemSpec.productNameCol` (Task 3) read in `reverseLineItems` (Task 4); `findProductByName` (Task 2) imported there.
- **Robust path preserved:** `productIdCol` (vibe app) still wins over the name dropdown.
