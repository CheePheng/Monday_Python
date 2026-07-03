import type { Budget, Ctx, Env, MondayItem, ObjectSpec, RunOpts, Stats } from "./types";
import { ALL_SPECS, CREATE_CUTOFF_MS, PORTAL_ID } from "./config";
import { buildColumnValues, itemName } from "./mapping";
import { colText, indexByHubspotId } from "./dedup";
import { targetGroup } from "./routing";
import {
  buildCreateProperties, buildReversePatch, buildUpdatePayload, decideDirection, fieldDiffs,
} from "./reconcile";
import {
  createItem, getBoardItems, getUsersByEmail, moveItem, setColumns, updateItem,
} from "./monday";
import {
  createRecord, getOwners, getPropertyOptions, patchRecord, searchAll, searchContactByEmail,
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
    getPropertyOptions(env, "deals", "dealstage"),
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
    if (lastSynced !== recModified) // establish baseline so future monday edits win correctly
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: recModified }, opts);
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

  const cv = buildUpdatePayload(diffs, rec, spec, ctx);
  cv[spec.syncStateCol] = recModified;
  await updateItem(env, spec.boardId, existing.id, itemName(rec, spec), cv, opts);
  if (diffs.some(d => d.kind === "group")) await moveItem(env, spec.boardId, existing.id, group, opts);
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
  if (created)
    await setColumns(env, spec.boardId, item.id,
      { [spec.idCol]: created.id, [spec.syncStateCol]: created.modified, ...linkValue(spec, ctx, created.id) }, opts);
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
