# Deal Form Field Cardinality — Design

**Date:** 2026-07-24
**Status:** approved for implementation

## Problem

The Deal Cockpit's deal form renders **Sales Users** as a multi-value chip picker, but HubSpot's
`deals.sales_user` is a single-select and can only ever hold one value. The form invites a choice the
sync cannot honour: the reverse-sync takes only `firstPersonOwnerId`, so a rep who picks two people
sees two in monday while HubSpot silently keeps one, with no warning.

**Vendors is NOT part of this problem** — see Verified Facts.

## Verified facts (measured against the live systems, deals only)

| Field | HubSpot property | Schema | HubSpot data | monday data |
|---|---|---|---|---|
| Vendors | `vendorschang_shang_lai_yuan` | `enumeration` / **`checkbox`** → MULTI, 83 options | 100 deals sampled | 253 of 616 cards set; 1 card holds 2 |
| Sales Users | `sales_user` | `enumeration` / **`select`** → SINGLE, 0 options | 100 deals sampled, **0** hold >1 | 540 of 616 hold exactly 1; **0 hold 2+**; 76 empty |

monday columns permit multi on both (`dropdown_mm4n4f7r` has no `limit_select`;
`multiple_person_mm532m82` has no `max_people_allowed`).

**Vendors verified working end-to-end.** monday card `2777680986` holds `"2Minitab, 1Tableau"` and
HubSpot deal `333514603213` holds `"2Minitab;1Tableau"` — two values on both sides, including the
comma→semicolon conversion in `reverseFieldValue`. No change required.

**No existing data is broken.** Zero of 616 deal cards hold 2+ sales users. This change is purely
preventive; there is no migration, no normalisation, and no "existing multi-value" case to warn about.

## Scope boundary

These cardinalities are verified for **deals only** and must not be extrapolated. Confirmed separately:

- `contacts.sales_user` and `companies.sales_user` are also SINGLE, but neither the Contact nor the
  Company form exposes the field (the Worker sets it from the acting rep), so nothing to change.
- **`contacts.manufacturer__c` ("Vendor" on the Contact form) is `checkbox` → MULTI with 86 options,
  but `record-form.ts` renders it as a single-select `enum`.** This is the same class of defect,
  mirrored, on a different form. **Explicitly out of scope** — recorded here so it is not lost.

## Design

Change one field in `monday-app/src/views/DealDrawer.tsx`: render **Sales Users** with `SelectOpt`
— the component "Deal owner" already uses one line below — instead of `ChipMulti`.

```tsx
<Field label="Sales User">
  <SelectOpt options={userOpts} value={form.salesUserIds?.[0]}
    onChange={v => set({ salesUserIds: v ? [v] : [] })} placeholder="No sales user" />
</Field>
```

**`DealForm.salesUserIds` stays `string[]`, holding 0 or 1 entry.** This is the deliberate choice:
`dealFormToColumnValues` (`peopleValue`) and `deliberateClears` both operate on the array and keep
working untouched, so emptying the picker still yields `[]` and still clears `sales_user` in HubSpot.
Refactoring to a scalar would ripple into `lib/columns.ts`, `useBoard.ts` and their tests for no
user-visible gain.

The label changes from plural "Sales Users" to singular "Sales User" so the form states the
constraint rather than implying the opposite. The monday column keeps its own title.

### Rejected alternatives

- **Cap `ChipMulti` with a `max=1` prop.** A chip picker limited to one is a confusing affordance and
  retains the "this holds many" look the change exists to remove.
- **Refactor `DealForm` to a scalar `salesUserId`.** Cleanest model, but touches four files and their
  tests to produce identical behaviour.
- **Cap the monday column at `max_people_allowed: 1`.** Rejected on evidence: 0 of 616 cards violate
  the rule, so reps are not creating this from the board; only the app invites it. Capping would
  change behaviour for people working directly in monday to defend against a zero-incident path, and
  the sync already resolves a stray second person deterministically (first wins). Remains available
  as a monday column setting if a hard stop is ever wanted.

## Testing

`monday-app/src/lib/columns.test.ts` already covers the array contract this change depends on, and
those tests must keep passing unchanged:

- `deliberateClears(loaded, { ...salesUserIds: [] })` → `salesUsers: true` (line 11) — the clear path.
  `SelectOpt` emits `undefined` for its placeholder, which the handler maps to `[]`, so choosing
  "No sales user" still produces exactly this input. **Verified against `SelectOpt`'s implementation:
  `onChange(e.target.value || undefined)`.**
- `dealFormToColumnValues({...salesUserIds: []})` → `{}` (line 38) — an untouched empty field is
  omitted rather than blanking the column.

**One test is genuinely missing and must be added** — the positive case, which locks in that the
single-select's `[v]` output still writes the people column correctly:

```ts
it("writes a single sales user to the people column", () =>
  expect(dealFormToColumnValues({ salesUserIds: ["111"] }))
    .toEqual({ multiple_person_mm532m82: peopleValue(["111"]) }));
```

The component swap itself is verified by `tsc` plus a manual check of the form, consistent with how
the rest of the drawer is covered (there is no DOM test stack in this app: `vitest.config.ts` uses
`environment: "node"` and includes only `src/**/*.test.ts`).

## Non-goals

- Any change to Vendors, on any form.
- Any change to the monday board columns or their settings.
- Any data migration or cleanup (nothing is broken).
- The `contacts.manufacturer__c` cardinality mismatch (flagged above).
