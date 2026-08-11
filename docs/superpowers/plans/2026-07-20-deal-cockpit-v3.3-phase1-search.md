# Deal Cockpit v3.3 — Phase 1: Live Search Freshness & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make contact/company/product search provably live and stale-proof, enrich product results, and remove the inline New-contact/New-company creators.

**Architecture:** monday app → Worker `/app/search` → live HubSpot CRM search (unchanged). The Worker now returns a match `total` and forbids HTTP caching; the debounced-search hook gains abort-on-clear + a sequence guard; the frontend surfaces "Search unavailable" and a "keep typing" hint.

**Tech Stack:** React 18 + TypeScript + Vite + vitest (app); Cloudflare Worker + vitest (worker). Deploy via the cached `mapps` CLI (app) and `wrangler` (worker).

**Design source:** `C:\Users\PC\.claude\plans\create-a-small-python-jupyter-happy-turtle.md` (Phase 1 section).

---

## File Structure

| File | Change |
|------|--------|
| `worker/src/hubspot.ts` | `searchObjects` → `{results,total}`; `SEARCH_PROPS.products` adds sku/description; `mapSearchResult` emits sku/price/description; export `SearchHit` |
| `worker/src/index.ts` | `/app/search` returns `{results,total}` + `Cache-Control: no-store` |
| `worker/test/hubspot-search.test.ts` (exists) | update the existing product test + add a richer product case |
| `monday-app/src/worker-client.ts` | `Hit` gains sku/price/description; `searchHubspot` → `{items,total}`, trims q, `cache:"no-store"`, throws on `{error}` |
| `monday-app/src/hooks/useDebouncedSearch.ts` | `debounceLatest` → `{trigger,cancel}`; hook adds seq guard, abort-on-clear / below-2, `total`, keeps `error` |
| `monday-app/src/hooks/useDebouncedSearch.test.ts` | update for `{trigger,cancel}` + cancel/stale tests |
| `monday-app/src/views/AssociationPicker.tsx` | remove New contact/company + dup-check; error state; 20 results + hint |
| `monday-app/src/views/DealDrawer.tsx` | drop `createContactCard/createCompanyCard` + the `a.create` branch |
| `monday-app/src/views/LineItemsEditor.tsx` | product-search states (Searching…/No products/Retry/Refresh) + result display |

---

## Task 1: Worker returns `total`, richer product results, and no-store

**Files:**
- Modify: `worker/src/hubspot.ts` (`SEARCH_PROPS`, `mapSearchResult`, `searchObjects`)
- Modify: `worker/src/index.ts` (`/app/search` handler)
- Test: `worker/test/hubspot-search.test.ts` (already exists — tests `mapSearchResult`)

- [ ] **Step 1: Update the product test in the EXISTING `worker/test/hubspot-search.test.ts`**

The file already has a product test asserting `{name, secondary}` only; the new shape adds `sku/price/description`, so that test would fail. REPLACE it and ADD a richer case. Change:
```ts
  it("product: name + price", () =>
    expect(mapSearchResult("products", { name: "Xtract Universal", price: "15400" }))
      .toEqual({ name: "Xtract Universal", secondary: "15400" }));
```
to:
```ts
  it("product: name + price (empty sku/description)", () =>
    expect(mapSearchResult("products", { name: "Xtract Universal", price: "15400" }))
      .toEqual({ name: "Xtract Universal", secondary: "15400", sku: "", price: "15400", description: "" }));
  it("product: full name/sku/price/description", () =>
    expect(mapSearchResult("products", { name: "Zoom Pro", hs_sku: "Z-1", price: "168", description: "Team plan" }))
      .toEqual({ name: "Zoom Pro", secondary: "168", sku: "Z-1", price: "168", description: "Team plan" }));
```
The contact/company tests stay as-is (the new `mapSearchResult` still returns just `{name, secondary}` for those).

- [ ] **Step 2: Run it, expect fail**

Run: `cd worker && npx vitest run test/hubspot-search.test.ts`
Expected: FAIL — product result has no `sku/price/description`.

- [ ] **Step 3: Extend `SEARCH_PROPS` and `mapSearchResult`**

