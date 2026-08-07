import { useEffect, useRef, useState } from "react";
import DrawerShell from "./DrawerShell";
import AssociationSection from "./AssociationSection";
import { Field, SelectStr, SelectOpt, type Opt } from "./FormFields";
import { COMPANY_COLS, COMPANY_REL_CONTACT, CONTACT_ID_COL, COMPANY_BOARD, hubspotRecordUrl } from "../board-config";
import { getItem, updateItemColumns, renameItem, getCardsByIds, openLink, openItemCard, type AccountUser } from "../monday-client";
import {
  ensureCard, syncCompany, getCompanyContacts, getRecordAssociations, getCompanySchema, createContact,
  addHubspotAssociation, deleteHubspotAssociation, searchHubspot,
  type Company, type EnumProp,
} from "../worker-client";
import { companyFormToColumnValues, type CompanyForm } from "../lib/company-form";
import { mergeAssoc } from "../lib/assoc-merge";
import type { Assoc } from "../lib/assoc";
import { colText, linkedIds } from "../useBoard";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";
import { useConfirm } from "../confirm";
import type { NewDealSeed } from "../lib/companies";
import { orDash } from "../lib/companies";

interface Props {
  company: Company; token: string; users: AccountUser[];
  onClose: () => void; onCreateDeal: (seed: NewDealSeed) => void; onSaved?: () => void;
}
const enumOpts = (schema: Record<string, EnumProp>, key: string): string[] =>
  (schema[key]?.options ?? []).map(o => o.label);

