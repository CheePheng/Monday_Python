import { useEffect, useRef, useState } from "react";
import { getContext, getBoardMeta, getUsers, getDeals, getDeal, getItemNames, type AccountUser, type BoardMeta, type RawItem } from "./monday-client";
import { validateBoardSchema } from "./lib/schema";
import { columnLabels } from "./lib/labels";
import { DEAL_COLS } from "./board-config";
import type { DealRow } from "./lib/filter";
import { upsertRow } from "./lib/rows";
import { syncDeal, clearDealFields } from "./worker-client";
import { confirmSynced, type SyncStatus, type SavedInfo } from "./lib/sync-status";

export interface DealOptions { pipeline: string[]; dealType: string[]; priority: string[]; vendors: string[]; currency: string[] }
const EMPTY_OPTIONS: DealOptions = { pipeline: [], dealType: [], priority: [], vendors: [], currency: [] };

function optionsFrom(meta: BoardMeta): DealOptions {
  const by = (id: string) => columnLabels(meta.columns.find(c => c.id === id)?.settings_str);
  return {
    pipeline: by(DEAL_COLS.pipeline.id), dealType: by(DEAL_COLS.dealType.id),
    priority: by(DEAL_COLS.priority.id), vendors: by(DEAL_COLS.vendors.id), currency: by(DEAL_COLS.currency.id),
  };
}

function colText(item: RawItem, colId: string): string { return item.column_values.find(c => c.id === colId)?.text ?? ""; }
function linkedIds(item: RawItem, colId: string): string[] { return item.column_values.find(c => c.id === colId)?.linked_item_ids ?? []; }
/** monday person ids in a people column (from its JSON value). Teams are excluded. */
function peopleIds(item: RawItem, colId: string): string[] {
  const cv = item.column_values.find(c => c.id === colId);
  try {
    return (JSON.parse(cv?.value ?? "{}").personsAndTeams ?? [])
      .filter((p: any) => p.kind === "person").map((p: any) => String(p.id));
  } catch { return []; }
}

function toRow(item: RawItem): DealRow {
  return {
    id: item.id, name: item.name, stage: colText(item, DEAL_COLS.stage.id), groupId: item.group.id,
    salesUserIds: peopleIds(item, DEAL_COLS.salesUsers.id),
    amount: colText(item, DEAL_COLS.amount.id), currency: colText(item, DEAL_COLS.currency.id),
    closeDate: colText(item, DEAL_COLS.closeDate.id),
    company: colText(item, DEAL_COLS.company.id), contact: colText(item, DEAL_COLS.contact.id),
    hubspotId: colText(item, DEAL_COLS.hubspotDealId.id) || undefined,
    createdAt: item.created_at,
  };
}

/** Build a DealRow from a raw item, resolving its linked company/contact names from `names`.
 * Shared by load() (all rows) and patchRow() (one row) so they can never drift. */
function rawItemToRow(item: RawItem, names: Record<string, string>): DealRow {
  const nameList = (col: string) => linkedIds(item, col).map(id => names[id]).filter(Boolean).join(", ");
  return { ...toRow(item), company: nameList(DEAL_COLS.company.id), contact: nameList(DEAL_COLS.contact.id) };
}

export interface BoardState {
  loading: boolean; error: string | null; schemaErrors: string[];
  userId: string; sessionToken: string; users: AccountUser[]; meta: BoardMeta | null;
  options: DealOptions; rows: DealRow[];
  reload: () => Promise<void>;
  /** Suspend the background refresh (the drawer sets this while it's open). */
  setAutoRefreshPaused: (paused: boolean) => void;
  /** Transient per-itemId sync status shown as a row badge (client-only). */
  syncing: Record<string, SyncStatus>;
  /** Refetch ONE deal and upsert it into rows (no loading flip). Returns the row, or null if gone. */
  patchRow: (itemId: string) => Promise<DealRow | null>;
  /** After a monday save: update the row, run the HubSpot sync in the background, set the badge status. */
  finishSave: (info: SavedInfo) => Promise<void>;
}

