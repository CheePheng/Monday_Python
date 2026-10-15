# Deal Cockpit v3.3 — Phase 2: Two line-item flows + schema-driven manual form + Save-to-library

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Add two line-item creation flows in the deal editor — **Add product** (catalog search → product-linked line item) and **+ New line item** (a schema-driven manual form for a standalone line item, with optional Save-to-product-library) — with the Worker as the only component that writes HubSpot line items/products, keyed by HubSpot Line Item ID / Product ID.

**Architecture:** monday app → Worker `/app/*` → HubSpot. On save, the app creates a **core monday subitem** (name/qty/price/discount/service-date/description/product-id/line-item-id) for the board, and sends the **full field payload** to a Worker create/update endpoint that (a) ensures the parent deal exists in HubSpot, (b) optionally creates a product for Save-to-library, (c) creates/updates the HubSpot line item with the allowlisted writable props + associates it to the deal, (d) writes the **Line Item ID back onto the subitem** (so the reverse-sync never double-creates). Extended fields live in HubSpot; the editor hydrates them (Phase 3 fresh-on-open). Enum options are served live by the Worker so the form stays current without a redeploy.

**Tech Stack:** Cloudflare Worker + vitest (worker); React 18 + TS + Vite + vitest (app). Deploy: `wrangler` + cached `mapps`.

**Design source:** `C:\Users\PC\.claude\plans\create-a-small-python-jupyter-happy-turtle.md` (Phase 2). **Verified HubSpot `line_items` write props** (do NOT guess): `name` (req), `hs_sku`, `description`, `brand_isv` (select), `family` (select), `is_active` (bool), `note`, `product_subcategory` (select), `service_date` (date), `recurringbillingfrequency` (select; "One-time"=empty), `hs_recurring_billing_start_date` (date), `discount` / `hs_discount_percentage`, `hs_tax_rate_group_id` (select = "Tax rate"), `hs_pricing_model` (select, req, default `flat`), `price` (req), `quantity`, `hs_cost_of_goods_sold`, `deposit`, `hs_product_id`, `hs_line_item_currency_code`. **READ-ONLY calc (never send):** `amount`, `hs_pre_discount_amount`, `hs_margin`, `hs_post_tax_amount`. Excluded: Image.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `worker/src/line-item-props.ts` | **new** — the writable-prop allowlist + the enum-prop list; `LINE_ITEM_WRITE_PROPS` set, `LINE_ITEM_ENUM_PROPS`, `PRODUCT_COPY_PROPS` |
| `worker/src/hubspot.ts` | add `getWritablePropOptions` (schema+options), `createProduct` |
| `worker/src/app-routes.ts` | add `parseCreateLineItemBody` (validates + strips to allowlist) |
| `worker/src/index.ts` | `GET /app/line-item-schema`; extend `POST /app/line-item` to a create path (`{itemId, subitemId, productId?, saveToLibrary?, properties}`) |
| `worker/test/line-item-props.test.ts`, `worker/test/app-routes.test.ts` | allowlist + parser tests |
| `monday-app/src/worker-client.ts` | `getLineItemSchema()`, `createHubspotLineItem(...)` |
| `monday-app/src/lib/line-item-form.ts` | **new** — the verified field descriptors (`LI_FIELDS`), `validateLineItemForm`, `computeTotals` (pure, tested) |
| `monday-app/src/views/LineItemForm.tsx` | **new** — schema-driven manual form (grouped Detail/Billing/Adjustments/Price) |
| `monday-app/src/views/LineItemsEditor.tsx` | two actions (Add product / + New line item); wire create via the Worker; open the form |
| `monday-app/src/views/DealDrawer.tsx` | pass the deal's monday `itemId` (parent) into persist so the Worker can resolve the deal |

---

## Task 1: Worker prop allowlist + tests (pure)

**Files:** Create `worker/src/line-item-props.ts`, `worker/test/line-item-props.test.ts`.