In `worker/src/hubspot.ts` change `SEARCH_PROPS.products` and `mapSearchResult`:
```ts
const SEARCH_PROPS: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email"],
  companies: ["name", "domain"],
  products: ["name", "price", "hs_sku", "description"],
};

export interface SearchHit { id: string; name: string; secondary: string; sku?: string; price?: string; description?: string }

export function mapSearchResult(type: string, p: Record<string, any>): Omit<SearchHit, "id"> {
  if (type === "contacts") {
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
    return { name: name || p.email || "(no name)", secondary: p.email ?? "" };
  }
  if (type === "companies") return { name: p.name || "(no name)", secondary: p.domain ?? "" };
  // products
  const price = p.price != null ? String(p.price) : "";
  return { name: p.name || "(no name)", secondary: price, sku: p.hs_sku ?? "", price, description: p.description ?? "" };
}
```

- [ ] **Step 4: Make `searchObjects` return `{results,total}`**

Replace `searchObjects` in `worker/src/hubspot.ts`:
```ts
/** Full-text search one HubSpot object type; returns up to `limit` (<=20) hits plus the match total. */
export async function searchObjects(env: Env, type: string, q: string, limit: number):
    Promise<{ results: SearchHit[]; total: number }> {
  const res = await hs(env, "POST", `/crm/v3/objects/${type}/search`,
    { query: q, properties: SEARCH_PROPS[type] ?? ["name"], limit: Math.min(Math.max(limit, 1), 20) }, 2);
  const results = (res.results ?? []).map((r: any) => ({ id: String(r.id), ...mapSearchResult(type, r.properties ?? {}) }));
  return { results, total: Number(res.total ?? results.length) };
}
```

- [ ] **Step 5: Update `/app/search` to pass `total` and forbid caching**

In `worker/src/index.ts`, replace the `try` block of the `/app/search` handler:
```ts
        try {
          const { results, total } = await searchObjects(env, type, q, Number.isFinite(limit) ? limit : 20);
          return Response.json({ results, total }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/search] type=${type} error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], total: 0, error: scope ? "scope" : "search-failed" },
            { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
```

- [ ] **Step 6: Run tests + typecheck, expect pass**

