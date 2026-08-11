# Deal Form Field Cardinality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the deal form's Sales Users field single-select, matching HubSpot's
`deals.sales_user` (`fieldType: select`). Vendors is already correct and is not touched.

**Architecture:** A component swap in one field of `DealDrawer.tsx` (`ChipMulti` → `SelectOpt`),
keeping `DealForm.salesUserIds` as `string[]` holding 0 or 1 entry so `dealFormToColumnValues` and
`deliberateClears` keep working untouched. Plus one new test covering the write path.

**Tech Stack:** React 18 + TypeScript + Vite + vitest; `mapps code:push` to deploy.

**Spec:** `docs/superpowers/specs/2026-07-24-deal-form-field-cardinality-design.md`

---

## File Structure

| File | Change |
|---|---|
| `monday-app/src/lib/columns.test.ts` | Add the missing positive-case test |
| `monday-app/src/views/DealDrawer.tsx` | Swap the Sales Users field to `SelectOpt` |

No worker change. No board/column change. No data migration (0 of 616 cards hold 2+ sales users).

---

### Task 1: Lock the write path with a test

**Files:** Modify `monday-app/src/lib/columns.test.ts`

Existing tests already cover clearing (line 11) and omission (line 38). The positive case — a form
holding exactly one sales user — is untested, and it is precisely what the new single-select emits.

- [ ] **Step 1: Add the test**

Add inside the existing `describe("dealFormToColumnValues — clearing", ...)` block, or as its own
`describe`:

```ts
it("writes a single sales user to the people column", () =>
  expect(dealFormToColumnValues({ salesUserIds: ["111"] }))
    .toEqual({ multiple_person_mm532m82: peopleValue(["111"]) }));
```

`peopleValue` is already imported at the top of the file (line 4), so no import change is needed.

- [ ] **Step 2: Run it**

Run: `cd monday-app && npx vitest run src/lib/columns.test.ts`
Expected: PASS. This test describes existing behaviour — it is a regression guard for the swap that
follows, not a red-then-green cycle. If it FAILS, stop: the array contract is not what the design
assumed and the swap is unsafe.

---

### Task 2: Swap Sales Users to a single-select

**Files:** Modify `monday-app/src/views/DealDrawer.tsx` (the `Field label="Sales Users"` block,
around line 330)

- [ ] **Step 1: Replace the field**

Replace:

```tsx
              <Field label="Sales Users">
                <ChipMulti options={userOpts} values={form.salesUserIds ?? []} onChange={v => set({ salesUserIds: v })} placeholder="Add sales user…" />
              </Field>
```

with:

```tsx
              {/* HubSpot's deals.sales_user is a single-select, and the reverse-sync only ever sends
                  the first person — a multi picker here promises what the sync cannot store. Kept as
                  a 0-or-1 array so dealFormToColumnValues / deliberateClears work unchanged. */}
              <Field label="Sales User">
                <SelectOpt options={userOpts} value={form.salesUserIds?.[0]}
                  onChange={v => set({ salesUserIds: v ? [v] : [] })} placeholder="No sales user" />
              </Field>
```

`SelectOpt` is already imported in this file (it is used by "Deal owner" a few lines below), so the
import line needs no change.

- [ ] **Step 2: Check whether `ChipMulti` is still used**

Run: `cd monday-app && grep -n "ChipMulti" src/views/DealDrawer.tsx`
Expected: **exactly two hits** — the import line (line 17) and the **Vendors** field. Vendors stays
multi, so the import must stay.

If only the import line remains, remove `ChipMulti` from it: this app's tsconfig has
`noUnusedLocals` enabled, so an unused import fails the build.

- [ ] **Step 3: Green gate**

Run: `cd monday-app && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass (130 existing + 1 new = 131).

- [ ] **Step 4: Build**

Run: `cd monday-app && npx vite build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src
git commit -m "fix(monday-app): Sales User is a single-select, matching HubSpot"
```

---

### Task 3: Deploy and verify

- [ ] **Step 1: Deploy**

The `mapps` CLI is not installable from npm (the published package 404s); use the cached npx copy:

```bash
cd monday-app
"/c/Users/PC/AppData/Local/npm-cache/_npx/e144775468857254/node_modules/.bin/mapps" \
  code:push -c -i 16011075 -f -d ./dist
```

- [ ] **Step 2: Verify in the app**

In the deal form, confirm:
1. **Sales User** is a single dropdown with a "No sales user" option — picking a second person
   replaces the first rather than adding a chip.
2. **Vendors** still allows several chips (unchanged).
3. Creating a deal defaults Sales User to the logged-in rep, as before.
4. Opening an existing deal with one sales user shows that person selected.
5. Setting Sales User to "No sales user" on a deal that had one, then saving, clears it in HubSpot
   (this is the `deliberateClears` path the tests cover).

---

## Rollback

`git revert` + redeploy. No data was migrated and no board settings were changed, so there is
nothing else to undo.

## Out of scope (recorded, not actioned)

`contacts.manufacturer__c` ("Vendor" on the Contact form) is `checkbox` → MULTI with 86 options but
is rendered as a single-select `enum` in `record-form.ts` — the same defect mirrored on a different
form. Deliberately excluded: this work is scoped to deals.
