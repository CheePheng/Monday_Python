import { useEffect, useRef, useState } from "react";
import type { BoardState } from "../useBoard";
import DrawerShell from "./DrawerShell";
import CreateProgress from "./CreateProgress";
import RecordForm from "./RecordForm";
import { validateRecordForm, recordFormToProperties, type RecordKind, type RecordFormValues } from "../lib/record-form";
import { isComplete } from "../lib/create-progress";
import { openLink, openItemCard } from "../monday-client";
import {
  createContact, createCompany, getContactSchema, getCompanySchema, newIdempotencyKey,
  type CreateResult, type EnumProp,
} from "../worker-client";

interface Props { kind: RecordKind; board: BoardState; onClose: () => void; onCreated?: (r: CreateResult) => void; onDirtyChange?: (dirty: boolean) => void }

const TITLE: Record<RecordKind, string> = { contact: "Create Contact", company: "Create Company" };

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
        <RecordForm kind={kind} values={values} schema={schema} validation={v} onChange={set} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <CreateProgress result={result} inFlight={inFlight}
            canRetry={submitted && !inFlight && !isComplete(result)}
            onRetry={() => void submit()}
            onOpenMonday={() => result?.mondayItemId && openItemCard(result.mondayItemId)}
            onOpenHubspot={() => result?.hubspotLink && openLink(result.hubspotLink)} />
          {err && <div className="dc-err">{err}</div>}
        </div>
      )}
    </DrawerShell>
  );
}
