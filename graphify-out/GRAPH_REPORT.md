# Graph Report - .  (2026-08-03)

## Corpus Check
- 196 files · ~196,864 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 808 nodes · 2115 edges · 32 communities (30 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.77)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Worker Sync Core
- Python Owner-Router POC
- Contact/Company Create Forms
- Record Reconcile & Mapping
- Webhooks & Sync Config
- App Dependencies
- Monday GraphQL Client
- Card Registry & Idempotency
- Kanban & Stage Grouping
- Line Items & Search Picker
- Companies Tab
- Deals Board View
- App to Worker Client
- Deal Drawer & Form
- App TS Config
- App Shell & Confirm Dialog
- Worker Dependencies
- Deal Filters & KPIs
- Date-Range Filters
- Worker TS Config
- Column Mapping & Line Items
- Line Item Form
- Board Config & IDs
- useBoard State Hook
- Session Token Auth
- Contact/Company Prop Allowlists
- Python Monday Smoke Test
- Sort Tests
- Python HubSpot Smoke Test

## God Nodes (most connected - your core abstractions)
1. `fetch()` - 45 edges
2. `hs()` - 25 edges
3. `api()` - 19 edges
4. `colText()` - 19 edges
5. `DealDrawer()` - 18 edges
6. `call()` - 18 edges
7. `ensureCardForRecord()` - 18 edges
8. `reconcileRecord()` - 18 edges
9. `syncMondayItem()` - 18 edges
10. `BoardView()` - 16 edges

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

## Communities (32 total, 2 thin omitted)

### Community 0 - "Worker Sync Core"
Cohesion: 0.05
Nodes (122): AssocReq, CLEARABLE_DEAL_PROPS, ClearDealReq, CreateCompanyReq, CreateContactReq, CreateLineItemReq, DealReq, FROM_OK (+114 more)

