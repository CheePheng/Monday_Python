import { useEffect, useState } from "react";
import type { BoardState } from "../useBoard";
import { dealFormToColumnValues, boardRelationValue, type DealForm } from "../lib/columns";
import { groupIdForStage, stageOptions } from "../lib/stage";
import { DEAL_COLS, SUB_COLS, CONTACT_ID_COL, COMPANY_ID_COL } from "../board-config";
import {
  createDeal, updateDealColumns, renameDeal, moveToGroup, getSubitems, getDeals, getCardsByIds,
} from "../monday-client";
import { colText, linkedIds } from "../useBoard";
import AssociationPicker, { type Assoc } from "./AssociationPicker";
import LineItemsEditor, { persistLineItems, type LineItem } from "./LineItemsEditor";
import UpdatesPanel from "./UpdatesPanel";

interface Props { itemId: string | null; board: BoardState; onClose: () => void; onSaved: (msg: string) => void }

export default function DealModal({ itemId, board, onClose, onSaved }: Props) {
  const isEdit = itemId != null;
  const [name, setName] = useState("");
  const [form, setForm] = useState<DealForm>({ salesUserIds: [board.userId] });
  const [contacts, setContacts] = useState<Assoc[]>([]);
  const [companies, setCompanies] = useState<Assoc[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [dealHubspotId, setDealHubspotId] = useState<string | null>(null);
  const [createdItemId, setCreatedItemId] = useState<string | null>(itemId); // persist so retries never re-create the parent
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stages = board.meta ? stageOptions(board.meta.groups) : [];

  useEffect(() => {
    if (!isEdit || !board.meta) return;
    void (async () => {
      const items = await getDeals();
      const it = items.find(i => i.id === itemId);
      if (!it) return;
      setName(it.name);
      setDealHubspotId(colText(it, DEAL_COLS.hubspotDealId.id) || null);
      setForm({
        amount: colText(it, DEAL_COLS.amount.id), currency: colText(it, DEAL_COLS.currency.id),
        closeDate: colText(it, DEAL_COLS.closeDate.id), stage: colText(it, DEAL_COLS.stage.id),
        dealType: colText(it, DEAL_COLS.dealType.id), priority: colText(it, DEAL_COLS.priority.id),
      });
      const [subs, contactCards, companyCards] = await Promise.all([
        getSubitems(itemId!),
        getCardsByIds(linkedIds(it, DEAL_COLS.contact.id), CONTACT_ID_COL),
        getCardsByIds(linkedIds(it, DEAL_COLS.company.id), COMPANY_ID_COL),
      ]);
      setContacts(contactCards.map(c => ({ hubspotId: c.hubspotId, itemId: c.itemId, label: c.name })));
      setCompanies(companyCards.map(c => ({ hubspotId: c.hubspotId, itemId: c.itemId, label: c.name })));
      setLineItems(subs.map(su => ({
        subitemId: su.id, name: su.name,
        lineItemId: su.column_values.find(c => c.id === SUB_COLS.lineItemId.id)?.text || undefined,
        productId: su.column_values.find(c => c.id === SUB_COLS.productId.id)?.text || undefined,
        unitPrice: su.column_values.find(c => c.id === SUB_COLS.unitPrice.id)?.text || "",
        quantity: su.column_values.find(c => c.id === SUB_COLS.quantity.id)?.text || "",
      })));
    })();
  }, [isEdit, itemId, board.meta]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      let parentId = createdItemId;
      if (!parentId) {
        const groupId = groupIdForStage(form.stage ?? stages[0], board.meta!.groups) ?? board.meta!.groups[0].id;
        parentId = await createDeal(groupId, name || "New Deal", dealFormToColumnValues(form));
        setCreatedItemId(parentId); // retries reuse this id, never create a second deal
      } else if (isEdit) {
        await renameDeal(parentId, name);
        await updateDealColumns(parentId, dealFormToColumnValues(form));
        const gid = form.stage ? groupIdForStage(form.stage, board.meta!.groups) : undefined;
        if (gid) await moveToGroup(parentId, gid);
      }
      await updateDealColumns(parentId, {
        [DEAL_COLS.contact.id]: boardRelationValue(contacts.map(c => c.itemId)),
        [DEAL_COLS.company.id]: boardRelationValue(companies.map(c => c.itemId)),
      });
      const persisted = await persistLineItems(board.sessionToken, parentId, lineItems);
      setLineItems(persisted);
      onSaved(isEdit ? "Deal updated" : "Deal created — syncing to HubSpot…");
    } catch (e) {
      setErr(`Save failed at a step — press Save to retry (the deal is not duplicated). ${String(e).slice(0, 160)}`);
    } finally { setSaving(false); }
  }

  const set = (p: Partial<DealForm>) => setForm(f => ({ ...f, ...p }));

  return (
    <div className="dc-backdrop" onClick={onClose}>
      <div className="dc-modal" onClick={e => e.stopPropagation()}>
        <div className="dc-modal-head">
          <h2>{isEdit ? "Edit deal" : "Create deal"}</h2>
          <button className="dc-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="dc-modal-body">
          <div className="dc-field">
            <label className="dc-field-label">Deal name</label>
            <input className="dc-field-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Acme — Q3 Renewal" />
          </div>

          <div className="dc-grid">
            <div className="dc-field"><label className="dc-field-label">Amount</label>
              <input className="dc-field-input" value={form.amount ?? ""} onChange={e => set({ amount: e.target.value })} placeholder="0" /></div>
            <div className="dc-field"><label className="dc-field-label">Currency</label>
              <input className="dc-field-input" value={form.currency ?? ""} onChange={e => set({ currency: e.target.value })} placeholder="USD" /></div>
            <div className="dc-field"><label className="dc-field-label">Close date</label>
              <input className="dc-field-input" value={form.closeDate ?? ""} onChange={e => set({ closeDate: e.target.value })} placeholder="YYYY-MM-DD" /></div>
          </div>

          <div className="dc-field">
            <label className="dc-field-label">Stage</label>
            <select className="dc-field-input" value={form.stage ?? ""} onChange={e => set({ stage: e.target.value })}>
              <option value="">Select stage…</option>
              {stages.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="dc-card">
            <AssociationPicker kind="contacts" token={board.sessionToken} dealHubspotId={dealHubspotId} value={contacts} onChange={setContacts} />
          </div>
          <div className="dc-card">
            <AssociationPicker kind="companies" token={board.sessionToken} dealHubspotId={dealHubspotId} value={companies} onChange={setCompanies} />
          </div>
          <div className="dc-card">
            <LineItemsEditor token={board.sessionToken} value={lineItems} onChange={setLineItems} />
          </div>
          {isEdit && itemId && <div className="dc-card"><UpdatesPanel itemId={itemId} /></div>}

          {err && <div className="dc-err">{err}</div>}
        </div>

        <div className="dc-modal-foot">
          <button className="dc-btn" onClick={onClose}>Cancel</button>
          <button className="dc-btn dc-btn-primary" disabled={saving} onClick={() => { if (!saving) void save(); }}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create deal"}
          </button>
        </div>
      </div>
    </div>
  );
}
