# Graph Report - Monday_Python  (2026-08-07)

## Corpus Check
- 219 files · ~230,628 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1769 nodes · 3256 edges · 113 communities (106 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.77)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `de70660a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.ts
- owner_router_test.py
- RecordDrawer.tsx
- sync.ts
- webhooks.ts
- dependencies
- monday-client.ts
- create-idempotency-do.ts
- KanbanView.tsx
- LineItemsEditor.tsx
- CompaniesView.tsx
- BoardView.tsx
- worker-client.ts
- DealDrawer.tsx
- compilerOptions
- confirm.tsx
- worker/package.json
- filter.ts
- date-range.ts
- compilerOptions
- columns.ts
- LineItemForm.tsx
- CompanyDrawer.tsx
- useBoard.ts
- session.ts
- contact-company-props.ts
- monday_smoke_test.py
- sort.ts
- hubspot_smoke_test.py
- associations.ts
- Component Information
- Component Information
- app-routes.ts
- PHASE 4 — App UI
- PHASE 2 — monday "Deal Cockpit" React app
- Deal Cockpit v3.4 — Standalone + Contextual Contact/Company Creation — Design
- PHASE 3 — Drawer shell + tabs
- create-records.ts
- Editable Companies + Association Fresh-on-Open Implementation Plan
- HubSpot ↔ monday Two-Way Sync Worker — Design Spec
- monday "Deal Cockpit" app (Board View) — Design
- Deal Cockpit — Editable Companies + Association Fresh-on-Open (design)
- HubSpot ↔ monday.com API Proof of Concept
- HubSpot ⇄ monday Sync Worker (live)
- HubSpot ↔ monday Two-Way Sync Worker — Implementation Plan
- Deal Cockpit v2 — UX upgrade (sole sales interface)
- Deal Cockpit v3.2 — Friendly Save Flow, Feedback & UI Polish + Regression Audit
- Design
- Deal Cockpit — Companies Tab (design)
- Deal Cockpit — Tab Filters + Fast Tab Switching (design)
- Assoc
- Architecture
- Deal Cockpit v3.1 — Drawer, editing & instant sync
- Created Date columns + Company domain gate — Design
- syncMondayItem
- Deal Cockpit v3.2 — Friendly Save Flow, Feedback & UI Polish Implementation Plan
- Companies Tab Implementation Plan
- Tab Filters + Fast Tab Switching Implementation Plan
- Editable Contacts Tab — Design
- Deals: Single Shared Board + Field Remap Implementation Plan
- HubSpot Associations + Line Items → monday Implementation Plan
- Deal Cockpit v3.3 — Phase 2: Two line-item flows + schema-driven manual form + Save-to-library
- Deal Cockpit v3.4 Phase A — Worker Foundation Implementation Plan
- HubSpot Associations + Line Items → monday — Design
- Reverse-sync the Sales Users person → HubSpot `sales_user` — Design
- Sync All Companies — Phase 2 (company→contact associations) — Design
- ContactsView.tsx
- Deal Cockpit v3.3 — Phase 1: Live Search Freshness & UX Implementation Plan
- Deal Cockpit v3.4 Phase B — Standalone Creation UI Implementation Plan
- Created Date columns + Company domain gate — Implementation Plan
- Worker /app/search endpoint (live HubSpot picker for the vibe app) — Design
- monday-first deal creation (vibe app) + reverse association & line-item sync — Design
- Product picker for line items (no new board) — Design
- Deal Cockpit v3.0 — Sync correctness (Amount / Currency / Close date)
- Two-Way Line-Item Sync — Design
- card-registry.ts
- Sync All Companies — Phase 1 Implementation Plan
- Editable Contacts Tab Implementation Plan
- monday item Update → HubSpot Note (deal/contact/company activity) — Design
- Deal Associations + Line Items → Linked on monday (Instant) — Implementation Plan
- Deal Cockpit v3.4 Phase C — Contextual + Nested Associations Implementation Plan
- Association Display Cascade + HubSpot Links Implementation Plan
- Audit Fixes F1–F4 Implementation Plan
- Worker /app/search endpoint + product line items — Implementation Plan
- monday-first deal creation: reverse association + line-item sync — Implementation Plan
- File Structure
- Sync All Companies — Phase 2 (associations) Implementation Plan
- Two-Way Line-Item Sync Implementation Plan
- Audit Fixes F1–F4 — Design
- Auto-associate Contact → Company in the Deal Form — Design
- Deal Form Field Cardinality — Design
- HubSpot Projects
- Reverse-sync Sales Users → HubSpot `sales_user` — Implementation Plan
- monday Update → HubSpot Note — Implementation Plan
- Product dropdown for line items (no new board) — Implementation Plan
- Deal Cockpit v3.0 — Sync correctness Implementation Plan
- Deal Cockpit v3.3 — Phase 3: Fresh-on-open line items + Refresh + guards
- Auto-associate Contact → Company Implementation Plan
- Deal Form Field Cardinality — Implementation Plan
- Deploy the Deal Cockpit Board View
- Phone Country Fix + Backfill — Design
- Phone Country Fix + Backfill Implementation Plan
- Association Display Cascade + HubSpot Links — Design
- App.tsx
- backfill.ts
- register-subitem-webhook.mjs
- AGENTS.md
- CLAUDE.md
- monday-vibe-app-backend-context.md
- monday-vibe-deal-app-prompt.md

## God Nodes (most connected - your core abstractions)
1. `fetch()` - 51 edges
2. `hs()` - 26 edges
3. `api()` - 23 edges
4. `call()` - 22 edges
5. `DealDrawer()` - 20 edges
6. `colText()` - 20 edges
7. `CompanyDrawer()` - 19 edges
8. `reconcileRecord()` - 19 edges
9. `ensureCardForRecord()` - 18 edges
10. `syncMondayItem()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `grouped()` --indirect_call--> `f()`  [INFERRED]
  monday-app/src/views/RecordForm.tsx → worker/test/mapping.test.ts
