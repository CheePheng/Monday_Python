# Deal Associations + Line Items → Linked on monday (Instant) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: Tasks 1, 3, 6, 7 touch live monday/HubSpot APIs with the local token and require the CLI environment — run inline, not via isolated subagents.

**Goal:** HubSpot deal Companies/Contacts + line items appear on the monday deal card as real Connect Boards links + subitems, instantly at creation and on change; same real-link treatment for Company↔Contact and Contact↔Deal.

**Architecture:** The relation-sync code is already built + unit-tested (`syncRelationColumn`, `findItemIdsByColumn`, `getLinkedItemIds`, `SPEC_BY_OBJECT`, `AssocSpec.relationCol`). This plan (a) creates the `board_relation` columns via monday API 2025-10, (b) wires their ids into config replacing the text columns, (c) adds HubSpot association-change + line-item webhooks and the Worker routing for them, (d) backfills, (e) deletes the old text columns after verification.

**Tech Stack:** Cloudflare Worker (TypeScript, vitest, wrangler), monday GraphQL (create in 2025-10, read/write in 2024-10), HubSpot developer-projects webhook app (`hs project upload` + reinstall), Python urllib one-time scripts.

---

## Task 1: Create the 5 Connect Boards columns via monday API (2025-10)

**Files:** one-time script in scratchpad (no repo file).

- [ ] **Step 1:** Run a Python script that, with header `API-Version: 2025-10`, calls `create_column(board_id, title, column_type: board_relation, defaults: {"boardIds":[<target>]})` five times:
  - Deals `5029480547`: "Associated Company" → `[5029639440]`; "Associated Contact" → `[5029639630]`
  - Contact `5029639630`: "Associated Company" → `[5029639440]`; "Associated Deal" → `[5029480547]`
  - Company `5029639440`: "Associated Contact" → `[5029639630]`
- [ ] **Step 2:** Print each returned `board_relation_*` id + `settings_str`; confirm each `settings_str` contains the right `boardIds`. Record the 5 ids for Task 2.

Expected: 5 ids like `board_relation_xxxx`, each with the correct target board in settings.

---

## Task 2: Wire relationCol into config, replace the text association columns

**Files:** Modify `worker/src/config.ts`

- [ ] **Step 1:** Replace each association's text `col` with `relationCol` = the id from Task 1. Deals:

```typescript
associations: [
  { toObject: "companies", nameProps: ["name"], relationCol: "<DEAL_REL_COMPANY>" },
  { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "<DEAL_REL_CONTACT>" },
  { toObject: "line_items", nameProps: ["name"], subitems: LINE_ITEM_SUBITEMS },
],
```

Company (`COMPANIES_MYLA`):
```typescript
associations: [
  { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "<COMPANY_REL_CONTACT>" },
],
```

Contact (`CONTACTS_MYLA`):
```typescript
associations: [
  { toObject: "companies", nameProps: ["name"], relationCol: "<CONTACT_REL_COMPANY>" },
  { toObject: "deals", nameProps: ["dealname"], relationCol: "<CONTACT_REL_DEAL>" },
],
```

Remove the now-unused text-column consts (`DEAL_ASSOC_COMPANY`, `DEAL_ASSOC_CONTACT`, `COMPANY_ASSOC_CONTACT`, `CONTACT_ASSOC_COMPANY`, `CONTACT_ASSOC_DEAL`).

- [ ] **Step 2:** `cd worker && npx tsc --noEmit && npx vitest run` → all green (the relation tests already assert the resolve/link/skip behaviour).
- [ ] **Step 3:** Commit-ready (user commits). Do NOT delete the text board columns yet (Task 7, after live verification).

---

## Task 3: Deploy + backfill links, verify creation-time links work

**Files:** one-time backfill script in scratchpad.

