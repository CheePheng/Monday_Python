# monday-first deal creation: reverse association + line-item sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`). Tasks 3, 5, 6 hit live monday/HubSpot with the local token — run inline. Task 4 is a user action (HubSpot scope + reinstall).

**Goal:** A deal created on the monday Deals board (by the vibe app) with contact/company Connect-Boards links + line-item subitems propagates to HubSpot — associations and line items included. Deal fields + `sales_user` already reverse; this adds reverse for **associations** and **line items**.

**Architecture:** Reverse runs on the **monday-edit path** (`syncMondayItem`), additive + set-only, so it never fights the authoritative forward pass (HubSpot→monday). Line-item reverse is **id-keyed** (creates only for subitems lacking a "HubSpot Line Item ID", then stamps it), so it's safe in the reconcile too.

**Tech Stack:** Cloudflare Worker (TS, vitest, wrangler), monday GraphQL, HubSpot CRM v3 (line_items) + v4 (associations).

---

## Task 1: HubSpot write helpers

**Files:** Modify `worker/src/hubspot.ts`; Test `worker/test/*` (light)

- [ ] **Step 1:** Add `putAssociation(env, fromObject, fromId, toObject, toId)` → `PUT /crm/v4/objects/{fromObject}/{fromId}/associations/default/{toObject}/{toId}` (idempotent; default association). Log + swallow individual failures.
- [ ] **Step 2:** Add `createLineItem(env, properties, dealId)` → `POST /crm/v3/objects/line_items` with `{ properties, associations: [{ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] }] }` (line_item→deal default type is 20). Returns the new id, or throws on 403 (missing scope) so the caller can log a clear "needs line_items.write" message.
- [ ] **Step 3:** `cd worker && npx tsc --noEmit` → clean.

---

## Task 2: Reverse association sync (additive, set-only)

**Files:** Modify `worker/src/associations.ts`, `worker/src/sync.ts`; Test `worker/test/associations.test.ts`

- [ ] **Step 1: Write failing test** (mocks already exist for getLinkedItemIds / getAssociatedIds / getRecordsByIds): reverse emits `putAssociation` only for links present in monday but missing in HubSpot; a fully-present set is a no-op.

```typescript
it("reverseAssociations PUTs monday links missing from HubSpot, skips present ones (additive)", async () => {
  H.assoc.set("deals:1:companies", ["11"]);            // HubSpot already has company 11
  H.links.set("100:conn_co", ["901", "902"]);          // monday deal 100 links cards 901,902
  H.targetHsId.set("901", "11"); H.targetHsId.set("902", "22"); // card -> its HubSpot id
  await reverseAssociations(env, relSpec, { id: "1", properties: {} }, item("100"), ctx, opts, budget());
  expect(H.puts).toEqual([["deals", "1", "companies", "22"]]); // only 22 is missing -> PUT; 11 skipped
});
```

- [ ] **Step 2:** Run → FAIL (`reverseAssociations` undefined).

