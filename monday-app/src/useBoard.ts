import { useEffect, useState } from "react";
import { getContext, getBoardMeta, getUsers, getDeals, type AccountUser, type BoardMeta, type RawItem } from "./monday-client";
import { validateBoardSchema } from "./lib/schema";
import { DEAL_COLS } from "./board-config";
import type { DealRow } from "./lib/filter";

function colText(item: RawItem, colId: string): string { return item.column_values.find(c => c.id === colId)?.text ?? ""; }
function linkedIds(item: RawItem, colId: string): string[] { return item.column_values.find(c => c.id === colId)?.linked_item_ids ?? []; }

function toRow(item: RawItem): DealRow {
  const people = item.column_values.find(c => c.id === DEAL_COLS.salesUsers.id);
  let salesUserIds: string[] = [];
  try { salesUserIds = (JSON.parse(people?.value ?? "{}").personsAndTeams ?? []).map((p: any) => String(p.id)); } catch { /* empty */ }
  return {
    id: item.id, name: item.name, stage: colText(item, DEAL_COLS.stage.id), salesUserIds,
    amount: colText(item, DEAL_COLS.amount.id), currency: colText(item, DEAL_COLS.currency.id),
    closeDate: colText(item, DEAL_COLS.closeDate.id),
    company: colText(item, DEAL_COLS.company.id), contact: colText(item, DEAL_COLS.contact.id),
  };
}

export interface BoardState {
  loading: boolean; error: string | null; schemaErrors: string[];
  userId: string; sessionToken: string; users: AccountUser[]; meta: BoardMeta | null; rows: DealRow[];
  reload: () => Promise<void>;
}

export function useBoard(): BoardState {
  const [s, setS] = useState<Omit<BoardState, "reload">>({
    loading: true, error: null, schemaErrors: [], userId: "", sessionToken: "", users: [], meta: null, rows: [],
  });

  async function load() {
    setS(p => ({ ...p, loading: true, error: null }));
    try {
      const ctx = await getContext();
      const meta = await getBoardMeta();
      const schema = validateBoardSchema(meta.columns, meta.groups);
      if (!schema.ok) { setS(p => ({ ...p, loading: false, schemaErrors: schema.errors, meta })); return; }
      const [users, items] = await Promise.all([getUsers(), getDeals()]);
      setS({
        loading: false, error: null, schemaErrors: [], userId: ctx.userId, sessionToken: ctx.sessionToken,
        users, meta, rows: items.map(toRow),
      });
    } catch (e) {
      setS(p => ({ ...p, loading: false, error: String(e).slice(0, 200) }));
    }
  }
  useEffect(() => { void load(); }, []);
  return { ...s, reload: load };
}

export { colText, linkedIds };
