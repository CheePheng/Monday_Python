# Two-Way Line-Item Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every rep-editable line-item attribute sync both directions in real time — a monday board subitem edit patches HubSpot (no more revert), while HubSpot edits keep flowing forward — via a new subitems-board webhook plus per-field reverse ownership.

**Architecture:** Event-source-wins. A new webhook on the line-item subitems board (5029480548) routes a subitem `change_column_value`/`change_name` to `reverseSubitemEdit`, which patches only the changed field on that HubSpot line item (or creates via the existing `reverseLineItems` for id-less rows). Forward `syncLineItems` is unchanged. A type-aware equality compare against HubSpot's current value distinguishes a real rep edit from a forward-sync echo, so both directions writing the same columns is safe.

**Tech Stack:** Cloudflare Worker (TypeScript), monday GraphQL API 2026-07, HubSpot CRM v3, vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-two-way-line-item-sync-design.md`

**Toolchain (MUST follow):** Work in `worker/`. Typecheck ONLY with `./node_modules/.bin/tsc --noEmit` (NEVER `npx tsc` — wrong package). Tests: `./node_modules/.bin/vitest run`. Commit code from the repo root with the exact messages below; **NO `Co-Authored-By: Claude` trailer** (the user is the sole author). Do NOT commit `docs/`. Do NOT deploy/push until Task 6. Branch: `feat/deals-single-board` (do not switch).

**Verified facts (from the code, do not re-derive):**
- `LINE_ITEM_SUBITEMS` (`worker/src/config.ts:65-81`): `boardId:"5029480548"`, `idCol:"text_mm53ds6w"`, `statusCol:"status"`, `productIdCol:"text_mm54hbvj"`, and `fields` with these `{hs, col, type}`: price→`numeric_mm53rsfd`(numbers), quantity→`numeric_mm531345`(numbers), hs_pre_discount_amount→`numeric_mm53txgw`(numbers), amount→`numeric_mm538yj9`(numbers), service_date→`date_mm53chbv`(date), discount→`numeric_mm53pkyf`(numbers), hs_discount_percentage→`numeric_mm5ax22v`(numbers), hs_line_item_currency_code→`text_mm538b8k`(text), description→`long_text_mm53a511`(long_text).
- `FieldSpec` (`worker/src/types.ts:24-29`) already has `reverse?: boolean` — no type change needed.
- `patchLineItem(env, lineItemId, properties: Record<string,string>, opts): Promise<boolean>` (`hubspot.ts:169`).
- `getRecord(env, object, id, properties: string[]): Promise<{id, properties}|null>` (`hubspot.ts:80`).
- `getItem(env, itemId): Promise<MondayItem|null>` (`monday.ts:62`) — works for a subitem; `ITEM_FIELDS` returns `id name created_at column_values{...}` but NOT `parent_item`.
- `colText(item, colId): string` (`dedup.ts:3`).
- `reverseLineItems(env, sub, parentItem, dealHubspotId, opts, budget)` (`associations.ts:68`) — create-only, id-less subitems, 90s grace + name-dedup.
- `DEALS.idCol = "numeric_mm4nz332"` (`config.ts:94`).
- `handleMonday` (`webhooks.ts:90-129`) parses `ev.boardId/pulseId/type/columnId`, early-returns "ignored" for boards not in `SPEC_BY_BOARD`; uses `coalesce(key, fn)` and `liveOpts(env)`.
- Test convention: pure functions are unit-tested (e.g. `test/line-item-props.test.ts`); I/O handlers are verified live (e.g. `test/webhook.test.ts` tests only pure extractors).

---

## Task 1: Reverse-patch decision (pure) + per-field `reverse` flags

**Files:**
- Modify: `worker/src/config.ts` (add `reverse: true` to 6 subitem fields)
- Create: `worker/src/line-item-reverse.ts`
- Create: `worker/test/line-item-reverse.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `worker/test/line-item-reverse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSubitemReversePatch, subitemFieldByCol, liValueEqual } from "../src/line-item-reverse";

// column ids from LINE_ITEM_SUBITEMS
const PRICE = "numeric_mm53rsfd";
const QTY = "numeric_mm531345";
const AMOUNT = "numeric_mm538yj9";          // forward-only (calc)
const CURRENCY = "text_mm538b8k";           // forward-only (deal-owned)
const SERVICE_DATE = "date_mm53chbv";
const DISCOUNT = "numeric_mm53pkyf";
const DISCOUNT_PCT = "numeric_mm5ax22v";
const DESCRIPTION = "long_text_mm53a511";
const ID_COL = "text_mm53ds6w";             // not a field

describe("subitemFieldByCol / reverse flags", () => {
  it("editable columns are reverse-eligible", () => {
    for (const c of [PRICE, QTY, SERVICE_DATE, DISCOUNT, DISCOUNT_PCT, DESCRIPTION])
      expect(subitemFieldByCol(c)?.reverse).toBe(true);
  });
  it("calc + currency columns are NOT reverse-eligible", () => {
    for (const c of [AMOUNT, CURRENCY, "numeric_mm53txgw" /* pre_discount */])
      expect(subitemFieldByCol(c)?.reverse).toBeFalsy();
  });
  it("unknown / id column maps to no field", () => {
    expect(subitemFieldByCol(ID_COL)).toBeUndefined();
    expect(subitemFieldByCol("bogus")).toBeUndefined();
  });
});

describe("liValueEqual (type-aware)", () => {
  it("numbers compare numerically (90 vs 90.00)", () => expect(liValueEqual("numbers", "90", "90.00")).toBe(true));
  it("numbers differ", () => expect(liValueEqual("numbers", "90", "99")).toBe(false));
  it("dates compare by first 10 chars", () => expect(liValueEqual("date", "2026-08-04", "2026-08-04T00:00:00Z")).toBe(true));
  it("text trimmed compare", () => expect(liValueEqual("text", " x ", "x")).toBe(true));
});

describe("buildSubitemReversePatch", () => {
  it("non-reverse column (amount) -> null", () =>
    expect(buildSubitemReversePatch(AMOUNT, "123", "0")).toBeNull());
  it("currency column -> null", () =>
    expect(buildSubitemReversePatch(CURRENCY, "USD", "CNY")).toBeNull());
  it("unknown column -> null", () =>
    expect(buildSubitemReversePatch(ID_COL, "x", "")).toBeNull());
  it("empty value -> null (omit-empty, never clear from an empty cell)", () =>
    expect(buildSubitemReversePatch(PRICE, "  ", "99")).toBeNull());
  it("price differs from HubSpot -> patch price only", () =>
    expect(buildSubitemReversePatch(PRICE, "90", "99")).toEqual({ price: "90" }));
  it("price equals HubSpot (90 vs 90.00) -> null (echo)", () =>
    expect(buildSubitemReversePatch(PRICE, "90", "90.00")).toBeNull());
  it("quantity edit patches quantity only (no price)", () =>
    expect(buildSubitemReversePatch(QTY, "3", "1")).toEqual({ quantity: "3" }));
  it("unit discount patches discount and clears the % sibling", () =>
    expect(buildSubitemReversePatch(DISCOUNT, "5", "")).toEqual({ discount: "5", hs_discount_percentage: "" }));
  it("discount % patches it and clears the amount sibling", () =>
    expect(buildSubitemReversePatch(DISCOUNT_PCT, "10", "")).toEqual({ hs_discount_percentage: "10", discount: "" }));
  it("service date is sliced to YYYY-MM-DD", () =>
    expect(buildSubitemReversePatch(SERVICE_DATE, "2026-08-04T00:00:00Z", "")).toEqual({ service_date: "2026-08-04" }));
  it("service date equal after slice -> null (echo)", () =>
    expect(buildSubitemReversePatch(SERVICE_DATE, "2026-08-04", "2026-08-04")).toBeNull());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run line-item-reverse`