- [ ] **Step 3: Implement** `reverseAssociations(env, spec, rec, item, ctx, opts, budget)` in `associations.ts`: for each `AssocSpec` with `relationCol`, `getLinkedItemIds(item.id, relationCol)` → for each linked card, read its HubSpot id off the target board (`getItem` column or a small query) → build the monday-side HubSpot-id set; `getAssociatedIds(spec.object, rec.id, toObject)` → the HubSpot set; `putAssociation` for each monday id NOT already in HubSpot. Never delete. Log `action=reverse-linked`/`skipped`.

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5: Wire into `syncMondayItem`** (`sync.ts`): for a deal that has a HubSpot id (linked), after `reconcileRecord`, call `reverseAssociations(env, spec, deal, item, ctx, opts, budget)`. Also call it right after `createFromMonday` succeeds (re-fetch the item's links once the deal has an id). NOT in the cron reconcile (avoids re-adding HubSpot-removed links).

- [ ] **Step 6:** `npx tsc --noEmit && npx vitest run` → green. Commit-ready.

---

## Task 3: Deploy + verify reverse associations

- [ ] **Step 1:** `npx wrangler deploy`.
- [ ] **Step 2 (live):** On a monday deal (already linked to HubSpot), add an "Associated Company" link to a company card → within seconds the HubSpot deal gains that company association (verify via `/crm/v4/objects/deals/{id}/associations/companies`). Same for a contact link.
- [ ] **Step 3:** Confirm additive: removing the link in monday does NOT remove the HubSpot association.

---

## Task 4: Enable line-item writes (USER ACTION)

- [ ] **Step 1:** In HubSpot, open the private app whose token is `HUBSPOT_ACCESS_TOKEN` (the Worker's write token — "monday sync"), add scope **`crm.objects.line_items.write`**, save, and reinstall / regenerate so the token gains write. Confirm by creating a throwaway line item via API (should no longer 403).

---

## Task 5: Reverse line-item sync (id-keyed, additive)

**Files:** Modify `worker/src/associations.ts`, `worker/src/sync.ts`; Test `worker/test/associations.test.ts`

- [ ] **Step 1: Write failing test:** a subitem with an EMPTY HubSpot Line Item ID → `createLineItem` is called with the mapped properties + the deal id, and the returned id is stamped back on the subitem; a subitem that already has an id → skipped (no create).

```typescript
it("reverseLineItems creates a HubSpot line item only for subitems lacking an id, then stamps it", async () => {
  H.subitems.set("100", [
    { id: "s1", name: "Widget", column_values: [{ id: LI.idCol, text: "" }, { id: "numeric_mm53rsfd", text: "50" }] },
    { id: "s2", name: "Synced", column_values: [{ id: LI.idCol, text: "31395364724" }] },
  ]);
  H.newLineItemId = "999";
  await reverseLineItems(env, LI, item("100"), "DEAL1", opts, budget());
  expect(H.createLineItem).toBe(1);                              // only s1 created
  expect(H.colOf("s1", LI.idCol)).toBe("999");                  // id stamped back
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** `reverseLineItems(env, sub, parentItem, dealHubspotId, opts, budget)`: `getSubitems(parentItem.id)` → for each subitem with empty `sub.idCol`, map its columns back to HubSpot line-item properties (`price`, `quantity`, `amount`, `hs_pre_discount_amount`, `service_date`, `discount`, `hs_line_item_currency_code`, `description`, name), `createLineItem(props, dealHubspotId)`, then `updateItem`/`setColumns` to write the new id onto `sub.idCol`. Additive (never delete). Guard the whole pass in a try/catch that logs "needs crm.objects.line_items.write" on 403.

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5: Wire in** `sync.ts`: call `reverseLineItems` from `syncMondayItem` (deal with a HubSpot id) AND from the cron reconcile deal loop (safe — id-keyed). Only attempt if a feature flag / env `LINE_ITEM_WRITE === "true"` is set, so it's dark until Task 4 is done.

- [ ] **Step 6:** `npx tsc --noEmit && npx vitest run` → green.

---

## Task 6: Deploy + live verify + the vibe app prompt

- [ ] **Step 1:** `npx wrangler deploy`; set `LINE_ITEM_WRITE=true` once Task 4 is confirmed.
- [ ] **Step 2 (live):** Create a deal on monday (vibe app) with a contact link, a company link, and one line-item subitem → within seconds the HubSpot deal has both associations + a line item; the subitem gets its HubSpot Line Item ID stamped (no duplicate on the next forward tick).
- [ ] **Step 3:** Deliver the finalized **monday vibe app prompt** (create/update deal + associations + line items, connected to the Deals/Contact/Company boards).

---

## Self-Review Notes

- **Spec coverage:** reverse associations additive/set-only (Task 2) ✔; reverse line items id-keyed (Task 5) ✔; scope gate for line items (Task 4 + env flag Task 5) ✔; loop-safety = reverse-assoc only on monday-edit path + line-items id-keyed (Task 2 Step 5, Task 5 Step 5) ✔; live verify both (Task 3, 6) ✔; vibe prompt (Task 6 Step 3) ✔.
- **Type consistency:** `putAssociation` / `createLineItem` (Task 1) consumed in Tasks 2/5; `reverseAssociations` / `reverseLineItems` wired in `syncMondayItem` (Tasks 2/5).
- **Loop safety:** reverse-assoc runs only when monday changed (never re-adds HubSpot-removed links because it's off in the reconcile); reverse-line-items only creates for id-less subitems, then stamps the id, so it can't re-create.
- **Dark launch:** line-item reverse is env-flag-gated so deploying before the scope exists is safe.