- [ ] **Step 1:** `cd worker && npx wrangler deploy` (name production; user-authorized deploy).
- [ ] **Step 2:** Backfill: touch every default-pipeline deal (and each contact/company) so `runAssociations` links them. Reuse the touch pattern (append+revert a name field); paced, in the background.
- [ ] **Step 3:** Live verify: query 3-4 deal cards → their "Associated Company"/"Associated Contact" `linked_item_ids` are populated with the right cards. Query a contact + a company card → their link columns populated.

Expected: link columns populated on sampled cards; `action=skipped` on a second run (no phantom writes).

---

## Task 4: Worker routing — association-change + line-item events

**Files:** Modify `worker/src/webhooks.ts`; Test `worker/test/webhook.test.ts`

- [ ] **Step 1: Write failing tests** for `extractObjectEvents` handling association-change, in `worker/test/webhook.test.ts`:

```typescript
it("routes an object.associationChange to a re-sync of the from-object", () => {
  const ev = { subscriptionType: "object.associationChange", objectTypeId: "0-3", fromObjectId: 9001, toObjectId: 5 };
  expect(extractObjectEvents(ev)).toEqual([{ type: "deal", id: "9001" }]);
});
it("routes a legacy deal.associationChange (objectId) to the deal", () => {
  const ev = { subscriptionType: "deal.associationChange", objectId: 9001, toObjectId: 5 };
  expect(extractObjectEvents(ev)).toEqual([{ type: "deal", id: "9001" }]);
});
it("association-change is NOT treated as a deletion", () => {
  const ev = { subscriptionType: "company.associationChange", objectId: 80010 };
  expect(extractObjectEvents(ev)).toEqual([{ type: "company", id: "80010" }]);
});
```

- [ ] **Step 2:** Run `npx vitest run test/webhook.test.ts` → FAIL (associationChange id not picked up; `fromObjectId` unread).

- [ ] **Step 3: Implement** in `extractObjectEvents` — add `fromObjectId` to the id sources and ensure `associationChange` is a normal update (not deletion). In the id extraction line add `e.fromObjectId`:

```typescript
let raw = e.objectId ?? e.fromObjectId ?? e.hs_object_id ?? e.dealId ?? e.vid ?? e.id ?? p.hs_object_id ?? p.dealId;
```

`type` resolution already handles `sub.startsWith("deal"|"contact"|"company")` and `OBJ_BY_TYPEID[objTypeId]`, so `deal.associationChange` and `object.associationChange`+`objectTypeId` both resolve. `deleted` stays false (`sub.split(".").pop()` is `"associationChange"`).

- [ ] **Step 4:** Run tests → PASS.

- [ ] **Step 5: Write failing test** for line-item → parent-deal extraction:

```typescript
it("extractLineItemIds pulls line_item ids (objectTypeId 0-8)", () => {
  const body = [{ subscriptionType: "object.propertyChange", objectTypeId: "0-8", objectId: 31395364724, propertyName: "price" }];
  expect(extractLineItemIds(body)).toEqual(["31395364724"]);
});
```

- [ ] **Step 6:** Run → FAIL (no `extractLineItemIds`).

- [ ] **Step 7: Implement** `extractLineItemIds(body)` in `worker/src/webhooks.ts` (mirrors `extractObjectEvents`, but keeps only `objectTypeId === "0-8"` / `subscriptionType` starting `line_item`, returning the line-item ids), and export it.

- [ ] **Step 8:** Run → PASS.

- [ ] **Step 9: Wire line items into `handleHubspot`** — after `extractObjectEvents`, resolve parent deals for any line-item ids and merge them into the deal re-syncs (bounded by the existing `MAX`):

```typescript
import { getAssociatedIds } from "./hubspot";
// ...after `const events = extractObjectEvents(body);`
const liIds = extractLineItemIds(body);
for (const liId of liIds.slice(0, MAX)) {
  try {
    const dealIds = await getAssociatedIds(env, "line_items", liId, "deals");
    for (const d of dealIds) events.push({ type: "deal", id: d });
  } catch (e) { console.log(`[webhook] line_item=${liId} action=error reason="${String(e).slice(0,120)}"`); }
}
```

