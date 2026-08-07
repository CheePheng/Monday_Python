import { useEffect, useRef, useState } from "react";
import DrawerShell from "./DrawerShell";
import AssociationPicker from "./AssociationPicker";
import { Field, SelectStr, SelectOpt, type Opt } from "./FormFields";
import { CONTACT_COLS, CONTACT_REL_COMPANY, CONTACT_REL_DEAL, CONTACT_BOARD, COMPANY_ID_COL, DEALS_BOARD, DEAL_COLS, hubspotRecordUrl } from "../board-config";
import { getItem, updateItemColumns, renameItem, getCardsByIds, findItemByColumn, openLink, openItemCard, type AccountUser } from "../monday-client";
import {
  ensureCard, syncContact, getRecordAssociations, getContactSchema,
  addHubspotAssociation, deleteHubspotAssociation, type EnumProp,
} from "../worker-client";
import { contactFormToColumnValues, type ContactForm } from "../lib/contact-form";
import { boardRelationValue } from "../lib/columns";
import { mergeAssoc } from "../lib/assoc-merge";
import type { Assoc } from "../lib/assoc";
import { colText, linkedIds } from "../useBoard";
import { useConfirm } from "../confirm";
import type { ContactHit } from "../lib/contacts";

interface Props {
  contact: ContactHit; token: string; users: AccountUser[];
  onClose: () => void; onSaved?: () => void;
}
const enumOpts = (schema: Record<string, EnumProp>, key: string): string[] =>
  (schema[key]?.options ?? []).map(o => o.label);

