import type {
  Budget, Ctx, Env, FieldSpec, HsRecord, LabelDict, MondayEdit, MondayItem, ObjectSpec, RetryEdit, RunOpts, Stats, WriteAuth,
} from "./types";
import type { CreateSnapshot, PendingEdit } from "./create-idempotency-do";
import { convergeRelationCell, pushBirthAssociations, reverseAssociations, reverseLineItems, syncAssociations } from "./associations";
import {
  CREATE_CUTOFF_MS, CREATED_AFTER_MS, DEAL_SPECS, DEALS, PORTAL_ID,
  specByBoard, specByObject, specsFor,
} from "./config";
import {
  MONDAY_ITEM_NAME_MAX, buildColumnValues, expectedText, formatValue, itemName, itemNameFitOn, linkText, numText, phoneDigits,
} from "./mapping";
import { colText, indexByHubspotId } from "./dedup";
import {
  lookupCard, lookupCardOwner, finishCard, claimHubspotForItem, finishHubspotForItem, forgetHubspotForItem,
  createWindowOf, noteCreateWindowEdit,
  beginConverge, beginRetry, clearMarks, failConverge, finishConverge, markEdits, notePushes, noteStamp, refundRetry,
  supersedeMarks, watchCells,
} from "./card-registry";
import {
  ALL_CELLS, LOG_RETRY_MAX, NAME_KEY, RELATION_HOLD_MS, RESCUE_LOOKBACK_MS, STUCK_MS, applyVeto, cellFp, cellKey, diffProps,
  effectiveLinkAt, eventTypeOfObject, fpOfField, fpOfName, gateKey, gatedCols, gatedProps, gaveUpMatches, holdWindowMs,
  isCoarseGated, isGatedField, judgeCell, mergedVersions, needHistoryBefore, newestForeignAt, newestNamed, newestNonOwnAt,
  ownLaterVerdict, reduceWatchCells, relKey, staleForwardGateOn, staleForwardRetryOn, updatedAtMs,
  type CardWatch, type CellVerdict, type ConvergeOutcome, type FinalVerdict, type HsVersion, type MarkInput, type PushRec,
  type TaggedVersion, type WatchBase, type WatchReply, type WatchReq,
} from "./card-watch";
import { cardValueFingerprint, lastCellChanges, type CellChange } from "./ui-actor";
import { ensureCardForRecord } from "./ensure-card";
import { releaseOnWorkedChanges } from "./no-activity";
import { ownerNoticeOn, queueOwnerNotices } from "./owner-notice";
import { adoptionKey } from "./adopt";
import { ensureHubspotWriteAuth } from "./write-auth";
import { authorizeCreate, authorizeWrite, canClaimCrmOwnership, withBirthOwnership } from "./ownership";
import { targetGroup } from "./routing";
import {
  backwardClearPlan, buildCreateProperties, buildReversePatch, buildUpdatePayload, columnEditPatch, danglingClearVerdict,
  decideDirection, emptiedFlaggedFields, fieldDiffs, reverseFieldValue, type Diff,
} from "./reconcile";
import { spillDeferred } from "./deferred-sync";
import {
  createItem, deleteItem, findItemByColumn, getBoardItems, getItem, getItemFresh, getItemsColumnText,
  getLinkedItemIds, getUsersByEmail, moveItem, setColumns, updateColumns, updateItem,
} from "./monday";
import {
  claimOwnership, createRecord, getCrmStageDicts, getDealStageLabels, getOwners, getPropertyHistory, getPropertyOptions, getRecord, patchRecord, searchCompanyByDomain,
  getRecordWithHistory, propertiesForSpec, searchAll, searchContactByEmail, searchModifiedIds,
} from "./hubspot";

const emptyStats = (): Stats => ({
  processed: 0, created: 0, toMonday: 0, toHubspot: 0, inSync: 0, skipped: 0, errors: 0,
  adopted: 0, createdInHubspot: 0,
});

function linkValue(spec: ObjectSpec, ctx: Ctx, id: string): Record<string, unknown> {
  return spec.linkCol
    ? { [spec.linkCol]: { url: `https://app.hubspot.com/contacts/${ctx.portalId}/record/${spec.objectTypeId}/${id}`, text: "Open in HubSpot" } }
    : {};
}

/**
 * Where each enum label dictionary comes from.
 *
 * SPEC-DRIVEN so that a deployment only fetches the metadata its OWN specs actually reference. This is
 * not a micro-optimisation: buildCtx previously fetched deal pipelines and three deal properties
 * unconditionally, which would have forced the CRM HubSpot app to hold `crm.objects.deals.read` +
 * `crm.schemas.deals.read` purely to satisfy a shared helper — for an integration where Deals are
 * deliberately out of scope. Least privilege beats convenience.
 *
 * "derived" dictionaries cost no API call: `salesUser` is built from the owner list, `pipeline` is a
 * literal. They are always present.
 */
const LABEL_SOURCE: Record<LabelDict, { object: string; prop: string } | "dealPipelines" | "derived"> = {
  stage:         "dealPipelines",
  pipeline:      "derived",
  salesUser:     "derived",
  dealtype:      { object: "deals", prop: "dealtype" },
  priority:      { object: "deals", prop: "hs_priority" },
  vendor:        { object: "deals", prop: "vendorschang_shang_lai_yuan" },
  leadStatus:    { object: "contacts", prop: "hs_lead_status" },
  contactSource: { object: "contacts", prop: "leadsource" },
  contactVendor: { object: "contacts", prop: "manufacturer__c" },
  contactPriority: { object: "contacts", prop: "priority__c" },
  lifecycleStage: { object: "contacts", prop: "lifecyclestage" },
  contactStatus:  { object: "contacts", prop: "leadstatus" },
  industry:      { object: "companies", prop: "industry" },
  companyType:   { object: "companies", prop: "type" },
  partnerWith:   { object: "companies", prop: "partner_with" },
  // Added 2026-09-09. Each of these is a HubSpot ENUMERATION whose monday column is a plain text or
  // status/dropdown column, so the reverse write must check membership or HubSpot 400s and wedges the
  // card. Option counts verified live against portal 39939588 on 2026-09-09:
  //   sales_person 4, department_3__c 29, countries 198, city_1__c 673, lead_source_sub__c 558.
  // The large ones are deliberately NOT retyped to monday dropdowns: monday cannot retype a column,
  // 198/558/673 all exceed the 88-label ceiling verified on this account, and every write sets
  // create_labels_if_missing:true so the column would accumulate a second vocabulary permanently.
  // A text column plus a validated reverse gets two-way editing with none of that.
  contactSalesPerson:   { object: "contacts", prop: "sales_person" },
  contactDepartment:    { object: "contacts", prop: "department_3__c" },
  contactCountries:     { object: "contacts", prop: "countries" },
  contactCity:          { object: "contacts", prop: "city_1__c" },
  contactLeadSourceSub: { object: "contacts", prop: "lead_source_sub__c" },
  // CRM Deals + Line Items, 2026-09-14. crmStage and crmPipeline are "derived" only in the sense that
  // buildCtx fills them from ONE call to getCrmStageDicts rather than from the generic property
  // loader — the `dealstage` PROPERTY carries no options at all, stages live on the pipelines.
  crmStage:      "derived",
  crmPipeline:   "derived",
  // The board's NATIVE Stage column, bucketed to the five labels it already has. Same single
  // getCrmStageDicts call as crmStage/crmPipeline — see coarseStageOf for why it is derived from
  // HubSpot's stage metadata rather than from the `stage` dictionary, which knows only the default
  // pipeline and minted GUID labels for every Salesforce-pipeline deal on 2026-09-15.
  crmCoarseStage: "derived",
  liBrand:       { object: "line_items", prop: "brand_isv" },
  liFamily:      { object: "line_items", prop: "family" },
  liSubcategory: { object: "line_items", prop: "product_subcategory" },
  liPricingModel:{ object: "line_items", prop: "hs_pricing_model" },
  liBillingFreq: { object: "line_items", prop: "recurringbillingfrequency" },
  liTaxRate:     { object: "line_items", prop: "hs_tax_rate_group_id" },
  liIsActive:    { object: "line_items", prop: "is_active" },
  liCurrency:    { object: "line_items", prop: "hs_line_item_currency_code" },
};

/** The label dictionaries THIS deployment's specs actually reference. */
export function labelDictsFor(env: { ENABLE_CRM?: string }): LabelDict[] {
  const want = new Set<LabelDict>();
  for (const spec of specsFor(env))
    for (const f of spec.fields) if (f.labels) want.add(f.labels);
  return [...want];
}

export async function buildCtx(env: Env): Promise<Ctx> {
  // Only the dictionaries this deployment needs, and only the ones that require a fetch. For the WM
  // deployment this resolves to the same 10 property/pipeline calls as before (its specs reference
  // every one of them); for CRM it is 5 calls and NOTHING under /deals.
  const wanted = labelDictsFor(env);
  const fetched = wanted.filter(d => LABEL_SOURCE[d] !== "derived");

  const [ownersById, mondayUsersByEmail, ...dicts] = await Promise.all([
    getOwners(env),
    getUsersByEmail(env),
    ...fetched.map(d => {
      const src = LABEL_SOURCE[d];
      return src === "dealPipelines" ? getDealStageLabels(env)
        : getPropertyOptions(env, (src as { object: string }).object, (src as { prop: string }).prop);
    }),
  ]);

  const labels: Partial<Record<LabelDict, Record<string, string>>> = {};
  fetched.forEach((d, i) => { labels[d] = dicts[i] as Record<string, string>; });

  // sales_user values are raw owner ids; label them with owner names.
  const salesUser: Record<string, string> = {};
  for (const [id, o] of Object.entries(ownersById)) if (o.name) salesUser[id] = o.name;
  // Derived dictionaries need no fetch, so they are always available regardless of the spec scan.
  labels.salesUser = salesUser;
  labels.pipeline = { default: "Sales Pipeline" };

  /**
   * THE CRM STAGE DICTIONARIES, fetched only when a spec asks for them — so the Work-Management
   * deployment makes exactly the calls it made before, and in particular still makes NOTHING under
   * /deals when running as CRM without them.
   *
   * One call fills three maps: the pipeline labels, the PIPELINE-QUALIFIED stage labels, and the
   * stage -> pipeline index that stagePipelinePairing needs to send a stage together with its own
   * pipeline. They come from one fetch because they come from one API response; splitting them would
   * triple the requests for no benefit.
   */
  let pipelineByStage: Record<string, string> | undefined;
  if (wanted.includes("crmStage") || wanted.includes("crmPipeline") || wanted.includes("crmCoarseStage")) {
    const d = await getCrmStageDicts(env);
    labels.crmStage = d.stages;
    labels.crmPipeline = d.pipelines;
    labels.crmCoarseStage = d.coarse;
    pipelineByStage = d.pipelineByStage;
  }

  // Reverse lookups for people-column reverse-sync: monday person id -> email -> HubSpot owner id.
  const mondayEmailByUserId: Record<string, string> = {};
  for (const [email, id] of Object.entries(mondayUsersByEmail)) mondayEmailByUserId[id] = email;
  /**
   * Email -> owner id, for turning a monday PERSON back into a HubSpot owner. An email claimed by more
   * than one owner is REMOVED, exactly like the name map below: nine HubSpot owners in this portal share
   * idaliang@dkmeco.com (Commercial, 华东销售, 华北销售, 华南销售, 华南主管, 华北主管, Maintenance, ADMIN A,
   * Ida Liang), and "last one wins" would assign whichever the API happened to list last. An ambiguous
   * person therefore resolves to nothing, and the edit is refused and healed rather than guessed.
   * Forward display is unaffected: every one of those owners still shows as Ida Liang.
   */
  const ownerIdByEmail: Record<string, string> = {};
  const emailSeen = new Set<string>();
  for (const [id, o] of Object.entries(ownersById)) {
    const e = (o.email ?? "").trim().toLowerCase();
    if (!e) continue;
    if (emailSeen.has(e)) { delete ownerIdByEmail[e]; continue; }
    emailSeen.add(e);
    ownerIdByEmail[e] = id;
  }
  /**
   * Owner NAME -> owner id, for `peopleByName` fields. A name claimed by more than one owner is
   * REMOVED rather than resolved to the first match: this portal holds two distinct owners both named
   * "Rick Antonio", and guessing between them would assign contacts to the wrong person. An ambiguous
   * or unknown name therefore resolves to nothing, which leaves the People cell empty — the correct
   * outcome, and the one the business already accepted for people with no monday account.
   */
  const ownerIdByName: Record<string, string> = {};
  const nameSeen = new Set<string>();
  for (const [id, o] of Object.entries(ownersById)) {
    const n = (o.name ?? "").trim().toLowerCase();
    if (!n) continue;
    if (nameSeen.has(n)) { delete ownerIdByName[n]; continue; }
    nameSeen.add(n);
    ownerIdByName[n] = id;
  }
  return { labels, ownersById, mondayUsersByEmail, mondayEmailByUserId, ownerIdByEmail, ownerIdByName,
    pipelineByStage, portalId: PORTAL_ID,
    // ITEM_NAME_FIT only, so names are compared fitted exactly while monday.ts writes them fitted. Off, the
    // key is absent and the Ctx is the one this always returned.
    ...(itemNameFitOn(env) ? { itemNameMax: MONDAY_ITEM_NAME_MAX } : {}) };
}

