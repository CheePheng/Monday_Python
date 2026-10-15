@echo off
rem Deploy the CRM Worker (hubspot-monday-crm-sync) with every live setting, from THIS folder.
rem KEEP THIS FILE ASCII-ONLY WITH CRLF LINE ENDINGS: cmd.exe misreads a batch file with LF endings plus multibyte
rem characters (it lost its place and ran fragments of these comments as commands on 2026-10-12).
rem It changes to its own folder first, so it can be run from anywhere, and it refuses to run unless the
rem config here is the CRM Worker's: the main checkout (Monday_Python) holds the LIVE Work-Management
rem Worker's code, and a deploy from there would overwrite the wrong Worker.
rem OWNER_NOTICE is ON: the monday workflow "#06 [Owner Notice] Email new contact owner" (5031811440, run as
rem ask ada, Outlook) is live and was tested 2026-10-09. To stop the notices, deploy with OWNER_NOTICE:false
rem (the workflow itself can stay on: nothing sets the notice status to pending without the Worker).
rem STALE_FORWARD_GATE is ON (d93c470): a HubSpot-side pass never writes over a person's monday edit still on its
rem way; every hold ends within 3 min. To roll back, deploy with STALE_FORWARD_GATE:false (watches drain by
rem themselves). STALE_FORWARD_RETRY stays false: not safe to arm yet.
rem FOLLOW_UP_REMINDER is OFF for now (its review fixes are not in yet; #07 paused). When ON (02.2): after a lead's assignment with
rem nothing logged, the card's follow-up reminder status (color_mm82ccsb) is flagged once; monday workflow #07
rem emails the owner (CC ZMark). Roll back by deploying it :false.
rem PROPERTY_BATCH_READ is ON (2026-10-12): label dictionaries load with one HubSpot batch read per object instead
rem of ~27 GETs per cold start, which hit HubSpot's ten-second limit. Roll back by deploying it :false.
rem CONTACT_CARD_NEEDS_OWNER is OFF again (2026-10-12, hiffer: contacts sync in real time, owner or not, or the two
rem systems never match). An ownerless contact gets its card at once; the owner notice fires when HubSpot assigns one.
rem Products and Services two-way (decision 2026-10-05): PS_DEAL_ONE, PS_OWNER_TWO_WAY, PS_CREATE_WITHOUT_DEAL,
rem PS_RESTORE_ON_DELETE all ship false and are armed ONE AT A TIME, in that order, each after a person's canary.
rem PS_CREATE_WITHOUT_DEAL also needs PS_DEAL_ONE (and BORN_ATTACHED_LINKS) on, and the P and S form's Deal question
rem made optional first. Roll back by deploying it :false; associations written, line items created, owners
rem pushed and cards restored stay as they are.
cd /d "%~dp0"
findstr /c:"\"name\": \"hubspot-monday-crm-sync\"" wrangler.jsonc >nul
if errorlevel 1 (
  echo REFUSED: %CD%\wrangler.jsonc is not the CRM Worker's config. Nothing was deployed.
  exit /b 1
)
rem wrangler bundles the files on disk, not the commit: refuse while the code has uncommitted changes.
for /f "delims=" %%i in ('git status --porcelain -- src wrangler.jsonc package.json') do (
  echo REFUSED: uncommitted change in the Worker code: %%i
  echo Nothing was deployed. Deploy again once the change is committed.
  exit /b 1
)
for /f %%h in ('git rev-parse --short HEAD') do echo Commit: %%h
echo Deploying hubspot-monday-crm-sync from %CD% ...
call npx wrangler deploy ^
 --var ACTIVITY_CUTOVER_AT:2026-09-16T11:16:48Z ^
 --var ACTIVITY_SKIP_MIRRORED_COPIES:true ^
 --var ASK_ADA_UI_EDITS:true ^
 --var BORN_ATTACHED_LINKS:true ^
 --var CREATE_WINDOW_REPLAY:false ^
 --var CRM_CREATE_CUTOFF_AT:2026-09-23T10:00:00Z ^
 --var DRY_RUN:false ^
 --var ENABLE_ACTIVITY_SYNC:true ^
 --var ENABLE_CRM:true ^
 --var ENABLE_LAD_SWEEP:true ^
 --var ENABLE_MARKETING_EMAIL_SYNC:true ^
 --var MARKETING_BACKFILL_FROM:2026-04-01T00:00:00Z ^
 --var MARKETING_CUTOVER_AT:2026-09-30T12:00:00Z ^
 --var MARKETING_MAX_WRITES_PER_POLL:60 ^
 --var MAX_WRITES:25 ^
 --var PS_ACCOUNT_REVERSE:false ^
 --var STAGE_COARSE_REVERSE:true ^
 --var WRITE_HUBSPOT:true ^
 --var HS_RATE_LIMIT_RETRY:true ^
 --var ITEM_NAME_FIT:true ^
 --var PROPERTY_BATCH_READ:true ^
 --var FOLLOW_UP_REMINDER:false ^
 --var NO_ACTIVITY_RELEASE:true ^
 --var CONTACT_CARD_NEEDS_OWNER:false ^
 --var CONTACT_OWNER_HUBSPOT_ONLY:true ^
 --var OWNER_NOTICE:true ^
 --var STALE_FORWARD_GATE:true ^
 --var STALE_FORWARD_RETRY:false ^
 --var PS_DEAL_ONE:false ^
 --var PS_OWNER_TWO_WAY:false ^
 --var PS_CREATE_WITHOUT_DEAL:false ^
 --var PS_RESTORE_ON_DELETE:false
