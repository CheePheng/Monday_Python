import { useState } from "react";
import { searchHubspot, updateHubspotLineItem, deleteHubspotLineItem, type Hit } from "../worker-client";
import { lineItemToSubitemColumns } from "../lib/columns";
import { createSubitem, updateSubitemColumns, deleteItem } from "../monday-client";
import { lineTotal, lineItemsTotal } from "../lib/totals";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";

export interface LineItem {
  subitemId?: string; lineItemId?: string; // present once synced by the Worker
  productId?: string; name: string; unitPrice: string; quantity: string; currency?: string; description?: string;
  discount?: string; discountMode?: "amount" | "percent"; discountPct?: string; serviceDate?: string;
}
interface Props {
  token: string; value: LineItem[]; onChange: (n: LineItem[]) => void;
  onError?: (msg: string) => void; onUseTotal?: (n: number) => void;
}

export default function LineItemsEditor({ token, value, onChange, onError, onUseTotal }: Props) {
  const [text, setText] = useState("");
  const { hits, loading, query, clear } = useDebouncedSearch<Hit>(
    (q, signal) => searchHubspot(token, "products", q, signal), 300);

  function addFromProduct(h: Hit) {
    onChange([...value, { productId: h.id, name: h.name, unitPrice: h.secondary || "0", quantity: "1", discountMode: "amount" }]);
    setText(""); clear();
  }
  function patch(i: number, p: Partial<LineItem>) { onChange(value.map((li, j) => j === i ? { ...li, ...p } : li)); }
  async function remove(i: number) {
    const li = value[i];
    // Already synced to HubSpot: confirm before we delete it there too.
    if (li.lineItemId && !confirm("Remove this line item? It will be deleted in HubSpot.")) return;
    // The monday subitem is the source of truth for the row: if it can't be deleted, surface the error and
    // KEEP the row (removing it from the UI would falsely imply the line item is gone).
    if (li.subitemId) {
      try { await deleteItem(li.subitemId); }
      catch (e) { onError?.("Couldn't remove the line item: " + String(e).slice(0, 120)); return; }
    }
    if (li.lineItemId) {
      try { await deleteHubspotLineItem(token, li.lineItemId); }
      catch (e) { onError?.("Couldn't remove the line item in HubSpot: " + String(e).slice(0, 120)); }
    }
    onChange(value.filter((_, j) => j !== i));
  }

  const grand = lineItemsTotal(value);
  const subtotal = value.reduce((s, li) => s + (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0), 0);
  const discountTotal = subtotal - grand;

  return (
    <div>
      <div className="dc-section-title">Line items</div>
      {value.length > 0 && (
        <table className="dc-qt">
          <thead>
            <tr>
              <th>Product</th><th>Qty</th><th>Unit price</th><th>Discount</th><th style={{ textAlign: "right" }}>Total</th><th></th>
            </tr>
          </thead>
          <tbody>
            {value.map((li, i) => {
              const mode = li.discountMode ?? "amount";
              return (
                <tr key={li.subitemId ?? i}>
                  <td>{li.name}</td>
                  <td>
                    <input className="dc-field-input" aria-label="Quantity" style={{ width: 56 }}
                      value={li.quantity} onChange={e => patch(i, { quantity: e.target.value })} />
                  </td>
                  <td>
                    <input className="dc-field-input" aria-label="Unit price" style={{ width: 76 }}
                      value={li.unitPrice} onChange={e => patch(i, { unitPrice: e.target.value })} />
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <button type="button" className={"dc-btn dc-btn-sm" + (mode === "amount" ? " on" : "")}
                        onClick={() => patch(i, { discountMode: "amount" })} aria-label="Discount as amount">$</button>
                      <button type="button" className={"dc-btn dc-btn-sm" + (mode === "percent" ? " on" : "")}
                        onClick={() => patch(i, { discountMode: "percent" })} aria-label="Discount as percent">%</button>
                      {mode === "percent" ? (
                        <input className="dc-field-input" aria-label="Discount percent" style={{ width: 60 }}
                          value={li.discountPct ?? ""} onChange={e => patch(i, { discountPct: e.target.value })} />
                      ) : (
                        <input className="dc-field-input" aria-label="Discount amount" style={{ width: 60 }}
                          value={li.discount ?? ""} onChange={e => patch(i, { discount: e.target.value })} />
                      )}
                    </div>
                  </td>
                  <td className="dc-money" style={{ textAlign: "right" }}>{lineTotal(li).toFixed(2)}</td>
                  <td>
                    <button type="button" className="dc-btn dc-btn-sm dc-btn-danger" onClick={() => void remove(i)} aria-label="Remove line item">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: value.length ? 10 : 0 }}>
        <input className="dc-field-input" style={{ flex: 1 }} placeholder="Add product…" value={text}
          onChange={e => { setText(e.target.value); query(e.target.value); }} />
        {loading && <div className="dc-spinner" style={{ width: 16, height: 16, borderWidth: 2, margin: 0 }} />}
      </div>
      {hits.length > 0 && (
        <div className="dc-results">
          {hits.map(h => (
            <div key={h.id} className="dc-result" onClick={() => addFromProduct(h)}>
              <span>{h.name}</span><small>{h.secondary}</small>
            </div>
          ))}
        </div>
      )}
      {value.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <div className="dc-mut">Subtotal: {subtotal.toFixed(2)}</div>
          <div className="dc-mut">Discount: −{discountTotal.toFixed(2)}</div>
          <div style={{ fontWeight: 700 }}>Total: {grand.toFixed(2)}</div>
          {onUseTotal && (
            <button type="button" className="dc-btn dc-btn-sm" style={{ marginTop: 8 }} onClick={() => onUseTotal(grand)}>
              Use total as deal amount
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Persist line items to monday + (for already-synced rows) HubSpot. Returns the updated list (with new
// subitem ids). New rows are created as subitems; the Worker mirrors them to HubSpot on its next sync.
export async function persistLineItems(token: string, parentItemId: string, items: LineItem[]): Promise<LineItem[]> {
  const out: LineItem[] = [];
  for (const li of items) {
    const cols = lineItemToSubitemColumns(li);
    if (!li.subitemId) {
      const subitemId = await createSubitem(parentItemId, li.name, cols);
      out.push({ ...li, subitemId });
    } else {
      await updateSubitemColumns(li.subitemId, cols);
      if (li.lineItemId) await updateHubspotLineItem(token, li.lineItemId, {
        price: li.unitPrice, quantity: li.quantity,
        ...(li.currency ? { hs_line_item_currency_code: li.currency } : {}),
        ...(li.description ? { description: li.description } : {}),
        ...(li.discountMode === "percent"
          ? { hs_discount_percentage: li.discountPct ?? "", discount: "" }
          : { discount: li.discount ?? "", hs_discount_percentage: "" }),
        ...(li.serviceDate ? { service_date: li.serviceDate } : {}),
      });
      out.push(li);
    }
  }
  return out;
}