Expected: FAIL — `Cannot find module '../src/line-item-reverse'`.

- [ ] **Step 3: Add `reverse: true` to the six editable subitem fields**

In `worker/src/config.ts`, inside `LINE_ITEM_SUBITEMS.fields` (lines 70-80), add `reverse: true` to exactly these six (leave `hs_pre_discount_amount`, `amount`, `hs_line_item_currency_code` untouched):

```ts
  fields: [
    { hs: "price", col: "numeric_mm53rsfd", type: "numbers", reverse: true },                    // Unit Price
    { hs: "quantity", col: "numeric_mm531345", type: "numbers", reverse: true },                 // Quantity
    { hs: "hs_pre_discount_amount", col: "numeric_mm53txgw", type: "numbers" },                  // Amount (pre-discount) — calc, forward-only
    { hs: "amount", col: "numeric_mm538yj9", type: "numbers" },                                  // Net Price — calc, forward-only
    { hs: "service_date", col: "date_mm53chbv", type: "date", reverse: true },                   // Service Date
    { hs: "discount", col: "numeric_mm53pkyf", type: "numbers", reverse: true },                 // Unit Discount (amount)
    { hs: "hs_discount_percentage", col: "numeric_mm5ax22v", type: "numbers", reverse: true },   // Discount %
    { hs: "hs_line_item_currency_code", col: "text_mm538b8k", type: "text" },                    // Currency — deal-owned, forward-only
    { hs: "description", col: "long_text_mm53a511", type: "long_text", reverse: true },          // Description
  ],
```

