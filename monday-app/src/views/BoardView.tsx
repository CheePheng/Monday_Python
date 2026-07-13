import { useMemo, useState } from "react";
import {
  Button, Search, Dropdown, Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
} from "@vibe/core";
import { useBoard } from "../useBoard";
import { filterDeals } from "../lib/filter";
import { stageOptions } from "../lib/stage";
import DealModal from "./DealModal";

const COLUMNS = [
  { id: "name", title: "Deal" }, { id: "stage", title: "Stage" }, { id: "amount", title: "Amount" },
  { id: "currency", title: "Cur" }, { id: "closeDate", title: "Close" }, { id: "company", title: "Company" },
  { id: "contact", title: "Contact" }, { id: "actions", title: "" },
];

export default function BoardView() {
  const board = useBoard();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<string | null | undefined>(undefined); // undefined=closed, null=new, id=edit
  const [toast, setToast] = useState<string | null>(null);

  const stages = useMemo(() => (board.meta ? stageOptions(board.meta.groups) : []), [board.meta]);
  const rows = useMemo(
    () => filterDeals(board.rows, { q, stage: stage || undefined, mine, myUserId: board.userId }),
    [board.rows, q, stage, mine, board.userId]);

  if (board.loading) return <div style={{ padding: 40, textAlign: "center" }}>Loading deals…</div>;
  if (board.schemaErrors.length)
    return (
      <div style={{ padding: 24 }}>
        <h3 style={{ marginTop: 0 }}>Configuration error — the board schema does not match this app.</h3>
        <ul>{board.schemaErrors.map(e => <li key={e}>{e}</li>)}</ul>
        <p>Fix the board (or update board-config) and reload. Writing is disabled until this passes.</p>
      </div>
    );
  if (board.error) return <div style={{ padding: 24 }}>Failed to load: {board.error}</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ minWidth: 200 }}>
          <Search size="small" placeholder="Search deals" value={q} onChange={setQ} />
        </div>
        <div style={{ minWidth: 200 }}>
          <Dropdown size="small" placeholder="All stages" clearable
            value={stage ? { label: stage, value: stage } : undefined}
            options={stages.map(s => ({ label: s, value: s }))}
            onOptionSelect={(o: any) => setStage(o?.value ?? "")}
            onClear={() => setStage("")} />
        </div>
        <Button kind={mine ? "primary" : "tertiary"} size="small" onClick={() => setMine(m => !m)}>My deals</Button>
        <div style={{ flex: 1 }} />
        <Button size="small" onClick={() => setEditing(null)}>+ Create Deal</Button>
      </div>

      <Table columns={COLUMNS} errorState={<div style={{ padding: 16 }}>Failed to load.</div>}
        emptyState={<div style={{ padding: 16 }}>No deals match.</div>}>
        <TableHeader>
          {COLUMNS.map(c => <TableHeaderCell key={c.id} title={c.title} />)}
        </TableHeader>
        <TableBody>
          {rows.map(r => (
            <TableRow key={r.id}>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.stage}</TableCell>
              <TableCell>{r.amount}</TableCell>
              <TableCell>{r.currency}</TableCell>
              <TableCell>{r.closeDate}</TableCell>
              <TableCell>{r.company}</TableCell>
              <TableCell>{r.contact}</TableCell>
              <TableCell><Button kind="tertiary" size="small" onClick={() => setEditing(r.id)}>Open</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editing !== undefined && (
        <DealModal
          itemId={editing} board={board}
          onClose={() => setEditing(undefined)}
          onSaved={async (msg) => { setEditing(undefined); setToast(msg); await board.reload(); }}
        />
      )}
      {toast && (
        <div onClick={() => setToast(null)}
          style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
            background: "#00854d", color: "#fff", padding: "10px 16px", borderRadius: 6, cursor: "pointer" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
