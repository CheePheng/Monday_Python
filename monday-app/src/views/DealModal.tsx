import { useEffect, useState } from "react";
import { Button } from "@vibe/core";
import type { BoardState } from "../useBoard";
import { dealFormToColumnValues, boardRelationValue, type DealForm } from "../lib/columns";
import { groupIdForStage, stageOptions } from "../lib/stage";
import { DEAL_COLS } from "../board-config";
import { createDeal, updateDealColumns, renameDeal, moveToGroup, getSubitems, getDeals } from "../monday-client";
import { colText } from "../useBoard";
import AssociationPicker, { type Assoc } from "./AssociationPicker";
import LineItemsEditor, { persistLineItems, type LineItem } from "./LineItemsEditor";
import UpdatesPanel from "./UpdatesPanel";
import { SUB_COLS } from "../board-config";

interface Props { itemId: string | null; board: BoardState; onClose: () => void; onSaved: (msg: string) => void }

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex",
  alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", zIndex: 1000, overflowY: "auto",
};
const panel: React.CSSProperties = {
  background: "var(--primary-background-color, #fff)", color: "var(--primary-text-color, #323338)",
  borderRadius: 8, width: "100%", maxWidth: 720, padding: 20, boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
};
const field: React.CSSProperties = { padding: "6px 10px", width: "100%", boxSizing: "border-box" };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: 1 };

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

  // Edit mode: hydrate from the existing card + its subitems.
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
      const subs = await getSubitems(itemId!);
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
      // 1) Parent item: create once (persisted) or update.
      let parentId = createdItemId;
      if (!parentId) {
        const groupId = groupIdForStage(form.stage ?? stages[0], board.meta!.groups) ?? board.meta!.groups[0].id;
        parentId = await createDeal(groupId, name || "New Deal", dealFormToColumnValues(form));
        setCreatedItemId(parentId); // from here on, retries reuse this id and never create a second deal
      } else if (isEdit) {
        await renameDeal(parentId, name);
        await updateDealColumns(parentId, dealFormToColumnValues(form));
        const gid = form.stage ? groupIdForStage(form.stage, board.meta!.groups) : undefined;
        if (gid) await moveToGroup(parentId, gid);
      }
      // 2) Associations: link the found/created cards on the deal's relation columns.
      await updateDealColumns(parentId, {
        [DEAL_COLS.contact.id]: boardRelationValue(contacts.map(c => c.itemId)),
        [DEAL_COLS.company.id]: boardRelationValue(companies.map(c => c.itemId)),
      });
      // 3) Line items: create new subitems / update+mirror synced ones.
      const persisted = await persistLineItems(board.sessionToken, parentId, lineItems);
      setLineItems(persisted);
      onSaved(isEdit ? "Deal updated" : "Deal created — syncing to HubSpot…");
    } catch (e) {
      setErr(`Save failed at a step — press Save to retry (the deal is not duplicated). ${String(e).slice(0, 160)}`);
    } finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{isEdit ? "Edit Deal" : "Create Deal"}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={labelStyle}>Deal name
            <input value={name} onChange={e => setName(e.target.value)} style={field} /></label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label style={labelStyle}>Amount
              <input value={form.amount ?? ""} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={field} /></label>
            <label style={labelStyle}>Currency
              <input value={form.currency ?? ""} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))} style={field} /></label>
            <label style={labelStyle}>Close date (YYYY-MM-DD)
              <input value={form.closeDate ?? ""} onChange={e => setForm(f => ({ ...f, closeDate: e.target.value }))} style={field} /></label>
          </div>
          <label style={labelStyle}>Stage
            <select value={form.stage ?? ""} onChange={e => setForm(f => ({ ...f, stage: e.target.value }))} style={field}>
              <option value="">Select stage…</option>
              {stages.map(s => <option key={s} value={s}>{s}</option>)}
            </select></label>

          <AssociationPicker kind="contacts" token={board.sessionToken} dealHubspotId={dealHubspotId}
            value={contacts} onChange={setContacts} />
          <AssociationPicker kind="companies" token={board.sessionToken} dealHubspotId={dealHubspotId}
            value={companies} onChange={setCompanies} />
          <LineItemsEditor token={board.sessionToken} value={lineItems} onChange={setLineItems} />
          {isEdit && itemId && <UpdatesPanel itemId={itemId} />}
          {err && <div style={{ color: "#d83a52" }}>{err}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <Button kind="tertiary" onClick={onClose}>Cancel</Button>
          <Button loading={saving} disabled={saving} onClick={() => { if (!saving) void save(); }}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
