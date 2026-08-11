# Deal Cockpit v3.3 — Phase 3: Fresh-on-open line items + Refresh + guards

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** When a rep opens a deal's Line Items tab, pull the deal's **current** HubSpot line items (merged by HubSpot Line Item ID) so line items added/edited directly in HubSpot show up — including the extended fields Phase 2 added — plus a "Refresh line items" button, an unsaved-edit guard, and a short cache. This completes editing extended fields on existing line items (Phase 2's manual form only handled *creating* new ones).

**Architecture:** monday app → Worker `GET /app/deal-line-items?itemId=` → resolves the deal's HubSpot id → returns its live HubSpot line items in the editor's `LineItem` shape. The editor merges by Line Item ID **only** (never by name) into its rows, keeping each monday `subitemId`; failure keeps the existing subitem data visible ("may be outdated"), never blanks.

**Tech Stack:** Worker + vitest; React + TS + vitest. Deploy `wrangler` + cached `mapps`.

**Design source:** `C:\Users\PC\.claude\plans\create-a-small-python-jupyter-happy-turtle.md` (Phase 3). Reuses Phase-2 pieces: `LINE_ITEM_WRITE_PROPS`, `getAssociatedIds`, `getRecordsByIds`, `LineItem`, `getLineItemSchema`.

**Also fold in (Phase-2 review nits, cosmetic):** remove dead `LiField.enum`; remove the unreachable `if (res?.error) throw` in `createHubspotLineItem`; rename `invalid`→`validation` in `LineItemForm`.

---

## File Structure

| File | Change |
|------|--------|
| `worker/src/hubspot.ts` | add `getDealLineItems(env, dealId)` — fetch + map HubSpot line items to the editor shape |
| `worker/src/index.ts` | `GET /app/deal-line-items?itemId=` (resolve deal id from the monday parent, return `{lineItems}`) |
| `monday-app/src/worker-client.ts` | `getDealLineItems(token, itemId)`; remove the dead `res?.error` throw |
| `monday-app/src/lib/line-item-merge.ts` | **new** — `mergeLineItems(current, fresh)` (by Line Item ID, pure) |
| `monday-app/src/lib/line-item-merge.test.ts` | **new** — unit tests |
| `monday-app/src/lib/line-item-form.ts` | remove the unused `enum` field from `LiField`/`LI_FIELDS` |
| `monday-app/src/views/LineItemForm.tsx` | rename `invalid`→`validation` |
| `monday-app/src/views/DealDrawer.tsx` | fresh-on-open fetch + merge on Line Items tab; refresh orchestration + status; pass to editor |
| `monday-app/src/views/LineItemsEditor.tsx` | "Refresh line items" button (last-refreshed / refreshing / error+Retry) + unsaved-edit guard |

---

## Task 1: Worker — `getDealLineItems` + route

**Files:** Modify `worker/src/hubspot.ts`, `worker/src/index.ts`.

- [ ] **Step 1: Add `getDealLineItems` to `worker/src/hubspot.ts`** (uses `getAssociatedIds`, `getRecordsByIds`, `LINE_ITEM_WRITE_PROPS`):
```ts
import { LINE_ITEM_WRITE_PROPS } from "./line-item-props";

/** Fetch a deal's CURRENT HubSpot line items, mapped to the app editor's row shape (core fields + a full
 * `props` bag of the writable extended fields for re-editing). Read-only. */
export async function getDealLineItems(env: Env, dealId: string):
    Promise<{ lineItemId: string; productId?: string; name: string; unitPrice: string; quantity: string;
      currency?: string; description?: string; discount?: string; discountPct?: string;
      discountMode: "amount" | "percent"; serviceDate?: string; props: Record<string, string> }[]> {
  const ids = await getAssociatedIds(env, "deals", dealId, "line_items");
  if (!ids.length) return [];
  const recs = await getRecordsByIds(env, "line_items", ids, [...LINE_ITEM_WRITE_PROPS]);
  return recs.map(r => {
    const p = r.properties as Record<string, string>;
    const props: Record<string, string> = {};
    for (const k of LINE_ITEM_WRITE_PROPS) if (p[k] != null && p[k] !== "") props[k] = String(p[k]);
    return {
      lineItemId: String(r.id), productId: p.hs_product_id || undefined,
      name: p.name ?? "", unitPrice: p.price ?? "", quantity: p.quantity ?? "1",
      currency: p.hs_line_item_currency_code || undefined, description: p.description || undefined,
      discount: p.discount || undefined, discountPct: p.hs_discount_percentage || undefined,
      discountMode: p.hs_discount_percentage ? "percent" : "amount",
      serviceDate: p.service_date || undefined, props,
    };
  });
}
```

- [ ] **Step 2: Add the route to `worker/src/index.ts`** (after `/app/line-item-schema`; `getItem`, `colText`, `DEALS`, `getDealLineItems` are imported — add `getDealLineItems` to the `./hubspot` import):
```ts
      // GET /app/deal-line-items?itemId=<monday parent> — the deal's CURRENT HubSpot line items (fresh-on-open).
      if (url.pathname === "/app/deal-line-items" && req.method === "GET") {
        const itemId = url.searchParams.get("itemId") ?? "";
        if (!/^\d+$/.test(itemId)) return Response.json({ error: "itemId must be numeric" }, { status: 400, headers: CORS });
        try {
          const deal = await getItem(env, itemId);
          const dealId = deal ? colText(deal, DEALS.idCol) : "";
          const lineItems = dealId ? await getDealLineItems(env, dealId) : [];
          return Response.json({ lineItems }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/deal-line-items] item=${itemId} error="${String(e).slice(0, 140)}"`);
          return Response.json({ lineItems: [], error: "fetch-failed" }, { status: 502, headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }
```

- [ ] **Step 3: Verify** — `cd worker && npx tsc --noEmit && npx vitest run` (171 green).
- [ ] **Step 4: Commit** — `git add worker/src/hubspot.ts worker/src/index.ts && git commit -m "feat(worker): GET /app/deal-line-items (fresh HubSpot line items for a deal)"`

---

## Task 2: App client + pure merge + nit-fixes

**Files:** Modify `monday-app/src/worker-client.ts`, `monday-app/src/lib/line-item-form.ts`; create `monday-app/src/lib/line-item-merge.ts`, `monday-app/src/lib/line-item-merge.test.ts`.

- [ ] **Step 1: Failing test** — `monday-app/src/lib/line-item-merge.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mergeLineItems } from "./line-item-merge";
import type { LineItem } from "../views/LineItemsEditor";