- [ ] **Step 1: Failing test** — `worker/test/line-item-props.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { LINE_ITEM_WRITE_PROPS, PRODUCT_COPY_PROPS, pickWritableLineItemProps } from "../src/line-item-props";

describe("line-item write allowlist", () => {
  it("keeps writable props, drops read-only/calculated and unknown", () =>
    expect(pickWritableLineItemProps({ name: "X", price: "10", amount: "999", hs_margin: "5", bogus: "y" }))
      .toEqual({ name: "X", price: "10" }));
  it("allowlist excludes the calculated fields", () => {
    for (const c of ["amount", "hs_pre_discount_amount", "hs_margin", "hs_post_tax_amount"])
      expect(LINE_ITEM_WRITE_PROPS.has(c)).toBe(false);
  });
  it("core writable + custom fields are allowlisted", () => {
    for (const p of ["name", "price", "quantity", "hs_sku", "brand_isv", "family", "product_subcategory",
      "is_active", "note", "service_date", "recurringbillingfrequency", "hs_recurring_billing_start_date",
      "discount", "hs_discount_percentage", "hs_tax_rate_group_id", "hs_pricing_model",
      "hs_cost_of_goods_sold", "deposit", "hs_product_id", "hs_line_item_currency_code"])
      expect(LINE_ITEM_WRITE_PROPS.has(p)).toBe(true);
  });
  it("PRODUCT_COPY_PROPS excludes hs_product_id and currency (product has no line currency)", () => {
    expect(PRODUCT_COPY_PROPS.has("hs_product_id")).toBe(false);
    expect(PRODUCT_COPY_PROPS.has("name")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail** — `cd worker && npx vitest run test/line-item-props.test.ts` → module not found.

- [ ] **Step 3: Implement** — `worker/src/line-item-props.ts`:
```ts
/** Writable HubSpot line_item properties the app may send (verified against the live schema).
 * Calculated/read-only props (amount, hs_pre_discount_amount, hs_margin, hs_post_tax_amount) are NOT here. */
export const LINE_ITEM_WRITE_PROPS = new Set<string>([
  "name", "hs_sku", "description", "brand_isv", "family", "is_active", "note", "product_subcategory",
  "service_date", "recurringbillingfrequency", "hs_recurring_billing_start_date",
  "hs_billing_start_delay_days", "hs_billing_start_delay_months",
  "discount", "hs_discount_percentage", "hs_tax_rate_group_id", "hs_pricing_model",
  "price", "quantity", "hs_cost_of_goods_sold", "deposit", "hs_product_id", "hs_line_item_currency_code",
]);

/** Enum props whose options the form fetches live from HubSpot (so new options appear without a redeploy). */
export const LINE_ITEM_ENUM_PROPS = [
  "brand_isv", "family", "product_subcategory", "is_active",
  "recurringbillingfrequency", "hs_pricing_model", "hs_tax_rate_group_id",
];

/** Props copied line-item -> new product when "Save to product library" is checked (product has no
 * per-line currency or product-id of its own). */
export const PRODUCT_COPY_PROPS = new Set<string>([
  "name", "hs_sku", "description", "brand_isv", "family", "is_active", "note", "product_subcategory",
  "recurringbillingfrequency", "hs_pricing_model", "price", "hs_cost_of_goods_sold", "deposit",
]);

