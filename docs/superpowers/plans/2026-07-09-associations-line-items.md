# HubSpot Associations + Line Items → monday Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync HubSpot associations (deal↔company/contact, company→contact, contact→company/deal) into parent monday text columns, and deal line items into monday subitems — HubSpot → monday only.

**Architecture:** A one-directional "associations pass" (`syncAssociations`) runs after the normal field reconcile in the deal/contact/company sync paths and the backup reconcile. New thin HubSpot helpers (`getAssociatedIds`, `getRecordsByIds`) and monday subitem helpers (`getSubitems`, `createSubitem`) support it. Config gains an optional `associations` block per `ObjectSpec`. No reverse, no Sync-State involvement, no name-matching (HubSpot Record ID / Line Item ID are the keys).

**Tech Stack:** TypeScript Cloudflare Worker (`worker/`), monday GraphQL v2, HubSpot CRM v3/v4, vitest.

**Spec:** `docs/superpowers/specs/2026-07-09-associations-line-items-design.md`

**Blocker (user action):** line-item *reads* are 403 until `crm.objects.line_items.read` is added to the **Private App** (Settings → Private Apps → Scopes). Tasks 1–6 (associations + all code/tests) do **not** need it. Tasks 7–9 (line-item property discovery, live verification, app webhook) require it.

---

## File Structure

| File | Responsibility |
|---|---|
| `worker/src/hubspot.ts` | + `getAssociatedIds` (v4 assoc → ids), `getRecordsByIds` (batch read). |
| `worker/src/monday.ts` | + `getSubitems`, `createSubitem` (subitem writes/deletes reuse `setColumns`/`deleteItem`). |
| `worker/src/types.ts` | + `AssocSpec` / `SubitemSpec`; `ObjectSpec.associations?`. |
| `worker/src/config.ts` | + column-id constants (Task 1 output) + `associations` on `DEALS`/`COMPANIES_MYLA`/`CONTACTS_MYLA`. |
| `worker/src/associations.ts` (new) | `syncAssociations` + `syncLineItemSubitems` (the pass; imports helpers). |
| `worker/src/sync.ts` | call `syncAssociations` after reconcile in `syncHubspotDeal`, `syncHubspotRecord`, `syncSpec`. |
| `worker/test/associations.test.ts` (new) | orchestration tests (mock hubspot/monday). |
| `worker/README.md` | association/subitem behavior, columns, HubSpot→monday-only, test steps. |
| monday boards (API) | create parent + subitem + company/contact columns (Task 1). |

---

## Task 1: Create the monday columns and capture their ids

**Files:** none (monday API). Record every returned id for Task 4.

- [ ] **Step 1: Create the parent + association columns** (run from repo root; `.env` has `MONDAY_API_TOKEN`)

