import { useEffect, useState } from "react";
import type { BoardState } from "../useBoard";
import { dealFormToColumnValues, boardRelationValue, type DealForm } from "../lib/columns";
import { groupIdForStage, stageOptions } from "../lib/stage";
import { DEAL_COLS, SUB_COLS, CONTACT_ID_COL, COMPANY_ID_COL, hubspotDealUrl } from "../board-config";
import {
  createDeal, updateDealColumns, renameDeal, moveToGroup, getSubitems, getDeal, getCardsByIds, openLink,
} from "../monday-client";
import { validateDealForm } from "../lib/validate";
import { colText, linkedIds, peopleIds } from "../useBoard";
import AssociationPicker, { type Assoc } from "./AssociationPicker";
import LineItemsEditor, { persistLineItems, type LineItem } from "./LineItemsEditor";
import UpdatesPanel from "./UpdatesPanel";
import { Field, SelectStr, SelectOpt, ChipMulti, type Opt } from "./FormFields";
import { syncDeal } from "../worker-client";

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
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [dealHubspotId, setDealHubspotId] = useState<string | null>(null);
  const [syncState, setSyncState] = useState("");
  const [createdItemId, setCreatedItemId] = useState<string | null>(itemId);
  const [saving, setSaving] = useState(false);
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
      const it = await getDeal(itemId!);
      if (!it) return;
      setName(it.name);
      setDealHubspotId(colText(it, DEAL_COLS.hubspotDealId.id) || null);
      setSyncState(colText(it, "text_mm4xxyzx"));
      setForm({
        amount: colText(it, DEAL_COLS.amount.id), currency: colText(it, DEAL_COLS.currency.id),
        closeDate: colText(it, DEAL_COLS.closeDate.id), stage: colText(it, DEAL_COLS.stage.id),
        pipeline: colText(it, DEAL_COLS.pipeline.id),
        dealType: colText(it, DEAL_COLS.dealType.id), priority: colText(it, DEAL_COLS.priority.id),
        vendors: splitCsv(colText(it, DEAL_COLS.vendors.id)),
        salesUserIds: peopleIds(it, DEAL_COLS.salesUsers.id),
        dealOwnerId: peopleIds(it, DEAL_COLS.dealOwner.id)[0],
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
      try { await syncDeal(board.sessionToken, parentId); } catch { /* webhook is the fallback; don't fail the save */ }
      onSaved(isEdit ? "Deal updated" : "Deal created — syncing to HubSpot…");
    } catch (e) {
      setErr(`Save failed at a step — press Save to retry (the deal is not duplicated). ${String(e).slice(0, 160)}`);
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
              <AssociationPicker kind="contacts" token={board.sessionToken} dealHubspotId={dealHubspotId} value={contacts} onChange={next => { setDirty(true); setContacts(next); }} onError={setChildErr} />
              <AssociationPicker kind="companies" token={board.sessionToken} dealHubspotId={dealHubspotId} value={companies} onChange={next => { setDirty(true); setCompanies(next); }} onError={setChildErr} />
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
          <button className="dc-btn dc-btn-primary" disabled={saving || !invalid.ok} onClick={() => { if (!saving) void save(); }}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create deal"}
          </button>
        </div>
      </div>
    </>
  );
}
