# Association Display Cascade + HubSpot Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In the Deal Cockpit app, show a friendly cascaded name for a linked contact/company instead of the raw `contacts <id>` fallback (A), and add a small `↗` on each linked chip to open that record in HubSpot (B).

**Architecture:** App-only. A pure `linkDisplayName` helper (TDD) applied inside the two functions that resolve linked cards to names; a `hubspotRecordUrl` builder and a per-chip `↗` in `AssociationPicker`. No worker/sync/board changes.

**Tech Stack:** React 18 + TS + Vite + vitest. Deploy: cached `mapps`.

**Spec:** `docs/superpowers/specs/2026-07-24-assoc-display-and-links-design.md`

---

## File Structure

| File | Change | Test |
|---|---|---|
| `monday-app/src/lib/link-name.ts` | Create: `linkDisplayName` | `link-name.test.ts` |
| `monday-app/src/board-config.ts` | Add `hubspotRecordUrl` + the two name-cascade column ids | `board-config.test.ts` |
| `monday-app/src/monday-client.ts` | `getItemNames` + `getCardsByIds` fetch 2 extra cols, apply the cascade | tsc |
| `monday-app/src/views/AssociationPicker.tsx` | Per-chip `↗` HubSpot link | tsc + visual |
| `monday-app/src/styles.css` | `.dc-chip-link` style | — |

---

## Task 1: `linkDisplayName` helper (TDD)

**Files:** Create `monday-app/src/lib/link-name.ts` and `monday-app/src/lib/link-name.test.ts`.

- [ ] **Step 1: Write the failing tests**

`monday-app/src/lib/link-name.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { linkDisplayName } from "./link-name";

describe("linkDisplayName", () => {
  it("returns a real firstname unchanged", () =>
    expect(linkDisplayName("Emily", "", "")).toBe("Emily"));
  it("returns a real domain unchanged", () =>
    expect(linkDisplayName("cxmt.com", "", "")).toBe("cxmt.com"));
  it("contact fallback -> lastname", () =>
    expect(linkDisplayName("contacts 1", "Smith", "a@b.co")).toBe("Smith"));
  it("contact fallback, no lastname -> email", () =>
    expect(linkDisplayName("contacts 1", "", "a@b.co")).toBe("a@b.co"));
  it("contact fallback, nothing -> keep the id fallback", () =>
    expect(linkDisplayName("contacts 1", "", "")).toBe("contacts 1"));
  it("company fallback -> company name", () =>
    expect(linkDisplayName("companies 2", "Acme Inc", "Shanghai")).toBe("Acme Inc"));
  it("company fallback, no name -> keep id, NEVER the city", () =>
    expect(linkDisplayName("companies 2", "", "Shanghai")).toBe("companies 2"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd monday-app && npx vitest run src/lib/link-name.test.ts`
