# Reverse-sync the Sales Users person → HubSpot `sales_user` — Design

**Date:** 2026-07-10
**Status:** Approved

## Goal

Assigning a person to the **Sales Users** people column in monday writes `sales_user` back to HubSpot, so
the record becomes assigned. For deals this makes the card move out of the **Unassigned Deals** group into
its Deal Stage group automatically (and clears the Shared/all-members team). Applies to Deal, Company, and
Contact boards.

## Context

- monday → HubSpot **creation already works** (verified live: a monday-created deal produced a HubSpot deal
  with `pipeline: default`, `dealstage` from its group). The gap is that people columns are **one-directional**
  (forward only), so a monday-created or monday-assigned record lands in HubSpot with `sales_user: null`.
- People columns are deliberately excluded from the text diff (`expectedText` returns null) to avoid phantom
  loops; today the only people write is the forward "fill an empty people column" heal in `fieldDiffs`.
- Sales Users columns: Deal `multiple_person_mm532m82`, Company `multiple_person_mm54phd7`, Contact
  `multiple_person_mm542gng` — all map to HubSpot `sales_user`.

## Confirmed decisions

1. Assigning Sales Users in monday sets **`sales_user` only** (not `hubspot_owner_id`).
2. Sales Users is treated as **effectively single**: if multiple are assigned, the **first** person wins.
3. Applies to **all three** boards (Deal, Company, Contact).
4. **Set-only**: clearing the Sales Users column in monday does **not** clear HubSpot `sales_user` (avoids
   accidental un-assignment). Un-assign in HubSpot if needed.
5. A monday person with **no matching HubSpot owner** (email mismatch) is skipped + logged.

## Architecture

### 1. Reverse identity maps (in `ctx`)

Build two reverse lookups in `buildCtx`:
- `mondayEmailByUserId`: monday user-id → email (invert `getUsersByEmail`, which is email → id).
- `ownerIdByEmail`: email → HubSpot owner-id (from `ownersById`, which is owner-id → {name,email}).

Helper `mondayPersonToOwnerId(ctx, personId)` = `ownerIdByEmail[ mondayEmailByUserId[personId] ]` (or null).

### 2. Read the assigned person id

The generic `MondayItem.column_values` only carries `{id, text}` (text = names, not ids). Extend the item
fetch (`ITEM_FIELDS`, and the board/subitem/webhook fetches that use it) to include the people typed value:

```graphql
column_values { id text ... on PeopleValue { persons_and_teams { id kind } } }
```

Add `persons_and_teams?: { id: string; kind: string }[]` to the column-value shape, and a helper
`firstPersonId(item, col)` returning the first `kind === "person"` id (or null).

### 3. Reverse rule (reuse the existing diff → direction → patch flow)

- Mark the Sales Users field **`reverse: true`** on all three specs.
- In `fieldDiffs`, for a **reversible people** field: compute `wantOwner = mondayPersonToOwnerId(firstPersonId(item,col))`.
  If `wantOwner` is non-null AND differs from the HubSpot value (`rec.properties[hs]`), push a diff carrying
  the monday-derived owner id (e.g. `mdText = wantOwner`, `hsText = rec value`). Do **not** push a diff when
  the column is empty (set-only) or the person doesn't map (skip).
- `decideDirection` is unchanged: a monday edit (HubSpot unchanged since last sync) → `toHubspot`.
- `reverseFieldValue` for a **people** field returns the monday-derived owner id directly (the diff already
  holds it), so `buildReversePatch` emits `{ sales_user: <owner-id> }`.
- Forward (HubSpot → monday) people behaviour is unchanged: still the empty-fill heal, still no text diff.

### 4. Group move is automatic

Once `sales_user` is patched in HubSpot, the record's `hs_lastmodifieddate` bumps → the next forward tick
recomputes `targetGroup` → the deal moves out of Unassigned into its Deal Stage group, and `maintainShared`
clears the all-members team. No special move code.

### 5. Loop safety

After the reverse write, the monday person maps to the HubSpot owner, so `wantOwner == rec value` → no diff,
no further writes. People are never text-diffed forward, so the forward fill can't fight the reverse.

## Testing

- **Unit** (`reconcile.test.ts` / `mapping.test.ts`): `fieldDiffs` emits a reversible people diff when the
  monday first-person maps to a different owner; emits nothing when empty (set-only) or unmapped;
  `buildReversePatch` produces `{ sales_user: <owner> }`; `mondayPersonToOwnerId` mapping.
- **Live**: (a) assign a Sales User to an Unassigned deal in monday → within seconds HubSpot `sales_user` is
  set and the card moves to its Deal Stage group (Shared cleared); (b) create a deal in monday with a Sales
  User → HubSpot deal carries `sales_user`; (c) company + contact: assigning Sales Users writes `sales_user`.

## Out of scope

- Reversing `hubspot_owner_id` / Deal Owner (kept forward-only).
- Clearing HubSpot `sales_user` when the monday column is emptied (set-only by decision #4).
