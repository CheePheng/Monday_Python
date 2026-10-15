# Deal Cockpit v2 (UX upgrade) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the shipped Deal Cockpit into a self-sufficient sales interface: real Company/Contact names + sort + wider search + delete, a Kanban pipeline, faster/fresher data, richer line items, inline new-contact/company creation, surfaced errors, input validation, and per-currency KPIs.

**Architecture:** Almost entirely the React app (`monday-app/`) + `monday.api`. One Worker touch-point: a session-authed `DELETE /app/deal` that archives the HubSpot deal. All correctness-critical logic goes into pure functions built test-first (vitest); monday/HubSpot I/O and UI follow the existing repo pattern (pure logic unit-tested, I/O verified live). **Note:** the Worker's `reverseLineItems` already maps every `sub.fields` entry on create (associations.ts:87-91), so description/discount/service-date need no Worker change — only new subitem columns in the app.

**Tech Stack:** TypeScript; Cloudflare Workers (`wrangler`, `vitest`); React 18, Vite, `monday-sdk-js`, custom CSS design system (`monday-app/src/styles.css`), HTML5 drag-and-drop (no new dep).

**Spec:** `docs/superpowers/specs/2026-07-14-deal-cockpit-v2-ux.md`.

**Column ids (new this round):** subitem discount `numeric_mm53pkyf`, service date `date_mm53chbv` (description `long_text_mm53a511` already in SUB_COLS). All HubSpot ids are strings.

---

# PHASE 1 — Worker: archive-deal endpoint

## Task 1: `DELETE /app/deal` (archive HubSpot deal)

**Files:** Modify `worker/src/hubspot.ts`, `worker/src/app-routes.ts`, `worker/src/index.ts`; Test `worker/test/app-routes.test.ts`.

- [ ] **Step 1: Failing test** — append to `worker/test/app-routes.test.ts`:

```typescript
import { parseDealBody } from "../src/app-routes";

describe("parseDealBody", () => {
  it("accepts a numeric hubspotDealId", () =>
    expect(parseDealBody({ hubspotDealId: "9001" })).toEqual({ ok: true, hubspotDealId: "9001" }));
  it("rejects missing / non-numeric", () => {
    expect(parseDealBody({}).ok).toBe(false);
    expect(parseDealBody({ hubspotDealId: "abc" }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect fail** — `cd worker && npx vitest run test/app-routes.test.ts` → FAIL (`parseDealBody` missing).

- [ ] **Step 3: Implement `parseDealBody`** — append to `worker/src/app-routes.ts`:

```typescript
export interface DealReq { ok: boolean; hubspotDealId?: string; error?: string }
export function parseDealBody(body: any): DealReq {
  const hubspotDealId = body?.hubspotDealId;
  if (!numeric(hubspotDealId)) return { ok: false, error: "hubspotDealId must be a numeric string" };
  return { ok: true, hubspotDealId };
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/app-routes.test.ts` → PASS.

- [ ] **Step 5: Add `archiveDeal`** — in `worker/src/hubspot.ts`, after `deleteLineItem`:

```typescript
/** Archive (soft-delete) a HubSpot deal by id. Idempotent; 404 -> already gone. */
export async function archiveDeal(env: Env, dealId: string, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) { console.log(`DRY hubspot ARCHIVE deal ${dealId}`); return false; }
  try {
    await hs(env, "DELETE", `/crm/v3/objects/deals/${dealId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot ARCHIVE deal ${dealId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot ARCHIVE deal ${dealId}`);
  return true;
}
```

- [ ] **Step 6: Wire the route** — in `worker/src/index.ts`: add `archiveDeal` to the `./hubspot` import and `parseDealBody` to the `./app-routes` import; then add this block inside the `/app/` section, next to the `/app/association` block:

```typescript
      // DELETE /app/deal {hubspotDealId} — archive the HubSpot deal (removes it from both systems)
      if (url.pathname === "/app/deal" && req.method === "DELETE") {
        const body = await req.json().catch(() => ({}));
        const d = parseDealBody(body);
        if (!d.ok) return Response.json({ error: d.error }, { status: 400, headers: CORS });
        try {
          await archiveDeal(env, d.hubspotDealId!, appWriteOpts(env));
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/deal] archive ${d.hubspotDealId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
        }
      }
```

- [ ] **Step 7: Verify + commit** — `cd worker && npx tsc --noEmit && npx vitest run` (all pass). Commit:
```bash
git add worker/src/hubspot.ts worker/src/app-routes.ts worker/src/index.ts worker/test/app-routes.test.ts
git commit -m "feat(worker): DELETE /app/deal archives the HubSpot deal"
```

---

# PHASE 2 — App pure libs (TDD)

## Task 2: `lib/sort.ts` — sortDeals

**Files:** Create `monday-app/src/lib/sort.ts` + `monday-app/src/lib/sort.test.ts`.

- [ ] **Step 1: Failing test** — `sort.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sortDeals, type SortKey } from "./sort";
import type { DealRow } from "./filter";

