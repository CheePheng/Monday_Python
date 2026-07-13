import { useState } from "react";
import { Button, Search, TextField } from "@vibe/core";
import { searchHubspot, updateHubspotLineItem, deleteHubspotLineItem, type Hit } from "../worker-client";
import { lineItemToSubitemColumns } from "../lib/columns";
import { createSubitem, updateSubitemColumns, deleteItem } from "../monday-client";

export interface LineItem {
  subitemId?: string; lineItemId?: string; // present once synced by the Worker
  productId?: string; name: string; unitPrice: string; quantity: string; currency?: string; description?: string;
}
interface Props { token: string; value: LineItem[]; onChange: (n: LineItem[]) => void }

const hitRow: React.CSSProperties = { cursor: "pointer", padding: "4px 6px", fontSize: 13, borderRadius: 4 };

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
    if (li.subitemId) await deleteItem(li.subitemId);               // remove the monday subitem
    if (li.lineItemId) { try { await deleteHubspotLineItem(token, li.lineItemId); } catch { /* surfaced on save */ } }
    onChange(value.filter((_, j) => j !== i));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <strong>Line items</strong>
      {value.map((li, i) => (
        <div key={li.subitemId ?? i} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <span style={{ flex: 1 }}>{li.name}</span>
          <div style={{ width: 90 }}>
            <TextField title="Qty" value={li.quantity} onChange={(v) => patch(i, { quantity: v })} size="small" />
          </div>
          <div style={{ width: 110 }}>
            <TextField title="Unit price" value={li.unitPrice} onChange={(v) => patch(i, { unitPrice: v })} size="small" />
          </div>
          <Button kind="tertiary" size="small" onClick={() => void remove(i)}>Remove</Button>
        </div>
      ))}
      <Search size="small" placeholder="Add product" value={q} onChange={search} />
      {hits.map(h => <div key={h.id} style={hitRow} onClick={() => addFromProduct(h)}>{h.name} · {h.secondary}</div>)}
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
