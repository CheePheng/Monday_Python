# Deal Cockpit — Companies Tab (design)

**Date:** 2026-07-31
**Status:** Design approved; ready for implementation plan.

## Context

The Deal Cockpit is a single monday Board-View app (`monday-app/`, `monday-deal-cockpit`)
pinned to the Deals board. Its `App.tsx` routes a single view (`/board` → `BoardView`),
which loads *all* deals into the browser (~600 rows — fine). Separately, ~25k HubSpot
companies were synced to the Company Follow Up board (`5029639440`), and a background run
is populating each company's linked contacts. The boss wants reps to browse those companies
from the app and act on them.

A Companies view can't reuse the Deals loading model: **25k cards cannot be bulk-loaded**
into the browser. But the Worker already exposes exactly what a directory needs —
`/app/search?type=companies` (live HubSpot company search) and
`/app/associations?type=companies&to=contacts` (a company's linked contacts, live from
HubSpot). Company records are rich (name, domain, industry, type, owner/sales user,
city/state, employees, revenue, LinkedIn, created date) and already carry a contact relation.

## Goal

Add a **Companies tab** alongside the Deals view: browse/search all ~25k companies
(newest-created first by default), open a company to see its details and linked contacts,
deep-link to HubSpot and the monday card, and start a deal pre-linked to the company (or to
the company **and** a specific contact).

## Non-goals (v1)

- **No editing of company fields** (no company reverse-sync). Browse-only on the company.
- **No filters** (industry/owner). Search is the find path; filters are an easy later add.
- **No "open contact's monday card"** action — redundant with ↗ HubSpot, thinner data, and
  fragile while the association run is still creating contact cards.
- No bulk actions, no CSV export.

## Architecture

The app stays one Board-View app (one iframe, one session), gaining a **second client-side
view** — no new monday app instance, no second board install.

- **Tab strip.** `App.tsx` renders a slim top bar with two `NavLink`s — **Deals** (`/board`)
  and **Companies** (`/companies`) — above `<Routes>`, active tab highlighted. Theme is applied
  at the shell (`dc-root`, already done); each view obtains the current user + session token via
  `getContext()` as it does today (`useBoard` for the Deals view; `CompaniesView` for its own).
- **New view.** `/companies` → `CompaniesView`, mirroring `BoardView`'s look (`.dc-wrap`
  header, search toolbar, `.dc-panel` table, existing `dc-*` styles). The Deals view is
  untouched.
- **The Worker remains the only HubSpot caller** (unchanged architecture rule). The Companies
  view calls Worker `/app/*` endpoints with the same session-token bearer; it never touches
  HubSpot directly and never loads 25k monday rows.

## Worker endpoints

### New: `GET /app/companies?q=&after=&limit=`

Session-token auth + CORS + `Cache-Control: no-store`, exactly like `/app/search`. Calls a
new `listCompanies()` in `worker/src/hubspot.ts`, factored into two **pure, mock-free**
helpers (mirroring the existing `mapSearchResult`) so the logic is unit-testable without
stubbing `fetch`: `companySearchBody({ q, after, limit })` builds the request body, and
`mapCompanyResult(properties, ownersById, labels)` maps one result (`labels` = `ctx.labels`).
`listCompanies` just calls `hs(env, "POST", "/crm/v3/objects/companies/search",
companySearchBody(...))` and maps.
`companySearchBody` posts to `/crm/v3/objects/companies/search` with:

- `sorts: [{ propertyName: "createdate", direction: "DESCENDING" }]` → **newest-created first**
  (the default view), applied whether or not a query is present, for predictable ordering.
- When `q` is non-empty: `query: q` (HubSpot full-text spans name + domain), no `filterGroups`.
- When `q` is empty (default listing): **no `query`**, and a benign
  `filterGroups: [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }]`
  (every company has a `createdate`). This guarantees a valid, complete, newest-first search
  rather than relying on a fully-empty search body being accepted — and mirrors how the
  existing `searchAll` pairs `filterGroups` with `sorts`.
- `properties`: `name, domain, industry, type, partner_with, city, state, numberofemployees,
  annualrevenue, linkedin_company_page, description, createdate, hubspot_owner_id, sales_user`.
- `limit` (default 25, cap 50) + `after` cursor.

Returns:

```json
{ "results": [ { "hubspotId", "name", "domain", "industry", "type", "partnerWith",
                 "city", "state", "employees", "revenue", "linkedin", "description",
                 "createdate", "ownerName", "salesUser" } ],
  "after": "<cursor|null>" }
```

