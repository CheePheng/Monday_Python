# Deals: Single Shared Board + Field Remap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move deal sync to ONE shared board (`5029480547`) for all sales users, remap the deal fields to the board's restructured columns (Deal Owner + Sales Users as people, Amount, Currency, Close Date, Deal Stage/Type as status), route no-`sales_user` deals into an "Unassigned Deals" **group**, retire the separate Unassigned/Rick deal boards, and delete two obsolete columns.

**Architecture:** A single `DEALS` `ObjectSpec` replaces `DEALS_MYLA` + `DEALS_UNASSIGNED`. `specForDeal` simplifies to `pipeline === "default" → DEALS` (all sales users, all dates). Grouping stays by stage, except a deal with no `sales_user` goes to the new "Unassigned Deals" group (new optional `noSalesUserGroup` on `GroupBy`). `sales_user` (a HubSpot owner id) maps to a **people** column via owner-email → monday-user (same path `hubspot_owner_id` already uses). Contacts and companies are unchanged this phase.

**Tech Stack:** TypeScript Cloudflare Worker (`worker/`), monday GraphQL v2, HubSpot CRM v3, vitest. Deploy with `npx wrangler deploy`; monday admin token in `.env` / Worker secret `MONDAY_API_TOKEN`.

---

## Context

The board `5029480547` ("Myla Mestiola Deals", to be treated as the shared board) was restructured. **Verified column ids** (from the live board):

| monday column | id | type | HubSpot property |
|---|---|---|---|
| Deal Owner | `person` | people | `hubspot_owner_id` |
| Sales Users | `multiple_person_mm532m82` | people | `sales_user` |
| Amounts | `numeric_mm531t6e` | numbers | `amount` |
| Currency | `color_mm53vk99` | status | `deal_currency_code` |
| Close Date | `date_mm53ecz3` | date | `closedate` |
| Deal Stage | `color_mm53fh1r` | status | `dealstage` |
| Deal Pipeline | `color_mm4ws6k` | status | `pipeline` |
| Deal Type | `color_mm53cky8` | status | `dealtype` |
| Priority | `dropdown_mm4nmmax` | dropdown | `hs_priority` |
| Vendors-厂商来源 | `dropdown_mm4n4f7r` | dropdown | `vendorschang_shang_lai_yuan` |
| HubSpot Deal ID | `numeric_mm4nz332` | numbers | (idCol) |
| Sync State | `text_mm4xxyzx` | text | (syncStateCol) |
| HubSpot Link | `link_mm4ns4nn` | link | (linkCol) |
| **DELETE** — Sales User (dropdown) | `dropdown_mm4wjkk9` | dropdown | (obsolete) |
| **DELETE** — Date Created | `date4` | date | (obsolete) |

The **stage→group** ids and the new **"Unassigned Deals" group** id are re-confirmed live in Task 1 (the board was edited, so we verify rather than trust the old config).

**Decisions (confirmed with the user):**
- One shared board `5029480547`; **retire** `Unassigned Deals` (5029479220) and `Rick Avery Antonio Deals` (5029547330) from the config (stop syncing them). Per-user visibility is handled by monday permissions/filters.
- Deals only this phase — contacts (`CONTACTS_MYLA`) and companies (`COMPANIES_MYLA`) are unchanged.
- No-`sales_user` deals go to the "Unassigned Deals" **group** on the shared board (not a separate board).
- The two obsolete columns are deleted **by this plan** (via the monday API).
- New fields (`amount`, `deal_currency_code`, `closedate`, plus the `sales_user`/`hubspot_owner_id` people columns) are **HubSpot-authoritative → forward-only** (no reverse write). Existing reversible fields (`dealname`, `dealtype`, `hs_priority`, `vendorschang_shang_lai_yuan`, and stage via group-move) keep two-way behavior.

## File Structure