### Community 1 - "Python Owner-Router POC"
Cohesion: 0.06
Nodes (60): Adds a 'HubSpot ID' numbers column to the Company and Contact boards (dedup…, build_column_values(), build_context(), build_stage_to_group(), configured_owner_ids(), create_item(), deal_properties(), fetch_deals() (+52 more)

### Community 2 - "Contact/Company Create Forms"
Cohesion: 0.08
Nodes (47): useConfirm(), Assoc, buildCreateAssoc(), isPendingCreate(), mergeAssociatedCompanies(), attemptCreate(), CREATE_STEPS, isComplete() (+39 more)

### Community 3 - "Record Reconcile & Mapping"
Cohesion: 0.08
Nodes (45): ActorOwner, OWNER_UNASSIGNED_MESSAGE, NOTE: an Unassigned record has no `sales_user`, and BOTH board specs filter on…, resolveActor(), CreateInput, hubspotLink(), EnsureCard, buildColumnValues() (+37 more)

### Community 4 - "Webhooks & Sync Config"
Cohesion: 0.05
Nodes (46): ALL_MEMBERS_TEAM_ID, ALL_SPECS, COMPANIES_MYLA, COMPANY_ID_COL, CONTACT_ID_COL, CONTACTS_MYLA, CREATE_CUTOFF_MS, CREATED_AFTER_MS (+38 more)

### Community 5 - "App Dependencies"
Cohesion: 0.06
Nodes (34): dependencies, monday-sdk-js, react, react-dom, react-router-dom, @vibe/core, @vibe/icons, devDependencies (+26 more)

### Community 6 - "Monday GraphQL Client"
Cohesion: 0.14
Nodes (23): apiErrorDetail(), apiErrorMessage(), linkDisplayName(), api(), createDeal(), createSubitem(), Ctx, deleteItem() (+15 more)

### Community 7 - "Card Registry & Idempotency"
Cohesion: 0.13
Nodes (17): cardStub(), claimCard(), claimHubspotForItem(), finishCard(), finishHubspotForItem(), forgetCard(), forgetHubspotForItem(), itemStub() (+9 more)

### Community 8 - "Kanban & Stage Grouping"
Cohesion: 0.15
Nodes (18): ColSpec, UNASSIGNED_GROUP, columnLabels(), KIND_TO_MONDAY_TYPE, SchemaResult, OK_COLS, OK_GROUPS, validateBoardSchema() (+10 more)

### Community 9 - "Line Items & Search Picker"
Cohesion: 0.16
Nodes (16): debounceLatest(), SearchResponse, useDebouncedSearch(), mergeLineItems(), lineItemsTotal(), lineTotal(), n(), TotalInput (+8 more)

### Community 10 - "Companies Tab"
Cohesion: 0.20
Nodes (16): buildDealSeed(), fmtCompanyDate(), fmtNumber(), NewDealSeed, orDash(), AVATAR, avatarFor(), CompaniesView() (+8 more)

### Community 11 - "Deals Board View"
Cohesion: 0.16
Nodes (17): hubspotDealUrl(), num(), sortDeals(), SortKey, AVATAR, avatarFor(), Badge(), BoardView() (+9 more)

### Community 12 - "App to Worker Client"
Cohesion: 0.18
Nodes (20): archiveHubspotDeal(), call(), clearDealFields(), createCompany(), createContact(), createHubspotLineItem(), deleteHubspotAssociation(), deleteHubspotLineItem() (+12 more)

### Community 13 - "Deal Drawer & Form"
Cohesion: 0.18
Nodes (16): DealErrors, validateDealForm(), colText(), linkedIds(), peopleIds(), rawItemToRow(), toRow(), DealDrawer() (+8 more)

### Community 14 - "App TS Config"
Cohesion: 0.10
Nodes (19): compilerOptions, isolatedModules, jsx, lib, module, moduleResolution, noEmit, noUnusedLocals (+11 more)

### Community 15 - "App Shell & Confirm Dialog"
Cohesion: 0.18
Nodes (13): App(), monday, ConfirmFn, ConfirmProvider(), Ctx, ConfirmOptions, ConfirmTone, resolveConfirm() (+5 more)

### Community 16 - "Worker Dependencies"
Cohesion: 0.12
Nodes (16): @cloudflare/workers-types, devDependencies, @cloudflare/workers-types, typescript, vitest, wrangler, typescript, vitest (+8 more)

### Community 17 - "Deal Filters & KPIs"
Cohesion: 0.21
Nodes (8): DealRow, filterDeals(), ROWS, computeKpis(), isLost(), isWon(), Kpis, upsertRow()

### Community 18 - "Date-Range Filters"
Cohesion: 0.21
Nodes (11): DATE_PRESETS, DatePreset, dateRange, endOfDay(), startOfDay(), startOfWeek(), NOW, ymd() (+3 more)

### Community 19 - "Worker TS Config"
Cohesion: 0.12
Nodes (15): @cloudflare/workers-types, ES2022, src/**/*.ts, test/**/*.ts, vitest/globals, compilerOptions, lib, module (+7 more)

### Community 20 - "Column Mapping & Line Items"
Cohesion: 0.22
Nodes (13): DEAL_COLS, SUB_COLS, blank(), boardRelationValue(), DealClears, DealForm, dealFormToColumnValues(), deliberateClears() (+5 more)

### Community 21 - "Line Item Form"
Cohesion: 0.27
Nodes (12): computeTotals(), isNumeric(), LI_FIELDS, LiField, LiFieldType, LineItemFormValues, num(), base (+4 more)

### Community 22 - "Board Config & IDs"
Cohesion: 0.15
Nodes (12): COMPANY_BOARD, COMPANY_ID_COL, CONTACT_BOARD, CONTACT_ID_COL, DEALS_BOARD, HS_OBJ, HUBSPOT_PORTAL_ID, hubspotRecordUrl() (+4 more)

### Community 23 - "useBoard State Hook"
Cohesion: 0.24
Nodes (11): confirmSynced(), SavedInfo, SyncStatus, AccountUser, BoardMeta, getContext(), RawItem, BoardState (+3 more)

### Community 24 - "Session Token Auth"
Cohesion: 0.26
Nodes (8): b64urlToBytes(), bytesToB64url(), claim(), SessionVerdict, timingSafeEq(), verifySessionToken(), b64url(), sign()

### Community 25 - "Contact/Company Prop Allowlists"
Cohesion: 0.44
Nodes (7): COMPANY_ENUM_PROPS, COMPANY_WRITE_PROPS, CONTACT_ENUM_PROPS, CONTACT_WRITE_PROPS, pick(), pickWritableCompanyProps(), pickWritableContactProps()

### Community 26 - "Python Monday Smoke Test"
Cohesion: 0.60
Nodes (4): load_optional_columns(), main(), monday_query(), Return monday_columns from config.json if present and configured with a real…

## Knowledge Gaps
- **158 isolated node(s):** `name`, `private`, `type`, `dev`, `build` (+153 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `f()` connect `Record Reconcile & Mapping` to `Worker Sync Core`, `Contact/Company Create Forms`?**
  _High betweenness centrality (0.318) - this node is a cross-community bridge._
- **Why does `grouped()` connect `Contact/Company Create Forms` to `Record Reconcile & Mapping`?**
  _High betweenness centrality (0.318) - this node is a cross-community bridge._
- **Why does `fetch()` connect `Worker Sync Core` to `Record Reconcile & Mapping`, `Webhooks & Sync Config`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **What connects `name`, `private`, `type` to the rest of the system?**
  _158 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Worker Sync Core` be split into smaller, more focused modules?**
  _Cohesion score 0.05377079061289588 - nodes in this community are weakly interconnected._
- **Should `Python Owner-Router POC` be split into smaller, more focused modules?**
  _Cohesion score 0.06101190476190476 - nodes in this community are weakly interconnected._
- **Should `Contact/Company Create Forms` be split into smaller, more focused modules?**
  _Cohesion score 0.07738095238095238 - nodes in this community are weakly interconnected._