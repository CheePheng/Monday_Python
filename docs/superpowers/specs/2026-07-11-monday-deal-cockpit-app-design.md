# monday "Deal Cockpit" app (Board View) — Design

**Date:** 2026-07-11
**Status:** Approved (rev 2 — incorporates review feedback)

## Goal

A monday app the sales team uses as their day-to-day cockpit on the "Hubspot Deals" board — browse/search
deals, create a deal, and edit a deal (fields + contact/company associations + line items + updates) — so
they rarely leave the board. The app writes to the monday board; the Cloudflare Worker mirrors it to HubSpot.

## Confirmed decisions

1. **Board View only for v1** (route `/board`). Item View deferred (route `/item` reserved).
2. **monday-first** for creates and field/link/subitem writes; the backend mirrors to HubSpot.
3. **Hosting split**: React bundle **hosted by monday** (deployed via `@mondaycom/apps-cli` `mapps
   code:push`; ZIP upload is being deprecated). Cloudflare **Worker** = backend (`/app/*` + all sync).
4. **Auth**: the app calls the Worker with the monday **session-token JWT**; the Worker verifies it (see
   §Auth — the exact signing secret is verified empirically). No permanent secret in the browser.
5. **Removals propagate** for BOTH line items and associations (by HubSpot id, **never by name**). This
   revises the earlier "set-only" stance for the editor's edit/remove actions.
6. **KPI cards deferred to v1.1** (definitions recorded in §Out of scope).

## Architecture

### Stack
Vite + React + TypeScript; **@vibe/core** + **@vibe/icons**; **monday-sdk-js** (`context`, `sessionToken`,
`api`, `execute`). New folder `monday-app/`. Route `/board` (v1); `/item` reserved.

### Auth (Worker verification of the session token)
The client sends `monday.get("sessionToken")` (a JWT) to the Worker. The Worker verifies: **HS256
signature**, **expiry**, **account id** (must be the allowed account), and **user id** present. The signing
key is the monday app secret — **verified empirically at implementation** (decode a real session token and
test its signature against the app's Client Secret vs Signing Secret; use whichever verifies) and stored in
the Worker env (`MONDAY_APP_SESSION_SECRET`). Keep CORS + OPTIONS. The old static `X-App-Secret` browser
path is retired once this works (see §Security).

### OAuth scopes (Developer Center)
`boards:read`, `boards:write`, `me:read`, `users:read`, `updates:read`, `updates:write`.

### Data access
- **monday board** via `monday.api()` (seamless session-token auth) — read/write deal columns, Connect-Boards
  links, subitems, updates; find-or-create contact/company cards; read account users for the people pickers.
- **HubSpot search** via `GET /app/search` (session-token authed) — contacts/companies/products type-ahead.

### Board View screens (v1)
- **Deal table**: query the Deals board (5029480547) → searchable / filterable / sortable Vibe table (Name,
  Deal Stage, Sales Users, Amount, Currency, Close Date, Associated Company, Associated Contact). Filters:
  stage, sales user, "my deals" (`context.user.id`). **+ Create Deal**; row click → **Edit Deal**.
- **Create / Edit Deal modal** (shared form): fields → columns (see map); Associations (Contacts/Companies)
  via `/app/search` type-ahead → find-or-create the target card → link; Line items as subitems (name, qty,
  unit price) with product type-ahead; Updates (edit mode: list + post).

### Startup schema validation (before any write)
On load, query the board(s) and confirm: every configured column id exists with the expected **type**; the
required **groups** exist; the Connect-Boards columns point to the intended boards; the subitem columns
exist. On any mismatch, show a **configuration error** and disable writes (fail safe, no partial data).
**All HubSpot ids are treated as strings** everywhere (they exceed JS safe-integer range — never `Number()`
them for matching).

### Column map (Deals board 5029480547)
`name`→item name · Pipeline `color_mm4ws6k` (default "Sales Pipeline") · Deal Stage `color_mm53fh1r`
(default "Appointment Scheduled", drives the group) · Vendors `dropdown_mm4n4f7r` · Amount `numeric_mm531t6e`
· Currency `color_mm53vk99` (default USD) · Close Date `date_mm53ecz3` · Sales Users
`multiple_person_mm532m82` · Deal Owner `person` · Deal Type `color_mm53cky8` · Priority `color_mm532rej` ·
Associated Company `board_relation_mm54rrj3`→5029639440 · Associated Contact `board_relation_mm5417sy`
→5029639630 · HubSpot Deal ID `numeric_mm4nz332` (read-only). Unassigned group `group_mm53yk6d`.
Subitems board 5029480548: id `text_mm53ds6w`, product id `text_mm54hbvj`, unit price `numeric_mm53rsfd`,
quantity `numeric_mm531345`. Contact board id-col `numeric_mm4xw7rk`; Company board id-col `numeric_mm4xkk3a`.

## Backend work (Worker) — NOT "no change"

Already built + verified live this session: Connect-Boards link **added** → HubSpot association; subitem
**created** → HubSpot line item; `create_update` → HubSpot note. **Still to build for the editor:**

1. **Session-token verification** on `/app/search` (§Auth).
2. **`POST /app/line-item`** — update a HubSpot line item by its Line Item ID (qty/price/etc.).
3. **`DELETE /app/line-item`** — delete a HubSpot line item by its Line Item ID (on row removal).
4. **`DELETE /app/association`** — disassociate a HubSpot link by ids (on association removal).
All new endpoints are **session-token authed**, operate **by HubSpot id (never by name)**, and reuse the
existing HubSpot write helpers. Create/add still flow through the existing monday-first sync.

## Create/Edit robustness (hard requirements)

- **Disable Save/Create while processing**; guard against double-submit.
- A create is a sequence (parent → links → subitems → optional update). **Persist the created parent item
  id**; on a later-step failure, **retry only the failed step** — never re-create the parent.
- Before find-or-create of an association card, **re-query by HubSpot id**; if two users race the same
  missing record, re-check after create and let the Worker's dedup reconcile.
- Edit/remove of a line item or association: if the subitem/link is already synced (has a HubSpot id), call
  the matching Worker endpoint; if not yet synced, just do the monday change (the create path handles it).

## Testing

- **Worker unit**: session-token verification (valid / expired / wrong-signature / wrong-account); the new
  line-item update/delete + association-delete endpoints (mock HubSpot).
- **App unit**: framework-free helpers — form → `column_values`, Deal-Stage → group, associate/line-item
  payload builders, schema-validation checker — under vitest.
- **Live**: Board View lists deals; create a deal (contact + company + product line item) → appears in
  HubSpot; edit fields + a line item qty + remove a link + post an update → all propagate (line-item
  updated, association removed, note created); "my deals" filter works.

## Security

Rotate the old `/app/search` static `X-App-Secret` (it was placed in the vibe prompt = frontend material →
treat as exposed). After session-token auth works, the browser uses only the session token; keep the static
secret only for genuine server-to-server calls, or remove that path.

## Out of scope (v1)

- **KPI cards → v1.1** (definitions for later: Active = not Closed Won/Lost; Closed Won = the Closed-Won
  stage; Total Pipeline = sum of Amount for open deals shown **per currency**, no FX conversion; Win Rate =
  Closed Won / (Closed Won + Closed Lost)).
- Item View (`/item` reserved), bulk actions, saved views, dashboards, offline.
- Any HubSpot write path *inside the app* (all HubSpot writes go through the Worker).