export default function ContactDrawer({ contact, token, users, onClose, onSaved }: Props) {
  const confirm = useConfirm();
  const [itemId, setItemId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<ContactForm & { firstname?: string; phone?: string }>({});
  const [origFirstname, setOrigFirstname] = useState("");
  const [origPhone, setOrigPhone] = useState("");   // so an untouched phone is never re-written (keeps monday's country flag)
  const [companies, setCompanies] = useState<Assoc[]>([]);
  const [origCompanies, setOrigCompanies] = useState<Assoc[]>([]);
  const [deals, setDeals] = useState<Assoc[]>([]);
  const [origDeals, setOrigDeals] = useState<Assoc[]>([]);
  const [schema, setSchema] = useState<Record<string, EnumProp>>({});
  // Non-fatal: the HubSpot association read failed, so the lists below show the monday board links ONLY.
  // Surfaced instead of swallowed — an empty section is indistinguishable from "no associations" otherwise.
  const [assocWarn, setAssocWarn] = useState(false);
  const savingRef = useRef(false);
  const title = contact.name || contact.email || "Contact";
  const userOpts: Opt[] = users.map(u => ({ value: u.id, label: u.name || u.email || u.id }));
  const set = (p: Partial<typeof form>) => { setDirty(true); setForm(f => ({ ...f, ...p })); };

  useEffect(() => { getContactSchema(token).then(setSchema).catch(() => {}); }, [token]);

  // Hydrate: resolve the monday card, read its columns + relations, merge fresh HubSpot companies + deals.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const id = await ensureCard(token, "contacts", contact.hubspotId);
        const it = await getItem(id);
        if (!it || !alive) { if (alive) setErr("Couldn't load this contact. Close and reopen."); return; }
        const people = (col: string) => {
          try { return (JSON.parse(it.column_values.find(c => c.id === col)?.value ?? "{}").personsAndTeams ?? [])
            .filter((p: any) => p.kind === "person").map((p: any) => String(p.id)); } catch { return []; }
        };
        const f: ContactForm & { firstname?: string; phone?: string } = {
          firstname: it.name,
          lastname: colText(it as any, CONTACT_COLS.lastname.id),
          email: colText(it as any, CONTACT_COLS.email.id),
          jobtitle: colText(it as any, CONTACT_COLS.jobtitle.id),
          phone: colText(it as any, CONTACT_COLS.phone.id),
          salesUserId: people(CONTACT_COLS.salesUsers.id)[0],
          ownerId: people(CONTACT_COLS.owner.id)[0],
          leadStatus: colText(it as any, CONTACT_COLS.leadStatus.id),
          leadSource: colText(it as any, CONTACT_COLS.leadSource.id),
          vendor: colText(it as any, CONTACT_COLS.vendor.id),
        };
        const compCards = await getCardsByIds(linkedIds(it as any, CONTACT_REL_COMPANY), COMPANY_ID_COL);
        const dealCards = await getCardsByIds(linkedIds(it as any, CONTACT_REL_DEAL), DEAL_COLS.hubspotDealId.id);
        let hsFailed = false;
        const [hsCompanies, hsDeals] = await Promise.all([
          getRecordAssociations(token, "contacts", contact.hubspotId, "companies").catch(() => { hsFailed = true; return []; }),
          getRecordAssociations(token, "contacts", contact.hubspotId, "deals").catch(() => { hsFailed = true; return []; }),
        ]);
        const mCompanies = mergeAssoc(compCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name })),
          hsCompanies.map(c => ({ hubspotId: c.hubspotId, name: c.name })));
        const mDeals = mergeAssoc(dealCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name })),
          hsDeals.map(c => ({ hubspotId: c.hubspotId, name: c.name })));
        if (!alive) return;
        setItemId(id); setForm(f); setOrigFirstname(it.name); setOrigPhone(f.phone ?? "");
        setAssocWarn(hsFailed);
        setCompanies(mCompanies); setOrigCompanies(mCompanies);
        setDeals(mDeals); setOrigDeals(mDeals); setLoaded(true);
      } catch (e) { if (alive) setErr("Couldn't load this contact. " + String(e).slice(0, 120)); }
    })();
    return () => { alive = false; };
  }, [contact.hubspotId, token]);

  async function guardedClose() {
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", message: "This contact has edits that haven't been saved.", confirmLabel: "Discard changes", cancelLabel: "Keep editing" }))) return;
    onClose();
  }

  // companies: ensureCard creates a card if missing. deals: findItemByColumn (deals aren't ensureCard-creatable);
  // a deal with no board card stays HubSpot-only (added directly below).
  async function resolveCompanies(list: Assoc[]): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      out.push({ ...a, itemId: await ensureCard(token, "companies", a.hubspotId!) });
    }
    return out;
  }
  async function resolveDeals(list: Assoc[]): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      const cardId = await findItemByColumn(DEALS_BOARD, DEAL_COLS.hubspotDealId.id, a.hubspotId!);
      out.push(cardId ? { ...a, itemId: cardId } : a);   // not found -> HubSpot-only
    }
    return out;
  }

  async function save() {
    if (savingRef.current || !itemId) return;
    savingRef.current = true; setSaving(true); setErr(null);
    try {
      // Send phone ONLY when the rep actually changed it. monday's phone column stores a countryShortName
      // alongside the number, and our write emits just { phone } — so re-sending an untouched, hydrated
      // value would silently drop the country flag the rep picked, on every save of any other field.
      const cv = contactFormToColumnValues(form.phone === origPhone ? { ...form, phone: undefined } : form);
      if (Object.keys(cv).length) await updateItemColumns(CONTACT_BOARD, itemId, cv);
      if (form.firstname && form.firstname !== origFirstname) await renameItem(CONTACT_BOARD, itemId, form.firstname);
      const rc = await resolveCompanies(companies); setCompanies(rc);
      const rd = await resolveDeals(deals); setDeals(rd);
      await updateItemColumns(CONTACT_BOARD, itemId, {
        [CONTACT_REL_COMPANY]: boardRelationValue(rc.filter(c => c.itemId).map(c => c.itemId!)),
        [CONTACT_REL_DEAL]: boardRelationValue(rd.filter(d => d.itemId).map(d => d.itemId!)),
      });
      // Unlink removed (reverseAssociations never deletes).
      for (const o of origCompanies)
        if (o.hubspotId && !rc.some(c => c.hubspotId === o.hubspotId))
          try { await deleteHubspotAssociation(token, "contacts", contact.hubspotId, "companies", o.hubspotId); } catch { /* best effort */ }
      for (const o of origDeals)
        if (o.hubspotId && !rd.some(d => d.hubspotId === o.hubspotId))
          try { await deleteHubspotAssociation(token, "contacts", contact.hubspotId, "deals", o.hubspotId); } catch { /* best effort */ }
      // Deals with no board card (rare) aren't in the relation column, so push their HubSpot link directly.
      for (const d of rd)
        if (!d.itemId && d.hubspotId)
          try { await addHubspotAssociation(token, "contacts", contact.hubspotId, "deals", d.hubspotId); } catch { /* best effort */ }
      setOrigCompanies(rc); setOrigDeals(rd);
      await syncContact(token, itemId);   // reverse fields + push relation links to HubSpot
      setDirty(false); onSaved?.(); onClose();
    } catch (e) {
      setErr("Save failed — press Save to retry. " + String(e).slice(0, 200));
    } finally { setSaving(false); savingRef.current = false; }
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
      <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("contacts", contact.hubspotId))}>↗ HubSpot</button>
      {itemId && <button className="dc-btn dc-btn-sm" onClick={() => openItemCard(itemId)}>↗ card</button>}
    </>
  );

  return (
    <DrawerShell title={loaded ? ((form.firstname || "") + " " + (form.lastname || "")).trim() || title : title} ariaLabel={`Edit contact ${title}`} onClose={guardedClose} headerRight={headerRight} footer={footer}>
      {!loaded && !err && <div className="dc-mut">Loading contact…</div>}
      {err && <div className="dc-err">{err}</div>}
      {loaded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="dc-section-title">Contact</div>
          <div className="dc-grid">
            <Field label="First name"><input className="dc-field-input" value={form.firstname ?? ""} onChange={e => set({ firstname: e.target.value })} /></Field>
            <Field label="Last name"><input className="dc-field-input" value={form.lastname ?? ""} onChange={e => set({ lastname: e.target.value })} /></Field>
            <Field label="Email"><input className="dc-field-input" value={form.email ?? ""} onChange={e => set({ email: e.target.value })} /></Field>
            <Field label="Job title"><input className="dc-field-input" value={form.jobtitle ?? ""} onChange={e => set({ jobtitle: e.target.value })} /></Field>
            <Field label="Phone"><input className="dc-field-input" value={form.phone ?? ""} onChange={e => set({ phone: e.target.value })} /></Field>
            <Field label="Sales user"><SelectOpt options={userOpts} value={form.salesUserId} onChange={v => set({ salesUserId: v })} placeholder="No sales user" /></Field>
            <Field label="Owner"><SelectOpt options={userOpts} value={form.ownerId} onChange={v => set({ ownerId: v })} placeholder="No owner" /></Field>
            <Field label="Lead status"><SelectStr options={enumOpts(schema, "hs_lead_status")} value={form.leadStatus} onChange={v => set({ leadStatus: v })} placeholder="—" /></Field>
            <Field label="Lead source"><SelectStr options={enumOpts(schema, "leadsource")} value={form.leadSource} onChange={v => set({ leadSource: v })} placeholder="—" /></Field>
            <Field label="Vendor"><SelectStr options={enumOpts(schema, "manufacturer__c")} value={form.vendor} onChange={v => set({ vendor: v })} placeholder="—" /></Field>
          </div>

          {assocWarn && (
            <div className="dc-err">
              Couldn't load HubSpot associations — showing this card's board links only. Saving now could drop
              links that exist in HubSpot; close and reopen to retry.
            </div>
          )}
          {/* AssociationPicker renders its own "Companies"/"Deals" section title — no preceding heading. */}
          <AssociationPicker kind="companies" token={token} value={companies} onChange={next => { setDirty(true); setCompanies(next); }} />
          <AssociationPicker kind="deals" token={token} value={deals} onChange={next => { setDirty(true); setDeals(next); }} />
        </div>
      )}
    </DrawerShell>
  );
}