/** HubSpot -> monday for one record, plus monday-edit -> HubSpot when monday is the newer side. */
async function reconcileRecord(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem | undefined,
    stats: Stats, appSave = false, selfOrigin = false, edit?: MondayEdit,
    /** A deliberate repair: HubSpot is authoritative for this record now. See reconcileForwardOnly. */
    forceForward = false,
    /** A stopped creator's create window, handed over already: by its row's own alarm
     *  (settleAbandonedCreate), which runs inside that Durable Object, or by a 'have' read that took it
     *  (replayOnLinked). It is not asked for again. */
    takeover?: Takeover): Promise<void> {
  const group = targetGroup(rec, spec);
  if (!group) { stats.skipped++; return; }
  const recModified = rec.properties[spec.modifiedProp] ?? "";

  if (!existing) {
    // Go through the shared reservation rather than creating directly: `existing` may be a stale miss (the
    // id-column search is eventually consistent, and syncSpec's board snapshot can be minutes old), and a
    // blind create here is what produced duplicate cards.
    const r = await ensureCardForRecord(env, spec, ctx, rec, opts);
    if (r.status === "created") { stats.created++; budget.left--; }
    return;
  }

  // A CARD STILL INSIDE ITS CREATE WINDOW (a monday row whose HubSpot record was made seconds ago). See
  // createWindowFor. While its creator is alive, the creator brings the card into line: a forward pass
  // here would copy HubSpot's create-time values over a person's edits -- HubSpot's own post-create
  // recalculation makes the record look newer than the card's Sync State -- so it is left to the creator,
  // and an edit sends only itself. Once the creator has stalled or died, this sync settles the card in its
  // place, by the rules of the creator's own round (settleTakeover) -- or the row's alarm does, or a
  // 'have' read, and hands it in as `takeover`. A drawer save and an operator's forced repair are never
  // affected. Only while the CREATE_WINDOW_REPLAY switch is on (createWindowReplayOn): off, the card syncs
  // as it always did.
  let holdForward = false;
  let take: Takeover | undefined;
  if (createWindowReplayOn(env, spec) && spec.createFromMonday && !appSave && !forceForward) {
    if (takeover) take = takeover;
    else {
      const w = await createWindowFor(env, spec, rec, existing, edit, selfOrigin);
      if (w.leave) { stats.skipped++; return; }
      holdForward = w.holdForward;
      take = w.takeover;
      // The read may predate the Sync State the creator's settle wrote (it was made while the creator was
      // still settling): judged by the older stamp, HubSpot's post-create recalculation would read as
      // newer than every cell the settle held, and copy HubSpot's values over them.
      if (w.baseline) existing = withBaseline(existing, spec, { baseline: w.baseline });
    }
  }

  await maintainShared(env, spec, rec, existing, opts, budget); // toggle the Shared team on sales_user change

  // COLUMN-LEVEL SPECS take their own path for everything except a drawer save. See
  // ObjectSpec.columnLevelReverse: a person's edit pushes only what they edited; anything else only
  // ever writes monday. The drawer (appSave) is explicit intent over every field it shows, so it keeps
  // the record-level behaviour below.
  if (spec.columnLevelReverse && !appSave) {
    // A stalled or dead creator's create window, settled by this sync in its place (with this event's own
    // edit, if it carries a person's or an automation's): its queue is sent as the edits it is, and the
    // card is brought into line as the creator would have, rather than by a forward pass.
    if (take) return settleTakeover(env, spec, ctx, opts, budget, rec, existing, stats, take,
      edit && (edit.cols.length || edit.name) && !selfOrigin ? edit : undefined);
    if (edit && (edit.cols.length || edit.name) && !selfOrigin)
      return reconcileColumnEdit(env, spec, ctx, opts, budget, rec, existing, stats, edit, holdForward);
    return reconcileForwardOnly(env, spec, ctx, opts, budget, rec, existing, stats, forceForward);
  }

  const lastSynced = colText(existing, spec.syncStateCol);
  // APP SAVE = INTENT. The rep just edited this card in a drawer, so monday wins and an empty HubSpot
  // field is fillable. Two concrete failures this prevents:
  //  - the drawer's own HubSpot association writes run BEFORE this sync, bumping the record's
  //    lastmodifieddate past the card's Sync State, which flipped newer-wins to `toMonday` and REVERTED
  //    the very edits being saved (drawer still reported success);
  //  - a field HubSpot has never held produced no diff at all, so the edit silently never left monday.
  const diffs = fieldDiffs(rec, existing, spec, ctx, appSave);
  // `selfOrigin` PINS THE DIRECTION FORWARD. The event came from our own token, so there is no user
  // intent behind it and nothing to push back — see isIntegrationActor. Deciding by timestamp instead
  // would sometimes pick "toHubspot" for a card we had just written ourselves, which is how a bulk
  // seed turns into a bulk write-back.
  const dir = selfOrigin ? "toMonday"
    : appSave && diffs.length ? "toHubspot"
    : decideDirection(diffs, recModified, lastSynced);

  // SAFE BACKFILLS RIDE OUTSIDE THE DIRECTION DECISION. A backfill fills an EMPTY HubSpot field from a
  // non-empty monday value: it can never overwrite or clear real HubSpot data, so it is non-conflicting by
  // definition and has no business in the record-level newer-wins arbitration. If it rode along, a
  // `toMonday` pass (HubSpot record newer than our sync state) would write nothing for the empty field —
  // buildUpdatePayload's formatValue returns null — then stamp the sync state and silently drop the fill.
  // Contacts are `skipFullReconcile`, so nothing would ever retry it. Runs before the branch below; the
  // `toHubspot` path already carries backfills inside buildReversePatch, so skip it there to avoid a
  // duplicate PATCH.
  // A backfill PATCH bumps the record's lastmodifieddate, so the baseline stamped below must be the
  // POST-patch value. Stamping the pre-patch one would leave hs > synced, and the next reconcile would
  // read that as "HubSpot is newer" and overwrite a rep's monday edit instead of pushing it.
  const backfilledMod = dir !== "toHubspot"
    ? await writeSafeBackfills(env, spec, ctx, opts, budget, rec, existing, diffs)
    : null;
  const stampMod = backfilledMod ?? recModified;

  if (dir === "none") {
    stats.inSync++;
    if (lastSynced !== stampMod) { // establish baseline so future monday edits win correctly
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: stampMod }, opts);
      budget.left--; // count the bookkeeping write so a first-run backlog can't overrun the tick
    }
    return;
  }

  if (dir === "toHubspot") {
    const patch = buildReversePatch(diffs, existing, spec, ctx);
    if (Object.keys(patch).length > 0) {
      // ONLY NOW is a HubSpot business write actually required, so only now may ownership be claimed.
      const auth = await ensureHubspotWriteAuth(env, spec, budget, rec, opts);
      if (auth && !auth.allowed) {
        // Refused (wm-owned, parked, historical, or a claim that could not be made). HubSpot is left
        // alone — but we FALL THROUGH to the forward write rather than returning.
        //
        // Returning here froze the whole card. On the CRM deployment the claim can never succeed
        // today (WRITE_HUBSPOT=false makes claimOwnership a no-op, so the record stays unstamped and
        // authorizeWrite denies), which meant ONE reversible monday-side diff — a rep fixing a typo in
        // Job Title — starved every FORWARD-only field on that card indefinitely: all 11 new sidebar
        // columns, Lifecycle Stage, 状态, everything. And because Sync State was left unstamped,
        // decideDirection kept choosing "toHubspot" on every later webhook, so the card never healed
        // except by someone editing the record in HubSpot. With skipFullReconcile and no SYNC crons (the
        // CRM Worker's only cron is */15: the marketing poller, and the LAD sweep, which revisits a record
        // only when its notes_last_updated moves -- pinned by deploy-config.test.ts), nothing else ever
        // retried it.
        //
        // Falling through is also the correct SEMANTIC: if monday may not write to HubSpot, then
        // HubSpot is the authority and the card should be brought back into line with it. The rep's
        // edit visibly snaps back, which is honest, rather than silently sitting in a frozen card.
        console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id}`
          + ` action=refused-forward-instead fields=${Object.keys(patch).join(",")}`
          + ` reason="${auth.reason}"`);
        stats.skipped++;
        // no return — the forward write below reconciles the card to HubSpot
      } else {
        const filled = diffs.filter(d => d.backfill && d.f && patch[d.f.hs] !== undefined);
        // The record-level write (a drawer save, the WM specs): the card as a whole is sent.
        const newMod = await sendPatch(env, spec, ctx, rec, existing.id, patch, opts, auth, [ALL_CELLS]);
        // Audit trail for the controlled backfill (a failed patch throws and is logged by the caller).
        for (const d of filled)
          console.log(`[backfill] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} field=${d.f!.hs} previous="" value="${patch[d.f!.hs]}" result=${newMod === null ? "dry-run" : "written"}`);
        await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: newMod ?? recModified }, opts);
        stats.toHubspot++; budget.left--;
        return;
      }
    }
    // nothing reversible differs -> fall through to a forward write
  }

  // Move BEFORE the value/syncState write: if the move fails, syncState stays unstamped so the next
  // tick re-runs toMonday (never flips to a reverse write that reverts the HubSpot stage change).
  if (diffs.some(d => d.kind === "group")) await moveItem(env, spec.boardId, existing.id, group, opts);
  const cv = buildUpdatePayload(diffs, rec, spec, ctx);
  cv[spec.syncStateCol] = stampMod;   // post-backfill timestamp (see the note above)
  await updateItem(env, spec.boardId, existing.id, itemName(rec, spec), cv, opts);
  stats.toMonday++; budget.left--;
}

/**
 * COLUMN-LEVEL, FORWARD-ONLY: a sync that no person's monday edit started -- a HubSpot webhook, a
 * sweep, our own token's echo, a monday event that names no column. It writes MONDAY or nothing.
 *
 * It acts only when HubSpot has changed since the card's Sync State. If it has not, every difference
 * on the card is monday-side, and that is either a person's edit whose column-level push is still in
 * flight or a value that push refused and already healed -- in neither case is overwriting it right.
 * The record-level engine read the same situation as "monday is newer, push it", which is exactly the
 * stale-overwrite this spec flag exists to remove.
 *
 * Never backfills and never claims: both are HubSpot writes, and this path has no person behind it.
 *
 * STALE_FORWARD_GATE (staleForwardGateOn): the per-cell pass below (forwardOnlyGated) instead -- unless forced. Off,
 * or forced (an operator's /resync), this pass exactly as it was (forwardOnlyHead).
 */
async function reconcileForwardOnly(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem,
    stats: Stats,
    /**
     * FORCE: forward every difference even though HubSpot is not newer than Sync State.
     *
     * Needed because the OLD engine stamped Sync State without applying some changes -- a filled People
     * cell was never updated, but the pass that ignored it still stamped the card. On such a card Sync
     * State equals HubSpot's last change while the cell is stale, so the ordinary rule reads the stale
     * cell as a person's pending edit and never heals it. Only the /resync repair route passes this,
     * for records an operator has chosen; ordinary traffic never does.
     */
    force = false): Promise<void> {
  if (!force && staleForwardGateOn(env, spec)) {
    await forwardOnlyGated(env, spec, ctx, opts, budget, rec, existing, stats);
    return;
  }
  return forwardOnlyHead(env, spec, ctx, opts, budget, rec, existing, stats, force);
}

/** reconcileForwardOnly as it always was: HEAD's body, unchanged. */
async function forwardOnlyHead(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem,
    stats: Stats, force: boolean): Promise<void> {
  // THE ONE HUBSPOT WRITE THIS PATH MAKES: a backward move's clear whose set never followed, finished from
  // the card (repairDanglingClears). Not finished now -> the pass still brings the card into line, but
  // leaves Sync State where it was and then throws, so the queue retries and the next event still sees it.
  const unfinished = await repairDanglingClears(env, spec, ctx, opts, budget, rec, existing);
  const recModified = rec.properties[spec.modifiedProp] ?? "";
  const lastSynced = colText(existing, spec.syncStateCol);
  const diffs = fieldDiffs(rec as HsRecord, existing, spec, ctx, false)
    .filter(d => !d.backfill);   // a backfill is a HubSpot write; formatValue("") would write nothing anyway
  const dir = force && diffs.length ? "toMonday" : decideDirection(diffs, recModified, lastSynced);

  if (dir !== "toMonday") {
    if (dir === "none") stats.inSync++; else stats.skipped++;
    // Establish a baseline so a later monday edit and a later HubSpot change are both distinguishable.
    // Only when the card is genuinely in line: stamping over a pending monday-side diff would bury it.
    if (dir === "none" && recModified && lastSynced !== recModified && !unfinished) {
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: recModified }, opts);
      budget.left--;
    }
    if (unfinished) throw unfinished;
    return;
  }

  if (diffs.some(d => d.kind === "group")) {
    const group = targetGroup(rec as HsRecord, spec);
    if (group) await moveItem(env, spec.boardId, existing.id, group, opts);
  }
  const cv = buildUpdatePayload(diffs, rec as HsRecord, spec, ctx);
  if (!unfinished) cv[spec.syncStateCol] = recModified;
  await updateItem(env, spec.boardId, existing.id, itemName(rec as HsRecord, spec), cv, opts);
  stats.toMonday++; budget.left--;
  // Worked in HubSpot (a Lifecycle off 1.NEW, a Lead Status set) -> out of "No Activity" (NO_ACTIVITY_RELEASE).
  // Only the columns this pass just changed: hsText is the label the card shows now. Never on an operator's
  // forced repair (/resync, scripts/refresh-forward.mjs): correcting a stale cell is not work, and that repair
  // promises it moves no card.
  if (!force)
    await releaseOnWorkedChanges(env, spec, existing.id, existing.group?.id,
      diffs.filter(d => d.kind === "field" && d.f).map(d => ({ col: d.f!.col, label: d.hsText })),
      "changed in HubSpot", opts);
  if (unfinished) throw unfinished;
}

// ===================================================================================================================
// STALE_FORWARD_GATE: THE FORWARD PASS, CELL BY CELL. The rules are card-watch.ts's; this is the I/O around them.
// ===================================================================================================================

/** What a converge hands the forward pass: its own two reads, and the watch it judges against. */
interface ConvergeIn {
  snapshot: CardWatch;
  history: Record<string, HsVersion[]>;
  stamps: Record<string, number | null>;
  values: Record<string, string | null>;
}

/** One gated cell in play, and what became of it. */
interface Judged {
  d: Diff;
  key: string;
  fp: string;
  typed: boolean;
  c: number | null;
  props: string[];
  coarse: boolean;
  verdict: CellVerdict;
  newestNonOwn?: number;
  final?: FinalVerdict | "rescued" | "stuck" | "log-unreadable";
  why?: string;
  /** The watch's loop breaker leaves this value alone. */
  stuck?: boolean;
}

/** Column types whose cells monday stamps with changed_at (live 2026-10-09: status, date, people). Before a card is
 *  read, any other cell may be untyped; once read, the stamps say. */
const TYPED_COL_TYPES = new Set(["status", "date", "people"]);

/** The properties a gated pass reads back: the spec's, and everything its first read carried. */
function readPropsOf(spec: ObjectSpec, rec: { properties: Record<string, string | null> }): string[] {
  return [...new Set([...propertiesForSpec(spec), ...Object.keys(rec.properties)])];
}

/** The record again, with the history of `props`; "gone" on a 404, "failed" when it could not be read. */
async function readHistory(env: Env, spec: ObjectSpec, rec: { id: string; properties: Record<string, string | null> },
    props: string[], where: string): Promise<{ rec: HsRecord; history: Record<string, HsVersion[]> } | "gone" | "failed"> {
  try {
    const r = await getRecordWithHistory(env, spec.object, rec.id, readPropsOf(spec, rec), props);
    if (!r) return "gone";
    return { rec: { id: rec.id, properties: r.properties }, history: r.history };
  } catch (e) {
    console.log(`${where} action=history-unreadable props=${props.join(",")} reason="${String(e).slice(0, 160)}"`
      + ` next="two-way cells judged without it: held while recent, left otherwise"`);
    return "failed";
  }
}

/** Would writing `stamp` move this card's Sync State FORWARD (or give it its first)? Never backwards, never a no-op. */
function stampsForward(stamp: string | null | undefined, current: string): boolean {
  return !!stamp && !(timeOf(current) >= timeOf(stamp));
}

/**
 * COLUMN-LEVEL FORWARD PASS, CELL BY CELL (STALE_FORWARD_GATE).
 *
 *  1. A backward move's clear left unfinished is finished first (repairDanglingClears), as HEAD.
 *  2. IN PLAY: every difference when HubSpot changed since Sync State (HEAD's rule), otherwise only those this pass's
 *     events name -- and, in a converge, those the card's watch holds.
 *  3. Nothing in play: HEAD (stamp a baseline that moves forward; leave the rest), but every two-way difference left
 *     goes to the card's watch, so it converges when its hold ends even if HubSpot never changes again.
 *  4. A one-way difference is HubSpot's alone: forwarded, as HEAD. A TWO-WAY one is judged by itself (card-watch.ts
 *     judgeCell): HubSpot's history first (only when its verdict needs it), then the card with its changed_at
 *     stamps; one more history read for a tie. The watch's veto (applyVeto) then holds a cell a person's edit is on
 *     its way to (its mark), and turns an expired untyped hold into a candidate. A candidate is left for the watch to
 *     converge -- in the converge itself it is rescued (STALE_FORWARD_RETRY, a person's edit the log proves, made
 *     after the card was linked to its record) or converged, through the loop breaker.
 *  5. ONE write: the forwarded cells, with HubSpot's name ONLY when the name itself is forwarded (a rename still on
 *     its way is never written over), never waiting on monday's rate limit (a refused write leaves the cells due for
 *     a converge on a fresh read; it is never sent minutes late). Sync State only when no two-way cell in play was
 *     left, and only forward; every stamp goes to the card's register (noteStamp). A converge reads its written cells
 *     back once, so the loop breaker remembers only a write that did not take.
 * The Deals coarse Stage is gated like a typed cell and keeps HEAD's timing: a candidate is forwarded only when
 * HubSpot is newer than Sync State -- at the pass, or (its hold registered with the watch) at a pass that judged the
 * same value while it was held; never rescued. A DRY RUN (an operator's /resync dryRun) leaves nothing durable: the
 * watch is only asked (read only), and nothing is noted, marked or queued.
 */
async function forwardOnlyGated(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem, stats: Stats,
    conv?: ConvergeIn): Promise<ConvergeOutcome> {
  const out: ConvergeOutcome = { resolved: [], forwarded: [], held: [], stuck: [], rescued: [] };
  const W = holdWindowMs(env);
  const dry = !!opts.dryRun;
  const scope = conv ? undefined : opts.scope;
  const base: WatchBase = { boardId: spec.boardId, itemId: existing.id, object: spec.object, recordId: rec.id };
  const where = `[forward] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id}`;
  const unfinished = await repairDanglingClears(env, spec, ctx, opts, budget, rec, existing);
  let fresh: HsRecord = { id: rec.id, properties: rec.properties };
  let card = existing;
  let history: Record<string, HsVersion[]> | undefined = conv?.history;
  let stamps: Record<string, number | null> = conv?.stamps ?? {};
  let values: Record<string, string | null> = conv?.values ?? {};
  let historyFailed = false;

  const newer = () => (Date.parse(fresh.properties[spec.modifiedProp] ?? "") || 0)
    > (Date.parse(colText(card, spec.syncStateCol)) || 0);
  const gp = (d: Diff) => gatedProps(env, spec, d, fresh);
  const isCoarse = (d: Diff) => d.kind === "field" && !!d.f && isCoarseGated(env, spec, d.f);
  const named = (d: Diff) => newestNamed(scope, gp(d) ?? diffProps(spec, d, fresh));
  const watched = (d: Diff) => !!conv && !!gp(d)
    && (conv.snapshot.allAt !== undefined || Object.hasOwn(conv.snapshot.cells, gateKey(d)));
  const diffsOf = () => fieldDiffs(fresh, card, spec, ctx, false).filter(d => !d.backfill);
  const inPlayOf = (ds: Diff[]) => newer() ? ds : ds.filter(d => !!named(d) || watched(d));
  const resolveWatched = (ds: Diff[]) => {
    if (!conv) return;
    const differing = new Set(ds.filter(d => gp(d)).map(gateKey));
    out.resolved.push(...Object.keys(conv.snapshot.cells).filter(k => !k.startsWith("rel:") && !differing.has(k)));
  };
  const gone = (why: string): ConvergeOutcome => {
    stats.skipped++;
    console.log(`${where} action=skipped reason="${why}"`);
    if (unfinished) throw unfinished;
    return { ...out, done: true };
  };

  let diffs = diffsOf();
  let inPlay = inPlayOf(diffs);

  // 3. NOTHING IN PLAY. (A coarse Stage difference here is one HubSpot is not newer than: HEAD's timing leaves it.)
  const nothingInPlay = async (): Promise<ConvergeOutcome> => {
    resolveWatched(diffs);
    if (!diffs.length) {
      stats.inSync++;
      const stamp = fresh.properties[spec.modifiedProp] ?? "";
      if (!unfinished && stampsForward(stamp, colText(card, spec.syncStateCol))) {
        // HEAD's baseline write, with gql's own rate-limit waits (it may land minutes late): noted, as step 8 says.
        const s0 = Date.now();
        await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: stamp }, opts);
        budget.left--;
        await noteStamp(env, base, stamp, s0, Date.now(), spec.syncStateCol, dry);
      }
    } else {
      stats.skipped++;
      const reqs: WatchReq[] = diffs.filter(d => gp(d) && !isCoarse(d)).map(d => ({ key: gateKey(d), fp: cellFp(d, card),
        typed: false, anchor: updatedAtMs(card.updated_at), kind: "hold", hs: d.hsText }));
      if (conv) out.held.push(...reqs);
      else if (reqs.length) await watchCells(env, base, reqs, { windowMs: W, dryRun: dry });
    }
    if (unfinished) throw unfinished;
    return out;
  };
  if (!inPlay.length) return nothingInPlay();

  // 5. THE FRESH READS, only when a two-way cell is in play: HubSpot (with the history the verdicts need) FIRST,
  // then the card with its stamps -- so the card read is never older than the HubSpot read it is judged against.
  if (!conv && inPlay.some(d => gp(d))) {
    const u0 = updatedAtMs(card.updated_at);
    const ask = new Set<string>();
    for (const d of inPlay) {
      const props = gp(d);
      if (!props) continue;
      const possiblyUntyped = d.kind === "name" || !TYPED_COL_TYPES.has(d.f!.type);
      if (needHistoryBefore({ scoped: !!scope, named: named(d), possiblyUntyped, u: u0 })) for (const p of props) ask.add(p);
    }
    if (ask.size) {
      const r = await readHistory(env, spec, rec, [...ask], where);
      if (r === "gone") return gone("the record is gone from HubSpot since this pass read it");
      if (r === "failed") historyFailed = true;
      else { fresh = r.rec; history = r.history; }
    }
    try {
      const c = await getItemFresh(env, existing.id, gatedCols(env, spec));
      if (!c) return gone("the card is gone since this pass read it");
      card = c.item; stamps = c.stamps; values = c.values;
    } catch (e) {
      console.log(`${where} action=stamps-unreadable reason="${String(e).slice(0, 160)}" next="every cell judged as untyped"`);
    }
    diffs = diffsOf();
    inPlay = inPlayOf(diffs);
    if (!inPlay.length) return nothingInPlay();
  }

  // 6. JUDGE every two-way cell in play.
  const now = Date.now();
  const S = timeOf(colText(card, spec.syncStateCol));
  const u = updatedAtMs(card.updated_at);
  const judge = (d: Diff, props: string[]): Judged => {
    const c = d.kind === "field" ? (stamps[d.f!.col] ?? null) : null;
    const versions = mergedVersions(history, props);
    const fpOf = d.kind === "name"
      ? (v: TaggedVersion) => fpOfName(spec, ctx, v.prop, v.value)
      : (v: TaggedVersion) => fpOfField(d.f!, v.value, ctx);
    const md = d.kind === "name" ? card.name.trim() : d.mdText;
    const fp = cellFp(d, card);
    const verdict = judgeCell({ c, u, S, versions, named: named(d), md, fp, fpOf, now, W, historyFailed });
    return { d, key: gateKey(d), fp, typed: c !== null, c, props, coarse: isCoarse(d), verdict,
      newestNonOwn: newestNonOwnAt(versions) };
  };
  const plain: Diff[] = [];
  const judged: Judged[] = [];
  for (const d of inPlay) {
    const props = gp(d);
    if (props) judged.push(judge(d, props)); else plain.push(d);
  }
  // The tie zone, an event whose source cannot be told, an untyped cell changed since its event: ONE more read.
  const more = judged.filter(j => j.verdict.v === "need-history");
  if (more.length) {
    const r = await readHistory(env, spec, rec, [...new Set(more.flatMap(j => j.props))], where);
    if (r === "gone" || r === "failed") historyFailed = true;
    else history = { ...(history ?? {}), ...r.history };
    for (const j of more) Object.assign(j, judge(j.d, j.props));
  }
  /** HubSpot's newest change of the cell that is not ours, as this pass knows it: from the history when read, else
   *  the event that named it (when not ours). A person's edit older than it never holds it off (V3). */
  const newsAtOf = (j: Judged): number | undefined => {
    if (j.newestNonOwn !== undefined) return j.newestNonOwn;
    const ev = named(j.d);
    return ev && ev.own === false && Number.isFinite(ev.at) && ev.at > 0 ? ev.at : undefined;
  };

  // 7. THE WATCH: one RPC (in a converge, the snapshot it was given), only when it can change something.
  const reqs: WatchReq[] = [];
  const resolvedKeys: string[] = [];
  // Two-way differences this pass did not put in play (HubSpot not newer, nothing names them): left, as HEAD leaves
  // them -- and handed to the watch, as step 3 hands them, so they converge when their hold ends whatever else happens.
  const unplayed: WatchReq[] = diffs.filter(d => gp(d) && !isCoarse(d) && !inPlay.includes(d))
    .map(d => ({ key: gateKey(d), fp: cellFp(d, card), typed: false, anchor: u, kind: "hold", hs: d.hsText }));
  if (conv) out.held.push(...unplayed); else reqs.push(...unplayed);
  for (const j of judged) {
    const v = j.verdict;
    const hs = j.d.hsText;
    // The coarse Stage's hold remembers that HubSpot was newer while it was held: its converge then keeps HEAD's word.
    const nw = j.coarse && newer() ? { newer: true } : {};
    if (v.v === "hold") reqs.push({ key: j.key, fp: j.fp, typed: v.typed, anchor: v.anchor, kind: "hold", hs, ...nw });
    // A coarse candidate is forwarded now when HubSpot is newer, and otherwise left to HEAD's timing: only asked.
    else if (v.v === "candidate") reqs.push({ key: j.key, fp: j.fp, typed: v.typed, anchor: j.c ?? u,
      kind: j.coarse ? "probe" : "candidate", hs, ...nw });
    else if (v.v === "forward") {
      // An untyped forward a live mark may veto (the card changed at or after HubSpot's news): the watch resolves it,
      // or -- vetoed -- keeps it held, so it still converges once the mark resolves. Otherwise simply resolved.
      const newsAt = newsAtOf(j);
      if (!j.typed && (newsAt === undefined || u >= newsAt))
        reqs.push({ key: j.key, fp: j.fp, typed: false, anchor: u, kind: "forward", hs,
          ...(newsAt !== undefined ? { newsAt } : {}) });
      else resolvedKeys.push(j.key);
    }
  }
  let replies: Record<string, WatchReply> | null = {};
  if (conv) replies = reduceWatchCells(conv.snapshot, base, reqs, { resolved: resolvedKeys }, now, W,
    staleForwardRetryOn(env, spec)).replies;
  else if (reqs.length || resolvedKeys.length)
    replies = await watchCells(env, base, reqs, { resolved: resolvedKeys, windowMs: W, dryRun: dry });
  if (replies === null)
    console.log(`${where} action=watch-unreachable next="holds stand, candidates are left, forwards proceed"`);
  for (const j of judged) {
    const r = replies === null ? null : replies[j.key];
    const v = applyVeto(j.verdict, r, { typed: j.typed, newestNonOwn: newsAtOf(j), unreachable: replies === null });
    j.final = v.final; j.why = v.why; j.stuck = !!r?.stuck;
    if (j.verdict.v === "hold" && v.final === "candidate")
      console.log(`${where} col=${j.d.kind === "name" ? "name" : j.key} action=hold-ended reason="${v.why}"`);
    // The coarse Stage keeps HEAD's timing: a candidate goes across only when HubSpot is newer than Sync State (in a
    // converge: or was, at a pass that judged this held value).
    if (j.coarse && j.final === "candidate") {
      const go = conv ? newer() || !!conv.snapshot.cells[j.key]?.newer : newer();
      j.final = go ? "forward" : "left";
      j.why = go ? "HubSpot is newer than Sync State (the coarse Stage's own timing)"
        : "the coarse Stage waits for HubSpot to be newer (HEAD's timing)";
    } else if (!conv && j.final === "candidate") j.final = "left";      // V4: the watch converges it
  }

  // THE CONVERGE'S CANDIDATES: a person's edit the activity log proves is RESCUED (marked, and retried; never
  // the name, a relation or the coarse Stage; never a value from before the card was linked to its record, nor from
  // beyond the rescue's horizon); every other one is CONVERGED to HubSpot -- through the loop breaker.
  if (conv) {
    const retryOn = staleForwardRetryOn(env, spec);
    const cands = judged.filter(j => j.final === "candidate");
    const rescuable = cands.filter(j => retryOn && j.d.kind === "field" && !j.coarse
      && (conv.snapshot.convergeAttempts ?? 0) < LOG_RETRY_MAX
      && !gaveUpMatches(conv.snapshot.gaveUp?.[j.key], j.fp, now)
      && Object.hasOwn(columnEditPatch(fresh, card, spec, ctx, { cols: [j.key] }).patch, j.d.f!.hs));
    // THE HORIZON (RESCUE_LOOKBACK_MS): an edit is rescued only when made at most that long before the watch first held
    // this value of the cell (a cell it never held: now), and never before the CRM cutover -- anything older is history.
    const cutover = timeOf(env.CRM_CUTOVER_AT);
    const horizonOf = (j: Judged) => Math.max((conv.snapshot.cells[j.key]?.seen ?? now) - RESCUE_LOOKBACK_MS,
      Number.isFinite(cutover) ? cutover : -Infinity);
    // A candidate whose history this converge did not read (put in play by HubSpot being newer, or a converge-all):
    // read now, once -- the provenance check below needs it, and declines only when this read fails too.
    const unread = rescuable.filter(j => mergedVersions(history, j.props) === undefined);
    if (unread.length) {
      const r = await readHistory(env, spec, fresh, [...new Set(unread.flatMap(j => j.props))], where);
      if (r !== "gone" && r !== "failed") history = { ...(history ?? {}), ...r.history };
    }
    let rows: Record<string, CellChange | null> | null = {};
    if (rescuable.length) {
      // From each candidate's change (or hold) -- never from before its horizon: an older row is not looked at.
      const from = rescuable.map(j => Math.max(j.c ?? conv.snapshot.cells[j.key]?.since ?? u, horizonOf(j)))
        .filter(Number.isFinite);
      // The record-id cell too: its newest write in the window is when the card was linked to its record.
      rows = await lastCellChanges(env, spec, card.id, [...rescuable.map(j => j.key), spec.idCol],
        from.length ? Math.min(...from) : now);
    }
    // WHEN THE CARD WAS LINKED to its record (an adoption, a monday-born create): its watch's record of it, or the id
    // cell's newest write in the log window (none there: linked before it -- every row in the window is after it; one
    // that cannot be told: nothing is rescued), except a monday-born create's own id write-back, which follows the
    // create's read that linked it (effectiveLinkAt). A value set before it is the form's, never an edit of the record.
    const linkAt = effectiveLinkAt(conv.snapshot, rows === null ? undefined : rows[spec.idCol]);
    const rescues: MarkInput[] = [];
    for (const j of cands) {
      if (!rescuable.includes(j)) { j.final = "forward"; continue; }
      if (rows === null) { j.final = "log-unreadable"; continue; }
      const row = rows[j.key];
      // A People cell: the removal the row records -- emptying a cell that showed someone other than HubSpot's owner
      // is refused, exactly as a live run refuses it (unknown: removed nobody, so a clear is never rescued).
      const people = j.d.f!.type === "people";
      if (!(row && row.atMs > linkAt && row.atMs >= horizonOf(j) && (row.cls === "person" || row.cls === "automation")
          && row.valueFp === cardValueFingerprint(values[j.key])
          && (!people || Object.hasOwn(columnEditPatch(fresh, card, spec, ctx,
            { cols: [j.key], removedPeople: { [j.key]: row.removed ?? [] } }).patch, j.d.f!.hs)))) {
        j.final = "forward";
        continue;
      }
      // PROVENANCE: the edit is sent only over what is OLDER than it. HubSpot's newest version that this card's own
      // writes do not explain -- anyone else's, or our app's own from another path or card (an operator's script, the
      // /app clear routes, a duplicate card) -- must predate the person's row. Then this card's own writes
      // (ownLaterVerdict): a later push of the property from another of its cells wins; and the edit is sent once --
      // when this card has sent this very value since the edit, HubSpot holding something else now is its answer,
      // converged (no loop) -- unless what HubSpot holds is this cell's own STALE push that landed after it (the edit
      // never landed). Whatever the card's own records cannot tell (no history read, a write it could not record) is
      // not sent.
      const versions = mergedVersions(history, j.props);
      const foreignAt = newestForeignAt(versions, conv.snapshot.pushes, rec.id);
      const want = columnEditPatch(fresh, card, spec, ctx, { cols: [j.key] }).patch[j.d.f!.hs];
      const own = versions && ownLaterVerdict(versions, conv.snapshot.pushes, rec.id, j.d.f!.hs, j.key, want, row.atMs);
      const declined = versions === undefined ? "HubSpot's history of it was not read: nothing is sent on that uncertainty"
        : foreignAt !== undefined && foreignAt >= row.atMs ? "HubSpot holds a later change -- another writer's, or our app's"
          + " from another path or card: the later change wins"
        : own === "sibling" ? "HubSpot holds this card's later push of the same property from another cell: that later"
          + " edit wins"
        : own === "sent" ? "this card already sent this edit and HubSpot holds something else now: converged to it, never"
          + " sent again"
        : undefined;
      if (declined) {
        j.final = "forward";
        console.log(`[converge] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} col=${j.key}`
          + ` action=rescue-declined reason="${declined}"`);
        continue;
      }
      j.final = "rescued";
      rescues.push({ key: j.key, at: row.atMs, rx: now, actor: row.userId, byAutomation: row.cls === "automation", rescued: true,
        ...(people ? { people: row.removed ?? null } : {}) });
    }
    // THE LOOP BREAKER: a converged candidate (never HubSpot's own later change: a forward verdict) is left alone only
    // when the cell shows exactly what our earlier write of the SAME HubSpot value became on monday, and HubSpot has
    // not changed it since -- a write that does not take is not repeated. A new value on the cell is converged again.
    for (const j of judged) {
      if (j.final !== "forward" || j.verdict.v === "forward") continue;
      const f = conv.snapshot.fwd?.[j.key];
      if (f && f.fp !== undefined && f.fp === j.fp && f.hs === j.d.hsText && now - f.at < STUCK_MS
          && !(j.newestNonOwn !== undefined && j.newestNonOwn > f.at)) {
        j.final = "stuck";
        console.log(`[converge] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} col=${j.key}`
          + ` action=converge-stuck reason="the cell still shows what our write of this HubSpot value became on monday: not written again"`);
      }
    }
    for (const j of judged) if (j.final === "log-unreadable")
      console.log(`[converge] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} col=${j.key}`
        + ` action=rescue-unreadable reason="monday's activity log could not be read: the cell is left, and judged again later"`);
    // THE RE-PROBE: the rescue's reads (the log, a history) stand between this converge's card read and its write --
    // seconds -- and a person's edit made meanwhile carries a mark the snapshot does not have. Asked again (one RPC): a
    // cell about to be written that now has a live mark is held instead, for that edit's own run. (Unreachable: the
    // snapshot's word stands, as for every forward write.)
    const writing = rescuable.length && !dry ? judged.filter(j => j.final === "forward") : [];
    if (writing.length) {
      const again = await watchCells(env, base, writing.map(j => ({ key: j.key, fp: j.fp, typed: j.typed, anchor: j.c ?? u,
        kind: "probe" as const })), { windowMs: W });
      for (const j of writing) if (again?.[j.key]?.mark) {
        j.final = "hold";
        j.why = "a person's edit of it arrived while the converge read monday's log (mark): left to that edit's own run";
      }
    }
    if (rescues.length && !dry) {
      await markEdits(env, base, rescues);
      console.log(`[converge] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id}`
        + ` cols=${rescues.map(r => r.key).join(",")} action=rescued reason="a person's (or an automation's) edit monday's log`
        + ` proves, never pushed: it is sent from the card"`);
      const type = eventTypeOfObject(spec.object);
      if (type) await spillDeferred(env, [{ type, id: existing.id, watch: { boardId: spec.boardId, kind: "retry" } }]);
    }
  }

  for (const j of judged) {
    if (j.final === "forward" || j.final === "rescued" || j.final === "stuck") continue;
    console.log(`${where} col=${j.d.kind === "name" ? "name" : j.key} action=${j.final === "hold" ? "forward-held" : "forward-left"}`
      + ` reason="${j.why}"`);
  }

  // 8. ONE WRITE. A pass that judged a two-way cell never waits on monday's rate limit (§16); one that did not is
  // HEAD's write -- gql may hold it through up to six rate-limit waits (65 s at most each), so it can land minutes
  // late. Its stamp is NOTED either way, once the write returns (noteStamp, below): the card's register keeps every
  // note in its Durable Object's storage for STAMP_NOTE_WINDOW_MS (16 min) -- longer than gql's waits with a minute
  // for each of its requests, and than the 15 minutes any invocation that can wait that long lives -- so an older
  // stamp landing after a newer one is compared with the newer's note, read back and restored. (A write whose
  // invocation is cut off mid-request may still land, un-noted: Sync State then stays older until the card's next
  // stamping pass moves it forward.) Meanwhile no verdict is misled by an older Sync State: our own versions are never
  // news, the typed and never-held verdicts ignore Sync State, and marks veto untyped news.
  const fwdDiffs = [...plain, ...judged.filter(j => j.final === "forward").map(j => j.d)];
  const left = judged.filter(j => j.final !== "forward");
  const waits = judged.length ? 0 : undefined;
  const stamp = fresh.properties[spec.modifiedProp] ?? "";
  // Never while a two-way cell in play is left (its value is not HubSpot's), never backwards, never over an
  // unfinished repair. A cell the loop breaker leaves (stuck) shows what our write of HubSpot's CURRENT value became
  // on monday (the breaker holds only for that value): it has HubSpot's value already, as monday renders it.
  const mayStamp = !unfinished && !left.some(j => j.final !== "stuck" && !j.stuck)
    && stampsForward(stamp, colText(card, spec.syncStateCol));
  // The stamp's write window, for the card's register (§13): every gated Sync State write is noted.
  let stampWindow: [number, number] | undefined;
  if (!fwdDiffs.length) {
    if (left.length) stats.skipped++; else stats.inSync++;
    if (mayStamp) {
      const s0 = Date.now();
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: stamp }, opts, waits);
      budget.left--;
      stampWindow = [s0, Date.now()];
    }
  } else {
    if (fwdDiffs.some(d => d.kind === "group")) {
      const group = targetGroup(fresh, spec);
      if (group) await moveItem(env, spec.boardId, existing.id, group, opts, waits);
    }
    const cv = buildUpdatePayload(fwdDiffs, fresh, spec, ctx);
    if (mayStamp) cv[spec.syncStateCol] = stamp;
    const renames = fwdDiffs.some(d => d.kind === "name");
    const s0 = Date.now();
    try {
      if (renames) await updateItem(env, spec.boardId, existing.id, itemName(fresh, spec), cv, opts, waits);
      else if (Object.keys(cv).length) await updateColumns(env, spec.boardId, existing.id, cv, opts, waits);
    } catch (e) {
      if ((e as Error)?.name === "MondayRateLimitedError") {
        const due = judged.filter(j => j.final === "forward");
        console.log(`${where} cols=${due.map(j => j.key).join(",") || "-"} action=write-rate-limited reason="monday refused`
          + ` the write for its rate limit (it never ran): the cells are left due for a converge on a fresh read"`);
        if (due.length) await watchCells(env, base, due.map(j => ({ key: j.key, fp: j.fp, typed: j.typed, anchor: j.c ?? u,
          kind: "candidate" as const, hs: j.d.hsText, ...(j.coarse && newer() ? { newer: true } : {}) })), { windowMs: W, dryRun: dry });
      }
      throw e;
    }
    const e1 = Date.now();
    stats.toMonday++; budget.left--;
    if (mayStamp) stampWindow = [s0, e1];
  }
  if (stampWindow) await noteStamp(env, base, stamp, stampWindow[0], stampWindow[1], spec.syncStateCol, dry);
  // Worked in HubSpot (a Lifecycle off 1.NEW, a Lead Status set) -> out of "No Activity" (NO_ACTIVITY_RELEASE).
  if (fwdDiffs.length)
    await releaseOnWorkedChanges(env, spec, existing.id, card.group?.id,
      fwdDiffs.filter(d => d.kind === "field" && d.f).map(d => ({ col: d.f!.col, label: d.hsText })),
      "changed in HubSpot", opts);

  if (conv) {
    // THE READ-BACK (loop breaker): what each written two-way cell shows now. A cell back in line needs no memory; one
    // that still differs did not take as sent (monday re-rendered it, or refused it), and only that state is remembered.
    const post: Record<string, string> = {};
    const wrote = judged.filter(j => j.final === "forward");
    if (wrote.length && !dry) {
      try {
        // Never waits on monday's rate limit: refused, nothing is remembered (a cell still differing converges again).
        const back = (await getItemFresh(env, existing.id, [], 0))?.item;
        if (back) {
          const still = new Set(fieldDiffs(fresh, back, spec, ctx, false).filter(d => !d.backfill && gp(d)).map(gateKey));
          for (const j of wrote) if (still.has(j.key)) post[j.key] = cellFp(j.d, back);
        }
      } catch (e) {
        console.log(`[converge] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} action=read-back-failed`
          + ` reason="${String(e).slice(0, 120)}" next="nothing remembered: a cell that still differs is converged again"`);
      }
    }
    resolveWatched(diffs);
    for (const j of judged) {
      if (j.final === "forward") out.forwarded.push({ key: j.key, fp: j.fp, hs: j.d.hsText,
        ...(post[j.key] !== undefined ? { post: post[j.key] } : {}) });
      else if (j.final === "hold") out.held.push({ key: j.key, fp: j.fp, typed: j.typed,
        anchor: j.verdict.v === "hold" ? j.verdict.anchor : (j.c ?? u), kind: "hold", hs: j.d.hsText,
        ...(j.coarse && newer() ? { newer: true } : {}) });
      else if (j.final === "stuck" || j.stuck) out.stuck.push(j.key);
      else if (j.final === "rescued") out.rescued.push(j.key);
      else if (j.final === "log-unreadable") (out.logUnreadable ??= []).push(j.key);
      // The coarse Stage HubSpot is not newer than: HEAD's timing leaves it, and so does the watch (no longer held).
      else if (j.coarse && j.final === "left") out.resolved.push(j.key);
    }
  }
  if (unfinished) throw unfinished;
  return out;
}

