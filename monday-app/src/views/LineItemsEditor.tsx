import { useState } from "react";
import { searchHubspot, updateHubspotLineItem, deleteHubspotLineItem, type Hit } from "../worker-client";
import { lineItemToSubitemColumns } from "../lib/columns";
import { createSubitem, updateSubitemColumns, deleteItem } from "../monday-client";
import { lineTotal, lineItemsTotal } from "../lib/totals";

export interface LineItem {
  subitemId?: string; lineItemId?: string; // present once synced by the Worker
  productId?: string; name: string; unitPrice: string; quantity: string; currency?: string; description?: string;
  discount?: string; serviceDate?: string;
}
interface Props {
  token: string; value: LineItem[]; onChange: (n: LineItem[]) => void;
  onError?: (msg: string) => void; onUseTotal?: (n: number) => void;
}

export default function LineItemsEditor({ token, value, onChange, onError, onUseTotal }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) { setHits([]); return; }
    try { setHits(await searchHubspot(token, "products", text)); } catch { setHits([]); onError?.("Product search unavailable"); }
  }
  function addFromProduct(h: Hit) {
    onChange([...value, { productId: h.id, name: h.name, unitPrice: h.secondary || "0", quantity: "1" }]);
    setQ(""); setHits([]);
  }
  function patch(i: number, p: Partial<LineItem>) { onChange(value.map((li, j) => j === i ? { ...li, ...p } : li)); }
  async function remove(i: number) {
    const li = value[i];
    if (li.subitemId) await deleteItem(li.subitemId);
    if (li.lineItemId) {
      try { await deleteHubspotLineItem(token, li.lineItemId); }
      catch (e) { onError?.("Couldn't remove the line item in HubSpot: " + String(e).slice(0, 120)); }
    }
    onChange(value.filter((_, j) => j !== i));
  }

  const total = lineItemsTotal(value);

  return (
    <div>
      <div className="dc-section-title">Line items</div>
      {value.map((li, i) => (
        <div key={li.subitemId ?? i} className="dc-li" style={{ flexWrap: "wrap" }}>
          <span className="dc-li-name">{li.name}</span>
          <input className="dc-field-input" aria-label="Quantity" placeholder="Qty" value={li.quantity} onChange={e => patch(i, { quantity: e.target.value })} />
          <input className="dc-field-input" aria-label="Unit price" placeholder="Price" value={li.unitPrice} onChange={e => patch(i, { unitPrice: e.target.value })} />
          <input className="dc-field-input" aria-label="Discount" placeholder="Disc" value={li.discount ?? ""} onChange={e => patch(i, { discount: e.target.value })} />
          <input type="date" className="dc-field-input" aria-label="Service date" style={{ width: 132 }} value={li.serviceDate ?? ""} onChange={e => patch(i, { serviceDate: e.target.value })} />
          <input className="dc-field-input" aria-label="Description" placeholder="Description" style={{ width: 160 }} value={li.description ?? ""} onChange={e => patch(i, { description: e.target.value })} />
          <span style={{ marginLeft: "auto", minWidth: 64, textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{lineTotal(li).toFixed(2)}</span>
          <button className="dc-btn dc-btn-sm dc-btn-danger" onClick={() => void remove(i)}>Remove</button>
        </div>
      ))}
      <input className="dc-field-input" style={{ marginTop: value.length ? 10 : 0 }} placeholder="Add product…" value={q} onChange={e => void search(e.target.value)} />
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>Total: {total.toFixed(2)}</span>
          {onUseTotal && (
            <button type="button" className="dc-btn dc-btn-sm" onClick={() => onUseTotal(total)}>Use as deal amount</button>
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
        ...(li.discount ? { discount: li.discount } : {}),
        ...(li.serviceDate ? { service_date: li.serviceDate } : {}),
      });
      out.push(li);
    }
  }
  return out;
}