- [ ] **Step 4: Create the pure module**

Create `worker/src/line-item-reverse.ts`:

```ts
import { LINE_ITEM_SUBITEMS } from "./config";
import type { FieldSpec } from "./types";

// The two mutually-exclusive discount modes: setting one clears the other in HubSpot.
const DISCOUNT_SIBLING: Record<string, string> = {
  discount: "hs_discount_percentage",
  hs_discount_percentage: "discount",
};

/** The LINE_ITEM_SUBITEMS field mapped to a monday subitem column id, or undefined (id/status/product/unknown). */
export function subitemFieldByCol(colId: string): FieldSpec | undefined {
  return LINE_ITEM_SUBITEMS.fields.find(f => f.col === colId);
}

/** Type-aware equality: numbers compared numerically (90 == 90.00), dates by first 10 chars, else trimmed string. */
export function liValueEqual(type: string, a: string, b: string): boolean {
  const A = (a ?? "").trim(), B = (b ?? "").trim();
  if (type === "numbers") {
    const na = Number(A), nb = Number(B);
    if (A !== "" && B !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return A === B;
  }
  if (type === "date") return A.slice(0, 10) === B.slice(0, 10);
  return A === B;
}

/**
 * PURE reverse-patch decision for one subitem column edit.
 * @param columnId            the monday subitem column that changed
 * @param subitemColumnValue  its current value (from colText)
 * @param hubspotCurrentValue HubSpot's current value for the mapped property (for echo suppression)
 * @returns the HubSpot props to PATCH, or null to send nothing
 *          (non-reverse column / empty value / echo).
 */
export function buildSubitemReversePatch(
  columnId: string, subitemColumnValue: string, hubspotCurrentValue: string,
): Record<string, string> | null {
  const f = subitemFieldByCol(columnId);
  if (!f || !f.reverse) return null;                                   // not reverse-eligible (calc/currency/id/status/unknown)
  const raw = (subitemColumnValue ?? "").trim();
  if (raw === "") return null;                                         // omit-empty: never clear HubSpot from an empty cell
  const value = f.type === "date" ? raw.slice(0, 10) : raw;
  if (liValueEqual(f.type, value, hubspotCurrentValue ?? "")) return null; // echo: already equals HubSpot -> no patch
  const props: Record<string, string> = { [f.hs]: value };
  const sibling = DISCOUNT_SIBLING[f.hs];
  if (sibling) props[sibling] = "";                                    // discount mode-switch: clear the other mode
  return props;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run line-item-reverse`
Expected: PASS (all cases).

- [ ] **Step 6: Full gate**

Run: `./node_modules/.bin/tsc --noEmit` (clean) and `./node_modules/.bin/vitest run` (all green — existing suites unaffected by the config flags).

- [ ] **Step 7: Commit**

```bash
git add worker/src/config.ts worker/src/line-item-reverse.ts worker/test/line-item-reverse.test.ts
git commit -m "feat(worker): reverse-patch decision for line items + per-field reverse flags"
```

---

## Task 2: `getParentItemId` helper + `reverseSubitemEdit` handler

**Files:**
- Modify: `worker/src/monday.ts` (add `getParentItemId`)
- Modify: `worker/src/associations.ts` (add `reverseSubitemEdit`; extend imports)

