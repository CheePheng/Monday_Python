import { useState } from "react";
import AssociationPicker from "./AssociationPicker";
import RecordForm from "./RecordForm";
import { buildCreateAssoc, type Assoc } from "../lib/assoc";
import { validateRecordForm, type RecordKind, type RecordFormValues } from "../lib/record-form";
import { newIdempotencyKey, type EnumProp } from "../worker-client";

interface Props {
  kind: RecordKind;              // "contact" | "company" (the record being linked/created)
  token: string;
  schema: Record<string, EnumProp>;
  value: Assoc[];
  onChange: (next: Assoc[]) => void;
  single?: boolean;              // keep at most one link (e.g. a Contact's Company)
}

const PLURAL: Record<RecordKind, "contacts" | "companies"> = { contact: "contacts", company: "companies" };

/** Search + stage an existing record, or stage a brand-new one (created on the parent's Save). */
export default function AssociationSection({ kind, token, schema, value, onChange, single }: Props) {
  const [creating, setCreating] = useState(false);
  const [values, setValues] = useState<RecordFormValues>({});
  const v = validateRecordForm(kind, values);

  function addNew() {
    if (!v.ok) return;
    const dedupKey = kind === "contact" ? values.email : values.domain;
    if (!dedupKey?.trim() && !window.confirm(
      `No ${kind === "contact" ? "email" : "domain"} — a duplicate can't be detected automatically. Add this new ${kind} anyway?`)) return;
    const staged = buildCreateAssoc(kind, values, newIdempotencyKey());
    onChange(single ? [staged] : [...value, staged]);
    setValues({}); setCreating(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <AssociationPicker kind={PLURAL[kind]} token={token} value={value} onChange={onChange} single={single} />
      {!creating ? (
        <button type="button" className="dc-btn dc-btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setCreating(true)}>
          ＋ New {kind}
        </button>
      ) : (
        <div className="dc-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="dc-section-title">New {kind}</div>
          <RecordForm kind={kind} values={values} schema={schema} validation={v} onChange={(p, val) => setValues(s => ({ ...s, [p]: val }))} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="dc-btn dc-btn-sm" onClick={() => { setValues({}); setCreating(false); }}>Cancel</button>
            <button type="button" className="dc-btn dc-btn-sm dc-btn-primary" disabled={!v.ok} onClick={addNew}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}