- The handler fetches `ctx` via `getCtxCached(env)` and passes it to `listCompanies`, which
  hands `ctx.ownersById` + `ctx.labels` to `mapCompanyResult`. `hubspot_owner_id` →
  `ownerName` via `ctx.ownersById[id]?.name`. **`industry`, `type`, `partner_with`, and
  `sales_user` are HubSpot enumerations** — their raw values are internal codes — so each is
  resolved to its display label via the matching `ctx.labels` dictionary (`industry`,
  `companyType`, `partnerWith`, `salesUser` respectively), **falling back to the raw value if
  unmapped**. Any miss → "". A single fetch supplies both the **list row** and everything the
  **detail panel** shows — no second round-trip to open a company.
- Fails soft: on error returns `{ results: [], after: null, error: "companies-failed" | "scope" }`
  (same shape/spirit as `/app/search`), so the UI shows a Retry state rather than a bare empty.
- Kept as a **separate** endpoint so the 20-cap `/app/search` picker is untouched.
- HubSpot `/search` deep-paging caps at 10,000 results; irrelevant to interactive
  newest-first browsing (a rep never hand-pages past 10k; a search term returns far fewer).

### Extend: `GET /app/associations` (contacts branch only)

The handler already fetches `email` for contacts; add `jobtitle` to the property list and
return `email` + `title` alongside `name`, so contact rows read *"Jane Tan · jane@acme.com ·
CTO"*. **Purely additive** — the deal-form auto-associate consumer reads the *companies*
branch and only uses `hubspotId`/`name`, so it is unaffected. The `contacts` result item
becomes `{ hubspotId, name, email, title }`.

No other Worker changes. `/app/ensure-card` and the deal-create endpoints are reused as-is.

## Companies list screen (`CompaniesView`)

Mirrors the Deals table. Header "Companies"; a **debounced search box** (reuse
`useDebouncedSearch` — ≥2 chars, ~300 ms, aborts stale requests) placeholder
*"Search companies by name or domain."*

`CompaniesView` has no `useBoard`, so it obtains the **session token** itself via
`getContext()` on mount (the same call `useBoard` uses) and threads it into its Worker calls
and the `CompanyDrawer`. On an auth failure the Retry path re-fetches the token, matching how
the existing app recovers.

- **Empty query →** newest-created-first list from `/app/companies` (no `q`).
- **Columns:** Company (avatar + name), Domain, Industry, Location (city/state),
  Owner / Sales user, Created. Row click opens the detail drawer.
- **Pagination:** a **"Load more"** button using the returned `after` cursor. Absent `after`
  = end of list, button hidden.
- **States** (same vocabulary as `AssociationPicker`): skeleton while loading,
  *"No companies match"* empty, *"Companies unavailable — Retry"* on error. Typing a new query
  resets pagination (drops any accumulated pages and `after`).

## Company detail (`CompanyDrawer`, reuses `DrawerShell`)

Opens as a right-side drawer, reusing `DrawerShell` (as `RecordDrawer` does — `DealDrawer`
predates the shell and renders a raw `dc-drawer`). All company fields come from the list
result already fetched — **no extra round-trip to open it**; only contacts are fetched on open.

- **Header:** name + domain; **↗ HubSpot** (`hubspotRecordUrl("companies", hubspotId)` →
  `openLink`), **↗ monday card** (safe here — Phase 1 gave every company a card; resolve via
  the existing `ensureCard("companies", hubspotId)` → `openItemCard`), and
  **＋ Create deal from this company**.
- **Fields (read-only):** industry, type, partner-with, city/state, employees, annual
  revenue, LinkedIn (rendered as a link), created date, owner, sales user, description.
  Empty values render as "—".
- **Contacts (N):** fetched on open from
  `/app/associations?type=companies&id=<hubspotId>&to=contacts` (now returning email + title).
  Each row: **name · email · title**, with **↗ HubSpot** (`hubspotRecordUrl("contacts", …)`)
  and **＋ Deal** (pre-links company + that contact). Own loading / *"No linked contacts"* /
  error+Retry states. Contacts cached for the drawer's open lifetime only.
  **Cap:** `getAssociatedIds` already fetches `?limit=100` without paging, so the list shows at
  most the first **100** contacts; when exactly 100 come back, the header reads **"Contacts
  (100+)"** to signal there may be more (rare — almost all companies have far fewer). Raising
  the cap is out of scope for v1.

## Create-deal-from-company / contact flow

The deal form lives in `BoardView` (where the deals `useBoard` state lives). Rather than
duplicate that state in the Companies view, the button **navigates to the Deals tab carrying
a seed**:

- `navigate("/board", { state: { newDeal: { company: { hubspotId, name },
  contact?: { hubspotId, name } } } })` (via `useNavigate`).
- **`DealDrawer` gains one optional prop** — `initialAssoc?: { contacts?: Assoc[];
  companies?: Assoc[] }` — used **only on create** (`!isEdit`) to initialize its `contacts` /
  `companies` state (today those start as `[]`). Each seed is a plain `Assoc`
  `{ label: name, hubspotId }` (no `itemId`), so on Save the existing `resolveAssocs` calls
  `ensureCard(kind, hubspotId)` to resolve/create the monday card — **identical** to the rep
  having picked that record in the `AssociationPicker`. (Seeds bypass `onContactsChange`, so
  auto-associate does not re-run: exactly the seeded company/contact are linked, nothing more.)
