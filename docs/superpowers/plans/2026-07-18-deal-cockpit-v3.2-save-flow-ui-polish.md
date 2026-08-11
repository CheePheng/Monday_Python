# Deal Cockpit v3.2 — Friendly Save Flow, Feedback & UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saving a deal instant and non-jarring — the drawer closes on monday confirmation, only the edited row updates (no full-board reload), and the row's sync badge flips to "Synced" only when HubSpot truly confirms — plus a refine-only UI polish pass and a full regression audit.

**Architecture:** Split the save into (a) monday writes in the drawer, which close the drawer and toast "Saved to monday", and (b) a background HubSpot sync owned by the board (`useBoard.finishSave`) that updates one row via `patchRow` and sets a transient per-row sync status. Two pure helpers carry the correctness (`confirmSynced`, `upsertRow`) and are built test-first.

**Tech Stack:** React 18 + TypeScript + Vite; vitest; monday GraphQL (`getDeal`, `getItemNames`); the existing Worker `/app/sync-deal` and `/app/clear-deal-fields` endpoints (no Worker changes).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `monday-app/src/lib/sync-status.ts` | **new** — `SyncStatus` type + `confirmSynced()` (pure) |
| `monday-app/src/lib/sync-status.test.ts` | **new** — unit tests for `confirmSynced` |
| `monday-app/src/lib/rows.ts` | **new** — `upsertRow()` (pure, replace-by-id / append) |
| `monday-app/src/lib/rows.test.ts` | **new** — unit tests for `upsertRow` |
| `monday-app/src/worker-client.ts` | `syncDeal` returns the Worker's `ok` boolean |
| `monday-app/src/useBoard.ts` | extract `rawItemToRow`; add `syncing` state, `patchRow`, `finishSave`; expose them |
| `monday-app/src/views/DealDrawer.tsx` | `save()` does monday writes only; new `onSaved(SavedInfo)`; Overview sub-sections |
| `monday-app/src/views/BoardView.tsx` | new `onSaved` handler; per-row sync badge; skeleton loading; empty-state CTA; name tooltips; toast variants + auto-dismiss |
| `monday-app/src/views/KanbanView.tsx` | `board.reload()` → `board.patchRow(id)` |
| `monday-app/src/styles.css` | `.dc-skeleton`, `.dc-syncbadge` states, toast `info`/`error` variants |

`SavedInfo` is the shared contract between the drawer and the board:

```ts
export interface SavedInfo { itemId: string; isEdit: boolean; clearProps: string[] }
```

It lives in `lib/sync-status.ts` (Task 1) so both `DealDrawer` and `useBoard` import it from one place.

---

## Task 1: `syncDeal` returns the Worker's success boolean

**Files:**
- Modify: `monday-app/src/worker-client.ts`

- [ ] **Step 1: Change `syncDeal` to return a boolean**

Current:
```ts
export async function syncDeal(token: string, itemId: string): Promise<void> {
  await call(token, "POST", "/app/sync-deal", { itemId });
}
```

Replace with:
```ts
export async function syncDeal(token: string, itemId: string): Promise<boolean> {
  const res = await call(token, "POST", "/app/sync-deal", { itemId });
  return res?.ok === true;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd monday-app && npx tsc --noEmit`
Expected: exit 0. (The only current caller, `DealDrawer`, ignores the return — still valid. That caller is removed in Task 5.)

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/worker-client.ts
git commit -m "refactor(monday-app): syncDeal returns the Worker ok boolean"
```

---

## Task 2: `confirmSynced` pure helper (TDD)

**Files:**
- Create: `monday-app/src/lib/sync-status.ts`
- Test: `monday-app/src/lib/sync-status.test.ts`

- [ ] **Step 1: Write the failing test**

`monday-app/src/lib/sync-status.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { confirmSynced } from "./sync-status";

