import { useMemo, useState } from "react";
import type { BoardState } from "../useBoard";
import type { DealRow } from "../lib/filter";
import { stageOptions, groupIdForStage } from "../lib/stage";
import { UNASSIGNED_GROUP } from "../board-config";
import { moveToGroup } from "../monday-client";

const money = (r: DealRow) => r.amount ? `${r.currency ?? ""} ${Number(r.amount).toLocaleString()}` : "";

export default function KanbanView({ board, rows, onOpen, onToast }: {
  board: BoardState; rows: DealRow[]; onOpen: (id: string) => void; onToast: (m: string) => void;
}) {
  const [drag, setDrag] = useState<string | null>(null);
  const cols = useMemo(() => {
    const stage = stageOptions(board.meta!.groups).map(t => ({ groupId: groupIdForStage(t, board.meta!.groups)!, title: t }));
    return [...stage, { groupId: UNASSIGNED_GROUP, title: "Unassigned" }];
  }, [board.meta]);
  const byGroup = (gid: string) => rows.filter(r => r.groupId === gid);

  async function drop(targetGroup: string) {
    const id = drag; setDrag(null);
    if (!id) return;
    const row = rows.find(r => r.id === id);
    if (!row || row.groupId === targetGroup) return;
    if (row.groupId === UNASSIGNED_GROUP || targetGroup === UNASSIGNED_GROUP) {
      onToast("Assign a Sales User first to move this deal out of Unassigned"); return;
    }
    try { await moveToGroup(id, targetGroup); await board.patchRow(id); }
    catch { onToast("Could not move the deal"); }
  }

  return (
    <div className="dc-kanban">
      {cols.map(c => {
        const items = byGroup(c.groupId);
        const total = items.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        return (
          <div key={c.groupId} className="dc-kcol" onDragOver={e => e.preventDefault()} onDrop={() => void drop(c.groupId)}>
            <div className="dc-kcol-head"><span>{c.title}</span><span className="dc-mut">{items.length} · {total ? total.toLocaleString() : "—"}</span></div>
            {items.map(r => (
              <div key={r.id} className="dc-kcard" draggable={c.groupId !== UNASSIGNED_GROUP}
                onDragStart={() => setDrag(r.id)} onClick={() => onOpen(r.id)}>
                <div className="dc-kcard-name">{r.name}</div>
                <div className="dc-mut" style={{ fontSize: 12 }}>{r.company || ""}</div>
                <div className="dc-money" style={{ fontSize: 13 }}>{money(r)}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
