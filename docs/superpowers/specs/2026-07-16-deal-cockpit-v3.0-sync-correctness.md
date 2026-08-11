# Deal Cockpit v3.0 — Sync correctness (Amount / Currency / Close date)

**Date:** 2026-07-16
**Status:** Approved design (pending user spec review)

## Context

Sales reps use the Deal Cockpit app as their only interface. But three core deal fields they can type into
the app — **Amount, Currency, Close date** — **never reach HubSpot**.

Verified: in `worker/src/config.ts:113-115` those fields have no `reverse: true`, and both monday→HubSpot
write paths in `worker/src/reconcile.ts` start with `if (!f.reverse) continue`
(`buildCreateProperties`, `buildReversePatch`). So a deal created in the app sends its name, stage (via the
group), owner, sales user, type, priority and vendors — but not the amount, currency or close date. Editing
them later doesn't push either. They survive in monday only because the forward pass skips empty HubSpot
values (`hsText === "" → continue`), so nothing overwrites them; they just silently never arrive.

This is a correctness hole in the sole-interface goal and is fixed **before** any further UX work. It is the
first of four rounds (v3.1 drawer/editing, v3.2 quick actions/KPIs/saved views, v3.3 scale).

## Decisions (confirmed)

- **Fix the sync first**, ahead of the UI rounds.
- **Pipeline stays forward-only.** DKM uses a single "Sales Pipeline", and changing pipeline in HubSpot
  without a matching stage can leave a deal broken. Consequence: the Pipeline **dropdown is removed from the
  app form** (a control that cannot sync is misleading). The create default still stamps the column, and the
  Worker's `createDefaults: { pipeline: "default" }` sets it in HubSpot.
- **Deal Stage keeps reversing via the monday group** (unchanged) — the status column stays forward-only
  display. Not part of this round.

## Controlled backfill (added after review)

`fieldDiffs` skips any field whose HubSpot value is empty (`reconcile.ts:41`, "don't fight monday"). That
also means a monday value can never *fill* an empty HubSpot field — so the `reverse: true` flags alone only
help **new** deals (the unconditional `buildCreateProperties` path) and edits to fields HubSpot already has.
Every existing deal with a blank HubSpot amount would stay stranded. A **controlled, deals-only backfill**
closes that, under strict rules:

Fill HubSpot from monday **only** when **all** hold:
1. the HubSpot value is empty, **and**
2. the monday value is non-empty, **and**
3. the monday item carries a valid **HubSpot Deal ID matching the record** (id match only — never by name), **and**
4. the field is on an explicit **backfill allowlist**.

- **Allowlisted now:** `amount`, `closedate`.
- **Deliberately NOT backfilled:** `deal_currency_code`, `sales_user`, `hubspot_owner_id`,
  `vendorschang_shang_lai_yuan`, `hs_priority`, `dealtype`. (They still reverse on edit — they just never
  auto-fill an empty HubSpot value.) More deal fields can be approved later, once amount + close date are verified.
- **Deals only** — never Contacts or Companies (enforced by both the allowlist and an explicit
  `spec.object === "deals"` guard).
- **Never clears HubSpot** because monday is empty (the rule requires a non-empty monday value).
- **Idempotent** — once HubSpot holds the value it is no longer empty, so the normal diff path takes over;
  records already matching produce no diff and no write.
- **Logged** per backfill: HubSpot Deal ID, monday item id, field, previous HubSpot value (empty), the value
  written, and the result. Logged at the write site (`sync.ts`, after `patchRecord`) so the result is real.
  A failed patch surfaces through the existing per-record error log.

## Why this is small (not a normalization project)

`expectedText` (`worker/src/mapping.ts:55-67`) **already** normalizes both directions of comparison — it was
written for exactly this loop risk (see its comment):
- **numbers:** `Number(v) → String(n)`, so HubSpot `5000.00` compares equal to monday `5000` → no phantom diff.
- **date:** `v.slice(0, 10)` → `2026-07-31`, matching monday's date-column text.
- **status:** dictionary lookup + trim; `deal_currency_code` has no label dict, so `USD → USD`.