/** The properties a watched key is judged on (the name: every property it can be built from). */
function watchedProps(env: Env, spec: ObjectSpec, key: string): string[] {
  if (key === NAME_KEY) return spec.nameReverse
    ? [...new Set([spec.nameReverse, ...spec.nameProps, ...(spec.nameFallbackProps ?? [])])] : [];
  const f = spec.fields.find(x => x.col === key);
  return f && gatedCols(env, spec).includes(f.col) ? [f.hs] : [];
}

/**
 * THE CARD WATCH'S CONVERGE (DEFERRED_SYNC `watch.kind: "converge"`, queued by the watch's alarm): a forward pass over
 * the card in which the cells the watch holds -- or every two-way cell, after an adoption or a create -- are in play
 * whether or not HubSpot is newer, judged against the watch's own snapshot. So a hold ends in a write when its clock
 * says so, with or without another event. Exactly two reads (HubSpot with the history of the watched properties,
 * then the card), plus one activity-log read when a candidate may be a person's edit to rescue. Relation cells the
 * watch holds are rewritten from HubSpot's set, with their marks applied. Errors throw: the wave retries, and the watch
 * backs the re-queue off -- once its converges have failed for CONVERGE_GIVE_UP_MS in a row, the watch dead-letters the
 * cells instead (loudly), and this run returns without a throw (nothing is retried).
 */
export async function settleCardWatch(env: Env, boardId: string, itemId: string, opts: RunOpts, budget: Budget): Promise<string> {
  const via = "via=card-watch";
  const W = holdWindowMs(env);
  const begun = await beginConverge(env, boardId, itemId);
  if (begun === null) throw new Error(`the card watch of ${boardId}/${itemId} did not answer`);
  const snap = begun.snapshot;
  if (!snap) return wlog("monday", itemId, "skipped", `reason="the card has no watch" ${via}`);
  try {
    return await convergeCard(env, boardId, itemId, opts, budget, snap, W, via);
  } catch (e) {
    // The cap, decided after a run FAILED -- never when one begins, so the run that would succeed is always tried.
    const failed = await failConverge(env, boardId, itemId);
    if (failed?.deadLetter)
      return wlog("monday", itemId, "dead-lettered", `cols=${failed.deadLetter.join(",") || "-"} reason="${String(e).slice(0, 120)}" ${via}`);
    throw e;
  }
}

/** settleCardWatch's converge proper, over the snapshot it began with. */
async function convergeCard(env: Env, boardId: string, itemId: string, opts: RunOpts, budget: Budget, snap: CardWatch,
    W: number, via: string): Promise<string> {
  const done = async (why: string) => {
    await finishConverge(env, boardId, itemId, { done: true, resolved: [], forwarded: [], held: [], stuck: [], rescued: [] }, W);
    return wlog("monday", itemId, "skipped", `reason="${why}: the watch is dropped" ${via}`);
  };
  const spec = specByBoard(env, boardId);
  if (!spec || !staleForwardGateOn(env, spec)) return done("STALE_FORWARD_GATE is off for this board");
  let recordId = snap.recordId ?? "";
  if (!/^\d+$/.test(recordId)) recordId = ((await getItemsColumnText(env, [itemId], spec.idCol))[itemId] ?? "").trim();
  if (!/^\d+$/.test(recordId)) return done("the card is not linked to a HubSpot record");
  const ctx = await getCtxCached(env);
  const keys = Object.keys(snap.cells);
  const relCols = (spec.associations ?? []).flatMap(a => a.relationCol && keys.includes(relKey(a.relationCol)) ? [a.relationCol] : []);
  const fieldKeys = snap.allAt !== undefined
    ? [...gatedCols(env, spec), ...(spec.nameReverse ? [NAME_KEY] : [])]
    : keys.filter(k => !k.startsWith("rel:"));
  const props = [...new Set(fieldKeys.flatMap(k => watchedProps(env, spec, k)))];
  const r = await getRecordWithHistory(env, spec.object, recordId,
    [...new Set([...propertiesForSpec(spec), "sales_user", "createdate"])], props);
  if (!r) return done(`${spec.object} ${recordId} is gone from HubSpot`);
  const c = await getItemFresh(env, itemId, gatedCols(env, spec));
  if (!c) return done("the card is gone");
  if (colText(c.item, spec.idCol).trim() !== recordId) return done(`the card no longer shows ${spec.object} ${recordId}`);
  const rec: HsRecord = { id: recordId, properties: r.properties };
  const stats = emptyStats();
  const out = await forwardOnlyGated(env, spec, ctx, opts, budget, rec, c.item, stats,
    { snapshot: snap, history: r.history, stamps: c.stamps, values: c.values });
  for (const col of relCols) {
    const status = await convergeRelationCell(env, spec, rec, c.item, col, ctx, opts, budget);
    if (status === "held") {
      const cell = snap.cells[relKey(col)];
      out.held.push({ key: relKey(col), fp: cell.fp, typed: true, anchor: cell.since, kind: "hold", windowMs: RELATION_HOLD_MS });
    } else out.resolved.push(relKey(col));
  }
  // Every watched cell is settled or re-held above; one that is neither is put off (never re-converged at once).
  out.considered = keys;
  await finishConverge(env, boardId, itemId, out, W);
  console.log(`[converge] object=${spec.object} hubspot_id=${recordId} monday_item=${itemId} action=converged`
    + ` forwarded=${out.forwarded.map(f => f.key).join(",") || "-"} held=${out.held.map(h => h.key).join(",") || "-"}`
    + ` rescued=${out.rescued.join(",") || "-"} stuck=${out.stuck.join(",") || "-"} resolved=${out.resolved.join(",") || "-"}`);
  return wlog(spec.object, recordId, actionOf(stats), `board=${boardId} item=${itemId} ${via}`);
}

/**
 * A MARK'S RETRY (STALE_FORWARD_RETRY; DEFERRED_SYNC `watch.kind: "retry"`, queued by the watch's alarm once a mark
 * outlived its lease, or by a converge's rescue): the person's edits whose runs did not resolve are sent again, FROM
 * THE CARD, through the ordinary column-level path (syncMondayItem), as the edit they are -- a person's with the
 * human-edit basis, an automation's never claiming. Two things are never sent, each cell given up instead (due for a
 * converge at once, its value never rescued again):
 *   - an edit made before the card was linked to its record: the form's starting state (an adoption never pushes it).
 *     The link time is the watch's, or the record-id cell's newest write in monday's log -- as for the log rescue --
 *     so a link the watch never learnt (its call failed) still counts; a log that cannot say defers the whole retry
 *     (it throws: nothing is sent on that uncertainty, and the marks stay for their next try);
 *   - an edit HubSpot changed the property after: the later change wins. "HubSpot changed it" is any version this
 *     card's own writes do not explain (PushRec) -- a person's, a workflow's, and our app's own from another path or
 *     card (an operator's script, a duplicate card); a version whose provenance cannot be told counts as such.
 * IT RUNS OUTSIDE THE CELL'S OWN QUEUE (a Durable Object alarm, minutes after the edit), so a newer edit of the same cell
 * can be read, pushed, or still on its way while it runs. Its push therefore looks at both sides again right before it
 * sends, and reads the card back after (types.ts RetryEdit; pushColumnEdit's retryGate): a key whose cell changed since
 * this run read the card is DEFERRED (not sent; its mark stays for its next try, or that newer edit's run clears it), a
 * key HubSpot changed after the edit meanwhile is SUPERSEDED (given up, as above), and a key the card shows otherwise once
 * its PATCH returned is RACED -- a newer edit made while it was in flight, whose own push may have landed first -- marked
 * again and re-sent from the card at once. A relation edit's add is re-checked against the cell the same way.
 * ITS OWN READS (the card, monday's log for the link, HubSpot's history) come before anything is sent: one that fails
 * gives the marks their attempt back (refundRetry) and throws -- a read monday or HubSpot refused, under the very rate
 * limits that kill the runs it recovers, is not a send that failed. Any other throw keeps the marks, and the watch
 * retries on its backoff until MARK_TTL_MS; then they are given up and the cells converge. A People cell's retry carries
 * the removals its events recorded (unknown: none), so emptying a cell that showed someone other than HubSpot's owner is
 * refused and healed, as a live run does.
 */
export async function retryMarkedEdits(env: Env, boardId: string, itemId: string, opts: RunOpts, budget: Budget): Promise<string> {
  const via = "via=edit-retry";
  const spec = specByBoard(env, boardId);
  if (!spec || !staleForwardRetryOn(env, spec))
    return wlog("monday", itemId, "skipped", `reason="STALE_FORWARD_RETRY is off for this board" ${via}`);
  const base: WatchBase = { boardId, itemId, object: spec.object };
  const W = holdWindowMs(env);
  const t0 = Date.now();
  const begun = await beginRetry(env, boardId, itemId, W);
  if (begun === null) throw new Error(`the card watch of ${boardId}/${itemId} did not answer`);
  const marks = begun.live;
  const keys = Object.keys(marks);
  if (!keys.length) return wlog("monday", itemId, "skipped", `reason="no mark is due for a retry" ${via}`);
  /** One of the retry's own reads: when it fails, nothing has been sent -- the marks get their attempt back. */
  const refund = async (e: unknown): Promise<never> => {
    await refundRetry(env, base, keys);
    console.log(`[watch] board=${boardId} item=${itemId} cols=${keys.join(",")} action=edit-retry-refunded`
      + ` reason="${String(e).slice(0, 140)}" next="nothing was sent: the marks keep this try and are retried on their backoff"`);
    throw e;
  };
  const read = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { return refund(e); } };
  const card = await read(() => getItem(env, itemId));
  const recordId = card ? colText(card, spec.idCol).trim() : "";
  if (!card || !/^\d+$/.test(recordId)) {
    await clearMarks(env, base, keys, t0);
    return wlog("monday", itemId, "skipped", `reason="${card ? "the card is not linked to a HubSpot record" : "the card is gone"}" ${via}`);
  }
  /** Give `ks` up: each cell, as the card shows it now, is due for a converge at once and never rescued again. */
  const giveUp = async (ks: string[]) => {
    const fps: Record<string, string> = {};
    for (const k of ks) fps[k] = retryCell(spec, k, card);
    await supersedeMarks(env, base, fps, t0, W);
  };
  // THE LINK CHECK, as the log rescue's. The watch's own link time settles it when it has one (an adoption or a create
  // tells it, and a mark from before it never even gets here: beginRetry gives it up); otherwise monday's log of the
  // record-id cell, from the oldest mark on, read PATIENTLY (gql's own waits: this runs in a Durable Object alarm).
  let linkAt: number;
  if (begun.linkedAt !== undefined) linkAt = effectiveLinkAt(begun, undefined);
  else {
    const oldest = Math.min(...keys.map(k => marks[k].at).filter(Number.isFinite));
    const idRows = await read(async () => {
      const rows = await lastCellChanges(env, spec, itemId, [spec.idCol], Number.isFinite(oldest) ? oldest : t0, { patient: true });
      if (rows === null || rows[spec.idCol] === null)
        throw new Error(`monday's log could not say when ${boardId}/${itemId} was linked to its record: nothing is re-sent on`
          + ` that uncertainty (the marks stay for their next try)`);
      return rows;
    });
    linkAt = effectiveLinkAt(begun, idRows[spec.idCol]);
  }
  const preLink = keys.filter(k => !(marks[k].at > linkAt));
  if (preLink.length) {
    console.log(`[watch] board=${boardId} item=${itemId} cols=${preLink.join(",")} action=edit-retry-abandoned`
      + ` reason="made before the card was linked to its record (monday's log): the form's starting state is never`
      + ` re-sent; the cell converges to HubSpot"`);
    await giveUp(preLink);
  }
  let send = keys.filter(k => !preLink.includes(k));
  const checked = send.filter(k => !k.startsWith("rel:") && retryPropsOf(spec, k).length);
  if (checked.length) {
    const r = await read(() => getRecordWithHistory(env, spec.object, recordId,
      [...new Set([...propertiesForSpec(spec), "sales_user", "createdate"])], [...new Set(checked.flatMap(k => retryPropsOf(spec, k)))]));
    if (!r) {
      await clearMarks(env, base, keys, t0);
      return wlog("monday", itemId, "skipped", `reason="${spec.object} ${recordId} is gone from HubSpot" ${via}`);
    }
    const later = checked.filter(k => {
      const vs = mergedVersions(r.history, retryPropsOf(spec, k));
      if (!vs) return true;                                // its history not read: cannot tell -- never sent on that
      const t = newestForeignAt(vs, begun.pushes, recordId);
      return t !== undefined && t > marks[k].at;
    });
    if (later.length) {
      console.log(`[watch] board=${boardId} item=${itemId} cols=${later.join(",")} action=edit-retry-superseded`
        + ` reason="HubSpot changed it after the edit (a version this card did not write): the later change wins, and the`
        + ` cell converges to it"`);
      // Not merely cleared: the card still shows the superseded value, so each cell is due for a converge at once
      // (and that value is never rescued again).
      await giveUp(later);
      send = send.filter(k => !later.includes(k));
    }
  }
  if (!send.length) return wlog("monday", itemId, "skipped", `reason="every mark was given up: nothing to re-send" ${via}`);
  const deferred: string[] = [], superseded: string[] = [];
  const raced: { key: string; at: number }[] = [];
  for (const byAutomation of [false, true]) {
    const ks = send.filter(k => !!marks[k].byAutomation === byAutomation);
    if (!ks.length) continue;
    const cols = ks.filter(k => k !== NAME_KEY).map(k => k.startsWith("rel:") ? k.slice(4) : k);
    const actor = ks.map(k => marks[k].actor).find(Boolean) ?? "";
    // A People cell: the people its events removed -- unknown or never recorded counts as nobody, so a retry never
    // clears HubSpot's owner on the strength of a removal it cannot see (refused and healed instead).
    const removedPeople: Record<string, string[]> = {};
    for (const k of ks) if (spec.fields.some(f => f.col === k && f.type === "people"))
      removedPeople[k] = marks[k].people?.known ? [...marks[k].people!.ids] : [];
    const retry: RetryEdit = { at: Object.fromEntries(ks.map(k => [k, marks[k].at])), pushes: begun.pushes ?? [],
      deferred: [], superseded: [], raced: [] };
    const edit: MondayEdit = { cols, ...(ks.includes(NAME_KEY) ? { name: true } : {}), ...(byAutomation ? { byAutomation: true } : {}),
      ...(actor ? { actor } : {}), ...(Object.keys(removedPeople).length ? { removedPeople } : {}), retry };
    for (const k of ks.filter(x => x.startsWith("rel:"))) {
      const col = k.slice(4);
      const rel = marks[k].rel;
      if (!rel) continue;
      edit.unlinked = { ...(edit.unlinked ?? {}), [col]: rel.removed };
      if (rel.known) edit.linked = { ...(edit.linked ?? {}), [col]: rel.added };
      edit.largestEvent = { ...(edit.largestEvent ?? {}), [col]: { added: rel.largestAdd, removed: rel.largestRemove } };
    }
    console.log(`[watch] board=${boardId} item=${itemId} cols=${ks.join(",")} actor=${actor || "-"}`
      + ` class=${byAutomation ? "automation" : "person"} action=edit-retried reason="its run did not resolve within its lease"`);
    // Every edit of a key reached us before this: one made after it is newer than what this run reads (RetryEdit.raced).
    const readFrom = Date.now();
    try { await syncMondayItem(env, boardId, itemId, opts, budget, false, false, edit, { id: actor, byAutomation }); }
    catch (e) { if (e instanceof RetryReadError) await refund(e); throw e; }
    deferred.push(...retry.deferred);
    superseded.push(...retry.superseded);
    raced.push(...retry.raced.map(key => ({ key, at: readFrom })));
  }
  if (deferred.length)
    console.log(`[watch] board=${boardId} item=${itemId} cols=${deferred.join(",")} action=edit-retry-deferred`
      + ` reason="the card changed since this retry read it: a newer edit, its own run's to send -- not sent, not healed,`
      + ` its mark kept"`);
  if (superseded.length) {
    console.log(`[watch] board=${boardId} item=${itemId} cols=${superseded.join(",")} action=edit-retry-superseded`
      + ` reason="HubSpot changed it after the edit, read right before the push (a version this card did not write): the`
      + ` later change wins, and the cell converges to it"`);
    await giveUp(superseded);
  }
  if (raced.length) {
    // Marked again as of this run's read (a lower bound for the newer edit's time: HubSpot's own change after it still
    // wins), due at once: the next try re-reads the card, and sends it if HubSpot does not hold it.
    await markEdits(env, base, raced.map(({ key, at }): MarkInput => ({ key, at, rx: Date.now(), rescued: true,
      ...(marks[key].actor ? { actor: marks[key].actor } : {}), ...(marks[key].byAutomation ? { byAutomation: true } : {}),
      ...(spec.fields.some(f => f.col === key && f.type === "people") ? { people: null } : {}) })));
    console.log(`[watch] board=${boardId} item=${itemId} cols=${raced.map(r => r.key).join(",")} action=edit-retry-raced`
      + ` reason="the card showed another value once the push returned: a newer edit made while it was in flight, whose`
      + ` own push may have landed first -- re-sent from the card at once"`);
    const type = eventTypeOfObject(spec.object);
    if (type) await spillDeferred(env, [{ type, id: itemId, watch: { boardId, kind: "retry" } }]);
  }
  const kept = new Set([...deferred, ...superseded, ...raced.map(r => r.key)]);
  const done = send.filter(k => !kept.has(k));
  await clearMarks(env, base, done, t0);
  return wlog("monday", itemId, "edit-retried", `board=${boardId} cols=${done.join(",") || "-"}`
    + `${kept.size ? ` kept=${[...kept].join(",")}` : ""} ${via}`);
}

/** The HubSpot properties a retried key is judged on (the name: every property it can be built from). */
function retryPropsOf(spec: ObjectSpec, k: string): string[] {
  return k === NAME_KEY
    ? (spec.nameReverse ? [...new Set([spec.nameReverse, ...spec.nameProps, ...(spec.nameFallbackProps ?? [])])] : [])
    : spec.fields.filter(f => f.col === k).map(f => f.hs);
}

/** A retried key as a card shows it: the cell as cellKey reads it, or the trimmed item name. */
function retryCell(spec: ObjectSpec, k: string, item: MondayItem): string {
  if (k === NAME_KEY) return item.name.trim();
  const f = spec.fields.find(x => x.col === k);
  return f ? cellKey(f, item) : "";
}

/** A mark's retry could not read what it must look at again right before it sends (retryGate): nothing was sent, and
 *  the retry gives its marks their attempt back. */
class RetryReadError extends Error {
  constructor(message: string) { super(message); this.name = "RetryReadError"; }
}

/**
 * A RETRY'S LAST LOOK BEFORE IT SENDS (types.ts RetryEdit): the card and HubSpot's history, read again -- the last reads
 * before the claim and the PATCH. Of the keys the edit carries (its columns, and the name):
 *   - deferred: the card shows the cell otherwise than this run read it -- a newer edit (or HubSpot's later value a
 *     forward pass wrote), its own run's to send: neither sent nor healed here;
 *   - superseded: HubSpot holds a version of it this card did not write, newer than the edit (or its history could not
 *     be read for it): the later change wins.
 * Throws RetryReadError when either side cannot be read: nothing is sent on that.
 */
async function retryGate(env: Env, spec: ObjectSpec, rec: { id: string }, existing: MondayItem, edit: MondayEdit,
    retry: RetryEdit): Promise<{ deferred: string[]; superseded: string[] }> {
  const keys = [...edit.cols.filter(c => spec.fields.some(f => f.col === c)), ...(edit.name ? [NAME_KEY] : [])];
  if (!keys.length) return { deferred: [], superseded: [] };
  let now: MondayItem | null;
  try { now = await getItem(env, existing.id); }
  catch (e) { throw new RetryReadError(`the card could not be read again right before the retry's push: ${String(e).slice(0, 160)}`); }
  const deferred = now ? keys.filter(k => retryCell(spec, k, now!) !== retryCell(spec, k, existing)) : [...keys];
  const left = keys.filter(k => !deferred.includes(k));
  const props = [...new Set(left.flatMap(k => retryPropsOf(spec, k)))];
  if (!props.length) return { deferred, superseded: [] };
  let h: { properties: Record<string, string | null>; history: Record<string, HsVersion[]> } | null;
  try {
    h = await getRecordWithHistory(env, spec.object, rec.id, [...new Set([...propertiesForSpec(spec), "sales_user", "createdate"])], props);
  } catch (e) { throw new RetryReadError(`HubSpot's history could not be read again right before the retry's push: ${String(e).slice(0, 160)}`); }
  if (!h) throw new RetryReadError(`${spec.object} ${rec.id} is gone from HubSpot`);
  const superseded = left.filter(k => {
    const vs = mergedVersions(h!.history, retryPropsOf(spec, k));
    if (!vs) return true;
    const t = newestForeignAt(vs, retry.pushes, rec.id);
    const at = retry.at[k];
    return t !== undefined && !(Number.isFinite(at) && t <= at);
  });
  return { deferred, superseded };
}

/**
 * COLUMN-LEVEL, A PERSON'S EDIT: push exactly the columns they changed, and nothing else.
 *
 * Order matters, and each step is there for a failure it prevents:
 *   1. If HubSpot changed since the card was last synced, apply THOSE changes to the columns the person
 *      did NOT edit, first. Otherwise stamping Sync State after the push would bury HubSpot's change:
 *      the card would look current while still holding the stale value. That is precisely how contact
 *      394787683005's Sales User would have stayed "Myla" forever after the next Job Title edit.
 *      EXCEPT a cell the push reports as held (ColumnEditResult.hold): it carries a person's edit still on
 *      its way in its own run, and Sync State then stays put (see the stamp below).
 *   2. Claim the record for CRM on this basis -- a person working it in CRM -- then write the edited
 *      columns. The claim is lazy: an edit that changes nothing sends nothing and claims nothing.
 *   3. Anything that could not be sent (refused value, ownership refusal, HubSpot rejection) is healed
 *      back to HubSpot's value on that column only, so the person sees it did not take.
 *
 * `holdForward`: skip step 1's "HubSpot changed" half. Only for an edit that lands while a live creator
 * is still settling its brand-new card (see createWindowFor): HubSpot's post-create recalculation makes
 * the record read as newer than the card, but that is the creator's to bring across, from a read that
 * can tell it apart from a person's pending edit. The push's own consequences still come back.
 *
 * Before all of it: a backward move an EARLIER run left half done -- HubSpot holding "" from our clear -- is
 * finished from the card (repairDanglingClears), because stamping this edit's push time would hide it from
 * every later re-check. Not finished now: everything else proceeds, Sync State stays where it was, and the
 * re-check is armed again.
 */
