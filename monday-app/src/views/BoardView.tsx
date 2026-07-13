import { useMemo, useState } from "react";
import { Button } from "@vibe/core";
import { useBoard } from "../useBoard";
import { filterDeals } from "../lib/filter";
import { stageOptions } from "../lib/stage";
import DealModal from "./DealModal";

// v1 presentation is intentionally lightweight (plain HTML + inline styles under Vibe's ThemeProvider).
// All data flow lives in the tested libs/clients; swap these elements for Vibe Table/inputs at polish time.
const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--layout-border-color, #e6e9ef)", textAlign: "left" };
const th: React.CSSProperties = { ...cell, fontWeight: 600, position: "sticky", top: 0, background: "var(--primary-background-color, #fff)" };

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
    <div style={{ padding: 16, fontFamily: "var(--font-family, inherit)" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input placeholder="Search deals" value={q} onChange={e => setQ(e.target.value)}
          style={{ padding: "6px 10px", minWidth: 180 }} />
        <select value={stage} onChange={e => setStage(e.target.value)} style={{ padding: "6px 10px" }}>
          <option value="">All stages</option>
          {stages.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button kind={mine ? "primary" : "tertiary"} size="small" onClick={() => setMine(m => !m)}>My deals</Button>
        <div style={{ flex: 1 }} />
        <Button size="small" onClick={() => setEditing(null)}>+ Create Deal</Button>
      </div>

      <div style={{ overflowX: "auto", maxHeight: "70vh", overflowY: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
          <thead>
            <tr>
              {["Deal", "Stage", "Amount", "Cur", "Close", "Company", "Contact"].map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? <tr><td style={cell} colSpan={7}>No deals match.</td></tr>
              : rows.map(r => (
                <tr key={r.id} onClick={() => setEditing(r.id)} style={{ cursor: "pointer" }}>
                  <td style={cell}>{r.name}</td><td style={cell}>{r.stage}</td>
                  <td style={cell}>{r.amount}</td><td style={cell}>{r.currency}</td>
                  <td style={cell}>{r.closeDate}</td><td style={cell}>{r.company}</td><td style={cell}>{r.contact}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {editing !== undefined && (
        <DealModal
          itemId={editing} board={board}
          onClose={() => setEditing(undefined)}
          onSaved={async (msg) => { setEditing(undefined); setToast(msg); await board.reload(); }}
        />
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)",
          background: "#00854d", color: "#fff", padding: "10px 16px", borderRadius: 6 }}
          onClick={() => setToast(null)}>{toast}</div>
      )}
    </div>
  );
}