- `BoardView` reads `location.state?.newDeal` (via `useLocation`) on mount, opens the create
  drawer passing `initialAssoc`, then **clears the router state** (e.g. `navigate(".",
  { replace: true, state: {} })`) so a refresh or back-navigation does not reopen the drawer.
- The company header's action seeds the company only; a contact row's **＋ Deal** seeds the
  company + that contact.

## Data, freshness, errors

- **Live on every open**; no stale caches beyond the open drawer's contact list.
- **Debounced search** aborts stale in-flight requests (reused hook), so a slow older response
  never overwrites a newer query's results.
- **Fail soft everywhere**: each endpoint returns an error field the UI turns into a Retry
  affordance; the view never blanks populated data on a transient failure.
- **Auth**: the session-token bearer already used by every `/app/*` call.

## Testing

**Worker (vitest, `worker/test/`):** — pure helpers, no `fetch` mock needed.
- `companySearchBody`: `sorts` createdate-DESC always; with a query → `query` set and no
  `filterGroups`; with empty `q` → no `query` and the `createdate HAS_PROPERTY` filterGroup;
  the full `properties` set; `limit` clamped to [1,50]; `after` forwarded when present, omitted
  when absent.
- `mapCompanyResult`: maps HubSpot properties to the response shape, resolving `ownerName`
  from a stub `ownersById` map and the enum fields (`industry`, `type`, `partner_with`,
  `sales_user`) from stub `ctx.labels` dicts — each tested for hit, miss → raw fallback, and
  empty → ""; missing fields render as "" (not `undefined`).
- `/app/associations` contacts branch returns `email` + `title` (additive), and the companies
  branch is unchanged — asserted on the pure mapping.

**App (vitest node, `monday-app/src/lib/`):**
- Pure helpers only: a company-row mapper (HubSpot fields → display cells, "—" for empties),
  detail field formatting (revenue/employees number formatting, LinkedIn link), and the
  create-deal **seed builder** (company-only vs company+contact). The existing
  `useDebouncedSearch` coverage carries the search behavior.

## File structure

**Worker**
- `worker/src/hubspot.ts` — add `companySearchBody()`, `mapCompanyResult()`, and
  `listCompanies()`; keep `searchObjects`/`mapSearchResult` untouched.
- `worker/src/index.ts` — add the `GET /app/companies` route (fetch `ctx` via
  `getCtxCached`, pass its `ownersById` + `labels`, fail soft); extend the
  `/app/associations` contacts mapping to include `email` + `title`.
- `worker/test/companies.test.ts` — `companySearchBody` + `mapCompanyResult` unit tests.

**App**
- `monday-app/src/App.tsx` — tab strip + `/companies` route.
- `monday-app/src/views/CompaniesView.tsx` — the list screen (search, table, load-more, states).
- `monday-app/src/views/CompanyDrawer.tsx` — the detail drawer (fields + contacts + actions).
- `monday-app/src/worker-client.ts` — a `listCompanies(token, { q, after, limit })` client
  function, and a **new** `getCompanyContacts(token, companyHubspotId)` returning
  `{ hubspotId, name, email, title }[]`. Do **not** overload the shared
  `getRecordAssociations` (used by the deal-form auto-associate) — add a dedicated function so
  its return type stays stable.
- `monday-app/src/lib/companies.ts` (+ `.test.ts`) — pure mappers (company row/detail
  formatting) + the create-deal **seed builder** (`newDeal` → `initialAssoc` `Assoc[]`s).
- `monday-app/src/views/DealDrawer.tsx` — add the optional `initialAssoc` prop that seeds the
  `contacts` / `companies` state on create (the only change to the deal form).
- `monday-app/src/views/BoardView.tsx` — use `useLocation` to consume `location.state.newDeal`,
  open a pre-seeded new-deal drawer (pass `initialAssoc`), then `useNavigate` to clear the state.
- Small additions to the existing `dc-*` stylesheet for the tab strip.

## Decisions (settled during brainstorming)

- **Scope:** browse + "create deal from company/contact"; no company editing (v1).
- **Default list:** newest-created-first across all companies; search spans all ~25k.
- **Contact-row actions:** ↗ HubSpot + ＋ Deal. *Not* "open monday card" (redundant, and
  fragile mid-association-run).
- **Data source:** live HubSpot via the Worker (Approach A) — freshest, complete contacts
  today (independent of the still-running monday association sync), no 25k browser load,
  smallest new surface. (Rejected: monday-board-backed — its contact relation is incomplete
  until the association run finishes, so most companies would show empty contacts today.)
- **Company monday-card link is safe** (Phase 1 gave every company a card); the contact
  monday-card link is not, hence omitted.