const R = (o: Partial<DealRow>): DealRow => ({ id: "x", name: "", stage: "", salesUserIds: [], ...o });
const rows: DealRow[] = [
  R({ id: "1", name: "Beta", amount: "500", closeDate: "2026-09-01", company: "Zeta" }),
  R({ id: "2", name: "Alpha", amount: "1500", closeDate: "2026-07-01", company: "Acme" }),
  R({ id: "3", name: "Gamma", amount: "", closeDate: "2026-08-01", company: "" }),
];
const ids = (rs: DealRow[]) => rs.map(r => r.id);

describe("sortDeals", () => {
  it("name asc / desc", () => {
    expect(ids(sortDeals(rows, "name", "asc"))).toEqual(["2", "1", "3"]);
    expect(ids(sortDeals(rows, "name", "desc"))).toEqual(["3", "1", "2"]);
  });
  it("amount numeric (blank treated as 0)", () =>
    expect(ids(sortDeals(rows, "amount", "asc"))).toEqual(["3", "1", "2"]));
  it("closeDate ascending (ISO)", () =>
    expect(ids(sortDeals(rows, "closeDate", "asc"))).toEqual(["2", "3", "1"]));
  it("does not mutate input", () => { const c = [...rows]; sortDeals(rows, "name", "asc"); expect(rows).toEqual(c); });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — `sort.ts`:

```typescript
import type { DealRow } from "./filter";
export type SortKey = "name" | "stage" | "amount" | "closeDate" | "company" | "contact";

const num = (v?: string) => { const n = Number(v); return isFinite(n) ? n : 0; };

/** Pure, non-mutating sort of deal rows. amount is numeric; the rest compare as strings. */
export function sortDeals(rows: DealRow[], key: SortKey, dir: "asc" | "desc"): DealRow[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (key === "amount") return (num(a.amount) - num(b.amount)) * sign;
    const av = String(a[key] ?? ""), bv = String(b[key] ?? "");
    return av.localeCompare(bv) * sign;
  });
}
```

- [ ] **Step 4: Run, expect pass. Commit** `git add monday-app/src/lib/sort.* && git commit -m "feat(monday-app): pure sortDeals"`.

## Task 3: widen `filterDeals` search (company/contact)

**Files:** Modify `monday-app/src/lib/filter.ts` + `monday-app/src/lib/filter.test.ts`.

- [ ] **Step 1: Add failing test** — append to `filter.test.ts`:

```typescript
it("search also matches company and contact", () => {
  const rs: DealRow[] = [
    { id: "1", name: "Deal one", stage: "s", salesUserIds: [], company: "Acme Corp" },
    { id: "2", name: "Deal two", stage: "s", salesUserIds: [], contact: "Jane Acme" },
    { id: "3", name: "Deal three", stage: "s", salesUserIds: [], company: "Beta" },
  ];
  expect(filterDeals(rs, { q: "acme" }).map(r => r.id)).toEqual(["1", "2"]);
});
```
(`DealRow` in this file needs `company`/`contact` — already present.)

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — replace the `q` line in `filterDeals`:

```typescript
    if (q) {
      const hay = `${r.name} ${r.company ?? ""} ${r.contact ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
```

- [ ] **Step 4: Run, expect pass. Commit** `git commit -am "feat(monday-app): search matches company + contact"`.

## Task 4: `lib/validate.ts` — validateDealForm

**Files:** Create `monday-app/src/lib/validate.ts` + `.test.ts`.

- [ ] **Step 1: Failing test:**

```typescript
import { describe, it, expect } from "vitest";
import { validateDealForm } from "./validate";
describe("validateDealForm", () => {
  it("ok with name + stage + numeric amount", () =>
    expect(validateDealForm("Acme", { stage: "Contract Sent", amount: "1500" }).ok).toBe(true));
  it("requires name and stage", () => {
    const r = validateDealForm("", { stage: "" });
    expect(r.ok).toBe(false); expect(r.errors.name).toBeTruthy(); expect(r.errors.stage).toBeTruthy();
  });
  it("rejects a non-numeric amount, allows empty", () => {
    expect(validateDealForm("A", { stage: "s", amount: "abc" }).errors.amount).toBeTruthy();
    expect(validateDealForm("A", { stage: "s", amount: "" }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** — `validate.ts`:

```typescript
export interface DealErrors { name?: string; stage?: string; amount?: string }
export function validateDealForm(name: string, form: { stage?: string; amount?: string }): { ok: boolean; errors: DealErrors } {
  const errors: DealErrors = {};
  if (!name.trim()) errors.name = "Deal name is required";
  if (!form.stage) errors.stage = "Stage is required";
  if (form.amount && !/^\d+(\.\d+)?$/.test(form.amount.trim())) errors.amount = "Amount must be a number";
  return { ok: Object.keys(errors).length === 0, errors };
}
```

- [ ] **Step 4: Run, expect pass. Commit** `git add monday-app/src/lib/validate.* && git commit -m "feat(monday-app): deal form validation"`.

## Task 5: `lib/totals.ts` — line-item totals

**Files:** Create `monday-app/src/lib/totals.ts` + `.test.ts`.

- [ ] **Step 1: Failing test:**

```typescript
import { describe, it, expect } from "vitest";
import { lineTotal, lineItemsTotal } from "./totals";
describe("line totals", () => {
  it("lineTotal = quantity × (unitPrice − discount)", () =>
    expect(lineTotal({ quantity: "2", unitPrice: "100", discount: "10" })).toBe(180));
  it("blanks default to 0; never negative", () => {
    expect(lineTotal({ quantity: "3", unitPrice: "50" })).toBe(150);
    expect(lineTotal({ quantity: "1", unitPrice: "5", discount: "999" })).toBe(0);
  });
  it("lineItemsTotal sums", () =>
    expect(lineItemsTotal([{ quantity: "2", unitPrice: "100" }, { quantity: "1", unitPrice: "50" }])).toBe(250));
});
```

- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** — `totals.ts`:

```typescript
export interface TotalInput { quantity?: string; unitPrice?: string; discount?: string }
const n = (v?: string) => { const x = Number(v); return isFinite(x) ? x : 0; };
export function lineTotal(li: TotalInput): number { return Math.max(0, n(li.quantity) * (n(li.unitPrice) - n(li.discount))); }
export function lineItemsTotal(items: TotalInput[]): number { return items.reduce((s, li) => s + lineTotal(li), 0); }
```

- [ ] **Step 4: Run, expect pass. Commit** `git add monday-app/src/lib/totals.* && git commit -m "feat(monday-app): line-item totals"`.

## Task 6: `lib/kpi.ts` — KPIs incl. per-currency pipeline

**Files:** Create `monday-app/src/lib/kpi.ts` + `.test.ts`.

- [ ] **Step 1: Failing test:**

```typescript
import { describe, it, expect } from "vitest";
import { computeKpis } from "./kpi";
import type { DealRow } from "./filter";
const R = (o: Partial<DealRow>): DealRow => ({ id: "x", name: "", stage: "", salesUserIds: [], ...o });
describe("computeKpis", () => {
  const rows = [
    R({ stage: "Contract Sent", amount: "1000", currency: "USD" }),
    R({ stage: "Qualified To Buy", amount: "500", currency: "USD" }),
    R({ stage: "Appointment", amount: "300", currency: "CNY" }),
    R({ stage: "Closed Won", amount: "9", currency: "USD" }),
    R({ stage: "Closed Lost", amount: "9", currency: "USD" }),
  ];
  it("groups open pipeline by currency (desc), counts active, won, win rate", () => {
    const k = computeKpis(rows);
    expect(k.pipeline).toEqual([{ currency: "USD", total: 1500 }, { currency: "CNY", total: 300 }]);
    expect(k.active).toBe(3); expect(k.won).toBe(1); expect(k.winRate).toBe(50);
  });
});
```

- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** — `kpi.ts`:

```typescript
import type { DealRow } from "./filter";
export interface Kpis { pipeline: { currency: string; total: number }[]; active: number; won: number; winRate: number }
const isWon = (s: string) => /won/i.test(s);
const isLost = (s: string) => /lost/i.test(s);

export function computeKpis(rows: DealRow[]): Kpis {
  const open = rows.filter(r => !isWon(r.stage) && !isLost(r.stage));
  const by = new Map<string, number>();
  for (const r of open) { const n = Number(r.amount); if (isFinite(n) && n) by.set(r.currency || "?", (by.get(r.currency || "?") ?? 0) + n); }
  const pipeline = [...by.entries()].map(([currency, total]) => ({ currency, total })).sort((a, b) => b.total - a.total);
  const won = rows.filter(r => isWon(r.stage)).length;
  const lost = rows.filter(r => isLost(r.stage)).length;
  return { pipeline, active: open.length, won, winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0 };
}
```

- [ ] **Step 4: Run, expect pass. Commit** `git add monday-app/src/lib/kpi.* && git commit -m "feat(monday-app): KPI compute with per-currency pipeline"`.

---

# PHASE 3 — App data layer

## Task 7: subitem columns + line-item encoder

**Files:** Modify `monday-app/src/board-config.ts`, `monday-app/src/lib/columns.ts`, `monday-app/src/lib/columns.test.ts`.

- [ ] **Step 1:** In `board-config.ts` `SUB_COLS`, add after `quantity`:
```typescript
  discount:   { id: "numeric_mm53pkyf",    kind: "numeric" },
  serviceDate:{ id: "date_mm53chbv",       kind: "date" },
```
- [ ] **Step 2:** In `lib/columns.ts`, extend `LineItemForm` and `lineItemToSubitemColumns`:
```typescript
export interface LineItemForm {
  unitPrice?: string; quantity?: string; productId?: string; currency?: string; description?: string;
  discount?: string; serviceDate?: string;
}
```
and inside `lineItemToSubitemColumns`, before the closing `return cv;`:
```typescript
  if (li.discount) cv[SUB_COLS.discount.id] = li.discount;
  if (li.serviceDate) cv[SUB_COLS.serviceDate.id] = { date: li.serviceDate };
```
- [ ] **Step 3: Add a test** — append to `columns.test.ts`:
```typescript
it("maps discount + service date", () =>
  expect(lineItemToSubitemColumns({ discount: "5", serviceDate: "2026-08-01" }))
    .toEqual({ numeric_mm53pkyf: "5", date_mm53chbv: { date: "2026-08-01" } }));
```
- [ ] **Step 4:** `cd monday-app && npx vitest run src/lib/columns.test.ts` → PASS. Commit `git add monday-app/src/board-config.ts monday-app/src/lib/columns.* && git commit -m "feat(monday-app): line-item discount + service date columns"`.

## Task 8: monday-client — getDeal, getItemNames, createContactCard, createCompanyCard

**Files:** Modify `monday-app/src/monday-client.ts`.

- [ ] **Step 1: Add functions** (after `getDeals`):

```typescript
/** Fetch a single deal item (fast edit-open, avoids re-fetching every deal). */
export async function getDeal(itemId: string): Promise<RawItem | null> {
  const d: any = await api(`query ($i:[ID!]) { items(ids:$i) {
    id name group { id } column_values { id text value ... on BoardRelationValue { linked_item_ids } } } }`, { i: [itemId] });
  return d.items?.[0] ?? null;
}

/** Resolve monday item ids -> { id: name } (batched by 100) for showing linked company/contact names. */
export async function getItemNames(itemIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < itemIds.length; i += 100) {
    const chunk = itemIds.slice(i, i + 100);
    const d: any = await api(`query ($ids:[ID!]) { items(ids:$ids) { id name } }`, { ids: chunk });
    for (const it of d.items ?? []) out[String(it.id)] = it.name;
  }
  return out;
}
```

- [ ] **Step 2: Add card creators** (after `findOrCreateCompany`), using the existing `CONTACT_BOARD`/`COMPANY_BOARD` + column ids:

```typescript
/** Create a brand-new contact card (no HubSpot id) — the Worker's createFromMonday pushes it to HubSpot.
 * Contact board primary column is First name (item name); the Worker splits "First Last". */
export async function createContactCard(fields: { name: string; email?: string; phone?: string }): Promise<string> {
  const cv: Record<string, unknown> = {};
  if (fields.email) cv["text_mm4p2bvb"] = fields.email;          // Email column
  if (fields.phone) cv["phone_mm4s31p3"] = { phone: fields.phone, countryShortName: "US" };
  const d: any = await api(`mutation ($b:ID!, $n:String!, $c:JSON!) {
    create_item(board_id:$b, item_name:$n, column_values:$c) { id } }`,
    { b: CONTACT_BOARD, n: fields.name, c: JSON.stringify(cv) });
  return String(d.create_item.id);
}
/** Create a brand-new company card. Company board primary column is the DOMAIN; company name lives in a
 * separate text column. Item name = domain || name so the Worker reverses domain correctly. */
export async function createCompanyCard(fields: { name: string; domain?: string }): Promise<string> {
  const cv: Record<string, unknown> = { text_mm4scke9: fields.name }; // Company Name column
  const d: any = await api(`mutation ($b:ID!, $n:String!, $c:JSON!) {
    create_item(board_id:$b, item_name:$n, column_values:$c) { id } }`,
    { b: COMPANY_BOARD, n: fields.domain || fields.name, c: JSON.stringify(cv) });
  return String(d.create_item.id);
}
```

- [ ] **Step 3:** `cd monday-app && npx tsc -b` (or `tsc --noEmit`) → no errors. Commit `git add monday-app/src/monday-client.ts && git commit -m "feat(monday-app): getDeal, getItemNames, create new contact/company cards"`.

## Task 9: worker-client — archiveDeal

**Files:** Modify `monday-app/src/worker-client.ts`.

- [ ] **Step 1: Add:**
```typescript
export async function archiveHubspotDeal(token: string, hubspotDealId: string): Promise<void> {
  await call(token, "DELETE", "/app/deal", { hubspotDealId });
}
```
- [ ] **Step 2:** `npx tsc --noEmit` → clean. Commit `git commit -am "feat(monday-app): worker-client archiveHubspotDeal"`.

## Task 10: useBoard — company/contact names, groupId, refresh-on-focus

**Files:** Modify `monday-app/src/lib/filter.ts` (DealRow gains `groupId`), `monday-app/src/useBoard.ts`.

- [ ] **Step 1:** In `filter.ts` `DealRow`, add `groupId: string;` (after `stage`).
- [ ] **Step 2:** In `useBoard.ts` `toRow`, add `groupId: item.group.id,` to the returned row (company/contact are filled in a second pass — leave them as `colText` for now; they'll be overwritten).
- [ ] **Step 3:** In `useBoard.ts` `load()`, after `getDeals()` resolves, resolve linked names and fill company/contact:

```typescript
      const [users, items] = await Promise.all([getUsers(), getDeals()]);
      const linkIds = new Set<string>();
      for (const it of items) { for (const id of linkedIds(it, DEAL_COLS.company.id)) linkIds.add(id);
                                for (const id of linkedIds(it, DEAL_COLS.contact.id)) linkIds.add(id); }
      const names = await getItemNames([...linkIds]);
      const nameList = (it: RawItem, col: string) => linkedIds(it, col).map(id => names[id]).filter(Boolean).join(", ");
      const rows = items.map(it => ({ ...toRow(it),
        company: nameList(it, DEAL_COLS.company.id), contact: nameList(it, DEAL_COLS.contact.id) }));
      setS({ loading: false, error: null, schemaErrors: [], userId: ctx.userId, sessionToken: ctx.sessionToken,
        users, meta, options: optionsFrom(meta), rows });
```
(Add `getItemNames` to the `./monday-client` import; `linkedIds` is already exported from this file.)

- [ ] **Step 4: Refresh-on-focus** — add a `useEffect` in `useBoard` after the initial-load effect:
```typescript
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => { if (Date.now() - last > 15000) { last = Date.now(); void load(); } };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, []);
```

- [ ] **Step 5:** `npx tsc --noEmit` → clean (BoardView still compiles; `groupId` is additive). Commit `git add monday-app/src/lib/filter.ts monday-app/src/useBoard.ts && git commit -m "feat(monday-app): resolve company/contact names, groupId, refresh-on-focus"`.

---

# PHASE 4 — App UI

## Task 11: BoardView — sortable headers, Table/Board toggle, refresh, delete, per-currency KPI

**Files:** Modify `monday-app/src/views/BoardView.tsx`; new `monday-app/src/views/KanbanView.tsx` referenced (stub first if needed).

- [ ] **Step 1:** Replace the KPI computation with `computeKpis` and render per-currency pipeline:
  - import `{ computeKpis } from "../lib/kpi"`, `{ sortDeals, type SortKey } from "../lib/sort"`.
  - `const kpi = useMemo(() => computeKpis(board.rows), [board.rows]);`
  - Render the first KPI card value as the top currency (`kpi.pipeline[0]`) formatted, with a `foot` of the next currencies joined (e.g. `¥300k · +1 more`); keep Active = `kpi.active`, Won = `kpi.won`, Win rate = `kpi.winRate`.
- [ ] **Step 2: Sorting** — add `const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "closeDate", dir: "asc" });` and sort after filter: `const rows = useMemo(() => sortDeals(filterDeals(...), sort.key, sort.dir), [...deps, sort]);`. Make each `<th>` clickable: `onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }))}` with a ▲/▼ indicator when active. (Give the header cells a `cursor:pointer` class.)
- [ ] **Step 3: Table/Board toggle** — `const [view, setView] = useState<"table" | "board">("table");` two toggle buttons in the toolbar. When `view === "board"`, render `<KanbanView board={board} rows={rows} onOpen={setEditing} onToast={setToast} />` instead of the table.
- [ ] **Step 4: Refresh button** — a toolbar button `onClick={() => void board.reload()}` (label ⟳ / "Refresh").
- [ ] **Step 5: Row delete** — add a small trash affordance in the actions cell that calls a `del(r)` handler:
```typescript
  async function del(r: DealRow) {
    if (!confirm(`Delete "${r.name}"? This archives the deal in HubSpot.`)) return;
    try {
      const hsId = /* look up the deal's HubSpot id */ undefined; // see note
      // BoardView doesn't currently carry the HubSpot id on the row — add `hubspotId` to DealRow + toRow
      // (colText(item, DEAL_COLS.hubspotDealId.id)) in this task so delete can archive.
      if (r.hubspotId) await archiveHubspotDeal(board.sessionToken, r.hubspotId);
      await deleteItem(r.id);
      setToast("Deal deleted"); await board.reload();
    } catch (e) { setToast("Delete failed: " + String(e).slice(0, 120)); }
  }
```
  - **Add `hubspotId?: string` to `DealRow`** (filter.ts) and set it in `toRow` (`hubspotId: colText(item, DEAL_COLS.hubspotDealId.id) || undefined`). Import `deleteItem` from `../monday-client` and `archiveHubspotDeal` from `../worker-client`.
- [ ] **Step 6: Build + commit** — `cd monday-app && npm run build` (add a temporary `KanbanView` stub exporting `() => null` if it doesn't exist yet). Commit `git add monday-app/src/views/BoardView.tsx monday-app/src/lib/filter.ts monday-app/src/views/KanbanView.tsx && git commit -m "feat(monday-app): sortable table, board toggle, refresh, delete, per-currency KPI"`.

## Task 12: KanbanView (drag between stages)

**Files:** Create/replace `monday-app/src/views/KanbanView.tsx`; add styles in Task 16.

- [ ] **Step 1: Implement** — columns from `stageOptions(board.meta.groups)` mapped to `{ groupId, title }` via `groupIdForStage`, plus an Unassigned column (`UNASSIGNED_GROUP`). Group `rows` by `groupId`. HTML5 DnD: cards `draggable` (except when `groupId === UNASSIGNED_GROUP`), `onDragStart` stashes the row id; column `onDrop` calls the move:

```tsx
import { useMemo, useState } from "react";
import type { BoardState } from "../useBoard";
import type { DealRow } from "../lib/filter";
import { stageOptions, groupIdForStage } from "../lib/stage";
import { UNASSIGNED_GROUP } from "../board-config";
import { moveToGroup } from "../monday-client";

const money = (r: DealRow) => r.amount ? `${r.currency ?? ""} ${Number(r.amount).toLocaleString()}` : "";

export default function KanbanView({ board, rows, onOpen, onToast }: {
  board: BoardState; rows: DealRow[]; onOpen: (id: string) => void; onToast: (m: string) => void;
}) {
  const [drag, setDrag] = useState<string | null>(null);
  const cols = useMemo(() => {
    const stage = stageOptions(board.meta!.groups).map(t => ({ groupId: groupIdForStage(t, board.meta!.groups)!, title: t }));
    return [...stage, { groupId: UNASSIGNED_GROUP, title: "Unassigned" }];
  }, [board.meta]);
  const byGroup = (gid: string) => rows.filter(r => r.groupId === gid);

  async function drop(targetGroup: string) {
    const id = drag; setDrag(null);
    if (!id) return;
    const row = rows.find(r => r.id === id);
    if (!row || row.groupId === targetGroup) return;
    if (row.groupId === UNASSIGNED_GROUP || targetGroup === UNASSIGNED_GROUP) {
      onToast("Assign a Sales User first to move this deal out of Unassigned"); return;
    }
    try { await moveToGroup(id, targetGroup); await board.reload(); }
    catch { onToast("Could not move the deal"); }
  }

  return (
    <div className="dc-kanban">
      {cols.map(c => {
        const items = byGroup(c.groupId);
        const total = items.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        return (
          <div key={c.groupId} className="dc-kcol" onDragOver={e => e.preventDefault()} onDrop={() => void drop(c.groupId)}>
            <div className="dc-kcol-head"><span>{c.title}</span><span className="dc-mut">{items.length} · {total ? total.toLocaleString() : "—"}</span></div>
            {items.map(r => (
              <div key={r.id} className="dc-kcard" draggable={c.groupId !== UNASSIGNED_GROUP}
                onDragStart={() => setDrag(r.id)} onClick={() => onOpen(r.id)}>
                <div className="dc-kcard-name">{r.name}</div>
                <div className="dc-mut" style={{ fontSize: 12 }}>{r.company || ""}</div>
                <div className="dc-money" style={{ fontSize: 13 }}>{money(r)}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit** — `npm run build`. Commit `git add monday-app/src/views/KanbanView.tsx && git commit -m "feat(monday-app): Kanban pipeline with drag-between-stages"`.

## Task 13: LineItemsEditor — description/discount/service date + subtotals + errors

**Files:** Modify `monday-app/src/views/LineItemsEditor.tsx`.

- [ ] **Step 1:** Extend the `LineItem` interface with `discount?: string; serviceDate?: string;` (description already implied). Add inputs for description, discount, service date (date input) per row; show each row's subtotal via `lineTotal(li)` and a footer `lineItemsTotal(value)` (import from `../lib/totals`). Add an optional `onTotal?: (n: number) => void` or a "Use as deal amount" button that calls a passed `onUseTotal?: (n: number) => void`.
- [ ] **Step 2: Errors** — add an optional prop `onError?: (msg: string) => void`; in `remove()` and `persistLineItems` failures, call `onError` instead of swallowing. Extend the `updateHubspotLineItem` call in `persistLineItems` to include `description`, `discount`, `service_date`:
```typescript
      if (li.lineItemId) await updateHubspotLineItem(token, li.lineItemId, {
        price: li.unitPrice, quantity: li.quantity,
        ...(li.currency ? { hs_line_item_currency_code: li.currency } : {}),
        ...(li.description ? { description: li.description } : {}),
        ...(li.discount ? { discount: li.discount } : {}),
        ...(li.serviceDate ? { service_date: li.serviceDate } : {}),
      });
```
- [ ] **Step 3: Build + commit** — `npm run build`. Commit.

## Task 14: AssociationPicker — inline new contact/company + errors

**Files:** Modify `monday-app/src/views/AssociationPicker.tsx`.

- [ ] **Step 1:** Add a "＋ New {contact|company}" button under the search that reveals a tiny inline form (contacts: name/email/phone; companies: name/domain). On submit call `createContactCard`/`createCompanyCard` (import from `../monday-client`), then push an `Assoc { hubspotId: "", itemId, label: name }` and clear the form. Add an optional `onError?: (msg: string) => void` prop; replace the silent `catch {}` in `add`/`remove`/`search` with `onError?.(...)` (search failure → a small "search unavailable" note).
- [ ] **Step 2: Build + commit** — `npm run build`. Commit.

## Task 15: DealModal — single-fetch, validation, dirty guard, delete, errors, totals→amount

**Files:** Modify `monday-app/src/views/DealModal.tsx`.

- [ ] **Step 1: Fast edit open** — replace `const items = await getDeals(); const it = items.find(...)` with `const it = await getDeal(itemId!)` (import `getDeal`).
- [ ] **Step 2: Validation** — import `validateDealForm`; compute `const v = validateDealForm(name, form);`; disable the primary button when `!v.ok`; show `v.errors.name/stage/amount` under the relevant fields.
- [ ] **Step 3: Dirty guard** — track a `dirty` flag (set true in `set`, `setName`, and the association/line-item onChange handlers); in the backdrop `onClick` and Cancel, if `dirty` call `confirm("Discard unsaved changes?")` before closing.
- [ ] **Step 4: Error thread** — add `const [childErr, setChildErr] = useState<string | null>(null);` pass `onError={setChildErr}` to both `AssociationPicker`s and `LineItemsEditor`; render `childErr` in the `dc-err` area alongside `err`.
- [ ] **Step 5: Delete button** — in edit mode, add a left-aligned "Delete" button in the footer that runs the same archive+`deleteItem` flow as Task 11 (using `dealHubspotId`), then `onSaved("Deal deleted")`.
- [ ] **Step 6: Totals→amount** — pass `onUseTotal={(n) => set({ amount: String(n) })}` to `LineItemsEditor`.
- [ ] **Step 7: Build + commit** — `npm run build`. Commit `git add monday-app/src/views/DealModal.tsx && git commit -m "feat(monday-app): fast edit, validation, dirty guard, delete, surfaced errors, totals->amount"`.

## Task 16: styles.css — Kanban, drag, inline-form, error, sortable-header

**Files:** Modify `monday-app/src/styles.css`.

- [ ] **Step 1:** Add classes used above: `.dc-kanban` (horizontal scroll flex), `.dc-kcol` (min-width ~260px surface column), `.dc-kcol-head`, `.dc-kcard` (draggable card, hover lift, `cursor:grab`), a drag-over highlight, `.dc-th-sort` (pointer + active arrow), `.dc-newform` (inline create form), and reuse `.dc-err`. Keep the existing token variables.
- [ ] **Step 2: Build + commit** — `npm run build`. Commit.

---

# PHASE 5 — Deploy + verify

## Task 17: Full verification, deploy, live test

- [ ] **Step 1:** `cd worker && npx tsc --noEmit && npx vitest run` (all pass) and `cd monday-app && npx vitest run && npm run build` (all pass).
- [ ] **Step 2: Deploy** — `cd worker && npx wrangler deploy`; `cd monday-app && npx @mondaycom/apps-cli@latest code:push -d ./dist -c -i 16011075 -f`.
- [ ] **Step 3: Live (hard-refresh the board view):** company/contact names show; sort each column; search a company; toggle Board and drag a deal to a new stage → confirm the stage changes in HubSpot within ~30s; an Unassigned card shows the block hint; create a NEW contact + company inline and confirm they appear in HubSpot linked to the deal; delete a deal → archived in HubSpot + card gone; edit opens instantly; a line item with description/discount/service date + subtotal round-trips; Create is disabled until name+stage present; a forced failure shows an error (not a false success); refresh-on-focus picks up a HubSpot-side edit.

---

## Self-Review Notes

- **Spec coverage:** table names/sort/search/delete (Tasks 3,10,11,2,1,9); Kanban (12,16); speed/freshness (8,10,15); richer line items (7,13, Worker already maps on create); new contact/company (8,14); surfaced errors (13,14,15); validation (4,15); totals + per-currency KPI (5,6,13,11). Worker delete endpoint (1). Line-item reverse-on-create needs no Worker change (associations.ts:87-91 maps all sub.fields — verified).
- **Type consistency:** `DealRow` gains `groupId` + `hubspotId` in filter.ts and is set in `toRow` (Task 10/11) before consumers use them; `SortKey` shared by sort.ts + BoardView; `computeKpis`/`Kpis` shared by kpi.ts + BoardView; `LineItem`/`LineItemForm` gain discount/serviceDate consistently (Tasks 7,13); `onError`/`onUseTotal` props defined where passed.
- **Placeholder scan:** none — the one "look up HubSpot id" note in Task 11 Step 5 is resolved in that same step (add `hubspotId` to DealRow/toRow).
- **Known follow-ups (not placeholders):** new contacts/companies inherit the board default owner in HubSpot (v2.1); Vibe not used (custom CSS layer).