No unit test: both are I/O (monday GraphQL + HubSpot), which this codebase verifies live, not in vitest (see `test/webhook.test.ts`, which tests only pure extractors). Correctness of the decision logic is covered by Task 1's pure tests; the handler is exercised in the Task 6 live smoke.

- [ ] **Step 1: Add `getParentItemId` to `worker/src/monday.ts`**

Add after `getSubitems` (after line 72):

```ts
/** The parent item id of a subitem (a line-item subitem's parent is the deal card). Null if none/deleted. */
export async function getParentItemId(env: Env, subitemId: string): Promise<string | null> {
  const data = await gql(env, `query ($i:[ID!]) { items(ids:$i) { parent_item { id } } }`, { i: [subitemId] });
  const pid = data.items?.[0]?.parent_item?.id;
  return pid ? String(pid) : null;
}
```

- [ ] **Step 2: Extend imports in `worker/src/associations.ts`**

Replace **lines 2, 3, 4** with the versions below and **add** the new `./line-item-reverse` line. Leave line 1 (`import type {...} from "./types"`) and lines 5-8 (`./ensure-card`, `./mapping`, `./routing`, `./dedup`) exactly as they are:

```ts
import { createLineItem, getAssociatedIds, getRecord, getRecordsByIds, patchLineItem, propertiesForSpec, putAssociation } from "./hubspot";
import { createItem, createSubitem, deleteItem, findItemIdsByColumn, getItem, getItemsColumnText, getLinkedItemIds, getParentItemId, getSubitems, setColumns, updateItem } from "./monday";
import { DEALS, LINE_ITEM_SUBITEMS, SPEC_BY_OBJECT } from "./config";
import { buildSubitemReversePatch, subitemFieldByCol } from "./line-item-reverse";
```

Changes vs. current: `getRecord`, `patchLineItem` added from `./hubspot` (line 2); `getItem`, `getParentItemId` added from `./monday` (line 3); `DEALS`, `LINE_ITEM_SUBITEMS` added from `./config` (line 4); the `./line-item-reverse` import is new.

- [ ] **Step 3: Add the `reverseSubitemEdit` handler to `worker/src/associations.ts`**

Add at the end of the file (after `reverseLineItems`):

```ts
/**
 * REVERSE a single monday line-item subitem edit -> HubSpot (event-source-wins; monday is the source).
 * change_name -> patch the line-item `name`. change_column_value -> patch the one reverse-eligible field
 * (has id) or create the line item (no id, via reverseLineItems' grace + dedup). Echo-suppressed and
 * omit-empty via buildSubitemReversePatch. HubSpot writes gated on LINE_ITEM_WRITE.
 */
export async function reverseSubitemEdit(env: Env, ev: any, opts: RunOpts, budget: Budget): Promise<void> {
  if (env.LINE_ITEM_WRITE !== "true") return;
  const sub = LINE_ITEM_SUBITEMS;
  const subitemId = String(ev.pulseId ?? ev.itemId ?? "");
  const type = String(ev.type ?? "");
  const columnId = ev.columnId ? String(ev.columnId) : "";
  if (!subitemId) return;

  // --- Rename: subitem name -> HubSpot line-item `name` (omit-empty + echo) ---
  if (type === "change_name") {
    const item = await getItem(env, subitemId);
    if (!item) return;
    const liId = colText(item, sub.idCol);
    if (!liId) return;                                   // no id -> the create path owns the name
    const newName = (item.name ?? "").trim();
    if (!newName) return;                                // omit-empty
    const cur = await getRecord(env, "line_items", liId, ["name"]);
    if (cur && (String(cur.properties.name ?? "")).trim() === newName) return; // echo
    await patchLineItem(env, liId, { name: newName }, opts); budget.left--;
    console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId} action=patched-name`);
    return;
  }

  if (type !== "change_column_value") return;
  const f = subitemFieldByCol(columnId);
  if (!f || !f.reverse) return;                          // gate first: non-reverse column costs 0 API calls

  const item = await getItem(env, subitemId);
  if (!item) return;
  const liId = colText(item, sub.idCol);
  const value = colText(item, f.col);

  // --- Has id -> PATCH the single changed field ---
  if (liId) {
    const cur = await getRecord(env, "line_items", liId, [f.hs]);
    const hsVal = cur ? String(cur.properties[f.hs] ?? "") : "";
    const props = buildSubitemReversePatch(columnId, value, hsVal);
    if (!props) return;                                  // echo / omit-empty
    await patchLineItem(env, liId, props, opts); budget.left--;
    console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId} action=patched cols=${Object.keys(props).join(",")}`);
    return;
  }

  // --- No id -> CREATE via the existing reverse pass (grace period + name-dedup) ---
  const parentId = await getParentItemId(env, subitemId);
  if (!parentId) return;
  const parent = await getItem(env, parentId);
  if (!parent) return;
  const dealId = colText(parent, DEALS.idCol);
  if (!dealId) return;                                   // deal not linked to HubSpot yet; a later sync carries it
  await reverseLineItems(env, sub, parent, dealId, opts, budget);
}
```

