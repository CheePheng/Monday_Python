export interface Opt { value: string; label: string }

export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="dc-field">
      <label className="dc-field-label">{label}{required && <span style={{ color: "var(--red)" }}> *</span>}</label>
      {children}
    </div>
  );
}

/** Single-select over plain string options. Empty value => the placeholder option. */
export function SelectStr({ options, value, onChange, placeholder }: {
  options: string[]; value?: string; onChange: (v: string | undefined) => void; placeholder?: string;
}) {
  return (
    <select className="dc-field-input" value={value ?? ""} onChange={e => onChange(e.target.value || undefined)}>
      <option value="">{placeholder ?? "Select…"}</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

/** Single-select over {value,label} options (e.g. users). */
export function SelectOpt({ options, value, onChange, placeholder }: {
  options: Opt[]; value?: string; onChange: (v: string | undefined) => void; placeholder?: string;
}) {
  return (
    <select className="dc-field-input" value={value ?? ""} onChange={e => onChange(e.target.value || undefined)}>
      <option value="">{placeholder ?? "Select…"}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Multi-select rendered as chips + an "add" dropdown of the remaining options. */
export function ChipMulti({ options, values, onChange, placeholder }: {
  options: Opt[]; values: string[]; onChange: (v: string[]) => void; placeholder?: string;
}) {
  const label = new Map(options.map(o => [o.value, o.label]));
  const remaining = options.filter(o => !values.includes(o.value));
  return (
    <div>
      {values.length > 0 && (
        <div className="dc-chips">
          {values.map(v => (
            <span key={v} className="dc-chip">{label.get(v) ?? v}
              <button onClick={() => onChange(values.filter(x => x !== v))} aria-label="Remove">×</button>
            </span>
          ))}
        </div>
      )}
      <select className="dc-field-input" value="" onChange={e => { if (e.target.value) onChange([...values, e.target.value]); }}>
        <option value="">{placeholder ?? "Add…"}</option>
        {remaining.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
