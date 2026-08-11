# Deal Cockpit v3.1 — Drawer, editing & instant sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the centered deal modal with a right-side tabbed drawer (create + edit), fix the association picker (debounce/spinner/cancel/keyboard/dup-warning), turn line items into a quotation table with amount-or-% discounts stored properly in HubSpot, and make every drawer save reach HubSpot instantly (never the cron).

**Architecture:** Almost entirely the React app (`monday-app/`). Small Worker additions: a `hs_discount_percentage` line-item field (needs one new monday subitems column) and a session-authed `POST /app/sync-deal` that runs the existing `syncMondayItem` reconcile on demand. Correctness-critical logic (totals, discount encoding, debounce/abort hook, request parsers) is built test-first (vitest); the drawer/tabs/picker UI follows the repo pattern (pure logic unit-tested, UI verified live).

**Tech Stack:** TypeScript, Cloudflare Workers (`wrangler`, `vitest`); React 18 + Vite, custom CSS design system, `monday-sdk-js`, `AbortController`.

**Spec:** `docs/superpowers/specs/2026-07-16-deal-cockpit-v3.1-drawer-editing.md`.

**Base facts:** subitems board `5029480548`; existing SUB_COLS incl. `discount: numeric_mm53pkyf` (HubSpot `discount`, a per-unit amount). `syncMondayItem(env, boardId, itemId, opts, budget)` is exported from `worker/src/sync.ts:407`. Deals board id via `DEALS.boardId` = `5029480547`. All HubSpot ids are strings.

**A note on the new column id:** Task 1 creates a "Discount %" column and produces its real id. Everywhere below it is written as `«DISCOUNT_PCT_COL»` — replace it with the id from Task 1 (it is a produced value, not an unresolved placeholder).

---

# PHASE 1 — Backend + shared libs

## Task 1: Create the "Discount %" subitems column + wire it

**Files:** Modify `worker/src/config.ts`, `monday-app/src/board-config.ts`. (Column creation is an API action, not a code change.)

- [ ] **Step 1: Create the column.** Run a monday `create_column` mutation against the subitems board with a token that has `boards:write`:
```graphql
mutation { create_column(board_id: 5029480548, title: "Discount %", column_type: numbers, description: "HubSpot hs_discount_percentage") { id } }
```
Primary method: `cd monday-app` and run a one-off node script that POSTs to `https://api.monday.com/v2` with `Authorization: <token>` and `API-Version: 2024-10`. If no local token has `boards:write` (the mapps app token is `me:write` only), **fall back**: ask the user to add a **Numbers** column named "Discount %" to the subitems board in the monday UI and paste its column id. Record the returned id as `«DISCOUNT_PCT_COL»`.

- [ ] **Step 2: Worker field.** In `worker/src/config.ts`, in `LINE_ITEM_SUBITEMS.fields`, add after the existing `discount` line:
```typescript
    { hs: "hs_discount_percentage", col: "«DISCOUNT_PCT_COL»", type: "numbers" },   // Discount % (alt to per-unit discount)
```
`reverseLineItems` already iterates `sub.fields`, so the create path maps it with no other Worker change.

- [ ] **Step 3: App SUB_COLS.** In `monday-app/src/board-config.ts` `SUB_COLS`, add after `discount`:
```typescript
  discountPct:{ id: "«DISCOUNT_PCT_COL»", kind: "numeric" },
```

- [ ] **Step 4: Verify + commit.** `cd worker && npx tsc --noEmit && npx vitest run` (150 green — no behavior change, just a new mapped field) and `cd monday-app && npx tsc --noEmit`. Commit:
```bash
git add worker/src/config.ts monday-app/src/board-config.ts
git commit -m "feat: add Discount % subitem column (HubSpot hs_discount_percentage)"
```

## Task 2: `lib/totals.ts` — discount modes (TDD)

**Files:** Modify `monday-app/src/lib/totals.ts`, `monday-app/src/lib/totals.test.ts`.

