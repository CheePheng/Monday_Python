import type { Budget, Ctx, Env, HsRecord, LabelDict, MondayItem, ObjectSpec, RunOpts, Stats, WriteAuth } from "./types";
import { reverseAssociations, reverseLineItems, syncAssociations } from "./associations";
import {
  CREATE_CUTOFF_MS, CREATED_AFTER_MS, DEAL_SPECS, DEALS, PORTAL_ID,
  specByBoard, specByObject, specsFor,
} from "./config";
import { buildColumnValues, itemName } from "./mapping";
import { colText, indexByHubspotId } from "./dedup";
import { lookupCard, finishCard, claimHubspotForItem, finishHubspotForItem, forgetHubspotForItem } from "./card-registry";
import { ensureCardForRecord } from "./ensure-card";
import { adoptionKey } from "./adopt";
import { authorizeCreate, authorizeWrite, canClaimCrmOwnership, withBirthOwnership } from "./ownership";
import { targetGroup } from "./routing";
import {
  buildCreateProperties, buildReversePatch, buildUpdatePayload, decideDirection, fieldDiffs,
  reverseFieldValue, type Diff,
} from "./reconcile";
import {
  createItem, deleteItem, findItemByColumn, getBoardItems, getItem, getUsersByEmail, moveItem,
  setColumns, updateItem,
} from "./monday";
import {
  claimOwnership, createRecord, getDealStageLabels, getOwners, getPropertyOptions, getRecord, patchRecord, searchCompanyByDomain,
  propertiesForSpec, searchAll, searchContactByEmail, searchModifiedIds,
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

  // Reverse lookups for people-column reverse-sync: monday person id -> email -> HubSpot owner id.
  const mondayEmailByUserId: Record<string, string> = {};
  for (const [email, id] of Object.entries(mondayUsersByEmail)) mondayEmailByUserId[id] = email;
  const ownerIdByEmail: Record<string, string> = {};
  for (const [id, o] of Object.entries(ownersById)) if (o.email) ownerIdByEmail[o.email.toLowerCase()] = id;
  return { labels, ownersById, mondayUsersByEmail, mondayEmailByUserId, ownerIdByEmail, portalId: PORTAL_ID };
}

/**
 * CLAIM-THEN-WRITE, evaluated LAZILY at the moment a HubSpot business write is actually required.
 *
 * Called only once the caller knows it has a non-empty patch to send. That ordering is the whole point:
 * discovering a record, creating its monday card, or reconciling HubSpot -> monday must NEVER stamp
 * ownership. A new HubSpot Contact can flow into monday CRM and stay unstamped indefinitely; ownership is
 * claimed the first time CRM needs to write BACK, and not a moment earlier.
 *
 * Returns undefined for specs without ownership, which is exactly what the legacy WM path passes today.
 */
async function ensureHubspotWriteAuth(env: Env, spec: ObjectSpec, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> },
    opts: RunOpts): Promise<WriteAuth | undefined> {
  const o = spec.ownership;
  if (!o) return undefined;                    // legacy WM behaviour, byte-for-byte
  const hsRec = rec as HsRecord;

  // Eligibility is re-proven inside claimOwnership too; this is not a substitute for that. It exists so
  // an INELIGIBLE record never even reaches the claim call, keeping the refusal a quiet log rather than
  // a thrown OwnershipError on the normal path.
  if (canClaimCrmOwnership(hsRec, o)) {
    const mod = await claimOwnership(env, spec, hsRec, opts);
    budget.left--;
    if (mod === null) {
      // Dry-run, or writeHubspot disabled (Phase B). NOTHING was written, so the record is still
      // unstamped and must stay that way — stamping locally here would manufacture an "allowed" auth for
      // a record this Worker does not own, and every log line downstream would then be a lie.
      console.log(`ownership object=${spec.object} id=${rec.id} action=claim-suppressed reason="dry-run or writes disabled"`);
    } else {
      // VERIFIED TRANSITION, not an assumption: claimOwnership throws on any HubSpot error and returns the
      // new modified timestamp only on success, and claimPatch is type-constrained to exactly
      // { sync_owner: <owner> }. So "we wrote this one property and HubSpot accepted it" is a confirmed
      // fact. Reflecting it locally is deliberately preferred over a re-fetch: a re-read that lagged
      // behind its own write would refuse the business patch we just earned the right to make, and the
      // next tick would re-enter and re-claim. The window is one statement wide with no interleaved await.
      rec.properties[o.prop] = o.owner;
      rec.properties[spec.modifiedProp] = mod;
      console.log(`ownership object=${spec.object} id=${rec.id} action=claimed owner=${o.owner}`);
    }
  }

  const auth = authorizeWrite(hsRec, o);
  if (!auth.allowed)
    console.log(`ownership object=${spec.object} id=${rec.id} action=write-refused reason="${auth.reason}"`);
  return auth;
}