(`events` is deduped downstream by the `coalesce` key `hs:deal:<id>:u`, so a line-item edit + its deal.associationChange collapse to one deal re-sync.)

- [ ] **Step 10:** `npx tsc --noEmit && npx vitest run` → all green. Commit-ready.

---

## Task 5: HubSpot app — association-change + line-item subscriptions + reinstall

**Files:** Modify `hubspot-monday-webhook-sync/src/app/webhooks/webhooks-hsmeta.json`

- [ ] **Step 1:** Add to `subscriptions.crmObjects`:

```json
{ "subscriptionType": "object.associationChange", "objectType": "deal", "active": true },
{ "subscriptionType": "object.associationChange", "objectType": "contact", "active": true },
{ "subscriptionType": "object.associationChange", "objectType": "company", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "price", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "quantity", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "amount", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "hs_pre_discount_amount", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "discount", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "hs_line_item_currency_code", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "hs_recurring_billing_period", "active": true }
```

- [ ] **Step 2:** From `hubspot-monday-webhook-sync/`, run `hs project upload` (creates a build). If HubSpot rejects `object.associationChange` or `line_item` for this platform version, record the exact error (VERIFICATION RISK): keep the association subs that ARE accepted, drop line-item property subs, and note that line-item price edits fall back to deal-edit/reconcile while add/remove stays instant via `deal.associationChange`.

- [ ] **Step 3:** Reinstall the app on the "Data Knowledge Management Ecosystem" account so the new scopes/subscriptions take effect (user does the click-through; confirm install status).

- [ ] **Step 4:** Tail Worker logs (`wrangler tail`) and confirm the real association-change payload shape matches `extractObjectEvents` (look for `fromObjectId` vs `objectId`); adjust Task 4 code to the observed shape if needed, redeploy.

---

## Task 6: Live end-to-end verification

- [ ] **Step 1:** In HubSpot, create a NEW deal in the Sales pipeline with an associated Company + Contact + one line item. Within seconds, the monday deal card shows: Associated Company link, Associated Contact link, and a line-item subitem.
- [ ] **Step 2:** Open an EXISTING deal, add another Contact (no other change). The monday card's Associated Contact link updates within seconds (proves association-change instant).
- [ ] **Step 3:** Edit that line item's price in HubSpot. The subitem's Unit Price updates (proves line-item instant; or, if line-item webhooks unsupported, note the fallback).
- [ ] **Step 4:** Remove the Contact association. The link clears.
- [ ] **Step 5:** Confirm the reverse boards: the Contact card's Associated Deal/Company links and the Company card's Associated Contact link are populated.

---

## Task 7: Delete the old text association columns (after verification passes)

**Files:** one-time script in scratchpad.

- [ ] **Step 1:** With Task 6 green, `delete_column` the 5 text columns: `text_mm53a30h`, `text_mm53k97q` (Deals); `text_mm53m5g0`, `text_mm53yyc3` (Contact); `text_mm5367qf` (Company).
- [ ] **Step 2:** Confirm the boards now show only the Connect Boards link columns for associations.

---

## Self-Review Notes

- **Spec coverage:** columns-via-API (Task 1) ✔; links replace text (Task 2, 7) ✔; instant-on-change (Task 4, 5) ✔; backfill (Task 3) ✔; testing unit+live (Task 4, 6) ✔; safety/skip-when-unchanged (already in `syncRelationColumn`, exercised Task 3 Step 3) ✔.
- **Type consistency:** `relationCol` (types.ts) used in config Task 2; `extractLineItemIds` new export used in `handleHubspot`; `getAssociatedIds(env, "line_items", id, "deals")` matches the existing hubspot.ts signature.
- **Verification risks are explicit** (Task 5 Step 2, Task 4 Step 4): association-change payload shape + line-item webhook support, each with a stated fallback.
- **Ordering:** text columns are deleted only in Task 7, after Task 6 confirms links populate — no data lost if something needs rework.
