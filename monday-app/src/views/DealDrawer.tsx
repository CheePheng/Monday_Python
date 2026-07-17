import { useEffect, useState } from "react";
import type { BoardState } from "../useBoard";
import { dealFormToColumnValues, deliberateClears, boardRelationValue, type DealForm } from "../lib/columns";
import { groupIdForStage, stageOptions } from "../lib/stage";
import { DEAL_COLS, SUB_COLS, CONTACT_ID_COL, COMPANY_ID_COL, hubspotDealUrl } from "../board-config";
import {
  createDeal, updateDealColumns, renameDeal, moveToGroup, getSubitems, getDeal, getCardsByIds, openLink,
  findOrCreateContact, findOrCreateCompany, createContactCard, createCompanyCard,
} from "../monday-client";
import { deleteHubspotAssociation } from "../worker-client";
import { validateDealForm } from "../lib/validate";
import { colText, linkedIds, peopleIds } from "../useBoard";
import AssociationPicker, { type Assoc } from "./AssociationPicker";
import LineItemsEditor, { persistLineItems, type LineItem } from "./LineItemsEditor";
import UpdatesPanel from "./UpdatesPanel";
import { Field, SelectStr, SelectOpt, ChipMulti, type Opt } from "./FormFields";
import { syncDeal, clearDealFields } from "../worker-client";

interface Props { itemId: string | null; board: BoardState; onClose: () => void; onSaved: (msg: string) => void; onDirtyChange?: (dirty: boolean) => void }

const pick = (arr: string[], re: RegExp) => arr.find(x => re.test(x)) ?? arr[0];
const splitCsv = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);