- [ ] **Step 1: Failing tests** — replace `totals.test.ts` with:
```typescript
import { describe, it, expect } from "vitest";
import { lineTotal, lineItemsTotal } from "./totals";
describe("line totals", () => {
  it("amount discount: qty × (unitPrice − discount)", () =>
    expect(lineTotal({ quantity: "2", unitPrice: "100", discount: "10" })).toBe(180));
  it("percent discount: qty × unitPrice × (1 − pct/100)", () =>
    expect(lineTotal({ quantity: "2", unitPrice: "100", discountMode: "percent", discountPct: "5" })).toBe(190));
  it("percent ignores the amount field", () =>
    expect(lineTotal({ quantity: "1", unitPrice: "100", discount: "40", discountMode: "percent", discountPct: "10" })).toBe(90));
  it("blanks default to 0; never negative", () => {
    expect(lineTotal({ quantity: "3", unitPrice: "50" })).toBe(150);
    expect(lineTotal({ quantity: "1", unitPrice: "5", discount: "999" })).toBe(0);
    expect(lineTotal({ quantity: "1", unitPrice: "100", discountMode: "percent", discountPct: "150" })).toBe(0);
  });
  it("lineItemsTotal sums mixed modes", () =>
    expect(lineItemsTotal([
      { quantity: "2", unitPrice: "100" },
      { quantity: "2", unitPrice: "100", discountMode: "percent", discountPct: "50" },
    ])).toBe(300));
});
```

- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement:**
```typescript
export interface TotalInput {
  quantity?: string; unitPrice?: string; discount?: string;
  discountMode?: "amount" | "percent"; discountPct?: string;
}
const n = (v?: string) => { const x = Number(v); return isFinite(x) ? x : 0; };
export function lineTotal(li: TotalInput): number {
  const gross = n(li.quantity) * n(li.unitPrice);
  const net = li.discountMode === "percent"
    ? gross * (1 - n(li.discountPct) / 100)
    : n(li.quantity) * (n(li.unitPrice) - n(li.discount));
  return Math.max(0, net);
}
export function lineItemsTotal(items: TotalInput[]): number { return items.reduce((s, li) => s + lineTotal(li), 0); }
```
- [ ] **Step 4: Run, expect pass. Commit** `git add monday-app/src/lib/totals.* && git commit -m "feat(monday-app): line totals support amount + percent discounts"`.

## Task 3: `lib/columns.ts` — encode active discount only (TDD)

**Files:** Modify `monday-app/src/lib/columns.ts`, `monday-app/src/lib/columns.test.ts`.