| File | Change |
|---|---|
| `worker/src/types.ts` | Add optional `noSalesUserGroup` to the prop-map `GroupBy` variant. |
| `worker/src/routing.ts` | `targetGroup`: return `noSalesUserGroup` when the record has no `sales_user`. |
| `worker/src/config.ts` | Replace `DEALS_MYLA` + `DEALS_UNASSIGNED` with one `DEALS` spec (new columns, new group logic, pipeline-only filter). Update `STAGE_GROUPS`, add `UNASSIGNED_GROUP`, update `ALL_SPECS` / `DEAL_SPECS`. |
| `worker/src/sync.ts` | `specForDeal` → `pipeline === "default" ? DEALS : null`; swap imports `DEALS_MYLA/DEALS_UNASSIGNED` → `DEALS`. |
| `worker/test/routing.test.ts` | Test `noSalesUserGroup`. |
| `worker/test/webhook.test.ts` | Update `specForDeal` tests for the one-board routing. |
| `worker/test/sync.test.ts` | Rename `DEALS_MYLA` → `DEALS`. |
| `worker/README.md` | Document the shared board, new fields, group routing, retired boards. |
| monday board `5029480547` | Delete columns `dropdown_mm4wjkk9` and `date4` (API step). |

---

## Task 1: Discovery — confirm live group ids, columns, and HubSpot property names

**Files:** none (read-only verification; record outputs for Task 3).

- [ ] **Step 1: Get the board's group ids** (stage groups + the new "Unassigned Deals" group)

