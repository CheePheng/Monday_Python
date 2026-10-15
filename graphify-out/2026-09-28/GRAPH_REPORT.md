# Graph Report - Monday_Python-crm  (2026-09-24)

## Corpus Check
- 447 files · ~1,988,351 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3798 nodes · 6895 edges · 235 communities (213 shown, 18 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 14 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b33a3253`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.ts
- owner_router_test.py
- RecordDrawer.tsx
- Handoff — HubSpot ↔ monday CRM two-way sync (Phase 1: Contacts + Accounts)
- reconcile.ts
- monday-app/package.json
- monday-client.ts
- card-registry.ts
- config.ts
- LineItemsEditor.tsx
- crm.ts
- activity-retry.ts
- CompanyDrawer.tsx
- sync.ts
- compilerOptions
- crm-associations.test.ts
- worker/package.json
- useBoard.ts
- CompaniesView.tsx
- compilerOptions
- BoardView.tsx
- LineItemForm.tsx
- ContactDrawer.tsx
- dedupe-timeline.mjs
- session.ts
- refresh-forward.mjs
- monday_smoke_test.py
- catchup-after-deploy.mjs
- hubspot_smoke_test.py
- HubSpot ↔ monday CRM — Phase 1 Implementation Plan (v3)
- hubspot.ts
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
- resync-people-columns.mjs
- Architecture
- Deal Cockpit v3.1 — Drawer, editing & instant sync
- Created Date columns + Company domain gate — Design
- webhooks.ts
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
- backfill-activities.mjs
- Deal Cockpit v3.3 — Phase 1: Live Search Freshness & UX Implementation Plan
- Deal Cockpit v3.4 Phase B — Standalone Creation UI Implementation Plan
- Created Date columns + Company domain gate — Implementation Plan
- Worker /app/search endpoint (live HubSpot picker for the vibe app) — Design
- monday-first deal creation (vibe app) + reverse association & line-item sync — Design
- Product picker for line items (no new board) — Design
- Deal Cockpit v3.0 — Sync correctness (Amount / Currency / Close date)
- Two-Way Line-Item Sync — Design
- backfill-crm.mjs
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
- ObjectSpec
- mapping.ts
- register-subitem-webhook.mjs
- AGENTS.md
- CLAUDE.md
- monday-vibe-app-backend-context.md
- monday-vibe-deal-app-prompt.md
- DealDrawer.tsx
- verify-deals-migration.mjs
- email-repair.test.ts
- recount-canonical-emails.mjs
- Phase 0 — monday CRM board schema audit
- H. Task 5 — EXECUTED 2026-09-07. Both boards: 27 columns, 0 items.
- fix-restore-races.ts
- Env
- reverse-sync.test.ts
- activity-registry.ts
- task-poller.ts
- inventory-email-entries.mjs
- migrate-people-column.mjs
- create-progress.ts
- classify-twin-accounts.mjs
- plan-email-cleanup.mjs
- cleanup-classify.mjs
- column-level-reverse.test.ts
- Historical Activity import — completion report
- How the monday CRM ↔ HubSpot sync works
- post-disable-baseline.mjs
- report-idless-corrected.mjs
- audit-created-companies.mjs
- canary-relations.mjs
- inventory-idless-companies.mjs
- probe-notwin-domains.mjs
- undo-aborted-deals-import.mjs
- activity-sync.ts
- Phase 2 audit — Deals, Line Items, Activities
- hubspot-crm-webhook-sync — HubSpot project app for the monday CRM sync
- canary-deals.mjs
- cleanup-apply.mjs
- verify-crm-import.mjs
- Contacts assignment + permissions — complete
- audit-deals-phase.mjs
- manifest-v2.mjs
- measure-assignment-crosstab.mjs
- resync-crm-records.mjs
- repair-phantom-status.mjs
- types.ts
- canary-preflight.mjs
- check-dangling-links.mjs
- measure-assignment-fields.mjs
- run-until-done.mjs
- trace-company-origin.mjs
- Deal stage mapping — the decision that gates the Deals spec
- cleanup-fake-company.mjs
- retire-sales-person-columns.mjs
- activity-owner-reset.test.ts
- activity-participants.test.ts
- Contacts ↔ Companies — sign-off report
- Deals + Line Items — implementation design
- Phase B rollout — how to exercise the CRM sync given the inert cutover
- measure-deal-associations.mjs
- measure-relation-cells.mjs
- supervise-migration.mjs
- verify-coarse-stages.mjs
- line-item-dispatch.test.ts
- CRM HubSpot runtime app + Worker secrets — prepared, NOT created
- add-crm-columns.mjs
- backfill-sales-user-people.mjs
- build-deals-schema.mjs
- measure-assoc-truncation.mjs
- plan-synthetic-cleanup.mjs
- read-source.mjs
- line-item-create.test.ts
- complete-sales-user-labels.mjs
- dedupe-crm-cards.mjs
- diagnose-accounts-adoption.mjs
- preview-email-localparts.mjs
- reconcile-counts.mjs
- reconcile-orphan-accounts.mjs
- Ctx
- rename-placeholder-cards.mjs
- wm-guard-impact.mjs
- wm-guard-landing.mjs
- read-wrangler.mjs
- reverse-enabled-batch.test.ts
- confirm.ts
- batch3-fixes.test.ts
- deal-routing-deployment.test.ts
- deals-import-baseline.mjs
- find-duplicate-cards.mjs
- preview-company-names.mjs
- preview-numeric-names.mjs
- wm-guard-preflight.mjs
- activity-email-body.test.ts
- activity-marker-pagination.test.ts
- specs-vs-scopes.test.ts
- PRODUCTION FOLLOW-UP — WM contacts `scopeAlsoLinkedProp` looks dead
- 2026-09-17-crm-column-audit-table.md
- add-sidebar-columns.mjs
- audit-crm-column-types.mjs
- check-hubspot-properties.mjs
- check-post-disable.mjs
- convert-sales-user-dropdown.mjs
- direction-table.mjs
- repoint-crm-webhooks.mjs
- verify-crm-columns.mjs
- activity-stale-reservation.test.ts
- apply-mapping-sheet.mjs
- create-crm-columns.mjs
- dump-crm-columns.mjs
- preview-contact-names.mjs
- Subscriptions
- remove-duplicate-crm-columns.mjs
- update-mapping-tests.mjs
- verify-spec-columns-exist.mjs
- association-via.test.ts
- check-hubspot-scopes.mjs
- company-name-to-relation.mjs
- convert-vendors-dropdown.mjs
- read-app-scopes.d.mts
- rename-crm-columns.mjs
- probe-activity-source.mjs
- retire-sales-person-columns.d.mts
- .mcp.json
- read-wrangler.d.mts
- register-crm-webhooks.d.mts
- relation-plan.d.mts

## God Nodes (most connected - your core abstractions)
1. `fetch()` - 68 edges
2. `Env` - 58 edges
3. `hs()` - 42 edges
4. `ObjectSpec` - 38 edges
5. `HsRecord` - 31 edges
6. `syncHubspotActivity()` - 28 edges
7. `Ctx` - 28 edges
8. `CRM_CONTACTS` - 27 edges
9. `fieldDiffs()` - 27 edges
10. `Handoff — HubSpot ↔ monday CRM two-way sync (Phase 1: Contacts + Accounts)` - 27 edges

## Surprising Connections (you probably didn't know these)
- `test_match_by_email()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py
- `test_match_by_name_when_no_id_or_email()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py
- `test_match_by_owner_id()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py
- `test_unmapped_owner_returns_none()` --calls--> `match_owner_config()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py
- `test_format_date_truncates_to_day()` --calls--> `format_column_value()`  [EXTRACTED]
  tests/test_routing.py → owner_router_test.py

## Import Cycles
- None detected.

## Communities (235 total, 18 thin omitted)

### Community 0 - "index.ts"
Cohesion: 0.08
Nodes (46): activityRetryBound(), parseSyncContactBody(), CreateInput, archiveDeal(), assertMayWrite(), assertMayWriteLineItem(), companySearchBody(), createLineItem() (+38 more)

### Community 1 - "owner_router_test.py"
Cohesion: 0.06
Nodes (60): Adds a 'HubSpot ID' numbers column to the Company and Contact boards (dedup…, build_column_values(), build_context(), build_stage_to_group(), configured_owner_ids(), create_item(), deal_properties(), fetch_deals() (+52 more)

### Community 2 - "RecordDrawer.tsx"
Cohesion: 0.11
Nodes (34): Assoc, buildCreateAssoc(), isPendingCreate(), mergeAssociatedCompanies(), attemptCreate(), hintQuery(), loadDuplicateHints(), SearchFn (+26 more)

### Community 3 - "Handoff — HubSpot ↔ monday CRM two-way sync (Phase 1: Contacts + Accounts)"
Cohesion: 0.04
Nodes (48): 0. Phase 1 scope — fixed, 10. Controlled rollout, 11. Phase 0 — board schema audit before any sync code, 12. The eight demo rows — explicit decision required, 13. CRM-specific create cutoff — required safeguard, 14. Contact creation / adoption, 15. Company / Account creation / adoption, 16. Two-way update rules (+40 more)

### Community 4 - "reconcile.ts"
Cohesion: 0.10
Nodes (25): unapplyScale(), applyStagePipelinePairing(), BACKFILL_OBJECTS, buildCreateProperties(), buildReversePatch(), buildUpdatePayload(), columnEditPatch(), ColumnEditResult (+17 more)

### Community 5 - "monday-app/package.json"
Cohesion: 0.06
Nodes (31): dependencies, monday-sdk-js, react, react-dom, react-router-dom, @vibe/core, @vibe/icons, devDependencies (+23 more)

### Community 6 - "monday-client.ts"
Cohesion: 0.10
Nodes (33): LINK_NAME_COL_2, LINK_NAME_COL_3, SUBITEMS_BOARD, apiErrorDetail(), apiErrorMessage(), linkDisplayName(), api(), createDeal() (+25 more)

### Community 7 - "card-registry.ts"
Cohesion: 0.05
Nodes (46): CRM_BOARDS, CRM_WEBHOOK_EVENTS, DELIVERED_EVENT_ALIASES, existingHooks(), gql(), main(), missingEvents(), cardStub() (+38 more)

### Community 8 - "config.ts"
Cohesion: 0.05
Nodes (49): scanWriteMode(), ALL_KNOWN_SPECS, ALL_MEMBERS_TEAM_ID, ALL_SPECS, COMPANIES_MYLA, COMPANY_ID_COL, CONTACT_ID_COL, CONTACTS_MYLA (+41 more)

### Community 9 - "LineItemsEditor.tsx"
Cohesion: 0.08
Nodes (35): SUB_COLS, debounceLatest(), SearchResponse, useDebouncedSearch(), clear(), query(), reset(), blank() (+27 more)

### Community 10 - "crm.ts"
Cohesion: 0.05
Nodes (39): META, readSubscriptions(), CRM_ACCOUNTS, CRM_CONTACTS, CRM_CREATE_CUTOFF_MS, CRM_DEALS, CRM_LINE_ITEMS, OWN_ACCOUNTS (+31 more)

### Community 11 - "activity-retry.ts"
Cohesion: 0.07
Nodes (42): ActivityOutcome, afterOutcome(), AlarmStep, DEAD_LETTER_CAP, DEAD_LETTER_NAME, DeadActivity, deadLetterStub(), DELIVER_SCHEDULE_MS (+34 more)

### Community 12 - "CompanyDrawer.tsx"
Cohesion: 0.09
Nodes (49): COMPANY_COLS, NewDealSeed, CLEARABLE, companyClears(), CompanyForm, companyFormToColumnValues(), base, getContext() (+41 more)

### Community 13 - "sync.ts"
Cohesion: 0.10
Nodes (58): reverseAssociations(), reverseLineItems(), syncLineItems(), syncNameColumn(), lookupCard(), specByObject(), colText(), indexByHubspotId() (+50 more)

### Community 14 - "compilerOptions"
Cohesion: 0.12
Nodes (15): compilerOptions, isolatedModules, jsx, lib, module, moduleResolution, noEmit, noUnusedLocals (+7 more)

### Community 15 - "crm-associations.test.ts"
Cohesion: 0.19
Nodes (13): adoptionKey(), companyDomainKey(), isHostname(), isPublicEmailDomain(), PUBLIC_EMAIL_DOMAINS, linkReverse(), crmEnv, hs (+5 more)

### Community 16 - "worker/package.json"
Cohesion: 0.12
Nodes (16): @cloudflare/workers-types, wrangler, devDependencies, @cloudflare/workers-types, typescript, vitest, wrangler, typescript (+8 more)

### Community 17 - "useBoard.ts"
Cohesion: 0.07
Nodes (34): ColSpec, UNASSIGNED_GROUP, DealRow, ROWS, computeKpis(), isLost(), isWon(), Kpis (+26 more)

### Community 18 - "CompaniesView.tsx"
Cohesion: 0.10
Nodes (30): buildDealSeed(), fmtCompanyDate(), fmtNumber(), orDash(), ContactHit, fmtContactDate(), orDash(), DATE_PRESETS (+22 more)

### Community 19 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, lib, module, moduleResolution, noEmit, skipLibCheck, strict, target (+2 more)

### Community 20 - "BoardView.tsx"
Cohesion: 0.08
Nodes (33): App(), monday, hubspotDealUrl(), ConfirmFn, ConfirmProvider(), Ctx, useConfirm(), filterDeals() (+25 more)

### Community 21 - "LineItemForm.tsx"
Cohesion: 0.27
Nodes (12): computeTotals(), isNumeric(), LI_FIELDS, LiField, LiFieldType, LineItemFormValues, num(), base (+4 more)

### Community 22 - "ContactDrawer.tsx"
Cohesion: 0.11
Nodes (25): COMPANY_BOARD, COMPANY_ID_COL, COMPANY_REL_CONTACT, CONTACT_BOARD, CONTACT_COLS, CONTACT_REL_COMPANY, CONTACT_REL_DEAL, DEAL_COLS (+17 more)

### Community 23 - "dedupe-timeline.mjs"
Cohesion: 0.09
Nodes (32): APPLY, BOARD, BOARDS_ON, bodyOf(), byId(), CANARY, cards, checkCard() (+24 more)

### Community 24 - "session.ts"
Cohesion: 0.26
Nodes (8): b64urlToBytes(), bytesToB64url(), claim(), SessionVerdict, timingSafeEq(), verifySessionToken(), b64url(), sign()

### Community 25 - "refresh-forward.mjs"
Cohesion: 0.11
Nodes (18): APPLY, arg(), argv, BATCH, FATAL, hs(), need(), OBJECT (+10 more)

### Community 26 - "monday_smoke_test.py"
Cohesion: 0.60
Nodes (4): load_optional_columns(), main(), monday_query(), Return monday_columns from config.json if present and configured with a real…

### Community 27 - "catchup-after-deploy.mjs"
Cohesion: 0.10
Nodes (24): ACTIVITIES, ALL, APPLY, BATCH, BOARDS, carded(), FatalResponse, hhmmss (+16 more)

### Community 30 - "HubSpot ↔ monday CRM — Phase 1 Implementation Plan (v3)"
Cohesion: 0.05
Nodes (38): 1. Exclusive runtime routing, 2. `/app/ensure-card` — terminal refusal, and an honest note about the risk, 3. monday webhook registrar — written, NOT run, 4. HubSpot webhook routing, 5. Phase B (`dryRun: false`, `writeHubspot: false`) preserved, 6. Phase-D claim rehearsal is now MANDATORY, All five `ensureCardForRecord` callers, and what a refusal does to each, Approval gates (all closed) (+30 more)

### Community 32 - "hubspot.ts"
Cohesion: 0.05
Nodes (55): CRM_CUTOVER_AT_MS, AssocPage, claimOwnership(), coarseStageOf(), COMPANY_LIST_PROPS, CompanyFilters, CompanyHit, CONTACT_LIST_PROPS (+47 more)

### Community 33 - "Component Information"
Cohesion: 0.06
Nodes (31): Account Management, app component, app-event, app-function, app-object, Available Actions for Card Components, Available Hooks for Card Components, card (+23 more)

### Community 34 - "Component Information"
Cohesion: 0.06
Nodes (31): Account Management, app component, app-event, app-function, app-object, Available Actions for Card Components, Available Hooks for Card Components, card (+23 more)

### Community 35 - "app-routes.ts"
Cohesion: 0.09
Nodes (38): AssocReq, CLEARABLE_DEAL_PROPS, CLEARABLE_PROPS, ClearDealReq, ClearRecordReq, CreateCompanyReq, CreateContactReq, CreateLineItemReq (+30 more)

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
Cohesion: 0.17
Nodes (18): internalCompanyIds(), internalDomains(), ActorOwner, OWNER_UNASSIGNED_MESSAGE, NOTE: an Unassigned record has no `sales_user`, and BOTH board specs filter on…, resolveActor(), createContactOrCompany(), hubspotLink() (+10 more)

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

### Community 53 - "resync-people-columns.mjs"
Cohesion: 0.09
Nodes (22): DEFAULT_CRM_WORKER_URL, INTEGRATION_USER_ID, requireIntegrationToken(), requireNewBuild(), APPLY, at, BOARDS, cvArg() (+14 more)

### Community 54 - "Architecture"
Cohesion: 0.13
Nodes (14): 1. Connect Boards columns (created once via a 2025-10 API script), 2. Link sync (built), 3. Config: relationCol replaces text col, 4. Instant on change (new webhooks), 5. Backfill, 6. Safety / edge cases, 7. Testing, Architecture (+6 more)

### Community 55 - "Deal Cockpit v3.1 — Drawer, editing & instant sync"
Cohesion: 0.13
Nodes (14): Architecture — the drawer, Associations tab — the fixed picker, Context, Deal Cockpit v3.1 — Drawer, editing & instant sync, Decisions (confirmed), Discount % — mechanics, Files, Instant sync — `POST /app/sync-deal` (+6 more)

### Community 56 - "Created Date columns + Company domain gate — Design"
Cohesion: 0.13
Nodes (14): Behaviour, Board / column state, Cleanup, Column reuse rule, Created Date columns + Company domain gate — Design, Explicitly out of scope, Goal, Part 1 — Created Date (+6 more)

### Community 57 - "webhooks.ts"
Cohesion: 0.07
Nodes (48): ACTIVITY_BY_TYPEID, activitySyncEnabled(), resetHelperOnReassignment(), actorLabel(), formatActor(), isAutomationActor(), isIntegrationActor(), userCache (+40 more)

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

### Community 69 - "backfill-activities.mjs"
Cohesion: 0.08
Nodes (35): ACTIVITY_TYPE, allAssociations(), APPLY, BOARD, buildIndex(), contactEmail, CUTOVER, destinationsForPage() (+27 more)

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

### Community 78 - "backfill-crm.mjs"
Cohesion: 0.13
Nodes (34): alreadyCarded(), createBatch(), ctxOf(), flush(), flushDealRelations(), flushRelations(), hsPage(), hsTotal() (+26 more)

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

### Community 106 - "ObjectSpec"
Cohesion: 0.07
Nodes (21): MondayItem, ObjectSpec, ctx, env, hubspot, item, monday, opts (+13 more)

### Community 107 - "mapping.ts"
Cohesion: 0.12
Nodes (26): phoneBackfillCandidates(), PhoneCard, applyScale(), buildColumnValues(), clampLongText(), dateCell(), domainStem(), emailStorable() (+18 more)

### Community 113 - "DealDrawer.tsx"
Cohesion: 0.11
Nodes (22): CONTACT_ID_COL, mergeAssoc(), mergeLineItems(), DealErrors, validateDealForm(), getSubitems(), colText(), peopleIds() (+14 more)

### Community 114 - "verify-deals-migration.mjs"
Cohesion: 0.09
Nodes (23): badSamples, BASELINE, cell(), COARSE_OK, dealIds, dealIdSet, dir, dumpBoard() (+15 more)

### Community 115 - "email-repair.test.ts"
Cohesion: 0.13
Nodes (16): h2mReservationKey, bodyOf(), EmailSource, fingerprint(), RepairAction, RepairDeps, RepairOptions, repairPair() (+8 more)

### Community 116 - "recount-canonical-emails.mjs"
Cohesion: 0.09
Nodes (22): bad, bodyOf(), canonicals, cls, COLS, dupRows, E, facts (+14 more)

### Community 117 - "Phase 0 — monday CRM board schema audit"
Cohesion: 0.09
Nodes (22): 10. Correction to the handoff — `createdate` is ALREADY fetched, 11. The blocker, narrowed, 12. HubSpot access path — resolved (2026-09-07), 13. Enum reality: internal values ≠ labels (confirmed, and it matters), 14. `industry` — the taxonomies DO NOT MATCH (F9, decision-grade), 15. Final direction decisions, 16. Remaining decisions for the user (3), 17. Phase 0 status: **COMPLETE** (+14 more)

### Community 118 - "H. Task 5 — EXECUTED 2026-09-07. Both boards: 27 columns, 0 items."
Cohesion: 0.09
Nodes (22): A. The finding that shapes every recommendation, Accounts / Companies — board 5028000496, B. Sequencing that makes the whole change set non-destructive, C. Contacts board `5028000495`, Contacts — board 5028000495, D-2 — `employee_count` — SETTLED (rev. 2, 2026-09-07): reuse the native column, one-way, D. Accounts board `5028000496`, E. Change set split by risk (+14 more)

### Community 119 - "fix-restore-races.ts"
Cohesion: 0.13
Nodes (13): APPLY, deps, HERE, JOBS, shadow, v, RestoreAction, RestoreDeps (+5 more)

### Community 120 - "Env"
Cohesion: 0.18
Nodes (16): deferKey(), DeferredItem, DeferredType, DeferredSync, EnqueueResult, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_QUEUE (+8 more)

### Community 121 - "reverse-sync.test.ts"
Cohesion: 0.10
Nodes (18): assoc, COMPANY_TYPE, companyRec(), contactRec(), ctx, drive(), ensure, env (+10 more)

### Community 122 - "activity-registry.ts"
Cohesion: 0.17
Nodes (25): ActivityClaim, claim(), claimActivityToHubspot(), claimActivityToMonday(), claimHubspotAsRepresented(), cycleKey(), getWatermark(), h2mKey() (+17 more)

### Community 123 - "task-poller.ts"
Cohesion: 0.10
Nodes (19): MAX_PER_POLL, OVERLAP_MS, PollResult, SWEEP_MAX, SWEEP_WINDOW_DAYS, SweepResult, TASK_POLL_SEED, env (+11 more)

### Community 124 - "inventory-email-entries.mjs"
Cohesion: 0.14
Nodes (15): BOARDS, cardsTouchedSinceCutover(), continueCard(), CUTOVER, firstPages(), gql(), groups, HERE (+7 more)

### Community 125 - "migrate-people-column.mjs"
Cohesion: 0.12
Nodes (17): apply, argv, BATCH, cards, dir, entry, field, flush() (+9 more)

### Community 126 - "create-progress.ts"
Cohesion: 0.18
Nodes (14): CREATE_STEPS, isComplete(), isFailed(), ProgressStep, progressSteps(), ResultLike, StepKey, StepStatus (+6 more)

### Community 127 - "classify-twin-accounts.mjs"
Cohesion: 0.12
Nodes (16): byOrphan, cardFacts(), COLS, E, eRows, gql(), HERE, inv (+8 more)

### Community 128 - "plan-email-cleanup.mjs"
Cohesion: 0.12
Nodes (15): buckets, cardEntries, cardsNeeded, CUT, dupGroups, fails, gql(), HERE (+7 more)

### Community 129 - "cleanup-classify.mjs"
Cohesion: 0.15
Nodes (15): ACC, accById, accDupes, blankDeals, cards(), conById, DEA, deaById (+7 more)

### Community 130 - "column-level-reverse.test.ts"
Cohesion: 0.12
Nodes (12): ALDRIN, assoc, ELAINE, ensure, env, hubspot, LIFECYCLE, live (+4 more)

### Community 131 - "Historical Activity import — completion report"
Cohesion: 0.12
Nodes (14): 1. Restore Contacts' Last Activity Date (`date_mm7054jz`), 2. Reminder workflows #03 / #04 / #05 — repoint before enabling, 3. Activities-board cleanup — classifier, not a date filter, 4. Meanwhile, unchanged, Post-import corrections — required before Day 1/3/5, By activity type, Disposition of everything not written, Headline (+6 more)

### Community 132 - "How the monday CRM ↔ HubSpot sync works"
Cohesion: 0.12
Nodes (15): 10. Not in scope today, 11. "It hasn't synced" — what to check, 1. In one picture, 2. Where records come from, 3. Which records are eligible, 4. What syncs, and in which direction, 5. When does it update?, 6. Contacts ↔ Companies (+7 more)

### Community 133 - "post-disable-baseline.mjs"
Cohesion: 0.12
Nodes (14): all, byCard, byDay, HERE, idless, idlessWithLink, idlessWithSync, newest (+6 more)

### Community 134 - "report-idless-corrected.mjs"
Cohesion: 0.12
Nodes (15): allCardBuckets, bucketOf, cardBuckets, cardSum, HERE, ids, inv, man (+7 more)

### Community 135 - "audit-created-companies.mjs"
Cohesion: 0.15
Nodes (12): allById, bad, byDomain, cardByHsId, hs(), monday(), ours, out (+4 more)

### Community 136 - "canary-relations.mjs"
Cohesion: 0.16
Nodes (13): accounts, allHs, byHsId, cellSize, groups, hs(), monday(), readContactCells() (+5 more)

### Community 137 - "inventory-idless-companies.mjs"
Cohesion: 0.14
Nodes (13): all, byDomain, gql(), HERE, idless, manifest, perBucket, rows (+5 more)

### Community 138 - "probe-notwin-domains.mjs"
Cohesion: 0.13
Nodes (12): buckets, domains, found, HERE, inv, malformed, noTwin, unavailable (+4 more)

### Community 139 - "undo-aborted-deals-import.mjs"
Cohesion: 0.13
Nodes (13): all, APPLY, BASELINE, canary, doomed, env, guidIdx, keep (+5 more)

### Community 140 - "activity-sync.ts"
Cohesion: 0.09
Nodes (36): CONTACT_ASSOC_TYPE, eligibleForHubspot(), FollowUpContext, HsActivity, HUBSPOT_OBJECT_FOR_NATIVE, MONDAY_ACTIVITY_TYPE, OUTBOUND, qualifiesAsFollowUp() (+28 more)

### Community 141 - "Phase 2 audit — Deals, Line Items, Activities"
Cohesion: 0.14
Nodes (13): 0. The three things that change the plan, 1. Volumes, 2.1 Association cardinality, 2.2 Automation dependency map, 2.3 The backfill storm — the hard prerequisite, 2.4 `dealstage` — why Stage must be one-way, and what to build instead, 2.5 Column diff, 2. Deals — board 5028000494 (+5 more)

### Community 142 - "hubspot-crm-webhook-sync — HubSpot project app for the monday CRM sync"
Cohesion: 0.14
Nodes (13): 0. Scope change, 2026-09-15 — deals and line items ADDED, reversing §1c, 1. Why this is a separate app, and not a reuse of `hubspot-monday-webhook-sync`, 1a. One app has ONE webhook destination — and it already points at the live WM Worker, 1b. That app is already subscribed to Contacts and Companies, 1c. Its scopes are read-only, and adding ours would widen the live app, 1d. Shared credential, 2. What the investigation confirmed that we can now copy, 3. What differs from the WM app (+5 more)

### Community 143 - "canary-deals.mjs"
Cohesion: 0.16
Nodes (13): groups, hs(), monday(), PIPE_LABEL, PREFIX, ROOT, selected, sleep() (+5 more)

### Community 144 - "cleanup-apply.mjs"
Cohesion: 0.19
Nodes (10): ACC_COLS, APPLY, COSMETIC_ONLY, del(), gql(), log, MAN, readCard() (+2 more)

### Community 145 - "verify-crm-import.mjs"
Cohesion: 0.25
Nodes (13): creds(), ctxRef, digits(), hsBatch(), hsTotal(), linkish(), loadWorker(), main() (+5 more)

### Community 146 - "Contacts assignment + permissions — complete"
Cohesion: 0.15
Nodes (12): 2026-09-15 — Sales Person retired; Sales User is the only assignment field, Contacts assignment + permissions — complete, Migration result, Open, Open, carried forward, Order, and why it is not a preference, Permissions, The engine change, and why it was necessary (+4 more)

### Community 147 - "audit-deals-phase.mjs"
Cohesion: 0.21
Nodes (12): args, cardinality(), counts, dealIds, hs(), out, report, ROOT (+4 more)

### Community 148 - "manifest-v2.mjs"
Cohesion: 0.15
Nodes (11): byKind, fails, HERE, ID_COL, idOf, old, out, records (+3 more)

### Community 149 - "measure-assignment-crosstab.mjs"
Cohesion: 0.17
Nodes (11): blankRows, byEmail, cross, hs(), out, owners, ph, ROOT (+3 more)

### Community 150 - "resync-crm-records.mjs"
Cohesion: 0.18
Nodes (10): APPLY, argv, env, hsPost(), IDS, LIMIT, recordsByIds(), recordsSince() (+2 more)

### Community 151 - "repair-phantom-status.mjs"
Cohesion: 0.16
Nodes (16): APPLY, at, candidates(), CASES, cellIndex(), CLEAR_NEVER_SET, histories(), hs() (+8 more)

### Community 152 - "types.ts"
Cohesion: 0.05
Nodes (51): clearsFromEmpty(), LI_CALCULATED, MAX_UNLINKS_PER_EDIT, resolvedAllIds(), sameSet(), shrinksFreshCard(), syncAssociations(), syncRelationColumn() (+43 more)

### Community 153 - "canary-preflight.mjs"
Cohesion: 0.17
Nodes (8): base, blocked, cand, gates, HERE, rec, SENTINEL, v

### Community 154 - "check-dangling-links.mjs"
Cohesion: 0.18
Nodes (11): byState, danglingByTarget, fake, monday(), onBoard, out, resolved, ROOT (+3 more)

### Community 155 - "measure-assignment-fields.mjs"
Cohesion: 0.20
Nodes (10): byEmail, count(), hs(), out, owners, report, ROOT, sleep() (+2 more)

### Community 156 - "run-until-done.mjs"
Cohesion: 0.18
Nodes (9): HERE, log(), logPath, maxFailures, maxPasses, onePass(), OWN_FLAGS, passThrough (+1 more)

### Community 157 - "trace-company-origin.mjs"
Cohesion: 0.18
Nodes (10): bigFan, blank, buckets, cardByHsId, created, monday(), ROOT, sleep() (+2 more)

### Community 158 - "Deal stage mapping — the decision that gates the Deals spec"
Cohesion: 0.18
Nodes (10): 1. `deal_stage` — the coarse map (HubSpot → monday only), 2. `HubSpot Stage` — the exact map (two-way), 3. What this costs if we get it wrong, 4. Open for the advisor, Deal stage mapping — the decision that gates the Deals spec, HubSpot Shared Selling Pipeline — part of the 227, Sales Pipeline (`default`) — 694 deals, Salesforce pipelines (×3: Sales, Maintenance, 赋能培训) — 4,360 + 3,358 + ~227 deals (+2 more)

### Community 159 - "cleanup-fake-company.mjs"
Cohesion: 0.22
Nodes (10): apply, EXPORT, exported, hs(), monday(), ROOT, sampleIds, sleep() (+2 more)

### Community 160 - "retire-sales-person-columns.mjs"
Cohesion: 0.31
Nodes (8): assigneeColumnsFromLogs(), countFilled(), gql(), KEEP, main(), TARGETS, token(), REAL_EVENT

### Community 161 - "activity-owner-reset.test.ts"
Cohesion: 0.18
Nodes (9): columnWrites, contactProps, createdTimeline, env, hubspot, monday, posted, reg (+1 more)

### Community 162 - "activity-participants.test.ts"
Cohesion: 0.18
Nodes (9): associated, CARDS, classified, created, EMAILS, env, hubspot, monday (+1 more)

### Community 163 - "Contacts ↔ Companies — sign-off report"
Cohesion: 0.20
Nodes (9): 1. Final state, 2. The relation pass, 3. The safety property, proven on real records, 4. The ceiling held, 5. No write-back, 6. What it took to get here, 7. Sign-off status, Contacts ↔ Companies — sign-off report (+1 more)

### Community 164 - "Deals + Line Items — implementation design"
Cohesion: 0.20
Nodes (9): 0. The correction, 1. Measured association cardinality and labels, 2. Association design: link all, select nothing, 3. Stage and pipeline — approved decisions, 4. Column diff — Deals board 5028000494, 5. Line Items — board 5028000489, 6. Validation budget, 7. Blocking prerequisites (+1 more)

### Community 165 - "Phase B rollout — how to exercise the CRM sync given the inert cutover"
Cohesion: 0.20
Nodes (9): A verified fact that shapes the answer, Before HubSpot writes / automatic claiming are ever enabled, Option 1 — finite cutover, HubSpot writes still disabled ✅ RECOMMENDED, Option 2 — explicitly `sync_owner=crm` test records, Options, Phase B rollout — how to exercise the CRM sync given the inert cutover, Recommended sequence, The problem, stated exactly (+1 more)

### Community 166 - "measure-deal-associations.mjs"
Cohesion: 0.24
Nodes (9): byPipeline, deals, hs(), measure(), out, report, ROOT, sleep() (+1 more)

### Community 167 - "measure-relation-cells.mjs"
Cohesion: 0.22
Nodes (9): affected, cardHsId, monday(), near, out, oversized, ROOT, sleep() (+1 more)

### Community 168 - "supervise-migration.mjs"
Cohesion: 0.24
Nodes (7): extra, HERE, importerRunning(), log(), logPath, runDriver(), statePath

### Community 169 - "verify-coarse-stages.mjs"
Cohesion: 0.20
Nodes (9): ALLOWED, counts, dir, entry, env, out, ROOT, stageIds (+1 more)

### Community 170 - "line-item-dispatch.test.ts"
Cohesion: 0.20
Nodes (7): crmEnv, ectx, hubspot, LINE_ITEM_EVENT, sync, waits, wmEnv

### Community 171 - "CRM HubSpot runtime app + Worker secrets — prepared, NOT created"
Cohesion: 0.22
Nodes (8): 1. Correction to my earlier report, 2. Which app to build, 3. Scopes — least privilege, after the `buildCtx` fix, 4. Webhook subscriptions, 5. Worker secrets, 6. monday token — exposure assessment and rotation, 7. What is still yours to do, in order, CRM HubSpot runtime app + Worker secrets — prepared, NOT created

### Community 172 - "add-crm-columns.mjs"
Cohesion: 0.25
Nodes (8): CONTACT_STATUS_LABELS, gql(), LIFECYCLE_LABELS, main(), PLANNED, PRIORITY_LABELS, NOTE: titles here MUST track scripts/rename-crm-columns.mjs. They were renamed…, SALES_PERSON_LABELS

### Community 173 - "backfill-sales-user-people.mjs"
Cohesion: 0.39
Nodes (8): APPLY, BOARDS, gql(), hsBatchRead(), hsGet(), mondayUsers(), ownerEmails(), run()

### Community 174 - "build-deals-schema.mjs"
Cohesion: 0.25
Nodes (8): apply, out, PLAN, q(), RETITLE, ROOT, sleep(), v

### Community 175 - "measure-assoc-truncation.mjs"
Cohesion: 0.25
Nodes (7): big, ids, monday(), ROOT, sleep(), truth, v

### Community 176 - "plan-synthetic-cleanup.mjs"
Cohesion: 0.28
Nodes (8): hs(), monday(), out, plan, ROOT, sleep(), TARGETS, v

### Community 177 - "read-source.mjs"
Cohesion: 0.21
Nodes (8): readCode(), readScript(), readSource(), SCRIPTS, SRC, strip(), SRC(), src()

### Community 178 - "line-item-create.test.ts"
Cohesion: 0.22
Nodes (5): env, hubspot, monday, opts, registry

### Community 179 - "complete-sales-user-labels.mjs"
Cohesion: 0.43
Nodes (7): BOARDS, completeLabelSet(), hubspotOwners(), main(), mergeLabels(), monday(), readLabels()

### Community 180 - "dedupe-crm-cards.mjs"
Cohesion: 0.43
Nodes (7): creds(), loadSpecs(), main(), monday(), ROOT, run(), sleep()

### Community 181 - "diagnose-accounts-adoption.mjs"
Cohesion: 0.43
Nodes (7): bareHost(), hubspot(), loadAdopt(), main(), monday(), ROOT, specCols()

### Community 182 - "preview-email-localparts.mjs"
Cohesion: 0.25
Nodes (5): emails, ROOT, sharedFull, sharedLocal, v

### Community 183 - "reconcile-counts.mjs"
Cohesion: 0.32
Nodes (5): allHubspotIds(), gql(), hsGet(), mondayCards(), REPORT

### Community 184 - "reconcile-orphan-accounts.mjs"
Cohesion: 0.43
Nodes (7): companiesByDomain(), creds(), loadWorker(), main(), monday(), ROOT, sleep()

### Community 185 - "Ctx"
Cohesion: 0.11
Nodes (14): COARSE_STAGES, Ctx, COMPANY_TYPE, companyType, ctx, LEAD_STATUS, leadStatus, PARTNER_WITH (+6 more)

### Community 186 - "rename-placeholder-cards.mjs"
Cohesion: 0.39
Nodes (7): creds(), loadWorker(), main(), monday(), ROOT, sleep(), throttle

### Community 187 - "wm-guard-impact.mjs"
Cohesion: 0.36
Nodes (7): allCards(), BOARDS, monday(), ROOT, sleep(), syncOwners(), v

### Community 188 - "wm-guard-landing.mjs"
Cohesion: 0.36
Nodes (7): boardIds(), crmStampedIds(), monday(), PAIRS, ROOT, sleep(), v

### Community 189 - "read-wrangler.mjs"
Cohesion: 0.70
Nodes (4): parseJsonc(), readConfig(), readWmConfig(), readWranglerConfig()

### Community 190 - "reverse-enabled-batch.test.ts"
Cohesion: 0.15
Nodes (11): CONTACT_CITY, CONTACT_PRIORITY, CONTACT_SOURCE, CONTACT_STATUS, CONTACT_VENDOR, ctx, DEPARTMENT, ENABLED_CONTACTS (+3 more)

### Community 191 - "confirm.ts"
Cohesion: 0.33
Nodes (7): ConfirmOptions, ConfirmTone, resolveConfirm(), TONES, ToneStyle, ConfirmDialog(), Props

### Community 192 - "batch3-fixes.test.ts"
Cohesion: 0.22
Nodes (6): captured, crmEnv, ectx, ELAINE, MYLA, waits

### Community 193 - "deal-routing-deployment.test.ts"
Cohesion: 0.25
Nodes (6): crmEnv, hubspot, monday, opts, registry, wmEnv

### Community 194 - "deals-import-baseline.mjs"
Cohesion: 0.52
Nodes (6): arg(), BOARDS, gql(), hubspotIds(), main(), token()

### Community 195 - "find-duplicate-cards.mjs"
Cohesion: 0.29
Nodes (4): byId, dupes, env, hours

### Community 196 - "preview-company-names.mjs"
Cohesion: 0.29
Nodes (5): domains, labelCount, multiSuffix, ROOT, v

### Community 197 - "preview-numeric-names.mjs"
Cohesion: 0.29
Nodes (4): byDomain, emails, ROOT, v

### Community 198 - "wm-guard-preflight.mjs"
Cohesion: 0.38
Nodes (6): countBy(), hs(), OBJECTS, propertyState(), ROOT, v

### Community 199 - "activity-email-body.test.ts"
Cohesion: 0.29
Nodes (5): env, hubspot, monday, reg, retry

### Community 200 - "activity-marker-pagination.test.ts"
Cohesion: 0.29
Nodes (5): env, hubspot, monday, reg, retry

### Community 201 - "specs-vs-scopes.test.ts"
Cohesion: 0.60
Nodes (3): META, readAppScopes(), SCOPES_FOR

### Community 202 - "PRODUCTION FOLLOW-UP — WM contacts `scopeAlsoLinkedProp` looks dead"
Cohesion: 0.33
Nodes (5): Before changing anything, verify, PRODUCTION FOLLOW-UP — WM contacts `scopeAlsoLinkedProp` looks dead, What it claims to do, Why it appears to be inert, Why it is not obviously broken

### Community 203 - "2026-09-17-crm-column-audit-table.md"
Cohesion: 0.33
Nodes (5): Accounts (5028000496) — 27 columns, 29,066 items, Activities (5028000492) — 8 columns, 3,427 items, Contacts (5028000495) — 39 columns, 95,305 items, Deals (5028000494) — 28 columns, 8,664 items, Products & Services (5028000489) — 26 columns, 9,970 items

### Community 204 - "add-sidebar-columns.mjs"
Cohesion: 0.47
Nodes (5): BOARD_NAMES, gql(), hubspotLabels(), main(), PLANNED

### Community 205 - "audit-crm-column-types.mjs"
Cohesion: 0.47
Nodes (5): ACCEPTS, gql(), main(), parseFields(), SPECS

### Community 206 - "check-hubspot-properties.mjs"
Cohesion: 0.33
Nodes (5): dir, entry, out, ROOT, v

### Community 207 - "check-post-disable.mjs"
Cohesion: 0.33
Nodes (4): base, fresh, HERE, v

### Community 208 - "convert-sales-user-dropdown.mjs"
Cohesion: 0.53
Nodes (5): BOARDS, dedupeLabels(), hubspotOptions(), main(), monday()

### Community 209 - "direction-table.mjs"
Cohesion: 0.53
Nodes (5): directionOf(), gql(), main(), parseFields(), SPECS

### Community 210 - "repoint-crm-webhooks.mjs"
Cohesion: 0.40
Nodes (5): CRM_BOARDS, EVENTS, gql(), main(), WM_BOARDS

### Community 211 - "verify-crm-columns.mjs"
Cohesion: 0.53
Nodes (5): BOARDS, columnRefs(), gql(), main(), specBlock()

### Community 212 - "activity-stale-reservation.test.ts"
Cohesion: 0.33
Nodes (5): env, hubspot, monday, reg, retry

### Community 214 - "create-crm-columns.mjs"
Cohesion: 0.40
Nodes (3): APPLY, created, WANTED

### Community 215 - "dump-crm-columns.mjs"
Cohesion: 0.60
Nodes (4): BOARDS, gql(), labelsOf(), main()

### Community 219 - "remove-duplicate-crm-columns.mjs"
Cohesion: 0.60
Nodes (4): countFilled(), gql(), main(), TARGETS

### Community 221 - "verify-spec-columns-exist.mjs"
Cohesion: 0.70
Nodes (4): loadSpecs(), main(), specColumnRefs(), token()

### Community 223 - "check-hubspot-scopes.mjs"
Cohesion: 0.50
Nodes (3): env, failedObjects, PROBES

### Community 224 - "company-name-to-relation.mjs"
Cohesion: 0.83
Nodes (3): gql(), main(), specStillReferences()

### Community 225 - "convert-vendors-dropdown.mjs"
Cohesion: 0.83
Nodes (3): hubspotLabels(), main(), monday()

### Community 227 - "rename-crm-columns.mjs"
Cohesion: 0.67
Nodes (3): gql(), main(), RENAMES

## Knowledge Gaps
- **1887 isolated node(s):** `monday`, `name`, `private`, `type`, `dev` (+1882 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 2197 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Env` connect `Env` to `index.ts`, `column-level-reverse.test.ts`, `card-registry.ts`, `crm.ts`, `activity-retry.ts`, `activity-sync.ts`, `sync.ts`, `types.ts`, `hubspot.ts`, `activity-owner-reset.test.ts`, `activity-participants.test.ts`, `create-records.ts`, `line-item-dispatch.test.ts`, `read-source.mjs`, `line-item-create.test.ts`, `webhooks.ts`, `batch3-fixes.test.ts`, `deal-routing-deployment.test.ts`, `activity-email-body.test.ts`, `activity-marker-pagination.test.ts`, `activity-stale-reservation.test.ts`, `association-via.test.ts`, `ObjectSpec`, `reverse-sync.test.ts`, `activity-registry.ts`, `task-poller.ts`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `react` connect `BoardView.tsx` to `RecordDrawer.tsx`, `monday-app/package.json`, `monday-client.ts`, `LineItemsEditor.tsx`, `CompanyDrawer.tsx`, `useBoard.ts`, `CompaniesView.tsx`, `DealDrawer.tsx`, `LineItemForm.tsx`, `ContactDrawer.tsx`, `confirm.ts`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Why does `LineItemsEditor()` connect `LineItemsEditor.tsx` to `DealDrawer.tsx`, `BoardView.tsx`, `CompanyDrawer.tsx`, `monday-client.ts`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **What connects `monday`, `name`, `private` to the rest of the system?**
  _1887 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07826694619147449 - nodes in this community are weakly interconnected._
- **Should `owner_router_test.py` be split into smaller, more focused modules?**
  _Cohesion score 0.06101190476190476 - nodes in this community are weakly interconnected._
- **Should `RecordDrawer.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.10815602836879433 - nodes in this community are weakly interconnected._