import { useState } from "react";
import { searchHubspot, updateHubspotLineItem, deleteHubspotLineItem, type Hit } from "../worker-client";
import { lineItemToSubitemColumns } from "../lib/columns";
import { createSubitem, updateSubitemColumns, deleteItem } from "../monday-client";

export interface LineItem {
  subitemId?: string; lineItemId?: string; // present once synced by the Worker
  productId?: string; name: string; unitPrice: string; quantity: string; currency?: string; description?: string;
}
interface Props { token: string; value: LineItem[]; onChange: (n: LineItem[]) => void }

export default function LineItemsEditor({ token, value, onChange }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) { setHits([]); return; }
    try { setHits(await searchHubspot(token, "products", text)); } catch { setHits([]); }
  }
  function addFromProduct(h: Hit) {
    onChange([...value, { productId: h.id, name: h.name, unitPrice: h.secondary || "0", quantity: "1" }]);
    setQ(""); setHits([]);
  }
  function patch(i: number, p: Partial<LineItem>) { onChange(value.map((li, j) => j === i ? { ...li, ...p } : li)); }
  async function remove(i: number) {
    const li = value[i];
    if (li.subitemId) await deleteItem(li.subitemId);
    if (li.lineItemId) { try { await deleteHubspotLineItem(token, li.lineItemId); } catch { /* surfaced on save */ } }
    onChange(value.filter((_, j) => j !== i));
  }

  return (
    <div>
      <div className="dc-section-title">Line items</div>
      {value.map((li, i) => (
        <div key={li.subitemId ?? i} className="dc-li">
          <span className="dc-li-name">{li.name}</span>
          <input className="dc-field-input" aria-label="Quantity" placeholder="Qty" value={li.quantity} onChange={e => patch(i, { quantity: e.target.value })} />
          <input className="dc-field-input" aria-label="Unit price" placeholder="Price" value={li.unitPrice} onChange={e => patch(i, { unitPrice: e.target.value })} />
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
        price: li.unitPrice, quantity: li.quantity, ...(li.currency ? { hs_line_item_currency_code: li.currency } : {}),
      });
      out.push(li);
    }
  }
  return out;
}