- [ ] **Step 4: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: clean. (If `getItem` was already imported elsewhere in `associations.ts`, dedupe the import; if `RunOpts`/`Budget` types aren't already imported, they are — see line 1.)

- [ ] **Step 5: Run the full suite**

Run: `./node_modules/.bin/vitest run`
Expected: all green (no behavior change to existing paths; new handler is not yet wired).

- [ ] **Step 6: Commit**

```bash
git add worker/src/monday.ts worker/src/associations.ts
git commit -m "feat(worker): reverseSubitemEdit handler + getParentItemId"
```

---

## Task 3: Route subitem-board webhooks to `reverseSubitemEdit`

**Files:**
- Modify: `worker/src/webhooks.ts` (add a branch in `handleMonday`; extend imports)

- [ ] **Step 1: Extend imports in `worker/src/webhooks.ts`**

The current imports are `import { SPEC_BY_BOARD } from "./config";` (line 2) and there is no `./associations` import. Change line 2 and add one new line:

```ts
import { SPEC_BY_BOARD, LINE_ITEM_SUBITEMS } from "./config";
import { reverseSubitemEdit } from "./associations";
```

(No import cycle: `associations.ts` does not import `webhooks.ts`.)

- [ ] **Step 2: Add the routing branch in `handleMonday`**

In `worker/src/webhooks.ts`, immediately **after** `const spec = SPEC_BY_BOARD[boardId];` (line 103) and **before** `if (!spec || !itemId)` (line 105), insert:

```ts
  // Line-item subitem edits (subitems board 5029480548) reverse to HubSpot. That board is NOT in
  // SPEC_BY_BOARD, so route it explicitly before the "board not configured" drop. Handles both
  // change_column_value (field patch / create) and change_name (line-item rename).
  // Coalesce PER SUBITEM+COLUMN (not per subitem): reverseSubitemEdit only processes the one column
  // in `ev`, so a per-subitem key would collapse two rapid edits to different columns and drop one.
  if (boardId === LINE_ITEM_SUBITEMS.boardId && itemId) {
    console.log(`[webhook] source=monday board=${boardId} subitem=${itemId} type=${type}${columnId ? ` col=${columnId}` : ""} action=received-line-item`);
    const coKey = type === "change_name" ? `sub:${itemId}:name` : `sub:${itemId}:${columnId}`;
    ectx.waitUntil(coalesce(coKey, () => reverseSubitemEdit(env, ev, liveOpts(env), { left: 30 }))
      .catch(e => console.log(`[webhook] source=monday subitem=${itemId} action=error reason="${String(e).slice(0, 160)}"`)));
    return new Response("ok");
  }
```

- [ ] **Step 3: Typecheck + full suite**

Run: `./node_modules/.bin/tsc --noEmit` (clean) and `./node_modules/.bin/vitest run` (all green — existing `webhook.test.ts` pure-extractor tests unaffected; the branch is I/O, verified live in Task 6).

- [ ] **Step 4: Commit**

```bash
git add worker/src/webhooks.ts
git commit -m "feat(worker): route subitems-board webhooks to reverse line-item sync"
```

---

## Task 4: Register the subitems-board webhook (one-time ops)

**Files:**
- Create: `worker/scripts/register-subitem-webhook.mjs`

This is a prerequisite for the whole feature — without the webhook, monday never notifies the Worker of a subitem edit. It is a one-time registration (like the deals-board webhook), run once against the monday API. It needs the monday API token in `MONDAY_CODE_ACCESS_TOKEN` (the same token used for `mapps`).

- [ ] **Step 1: Create the registration script**

Create `worker/scripts/register-subitem-webhook.mjs`:

```js
// One-time: register monday webhooks on the line-item subitems board so board edits reverse to HubSpot.
// Usage (from repo root):  MONDAY_CODE_ACCESS_TOKEN=<token> node worker/scripts/register-subitem-webhook.mjs
const TOKEN = process.env.MONDAY_CODE_ACCESS_TOKEN;
if (!TOKEN) { console.error("Set MONDAY_CODE_ACCESS_TOKEN"); process.exit(1); }
const BOARD = "5029480548"; // LINE_ITEM_SUBITEMS.boardId
const URL = "https://hubspot-monday-sync.askada.workers.dev/webhooks/monday";
const EVENTS = ["change_column_value", "change_name"];

async function createWebhook(event) {
  const query = `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) {
    create_webhook(board_id: $b, url: $u, event: $e) { id board_id event }
  }`;
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables: { b: BOARD, u: URL, e: event } }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(`${event}: ${JSON.stringify(j.errors)}`);
  return j.data.create_webhook;
}

for (const e of EVENTS) {
  try { console.log("created", JSON.stringify(await createWebhook(e))); }
  catch (err) { console.error("FAILED", e, String(err).slice(0, 300)); }
}
```

