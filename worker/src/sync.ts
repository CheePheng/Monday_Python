import type { Budget, Ctx, Env, MondayItem, ObjectSpec, RunOpts, Stats } from "./types";
import {
  ALL_SPECS, CREATE_CUTOFF_MS, CREATED_AFTER_MS, DEAL_SPECS, DEALS_MYLA, DEALS_UNASSIGNED,
  PORTAL_ID, SALES_USER_MYLA, SPEC_BY_BOARD,
} from "./config";
import { buildColumnValues, itemName } from "./mapping";
import { colText, indexByHubspotId } from "./dedup";
import { targetGroup } from "./routing";
import {
  buildCreateProperties, buildReversePatch, buildUpdatePayload, decideDirection, fieldDiffs,
} from "./reconcile";
import {
  createItem, deleteItem, findItemByColumn, getBoardItems, getItem, getUsersByEmail, moveItem,
  setColumns, updateItem,
} from "./monday";
import {
  createRecord, getDealStageLabels, getOwners, getPropertyOptions, getRecord, patchRecord,
  propertiesForSpec, searchAll, searchContactByEmail,
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

export async function buildCtx(env: Env): Promise<Ctx> {
  const [ownersById, mondayUsersByEmail, stage, dealtype, priority, vendor, leadStatus,
         industry, companyType, contactSource, contactVendor] = await Promise.all([
    getOwners(env),
    getUsersByEmail(env),
    getDealStageLabels(env),
    getPropertyOptions(env, "deals", "dealtype"),
    getPropertyOptions(env, "deals", "hs_priority"),
    getPropertyOptions(env, "deals", "vendorschang_shang_lai_yuan"),
    getPropertyOptions(env, "contacts", "hs_lead_status"),
    getPropertyOptions(env, "companies", "industry"),
    getPropertyOptions(env, "companies", "type"),
    getPropertyOptions(env, "contacts", "leadsource"),
    getPropertyOptions(env, "contacts", "manufacturer__c"),
  ]);
  // sales_user values are raw owner ids; label them with owner names.
  const salesUser: Record<string, string> = {};
  for (const [id, o] of Object.entries(ownersById)) if (o.name) salesUser[id] = o.name;
  return {
    labels: { stage, dealtype, priority, vendor, leadStatus, industry, companyType,
              contactSource, contactVendor, salesUser,
              pipeline: { default: "Sales Pipeline" } },
    ownersById, mondayUsersByEmail, portalId: PORTAL_ID,
  };
}

/** HubSpot -> monday for one record, plus monday-edit -> HubSpot when monday is the newer side. */
async function reconcileRecord(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> }, existing: MondayItem | undefined,
    stats: Stats): Promise<void> {
  const group = targetGroup(rec, spec);
  if (!group) { stats.skipped++; return; }
  const recModified = rec.properties[spec.modifiedProp] ?? "";

  if (!existing) {
    const cv = buildColumnValues(rec, spec, ctx);
    cv[spec.syncStateCol] = recModified;
    await createItem(env, spec.boardId, group, itemName(rec, spec), cv, opts);
    stats.created++; budget.left--;
    return;
  }

  const lastSynced = colText(existing, spec.syncStateCol);
  const diffs = fieldDiffs(rec, existing, spec, ctx);
  const dir = decideDirection(diffs, recModified, lastSynced);

  if (dir === "none") {
    stats.inSync++;
    if (lastSynced !== recModified) { // establish baseline so future monday edits win correctly
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: recModified }, opts);
      budget.left--; // count the bookkeeping write so a first-run backlog can't overrun the tick
    }
    return;
  }

  if (dir === "toHubspot") {
    const patch = buildReversePatch(diffs, existing, spec, ctx);
    if (Object.keys(patch).length > 0) {
      const newMod = await patchRecord(env, spec, rec.id, patch, opts);
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
  cv[spec.syncStateCol] = recModified;
  await updateItem(env, spec.boardId, existing.id, itemName(rec, spec), cv, opts);
  stats.toMonday++; budget.left--;
}

/** monday card with no HubSpot id (added after go-live) -> create/adopt a HubSpot record. */
async function createFromMonday(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts, budget: Budget,
    item: MondayItem, emailCol: string | undefined, stats: Stats): Promise<void> {
  if (spec.object === "contacts") {
    const email = emailCol ? colText(item, emailCol) : "";
    if (!email) { stats.skipped++; console.log(`contact card ${item.id} has no email — skip create`); return; }
    const adopt = await searchContactByEmail(env, email);
    if (adopt) { // link the card to the existing HubSpot contact instead of creating a duplicate
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: adopt.id, [spec.syncStateCol]: adopt.modified, ...linkValue(spec, ctx, adopt.id) }, opts);
      stats.adopted++; budget.left--;
      return;
    }
  }
  const props = buildCreateProperties(item, spec, ctx);
  const created = await createRecord(env, spec, props, opts);
  if (created) {
    // The write-back is idempotent -> retries hard (setColumns retries=3). If it still fails, the
    // HubSpot record exists but the card has no id and would re-create next tick: log the orphan and
    // signal the caller to STOP creating this run so the failure can't cascade into duplicates.
    try {
      await setColumns(env, spec.boardId, item.id,
        { [spec.idCol]: created.id, [spec.syncStateCol]: created.modified, ...linkValue(spec, ctx, created.id) }, opts);
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
  for (const spec of ALL_SPECS) {
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
  const p = deal.properties;
  if (p.pipeline !== "default") return null;                                  // only the Sales Pipeline
  if ((Date.parse(p.createdate ?? "") || 0) < CREATED_AFTER_MS) return null;   // new-only
  const su = p.sales_user;
  if (su && su === SALES_USER_MYLA) return DEALS_MYLA;
  if (!su) return DEALS_UNASSIGNED;
  return null;                                                                 // another (un-onboarded) owner
}

/** Duplicate prevention: search every deal board for an existing card with this HubSpot Deal ID. */
async function findLinkedDealItem(env: Env, dealId: string):
    Promise<{ spec: ObjectSpec; item: MondayItem } | null> {
  for (const spec of DEAL_SPECS) {
    const items = await findItemByColumn(env, spec.boardId, spec.idCol, dealId);
    if (items.length) return { spec, item: items[0] };
  }
  return null;
}

/** HubSpot deal changed -> reconcile the one matching monday card (create / update / move). */
export async function syncHubspotDeal(env: Env, dealId: string, opts: RunOpts, budget: Budget): Promise<string> {
  const ctx = await getCtxCached(env);
  const deal = await getRecord(env, "deals", dealId, propertiesForSpec(DEALS_MYLA));
  if (!deal) return wlog("hubspot", dealId, "skipped", 'reason="deal not found (deleted/archived)"');
  const target = specForDeal(deal);
  const linked = await findLinkedDealItem(env, dealId); // dedup across all deal boards
  const stats = emptyStats();

  if (linked) {
    if (target && target.boardId === linked.spec.boardId) {
      await reconcileRecord(env, linked.spec, ctx, opts, budget, deal, linked.item, stats); // update-in-place, never duplicate
      return wlog("hubspot", dealId, actionOf(stats), `board=${linked.spec.boardId} item=${linked.item.id}`);
    }
    // reassigned to a different board (or left scope): remove the old card, recreate on the new board
    await deleteItem(env, linked.item.id, opts); budget.left--;
    if (target) {
      await reconcileRecord(env, target, ctx, opts, budget, deal, undefined, stats);
      return wlog("hubspot", dealId, "moved", `from=${linked.spec.boardId} to=${target.boardId}`);
    }
    return wlog("hubspot", dealId, "removed", `reason="deal left mapped boards" was=${linked.spec.boardId}`);
  }

  if (target) {
    await reconcileRecord(env, target, ctx, opts, budget, deal, undefined, stats); // no card anywhere -> create one
    return wlog("hubspot", dealId, actionOf(stats), `board=${target.boardId}`);
  }
  return wlog("hubspot", dealId, "skipped", 'reason="deal not in scope (pipeline/owner/created-before-cutoff)"');
}

/** monday card changed -> reconcile the one linked HubSpot deal (create / update). */
export async function syncMondayItem(env: Env, boardId: string, itemId: string, opts: RunOpts,
    budget: Budget): Promise<string> {
  const spec = SPEC_BY_BOARD[boardId];
  if (!spec) return wlog("monday", itemId, "skipped", `reason="board ${boardId} not configured"`);
  const ctx = await getCtxCached(env);
  const item = await getItem(env, itemId);
  if (!item) return wlog("monday", itemId, "skipped", 'reason="item not found (deleted)"');
  const dealId = colText(item, spec.idCol);
  const stats = emptyStats();

  if (dealId) { // already linked -> update that HubSpot record, never create a duplicate
    const deal = await getRecord(env, spec.object, dealId, propertiesForSpec(spec));
    if (!deal) return wlog("monday", itemId, "skipped", `reason="linked ${spec.object} ${dealId} not in HubSpot"`);
    await reconcileRecord(env, spec, ctx, opts, budget, deal, item, stats);
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
