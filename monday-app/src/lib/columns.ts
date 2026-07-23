import { DEAL_COLS, SUB_COLS } from "../board-config";

/** monday people value from string user ids (ids must be numeric for monday). */
export function peopleValue(ids: string[]): { personsAndTeams: { id: number; kind: "person" }[] } {
  return { personsAndTeams: ids.filter(Boolean).map(id => ({ id: Number(id), kind: "person" as const })) };
}
/** monday Connect-Boards value from linked monday item ids. Deduped: a staged "+ New" record whose email
 * or domain dedups onto an already-linked record resolves to the SAME card, which would otherwise send
 * item_ids:[123,123]. */
export function boardRelationValue(itemIds: string[]): { item_ids: number[] } {
  return { item_ids: [...new Set(itemIds.filter(Boolean).map(id => Number(id)))] };
}

export interface DealForm {
  amount?: string; currency?: string; closeDate?: string; stage?: string; pipeline?: string;
  dealType?: string; priority?: string; vendors?: string[]; salesUserIds?: string[]; dealOwnerId?: string;
}

/** The fields a rep is allowed to deliberately clear. */
export interface DealClears { amount?: boolean; closeDate?: boolean; salesUsers?: boolean }

const blank = (v?: string) => !(v ?? "").trim();

/** Which clearable fields the rep DELIBERATELY emptied: the value loaded with something in it, and the
 * rep emptied the box. `orig` must be the form as it was hydrated from the item.
 *
 * A field that was already empty is never a clear. That matters: if monday is empty only because the
 * sync hasn't filled it yet, treating it as a clear would wipe a real HubSpot value on the next save. */
export function deliberateClears(orig: DealForm, now: DealForm): DealClears {
  const emptied = (a?: string, b?: string) => !blank(a) && blank(b);
  return {
    amount: emptied(orig.amount, now.amount),
    closeDate: emptied(orig.closeDate, now.closeDate),
    salesUsers: (orig.salesUserIds?.length ?? 0) > 0 && (now.salesUserIds?.length ?? 0) === 0,
  };
}

/** Deal form -> monday column_values object (JSON-encode before sending). Empty fields are omitted so
 * an edit never blanks an untouched column — EXCEPT the fields in `clears`, which the rep deliberately
 * emptied and which are written as null (null clears every monday column type).
 * Note: item name (dealname) and group are set separately. */
export function dealFormToColumnValues(f: DealForm, clears: DealClears = {}): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (f.amount) cv[DEAL_COLS.amount.id] = f.amount;
  else if (clears.amount) cv[DEAL_COLS.amount.id] = null;
  if (f.currency) cv[DEAL_COLS.currency.id] = { label: f.currency };
  if (f.closeDate) cv[DEAL_COLS.closeDate.id] = { date: f.closeDate };
  else if (clears.closeDate) cv[DEAL_COLS.closeDate.id] = null;
  if (f.stage) cv[DEAL_COLS.stage.id] = { label: f.stage };
  if (f.pipeline) cv[DEAL_COLS.pipeline.id] = { label: f.pipeline };
  if (f.dealType) cv[DEAL_COLS.dealType.id] = { label: f.dealType };
  if (f.priority) cv[DEAL_COLS.priority.id] = { label: f.priority };
  if (f.vendors && f.vendors.length) cv[DEAL_COLS.vendors.id] = { labels: f.vendors };
  if (f.salesUserIds && f.salesUserIds.length) cv[DEAL_COLS.salesUsers.id] = peopleValue(f.salesUserIds);
  else if (clears.salesUsers) cv[DEAL_COLS.salesUsers.id] = null;
  if (f.dealOwnerId) cv[DEAL_COLS.dealOwner.id] = peopleValue([f.dealOwnerId]);
  return cv;
}

export interface LineItemForm {
  unitPrice?: string; quantity?: string; productId?: string; currency?: string; description?: string;
  discount?: string; discountMode?: "amount" | "percent"; discountPct?: string; serviceDate?: string;
}
/** Line-item form -> HubSpot property patch for an already-synced line item.
 *
 * Two rules keep a save from destroying data in HubSpot (the CRM is the source of truth, and these
 * subitem fields are forward-only — the Worker can never restore what we blank here):
 *  - only the ACTIVE discount is sent; the other is blanked so switching $/% can't leave a stale value.
 *    This means the caller MUST hydrate discount/discountPct/discountMode from the subitem, or an
 *    untouched line item would report "no discount" and clear a real one.
 *  - an empty price/quantity is omitted, never sent as "" — a blank box must not clear a real value. */
export function lineItemHubspotProperties(li: LineItemForm): Record<string, string> {
  return {
    ...(li.unitPrice ? { price: li.unitPrice } : {}),
    ...(li.quantity ? { quantity: li.quantity } : {}),
    ...(li.currency ? { hs_line_item_currency_code: li.currency } : {}),
    ...(li.description ? { description: li.description } : {}),
    ...(li.discountMode === "percent"
      ? { hs_discount_percentage: li.discountPct ?? "", discount: "" }
      : { discount: li.discount ?? "", hs_discount_percentage: "" }),
    ...(li.serviceDate ? { service_date: li.serviceDate } : {}),
  };
}

/** Line-item form -> subitem column_values (blanks omitted). Writes only the ACTIVE discount column
 * (amount or percent); clearing the inactive one on a mode switch is handled by the update path. */
export function lineItemToSubitemColumns(li: LineItemForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (li.unitPrice) cv[SUB_COLS.unitPrice.id] = li.unitPrice;
  if (li.quantity) cv[SUB_COLS.quantity.id] = li.quantity;
  if (li.productId) cv[SUB_COLS.productId.id] = li.productId;
  if (li.currency) cv[SUB_COLS.currency.id] = li.currency;
  if (li.description) cv[SUB_COLS.description.id] = { text: li.description };
  if (li.discountMode === "percent") { if (li.discountPct) cv[SUB_COLS.discountPct.id] = li.discountPct; }
  else if (li.discount) cv[SUB_COLS.discount.id] = li.discount;
  if (li.serviceDate) cv[SUB_COLS.serviceDate.id] = { date: li.serviceDate };
  return cv;
}