/** Keep only allowlisted, non-empty string props. */
export function pickWritableLineItemProps(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props ?? {}))
    if (LINE_ITEM_WRITE_PROPS.has(k) && v != null && String(v) !== "") out[k] = String(v);
  return out;
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/line-item-props.test.ts` → 4 pass.
- [ ] **Step 5: Commit** — `git add worker/src/line-item-props.ts worker/test/line-item-props.test.ts && git commit -m "feat(worker): line-item writable-prop allowlist + product-copy list"`

---

## Task 2: Worker `parseCreateLineItemBody` + tests

**Files:** Modify `worker/src/app-routes.ts`, `worker/test/app-routes.test.ts`.

- [ ] **Step 1: Failing test** — add to `worker/test/app-routes.test.ts`:
```ts
import { parseCreateLineItemBody } from "../src/app-routes";
describe("parseCreateLineItemBody", () => {
  it("requires numeric itemId + subitemId and strips props to the allowlist", () =>
    expect(parseCreateLineItemBody({ itemId: "1", subitemId: "2", saveToLibrary: true,
      properties: { name: "X", price: "10", amount: "999" } }))
      .toEqual({ ok: true, itemId: "1", subitemId: "2", saveToLibrary: true, properties: { name: "X", price: "10" } }));
  it("rejects a non-numeric itemId/subitemId", () => {
    expect(parseCreateLineItemBody({ itemId: "x", subitemId: "2", properties: { name: "X" } }).ok).toBe(false);
    expect(parseCreateLineItemBody({ itemId: "1", subitemId: "x", properties: { name: "X" } }).ok).toBe(false);
  });
  it("requires a name (or hs_product_id) after allowlisting", () =>
    expect(parseCreateLineItemBody({ itemId: "1", subitemId: "2", properties: { amount: "999" } }).ok).toBe(false));
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/app-routes.test.ts` → `parseCreateLineItemBody` undefined.

- [ ] **Step 3: Implement** — add to `worker/src/app-routes.ts` (import the allowlist):
```ts
import { pickWritableLineItemProps } from "./line-item-props";

export interface CreateLineItemReq {
  ok: boolean; itemId?: string; subitemId?: string; saveToLibrary?: boolean;
  properties?: Record<string, string>; error?: string;
}
export function parseCreateLineItemBody(body: any): CreateLineItemReq {
  const itemId = body?.itemId, subitemId = body?.subitemId;
  if (!numeric(itemId)) return { ok: false, error: "itemId must be a numeric string" };
  if (!numeric(subitemId)) return { ok: false, error: "subitemId must be a numeric string" };
  const properties = pickWritableLineItemProps(body?.properties ?? {});
  if (!properties.name && !properties.hs_product_id)
    return { ok: false, error: "a line item needs a name or a product id" };
  return { ok: true, itemId, subitemId, saveToLibrary: body?.saveToLibrary === true, properties };
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/app-routes.test.ts` → all pass.
- [ ] **Step 5: Commit** — `git add worker/src/app-routes.ts worker/test/app-routes.test.ts && git commit -m "feat(worker): parseCreateLineItemBody (allowlisted create-line-item body)"`

---

## Task 3: Worker helpers — `createProduct` + `getWritablePropOptions`

**Files:** Modify `worker/src/hubspot.ts`.

- [ ] **Step 1: Implement `createProduct`** (after `createLineItem`):
```ts
/** Create a HubSpot product (for "Save line item to the product library"). Returns the new product id. */
export async function createProduct(env: Env, properties: Record<string, string>, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun || !opts.writeHubspot) { console.log(`DRY hubspot CREATE product: ${JSON.stringify(properties)}`); return null; }
  const res = await hs(env, "POST", "/crm/v3/objects/products", { properties }, 1);
  console.log(`hubspot CREATE product -> ${res.id}`);
  return res.id ? String(res.id) : null;
}
```

- [ ] **Step 2: Implement `getWritablePropOptions`** (reads the line_items property schema, returns options for the enum props):
```ts
/** For the manual line-item form: label + options for each enum line_item prop, read live from the
 * property schema so new portal options appear without a redeploy. */
export async function getWritablePropOptions(env: Env, names: string[]):
    Promise<Record<string, { label: string; options: { value: string; label: string }[] }>> {
  const res = await hs(env, "GET", "/crm/v3/properties/line_items", undefined, 2);
  const byName: Record<string, any> = {};
  for (const p of (res.results ?? [])) byName[p.name] = p;
  const out: Record<string, { label: string; options: { value: string; label: string }[] }> = {};
  for (const n of names) {
    const p = byName[n];
    if (p) out[n] = { label: p.label ?? n, options: (p.options ?? []).map((o: any) => ({ value: String(o.value), label: o.label })) };
  }
  return out;
}
```

- [ ] **Step 3: Typecheck** — `cd worker && npx tsc --noEmit` → exit 0.
- [ ] **Step 4: Commit** — `git add worker/src/hubspot.ts && git commit -m "feat(worker): createProduct + getWritablePropOptions (schema-driven form)"`

---

## Task 4: Worker routes — schema endpoint + create-line-item endpoint

**Files:** Modify `worker/src/index.ts`.

Uses: `getItem`/`colText` (resolve the deal's HubSpot id from the monday parent), `syncMondayItem` (ensure the deal exists if not yet linked), `createProduct`, `createLineItem`, `setColumns` (write the Line Item ID back to the subitem), `LINE_ITEM_ENUM_PROPS`, `PRODUCT_COPY_PROPS`, `DEALS`, `LINE_ITEM_SUBITEMS` (from config), `getWritablePropOptions`.

- [ ] **Step 1: Add the schema route** (inside the `/app/*` block):
```ts
      // GET /app/line-item-schema — writable enum options for the manual line-item form (live).
      if (url.pathname === "/app/line-item-schema" && req.method === "GET") {
        try {
          const schema = await getWritablePropOptions(env, LINE_ITEM_ENUM_PROPS);
          return Response.json({ schema }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/line-item-schema] error="${String(e).slice(0, 140)}"`);
          return Response.json({ schema: {}, error: "schema-failed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }
```

- [ ] **Step 2: Add the create branch to `/app/line-item`** — the existing handler covers POST (PATCH update) + DELETE. Add a create branch keyed on the presence of `subitemId` in the body. Replace the `/app/line-item` handler with:
```ts
      // POST /app/line-item — create (body has subitemId) OR update (body has lineItemId) | DELETE {lineItemId}
      if (url.pathname === "/app/line-item" && (req.method === "POST" || req.method === "DELETE")) {
        const body = await req.json().catch(() => ({}));
        if (req.method === "POST" && body?.subitemId !== undefined) {
          const c = parseCreateLineItemBody(body);
          if (!c.ok) return Response.json({ error: c.error }, { status: 400, headers: CORS });
          try {
            // 1) ensure the parent deal exists in HubSpot; resolve its id from the monday deal card.
            let deal = await getItem(env, c.itemId!);
            let dealId = deal ? colText(deal, DEALS.idCol) : "";
            if (!dealId) {
              await syncMondayItem(env, DEALS.boardId, c.itemId!, appWriteOpts(env), { left: 10 }); // createFromMonday
              deal = await getItem(env, c.itemId!);
              dealId = deal ? colText(deal, DEALS.idCol) : "";
            }
            if (!dealId) return Response.json({ ok: false, error: "deal-not-synced" }, { status: 409, headers: CORS });
            // 2) optional Save-to-library -> create a product, link it.
            const props = { ...c.properties! };
            if (c.saveToLibrary && !props.hs_product_id) {
              const pProps: Record<string, string> = {};
              for (const [k, v] of Object.entries(props)) if (PRODUCT_COPY_PROPS.has(k)) pProps[k] = v;
              const pid = await createProduct(env, pProps, appWriteOpts(env));
              if (pid) props.hs_product_id = pid;
            }
            // 3) create the HubSpot line item (+ associate to the deal), 4) write the id back onto the subitem.
            const lineItemId = await createLineItem(env, props, dealId, appWriteOpts(env));
            if (lineItemId) await setColumns(env, LINE_ITEM_SUBITEMS.boardId, c.subitemId!, { [LINE_ITEM_SUBITEMS.idCol]: lineItemId }, appWriteOpts(env));
            return Response.json({ ok: true, lineItemId, productId: props.hs_product_id }, { headers: CORS });
          } catch (e) {
            console.log(`[app/line-item] create subitem=${body?.subitemId} error="${String(e).slice(0, 160)}"`);
            return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
          }
        }
        const p = parseLineItemBody(req.method === "POST" ? "PATCH" : "DELETE", body);
        if (!p.ok) return Response.json({ error: p.error }, { status: 400, headers: CORS });
        try {
          if (req.method === "POST") await patchLineItem(env, p.lineItemId!, p.properties!, appWriteOpts(env));
          else await deleteLineItem(env, p.lineItemId!, appWriteOpts(env));
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/line-item] ${req.method} ${p.lineItemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
        }
      }
```

- [ ] **Step 3: Wire imports** — in `worker/src/index.ts` add to the existing imports: from `./hubspot` add `createProduct, createLineItem, getWritablePropOptions`; from `./app-routes` add `parseCreateLineItemBody`; from `./line-item-props` import `{ LINE_ITEM_ENUM_PROPS, PRODUCT_COPY_PROPS }`; from `./config` add `LINE_ITEM_SUBITEMS`; from `./monday` add `getItem, setColumns`; from `./dedup` add `colText`. (Check which are already imported; add only the missing ones.)

- [ ] **Step 4: Typecheck + worker tests** — `cd worker && npx tsc --noEmit && npx vitest run` → green (no new failures; existing 164+ still pass).
- [ ] **Step 5: Commit** — `git add worker/src/index.ts && git commit -m "feat(worker): /app/line-item-schema + create-line-item (resolve deal, save-to-library, id write-back)"`

---

## Task 5: App client — `getLineItemSchema` + `createHubspotLineItem`

**Files:** Modify `monday-app/src/worker-client.ts`.

- [ ] **Step 1: Add the two functions**:
```ts
export interface EnumProp { label: string; options: { value: string; label: string }[] }
export async function getLineItemSchema(token: string): Promise<Record<string, EnumProp>> {
  const res = await call(token, "GET", "/app/line-item-schema");
  return res?.schema ?? {};
}
/** Create a HubSpot line item from a monday subitem via the Worker (which ensures the deal exists,
 * associates it, optional Save-to-library, and writes the Line Item ID back onto the subitem). */
export async function createHubspotLineItem(token: string, args: {
  itemId: string; subitemId: string; productId?: string; saveToLibrary?: boolean; properties: Record<string, string>;
}): Promise<{ lineItemId?: string; productId?: string }> {
  const res = await call(token, "POST", "/app/line-item", {
    itemId: args.itemId, subitemId: args.subitemId, saveToLibrary: args.saveToLibrary,
    properties: { ...args.properties, ...(args.productId ? { hs_product_id: args.productId } : {}) },
  });
  if (res?.error) throw new Error("line-item-" + res.error);
  return { lineItemId: res.lineItemId, productId: res.productId };
}
```

- [ ] **Step 2: Typecheck** — `cd monday-app && npx tsc --noEmit` → exit 0.
- [ ] **Step 3: Commit** — `git add monday-app/src/worker-client.ts && git commit -m "feat(monday-app): worker-client getLineItemSchema + createHubspotLineItem"`

---

## Task 6: Pure form logic — field descriptors, validation, totals

**Files:** Create `monday-app/src/lib/line-item-form.ts`, `monday-app/src/lib/line-item-form.test.ts`.

- [ ] **Step 1: Failing test** — `line-item-form.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { validateLineItemForm, computeTotals, LI_FIELDS, type LineItemFormValues } from "./line-item-form";

const base: LineItemFormValues = { name: "X", price: "100", quantity: "2", hs_pricing_model: "flat" };

describe("validateLineItemForm", () => {
  it("passes with name + price + pricing model", () => expect(validateLineItemForm(base).ok).toBe(true));
  it("requires name, price, pricing model", () => {
    expect(validateLineItemForm({ ...base, name: "" }).ok).toBe(false);
    expect(validateLineItemForm({ ...base, price: "" }).ok).toBe(false);
    expect(validateLineItemForm({ ...base, hs_pricing_model: "" }).ok).toBe(false);
  });
  it("rejects a non-numeric price/quantity", () =>
    expect(validateLineItemForm({ ...base, price: "abc" }).ok).toBe(false));
});

describe("computeTotals", () => {
  it("subtotal = price*qty; amount-discount reduces net", () =>
    expect(computeTotals({ ...base, discountMode: "amount", discount: "10" }))
      .toMatchObject({ subtotal: 200, net: 180 }));
  it("percent discount", () =>
    expect(computeTotals({ ...base, discountMode: "percent", hs_discount_percentage: "10" }))
      .toMatchObject({ subtotal: 200, net: 180 }));
  it("margin = (price - unit cost) * qty", () =>
    expect(computeTotals({ ...base, hs_cost_of_goods_sold: "60" }).margin).toBe(80));
});

it("LI_FIELDS lists only verified writable props (never a calc prop)", () => {
  const calc = ["amount", "hs_pre_discount_amount", "hs_margin", "hs_post_tax_amount"];
  for (const f of LI_FIELDS) expect(calc).not.toContain(f.prop);
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — `monday-app/src/lib/line-item-form.ts`. `LI_FIELDS` is the ordered, grouped descriptor list (each `{ prop, label, type, group, required?, enum? }`), matching the verified schema. `validateLineItemForm` checks name/price/hs_pricing_model present + price/quantity numeric. `computeTotals` returns `{ subtotal, discountAmt, net, margin }` computed client-side (calc fields are display-only, never sent):
```ts
export type LiFieldType = "text" | "textarea" | "number" | "date" | "enum" | "bool";
export interface LiField { prop: string; label: string; type: LiFieldType; group: "detail" | "billing" | "adjust" | "price"; required?: boolean; enum?: boolean }

export const LI_FIELDS: LiField[] = [
  { prop: "name", label: "Name", type: "text", group: "detail", required: true },
  { prop: "hs_sku", label: "SKU", type: "text", group: "detail" },
  { prop: "description", label: "Description", type: "textarea", group: "detail" },
  { prop: "brand_isv", label: "Brand ISV", type: "enum", group: "detail", enum: true },
  { prop: "family", label: "Family", type: "enum", group: "detail", enum: true },
  { prop: "product_subcategory", label: "Product Subcategory", type: "enum", group: "detail", enum: true },
  { prop: "is_active", label: "Is Active", type: "enum", group: "detail", enum: true },
  { prop: "note", label: "Note", type: "textarea", group: "detail" },
  { prop: "service_date", label: "Service Date", type: "date", group: "detail" },
  { prop: "recurringbillingfrequency", label: "Billing frequency", type: "enum", group: "billing", enum: true },
  { prop: "hs_recurring_billing_start_date", label: "Billing start date", type: "date", group: "billing" },
  { prop: "hs_tax_rate_group_id", label: "Tax rate", type: "enum", group: "adjust", enum: true },
  { prop: "hs_pricing_model", label: "Pricing model", type: "enum", group: "price", required: true, enum: true },
  { prop: "price", label: "Unit price", type: "number", group: "price", required: true },
  { prop: "quantity", label: "Quantity", type: "number", group: "price" },
  { prop: "hs_cost_of_goods_sold", label: "Unit cost", type: "number", group: "price" },
  { prop: "deposit", label: "Deposit", type: "number", group: "price" },
];

export interface LineItemFormValues extends Record<string, string | undefined> {
  discountMode?: "amount" | "percent"; discount?: string; hs_discount_percentage?: string;
}

const num = (v?: string) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isNumeric = (v?: string) => !v || /^\d+(\.\d+)?$/.test(v.trim());

export function validateLineItemForm(f: LineItemFormValues): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.name?.trim()) errors.name = "Name is required";
  if (!f.price?.trim()) errors.price = "Unit price is required";
  if (!f.hs_pricing_model) errors.hs_pricing_model = "Pricing model is required";
  if (!isNumeric(f.price)) errors.price = "Must be a number";
  if (!isNumeric(f.quantity)) errors.quantity = "Must be a number";
  return { ok: Object.keys(errors).length === 0, errors };
}

export function computeTotals(f: LineItemFormValues): { subtotal: number; discountAmt: number; net: number; margin: number } {
  const qty = num(f.quantity) || 1, price = num(f.price);
  const subtotal = qty * price;
  const discountAmt = f.discountMode === "percent" ? subtotal * (num(f.hs_discount_percentage) / 100) : num(f.discount) * qty;
  const net = Math.max(0, subtotal - discountAmt);
  const margin = (price - num(f.hs_cost_of_goods_sold)) * qty;
  return { subtotal, discountAmt, net, margin };
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `git add monday-app/src/lib/line-item-form.ts monday-app/src/lib/line-item-form.test.ts && git commit -m "feat(monday-app): line-item form descriptors + validation + client-side totals"`

---

## Task 7: `LineItemForm` component (schema-driven manual form)

**Files:** Create `monday-app/src/views/LineItemForm.tsx`.

- [ ] **Step 1: Build the form** — props `{ schema, currency, onCancel, onAdd, onError }`. It renders `LI_FIELDS` grouped (Line item details / Billing / Adjustments & Tax / Price), enum fields use `schema[prop].options` (a `<select>`; `is_active` maps true/false), the discount uses the existing `%`/currency toggle (label shows `currency`), calc displays (subtotal/net/margin via `computeTotals`, read-only), a **Save to product library** checkbox, and Save is disabled until `validateLineItemForm(...).ok`. On Add it calls `onAdd(values, saveToLibrary)`. Full component code:
```tsx
import { useState } from "react";
import { LI_FIELDS, validateLineItemForm, computeTotals, type LiField, type LineItemFormValues } from "../lib/line-item-form";
import type { EnumProp } from "../worker-client";

interface Props {
  schema: Record<string, EnumProp>; currency: string;
  onCancel: () => void; onAdd: (values: LineItemFormValues, saveToLibrary: boolean) => void;
}
const GROUPS: { id: LiField["group"]; title: string }[] = [
  { id: "detail", title: "Line item details" }, { id: "billing", title: "Billing" },
  { id: "adjust", title: "Adjustments & Tax" }, { id: "price", title: "Price" },
];

export default function LineItemForm({ schema, currency, onCancel, onAdd }: Props) {
  const [v, setV] = useState<LineItemFormValues>({ hs_pricing_model: "flat", quantity: "1", discountMode: "percent" });
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const set = (prop: string, val: string) => setV(s => ({ ...s, [prop]: val }));
  const invalid = validateLineItemForm(v);
  const t = computeTotals(v);

  const field = (f: LiField) => {
    const opts = schema[f.prop]?.options ?? [];
    return (
      <div className="dc-field" key={f.prop}>
        <label className="dc-field-label">{f.label}{f.required && <span style={{ color: "var(--red)" }}> *</span>}</label>
        {f.type === "enum" ? (
          <select className="dc-field-input" value={v[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)}>
            <option value="">—</option>
            {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : f.type === "textarea" ? (
          <textarea className="dc-field-input" rows={2} value={v[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        ) : (
          <input className="dc-field-input" type={f.type === "date" ? "date" : "text"} inputMode={f.type === "number" ? "decimal" : undefined}
            value={v[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        )}
        {invalid.errors[f.prop] && <div className="dc-err">{invalid.errors[f.prop]}</div>}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {GROUPS.map(g => (
        <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="dc-section-title">{g.title}</div>
          <div className="dc-grid">{LI_FIELDS.filter(f => f.group === g.id).map(field)}</div>
          {g.id === "adjust" && (
            <div className="dc-field">
              <label className="dc-field-label">Unit discount</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button type="button" className={"dc-btn dc-btn-sm" + (v.discountMode === "percent" ? " on" : "")} onClick={() => set("discountMode", "percent")}>%</button>
                <button type="button" className={"dc-btn dc-btn-sm" + (v.discountMode === "amount" ? " on" : "")} onClick={() => set("discountMode", "amount")}>{currency || "amt"}</button>
                {v.discountMode === "percent"
                  ? <input className="dc-field-input" value={v.hs_discount_percentage ?? ""} onChange={e => set("hs_discount_percentage", e.target.value)} placeholder="0" />
                  : <input className="dc-field-input" value={v.discount ?? ""} onChange={e => set("discount", e.target.value)} placeholder="0" />}
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="dc-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="dc-mut">Pre-tax subtotal: {t.subtotal.toFixed(2)}</div>
        <div className="dc-mut">Total (excl. tax): {t.net.toFixed(2)}</div>
        <div className="dc-mut">Your margin: {t.margin.toFixed(2)}</div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
        <input type="checkbox" checked={saveToLibrary} onChange={e => setSaveToLibrary(e.target.checked)} />
        Save line item to the product library
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="dc-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="dc-btn dc-btn-primary" disabled={!invalid.ok} onClick={() => onAdd(v, saveToLibrary)}>Add line item</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** — `cd monday-app && npx tsc --noEmit` (LineItemForm may be unused until Task 8 — that's fine; tsc doesn't error on an unused module).
- [ ] **Step 3: Commit** — `git add monday-app/src/views/LineItemForm.tsx && git commit -m "feat(monday-app): schema-driven manual LineItemForm (grouped, validated, save-to-library)"`

---

## Task 8: Wire the two flows into `LineItemsEditor` + `DealDrawer` persist

**Files:** Modify `monday-app/src/views/LineItemsEditor.tsx`, `monday-app/src/views/DealDrawer.tsx`, `monday-app/src/lib/columns.ts` (extend `LineItem`).

- [ ] **Step 1: Extend the `LineItem` type** (in `LineItemsEditor.tsx`) with the manual/extended fields + a `saveToLibrary` flag + a staged `props` bag for the full HubSpot payload:
```ts
export interface LineItem {
  subitemId?: string; lineItemId?: string;
  productId?: string; name: string; unitPrice: string; quantity: string; currency?: string; description?: string;
  discount?: string; discountMode?: "amount" | "percent"; discountPct?: string; serviceDate?: string;
  saveToLibrary?: boolean; props?: Record<string, string>;  // full HubSpot property payload for manual line items
}
```

- [ ] **Step 2: Add a "+ New line item" button + the form** — in `LineItemsEditor`, add state `const [adding, setAdding] = useState(false)` and a `schema` fetched once (`getLineItemSchema`) when the form opens; render the "+ New line item" button next to the "Add product…" input; when `adding`, render `<LineItemForm schema currency onCancel onAdd />`. `onAdd(values, saveToLibrary)` pushes a new `LineItem` carrying `name`, `unitPrice: values.price`, `quantity: values.quantity ?? "1"`, discount fields, and **`props: allWritableValues`** (the full payload) + `saveToLibrary`, then closes the form.

- [ ] **Step 3: `persistLineItems` creates via the Worker** — change `persistLineItems(token, parentItemId, items)`: for a row with **no `lineItemId`** that has a `subitemId` (just created), call `createHubspotLineItem(token, { itemId: parentItemId, subitemId, productId, saveToLibrary, properties })` where `properties` = the manual `props` (or, for an Add-product row, the core `{ name, price, quantity, hs_product_id, ...discount }`) and store the returned `lineItemId`. For a row with a `lineItemId`, keep the existing `updateHubspotLineItem` patch. Full replacement of `persistLineItems`:
```ts
export async function persistLineItems(token: string, parentItemId: string, items: LineItem[]): Promise<LineItem[]> {
  const out: LineItem[] = [];
  for (const li of items) {
    const cols = lineItemToSubitemColumns(li);
    if (!li.subitemId) {
      const subitemId = await createSubitem(parentItemId, li.name, cols);
      // create the HubSpot line item now (Worker ensures the deal exists, associates, writes the id back).
      const properties = li.props ?? lineItemHubspotProperties(li);
      const { lineItemId } = await createHubspotLineItem(token, {
        itemId: parentItemId, subitemId, productId: li.productId, saveToLibrary: li.saveToLibrary, properties,
      }).catch(() => ({ lineItemId: undefined }));
      out.push({ ...li, subitemId, lineItemId });
    } else {
      await updateSubitemColumns(li.subitemId, cols);
      if (li.lineItemId) await updateHubspotLineItem(token, li.lineItemId, li.props ?? lineItemHubspotProperties(li));
      out.push(li);
    }
  }
  return out;
}
```
(Import `createHubspotLineItem` from `../worker-client`.)

- [ ] **Step 4: Confirm DealDrawer already passes the monday parent id** — `persistLineItems(board.sessionToken, parentId, lineItems)` already passes `parentId` (the monday deal item id). No change needed beyond confirming.

- [ ] **Step 5: Typecheck + tests + build** — `cd monday-app && npx tsc --noEmit && npx vitest run && npm run build` → all green.
- [ ] **Step 6: Commit** — `git add monday-app/src/views/LineItemsEditor.tsx monday-app/src/lib/columns.ts && git commit -m "feat(monday-app): Add product + New line item flows via Worker-direct create"`

---

## Task 9: Verify + deploy

- [ ] **Step 1: Full suites** — worker `tsc`+`vitest`; app `tsc`+`vitest`+`build` → green.
- [ ] **Step 2: Deploy** — `cd worker && npx wrangler deploy`; `cd monday-app && "<cached mapps>" code:push -c -i 16011075 -f -d ./dist`.
- [ ] **Step 3: Live checks (auth-gated, so use a test deal via the app):** create a manual line item on a test deal → appears under the correct HubSpot Deal, **not** in the product library (unless the box is checked); `hs_product_id` empty for manual, retained for Add-product; edit qty/price → same Line Item ID patched; retry/double-save → no duplicate; remove → exact Line Item ID deleted. (The reviewer/you run these live on a `test` deal and clean up.)
- [ ] **Step 4: Report** results; note Phase 3 (fresh-on-open) remains.

---

## Self-Review

**Spec coverage:** two flows (Add product / New line item → Tasks 7,8); schema-driven options (Tasks 3,4,5,7); Worker-only HubSpot writes + associate + id write-back (Task 4); Save-to-library (Tasks 1,4,7,8); idempotency by Line Item ID / Product ID, retry-only-failed, no name matching (Tasks 4,8 — create only when no `lineItemId`; `savingRef` in the drawer already guards double-submit); calc fields display-only never sent (Tasks 1,6); required-field validation (Task 6); currency from the deal (Task 8 passes `currency`). Hydration of extended fields on open = **Phase 3** (documented dependency).

**Placeholder scan:** every code step has complete code + commands. No TBD.

**Type consistency:** `EnumProp` (worker-client) used by `getLineItemSchema`/`LineItemForm`; `LineItemFormValues`/`LI_FIELDS`/`computeTotals`/`validateLineItemForm` consistent across Tasks 6–8; `createHubspotLineItem` arg shape matches the Worker `parseCreateLineItemBody` body (`itemId/subitemId/saveToLibrary/properties`); `pickWritableLineItemProps` allowlist shared by parser (Task 2) + tests (Task 1).

**Note / Phase-3 dependency:** editing an EXISTING line item's extended fields needs fresh-on-open hydration (Phase 3). Until then, existing rows edit core fields; `persistLineItems` only sends `li.props` when present (manual rows) or the core `lineItemHubspotProperties(li)` — it never sends unloaded fields, so a no-change save can't blank extended props.
