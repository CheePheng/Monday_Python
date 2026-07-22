import { useEffect, useRef, useState } from "react";
import type { BoardState } from "../useBoard";
import DrawerShell from "./DrawerShell";
import CreateProgress from "./CreateProgress";
import { Field, SelectStr } from "./FormFields";
import { fieldsFor, validateRecordForm, recordFormToProperties, type RecordKind, type RecordFormValues, type RecordField } from "../lib/record-form";
import { isComplete } from "../lib/create-progress";
import { openLink, openItemCard } from "../monday-client";
import {
  createContact, createCompany, getContactSchema, getCompanySchema, newIdempotencyKey,
  type CreateResult, type EnumProp,
} from "../worker-client";

interface Props { kind: RecordKind; board: BoardState; onClose: () => void; onCreated?: (r: CreateResult) => void; onDirtyChange?: (dirty: boolean) => void }

const TITLE: Record<RecordKind, string> = { contact: "Create Contact", company: "Create Company" };

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

export default function RecordDrawer({ kind, board, onClose, onCreated, onDirtyChange }: Props) {
  const [values, setValues] = useState<RecordFormValues>({});
  const [schema, setSchema] = useState<Record<string, EnumProp>>({});
  const [result, setResult] = useState<CreateResult | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [submitted, setSubmitted] = useState(false); // once true, show progress instead of the form
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // One idempotency key per drawer instance -> every Retry resumes the same server-side create.
  const keyRef = useRef<string>(newIdempotencyKey());
  const savingRef = useRef(false); // synchronous double-submit lock

  const groups = grouped(fieldsFor(kind));
  const v = validateRecordForm(kind, values);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);

  useEffect(() => {
    let alive = true;
    const load = kind === "contact" ? getContactSchema : getCompanySchema;
    load(board.sessionToken).then(s => { if (alive) setSchema(s); }).catch(() => { /* form still works without enum options */ });
    return () => { alive = false; };
  }, [kind, board.sessionToken]);

  const set = (prop: string, val: string) => { setDirty(true); setValues(s => ({ ...s, [prop]: val })); };

  function guardedClose() {
    if (dirty && !isComplete(result) && !confirm("Discard this new " + kind + "?")) return;
    onClose();
  }

  async function submit() {
    if (savingRef.current || !v.ok) return;
    // Duplicate-risk gate (spec): with no dedup key (email/domain) we can't detect an existing record —
    // require an explicit confirm on the FIRST submit (a Retry is a resume, so skip it then).
    const dedupKey = kind === "contact" ? values.email : values.domain;
    if (!submitted && !dedupKey?.trim() && !window.confirm(
      `No ${kind === "contact" ? "email" : "domain"} — a duplicate can't be detected automatically. Create this ${kind} anyway?`)) return;
    savingRef.current = true;
    setSubmitted(true); setInFlight(true); setErr(null);
    try {
      const properties = recordFormToProperties(kind, values);
      const args = { idempotencyKey: keyRef.current, properties };
      const r = kind === "contact" ? await createContact(board.sessionToken, args) : await createCompany(board.sessionToken, args);
      setResult(r);
      if (r.status === "completed") { setDirty(false); onCreated?.(r); }
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally { setInFlight(false); savingRef.current = false; }
  }

  const field = (f: RecordField) => {
    const opts = schema[f.prop]?.options ?? [];
    return (
      <Field key={f.prop} label={f.label} required={f.required}>
        {f.type === "enum" ? (
          <SelectStr options={opts.map(o => o.label)} value={optLabel(opts, values[f.prop])}
            onChange={lbl => set(f.prop, optValue(opts, lbl))} placeholder="—" />
        ) : f.type === "textarea" ? (
          <textarea className="dc-field-input" rows={2} value={values[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        ) : (
          <input className="dc-field-input" type={f.type === "email" ? "email" : "text"}
            inputMode={f.type === "number" ? "decimal" : undefined}
            value={values[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        )}
        {v.errors[f.prop] && <div className="dc-err">{v.errors[f.prop]}</div>}
        {!v.errors[f.prop] && v.warnings[f.prop] && <div className="dc-mut" style={{ marginTop: 4 }}>{v.warnings[f.prop]}</div>}
      </Field>
    );
  };

  const footer = submitted ? (
    <button className="dc-btn dc-btn-primary" onClick={guardedClose}>{isComplete(result) ? "Done" : "Close"}</button>
  ) : (
    <>
      <button className="dc-btn" onClick={guardedClose}>Cancel</button>
      <button className="dc-btn dc-btn-primary" disabled={!v.ok || inFlight} onClick={() => void submit()}>
        {inFlight ? "Creating…" : TITLE[kind]}
      </button>
    </>
  );

  return (
    <DrawerShell title={TITLE[kind]} ariaLabel={TITLE[kind]} onClose={guardedClose} footer={footer}>
      {!submitted ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {groups.map(g => (
            <div key={g.group} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="dc-section-title">{g.group}</div>
              <div className="dc-grid">{g.fields.map(field)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <CreateProgress result={result} inFlight={inFlight}
            onRetry={() => void submit()}
            onOpenMonday={() => result?.mondayItemId && openItemCard(result.mondayItemId)}
            onOpenHubspot={() => result?.hubspotLink && openLink(result.hubspotLink)} />
          {err && <div className="dc-err">{err}</div>}
        </div>
      )}
    </DrawerShell>
  );
}

// Enum columns store the HubSpot value but the picker shows labels; translate both ways via the schema.
function optLabel(opts: EnumProp["options"], value?: string): string | undefined {
  return opts.find(o => o.value === value)?.label ?? value;
}
function optValue(opts: EnumProp["options"], label?: string): string {
  return opts.find(o => o.label === label)?.value ?? label ?? "";
}