async function reconcileColumnEdit(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem,
    stats: Stats, edit: MondayEdit, holdForward = false): Promise<void> {
  const repaired = new Set<string>();
  const unfinished = await repairDanglingClears(env, spec, ctx, opts, budget, rec, existing,
    { skip: new Set(edit.cols), repaired });
  const recModified = rec.properties[spec.modifiedProp] ?? "";
  const lastSynced = colText(existing, spec.syncStateCol);
  const editedCols = new Set(edit.cols);
  const hubspotNewer = !holdForward && (Date.parse(recModified) || 0) > (Date.parse(lastSynced) || 0);

  // 1. The person's edit.
  const { patch, heal, healName, newMod, fields, hold, pending } = await pushColumnEdit(env, spec, ctx, opts, budget,
    rec, existing, stats, edit);
  // Cells this change did not edit that hold a person's edit still on its way in its own run (today only
  // the HubSpot Stage cell beside a coarse Stage edit: see coarseStageEdit). Never written over below.
  const held = new Set(hold ?? []);

  // 2. What monday must now show, judged against HubSpot's state AFTER the push. Two sources:
  //   - HubSpot's own newer changes, on columns this person did not edit (only when HubSpot really
  //     changed since Sync State -- otherwise a difference there is someone's pending edit);
  //   - the push's own consequences: the item name when it is built from a pushed property, and any
  //     OTHER column mapped from a pushed property. Without this, editing First name leaves the card's
  //     title stale for good, because the push's echo finds HubSpot no newer than the new Sync State.
  const pushed = newMod !== null ? patch : {};
  const effective: HsRecord = { id: rec.id, properties: { ...rec.properties, ...pushed } };
  const pushedProps = new Set(Object.keys(pushed));
  const nameFedByPush = [...spec.nameProps, ...(spec.nameFallbackProps ?? [])].some(p => pushedProps.has(p));
  // STALE_FORWARD_GATE: an unedited TWO-WAY cell is never written by this pass unless the push itself changed it --
  // it may carry another edit still on its way (the same rep's Lifecycle, a second before this Lead Status). Only a
  // HubSpot change of it is news, and that change's own pass (or the watch's converge, below) brings it.
  const gate = staleForwardGateOn(env, spec);
  const leftGated: Diff[] = [];
  const forward = fieldDiffs(effective, existing, spec, ctx, false).filter(d => {
    if (d.backfill || d.kind === "group") return false;
    // The name: never over a name this person just pushed; healed separately when refused; otherwise
    // only when HubSpot changed or the push itself changed what the name is built from. A difference
    // with neither cause is someone's rename still on its way, and must be left alone.
    if (d.kind === "name") {
      if (gate && !edit.name && !healName && !nameFedByPush && gatedProps(env, spec, d, effective)) { leftGated.push(d); return false; }
      return !edit.name && !healName && (hubspotNewer || nameFedByPush);
    }
    if (d.kind !== "field" || !d.f || editedCols.has(d.f.col)) return false;
    // A repaired stage: HubSpot now holds what the card showed when re-read, newer than `existing`.
    if (repaired.has(d.f.col)) return false;
    // A held cell: HubSpot's value over it would revert that edit before its own run reads it, and that
    // run would then find nothing to send.
    if (held.has(d.f.col)) {
      console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} col=${d.f.col}`
        + ` action=forward-held reason="a person's edit of it is still on its way, in its own run"`);
      return false;
    }
    if (gate && !pushedProps.has(d.f.hs) && gatedProps(env, spec, d, effective)) { leftGated.push(d); return false; }
    return hubspotNewer || pushedProps.has(d.f.hs);
  });
  if (leftGated.length) {
    const W = holdWindowMs(env);
    const base: WatchBase = { boardId: spec.boardId, itemId: existing.id, object: spec.object, recordId: rec.id };
    console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id}`
      + ` cols=${leftGated.map(d => d.kind === "name" ? "name" : d.f!.col).join(",")} action=left-to-forward-pass`
      + ` reason="two-way cells this edit did not change: ${hubspotNewer ? "the watch converges them on a fresh read"
        : "someone's edit, or HubSpot's change, brings them"}"`);
    // HubSpot changed since Sync State: what it changed is judged within a deferred cycle, on fresh reads -- HEAD's
    // step 1, made per cell. The coarse Stage goes too, marked as seen while HubSpot was newer: this run stamps its
    // push past that, and its converge must still keep HEAD's word (forward unless a person's edit holds it).
    const due: WatchReq[] = leftGated.map(d => ({ key: gateKey(d), fp: cellFp(d, existing), typed: false,
      anchor: updatedAtMs(existing.updated_at), kind: "candidate", hs: d.hsText,
      ...(d.kind === "field" && isCoarseGated(env, spec, d.f) ? { newer: true } : {}) }));
    if (hubspotNewer && due.length) await watchCells(env, base, due, { windowMs: W, dryRun: !!opts.dryRun });
  }

  // 3. One monday write for everything that has to come back.
  // A People cell healed to an owner with no monday seat (or no owner at all) is emptied, not left
  // showing the person HubSpot refused.
  const healDiffs: Diff[] = heal.map(f => ({ kind: "field", f, hsText: "", mdText: "",
    ...(f.type === "people" && !formatValue(f, effective.properties[f.hs], ctx) ? { peopleClear: true } : {}) }));
  const cv = buildUpdatePayload([...forward, ...healDiffs], effective, spec, ctx);
  // Stamp the newest HubSpot state monday now reflects. After a push that is the push's own timestamp;
  // without one, only a forward pass over HubSpot's changes justifies moving the baseline -- and not one
  // that held a cell back: monday does not reflect HubSpot there. The held edit's own run stamps its push;
  // and were the cell ever not a person's edit after all (a lagging stage time, see coarseStageEdit), the
  // change it hides still reads as newer, so its own webhook brings it rather than finding it buried.
  // Not the push's own time while a backward move is pending (ColumnPush.pending): that time is the clear's.
  // And nothing at all while an earlier one is unfinished: Sync State behind it is what keeps it visible.
  // STALE_FORWARD_GATE: without a push of its own, not while a two-way cell is left (leftGated: always empty off).
  const stamp = unfinished ? "" : (pending ? null : newMod) ?? (hubspotNewer && !held.size && !leftGated.length ? recModified : "");
  if (stamp) cv[spec.syncStateCol] = stamp;
  if (unfinished) await rearmRecheck(env, spec, opts, rec.id, existing.id);
  const renames = healName || forward.some(d => d.kind === "name");
  const s0 = Date.now();
  if (renames) {
    await updateItem(env, spec.boardId, existing.id, itemName(effective, spec), cv, opts);
    budget.left--;
  } else if (Object.keys(cv).length) {
    await setColumns(env, spec.boardId, existing.id, cv, opts);
    budget.left--;
  }
  // HEAD's write, with gql's own rate-limit waits (it may land minutes late): its stamp is noted with the card's
  // register (STALE_FORWARD_GATE), which keeps it longer than such a write can take (see forwardOnlyGated, step 8).
  if (gate && stamp)
    await noteStamp(env, { boardId: spec.boardId, itemId: existing.id, object: spec.object, recordId: rec.id },
      stamp, s0, Date.now(), spec.syncStateCol, !!opts.dryRun);
  if (forward.length || heal.length || healName) stats.toMonday++;
  if (!fields.length && !forward.length && !heal.length && !healName) stats.inSync++;
  // Worked -> out of "No Activity" (NO_ACTIVITY_RELEASE): a PERSON's own status edits that LANDED in HubSpot (a
  // refused or healed one did not happen; an automation's is not work -- the board's #08 sets In Progress on a
  // customer's reply), and any HubSpot change this pass brought across.
  await releaseOnWorkedChanges(env, spec, existing.id, existing.group?.id, [
    ...(edit.byAutomation ? [] : spec.fields.filter(f => editedCols.has(f.col) && f.hs in pushed)
      .map(f => ({ col: f.col, label: colText(existing, f.col) }))),
    ...forward.filter(d => d.kind === "field" && d.f).map(d => ({ col: d.f!.col, label: d.hsText })),
  ], edit.byAutomation ? "changed in HubSpot" : "edited", opts);
}

/** What sending one column-level edit produced: see pushColumnEdit. */
interface ColumnPush {
  /** What columnEditPatch built, less anything HubSpot did not take -- i.e. what HubSpot now holds from this
   *  edit when newMod !== null (only then was anything sent). */
  patch: Record<string, string>;
  /** Edited fields that did not take -- refused, ownership-refused, or rejected by HubSpot. */
  heal: FieldSpec[];
  healName: boolean;
  /** HubSpot's modified timestamp after the PATCH; null when nothing was sent (or a dry run). */
  newMod: string | null;
  fields: string[];
  /** Unedited cells holding a person's edit still on its way (ColumnEditResult.hold); absent when none. */
  hold?: string[];
  /**
   * Properties a backward move left EMPTY in HubSpot -- its clear landed, its set and restore did not
   * (BackwardSetError) -- whose cells keep the person's value for the queued re-check to send. While any is
   * pending, Sync State must NOT move to the clear's timestamp: the re-check acts only on a record HubSpot
   * changed after Sync State (repairDanglingClears). Absent when none.
   */
  pending?: string[];
}

/**
 * STEP 1 OF A COLUMN-LEVEL EDIT, on its own: send exactly what the person changed, claiming the record
 * lazily, and report what could not be sent so the caller can heal it. Shared by the ordinary edit path
 * (reconcileColumnEdit) and the create window's own replay (settleRound), which differ only in what they
 * write back to monday afterwards.
 */
async function pushColumnEdit(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem,
    stats: Stats, given: MondayEdit): Promise<ColumnPush> {
  const hsRec = rec as HsRecord;
  // STALE_FORWARD_RETRY: A MARK'S RETRY LOOKS AGAIN RIGHT BEFORE IT SENDS (retryGate) -- before the claim, so a key it
  // drops never claims the record either. A cell the card shows otherwise now, or that HubSpot changed after the edit,
  // is not this run's: it is left out of the edit (neither sent nor healed) and held (no Sync State over it).
  let edit = given;
  let parked: string[] = [];
  if (given.retry && !opts.dryRun) {
    const first = columnEditPatch(hsRec, existing, spec, ctx, given);
    if (Object.keys(first.patch).length || first.heal.length || first.healName) {
      const g = await retryGate(env, spec, rec, existing, given, given.retry);
      given.retry.deferred.push(...g.deferred);
      given.retry.superseded.push(...g.superseded);
      const out = new Set([...g.deferred, ...g.superseded]);
      if (out.size) {
        edit = { ...given, cols: given.cols.filter(c => !out.has(c)), ...(given.name ? { name: !out.has(NAME_KEY) } : {}) };
        parked = [...out].filter(k => k !== NAME_KEY);
      }
    }
  }
  const editedCols = new Set(edit.cols);
  const r = columnEditPatch(hsRec, existing, spec, ctx, edit);
  for (const why of r.refusals)
    console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} action=refused reason="${why}"`);
  const heal = [...r.heal];
  let healName = r.healName;
  let newMod: string | null = null;
  let landed = r.patch;
  let pending: string[] | undefined;
  const fields = Object.keys(r.patch);
  if (fields.length) {
    // An automation can write to a record CRM already owns, but only a PERSON can claim one.
    const auth = await ensureHubspotWriteAuth(env, spec, budget, rec, opts,
      edit.byAutomation ? "cutover" : "human-edit");
    const sentFields = spec.fields.filter(f => editedCols.has(f.col) && f.hs in r.patch);
    if (auth && !auth.allowed) {
      console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id}`
        + ` action=refused-forward-instead fields=${fields.join(",")} reason="${auth.reason}"`);
      heal.push(...sentFields);
      if (edit.name && spec.nameReverse && spec.nameReverse in r.patch) healName = true;
      stats.skipped++;
    } else {
      try {
        newMod = await sendPatch(env, spec, ctx, rec, existing.id, r.patch, opts, auth,
          [...edit.cols, ...(edit.name ? [NAME_KEY] : [])]);
        budget.left--; stats.toHubspot++;
        console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id}`
          + ` action=written fields=${fields.join(",")}${fields.some(f => r.patch[f] === "") ? " (includes a clear)" : ""}`);
      } catch (e) {
        // HubSpot rejected it (validation rule, required property, bad value). Heal what did not take and
        // carry on: an unguarded throw here would skip the forward write and freeze the card.
        //
        // EXCEPT A BACKWARD MOVE WHOSE CLEAR LANDED (BackwardSetError): that clear carried every other
        // property of the edit (sendPatch, step 1), so only the move did not take -- the rest is written and
        // is not healed back. Restored, HubSpot holds the previous stage again and the cell is healed to it.
        // Not restored, HubSpot holds "", which the card must not be told: it keeps the person's stage for
        // the re-check sendPatch armed, and `pending` keeps Sync State behind the clear until then.
        const partial = e instanceof BackwardSetError ? e : undefined;
        const failed = new Set(partial ? partial.props : fields);
        landed = Object.fromEntries(Object.entries(r.patch).filter(([p]) => !failed.has(p)));
        if (partial) {
          newMod = partial.landedMod; budget.left--;
          if (!partial.restored) pending = partial.props;
        }
        if (!partial || partial.restored) heal.push(...sentFields.filter(f => failed.has(f.hs)));
        if (!partial && edit.name && spec.nameReverse && spec.nameReverse in r.patch) healName = true;
        const sent = Object.keys(landed);
        if (sent.length) stats.toHubspot++; else stats.skipped++;
        console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id}`
          + ` action=${sent.length ? `written fields=${sent.join(",")} not-landed=${[...failed].join(",")}`
            : `rejected fields=${fields.join(",")}`}${pending ? ` pending=${pending.join(",")}` : ""}`
          + ` reason="${String(e).slice(0, 160)}"`);
      }
    }
  }

  // A RETRY READS THE CARD BACK once its PATCH returned: a cell it sent that the card now shows otherwise was edited while
  // the PATCH was in flight, and that edit's own push may have landed first -- and been written over. RACED: the retry
  // marks it again and re-sends it from the card at once (retryMarkedEdits). A read that fails is only logged: the
  // converge's rescue still heals it (ownLaterVerdict: this cell's own stale push never makes the edit "already sent").
  if (given.retry && newMod !== null) {
    const sentKeys = [...edit.cols.filter(c => spec.fields.some(f => f.col === c && f.hs in landed)),
      ...(edit.name && spec.nameReverse && spec.nameReverse in landed ? [NAME_KEY] : [])];
    try {
      const back = sentKeys.length ? await getItem(env, existing.id) : null;
      if (back) given.retry.raced.push(...sentKeys.filter(k => retryCell(spec, k, back) !== retryCell(spec, k, existing)));
    } catch (e) {
      console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} action=retry-read-back-failed`
        + ` reason="${String(e).slice(0, 120)}" next="a newer edit raced with this push is healed by the converge's rescue"`);
    }
  }
  const hold = [...(r.hold ?? []), ...parked];
  return { patch: landed, heal, healName, newMod, fields, ...(pending ? { pending } : {}), ...(hold.length ? { hold } : {}) };
}

/**
 * A backward move's clear LANDED -- carrying every other property of the write -- but the move itself did
 * not. Thrown by sendPatch after the restore was tried; pushColumnEdit turns it into a partial result.
 */
export class BackwardSetError extends Error {
  constructor(
    /** HubSpot's modified timestamp after the last PATCH that landed: the restore's, else the clear's. */
    readonly landedMod: string | null,
    /** The properties whose move did not land. Everything else in the write did, with the clear. */
    readonly props: string[],
    /** true: each is back at its previous value (the restore was answered 200). false: HubSpot holds "". */
    readonly restored: boolean,
    cause: unknown,
  ) {
    super(`backward move of ${props.join(",")} did not land (${restored ? "previous value restored" : "left empty"}):`
      + ` ${String(cause).slice(0, 200)}`);
    this.name = "BackwardSetError";
  }
}

/**
 * ONE MONDAY -> HUBSPOT WRITE, sent as two PATCHes when a property must be cleared before it can move back.
 * Every business-field PATCH this file sends goes through here. See FieldSpec.backwardNeedsClear.
 *
 * Nothing to clear (a forward move, a first fill, a clear, an unchanged or unflagged property, an order it
 * cannot place): exactly the one patchRecord call it always was. Otherwise:
 *   0. ARM THE RE-CHECK, before anything is cleared: the record goes to the durable queue (DEFERRED_SYNC) as
 *      a re-check, which ~15 s later finishes a clear its set never followed and does nothing else
 *      (recheckDanglingClears: no forward write, so it cannot overwrite the person's next edit). Before,
 *      not after: this run lives in a waitUntil Cloudflare cancels about 30 s after the response, and an
 *      isolate that dies between the clear and the set runs nothing after it -- no retry, no restore, no log.
 *   1. PATCH EVERYTHING ELSE, WITH THE CLEAR: the backward-moving properties as "", every other property at
 *      its new value. So a 400 that another property causes fails HERE, before anything is cleared, and the
 *      only thing that can still fail after it is the move itself. Same spec, record and WriteAuth as the
 *      real write, so patchRecord's ownership assert refuses the clear exactly when it would refuse the
 *      write. A throw here changed nothing and goes to the caller like any rejected PATCH.
 *   2. PATCH the moving properties alone, to their new value.
 *   3. If that fails, once more; if it fails again, put back what the clear removed (from empty, any stage is
 *      accepted) and throw BackwardSetError, saying whether the restore was confirmed. Confirmed, the caller
 *      heals the cell to that value, which HubSpot holds again. Not confirmed, HubSpot holds "" and the card
 *      must NOT be told otherwise: it keeps the person's value, Sync State stays behind the clear, and the
 *      re-check armed in step 0 sends that value (from empty: a forward move, which HubSpot always takes).
 * Returns the modified timestamp of the PATCH that carried the move (null in a dry run).
 *
 * THE ECHO OF THE CLEAR IS HARMLESS: a HubSpot webhook re-reads the record (it never uses the event's
 * value), the read almost always finds the stage already set, and an empty HubSpot value never blanks a
 * monday cell. A read that does land between the two PATCHes finds OUR clear in the history and sends the
 * card's value -- the same one the set is sending. Pinned in lifecycle-backward-clear.test.ts.
 *
 * `keys`: the cells this write is sent for (PushRec.keys). STALE_FORWARD_RETRY: the move's PATCHes go to the card's
 * own-write ledger TOGETHER, once the move is done or given up -- never one RPC between the clear and the set, which
 * would only hold HubSpot's stage empty the longer (up to the watch RPC's 3 s).
 */
async function sendPatch(env: Env, spec: ObjectSpec, ctx: Ctx, rec: { id: string; properties: Record<string, string | null> },
    itemId: string, patch: Record<string, string>, opts: RunOpts, auth: WriteAuth | undefined, keys: string[]): Promise<string | null> {
  const plan = backwardClearPlan(spec, patch, rec.properties, ctx);
  const where = `[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${itemId}`;
  for (const p of plan.unknown)
    console.log(`${where} field=${p} previous=${JSON.stringify(rec.properties[p] ?? "")} value=${JSON.stringify(patch[p])}`
      + ` action=lifecycle-order-unknown reason="the option order is not loaded or does not hold both values; sent`
      + ` as one PATCH, which HubSpot ignores if it is a move to an earlier stage"`);
  const cleared = Object.keys(plan.clear);
  if (!cleared.length) return patchFromCard(env, spec, rec.id, itemId, patch, opts, auth, keys);

  const moves = cleared.map(p => `${p}:${plan.previous[p]}->${patch[p]}`).join(",");
  const move: Record<string, string> = Object.fromEntries(cleared.map(p => [p, patch[p]]));
  if (!opts.dryRun && opts.writeHubspot) await armRecheck(env, spec, rec.id, where);
  const written: LedgerWrite[] = [];
  const send = async (p: Record<string, string>): Promise<string | null> => {
    const s = Date.now();
    const mod = await patchRecord(env, spec, rec.id, p, opts, auth);
    written.push({ props: p, mod, s, e: Date.now() });
    return mod;
  };
  try {
    const clearedMod = await send({ ...patch, ...plan.clear });
    let failure: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const newMod = await send(move);
        console.log(`${where} moves=${moves} action=lifecycle-backward-clear-set`
          + `${attempt > 1 ? " retried=1" : ""} result=${newMod === null ? "dry-run" : "written"}`);
        return newMod;
      } catch (e) { failure = e; }
    }
    let restore = "ok", restoredMod: string | null = null;
    try { restoredMod = await send(plan.previous); }
    catch (e) { restore = `failed: ${String(e).slice(0, 120)}`; }
    const restored = restore === "ok";
    console.log(`${where} moves=${moves} action=lifecycle-backward-failed restore="${restore}"`
      + (restored ? "" : ` pending=${cleared.join(",")} next="HubSpot holds it empty; the card keeps the person's`
        + ` value, and the queued re-check sends it"`)
      + ` reason="${String(failure).slice(0, 160)}"`);
    throw new BackwardSetError(restored ? (restoredMod ?? clearedMod) : clearedMod, cleared, restored, failure);
  } finally {
    await recordCardPushes(env, spec, rec.id, itemId, written, keys, opts);
  }
}

/** One PATCH that HubSpot answered, for the card's own-write ledger. */
interface LedgerWrite { props: Record<string, string>; mod: string | null; s: number; e: number }

/**
 * ONE PATCH SENT FROM THE CARD `itemId` -- patchRecord, and then, while STALE_FORWARD_RETRY is on, each property written
 * goes to the card's own-write ledger (card-watch.ts PushRec): so a retry or a rescue can tell this card's own versions
 * of a property from anyone else's write made with our app's token. Recorded once HubSpot answered; a PATCH that throws
 * records nothing (its version, should it have landed, reads as someone else's: the safe side). Every business-field
 * PATCH sync.ts sends from a card goes through here or through sendPatch's backward move (repairDanglingClears too).
 * `keys`: the cells it is sent for (PushRec.keys).
 */
async function patchFromCard(env: Env, spec: ObjectSpec, recordId: string, itemId: string, patch: Record<string, string>,
    opts: RunOpts, auth: WriteAuth | undefined, keys: string[]): Promise<string | null> {
  const s = Date.now();
  const newMod = await patchRecord(env, spec, recordId, patch, opts, auth);
  await recordCardPushes(env, spec, recordId, itemId, [{ props: patch, mod: newMod, s, e: Date.now() }], keys, opts);
  return newMod;
}

/** The card's own-write ledger entries for `writes` to `recordId`, sent for the cells `keys` (STALE_FORWARD_RETRY only;
 *  never in a dry run or with HubSpot writes off), in one RPC. A write's `mod`: the modified time HubSpot answered with
 *  (null: none). */
async function recordCardPushes(env: Env, spec: ObjectSpec, recordId: string, itemId: string, writes: LedgerWrite[],
    keys: string[], opts: RunOpts): Promise<void> {
  if (opts.dryRun || !opts.writeHubspot || !staleForwardRetryOn(env, spec) || !writes.length) return;
  const entries: PushRec[] = writes.flatMap(w => {
    const at = timeOf(w.mod);
    return Object.entries(w.props).map(([prop, value]): PushRec =>
      ({ recordId, prop, value: String(value ?? ""), mod: Number.isFinite(at) ? at : NaN, s: w.s, e: w.e, keys: [...keys] }));
  });
  await notePushes(env, { boardId: spec.boardId, itemId, object: spec.object, recordId }, entries);
}

/**
 * Queue this record's RE-CHECK shortly after (DEFERRED_SYNC, as DeferredItem.recheck): the durable repair
 * behind every backward move (sendPatch, step 0), which the queue runs as recheckDanglingClears -- never as a
 * forward pass. Its queue dedups, retries a re-check that throws (MAX_ATTEMPTS) and survives this isolate. A
 * re-check that finds the move landed costs two reads and writes nothing. Without the binding (the WM
 * deployment, whose specs flag no field) or for an object it does not take, nothing is queued and the log
 * says so; spillDeferred itself fails soft and logs.
 */
async function armRecheck(env: Env, spec: ObjectSpec, id: string, where: string): Promise<void> {
  const type = (Object.keys(SPEC_OBJECT_FOR_EVENT) as HsEventObject[]).find(k => SPEC_OBJECT_FOR_EVENT[k] === spec.object);
  if (!type || !env.DEFERRED_SYNC) {
    console.log(`${where} action=lifecycle-recheck-unarmed reason="${type ? "no DEFERRED_SYNC binding" : "no queue type"}`
      + ` for ${spec.object}; a clear its set cannot follow waits for the next HubSpot event on the record"`);
    return;
  }
  await spillDeferred(env, [{ type, id, recheck: true }]);
}

/** A repair an edit path could not finish (repairDanglingClears with `fromEdit`): queue the re-check again --
 *  the one the move armed may have run, or been abandoned, already. Not when nothing would be written anyway. */
async function rearmRecheck(env: Env, spec: ObjectSpec, opts: RunOpts, id: string, itemId: string): Promise<void> {
  if (opts.dryRun || !opts.writeHubspot) return;
  await armRecheck(env, spec, id, `[reverse] object=${spec.object} hubspot_id=${id} monday_item=${itemId}`);
}

/**
 * THE QUEUED RE-CHECK ITSELF (DeferredItem.recheck): finish a backward move's clear whose set never followed
 * -- repairDanglingClears -- and NOTHING ELSE. No forward write, no Sync State, no card created, no
 * associations: it writes monday nothing at all.
 *
 * Why not the ordinary forward pass it used to be. It runs at a fixed ~15 s after the move, when the person
 * is often still working the card, and HubSpot bumps the record's lastmodifieddate by itself (sourceType API)
 * ~7 s after every stage change -- our own write included (contact 553232416501: INTEGRATION at 03:10:17.297,
 * API at 03:10:24.585 and .740). So that pass almost always read HubSpot as newer than Sync State and copied
 * HubSpot's value over any cell that differed: a Job Title typed at +13 s was overwritten at +15 s, and lost
 * if its own run read the card after that, or left HubSpot and the card disagreeing for good if before.
 * Before backward moves were sent at all, no bump followed them, so no such pass ran.
 *
 * HubSpot first, THEN the card: the clear this looks for was made after the person's edit that caused it, so
 * a card read after a HubSpot read that shows the clear shows that edit too (see "WHICH CARD" on
 * repairDanglingClears). Throws when the repair could not be finished now, so the queue tries again.
 */
export async function recheckDanglingClears(env: Env, objectType: HsEventObject, id: string, opts: RunOpts,
    budget: Budget): Promise<string> {
  const via = "via=lifecycle-recheck";
  const spec = specByObject(env, SPEC_OBJECT_FOR_EVENT[objectType]);
  if (!spec) return wlog(objectType, id, "skipped", `reason="object not in scope for this deployment" ${via}`);
  if (!spec.fields.some(f => f.backwardNeedsClear))
    return wlog(spec.object, id, "skipped", `reason="no field of ${spec.object} is moved back by a clear" ${via}`);
  const ctx = await getCtxCached(env);
  const rec = await getRecord(env, spec.object, id, [...new Set([...propertiesForSpec(spec), "sales_user", "createdate"])]);
  if (!rec) return wlog(spec.object, id, "skipped", `reason="record not found (deleted/archived)" ${via}`);
  let card: MondayItem | undefined = (await findItemByColumn(env, spec.boardId, spec.idCol, id))[0];
  if (!card) {
    const known = await lookupCard(env, spec.boardId, id);
    if (known) card = (await getItem(env, known)) ?? undefined;
  }
  if (!card) return wlog(spec.object, id, "skipped", `reason="no linked monday card" ${via}`);
  const left = budget.left;
  const unfinished = await repairDanglingClears(env, spec, ctx, opts, budget, rec, card);
  if (unfinished) throw unfinished;
  return wlog(spec.object, id, budget.left < left ? "repaired-hubspot" : "skipped-in-sync", `board=${spec.boardId} ${via}`);
}

/** How a pass started by a PERSON'S EDIT asks for the repair: see repairDanglingClears. */
interface RepairFromEdit {
  /** The columns the edit itself sends: their own push handles an emptied stage (from empty, one PATCH). */
  skip: ReadonlySet<string>;
  /** Filled with the columns repaired, whose value came from the card as re-read: HubSpot now holds what that
   *  read showed, so the caller must not forward it over its own, older read of the card. */
  repaired: Set<string>;
}

/**
 * THE RE-CHECK: FINISH A BACKWARD MOVE WHOSE SET NEVER FOLLOWED ITS CLEAR. Run by the queued re-check
 * (recheckDanglingClears), at the start of every forward-only pass (so the clear's own HubSpot echo and any
 * later event reach it), and -- `fromEdit` -- before a person's edit (reconcileColumnEdit) or a create
 * window's round (settleRound) stamps Sync State.
 *
 * WHY THE EDIT PATHS TOO. A clear whose set and restore failed leaves HubSpot "" and Sync State behind the
 * clear, which is all that lets the repair see it (the guard below). A person's next edit of ANOTHER column
 * used to stamp its own push time over that -- and from then on every re-check and echo found HubSpot "not
 * newer", so the stage stayed empty for good (review round 3, B1). A person's edit is an even stronger basis
 * for this write than the queue's. Not finished there, the caller leaves Sync State where it was and arms the
 * re-check again.
 *
 * A `backwardNeedsClear` field HubSpot holds EMPTY while the card shows a stage (emptiedFlaggedFields) is
 * exactly what a clear without its set leaves -- and nothing else repairs it: an empty HubSpot value raises
 * no forward diff, and the card is not a person's edit any more. So, and only when HubSpot has changed since
 * Sync State (sendPatch keeps the stamp behind such a clear; anything older is not news):
 *   - ownership first: only a record CRM owns (the clear itself required it); otherwise nothing is read;
 *   - the history decides (danglingClearVerdict): the newest version must be an integration's clear of a set
 *     value, within the window, and NEWER than Sync State. A person's clear in HubSpot, or anyone else's, is
 *     left exactly as it is -- and so is a person's clear sent from monday, which Sync State already took;
 *   - then the card's value is sent. From empty that is a forward move, so it lands in one PATCH. It is the
 *     person's stage when the run died or a restore failed (the card kept it), or the previous stage when
 *     an earlier run healed to it -- either way HubSpot and the card agree again.
 * A HubSpot write from a pass with no person behind it, deliberately: it completes the write a person's edit
 * already started and claimed, and is confined to that shape.
 *
 * WHICH CARD. A forward pass and the queued re-check read HubSpot first and the card after, so their card
 * already shows the edit that caused the clear. A person's edit path reads the card FIRST: that read can
 * predate the very stage edit whose clear it finds (its Job Title event was read just before the stage was
 * changed), and sending the stage it shows would undo that edit -- a later stage blocks the set behind it,
 * which HubSpot then ignores. So `fromEdit` re-reads the card once the history says the clear is ours.
 *
 * Returns the failure, if the history, the card or the PATCH could not be had now: the caller finishes its
 * pass WITHOUT moving Sync State, then throws it or re-arms, so the queue tries again and the next event still
 * sees the record as changed. On success the record is updated in place (value and modified time), as a claim is.
 */