- [ ] **Step 2: Run it once (records the webhook ids)**

Run (from repo root): `MONDAY_CODE_ACCESS_TOKEN=<token> node worker/scripts/register-subitem-webhook.mjs`
Expected: two `created {...}` lines, each with an `id`, `board_id: "5029480548"`, and the event. If monday rejects `change_name` as an invalid `WebhookEventType`, log the raw error and keep the `change_column_value` webhook (the core edit/patch path); revisit the name event in Step 3.

- [ ] **Step 3: Confirm the subscription challenge succeeded**

The Worker already echoes monday's `{challenge}` (`webhooks.ts:96`). A successfully created webhook means monday's challenge was answered. Record the returned webhook ids (paste into the PR/commit description or a note) so they can be deleted later if needed via `delete_webhook`.

- [ ] **Step 4: Commit the script**

```bash
git add worker/scripts/register-subitem-webhook.mjs
git commit -m "chore(worker): one-time subitems-board webhook registration script"
```

---

## Task 5: Audit the app-edit line-item path (Component 3)

**Files (read/verify; edit only if a gap is found):**
- `monday-app/src/views/LineItemForm.tsx`, `monday-app/src/lib/line-item-form.ts` (the form fields)
- `monday-app/src/worker-client.ts` (`createHubspotLineItem` / update payload)
- `worker/src/app-routes.ts` (`parseLineItemBody`), `worker/src/line-item-props.ts` (`LINE_ITEM_WRITE_PROPS`), `worker/src/index.ts` (`/app/line-item` update branch → `patchLineItem`)

The app already does full CRUD to HubSpot (create + id write-back, `patchLineItem` update, `deleteLineItem`). This task confirms every editable attribute the form exposes is actually sent on update.

- [ ] **Step 1: List the form's editable fields**

Read `LineItemForm.tsx` / `lib/line-item-form.ts` and enumerate every editable field descriptor (name, price, quantity, discount, discount%, service_date, description, hs_sku, brand_isv, family, product_subcategory, is_active, note, recurringbillingfrequency, hs_recurring_billing_start_date, hs_tax_rate_group_id, hs_pricing_model, hs_cost_of_goods_sold, deposit).

- [ ] **Step 2: Confirm each is in the write allowlist**

For each field's HubSpot prop, confirm `LINE_ITEM_WRITE_PROPS.has(prop) === true`. The existing test `worker/test/line-item-props.test.ts` already asserts this for the full list — run it: `./node_modules/.bin/vitest run line-item-props` (Expected: PASS). Confirm the form exposes no editable prop that is missing from that list.

- [ ] **Step 3: Confirm the update path sends the loaded fields**

