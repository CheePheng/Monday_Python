# Worker /app/search endpoint + product line items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`). Task 4 = user action (scopes). Tasks 5-6 hit live APIs — run inline.

**Goal:** A `/app/search` Worker endpoint so the vibe app can live-search HubSpot contacts/companies/products; products picked become line items carrying `hs_product_id`.

**Architecture:** One new authed GET route in `index.ts` delegating to a `searchObjects` helper in `hubspot.ts`; `reverseLineItems` gains `hs_product_id`. Reuses existing reverse sync.

**Tech Stack:** Cloudflare Worker (TS, vitest), HubSpot CRM v3 search.

---

## Task 1: HubSpot search helper

**Files:** Modify `worker/src/hubspot.ts`; Test `worker/test/hubspot-search.test.ts` (new, pure mapping)

- [ ] **Step 1:** Add `searchObjects(env, type, q, limit)` → `POST /crm/v3/objects/{type}/search` with `{ query: q, properties, limit }` (properties per type: contacts `firstname,lastname,email`; companies `name,domain`; products `name,price`). Return `[{ id, name, secondary }]` mapping (name/secondary per the spec). Export a pure `mapSearchResult(type, props)` for unit testing.
- [ ] **Step 2:** Unit-test `mapSearchResult` for each type (contact name = "first last" / email fallback; company name/domain; product name/price).
- [ ] **Step 3:** `npx tsc --noEmit && npx vitest run` → green.

---

## Task 2: /app/search route (auth + CORS)

**Files:** Modify `worker/src/index.ts`, `worker/src/types.ts` (add `APP_SECRET?`)

- [ ] **Step 1:** Add to `fetch`: handle `OPTIONS` for `/app/search` → 204 with CORS headers (`Access-Control-Allow-Origin: *`, `Allow-Methods: GET,OPTIONS`, `Allow-Headers: X-App-Secret`).
- [ ] **Step 2:** Handle `GET /app/search`: require header `X-App-Secret === env.APP_SECRET` (fallback `TRIGGER_SECRET`) else 403; read `type` (validate in contacts|companies|products), `q`, `limit` (clamp ≤20); `const results = await searchObjects(env, type, q, limit)`; return `Response.json({ results }, { headers: cors })`. Catch a HubSpot 403 (products scope) → `Response.json({ results: [], error: "scope" }, { status: 200 })` so the app degrades gracefully.
- [ ] **Step 3:** `npx tsc --noEmit` → clean. Deploy later (Task 5).

---

## Task 3: reverseLineItems carries hs_product_id

**Files:** Modify `worker/src/config.ts` (add product-id subitem column const), `worker/src/associations.ts`; Test `worker/test/associations.test.ts`

- [ ] **Step 1:** Add a `productIdCol?` to `SubitemSpec` (types.ts) and set it on `LINE_ITEM_SUBITEMS` to a spare/new subitem text column ("HubSpot Product ID"). (Create the column via a one-off monday API call, record the id.)
- [ ] **Step 2: Failing test:** a subitem whose `productIdCol` holds a product id → `reverseLineItems` includes `hs_product_id` in the created line-item props.
- [ ] **Step 3: Implement:** in `reverseLineItems`, if `sub.productIdCol` and the subitem has a value there, set `props["hs_product_id"] = <that value>`.
- [ ] **Step 4:** `npx tsc --noEmit && npx vitest run` → green.

---

## Task 4: Scopes (USER ACTION)

- [ ] **Step 1:** On the private/write app (the Worker's `HUBSPOT_ACCESS_TOKEN`), add **`crm.objects.products.read`** and **`crm.objects.line_items.write`**; save + reinstall/regenerate. Confirm `type=products` search no longer 403s and a line-item create no longer 403s.

---

## Task 5: Deploy + enable + secrets

- [ ] **Step 1:** `wrangler secret put APP_SECRET` (a random string the vibe app will send).
- [ ] **Step 2:** `npx wrangler deploy`.
- [ ] **Step 3:** Once Task 4 is confirmed, set `LINE_ITEM_WRITE=true` (env var) and redeploy.
- [ ] **Step 4 (live):** `curl -H "X-App-Secret: <s>" ".../app/search?type=contacts&q=docusign"` → matches; `type=products&q=...` → catalog items.

---

## Task 6: Vibe app prompt update + full live verify

- [ ] **Step 1:** Update `docs/monday-vibe-deal-app-prompt.md`: the Contacts/Companies/Line-item pickers call `GET {worker}/app/search?type=…&q=…` (with the `X-App-Secret` header); on select, find-or-create the monday card + link (contacts/companies) or add a product line-item subitem (name, price, product id).
- [ ] **Step 2 (live):** In the app, create a deal picking a searched contact + company + product line item → the monday deal gets the links + subitem, and HubSpot gets the deal, both associations, and a line item tied to the product.

---

## Self-Review Notes

- **Spec coverage:** search endpoint per-type mapping (Task 1) ✔; auth + CORS + graceful products-403 (Task 2) ✔; product→line-item `hs_product_id` (Task 3) ✔; scopes (Task 4) ✔; secret + enable (Task 5) ✔; prompt + live verify (Task 6) ✔.
- **Type consistency:** `searchObjects`/`mapSearchResult` (Task 1) used by the route (Task 2); `SubitemSpec.productIdCol` (Task 3) read in `reverseLineItems`.
- **Graceful degradation:** products search returns `{results:[], error:"scope"}` (not a 500) until the scope lands, so the app's contact/company pickers work immediately.
