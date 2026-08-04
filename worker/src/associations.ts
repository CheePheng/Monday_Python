import type { AssocSpec, Budget, Ctx, Env, HsRecord, MondayItem, ObjectSpec, RunOpts, SubitemSpec } from "./types";
import { createLineItem, getAssociatedIds, getRecord, getRecordsByIds, patchLineItem, propertiesForSpec, putAssociation } from "./hubspot";
import { createItem, createSubitem, deleteItem, findItemIdsByColumn, getItem, getItemsColumnText, getLinkedItemIds, getParentItemId, getSubitems, setColumns, updateItem } from "./monday";
import { DEALS, LINE_ITEM_SUBITEMS, SPEC_BY_OBJECT } from "./config";
import { buildSubitemReversePatch, subitemFieldByCol } from "./line-item-reverse";
import { ensureCardForRecord, cardIdOf } from "./ensure-card";
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

/** REVERSE association pass (monday -> HubSpot). Additive + set-only: for each Connect-Boards column, add
 * any monday-linked record as a HubSpot association if it isn't one already; NEVER deletes. Idempotent PUT,
 * so it converges with the forward pass. Meant for the monday-edit path only (not the cron reconcile) so it
 * can't re-add a HubSpot-removed link. */
export async function reverseAssociations(env: Env, spec: ObjectSpec, rec: HsRecord, item: MondayItem,
    opts: RunOpts, budget: Budget): Promise<void> {
  for (const a of spec.associations ?? []) {
    if (!a.relationCol) continue;
    try {
      const target = SPEC_BY_OBJECT[a.toObject];
      if (!target) continue;
      const linkedCards = await getLinkedItemIds(env, item.id, a.relationCol);
      if (!linkedCards.length) continue;
      const hsIdByCard = await getItemsColumnText(env, linkedCards, target.idCol);
      const want = [...new Set(Object.values(hsIdByCard).filter(id => /^\d+$/.test(id)))];
      if (!want.length) continue;
      const current = new Set(await getAssociatedIds(env, spec.object, rec.id, a.toObject));
      let added = 0;
      for (const hsId of want) {
        if (current.has(hsId)) continue;
        if (budget.left <= 0) break;
        await putAssociation(env, spec.object, rec.id, a.toObject, hsId, opts); budget.left--; added++;
      }
      console.log(`source=monday object=${spec.object} id=${rec.id} reverse=${a.toObject} linked=${want.length} added=${added} action=reverse-associated`);
    } catch (e) {
      console.log(`reverse-assoc error ${spec.object}/${rec.id} ${a.toObject}: ${String(e).slice(0, 160)}`);
    }
  }
}

// HubSpot COMPUTES these from price/quantity/discount — don't send them on a line-item create.
const LI_CALCULATED = new Set(["amount", "hs_pre_discount_amount"]);

/** How long to leave a brand-new id-less subitem alone, so the app's own /app/line-item create (which is
 * idempotent and carries the full field set) wins instead of racing this pass into a duplicate. */
const APP_CREATE_GRACE_MS = 90_000;

/** REVERSE line-item pass (monday subitems -> HubSpot line items). id-keyed + additive: creates a HubSpot
 * line item only for a subitem with an EMPTY "HubSpot Line Item ID", then stamps the returned id back so
 * the forward pass treats it as synced (no duplicate). Never deletes. Requires crm.objects.line_items.write. */
