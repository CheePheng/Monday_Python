import { useState } from "react";
import { LI_FIELDS, validateLineItemForm, computeTotals, type LiField, type LineItemFormValues } from "../lib/line-item-form";
import type { EnumProp } from "../worker-client";

interface Props {
  schema: Record<string, EnumProp>; currency: string;
  onCancel: () => void; onAdd: (values: LineItemFormValues, saveToLibrary: boolean) => void;
}
const GROUPS: { id: LiField["group"]; title: string }[] = [
  { id: "detail", title: "Line item details" }, { id: "billing", title: "Billing" },
  { id: "adjust", title: "Adjustments & Tax" }, { id: "price", title: "Price" },
];

export default function LineItemForm({ schema, currency, onCancel, onAdd }: Props) {
  const [v, setV] = useState<LineItemFormValues>({ hs_pricing_model: "flat", quantity: "1", discountMode: "percent" });
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const set = (prop: string, val: string) => setV(s => ({ ...s, [prop]: val }));
  const invalid = validateLineItemForm(v);
  const t = computeTotals(v);

  const field = (f: LiField) => {
    const opts = schema[f.prop]?.options ?? [];
    return (
      <div className="dc-field" key={f.prop}>
        <label className="dc-field-label">{f.label}{f.required && <span style={{ color: "var(--red)" }}> *</span>}</label>
        {f.type === "enum" ? (
          <select className="dc-field-input" value={v[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)}>
            <option value="">—</option>
            {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : f.type === "textarea" ? (
          <textarea className="dc-field-input" rows={2} value={v[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        ) : (
          <input className="dc-field-input" type={f.type === "date" ? "date" : "text"} inputMode={f.type === "number" ? "decimal" : undefined}
            value={v[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        )}
        {invalid.errors[f.prop] && <div className="dc-err">{invalid.errors[f.prop]}</div>}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {GROUPS.map(g => (
        <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="dc-section-title">{g.title}</div>
          <div className="dc-grid">{LI_FIELDS.filter(f => f.group === g.id).map(field)}</div>
          {g.id === "adjust" && (
            <div className="dc-field">
              <label className="dc-field-label">Unit discount</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button type="button" className={"dc-btn dc-btn-sm" + (v.discountMode === "percent" ? " on" : "")} onClick={() => set("discountMode", "percent")}>%</button>
                <button type="button" className={"dc-btn dc-btn-sm" + (v.discountMode === "amount" ? " on" : "")} onClick={() => set("discountMode", "amount")}>{currency || "amt"}</button>
                {v.discountMode === "percent"
                  ? <input className="dc-field-input" value={v.hs_discount_percentage ?? ""} onChange={e => set("hs_discount_percentage", e.target.value)} placeholder="0" />
                  : <input className="dc-field-input" value={v.discount ?? ""} onChange={e => set("discount", e.target.value)} placeholder="0" />}
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="dc-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="dc-mut">Pre-tax subtotal: {t.subtotal.toFixed(2)}</div>
        <div className="dc-mut">Total (excl. tax): {t.net.toFixed(2)}</div>
        <div className="dc-mut">Your margin: {t.margin.toFixed(2)}</div>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
        <input type="checkbox" checked={saveToLibrary} onChange={e => setSaveToLibrary(e.target.checked)} />
        Save line item to the product library
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="dc-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="dc-btn dc-btn-primary" disabled={!invalid.ok} onClick={() => onAdd(v, saveToLibrary)}>Add line item</button>
      </div>
    </div>
  );
}