/** HubSpot -> monday for one record, plus monday-edit -> HubSpot when monday is the newer side. */
async function reconcileRecord(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem | undefined,
    stats: Stats, appSave = false): Promise<void> {
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

  await maintainShared(env, spec, rec, existing, opts, budget); // toggle the Shared team on sales_user change

  const lastSynced = colText(existing, spec.syncStateCol);
  // APP SAVE = INTENT. The rep just edited this card in a drawer, so monday wins and an empty HubSpot
  // field is fillable. Two concrete failures this prevents:
  //  - the drawer's own HubSpot association writes run BEFORE this sync, bumping the record's
  //    lastmodifieddate past the card's Sync State, which flipped newer-wins to `toMonday` and REVERTED
  //    the very edits being saved (drawer still reported success);
  //  - a field HubSpot has never held produced no diff at all, so the edit silently never left monday.
  const diffs = fieldDiffs(rec, existing, spec, ctx, appSave);
  const dir = appSave && diffs.length ? "toHubspot" : decideDirection(diffs, recModified, lastSynced);

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
        // Refused (wm-owned, parked, historical, or a claim that could not be made). Leave HubSpot
        // alone and do NOT stamp the sync state — the next tick must re-evaluate, not treat this as done.
        stats.skipped++;
        return;
      }
      const filled = diffs.filter(d => d.backfill && d.f && patch[d.f.hs] !== undefined);
      const newMod = await patchRecord(env, spec, rec.id, patch, opts, auth);
      // Audit trail for the controlled backfill (a failed patch throws and is logged by the caller).
      for (const d of filled)
        console.log(`[backfill] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} field=${d.f!.hs} previous="" value="${patch[d.f!.hs]}" result=${newMod === null ? "dry-run" : "written"}`);
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: newMod ?? recModified }, opts);
      stats.toHubspot++; budget.left--;
      return;
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
  if (!INDEPENDENT_BACKFILL_OBJECTS.has(spec.object)) return null;
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
    newMod = await patchRecord(env, spec, rec.id, patch, opts, auth); budget.left--;
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
async function createFromMonday(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    item: MondayItem, emailCol: string | undefined, stats: Stats): Promise<void> {
  // Cross-isolate guard. monday fires create_pulse AND change_column_value for one new row; those land in
  // different isolates where `coalesce` (per-isolate) can't see each other, so both used to reach here and
  // each created its own HubSpot record — leaving one orphan that the sync then carded separately.
  const claim = await claimHubspotForItem(env, spec.boardId, item.id);
  if (claim.status === "creating") {
    stats.skipped++;
    console.log(`${spec.object} card ${item.id} create already in flight — skipping (would duplicate)`);
    return;
  }
  if (claim.status === "have") {
    // A previous attempt created the record but its id write-back failed. Re-stamp instead of creating again.
    await setColumns(env, spec.boardId, item.id,
      { [spec.idCol]: claim.itemId, ...linkValue(spec, ctx, claim.itemId) }, opts);
    stats.adopted++; budget.left--;
    console.log(`${spec.object} card ${item.id} re-stamped with ${claim.itemId} (earlier write-back had failed)`);
    return;
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
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: adopt.id, [spec.syncStateCol]: adopt.modified, ...linkValue(spec, ctx, adopt.id) }, opts);
      await finishHubspotForItem(env, spec.boardId, item.id, adopt.id);
      stats.adopted++; budget.left--;
      console.log(`${spec.object} card ${item.id} action=adopted hubspot_id=${adopt.id} by=${spec.adoptBy.kind}`);
      return;
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
  let created: { id: string; modified: string } | null;
  try {
    created = await createRecord(env, spec, props, opts,
      spec.ownership ? authorizeCreate(spec.ownership) : undefined);
  } catch (e) {
    await forgetHubspotForItem(env, spec.boardId, item.id); // release so a later pass may retry
    throw e;
  }
  if (created) {
    // Record the pairing BEFORE the write-back: if the write-back fails, the next pass re-stamps from here
    // instead of creating a second HubSpot record.
    await finishHubspotForItem(env, spec.boardId, item.id, created.id);
    // The write-back is idempotent -> retries hard (setColumns retries=3). If it still fails, the
    // HubSpot record exists but the card has no id and would re-create next tick: log the orphan and
    // signal the caller to STOP creating this run so the failure can't cascade into duplicates.
    try {
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: created.id, [spec.syncStateCol]: created.modified, ...linkValue(spec, ctx, created.id) }, opts);
      // Register the pairing NOW: HubSpot's creation webhook arrives within seconds, before monday has
      // indexed the id we just stamped, and would otherwise create a second card for this record.
      await finishCard(env, spec.boardId, created.id, item.id);
    } catch (e) {
      console.log(`CRITICAL: created ${spec.object}/${created.id} but id write-back to card ${item.id} failed — aborting ${spec.object} create loop: ${String(e).slice(0, 200)}`);
      throw new Error("WRITEBACK_FAILED");
    }
  }
  stats.createdInHubspot++; budget.left--;
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
      if ((Date.parse(item.created_at) || 0) <= CREATE_CUTOFF_MS) continue; // pre-go-live: leave orphans alone
      try {
        await createFromMonday(env, spec, ctx, opts, budget, item, emailCol, stats);
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
    budget: Budget): Promise<string> {
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
  if (!existing) {
    const known = await lookupCard(env, spec.boardId, id);
    if (known) {
      existing = (await getItem(env, known)) ?? undefined;
      if (existing) console.log(`${spec.object}/${id} card ${known} resolved via registry (column search not indexed yet)`);
    }
  }
  const stats = emptyStats();
  await reconcileRecord(env, spec, ctx, opts, budget, rec, existing, stats);
  await runAssociations(env, spec, rec, ctx, opts, budget);
  return wlog(spec.object, id, actionOf(stats), `board=${spec.boardId}`);
}