export async function reverseLineItems(env: Env, sub: SubitemSpec, parentItem: MondayItem,
    dealHubspotId: string, opts: RunOpts, budget: Budget): Promise<void> {
  const subitems = await getSubitems(env, parentItem.id);
  // The app creates the subitem FIRST and then calls POST /app/line-item to create the HubSpot line item
  // and stamp its id back. Saving a deal also fires a monday column webhook that lands here in the middle
  // of that — and creating one now yields TWO line items on the deal, doubling its total. Leave brand-new
  // id-less subitems to the app; if it never finishes, a later pass (10-min backup / daily) picks them up.
  const now = Date.now();
  const idless = subitems.filter(s => {
    if (colText(s, sub.idCol)) return false;                    // already has a HubSpot Line Item ID
    const age = now - (Date.parse(s.created_at) || 0);
    if (age < APP_CREATE_GRACE_MS) {
      console.log(`source=monday reverse-line-item deal=${dealHubspotId} subitem=${s.id} action=deferred reason="created ${Math.round(age / 1000)}s ago; the app may still be creating its line item"`);
      return false;
    }
    return true;
  });
  if (!idless.length) return;
  // Dedup guard (webhook coalescing is per-isolate; two isolates could double-create): adopt an existing
  // same-name line item already on this deal instead of creating a second one.
  const byName: Record<string, string> = {};
  try {
    const liIds = await getAssociatedIds(env, "deals", dealHubspotId, "line_items");
    const lis = liIds.length ? await getRecordsByIds(env, "line_items", liIds, ["name"]) : [];
    for (const li of lis) { const n = (li.properties.name ?? "").trim(); if (n && !(n in byName)) byName[n] = li.id; }
  } catch { /* best-effort dedup */ }
  for (const s of idless) {
    if (budget.left <= 0) break;
    const name = (s.name ?? "").trim();
    if (name && byName[name]) { // a matching line item already exists -> adopt it, never duplicate
      const liId = byName[name]; delete byName[name];
      await setColumns(env, sub.boardId, s.id, { [sub.idCol]: liId }, opts); budget.left--;
      console.log(`source=monday reverse-line-item deal=${dealHubspotId} subitem=${s.id} line_item=${liId} action=adopted`);
      continue;
    }
    const props: Record<string, string> = {};
    if (name) props["name"] = name;
    for (const f of sub.fields) {
      if (LI_CALCULATED.has(f.hs)) continue;
      const v = colText(s, f.col).trim();
      if (v) props[f.hs] = f.type === "date" ? v.slice(0, 10) : v;
    }
    // Picked from the HubSpot product library (the vibe app sets the product id) -> link the line item.
    if (sub.productIdCol) { const pid = colText(s, sub.productIdCol).trim(); if (pid) props["hs_product_id"] = pid; }
    if (!props["name"] && !props["price"]) continue; // nothing meaningful to create
    try {
      const liId = await createLineItem(env, props, dealHubspotId, opts); budget.left--;
      if (liId) await setColumns(env, sub.boardId, s.id, { [sub.idCol]: liId }, opts);
      console.log(`source=monday reverse-line-item deal=${dealHubspotId} subitem=${s.id} line_item=${liId} action=created`);
    } catch (e) {
      console.log(`reverse-line-item error deal=${dealHubspotId} subitem=${s.id}: ${String(e).slice(0, 140)} (needs crm.objects.line_items.write?)`);
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
  const cardByHsId: Record<string, string> = { ...existing };
  // Resolve every associated id to a monday card, creating on-demand for uncarded ones. A contact-heavy
  // company (up to 100 associated contacts) would otherwise serialize 100 single-record fetches + creates,
  // so BATCH the record fetch (one call) and create the cards with bounded concurrency. Each card is
  // independent and idempotency-guarded by its own Durable Object (ensureCardForRecord), so parallel
  // creates can't duplicate; the budget is a soft cap so a small concurrent overshoot is harmless.
  const uncarded = ids.filter(hsId => !cardByHsId[hsId]);
  if (uncarded.length && !opts.dryRun && budget.left > 0) {
    const recById: Record<string, HsRecord> = {};
    for (const r of await getRecordsByIds(env, target.object, uncarded, propertiesForSpec(target))) recById[r.id] = r;
    const CARD_CONC = 5;
    for (let i = 0; i < uncarded.length && budget.left > 0; i += CARD_CONC) {
      await Promise.all(uncarded.slice(i, i + CARD_CONC).map(async hsId => {
        if (budget.left <= 0 || cardByHsId[hsId]) return;
        const rec = recById[hsId];
        if (!rec) return;
        const id = cardIdOf(await ensureCardForRecord(env, target, ctx, rec, opts)); budget.left--;
        if (id) {
          cardByHsId[hsId] = id;
          console.log(`source=hubspot object=${target.object} id=${hsId} action=ensured-associated-card board=${target.boardId} item=${id}`);
        }
      }));
    }
  }
  const want = ids.map(hsId => cardByHsId[hsId]).filter((x): x is string => !!x);
  const current = await getLinkedItemIds(env, item.id, a.relationCol!);
  if (sameSet(current, want)) {
    console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} count=${want.length} action=skipped`);
    return;
  }
  if (opts.dryRun) { console.log(`DRY relation ${spec.object}/${item.id} ${a.toObject}=[${want.join(",")}]`); return; }
  await setColumns(env, spec.boardId, item.id, { [a.relationCol!]: { item_ids: want.map(Number) } }, opts); budget.left--;
  console.log(`source=hubspot object=${spec.object} id=${item.id} relation=${a.toObject} board=${spec.boardId} item=${item.id} linked=${want.length} action=updated-relation`);
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

/**
 * REVERSE a single monday line-item subitem edit -> HubSpot (event-source-wins; monday is the source).
 * change_name -> patch the line-item `name`. change_column_value -> patch the one reverse-eligible field
 * (has id) or create the line item (no id, via reverseLineItems' grace + dedup). Echo-suppressed and
 * omit-empty via buildSubitemReversePatch. HubSpot writes gated on LINE_ITEM_WRITE.
 */
export async function reverseSubitemEdit(env: Env, ev: any, opts: RunOpts, budget: Budget): Promise<void> {
  if (env.LINE_ITEM_WRITE !== "true") return;
  const sub = LINE_ITEM_SUBITEMS;
  const subitemId = String(ev.pulseId ?? ev.itemId ?? "");
  const type = String(ev.type ?? "");
  const columnId = ev.columnId ? String(ev.columnId) : "";
  if (!subitemId) return;

  // --- Rename: subitem name -> HubSpot line-item `name` (omit-empty + echo) ---
  if (type === "change_name") {
    const item = await getItem(env, subitemId);
    if (!item) return;
    const liId = colText(item, sub.idCol);
    if (!liId) return;                                   // no id -> the create path owns the name
    const newName = (item.name ?? "").trim();
    if (!newName) return;                                // omit-empty
    const cur = await getRecord(env, "line_items", liId, ["name"]);
    if (cur && (String(cur.properties.name ?? "")).trim() === newName) return; // echo
    await patchLineItem(env, liId, { name: newName }, opts); budget.left--;
    console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId} action=patched-name`);
    return;
  }

  if (type !== "change_column_value") return;
  const f = subitemFieldByCol(columnId);
  if (!f || !f.reverse) return;                          // gate first: non-reverse column costs 0 API calls

  const item = await getItem(env, subitemId);
  if (!item) return;
  const liId = colText(item, sub.idCol);
  const value = colText(item, f.col);

  // --- Has id -> PATCH the single changed field ---
  if (liId) {
    const cur = await getRecord(env, "line_items", liId, [f.hs]);
    const hsVal = cur ? String(cur.properties[f.hs] ?? "") : "";
    const props = buildSubitemReversePatch(columnId, value, hsVal);
    if (!props) return;                                  // echo / omit-empty
    await patchLineItem(env, liId, props, opts); budget.left--;
    console.log(`source=monday reverse-line-item subitem=${subitemId} line_item=${liId} action=patched cols=${Object.keys(props).join(",")}`);
    return;
  }

  // --- No id -> CREATE via the existing reverse pass (grace period + name-dedup) ---
  const parentId = await getParentItemId(env, subitemId);
  if (!parentId) return;
  const parent = await getItem(env, parentId);
  if (!parent) return;
  const dealId = colText(parent, DEALS.idCol);
  if (!dealId) return;                                   // deal not linked to HubSpot yet; a later sync carries it
  await reverseLineItems(env, sub, parent, dealId, opts, budget);
}
