import { Field, SelectStr } from "./FormFields";
import { fieldsFor, NO_WEBSITE, type RecordKind, type RecordFormValues, type RecordField } from "../lib/record-form";
import type { EnumProp } from "../worker-client";

interface Props {
  kind: RecordKind;
  values: RecordFormValues;
  schema: Record<string, EnumProp>;
  validation: { errors: Record<string, string>; warnings: Record<string, string> };
  onChange: (prop: string, val: string) => void;
}

/** Group the fields in declaration order, preserving first-seen group order. */
function grouped(fields: RecordField[]): { group: string; fields: RecordField[] }[] {
  const out: { group: string; fields: RecordField[] }[] = [];
  for (const f of fields) {
    let g = out.find(x => x.group === f.group);
    if (!g) { g = { group: f.group, fields: [] }; out.push(g); }
    g.fields.push(f);
  }
  return out;
}

/** The grouped Contact/Company create form body (no drawer chrome, no submit) — reused standalone, in the
 * deal's "+ New" panel, and in the nested-association panel. */
export default function RecordForm({ kind, values, schema, validation, onChange }: Props) {
  const groups = grouped(fieldsFor(kind));
  const field = (f: RecordField) => {
    const opts = schema[f.prop]?.options ?? [];
    // Form-only flag: sits on its own row (no Field chrome) and spans the grid so it reads as a statement
    // about the field above it. Ticking it clears the domain, so the two can never disagree.
    if (f.type === "checkbox") return (
      <label key={f.prop} style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
        <input type="checkbox" checked={values[f.prop] === "1"}
          onChange={e => {
            onChange(f.prop, e.target.checked ? "1" : "");
            if (e.target.checked && f.prop === NO_WEBSITE) onChange("domain", "");
          }} />
        {f.label}
      </label>
    );
    return (
      <Field key={f.prop} label={f.label} required={f.required}>
        {f.type === "enum" ? (
          <SelectStr options={opts.map(o => o.label)} value={optLabel(opts, values[f.prop])}
            onChange={lbl => onChange(f.prop, optValue(opts, lbl))} placeholder="—" />
        ) : f.type === "textarea" ? (
          <textarea className="dc-field-input" rows={2} value={values[f.prop] ?? ""} onChange={e => onChange(f.prop, e.target.value)} />
        ) : (
          <input className="dc-field-input" type={f.type === "email" ? "email" : "text"}
            inputMode={f.type === "number" ? "decimal" : undefined}
            disabled={f.prop === "domain" && values[NO_WEBSITE] === "1"}
            value={values[f.prop] ?? ""} onChange={e => onChange(f.prop, e.target.value)} />
        )}
        {validation.errors[f.prop] && <div className="dc-err">{validation.errors[f.prop]}</div>}
        {!validation.errors[f.prop] && validation.warnings[f.prop] && <div className="dc-mut" style={{ marginTop: 4 }}>{validation.warnings[f.prop]}</div>}
      </Field>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {groups.map(g => (
        <div key={g.group} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="dc-section-title">{g.group}</div>
          <div className="dc-grid">{g.fields.map(field)}</div>
        </div>
      ))}
    </div>
  );
}

// Enum columns store the HubSpot value but the picker shows labels; translate both ways via the schema.
function optLabel(opts: EnumProp["options"], value?: string): string | undefined {
  return opts.find(o => o.value === value)?.label ?? value;
}
function optValue(opts: EnumProp["options"], label?: string): string {
  return opts.find(o => o.label === label)?.value ?? label ?? "";
}
