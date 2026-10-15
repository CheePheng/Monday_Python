# Graph Report - worker  (2026-10-01)

## Corpus Check
- 275 files · ~477,523 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2990 nodes · 6552 edges · 183 communities (165 shown, 14 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b33a3253`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- cleanup-extra-cards.mjs
- activity-retry.ts
- marketing-email-poller.ts
- activity-sync.ts
- associations.ts
- restore-timeline-entries.mjs
- lifecycle-backward-clear.test.ts
- hubspot.ts
- checkIdlessAccounts
- relation-edit.ts
- mapping.ts
- backfill-activities.mjs
- activity-registry.ts
- monday.ts
- marketing-emails.ts
- restore-card.ts
- handleMonday
- lad-sweep.ts
- crm.ts
- coarse-stage-reverse.test.ts
- activity-retry.test.ts
- backfill-crm.mjs
- catchup-after-deploy.mjs
- resync-people-columns.mjs
- activity-mirror-deferral.test.ts
- main
- create-window-edits.test.ts
- verify-deals-migration.mjs
- activity-doorbell.test.ts
- email-repair.test.ts
- recount-canonical-emails.mjs
- line-item-create.test.ts
- fix-restore-races.ts
- refresh-forward.mjs
- reverse-sync.test.ts
- types.ts
- read-source.mjs
- born-attached.test.ts
- colText
- lad-scripts.test.ts
- sync.ts
- deferred-sync.test.ts
- inventory-email-entries.mjs
- migrate-people-column.mjs
- repair-phantom-status.mjs
- activity-mirrored-copies.test.ts
- association-paired-side.test.ts
- classify-twin-accounts.mjs
- plan-email-cleanup.mjs
- column-level-reverse.test.ts
- association-deleted-card.test.ts
- crm-associations.test.ts
- line-item-account-reverse.test.ts
- HubSpot ⇄ monday Sync Worker (live)
- cleanup-classify.mjs
- package.json
- post-disable-baseline.mjs
- report-idless-corrected.mjs
- card-registry.ts
- task-poller.ts
- association-link-order.test.ts
- audit-created-companies.mjs
- canary-relations.mjs
- inventory-idless-companies.mjs
- probe-notwin-domains.mjs
- undo-aborted-deals-import.mjs
- marketing-email-poller.test.ts
- canary-deals.mjs
- cleanup-apply.mjs
- verify-crm-import.mjs
- activity-deliver-in-do.test.ts
- MondayItem
- audit-deals-phase.mjs
- manifest-v2.mjs
- measure-assignment-crosstab.mjs
- resync-crm-records.mjs
- create-idempotency-do.ts
- canary-preflight.mjs
- check-dangling-links.mjs
- measure-assignment-fields.mjs
- run-until-done.mjs
- trace-company-origin.mjs
- webhooks.ts
- registry-lookup.ts
- session.ts
- activity-owner-reset.test.ts
- ensure-card.ts
- association-link-diff.test.ts
- cleanup-fake-company.mjs
- retire-sales-person-columns.mjs
- activity-participants.test.ts
- activity-stale-reservation.test.ts
- compilerOptions
- restore-idless-account.test.ts
- measure-deal-associations.mjs
- measure-relation-cells.mjs
- probe-marketing-events.mjs
- index.ts
- supervise-migration.mjs
- verify-coarse-stages.mjs
- activity-retry-do.ts
- ActivityRetry
- hubspot-latest-wins.test.ts
- line-item-dispatch.test.ts
- add-crm-columns.mjs
- backfill-sales-user-people.mjs
- build-deals-schema.mjs
- measure-assoc-truncation.mjs
- plan-synthetic-cleanup.mjs
- reverseSubitemEdit
- fetch
- marketing-cron.test.ts
- syncMondayItem
- born-attached-provenance.test.ts
- contact-company-props.ts
- change
- complete-sales-user-labels.mjs
- dedupe-crm-cards.mjs
- diagnose-accounts-adoption.mjs
- preview-email-localparts.mjs
- reconcile-counts.mjs
- reconcile-orphan-accounts.mjs
- register-crm-webhooks.mjs
- coarse-stage-webhook.test.ts
- rename-placeholder-cards.mjs
- wm-guard-impact.mjs
- wm-guard-landing.mjs
- Env
- create-records.ts
- deal-routing-deployment.test.ts
- relationDiff
- task-sweep-e2e.test.ts
- wake-timeline.test.ts
- deals-import-baseline.mjs
- find-duplicate-cards.mjs
- preview-company-names.mjs
- preview-numeric-names.mjs
- wm-guard-preflight.mjs
- vitest
- monday-webhook-auth.test.ts
- activity-email-body.test.ts
- activity-marker-pagination.test.ts
- add-sidebar-columns.mjs
- audit-crm-column-types.mjs
- check-hubspot-properties.mjs
- check-post-disable.mjs
- convert-sales-user-dropdown.mjs
- direction-table.mjs
- repoint-crm-webhooks.mjs
- verify-crm-columns.mjs
- RunOpts
- wm-unbound-namespaces.test.ts
- wm-app-routes-live.test.ts
- apply-mapping-sheet.mjs
- check-activity-doorbell.d.mts
- create-crm-columns.mjs
- create-marketing-activity-type.mjs
- dump-crm-columns.mjs
- preview-contact-names.mjs
- Subscriptions
- remove-duplicate-crm-columns.mjs
- update-mapping-tests.mjs
- verify-spec-columns-exist.mjs
- line-item-props.ts
- check-hubspot-scopes.mjs
- company-name-to-relation.mjs
- convert-vendors-dropdown.mjs
- read-app-scopes.d.mts
- register-subitem-webhook.mjs
- rename-crm-columns.mjs
- probe-activity-source.mjs
- retire-sales-person-columns.d.mts
- find-stale-lad.d.mts
- read-wrangler.d.mts
- register-crm-webhooks.d.mts
- relation-plan.d.mts
- read-wrangler.mjs
- coarseStageField
- reconcile.ts

## God Nodes (most connected - your core abstractions)
1. `vitest` - 115 edges
2. `Env` - 82 edges
3. `fetch()` - 72 edges
4. `hs()` - 52 edges
5. `CRM_CONTACTS` - 43 edges
6. `ObjectSpec` - 43 edges
7. `HsRecord` - 39 edges
8. `MondayItem` - 36 edges
9. `main()` - 35 edges
10. `CRM_ACCOUNTS` - 32 edges

## Surprising Connections (you probably didn't know these)
- `fieldDiffsOnly()` --calls--> `fieldDiffs()`  [EXTRACTED]
  test/reverse-sync.test.ts → src/reconcile.ts
- `SRC()` --calls--> `readCode()`  [EXTRACTED]
  test/app-route-ownership.test.ts → scripts/read-source.mjs
- `src()` --calls--> `readCode()`  [EXTRACTED]
  test/self-origin-guard.test.ts → scripts/read-source.mjs
- `card()` --calls--> `itemName()`  [EXTRACTED]
  test/column-level-reverse.test.ts → src/mapping.ts
- `card()` --calls--> `itemName()`  [EXTRACTED]
  test/lifecycle-backward-clear.test.ts → src/mapping.ts

## Import Cycles
- None detected.

## Communities (183 total, 14 thin omitted)

### Community 0 - "cleanup-extra-cards.mjs"
Cohesion: 0.05
Nodes (43): APPLY, arg(), argv, assocBefore, assocCounts(), B, CANARY, CHECK (+35 more)

### Community 1 - "activity-retry.ts"
Cohesion: 0.18
Nodes (17): activityRetryBound(), AlarmStep, DEAD_LETTER_NAME, deadLetterStub(), DISABLED_RECHECK_MS, OutcomeStep, PendingMode, RETRYABLE (+9 more)

### Community 2 - "marketing-email-poller.ts"
Cohesion: 0.06
Nodes (67): h2mReservationKey, readNote(), readNoteStrict(), writeNote(), advance(), appendLedger(), backfillPhase(), campaignTriesName() (+59 more)

### Community 3 - "activity-sync.ts"
Cohesion: 0.09
Nodes (37): CONTACT_ASSOC_TYPE, eligibleForHubspot(), FollowUpContext, HsActivity, HUBSPOT_OBJECT_FOR_NATIVE, MARKETING_ACTIVITY_TYPE_ID, MONDAY_ACTIVITY_TYPE, OUTBOUND (+29 more)

### Community 4 - "associations.ts"
Cohesion: 0.09
Nodes (50): activeCards(), birthColumns(), BirthLinks, CellEdit, cellEditOf(), clearsFromEmpty(), DEAL_COMPANY_PRIMARY, dealsBeingFilled (+42 more)

### Community 5 - "restore-timeline-entries.mjs"
Cohesion: 0.09
Nodes (50): backfillEntry(), BOARD, bodyAfter(), callSite(), CUTOVER, CUTOVER_ISO, differences(), internalDomains() (+42 more)

### Community 6 - "lifecycle-backward-clear.test.ts"
Cohesion: 0.07
Nodes (36): OPTION_ORDER_KEY, withOptionOrder(), assoc, card(), cardAfterRun(), durableEnv(), editCells(), editStage() (+28 more)

### Community 7 - "hubspot.ts"
Cohesion: 0.07
Nodes (47): archiveDeal(), assertMayWriteLineItem(), AssociationType, AssocPage, byDisplayOrder(), COARSE_TARGETS, CoarseStage, coarseStageOf() (+39 more)

### Community 8 - "checkIdlessAccounts"
Cohesion: 0.16
Nodes (34): afterIdDelete(), atOrAfter(), bornInWindow(), checkCardCreates(), checkContacts(), checkDeals(), checkDupExtras(), checkIdlessAccounts() (+26 more)

### Community 9 - "relation-edit.ts"
Cohesion: 0.18
Nodes (9): ActorClass, drainRelationEvents(), isPairedEcho(), NetRelationEdit, pairSeen, Pending, recordRelationEvent(), RelationDiff (+1 more)

### Community 10 - "mapping.ts"
Cohesion: 0.06
Nodes (47): ActorOwner, OWNER_UNASSIGNED_MESSAGE, NOTE: an Unassigned record has no `sales_user`, and BOTH board specs filter on…, applyScale(), buildColumnValues(), clampLongText(), dateCell(), domainStem() (+39 more)

### Community 11 - "backfill-activities.mjs"
Cohesion: 0.08
Nodes (35): ACTIVITY_TYPE, allAssociations(), APPLY, BOARD, buildIndex(), contactEmail, CUTOVER, destinationsForPage() (+27 more)

### Community 12 - "activity-registry.ts"
Cohesion: 0.16
Nodes (27): acquireLock(), ActivityClaim, claim(), claimActivityToHubspot(), claimActivityToMonday(), claimHubspotAsRepresented(), cycleKey(), getWatermark() (+19 more)

### Community 13 - "monday.ts"
Cohesion: 0.23
Nodes (14): syncLineItems(), createItem(), createSubitem(), deleteItem(), findItemIdsByColumn(), getBoardItems(), getItemStates(), getParentItemId() (+6 more)

### Community 14 - "marketing-emails.ts"
Cohesion: 0.09
Nodes (33): MARKER_RE, MARKETING_MARKER_RE, OUR_TYPE, PORTAL_ID, Run, CAMPAIGN_TYPES_SHOWN, campaignIdsNeeded(), CampaignInfo (+25 more)

### Community 15 - "restore-card.ts"
Cohesion: 0.19
Nodes (12): forgetCard(), forgetCardOwner(), DELETION_EVENTS, hubspotIdFromPayload(), isDeletionEvent(), OBJECT_FOR, payloadShape(), restoreDeletedCard() (+4 more)

### Community 16 - "handleMonday"
Cohesion: 0.16
Nodes (18): inCanaryScope(), syncMondayTimeline(), actorLabel(), formatActor(), isAutomationActor(), isIntegrationActor(), userCache, createNote() (+10 more)

### Community 17 - "lad-sweep.ts"
Cohesion: 0.07
Nodes (35): Fail, iso(), LAD_PROP, LAD_SWEEP_OBJECTS, LAD_SWEEP_SEED, LadObjectResult, ladSweepEnabled(), ladSweepGate() (+27 more)

### Community 18 - "crm.ts"
Cohesion: 0.05
Nodes (35): META, readSubscriptions(), CRM_DEALS, CRM_LINE_ITEMS, OWN_ACCOUNTS, OWN_CONTACTS, OWN_DEALS, OWN_LINE_ITEMS (+27 more)

### Community 19 - "coarse-stage-reverse.test.ts"
Cohesion: 0.08
Nodes (29): cardAt(), ctx(), DICTS, ectx, hs, item(), LABELS, mondayApi (+21 more)

### Community 20 - "activity-retry.test.ts"
Cohesion: 0.14
Nodes (13): ActivityOutcome, DEAD_LETTER_CAP, MAX_DEFERRED_MS, baseEnv(), createdTimeline, deadLetters, fakeCtx(), fakeNamespace() (+5 more)

### Community 21 - "backfill-crm.mjs"
Cohesion: 0.13
Nodes (34): alreadyCarded(), createBatch(), ctxOf(), flush(), flushDealRelations(), flushRelations(), hsPage(), hsTotal() (+26 more)

### Community 22 - "catchup-after-deploy.mjs"
Cohesion: 0.09
Nodes (26): ACTIVITIES, ALL, APPLY, BATCH, BOARDS, carded(), FatalResponse, hhmmss (+18 more)

### Community 23 - "resync-people-columns.mjs"
Cohesion: 0.09
Nodes (22): DEFAULT_CRM_WORKER_URL, INTEGRATION_USER_ID, requireIntegrationToken(), requireNewBuild(), APPLY, at, BOARDS, cvArg() (+14 more)

### Community 24 - "activity-mirror-deferral.test.ts"
Cohesion: 0.15
Nodes (7): MIRROR_SETTLE_MS, add(), BOARD_OF, CARD, hubspot, monday, reg

### Community 25 - "main"
Cohesion: 0.09
Nodes (44): applyRefusal(), cardsByRecord(), DESTINATION_KINDS, destinationsOf(), destinationVerdict(), emptyDestinations(), HOLD_REASONS, keepAllowed() (+36 more)

### Community 26 - "create-window-edits.test.ts"
Cohesion: 0.09
Nodes (35): advance(), alarmAt(), ASK_ADA, assoc, AUTOMATION, budget(), cell(), cellText() (+27 more)

### Community 27 - "verify-deals-migration.mjs"
Cohesion: 0.09
Nodes (23): badSamples, BASELINE, cell(), COARSE_OK, dealIds, dealIdSet, dir, dumpBoard() (+15 more)

### Community 28 - "activity-doorbell.test.ts"
Cohesion: 0.13
Nodes (21): BELL_COL, BELL_WORKFLOW_ID, classifyDoorbell(), CONTACTS_BOARD, DOORBELL_COL, filterCovers(), LAD_COL, main() (+13 more)

### Community 29 - "email-repair.test.ts"
Cohesion: 0.14
Nodes (15): bodyOf(), EmailSource, fingerprint(), RepairAction, RepairDeps, RepairOptions, repairPair(), RepairResult (+7 more)

### Community 30 - "recount-canonical-emails.mjs"
Cohesion: 0.09
Nodes (22): bad, bodyOf(), canonicals, cls, COLS, dupRows, E, facts (+14 more)

### Community 31 - "line-item-create.test.ts"
Cohesion: 0.22
Nodes (5): env, hubspot, monday, opts, registry

### Community 32 - "fix-restore-races.ts"
Cohesion: 0.13
Nodes (13): APPLY, deps, HERE, JOBS, shadow, v, RestoreAction, RestoreDeps (+5 more)

### Community 33 - "refresh-forward.mjs"
Cohesion: 0.10
Nodes (20): APPLY, arg(), argv, BATCH, FATAL, hs(), LONG_WAIT, need() (+12 more)

### Community 34 - "reverse-sync.test.ts"
Cohesion: 0.10
Nodes (21): ObjectSpec, assoc, cardFor(), COMPANY_TYPE, companyRec(), contactRec(), ctx, drive() (+13 more)

### Community 35 - "types.ts"
Cohesion: 0.07
Nodes (41): ALL_SPECS, CRM_CUTOVER_AT_MS, claimOwnership(), authorizeWrite(), canClaimCrmOwnership(), claimPatch(), MAX_PLAUSIBLE_CUTOVER_MS, mayCreateCrmCard() (+33 more)

### Community 36 - "read-source.mjs"
Cohesion: 0.12
Nodes (16): listSources(), readCode(), readFixture(), readScript(), readSource(), SCRIPTS, SRC, strip() (+8 more)

### Community 37 - "born-attached.test.ts"
Cohesion: 0.10
Nodes (14): accountCard(), AUTOMATION, automationEdit, card(), cells, contactCard(), dealCard(), env (+6 more)

### Community 38 - "colText"
Cohesion: 0.17
Nodes (26): syncNameColumn(), colText(), ensureCardForRecord(), itemName(), setColumns(), updateItem(), buildUpdatePayload(), decideDirection() (+18 more)

### Community 39 - "lad-scripts.test.ts"
Cohesion: 0.12
Nodes (29): cardDay(), classifyStale(), LAD_PROP, localDay(), main(), hsRead(), md(), sleep() (+21 more)

### Community 40 - "sync.ts"
Cohesion: 0.08
Nodes (41): DEAL_SPECS, CreateSnapshot, PendingEdit, indexByHubspotId(), getDealStageLabels(), getOwners(), propertiesFor(), searchAll() (+33 more)

### Community 41 - "deferred-sync.test.ts"
Cohesion: 0.17
Nodes (16): deferKey(), DeferredItem, DeferredType, DeferredSync, EnqueueResult, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_QUEUE (+8 more)

### Community 42 - "inventory-email-entries.mjs"
Cohesion: 0.14
Nodes (15): BOARDS, cardsTouchedSinceCutover(), continueCard(), CUTOVER, firstPages(), gql(), groups, HERE (+7 more)

### Community 43 - "migrate-people-column.mjs"
Cohesion: 0.12
Nodes (17): apply, argv, BATCH, cards, dir, entry, field, flush() (+9 more)

### Community 44 - "repair-phantom-status.mjs"
Cohesion: 0.16
Nodes (16): APPLY, at, candidates(), CASES, cellIndex(), CLEAR_NEVER_SET, histories(), hs() (+8 more)

### Community 45 - "activity-mirrored-copies.test.ts"
Cohesion: 0.13
Nodes (14): add(), base, BOARD_OF, CARD, CONTACT_CARDS, hubspot, logs(), logSpy (+6 more)

### Community 46 - "association-paired-side.test.ts"
Cohesion: 0.12
Nodes (15): captured, cell, ectx, env, hs, HS_OF, itemOf(), L() (+7 more)

### Community 47 - "classify-twin-accounts.mjs"
Cohesion: 0.12
Nodes (16): byOrphan, cardFacts(), COLS, E, eRows, gql(), HERE, inv (+8 more)

### Community 48 - "plan-email-cleanup.mjs"
Cohesion: 0.12
Nodes (15): buckets, cardEntries, cardsNeeded, CUT, dupGroups, fails, gql(), HERE (+7 more)

### Community 49 - "column-level-reverse.test.ts"
Cohesion: 0.11
Nodes (13): ALDRIN, assoc, card(), ELAINE, ensure, env, hubspot, LIFECYCLE (+5 more)

### Community 50 - "association-deleted-card.test.ts"
Cohesion: 0.11
Nodes (18): META, readAppScopes(), SCOPES_FOR, CRM_SPECS, BULK, captured, ectx, env (+10 more)

### Community 51 - "crm-associations.test.ts"
Cohesion: 0.19
Nodes (13): adoptionKey(), companyDomainKey(), isHostname(), isPublicEmailDomain(), PUBLIC_EMAIL_DOMAINS, linkReverse(), crmEnv, hs (+5 more)

### Community 52 - "line-item-account-reverse.test.ts"
Cohesion: 0.12
Nodes (14): CARD, companiesOfDeal, DEALS_SPEC, dealsOfLi, derived, hs, item, liRec (+6 more)

### Community 53 - "HubSpot ⇄ monday Sync Worker (live)"
Cohesion: 0.12
Nodes (16): Confirming duplicate prevention, Create the monday webhooks, Deploy / secrets, Enabling HubSpot signature validation (safe rollout), ⚠️ Free plan limit, HubSpot ⇄ monday Sync Worker (live), HubSpot webhooks — done via a developer-projects app ✅, Known limitations (+8 more)

### Community 54 - "cleanup-classify.mjs"
Cohesion: 0.15
Nodes (15): ACC, accById, accDupes, blankDeals, cards(), conById, DEA, deaById (+7 more)

### Community 55 - "package.json"
Cohesion: 0.12
Nodes (15): devDependencies, @cloudflare/workers-types, typescript, vitest, wrangler, name, private, scripts (+7 more)

### Community 56 - "post-disable-baseline.mjs"
Cohesion: 0.12
Nodes (14): all, byCard, byDay, HERE, idless, idlessWithLink, idlessWithSync, newest (+6 more)

### Community 57 - "report-idless-corrected.mjs"
Cohesion: 0.12
Nodes (15): allCardBuckets, bucketOf, cardBuckets, cardSum, HERE, ids, inv, man (+7 more)

### Community 58 - "card-registry.ts"
Cohesion: 0.12
Nodes (25): scanWriteMode(), cardStub(), claimCard(), claimHubspotForItem(), CREATE_CLAIM_STALE_MS, createWindowOf(), finishCard(), finishHubspotForItem() (+17 more)

### Community 59 - "task-poller.ts"
Cohesion: 0.17
Nodes (13): MAX_PER_POLL, OVERLAP_MS, PollResult, SWEEP_MAX, SWEEP_WINDOW_DAYS, SweepResult, TASK_POLL_SEED, env (+5 more)

### Community 60 - "association-link-order.test.ts"
Cohesion: 0.13
Nodes (10): captured, ectx, env, hs, item, live, monday, push() (+2 more)

### Community 61 - "audit-created-companies.mjs"
Cohesion: 0.15
Nodes (12): allById, bad, byDomain, cardByHsId, hs(), monday(), ours, out (+4 more)

### Community 62 - "canary-relations.mjs"
Cohesion: 0.16
Nodes (13): accounts, allHs, byHsId, cellSize, groups, hs(), monday(), readContactCells() (+5 more)

### Community 63 - "inventory-idless-companies.mjs"
Cohesion: 0.14
Nodes (13): all, byDomain, gql(), HERE, idless, manifest, perBucket, rows (+5 more)

### Community 64 - "probe-notwin-domains.mjs"
Cohesion: 0.13
Nodes (12): buckets, domains, found, HERE, inv, malformed, noTwin, unavailable (+4 more)

### Community 65 - "undo-aborted-deals-import.mjs"
Cohesion: 0.13
Nodes (13): all, APPLY, BASELINE, canary, doomed, env, guidIdx, keep (+5 more)

### Community 66 - "marketing-email-poller.test.ts"
Cohesion: 0.15
Nodes (11): MARKETING_OBJECTS, at(), ev(), hubspot, monday, NOW, reg, retry (+3 more)

### Community 67 - "canary-deals.mjs"
Cohesion: 0.16
Nodes (13): groups, hs(), monday(), PIPE_LABEL, PREFIX, ROOT, selected, sleep() (+5 more)

### Community 68 - "cleanup-apply.mjs"
Cohesion: 0.19
Nodes (10): ACC_COLS, APPLY, COSMETIC_ONLY, del(), gql(), log, MAN, readCard() (+2 more)

### Community 69 - "verify-crm-import.mjs"
Cohesion: 0.25
Nodes (13): creds(), ctxRef, digits(), hsBatch(), hsTotal(), linkish(), loadWorker(), main() (+5 more)

### Community 70 - "activity-deliver-in-do.test.ts"
Cohesion: 0.20
Nodes (6): DELIVER_SCHEDULE_MS, RECONCILE_SCHEDULE_MS, RETRY_SCHEDULE_MS, ectx, sync, waits

### Community 71 - "MondayItem"
Cohesion: 0.06
Nodes (25): MondayItem, env, hs, HS_OF, item, live, monday, ctx (+17 more)

### Community 72 - "audit-deals-phase.mjs"
Cohesion: 0.21
Nodes (12): args, cardinality(), counts, dealIds, hs(), out, report, ROOT (+4 more)

### Community 73 - "manifest-v2.mjs"
Cohesion: 0.15
Nodes (11): byKind, fails, HERE, ID_COL, idOf, old, out, records (+3 more)

### Community 74 - "measure-assignment-crosstab.mjs"
Cohesion: 0.17
Nodes (11): blankRows, byEmail, cross, hs(), out, owners, ph, ROOT (+3 more)

### Community 75 - "resync-crm-records.mjs"
Cohesion: 0.18
Nodes (10): APPLY, argv, env, hsPost(), IDS, LIMIT, recordsByIds(), recordsSince() (+2 more)

### Community 76 - "create-idempotency-do.ts"
Cohesion: 0.09
Nodes (13): CardClaim, CardEntry, CreateIdempotency, RETENTION_MS, SettleWatch, WATCH_RETRY_MS, WatchStep, Claim (+5 more)

### Community 77 - "canary-preflight.mjs"
Cohesion: 0.17
Nodes (8): base, blocked, cand, gates, HERE, rec, SENTINEL, v

### Community 78 - "check-dangling-links.mjs"
Cohesion: 0.18
Nodes (11): byState, danglingByTarget, fake, monday(), onBoard, out, resolved, ROOT (+3 more)

### Community 79 - "measure-assignment-fields.mjs"
Cohesion: 0.20
Nodes (10): byEmail, count(), hs(), out, owners, report, ROOT, sleep() (+2 more)

### Community 80 - "run-until-done.mjs"
Cohesion: 0.18
Nodes (9): HERE, log(), logPath, maxFailures, maxPasses, onePass(), OWN_FLAGS, passThrough (+1 more)

### Community 81 - "trace-company-origin.mjs"
Cohesion: 0.18
Nodes (10): bigFan, blank, buckets, cardByHsId, created, monday(), ROOT, sleep() (+2 more)

### Community 82 - "webhooks.ts"
Cohesion: 0.12
Nodes (22): ACTIVITY_BY_NAME, ACTIVITY_BY_TYPEID, ACTIVITY_BELL_COL, coalesceLatest(), extractActivityEvents(), extractDealAssocChangeIds(), extractDealIds(), extractDeletedLineItemIds() (+14 more)

### Community 83 - "registry-lookup.ts"
Cohesion: 0.24
Nodes (7): lookupCardOwner(), ALLOWED_BOARDS, handleRegistryLookup(), RegistryLookupResult, secretMatches(), env, registry

### Community 84 - "session.ts"
Cohesion: 0.26
Nodes (8): b64urlToBytes(), bytesToB64url(), claim(), SessionVerdict, timingSafeEq(), verifySessionToken(), b64url(), sign()

### Community 85 - "activity-owner-reset.test.ts"
Cohesion: 0.18
Nodes (9): columnWrites, contactProps, createdTimeline, env, hubspot, monday, posted, reg (+1 more)

### Community 86 - "ensure-card.ts"
Cohesion: 0.08
Nodes (19): EnsureCard, isRetryable(), env, hs, HS_OF, item, live, monday (+11 more)

### Community 87 - "association-link-diff.test.ts"
Cohesion: 0.17
Nodes (6): env, hs, HS_OF, item, live, monday

### Community 88 - "cleanup-fake-company.mjs"
Cohesion: 0.22
Nodes (10): apply, EXPORT, exported, hs(), monday(), ROOT, sampleIds, sleep() (+2 more)

### Community 89 - "retire-sales-person-columns.mjs"
Cohesion: 0.31
Nodes (8): assigneeColumnsFromLogs(), countFilled(), gql(), KEEP, main(), TARGETS, token(), REAL_EVENT

### Community 90 - "activity-participants.test.ts"
Cohesion: 0.18
Nodes (9): associated, CARDS, classified, created, EMAILS, env, hubspot, monday (+1 more)

### Community 91 - "activity-stale-reservation.test.ts"
Cohesion: 0.33
Nodes (5): env, hubspot, monday, reg, retry

### Community 92 - "compilerOptions"
Cohesion: 0.18
Nodes (10): compilerOptions, lib, module, moduleResolution, noEmit, skipLibCheck, strict, target (+2 more)

### Community 93 - "restore-idless-account.test.ts"
Cohesion: 0.29
Nodes (6): ACCOUNTS, env, opts, orphanEvent, registry, sync

### Community 94 - "measure-deal-associations.mjs"
Cohesion: 0.24
Nodes (9): byPipeline, deals, hs(), measure(), out, report, ROOT, sleep() (+1 more)

### Community 95 - "measure-relation-cells.mjs"
Cohesion: 0.22
Nodes (9): affected, cardHsId, monday(), near, out, oversized, ROOT, sleep() (+1 more)

### Community 96 - "probe-marketing-events.mjs"
Cohesion: 0.36
Nodes (8): classes(), env, events(), get(), main(), mask(), readContacts(), tally()

### Community 97 - "index.ts"
Cohesion: 0.10
Nodes (30): participantsFor(), staffEmails(), reverseLineItems(), phoneBackfillCandidates(), PhoneCard, CreateInput, createLineItem(), getAssociatedIds() (+22 more)

### Community 98 - "supervise-migration.mjs"
Cohesion: 0.24
Nodes (7): extra, HERE, importerRunning(), log(), logPath, runDriver(), statePath

### Community 99 - "verify-coarse-stages.mjs"
Cohesion: 0.20
Nodes (9): ALLOWED, counts, dir, entry, env, out, ROOT, stageIds (+1 more)

### Community 100 - "activity-retry-do.ts"
Cohesion: 0.42
Nodes (7): afterOutcome(), mayDeferMirror(), nextDelayMs(), scheduleFor(), stepForAlarm(), activitySyncEnabled(), skipMirroredCopies()

### Community 101 - "ActivityRetry"
Cohesion: 0.36
Nodes (3): DeadActivity, ActivityRetry, PendingActivity

### Community 102 - "hubspot-latest-wins.test.ts"
Cohesion: 0.20
Nodes (7): assocEvent, crm, ectx, ladEvent, sync, waits, wm

### Community 103 - "line-item-dispatch.test.ts"
Cohesion: 0.20
Nodes (7): crmEnv, ectx, hubspot, LINE_ITEM_EVENT, sync, waits, wmEnv

### Community 104 - "add-crm-columns.mjs"
Cohesion: 0.25
Nodes (8): CONTACT_STATUS_LABELS, gql(), LIFECYCLE_LABELS, main(), PLANNED, PRIORITY_LABELS, NOTE: titles here MUST track scripts/rename-crm-columns.mjs. They were renamed…, SALES_PERSON_LABELS

### Community 105 - "backfill-sales-user-people.mjs"
Cohesion: 0.39
Nodes (8): APPLY, BOARDS, gql(), hsBatchRead(), hsGet(), mondayUsers(), ownerEmails(), run()

### Community 106 - "build-deals-schema.mjs"
Cohesion: 0.25
Nodes (8): apply, out, PLAN, q(), RETITLE, ROOT, sleep(), v

### Community 107 - "measure-assoc-truncation.mjs"
Cohesion: 0.25
Nodes (7): big, ids, monday(), ROOT, sleep(), truth, v

### Community 108 - "plan-synthetic-cleanup.mjs"
Cohesion: 0.28
Nodes (8): hs(), monday(), out, plan, ROOT, sleep(), TARGETS, v

### Community 109 - "reverseSubitemEdit"
Cohesion: 0.40
Nodes (8): reverseSubitemEdit(), LINE_ITEM_SUBITEMS, buildSubitemReversePatch(), DISCOUNT_SIBLING, isReverseSubitemEvent(), liValueEqual(), readSubitemEvent(), subitemFieldByCol()

### Community 110 - "fetch"
Cohesion: 0.13
Nodes (29): AssocReq, CLEARABLE_DEAL_PROPS, CLEARABLE_PROPS, ClearDealReq, ClearRecordReq, CreateCompanyReq, CreateContactReq, CreateLineItemReq (+21 more)

### Community 111 - "marketing-cron.test.ts"
Cohesion: 0.22
Nodes (5): crm, lad, mkt, tasks, wm

### Community 112 - "syncMondayItem"
Cohesion: 0.12
Nodes (29): SALES_USER_MYLA, specByBoard(), getRecord(), propertiesForSpec(), searchModifiedIds(), recordWriteAuth(), findItemByColumn(), getItem() (+21 more)

### Community 113 - "born-attached-provenance.test.ts"
Cohesion: 0.25
Nodes (7): actor, crm, ectx, fire(), settle(), sync, waits

### Community 114 - "contact-company-props.ts"
Cohesion: 0.44
Nodes (7): COMPANY_ENUM_PROPS, COMPANY_WRITE_PROPS, CONTACT_ENUM_PROPS, CONTACT_WRITE_PROPS, pick(), pickWritableCompanyProps(), pickWritableContactProps()

### Community 115 - "change"
Cohesion: 0.22
Nodes (9): cell(), cellOf(), change(), linked(), personSets(), post(), setCell(), settle() (+1 more)

### Community 116 - "complete-sales-user-labels.mjs"
Cohesion: 0.43
Nodes (7): BOARDS, completeLabelSet(), hubspotOwners(), main(), mergeLabels(), monday(), readLabels()

### Community 117 - "dedupe-crm-cards.mjs"
Cohesion: 0.43
Nodes (7): creds(), loadSpecs(), main(), monday(), ROOT, run(), sleep()

### Community 118 - "diagnose-accounts-adoption.mjs"
Cohesion: 0.43
Nodes (7): bareHost(), hubspot(), loadAdopt(), main(), monday(), ROOT, specCols()

### Community 119 - "preview-email-localparts.mjs"
Cohesion: 0.25
Nodes (5): emails, ROOT, sharedFull, sharedLocal, v

### Community 120 - "reconcile-counts.mjs"
Cohesion: 0.32
Nodes (5): allHubspotIds(), gql(), hsGet(), mondayCards(), REPORT

### Community 121 - "reconcile-orphan-accounts.mjs"
Cohesion: 0.43
Nodes (7): companiesByDomain(), creds(), loadWorker(), main(), monday(), ROOT, sleep()

### Community 122 - "register-crm-webhooks.mjs"
Cohesion: 0.39
Nodes (7): CRM_BOARDS, CRM_WEBHOOK_EVENTS, DELIVERED_EVENT_ALIASES, existingHooks(), gql(), main(), missingEvents()

### Community 123 - "coarse-stage-webhook.test.ts"
Cohesion: 0.13
Nodes (12): actor, base, ectx, fire(), ON, post(), registry, settle() (+4 more)

### Community 124 - "rename-placeholder-cards.mjs"
Cohesion: 0.39
Nodes (7): creds(), loadWorker(), main(), monday(), ROOT, sleep(), throttle

### Community 125 - "wm-guard-impact.mjs"
Cohesion: 0.36
Nodes (7): allCards(), BOARDS, monday(), ROOT, sleep(), syncOwners(), v

### Community 126 - "wm-guard-landing.mjs"
Cohesion: 0.36
Nodes (7): boardIds(), crmStampedIds(), monday(), PAIRS, ROOT, sleep(), v

### Community 127 - "Env"
Cohesion: 0.25
Nodes (3): Env, env, hsMock

### Community 128 - "create-records.ts"
Cohesion: 0.21
Nodes (15): internalCompanyIds(), internalDomains(), resolveActor(), createContactOrCompany(), hubspotLink(), cardIdOf(), assertAssociationDefined(), assertMayWrite() (+7 more)

### Community 129 - "deal-routing-deployment.test.ts"
Cohesion: 0.25
Nodes (6): crmEnv, hubspot, monday, opts, registry, wmEnv

### Community 130 - "relationDiff"
Cohesion: 0.67
Nodes (4): linkedCardIds(), linkedIds(), relationDiff(), unlinkedCardIds()

### Community 131 - "task-sweep-e2e.test.ts"
Cohesion: 0.25
Nodes (6): CARD_OF, env, hubspot, monday, reg, retry

### Community 132 - "wake-timeline.test.ts"
Cohesion: 0.29
Nodes (6): act, crm, ectx(), monday, post(), wm

### Community 133 - "deals-import-baseline.mjs"
Cohesion: 0.52
Nodes (6): arg(), BOARDS, gql(), hubspotIds(), main(), token()

### Community 134 - "find-duplicate-cards.mjs"
Cohesion: 0.29
Nodes (4): byId, dupes, env, hours

### Community 135 - "preview-company-names.mjs"
Cohesion: 0.29
Nodes (5): domains, labelCount, multiSuffix, ROOT, v

### Community 136 - "preview-numeric-names.mjs"
Cohesion: 0.29
Nodes (4): byDomain, emails, ROOT, v

### Community 137 - "wm-guard-preflight.mjs"
Cohesion: 0.38
Nodes (6): countBy(), hs(), OBJECTS, propertyState(), ROOT, v

### Community 138 - "vitest"
Cohesion: 0.07
Nodes (39): vitest, ALL_KNOWN_SPECS, ALL_MEMBERS_TEAM_ID, COMPANIES_MYLA, COMPANY_ID_COL, CONTACT_ID_COL, CONTACTS_MYLA, CREATE_CUTOFF_MS (+31 more)

### Community 140 - "activity-email-body.test.ts"
Cohesion: 0.29
Nodes (5): env, hubspot, monday, reg, retry

### Community 141 - "activity-marker-pagination.test.ts"
Cohesion: 0.29
Nodes (5): env, hubspot, monday, reg, retry

### Community 142 - "add-sidebar-columns.mjs"
Cohesion: 0.47
Nodes (5): BOARD_NAMES, gql(), hubspotLabels(), main(), PLANNED

### Community 143 - "audit-crm-column-types.mjs"
Cohesion: 0.47
Nodes (5): ACCEPTS, gql(), main(), parseFields(), SPECS

### Community 144 - "check-hubspot-properties.mjs"
Cohesion: 0.33
Nodes (5): dir, entry, out, ROOT, v

### Community 145 - "check-post-disable.mjs"
Cohesion: 0.33
Nodes (4): base, fresh, HERE, v

### Community 146 - "convert-sales-user-dropdown.mjs"
Cohesion: 0.53
Nodes (5): BOARDS, dedupeLabels(), hubspotOptions(), main(), monday()

### Community 147 - "direction-table.mjs"
Cohesion: 0.53
Nodes (5): directionOf(), gql(), main(), parseFields(), SPECS

### Community 148 - "repoint-crm-webhooks.mjs"
Cohesion: 0.40
Nodes (5): CRM_BOARDS, EVENTS, gql(), main(), WM_BOARDS

### Community 149 - "verify-crm-columns.mjs"
Cohesion: 0.53
Nodes (5): BOARDS, columnRefs(), gql(), main(), specBlock()

### Community 150 - "RunOpts"
Cohesion: 0.13
Nodes (10): OwnershipError, RunOpts, calls(), CUTOVER, env, live, mockFetch(), own (+2 more)

### Community 152 - "wm-app-routes-live.test.ts"
Cohesion: 0.29
Nodes (3): ctx, hubspot, worker()

### Community 154 - "check-activity-doorbell.d.mts"
Cohesion: 0.40
Nodes (4): ColumnUse, DoorbellRow, DoorbellVerdict, DoorbellVerdictName

### Community 155 - "create-crm-columns.mjs"
Cohesion: 0.40
Nodes (3): APPLY, created, WANTED

### Community 156 - "create-marketing-activity-type.mjs"
Cohesion: 0.50
Nodes (4): APPLY, env, gql(), main()

### Community 157 - "dump-crm-columns.mjs"
Cohesion: 0.60
Nodes (4): BOARDS, gql(), labelsOf(), main()

### Community 160 - "remove-duplicate-crm-columns.mjs"
Cohesion: 0.60
Nodes (4): countFilled(), gql(), main(), TARGETS

### Community 162 - "verify-spec-columns-exist.mjs"
Cohesion: 0.70
Nodes (4): loadSpecs(), main(), specColumnRefs(), token()

### Community 163 - "line-item-props.ts"
Cohesion: 0.53
Nodes (4): LINE_ITEM_ENUM_PROPS, LINE_ITEM_WRITE_PROPS, pickWritableLineItemProps(), PRODUCT_COPY_PROPS

### Community 164 - "check-hubspot-scopes.mjs"
Cohesion: 0.50
Nodes (3): env, failedObjects, PROBES

### Community 165 - "company-name-to-relation.mjs"
Cohesion: 0.83
Nodes (3): gql(), main(), specStillReferences()

### Community 166 - "convert-vendors-dropdown.mjs"
Cohesion: 0.83
Nodes (3): hubspotLabels(), main(), monday()

### Community 169 - "rename-crm-columns.mjs"
Cohesion: 0.67
Nodes (3): gql(), main(), RENAMES

### Community 180 - "read-wrangler.mjs"
Cohesion: 0.70
Nodes (4): parseJsonc(), readConfig(), readWmConfig(), readWranglerConfig()

### Community 181 - "coarseStageField"
Cohesion: 1.00
Nodes (3): coarseStageField(), exactStageField(), coarseStageCols()

### Community 189 - "reconcile.ts"
Cohesion: 0.07
Nodes (38): coarseTargetsFor(), unapplyScale(), applyStagePipelinePairing(), BACKFILL_OBJECTS, backwardClearPlan, buildCreateProperties(), buildReversePatch(), coarseStageEdit() (+30 more)

## Knowledge Gaps
- **1201 isolated node(s):** `name`, `private`, `type`, `test`, `dev` (+1196 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1486 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `vitest` to `create-records.ts`, `deal-routing-deployment.test.ts`, `activity-sync.ts`, `associations.ts`, `task-sweep-e2e.test.ts`, `lifecycle-backward-clear.test.ts`, `hubspot.ts`, `wake-timeline.test.ts`, `mapping.ts`, `monday-webhook-auth.test.ts`, `activity-email-body.test.ts`, `activity-marker-pagination.test.ts`, `marketing-emails.ts`, `restore-card.ts`, `handleMonday`, `crm.ts`, `coarse-stage-reverse.test.ts`, `activity-retry.test.ts`, `backfill-crm.mjs`, `RunOpts`, `wm-unbound-namespaces.test.ts`, `activity-mirror-deferral.test.ts`, `main`, `create-window-edits.test.ts`, `wm-app-routes-live.test.ts`, `activity-doorbell.test.ts`, `email-repair.test.ts`, `line-item-create.test.ts`, `fix-restore-races.ts`, `reverse-sync.test.ts`, `types.ts`, `read-source.mjs`, `born-attached.test.ts`, `line-item-props.ts`, `lad-scripts.test.ts`, `deferred-sync.test.ts`, `activity-mirrored-copies.test.ts`, `association-paired-side.test.ts`, `column-level-reverse.test.ts`, `association-deleted-card.test.ts`, `crm-associations.test.ts`, `line-item-account-reverse.test.ts`, `package.json`, `card-registry.ts`, `task-poller.ts`, `association-link-order.test.ts`, `reconcile.ts`, `marketing-email-poller.test.ts`, `activity-deliver-in-do.test.ts`, `MondayItem`, `create-idempotency-do.ts`, `webhooks.ts`, `registry-lookup.ts`, `session.ts`, `activity-owner-reset.test.ts`, `ensure-card.ts`, `association-link-diff.test.ts`, `retire-sales-person-columns.mjs`, `activity-participants.test.ts`, `activity-stale-reservation.test.ts`, `restore-idless-account.test.ts`, `index.ts`, `hubspot-latest-wins.test.ts`, `line-item-dispatch.test.ts`, `reverseSubitemEdit`, `fetch`, `marketing-cron.test.ts`, `syncMondayItem`, `born-attached-provenance.test.ts`, `contact-company-props.ts`, `coarse-stage-webhook.test.ts`, `Env`?**
  _High betweenness centrality (0.179) - this node is a cross-community bridge._
- **Why does `Env` connect `Env` to `create-records.ts`, `activity-retry.ts`, `marketing-email-poller.ts`, `activity-sync.ts`, `associations.ts`, `deal-routing-deployment.test.ts`, `lifecycle-backward-clear.test.ts`, `hubspot.ts`, `task-sweep-e2e.test.ts`, `wake-timeline.test.ts`, `monday-webhook-auth.test.ts`, `activity-registry.ts`, `monday.ts`, `marketing-emails.ts`, `restore-card.ts`, `handleMonday`, `lad-sweep.ts`, `crm.ts`, `activity-email-body.test.ts`, `activity-marker-pagination.test.ts`, `activity-retry.test.ts`, `coarse-stage-reverse.test.ts`, `wm-unbound-namespaces.test.ts`, `activity-mirror-deferral.test.ts`, `wm-app-routes-live.test.ts`, `create-window-edits.test.ts`, `activity-doorbell.test.ts`, `line-item-create.test.ts`, `reverse-sync.test.ts`, `types.ts`, `read-source.mjs`, `born-attached.test.ts`, `sync.ts`, `deferred-sync.test.ts`, `activity-mirrored-copies.test.ts`, `association-paired-side.test.ts`, `column-level-reverse.test.ts`, `association-deleted-card.test.ts`, `line-item-account-reverse.test.ts`, `card-registry.ts`, `task-poller.ts`, `association-link-order.test.ts`, `marketing-email-poller.test.ts`, `activity-deliver-in-do.test.ts`, `MondayItem`, `create-idempotency-do.ts`, `webhooks.ts`, `registry-lookup.ts`, `activity-owner-reset.test.ts`, `ensure-card.ts`, `association-link-diff.test.ts`, `activity-participants.test.ts`, `activity-stale-reservation.test.ts`, `restore-idless-account.test.ts`, `index.ts`, `activity-retry-do.ts`, `ActivityRetry`, `hubspot-latest-wins.test.ts`, `line-item-dispatch.test.ts`, `marketing-cron.test.ts`, `born-attached-provenance.test.ts`, `coarse-stage-webhook.test.ts`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `BELL_COL` connect `activity-doorbell.test.ts` to `cleanup-extra-cards.mjs`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **What connects `name`, `private`, `type` to the rest of the system?**
  _1201 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `cleanup-extra-cards.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.04625346901017576 - nodes in this community are weakly interconnected._
- **Should `marketing-email-poller.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05926251097453907 - nodes in this community are weakly interconnected._
- **Should `activity-sync.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08686868686868687 - nodes in this community are weakly interconnected._