async function repairDanglingClears(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, card: MondayItem,
    fromEdit?: RepairFromEdit): Promise<Error | undefined> {
  const fills = emptiedFlaggedFields(spec, rec as HsRecord, card, ctx).filter(x => !fromEdit?.skip.has(x.f.col));
  if (!fills.length) return undefined;
  if (!(timeOf(rec.properties[spec.modifiedProp]) > timeOf(colText(card, spec.syncStateCol)))) return undefined;
  const where = `[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${card.id}`;
  const names = fills.map(x => x.f.hs).join(",");
  const auth = spec.ownership ? authorizeWrite(rec as HsRecord, spec.ownership) : undefined;
  if (auth && !auth.allowed) {
    console.log(`${where} fields=${names} action=lifecycle-clear-repair-refused reason="${auth.reason}"`);
    return undefined;
  }
  const patch: Record<string, string> = {};
  try {
    const ours: typeof fills = [];
    const syncedAt = timeOf(colText(card, spec.syncStateCol));
    for (const x of fills) {
      const why = danglingClearVerdict(await getPropertyHistory(env, spec.object, rec.id, x.f.hs), Date.now(), syncedAt);
      if (why) console.log(`${where} field=${x.f.hs} card=${JSON.stringify(x.value)} action=lifecycle-empty-left reason="${why}"`);
      else ours.push(x);
    }
    if (!ours.length) return undefined;
    const now = fromEdit ? await getItem(env, card.id) : card;
    const cols: string[] = [];
    for (const { f } of ours) {
      const value = now ? reverseFieldValue(f, colText(now, f.col), ctx) : "";
      if (value) { patch[f.hs] = value; cols.push(f.col); }
      else console.log(`${where} field=${f.hs} action=lifecycle-empty-left reason="${now ? "the card no longer shows a stage"
        : "the card is gone"}: nothing to send"`);
    }
    if (!Object.keys(patch).length) return undefined;
    const newMod = await patchFromCard(env, spec, rec.id, card.id, patch, opts, auth, cols);
    budget.left--;
    for (const c of cols) fromEdit?.repaired.add(c);
    for (const [p, v] of Object.entries(patch))
      console.log(`${where} field=${p} value=${JSON.stringify(v)} action=lifecycle-clear-repaired`
        + ` result=${newMod === null ? "dry-run" : "written"} reason="HubSpot held it empty from our own clear, whose`
        + ` set never followed; sent the card's value"`);
    if (newMod !== null) { Object.assign(rec.properties, patch); rec.properties[spec.modifiedProp] = newMod; }
    return undefined;
  } catch (e) {
    console.log(`${where} fields=${names} action=lifecycle-clear-repair-failed reason="${String(e).slice(0, 160)}"`);
    return new Error(`lifecycle re-check of ${spec.object}/${rec.id} ${names} could not finish: ${String(e).slice(0, 200)}`);
  }
}

/** Objects that take the direction-INDEPENDENT backfill path. Deliberately contacts-only — see the note
 * inside writeSafeBackfills. Deals keep their long-standing toHubspot-only backfill. */
const INDEPENDENT_BACKFILL_OBJECTS = new Set(["contacts"]);

/** Write only the SAFE BACKFILLS from `diffs` (empty HubSpot field <- non-empty monday value), independent
 * of the direction decision. Same guarantees as the reverse path: allowlisted `backfill` fields only,
 * id-matched card, never clears (an empty monday value produces no diff in the first place), idempotent.
 * Every fill is logged `[backfill] ... path=independent` so a rollout's blast radius is auditable. */
async function writeSafeBackfills(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, item: MondayItem,
    diffs: Diff[]): Promise<string | null> {
  if (budget.left <= 0) return null;
  // Deliberately NARROW: only contacts take the direction-independent path. Deals already carry `backfill`
  // on six fields, and they ARE swept by the daily full reconcile, so their existing toHubspot-only
  // behaviour is adequate — routing them here too would turn every toMonday pass (including the nightly
  // sweep over every deal) into an unannounced bulk HubSpot write. Contacts need it precisely because they
  // are skipFullReconcile and nothing else would ever retry the fill.
  // Object-name allowlist OR the per-spec opt-in. The set is keyed on "contacts"/"companies", which the
  // live WM specs also use, so it must not grow; `fillEmptyFromMonday` reaches the same outcome for the
  // CRM specs alone. Without this branch a fill would only happen when the monday edit is itself the
  // trigger (decideDirection returns "toHubspot"); a HubSpot-triggered pass over a company whose monday
  // card holds a value HubSpot lacks would leave it unfilled forever, because CRM specs are
  // skipFullReconcile on a Worker with no SYNC crons (its only cron, */15, dispatches the marketing
  // poller and nothing else) and nothing else ever revisits them.
  if (!INDEPENDENT_BACKFILL_OBJECTS.has(spec.object) && !spec.fillEmptyFromMonday) return null;
  const fills = diffs.filter(d => d.kind === "field" && d.backfill && d.f?.reverse);
  if (!fills.length) return null;
  const patch: Record<string, string> = {};
  for (const d of fills) {
    const v = reverseFieldValue(d.f!, d.mdText, ctx);
    if (v) patch[d.f!.hs] = v;
  }
  if (!Object.keys(patch).length) return null;
  // A rejected backfill must NEVER abort the record's normal sync: patchRecord throws on any HubSpot 4xx,
  // and an unguarded throw here would skip the forward write for good on a record whose monday value
  // HubSpot refuses (validation rule, over-length, bad enum) — that record would stop receiving updates
  // entirely and every drawer save would 502.
  // Same claim-then-write rule as the reverse path: a backfill IS a HubSpot business write, so it may
  // claim ownership — but only here, once the patch is known non-empty.
  const auth = await ensureHubspotWriteAuth(env, spec, budget, rec, opts);
  if (auth && !auth.allowed) {
    console.log(`[backfill] object=${spec.object} hubspot_id=${rec.id} monday_item=${item.id} fields=${Object.keys(patch).join(",")} result=refused reason="${auth.reason}" path=independent`);
    return null;
  }
  let newMod: string | null = null;
  try {
    // A fill has nothing to move back from (HubSpot is empty by construction), so this is always one PATCH;
    // routed through sendPatch only so no write of a backwardNeedsClear property can bypass it.
    newMod = await sendPatch(env, spec, ctx, rec, item.id, patch, opts, auth,
      fills.filter(d => patch[d.f!.hs] !== undefined).map(d => d.f!.col)); budget.left--;
  } catch (e) {
    console.log(`[backfill] object=${spec.object} hubspot_id=${rec.id} monday_item=${item.id} fields=${Object.keys(patch).join(",")} result=error reason="${String(e).slice(0, 160)}" path=independent`);
    return null;
  }
  for (const d of fills) {
    const v = patch[d.f!.hs];
    if (v !== undefined)
      console.log(`[backfill] object=${spec.object} hubspot_id=${rec.id} monday_item=${item.id} field=${d.f!.hs} previous="" value="${v}" result=${newMod === null ? "dry-run" : "written"} path=independent`);
  }
  return newMod;
}

/** Keep the "Shared" people column holding the all-members team on records with NO sales_user (so
 * Unassigned deals stay viewable by everyone under restricted board permissions), cleared once assigned.
 * People columns aren't text-diffed, so this toggles explicitly on the empty/non-empty column state. */
async function maintainShared(env: Env, spec: ObjectSpec,
    rec: { properties: Record<string, string | null> }, item: MondayItem, opts: RunOpts,
    budget: Budget): Promise<void> {
  const us = spec.unassignedShared;
  if (!us?.teamId || budget.left <= 0) return;
  const wantTeam = !(rec.properties.sales_user ?? "").trim();
  const hasTeam = colText(item, us.col).trim() !== "";
  if (wantTeam === hasTeam) return; // already correct
  const value = wantTeam
    ? { personsAndTeams: [{ id: Number(us.teamId), kind: "team" }] }
    : { personsAndTeams: [] };
  await setColumns(env, spec.boardId, item.id, { [us.col]: value }, opts); budget.left--;
  console.log(`${spec.object}/${(rec as any).id ?? ""} shared-column action=${wantTeam ? "set-team" : "cleared"}`);
}

/** monday card with no HubSpot id (added after go-live) -> create/adopt a HubSpot record. */
/**
 * The HubSpot id of the parent a child record must be born attached to, or "" if it cannot be resolved.
 *
 * Follows the chain a rep would: the Connect-Boards column they filled on the form -> the linked monday
 * card -> that card's HubSpot id. Every hop can legitimately fail — the rep left Deal blank, or picked a
 * Deal card that has not itself synced yet — and all of them mean the same thing: not yet. Returning ""
 * lets the caller refuse visibly rather than create an orphan.
 *
 * EXACTLY ONE parent. Where a rep has linked several, the first is not a guess worth making: a line item
 * belongs to one deal, and picking arbitrarily would put revenue on the wrong one.
 */
async function resolveCreateParent(env: Env, spec: ObjectSpec, item: MondayItem): Promise<string> {
  const p = spec.createParent;
  if (!p) return "";
  const target = specByObject(env, p.toObject);
  if (!target) return "";
  const linked = await getLinkedItemIds(env, item.id, p.relationCol);
  if (linked.length !== 1) {
    console.log(`${spec.object} card ${item.id} parent=${p.relationCol} linked=${linked.length}`
      + ` action=unresolved reason="${linked.length ? "more than one parent linked" : "no parent linked"}"`);
    return "";
  }
  const byCard = await getItemsColumnText(env, linked, target.idCol);
  const hsId = (byCard[linked[0]] ?? "").trim();
  if (!/^\d+$/.test(hsId)) {
    console.log(`${spec.object} card ${item.id} parent_card=${linked[0]} action=unresolved`
      + ` reason="the linked ${p.toObject} card carries no HubSpot id yet"`);
    return "";
  }
  return hsId;
}

/** Who caused a monday event, as the webhook resolved it, beyond `selfOrigin`. See syncMondayItem. */
export interface MondayActor { id: string; byAutomation: boolean }

/**
 * WHO STARTED A CREATE, which is what the birth pass is allowed on. It sends the links a card shows on
 * the authority of a PERSON having made the card, so anything else is suppressed (fail closed):
 *   - "person": an event that is neither our own token's (the provenance gate refused those already)
 *     nor an automation's. The Create form and "+ Add" arrive as the rep who used them;
 *   - "automation": monday attributes automation and workflow actions to a negative pseudo-user (-4).
 *     An automation's relation edit never pushes (reverseAssociations), and a create it started is the
 *     same kind of act: a configured rule, not a person picking these links, and able to fire in bulk;
 *   - "sweep": the nightly create loop, which no event started (CRM boards skip it; WM has no birth pass).
 */
interface CreateTrigger { kind: "person" | "automation" | "sweep"; actor?: string }

/**
 * The row turned out to stand for a record ALREADY -- a "have" claim, an adoption, or the card-owner
 * index -- and there is something still to apply to it: see replayOnLinked.
 */
interface AlreadyLinked {
  recordId: string;
  /** The event's own edit, a person's (or an adoption's replay): applied as an edit of the linked card. */
  replay?: MondayEdit;
  /** What a stopped creator left, settled by the same sync (see Takeover). */
  takeover?: Takeover;
  /** The Sync State this Worker last wrote for the record (CardEntry.baseline). See withBaseline. */
  baseline?: string;
  /** No baseline is known, but the card was made FROM the record by this Worker (the card-owner index):
   *  it stands for the record as HubSpot had it when the card was made. See withBaseline. */
  fromCard?: boolean;
  /** A read to replay on, when the event's own read predates the edits being replayed (an adoption). */
  card?: MondayItem;
  /** For the log: why the row was already linked. */
  why: string;
}

/**
 * A STOPPED CREATOR'S CREATE WINDOW, handed to whoever settles the card in its place: the row's alarm, a
 * sync that found the hold stale, a 'have' read. `entries` is its queue with the notes beside it;
 * `snapshot` is there when the window was never settled (see CreateSnapshot) -- then the stand-in runs
 * the creator's own round (settleTakeover).
 */
export interface Takeover {
  entries: PendingEdit[];
  snapshot?: CreateSnapshot;
  /** Filled in by the round (settleTakeover): the Sync State it left on the card. The row's alarm records
   *  it, as a creator's release records its own, for a read that predates it (createWindowFor). */
  settled?: string;
}

/** The Connect-Boards columns of a spec. A relation edit made mid-create is sent by the birth pass (it
 *  reads the cells after the id write-back), never by a column replay, which has no before/after diff. */
function relationColsOf(spec: ObjectSpec): Set<string> {
  return new Set((spec.associations ?? []).flatMap(a => a.relationCol ? [a.relationCol] : []));
}

/** What an event's edit leaves for a create in flight: which columns, and whose. Nothing for an event
 *  that names no column (item created, moved) or for the sweep. */
function pendingEditOf(edit: MondayEdit | undefined, actorClass: PendingEdit["actorClass"] | null,
    actor?: string): PendingEdit | undefined {
  if (!edit || !actorClass || (!edit.cols.length && !edit.name)) return undefined;
  return { cols: [...edit.cols], ...(edit.name ? { name: true } : {}), actorClass,
    ...(actor ? { actor } : {}), at: Date.now() };
}

/**
 * WHOSE IS EACH COLUMN NOW, by a create window's queue and notes: its LATEST entry decides (a tie goes to
 * the later one in queue order, which is arrival order). A fresh read cannot say who put a value there,
 * so a column a person edited and an automation -- or our own token, a note -- then overwrote is not the
 * person's any more, and the other way round it is. The one rule for every replay: the creator's round,
 * a takeover, a 'have' read, an adoption. Relation columns are left out: no before/after diff survives
 * the queue, and a created record's birth pass reads those cells itself. Keyed by column id, and NAME_KEY.
 */
function latestEntries(spec: ObjectSpec, entries: PendingEdit[]): Map<string, PendingEdit> {
  const relation = relationColsOf(spec);
  const latest = new Map<string, PendingEdit>();
  const see = (k: string, e: PendingEdit) => {
    const cur = latest.get(k);
    if (!cur || e.at >= cur.at) latest.set(k, e);
  };
  for (const e of entries) {
    for (const c of e.cols) if (!relation.has(c)) see(c, e);
    if (e.name) see(NAME_KEY, e);
  }
  return latest;
}

/** A latest entry that is a person's edit to replay (not an automation's, not a note). */
const replayable = (e: PendingEdit) => e.actorClass === "person" && !e.note;

/**
 * The PEOPLE's columns of a create-window queue, as one column edit: those whose latest entry is a
 * person's (latestEntries). Everything else is never sent -- logged by logDroppedEntries.
 */
function personReplayOf(spec: ObjectSpec, entries: PendingEdit[]): MondayEdit | undefined {
  const cols: string[] = [];
  let name = false;
  let actor: string | undefined;
  for (const [k, e] of latestEntries(spec, entries)) {
    if (!replayable(e)) continue;
    if (k === NAME_KEY) name = true; else cols.push(k);
    actor = e.actor ?? actor;
  }
  if (!cols.length && !name) return undefined;
  return { cols, ...(name ? { name: true } : {}), ...(actor ? { actor } : {}) };
}

/** The log line for a column a replay does not send because its latest entry is not a person's edit. */
function droppedLine(spec: ObjectSpec, itemId: string, recordId: string, key: string, e: PendingEdit,
    shown = false): string {
  const who = e.actorClass === "integration" ? "our own token" : `an ${e.actorClass}`;
  return `${spec.object} card ${itemId} hubspot_id=${recordId} cols=${key === NAME_KEY ? "name" : key}`
    + `${e.actor ? ` actor=${e.actor}` : ""} class=${e.actorClass} action=create-window-edit-dropped reason="${
      e.note ? `the cell was last written by ${who} while the record's create window was open; it is not sent as a person's edit`
        : `an ${e.actorClass}'s edit made while the record was being created is not sent${shown ? "; the card shows HubSpot's value" : ""}`}"`;
}

function logDroppedEntries(spec: ObjectSpec, itemId: string, recordId: string, entries: PendingEdit[]): void {
  for (const [k, e] of latestEntries(spec, entries))
    if (!replayable(e)) console.log(droppedLine(spec, itemId, recordId, k, e));
}

/**
 * How long after its record was created (or after the edit, for a record older than it) a queued edit is
 * replayed exactly as the creator would have replayed it. A replay later than this -- a takeover that
 * failed and was retried or given up, a queue nothing took until the next sync of the card, minutes or
 * hours on -- first asks whether HubSpot has changed that property since (hubspotMovedOn): a HubSpot
 * user's newer change is kept, and shown on the card, rather than overwritten with an older value from
 * monday. Two minutes covers the creator's own round and the row's first alarm (35 s after the hold),
 * with room for a slow HubSpot create; it is the create-window gate of the version before the alarm.
 */
export const REPLAY_FRESH_MS = 2 * 60_000;

/**
 * HAS HUBSPOT MOVED ON FROM THE CREATE, for the property behind `key` (a column id, or NAME_KEY)? As far
 * as can be told without its history:
 *   - a property the create sent (`sent`): HubSpot holds something else now -- a HubSpot user's change,
 *     or a workflow's;
 *   - one it did not send: HubSpot holds anything at all. A create default (the pipeline) and a later
 *     change cannot be told apart, so a LATE replay does not risk the latter.
 * Compared as the card would show it, so a value HubSpot re-rendered (a date) is not a change. Only a late
 * replay asks (REPLAY_FRESH_MS): a timely one is what the creator's round would have sent.
 */
function hubspotMovedOn(spec: ObjectSpec, ctx: Ctx, rec: { properties: Record<string, string | null> },
    key: string, sent: Record<string, string>): boolean {
  const f = key === NAME_KEY ? undefined : spec.fields.find(x => x.col === key);
  const prop = key === NAME_KEY ? spec.nameReverse : f?.hs;
  if (!prop) return false;
  const now = String(rec.properties[prop] ?? "").trim();
  if (!(prop in sent)) return now !== "";
  const was = String(sent[prop] ?? "").trim();
  if (now === was) return false;
  if (f && f.type !== "people") {
    const shown = expectedText(f, now, ctx);
    if (shown !== null && shown === expectedText(f, was, ctx)) return false;
  }
  return true;
}

/** Is a replay of an edit made at `at` late (REPLAY_FRESH_MS), for this record? */
function lateReplay(spec: ObjectSpec, rec: { properties: Record<string, string | null> }, at: number): boolean {
  const born = timeOf(rec.properties[spec.ownership?.createdProp ?? "createdate"]);
  return Date.now() - Math.max(at, Number.isFinite(born) ? born : 0) > REPLAY_FRESH_MS;
}

function refusedLine(spec: ObjectSpec, itemId: string, recordId: string, key: string): string {
  const prop = key === NAME_KEY ? spec.nameReverse : spec.fields.find(x => x.col === key)?.hs;
  return `${spec.object} card ${itemId} hubspot_id=${recordId} cols=${key === NAME_KEY ? "name" : key}`
    + ` action=create-window-edit-refused reason="HubSpot changed ${prop ?? key} after this edit was made, and`
    + ` the replay comes late: HubSpot's newer value is kept, and shown on the card"`;
}

/**
 * THE 'have' RACE: an edit that arrives once the record exists but before monday serves the id written
 * for it. Re-stamping alone (the old answer) kept the record but dropped the edit, which is the live
 * bug's other half. So the edit is handed back to be applied as what it is -- an edit of the now-linked
 * card, through the ordinary linked path -- together with whatever a stalled or dead creator left
 * (`left`), which the same sync settles in its place (settleTakeover).
 *
 * The event's own edit only when it is a PERSON's (the old re-stamp-only answer stands for an
 * automation's). What a creator left is taken when it holds a person's edit or was never settled (a
 * snapshot); otherwise it is only logged. The event's OWN relation edit carries its diff and goes through
 * reverseAssociations like any linked relation edit.
 */
function replayOnLinked(env: Env, spec: ObjectSpec, itemId: string, recordId: string, edit: MondayEdit | undefined,
    trigger: CreateTrigger, left: Takeover | undefined,
    link: Omit<AlreadyLinked, "recordId" | "replay" | "takeover">): AlreadyLinked | undefined {
  if (!spec.columnLevelReverse) return undefined;   // record-level (WM): unchanged, re-stamp only
  // The kill switch: off, a 'have' claim (or a card-owner re-stamp) re-stamps only, as before. Nothing
  // queues while it is off, so leftovers can only be a create that was in flight when it was flipped.
  if (!createWindowReplayOn(env, spec)) {
    const queued = left?.entries.filter(e => !e.note).length ?? 0;
    if (queued)
      console.log(`${spec.object} hubspot_id=${recordId} queued=${queued} action=create-window-replay-disabled`
        + ` reason="CREATE_WINDOW_REPLAY is off: edits queued before the switch was turned off are not replayed"`);
    return undefined;
  }
  const own = trigger.kind === "person" && edit && (edit.cols.length || edit.name) ? edit : undefined;
  const take = left && (left.snapshot || personReplayOf(spec, left.entries)) ? left : undefined;
  if (left && !take) logDroppedEntries(spec, itemId, recordId, left.entries);
  if (!own && !take) return undefined;
  return { recordId, ...link, ...(own ? { replay: own } : {}), ...(take ? { takeover: take } : {}) };
}

/**
 * A takeover is settled from a FRESH read of the card. This event's own read was taken before its claim,
 * and the queue it took may be younger than that read -- behind a card-owner re-stamp it always is: the
 * edits queued while this very event held the claim. Replayed on the older read, a queued edit that
 * filled a cell would find it empty and send nothing (or a clear). An unreadable card keeps the old read.
 */
async function withFreshCard(env: Env, itemId: string, linked: AlreadyLinked | undefined): Promise<AlreadyLinked | undefined> {
  if (!linked?.takeover || linked.card) return linked;
  const fresh = await getItem(env, itemId);
  return fresh ? { ...linked, card: fresh } : linked;
}

/**
 * OUR OWN TOKEN'S EDIT OF A CARD WITH NO ID YET, noted for the row's create window (the provenance gate
 * then refuses it). Its event never reaches a claim, so without a note a replay of a person's queued edit
 * of the same column would read our value off the card and send it as theirs. CREATE_WINDOW_REPLAY only;
 * a no-op for a row with no window open, and it fails open.
 */
async function noteOwnEdit(env: Env, spec: ObjectSpec, itemId: string, edit: MondayEdit | undefined,
    actor: MondayActor | undefined): Promise<void> {
  if (!createWindowReplayOn(env, spec) || !spec.createFromMonday) return;
  const note = pendingEditOf(edit, "integration", actor?.id || edit?.actor);
  if (!note) return;
  try { await noteCreateWindowEdit(env, spec.boardId, itemId, note); }
  catch (e) { console.log(`[md-create] note item=${itemId} error="${String(e).slice(0, 120)}"`); }
}

/**
 * AN ADOPTION'S REPLAY: the people's edits that queued WHILE the adoption was searching HubSpot, sent to
 * the record it found -- from a FRESH read, since the adopter's own read predates them (replayed on it,
 * an edit that filled an empty cell would read as one that emptied it, and clear HubSpot's value).
 *
 * Only where the card has changed since the adoption read it. A value the card already held then -- a
 * form's own field, whose event trails the item's creation -- is the new card's starting state, not an
 * edit of the record, and an adoption has never pushed a new card's starting values onto an existing
 * record. The adopter's own event is not replayed, for the same reason.
 */
async function adoptionReplay(env: Env, spec: ObjectSpec, item: MondayItem, adopt: { id: string; modified: string },
    queued: PendingEdit[]): Promise<AlreadyLinked | undefined> {
  logDroppedEntries(spec, item.id, adopt.id, queued);
  const want = personReplayOf(spec, queued);
  if (!want) return undefined;
  const fresh = await getItem(env, item.id);
  if (!fresh) return undefined;
  const cols = want.cols.filter(c => {
    const f = spec.fields.find(x => x.col === c);
    return f ? cellKey(f, fresh) !== cellKey(f, item) : colText(fresh, c) !== colText(item, c);
  });
  const name = !!want.name && fresh.name.trim() !== item.name.trim();
  if (!cols.length && !name) {
    console.log(`${spec.object} card ${item.id} hubspot_id=${adopt.id} action=adoption-replay-skipped`
      + ` reason="nothing queued during the adoption differs from what the adoption read"`);
    return undefined;
  }
  return { recordId: adopt.id, card: fresh, baseline: adopt.modified,
    why: "a person edited the card while it was being adopted; the edit is applied to the adopted record",
    replay: { cols, ...(name ? { name: true } : {}), ...(want.actor ? { actor: want.actor } : {}) } };
}

/**
 * The card as a read that lags monday cannot show it: carrying the Sync State the card really holds.
 *
 * A replay's read is missing the id (that is why it is a replay) and so the Sync State written in the same
 * mutation. Reconciled as it is, an empty Sync State makes HubSpot read as "newer" than the card, and the
 * column-level engine copies HubSpot's values over every other column the person has changed -- the live
 * bug, by another road. So the ordinary freshness rule is given the baseline it would have read: the one
 * this Worker last wrote for the record, or -- for a card made from the record, with no baseline known
 * (`fromCard`) -- the moment the card was made (its created_at). The card was built from the record as
 * HubSpot had it then, so a HubSpot change made AFTER it still reads as newer and comes across. (Judging
 * it by the record as it is now, the version before, buried that change for good: the replay's push then
 * stamped Sync State past it, and the change's own webhook found nothing newer to bring.) A read that does
 * show a Sync State keeps it: for a card made from the record, whatever it shows; otherwise when it is
 * the later one.
 */
function withBaseline(item: MondayItem, spec: ObjectSpec, link: Pick<AlreadyLinked, "baseline" | "fromCard">): MondayItem {
  const shown = colText(item, spec.syncStateCol);
  const want = link.fromCard
    ? (shown || item.created_at || "")
    : (link.baseline && !(timeOf(shown) >= timeOf(link.baseline)) ? link.baseline : shown);
  return want && want !== shown ? withColumn(item, spec.syncStateCol, want) : item;
}

/**
 * THE CREATE_WINDOW_REPLAY KILL SWITCH: is the create-window machinery on for this spec?
 *
 * Only the literal "true" arms it, and only on a column-level spec (the only kind that ever had it).
 * Anything else, including absent, is the create path exactly as it was before the machinery existed,
 * and every one of its ENTRY POINTS asks this, so the off path is that old path rather than a new one
 * that happens to agree with it:
 *   - the claim is made WITHOUT the event's edit, so an event that finds the create in flight is skipped
 *     and nothing queues (createFromMonday);
 *   - the create records its id with a plain finish: no hold, no heartbeat, no settle round, no release;
 *   - a 'have' claim and a card-owner re-stamp re-stamp only (replayOnLinked), and an adoption settles
 *     with a plain finish and replays nothing;
 *   - a sync of a young linked card never consults the create window (reconcileRecord).
 * Read on every event, so flipping the var in the Cloudflare dashboard takes effect without a code change.
 */
export function createWindowReplayOn(env: { CREATE_WINDOW_REPLAY?: string }, spec: ObjectSpec): boolean {
  return !!spec.columnLevelReverse && env.CREATE_WINDOW_REPLAY === "true";
}

/**
 * THE BORN_ATTACHED_LINKS KILL SWITCH: does a monday-born record get the card's relation links (the birth
 * pass, bornAttached)? Only the literal "true" arms it; anything else, including absent, is the create path
 * as it was before the pass existed -- no association write follows a monday-born record. It gates the
 * LINKS only: the card-owner re-stamp and the create's provenance are duplicate-record guards and stay on.
 * Read on every create, so flipping the var in the Cloudflare dashboard takes effect without a code change.
 * (pushBirthAssociations repeats the same test, so no other caller can get past it.)
 */
export function birthLinksOn(env: { BORN_ATTACHED_LINKS?: string }): boolean {
  return env.BORN_ATTACHED_LINKS === "true";
}

