import type { AssocSpec, Budget, Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts } from "./types";
import { getAssociatedIds, getRecordsByIds } from "./hubspot";
import { createSubitem, deleteItem, getSubitems, setColumns, updateItem } from "./monday";
import { formatValue } from "./mapping";
import { colText } from "./dedup";

const DEAL_BOARD = "5029480547"; // parent (deal) board; line-item Summary/Count/Total live here.

/** HubSpot -> monday association pass. One-directional: it reflects HubSpot associations onto the monday
 * item (name columns) and deal line items onto subitems. It NEVER writes HubSpot. Each association is
 * isolated so one failure (e.g. line_items 403 before the scope is added) doesn't block the others. */
export async function syncAssociations(env: Env, spec: ObjectSpec, rec: HsRecord, item: MondayItem,
    ctx: Ctx, opts: RunOpts, budget: Budget): Promise<void> {
  for (const a of spec.associations ?? []) {
    try {
      const ids = await getAssociatedIds(env, spec.object, rec.id, a.toObject);
      if (a.subitems) await syncLineItems(env, a, ids, item.id, ctx, opts, budget, spec.object, rec.id);
      else await syncNameColumn(env, spec, a, ids, rec, item, opts, budget);
    } catch (e) {
      console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} action=error reason="${String(e).slice(0, 140)}"`);
    }
  }
}

/** company/contact/deal associations -> comma-joined names in a parent text column (cleared when none). */
async function syncNameColumn(env: Env, spec: ObjectSpec, a: AssocSpec, ids: string[], rec: HsRecord,
    item: MondayItem, opts: RunOpts, budget: Budget): Promise<void> {
  const recs = await getRecordsByIds(env, a.toObject, ids, a.nameProps);
  const names = recs.map(r => a.nameProps.map(p => r.properties[p] ?? "").join(" ").trim())
    .filter(Boolean).join(", ");
  if (colText(item, a.col!) === names) {
    console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} count=${ids.length} action=skipped`);
    return;
  }
  if (opts.dryRun) { console.log(`DRY assoc ${spec.object}/${rec.id} ${a.toObject}='${names}'`); return; }
  await setColumns(env, spec.boardId, item.id, { [a.col!]: names }, opts); budget.left--;
  console.log(`source=hubspot object=${spec.object} id=${rec.id} association=${a.toObject} count=${ids.length} board=${spec.boardId} item=${item.id} action=${names ? "updated-monday" : "cleared-monday"}`);
}

/** deal line items -> monday SUBITEMS under the deal card. Create/update by HubSpot Line Item ID,
 * mark removed subitems "Removed" (or delete if no status column), rebuild the parent Summary/Count/Total.
 * HubSpot -> monday only. */
async function syncLineItems(env: Env, a: AssocSpec, ids: string[], parentId: string, ctx: Ctx,
    opts: RunOpts, budget: Budget, obj: string, recId: string): Promise<void> {
  const sub = a.subitems!;
  console.log(`source=hubspot object=${obj} id=${recId} association=line_items count=${ids.length} action=sync-start`);
  const props = [...new Set([...sub.fields.map(f => f.hs), ...a.nameProps, sub.totalProp, "quantity", "price"])];
  const lis = ids.length ? await getRecordsByIds(env, "line_items", ids, props) : [];
  const existing = await getSubitems(env, parentId);
  const byLi: Record<string, MondayItem> = {};
  for (const s of existing) { const k = colText(s, sub.idCol); if (k) byLi[k] = s; }

  const want = new Set<string>();
  let total = 0;
  const summary: string[] = [];
  for (const li of lis) {
    want.add(li.id);
    const name = a.nameProps.map(p => li.properties[p] ?? "").join(" ").trim() || `line_item ${li.id}`;
    total += Number(li.properties[sub.totalProp] ?? 0) || 0;
    summary.push(`${name} | Qty: ${li.properties["quantity"] ?? ""} | Unit Price: ${li.properties["price"] ?? ""}`);
    const cv: Record<string, unknown> = { [sub.idCol]: li.id };
    for (const f of sub.fields) { const v = formatValue(f, li.properties[f.hs], ctx); if (v != null) cv[f.col] = v; }
    if (opts.dryRun) { console.log(`DRY line_item ${li.id} on ${parentId}`); continue; }
    const cur = byLi[li.id];
    if (cur) {
      await updateItem(env, sub.boardId, cur.id, name, cv, opts); budget.left--;
      console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${li.id} monday_subitem_id=${cur.id} action=updated-subitem`);
    } else {
      const sid = await createSubitem(env, parentId, name, cv, opts); budget.left--;
      console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${li.id} monday_parent_item_id=${parentId} monday_subitem_id=${sid} action=created-subitem`);
    }
  }
  // Removed line items: mark the subitem Status = "Removed" (safest), or delete if no status column.
  for (const s of existing) {
    const k = colText(s, sub.idCol);
    if (!k || want.has(k) || opts.dryRun) continue;
    if (sub.statusCol) {
      if (colText(s, sub.statusCol) === "Removed") continue; // already marked
      await updateItem(env, sub.boardId, s.id, s.name, { [sub.statusCol]: { label: "Removed" } }, opts); budget.left--;
    } else {
      await deleteItem(env, s.id, opts); budget.left--;
    }
    console.log(`source=hubspot object=${obj} id=${recId} line_item_id=${k} monday_subitem_id=${s.id} action=removed-or-marked-inactive`);
  }
  if (!opts.dryRun) {
    await setColumns(env, DEAL_BOARD, parentId, {
      [sub.summaryCol]: { text: summary.join("\n") },  // long-text column needs { text }
      [sub.countCol]: String(lis.length), [sub.totalCol]: String(total),
    }, opts); budget.left--;
  }
  console.log(`source=hubspot object=${obj} id=${recId} association=line_items count=${lis.length} action=${lis.length ? "updated-subitems" : "no-line-items"}`);
}