```bash
set -a && . ./.env && set +a
create() { # board title type
  curl -s -X POST "https://api.monday.com/v2" -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2024-10" \
    -d "{\"query\":\"mutation { create_column(board_id:$1, title:\\\"$2\\\", column_type:$3) { id title } }\"}" \
    | python -c "import sys,json;c=json.load(sys.stdin)['data']['create_column'];print(f\"$1  {c['id']}  {c['title']}\")"
}
# Deal parent board 5029480547
create 5029480547 "Associated Company" text
create 5029480547 "Associated Contact" text
create 5029480547 "Line Items Summary" long_text
create 5029480547 "Line Items Count" numbers
create 5029480547 "Line Items Total Value" numbers
# Deal subitems board 5029480548
create 5029480548 "HubSpot Line Item ID" text
create 5029480548 "Unit Price" numbers
create 5029480548 "Quantity" numbers
create 5029480548 "Amount" numbers
create 5029480548 "Net Price" numbers
create 5029480548 "Service Date" date
create 5029480548 "Unit Discount" numbers
create 5029480548 "Description" long_text
# Company board 5029639440
create 5029639440 "Associated Contact" text
# Contact board 5029639630
create 5029639630 "Associated Company" text
create 5029639630 "Associated Deal" text
```
Expected: one `boardId  columnId  title` line per column. **Record every `columnId`** — they are used verbatim in Task 4. (`long_text` is monday's rich-text column type; if a `create_column` errors on `long_text`, re-run that one with `text`.)

- [ ] **Step 2: Sanity-check** the subitems board now has the new columns:
```bash
set -a && . ./.env && set +a
curl -s -X POST "https://api.monday.com/v2" -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2024-10" \
  -d '{"query":"query { boards(ids:[5029480548]) { columns { id title } } }"}' \
  | python -c "import sys,json;[print(c['id'],c['title']) for c in json.load(sys.stdin)['data']['boards'][0]['columns']]"
```
Expected: includes `HubSpot Line Item ID`, `Unit Price`, `Quantity`, `Amount`, `Net Price`, `Service Date`, `Unit Discount`, `Description`.

---

## Task 2: HubSpot association + batch-read helpers

**Files:** Modify `worker/src/hubspot.ts`

- [ ] **Step 1: Add the two helpers** (after `getRecord`, near the other read helpers)

```typescript
/** Ids of records associated to `id` (HubSpot v4 associations). e.g. deal -> companies/contacts/line_items. */
export async function getAssociatedIds(env: Env, fromObject: string, id: string, toObject: string): Promise<string[]> {
  const res = await hs(env, "GET", `/crm/v4/objects/${fromObject}/${id}/associations/${toObject}?limit=100`, undefined, 3);
  return (res.results ?? []).map((r: any) => String(r.toObjectId)).filter((x: string) => /^\d+$/.test(x));
}

/** Batch-read records by id (names for association columns, or line-item fields). Empty ids -> []. */
export async function getRecordsByIds(env: Env, object: string, ids: string[], properties: string[]): Promise<HsRecord[]> {
  if (!ids.length) return [];
  const res = await hs(env, "POST", `/crm/v3/objects/${object}/batch/read`,
    { properties, inputs: ids.map(id => ({ id })) });
  return (res.results ?? []).map((r: any) => ({ id: String(r.id), properties: r.properties ?? {} }));
}
```

- [ ] **Step 2: Typecheck** — `cd worker && npx tsc --noEmit` → no errors in `hubspot.ts` (these are exercised by Task 5's tests and live verification).

- [ ] **Step 3: Commit** — `git add worker/src/hubspot.ts && git commit -m "feat(hubspot): getAssociatedIds + getRecordsByIds helpers"`

---

## Task 3: monday subitem helpers

**Files:** Modify `worker/src/monday.ts`

- [ ] **Step 1: Add subitem helpers** (after `getItem`; `ITEM_FIELDS` already exists in this file)

```typescript
/** Subitems under a parent item (id, name, columns incl. the HubSpot Line Item ID column). */
export async function getSubitems(env: Env, parentItemId: string): Promise<MondayItem[]> {
  const data = await gql(env, `query ($i:[ID!]) { items(ids:$i) { subitems { ${ITEM_FIELDS} } } }`, { i: [parentItemId] });
  return data.items?.[0]?.subitems ?? [];
}

/** Create a subitem under a parent. Returns the new subitem id (null in dry-run). retries=1 (create). */
export async function createSubitem(env: Env, parentItemId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun) { console.log(`DRY create subitem '${name}' under ${parentItemId}`); return null; }
  const data = await gql(env,
    `mutation ($p:ID!, $n:String!, $c:JSON) {
       create_subitem(parent_item_id:$p, item_name:$n, column_values:$c, create_labels_if_missing:true) { id } }`,
    { p: parentItemId, n: name, c: JSON.stringify(cv) }, 1);
  const sid = data.create_subitem?.id ?? null;
  console.log(`created subitem ${sid} under ${parentItemId}`);
  return sid;
}
```
(Subitem column updates reuse `setColumns(env, subitemsBoardId, subitemId, cv, opts)`; subitem removal reuses `deleteItem(env, subitemId, opts)`.)

- [ ] **Step 2: Typecheck** — `cd worker && npx tsc --noEmit` → no new errors.
- [ ] **Step 3: Commit** — `git add worker/src/monday.ts && git commit -m "feat(monday): getSubitems + createSubitem helpers"`

---

## Task 4: Association config types + spec wiring

**Files:** Modify `worker/src/types.ts`, `worker/src/config.ts`

- [ ] **Step 1: Add the association types** (`worker/src/types.ts`, after `ObjectSpec`)

```typescript
// A HubSpot association synced onto the parent monday item (HubSpot -> monday only).
export interface AssocSpec {
  toObject: "companies" | "contacts" | "deals" | "line_items";
  nameProps: string[];     // properties composing the associated record's display name / line-item name
  col?: string;            // parent text column for comma-joined names (companies/contacts/deals)
  subitems?: SubitemSpec;  // line_items only
}
export interface SubitemSpec {
  boardId: string;   // subitems board
  idCol: string;     // "HubSpot Line Item ID" text column (dedup key)
  fields: FieldSpec[]; // line-item property -> subitem column
  summaryCol: string;  // parent "Line Items Summary"
  countCol: string;    // parent "Line Items Count"
  totalCol: string;    // parent "Line Items Total Value"
  totalProp: string;   // line-item property summed into totalCol
}
```
And add to `ObjectSpec`: `associations?: AssocSpec[];`

- [ ] **Step 2: Add column-id constants + wire associations** (`worker/src/config.ts`) — replace `PASTE_*` with the Task 1 ids:

```typescript
// --- Association columns (created in Task 1) ---
const DEAL_ASSOC_COMPANY = "PASTE_from_Task1";   // Deal board "Associated Company"
const DEAL_ASSOC_CONTACT = "PASTE_from_Task1";   // Deal board "Associated Contact"
const DEAL_LI_SUMMARY = "PASTE_from_Task1";      // "Line Items Summary"
const DEAL_LI_COUNT = "PASTE_from_Task1";        // "Line Items Count"
const DEAL_LI_TOTAL = "PASTE_from_Task1";        // "Line Items Total Value"
const SUBITEMS_BOARD = "5029480548";
const LI_ID = "PASTE_from_Task1";                // subitem "HubSpot Line Item ID"
const LI_UNIT_PRICE = "PASTE_from_Task1";
const LI_QTY = "PASTE_from_Task1";
const LI_AMOUNT = "PASTE_from_Task1";
const LI_NET_PRICE = "PASTE_from_Task1";
const LI_SERVICE_DATE = "PASTE_from_Task1";
const LI_UNIT_DISCOUNT = "PASTE_from_Task1";
const LI_DESCRIPTION = "PASTE_from_Task1";
const COMPANY_ASSOC_CONTACT = "PASTE_from_Task1";
const CONTACT_ASSOC_COMPANY = "PASTE_from_Task1";
const CONTACT_ASSOC_DEAL = "PASTE_from_Task1";

// Line-item property names — CONFIRMED in Task 7 (private-app scope required to inspect). Placeholder
// mapping uses HubSpot's documented names; Task 7 verifies/corrects them against a real line item.
export const LINE_ITEM_SUBITEMS: SubitemSpec = {
  boardId: SUBITEMS_BOARD, idCol: LI_ID,
  summaryCol: DEAL_LI_SUMMARY, countCol: DEAL_LI_COUNT, totalCol: DEAL_LI_TOTAL, totalProp: "amount",
  fields: [
    { hs: "price", col: LI_UNIT_PRICE, type: "numbers" },
    { hs: "quantity", col: LI_QTY, type: "numbers" },
    { hs: "amount", col: LI_AMOUNT, type: "numbers" },
    { hs: "hs_pre_discount_amount", col: LI_NET_PRICE, type: "numbers" },      // Net Price (confirm in Task 7)
    { hs: "hs_recurring_billing_start_date", col: LI_SERVICE_DATE, type: "date" }, // Service Date (confirm)
    { hs: "discount", col: LI_UNIT_DISCOUNT, type: "numbers" },                // Unit Discount (confirm)
    { hs: "description", col: LI_DESCRIPTION, type: "text" },
  ],
};
```
Then add `associations` to each spec:
```typescript
// on DEALS:
  associations: [
    { toObject: "companies", nameProps: ["name"], col: DEAL_ASSOC_COMPANY },
    { toObject: "contacts", nameProps: ["firstname", "lastname"], col: DEAL_ASSOC_CONTACT },
    { toObject: "line_items", nameProps: ["name"], subitems: LINE_ITEM_SUBITEMS },
  ],
// on COMPANIES_MYLA:
  associations: [ { toObject: "contacts", nameProps: ["firstname", "lastname"], col: COMPANY_ASSOC_CONTACT } ],
// on CONTACTS_MYLA:
  associations: [
    { toObject: "companies", nameProps: ["name"], col: CONTACT_ASSOC_COMPANY },
    { toObject: "deals", nameProps: ["dealname"], col: CONTACT_ASSOC_DEAL },
  ],
```

- [ ] **Step 3: Typecheck** — `cd worker && npx tsc --noEmit` → clean.
- [ ] **Step 4: Commit** — `git add worker/src/types.ts worker/src/config.ts && git commit -m "feat(config): association + line-item-subitem specs"`

---

## Task 5: `syncAssociations` (the pass) + orchestration tests

**Files:** Create `worker/src/associations.ts`, `worker/test/associations.test.ts`

- [ ] **Step 1: Write the failing tests** (`worker/test/associations.test.ts`) — mock hubspot/monday exactly like `sync.test.ts` does. Cover: company names written / cleared, subitem create+update+delete, summary/count/total. (Full test file — mirror the `vi.hoisted` store + `vi.mock` pattern in `worker/test/sync.test.ts`; assert via an in-memory `subitems` map keyed on parent id, and `getAssociatedIds`/`getRecordsByIds` returning fixtures.)

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
const H = vi.hoisted(() => {
  const assoc = new Map<string, string[]>();        // `${obj}:${id}:${to}` -> ids
  const records = new Map<string, any>();           // `${obj}:${id}` -> {id, properties}
  const parentCols = new Map<string, Record<string,string>>(); // parentItemId -> {col:text}
  const subitems = new Map<string, any[]>();         // parentItemId -> [{id,name,column_values}]
  const counts: Record<string, number> = { createSubitem: 0, deleteItem: 0, setColumns: 0 };
  let next = 900;
  const colText = (it: any, c: string) => (it.column_values.find((x:any)=>x.id===c)?.text ?? "").trim();
  const reset = () => { assoc.clear(); records.clear(); parentCols.clear(); subitems.clear(); next=900;
    for (const k in counts) counts[k]=0; };
  return { assoc, records, parentCols, subitems, counts, colText, reset, id: () => String(next++) };
});
vi.mock("../src/hubspot", () => ({
  getAssociatedIds: async (_e:any,f:string,id:string,t:string) => H.assoc.get(`${f}:${id}:${t}`) ?? [],
  getRecordsByIds: async (_e:any,o:string,ids:string[]) => ids.map(id => H.records.get(`${o}:${id}`)).filter(Boolean),
}));
vi.mock("../src/monday", () => ({
  getSubitems: async (_e:any, p:string) => H.subitems.get(p) ?? [],
  createSubitem: async (_e:any, p:string, name:string, cv:any) => { H.counts.createSubitem++;
    const sid=H.id(); const it={id:sid,name,column_values:Object.entries(cv).map(([id,v])=>({id,text:String((v as any)?.text ?? v ?? "")}))};
    H.subitems.set(p,[...(H.subitems.get(p)??[]),it]); return sid; },
  setColumns: async (_e:any, _b:string, itemId:string, cv:any) => { H.counts.setColumns++;
    // parent col write OR subitem col write
    const cur=H.parentCols.get(itemId)??{}; for (const [k,v] of Object.entries(cv)) cur[k]=String((v as any)?.text ?? v ?? ""); H.parentCols.set(itemId,cur); },
  deleteItem: async (_e:any, itemId:string) => { H.counts.deleteItem++;
    for (const [p,arr] of H.subitems) H.subitems.set(p, arr.filter(s=>s.id!==itemId)); },
}));
import { syncAssociations } from "../src/associations";
import { DEALS, COMPANIES_MYLA } from "../src/config";

const env:any={}; const opts={dryRun:false,writeHubspot:false,maxWrites:50}; const budget=()=>({left:50});
const item = (id:string, cols:{id:string;text:string}[]=[]) => ({ id, name:"x", created_at:"", updated_at:"", group:{id:"g"}, column_values: cols });
const ctx:any = { labels:{}, ownersById:{}, mondayUsersByEmail:{}, portalId:1 };
beforeEach(()=>H.reset());

it("writes associated company + contact names to the parent columns", async () => {
  H.assoc.set("deals:1:companies", ["11"]); H.records.set("companies:11", { id:"11", properties:{ name:"Acme" } });
  H.assoc.set("deals:1:contacts", ["21"]); H.records.set("contacts:21", { id:"21", properties:{ firstname:"Jo", lastname:"Lee" } });
  await syncAssociations(env, DEALS, { id:"1", properties:{} }, item("100"), ctx, opts, budget());
  const cols=H.parentCols.get("100")!;
  expect(cols[DEALS.associations!.find(a=>a.toObject==="companies")!.col!]).toBe("Acme");
  expect(cols[DEALS.associations!.find(a=>a.toObject==="contacts")!.col!]).toBe("Jo Lee");
});
it("clears the association column when there are no associations", async () => {
  await syncAssociations(env, COMPANIES_MYLA, { id:"7", properties:{} },
    item("70", [{ id: COMPANIES_MYLA.associations![0].col!, text: "Old" }]), ctx, opts, budget());
  expect(H.parentCols.get("70")![COMPANIES_MYLA.associations![0].col!]).toBe("");
});
it("creates a subitem per line item, updates existing (by Line Item ID), deletes removed", async () => {
  const li = DEALS.associations!.find(a=>a.subitems)!.subitems!;
  H.assoc.set("deals:1:line_items", ["999","888"]);
  H.records.set("line_items:999", { id:"999", properties:{ name:"A", price:"1500", quantity:"1", amount:"1500" } });
  H.records.set("line_items:888", { id:"888", properties:{ name:"B", price:"10", quantity:"2", amount:"20" } });
  // existing subitem for 999 (update) + a stale one for 777 (delete)
  H.subitems.set("100", [
    { id:"s999", name:"A-old", column_values:[{id:li.idCol,text:"999"}] },
    { id:"s777", name:"gone", column_values:[{id:li.idCol,text:"777"}] },
  ]);
  await syncAssociations(env, DEALS, { id:"1", properties:{} }, item("100"), ctx, opts, budget());
  const subs=H.subitems.get("100")!.map(s=>H.colText(s, li.idCol)).sort();
  expect(subs).toEqual(["888","999"]);           // 777 deleted, 888 created, 999 kept
  expect(H.counts.createSubitem).toBe(1); expect(H.counts.deleteItem).toBe(1);
  expect(H.parentCols.get("100")![li.countCol]).toBe("2");
  expect(H.parentCols.get("100")![li.totalCol]).toBe("1520");
});
```

- [ ] **Step 2: Run, expect fail** — `cd worker && npx vitest run test/associations.test.ts` → FAIL (module `../src/associations` not found).

- [ ] **Step 3: Implement** `worker/src/associations.ts`

```typescript
import type { AssocSpec, Budget, Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts } from "./types";
import { getAssociatedIds, getRecordsByIds } from "./hubspot";
import { createSubitem, deleteItem, getSubitems, setColumns } from "./monday";
import { formatValue } from "./mapping";
import { colText } from "./dedup";

/** HubSpot -> monday association pass. One-directional; never writes HubSpot. */
export async function syncAssociations(env: Env, spec: ObjectSpec, rec: HsRecord, item: MondayItem,
    ctx: Ctx, opts: RunOpts, budget: Budget): Promise<void> {
  for (const a of spec.associations ?? []) {
    const ids = await getAssociatedIds(env, spec.object, rec.id, a.toObject);
    if (a.subitems) { await syncLineItems(env, a, ids, item.id, opts, budget, spec.object, rec.id); continue; }
    const recs = await getRecordsByIds(env, a.toObject, ids, a.nameProps);
    const names = recs.map(r => a.nameProps.map(p => r.properties[p] ?? "").join(" ").trim())
      .filter(Boolean).join(", ");
    if (colText(item, a.col!) === names) {
      console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} count=${ids.length} action=skipped`);
      continue;
    }
    if (opts.dryRun) { console.log(`DRY assoc ${spec.object}/${rec.id} ${a.toObject}='${names}'`); continue; }
    await setColumns(env, spec.boardId, item.id, { [a.col!]: names }, opts); budget.left--;
    console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} count=${ids.length} board=${spec.boardId} item=${item.id} action=${names ? "updated-monday" : "cleared-monday"}`);
  }
}

async function syncLineItems(env: Env, a: AssocSpec, ids: string[], parentId: string, opts: RunOpts,
    budget: Budget, obj: string, recId: string): Promise<void> {
  const sub = a.subitems!;
  const lis = await getRecordsByIds(env, "line_items", ids, [...new Set([...sub.fields.map(f => f.hs), ...a.nameProps, sub.totalProp])]);
  const existing = await getSubitems(env, parentId);
  const byLi: Record<string, MondayItem> = {};
  for (const s of existing) { const k = colText(s, sub.idCol); if (k) byLi[k] = s; }
  const wantIds = new Set<string>();
  let total = 0;
  const summary: string[] = [];

  for (const li of lis) {
    wantIds.add(li.id);
    const name = a.nameProps.map(p => li.properties[p] ?? "").join(" ").trim() || `line_item ${li.id}`;
    total += Number(li.properties[sub.totalProp] ?? 0) || 0;
    summary.push(`${name} | Qty: ${li.properties["quantity"] ?? ""} | Unit Price: ${li.properties["price"] ?? ""}`);
    const cv: Record<string, unknown> = { [sub.idCol]: li.id };
    for (const f of sub.fields) { const v = formatValue(f, li.properties[f.hs], { labels: {}, ownersById: {}, mondayUsersByEmail: {}, portalId: 0 }); if (v != null) cv[f.col] = v; }
    const cur = byLi[li.id];
    if (opts.dryRun) { console.log(`DRY line_item ${li.id} on ${parentId}`); continue; }
    if (cur) {
      await setColumns(env, sub.boardId, cur.id, { ...cv, name } as any, opts); budget.left--;
      console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${li.id} subitem=${cur.id} action=updated-subitem`);
    } else {
      const sid = await createSubitem(env, parentId, name, cv, opts); budget.left--;
      console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${li.id} subitem=${sid} action=created-subitem`);
    }
  }
  for (const s of existing) {
    const k = colText(s, sub.idCol);
    if (k && !wantIds.has(k) && !opts.dryRun) {
      await deleteItem(env, s.id, opts); budget.left--;
      console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${k} subitem=${s.id} action=removed`);
    }
  }
  if (!opts.dryRun) {
    await setColumns(env, opts.dryRun ? "" : (a.col ? "" : parentId), parentId, {}, opts).catch(() => {}); // no-op guard; real writes below
  }
  // parent summary/count/total on the DEAL board (the parent item's own board id is the deal board)
  if (!opts.dryRun) {
    await setColumns(env, dealBoardOf(sub), parentId, {
      [sub.summaryCol]: summary.join("\n"),
      [sub.countCol]: String(lis.length),
      [sub.totalCol]: String(total),
    }, opts); budget.left--;
  }
  console.log(`source=hubspot object=${obj} id=${recId} association=line_items count=${lis.length} action=updated-subitems`);
}

// The parent (deal) item lives on the deal board; summary/count/total columns are on that board.
function dealBoardOf(_sub: import("./types").SubitemSpec): string { return "5029480547"; }
```

> **Note for the implementer:** simplify the parent-summary write — delete the `no-op guard` line and just do the single `setColumns(env, "5029480547", parentId, {summary,count,total})`. The `dealBoardOf` helper hard-codes the deal board id (the only board with subitems). Keep the summary/count/total write **once** after the loop.

- [ ] **Step 4: Run, expect pass** — `cd worker && npx vitest run test/associations.test.ts` → PASS. Fix any assertion drift (e.g., summary format) until green.

- [ ] **Step 5: Full suite + typecheck** — `npx vitest run && npx tsc --noEmit` → all green.

- [ ] **Step 6: Commit** — `git add worker/src/associations.ts worker/test/associations.test.ts && git commit -m "feat(associations): syncAssociations pass + line-item subitems"`

---

## Task 6: Wire the pass into the sync paths

**Files:** Modify `worker/src/sync.ts`

- [ ] **Step 1: Import** `import { syncAssociations } from "./associations";`

- [ ] **Step 2: Call it after the deal reconcile** — in `syncHubspotDeal`, after the `reconcileRecord(... linked.item ...)` / create branch, resolve the card and run the pass:

```typescript
// after reconcileRecord in the "linked && same board" branch and the "create" branch, before returning:
const card = (await findItemByColumn(env, target.boardId, target.idCol, dealId))[0];
if (card) await syncAssociations(env, target, deal, card, ctx, opts, budget);
```
(Use the spec actually reconciled — `linked.spec` or `target`. Only call when `spec.associations` exists, which `syncAssociations` already guards.)

- [ ] **Step 3: Call it in `syncHubspotRecord`** (contacts/companies) — after `reconcileRecord`, `const card=(await findItemByColumn(env, spec.boardId, spec.idCol, id))[0]; if (card) await syncAssociations(env, spec, rec, card, ctx, opts, budget);`

- [ ] **Step 4: Call it in `syncSpec`** (full reconcile) — inside the record loop, after `reconcileRecord`, for records with an existing card: `const card = byId[String(rec.id)]; if (card) await syncAssociations(env, spec, rec, card, ctx, opts, budget).catch(e => console.log(...));` (brand-new cards get associations on their next webhook/tick — documented.)

- [ ] **Step 5: Typecheck + full tests** — `npx tsc --noEmit && npx vitest run` → green.

- [ ] **Step 6: Commit** — `git add worker/src/sync.ts && git commit -m "feat(sync): run association pass on webhook + backup reconcile"`

---

## Task 7: [SCOPE-GATED] Confirm line-item property names + deploy

**Prereq:** the user has added `crm.objects.line_items.read` to the Private App.

- [ ] **Step 1: Inspect a real line item** — confirm the property names for Net Price / Service Date / Unit Discount:
```bash
set -a && . ./.env && set +a
curl -s "https://api.hubapi.com/crm/v3/objects/line_items?limit=3&properties=name,price,quantity,amount,hs_pre_discount_amount,discount,hs_discount_percentage,description,hs_recurring_billing_start_date,hs_line_item_currency_code" -H "Authorization: Bearer $HUBSPOT_ACCESS_TOKEN" \
  | python -c "import sys,json;[print(r['id'],{k:v for k,v in r['properties'].items() if v}) for r in json.load(sys.stdin).get('results',[])]"
```
Expected: 200 (not 403) with populated fields. If Net Price / Service Date / Unit Discount live under different property names, update `LINE_ITEM_SUBITEMS.fields` in `config.ts` accordingly and re-run `npx vitest run`.

- [ ] **Step 2: Deploy** — `cd worker && npx wrangler deploy`.

- [ ] **Step 3: Commit any config fix** — `git add worker/src/config.ts && git commit -m "fix(config): confirmed line-item property names"`

---

## Task 8: [OPTIONAL] Instant line-item edit webhooks

**Files:** Modify `hubspot-monday-webhook-sync/src/app/webhooks/webhooks-hsmeta.json`

- [ ] **Step 1:** add line-item subscriptions so a line-item edit fires a webhook (else edits sync on the ≤10-min backup):
```json
{ "subscriptionType": "object.creation", "objectType": "line_item", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "price", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "quantity", "active": true },
{ "subscriptionType": "object.propertyChange", "objectType": "line_item", "propertyName": "amount", "active": true }
```
(Line-item events carry the line-item id; the Worker resolves the parent deal via `getAssociatedIds("line_items", id, "deals")` and re-syncs that deal. **Only add this if you also extend `extractObjectEvents` + `handleHubspot` to map `line_item` → its deal.** If out of scope now, skip Task 8 — deal-webhook + backup already refresh line items.)

- [ ] **Step 2:** `cd hubspot-monday-webhook-sync && hs project upload --account 39939588`, then **re-install** in the portal (new `line_items.read` scope). `hs project app-install-status` should read "installed".

---

## Task 9: Live verification + docs

- [ ] **Step 1: Verify (from HubSpot UI or API)** — on a Sales-Pipeline deal: add a company, a contact, and a line item; within a few seconds (deal webhook) the deal card shows `Associated Company`, `Associated Contact`, `Line Items Summary`/`Count`/`Total`, and one **subitem** with the Line Item ID + fields. Change the line item's quantity → same subitem updates. Remove the line item → subitem deleted. On a company: add a contact → `Associated Contact` fills. On a contact: associate a company + deal → both columns fill. Remove all → columns clear.

- [ ] **Step 2: README** — add an "Associations & line items" section: HubSpot→monday-only; the exact parent columns + subitem columns; subitems (not fallback text); refresh on object-webhook + backup (association-only changes ≤10 min); the HubSpot-UI test steps above.

- [ ] **Step 3: Commit** — `git add worker/README.md && git commit -m "docs: associations + line-item subitems"`

---

## Self-Review Notes

- **Spec coverage:** deal→company/contact/line-items (Task 4 assoc + Task 5 pass); company→contact, contact→company/deal (Task 4/5); subitems dedup by Line Item ID + update + delete-on-removal (Task 5 `syncLineItems`); Summary/Count/Total (Task 5); columns created (Task 1); HubSpot→monday only, no reverse (pass never writes HubSpot); logging format (Task 5 log lines); refresh on webhook+backup (Task 6); scopes (blocker note + Task 7/8); tests (Task 5) map to spec scenarios 1–7,9,10; scenario 8 "missing column" — `setColumns` on a bad column id throws and is caught per-record (add a `.catch` log in Task 6 wiring). 
- **Discovery-driven values (not placeholders):** Task 1 creates columns → their ids fill Task 4's `PASTE_from_Task1`; Task 7 confirms the 3 uncertain line-item property names. Both have explicit produce-then-use steps.
- **Type consistency:** `AssocSpec`/`SubitemSpec` (Task 4) used by `syncAssociations`/`syncLineItems` (Task 5) and `ObjectSpec.associations` (Task 4) read in Task 6. `getAssociatedIds`/`getRecordsByIds` (Task 2), `getSubitems`/`createSubitem` (Task 3) match their call sites in Task 5.
