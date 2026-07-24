import { useState } from "react";
import {
  searchHubspot, updateHubspotLineItem, deleteHubspotLineItem, getLineItemSchema, createHubspotLineItem,
  type Hit, type EnumProp,
} from "../worker-client";
import { lineItemToSubitemColumns, lineItemHubspotProperties } from "../lib/columns";
import { createSubitem, updateSubitemColumns, deleteItem } from "../monday-client";
import { lineTotal, lineItemsTotal } from "../lib/totals";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";
import LineItemForm from "./LineItemForm";
import type { LineItemFormValues } from "../lib/line-item-form";
import { useConfirm } from "../confirm";

export interface LineItem {
  subitemId?: string; lineItemId?: string; // present once synced by the Worker
  productId?: string; name: string; unitPrice: string; quantity: string; currency?: string; description?: string;
  discount?: string; discountMode?: "amount" | "percent"; discountPct?: string; serviceDate?: string;
  saveToLibrary?: boolean; props?: Record<string, string>;
}
interface Props {
  token: string; value: LineItem[]; onChange: (n: LineItem[]) => void;
  onError?: (msg: string) => void; onUseTotal?: (n: number) => void; currency?: string;
  refreshState?: { at: number; loading: boolean; error: boolean }; onRefresh?: () => void; dirty?: boolean;
}