async function createFromMonday(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    item: MondayItem, emailCol: string | undefined, stats: Stats, trigger: CreateTrigger,
    /** The edit that started this event (column-level specs): queued if a create is already in flight,
     *  replayed by this create's own settle if this event becomes the creator. */
    edit?: MondayEdit): Promise<AlreadyLinked | undefined> {
  // Cross-isolate guard. monday fires create_pulse AND change_column_value for one new row; those land in
  // different isolates where `coalesce` (per-isolate) can't see each other, so both used to reach here and
  // each created its own HubSpot record — leaving one orphan that the sync then carded separately.
  //
  // COLUMN-LEVEL: the claim also QUEUES this event's edit when a create is in flight. It used to be
  // skipped and lost: a person changing HubSpot Stage twice on a brand-new card saw the first change
  // create the deal, the second land here as "creating", and the forward pass that followed HubSpot's
  // creation webhook copy the first value back over the card (2026-09-30 17:40Z, user 104231430).
  // With CREATE_WINDOW_REPLAY off (createWindowReplayOn) the claim carries no edit: the old skip-and-drop.
  // (STALE_FORWARD_GATE: `item` was read just now -- what it shows is what a create sends; a change after it is an edit.)
  const readAt = Date.now();
  const windowOn = createWindowReplayOn(env, spec);
  const defer = windowOn
    ? pendingEditOf(edit, trigger.kind === "sweep" ? null : trigger.kind, trigger.actor) : undefined;
  const claim = defer
    ? await claimHubspotForItem(env, spec.boardId, item.id, defer)
    : await claimHubspotForItem(env, spec.boardId, item.id);
  if (claim.status === "creating") {
    // Skipping is still right. When a PERSON's event started the create in flight, this skip loses no
    // relation edit: that create reads the card's links AFTER its id write-back (pushBirthAssociations),
    // so anything linked now is sent then. When an AUTOMATION's event started it, the birth pass is
    // suppressed and a link made now is not sent (logged there as birth-assoc-suppressed). With
    // BORN_ATTACHED_LINKS off there is no birth pass, and the log says only what it always said.
    stats.skipped++;
    console.log(`${spec.object} card ${item.id} create already in flight — skipping (would duplicate)`
      + (spec.columnLevelReverse && birthLinksOn(env)
        ? `; its links are read by that create's birth pass, unless an automation's event started it` : ""));
    if (claim.deferred && defer)
      console.log(`${spec.object} card ${item.id} cols=${defer.cols.join(",")}${defer.name ? " name" : ""}`
        + `${defer.actor ? ` actor=${defer.actor}` : ""} class=${defer.actorClass} action=deferred-to-create reason="${
          defer.actorClass === "person"
            ? "queued: the creator replays it from a fresh read of the card once the record exists"
            : "recorded, not sent: an automation's edit made while the record is being created"}"`);
    return;
  }
  if (claim.status === "have") {
    // The record exists: a previous attempt created it but its id write-back failed -- or this read lags
    // the write-back of a create that is still settling. Re-stamp instead of creating again (idempotent
    // beside a write-back still in flight).
    await setColumns(env, spec.boardId, item.id,
      { [spec.idCol]: claim.itemId, ...linkValue(spec, ctx, claim.itemId) }, opts);
    stats.adopted++; budget.left--;
    console.log(`${spec.object} card ${item.id} re-stamped with ${claim.itemId} (${claim.settling
      ? "its create is still settling; this read lags the id written for it" : "earlier write-back had failed"})`);
    // With CREATE_WINDOW_REPLAY off that is all: replayOnLinked hands nothing back (the old re-stamp).
    // On, what a stopped creator left (its queue, and its snapshot when it never settled) goes with it.
    const left: Takeover | undefined = claim.pending?.length || claim.snapshot
      ? { entries: claim.pending ?? [], ...(claim.snapshot ? { snapshot: claim.snapshot } : {}) } : undefined;
    return withFreshCard(env, item.id, replayOnLinked(env, spec, item.id, claim.itemId, edit, trigger, left,
      { baseline: claim.baseline,
        why: "the record exists but monday had not served its id yet; the edit is applied to it, not dropped" }));
  }

  /**
   * THE CARD ALREADY STANDS FOR A RECORD. Every card this Worker makes for a HubSpot record (a HubSpot-born
   * record's card, a restore) goes through ensureCardForRecord, whose finishCard writes the card-owner
   * index -- but never this per-item claim, so the claim above said "proceed". An empty id in THIS read
   * is then monday's id-read lag, the misreading the provenance gate in syncMondayItem exists for, reached
   * by an event that is not our token's: an automation on item-created, or a person's edit inside the
   * lag. Creating would DUPLICATE the record, and the birth pass would copy onto the duplicate the links
   * the forward pass wrote into the cell from the real one. So it is re-stamped instead, like "have".
   *
   * The claim is settled on that record FIRST, so a failed re-stamp still leaves the next event reading
   * "have" rather than reaching a create. CRM boards only (suppressSelfOriginWrites): the Work-Management
   * create path is left as it is. Fails open like the claim: an index that cannot be read returns null.
   */
  if (spec.suppressSelfOriginWrites) {
    const owner = await lookupCardOwner(env, spec.boardId, item.id);
    if (owner) {
      // With CREATE_WINDOW_REPLAY on, settled as a LINK: this claim made the row read "creating" for a
      // moment, so a person's edit inside the lag may have queued behind it (an automation's item-created
      // event holding the claim, say). A plain finish stranded that queue, watched by nothing, for whichever
      // sync came next -- an hour on, a HubSpot user's change, which the stale value then overwrote. The
      // link hands it back, and it is applied now with this event. Off: the plain finish, as before.
      const queued = windowOn
        ? (await finishHubspotForItem(env, spec.boardId, item.id, owner, "link")) ?? []
        : (await finishHubspotForItem(env, spec.boardId, item.id, owner), []);
      await setColumns(env, spec.boardId, item.id, { [spec.idCol]: owner, ...linkValue(spec, ctx, owner) }, opts);
      stats.adopted++; budget.left--;
      console.log(`${spec.object} card ${item.id} hubspot_id=${owner} action=re-stamped`
        + ` reason="the card-owner index already pairs this card with that record; an empty id read does not make it a new row"`);
      // The same lag as the 'have' race, on a card this Worker made for a HubSpot record: a person's edit
      // inside it is still an edit of that record. No baseline is recorded for such a card, but it was
      // made FROM the record, so it is judged against the record as HubSpot had it when the card was made
      // (see withBaseline). The re-stamp itself is a duplicate-record guard and runs whatever the switches
      // say; only this replay is CREATE_WINDOW_REPLAY's (replayOnLinked).
      return withFreshCard(env, item.id, replayOnLinked(env, spec, item.id, owner, edit, trigger,
        queued.length ? { entries: queued } : undefined,
        { fromCard: true, why: "the card-owner index pairs this card with the record; the edit is applied to it, not dropped" }));
    }
  }

  // CRM specs declare their adoption key. A SEPARATE branch so the production WM adoption paths below
  // stay byte-for-byte unchanged — WM specs have no `adoptBy` and never enter here. The `else if` is
  // load-bearing: a CRM Accounts spec that found no match must NOT fall into the WM companies branch,
  // which adopts on `item.name` (a display name on the CRM board).
  if (spec.adoptBy) {
    const key = adoptionKey(item, spec);
    if (!key) {
      // No usable domain/email -> do not create a HubSpot record. Non-destructive and visible: the reason
      // is stamped on the card's Sync State so a rep can see why nothing happened.
      stats.skipped++;
      await forgetHubspotForItem(env, spec.boardId, item.id);
      await setColumns(env, spec.boardId, item.id,
        { [spec.syncStateCol]: `not synced — needs ${spec.adoptBy.kind}` }, opts).catch(() => {});
      console.log(`${spec.object} card ${item.id} action=skip-create reason=needs_${spec.adoptBy.kind}`);
      return;
    }
    const adopt = spec.adoptBy.kind === "email"
      ? await searchContactByEmail(env, key)
      : await searchCompanyByDomain(env, key);
    if (adopt) {
      // ADOPTION DOES NOT CLAIM. The card is linked to the existing HubSpot record so no duplicate is
      // made, but ownership is untouched: a historical record stays WM-owned (or unstamped), so the CRM
      // reverse write remains blocked by authorizeWrite. Recreating history must never migrate ownership.
      const adoptedAt = Date.now();
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: adopt.id, [spec.syncStateCol]: adopt.modified, ...linkValue(spec, ctx, adopt.id) }, opts);
      // STALE_FORWARD_GATE: the card shows the FORM's values, which are not edits of the record, under a Sync State
      // it never synced to. Within W a forward pass holds them (they are recent); at +W the watch converges every
      // two-way cell HubSpot holds otherwise -- with or without a HubSpot event (finding [0]). The link time goes
      // with it: what the card showed before it is never rescued or re-sent as a person's edit of the record --
      // adoption never pushes the form's values, and never claims (see above). Should the watch not learn it, the
      // id cell's own write in monday's log dates it for both (effectiveLinkAt). The write above keeps gql's own
      // rate-limit waits (it may land minutes late): its stamp is noted like every other (forwardOnlyGated, step 8).
      if (staleForwardGateOn(env, spec)) {
        const base: WatchBase = { boardId: spec.boardId, itemId: item.id, object: spec.object, recordId: adopt.id };
        const linkedAt = Date.now();
        await noteStamp(env, base, adopt.modified, adoptedAt, linkedAt, spec.syncStateCol, !!opts.dryRun);
        await watchCells(env, base, [], { all: true, linkedAt, windowMs: holdWindowMs(env), dryRun: !!opts.dryRun });
      }
      // Column-level: settled as a link, handing back the edits that queued while the search ran. With
      // CREATE_WINDOW_REPLAY off nothing queued, and the plain finish is the old one.
      const queued = windowOn
        ? (await finishHubspotForItem(env, spec.boardId, item.id, adopt.id, "link", { baseline: adopt.modified })) ?? []
        : (await finishHubspotForItem(env, spec.boardId, item.id, adopt.id), []);
      stats.adopted++; budget.left--;
      console.log(`${spec.object} card ${item.id} action=adopted hubspot_id=${adopt.id} by=${spec.adoptBy.kind}`);
      // NOT BORN HERE, SO NOT BORN ATTACHED. The birth pass writes on the authority of the stamp this
      // Worker put in its own create payload; an adopted record carries no such stamp, and its links are
      // a person's edit to make through the ordinary, ownership-checked column-level path.
      console.log(`${spec.object} card ${item.id} hubspot_id=${adopt.id} action=birth-links-skipped reason=adopted`);
      // A person's edit that arrived WHILE the adoption ran was queued, not sent: it is an edit of the
      // record just adopted, and goes through that same ordinary path now. See adoptionReplay.
      return windowOn ? adoptionReplay(env, spec, item, adopt, queued) : undefined;
    }
  } else if (spec.object === "contacts") {
    const email = emailCol ? colText(item, emailCol) : "";
    if (!email) { stats.skipped++; await forgetHubspotForItem(env, spec.boardId, item.id); console.log(`contact card ${item.id} has no email — skip create`); return; }
    const adopt = await searchContactByEmail(env, email);
    if (adopt) { // link the card to the existing HubSpot contact instead of creating a duplicate
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: adopt.id, [spec.syncStateCol]: adopt.modified, ...linkValue(spec, ctx, adopt.id) }, opts);
      await finishHubspotForItem(env, spec.boardId, item.id, adopt.id);
      stats.adopted++; budget.left--;
      return;
    }
  } else if (spec.object === "companies") {
    // Companies had NO dedup at all — every trigger created another company. The card's NAME is its domain
    // (COMPANIES_MYLA.nameProps = ["domain"]), so adopt an existing company on the same normalized domain.
    // CHAINED to the adoptBy branch above: a CRM spec must never reach this name-based adoption.
    const adopt = await searchCompanyByDomain(env, item.name);
    if (adopt) {
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: adopt.id, [spec.syncStateCol]: adopt.modified, ...linkValue(spec, ctx, adopt.id) }, opts);
      await finishHubspotForItem(env, spec.boardId, item.id, adopt.id);
      stats.adopted++; budget.left--;
      return;
    }
  }
  // BIRTH OWNERSHIP. A record created here has no HubSpot twin, so there is nothing to claim — and born
  // unstamped it would be stranded behind this Worker's own write guard. Ownership is therefore set
  // atomically in the create payload. Categorically different from claimOwnership(), whose only permitted
  // mutation is the ownership property of an EXISTING record. Inert for specs without ownership.
  const props = withBirthOwnership(buildCreateProperties(item, spec, ctx), spec.ownership);
  // NEVER CREATE A RECORD THIS SYNC COULD NOT FIND AGAIN.
  //
  // A spec with `adoptBy` matches cards to records by one key property. buildCreateProperties only
  // emits fields marked `reverse` (reconcile.ts:305), so if that key property is not reversible the
  // create silently omits it — and mints a record with an EMPTY dedup key. That is not a cosmetic
  // gap: the next lookup for it misses, so a later card creates a second copy, and nothing errors at
  // any point. Live on 2026-09-09: four Accounts cards carried real domains with no HubSpot match,
  // and `domain` was forward-only, so each was one webhook away from creating a domainless company.
  //
  // Refusing is safe and visible where creating is neither: the card keeps its data, the reason lands
  // on Sync State for the rep, and nothing irreversible happens in HubSpot — monday deletion never
  // deletes a HubSpot record, so a junk record created here would have to be cleaned up by hand.
  if (spec.adoptBy) {
    const keyField = spec.fields.find(f => f.col === spec.adoptBy!.col);
    if (!keyField || !props[keyField.hs]) {
      stats.skipped++;
      await forgetHubspotForItem(env, spec.boardId, item.id);
      await setColumns(env, spec.boardId, item.id,
        { [spec.syncStateCol]: `not synced — ${spec.adoptBy.kind} is not writable to HubSpot` }, opts).catch(() => {});
      console.log(`${spec.object} card ${item.id} action=skip-create`
        + ` reason="would create a record with no ${spec.adoptBy.kind}, which nothing could match again"`
        + ` key_field=${keyField?.hs ?? "UNMAPPED"} key_reversible=${!!keyField?.reverse}`);
      return;
    }
  }
  /**
   * A CHILD RECORD IS BORN ATTACHED, OR NOT AT ALL.
   *
   * Resolved before the create and sent inside it. Refusing is the safe direction here in a way it is
   * not elsewhere: a line item created without its deal is invisible in HubSpot's UI — no quote, no
   * deal amount, nothing linking back — and monday cannot delete a HubSpot record to tidy it up. The
   * card keeps everything the rep typed and says why on Sync State, so the fix is to fill in the Deal
   * and let the next event retry.
   */
  let parentAssoc: { toId: string; associationTypeId: number }[] | undefined;
  if (spec.createParent) {
    const parentHsId = await resolveCreateParent(env, spec, item);
    if (!parentHsId) {
      stats.skipped++;
      await forgetHubspotForItem(env, spec.boardId, item.id);
      await setColumns(env, spec.boardId, item.id,
        { [spec.syncStateCol]: `not synced — needs a linked ${spec.createParent.toObject.replace(/s$/, "")}` },
        opts).catch(() => {});
      console.log(`${spec.object} card ${item.id} action=skip-create`
        + ` reason="its ${spec.createParent.relationCol} does not resolve to a HubSpot`
        + ` ${spec.createParent.toObject} id; a parentless record would be unreachable"`);
      return;
    }
    parentAssoc = [{ toId: parentHsId, associationTypeId: spec.createParent.associationTypeId }];
  }

  let created: { id: string; modified: string } | null;
  const createdFrom = Date.now();
  try {
    created = await createRecord(env, spec, props, opts,
      spec.ownership ? authorizeCreate(spec.ownership) : undefined, parentAssoc);
  } catch (e) {
    await forgetHubspotForItem(env, spec.boardId, item.id); // release so a later pass may retry
    throw e;
  }
  const createdTo = Date.now();
  if (created) {
    // Record the pairing BEFORE the write-back: if the write-back fails, the next pass re-stamps from here
    // instead of creating a second HubSpot record.
    //
    // COLUMN-LEVEL: as a HOLD, with the Sync State the write-back is about to stamp as its baseline. The
    // id is just as durable; the hold only says this creator is alive and will bring the new card into
    // line (settleCreateWindow), so a forward pass leaves the card to it. The queue closes here: an edit
    // arriving from now on is an edit of an existing record and sends itself. With it goes what this
    // creator knows (CreateSnapshot), for whoever has to settle the card should it stop. With
    // CREATE_WINDOW_REPLAY off: the plain finish, as before -- no hold, so nothing below waits on this creator.
    if (windowOn)
      await finishHubspotForItem(env, spec.boardId, item.id, created.id, "hold",
        { baseline: created.modified, snapshot: createSnapshot(spec, item, props, edit, trigger) });
    else await finishHubspotForItem(env, spec.boardId, item.id, created.id);
    // The write-back is idempotent -> retries hard (setColumns retries=3). If it still fails, the
    // HubSpot record exists but the card has no id and would re-create next tick: log the orphan and
    // signal the caller to STOP creating this run so the failure can't cascade into duplicates.
    const writeBackAt = Date.now();
    try {
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: created.id, [spec.syncStateCol]: created.modified, ...linkValue(spec, ctx, created.id) }, opts);
      // Register the pairing NOW: HubSpot's creation webhook arrives within seconds, before monday has
      // indexed the id we just stamped, and would otherwise create a second card for this record.
      await finishCard(env, spec.boardId, created.id, item.id);
    } catch (e) {
      // Stop holding: nothing will settle this create now. The next event re-stamps the card, applies its
      // edit, and takes the queue with it. No baseline either: the card was never stamped.
      if (windowOn) await finishHubspotForItem(env, spec.boardId, item.id, created.id);
      console.log(`CRITICAL: created ${spec.object}/${created.id} but id write-back to card ${item.id} failed — aborting ${spec.object} create loop: ${String(e).slice(0, 200)}`);
      throw new Error("WRITEBACK_FAILED");
    }
    const writeBackEnd = Date.now();
    /**
     * A contact a person created from the monday form gets its owner's notice, exactly as one assigned in HubSpot
     * would (OWNER_NOTICE; Contacts only) -- the queue decides, and flags 通知状态 for the board's workflow to send.
     * QUEUED NOW, the moment the card is paired with the new record -- not last: the birth-links pass and the
     * create window's settle below can each sit on monday's rate limit past the monday webhook's ~30 s, and a
     * creator cut off there never queued it (its takeover does not, and HubSpot's creation webhook finds the card
     * already paired). Safe this early: the queue runs it no sooner than its next wave, reads the owner back from
     * HubSpot, flags only a card that shows that owner, and writes only 通知状态 -- a column nothing below reads,
     * writes or replays. The owner-change event HubSpot fires for the same birth is the same entry.
     */
    if (spec.ownerNotice && ownerNoticeOn(env))
      await queueOwnerNotices(env, [created.id], "created in monday").catch(() => undefined);
    // STALE_FORWARD_GATE, after the write-back (never able to fail it) and after the owner notice is queued (its
    // reads and writes never wait on monday's rate limit either way).
    if (staleForwardGateOn(env, spec))
      await afterCreateWriteBack(env, spec, ctx, opts, item, created, props, windowOn, writeBackAt, writeBackEnd, readAt,
        { s: createdFrom, e: createdTo });
  }
  stats.createdInHubspot++; budget.left--;
  // HEARTBEAT before the birth pass: it can wait on monday's rate limit, and a hold that went stale while
  // this creator was still alive would hand the card to a forward pass it is about to settle.
  if (created && windowOn)
    await finishHubspotForItem(env, spec.boardId, item.id, created.id, "renew");
  // BORN ATTACHED. Only a record this call genuinely created (not a dry run, which returns null; not an
  // adoption or a re-stamp, which returned above), only AFTER the id write-back (see
  // pushBirthAssociations for why that ordering is what covers a relation edit made mid-create), only
  // for a create a person's event started (see bornAttached), and only while the BORN_ATTACHED_LINKS
  // switch is on. Off, the pass is not run at all -- no read of the cells, no association write -- which
  // is the create path as it was before it existed; one line per create says so.
  if (created) {
    if (birthLinksOn(env)) await bornAttached(env, spec, item, created.id, props, opts, budget, trigger);
    else if (spec.columnLevelReverse)
      console.log(`${spec.object} card ${item.id} hubspot_id=${created.id} action=birth-links-disabled`
        + ` reason="BORN_ATTACHED_LINKS is off: the card's links are not sent to the new record"`);
  }
  // Then close the create window: replay what people changed while the record was being made, bring the
  // card into line with what HubSpot did on its own, and set the baseline. CREATE_WINDOW_REPLAY only.
  if (created && windowOn)
    await settleCreateWindow(env, spec, ctx, opts, budget, item, created.id, props, stats);
}

/**
 * A MONDAY-BORN RECORD'S CARD, ONCE ITS ID WRITE-BACK LANDED (STALE_FORWARD_GATE). None of these steps can turn the
 * create into a failure (the write-back already succeeded, finishCard already ran), and none waits on monday's rate
 * limit (they run inside the creator's webhook, after its owner notice is queued):
 *   1. the stamp it wrote goes to the card's register (noteStamp); STALE_FORWARD_RETRY: what the create sent goes to
 *      the card's own-write ledger (PushRec), so the record's create-time versions read as this card's own;
 *   2. CREATE_WINDOW_REPLAY off: the card's watch converges at +W whatever HubSpot derived on its own (watch-all), and
 *      learns the link time -- when the create READ the card (`readAt`): what it showed then is what the create sent
 *      (or refused), never rescued or re-sent as a person's edit; a change made since -- during the id write-back too
 *      (`s`..`e`, linkWrite) -- is an edit of the new record;
 *   3. ...and the card is shown what the create SENT where it showed something else -- a default it never had (Deals'
 *      Pipeline, a default Stage), a name the create split into first/last -- so it is in line with its new record at
 *      once (finding [12]). ONLY a cell that still shows what the create read and has no person's edit on its way (a
 *      mark): the watch is asked FIRST (with step 2's call), then the card is re-read, then the fill is written -- so
 *      the re-read is the last thing before the write. A cell a person changed or is changing is left to that person's
 *      own run and to the converge, which judge it per cell. Best effort, with create_labels_if_missing
 *      (updateColumns); a failure is logged.
 * KNOWN RESIDUAL (documented, not closable here): a pick that lands in the sub-second gap between the re-read and the
 * fill's write is written over, and its own run then finds the card equal to HubSpot and sends nothing. monday has no
 * compare-and-set, and the run sends what the card shows, never an event's value; closing it would need the pick's
 * value carried from its event to a re-assertion that is itself ordered after the fill -- the same gap every forward
 * write has between its card read and its write (R1's no-CAS residual), at its widest here only by the re-read.
 * With CREATE_WINDOW_REPLAY on, the creator's own settle round does 2 and 3.
 */
async function afterCreateWriteBack(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, item: MondayItem,
    created: { id: string; modified: string }, props: Record<string, string>, windowOn: boolean, s: number, e: number,
    readAt: number, createdIn: { s: number; e: number }): Promise<void> {
  const base: WatchBase = { boardId: spec.boardId, itemId: item.id, object: spec.object, recordId: created.id };
  const dry = !!opts.dryRun;
  if (created.modified) await noteStamp(env, base, created.modified, s, e, spec.syncStateCol, dry);
  await recordCardPushes(env, spec, created.id, item.id,
    [{ props, mod: created.modified || null, s: createdIn.s, e: createdIn.e }], [ALL_CELLS], opts);
  if (windowOn) return;
  const where = `${spec.object} card ${item.id} hubspot_id=${created.id}`;
  const failed = (err: unknown) => console.log(`${where} action=create-fill-failed reason="${String(err).slice(0, 160)}"`
    + ` next="the card's watch converges it at +W"`);
  const sent: HsRecord = { id: created.id, properties: props };
  const want = fieldDiffs(sent, item, spec, ctx, false)
    .filter(d => d.kind === "field" && !d.backfill && !!d.f && Object.hasOwn(props, d.f.hs));
  // Marks first (with the converge-all and the link), so the card's re-read below is the last thing before the write.
  const probes: WatchReq[] = want.filter(d => isGatedField(env, spec, d.f!))
    .map(d => ({ key: d.f!.col, fp: cellKey(d.f!, item), typed: false, anchor: Date.now(), kind: "probe" }));
  const replies = await watchCells(env, base, probes, { all: true, linkedAt: readAt, linkWrite: { s, e },
    windowMs: holdWindowMs(env), dryRun: dry });
  let shown: MondayItem | null = null;
  if (want.length) {
    try { shown = (await getItemFresh(env, item.id, [], 0))?.item ?? null; }
    catch (err) { failed(err); }
  }
  // Still showing what the create read, with no person's edit on its way: the fill's to write.
  const unchanged = shown ? want.filter(d => cellKey(d.f!, shown!) === cellKey(d.f!, item)) : [];
  const fill = unchanged.filter(d => !replies?.[d.f!.col]?.mark);
  const skipped = shown ? want.filter(d => !fill.includes(d)) : [];
  if (skipped.length)
    console.log(`${where} cols=${skipped.map(d => d.f!.col).join(",")} action=create-fill-skipped reason="changed since the`
      + ` create read the card, or a person's edit of it is on its way: left to that edit's own run and the watch"`);
  if (!fill.length) return;
  try {
    const cv = buildUpdatePayload(fill, sent, spec, ctx);
    if (Object.keys(cv).length) {
      await updateColumns(env, spec.boardId, item.id, cv, opts, 0);
      console.log(`${where} cols=${Object.keys(cv).join(",")}`
        + ` action=create-filled reason="the card shows what the create sent (defaults, a split name)"`);
    }
  } catch (err) { failed(err); }
}

/**
 * What this creator knows, kept with its hold for whoever settles the card in its place (CreateSnapshot):
 * the two-way cells as it read them, what it sent, and its own event -- the columns that event named,
 * and whose it was (none for the sweep).
 */
function createSnapshot(spec: ObjectSpec, built: MondayItem, sent: Record<string, string>,
    edit: MondayEdit | undefined, trigger: CreateTrigger): CreateSnapshot {
  const relation = relationColsOf(spec);
  const cols = (edit?.cols ?? []).filter(c => !relation.has(c));
  const own = trigger.kind !== "sweep" && (cols.length || edit?.name)
    ? { cols, ...(edit?.name ? { name: true } : {}), actorClass: trigger.kind,
        ...(trigger.actor ? { actor: trigger.actor } : {}) } : undefined;
  return { built: builtCells(spec, built), sent: { ...sent }, ...(own ? { trigger: own } : {}), at: Date.now() };
}

/** Each two-way cell of a card, and its name, as cellKey reads them: a create's `built`, by column. */
function builtCells(spec: ObjectSpec, item: MondayItem): Record<string, string> {
  const out: Record<string, string> = { [NAME_KEY]: item.name.trim() };
  for (const f of spec.fields) if (f.reverse || f.appReverse) out[f.col] = cellKey(f, item);
  return out;
}

