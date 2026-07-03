import type { Ctx, Env, ObjectSpec, RunOpts, Stats } from "./types";
import { ALL_SPECS, PORTAL_ID } from "./config";
import { buildColumnValues, itemName } from "./mapping";
import { indexByHubspotId } from "./dedup";
import { targetGroup } from "./routing";
import { decideDirection, fieldDiffs, buildReversePatch } from "./reconcile";
import { createItem, getBoardItems, getUsersByEmail, moveItem, updateItem } from "./monday";
import { getOwners, getPropertyOptions, patchRecord, searchAll } from "./hubspot";

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

export async function syncSpec(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts): Promise<Stats> {
  const stats: Stats = { processed: 0, created: 0, toMonday: 0, toHubspot: 0, inSync: 0, skipped: 0, errors: 0 };
  const [records, items] = await Promise.all([searchAll(env, spec), getBoardItems(env, spec.boardId)]);
  const byId = indexByHubspotId(items, spec.idCol);
  let writes = 0;

  for (const rec of records) {
    stats.processed++;
    if (writes >= opts.maxWrites) { stats.skipped++; continue; }
    try {
      const group = targetGroup(rec, spec);
      if (!group) { stats.skipped++; continue; }
      const existing = byId[String(rec.id)];

      if (!existing) {
        await createItem(env, spec.boardId, group, itemName(rec, spec), buildColumnValues(rec, spec, ctx), opts);
        stats.created++; writes++;
        continue;
      }

      const diffs = fieldDiffs(rec, existing, spec, ctx);
      const dir = decideDirection(diffs, rec.properties[spec.modifiedProp], existing.updated_at);
      if (dir === "none") { stats.inSync++; continue; }

      if (dir === "toHubspot") {
        const patch = buildReversePatch(diffs, existing, spec, ctx);
        if (Object.keys(patch).length > 0) {
          await patchRecord(env, spec, rec.id, patch, opts);
          stats.toHubspot++; writes++;
          continue;
        }
        // nothing reversible differs -> fall through to forward write
      }

      await updateItem(env, spec.boardId, existing.id, itemName(rec, spec), buildColumnValues(rec, spec, ctx), opts);
      if (diffs.some(d => d.kind === "group")) await moveItem(env, spec.boardId, existing.id, group, opts);
      stats.toMonday++; writes++;
    } catch (e) {
      stats.errors++;
      console.log(`error ${spec.object}/${rec.id}: ${String(e).slice(0, 300)}`);
    }
  }
  console.log(`${spec.object} board ${spec.boardId}: ${JSON.stringify(stats)}`);
  return stats;
}

export async function runAll(env: Env, opts: RunOpts, only?: string): Promise<Record<string, Stats>> {
  const ctx = await buildCtx(env);
  const out: Record<string, Stats> = {};
  for (const spec of ALL_SPECS) {
    if (only && spec.object !== only) continue;
    out[`${spec.object}:${spec.boardId}`] = await syncSpec(env, spec, ctx, opts);
  }
  return out;
}