export function useBoard(): BoardState {
  const [s, setS] = useState<Omit<BoardState, "reload" | "setAutoRefreshPaused" | "syncing" | "patchRow" | "finishSave">>({
    loading: true, error: null, schemaErrors: [], userId: "", sessionToken: "", users: [], meta: null,
    options: EMPTY_OPTIONS, rows: [],
  });
  const pausedRef = useRef(false);
  const [syncing, setSyncing] = useState<Record<string, SyncStatus>>({});
  const setStatus = (id: string, status: SyncStatus) => setSyncing(prev => ({ ...prev, [id]: status }));
  const clearStatus = (id: string) => setSyncing(prev => { const n = { ...prev }; delete n[id]; return n; });

  // `silent` refreshes rows in place. Flipping `loading` unmounts the whole view (BoardView renders a
  // loading screen on it), which would throw away an open drawer's unsaved edits — never do that
  // for a refresh the user didn't ask for.
  async function load(opts?: { silent?: boolean }) {
    if (!opts?.silent) setS(p => ({ ...p, loading: true, error: null }));
    try {
      const ctx = await getContext();
      const meta = await getBoardMeta();
      const schema = validateBoardSchema(meta.columns, meta.groups);
      if (!schema.ok) { setS(p => ({ ...p, loading: false, schemaErrors: schema.errors, meta })); return; }
      const [users, items] = await Promise.all([getUsers(), getDeals()]);
      const linkIds = new Set<string>();
      for (const it of items) {
        for (const id of linkedIds(it, DEAL_COLS.company.id)) linkIds.add(id);
        for (const id of linkedIds(it, DEAL_COLS.contact.id)) linkIds.add(id);
      }
      const names = await getItemNames([...linkIds]);
      const rows = items.map(it => rawItemToRow(it, names));
      setS({
        loading: false, error: null, schemaErrors: [], userId: ctx.userId, sessionToken: ctx.sessionToken,
        users, meta, options: optionsFrom(meta), rows,
      });
    } catch (e) {
      setS(p => ({ ...p, loading: false, error: String(e).slice(0, 200) }));
    }
  }
  // Refetch ONE deal and upsert it into rows — no `loading` flip, so the board never flashes.
  async function patchRow(itemId: string): Promise<DealRow | null> {
    const it = await getDeal(itemId);
    if (!it) return null;
    const linkIds = new Set<string>();
    for (const id of linkedIds(it, DEAL_COLS.company.id)) linkIds.add(id);
    for (const id of linkedIds(it, DEAL_COLS.contact.id)) linkIds.add(id);
    const names = await getItemNames([...linkIds]);
    const row = rawItemToRow(it, names);
    setS(prev => ({ ...prev, rows: upsertRow(prev.rows, row) }));
    return row;
  }

  // Background HubSpot sync for a just-saved deal. Updates the one row, then flips the badge to Synced
  // ONLY when the Worker reported ok AND a HubSpot Deal ID is present. Failure -> "error" (Retry badge).
  async function finishSave(info: SavedInfo) {
    const { itemId, clearProps } = info;
    setStatus(itemId, "syncing");
    const row = await patchRow(itemId);            // show the new monday values immediately
    try {
      if (clearProps.length && row?.hubspotId)
        await clearDealFields(s.sessionToken, row.hubspotId, clearProps);
      const ok = await syncDeal(s.sessionToken, itemId);
      const after = await patchRow(itemId);        // pick up HubSpot Deal ID + last-synced
      const status = confirmSynced(ok, after?.hubspotId);
      setStatus(itemId, status);
      if (status === "synced") setTimeout(() => clearStatus(itemId), 4000);
    } catch {
      setStatus(itemId, "error");
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    let last = Date.now();
    // visibilitychange only: window "focus" fires on almost any click inside the board-view iframe
    // (and when a confirm() dialog closes), which made the board appear to refresh at random.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || pausedRef.current) return;
      if (Date.now() - last < 15000) return;
      last = Date.now();
      void load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return {
    ...s, syncing, reload: load, patchRow, finishSave,
    setAutoRefreshPaused: (p: boolean) => { pausedRef.current = p; },
  };
}

export { colText, linkedIds, peopleIds };
