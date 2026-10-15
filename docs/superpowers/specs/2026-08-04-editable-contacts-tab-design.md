# Editable Contacts Tab — Design

**Date:** 2026-08-04
**Status:** Approved (pending user spec review)
**Branch:** `feat/deals-single-board`

## Goal

Add a **Contacts** tab to the Deal Cockpit app that mirrors the Companies tab: a searchable, filterable live HubSpot contact directory, and an **editable** drawer that edits contact fields (reverse-synced to HubSpot) and adds/changes/removes the contact's associations to **companies AND deals** (both directions: monday `board_relation` column + HubSpot association).

## Decisions (locked with the user)

- **Editable fields = broad:** First name, Last name, Email, Phone, Job title, Sales user, Owner, Lead status, Lead source, Vendor. Owner/Phone/Lead source/Vendor are made reverse-capable (they're forward-only today).
- **Associations = Companies + Deals**, both fully two-way (each has a monday relation column).
- **Approach = mirror the Companies tab** (new `ContactsView` + `ContactDrawer` + `listContacts`), reusing the shipped generic reverse (`syncMondayItem`), `AssociationSection`, `mergeAssoc`, `getItem`/`updateItemColumns`/`renameItem`, and the `/app/association` endpoint. Rejected: generalizing `CompaniesView`/`CompanyDrawer` into one parameterized component — it destabilizes shipped code for only two entity types; mirror now, abstract later if a third appears.

## Contact model (verified in `CONTACTS_MYLA`, `worker/src/config.ts`)

- Board **5029639630**; `idCol = CONTACT_ID_COL = "numeric_mm4xw7rk"`; item name = `firstname` (`nameReverse:"firstname"`).
- Relation columns: `CONTACT_REL_COMPANY = "board_relation_mm54dbxk"`, `CONTACT_REL_DEAL = "board_relation_mm54zahf"`.
- Association specs already present: `{toObject:"companies", relationCol:CONTACT_REL_COMPANY}`, `{toObject:"deals", relationCol:CONTACT_REL_DEAL}`.

## Editable field map

| Drawer field | HubSpot prop | monday column | type | reverse today? |
|---|---|---|---|---|
| First name | `firstname` | *item name* | text (name) | yes (`nameReverse`) |
| Last name | `lastname` | `text_mm4scke9` | text | yes |
| Email | `email` | `text_mm4p2bvb` | text | yes |
| Job title | `jobtitle` | `text_mm4sznkw` | text | yes |
| Sales user | `sales_user` | `multiple_person_mm542gng` | people | yes |
| Lead status | `hs_lead_status` | `status` | status (`leadStatus`) | yes |
| **Phone** | `phone` | `phone_mm4s31p3` | phone | **add `reverse:true`** |
| **Owner** | `hubspot_owner_id` | `multiple_person_mm4p8xe2` | people | **add `reverse:true`** |
| **Lead source** | `leadsource` | `dropdown_mm4sj3kw` | dropdown (`contactSource`) | **add `reverse:true`** |
| **Vendor** | `manufacturer__c` | `dropdown_mm4t8gjf` | dropdown (`contactVendor`) | **add `reverse:true`** |

Read-only (shown, not edited): `company` (the free-text company-name prop — the company **link** is managed by the association section, so this string is not an editable field), `createdate`, `notes_last_updated`. **No field-blanking in v1:** `contactFormToColumnValues` omits empty values (same rule as `companyFormToColumnValues`).

## Component 1 — Contact directory (`listContacts` + `GET /app/contacts`)

Mirror `worker/src/hubspot.ts`'s company directory (`COMPANY_LIST_PROPS`/`companySearchBody`/`mapCompanyResult`/`listCompanies`) and `index.ts`'s `GET /app/companies`:

- **`CONTACT_LIST_PROPS`** = `["firstname","lastname","email","phone","jobtitle","company","hs_lead_status","leadsource","createdate","hubspot_owner_id","sales_user","notes_last_updated"]`.
- **`contactSearchBody({q, after, limit, ownerId, created, activity})`** — pure, sorts by `createdate` DESC; owner (`hubspot_owner_id` EQ), created (`createdate` GTE/LTE), activity (`notes_last_updated` GTE/LTE) in one AND'd `filterGroups`; full-text `query` when present; the empty-query `createdate HAS_PROPERTY` fallback — identical shape to `companySearchBody`.
- **`mapContactResult(p, ownersById, labels)`** — pure → `ContactHit` (name = `firstname`+`lastname` joined, email, company, jobtitle, phone, `leadStatus`/`leadSource`/`vendor` resolved via `labels`, createdate, ownerName, salesUser).
- **`listContacts(env, args, ownersById, labels)`** — I/O; returns `{items, after}`.
- **`GET /app/contacts?q=&after=&limit=&ownerId=&createdGte=&createdLte=&activityGte=&activityLte=`** in `index.ts`, session-authed, `Cache-Control: no-store`, mirroring `/app/companies` exactly (including the `scope`/`contacts-failed` error handling).

**Directory table columns:** Contact (avatar + name), Email, Company, Lead status, Owner/Sales user, Created. **Filters:** owner + Created + Last-activity (same `DateRangeFilter` as Companies).

## Component 2 — Editable drawer + reverse

- **Config:** add `reverse: true` to `phone`, `hubspot_owner_id`, `leadsource`, `manufacturer__c` in `CONTACTS_MYLA.fields`. (This only affects the reverse path; forward sync is unchanged. `sales_user`/`lead status`/text fields already reverse; firstname reverses via the item name.)
- **`POST /app/sync-contact {itemId}`** → `syncMondayItem(CONTACTS_MYLA.boardId, itemId, …)` — mirrors `/app/sync-company` (reuses the `{itemId}` body parser). Runs `reconcileRecord` (reverse fields) + `reverseAssociations` (pushes both relation columns to HubSpot).
- **`FROM_OK` += `"contacts"`** in `app-routes.ts` (`parseAssociationBody`), so `contact→company` and `contact→deal` add/remove work through `POST|DELETE /app/association` (the parsed `fromObject` flows into `putAssociation`/`deleteAssociation`, which already resolve object type ids incl. contacts `0-1`).
- **`ContactDrawer.tsx`** (mirror `CompanyDrawer.tsx`): `ensureCard("contacts", hubspotId)` → `getItem` → hydrate the form (people columns → first person id; text/status/dropdown → `colText`) → `FormFields` form for the editable map → two `AssociationSection`s (companies + deals). Save:
  1. `updateItemColumns(CONTACT_BOARD, itemId, contactFormToColumnValues(form))` (omit-empty),
  2. `renameItem(CONTACT_BOARD, itemId, firstname)` when firstname changed,
  3. resolve both association lists to cards — companies via `ensureCard("companies", …)` (creates if missing), deals via `findItemByColumn(DEALS_BOARD, DEAL_COLS.hubspotDealId.id, …)` (deals aren't `ensureCard`-creatable; a not-found deal falls back to HubSpot-only, see Component 3) — then write the `CONTACT_REL_COMPANY` + `CONTACT_REL_DEAL` relation columns,
  4. unlink removed companies/deals from HubSpot (`deleteHubspotAssociation("contacts", contactHubspotId, kind, hubspotId)` — `reverseAssociations` never deletes),
  5. `syncContact(token, itemId)` (reverse fields + push the relation links to HubSpot).
- **`lib/contact-form.ts`** `contactFormToColumnValues(f)` + test: text/phone/number raw or shaped, status `{label}`, dropdown `{labels:[label]}`, people via `peopleValue`, omit empty, no clear path — mirrors `company-form.ts`.
- **`lib/contacts.ts`** — `Contact`/`ContactHit` types, `orDash`, `fmtContactDate`, `NewDealSeed` re-use (mirror `lib/companies.ts`).
- **`board-config.ts`** — `CONTACT_BOARD = "5029639630"`, `CONTACT_REL_COMPANY`, `CONTACT_REL_DEAL`, `CONTACT_ID_COL`, and a `CONTACT_COLS` map (lastname/email/jobtitle/phone/salesUsers/owner/leadStatus/leadSource/vendor → the column ids above).
- **`worker-client.ts`** — `listContacts(token, args)`, `syncContact(token, itemId)`. `getRecordAssociations`/`searchHubspot` already accept `contacts`/`companies`/`deals`; **`addHubspotAssociation`/`deleteHubspotAssociation`'s `fromObject` type is widened from `"deals" | "companies"` to also include `"contacts"`** (the Worker's `putAssociation`/`deleteAssociation` already resolve object type ids generically — `reverseAssociations` uses them for contact links — so only the client-side type union changes).

## Component 3 — Associations (both two-way + fresh-on-open)

Both `contact→company` and `contact→deal` are managed by **`AssociationPicker` used directly** (search + link/unlink existing records — link-existing-only; no inline record creation in v1: new companies are created from the Companies tab / standalone creator, deals from the board). Using the picker directly (rather than `AssociationSection`, which wraps it with a "+ New" create panel) is what makes it link-existing-only — no create-suppression needed. Each section writes **both** monday's relation column (`CONTACT_REL_COMPANY` / `CONTACT_REL_DEAL`) **and** the HubSpot association (via `syncContact`→`reverseAssociations` for adds; explicit `deleteHubspotAssociation` for removes).

**`AssociationPicker` gains a `"deals"` kind** (its `kind` widens to `"contacts" | "companies" | "deals"`; `searchHubspot("deals")` and `hubspotRecordUrl("deals", …)` already exist, so only the type + the section-title map change). `"contacts"`/`"companies"` are unchanged.

**Resolving a picked deal to its board card (the one asymmetry vs. contacts/companies):** contacts and companies are resolved to a monday card with `ensureCard`, which *creates* the card if missing. Deals are the primary board and are never created by the app, so `ensureCard` has no `"deals"` path. To write `CONTACT_REL_DEAL`, a picked HubSpot deal id is resolved to its existing card on the DEALS board (`5029480547`) via a **find-by-column lookup** (`DEAL_COLS.hubspotDealId.id = "numeric_mm4nz332"`) — a small new `monday-client` helper `findItemByColumn(boardId, columnId, value)` (the Worker already has one; the app doesn't). If a picked deal has no card on the board (rare — every synced deal has one), that single deal link is applied **HubSpot-only** (`addHubspotAssociation`) and the forward sync fills the relation column on the next tick; it never blocks the save. Existing linked deals load via `getCardsByIds(linkedIds(item, CONTACT_REL_DEAL), DEAL_COLS.hubspotDealId.id)` (board-agnostic — it just reads the id column per item).

**The "1-of-N" data-loss fix, carried over:** on edit-open the drawer fetches the contact's companies and deals **fresh from HubSpot** (`getRecordAssociations(token,"contacts",id,"companies"|"deals")`) and **merges** (`mergeAssoc`) with the monday relation cards, so a contact linked to many companies/deals shows all of them and a save never silently drops the unloaded ones — the identical fix the deal and company drawers already carry.

## Component 4 — Nav tab + routing

`App.tsx`: add a **Contacts** `NavLink` (`to="/contacts"`) next to Deals/Companies, and a `Route path="/contacts" element={<ContactsView/>}`. `ContactsView.tsx` mirrors `CompaniesView.tsx` (token fetch, debounced search, filters, pagination, skeleton/empty/retry, `onCreateDeal` seed, `onSaved` reload) but calls `listContacts` and renders `ContactDrawer`.

## Phone — confirmed to need its own gated task

monday's phone column write shape is simple (`{phone: "<digits>"}`, no country code — `mapping.ts:24-30`). The catch is the **reverse**: the reconcile currently treats phone as **not diffable** (`expectedText` returns `null` for phone at `mapping.ts:63`; `reconcile.ts:41` `continue`s on it), so `reverse:true` on phone **does nothing on its own**. Making phone edits reach HubSpot requires changing `expectedText` to return a normalized digit string for phone so the reconcile can detect a monday-side phone edit — and the code's own comment warns phone echoes can cause phantom-diff loops.

Therefore Phone is a **separate, gated task, done last**: add the `expectedText` phone-diff (contained — `CONTACTS_MYLA` is the only spec with a phone field) + the form field, then **live-verify no loop** (edit phone in monday → HubSpot updates → forward tick doesn't bounce). If the loop check fails, Phone ships **read-only** (displayed, not editable) and remains a fast-follow. The other nine fields (Owner via the people branch, the two dropdowns, and the text/status fields) reverse through existing, proven paths and carry no such risk.

## Error handling / idempotency

- Save is guarded by a `savingRef` double-submit lock (mirror CompanyDrawer); association diffs key on `hubspotId` (never name); `contactFormToColumnValues` omits empty (never clears HubSpot from an empty field); `ensureCard` is idempotency-guarded server-side (card registry). A failed reverse logs and is swept by the cron.

## Testing

- **Unit (app):** `contactFormToColumnValues` — text/phone/people/status/dropdown mapping, omit-empty, no clear path. Reuse the existing `mergeAssoc` tests.
- **Unit (worker):** `contactSearchBody` (sorts/filters/query/empty-fallback) + `mapContactResult` (label resolution, name join) — mirror the `companySearchBody`/`mapCompanyResult` tests.
- **Gates:** worker `tsc` + `vitest`; app `tsc` + `vite build` (`noUnusedLocals` ON).
- **Live (a test contact):** edit each field → HubSpot updates; add/remove a company and a deal → monday relation + HubSpot both reflect; open a contact linked to several companies/deals → all show; save with no changes → nothing dropped.

## Out of scope

- Generalizing the company/contact views into one shared component (future refactor).
- Contact **creation** (already exists via the v3.4 standalone `RecordDrawer` + `/app/contact`); this is edit-only.
- Blanking/clearing fields from an empty drawer input (no clear path in v1).
- Any change to how the Companies or Deals drawers behave. `AssociationPicker` gains a `"deals"` kind (additive; existing `"contacts"`/`"companies"` usage is unchanged), and `expectedText` gains a phone branch (only `CONTACTS_MYLA` has a phone field, so no other board is affected).