/**
 * THE CREATE WINDOW, CLOSED BY THE CREATOR.
 *
 * Two halves, split at the moment the record exists (the hold):
 *   - BEFORE it, there is nothing to send an edit to. A claim answers "creating" and queues the event's
 *     edit (CreateIdempotency.claimCard) instead of dropping it. This settle replays the queue.
 *   - FROM it, an edit is an edit of an existing record and sends itself, whether its read shows the id
 *     (the linked path) or lags it (the 'have' race): nothing waits on this creator, so nothing is lost
 *     if it dies. What waits is only the FORWARD half -- HubSpot's creation webhook, the association
 *     webhooks the birth pass sets off, our own echoes -- because judged by Sync State, HubSpot's
 *     post-create recalculation makes every difference on the card read as HubSpot's (createWindowFor).
 *
 * One round (settleRound) therefore settles it: nothing can join the queue after the hold. This event's
 * own edit is NOT replayed: its value is what the create was built from, and a later change of the same
 * column -- a second event folded into this run by the webhook, or one still on its way -- is on the
 * card, held there by the absorb, and sent by its own event. (Replaying it here sent whatever the cell
 * held on the basis of a PERSON's edit, even when an automation or our own token had put it there.)
 *
 * The hold is a HEARTBEAT (renewed here, and before the birth pass). A creator that stalls or dies lets it
 * go stale, and whoever gets there first settles the card IN ITS PLACE, by this same round: the row's own
 * alarm, set for that moment (settleAbandonedCreate), or a sync of the card (settleTakeover). The hold
 * recorded what they need (CreateSnapshot) -- including that a folded re-run of this event, which died
 * with it, is now theirs to send. The queue is acknowledged only once the round has run, so a creator
 * that dies mid-replay leaves it for them instead of losing it.
 *
 * Fenced like the birth pass: the record exists and is counted, so a failure here is logged, never thrown,
 * and the hold is ALWAYS released.
 */
async function settleCreateWindow(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    built: MondayItem, recordId: string, sent: Record<string, string>, stats: Stats): Promise<void> {
  // The heartbeat, and the edits that queued while HubSpot was making the record, with the notes beside
  // them (read, not yet removed).
  const queued = (await finishHubspotForItem(env, spec.boardId, built.id, recordId, "renew")) ?? [];
  let settled: string | null = null;
  try {
    settled = await settleCreateRound(env, spec, ctx, opts, budget, built, recordId, queued, sent, stats);
  } catch (e) {
    console.log(`${spec.object} card ${built.id} hubspot_id=${recordId} action=create-settle-error`
      + ` reason="${String(e).slice(0, 160)}"`);
  }
  // Acknowledged only if the round ran to the end, and only the queue it was given (notes are not
  // counted); otherwise the queue, the hold's baseline and its snapshot stay, and the row settles the card.
  await finishHubspotForItem(env, spec.boardId, built.id, recordId, "release",
    settled === null ? {} : { ack: queued.filter(e => !e.note).length, ...(settled ? { baseline: settled } : {}) });
}

// cellKey (a card cell normalised exactly as fieldDiffs normalises the monday side) and NAME_KEY (the monday name
// edit, as a column key) live in card-watch.ts, which the stale-forward gate shares with the create window.

/** The creator's round, on its own fresh reads: HubSpot FIRST, then the card. An edit whose push lands
 *  between the two reads is then seen on the card with the later Sync State it stamped, so the baseline
 *  never moves back past it (read the other way round, the card would predate that stamp and the settle
 *  would write an older one over it). null when either cannot be read. See settleRound. */
async function settleCreateRound(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    built: MondayItem, recordId: string, batch: PendingEdit[], sent: Record<string, string>,
    stats: Stats): Promise<string | null> {
  const rec = await getRecord(env, spec.object, recordId, propertiesForSpec(spec));
  if (!rec) return null;
  const fresh = await getItem(env, built.id);
  if (!fresh) return null;
  // monday may not serve the id this create stamped yet; the card IS linked to this record.
  return settleRound(env, spec, ctx, opts, budget, rec, withColumn(fresh, spec.idCol, recordId), recordId,
    { entries: batch, built: builtCells(spec, built), sent }, stats);
}

/** What one round of a create window is given. See settleRound. */
interface Round {
  /** The queue, with the notes beside it (PendingEdit.note). */
  entries: PendingEdit[];
  /** The two-way cells as the create read them (CreateSnapshot.built). */
  built: Record<string, string>;
  /** What the create sent (CreateSnapshot.sent). */
  sent: Record<string, string>;
  /** A stand-in's only: the creator's own event, whose folded re-run died with it, and when it held. */
  trigger?: CreateSnapshot["trigger"];
  heldAt?: number;
  /** A stand-in's only: the edit of the sync that is standing in, sent with the rest as its own. */
  own?: MondayEdit;
  /** Run in the creator's place (settleTakeover), not by the creator. For the log. */
  standIn?: boolean;
}

/**
 * THE CREATE WINDOW'S ROUND: send what people changed while the record was being made, take what HubSpot
 * changed on its own, set the baseline. Run by the creator (settleCreateRound), and by whoever settles the
 * card in its place when it stops (settleTakeover): the same rules, on the same record of what the create
 * read and sent. Returns the Sync State the card now holds ("" if none is known).
 *
 * 1. REPLAY. Every column whose LATEST entry is a PERSON's edit (latestEntries) is sent through the
 *    ordinary column-level push (pushColumnEdit), from the card as it is now -- so HubSpot gets what is on
 *    screen, however many edits queued. An automation's edit is not sent (as before this existed); its
 *    column is shown as HubSpot has it, which is what the forward pass used to do to it. A column our own
 *    token (or a dropped automation event) wrote last -- a note -- is not sent either, and is left as it is.
 *    A stand-in also sends the creator's own column when it has changed since the create read it and
 *    nothing queued explains it: that is the webhook's folded re-run of the creator's event, which died
 *    with the creator -- sent as the lost run would have sent it, and only for a person's event (an
 *    automation's create sends nothing on its behalf; the cell is held, below).
 *    A LATE replay (REPLAY_FRESH_MS) is not sent over a newer HubSpot change of the same property
 *    (hubspotMovedOn): that value is kept, and shown on the card.
 *
 * 2. ABSORB, and why it cannot be the ordinary forward pass. HubSpot recalculates a new record right after
 *    creating it (stage probability, created date, derived fields), which moves its modified timestamp
 *    past the create's. Judged by Sync State, EVERY difference on the card then reads as "HubSpot is
 *    newer" and is copied over it -- including a person's edit whose own event has not arrived yet. That
 *    was the live bug's last step. The create's read (`built`) tells the two apart per column:
 *      - a column HubSpot owns (one-way), or a two-way cell NOBODY has touched since `built`: the
 *        difference is HubSpot's -- a create default the card never showed (the pipeline), its own
 *        recalculation (probability), a workflow's value, a replay's consequence -> shown on the card;
 *      - a two-way cell that HAS changed since: a person's edit (its event on the way, or folded into a
 *        re-run of the creator's event) -> left alone, for that event to push. This is also where a value
 *        our own token or an automation put there after `built` stays: the engine's ordinary rule for a
 *        difference HubSpot did not cause (reconcileForwardOnly).
 *    Sync State plays no part in it, which is why a stand-in brings HubSpot's post-create state across
 *    even after a person's push during the hold stamped Sync State past it.
 *
 * 3. BASELINE. Sync State is stamped with HubSpot's timestamp as read (or the replay's own) -- never
 *    moved backwards past one a person's edit wrote meanwhile. From here the engine's ordinary rule
 *    holds: a later forward pass acts only if HubSpot changes AGAIN, and every difference it finds before
 *    then is monday's -- which is exactly what the cells left alone in (2) are. So HubSpot's creation
 *    webhook, arriving after this, has nothing to copy back.
 */
async function settleRound(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: HsRecord, card: MondayItem, recordId: string, r: Round, stats: Stats): Promise<string> {
  const itemId = card.id;
  const relation = relationColsOf(spec);
  const keyOf = (c: string): string => {
    if (c === NAME_KEY) return card.name.trim();
    const f = spec.fields.find(x => x.col === c);
    return f ? cellKey(f, card) : colText(card, c);
  };
  /** Changed since the create read it. Only a cell the create recorded can say (two-way, and the name). */
  const touched = (c: string) => r.built[c] !== undefined && keyOf(c) !== r.built[c];

  // 1. Whose is each column now, and what is sent.
  const latest = latestEntries(spec, r.entries);
  const send = new Set<string>();      // replayed: column ids and NAME_KEY
  const dropped = new Set<string>();   // an automation's: not sent, shown as HubSpot has it
  const refused = new Set<string>();   // HubSpot moved on after the edit: not sent, shown as HubSpot has it
  const replay = (c: string, at: number) => {
    if (lateReplay(spec, rec, at) && hubspotMovedOn(spec, ctx, rec, c, r.sent)) {
      refused.add(c);
      console.log(refusedLine(spec, itemId, recordId, c));
    } else send.add(c);
  };
  for (const [c, e] of latest) {
    if (replayable(e)) { replay(c, e.at); continue; }
    if (!e.note) dropped.add(c);
    console.log(droppedLine(spec, itemId, recordId, c, e, !e.note));
  }
  const t = r.trigger;
  if (t?.actorClass === "person")
    for (const c of [...t.cols.filter(x => !relation.has(x)), ...(t.name ? [NAME_KEY] : [])])
      if (!latest.has(c) && touched(c)) {
        console.log(`${spec.object} card ${itemId} hubspot_id=${recordId} cols=${c === NAME_KEY ? "name" : c}`
          + `${t.actor ? ` actor=${t.actor}` : ""} action=create-window-rerun-replayed reason="changed since the`
          + ` create read it, by nothing queued: the re-run of the creator's own event, which stopped with it"`);
        replay(c, r.heldAt ?? Date.now());
      }
  const own = r.own;
  const cols = new Set([...(own?.cols ?? []), ...[...send].filter(c => c !== NAME_KEY)]);
  const name = !!own?.name || send.has(NAME_KEY);

  // A backward move's clear an earlier run left unfinished: finished before this round stamps Sync State over
  // it (see repairDanglingClears). Not finished now -> no restamp, and the re-check is armed again.
  const repaired = new Set<string>();
  const unfinished = await repairDanglingClears(env, spec, ctx, opts, budget, rec, card, { skip: cols, repaired });

  let push: ColumnPush = { patch: {}, heal: [], healName: false, newMod: null, fields: [] };
  if (cols.size || name)
    push = await pushColumnEdit(env, spec, ctx, opts, budget, rec, card, stats,
      { ...(own ?? {}), cols: [...cols], ...(name ? { name: true } : {}) });
  const pushed = push.newMod !== null ? push.patch : {};
  const effective: HsRecord = { id: rec.id, properties: { ...rec.properties, ...pushed } };

  // 2. Absorb.
  const held: string[] = [];
  const forward = fieldDiffs(effective, card, spec, ctx, false).filter(d => {
    if (d.backfill || d.kind === "group") return false;   // a backfill is monday's value HubSpot lacks
    if (d.kind === "name") {
      if (name || push.healName) return false;          // the replay's own rename: sent, or healed below
      if (!spec.nameReverse || dropped.has(NAME_KEY) || refused.has(NAME_KEY)) return true;
      if (!touched(NAME_KEY)) return true;              // HubSpot builds the name, or nobody renamed it
      held.push("name");
      return false;
    }
    const f = d.f;
    if (!f || cols.has(f.col)) return false;             // the replay's own edit: sent, or healed below
    if (repaired.has(f.col)) return false;               // HubSpot now holds what the card showed when re-read
    if (!(f.reverse || f.appReverse)) return true;       // HubSpot's column: nothing on it is monday's
    if (dropped.has(f.col) || refused.has(f.col)) return true;   // not sent: shown as HubSpot has it
    if (!touched(f.col)) return true;                    // untouched since the create read it
    held.push(f.col);
    return false;
  });

  // 3. One monday write: HubSpot's changes, heals of what could not be sent, and the baseline.
  const healDiffs: Diff[] = push.heal.map(f => ({ kind: "field", f, hsText: "", mdText: "",
    ...(f.type === "people" && !formatValue(f, effective.properties[f.hs], ctx) ? { peopleClear: true } : {}) }));
  const cv = buildUpdatePayload([...forward, ...healDiffs], effective, spec, ctx);
  const shown = colText(card, spec.syncStateCol);
  // Never the clear's own time while a backward move is pending (ColumnPush.pending).
  const stamp = (push.pending ? null : push.newMod) ?? rec.properties[spec.modifiedProp] ?? "";
  // Forwards only: an edit sent while this ran (holdForward) stamped its own, later, push time. A push it
  // makes after the card read is still a race this cannot see; its event's own stamp lands after.
  const restamp = !unfinished && !!stamp && !(timeOf(shown) >= timeOf(stamp));
  if (restamp) cv[spec.syncStateCol] = stamp;
  if (unfinished) await rearmRecheck(env, spec, opts, rec.id, itemId);
  const renames = push.healName || forward.some(d => d.kind === "name");
  if (renames) {
    await updateItem(env, spec.boardId, itemId, itemName(effective, spec), cv, opts);
    budget.left--;
  } else if (Object.keys(cv).length) {
    await setColumns(env, spec.boardId, itemId, cv, opts);
    budget.left--;
  }
  if (forward.length || healDiffs.length || push.healName) stats.toMonday++;
  if (!push.fields.length && !forward.length && !healDiffs.length && !push.healName) stats.inSync++;
  const baseline = restamp ? stamp : shown;
  console.log(`${spec.object} card ${itemId} hubspot_id=${recordId} action=create-window-settled`
    + ` sent=${push.newMod !== null ? push.fields.join(",") : "-"}`
    + ` shown=${forward.map(d => d.kind === "name" ? "name" : d.f?.col).join(",") || "-"}`
    + ` held=${held.join(",") || "-"} dropped=${[...dropped].join(",") || "-"}`
    + ` refused=${[...refused].join(",") || "-"} baseline=${baseline || "-"}${r.standIn ? " by=stand-in" : ""}`);
  return baseline;
}

/** The card as it is, but showing `text` in column `col` (the id monday has not served back yet). */
function withColumn(item: MondayItem, col: string, text: string): MondayItem {
  return { ...item, column_values: [...item.column_values.filter(c => c.id !== col), { id: col, text }] };
}

/**
 * Records younger than this are checked for a monday-row create window (createWindowFor): as long as
 * the row can hold anything for them. A LIVE hold lasts CREATE_CLAIM_STALE_MS past its last heartbeat,
 * but a stalled or dead creator's QUEUE stays until someone takes it -- the row's alarm, normally within
 * seconds, or failing that the first sync of the card -- and the row keeps it for its whole retention
 * (CreateIdempotency's RETENTION_MS, 24 h after its last write). A 2-minute gate here once let a queue
 * outlive every sync that could read it: the next event, minutes later, reverted the card instead. The
 * extra hour covers a row whose last write came after the create (a takeover's retries, a release).
 * Pinned against RETENTION_MS by test/create-window-edits.test.ts. An older record is never asked. What
 * a LATE reader may still send is bounded separately, per property (REPLAY_FRESH_MS, hubspotMovedOn).
 */
export const CREATE_WINDOW_MS = 25 * 60 * 60_000;

/** epoch-ms or ISO -> ms; NaN when neither. */
function timeOf(v: unknown): number {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
}

/**
 * A SYNC OF A LINKED CARD THAT IS STILL INSIDE ITS CREATE WINDOW. See settleCreateWindow.
 *
 * Only a RECENT record is asked about (its own created date, fetched with every CRM record for the
 * ownership rules; see CREATE_WINDOW_MS), so an established card never pays the Durable Object read and
 * behaves exactly as before. A young record whose row holds nothing -- HubSpot-born, or a create that
 * settled -- syncs exactly as before too, judged by the Sync State the row recorded (`baseline`) when the
 * read shows an older one. Then:
 *   - its creator is ALIVE (a fresh hold): an edit that carries a column -- a person's or an
 *     automation's -- is an edit of an existing record and is sent now, by the ordinary column-level
 *     path, with `holdForward` (HubSpot's post-create changes are the creator's to bring across). Nothing
 *     is parked on the creator, so nothing is lost if it dies. A sync with no edit of its own -- HubSpot's
 *     creation webhook, an association webhook, our own echo, an event that names no column -- would only
 *     copy HubSpot's values over the card, so it is LEFT to the creator (`leave`).
 *   - its creator stalled or died (a stale hold), or never settled (its release left the window open):
 *     this sync settles the card in its place (`takeover`, see settleTakeover), with its own edit.
 * Our own token's edit is never sent; it is NOTED for the window (CreateIdempotency.noteEdit), so that no
 * replay sends what we wrote there as a person's edit.
 * Fails open: an unreadable state, like an old record, syncs as it always did.
 */
async function createWindowFor(env: Env, spec: ObjectSpec,
    rec: { id: string; properties: Record<string, string | null> }, card: MondayItem,
    edit: MondayEdit | undefined, selfOrigin: boolean):
    Promise<{ leave: boolean; holdForward: boolean; baseline?: string; takeover?: Takeover }> {
  const ordinary = { leave: false, holdForward: false };
  const born = timeOf(rec.properties[spec.ownership?.createdProp ?? "createdate"]);
  if (!Number.isFinite(born) || Date.now() - born > CREATE_WINDOW_MS) return ordinary;
  const note = selfOrigin ? pendingEditOf(edit, "integration", edit?.actor) : undefined;
  let w: Awaited<ReturnType<typeof createWindowOf>>;
  try { w = await createWindowOf(env, spec.boardId, card.id, note); }
  catch { return ordinary; }    // a registry that cannot answer must never block a sync
  const own = edit && (edit.cols.length || edit.name) && !selfOrigin ? edit : undefined;
  if (w.settling) {
    if (own) {
      console.log(`${spec.object} card ${card.id} hubspot_id=${rec.id} cols=${own.cols.join(",") || "-"}`
        + `${own.name ? " name" : ""} class=${own.byAutomation ? "automation" : "person"} action=applied-inside-create-window`
        + ` reason="an edit of a record that exists is sent now; the creator brings the rest of the card into line"`);
      return { leave: false, holdForward: true };
    }
    console.log(`${spec.object} card ${card.id} hubspot_id=${rec.id} action=left-to-settling-create`
      + ` reason="the record's create is still settling; its creator brings the card into line with HubSpot itself`
      + ` (its row takes over if the creator stops)"`);
    return { leave: true, holdForward: false };
  }
  const base = w.baseline ? { baseline: w.baseline } : {};
  if (!w.leftovers?.length && !w.snapshot) return { ...ordinary, ...base };
  return { ...ordinary, ...base,
    takeover: { entries: w.leftovers ?? [], ...(w.snapshot ? { snapshot: w.snapshot } : {}) } };
}

/**
 * A STOPPED CREATOR'S CREATE WINDOW, SETTLED BY THIS SYNC IN ITS PLACE: whoever finds it -- the row's
 * alarm (settleAbandonedCreate), a sync that finds the hold stale (createWindowFor), a 'have' read
 * (replayOnLinked) -- with its own edit (`own`), if it carries one.
 *
 * With the creator's snapshot (a window it never settled): the creator's own round (settleRound). Without
 * one -- a queue behind a create made with the switch off, or behind a claim that turned out to stand for
 * a record already (the card-owner index) -- there is no create read to judge the card by: its people's
 * edits are sent as the edit they are (by the latest-entry rule, and not over a newer HubSpot change when
 * late), with this sync's own, through the ordinary engine.
 */
async function settleTakeover(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, card: MondayItem, stats: Stats,
    take: Takeover, own: MondayEdit | undefined): Promise<void> {
  const queued = take.entries.filter(e => !e.note);
  console.log(`${spec.object} card ${card.id} hubspot_id=${rec.id} queued=${queued.length}`
    + `${take.snapshot ? "" : " snapshot=none"} action=create-window-leftovers-replayed reason="its creator stopped`
    + ` before it settled the card; this sync settles it in its place"`);
  if (take.snapshot) {
    const settled = await settleRound(env, spec, ctx, opts, budget, rec as HsRecord, card, rec.id, { entries: take.entries,
      built: take.snapshot.built, sent: take.snapshot.sent, trigger: take.snapshot.trigger,
      heldAt: take.snapshot.at, own, standIn: true }, stats);
    if (settled) take.settled = settled;
    return;
  }
  const replay = leftoversReplay(spec, ctx, rec, card, own, take.entries);
  if (replay) return reconcileColumnEdit(env, spec, ctx, opts, budget, rec, card, stats, replay);
  if (own) return reconcileColumnEdit(env, spec, ctx, opts, budget, rec, card, stats, own);
  return reconcileForwardOnly(env, spec, ctx, opts, budget, rec, card, stats);
}

/**
 * A queue without a snapshot, as one edit: its people's columns (latestEntries), less any a LATE replay
 * would send over a newer HubSpot value (hubspotMovedOn, with nothing known to have been sent), merged
 * with the sync's own edit. An automation's own edit keeps its (weaker, never-claiming) basis for the
 * whole push; a record born in this window is CRM's already, so the person's edits still go through.
 */
function leftoversReplay(spec: ObjectSpec, ctx: Ctx, rec: { id: string; properties: Record<string, string | null> },
    card: MondayItem, own: MondayEdit | undefined, entries: PendingEdit[]): MondayEdit | undefined {
  logDroppedEntries(spec, card.id, rec.id, entries);
  const cols: string[] = [];
  let name = false;
  let actor: string | undefined;
  for (const [k, e] of latestEntries(spec, entries)) {
    if (!replayable(e)) continue;
    if (lateReplay(spec, rec, e.at) && hubspotMovedOn(spec, ctx, rec, k, {})) {
      console.log(refusedLine(spec, card.id, rec.id, k));
      continue;
    }
    if (k === NAME_KEY) name = true; else cols.push(k);
    actor = e.actor ?? actor;
  }
  if (!cols.length && !name) return undefined;
  if (!own) return { cols, ...(name ? { name: true } : {}), ...(actor ? { actor } : {}) };
  return { ...own, cols: [...new Set([...own.cols, ...cols])], ...(own.name || name ? { name: true } : {}) };
}

/**
 * A CREATE WINDOW WHOSE CREATOR STOPPED, SETTLED BY ITS OWN ROW (CreateIdempotency.alarm).
 *
 * The creator's hold lapsed before its settle round ran (or its release left the window open), and
 * HubSpot's creation webhook -- which lands inside the live hold -- was left to it. So nothing else is
 * coming. Without this the card waited for whichever event came next, and that event reverted it to the
 * create-time values instead (a HubSpot change forwarding them, or an unrelated edit's step 1 copying
 * them across). This is that next sync, run now, standing in for the creator (settleTakeover): the queue
 * is sent as the person's edits it holds, a folded re-run of the creator's own event that died with it is
 * sent as that run would have, and HubSpot's own changes (its post-create recalculation, pipeline,
 * created date, the summary Stage) come to the card. Two things the row knows besides:
 *   - the card is this record's even when its read shows no id (a write-back that never landed): it is
 *     re-stamped, as a 'have' claim would re-stamp it;
 *   - a read without the id lacks the Sync State written with it, so it is judged against the baseline
 *     the hold recorded (withBaseline), not an empty cell.
 * Returns the outcome line, and throws on a failure the alarm should retry (a monday or HubSpot error). A
 * card or record that is gone, a card showing another record now, or the switch turned off since, is an
 * outcome and not a failure: logged, and the window is closed.
 */
export async function settleAbandonedCreate(env: Env, boardId: string, itemId: string, recordId: string,
    take: Takeover, baseline: string | undefined, opts: RunOpts, budget: Budget): Promise<string> {
  const via = "via=create-window-alarm";
  const spec = specByBoard(env, boardId);
  if (!spec) return wlog("monday", itemId, "skipped", `reason="board ${boardId} not configured" ${via}`);
  if (!createWindowReplayOn(env, spec) || !spec.createFromMonday) {
    console.log(`${spec.object} card ${itemId} hubspot_id=${recordId} queued=${take.entries.filter(e => !e.note).length}`
      + ` action=create-window-replay-disabled reason="CREATE_WINDOW_REPLAY is off: a stopped create's queue is not replayed"`);
    return wlog("monday", itemId, "skipped", `reason="CREATE_WINDOW_REPLAY is off" ${via}`);
  }
  const ctx = await getCtxCached(env);
  const rec = await getRecord(env, spec.object, recordId, propertiesForSpec(spec));
  if (!rec) return wlog("monday", itemId, "skipped", `reason="linked ${spec.object} ${recordId} not in HubSpot" ${via}`);
  const item = await getItem(env, itemId);
  if (!item) return wlog("monday", itemId, "skipped", `reason="item not found (deleted)" ${via}`);
  const shown = colText(item, spec.idCol).trim();
  if (shown && shown !== recordId)
    return wlog("monday", itemId, "skipped", `reason="the card shows ${spec.object} ${shown} now, not ${recordId}" ${via}`);
  let card = item;
  if (!shown) {
    await setColumns(env, spec.boardId, item.id, { [spec.idCol]: recordId, ...linkValue(spec, ctx, recordId) }, opts);
    budget.left--;
    await finishCard(env, spec.boardId, recordId, item.id);
    console.log(`${spec.object} card ${item.id} re-stamped with ${recordId} (its create stopped before monday served the id)`);
    card = withColumn(item, spec.idCol, recordId);
  }
  card = withBaseline(card, spec, { baseline });
  const stats = emptyStats();
  await reconcileRecord(env, spec, ctx, opts, budget, rec, card, stats, false, false, undefined, false, take);
  return wlog("monday", itemId, actionOf(stats), `board=${boardId} deal=${recordId} ${via}`);
}

/**
 * The birth pass, fenced off from the create. The create already happened and is counted, and the id is
 * stamped. A failure here must never surface as a create error, and never as WRITEBACK_FAILED, which
 * would stop the cron's create loop. One line per created record: the summary, or why there was none.
 *
 * PROVENANCE, checked here because pushBirthAssociations reads the WHOLE cell and cannot tell who put a
 * card in it. The provenance gate upstream only refuses our own token's events, so without this an
 * automation's event on a new row pushed every card in its relation cells. Suppressed, not refused: the
 * cells are left as they are, exactly as reverseAssociations leaves an automation's relation edit.
 */
async function bornAttached(env: Env, spec: ObjectSpec, item: MondayItem, recordId: string,
    props: Record<string, string>, opts: RunOpts, budget: Budget, trigger: CreateTrigger): Promise<void> {
  if (!spec.columnLevelReverse) return;   // record-level (WM): no birth pass, and nothing new logged
  if (trigger.kind !== "person") {
    console.log(`source=monday object=${spec.object} id=${recordId} item=${item.id}`
      + `${trigger.actor ? ` actor=${trigger.actor}` : ""} action=birth-assoc-suppressed reason="${
        trigger.kind === "automation"
          ? "the create was triggered by a monday automation, not a person"
          : "no person's event is behind this create (the nightly sweep)"}"`);
    return;
  }
  try {
    const r = await pushBirthAssociations(env, spec, recordId, props, item, opts, budget);
    if (r) console.log(`${spec.object} card ${item.id} hubspot_id=${recordId} action=born-attached`
      + ` links=${r.links} skipped=${r.skipped} refused=${r.refused}`);
  } catch (e) {
    console.log(`${spec.object} card ${item.id} hubspot_id=${recordId} action=born-attached-error`
      + ` reason="${String(e).slice(0, 160)}"`);
  }
}

