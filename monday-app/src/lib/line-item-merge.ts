import type { LineItem } from "../views/LineItemsEditor";

/** Merge the deal's fresh HubSpot line items into the editor's rows, keyed by HubSpot Line Item ID ONLY
 * (never by name). A matching row keeps its monday `subitemId` and takes the fresh HubSpot fields; a fresh
 * line item with no matching row is added; a row whose id is gone from HubSpot is dropped; unsaved rows
 * (no `lineItemId`) are preserved. */
export function mergeLineItems(current: LineItem[], fresh: LineItem[]): LineItem[] {
  const byId = new Map<string, LineItem>();
  for (const c of current) if (c.lineItemId) byId.set(c.lineItemId, c);
  const merged = fresh.map(f => {
    const cur = f.lineItemId ? byId.get(f.lineItemId) : undefined;
    return cur?.subitemId ? { ...f, subitemId: cur.subitemId } : { ...f };
  });
  const unsaved = current.filter(c => !c.lineItemId);
  return [...merged, ...unsaved];
}