- [ ] **Step 1: Extend `LineItemForm`** — add `discountMode?: "amount" | "percent"; discountPct?: string;`.
- [ ] **Step 2: Encode.** In `lineItemToSubitemColumns`, replace the current discount line with mode-aware encoding (write the active one, leave the inactive column unset so it isn't blanked here — clearing on switch is handled by the update path in Task 10):
```typescript
  if (li.discountMode === "percent") { if (li.discountPct) cv[SUB_COLS.discountPct.id] = li.discountPct; }
  else if (li.discount) cv[SUB_COLS.discount.id] = li.discount;
```
- [ ] **Step 3: Tests** — append to `columns.test.ts`:
```typescript
it("amount mode writes the discount column only", () =>
  expect(lineItemToSubitemColumns({ discount: "5", discountMode: "amount" }))
    .toEqual({ numeric_mm53pkyf: "5" }));
it("percent mode writes the discount% column only", () =>
  expect(lineItemToSubitemColumns({ discountPct: "10", discountMode: "percent" }))
    .toEqual({ "«DISCOUNT_PCT_COL»": "10" }));
```
- [ ] **Step 4: Run + commit** `git add monday-app/src/lib/columns.* && git commit -m "feat(monday-app): encode the active discount (amount or percent) for a line item"`.

## Task 4: Worker `POST /app/sync-deal` (instant sync) + client (TDD parse)

**Files:** Modify `worker/src/app-routes.ts`, `worker/src/index.ts`, `worker/test/app-routes.test.ts`, `monday-app/src/worker-client.ts`.

- [ ] **Step 1: Failing test** — append to `worker/test/app-routes.test.ts`:
```typescript
import { parseSyncDealBody } from "../src/app-routes";
describe("parseSyncDealBody", () => {
  it("accepts a numeric itemId", () =>
    expect(parseSyncDealBody({ itemId: "12345" })).toEqual({ ok: true, itemId: "12345" }));
  it("rejects missing / non-numeric", () => {
    expect(parseSyncDealBody({}).ok).toBe(false);
    expect(parseSyncDealBody({ itemId: "abc" }).ok).toBe(false);
  });
});
```
(add `parseSyncDealBody` to the existing `../src/app-routes` import).

- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement parser** — append to `worker/src/app-routes.ts`:
```typescript
export interface SyncDealReq { ok: boolean; itemId?: string; error?: string }
export function parseSyncDealBody(body: any): SyncDealReq {
  const itemId = body?.itemId;
  if (!numeric(itemId)) return { ok: false, error: "itemId must be a numeric string" };
  return { ok: true, itemId };
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Wire the route.** In `worker/src/index.ts`: add `parseSyncDealBody` to the `./app-routes` import, `syncMondayItem` to the `./sync` import (it may not be imported there yet — check), `DEALS` to the `./config` import, and a `Budget` type import if needed. Add this block inside the `/app/` section (after `/app/deal`):
```typescript
      // POST /app/sync-deal {itemId} — run the deal's reconcile NOW (fields+associations+line items -> HubSpot),
      // the same path the monday webhook uses. Makes a drawer save instant instead of waiting on a webhook/cron.
      if (url.pathname === "/app/sync-deal" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const s = parseSyncDealBody(body);
        if (!s.ok) return Response.json({ error: s.error }, { status: 400, headers: CORS });
        try {
          await syncMondayItem(env, DEALS.boardId, s.itemId!, appWriteOpts(env), { left: 30 });
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/sync-deal] item=${s.itemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "sync-failed" }, { status: 502, headers: CORS });
        }
      }