export default function DealDrawer({ itemId, board, onClose, onSaved, onDirtyChange }: Props) {
  const isEdit = itemId != null;
  const stages = board.meta ? stageOptions(board.meta.groups) : [];
  const userOpts: Opt[] = board.users.map(u => ({ value: u.id, label: u.name || u.email || u.id }));
  const vendorOpts: Opt[] = board.options.vendors.map(v => ({ value: v, label: v }));

  const [name, setName] = useState("");
  const [form, setForm] = useState<DealForm>(() => isEdit ? { salesUserIds: [], vendors: [] } : {
    pipeline: pick(board.options.pipeline, /sales pipeline/i),
    currency: pick(board.options.currency, /usd|dollar/i),
    stage: stages[0],
    salesUserIds: board.userId ? [board.userId] : [],
    dealOwnerId: board.userId || undefined,
    vendors: [],
  });
  const [contacts, setContacts] = useState<Assoc[]>([]);
  const [companies, setCompanies] = useState<Assoc[]>([]);
  // What was linked when the drawer opened — the baseline for working out what to unlink on Save.
  const [origContacts, setOrigContacts] = useState<Assoc[]>([]);
  const [origCompanies, setOrigCompanies] = useState<Assoc[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [dealHubspotId, setDealHubspotId] = useState<string | null>(null);
  const [syncState, setSyncState] = useState("");
  const [createdItemId, setCreatedItemId] = useState<string | null>(itemId);
  const [saving, setSaving] = useState(false);
  // Nothing may be cleared from a form that didn't fully load: `loaded` gates Save, and `origForm` is
  // the baseline that decides whether an empty box is a deliberate clear or was simply never filled.
  const [loaded, setLoaded] = useState(!isEdit);
  const [origForm, setOrigForm] = useState<DealForm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [childErr, setChildErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [tab, setTab] = useState<"overview" | "associations" | "lineItems" | "updates" | "sync">("overview");
  const [advanced, setAdvanced] = useState(false);
  const TABS: { id: typeof tab; label: string }[] = [
    { id: "overview", label: "Overview" }, { id: "associations", label: "Associations" },
    { id: "lineItems", label: "Line Items" },
    ...(isEdit ? [{ id: "updates" as const, label: "Updates" }, { id: "sync" as const, label: "Sync" }] : []),
  ];

  useEffect(() => {
    if (!isEdit || !board.meta) return;
    void (async () => {
      try {
      const it = await getDeal(itemId!);
      if (!it) { setErr("Couldn't load this deal. Close and reopen it before saving."); return; }
      setName(it.name);
      setDealHubspotId(colText(it, DEAL_COLS.hubspotDealId.id) || null);
      setSyncState(colText(it, "text_mm4xxyzx"));
      const loadedForm: DealForm = {
        amount: colText(it, DEAL_COLS.amount.id), currency: colText(it, DEAL_COLS.currency.id),
        closeDate: colText(it, DEAL_COLS.closeDate.id), stage: colText(it, DEAL_COLS.stage.id),
        pipeline: colText(it, DEAL_COLS.pipeline.id),
        dealType: colText(it, DEAL_COLS.dealType.id), priority: colText(it, DEAL_COLS.priority.id),
        vendors: splitCsv(colText(it, DEAL_COLS.vendors.id)),
        salesUserIds: peopleIds(it, DEAL_COLS.salesUsers.id),
        dealOwnerId: peopleIds(it, DEAL_COLS.dealOwner.id)[0],
      };
      setForm(loadedForm);
      setOrigForm(loadedForm); // baseline: what was actually on the deal when it opened
      const [subs, contactCards, companyCards] = await Promise.all([
        getSubitems(itemId!),
        getCardsByIds(linkedIds(it, DEAL_COLS.contact.id), CONTACT_ID_COL),
        getCardsByIds(linkedIds(it, DEAL_COLS.company.id), COMPANY_ID_COL),
      ]);
      const cs = contactCards.map(c => ({ hubspotId: c.hubspotId, itemId: c.itemId, label: c.name }));
      const cos = companyCards.map(c => ({ hubspotId: c.hubspotId, itemId: c.itemId, label: c.name }));
      setContacts(cs); setOrigContacts(cs);
      setCompanies(cos); setOrigCompanies(cos);
      // Hydrate EVERY field the save writes back. Anything left undefined here is sent to HubSpot as a
      // blank on the next save — that's how discounts were being wiped by simply opening and saving.
      setLineItems(subs.map((su): LineItem => {
        const col = (id: string) => su.column_values.find(c => c.id === id)?.text || "";
        const discount = col(SUB_COLS.discount.id);
        const discountPct = col(SUB_COLS.discountPct.id);
        return {
          subitemId: su.id, name: su.name,
          lineItemId: col(SUB_COLS.lineItemId.id) || undefined,
          productId: col(SUB_COLS.productId.id) || undefined,
          unitPrice: col(SUB_COLS.unitPrice.id),
          quantity: col(SUB_COLS.quantity.id),
          currency: col(SUB_COLS.currency.id) || undefined,
          description: col(SUB_COLS.description.id) || undefined,
          serviceDate: col(SUB_COLS.serviceDate.id) || undefined,
          discount: discount || undefined,
          discountPct: discountPct || undefined,
          discountMode: discountPct ? "percent" : "amount",
        };
      }));
      // Only now is the form a faithful copy of the deal. Save stays disabled until this point, so a
      // half-loaded drawer can never blank a field or unlink an association it simply didn't fetch.
      setLoaded(true);
      } catch (e) {
        setErr("Couldn't load this deal. Close and reopen it before saving. " + String(e).slice(0, 120));
      }
    })();
  }, [isEdit, itemId, board.meta]);

  const set = (p: Partial<DealForm>) => { setDirty(true); setForm(f => ({ ...f, ...p })); };
  const invalid = validateDealForm(name, form);

  function guardedClose() {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") guardedClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty]);

  // Report dirty state up so the board can guard a deal switch (row click / Create) on unsaved edits.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);

  /** Create/find the monday card for each staged association. Rows that already have an itemId are left
   * alone, so a retry can never create a second card for the same record. */
  async function resolveAssocs(list: Assoc[], kind: "contacts" | "companies"): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      const itemId = a.create
        ? (a.create.kind === "contact"
          ? await createContactCard({ name: a.create.name, email: a.create.email, phone: a.create.phone })
          : await createCompanyCard({ name: a.create.name, domain: a.create.domain }))
        : (kind === "contacts"
          ? await findOrCreateContact(a.hubspotId, a.label)
          : await findOrCreateCompany(a.hubspotId, a.label));
      out.push({ ...a, itemId });
    }
    return out;
  }

  /** Unlink in HubSpot whatever was removed from the drawer since it opened. Best-effort: the board
   * relation column is the source of truth for the link, so a failure here shouldn't fail the save. */
  async function unlinkRemoved(orig: Assoc[], current: Assoc[], kind: "contacts" | "companies") {
    if (!dealHubspotId) return;
    for (const o of orig) {
      if (!o.hubspotId || !o.itemId) continue;
      if (current.some(c => c.itemId === o.itemId)) continue;
      try { await deleteHubspotAssociation(board.sessionToken, kind, dealHubspotId, o.hubspotId); }
      catch (e) { setChildErr("Couldn't unlink in HubSpot: " + String(e).slice(0, 120)); }
    }
  }

  async function save() {
    setSaving(true); setErr(null);
    try {
      // Only an edit can clear: a create has no prior value to remove, and origForm is the proof the
      // deal actually loaded. Amount/Close date/Sales Users emptied by the rep are cleared on BOTH
      // sides; every other field is still just omitted when empty.
      const clears = origForm ? deliberateClears(origForm, form) : {};
      let parentId = createdItemId;
      if (!parentId) {
        const stage = form.stage ?? stages[0];
        // Don't fall back to groups[0] — that's "Unassigned Deals", so an unresolved stage would file
        // the deal in the wrong group instead of telling anyone.
        const groupId = groupIdForStage(stage, board.meta!.groups);
        if (!groupId) throw new Error(`No group matches the stage "${stage}"`);
        parentId = await createDeal(groupId, name || "New Deal", dealFormToColumnValues(form));
        setCreatedItemId(parentId); // retries reuse this id, never create a second deal
      } else {
        // Also covers retrying a create whose later steps failed: the item already exists, so re-apply
        // the form to it rather than skipping (edits made before the retry would otherwise be lost).
        await renameDeal(parentId, name);
        await updateDealColumns(parentId, dealFormToColumnValues(form, clears));
        const gid = form.stage ? groupIdForStage(form.stage, board.meta!.groups) : undefined;
        if (gid) await moveToGroup(parentId, gid);
      }
      // Staged associations become real only now, at Save.
      const rc = await resolveAssocs(contacts, "contacts");
      const rco = await resolveAssocs(companies, "companies");
      setContacts(rc); setCompanies(rco); // keep the ids so a retry reuses the cards
      await updateDealColumns(parentId, {
        [DEAL_COLS.contact.id]: boardRelationValue(rc.map(c => c.itemId!)),
        [DEAL_COLS.company.id]: boardRelationValue(rco.map(c => c.itemId!)),
      });
      await unlinkRemoved(origContacts, rc, "contacts");
      await unlinkRemoved(origCompanies, rco, "companies");
      setOrigContacts(rc); setOrigCompanies(rco);
      const persisted = await persistLineItems(board.sessionToken, parentId, lineItems);
      setLineItems(persisted);
      // Push the rep's deliberate clears to HubSpot. The sync can never do this itself: an empty monday
      // value is indistinguishable from "never set" (and for people columns means "heal from HubSpot"),
      // so the intent has to travel with the action. Empties nothing unless the rep emptied it.
      const clearProps = [
        ...(clears.amount ? ["amount"] : []),
        ...(clears.closeDate ? ["closedate"] : []),
        ...(clears.salesUsers ? ["sales_user"] : []),
      ];
      if (dealHubspotId && clearProps.length)
        await clearDealFields(board.sessionToken, dealHubspotId, clearProps);
      try { await syncDeal(board.sessionToken, parentId); } catch { /* webhook is the fallback; don't fail the save */ }
      onSaved(isEdit ? "Deal updated" : "Deal created — syncing to HubSpot…");
    } catch (e) {
      setErr(`Save failed at a step — press Save to retry (the deal is not duplicated). ${String(e).slice(0, 400)}`);
    } finally { setSaving(false); }
  }

  return (
    <>
      <div className="dc-drawer" role="dialog" aria-label={isEdit ? "Edit deal" : "Create deal"}>
        <div className="dc-modal-head">
          <h2>{isEdit ? "Edit deal" : "Create deal"}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isEdit && dealHubspotId && (
              <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotDealUrl(dealHubspotId))}>↗ HubSpot</button>
            )}
            <button className="dc-x" onClick={guardedClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="dc-tabs">
          {TABS.map(t => (
            <button key={t.id} className={"dc-tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        <div className="dc-drawer-body">
          {tab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label="Deal name" required>
                <input className="dc-field-input" value={name} onChange={e => { setDirty(true); setName(e.target.value); }} placeholder="e.g. Acme — Q3 Renewal" />
              </Field>
              {invalid.errors.name && <div className="dc-err">{invalid.errors.name}</div>}

              <div className="dc-grid">
                <Field label="Deal stage" required>
                  <SelectStr options={stages} value={form.stage} onChange={v => set({ stage: v })} placeholder="Select stage…" />
                  {invalid.errors.stage && <div className="dc-err">{invalid.errors.stage}</div>}
                </Field>
              </div>

              <div className="dc-grid">
                <Field label="Amount">
                  <input className="dc-field-input" value={form.amount ?? ""} onChange={e => set({ amount: e.target.value })} placeholder="0" />
                  {invalid.errors.amount && <div className="dc-err">{invalid.errors.amount}</div>}
                </Field>
                <Field label="Currency"><SelectStr options={board.options.currency} value={form.currency} onChange={v => set({ currency: v })} /></Field>
                <Field label="Close date"><input className="dc-field-input" type="date" value={form.closeDate ?? ""} onChange={e => set({ closeDate: e.target.value })} /></Field>
              </div>

              <Field label="Sales Users">
                <ChipMulti options={userOpts} values={form.salesUserIds ?? []} onChange={v => set({ salesUserIds: v })} placeholder="Add sales user…" />
              </Field>

              <button type="button" className="dc-btn dc-btn-sm" onClick={() => setAdvanced(a => !a)}>
                {advanced ? "Hide details" : "More details"}
              </button>
              {advanced && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div className="dc-grid">
                    <Field label="Deal type"><SelectStr options={board.options.dealType} value={form.dealType} onChange={v => set({ dealType: v })} placeholder="—" /></Field>
                    <Field label="Priority"><SelectStr options={board.options.priority} value={form.priority} onChange={v => set({ priority: v })} placeholder="—" /></Field>
                  </div>
                  <div className="dc-grid">
                    <Field label="Vendors"><ChipMulti options={vendorOpts} values={form.vendors ?? []} onChange={v => set({ vendors: v })} placeholder="Add vendor…" /></Field>
                    <Field label="Deal owner"><SelectOpt options={userOpts} value={form.dealOwnerId} onChange={v => set({ dealOwnerId: v })} placeholder="No owner" /></Field>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "associations" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <AssociationPicker kind="contacts" token={board.sessionToken} value={contacts} onChange={next => { setDirty(true); setContacts(next); }} />
              <AssociationPicker kind="companies" token={board.sessionToken} value={companies} onChange={next => { setDirty(true); setCompanies(next); }} />
            </div>
          )}

          {tab === "lineItems" && (
            <LineItemsEditor token={board.sessionToken} value={lineItems} onChange={next => { setDirty(true); setLineItems(next); }} onError={setChildErr} onUseTotal={n => set({ amount: String(n) })} />
          )}

          {tab === "updates" && isEdit && itemId && <UpdatesPanel itemId={itemId} />}

          {tab === "sync" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="dc-section-title">Sync</div>
              <div>HubSpot Deal ID: {dealHubspotId ? <b>{dealHubspotId}</b> : <span className="dc-mut">Pending — creating in HubSpot…</span>}</div>
              <div className="dc-mut">Last synced: {syncState || "—"}</div>
              {dealHubspotId && <div><button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotDealUrl(dealHubspotId))}>↗ Open in HubSpot</button></div>}
            </div>
          )}

          {(err || childErr) && <div className="dc-err">{err || childErr}</div>}
        </div>

        <div className="dc-modal-foot">
          <button className="dc-btn" onClick={guardedClose}>Cancel</button>
          <button className="dc-btn dc-btn-primary" disabled={saving || !invalid.ok || !loaded} onClick={() => { if (!saving) void save(); }}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create deal"}
          </button>
        </div>
      </div>
    </>
  );
}