And `reverseFieldValue` passes those values straight through (`rev[text] ?? text`), producing valid HubSpot
input. So the change is the three flags plus tests.

## Changes

1. **`worker/src/config.ts`** — add `reverse: true` to the three DEALS fields:
   - `{ hs: "amount", col: "numeric_mm531t6e", type: "numbers" }`
   - `{ hs: "deal_currency_code", col: "color_mm53vk99", type: "status" }`
   - `{ hs: "closedate", col: "date_mm53ecz3", type: "date" }`
   This makes them flow through the existing `buildReversePatch` (edits) and `buildCreateProperties`
   (monday-created deals) paths. No new code paths.

2. **`monday-app/src/views/DealModal.tsx`** — remove the **Pipeline** `<Field>` from the form JSX. Keep the
   `pipeline` default in the form's initial state (so the monday column is still stamped on create) and keep
   `dealFormToColumnValues`'s pipeline mapping unchanged.

3. **`monday-app/src/views/LineItemsEditor.tsx`** (v2.1 leftover) — `remove()` currently awaits the monday
   `deleteItem(li.subitemId)` outside any try/catch, so a failure becomes an unhandled rejection with no user
   feedback. Wrap it and route the failure to `onError`.

## Round-trip behaviour (why it converges)

- **Amount:** app writes `5000` → HubSpot stores `5000.00` → `expectedText` → `5000` → equals monday → no diff.
- **Close date:** app writes `2026-07-31` → HubSpot stores midnight UTC, returns ISO → sliced to
  `2026-07-31` → equals monday → no diff.
- **Currency:** `USD → USD` both ways.
- **Conflicts** follow the existing `decideDirection` rule (HubSpot changed since last sync → HubSpot wins;
  otherwise the monday edit wins) — unchanged, same as every other reversible field.

## Known HubSpot-side behaviour (verify live, not a bug in our sync)

- **Amount vs line-item roll-up:** if the portal calculates deal Amount from line items, HubSpot may
  recalculate over a typed Amount. That converges (HubSpot's recalc bumps `hs_lastmodifieddate`, so the next
  pass pulls it back to monday) — it is HubSpot's behaviour, not a loop. Confirm during the live test.
- **`deal_currency_code` writability** requires multi-currency (DKM has USD + CNY deals, so it is on).

## Testing

- **Worker unit (vitest), in `worker/test/reconcile.test.ts`:**
  - No phantom diff: HubSpot `amount: "5000.00"` vs monday column text `5000` → `fieldDiffs` returns no
    amount diff (guards the loop risk).
  - A monday-side edit of amount / closedate / currency produces a `buildReversePatch` containing
    `{ amount, closedate, deal_currency_code }`.
  - `buildCreateProperties` for a monday-created deal includes amount, closedate and currency.
  - Close-date normalization: HubSpot `2026-07-31T00:00:00Z` vs monday `2026-07-31` → no diff.
  - The existing 135 worker tests stay green (no regression to forward sync).
- **Live:** create a deal in the app with an amount, currency and close date → all three appear on the
  HubSpot deal within ~30s. Edit the amount in the app → HubSpot updates. Watch whether a line-item roll-up
  overrides the typed amount. Confirm the Pipeline field is gone from the form and new deals still land in
  the Sales Pipeline.

## Files

`worker/src/config.ts`, `worker/test/reconcile.test.ts`, `monday-app/src/views/DealModal.tsx`,
`monday-app/src/views/LineItemsEditor.tsx`.

## Out of scope (later rounds)

v3.1 drawer + progressive create form + picker (debounce/spinner/cancel/keyboard/duplicate warning) +
quotation-style line items with amount-or-% discount. v3.2 inline quick actions + Kanban group&badge + KPIs
following the filter + saved views + sync-status badges. v3.3 scale (virtualization, caching, targeted
refresh). Dropped: follow-up date, overdue view, separate Activity tab ("Activity" = the Updates feed).