Expected: FAIL — cannot import `linkDisplayName` (module doesn't exist).

- [ ] **Step 3: Implement**

`monday-app/src/lib/link-name.ts`:
```ts
// Friendly display name for a linked contact/company card. The worker names a card by its primary field
// (contact firstname / company domain); when that's empty the card name is the fallback `contacts <id>` /
// `companies <id>`. That string encodes the type, so one function cascades correctly for both boards.
//   c1 = text_mm4scke9  (contact: lastname · company: name)
//   c2 = text_mm4p2bvb  (contact: email   · company: city — deliberately NOT used for companies)
const FALLBACK_RE = /^(contacts|companies) \d+$/;

export function linkDisplayName(name: string, c1: string, c2: string): string {
  const m = FALLBACK_RE.exec(name.trim());
  if (!m) return name;                                              // a real firstname / domain
  if (m[1] === "contacts") return c1.trim() || c2.trim() || name;  // lastname -> email -> keep id
  return c1.trim() || name;                                        // company: name -> keep id (never city)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd monday-app && npx vitest run src/lib/link-name.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/link-name.ts monday-app/src/lib/link-name.test.ts
git commit -m "feat(monday-app): linkDisplayName cascade for linked contact/company names"
```

---

## Task 2: `hubspotRecordUrl` + name-cascade column ids

**Files:** Modify `monday-app/src/board-config.ts`; create `monday-app/src/board-config.test.ts`.

- [ ] **Step 1: Write the failing test**

`monday-app/src/board-config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hubspotRecordUrl } from "./board-config";

describe("hubspotRecordUrl", () => {
  it("uses the 0-1 object path for contacts", () =>
    expect(hubspotRecordUrl("contacts", "123")).toBe("https://app.hubspot.com/contacts/39939588/record/0-1/123"));
  it("uses the 0-2 object path for companies", () =>
    expect(hubspotRecordUrl("companies", "456")).toBe("https://app.hubspot.com/contacts/39939588/record/0-2/456"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd monday-app && npx vitest run src/board-config.test.ts`
Expected: FAIL — `hubspotRecordUrl` is not exported.

- [ ] **Step 3: Implement**

In `monday-app/src/board-config.ts`, after the existing `hubspotDealUrl` (around line 7), add:
```ts
// Deep link to a linked contact/company's HubSpot record (0-1 = contacts, 0-2 = companies; deals are 0-3).
const HS_OBJ = { contacts: "0-1", companies: "0-2" } as const;
export const hubspotRecordUrl = (kind: "contacts" | "companies", id: string) =>
  `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/${HS_OBJ[kind]}/${id}`;
```
and near the `CONTACT_ID_COL` / `COMPANY_ID_COL` lines (around line 16), add the name-cascade source columns (same id on both boards):
```ts
// Fallback name-cascade sources (same column id on both boards): contact lastname / company name.
export const LINK_NAME_COL_2 = "text_mm4scke9";
// contact email (this column is 'city' on the company board — linkDisplayName never uses it for companies).
export const LINK_NAME_COL_3 = "text_mm4p2bvb";
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd monday-app && npx vitest run src/board-config.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/board-config.ts monday-app/src/board-config.test.ts
git commit -m "feat(monday-app): hubspotRecordUrl + name-cascade column ids"
```

---

## Task 3: Apply the cascade in `getItemNames` + `getCardsByIds`

**Files:** Modify `monday-app/src/monday-client.ts`.

No unit test (monday-SDK I/O). Verified by `tsc` + the tested `linkDisplayName`. **Note:** `getCardsByIds` currently reads the HubSpot id by array index `[0]` (safe only with a single column) — this task switches both to lookup-by-column-id, which is required once we fetch three columns.

- [ ] **Step 1: Add the import**

At the top of `monday-app/src/monday-client.ts`, extend the `board-config` import to include the two column ids, and add the helper import:
```ts
import {
  DEALS_BOARD, SUBITEMS_BOARD, LINK_NAME_COL_2, LINK_NAME_COL_3,
} from "./board-config";
import { linkDisplayName } from "./lib/link-name";
```
(Keep `apiErrorDetail`/`apiErrorMessage` and any other existing imports as they are.)

- [ ] **Step 2: Rewrite `getItemNames`**

Replace:
```ts
/** Resolve monday item ids -> { id: name } (batched) for showing linked company/contact names. */
export async function getItemNames(itemIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    const d: any = await api(`query ($ids:[ID!]) { items(ids:$ids, limit:${ID_CHUNK}) { id name } }`, { ids: chunk });
    for (const it of d.items ?? []) out[String(it.id)] = it.name;
  }
  return out;
}
```
with:
```ts
/** Resolve monday item ids -> { id: displayName } for showing linked company/contact names. Applies the
 * fallback cascade (firstname->lastname->email / domain->name) so an empty primary field never shows the
 * raw `contacts <id>` fallback. */
export async function getItemNames(itemIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    const d: any = await api(`query ($ids:[ID!]) { items(ids:$ids, limit:${ID_CHUNK}) {
      id name column_values(ids:["${LINK_NAME_COL_2}","${LINK_NAME_COL_3}"]) { id text } } }`, { ids: chunk });
    for (const it of d.items ?? []) {
      const col = (id: string) => it.column_values?.find((c: any) => c.id === id)?.text ?? "";
      out[String(it.id)] = linkDisplayName(it.name, col(LINK_NAME_COL_2), col(LINK_NAME_COL_3));
    }
  }
  return out;
}
```

- [ ] **Step 3: Rewrite the body of `getCardsByIds`**

Replace:
```ts
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {   // same 25-row cap as getItemNames
    const d: any = await api(`query ($ids:[ID!], $cols:[String!]) {
      items(ids:$ids, limit:${ID_CHUNK}) { id name column_values(ids:$cols) { id text } } }`,
      { ids: itemIds.slice(i, i + ID_CHUNK), cols: [idCol] });
    for (const it of d.items ?? [])
      out.push({ itemId: String(it.id), name: it.name, hubspotId: it.column_values?.[0]?.text ?? "" });
  }
```
with:
```ts
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {   // same 25-row cap as getItemNames
    const d: any = await api(`query ($ids:[ID!], $cols:[String!]) {
      items(ids:$ids, limit:${ID_CHUNK}) { id name column_values(ids:$cols) { id text } } }`,
      { ids: itemIds.slice(i, i + ID_CHUNK), cols: [idCol, LINK_NAME_COL_2, LINK_NAME_COL_3] });
    for (const it of d.items ?? []) {
      const col = (id: string) => it.column_values?.find((c: any) => c.id === id)?.text ?? "";
      out.push({
        itemId: String(it.id),
        name: linkDisplayName(it.name, col(LINK_NAME_COL_2), col(LINK_NAME_COL_3)),
        hubspotId: col(idCol),
      });
    }
  }
```

- [ ] **Step 4: Typecheck + app tests**

Run: `cd monday-app && ./node_modules/.bin/tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/monday-client.ts
git commit -m "feat(monday-app): show cascaded linked-record names in board columns and chips"
```

---

## Task 4: Per-chip `↗` HubSpot link in `AssociationPicker`

**Files:** Modify `monday-app/src/views/AssociationPicker.tsx` and `monday-app/src/styles.css`.

- [ ] **Step 1: Add imports**

At the top of `monday-app/src/views/AssociationPicker.tsx`, add:
```ts
import { openLink } from "../monday-client";
import { hubspotRecordUrl } from "../board-config";
```

- [ ] **Step 2: Add the `↗` to each chip**

Replace:
```tsx
          {value.map((a, i) => (
            <span key={a.itemId || a.hubspotId || i} className="dc-chip">{a.label}
              <button onClick={() => remove(a)} aria-label="Remove">×</button>
            </span>
          ))}
```
with:
```tsx
          {value.map((a, i) => (
            <span key={a.itemId || a.hubspotId || i} className="dc-chip">{a.label}
              {a.hubspotId && (
                <button type="button" className="dc-chip-link" title="Open in HubSpot" aria-label="Open in HubSpot"
                  onClick={() => openLink(hubspotRecordUrl(kind, a.hubspotId!))}>↗</button>
              )}
              <button onClick={() => remove(a)} aria-label="Remove">×</button>
            </span>
          ))}
```
(`kind` is the picker's existing prop, `"contacts" | "companies"` — exactly what `hubspotRecordUrl` expects.)

- [ ] **Step 3: Add the chip-link style**

In `monday-app/src/styles.css`, after the `.dc-chip button` rules (~line 203), add:
```css
.dc-chip-link { background: transparent !important; font-size: 13px !important; text-decoration: none; }
.dc-chip-link:hover { background: rgba(0,0,0,.10) !important; }
[data-theme="dark"] .dc-chip-link:hover { background: rgba(255,255,255,.18) !important; }
```

- [ ] **Step 4: Typecheck + build**

Run: `cd monday-app && ./node_modules/.bin/tsc --noEmit && npx vite build`
Expected: tsc clean; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/views/AssociationPicker.tsx monday-app/src/styles.css
git commit -m "feat(monday-app): open a linked contact/company in HubSpot from its chip"
```

---

## Task 5: Green gate + deploy

- [ ] **Step 1: Full green gate**

Run: `cd monday-app && ./node_modules/.bin/tsc --noEmit && npx vitest run && npx vite build`
Expected: tsc clean; all tests pass (existing + 7 link-name + 2 board-config); build succeeds.

- [ ] **Step 2: Deploy**

Run: `cd monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/e144775468857254/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`
Expected: "Your project is live at …".

- [ ] **Step 3: Verify in the app**

1. A deal linked to a contact with no first name shows the **last name** (or email) in the Contact column and chip — not `contacts <id>`.
2. A company with no domain shows its **name** — not `companies <id>`.
3. Each linked contact/company chip has a `↗`; clicking it opens that record in HubSpot (contacts `0-1`, companies `0-2`).
4. A staged **"+ New"** record (not yet created) shows **no** `↗`.

---

## Self-Review

**Spec coverage:** A (cascade) → Tasks 1 + 3 (+ col ids in Task 2); B (HubSpot links) → Tasks 2 (`hubspotRecordUrl`) + 4. Search confirmed already-correct (no task). ✅

**Placeholder scan:** every code step shows complete code; every run step has an exact command + expected result. ✅

**Type consistency:** `linkDisplayName(name, c1, c2)` signature matches across Task 1 (def), Task 3 (use); `hubspotRecordUrl("contacts"|"companies", id)` matches Task 2 (def) and Task 4 (use, passing the picker's `kind`); `LINK_NAME_COL_2/3` defined in Task 2, imported in Task 3. `getCardsByIds` switches from index `[0]` to `col(idCol)` — required now that three columns are fetched. ✅

## Rollback

Each task is its own commit — `git revert` any independently. App-only; nothing else to undo.
