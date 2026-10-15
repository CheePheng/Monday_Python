# Deal Cockpit — Editable Companies + Association Fresh-on-Open (design)

**Date:** 2026-08-03
**Status:** Design approved; ready for implementation plan.

## Context

The Companies tab's `CompanyDrawer` is read-only (browse + create-deal). Reps need to **edit a
company** (fields + its contact/deal associations), with everything **connected to HubSpot** (the
source of truth). Separately, a real bug: opening a deal for edit shows only **1** contact when the
deal has ~10 — and worse, saving then **overwrites** the deal's monday contact-relation column with
that under-loaded set, silently dropping the rest from the board.

Two enabling facts from the code:
- **`syncMondayItem(env, boardId, itemId, …)` is generic** — for any configured board it reconciles the
  monday item's `reverse` fields to HubSpot and runs `reverseAssociations` (monday relation links →
  HubSpot associations, additive/set-only). So company reverse-sync **reuses** the exact deal machinery
  (`/app/sync-deal` is just `syncMondayItem(DEALS.boardId, …)`).
- **Board relation columns:** deal↔company (`DEAL_REL_COMPANY`), deal↔contact (`DEAL_REL_CONTACT`),
  company→contact (`COMPANY_REL_CONTACT`), contact→company/deal exist. **There is no company→deal
  column** — company↔deal is tracked on the deal side only.

## Goal

1. Make `CompanyDrawer` **editable**: edit the company's reverse-syncable fields and its **contact**
   associations (board column + HubSpot), and add/remove its **deal** associations (HubSpot-only).
2. **Fix the association load bug**: the deal drawer (and the new company edit) load associations
   **fresh from HubSpot on open**, so all associated records show and a save can never shrink them.

## Non-goals (v1)

- No new company→deal board column (deal associations from the company are HubSpot-only, per decision).
- No editing of the remaining one-way fields (`partner_with`/`timezone`/`createdate`) — shown read-only.
  (Owner **is** made editable this feature — see Part 1.)