Run: `cd worker && npx vitest run test/hubspot.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0. (Note: `searchObjects` callers only exist in `index.ts`, updated above.)

- [ ] **Step 7: Commit**

```bash
git add worker/src/hubspot.ts worker/src/index.ts worker/test/hubspot-search.test.ts
git commit -m "feat(worker): /app/search returns total + richer product hits + no-store"
```

---

## Task 2: `searchHubspot` returns `{items,total}`, trims, no-store, surfaces errors

**Files:**
- Modify: `monday-app/src/worker-client.ts`

- [ ] **Step 1: Add `no-store` to the shared `call`**

In `monday-app/src/worker-client.ts`, change the `fetch` in `call`:
```ts
  const res = await fetch(WORKER_BASE + path, {
    method, signal, cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
```

- [ ] **Step 2: Extend `Hit` and rewrite `searchHubspot`**

Replace the `Hit`/`searchHubspot` block:
```ts
export interface Hit { id: string; name: string; secondary: string; sku?: string; price?: string; description?: string }
export interface SearchResult { items: Hit[]; total: number }
export async function searchHubspot(token: string, type: "contacts" | "companies" | "products", q: string, signal?: AbortSignal): Promise<SearchResult> {
  const res = await call(token, "GET", `/app/search?type=${type}&q=${encodeURIComponent(q.trim())}&limit=20`, undefined, signal);
  if (res?.error) throw new Error("search-" + res.error);           // surface HubSpot failure (scope/search-failed)
  return { items: res.results ?? [], total: Number(res.total ?? (res.results?.length ?? 0)) };
}
```

- [ ] **Step 3: Typecheck (expected to fail in consumers until Tasks 3–6)**

Run: `cd monday-app && npx tsc --noEmit`
Expected: errors in `AssociationPicker.tsx` / `LineItemsEditor.tsx` (they still expect `Hit[]`). This is expected — those files are updated in Tasks 4 and 6. Do not fix here.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/worker-client.ts
git commit -m "feat(monday-app): searchHubspot returns {items,total}, trims, no-store, throws on error"
```

---

## Task 3: Harden `useDebouncedSearch` (abort-on-clear, sequence guard, total)

**Files:**
- Modify: `monday-app/src/hooks/useDebouncedSearch.ts`
- Test: `monday-app/src/hooks/useDebouncedSearch.test.ts`

- [ ] **Step 1: Rewrite the test for `{trigger,cancel}` + stale/cancel behavior**

Replace `monday-app/src/hooks/useDebouncedSearch.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounceLatest } from "./useDebouncedSearch";

describe("debounceLatest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only runs the last call within the window, and aborts the prior signal", () => {
    const runs: string[] = [], aborted: string[] = [];
    const run = (q: string, s: AbortSignal) => { s.addEventListener("abort", () => aborted.push(q)); runs.push(q); };
    const d = debounceLatest(run, 300);
    d.trigger("a"); d.trigger("ab"); d.trigger("abc");
    vi.advanceTimersByTime(299); expect(runs).toEqual([]);
    vi.advanceTimersByTime(1); expect(runs).toEqual(["abc"]);
    d.trigger("abcd"); vi.advanceTimersByTime(300);
    expect(runs).toEqual(["abc", "abcd"]);
    expect(aborted).toEqual(["abc"]);
  });

  it("cancel() clears a pending timer so nothing runs", () => {
    const runs: string[] = [];
    const d = debounceLatest((q) => runs.push(q), 300);
    d.trigger("abc"); d.cancel();
    vi.advanceTimersByTime(500); expect(runs).toEqual([]);
  });

  it("cancel() aborts an in-flight request", () => {
    const aborted: string[] = [];
    const d = debounceLatest((q, s) => s.addEventListener("abort", () => aborted.push(q)), 300);
    d.trigger("abc"); vi.advanceTimersByTime(300);
    d.cancel(); expect(aborted).toEqual(["abc"]);
  });
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd monday-app && npx vitest run src/hooks/useDebouncedSearch.test.ts`
Expected: FAIL — `d.trigger`/`d.cancel` are not functions.

- [ ] **Step 3: Rewrite the hook**

Replace `monday-app/src/hooks/useDebouncedSearch.ts`:
```ts
import { useEffect, useRef, useState } from "react";

/** Debounce that runs only the latest call after `ms`, aborts the previous in-flight request, and can be
 * cancelled (clears the timer AND aborts any in-flight request). Pure/testable. */
export function debounceLatest(run: (q: string, signal: AbortSignal) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  return {
    trigger(q: string) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        controller?.abort();
        controller = new AbortController();
        run(q, controller.signal);
      }, ms);
    },
    cancel() { if (timer) clearTimeout(timer); timer = undefined; controller?.abort(); controller = undefined; },
  };
}

export interface SearchResponse<T> { items: T[]; total: number }

/** Debounced, cancellable search. Stale-proof two ways: AbortController cancels the network request, and a
 * monotonic sequence id ensures a late older response can never overwrite a newer one or a cleared box. */
export function useDebouncedSearch<T>(fetcher: (q: string, signal: AbortSignal) => Promise<SearchResponse<T>>, ms = 300) {
  const [hits, setHits] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const seq = useRef(0);
  // Consumers pass an inline `fetcher` that is a NEW function every render. Read it through a ref so the
  // debounce is built ONCE — depending on `fetcher` would rebuild it (and the cleanup would abort the
  // in-flight search) on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const debounced = useRef<ReturnType<typeof debounceLatest>>();

  useEffect(() => {
    debounced.current = debounceLatest(async (q, signal) => {
      const mySeq = ++seq.current;
      setLoading(true); setError(false);
      try {
        const r = await fetcherRef.current(q, signal);
        if (signal.aborted || mySeq !== seq.current) return;   // stale -> ignore
        setHits(r.items); setTotal(r.total); setLoading(false);
      } catch (e: any) {
        if (e?.name === "AbortError" || mySeq !== seq.current) return;
        setError(true); setLoading(false); setHits([]); setTotal(0);
      }
    }, ms);
    return () => debounced.current?.cancel();
  }, [ms]);   // stable — the fetcher is read via a ref (see above)

  // Bumping seq invalidates any in-flight response so it can't land after a clear / sub-2-char reset.
  function reset() { seq.current++; setHits([]); setTotal(0); setLoading(false); }
  function query(q: string) {
    if (q.trim().length < 2) { debounced.current?.cancel(); reset(); return; }
    debounced.current?.trigger(q);
  }
  function clear() { debounced.current?.cancel(); reset(); setError(false); }

  return { hits, total, loading, error, query, clear };
}
```

- [ ] **Step 4: Run the hook test, expect pass**

Run: `cd monday-app && npx vitest run src/hooks/useDebouncedSearch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/hooks/useDebouncedSearch.ts monday-app/src/hooks/useDebouncedSearch.test.ts
git commit -m "feat(monday-app): debounced search — cancel on clear/below-2 + sequence guard + total"
```

---

## Task 4: AssociationPicker — search-and-link only, error state, result cap + hint

**Files:**
- Modify: `monday-app/src/views/AssociationPicker.tsx`

- [ ] **Step 1: Replace the component with the search-and-link-only version**

Replace the entire contents of `monday-app/src/views/AssociationPicker.tsx`:
```tsx
import { useEffect, useState } from "react";
import { searchHubspot, type Hit } from "../worker-client";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";

/** A staged link to an existing HubSpot contact/company (resolved to a monday card on Save). */
export interface Assoc { hubspotId: string; itemId?: string; label: string }
interface Props {
  kind: "contacts" | "companies"; token: string;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
}

/** Picker for the deal's contact/company links: search the LIVE HubSpot CRM and stage a link. Creating new
 * contacts/companies is done elsewhere (removed here). Everything is staged; the drawer resolves cards on Save. */
export default function AssociationPicker({ kind, token, value, onChange }: Props) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(-1);
  const { hits, total, loading, error, query, clear } = useDebouncedSearch<Hit>(
    (q, signal) => searchHubspot(token, kind, q, signal), 300);

  useEffect(() => { setActive(-1); }, [hits]);

  function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    onChange([...value, { hubspotId: hit.id, label: hit.name }]);
    clear(); setText("");
  }
  function remove(a: Assoc) { onChange(value.filter(v => v !== a)); }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { if (active >= 0 && hits[active]) { e.preventDefault(); add(hits[active]); } }
    else if (e.key === "Escape") { e.stopPropagation(); clear(); setText(""); } // don't bubble to the drawer's Esc-close
  }

  return (
    <div>
      <div className="dc-section-title">{kind === "contacts" ? "Contacts" : "Companies"}</div>
      {value.length > 0 && (
        <div className="dc-chips">
          {value.map((a, i) => (
            <span key={a.itemId || a.hubspotId || i} className="dc-chip">{a.label}
              <button onClick={() => remove(a)} aria-label="Remove">×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input className="dc-field-input" style={{ flex: 1 }} placeholder={`Search ${kind}…`}
          value={text} onChange={e => { setText(e.target.value); query(e.target.value); }} onKeyDown={onKeyDown} />
        {loading && <div className="dc-spinner" style={{ width: 16, height: 16, borderWidth: 2, margin: 0 }} />}
      </div>
      {error && (
        <div className="dc-err" style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Search unavailable</span>
          <button type="button" className="dc-btn dc-btn-sm" onClick={() => query(text)}>Retry</button>
        </div>
      )}
      {hits.length > 0 && (
        <div className="dc-results">
          {hits.map((h, idx) => (
            <div key={h.id} className="dc-result" onMouseEnter={() => setActive(idx)} onClick={() => add(h)}
              style={{ alignItems: "center", background: idx === active ? "var(--surface-hover)" : undefined }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{h.name}</span>
                {h.secondary && <small>{h.secondary}</small>}
              </div>
              <small style={{ flexShrink: 0, fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase" }}>Existing</small>
            </div>
          ))}
          {total > hits.length && <div className="dc-mut" style={{ padding: "6px 12px", fontSize: 12.5 }}>More matches — keep typing to narrow.</div>}
        </div>
      )}
      {!loading && !error && text.trim().length >= 2 && hits.length === 0 &&
        <div className="dc-mut" style={{ marginTop: 6, fontSize: 12.5 }}>No {kind} found.</div>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the file's own surface**

Run: `cd monday-app && npx tsc --noEmit`
Expected: `AssociationPicker` errors are gone; remaining errors only in `DealDrawer.tsx` (it imports the removed `createContactCard` path and uses `a.create`) and `LineItemsEditor.tsx`. Fixed in Tasks 5–6.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/views/AssociationPicker.tsx
git commit -m "feat(monday-app): AssociationPicker search-and-link only + error/Retry + result hint"
```

---

## Task 5: DealDrawer — drop the New-contact/company create path

**Files:**
- Modify: `monday-app/src/views/DealDrawer.tsx`

- [ ] **Step 1: Trim the monday-client import**

In `monday-app/src/views/DealDrawer.tsx`, change the import (remove `createContactCard, createCompanyCard`):
```ts
import {
  createDeal, updateDealColumns, renameDeal, moveToGroup, getSubitems, getDeal, getCardsByIds, openLink,
  findOrCreateContact, findOrCreateCompany,
} from "../monday-client";
```

- [ ] **Step 2: Simplify `resolveAssocs` (no `a.create` branch)**

Replace the `resolveAssocs` function body:
```ts
  /** Create/find the monday card for each staged association. Rows that already have an itemId are left
   * alone, so a retry can never create a second card for the same record. */
  async function resolveAssocs(list: Assoc[], kind: "contacts" | "companies"): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      const itemId = kind === "contacts"
        ? await findOrCreateContact(a.hubspotId, a.label)
        : await findOrCreateCompany(a.hubspotId, a.label);
      out.push({ ...a, itemId });
    }
    return out;
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd monday-app && npx tsc --noEmit`
Expected: only `LineItemsEditor.tsx` errors remain (Task 6). `DealDrawer` is clean.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/views/DealDrawer.tsx
git commit -m "feat(monday-app): drop inline New-contact/company create from the drawer"
```

---

## Task 6: LineItemsEditor — product-search states + richer result rows

**Files:**
- Modify: `monday-app/src/views/LineItemsEditor.tsx`

- [ ] **Step 1: Update the hook usage to the new shape + richer add**

In `monday-app/src/views/LineItemsEditor.tsx`, replace the hook line and `addFromProduct`:
```tsx
  const { hits, loading, error, query, clear } = useDebouncedSearch<Hit>(
    (q, signal) => searchHubspot(token, "products", q, signal), 300);

  function addFromProduct(h: Hit) {
    onChange([...value, { productId: h.id, name: h.name, unitPrice: h.price || h.secondary || "0", quantity: "1", discountMode: "amount", description: h.description }]);
    setText(""); clear();
  }
```

- [ ] **Step 2: Replace the search input + results block with explicit states**

Replace the block from `<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: value.length ? 10 : 0 }}>` through the closing of the `{hits.length > 0 && (…)}` results div:
```tsx
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: value.length ? 10 : 0 }}>
        <input className="dc-field-input" style={{ flex: 1 }} placeholder="Add product…" value={text}
          onChange={e => { setText(e.target.value); query(e.target.value); }} />
        {loading && <span className="dc-mut" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>Searching…</span>}
        {!loading && <button type="button" className="dc-btn dc-btn-sm" title="Refresh search" onClick={() => query(text)} disabled={text.trim().length < 2}>⟳</button>}
      </div>
      {error && (
        <div className="dc-err" style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Search failed</span>
          <button type="button" className="dc-btn dc-btn-sm" onClick={() => query(text)}>Retry</button>
        </div>
      )}
      {hits.length > 0 && (
        <div className="dc-results">
          {hits.map(h => (
            <div key={h.id} className="dc-result" onClick={() => addFromProduct(h)} style={{ alignItems: "center" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{h.name}</span>
                {(h.sku || h.description) && <small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[h.sku && `SKU ${h.sku}`, h.description].filter(Boolean).join(" · ")}</small>}
              </div>
              <small className="dc-money" style={{ flexShrink: 0 }}>{h.price || h.secondary}</small>
            </div>
          ))}
        </div>
      )}
      {!loading && !error && text.trim().length >= 2 && hits.length === 0 &&
        <div className="dc-mut" style={{ marginTop: 6, fontSize: 12.5 }}>No products found.</div>}
```

- [ ] **Step 3: Full typecheck + tests + build**

Run: `cd monday-app && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc exit 0; all tests pass; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/views/LineItemsEditor.tsx
git commit -m "feat(monday-app): product search states (Searching/No products/Retry/Refresh) + SKU/price rows"
```

---

## Task 7: Verify end-to-end + deploy

**Files:** none (verification + deploy).

- [ ] **Step 1: Full suites**

Run: `cd monday-app && npx tsc --noEmit && npx vitest run && npm run build`
Then: `cd worker && npx tsc --noEmit && npx vitest run`
Expected: both green (app: +2 debounce cases in `useDebouncedSearch.test.ts`; worker: the one product case in `hubspot-search.test.ts` is split into two).

- [ ] **Step 2: Deploy worker then app**

```bash
cd worker && npx wrangler deploy
cd ../monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist
```
Expected: worker "Current Version ID: …"; app "Your project is live at …/source/<id>.zip". Record both.

- [ ] **Step 3: Live read-only check (freshness + no-store)**

Run this from `worker` (uses `.env` `HUBSPOT_ACCESS_TOKEN`; never prints it):
```bash
node -e 'const B="https://hubspot-monday-sync.askada.workers.dev";fetch(B+"/app/search?type=products&q=zoom&limit=20",{headers:{Authorization:"Bearer x"}}).then(r=>console.log("no-auth status",r.status,"cache-control:",r.headers.get("cache-control")))'
```
Expected: `403` (auth-gated) with `cache-control: no-store` present on the response.

- [ ] **Step 4: Manual checklist (hard-refresh the board view)**

1. Associations tab: **no** "New contact"/"New company" buttons; searching a contact/company shows live results; a just-created HubSpot contact appears on a fresh search.
2. Type 1 char → no request; type 2+ → results after ~300ms; clear the box → results vanish and no late results appear.
3. Kill network / force an error → "Search unavailable — Retry"; Retry re-runs.
4. Line Items → Add product: shows Searching… then rows with SKU · description · price; "No products found" for gibberish; the ⟳ refetches.
5. A search with many matches shows "More matches — keep typing to narrow".

- [ ] **Step 5: Commit any doc note (optional)**

No code change expected here. If a fix was needed, commit it with a `fix(...)` message and re-run Steps 1–4.

---

## Self-Review

**1. Spec coverage (Phase 1 of the design):**
- Live search unchanged + no-store → Tasks 1 (Step 5), 2 (Step 1). ✓
- `total` + "keep typing" hint (20 results) → Tasks 1, 2, 4 (Step 1). ✓
- Debounce ≥2 chars / ~300ms → unchanged (`query` gate + `debounceLatest`). ✓
- Stale protection: abort-on-clear, abort-below-2, sequence guard → Task 3. ✓
- Error surfacing ("Search unavailable"/"Search failed" + Retry) → Tasks 2 (throw), 4, 6. ✓
- Product result display (name/SKU/price/description) → Tasks 1, 6. ✓
- Product states (Searching…/No products/Retry/Refresh) → Task 6. ✓
- Remove New contact/company → Tasks 4, 5. ✓

**2. Placeholder scan:** every code step shows complete code; commands have expected output. No TBD/TODO. ✓

**3. Type consistency:**
- `SearchHit`/`Hit` gain the same optional `sku/price/description` (Tasks 1, 2). ✓
- `searchHubspot` returns `SearchResult {items,total}` (Task 2), consumed by `useDebouncedSearch`'s `SearchResponse<T>` fetcher (Task 3) and by `AssociationPicker`/`LineItemsEditor` via `{hits,total,loading,error,query,clear}` (Tasks 4, 6). ✓
- `debounceLatest` → `{trigger,cancel}` (Task 3) matches the updated test (Task 3 Step 1). ✓
- `Assoc` loses `create?`; `DealDrawer.resolveAssocs` no longer references `a.create` (Tasks 4, 5). ✓
- Cross-file compile only green after Task 6; Tasks 2–5 note the expected transient tsc errors. ✓

---

## Execution Handoff

Phase 2 (two line-item flows + schema-driven manual form + Save-to-library) and Phase 3 (fresh-on-open + Refresh) each get their own plan when Phase 1 is merged.