describe("confirmSynced", () => {
  it("is 'synced' only when the Worker reported ok AND a HubSpot Deal ID exists", () =>
    expect(confirmSynced(true, "9001")).toBe("synced"));
  it("is 'error' when ok but no HubSpot Deal ID yet (never a false Synced)", () =>
    expect(confirmSynced(true, undefined)).toBe("error"));
  it("is 'error' when the Worker did not report ok", () => {
    expect(confirmSynced(false, "9001")).toBe("error");
    expect(confirmSynced(false, undefined)).toBe("error");
  });
  it("treats an empty-string id as no id", () =>
    expect(confirmSynced(true, "")).toBe("error"));
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd monday-app && npx vitest run src/lib/sync-status.test.ts`
Expected: FAIL — cannot find module `./sync-status`.

- [ ] **Step 3: Implement**

`monday-app/src/lib/sync-status.ts`:
```ts
export type SyncStatus = "syncing" | "synced" | "error";

/** Shared drawer→board contract for a completed monday save whose HubSpot sync runs in the background. */
export interface SavedInfo { itemId: string; isEdit: boolean; clearProps: string[] }

/** "Synced" is only truthful when the Worker reported success AND a HubSpot Deal ID now exists.
 * Anything else is "error" (shown as Retry) — never a false Synced. */
export function confirmSynced(syncOk: boolean, hubspotId?: string): SyncStatus {
  return syncOk && !!hubspotId ? "synced" : "error";
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd monday-app && npx vitest run src/lib/sync-status.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/sync-status.ts monday-app/src/lib/sync-status.test.ts
git commit -m "feat(monday-app): confirmSynced + SavedInfo/SyncStatus contract"
```

---

## Task 3: `upsertRow` pure helper (TDD)

**Files:**
- Create: `monday-app/src/lib/rows.ts`
- Test: `monday-app/src/lib/rows.test.ts`

- [ ] **Step 1: Write the failing test**

`monday-app/src/lib/rows.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { upsertRow } from "./rows";
import type { DealRow } from "./filter";

const R = (id: string, name = ""): DealRow => ({ id, name, stage: "", salesUserIds: [] });

describe("upsertRow", () => {
  it("replaces the row with the same id, keeping position", () => {
    const rows = [R("1", "a"), R("2", "b"), R("3", "c")];
    const out = upsertRow(rows, R("2", "B!"));
    expect(out.map(r => r.id)).toEqual(["1", "2", "3"]);
    expect(out[1].name).toBe("B!");
  });
  it("appends a new id", () => {
    const out = upsertRow([R("1"), R("2")], R("9", "new"));
    expect(out.map(r => r.id)).toEqual(["1", "2", "9"]);
  });
  it("does not mutate the input array", () => {
    const rows = [R("1"), R("2")];
    const copy = [...rows];
    upsertRow(rows, R("2", "x"));
    expect(rows).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd monday-app && npx vitest run src/lib/rows.test.ts`
Expected: FAIL — cannot find module `./rows`.

- [ ] **Step 3: Implement**

`monday-app/src/lib/rows.ts`:
```ts
import type { DealRow } from "./filter";

/** Replace the row with the same id, or append it. Pure; never mutates the input array. */
export function upsertRow(rows: DealRow[], row: DealRow): DealRow[] {
  const i = rows.findIndex(r => r.id === row.id);
  if (i === -1) return [...rows, row];
  const out = rows.slice();
  out[i] = row;
  return out;
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd monday-app && npx vitest run src/lib/rows.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/rows.ts monday-app/src/lib/rows.test.ts
git commit -m "feat(monday-app): upsertRow (replace-by-id / append, pure)"
```

---

## Task 4: `useBoard` — shared row builder, `syncing`, `patchRow`, `finishSave`

**Files:**
- Modify: `monday-app/src/useBoard.ts`

Current relevant code (for reference): `toRow(item)` builds a `DealRow` from column text; `load()` resolves
linked names then maps items to rows; the hook returns `{ ...s, reload: load, setAutoRefreshPaused }`.

- [ ] **Step 1: Add imports**

At the top of `monday-app/src/useBoard.ts`, add:
```ts
import { getDeal } from "./monday-client";
import { upsertRow } from "./lib/rows";
import { syncDeal, clearDealFields } from "./worker-client";
import { confirmSynced, type SyncStatus, type SavedInfo } from "./lib/sync-status";
```
(`getContext, getBoardMeta, getUsers, getDeals, getItemNames` are already imported — extend that line to also import `getDeal` rather than duplicating, if preferred.)

- [ ] **Step 2: Add a module-level shared row builder**

Add near `toRow` (module scope, not inside the hook):
```ts
/** Build a DealRow from a raw item, resolving its linked company/contact names from `names`.
 * Shared by load() (all rows) and patchRow() (one row) so they can never drift. */
function rawItemToRow(item: RawItem, names: Record<string, string>): DealRow {
  const nameList = (col: string) => linkedIds(item, col).map(id => names[id]).filter(Boolean).join(", ");
  return { ...toRow(item), company: nameList(DEAL_COLS.company.id), contact: nameList(DEAL_COLS.contact.id) };
}
```

- [ ] **Step 3: Use the shared builder in `load()`**

In `load()`, replace the inline names+rows block:
```ts
      const names = await getItemNames([...linkIds]);
      const nameList = (it: RawItem, col: string) => linkedIds(it, col).map(id => names[id]).filter(Boolean).join(", ");
      const rows = items.map(it => ({ ...toRow(it),
        company: nameList(it, DEAL_COLS.company.id), contact: nameList(it, DEAL_COLS.contact.id) }));
```
with:
```ts
      const names = await getItemNames([...linkIds]);
      const rows = items.map(it => rawItemToRow(it, names));
```

- [ ] **Step 4: Extend `BoardState` and add the `syncing` state**

In the `BoardState` interface add:
```ts
  syncing: Record<string, SyncStatus>;
  patchRow: (itemId: string) => Promise<DealRow | null>;
  finishSave: (info: SavedInfo) => Promise<void>;
```

Inside `useBoard`, after the existing `useState`/`pausedRef`, add:
```ts
  const [syncing, setSyncing] = useState<Record<string, SyncStatus>>({});
  const setStatus = (id: string, status: SyncStatus) => setSyncing(prev => ({ ...prev, [id]: status }));
  const clearStatus = (id: string) => setSyncing(prev => { const n = { ...prev }; delete n[id]; return n; });
```

- [ ] **Step 5: Add `patchRow`**

Inside `useBoard` (after `load`):
```ts
  // Refetch ONE deal and upsert it into rows — no `loading` flip, so the board never flashes.
  async function patchRow(itemId: string): Promise<DealRow | null> {
    const it = await getDeal(itemId);
    if (!it) return null;
    const linkIds = new Set<string>();
    for (const id of linkedIds(it, DEAL_COLS.company.id)) linkIds.add(id);
    for (const id of linkedIds(it, DEAL_COLS.contact.id)) linkIds.add(id);
    const names = await getItemNames([...linkIds]);
    const row = rawItemToRow(it, names);
    setS(prev => ({ ...prev, rows: upsertRow(prev.rows, row) }));
    return row;
  }
```

- [ ] **Step 6: Add `finishSave`**

Inside `useBoard`:
```ts
  // Background HubSpot sync for a just-saved deal. Updates the one row, then flips the badge to Synced
  // ONLY when the Worker reported ok AND a HubSpot Deal ID is present. Failure -> "error" (Retry badge).
  async function finishSave(info: SavedInfo) {
    const { itemId, clearProps } = info;
    setStatus(itemId, "syncing");
    const row = await patchRow(itemId);            // show the new monday values immediately
    try {
      if (clearProps.length && row?.hubspotId)
        await clearDealFields(s.sessionToken, row.hubspotId, clearProps);
      const ok = await syncDeal(s.sessionToken, itemId);
      const after = await patchRow(itemId);        // pick up HubSpot Deal ID + last-synced
      const status = confirmSynced(ok, after?.hubspotId);
      setStatus(itemId, status);
      if (status === "synced") setTimeout(() => clearStatus(itemId), 4000);
    } catch {
      setStatus(itemId, "error");
    }
  }
```

- [ ] **Step 7: Expose the new API from the hook return**

Change the return:
```ts
  return { ...s, reload: load, setAutoRefreshPaused: (p: boolean) => { pausedRef.current = p; } };
```
to:
```ts
  return {
    ...s, syncing, reload: load, patchRow, finishSave,
    setAutoRefreshPaused: (p: boolean) => { pausedRef.current = p; },
  };
```

- [ ] **Step 8: Typecheck**

Run: `cd monday-app && npx tsc --noEmit`
Expected: exit 0. (BoardView still passes the old `onSaved`; that's fixed in Task 6. If tsc flags the old `onSaved(msg)` call site now, leave it — Task 5/6 resolve it. If it blocks, do Tasks 5–6 before re-running.)

- [ ] **Step 9: Commit**

```bash
git add monday-app/src/useBoard.ts
git commit -m "feat(monday-app): targeted patchRow + background finishSave + per-row sync status"
```

---

## Task 5: `DealDrawer` — monday writes only, new `onSaved`, Overview sub-sections

**Files:**
- Modify: `monday-app/src/views/DealDrawer.tsx`

- [ ] **Step 1: Update imports**

Remove the HubSpot-call imports from the drawer (they move to the board):
- In the line `import { syncDeal, clearDealFields } from "../worker-client";` — delete it.
- Keep `import { deleteHubspotAssociation } from "../worker-client";` (still used by `unlinkRemoved`).

Add the shared contract import:
```ts
import type { SavedInfo } from "../lib/sync-status";
```

- [ ] **Step 2: Change the `onSaved` prop type**

In `interface Props`, change:
```ts
onSaved: (msg: string) => void;
```
to:
```ts
onSaved: (info: SavedInfo) => void;
```

- [ ] **Step 3: Replace the tail of `save()`**

Find this block at the end of `save()`:
```ts
      const persisted = await persistLineItems(board.sessionToken, parentId, lineItems);
      setLineItems(persisted);
      // Push the rep's deliberate clears to HubSpot. ...
      const clearProps = [
        ...(clears.amount ? ["amount"] : []),
        ...(clears.closeDate ? ["closedate"] : []),
        ...(clears.salesUsers ? ["sales_user"] : []),
      ];
      if (dealHubspotId && clearProps.length)
        await clearDealFields(board.sessionToken, dealHubspotId, clearProps);
      try { await syncDeal(board.sessionToken, parentId); } catch { /* webhook is the fallback; don't fail the save */ }
      onSaved(isEdit ? "Deal updated" : "Deal created — syncing to HubSpot…");
```

Replace with:
```ts
      const persisted = await persistLineItems(board.sessionToken, parentId, lineItems);
      setLineItems(persisted);
      // HubSpot side (clears + reconcile) is deferred to the board's background finishSave, so the drawer
      // can close the instant monday confirms. clearProps carries the rep's deliberate clears.
      const clearProps = [
        ...(clears.amount ? ["amount"] : []),
        ...(clears.closeDate ? ["closedate"] : []),
        ...(clears.salesUsers ? ["sales_user"] : []),
      ];
      onSaved({ itemId: parentId, isEdit, clearProps });
```

- [ ] **Step 4: Group the Overview tab into sub-sections**

In the Overview tab JSX (`{tab === "overview" && (...)}`), wrap the field groups with `.dc-section-title`
headers. Change the opening of the overview block from:
```tsx
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label="Deal name" required>
```
to:
```tsx
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="dc-section-title">Deal</div>
              <Field label="Deal name" required>
```
Then immediately before the Amount/Currency/Close date grid (`<div className="dc-grid">` containing
`Field label="Amount"`), insert:
```tsx
              <div className="dc-section-title">Value</div>
```
Then immediately before the Sales Users `Field` (`<Field label="Sales Users">`), insert:
```tsx
              <div className="dc-section-title">People</div>
```
(These are the three groups: Deal name+stage, Value, People+details. The Deal type/Priority/Vendors/Deal
owner grids that follow People stay under the People section — no extra header needed.)

- [ ] **Step 5: Typecheck**

Run: `cd monday-app && npx tsc --noEmit`
Expected: BoardView's `onSaved={async (msg) => ...}` is now a type error (string vs SavedInfo). That is expected and fixed in Task 6. Proceed.

- [ ] **Step 6: Commit**

```bash
git add monday-app/src/views/DealDrawer.tsx
git commit -m "feat(monday-app): drawer does monday writes only; defers HubSpot to board; Overview sub-sections"
```

---

## Task 6: `BoardView` — save handler, sync badge, toast variants

**Files:**
- Modify: `monday-app/src/views/BoardView.tsx`

- [ ] **Step 1: Toast state becomes a typed object**

Change:
```ts
  const [toast, setToast] = useState<string | null>(null);
```
to:
```ts
  const [toast, setToast] = useState<{ text: string; type: "success" | "info" | "error" } | null>(null);
```

- [ ] **Step 2: Auto-dismiss success/info toasts**

Add after the `toast` state (alongside the other hooks):
```ts
  useEffect(() => {
    if (!toast || toast.type === "error") return;   // errors persist until dismissed
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
```
(`useEffect` is already imported.)

- [ ] **Step 3: Update every `setToast` call site to the object form**

- The KanbanView prop `onToast={setToast}` — change to `onToast={(text) => setToast({ text, type: "info" })}`.
- Any other `setToast("...")` in this file → `setToast({ text: "...", type: "success" })`.

- [ ] **Step 4: New `onSaved` handler + drawer wiring**

Replace the drawer element:
```tsx
      {editing !== undefined && (
        <DealDrawer key={editing ?? "new"} itemId={editing} board={board}
          onDirtyChange={d => { drawerDirty.current = d; }}
          onClose={() => setEditing(undefined)}
          onSaved={async (msg) => { setEditing(undefined); setToast(msg); await board.reload(); }} />
      )}
```
with:
```tsx
      {editing !== undefined && (
        <DealDrawer key={editing ?? "new"} itemId={editing} board={board}
          onDirtyChange={d => { drawerDirty.current = d; }}
          onClose={() => setEditing(undefined)}
          onSaved={(info) => {
            setEditing(undefined);
            setToast({ text: "Saved to monday", type: "info" });
            void board.finishSave(info).then(() => {
              if (board.syncingRef?.current?.[info.itemId] === "error") { /* badge shows Retry */ }
            });
          }} />
      )}
```
Simplify — drop the `.then` inspection (the badge reflects status directly). Final:
```tsx
      {editing !== undefined && (
        <DealDrawer key={editing ?? "new"} itemId={editing} board={board}
          onDirtyChange={d => { drawerDirty.current = d; }}
          onClose={() => setEditing(undefined)}
          onSaved={(info) => {
            setEditing(undefined);
            setToast({ text: "Saved to monday", type: "info" });
            void board.finishSave(info);
          }} />
      )}
```

- [ ] **Step 5: Render the toast with its type class**

Change:
```tsx
      {toast && <div className="dc-toast" onClick={() => setToast(null)}>✓ {toast}</div>}
```
to:
```tsx
      {toast && (
        <div className={"dc-toast dc-toast-" + toast.type} onClick={() => setToast(null)}>
          {toast.type === "error" ? "⚠ " : toast.type === "info" ? "" : "✓ "}{toast.text}
        </div>
      )}
```

- [ ] **Step 6: Add the per-row sync badge**

In the actions cell of each row — currently:
```tsx
                      <td className="dc-mut">{fmtCreated(r.createdAt)}</td>
                      <td className="r">
                        {r.hubspotId && <button className="dc-btn dc-btn-sm" title="Open in HubSpot" style={{ marginRight: 6 }} onClick={e => { e.stopPropagation(); openLink(hubspotDealUrl(r.hubspotId!)); }}>↗ HubSpot</button>}
                        <span className="dc-open dc-btn dc-btn-sm">Open →</span>
                      </td>
```
insert the badge before the HubSpot button:
```tsx
                      <td className="dc-mut">{fmtCreated(r.createdAt)}</td>
                      <td className="r">
                        {board.syncing[r.id] === "syncing" && <span className="dc-syncbadge syncing" style={{ marginRight: 6 }}>⟳ Syncing…</span>}
                        {board.syncing[r.id] === "synced" && <span className="dc-syncbadge synced" style={{ marginRight: 6 }}>✓ Synced</span>}
                        {board.syncing[r.id] === "error" && (
                          <button className="dc-syncbadge error" style={{ marginRight: 6 }}
                            onClick={e => { e.stopPropagation(); void board.finishSave({ itemId: r.id, isEdit: true, clearProps: [] }); }}>
                            ⚠ Retry
                          </button>
                        )}
                        {r.hubspotId && <button className="dc-btn dc-btn-sm" title="Open in HubSpot" style={{ marginRight: 6 }} onClick={e => { e.stopPropagation(); openLink(hubspotDealUrl(r.hubspotId!)); }}>↗ HubSpot</button>}
                        <span className="dc-open dc-btn dc-btn-sm">Open →</span>
                      </td>
```

- [ ] **Step 7: Typecheck + tests + build**

Run: `cd monday-app && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc exit 0; all tests pass (74 + 7 new = 81); build succeeds.

- [ ] **Step 8: Commit**

```bash
git add monday-app/src/views/BoardView.tsx
git commit -m "feat(monday-app): instant Saved-to-monday toast + background finishSave + per-row sync badge"
```

---

## Task 7: `BoardView` — skeleton loading, empty-state CTA, name tooltips

**Files:**
- Modify: `monday-app/src/views/BoardView.tsx`

- [ ] **Step 1: Replace the full-screen loading return with skeleton rows**

Change:
```tsx
  if (board.loading)
    return <div className="dc-wrap"><div className="dc-loading"><div className="dc-spinner" />Loading deals…</div></div>;
```
to:
```tsx
  if (board.loading)
    return (
      <div className="dc-wrap">
        <div className="dc-header"><h1 className="dc-title">Deals</h1></div>
        <div className="dc-panel"><div className="dc-table-scroll">
          <table className="dc-table"><tbody>
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i}><td colSpan={9}><div className="dc-skeleton" /></td></tr>
            ))}
          </tbody></table>
        </div></div>
      </div>
    );
```

- [ ] **Step 2: Empty-state CTA when there are no deals and no active filters**

Add a `filtersActive` value near the `rows` memo:
```ts
  const filtersActive = !!(q || stage || mine || salesUser);
```
Change the empty cell:
```tsx
                {rows.length === 0
                  ? <tr><td colSpan={9}><div className="dc-empty">No deals match your filters.</div></td></tr>
```
to:
```tsx
                {rows.length === 0
                  ? <tr><td colSpan={9}>
                      {filtersActive
                        ? <div className="dc-empty">No deals match your filters.</div>
                        : <div className="dc-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <span style={{ fontSize: 15 }}>No deals yet.</span>
                            <button className="dc-btn dc-btn-primary" onClick={() => attemptOpen(null)}>＋ Create your first deal</button>
                          </div>}
                    </td></tr>
```

- [ ] **Step 3: Tooltips on truncated names**

- Deal name cell: change `<span className="dc-deal-name">{r.name}</span>` to
  `<span className="dc-deal-name" title={r.name}>{r.name}</span>`.
- Company cell: add `title={r.company || ""}` to its `<td>`.
- Contact cell: add `title={r.contact || ""}` to its `<td>`.

- [ ] **Step 4: Typecheck + build**

Run: `cd monday-app && npx tsc --noEmit && npm run build`
Expected: exit 0; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/views/BoardView.tsx
git commit -m "feat(monday-app): skeleton loading, empty-state CTA, name tooltips"
```

---

## Task 8: `KanbanView` — targeted row update instead of full reload

**Files:**
- Modify: `monday-app/src/views/KanbanView.tsx`

- [ ] **Step 1: Swap `reload` for `patchRow` after a drag**

Change:
```ts
    try { await moveToGroup(id, targetGroup); await board.reload(); }
    catch { onToast("Could not move the deal"); }
```
to:
```ts
    try { await moveToGroup(id, targetGroup); await board.patchRow(id); }
    catch { onToast("Could not move the deal"); }
```

- [ ] **Step 2: Typecheck + build**

Run: `cd monday-app && npx tsc --noEmit && npm run build`
Expected: exit 0; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/views/KanbanView.tsx
git commit -m "fix(monday-app): kanban drag updates just the moved card, no full-board flash"
```

---

## Task 9: Styles — skeleton, sync badge, toast variants

**Files:**
- Modify: `monday-app/src/styles.css`

- [ ] **Step 1: Add the new classes**

Append to `monday-app/src/styles.css`:
```css
/* ---------- skeleton loading ---------- */
.dc-skeleton {
  height: 20px; border-radius: 8px;
  background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-hover) 37%, var(--surface-2) 63%);
  background-size: 400% 100%; animation: dcshimmer 1.3s ease-in-out infinite;
}
@keyframes dcshimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }

/* ---------- per-row sync badge ---------- */
.dc-syncbadge {
  display: inline-block; padding: 3px 9px; border-radius: 20px; font-size: 11.5px; font-weight: 700;
  white-space: nowrap; border: none; font-family: inherit;
}
.dc-syncbadge.syncing { background: var(--accent-soft); color: var(--accent); }
.dc-syncbadge.synced  { background: var(--green-soft); color: var(--green); animation: dcfade .2s ease; }
.dc-syncbadge.error   { background: var(--red-soft); color: var(--red); cursor: pointer; }
.dc-syncbadge.error:hover { filter: brightness(1.05); }

/* ---------- toast variants ---------- */
.dc-toast-info  { background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
.dc-toast-error { background: linear-gradient(135deg, var(--red), #c23350); }
```
(The base `.dc-toast` already sets layout + the green success gradient; `.dc-toast-success` keeps that
default, so no override is needed for success.)

- [ ] **Step 2: Build**

Run: `cd monday-app && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/styles.css
git commit -m "feat(monday-app): skeleton shimmer, sync-badge and toast variant styles"
```

---

## Task 10: Deploy + full regression audit

**Files:** none (verification + deploy).

- [ ] **Step 1: Full automated suite — app**

Run: `cd monday-app && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc exit 0; **81 tests pass** (74 existing + 4 confirmSynced + 3 upsertRow); build succeeds.

- [ ] **Step 2: Full automated suite — worker**

Run: `cd worker && npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; **158 tests pass** (unchanged — no Worker code changed).

- [ ] **Step 3: Deploy the app**

Run (from repo root):
```bash
cd monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist
```
Expected: "Your project is live at …" with a new `source/<id>.zip`. Record the source id.
(No Worker deploy — no Worker changes.)

- [ ] **Step 4: Live read-only probes (non-destructive)**

Using the `.env` `MONDAY_API_TOKEN` (never printed), run one Node script (place in the scratchpad) that
asserts:
- Board `5029480547` and `5029480548` each expose every configured column with the expected type
  (23 total; reuse the audit-cols probe shape).
- Every monday write document validates against the live 2026-07 schema using **ghost ids**
  (`999999999999`), not `@skip` — expect "board does not exist" / "Item not found", never a validation
  error (reuse the validate2 probe shape).
- monday group ↔ HubSpot `dealstage`: 0 drift over all deals (reuse the audit-hs-stage probe;
  needs `HUBSPOT_ACCESS_TOKEN`).

Expected: 23/23 columns OK; all write docs reach execution; 0 stage drift.

- [ ] **Step 5: Live auth-gate probes (curl, non-destructive)**

Run:
```bash
B=https://hubspot-monday-sync.askada.workers.dev
for p in search line-item association deal sync-deal clear-deal-fields; do
  echo -n "$p POST unauthed -> "; curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/app/$p" -H 'Content-Type: application/json' -d '{}'
  echo -n "$p OPTIONS       -> "; curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$B/app/$p"
done
```
Expected: every POST → `403`; every OPTIONS → `204`.

- [ ] **Step 6: Manual checklist (hand to the user, run in the live app after hard-refresh)**

1. Create a deal → drawer closes instantly, "Saved to monday" toast, row appears at top (newest-first),
   badge goes ⟳ Syncing… → ✓ Synced, and the row gains a HubSpot Deal ID.
2. Edit a deal's Amount → no full-board flash; the one row updates; badge confirms.
3. Clear Amount and clear Close date → both empty in monday and (after sync) HubSpot.
4. Empty Sales Users → the deal returns to Unassigned after sync.
5. Add then remove a contact; add a line item with a % discount → reflected in HubSpot.
6. Kanban: drag a card between stages → no full-screen flash.
7. Force a sync error is not required; if any badge shows ⚠ Retry, clicking it re-runs and flips to Synced.

- [ ] **Step 7: Report**

Produce one pass/fail table (inline) covering Steps 1–5 results and note the app source id deployed. Flag
any failure with its cause.

- [ ] **Step 8: Commit (docs/notes only if any code fix was needed during audit)**

If the audit surfaced a fix, commit it with a `fix(monday-app): …` message describing the defect and
verification. Otherwise nothing to commit.

---

## Self-Review

**1. Spec coverage:**
- §2 save/sync flow → Tasks 1 (syncDeal boolean), 4 (patchRow/finishSave/status), 5 (drawer onSaved), 6 (handler + badge). ✓
- §2.3 pure core (`confirmSynced`, `upsertRow`) → Tasks 2, 3, test-first. ✓
- §2.4 shared `rawItemToRow` → Task 4 Step 2–3. ✓
- §2.5 Kanban consistency → Task 8. ✓
- §3 loading/feedback (skeleton, badge, toast variants) → Tasks 6, 7, 9. ✓
- §4 table/drawer polish (tooltips, empty-state CTA, Overview sub-sections) → Tasks 5 (sub-sections), 7 (tooltips, CTA). ✓
- §5 regression audit → Task 10. ✓
- §6 files-touched table → every file has a task. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows real code; commands have expected output. ✓
(One draft `.then` inspection in Task 6 Step 4 was replaced inline with the final simplified handler.)

**3. Type consistency:**
- `SavedInfo { itemId; isEdit; clearProps }` defined in Task 2, used identically in Tasks 4, 5, 6. ✓
- `SyncStatus` from Task 2 used in Task 4's `syncing: Record<string, SyncStatus>`. ✓
- `syncDeal` returns `boolean` (Task 1) consumed by `finishSave` (Task 4). ✓
- `patchRow(itemId): Promise<DealRow | null>` defined in Task 4, called in Tasks 4, 8. ✓
- `board.syncing[r.id]` (Task 6) matches the `syncing` map exposed in Task 4 Step 7. ✓
- `finishSave(info)` signature matches all call sites (drawer→BoardView handler, retry badge). ✓