- No company delete/archive from the app.
- No bulk association editing.
- **No explicit field-blanking.** v1 sets/changes field values; a field left empty is **omitted**, not
  reverse-cleared (an empty monday value is ambiguous to the reconciler — the deal drawer needed a
  narrow clear-allowlist for exactly this, and companies don't get one in v1). So `companyFormToColumnValues`
  simply omits empty fields; there is no `deliberateClears` for companies.

## Part 1 — Editable company fields

### Editable set (the `COMPANIES_MYLA` `reverse: true` fields)

| Field | monday column (COMPANY_COLS) | type |
|---|---|---|
| Domain (**item name**, `nameReverse: "domain"`) | *(item name)* | text |
| Company Name (`name`) | `text_mm4scke9` | text |
| Industry (`industry`) | `dropdown_mm54zrp2` | dropdown (enum) |
| Type (`type`) | `color_mm545z1t` | status (enum) |
| Sales User (`sales_user`) | `multiple_person_mm54phd7` | people |
| City (`city`) | `text_mm4p2bvb` | text |
| State (`state`) | `text_mm4sznkw` | text |
| Employees (`numberofemployees`) | `numeric_mm4ww8gs` | number |
| Annual revenue (`annualrevenue`) | `numeric_mm4w8g9k` | number |
| LinkedIn (`linkedin_company_page`) | `text_mm4w6rzg` | text |
| Description (`description`) | `text_mm4wwtd0` | text |
| Owner (`hubspot_owner_id`) | `multiple_person_mm4p8xe2` | people |

**Owner is made reverse-capable** for this feature: add `reverse: true` to the `COMPANIES_MYLA`
`hubspot_owner_id` field (worker config). It uses the existing people-reverse machinery (monday person
→ email → HubSpot owner id), exactly like `sales_user` and the deal owner. This makes company owner
**two-way** (a monday owner edit now pushes to HubSpot) — an intended behavior change.

Read-only (one-way, shown but not editable): **Partner with** (`color_mm54xzax`), **Created date**.
These column ids go into a new `COMPANY_COLS` map in `monday-app/src/board-config.ts` (mirrored from the
worker's `COMPANIES_MYLA`).

### Data flow

`CompanyDrawer` opens with a `Company` (from `/app/companies`) that carries `hubspotId` but **not the
monday itemId**, and only **display-resolved** field values (e.g. industry label, not the internal
enum value). So on open, the drawer:
1. Resolves the monday card id: `ensureCard(companies, hubspotId)` → `itemId` (existing endpoint).
2. Fetches the card's column values (a generic `getItem(itemId)` in monday-client) → hydrates the form:
   text/number from the column `text`, enums from the column's label (see below), people (sales user)
   from the column's person ids. This baseline (`origForm`, like the deal drawer) is what Save diffs
   against so it sends only the fields the rep actually changed.
- **Enums use labels, not internal values** (mirror the deal drawer / `lib/columns.ts`): hydrate each
  enum field from the column's `text` (its label) and write it back as `{ label }` (status) /
  `{ labels: [label] }` (dropdown). So no internal enum value is needed — the dropdown just lists labels
  from `GET /app/company-schema` (`industry`, `type`), and the current value is matched by label.
- People (sales user) options come from the account `users`. `CompanyDrawer` has no `board`, so
  `CompaniesView` fetches `users` once via `getUsers()` (cheap, like it already does for owners) and
  passes `users` + the session token + an `onSaved` callback into `CompanyDrawer`.

### Save (mirrors the deal drawer's optimistic write + background sync + status badge)

1. Write only the **changed** columns to the company card via a new generic
   `updateItemColumns(boardId, itemId, cols)` in monday-client (today's `updateDealColumns` hardcodes
   the deals board); rename the card if the **domain** (item name) changed
   (`renameItem(boardId, itemId, name)`).
2. `POST /app/sync-company { itemId }` → `syncMondayItem(COMPANIES_MYLA.boardId, itemId, …)` reverse-
   syncs the changed reverse fields **and** the contact associations to HubSpot. A background call with
   a ✓ Synced / ⚠ Retry badge, exactly like the deal drawer's `finishSave`.
- **Hydration safety:** only changed+loaded fields are written; an unloaded field is never blanked
  (protects against clobbering a value the drawer didn't fetch).

## Part 2 — Company associations

### Contacts — full (board column + HubSpot)

Reuse `AssociationSection` (the deal drawer's contact/company picker). Value = the company's contacts
as `Assoc[]`. On Save:
1. Resolve each staged contact to a monday card (`resolveAssocs` → `ensureCard`).
2. Write the `COMPANY_REL_CONTACT` board_relation column (`updateItemColumns`).
3. `/app/sync-company`'s `reverseAssociations` pushes the links to HubSpot (additive/set-only).
4. **Removed** contacts (in the loaded set, not in the saved set) are unlinked in HubSpot via
   `DELETE /app/association { fromObject: "companies", fromId: companyHsId, toObject: "contacts",
   toId }` — because `reverseAssociations` never deletes (mirror the deal drawer's `unlinkRemoved`).

### Deals — HubSpot-only (no board column)

The drawer shows the company's deals live from `GET /app/associations?type=companies&id=<hsId>&to=deals`
(the endpoint already accepts `deals`). Editing pushes straight to HubSpot:
- **Add** a deal → `POST /app/association { fromObject: "companies", fromId, toObject: "deals", toId }`
  (`putAssociation`).
- **Remove** a deal → `DELETE /app/association { fromObject: "companies", fromId, toObject: "deals", toId }`.
- No monday column is written; the deal's own "Company" link reflects an add from the deal side via
  the normal sync. To pick a deal to add, use the live deal search (the new `/app/search?type=deals`
  branch, Part 4) — a debounced picker like the contact/company one.

## Part 3 — Association fresh-on-open (the bug fix)

On edit-open, after loading the monday relation cards as today, **also** fetch the record's live
HubSpot associations and **merge**:
- Deal drawer: `/app/associations?type=deals&id=<dealHsId>&to=contacts` (and `&to=companies`).
- Company drawer: `/app/associations?type=companies&id=<hsId>&to=contacts`.

Merge rule (a pure, tested helper `mergeAssoc(mondayCards, hubspotRecs)`): start from the monday cards
(which carry `itemId`); for every HubSpot-associated record **not already present by `hubspotId`**, add
a staged `Assoc { label, hubspotId }` (no `itemId` — resolved to a card on Save by the existing
`resolveAssocs`, exactly like a picked contact). Deduped by `hubspotId`.

Effect:
- The drawer shows **all** associations (all 10 contacts), names immediately (card resolution deferred
  to Save, so open stays fast).
- `origContacts`/`origCompanies` become the **full** merged set, so `unlinkRemoved` only unlinks what the
  rep explicitly removed — **a save can no longer silently shrink the relation** (today's data-loss bug).
- Requires the record's HubSpot id at open time: the deal already loads `dealHubspotId`; the company
  drawer has `hubspotId`. If a deal has no HubSpot id yet (never synced), skip the fresh fetch and fall
  back to the monday relation (unchanged).

Separately (not blocking): the root under-population of the monday relation is healed by the daily
reconcile's `syncAssociations`; the fresh-on-open makes the drawer correct regardless of lag.

## Part 4 — Worker + app wiring

**Worker (`worker/src/config.ts`, `index.ts`, `app-routes.ts`):**
- `config.ts` — add `reverse: true` to `COMPANIES_MYLA`'s `hubspot_owner_id` field (makes company owner
  two-way; reuses the people-reverse path). One line.
- `POST /app/sync-company { itemId }` → `syncMondayItem(COMPANIES_MYLA.boardId, itemId, appWriteOpts, {left:30})`. Mirror of `/app/sync-deal`; parse+validate `itemId` (numeric).
- `POST /app/association { fromObject, fromId, toObject, toId }` → `putAssociation(env, fromObject, fromId, toObject, toId, appWriteOpts)`. Generalize the body parser; allow `fromObject ∈ {deals,companies}`.
- **Generalize** the existing `DELETE /app/association` (today `fromObject` is fixed to `"deals"`) to
  accept `fromObject ∈ {deals, companies}` and validate the object pair.
- Extend `/app/search` with a **`deals`** branch (`SEARCH_PROPS.deals = ["dealname"]`; `mapSearchResult`
  → `{ name: p.dealname, secondary: "" }`) so the company drawer can search a deal to add. Required —
  without it there's no way to pick a deal to associate.
- **`/app/associations` must name deals:** add a `deals` branch to `mapAssocRecord`
  (`name = p.dealname`) and add `"dealname"` to the handler's `getRecordsByIds` prop list. Without this,
  `to=deals` returns empty names and the company's deal list would show blanks.

**App:**
- `monday-app/src/board-config.ts` — add `COMPANY_COLS` (the column ids above) + `COMPANY_REL_CONTACT`.
- `monday-app/src/monday-client.ts` — generic `getItem(itemId)`, `updateItemColumns(boardId, itemId, cols)`,
  `renameItem(boardId, itemId, name)` (generalize the deal-specific ones; keep the deal wrappers or
  point them at the generic).
- `monday-app/src/worker-client.ts` — `syncCompany(token, itemId)`, `addAssociation(token, {fromObject,
  fromId, toObject, toId})`, generalize `deleteHubspotAssociation` to take `fromObject`, and a
  `searchDeals`/extended `searchHubspot` for the `deals` type. `getRecordAssociations(..., to="deals")`
  works once the worker's `mapAssocRecord` deals branch (above) is in.
- `monday-app/src/lib/company-form.ts` (+ test) — `companyFormToColumnValues(form)` (mirror
  `lib/columns.ts`'s `dealFormToColumnValues`: text/number → raw, status → `{label}`, dropdown →
  `{labels:[label]}`, people → `{personsAndTeams}`; **omit empty**, no clear path).
- `monday-app/src/lib/assoc-merge.ts` (+ test) — the pure `mergeAssoc(mondayCards, hubspotRecs)` helper.
- `monday-app/src/views/CompanyDrawer.tsx` — becomes editable: form (via `FormFields`), contacts
  `AssociationSection`, a deals association list (add/remove, HubSpot-only), Save. Reuses the deal
  drawer's dirty-guard + status-badge patterns. `CompaniesView` passes `users` + a card-refresh callback.
- `monday-app/src/views/DealDrawer.tsx` — fold `mergeAssoc` into the edit-open load (contacts + companies).

## Part 5 — Horizontal table scroll (both tabs)

The Deals and Companies tables cut off right-hand columns (Sales User, ↗ HubSpot) with no usable
horizontal scrollbar. Fix in `styles.css`: `.dc-table-scroll { overflow-x: auto }` with a visible
scrollbar (`scrollbar-width: thin` / a styled `::-webkit-scrollbar`), and give `.dc-table` a
`min-width: max-content` (or a sensible min) so columns keep their width and the row scrolls right
instead of cramming. Pure CSS — no component change; applies to both tabs (they share `.dc-table*`).

## Testing

**App (vitest node):**
- `companyFormToColumnValues`: text/number → raw; status → `{label}`; dropdown → `{labels:[label]}`;
  people → `{personsAndTeams}`; empty fields omitted.
- `mergeAssoc`: monday-only, HubSpot-only, overlap (dedup by hubspotId), empty; monday cards keep their
  `itemId`, HubSpot-only get `hubspotId` + no `itemId`.

**Worker (vitest):**
- `parseAssociationBody` accepts `fromObject ∈ {deals,companies}` for both add + delete; rejects bad pairs.
- `/app/sync-company` body parse (numeric itemId).
- `mapAssocRecord("deals", …)` → `{ hubspotId, name: dealname }`; `mapSearchResult("deals", …)` → name.

**Live smoke:** edit a company field → HubSpot company updates; add/remove a company↔contact → HubSpot
association + `COMPANY_REL_CONTACT` reflect it; add/remove a company↔deal → HubSpot reflects it; open a
deal with ~10 HubSpot contacts → all show; save with no changes → none dropped from the relation.

## Decisions (settled)

- **Company↔deal = HubSpot-only** (no board column); company↔contact = full (board + HubSpot).
- **Editable = the reverse-sync fields + owner** (owner made reverse-capable via a one-line config
  change); partner-with/timezone/createdate stay read-only (one-way).
- **Reverse-sync reuses `syncMondayItem`** via a new `/app/sync-company` (no new sync logic).
- **The bug fix = fresh-on-open association merge from HubSpot** (deal + company drawers), which also
  removes the silent shrink-on-save data-loss.
