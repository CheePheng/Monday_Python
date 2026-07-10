import type { AssocSpec, Budget, Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts } from "./types";
import { getAssociatedIds, getRecordsByIds, propertiesForSpec } from "./hubspot";
import { createItem, createSubitem, deleteItem, findItemIdsByColumn, getLinkedItemIds, getSubitems, setColumns, updateItem } from "./monday";
import { SPEC_BY_OBJECT } from "./config";
import { buildColumnValues, formatValue, itemName } from "./mapping";
import { targetGroup } from "./routing";
import { colText } from "./dedup";

/** HubSpot -> monday association pass. One-directional: it reflects HubSpot associations onto the monday
 * item (name columns) and deal line items onto subitems. It NEVER writes HubSpot. Each association is
 * isolated so one failure (e.g. line_items 403 before the scope is added) doesn't block the others. */
export async function syncAssociations(env: Env, spec: ObjectSpec, rec: HsRecord, item: MondayItem,
    ctx: Ctx, opts: RunOpts, budget: Budget): Promise<void> {
  for (const a of spec.associations ?? []) {
    try {
      const ids = await getAssociatedIds(env, spec.object, rec.id, a.toObject);
      if (a.subitems) { await syncLineItems(env, a, ids, item.id, ctx, opts, budget, spec.object, rec.id); continue; }
      // A "Connect Boards" column links the actual cards; the text column (if kept) shows readable names.
      if (a.relationCol) await syncRelationColumn(env, spec, a, ids, item, ctx, opts, budget);
      if (a.col) await syncNameColumn(env, spec, a, ids, rec, item, opts, budget);
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

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

/** company/contact/deal associations -> a monday "Connect Boards" (board_relation) column that LINKS the
 * actual cards. Resolves each associated HubSpot id to the monday card on the target board; if a target
 * card doesn't exist yet, it is created on demand (so associations always link, even for records the
 * target board's own filter would exclude). Skips when links already match. HubSpot -> monday only. */
async function syncRelationColumn(env: Env, spec: ObjectSpec, a: AssocSpec, ids: string[],
    item: MondayItem, ctx: Ctx, opts: RunOpts, budget: Budget): Promise<void> {
  const target = SPEC_BY_OBJECT[a.toObject];
  if (!target) return; // no monday board for this object (e.g. line_items)
  const existing = ids.length ? await findItemIdsByColumn(env, target.boardId, target.idCol, ids) : {};
  const want: string[] = [];
  for (const hsId of ids) {
    let cardId: string | null = existing[hsId] ?? null;
    if (!cardId && budget.left > 0) cardId = await ensureTargetCard(env, target, hsId, ctx, opts, budget);
    if (cardId) want.push(cardId);
  }
  const current = await getLinkedItemIds(env, item.id, a.relationCol!);
  if (sameSet(current, want)) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} count=${want.length} action=skipped`);
    return;
  }
  if (opts.dryRun) { console.log(`DRY relation ${spec.object}/${item.id} ${a.toObject}=[${want.join(",")}]`); return; }
  await setColumns(env, spec.boardId, item.id, { [a.relationCol!]: { item_ids: want.map(Number) } }, opts); budget.left--;
  console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} board=${spec.boardId} item=${item.id} linked=${want.length} action=updated-relation`);
}

/** Create a monday card on demand for an associated record that isn't on its board yet, so the link can
 * resolve. Card only (fields + group + sync-state) — NOT its own associations, to avoid cascades. Bypasses
 * the target board's search filter (an associated company/contact links even without a sales_user). */
async function ensureTargetCard(env: Env, target: ObjectSpec, hsId: string, ctx: Ctx,
    opts: RunOpts, budget: Budget): Promise<string | null> {
  const rec = (await getRecordsByIds(env, target.object, [hsId], propertiesForSpec(target)))[0];
  if (!rec) return null;
  const group = targetGroup(rec, target);
  if (!group) return null;
  if (opts.dryRun) { console.log(`DRY create-associated ${target.object}/${hsId}`); return null; }
  const cv = buildColumnValues(rec, target, ctx);
  cv[target.syncStateCol] = rec.properties[target.modifiedProp] ?? "";
  const id = await createItem(env, target.boardId, group, itemName(rec, target), cv, opts); budget.left--;
  console.log(`source=hubspot object=${target.object} id=${hsId} action=created-associated-card board=${target.boardId} item=${id}`);
  return id;
}

/** deal line items -> monday SUBITEMS under the deal card. Create/update by HubSpot Line Item ID,
 * mark removed subitems "Removed" (or delete if no status column). Everything lives on the subitem
 * columns — there is no parent roll-up. HubSpot -> monday only. */
async function syncLineItems(env: Env, a: AssocSpec, ids: string[], parentId: string, ctx: Ctx,
    opts: RunOpts, budget: Budget, obj: string, recId: string): Promise<void> {
  const sub = a.subitems!;
  console.log(`source=hubspot object=${obj} id=${recId} association=line_items count=${ids.length} action=sync-start`);
  const props = [...new Set([...sub.fields.map(f => f.hs), ...a.nameProps])];
  const lis = ids.length ? await getRecordsByIds(env, "line_items", ids, props) : [];
  const existing = await getSubitems(env, parentId);
  const byLi: Record<string, MondayItem> = {};
  for (const s of existing) { const k = colText(s, sub.idCol); if (k) byLi[k] = s; }

  const want = new Set<string>();
  for (const li of lis) {
    want.add(li.id);
    const name = a.nameProps.map(p => li.properties[p] ?? "").join(" ").trim() || `line_item ${li.id}`;
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
  console.log(`source=hubspot object=${obj} id=${recId} association=line_items count=${lis.length} action=${lis.length ? "updated-subitems" : "no-line-items"}`);
}