```
(If `appWriteOpts`'s `maxWrites: 5` is too small for a full reconcile, pass `{ ...appWriteOpts(env), maxWrites: 30 }` as opts — but the budget arg `{ left: 30 }` is the actual per-call cap used by `reconcileRecord`, so `appWriteOpts(env)` is fine for opts.)

- [ ] **Step 6: App client.** In `monday-app/src/worker-client.ts` add:
```typescript
export async function syncDeal(token: string, itemId: string): Promise<void> {
  await call(token, "POST", "/app/sync-deal", { itemId });
}
```

- [ ] **Step 7: Verify + commit.** `cd worker && npx tsc --noEmit && npx vitest run` (all green) and `cd monday-app && npx tsc --noEmit`. Commit:
```bash
git add worker/src/app-routes.ts worker/src/index.ts worker/test/app-routes.test.ts monday-app/src/worker-client.ts
git commit -m "feat(worker): POST /app/sync-deal runs an instant deal reconcile (drawer save)"
```

---

# PHASE 2 — Picker rework

## Task 5: `useDebouncedSearch` hook + abortable search (TDD)

**Files:** Create `monday-app/src/hooks/useDebouncedSearch.ts` + `.test.ts`; modify `monday-app/src/worker-client.ts`.

- [ ] **Step 1: Abort signal on search.** In `worker-client.ts`, thread an optional `AbortSignal` through `call` and `searchHubspot`:
```typescript
async function call(token: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(WORKER_BASE + path, {
    method, signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`worker ${method} ${path}: ${res.status}`);
  return res.json();
}
export async function searchHubspot(token: string, type: "contacts" | "companies" | "products", q: string, signal?: AbortSignal): Promise<Hit[]> {
  const res = await call(token, "GET", `/app/search?type=${type}&q=${encodeURIComponent(q)}&limit=10`, undefined, signal);
  return res.results ?? [];
}
```

- [ ] **Step 2: Failing test** — `useDebouncedSearch.test.ts` (pure timing logic extracted so it's testable without React). Implement the hook around a small pure `makeDebouncer` OR test the hook with `@testing-library/react` if available; simplest is a pure helper test:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounceLatest } from "./useDebouncedSearch";
describe("debounceLatest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("only runs the last call within the window, and aborts the prior signal", async () => {
    const runs: string[] = [];
    const aborted: string[] = [];
    const run = (q: string, signal: AbortSignal) => { signal.addEventListener("abort", () => aborted.push(q)); runs.push(q); };
    const d = debounceLatest(run, 300);
    d("a"); d("ab"); d("abc");
    vi.advanceTimersByTime(299); expect(runs).toEqual([]);
    vi.advanceTimersByTime(1); expect(runs).toEqual(["abc"]);
    d("abcd"); vi.advanceTimersByTime(300);
    expect(runs).toEqual(["abc", "abcd"]);
    expect(aborted).toEqual(["abc"]); // starting the next run aborts the previous request
  });
});
```

- [ ] **Step 3: Implement** — `useDebouncedSearch.ts`:
```typescript
import { useEffect, useRef, useState } from "react";

/** Debounce that only fires the latest call after `ms` and aborts the previous in-flight run. Pure/testable. */
export function debounceLatest(run: (q: string, signal: AbortSignal) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  return (q: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      controller?.abort();
      controller = new AbortController();
      run(q, controller.signal);
    }, ms);
  };
}

/** React hook: debounced, cancellable search returning { hits, loading, error }. */
export function useDebouncedSearch<T>(fetcher: (q: string, signal: AbortSignal) => Promise<T[]>, ms = 300) {
  const [hits, setHits] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const debounced = useRef<(q: string) => void>();
  useEffect(() => {
    debounced.current = debounceLatest(async (q, signal) => {
      setLoading(true); setError(false);
      try { const r = await fetcher(q, signal); if (!signal.aborted) { setHits(r); setLoading(false); } }
      catch (e: any) { if (e?.name !== "AbortError") { setError(true); setLoading(false); setHits([]); } }
    }, ms);
  }, [fetcher, ms]);
  function query(q: string) { if (q.trim().length < 2) { setHits([]); setLoading(false); return; } debounced.current?.(q); }
  function clear() { setHits([]); setLoading(false); setError(false); }
  return { hits, loading, error, query, clear };
}
```

- [ ] **Step 4: Run + commit** `git add monday-app/src/hooks/useDebouncedSearch.* monday-app/src/worker-client.ts && git commit -m "feat(monday-app): debounced+cancellable search hook; abortable searchHubspot"`.

## Task 6: Rework `AssociationPicker`

**Files:** Modify `monday-app/src/views/AssociationPicker.tsx`.

- [ ] **Step 1:** Use `useDebouncedSearch` (fetcher = `(q, signal) => searchHubspot(token, kind, q, signal)`), replacing the manual `search()` + `hits` state. Bind the input to `query(text)`; show a **spinner** while `loading`; a small "Search unavailable" note on `error`.
- [ ] **Step 2: Keyboard nav.** Track `active` index; on the input `onKeyDown` — ArrowDown/ArrowUp move `active` within `hits`, Enter selects `hits[active]` (calls the existing `add`), Escape clears. Highlight the active row.
- [ ] **Step 3: Prominent secondary + labels.** Each result shows the name and, beneath, the email (contacts) / domain (companies) from `hit.secondary`, plus a muted "Existing" tag. The "+ New {kind}" action stays.
- [ ] **Step 4: Duplicate warning.** In `createNew()`, before creating, if any current `hits` (or a fresh lookup on the typed name/email) has a matching email (contacts) or matching domain/name (companies), show an inline warning "A similar record exists" with a "Link it instead" button that calls `add(match)` and cancels the create. Keep create available ("Create anyway").
- [ ] **Step 5: Build + commit** — `cd monday-app && npm run build`. Commit.

---

# PHASE 3 — Drawer shell + tabs

## Task 7: `DealDrawer` shell (replaces the modal) + instant sync

**Files:** Create `monday-app/src/views/DealDrawer.tsx`; modify `monday-app/src/views/BoardView.tsx`; delete `monday-app/src/views/DealModal.tsx`.

- [ ] **Step 1:** Build `DealDrawer` from the current `DealModal` logic (state, edit hydration, the retry-safe `save()`), but: render as a right-anchored panel (`dc-drawer`) with a tab strip and per-tab bodies; no blocking backdrop (a transparent click-catcher on the left that calls `guardedClose`); Esc closes (`useEffect` keydown). Tabs: `overview | associations | lineItems | updates | sync` via `useState`; in create mode hide `updates`/`sync`.
- [ ] **Step 2: Instant sync in save.** After the parent create/update + association `updateDealColumns` + `persistLineItems`, add `await syncDeal(board.sessionToken, parentId);` (import from `../worker-client`) so the deal reconciles to HubSpot immediately. Keep the existing error handling; a sync-deal failure surfaces via the same error banner but does NOT lose the monday writes.
- [ ] **Step 3:** Move the field form, associations, line items, updates into their tab components (Tasks 8-11); the drawer owns the shared state and passes it down. Keep the HubSpot-link header button + validation-gated Save + dirty guard.
- [ ] **Step 4:** In `BoardView.tsx`, replace `import DealModal from "./DealModal"` + `<DealModal .../>` with `DealDrawer`. Delete `views/DealModal.tsx`.
- [ ] **Step 5: Build + commit** — `npm run build`. Commit `git add monday-app/src/views/DealDrawer.tsx monday-app/src/views/BoardView.tsx && git rm monday-app/src/views/DealModal.tsx && git commit -m "feat(monday-app): right-side deal drawer with tabs + instant sync-on-save"`.

## Task 8: `OverviewTab` (progressive form)

**Files:** Create `monday-app/src/views/tabs/OverviewTab.tsx`.

- [ ] **Step 1:** Primary fields (Deal name, Sales User, Deal stage, Amount, Currency, Close date) always shown; a "More details" toggle reveals Deal type, Priority, Vendors, Deal owner. Reuse `FormFields` + the existing `set`/`invalid` from the drawer (passed as props). Inline field errors as today. Build + commit.

## Task 9: `AssociationsTab`

**Files:** Create `monday-app/src/views/tabs/AssociationsTab.tsx`.

- [ ] **Step 1:** Render the two reworked `<AssociationPicker>`s (contacts, companies) with the drawer's `onError`. Build + commit.

## Task 10: `LineItemsTab` (quotation table)

**Files:** Create `monday-app/src/views/tabs/LineItemsTab.tsx`; the `persistLineItems` export moves here from `LineItemsEditor` (or `LineItemsEditor` is repurposed).

- [ ] **Step 1: Table.** Columns `Product · Qty · Unit price · Discount · Line total · ✕`. The Discount cell holds a `$`/`%` toggle (per line) + a value input bound to `discount` or `discountPct`; toggling sets `discountMode` and clears the other value. Per-line total via `lineTotal(li)`. Product add via `useDebouncedSearch(products)`.
- [ ] **Step 2: Footer.** Subtotal `Σ qty×unitPrice`, discount total `subtotal − grandTotal`, grand total `lineItemsTotal(value)`, and "Use total as deal amount" (`onUseTotal`).
- [ ] **Step 3: Delete confirm.** For a synced line (`li.lineItemId`), `remove()` first `confirm(...)`. Keep the monday-delete-then-HubSpot-delete flow with the Task-3(v3.0) error handling.
- [ ] **Step 4: Persist mode-aware discount.** In `persistLineItems`, the `updateHubspotLineItem` call sends BOTH discount properties so a mode switch clears the old one:
```typescript
        ...(li.discountMode === "percent"
          ? { hs_discount_percentage: li.discountPct ?? "", discount: "" }
          : { discount: li.discount ?? "", hs_discount_percentage: "" }),
```
- [ ] **Step 5: Build + commit.**

## Task 11: `SyncTab`

**Files:** Create `monday-app/src/views/tabs/SyncTab.tsx`.

- [ ] **Step 1:** Read-only: HubSpot Deal ID (or "Pending — creating in HubSpot…" when the drawer's `dealHubspotId` is null), the last-synced timestamp (add the deal's Sync State column `text_mm4xxyzx` to the edit-hydration read and pass it in), and an "Open in HubSpot" button (reuse `openLink`+`hubspotDealUrl`). Build + commit.

## Task 12: `styles.css` — drawer, tabs, quotation table

**Files:** Modify `monday-app/src/styles.css`.

- [ ] **Step 1:** Add `.dc-drawer` (fixed right, width ~520px / `min(520px, 100%)`, full height, `box-shadow`, slide-in animation), `.dc-drawer-catch` (transparent left click-catcher), `.dc-tabs` / `.dc-tab` (+ active), `.dc-qt` quotation table styles (aligned numeric cells, discount toggle), and a small inline spinner class for the picker if not already present. Theme-aware via the existing variables. Build + commit.

---

# PHASE 4 — Deploy + verify

## Task 13: Full gate, deploy, live verification

- [ ] **Step 1:** `cd worker && npx tsc --noEmit && npx vitest run` (green) and `cd monday-app && npx vitest run && npm run build` (green).
- [ ] **Step 2: Deploy.** `cd worker && npx wrangler deploy`; `cd monday-app && npx @mondaycom/apps-cli@latest code:push -d ./dist -c -i 16011075 -f`.
- [ ] **Step 3: Live (hard-refresh):**
  - Drawer opens from the right; the table stays visible; clicking another row switches the drawer (dirty guard fires if unsaved).
  - Create with only primary fields, then via "More details"; Save is blocked until name+stage+valid amount.
  - Picker: typing debounces (one request after you stop), a spinner shows, rapid typing doesn't render stale results, ↑/↓/Enter selects; creating a new contact that duplicates an existing email shows the warning.
  - Line items: add a `%`-discount line and a `$`-discount line → per-line + grand totals correct; in HubSpot the %-line shows `hs_discount_percentage` and the $-line shows `discount`; switching a line's mode clears the other in HubSpot.
  - **Instant:** on Save the deal + line items appear/update in HubSpot within ~a second (watch it's not a 10-min cron delay).
  - Deleting a synced line item prompts to confirm.
  - Sync tab shows the HubSpot Deal ID + last-synced + Open in HubSpot.

---

## Self-Review Notes

- **Spec coverage:** drawer shell + tabs (7-11); progressive Overview (8); picker debounce/spinner/cancel/keyboard/dup (5,6); quotation table + $/% discount (2,3,10) with HubSpot `hs_discount_percentage` via the new column (1) mapped by the existing `reverseLineItems`; instant sync (4,7); Sync tab (11); styles (12). Deploy/verify (13).
- **Type consistency:** `TotalInput`/`LineItemForm`/`LineItem` gain `discountMode`+`discountPct` consistently (2,3,10); `useDebouncedSearch` fetcher signature `(q, signal) => Promise<Hit[]>` matches the abortable `searchHubspot` (5,6); `parseSyncDealBody` matches its test + the route (4); the drawer passes shared state (`set`, `invalid`, `form`, line items, associations) to the tab components (7-11).
- **Placeholder scan:** `«DISCOUNT_PCT_COL»` is a value produced by Task 1 and substituted in Tasks 1-3 — flagged, not an unresolved TODO. No other placeholders.
- **Known follow-ups (not placeholders):** `hs_discount_percentage` sending `""` to clear on a mode switch relies on HubSpot accepting empty-string clears (verify in Task 13); the currency-label caveat from v3.0 still stands (don't rename monday currency labels).
- **Scope note:** this is a large single subsystem (one drawer). Kept as one plan with phases; if execution shows Phase 3 is too heavy for single tasks, split a tab task, but the boundaries above are each self-contained.