- `test_match_by_email()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py
- `test_match_by_name_when_no_id_or_email()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py
- `test_match_by_owner_id()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py
- `test_unmapped_owner_returns_none()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py

## Import Cycles
- None detected.

## Communities (113 total, 7 thin omitted)

### Community 0 - "index.ts"
Cohesion: 0.10
Nodes (49): parseSyncContactBody(), archiveDeal(), COMPANY_LIST_PROPS, CompanyFilters, CompanyHit, companySearchBody(), CONTACT_LIST_PROPS, ContactHit (+41 more)

### Community 1 - "owner_router_test.py"
Cohesion: 0.06
Nodes (60): Adds a 'HubSpot ID' numbers column to the Company and Contact boards (dedup…, build_column_values(), build_context(), build_stage_to_group(), configured_owner_ids(), create_item(), deal_properties(), fetch_deals() (+52 more)

### Community 2 - "RecordDrawer.tsx"
Cohesion: 0.08
Nodes (46): useConfirm(), buildCreateAssoc(), isPendingCreate(), attemptCreate(), CREATE_STEPS, isComplete(), isFailed(), ProgressStep (+38 more)

### Community 3 - "sync.ts"
Cohesion: 0.10
Nodes (45): EnsureCard, ensureCardForRecord(), buildColumnValues(), expectedText(), formatValue(), itemName(), phoneDigits(), createItem() (+37 more)

### Community 4 - "webhooks.ts"
Cohesion: 0.06
Nodes (47): reverseSubitemEdit(), ALL_MEMBERS_TEAM_ID, ALL_SPECS, COMPANIES_MYLA, COMPANY_ID_COL, CONTACT_ID_COL, CONTACTS_MYLA, CREATE_CUTOFF_MS (+39 more)

### Community 5 - "dependencies"
Cohesion: 0.06
Nodes (34): dependencies, monday-sdk-js, react, react-dom, react-router-dom, @vibe/core, @vibe/icons, devDependencies (+26 more)

### Community 6 - "monday-client.ts"
Cohesion: 0.14
Nodes (22): apiErrorDetail(), apiErrorMessage(), linkDisplayName(), api(), createDeal(), Ctx, deleteItem(), findItemByColumn() (+14 more)

### Community 7 - "create-idempotency-do.ts"
Cohesion: 0.17
Nodes (9): CardClaim, CardEntry, CreateIdempotency, Claim, CreateResult, CreateState, CreateSteps, decideClaim() (+1 more)

### Community 8 - "KanbanView.tsx"
Cohesion: 0.32
Nodes (10): UNASSIGNED_GROUP, Group, groupIdForStage(), groupStageLabel(), stageForGroupId(), stageOptions(), GROUPS, STAGE_LABELS (+2 more)

### Community 9 - "LineItemsEditor.tsx"
Cohesion: 0.18
Nodes (15): lineItemHubspotProperties(), lineItemToSubitemColumns(), mergeLineItems(), lineItemsTotal(), lineTotal(), n(), TotalInput, createSubitem() (+7 more)

### Community 10 - "CompaniesView.tsx"
Cohesion: 0.27
Nodes (11): buildDealSeed(), fmtCompanyDate(), fmtNumber(), orDash(), getContext(), getUsers(), AVATAR, avatarFor() (+3 more)

### Community 11 - "BoardView.tsx"
Cohesion: 0.18
Nodes (14): hubspotDealUrl(), AVATAR, avatarFor(), Badge(), BoardView(), CUR_SYMBOL, fmt(), fmtCreated() (+6 more)

### Community 12 - "worker-client.ts"
Cohesion: 0.17
Nodes (20): addHubspotAssociation(), archiveHubspotDeal(), call(), clearDealFields(), CompanyContact, createCompany(), createContact(), deleteHubspotAssociation() (+12 more)

### Community 13 - "DealDrawer.tsx"
Cohesion: 0.17
Nodes (23): mergeAssoc(), DealErrors, validateDealForm(), getCardsByIds(), getItem(), openLink(), colText(), linkedIds() (+15 more)

### Community 14 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, isolatedModules, jsx, lib, module, moduleResolution, noEmit, noUnusedLocals (+11 more)

### Community 15 - "confirm.tsx"
Cohesion: 0.24
Nodes (10): ConfirmFn, ConfirmProvider(), Ctx, ConfirmOptions, ConfirmTone, resolveConfirm(), TONES, ToneStyle (+2 more)

### Community 16 - "worker/package.json"
Cohesion: 0.12
Nodes (16): @cloudflare/workers-types, devDependencies, @cloudflare/workers-types, typescript, vitest, wrangler, typescript, vitest (+8 more)

### Community 17 - "filter.ts"
Cohesion: 0.21
Nodes (8): DealRow, filterDeals(), ROWS, computeKpis(), isLost(), isWon(), Kpis, upsertRow()

### Community 18 - "date-range.ts"
Cohesion: 0.27
Nodes (8): DATE_PRESETS, dateRange, endOfDay(), startOfDay(), startOfWeek(), NOW, ymd(), DealFilter

### Community 19 - "compilerOptions"
Cohesion: 0.12
Nodes (15): @cloudflare/workers-types, ES2022, src/**/*.ts, test/**/*.ts, vitest/globals, compilerOptions, lib, module (+7 more)

### Community 20 - "columns.ts"
Cohesion: 0.20
Nodes (12): CONTACT_COLS, SUB_COLS, blank(), boardRelationValue(), DealClears, DealForm, dealFormToColumnValues(), deliberateClears() (+4 more)

### Community 21 - "LineItemForm.tsx"
Cohesion: 0.27
Nodes (12): computeTotals(), isNumeric(), LI_FIELDS, LiField, LiFieldType, LineItemFormValues, num(), base (+4 more)

### Community 22 - "CompanyDrawer.tsx"
Cohesion: 0.11
Nodes (24): COMPANY_BOARD, COMPANY_COLS, COMPANY_ID_COL, COMPANY_REL_CONTACT, CONTACT_BOARD, CONTACT_ID_COL, CONTACT_REL_COMPANY, CONTACT_REL_DEAL (+16 more)

### Community 23 - "useBoard.ts"
Cohesion: 0.11
Nodes (23): ColSpec, DEAL_COLS, columnLabels(), KIND_TO_MONDAY_TYPE, SchemaResult, OK_COLS, OK_GROUPS, validateBoardSchema() (+15 more)

### Community 24 - "session.ts"
Cohesion: 0.26
Nodes (8): b64urlToBytes(), bytesToB64url(), claim(), SessionVerdict, timingSafeEq(), verifySessionToken(), b64url(), sign()

### Community 25 - "contact-company-props.ts"
Cohesion: 0.44
Nodes (7): COMPANY_ENUM_PROPS, COMPANY_WRITE_PROPS, CONTACT_ENUM_PROPS, CONTACT_WRITE_PROPS, pick(), pickWritableCompanyProps(), pickWritableContactProps()

### Community 26 - "monday_smoke_test.py"
Cohesion: 0.60
Nodes (4): load_optional_columns(), main(), monday_query(), Return monday_columns from config.json if present and configured with a real…

### Community 27 - "sort.ts"
Cohesion: 0.32
Nodes (4): num(), sortDeals(), SortKey, rows

### Community 32 - "associations.ts"
Cohesion: 0.12
Nodes (36): clearsFromEmpty(), LI_CALCULATED, resolvedAllIds(), reverseAssociations(), reverseLineItems(), sameSet(), shrinksFreshCard(), syncAssociations() (+28 more)

### Community 33 - "Component Information"
Cohesion: 0.06
Nodes (31): Account Management, app component, app-event, app-function, app-object, Available Actions for Card Components, Available Hooks for Card Components, card (+23 more)

### Community 34 - "Component Information"
Cohesion: 0.06
Nodes (31): Account Management, app component, app-event, app-function, app-object, Available Actions for Card Components, Available Hooks for Card Components, card (+23 more)

### Community 35 - "app-routes.ts"
Cohesion: 0.12
Nodes (28): AssocReq, CLEARABLE_DEAL_PROPS, ClearDealReq, CreateCompanyReq, CreateContactReq, CreateLineItemReq, DealReq, FROM_OK (+20 more)

### Community 36 - "PHASE 4 — App UI"
Cohesion: 0.08
Nodes (24): Deal Cockpit v2 (UX upgrade) Implementation Plan, PHASE 1 — Worker: archive-deal endpoint, PHASE 2 — App pure libs (TDD), PHASE 3 — App data layer, PHASE 4 — App UI, PHASE 5 — Deploy + verify, Self-Review Notes, Task 10: useBoard — company/contact names, groupId, refresh-on-focus (+16 more)

### Community 37 - "PHASE 2 — monday "Deal Cockpit" React app"
Cohesion: 0.09
Nodes (21): Board / HubSpot constants (single source of truth for the app), monday "Deal Cockpit" App — Implementation Plan, PHASE 1 — Worker backend, PHASE 2 — monday "Deal Cockpit" React app, Self-Review Notes, Task 10: monday API client + session-token bootstrap, Task 11: Worker client (session-token calls), Task 12: App state hook — load context, validate schema, load deals (+13 more)

### Community 38 - "Deal Cockpit v3.4 — Standalone + Contextual Contact/Company Creation — Design"
Cohesion: 0.09
Nodes (21): Architecture, Association (Connect Boards / `board_relation`) columns — ALL EXIST; no new columns are created, Boards + HubSpot-ID columns, Business goal, Component 1 — Durable Object idempotency store (Worker), Component 2 — Owner-mapping resolver (Worker), Component 3 — Search-or-create endpoints (Worker), Component 4 — Generalized entity drawer + header actions (App) (+13 more)

### Community 39 - "PHASE 3 — Drawer shell + tabs"
Cohesion: 0.10
Nodes (19): Deal Cockpit v3.1 — Drawer, editing & instant sync — Implementation Plan, PHASE 1 — Backend + shared libs, PHASE 2 — Picker rework, PHASE 3 — Drawer shell + tabs, PHASE 4 — Deploy + verify, Self-Review Notes, Task 10: `LineItemsTab` (quotation table), Task 11: `SyncTab` (+11 more)

### Community 40 - "create-records.ts"
Cohesion: 0.19
Nodes (14): ActorOwner, OWNER_UNASSIGNED_MESSAGE, NOTE: an Unassigned record has no `sales_user`, and BOTH board specs filter on…, resolveActor(), createContactOrCompany(), CreateInput, hubspotLink(), cardIdOf() (+6 more)

### Community 41 - "Editable Companies + Association Fresh-on-Open Implementation Plan"
Cohesion: 0.12
Nodes (16): Editable Companies + Association Fresh-on-Open Implementation Plan, File structure, Self-review checklist (run after all tasks), Task 10: App — editable CompanyDrawer, Task 11: App — CompaniesView passes users + onSaved, Task 12: App — horizontal table scroll + any picker styles, Task 13: Deploy worker + end-to-end verification, Task 1: Worker — company owner reverse + deals in associations/search (+8 more)

### Community 42 - "HubSpot ↔ monday Two-Way Sync Worker — Design Spec"
Cohesion: 0.12
Nodes (16): Architecture, Board & field mapping reference (discovered), Components (small, independently testable modules), Context, Dedup, Error handling, Goals, HubSpot ↔ monday Two-Way Sync Worker — Design Spec (+8 more)

### Community 43 - "monday "Deal Cockpit" app (Board View) — Design"
Cohesion: 0.12
Nodes (16): Architecture, Auth (Worker verification of the session token), Backend work (Worker) — NOT "no change", Board View screens (v1), Column map (Deals board 5029480547), Confirmed decisions, Create/Edit robustness (hard requirements), Data access (+8 more)

### Community 44 - "Deal Cockpit — Editable Companies + Association Fresh-on-Open (design)"
Cohesion: 0.12
Nodes (16): Contacts — full (board column + HubSpot), Context, Data flow, Deal Cockpit — Editable Companies + Association Fresh-on-Open (design), Deals — HubSpot-only (no board column), Decisions (settled), Editable set (the `COMPANIES_MYLA` `reverse: true` fields), Goal (+8 more)

### Community 45 - "HubSpot ↔ monday.com API Proof of Concept"
Cohesion: 0.12
Nodes (16): 1. Setup, 2. Run the smoke tests, 3. Finding the ids you need, 4. Testing safely with DRY_RUN, 5. What success looks like, Auto-sync with the watcher (no manual runs), Field mapping (every monday column gets filled), Get your tokens (+8 more)

### Community 46 - "HubSpot ⇄ monday Sync Worker (live)"
Cohesion: 0.12
Nodes (16): Confirming duplicate prevention, Create the monday webhooks, Deploy / secrets, Enabling HubSpot signature validation (safe rollout), ⚠️ Free plan limit, HubSpot ⇄ monday Sync Worker (live), HubSpot webhooks — done via a developer-projects app ✅, Known limitations (+8 more)

### Community 47 - "HubSpot ↔ monday Two-Way Sync Worker — Implementation Plan"
Cohesion: 0.12
Nodes (15): HubSpot ↔ monday Two-Way Sync Worker — Implementation Plan, Self-Review Notes, Task 10: `sync.ts` orchestrator + `index.ts` entrypoints, Task 11: Deploy, secrets, and dry-run verification (deals first), Task 12: Companies + contacts dry-run, then live backfill, Task 13: Cutover to live cron + docs, Task 1: Discovery — sales_user values, contact/company properties, lead-status options, Task 2: Add "HubSpot ID" number columns to Company + Contact boards (+7 more)

### Community 48 - "Deal Cockpit v2 — UX upgrade (sole sales interface)"
Cohesion: 0.12
Nodes (15): 1. Table gaps (🔴), 2. Kanban pipeline view, 3. Speed & freshness, 4. Richer line items, 5. Create net-new contacts / companies (not just attach existing), 6. Surface errors (stop silent failures), 7. Input validation, 8. Line-item totals + KPI currency clarity (+7 more)

### Community 49 - "Deal Cockpit v3.2 — Friendly Save Flow, Feedback & UI Polish + Regression Audit"
Cohesion: 0.12
Nodes (15): 1. Problem, 2.1 Required behavior (from the user), 2.2 Split of responsibilities, 2.3 Pure, testable core, 2.4 Shared row builder, 2.5 Kanban consistency, 2. Save & sync flow (the core change), 3. Loading & feedback (+7 more)

### Community 50 - "Design"
Cohesion: 0.12
Nodes (15): 1. Two spec flags (company-scoped, so contacts/deals are untouched), 2. Spec-aware scope, 3. Incremental drops the gate for `includeAll` specs, 4. Full reconcile skips `skipFullReconcile` specs, 5. List-API pagination helper, 6. Bulk-import endpoint (drives the one-time load through the real card path), 7. Import driver (`scratchpad/import-companies.cjs`), 8. Ongoing (+7 more)

### Community 51 - "Deal Cockpit — Companies Tab (design)"
Cohesion: 0.12
Nodes (15): Architecture, Companies list screen (`CompaniesView`), Company detail (`CompanyDrawer`, reuses `DrawerShell`), Context, Create-deal-from-company / contact flow, Data, freshness, errors, Deal Cockpit — Companies Tab (design), Decisions (settled during brainstorming) (+7 more)

### Community 52 - "Deal Cockpit — Tab Filters + Fast Tab Switching (design)"
Cohesion: 0.12
Nodes (15): App, Context, Deal Cockpit — Tab Filters + Fast Tab Switching (design), Decisions (settled), File structure, Goal, New: `GET /app/owners`, Non-goals (v1) (+7 more)

### Community 53 - "Assoc"
Cohesion: 0.20
Nodes (9): hubspotRecordUrl(), debounceLatest(), SearchResponse, useDebouncedSearch(), Assoc, mergeAssociatedCompanies(), AssociationPicker(), Props (+1 more)

### Community 54 - "Architecture"
Cohesion: 0.13
Nodes (14): 1. Connect Boards columns (created once via a 2025-10 API script), 2. Link sync (built), 3. Config: relationCol replaces text col, 4. Instant on change (new webhooks), 5. Backfill, 6. Safety / edge cases, 7. Testing, Architecture (+6 more)

### Community 55 - "Deal Cockpit v3.1 — Drawer, editing & instant sync"
Cohesion: 0.13
Nodes (14): Architecture — the drawer, Associations tab — the fixed picker, Context, Deal Cockpit v3.1 — Drawer, editing & instant sync, Decisions (confirmed), Discount % — mechanics, Files, Instant sync — `POST /app/sync-deal` (+6 more)

### Community 56 - "Created Date columns + Company domain gate — Design"
Cohesion: 0.13
Nodes (14): Behaviour, Board / column state, Cleanup, Column reuse rule, Created Date columns + Company domain gate — Design, Explicitly out of scope, Goal, Part 1 — Created Date (+6 more)

### Community 57 - "syncMondayItem"
Cohesion: 0.31
Nodes (15): getRecord(), propertiesForSpec(), findItemByColumn(), getItem(), actionOf(), deleteHubspotObject(), emptyStats(), findLinkedDealItem() (+7 more)

### Community 58 - "Deal Cockpit v3.2 — Friendly Save Flow, Feedback & UI Polish Implementation Plan"
Cohesion: 0.14
Nodes (13): Deal Cockpit v3.2 — Friendly Save Flow, Feedback & UI Polish Implementation Plan, File Structure, Self-Review, Task 10: Deploy + full regression audit, Task 1: `syncDeal` returns the Worker's success boolean, Task 2: `confirmSynced` pure helper (TDD), Task 3: `upsertRow` pure helper (TDD), Task 4: `useBoard` — shared row builder, `syncing`, `patchRow`, `finishSave` (+5 more)

### Community 59 - "Companies Tab Implementation Plan"
Cohesion: 0.14
Nodes (13): Companies Tab Implementation Plan, File structure, Self-review checklist (run after implementing all tasks), Task 10: Deploy + end-to-end verification, Task 1: Worker pure helpers — `companySearchBody` + `mapCompanyResult`, Task 2: Worker `listCompanies` + `GET /app/companies` route, Task 3: Worker `/app/associations` contacts → email + title, Task 4: App worker-client — `Company`/`CompanyContact` + `listCompanies` + `getCompanyContacts` (+5 more)

### Community 60 - "Tab Filters + Fast Tab Switching Implementation Plan"
Cohesion: 0.14
Nodes (13): File structure, Self-review checklist (run after implementing all tasks), Tab Filters + Fast Tab Switching Implementation Plan, Task 10: Deploy worker + end-to-end verification, Task 1: Date-range engine (`lib/date-range.ts`), Task 2: Deals client-side create-date filter (`lib/filter.ts`), Task 3: Worker company filters + owners mapper (`hubspot.ts`), Task 4: Worker `/app/companies` filter params + `GET /app/owners` (+5 more)

### Community 61 - "Editable Contacts Tab — Design"
Cohesion: 0.14
Nodes (13): Component 1 — Contact directory (`listContacts` + `GET /app/contacts`), Component 2 — Editable drawer + reverse, Component 3 — Associations (both two-way + fresh-on-open), Component 4 — Nav tab + routing, Contact model (verified in `CONTACTS_MYLA`, `worker/src/config.ts`), Decisions (locked with the user), Editable Contacts Tab — Design, Editable field map (+5 more)

### Community 62 - "Deals: Single Shared Board + Field Remap Implementation Plan"
Cohesion: 0.15
Nodes (12): Context, Deals: Single Shared Board + Field Remap Implementation Plan, File Structure, Self-Review Notes, Task 1: Discovery — confirm live group ids, columns, and HubSpot property names, Task 2: Delete the two obsolete monday columns, Task 3: Add `noSalesUserGroup` to the GroupBy type and routing, Task 4: Replace the deal specs with one shared `DEALS` spec (+4 more)

### Community 63 - "HubSpot Associations + Line Items → monday Implementation Plan"
Cohesion: 0.15
Nodes (12): File Structure, HubSpot Associations + Line Items → monday Implementation Plan, Self-Review Notes, Task 1: Create the monday columns and capture their ids, Task 2: HubSpot association + batch-read helpers, Task 3: monday subitem helpers, Task 4: Association config types + spec wiring, Task 5: `syncAssociations` (the pass) + orchestration tests (+4 more)

### Community 64 - "Deal Cockpit v3.3 — Phase 2: Two line-item flows + schema-driven manual form + Save-to-library"
Cohesion: 0.15
Nodes (12): Deal Cockpit v3.3 — Phase 2: Two line-item flows + schema-driven manual form + Save-to-library, File Structure, Self-Review, Task 1: Worker prop allowlist + tests (pure), Task 2: Worker `parseCreateLineItemBody` + tests, Task 3: Worker helpers — `createProduct` + `getWritablePropOptions`, Task 4: Worker routes — schema endpoint + create-line-item endpoint, Task 5: App client — `getLineItemSchema` + `createHubspotLineItem` (+4 more)

### Community 65 - "Deal Cockpit v3.4 Phase A — Worker Foundation Implementation Plan"
Cohesion: 0.15
Nodes (12): Deal Cockpit v3.4 Phase A — Worker Foundation Implementation Plan, Notes for the implementer, Task 10: Build gate, deploy, and live verification, Task 1: `normalizeDomain` — pure company-domain normalizer, Task 2: `searchCompanyByDomain` — HubSpot domain dedup lookup, Task 3: Contact/Company writable-prop allowlists + enum lists, Task 4: `resolveActor` — current-rep → HubSpot owner (or Unassigned), Task 5: `parseContactBody` / `parseCompanyBody` request validators (+4 more)

### Community 66 - "HubSpot Associations + Line Items → monday — Design"
Cohesion: 0.15
Nodes (12): Architecture — a separate "associations pass", Constraints / non-goals, Data flow, Goal, HubSpot Associations + Line Items → monday — Design, Line-item subitems (dedup + removal), Logging, monday columns to create (auto-created via the admin token; ids captured into config) (+4 more)

### Community 67 - "Reverse-sync the Sales Users person → HubSpot `sales_user` — Design"
Cohesion: 0.15
Nodes (12): 1. Reverse identity maps (in `ctx`), 2. Read the assigned person id, 3. Reverse rule (reuse the existing diff → direction → patch flow), 4. Group move is automatic, 5. Loop safety, Architecture, Confirmed decisions, Context (+4 more)

### Community 68 - "Sync All Companies — Phase 2 (company→contact associations) — Design"
Cohesion: 0.15
Nodes (12): 1. Contact scope = union (a new, general spec flag), 2. Bulk association run (reuses the association pass), 3. Ongoing, 4. Link direction (decision), Constraints (from Phase 1 + the code), Design, Goal, Non-goals (Phase 2) (+4 more)

### Community 69 - "ContactsView.tsx"
Cohesion: 0.28
Nodes (10): ContactHit, fmtContactDate(), orDash(), DatePreset, AVATAR, avatarFor(), ContactsView(), initials() (+2 more)

### Community 70 - "Deal Cockpit v3.3 — Phase 1: Live Search Freshness & UX Implementation Plan"
Cohesion: 0.17
Nodes (11): Deal Cockpit v3.3 — Phase 1: Live Search Freshness & UX Implementation Plan, Execution Handoff, File Structure, Self-Review, Task 1: Worker returns `total`, richer product results, and no-store, Task 2: `searchHubspot` returns `{items,total}`, trims, no-store, surfaces errors, Task 3: Harden `useDebouncedSearch` (abort-on-clear, sequence guard, total), Task 4: AssociationPicker — search-and-link only, error state, result cap + hint (+3 more)

### Community 71 - "Deal Cockpit v3.4 Phase B — Standalone Creation UI Implementation Plan"
Cohesion: 0.17
Nodes (11): Deal Cockpit v3.4 Phase B — Standalone Creation UI Implementation Plan, Notes for the implementer, Task 1: worker-client — schema fetch + create calls + idempotency key, Task 2: `record-form` — Contact/Company field descriptors + validation + form→properties, Task 3: `create-progress` — result → step-display mapping, Task 4: `DrawerShell` — reusable drawer chrome, Task 5: `CreateProgress` — the step progress UI, Task 6: `RecordDrawer` — the standalone Contact/Company create drawer (+3 more)

### Community 72 - "Created Date columns + Company domain gate — Implementation Plan"
Cohesion: 0.17
Nodes (11): Created Date columns + Company domain gate — Implementation Plan, Notes for the implementer, Task 1: Worker — column listing + creation helpers, behind the temporary diag route, Task 2: Create the two columns and capture their REAL ids, Task 3: Map `createdate` one-way on Companies and Deals, Task 4: `record-form` — the domain gate, Task 5: `RecordForm` — render the checkbox, Task 6: Delete the now-unreachable company confirm (+3 more)

### Community 73 - "Worker /app/search endpoint (live HubSpot picker for the vibe app) — Design"
Cohesion: 0.17
Nodes (11): 1. `GET /app/search` (new Worker route), 2. Product → line item carries `hs_product_id`, 3. Vibe app (prompt update), 4. Scopes (user, on the private/write app), Architecture, Confirmed decisions, Context, Goal (+3 more)

### Community 74 - "monday-first deal creation (vibe app) + reverse association & line-item sync — Design"
Cohesion: 0.17
Nodes (11): 1. The vibe app (built by the user in monday vibe), 2. Reverse association sync (Worker) — additive, set-only, loop-safe, 3. Reverse line-item sync (Worker) — additive, set-only, keyed by Line Item ID, 4. Direction & loop safety, Architecture, Confirmed decisions, Context, Goal (+3 more)

### Community 75 - "Product picker for line items (no new board) — Design"
Cohesion: 0.17
Nodes (11): 1. "Product" single-select dropdown on the subitems board (5029480548), 2. `SubitemSpec.productNameCol`, 3. `reverseLineItems` resolves the picked product, 4. `findProductByName` (hubspot.ts), Architecture, Confirmed decisions, Context, Goal (+3 more)

### Community 76 - "Deal Cockpit v3.0 — Sync correctness (Amount / Currency / Close date)"
Cohesion: 0.17
Nodes (11): Changes, Context, Controlled backfill (added after review), Deal Cockpit v3.0 — Sync correctness (Amount / Currency / Close date), Decisions (confirmed), Files, Known HubSpot-side behaviour (verify live, not a bug in our sync), Out of scope (later rounds) (+3 more)

### Community 77 - "Two-Way Line-Item Sync — Design"
Cohesion: 0.17
Nodes (11): Architecture — three trigger paths, Component 1 — New subitems-board webhook, Component 2 — Per-field ownership on the 9 subitem columns, Component 3 — App-edit path audit (no expected code change), Decisions (locked with the user), Error handling & idempotency, Goal, Out of scope (+3 more)

### Community 78 - "card-registry.ts"
Cohesion: 0.36
Nodes (11): cardStub(), claimCard(), claimHubspotForItem(), finishCard(), finishHubspotForItem(), forgetCard(), forgetHubspotForItem(), itemStub() (+3 more)

### Community 79 - "Sync All Companies — Phase 1 Implementation Plan"
Cohesion: 0.18
Nodes (10): Rollback, Self-Review, Sync All Companies — Phase 1 Implementation Plan, Task 1: Spec flags + spec-aware `recInScope` (TDD), Task 2: Relax the incremental + drop companies from the full sweep, Task 3: List-API pagination helper, Task 4: Bulk-import endpoint, Task 5: Regression check BEFORE importing (safety gate) (+2 more)

### Community 80 - "Editable Contacts Tab Implementation Plan"
Cohesion: 0.18
Nodes (10): Editable Contacts Tab Implementation Plan, Self-review checklist (run after all tasks), Task 1: Worker — contact directory (pure fns + `listContacts`) + config reverse flags, Task 2: Worker — `/app/contacts` + `/app/sync-contact` + `FROM_OK` contacts, Task 3: App — `board-config` CONTACT_COLS + `lib/contact-form.ts` + `lib/contacts.ts`, Task 4: App — worker-client contacts helpers + monday-client findItemByColumn + AssociationPicker deals kind, Task 5: App — editable `ContactDrawer.tsx`, Task 6: App — `ContactsView.tsx` + nav tab + route (+2 more)

### Community 81 - "monday item Update → HubSpot Note (deal/contact/company activity) — Design"
Cohesion: 0.18
Nodes (10): 1. `createNote` (hubspot.ts), 2. `handleMonday` create_update path (webhooks.ts), 3. Subscribe `create_update` on all three boards, Architecture, Confirmed decisions, Context, Goal, monday item Update → HubSpot Note (deal/contact/company activity) — Design (+2 more)

### Community 82 - "Deal Associations + Line Items → Linked on monday (Instant) — Implementation Plan"
Cohesion: 0.20
Nodes (9): Deal Associations + Line Items → Linked on monday (Instant) — Implementation Plan, Self-Review Notes, Task 1: Create the 5 Connect Boards columns via monday API (2025-10), Task 2: Wire relationCol into config, replace the text association columns, Task 3: Deploy + backfill links, verify creation-time links work, Task 4: Worker routing — association-change + line-item events, Task 5: HubSpot app — association-change + line-item subscriptions + reinstall, Task 6: Live end-to-end verification (+1 more)

### Community 83 - "Deal Cockpit v3.4 Phase C — Contextual + Nested Associations Implementation Plan"
Cohesion: 0.20
Nodes (9): Deal Cockpit v3.4 Phase C — Contextual + Nested Associations Implementation Plan, Notes for the implementer, Task 1: `lib/assoc.ts` — the shared Assoc model + a pending-create builder, Task 2: `RecordForm` — extract the reusable record-form body, Task 3: worker-client — createContact/createCompany accept association ids, Task 4: `AssociationSection` — search-existing + "+ New" (create-on-save), Task 5: Deal → Associations uses AssociationSection; save creates pending records, Task 6: Standalone RecordDrawer — optional nested association (link or create) (+1 more)

### Community 84 - "Association Display Cascade + HubSpot Links Implementation Plan"
Cohesion: 0.20
Nodes (9): Association Display Cascade + HubSpot Links Implementation Plan, File Structure, Rollback, Self-Review, Task 1: `linkDisplayName` helper (TDD), Task 2: `hubspotRecordUrl` + name-cascade column ids, Task 3: Apply the cascade in `getItemNames` + `getCardsByIds`, Task 4: Per-chip `↗` HubSpot link in `AssociationPicker` (+1 more)

### Community 85 - "Audit Fixes F1–F4 Implementation Plan"
Cohesion: 0.20
Nodes (9): Audit Fixes F1–F4 Implementation Plan, File Structure, Rollback, Self-Review, Task 1: F1 — Contact first/last name split (TDD), Task 2: F3 — Greedy reverse-dropdown parser (TDD), Task 3: F2 — Owner lookup failure degrades to Unassigned, Task 4: F4 — Surface the worker's error message (+1 more)

### Community 86 - "Worker /app/search endpoint + product line items — Implementation Plan"
Cohesion: 0.22
Nodes (8): Self-Review Notes, Task 1: HubSpot search helper, Task 2: /app/search route (auth + CORS), Task 3: reverseLineItems carries hs_product_id, Task 4: Scopes (USER ACTION), Task 5: Deploy + enable + secrets, Task 6: Vibe app prompt update + full live verify, Worker /app/search endpoint + product line items — Implementation Plan

### Community 87 - "monday-first deal creation: reverse association + line-item sync — Implementation Plan"
Cohesion: 0.22
Nodes (8): monday-first deal creation: reverse association + line-item sync — Implementation Plan, Self-Review Notes, Task 1: HubSpot write helpers, Task 2: Reverse association sync (additive, set-only), Task 3: Deploy + verify reverse associations, Task 4: Enable line-item writes (USER ACTION), Task 5: Reverse line-item sync (id-keyed, additive), Task 6: Deploy + live verify + the vibe app prompt

### Community 88 - "File Structure"
Cohesion: 0.22
Nodes (8): Duplicate Card Cleanup + Created-Date Catch-Up — Implementation Plan, File Structure, Rollback, Root cause (established in Phase 1 — not re-litigated here), Task 1: Delete the 50 duplicate cards, Task 2: Mark one-way columns webhook-ignorable, Task 3: Fill Created date on all three boards, Task 4: Final verification

### Community 89 - "Sync All Companies — Phase 2 (associations) Implementation Plan"
Cohesion: 0.22
Nodes (8): Rollback, Self-Review, Sync All Companies — Phase 2 (associations) Implementation Plan, Task 1: Contact scope union (TDD), Task 2: Bulk association endpoint, Task 3: Regression gate BEFORE the run, Task 4: Bulk association run, Task 5: Verify

### Community 90 - "Two-Way Line-Item Sync Implementation Plan"
Cohesion: 0.22
Nodes (8): Self-review checklist (run after all tasks), Task 1: Reverse-patch decision (pure) + per-field `reverse` flags, Task 2: `getParentItemId` helper + `reverseSubitemEdit` handler, Task 3: Route subitem-board webhooks to `reverseSubitemEdit`, Task 4: Register the subitems-board webhook (one-time ops), Task 5: Audit the app-edit line-item path (Component 3), Task 6: Deploy + live verification, Two-Way Line-Item Sync Implementation Plan

### Community 91 - "Audit Fixes F1–F4 — Design"
Cohesion: 0.22
Nodes (8): Audit Fixes F1–F4 — Design, F1 — Contact first/last name split is dead code, F2 — Owner-resolution failure blocks a Contact/Company create, F3 — Reverse-dropdown comma split is fragile, F4 — Worker errors surface as a bare HTTP status, Non-goals, Scope, Testing summary

### Community 92 - "Auto-associate Contact → Company in the Deal Form — Design"
Cohesion: 0.22
Nodes (8): App — auto-stage on contact add, Auto-associate Contact → Company in the Deal Form — Design, Data flow, Design, Non-goals, Problem, Testing, Worker — a read endpoint for associations

### Community 93 - "Deal Form Field Cardinality — Design"
Cohesion: 0.22
Nodes (8): Deal Form Field Cardinality — Design, Design, Non-goals, Problem, Rejected alternatives, Scope boundary, Testing, Verified facts (measured against the live systems, deals only)

### Community 94 - "HubSpot Projects"
Cohesion: 0.22
Nodes (8): Adding Features to your app, Documentation, Getting Started, HubSpot Projects, Next Steps, Overview, Project Structure, Resources

### Community 95 - "Reverse-sync Sales Users → HubSpot `sales_user` — Implementation Plan"
Cohesion: 0.25
Nodes (7): Reverse-sync Sales Users → HubSpot `sales_user` — Implementation Plan, Self-Review Notes, Task 1: Reverse identity maps in ctx, Task 2: Carry people-column person ids on MondayItem, Task 3: People reverse in the diff/patch flow, Task 4: Mark Sales Users reversible on all three boards, Task 5: Deploy + live verification

### Community 96 - "monday Update → HubSpot Note — Implementation Plan"
Cohesion: 0.25
Nodes (7): monday Update → HubSpot Note — Implementation Plan, Self-Review Notes, Task 1: createNote + getUserById helpers, Task 2: handleMonday create_update path, Task 3: Deploy, Task 4: Subscribe create_update on all three boards, Task 5: Live verify

### Community 97 - "Product dropdown for line items (no new board) — Implementation Plan"
Cohesion: 0.25
Nodes (7): Product dropdown for line items (no new board) — Implementation Plan, Self-Review Notes, Task 1: Create + seed the "Product" dropdown on the subitems board, Task 2: findProductByName helper, Task 3: SubitemSpec.productNameCol + config, Task 4: reverseLineItems resolves the product (id, then name), Task 5: Deploy + live verify

### Community 98 - "Deal Cockpit v3.0 — Sync correctness Implementation Plan"
Cohesion: 0.25
Nodes (7): Deal Cockpit v3.0 — Sync correctness Implementation Plan, Self-Review Notes, Task 1: Reverse Amount / Currency / Close date (TDD, real DEALS spec), Task 1b: Controlled deals-only backfill of empty HubSpot values (TDD), Task 2: Remove the dead Pipeline field from the form, Task 3: Surface a failed monday line-item delete, Task 4: Deploy + live verification

### Community 99 - "Deal Cockpit v3.3 — Phase 3: Fresh-on-open line items + Refresh + guards"
Cohesion: 0.25
Nodes (7): Deal Cockpit v3.3 — Phase 3: Fresh-on-open line items + Refresh + guards, File Structure, Self-Review, Task 1: Worker — `getDealLineItems` + route, Task 2: App client + pure merge + nit-fixes, Task 3: DealDrawer fresh-on-open + LineItemsEditor Refresh button + guard, Task 4: LineItemForm nit + verify + deploy

### Community 100 - "Auto-associate Contact → Company Implementation Plan"
Cohesion: 0.25
Nodes (7): Auto-associate Contact → Company Implementation Plan, Rollback, Self-Review, Task 1: `mergeAssociatedCompanies` helper (TDD), Task 2: Worker `/app/associations` read endpoint, Task 3: App — fetch + auto-stage on contact add, Task 4: Deploy + verify

### Community 101 - "Deal Form Field Cardinality — Implementation Plan"
Cohesion: 0.25
Nodes (7): Deal Form Field Cardinality — Implementation Plan, File Structure, Out of scope (recorded, not actioned), Rollback, Task 1: Lock the write path with a test, Task 2: Swap Sales Users to a single-select, Task 3: Deploy and verify

### Community 102 - "Deploy the Deal Cockpit Board View"
Cohesion: 0.25
Nodes (7): Add to a board, Build + push (monday-hosted), Deploy the Deal Cockpit Board View, Notes, OAuth scopes (Developer Center > OAuth), Secrets — confirmed values (do NOT commit these), Worker secrets (set once, then `wrangler deploy`)

### Community 103 - "Phone Country Fix + Backfill — Design"
Cohesion: 0.29
Nodes (6): Fix, Non-goals, Phone Country Fix + Backfill — Design, Problem, Testing, Verified monday behaviour (tested live on the card)

### Community 104 - "Phone Country Fix + Backfill Implementation Plan"
Cohesion: 0.33
Nodes (5): Phone Country Fix + Backfill Implementation Plan, Rollback, Self-Review, Task 1: Fix the `phone` case in `formatValue` (TDD), Task 2: Backfill existing contact phones

### Community 105 - "Association Display Cascade + HubSpot Links — Design"
Cohesion: 0.33
Nodes (5): Association Display Cascade + HubSpot Links — Design, Feature A — smart display-name cascade, Feature B — open a linked contact/company in HubSpot, Non-goals, Testing

### Community 106 - "App.tsx"
Cohesion: 0.60
Nodes (3): App(), monday, useBoard()

## Knowledge Gaps
- **864 isolated node(s):** `name`, `private`, `type`, `dev`, `build` (+859 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `f()` connect `sync.ts` to `associations.ts`, `index.ts`, `RecordDrawer.tsx`, `app-routes.ts`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `grouped()` connect `RecordDrawer.tsx` to `sync.ts`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `fetch()` connect `index.ts` to `associations.ts`, `app-routes.ts`, `sync.ts`, `webhooks.ts`, `create-records.ts`, `backfill.ts`, `syncMondayItem`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `name`, `private`, `type` to the rest of the system?**
  _864 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09853249475890985 - nodes in this community are weakly interconnected._
- **Should `owner_router_test.py` be split into smaller, more focused modules?**
  _Cohesion score 0.06101190476190476 - nodes in this community are weakly interconnected._
- **Should `RecordDrawer.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.08192090395480225 - nodes in this community are weakly interconnected._