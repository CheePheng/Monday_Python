import { useEffect, useRef, useState } from "react";
import { getContext, getBoardMeta, getUsers, getDeals, getItemNames, type AccountUser, type BoardMeta, type RawItem } from "./monday-client";
import { validateBoardSchema } from "./lib/schema";
import { columnLabels } from "./lib/labels";
import { DEAL_COLS } from "./board-config";
import type { DealRow } from "./lib/filter";

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

export interface BoardState {
  loading: boolean; error: string | null; schemaErrors: string[];
  userId: string; sessionToken: string; users: AccountUser[]; meta: BoardMeta | null;
  options: DealOptions; rows: DealRow[];
  reload: () => Promise<void>;
  /** Suspend the background refresh (the drawer sets this while it's open). */
  setAutoRefreshPaused: (paused: boolean) => void;
}

export function useBoard(): BoardState {
  const [s, setS] = useState<Omit<BoardState, "reload" | "setAutoRefreshPaused">>({
    loading: true, error: null, schemaErrors: [], userId: "", sessionToken: "", users: [], meta: null,
    options: EMPTY_OPTIONS, rows: [],
  });
  const pausedRef = useRef(false);

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
      const nameList = (it: RawItem, col: string) => linkedIds(it, col).map(id => names[id]).filter(Boolean).join(", ");
      const rows = items.map(it => ({ ...toRow(it),
        company: nameList(it, DEAL_COLS.company.id), contact: nameList(it, DEAL_COLS.contact.id) }));
      setS({
        loading: false, error: null, schemaErrors: [], userId: ctx.userId, sessionToken: ctx.sessionToken,
        users, meta, options: optionsFrom(meta), rows,
      });
    } catch (e) {
      setS(p => ({ ...p, loading: false, error: String(e).slice(0, 200) }));
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
  return { ...s, reload: load, setAutoRefreshPaused: (p: boolean) => { pausedRef.current = p; } };
}

export { colText, linkedIds, peopleIds };
