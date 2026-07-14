import { DEAL_COLS, SUB_COLS } from "../board-config";

/** monday people value from string user ids (ids must be numeric for monday). */
export function peopleValue(ids: string[]): { personsAndTeams: { id: number; kind: "person" }[] } {
  return { personsAndTeams: ids.filter(Boolean).map(id => ({ id: Number(id), kind: "person" as const })) };
}
/** monday Connect-Boards value from linked monday item ids. */
export function boardRelationValue(itemIds: string[]): { item_ids: number[] } {
  return { item_ids: itemIds.filter(Boolean).map(id => Number(id)) };
}

export interface DealForm {
  amount?: string; currency?: string; closeDate?: string; stage?: string; pipeline?: string;
  dealType?: string; priority?: string; vendors?: string[]; salesUserIds?: string[]; dealOwnerId?: string;
}

/** Deal form -> monday column_values object (JSON-encode before sending). Empty fields are omitted so
 * an edit never blanks an untouched column. Note: item name (dealname) and group are set separately. */
export function dealFormToColumnValues(f: DealForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (f.amount) cv[DEAL_COLS.amount.id] = f.amount;
  if (f.currency) cv[DEAL_COLS.currency.id] = { label: f.currency };
  if (f.closeDate) cv[DEAL_COLS.closeDate.id] = { date: f.closeDate };
  if (f.stage) cv[DEAL_COLS.stage.id] = { label: f.stage };
  if (f.pipeline) cv[DEAL_COLS.pipeline.id] = { label: f.pipeline };
  if (f.dealType) cv[DEAL_COLS.dealType.id] = { label: f.dealType };
  if (f.priority) cv[DEAL_COLS.priority.id] = { label: f.priority };
  if (f.vendors && f.vendors.length) cv[DEAL_COLS.vendors.id] = { labels: f.vendors };
  if (f.salesUserIds && f.salesUserIds.length) cv[DEAL_COLS.salesUsers.id] = peopleValue(f.salesUserIds);
  if (f.dealOwnerId) cv[DEAL_COLS.dealOwner.id] = peopleValue([f.dealOwnerId]);
  return cv;
}

export interface LineItemForm {
  unitPrice?: string; quantity?: string; productId?: string; currency?: string; description?: string;
}
/** Line-item form -> subitem column_values (blanks omitted). */
export function lineItemToSubitemColumns(li: LineItemForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (li.unitPrice) cv[SUB_COLS.unitPrice.id] = li.unitPrice;
  if (li.quantity) cv[SUB_COLS.quantity.id] = li.quantity;
  if (li.productId) cv[SUB_COLS.productId.id] = li.productId;
  if (li.currency) cv[SUB_COLS.currency.id] = li.currency;
  if (li.description) cv[SUB_COLS.description.id] = { text: li.description };
  return cv;
}