export default function CompanyDrawer({ company, token, users, onClose, onCreateDeal, onSaved }: Props) {
  const confirm = useConfirm();
  const [itemId, setItemId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<CompanyForm & { domain?: string }>({});
  const [origDomain, setOrigDomain] = useState("");
  const [contacts, setContacts] = useState<Assoc[]>([]);
  const [origContacts, setOrigContacts] = useState<Assoc[]>([]);
  const [deals, setDeals] = useState<{ hubspotId: string; name: string }[]>([]);
  const [schema, setSchema] = useState<Record<string, EnumProp>>({});
  const savingRef = useRef(false);
  const title = company.name || company.domain || "Company";
  const userOpts: Opt[] = users.map(u => ({ value: u.id, label: u.name || u.email || u.id }));
  const set = (p: Partial<typeof form>) => { setDirty(true); setForm(f => ({ ...f, ...p })); };

  useEffect(() => { getCompanySchema(token).then(setSchema).catch(() => {}); }, [token]);

  // Hydrate: resolve the monday card, read its columns + relation, merge fresh HubSpot contacts + deals.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const id = await ensureCard(token, "companies", company.hubspotId);
        const it = await getItem(id);
        if (!it || !alive) { if (alive) setErr("Couldn't load this company. Close and reopen."); return; }
        const people = (col: string) => {
          try { return (JSON.parse(it.column_values.find(c => c.id === col)?.value ?? "{}").personsAndTeams ?? [])
            .filter((p: any) => p.kind === "person").map((p: any) => String(p.id)); } catch { return []; }
        };
        const f: CompanyForm & { domain?: string } = {
          domain: it.name,
          name: colText(it as any, COMPANY_COLS.name.id),
          industry: colText(it as any, COMPANY_COLS.industry.id),
          type: colText(it as any, COMPANY_COLS.type.id),
          salesUserId: people(COMPANY_COLS.salesUsers.id)[0],
          ownerId: people(COMPANY_COLS.owner.id)[0],
          city: colText(it as any, COMPANY_COLS.city.id), state: colText(it as any, COMPANY_COLS.state.id),
          employees: colText(it as any, COMPANY_COLS.employees.id), revenue: colText(it as any, COMPANY_COLS.revenue.id),
          linkedin: colText(it as any, COMPANY_COLS.linkedin.id), description: colText(it as any, COMPANY_COLS.description.id),
        };
        const cards = await getCardsByIds(linkedIds(it as any, COMPANY_REL_CONTACT), CONTACT_ID_COL);
        const [hsContacts, hsDeals] = await Promise.all([
          getCompanyContacts(token, company.hubspotId).catch(() => []),
          getRecordAssociations(token, "companies", company.hubspotId, "deals").catch(() => []),
        ]);
        const merged = mergeAssoc(cards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name })),
          hsContacts.map(c => ({ hubspotId: c.hubspotId, name: c.name })));
        if (!alive) return;
        setItemId(id); setForm(f); setOrigDomain(it.name);
        setContacts(merged); setOrigContacts(merged); setDeals(hsDeals); setLoaded(true);
      } catch (e) { if (alive) setErr("Couldn't load this company. " + String(e).slice(0, 120)); }
    })();
    return () => { alive = false; };
  }, [company.hubspotId, token]);

  async function guardedClose() {
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", message: "This company has edits that haven't been saved.", confirmLabel: "Discard changes", cancelLabel: "Keep editing" }))) return;
    onClose();
  }

  async function resolveContacts(list: Assoc[]): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      if (a.create) {   // staged "+ New contact": create it now (keyed, so a retry resumes, never duplicates)
        const r = await createContact(token, { idempotencyKey: a.create.key, properties: a.create.properties });
        if (!r.hubspotId || !r.mondayItemId) throw new Error("Couldn't create the new contact");
        out.push({ label: a.label, hubspotId: r.hubspotId, itemId: r.mondayItemId });
        continue;
      }
      const cid = await ensureCard(token, "contacts", a.hubspotId!);
      out.push({ ...a, itemId: cid });
    }
    return out;
  }

  async function save() {
    if (savingRef.current || !itemId) return;
    savingRef.current = true; setSaving(true); setErr(null);
    try {
      const cv = companyFormToColumnValues(form);
      if (Object.keys(cv).length) await updateItemColumns(COMPANY_BOARD, itemId, cv);
      if (form.domain && form.domain !== origDomain) await renameItem(COMPANY_BOARD, itemId, form.domain);
      const rc = await resolveContacts(contacts);
      setContacts(rc);
      await updateItemColumns(COMPANY_BOARD, itemId, { [COMPANY_REL_CONTACT]: { item_ids: [...new Set(rc.map(c => Number(c.itemId)))] } });
      // Unlink contacts removed since open (reverseAssociations never deletes).
      for (const o of origContacts) {
        if (o.hubspotId && !rc.some(c => c.hubspotId === o.hubspotId))
          try { await deleteHubspotAssociation(token, "companies", company.hubspotId, "contacts", o.hubspotId); } catch { /* best effort */ }
      }
      setOrigContacts(rc);
      await syncCompany(token, itemId);       // reverse fields + contact links to HubSpot
      setDirty(false); onSaved?.(); onClose();
    } catch (e) {
      setErr("Save failed — press Save to retry. " + String(e).slice(0, 200));
    } finally { setSaving(false); savingRef.current = false; }
  }

  // HubSpot-only deal association add/remove.
  const dealSearch = useDebouncedSearch<{ id: string; name: string; secondary: string }>(
    async (q, signal) => { const r = await searchHubspot(token, "deals", q, signal); return { items: r.items, total: r.total }; });
  async function addDeal(hsDealId: string, name: string) {
    if (deals.some(d => d.hubspotId === hsDealId)) return;
    setDeals(d => [...d, { hubspotId: hsDealId, name }]);
    try { await addHubspotAssociation(token, "companies", company.hubspotId, "deals", hsDealId); } catch { setDeals(d => d.filter(x => x.hubspotId !== hsDealId)); }
  }
  async function removeDeal(hsDealId: string) {
    setDeals(d => d.filter(x => x.hubspotId !== hsDealId));
    try { await deleteHubspotAssociation(token, "companies", company.hubspotId, "deals", hsDealId); } catch { /* best effort */ }
  }

  const footer = (
    <>
      <button className="dc-btn" onClick={guardedClose}>Cancel</button>
      <button className="dc-btn dc-btn-primary" disabled={saving || !loaded} onClick={() => { if (!saving) void save(); }}>
        {saving ? "Saving…" : "Save changes"}
      </button>
    </>
  );
  const headerRight = (
    <>
      <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("companies", company.hubspotId))}>↗ HubSpot</button>
      {itemId && <button className="dc-btn dc-btn-sm" onClick={() => openItemCard(itemId)}>↗ card</button>}
      <button className="dc-btn dc-btn-primary dc-btn-sm" onClick={() => onCreateDeal({ company: { hubspotId: company.hubspotId, name: title } })}>＋ Deal</button>
    </>
  );

  return (
    <DrawerShell title={loaded ? (form.name || form.domain || title) : title} ariaLabel={`Edit company ${title}`} onClose={guardedClose} headerRight={headerRight} footer={footer}>
      {!loaded && !err && <div className="dc-mut">Loading company…</div>}
      {err && <div className="dc-err">{err}</div>}
      {loaded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="dc-section-title">Company</div>
          <div className="dc-grid">
            <Field label="Company name"><input className="dc-field-input" value={form.name ?? ""} onChange={e => set({ name: e.target.value })} /></Field>
            <Field label="Domain"><input className="dc-field-input" value={form.domain ?? ""} onChange={e => set({ domain: e.target.value })} /></Field>
            <Field label="Industry"><SelectStr options={enumOpts(schema, "industry")} value={form.industry} onChange={v => set({ industry: v })} placeholder="—" /></Field>
            <Field label="Type"><SelectStr options={enumOpts(schema, "type")} value={form.type} onChange={v => set({ type: v })} placeholder="—" /></Field>
            <Field label="Sales user"><SelectOpt options={userOpts} value={form.salesUserId} onChange={v => set({ salesUserId: v })} placeholder="No sales user" /></Field>
            <Field label="Owner"><SelectOpt options={userOpts} value={form.ownerId} onChange={v => set({ ownerId: v })} placeholder="No owner" /></Field>
            <Field label="City"><input className="dc-field-input" value={form.city ?? ""} onChange={e => set({ city: e.target.value })} /></Field>
            <Field label="State"><input className="dc-field-input" value={form.state ?? ""} onChange={e => set({ state: e.target.value })} /></Field>
            <Field label="Employees"><input className="dc-field-input" value={form.employees ?? ""} onChange={e => set({ employees: e.target.value })} /></Field>
            <Field label="Annual revenue"><input className="dc-field-input" value={form.revenue ?? ""} onChange={e => set({ revenue: e.target.value })} /></Field>
            <Field label="LinkedIn"><input className="dc-field-input" value={form.linkedin ?? ""} onChange={e => set({ linkedin: e.target.value })} /></Field>
          </div>
          <Field label="Description"><textarea className="dc-field-input" rows={3} value={form.description ?? ""} onChange={e => set({ description: e.target.value })} /></Field>

          <div className="dc-section-title">Contacts</div>
          <AssociationSection kind="contact" token={token} schema={schema} value={contacts} onChange={next => { setDirty(true); setContacts(next); }} />

          <div className="dc-section-title">Deals</div>
          <div className="dc-search">
            <input className="dc-input" placeholder="Search a deal to link…" onChange={e => dealSearch.query(e.target.value)} />
          </div>
          {dealSearch.hits.length > 0 && (
            <div className="dc-picker-results">
              {dealSearch.hits.map(h => <button key={h.id} className="dc-picker-row" onClick={() => { addDeal(h.id, h.name); dealSearch.clear(); }}>＋ {h.name}</button>)}
            </div>
          )}
          <div className="dc-contact-list">
            {deals.length === 0 && <div className="dc-mut">No linked deals.</div>}
            {deals.map(d => (
              <div key={d.hubspotId} className="dc-contact-row">
                <span className="dc-contact-name">{orDash(d.name)}</span>
                <div className="dc-contact-actions">
                  <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("deals", d.hubspotId))}>↗</button>
                  <button className="dc-btn dc-btn-sm" onClick={() => void removeDeal(d.hubspotId)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </DrawerShell>
  );
}