/** Dispatch a HubSpot object event to the right sync path. */
export async function syncHubspotObject(env: Env, objectType: "deal" | "contact" | "company",
    id: string, opts: RunOpts, budget: Budget): Promise<string> {
  // Deals exist ONLY in the WM deployment. specByObject returns undefined for "deals" on the CRM
  // deployment, so a stray deal webhook there is a logged no-op rather than an accidental Deal sync.
  if (objectType === "deal") {
    if (!specByObject(env, "deals")) return wlog("deals", id, "skipped", 'reason="deals not in scope for this deployment"');
    return syncHubspotDeal(env, id, opts, budget);
  }
  const spec = specByObject(env, objectType === "contact" ? "contacts" : "companies");
  if (!spec) return wlog(objectType, id, "skipped", 'reason="object not in scope for this deployment"');
  return syncHubspotRecord(env, spec, id, opts, budget);
}

/** A HubSpot record was DELETED -> delete the linked monday card. HubSpot is the source of truth,
 * so this only removes the follow-up card; it never deletes anything in HubSpot. No-op if no card
 * is linked. (We don't need to fetch the record — the delete event carries the id, and we find the
 * card by its HubSpot ID column.) */
export async function deleteHubspotObject(env: Env, objectType: "deal" | "contact" | "company",
    id: string, opts: RunOpts, budget: Budget): Promise<string> {
  if (objectType === "deal") {
    // Same guard as the contact/company branch below: findLinkedDealItem scans the WM DEAL boards, so
    // without this the CRM deployment would delete a WM deal card on a HubSpot deal deletion.
    if (!specByObject(env, "deals"))
      return wlog("deals", id, "skipped", 'reason="deals not in scope for this deployment"');
    const linked = await findLinkedDealItem(env, id); // searches both deal boards
    if (!linked) return wlog("deals", id, "skipped", 'reason="deleted in HubSpot; no linked monday card"');
    await deleteItem(env, linked.item.id, opts); budget.left--;
    return wlog("deals", id, "deleted-monday", `board=${linked.spec.boardId} item=${linked.item.id}`);
  }
  // EXCLUSIVE routing, same as every other path. Hardcoding the WM specs here meant the CRM deployment
  // would look up a deleted HubSpot id on the WM board and DELETE THAT CARD — a cross-deployment write,
  // the precise failure exclusive routing exists to prevent. Found by the Task 11 matrix.
  const spec = specByObject(env, objectType === "contact" ? "contacts" : "companies");
  if (!spec) return wlog(objectType, id, "skipped", 'reason="object not in scope for this deployment"');
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

  // Deals: dedup ids across the two deal boards, route via the deal-aware path. Empty on the CRM
  // deployment, whose specsFor() contains no deals spec at all.
  const dealIds = new Set<string>();
  for (const spec of (specByObject(env, "deals") ? DEAL_SPECS : [])) {
    for (const id of await searchModifiedIds(env, spec, since)) dealIds.add(id);
  }
  for (const id of dealIds) {
    if (budget.left <= 0) break;
    changed++;
    try { await syncHubspotDeal(env, id, opts, budget); }
    catch (e) { console.log(`incremental deal ${id} error: ${String(e).slice(0, 200)}`); }
  }

  // Contacts + companies: one board each.
  for (const spec of specsFor(env).filter(s => s.object !== "deals")) {
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
export async function syncMondayItem(env: Env, boardId: string, itemId: string, opts: RunOpts,
    budget: Budget, appSave = false): Promise<string> {
  // EXCLUSIVE routing: a board this deployment does not own resolves to undefined and the event is a
  // no-op. That is what stops the CRM Worker from becoming a second processor for the WM boards.
  const spec = specByBoard(env, boardId);
  if (!spec) return wlog("monday", itemId, "skipped", `reason="board ${boardId} not configured"`);
  const ctx = await getCtxCached(env);
  const item = await getItem(env, itemId);
  if (!item) return wlog("monday", itemId, "skipped", 'reason="item not found (deleted)"');
  const dealId = colText(item, spec.idCol);
  const stats = emptyStats();

  if (dealId) { // already linked -> update that HubSpot record, never create a duplicate
    const deal = await getRecord(env, spec.object, dealId, propertiesForSpec(spec));
    if (!deal) return wlog("monday", itemId, "skipped", `reason="linked ${spec.object} ${dealId} not in HubSpot"`);
    await reconcileRecord(env, spec, ctx, opts, budget, deal, item, stats, appSave);
    // Reverse Connect-Boards links -> HubSpot associations (monday-edit path only; additive/set-only).
    if (budget.left > 0) await reverseAssociations(env, spec, deal, item, opts, budget);
    // Reverse monday subitems -> HubSpot line items (id-keyed; only when the write scope is enabled).
    const liSub = spec.associations?.find(a => a.subitems)?.subitems;
    if (env.LINE_ITEM_WRITE === "true" && liSub && budget.left > 0)
      await reverseLineItems(env, liSub, item, deal.id, opts, budget);
    return wlog("monday", itemId, actionOf(stats), `board=${boardId} deal=${dealId}`);
  }

  // new card -> create a HubSpot record (guards match the cron's createFromMonday path)
  if (!spec.createFromMonday) return wlog("monday", itemId, "skipped", 'reason="board not create-enabled"');
  if ((Date.parse(item.created_at) || 0) <= CREATE_CUTOFF_MS)
    return wlog("monday", itemId, "skipped", 'reason="card created before go-live cutoff"');
  const emailCol = spec.fields.find(f => f.hs === "email")?.col;
  try {
    await createFromMonday(env, spec, ctx, opts, budget, item, emailCol, stats);
  } catch (e) {
    return wlog("monday", itemId, "error", `reason="${String(e).slice(0, 160)}"`);
  }
  return wlog("monday", itemId, actionOf(stats), `board=${boardId}`);
}