export async function syncSpec(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget): Promise<Stats> {
  const stats = emptyStats();
  const [records, items] = await Promise.all([searchAll(env, spec), getBoardItems(env, spec.boardId)]);
  const byId = indexByHubspotId(items, spec.idCol);

  for (const rec of records) {
    stats.processed++;
    if (budget.left <= 0) { stats.skipped++; continue; }
    try {
      await reconcileRecord(env, spec, ctx, opts, budget, rec, byId[String(rec.id)], stats);
    } catch (e) {
      stats.errors++;
      console.log(`error ${spec.object}/${rec.id}: ${String(e).slice(0, 300)}`);
    }
    // Backup reconcile of associations/line-items — uses the already-fetched card (no extra read).
    const assocCard = byId[String(rec.id)];
    if (spec.associations && assocCard && budget.left > 0) {
      try { await syncAssociations(env, spec, rec, assocCard, ctx, opts, budget); }
      catch (e) { console.log(`assoc error ${spec.object}/${rec.id}: ${String(e).slice(0, 200)}`); }
    }
  }

  if (spec.createFromMonday) {
    const emailCol = spec.fields.find(f => f.hs === "email")?.col;
    for (const item of items) {
      if (budget.left <= 0) break;
      if (colText(item, spec.idCol)) continue;                       // already linked to HubSpot
      if ((Date.parse(item.created_at) || 0) <= createCutoffFor(spec)) continue; // pre-go-live: leave orphans alone
      try {
        // The sweep carries no edit, so createFromMonday hands nothing back to replay for it. (A dead
        // creator's leftovers only exist on column-level specs, and every one of those is
        // skipFullReconcile, so runAll never sweeps them.)
        await createFromMonday(env, spec, ctx, opts, budget, item, emailCol, stats, { kind: "sweep" });
      } catch (e) {
        stats.errors++;
        console.log(`error create-from-monday ${spec.object} item ${item.id}: ${String(e).slice(0, 300)}`);
        if (String(e).includes("WRITEBACK_FAILED")) break; // stop creating this run — avoid dup cascade
      }
    }
  }

  console.log(`${spec.object} board ${spec.boardId}: ${JSON.stringify(stats)}`);
  return stats;
}

export async function runAll(env: Env, opts: RunOpts, only?: string): Promise<Record<string, Stats>> {
  const ctx = await buildCtx(env);
  const budget: Budget = { left: opts.maxWrites };
  const out: Record<string, Stats> = {};
  for (const spec of specsFor(env)) {
    if (spec.skipFullReconcile) continue;   // e.g. companies: 25k can't be search-swept; incremental+webhooks cover it
    if (only && spec.object !== only) continue;
    const key = `${spec.object}:${spec.boardId}`;
    try {
      out[key] = await syncSpec(env, spec, ctx, opts, budget);
    } catch (e) {
      console.log(`spec ${key} failed: ${String(e).slice(0, 300)}`);
      out[key] = { ...emptyStats(), errors: 1 };
    }
  }
  return out;
}

// ------------------------- webhook fast path (single record) -------------------------

// The context (owners, labels, monday users) rarely changes. Cache it in the isolate so each webhook
// doesn't re-fetch it — keeps a webhook invocation to just a few subrequests.
let cachedCtx: Ctx | null = null;
let cachedCtxAt = 0;
export async function getCtxCached(env: Env, ttlMs = 60_000): Promise<Ctx> {
  if (cachedCtx && Date.now() - cachedCtxAt < ttlMs) return cachedCtx;
  cachedCtx = await buildCtx(env);
  cachedCtxAt = Date.now();
  return cachedCtx;
}
/** Test-only: drop the cached ctx, so a test that builds its own owner/user map cannot leak it into the
 *  next one through the 60 s TTL. */
export function resetCtxCache(): void { cachedCtx = null; cachedCtxAt = 0; }

/** Structured single-line webhook log. */
function wlog(source: string, id: string, action: string, extra = ""): string {
  const line = `[webhook] source=${source} id=${id} action=${action}${extra ? ` ${extra}` : ""}`;
  console.log(line);
  return line;
}
function actionOf(s: Stats): string {
  if (s.createdInHubspot) return "created-hubspot";
  if (s.adopted) return "adopted-hubspot";
  if (s.created) return "created-monday";
  if (s.toHubspot) return "updated-hubspot";
  if (s.toMonday) return "updated-monday";
  if (s.inSync) return "skipped-in-sync";
  if (s.errors) return "error";
  return "skipped";
}

/** Which deal board a HubSpot deal belongs to (or null if out of scope). */
/**
 * DOES THIS DEPLOYMENT ROUTE DEALS ACROSS SEVERAL BOARDS BY PIPELINE?
 *
 * Only Work Management does. `syncHubspotDeal` exists for that shape: `specForDeal` picks a board from
 * the deal's pipeline and `findLinkedDealItem` dedups across `DEAL_SPECS`. The CRM deployment has ONE
 * deals board (5028000494, `groupBy.singleGroup`, `includeAll`), so its deals belong on the ordinary
 * single-board path that contacts, companies and line items already use.
 *
 * THIS REPLACES A PREMISE THAT SILENTLY EXPIRED. Three call sites asserted, in comments, that
 * `specByObject(env, "deals")` is undefined on the CRM deployment — true when they were written, false
 * since CRM_DEALS joined CRM_SPECS. Every one of them therefore let a CRM deal through a guard designed
 * to stop it and on into the WM path, which reads `propertiesForSpec(DEALS)` and writes board
 * 5029480547 — the LIVE Work-Management board this deployment must never touch. The delete path was the
 * sharp end: a HubSpot deal deletion arriving here would have deleted a WM card.
 *
 * Latent only because nothing currently subscribes deal events to this Worker. Adding one — which the
 * Lark work and monday-form deal creation both require — would have made it real.
 *
 * Compared by BOARD ID, not by reference: `specsFor` returns copies of CRM specs when CRM_CUTOVER_AT is
 * set, so identity is not a safe discriminator even though it happens to hold for WM today.
 */
/**
 * The go-live line for THIS spec: cards older than it never create a HubSpot record.
 *
 * Falls back to the Work-Management constant only for specs that declare nothing — the CRM specs are
 * given `createCutoffMs` by `specsFor`, and it fails closed to Infinity when the environment does not
 * name a go-live timestamp. See ObjectSpec.createCutoffMs for why that matters on the Accounts board.
 */
function createCutoffFor(spec: ObjectSpec): number {
  return spec.createCutoffMs ?? CREATE_CUTOFF_MS;
}

export function legacyDealRouting(env: { ENABLE_CRM?: string; CRM_CUTOVER_AT?: string }): boolean {
  const spec = specByObject(env, "deals");
  return !!spec && DEAL_SPECS.some(s => s.boardId === spec.boardId);
}

export function specForDeal(deal: { properties: Record<string, string | null> }): ObjectSpec | null {
  // One shared board: any Sales-Pipeline deal (all sales users, all dates). A deal with no sales_user
  // still routes here — it just lands in the Unassigned group (see targetGroup / noSalesUserGroup).
  return deal.properties.pipeline === "default" ? DEALS : null;
}

/** Duplicate prevention: search every deal board for an existing card with this HubSpot Deal ID. */
async function findLinkedDealItem(env: Env, dealId: string):
    Promise<{ spec: ObjectSpec; item: MondayItem } | null> {
  for (const spec of DEAL_SPECS) {
    const items = await findItemByColumn(env, spec.boardId, spec.idCol, dealId);
    if (items.length) return { spec, item: items[0] };
  }
  // Same eventual-consistency guard as contacts/companies: a card whose HubSpot ID was stamped moments ago
  // (createFromMonday) may not be indexed yet, and HubSpot's deal.creation webhook lands right about then —
  // without this the reconcile would treat it as unlinked and create a SECOND deal card.
  for (const spec of DEAL_SPECS) {
    const known = await lookupCard(env, spec.boardId, dealId);
    if (known) {
      const item = await getItem(env, known);
      if (item) { console.log(`deals/${dealId} card ${known} resolved via registry (column search not indexed yet)`); return { spec, item }; }
    }
  }
  return null;
}

/** HubSpot deal changed -> reconcile the one matching monday card (create / update / move). */
export async function syncHubspotDeal(env: Env, dealId: string, opts: RunOpts, budget: Budget): Promise<string> {
  const ctx = await getCtxCached(env);
  const deal = await getRecord(env, "deals", dealId, propertiesForSpec(DEALS));
  if (!deal) return wlog("hubspot", dealId, "skipped", 'reason="deal not found (deleted/archived)"');
  const target = specForDeal(deal);
  const linked = await findLinkedDealItem(env, dealId); // dedup across all deal boards
  const stats = emptyStats();

  if (linked) {
    if (target && target.boardId === linked.spec.boardId) {
      await reconcileRecord(env, linked.spec, ctx, opts, budget, deal, linked.item, stats); // update-in-place, never duplicate
      await runAssociations(env, linked.spec, deal, ctx, opts, budget);
      return wlog("hubspot", dealId, actionOf(stats), `board=${linked.spec.boardId} item=${linked.item.id}`);
    }
    // reassigned to a different board (or left scope): remove the old card, recreate on the new board
    await deleteItem(env, linked.item.id, opts); budget.left--;
    if (target) {
      await reconcileRecord(env, target, ctx, opts, budget, deal, undefined, stats);
      await runAssociations(env, target, deal, ctx, opts, budget);
      return wlog("hubspot", dealId, "moved", `from=${linked.spec.boardId} to=${target.boardId}`);
    }
    return wlog("hubspot", dealId, "removed", `reason="deal left mapped boards" was=${linked.spec.boardId}`);
  }

  if (target) {
    await reconcileRecord(env, target, ctx, opts, budget, deal, undefined, stats); // no card anywhere -> create one
    await runAssociations(env, target, deal, ctx, opts, budget);
    return wlog("hubspot", dealId, actionOf(stats), `board=${target.boardId}`);
  }
  return wlog("hubspot", dealId, "skipped", 'reason="deal not in scope (pipeline/owner/created-before-cutoff)"');
}

/** After a HubSpot->monday reconcile, refresh the record's associations onto its (now-existing) card.
 * One-directional + guarded so association failures (e.g. line_items 403) never break the main sync. */
async function runAssociations(env: Env, spec: ObjectSpec, rec: HsRecord, ctx: Ctx, opts: RunOpts,
    budget: Budget): Promise<void> {
  if (!spec.associations || budget.left <= 0) return;
  try {
    // This runs right after a card may have just been created, so the eventually-consistent column search
    // will usually MISS it — which silently left brand-new cards with no relation links and no line-item
    // subitems until the next full reconcile. Fall back to the registry.
    let card: MondayItem | undefined = (await findItemByColumn(env, spec.boardId, spec.idCol, rec.id))[0];
    if (!card) {
      const known = await lookupCard(env, spec.boardId, rec.id);
      if (known) card = (await getItem(env, known)) ?? undefined;
    }
    if (card) await syncAssociations(env, spec, rec, card, ctx, opts, budget);
  } catch (e) {
    console.log(`assoc error ${spec.object}/${rec.id}: ${String(e).slice(0, 200)}`);
  }
}

/** True when a contact/company is in the board's own sync scope (ANY sales_user AND created >= cutoff).
 * Mirrors the CONTACTS_MYLA / COMPANIES_MYLA search filters (sales_user HAS_PROPERTY + createdate) for
 * the single-record webhook path. NB: associated records that fall outside this are still created on
 * demand by the association pass (ensureTargetCard) so their deal/contact/company links resolve. */
export function recInScope(spec: ObjectSpec, rec: { properties: Record<string, string | null> }): boolean {
  if (spec.includeAll) return true;
  if (spec.scopeAlsoLinkedProp && (rec.properties[spec.scopeAlsoLinkedProp] ?? "").toString().trim()) return true;
  if (!(rec.properties.sales_user ?? "").trim()) return false;
  return (Date.parse(rec.properties.createdate ?? "") || 0) >= CREATED_AFTER_MS;
}

/** HubSpot contact/company changed -> reconcile the one matching card on its single board.
 * (Deals use syncHubspotDeal, which also routes across the Myla/Unassigned boards.) */
export async function syncHubspotRecord(env: Env, spec: ObjectSpec, id: string, opts: RunOpts,
    budget: Budget, ignoreItemId?: string, forceForward = false): Promise<string> {
  const ctx = await getCtxCached(env);
  // Always fetch sales_user + createdate so we can scope-check even when they aren't mapped fields.
  const props = [...new Set([...propertiesForSpec(spec), "sales_user", "createdate",
    ...(spec.scopeAlsoLinkedProp ? [spec.scopeAlsoLinkedProp] : [])])];
  const rec = await getRecord(env, spec.object, id, props);
  if (!rec) return wlog(spec.object, id, "skipped", 'reason="record not found (deleted/archived)"');
  // Scope-check BEFORE the board lookup: contact/company webhooks fire portal-wide, so a non-Myla
  // record must cost only this one fetch (no extra monday subrequest) before we drop it.
  if (!recInScope(spec, rec)) return wlog(spec.object, id, "skipped", 'reason="out of scope (sales_user/created-before-cutoff)"');
  // The id-column search is eventually consistent. When the app's create endpoint has just made this
  // record (and its card), HubSpot's creation webhook lands here within seconds — before monday has
  // indexed the card — and creating again would produce a DUPLICATE card. Fall back to the registry.
  let existing: MondayItem | undefined = (await findItemByColumn(env, spec.boardId, spec.idCol, id))[0];
  // A card the CALLER already knows is dead must never be adopted from this search. The search index is
  // eventually consistent, so a card deleted a second ago is still returned — and reconcileRecord would
  // then happily issue change_multiple_column_values against a dead item id, which errors out of the
  // waitUntil with the registry already cleared and nothing scheduled to retry. Only the restore path
  // passes this, so every other caller keeps its single lookup and pays nothing.
  if (existing && ignoreItemId && String(existing.id) === String(ignoreItemId)) {
    console.log(`${spec.object}/${id} column search returned the just-deleted card ${ignoreItemId}`
      + ` — ignoring a stale index hit and creating instead`);
    existing = undefined;
  }
  if (!existing) {
    const known = await lookupCard(env, spec.boardId, id);
    if (known) {
      existing = (await getItem(env, known)) ?? undefined;
      if (existing) console.log(`${spec.object}/${id} card ${known} resolved via registry (column search not indexed yet)`);
    }
  }
  const stats = emptyStats();
  await reconcileRecord(env, spec, ctx, opts, budget, rec, existing, stats, false, false, undefined, forceForward);
  await runAssociations(env, spec, rec, ctx, opts, budget);
  return wlog(spec.object, id, actionOf(stats), `board=${spec.boardId}`);
}

/** Dispatch a HubSpot object event to the right sync path. */
/** Webhook event name -> spec object name. `line_item` joined 2026-09-21: Products & Services is a CRM
 *  BOARD, so a line-item change has its own card to reconcile, not just a parent deal to rebuild. */
export const SPEC_OBJECT_FOR_EVENT = {
  contact: "contacts", company: "companies", deal: "deals", line_item: "line_items",
} as const;
export type HsEventObject = keyof typeof SPEC_OBJECT_FOR_EVENT;

export async function syncHubspotObject(env: Env, objectType: HsEventObject,
    id: string, opts: RunOpts, budget: Budget, ignoreItemId?: string): Promise<string> {
  // Deals route by DEPLOYMENT, not by a constant: WM fans across pipeline boards, CRM has one board and
  // takes the ordinary path. See legacyDealRouting — the old comment here claimed specByObject returns
  // undefined for "deals" on CRM, which stopped being true when CRM_DEALS joined CRM_SPECS.
  if (objectType === "deal") {
    const dealSpec = specByObject(env, "deals");
    if (!dealSpec) return wlog("deals", id, "skipped", 'reason="deals not in scope for this deployment"');
    if (legacyDealRouting(env)) return syncHubspotDeal(env, id, opts, budget);
    return syncHubspotRecord(env, dealSpec, id, opts, budget, ignoreItemId);
  }
  // Contacts, companies and — on the CRM deployment — line items are all ordinary single-board specs.
  // A deployment that does not own the object resolves nothing and the event is a logged no-op, which
  // is what keeps the two Workers off each other's boards.
  const spec = specByObject(env, SPEC_OBJECT_FOR_EVENT[objectType]);
  if (!spec) return wlog(objectType, id, "skipped", 'reason="object not in scope for this deployment"');
  return syncHubspotRecord(env, spec, id, opts, budget, ignoreItemId);
}

/** A HubSpot record was DELETED -> delete the linked monday card. HubSpot is the source of truth,
 * so this only removes the follow-up card; it never deletes anything in HubSpot. No-op if no card
 * is linked. (We don't need to fetch the record — the delete event carries the id, and we find the
 * card by its HubSpot ID column.) */
export async function deleteHubspotObject(env: Env, objectType: HsEventObject,
    id: string, opts: RunOpts, budget: Budget): Promise<string> {
  // EXCLUSIVE routing, same as every other path. Hardcoding the WM specs here meant the CRM deployment
  // would look up a deleted HubSpot id on the WM board and DELETE THAT CARD — a cross-deployment write,
  // the precise failure exclusive routing exists to prevent. Found by the Task 11 matrix.
  const spec = specByObject(env, SPEC_OBJECT_FOR_EVENT[objectType]);
  if (!spec) return wlog(objectType, id, "skipped", 'reason="object not in scope for this deployment"');
  // The multi-board deal search belongs to WM ONLY. Reaching it from the CRM deployment would delete a
  // card on the live WM board — the deal-shaped instance of exactly the bug the note above describes.
  if (objectType === "deal" && legacyDealRouting(env)) {
    const linked = await findLinkedDealItem(env, id); // searches both deal boards
    if (!linked) return wlog("deals", id, "skipped", 'reason="deleted in HubSpot; no linked monday card"');
    await deleteItem(env, linked.item.id, opts); budget.left--;
    return wlog("deals", id, "deleted-monday", `board=${linked.spec.boardId} item=${linked.item.id}`);
  }
  const item = (await findItemByColumn(env, spec.boardId, spec.idCol, id))[0];
  if (!item) return wlog(spec.object, id, "skipped", 'reason="deleted in HubSpot; no linked monday card"');
  await deleteItem(env, item.id, opts); budget.left--;
  return wlog(spec.object, id, "deleted-monday", `board=${spec.boardId} item=${item.id}`);
}

/** Every-minute fast poll: push recently-CHANGED HubSpot records to monday (near-instant even without
 * HubSpot webhooks — deals, contacts, AND companies). Skips work when nothing changed. */
export async function runIncremental(env: Env, opts: RunOpts, windowMs = 180_000): Promise<string> {
  const since = Date.now() - windowMs;
  const budget: Budget = { left: opts.maxWrites };
  let changed = 0;

  // Deals: dedup ids across the two deal boards, route via the deal-aware path. WM ONLY — the CRM
  // deployment's single deals board is swept by the ordinary loop below instead. The previous condition
  // (`specByObject(env,"deals") ? ...`) was true on BOTH deployments once CRM_DEALS existed, so the CRM
  // Worker searched and wrote the WM board here while its own Deals board was never swept at all.
  const dealIds = new Set<string>();
  for (const spec of (legacyDealRouting(env) ? DEAL_SPECS : [])) {
    for (const id of await searchModifiedIds(env, spec, since)) dealIds.add(id);
  }
  for (const id of dealIds) {
    if (budget.left <= 0) break;
    changed++;
    try { await syncHubspotDeal(env, id, opts, budget); }
    catch (e) { console.log(`incremental deal ${id} error: ${String(e).slice(0, 200)}`); }
  }

  // Contacts + companies + line items — one board each — and, on the CRM deployment, Deals too, since
  // its deals board is ordinary. The exclusion is now of the LEGACY path, not of the object.
  for (const spec of specsFor(env).filter(s => !(s.object === "deals" && legacyDealRouting(env)))) {
    for (const id of await searchModifiedIds(env, spec, since)) {
      if (budget.left <= 0) break;
      changed++;
      try { await syncHubspotRecord(env, spec, id, opts, budget); }
      catch (e) { console.log(`incremental ${spec.object} ${id} error: ${String(e).slice(0, 200)}`); }
    }
  }
  return changed ? `incremental: ${changed} changed record(s)` : "incremental: no changes";
}

/** monday card changed -> reconcile the one linked HubSpot deal (create / update). */
/**
 * @param selfOrigin  THIS EVENT WAS CAUSED BY OUR OWN TOKEN, not a person — see isIntegrationActor.
 *   Every monday -> HubSpot mutation is suppressed: no record creation, no reverse field patch, no
 *   reverse associations, no ownership claim. The forward direction still runs, because reconciling
 *   HubSpot's truth onto a card we just wrote is harmless and self-healing.
 *
 *   Without this, a bulk seed becomes a bulk WRITE-BACK. Measured during the historical import: 1,207
 *   HubSpot Companies created from our own echoes, one of which (fake.com) then accumulated 1,581
 *   contact associations. The cause is a race, not a logic error — createItem stamps the HubSpot ID,
 *   monday fires create_item within milliseconds, and the webhook's read of that column comes back
 *   empty, so the card looks monday-originated.
 *
 * @param actor  Who caused the event, as the webhook resolved it. Needed on its own because an event that
 *   names no column (item created, moved) carries no `edit`, so `edit.byAutomation` cannot say an
 *   automation made the row. Only the create's birth pass reads it. Absent (every non-webhook caller),
 *   `edit.byAutomation` decides, and without that the event is a person's: the column-level reverse
 *   path reads an absent `byAutomation` the same way.
 */
export async function syncMondayItem(env: Env, boardId: string, itemId: string, opts: RunOpts,
    budget: Budget, appSave = false, selfOrigin = false, edit?: MondayEdit, actor?: MondayActor): Promise<string> {
  // EXCLUSIVE routing: a board this deployment does not own resolves to undefined and the event is a
  // no-op. That is what stops the CRM Worker from becoming a second processor for the WM boards.
  const spec = specByBoard(env, boardId);
  if (!spec) return wlog("monday", itemId, "skipped", `reason="board ${boardId} not configured"`);
  const ctx = await getCtxCached(env);
  const item = await getItem(env, itemId);
  if (!item) return wlog("monday", itemId, "skipped", 'reason="item not found (deleted)"');
  const dealId = colText(item, spec.idCol);
  const stats = emptyStats();

  /** The linked path: update that HubSpot record, never create a duplicate. Also where an edit lands that
   *  arrived after its card's create but before monday served the id (see replayOnLinked), with `link`
   *  saying which Sync State that lagging read could not show (see withBaseline). */
  // Its parameters deliberately keep the names the linked branch has always used (they shadow the
  // outer ones): the calls below are pinned verbatim by self-origin-guard.test.ts.
  const syncLinked = async (item: MondayItem, recordId: string, edit: MondayEdit | undefined,
      stats: Stats, link?: AlreadyLinked): Promise<string> => {
    const deal = await getRecord(env, spec.object, recordId, propertiesForSpec(spec));
    if (!deal) return wlog("monday", itemId, "skipped", `reason="linked ${spec.object} ${recordId} not in HubSpot"`);
    if (link) item = withBaseline(item, spec, link);
    // `selfOrigin` forces the FORWARD direction: reconcileRecord's reverse path is gated on the same
    // flag, so our own echo cannot push a value back into HubSpot. What a stopped creator left, when the
    // 'have' read took it, is settled by the same reconcile (settleTakeover).
    if (link?.takeover)
      await reconcileRecord(env, spec, ctx, opts, budget, deal, item, stats, appSave, selfOrigin, edit, false, link.takeover);
    else await reconcileRecord(env, spec, ctx, opts, budget, deal, item, stats, appSave, selfOrigin, edit);
    // Reverse Connect-Boards links -> HubSpot associations (monday-edit path only). On a column-level
    // spec it pushes exactly what the person added or removed, and snaps the cell back on a refusal;
    // record-level specs (WM) and the drawer save keep the additive whole-cell pass. See
    // reverseAssociations. Skipped entirely for our own echoes: this is the path that gave fake.com
    // 1,581 associations.
    //
    // On a column-level spec it runs ONLY when the person edited a relation column. Running it on every
    // edit is the association-shaped version of the stale-overwrite: a relation cell that lagged behind
    // HubSpot would be re-asserted by an unrelated Job Title edit.
    const relationEdited = !spec.columnLevelReverse || appSave
      || (edit?.cols ?? []).some(c => (spec.associations ?? []).some(a => a.relationCol === c));
    if (budget.left > 0 && !selfOrigin && relationEdited)
      await reverseAssociations(env, spec, deal, item, opts, budget,
        spec.columnLevelReverse && !appSave
          // `linked`/`unlinked` are the person's own before/after diff; `largestEvent` lets the caps
          // judge one click at a time; `byAutomation` suppresses the push entirely; `actor` is for logs.
          // No ctx on purpose: a snap-back never creates cards (see snapBackRelation).
          ? { onlyCols: new Set(edit?.cols ?? []), basis: edit?.byAutomation ? "cutover" : "human-edit",
              unlinked: edit?.unlinked, linked: edit?.linked, largestEvent: edit?.largestEvent,
              byAutomation: edit?.byAutomation, actor: edit?.actor, ...(edit?.retry ? { retry: true } : {}) }
          : undefined);
    else if (selfOrigin) console.log(`[webhook] source=monday item=${itemId} action=reverse-assoc-skipped`
      + ` reason="event caused by our own token, not a person"`);
    // Reverse monday subitems -> HubSpot line items (id-keyed; only when the write scope is enabled).
    const liSub = spec.associations?.find(a => a.subitems)?.subitems;
    if (env.LINE_ITEM_WRITE === "true" && liSub && budget.left > 0)
      await reverseLineItems(env, liSub, item, deal.id, opts, budget);
    return wlog("monday", itemId, actionOf(stats), `board=${boardId} deal=${recordId}`);
  };

  if (dealId) return syncLinked(item, dealId, edit, stats);

  // new card -> create a HubSpot record (guards match the cron's createFromMonday path)
  //
  // THE PROVENANCE GATE, and it comes FIRST because it is the one that was missing. A card with no
  // HubSpot ID in this read is not proof a person made one: our own createItem stamps that column, and
  // the create_item webhook can arrive before monday serves it back. 1,207 HubSpot Companies were
  // created from exactly that misreading during the historical import.
  // (Refused below, but NOTED first when this row's record is being made or its create window is still
  // open: what our token wrote here must not be sent later as the edit of a person whose queued column it
  // overwrote -- that replay reads the card, not the event. A note writes nothing outside the row.)
  if (selfOrigin) await noteOwnEdit(env, spec, itemId, edit, actor);
  if (selfOrigin)
    return wlog("monday", itemId, "skipped",
      'reason="no HubSpot id yet, but this event came from our own token — refusing to create"');
  if (!spec.createFromMonday) return wlog("monday", itemId, "skipped", 'reason="board not create-enabled"');
  if ((Date.parse(item.created_at) || 0) <= createCutoffFor(spec))
    return wlog("monday", itemId, "skipped", 'reason="card created before go-live cutoff"');
  const emailCol = spec.fields.find(f => f.hs === "email")?.col;
  // Who started this create, for the birth pass (see CreateTrigger). The create itself is decided exactly
  // as before: an automation's event still creates, only its birth links are suppressed.
  const trigger: CreateTrigger = {
    kind: actor?.byAutomation || edit?.byAutomation ? "automation" : "person",
    actor: actor?.id || edit?.actor,
  };
  let linked: AlreadyLinked | undefined;
  try {
    linked = await createFromMonday(env, spec, ctx, opts, budget, item, emailCol, stats, trigger, edit);
  } catch (e) {
    return wlog("monday", itemId, "error", `reason="${String(e).slice(0, 160)}"`);
  }
  const outcome = wlog("monday", itemId, actionOf(stats), `board=${boardId}`);
  if (!linked) return outcome;
  // THE 'have' RACE (and an adoption's queue): the row's record already exists, and a person's edit of
  // it is still to be applied -- or a stopped creator's window to be settled. Re-stamped above; now
  // applied as the edit of the linked card it is.
  console.log(`[webhook] source=monday id=${itemId} hubspot_id=${linked.recordId}`
    + ` cols=${linked.replay?.cols.join(",") || "-"}${linked.replay?.name ? " name" : ""}`
    + `${linked.takeover ? ` queued=${linked.takeover.entries.filter(e => !e.note).length}` : ""} action=replay-as-edit`
    + ` reason="${linked.why}"`);
  try {
    return await syncLinked(withColumn(linked.card ?? item, spec.idCol, linked.recordId), linked.recordId,
      linked.replay, emptyStats(), linked);
  } catch (e) {
    return wlog("monday", itemId, "error", `reason="${String(e).slice(0, 160)}"`);
  }
}