Run (from repo root; `.env` holds `MONDAY_API_TOKEN`):
```bash
set -a && . ./.env && set +a
curl -s -X POST "https://api.monday.com/v2" \
  -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2024-10" \
  -d '{"query":"query { boards(ids:[5029480547]) { groups { id title } } }"}' \
  | python -c "import sys,json;[print(g['id'],'|',g['title']) for g in json.load(sys.stdin)['data']['boards'][0]['groups']]"
```
Expected: a list like `group_mm4nf6fw | Appointment Scheduled`, plus one titled **`Unassigned Deals`**.
Record: the id of the `Unassigned Deals` group → this is `UNASSIGNED_GROUP` in Task 3. Confirm each stage-group id below still matches (update Task 3's `STAGE_GROUPS` if any changed):
`appointmentscheduled=group_mm4nf6fw, qualifiedtobuy=group_title, presentationscheduled=group_mm4pa9zg, decisionmakerboughtin=group_mm4pbazz, contractsent=group_mm4pavfa, closedwon=group_mm4py571, closedlost=group_mm4pw6e2, 2831885024=group_mm4pdres`.

- [ ] **Step 2: Confirm HubSpot deal property names + sample values**

```bash
set -a && . ./.env && set +a
curl -s -X POST "https://api.hubapi.com/crm/v3/objects/deals/search" \
  -H "Authorization: Bearer $HUBSPOT_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"filterGroups":[{"filters":[{"propertyName":"pipeline","operator":"EQ","value":"default"}]}],"sorts":[{"propertyName":"hs_lastmodifieddate","direction":"DESCENDING"}],"properties":["amount","deal_currency_code","closedate","dealstage","dealtype","hubspot_owner_id","sales_user"],"limit":3}' \
  | python -c "import sys,json;[print(r['id'], r['properties']) for r in json.load(sys.stdin)['results']]"
```
Expected: keys `amount`, `deal_currency_code`, `closedate`, `dealstage`, `dealtype`, `hubspot_owner_id`, `sales_user` return values (some may be null). If `deal_currency_code` is absent/empty on every deal, use the property that holds the currency code instead and note it for Task 3's `deal_currency_code` mapping.

- [ ] **Step 3: Confirm the obsolete columns still exist (to delete in Task 2)**

```bash
set -a && . ./.env && set +a
curl -s -X POST "https://api.monday.com/v2" \
  -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2024-10" \
  -d '{"query":"query { boards(ids:[5029480547]) { columns { id title } } }"}' \
  | python -c "import sys,json;print([c for c in json.load(sys.stdin)['data']['boards'][0]['columns'] if c['id'] in ('dropdown_mm4wjkk9','date4')])"
```
Expected: shows `dropdown_mm4wjkk9` (Sales User) and `date4` (Date Created). If either is already gone, skip it in Task 2.

---

## Task 2: Delete the two obsolete monday columns

**Files:** none (monday API mutation).

- [ ] **Step 1: Delete `dropdown_mm4wjkk9` (old "Sales User" dropdown) and `date4` (old "Date Created")**

```bash
set -a && . ./.env && set +a
for COL in dropdown_mm4wjkk9 date4; do
  curl -s -X POST "https://api.monday.com/v2" \
    -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2024-10" \
    -d "{\"query\":\"mutation { delete_column(board_id:5029480547, column_id:\\\"$COL\\\") { id } }\"}"
  echo " <- deleted $COL"
done
```
Expected: each returns `{"data":{"delete_column":{"id":"<COL>"}}}`.

- [ ] **Step 2: Verify they are gone**

Re-run Task 1 Step 3's query. Expected: empty list `[]`.

> Note: do this BEFORE deploying the new config so the code never references a column that a monday user might still be looking at mid-migration. The code stops mapping them in Task 3 regardless.

---

## Task 3: Add `noSalesUserGroup` to the GroupBy type and routing

**Files:**
- Modify: `worker/src/types.ts`
- Modify: `worker/src/routing.ts`
- Test: `worker/test/routing.test.ts`

- [ ] **Step 1: Write the failing test** (append inside `describe("targetGroup", …)` in `worker/test/routing.test.ts`)

```typescript
const withNoOwner: ObjectSpec = {
  ...grouped,
  groupBy: { prop: "dealstage", map: { closedwon: "g6" }, reverse: true, noSalesUserGroup: "gUnassigned" },
};

describe("targetGroup noSalesUserGroup", () => {
  it("routes a deal with no sales_user to the unassigned group", () =>
    expect(targetGroup({ id: "1", properties: { dealstage: "closedwon", sales_user: "" } }, withNoOwner)).toBe("gUnassigned"));
  it("a deal WITH a sales_user still uses its stage group", () =>
    expect(targetGroup({ id: "1", properties: { dealstage: "closedwon", sales_user: "555" } }, withNoOwner)).toBe("g6"));
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd worker && npx vitest run test/routing.test.ts -t "noSalesUserGroup"`
Expected: FAIL — `noSalesUserGroup` not in the type / not honored (returns "g6" for the no-owner case).

- [ ] **Step 3: Add the type field** (`worker/src/types.ts`, the prop-map `GroupBy` variant)

```typescript
export type GroupBy =
  // hs value -> monday group id. fallbackGroup catches empty/unmapped values so the record is placed
  // instead of skipped. noSalesUserGroup overrides placement when the record has no sales_user.
  | { prop: string; map: Record<string, string>; reverse: boolean; fallbackGroup?: string; noSalesUserGroup?: string }
  | { singleGroup: string };
```

- [ ] **Step 4: Honor it in `targetGroup`** (`worker/src/routing.ts`)

```typescript
export function targetGroup(rec: HsRecord, spec: ObjectSpec): string | null {
  if ("singleGroup" in spec.groupBy) return spec.groupBy.singleGroup;
  // No sales_user -> the "Unassigned Deals" group (when configured), regardless of stage.
  if (spec.groupBy.noSalesUserGroup && !(rec.properties.sales_user ?? "").trim())
    return spec.groupBy.noSalesUserGroup;
  const v = rec.properties[spec.groupBy.prop];
  const mapped = v ? spec.groupBy.map[v] : undefined;   // empty OR unmapped value ->
  return mapped ?? spec.groupBy.fallbackGroup ?? null;  // fall back so the record isn't skipped
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd worker && npx vitest run test/routing.test.ts`
Expected: PASS (all routing tests).

- [ ] **Step 6: Commit**

```bash
git add worker/src/types.ts worker/src/routing.ts worker/test/routing.test.ts
git commit -m "feat(routing): noSalesUserGroup places owner-less deals in the Unassigned group"
```

---

## Task 4: Replace the deal specs with one shared `DEALS` spec

**Files:**
- Modify: `worker/src/config.ts`

- [ ] **Step 1: Replace `STAGE_GROUPS` region — add the Unassigned group constant**

Replace the `STAGE_GROUPS` block (lines ~21-31) with (use the `UNASSIGNED_GROUP` id from Task 1 Step 1; update any stage-group id Task 1 flagged as changed):

```typescript
// HubSpot stage id -> monday group id (shared Deals board 5029480547)
const STAGE_GROUPS: Record<string, string> = {
  appointmentscheduled: "group_mm4nf6fw",
  qualifiedtobuy: "group_title",
  presentationscheduled: "group_mm4pa9zg",
  decisionmakerboughtin: "group_mm4pbazz",
  contractsent: "group_mm4pavfa",
  closedwon: "group_mm4py571",
  closedlost: "group_mm4pw6e2",
  "2831885024": "group_mm4pdres",
};
// Deals with no sales_user land here (the "Unassigned Deals" group added on 5029480547). From Task 1.
const UNASSIGNED_GROUP = "PASTE_UNASSIGNED_GROUP_ID_FROM_TASK_1";
```

- [ ] **Step 2: Replace both `DEALS_MYLA` and `DEALS_UNASSIGNED` (lines ~45-101) with one `DEALS` spec**

```typescript
export const DEALS: ObjectSpec = {
  object: "deals",
  objectTypeId: "0-3",
  // One shared board for ALL sales users: every Sales-Pipeline deal, any/no sales_user, all dates.
  searchFilters: [
    { propertyName: "pipeline", operator: "EQ", value: "default" },
  ],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"],
  nameReverse: "dealname",
  boardId: "5029480547",
  idCol: "numeric_mm4nz332",
  syncStateCol: "text_mm4xxyzx",
  linkCol: "link_mm4ns4nn",
  // Group by stage; deals with no sales_user go to the Unassigned Deals group instead.
  groupBy: { prop: "dealstage", map: STAGE_GROUPS, reverse: true, noSalesUserGroup: UNASSIGNED_GROUP },
  createFromMonday: true,
  // A card added by a salesperson creates a Sales-Pipeline deal; owner/sales_user are set in HubSpot
  // (or via the person columns) afterward — until then it sits in the Unassigned group.
  createDefaults: { pipeline: "default" },
  fields: [
    { hs: "hubspot_owner_id", col: "person", type: "people" },                                     // Deal Owner
    { hs: "sales_user", col: "multiple_person_mm532m82", type: "people" },                          // Sales Users
    { hs: "amount", col: "numeric_mm531t6e", type: "numbers" },                                     // Amounts
    { hs: "deal_currency_code", col: "color_mm53vk99", type: "status" },                            // Currency
    { hs: "closedate", col: "date_mm53ecz3", type: "date" },                                        // Close Date
    { hs: "dealstage", col: "color_mm53fh1r", type: "status", labels: "stage" },                    // Deal Stage
    { hs: "pipeline", col: "color_mm4ws6k", type: "status", labels: "pipeline" },                   // Deal Pipeline
    { hs: "dealtype", col: "color_mm53cky8", type: "status", labels: "dealtype", reverse: true },   // Deal Type
    { hs: "hs_priority", col: "dropdown_mm4nmmax", type: "dropdown", labels: "priority", reverse: true },        // Priority
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm4n4f7r", type: "dropdown", labels: "vendor", reverse: true }, // Vendors
  ],
};
```

- [ ] **Step 3: Update the spec collections** (bottom of `config.ts`, lines ~166-173)

```typescript
export const ALL_SPECS: ObjectSpec[] = [DEALS, COMPANIES_MYLA, CONTACTS_MYLA];

// Deal boards a HubSpot deal webhook can route to (now just the one shared board).
export const DEAL_SPECS: ObjectSpec[] = [DEALS];

// boardId -> spec, so a monday webhook can find the spec for the board that fired it.
export const SPEC_BY_BOARD: Record<string, ObjectSpec> =
  Object.fromEntries(ALL_SPECS.map(s => [s.boardId, s]));
```

- [ ] **Step 4: Byte-check the types compile**

Run: `cd worker && npx tsc --noEmit`
Expected: FAILS in `sync.ts` / tests referencing `DEALS_MYLA` / `DEALS_UNASSIGNED` (fixed in Tasks 5-6). `config.ts` itself must have no errors — if `tsc` reports a `config.ts` error, fix it before moving on.

- [ ] **Step 5: Commit**

```bash
git add worker/src/config.ts
git commit -m "feat(config): single shared DEALS spec (remapped columns, unassigned group)"
```

---

## Task 5: Simplify `specForDeal` and fix `sync.ts` imports

**Files:**
- Modify: `worker/src/sync.ts`

- [ ] **Step 1: Swap the deal imports** — in the `from "./config"` import block, replace `DEALS_MYLA, DEALS_UNASSIGNED` with `DEALS` (keep `CREATED_AFTER_MS`, `SALES_USER_MYLA`, `COMPANIES_MYLA`, `CONTACTS_MYLA`, etc. — they're still used by the contact/company scope check).

```typescript
import {
  ALL_SPECS, COMPANIES_MYLA, CONTACTS_MYLA, CREATE_CUTOFF_MS, CREATED_AFTER_MS, DEAL_SPECS,
  DEALS, PORTAL_ID, SALES_USER_MYLA, SPEC_BY_BOARD,
} from "./config";
```

- [ ] **Step 2: Replace `specForDeal`** (the whole function)

```typescript
/** Which board a HubSpot deal belongs to. One shared board now: any Sales-Pipeline deal (all sales
 * users, all dates); no-sales_user deals still land here, just in the Unassigned group (see targetGroup). */
export function specForDeal(deal: { properties: Record<string, string | null> }): ObjectSpec | null {
  return deal.properties.pipeline === "default" ? DEALS : null;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: only test files may still error (Task 6). `src/**` must be clean.

- [ ] **Step 4: Commit**

```bash
git add worker/src/sync.ts
git commit -m "feat(sync): specForDeal routes every default-pipeline deal to the shared board"
```

---

## Task 6: Update tests for one-board routing + `DEALS` rename

**Files:**
- Modify: `worker/test/webhook.test.ts`
- Modify: `worker/test/sync.test.ts`

- [ ] **Step 1: Replace the `specForDeal` describe block in `worker/test/webhook.test.ts`**

```typescript
describe("specForDeal (HubSpot deal -> shared board routing)", () => {
  it("a default-pipeline deal (any sales_user) -> shared Deals board", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "1739141284", createdate: RECENT }))?.boardId)
      .toBe("5029480547"));

  it("a default-pipeline deal with NO sales_user -> shared Deals board (Unassigned group)", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "", createdate: RECENT }))?.boardId)
      .toBe("5029480547"));

  it("a different (non-Myla) sales_user -> shared Deals board too", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "999", createdate: RECENT }))?.boardId)
      .toBe("5029480547"));

  it("an OLD deal still routes (all dates on the shared board)", () =>
    expect(specForDeal(deal({ pipeline: "default", sales_user: "1739141284", createdate: OLD }))?.boardId)
      .toBe("5029480547"));

  it("a non-default pipeline -> null", () =>
    expect(specForDeal(deal({ pipeline: "someothersalespipeline", sales_user: "1739141284", createdate: RECENT })))
      .toBeNull());
});
```

- [ ] **Step 2: Rename the constant in `worker/test/sync.test.ts`** — update the config import and the `BOARD`/`ID_COL` derivations:

```typescript
import { COMPANIES_MYLA, CONTACTS_MYLA, DEALS, SALES_USER_MYLA } from "../src/config";
```
and change `const BOARD = DEALS_MYLA.boardId;` / `const ID_COL = DEALS_MYLA.idCol;` / `const SYNC_COL = DEALS_MYLA.syncStateCol;` to use `DEALS` instead of `DEALS_MYLA` (search-replace `DEALS_MYLA` → `DEALS` in this file).

- [ ] **Step 3: Run the whole suite**

Run: `cd worker && npx vitest run`
Expected: PASS. If a deal reconcile test fails on a group id, confirm `group_mm4nf6fw` (appointmentscheduled) still matches Task 1's output and update the test's `GROUP` constant if needed.

- [ ] **Step 4: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add worker/test/webhook.test.ts worker/test/sync.test.ts
git commit -m "test: one shared deals board routing + DEALS rename"
```

---

## Task 7: Deploy and verify live

**Files:** none.

- [ ] **Step 1: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: `Deployed hubspot-monday-sync` with a new Version ID.

- [ ] **Step 2: Verify a deal WITH a sales_user syncs the new fields** — edit one field on a `default`-pipeline deal in HubSpot (e.g. bump `amount`), then within seconds check its card on board `5029480547`:

```bash
set -a && . ./.env && set +a
# replace <DEALID> with a deal you just edited
curl -s -X POST "https://api.monday.com/v2" -H "Authorization: $MONDAY_API_TOKEN" -H "Content-Type: application/json" -H "API-Version: 2024-10" \
  -d '{"query":"query { items_page_by_column_values(limit:1, board_id:5029480547, columns:[{column_id:\"numeric_mm4nz332\", column_values:[\"<DEALID>\"]}]) { items { name group { id } column_values(ids:[\"person\",\"multiple_person_mm532m82\",\"numeric_mm531t6e\",\"color_mm53vk99\",\"date_mm53ecz3\",\"color_mm53fh1r\"]) { id text } } } }"}'
```
Expected: `person` (Deal Owner) and `multiple_person_mm532m82` (Sales Users) show people, `numeric_mm531t6e` the amount, `color_mm53vk99` the currency, `date_mm53ecz3` the close date, `color_mm53fh1r` the stage; `group.id` is the deal's stage group.

- [ ] **Step 3: Verify a deal with NO sales_user lands in the Unassigned group** — pick/POST a `default`-pipeline deal with `sales_user` empty, wait a few seconds, and confirm its card's `group.id` equals `UNASSIGNED_GROUP` (same query as Step 2).

- [ ] **Step 4: Confirm the retired boards are no longer written** — run `npx wrangler tail` briefly; you should see `source=hubspot ... board=5029480547` and no writes to `5029479220` / `5029547330`.

- [ ] **Step 5: (Optional) trigger a full backfill of all sales users' deals** — the shared board now includes every `default`-pipeline deal. Let the daily full reconcile fill it in, or run the manual sweep:
```bash
# needs the TRIGGER_SECRET header; maxWrites high on Workers Paid
curl -H "X-Trigger-Secret: <SECRET>" "https://hubspot-monday-sync.askada.workers.dev/run?object=deals&mode=live&maxWrites=500"
```

---

## Task 8: Docs + memory

**Files:**
- Modify: `worker/README.md`

- [ ] **Step 1: Update the "What it does" table row for deals** — one board for all sales users:

Change the deals rows to a single line:
```markdown
| Deals `5029480547` | deals (pipeline = Sales Pipeline, ALL sales users) | deal stage (no sales_user → "Unassigned Deals" group) | all dates |
```
Remove the separate `Unassigned Deals 5029479220` row.

- [ ] **Step 2: Add a note under the deals description**

```markdown
**Deals — one shared board:** every Sales-Pipeline deal (any owner) syncs to `5029480547`; per-user
visibility is done with monday permissions/filters. `hubspot_owner_id` → **Deal Owner** (person),
`sales_user` → **Sales Users** (person), plus `amount`, `deal_currency_code` (Currency status), and
`closedate` (Close Date) — all HubSpot-authoritative. Deals with no `sales_user` sit in the
**Unassigned Deals** group. The old `Unassigned Deals`/`Rick …` deal boards are retired.
```

- [ ] **Step 3: Commit**

```bash
git add worker/README.md
git commit -m "docs: shared deals board + new field mappings"
```

---

## Self-Review Notes

- **Spec coverage:** Deal Owner→person (kept, Task 4 field `person`); Amount (Task 4 `numeric_mm531t6e`); Currency (Task 4 `color_mm53vk99` status); Close Date (Task 4 `date_mm53ecz3`); Sales Users as a person (Task 4 `multiple_person_mm532m82`); one board for all sales users (Tasks 4-5, `specForDeal` + single `DEALS`); no-sales_user → Unassigned group (Tasks 3-4, `noSalesUserGroup`); delete Date Created + old Sales User dropdown (Task 2). All requirements mapped.
- **Type consistency:** `noSalesUserGroup` defined in `GroupBy` (Task 3 Step 3) and read in `targetGroup` (Task 3 Step 4) and set in `DEALS.groupBy` (Task 4 Step 2). `DEALS` exported (Task 4) and imported in `sync.ts` (Task 5) and tests (Task 6). `DEAL_SPECS`/`ALL_SPECS`/`SPEC_BY_BOARD` updated (Task 4 Step 3).
- **One placeholder by necessity:** `UNASSIGNED_GROUP` in Task 4 Step 1 is filled from Task 1 Step 1's live query (the board was just edited, so the id must be read live, not guessed). Every other id is verified.
- **Out of scope (unchanged):** contacts (`CONTACTS_MYLA`), companies (`COMPANIES_MYLA`), the HubSpot webhook app, cron cadence. `createFromMonday` deal defaults are trimmed to `{pipeline:"default"}` — a monday-created deal is unassigned until an owner is set (documented limitation, acceptable this phase).
