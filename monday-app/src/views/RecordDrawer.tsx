import { useEffect, useRef, useState } from "react";
import type { BoardState } from "../useBoard";
import DrawerShell from "./DrawerShell";
import CreateProgress from "./CreateProgress";
import RecordForm from "./RecordForm";
import AssociationSection from "./AssociationSection";
import type { Assoc } from "../lib/assoc";
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
  const nestedKind: RecordKind = kind === "contact" ? "company" : "contact";
  const [assoc, setAssoc] = useState<Assoc[]>([]);
  const [nestedSchema, setNestedSchema] = useState<Record<string, EnumProp>>({});

  const v = validateRecordForm(kind, values);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);

  useEffect(() => {
    let alive = true;
    const load = kind === "contact" ? getContactSchema : getCompanySchema;
    const loadNested = nestedKind === "contact" ? getContactSchema : getCompanySchema;
    load(board.sessionToken).then(s => { if (alive) setSchema(s); }).catch(() => { /* form still works without enum options */ });
    loadNested(board.sessionToken).then(s => { if (alive) setNestedSchema(s); }).catch(() => {});
    return () => { alive = false; };
  }, [kind, nestedKind, board.sessionToken]);

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
      // Resolve any linked/new related records to HubSpot ids first (a staged "+ New" is created here,
      // keyed so a retry resumes). Then the main create carries the association ids.
      const relatedIds: string[] = [];
      for (const a of assoc) {
        if (a.hubspotId) { relatedIds.push(a.hubspotId); continue; }
        if (a.create) {
          const rr = nestedKind === "contact"
            ? await createContact(board.sessionToken, { idempotencyKey: a.create.key, properties: a.create.properties })
            : await createCompany(board.sessionToken, { idempotencyKey: a.create.key, properties: a.create.properties });
          if (!rr.hubspotId) throw new Error(`Couldn't create the linked ${nestedKind}`);
          relatedIds.push(rr.hubspotId);
        }
      }
      const args = kind === "contact"
        ? { idempotencyKey: keyRef.current, properties, associateCompanyHubspotId: relatedIds[0] }
        : { idempotencyKey: keyRef.current, properties, associateContactHubspotIds: relatedIds };
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
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <RecordForm kind={kind} values={values} schema={schema} validation={v} onChange={set} />
          <div>
            <div className="dc-section-title">{kind === "contact" ? "Company (optional)" : "Contacts (optional)"}</div>
            <AssociationSection kind={nestedKind} token={board.sessionToken} schema={nestedSchema}
              value={assoc} onChange={next => { setDirty(true); setAssoc(next); }} single={kind === "contact"} />
          </div>
        </div>
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