Trace `LineItemsEditor` save → `worker-client` update call → `/app/line-item` update branch → `patchLineItem`. Confirm the update payload is built from the form values (the Phase 3 fresh-on-open hydration loads extended props, so a save carries them). Confirm no editable field is dropped between form and payload.

- [ ] **Step 4: Record the result**

If everything is covered (expected): no code change; note "app path audit: complete, all editable props flow" in the commit/PR description. If a gap is found (an editable form field whose prop is not sent on update, or not in `LINE_ITEM_WRITE_PROPS`), fix the smallest thing — add the prop to the payload or to `LINE_ITEM_WRITE_PROPS` — with a one-line test, and commit:

```bash
# only if a gap was found and fixed:
git add worker/src/line-item-props.ts worker/test/line-item-props.test.ts
git commit -m "fix(worker): include <prop> in the line-item write allowlist"
```

If no gap: no commit for this task.

---

## Task 6: Deploy + live verification

**Files:** none (ops).

- [ ] **Step 1: Full gate**

Run (in `worker/`): `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vitest run` — both green.

- [ ] **Step 2: Deploy the Worker**

Run (in `worker/`): `./node_modules/.bin/wrangler deploy`. Confirm `DRY_RUN="false"` and `LINE_ITEM_WRITE="true"` in the deploy output bindings.

- [ ] **Step 3: Register the webhook (if not already done in Task 4)**

Run the Task 4 script once. Verify two webhooks exist on board 5029480548.

- [ ] **Step 4: Live verification on a test deal** (create + clean up afterward)

1. Edit a subitem's **Unit Price** on the board (e.g. 99 → 90) → within seconds the HubSpot line item shows 90; it does **not** revert on the next forward tick.
2. Edit **Quantity / Service Date / Description** on the board → each reaches HubSpot.
3. Set **Unit Discount** on a line item → HubSpot `discount` set and `hs_discount_percentage` cleared; then set **Discount %** → the reverse (the sibling clears).
4. **Rename** a line item on the board → HubSpot line-item name updates and does not revert. (If `change_name` wasn't registered, note this as pending.)
5. Empty a subitem cell (e.g. clear discount) → HubSpot is **not** cleared (omit-empty); confirm the value is unchanged in HubSpot.
6. Edit the same line item **in HubSpot** → the change flows forward to the subitem (forward path unchanged), and does not trigger a reverse write back (echo suppressed — check logs for no `action=patched` echo storm).
7. Add a new subitem on the board, set price; after the 90s grace / a subsequent deal edit, a HubSpot line item is created and its id is stamped back (no duplicate vs an app-created one).
8. Change the deal currency in HubSpot → the subitem Currency cell refreshes on the next forward tick; a board Currency-cell edit does **not** push to HubSpot.

- [ ] **Step 5: Watch the logs for an echo loop**

During Steps 4.1-4.2, tail `wrangler tail` (or the dashboard logs) and confirm each board edit produces exactly one `action=patched` and no repeating reverse writes for the same value (the type-aware echo guard should stop forward writes from bouncing back).

---

## Self-review checklist (run after all tasks)

- Config: exactly six fields carry `reverse: true` (price, quantity, service_date, discount, hs_discount_percentage, description); amount / hs_pre_discount_amount / hs_line_item_currency_code do **not**.
- Pure `buildSubitemReversePatch` returns null for: non-reverse column, empty value, echo (type-aware equal); returns `{prop}` for a real edit; adds the sibling `""` for the discount pair only.
- Handler gates on `f.reverse` **before** any API call; patch path needs no parent-deal lookup; create path reuses `reverseLineItems` (grace + dedup); name path handled via `change_name`.
- Echo guard: handler fetches HubSpot current value and passes it to the pure function; `patchLineItem` itself has no equality check, so the compare is explicit.
- Routing branch is inserted before the `!spec` early return and coalesces **per subitem+column** (`sub:<subitemId>:<columnId>`, or `:name`) — never per-subitem, which would drop concurrent different-column edits.
- Every new symbol referenced later exists: `subitemFieldByCol`, `liValueEqual`, `buildSubitemReversePatch` (Task 1); `getParentItemId`, `reverseSubitemEdit` (Task 2); routing (Task 3).
- No `Co-Authored-By: Claude` trailer on any commit; `docs/` not committed.