const row = (o: Partial<LineItem>): LineItem => ({ name: "", unitPrice: "0", quantity: "1", ...o });

describe("mergeLineItems (by HubSpot Line Item ID only)", () => {
  it("updates a matching row's fields but keeps its monday subitemId", () => {
    const cur = [row({ subitemId: "s1", lineItemId: "L1", name: "old", unitPrice: "5" })];
    const fresh = [row({ lineItemId: "L1", name: "new", unitPrice: "9" })];
    const out = mergeLineItems(cur, fresh);
    expect(out).toEqual([{ ...fresh[0], subitemId: "s1" }]);
  });
  it("adds a HubSpot line item that has no matching row", () => {
    const out = mergeLineItems([], [row({ lineItemId: "L2", name: "hs-only" })]);
    expect(out.map(r => r.lineItemId)).toEqual(["L2"]);
  });
  it("keeps unsaved rows (no lineItemId) and drops rows removed in HubSpot", () => {
    const cur = [row({ subitemId: "s3", lineItemId: "L3", name: "gone" }), row({ name: "pending" })];
    const out = mergeLineItems(cur, []);            // HubSpot has none
    expect(out.map(r => r.name)).toEqual(["pending"]);   // L3 dropped, unsaved kept
  });
  it("never matches by name", () => {
    const cur = [row({ subitemId: "s4", lineItemId: "L4", name: "Widget" })];
    const fresh = [row({ lineItemId: "L9", name: "Widget" })];
    const out = mergeLineItems(cur, fresh);
    expect(out).toEqual([{ ...fresh[0] }]);         // L4 dropped (not in fresh), L9 added; no name merge
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** — `monday-app/src/lib/line-item-merge.ts`:
```ts
import type { LineItem } from "../views/LineItemsEditor";

/** Merge the deal's fresh HubSpot line items into the editor's rows, keyed by HubSpot Line Item ID ONLY
 * (never by name). A matching row keeps its monday `subitemId` and takes the fresh HubSpot fields; a fresh
 * line item with no matching row is added; a row whose id is gone from HubSpot is dropped; unsaved rows
 * (no `lineItemId`) are preserved. */
export function mergeLineItems(current: LineItem[], fresh: LineItem[]): LineItem[] {
  const bySubitem = new Map<string, LineItem>();
  for (const c of current) if (c.lineItemId) bySubitem.set(c.lineItemId, c);
  const merged = fresh.map(f => {
    const cur = f.lineItemId ? bySubitem.get(f.lineItemId) : undefined;
    return cur?.subitemId ? { ...f, subitemId: cur.subitemId } : { ...f };
  });
  const unsaved = current.filter(c => !c.lineItemId);
  return [...merged, ...unsaved];
}
```

- [ ] **Step 4: Add `getDealLineItems` to `worker-client.ts`** + remove the dead throw. Add:
```ts
export async function getDealLineItems(token: string, itemId: string): Promise<import("./views/LineItemsEditor").LineItem[]> {
  const res = await call(token, "GET", `/app/deal-line-items?itemId=${encodeURIComponent(itemId)}`);
  return res?.lineItems ?? [];
}
```
And in `createHubspotLineItem`, DELETE the line `if (res?.error) throw new Error("line-item-" + res.error);` (unreachable — `call` already throws on non-2xx).

- [ ] **Step 5: Nit — remove the unused `enum` field** in `monday-app/src/lib/line-item-form.ts`: delete `enum?: boolean` from the `LiField` interface, and remove every `enum: true` from the `LI_FIELDS` entries. (`LineItemForm` branches on `f.type === "enum"`, so nothing reads `f.enum`.)

- [ ] **Step 6: Run tests + tsc** — `cd monday-app && npx vitest run src/lib/line-item-merge.test.ts && npx tsc --noEmit && npx vitest run` → all green (90 + 4 new).
- [ ] **Step 7: Commit** — `git add monday-app/src/lib/line-item-merge.ts monday-app/src/lib/line-item-merge.test.ts monday-app/src/worker-client.ts monday-app/src/lib/line-item-form.ts && git commit -m "feat(monday-app): mergeLineItems + getDealLineItems client; drop dead enum field + res.error throw"`

---

## Task 3: DealDrawer fresh-on-open + LineItemsEditor Refresh button + guard

**Files:** Modify `monday-app/src/views/DealDrawer.tsx`, `monday-app/src/views/LineItemsEditor.tsx`.

- [ ] **Step 1: DealDrawer — refresh state + orchestration.** Add near the other state:
```ts
  const [liRefresh, setLiRefresh] = useState<{ at: number; loading: boolean; error: boolean }>({ at: 0, loading: false, error: false });
  const liFetched = useRef(false);

  async function refreshLineItems() {
    if (!isEdit) return;
    setLiRefresh(s => ({ ...s, loading: true, error: false }));
    try {
      const fresh = await getDealLineItems(board.sessionToken, itemId!);
      setLineItems(cur => mergeLineItems(cur, fresh));
      setLiRefresh({ at: Date.now(), loading: false, error: false });
    } catch {
      setLiRefresh(s => ({ ...s, loading: false, error: true }));   // keep existing rows; mark maybe-outdated
    }
  }
```
Import `getDealLineItems` from `../worker-client`, `mergeLineItems` from `../lib/line-item-merge`, and `useRef` (already imported).

- [ ] **Step 2: Fetch once when the Line Items tab first opens** (cache: don't refetch within ~45s or on tab re-entry). Add an effect:
```ts
  useEffect(() => {
    if (tab !== "lineItems" || !isEdit || liFetched.current) return;
    liFetched.current = true;
    void refreshLineItems();
  }, [tab, isEdit]);
```

- [ ] **Step 3: Pass refresh props to the editor** — change the Line Items tab render:
```tsx
          {tab === "lineItems" && (
            <LineItemsEditor token={board.sessionToken} value={lineItems} currency={form.currency}
              onChange={next => { setDirty(true); setLineItems(next); }} onError={setChildErr} onUseTotal={n => set({ amount: String(n) })}
              refreshState={liRefresh} onRefresh={refreshLineItems} dirty={dirty} />
          )}
```

- [ ] **Step 4: LineItemsEditor — accept the refresh props + render the button + guard.** Extend `Props`:
```ts
interface Props {
  token: string; value: LineItem[]; onChange: (n: LineItem[]) => void;
  onError?: (msg: string) => void; onUseTotal?: (n: number) => void; currency?: string;
  refreshState?: { at: number; loading: boolean; error: boolean }; onRefresh?: () => void; dirty?: boolean;
}
```
Destructure them (with defaults). At the TOP of the returned JSX (right after `<div className="dc-section-title">Line items</div>`), add a refresh row:
```tsx
      {onRefresh && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: 12.5 }}>
          <button type="button" className="dc-btn dc-btn-sm" disabled={refreshState?.loading}
            onClick={() => { if (!dirty || confirm("Discard unsaved line-item changes and refresh from HubSpot?")) onRefresh(); }}>
            {refreshState?.loading ? "Refreshing…" : "⟳ Refresh line items"}
          </button>
          {refreshState?.error
            ? <span className="dc-mut" style={{ color: "var(--red)" }}>Couldn't refresh — showing last known (may be outdated)</span>
            : refreshState?.at ? <span className="dc-mut">Updated {new Date(refreshState.at).toLocaleTimeString()}</span> : null}
        </div>
      )}
```

- [ ] **Step 5: Verify** — `cd monday-app && npx tsc --noEmit && npx vitest run && npm run build` → all green.
- [ ] **Step 6: Commit** — `git add monday-app/src/views/DealDrawer.tsx monday-app/src/views/LineItemsEditor.tsx && git commit -m "feat(monday-app): fresh-on-open line items + Refresh button + unsaved-edit guard"`

---

## Task 4: LineItemForm nit + verify + deploy

**Files:** Modify `monday-app/src/views/LineItemForm.tsx`.

- [ ] **Step 1: Nit — rename `invalid`→`validation`** in `LineItemForm.tsx`: `const validation = validateLineItemForm(v);` and update the two uses — `validation.errors[f.prop]` and `disabled={!validation.ok}`. (Clarity: the value is the validation result, not "invalid".)
- [ ] **Step 2: Verify** — `cd monday-app && npx tsc --noEmit && npx vitest run && npm run build`; `cd worker && npx tsc --noEmit && npx vitest run` → all green.
- [ ] **Step 3: Commit** — `git add monday-app/src/views/LineItemForm.tsx && git commit -m "refactor(monday-app): rename invalid->validation in LineItemForm"`
- [ ] **Step 4: Deploy** — `cd worker && npx wrangler deploy`; `cd monday-app && "<cached mapps>" code:push -c -i 16011075 -f -d ./dist`. Record ids.
- [ ] **Step 5: Auth-gate check** — `GET /app/deal-line-items?itemId=1` unauth → 403; OPTIONS → 204.
- [ ] **Step 6: Manual checklist (user, on a test deal):** edit a line item's Family/qty directly in HubSpot → reopen the deal's Line Items tab → the change shows (merged by Line Item ID); ⟳ Refresh updates without reloading the board; making a local edit then Refresh prompts "Discard…"; kill network + Refresh → keeps existing rows + "may be outdated".

---

## Self-Review

**Spec coverage:** fresh-on-open fetch (Task 1 route + Task 3 effect); merge by Line Item ID only, never name (Task 2 `mergeLineItems` + tests); Refresh button with last-refreshed/refreshing/error (Task 3); unsaved-edit guard (Task 3 confirm); failure keeps data + "may be outdated", never blank (Task 3 catch keeps rows); cache (~tab-first-open via `liFetched` ref — no refetch on tab switch). Nits folded (Tasks 2, 4).

**Placeholder scan:** complete code + commands throughout.

**Type consistency:** `getDealLineItems` (worker) returns the editor `LineItem` shape; `worker-client.getDealLineItems` returns `LineItem[]`; `mergeLineItems(current, fresh): LineItem[]`; `LineItemsEditor` `Props` gains `refreshState/onRefresh/dirty` matching what DealDrawer passes. The Worker maps HubSpot props → the same `LineItem` fields the app uses (`unitPrice`, `discountPct`, `serviceDate`, `props`).

**Phase-3 dependency note:** editing an existing line item's extended fields now works because fresh-on-open hydrates `li.props`; `persistLineItems` (Phase 2) sends `li.props ?? lineItemHubspotProperties(li)` on update — so a no-change save still can't blank an unloaded field, and a loaded-then-saved field round-trips.