export default function LineItemsEditor({ token, value, onChange, onError, onUseTotal, currency = "", refreshState, onRefresh, dirty }: Props) {
  const confirm = useConfirm();   // shadows window.confirm on purpose (see BoardView)
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [schema, setSchema] = useState<Record<string, EnumProp>>({});
  const { hits, loading, error, query, clear } = useDebouncedSearch<Hit>(
    (q, signal) => searchHubspot(token, "products", q, signal), 300);

  async function openNewLineItem() {
    setAdding(true);
    try { setSchema(await getLineItemSchema(token)); } catch { /* form still usable without enum options */ }
  }

  // Build the full HubSpot property payload from the manual form values (Worker allowlists it).
  function formToProps(v: LineItemFormValues): Record<string, string> {
    const props: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) { if (k === "discountMode" || val == null || val === "") continue; props[k] = String(val); }
    if (v.discountMode === "percent") delete props.discount; else delete props.hs_discount_percentage;
    if (currency) props.hs_line_item_currency_code = currency;
    return props;
  }
  function addManual(v: LineItemFormValues, saveToLibrary: boolean) {
    onChange([...value, {
      name: v.name || "New line item", unitPrice: v.price ?? "0", quantity: v.quantity ?? "1",
      discount: v.discount, discountPct: v.hs_discount_percentage, discountMode: v.discountMode ?? "percent",
      serviceDate: v.service_date, description: v.description, currency, saveToLibrary, props: formToProps(v),
    }]);
    setAdding(false);
  }

  function addFromProduct(h: Hit) {
    onChange([...value, { productId: h.id, name: h.name, unitPrice: h.price || h.secondary || "0", quantity: "1", discountMode: "amount", description: h.description, currency }]);
    setText(""); clear();
  }
  function patch(i: number, p: Partial<LineItem>) { onChange(value.map((li, j) => j === i ? { ...li, ...p } : li)); }
  async function remove(i: number) {
    const li = value[i];
    // Already synced to HubSpot: confirm before we delete it there too.
    if (li.lineItemId && !(await confirm({
      tone: "danger",
      title: "Remove this line item?",
      message: `“${li.name || "This line item"}” will also be deleted from the deal in HubSpot. This can't be undone from here.`,
      confirmLabel: "Remove line item",
      cancelLabel: "Keep it",
    }))) return;
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
      {onRefresh && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: 12.5 }}>
          <button type="button" className="dc-btn dc-btn-sm" disabled={refreshState?.loading}
            onClick={async () => {
              if (dirty && !(await confirm({
                title: "Discard unsaved line-item changes?",
                message: "Refreshing pulls the current line items from HubSpot and replaces what you've edited here.",
                confirmLabel: "Discard & refresh",
                cancelLabel: "Keep editing",
              }))) return;
              onRefresh();
            }}>
            {refreshState?.loading ? "Refreshing…" : "⟳ Refresh line items"}
          </button>
          {refreshState?.error
            ? <span className="dc-mut" style={{ color: "var(--red)" }}>Couldn't refresh — showing last known (may be outdated)</span>
            : refreshState?.at ? <span className="dc-mut">Updated {new Date(refreshState.at).toLocaleTimeString()}</span> : null}
        </div>
      )}
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
        {loading && <span className="dc-mut" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>Searching…</span>}
        {!loading && <button type="button" className="dc-btn dc-btn-sm" title="Refresh search" onClick={() => query(text)} disabled={text.trim().length < 2}>⟳</button>}
      </div>
      {error && (
        <div className="dc-err" style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Search failed</span>
          <button type="button" className="dc-btn dc-btn-sm" onClick={() => query(text)}>Retry</button>
        </div>
      )}
      {hits.length > 0 && (
        <div className="dc-results">
          {hits.map(h => (
            <div key={h.id} className="dc-result" onClick={() => addFromProduct(h)} style={{ alignItems: "center" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{h.name}</span>
                {(h.sku || h.description) && <small style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[h.sku && `SKU ${h.sku}`, h.description].filter(Boolean).join(" · ")}</small>}
              </div>
              <small className="dc-money" style={{ flexShrink: 0 }}>{h.price || h.secondary}</small>
            </div>
          ))}
        </div>
      )}
      {!loading && !error && text.trim().length >= 2 && hits.length === 0 &&
        <div className="dc-mut" style={{ marginTop: 6, fontSize: 12.5 }}>No products found.</div>}
      {!adding && (
        <button type="button" className="dc-btn dc-btn-sm" style={{ marginTop: 8 }} onClick={() => void openNewLineItem()}>
          ＋ New line item
        </button>
      )}
      {adding && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <LineItemForm schema={schema} currency={currency} onCancel={() => setAdding(false)} onAdd={addManual} />
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
// subitem ids) plus an error message if any row's HubSpot step failed, so the caller can surface it and
// let the rep retry (subitem ids are retained, so a retry never duplicates the subitem or the line item).
export async function persistLineItems(token: string, parentItemId: string, items: LineItem[]): Promise<{ items: LineItem[]; error?: string }> {
  const out: LineItem[] = [];
  let error: string | undefined;
  for (const li of items) {
    const cols = lineItemToSubitemColumns(li);
    if (li.lineItemId) {                                   // already synced -> update the same line item
      if (li.subitemId) await updateSubitemColumns(li.subitemId, cols);
      await updateHubspotLineItem(token, li.lineItemId, li.props ?? lineItemHubspotProperties(li));
      out.push(li);
      continue;
    }
    // create (or retry a create whose HubSpot step failed): keep/create the subitem, then create the line
    // item. Retaining subitemId on failure means a retry never duplicates the subitem, and the Worker
    // dedups the line item by the id it stamped back.
    const subitemId = li.subitemId ?? await createSubitem(parentItemId, li.name, cols);
    if (li.subitemId) await updateSubitemColumns(subitemId, cols);
    try {
      const { lineItemId } = await createHubspotLineItem(token, {
        itemId: parentItemId, subitemId, productId: li.productId, saveToLibrary: li.saveToLibrary,
        properties: li.props ?? lineItemHubspotProperties(li),
      });
      out.push({ ...li, subitemId, lineItemId });
    } catch {
      out.push({ ...li, subitemId });                     // keep subitemId so the retry reuses it
      error = "Some line items couldn't be saved to HubSpot — press Save to retry.";
    }
  }
  return { items: out, error };
}
