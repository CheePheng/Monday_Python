import { useEffect, useState } from "react";
import { Modal, ModalContent, ModalFooterButtons, TextField, Dropdown } from "@vibe/core";
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

const row: React.CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap" };
const col: React.CSSProperties = { flex: 1, minWidth: 160 };

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

  // Edit mode: hydrate from the existing card + its subitems + its linked association cards.
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

  const stageValue = form.stage ? { label: form.stage, value: form.stage } : undefined;

  return (
    <Modal id="deal-cockpit-modal" show title={isEdit ? "Edit Deal" : "Create Deal"} onClose={onClose} width="720px">
      <ModalContent>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <TextField title="Deal name" value={name} onChange={setName} />
          <div style={row}>
            <div style={col}><TextField title="Amount" value={form.amount ?? ""} onChange={v => setForm(f => ({ ...f, amount: v }))} /></div>
            <div style={col}><TextField title="Currency" value={form.currency ?? ""} onChange={v => setForm(f => ({ ...f, currency: v }))} /></div>
            <div style={col}><TextField title="Close date (YYYY-MM-DD)" value={form.closeDate ?? ""} onChange={v => setForm(f => ({ ...f, closeDate: v }))} /></div>
          </div>
          <div>
            <div style={{ fontSize: 13, marginBottom: 4 }}>Stage</div>
            <Dropdown placeholder="Select stage…" clearable value={stageValue}
              options={stages.map(s => ({ label: s, value: s }))}
              onOptionSelect={(o: any) => setForm(f => ({ ...f, stage: o?.value }))}
              onClear={() => setForm(f => ({ ...f, stage: undefined }))} />
          </div>
          <AssociationPicker kind="contacts" token={board.sessionToken} dealHubspotId={dealHubspotId} value={contacts} onChange={setContacts} />
          <AssociationPicker kind="companies" token={board.sessionToken} dealHubspotId={dealHubspotId} value={companies} onChange={setCompanies} />
          <LineItemsEditor token={board.sessionToken} value={lineItems} onChange={setLineItems} />
          {isEdit && itemId && <UpdatesPanel itemId={itemId} />}
          {err && <div style={{ color: "#d83a52" }}>{err}</div>}
        </div>
      </ModalContent>
      <ModalFooterButtons
        primaryButtonText={saving ? "Saving…" : "Save"}
        secondaryButtonText="Cancel"
        onPrimaryButtonClick={() => { if (!saving) void save(); }}
        onSecondaryButtonClick={onClose}
      />
    </Modal>
  );
}
