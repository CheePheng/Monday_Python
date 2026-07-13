import { useMemo, useState } from "react";
import {
  Button, Search, Dropdown, Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
} from "@vibe/core";
import { useBoard } from "../useBoard";
import { filterDeals, type DealRow } from "../lib/filter";
import { stageOptions } from "../lib/stage";
import DealModal from "./DealModal";

const COLUMNS = [
  { id: "name", title: "Deal" }, { id: "stage", title: "Stage" }, { id: "amount", title: "Amount" },
  { id: "closeDate", title: "Close date" }, { id: "company", title: "Company" }, { id: "contact", title: "Contact" },
  { id: "actions", title: "" },
];

const CUR_SYMBOL: Record<string, string> = { USD: "$", CNY: "¥", RMB: "¥", EUR: "€", GBP: "£", HKD: "HK$", JPY: "¥", AUD: "A$", SGD: "S$" };
function money(amount?: string, cur?: string): string {
  if (!amount) return "—";
  const n = Number(amount);
  if (!isFinite(n)) return amount;
  const s = CUR_SYMBOL[cur ?? ""];
  const num = n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return s ? `${s}${num}` : `${num}${cur ? " " + cur : ""}`;
}
function stageStyle(stage: string): { bg: string; fg: string } {
  const s = stage.toLowerCase();
  if (s.includes("won")) return { bg: "rgba(0,200,117,.16)", fg: "#00c875" };
  if (s.includes("lost")) return { bg: "rgba(226,68,92,.16)", fg: "#e2445c" };
  if (s.includes("contract")) return { bg: "rgba(88,101,242,.16)", fg: "#8a97ff" };
  if (s.includes("decision")) return { bg: "rgba(51,170,255,.16)", fg: "#33aaff" };
  if (s.includes("presentation")) return { bg: "rgba(177,139,255,.16)", fg: "#b18bff" };
  if (s.includes("qualified")) return { bg: "rgba(255,184,77,.16)", fg: "#ffb84d" };
  return { bg: "rgba(128,138,157,.16)", fg: "var(--secondary-text-color)" };
}

function StageBadge({ stage }: { stage: string }) {
  if (!stage) return <span style={{ color: "var(--secondary-text-color)" }}>—</span>;
  const { bg, fg } = stageStyle(stage);
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", borderRadius: 14, fontSize: 12, fontWeight: 600,
      background: bg, color: fg, whiteSpace: "nowrap",
    }}>{stage}</span>
  );
}

const muted: React.CSSProperties = { color: "var(--secondary-text-color)" };

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

  if (board.loading)
    return <div style={{ padding: 48, textAlign: "center", ...muted }}>Loading deals…</div>;
  if (board.schemaErrors.length)
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <h3 style={{ marginTop: 0 }}>Configuration error — the board schema does not match this app.</h3>
        <ul>{board.schemaErrors.map(e => <li key={e} style={{ marginBottom: 4 }}>{e}</li>)}</ul>
        <p style={muted}>Fix the board (or update board-config) and reload. Writing is disabled until this passes.</p>
      </div>
    );
  if (board.error) return <div style={{ padding: 24 }}>Failed to load: {board.error}</div>;

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>Deals</h1>
        <span style={{ ...muted, fontSize: 14 }}>{rows.length} of {board.rows.length}</span>
        <div style={{ flex: 1 }} />
        <Button onClick={() => setEditing(null)}>+ Create deal</Button>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ flex: "1 1 260px", maxWidth: 340 }}>
          <Search size="small" placeholder="Search deals" value={q} onChange={setQ} />
        </div>
        <div style={{ width: 220 }}>
          <Dropdown size="small" placeholder="All stages" clearable
            value={stage ? { label: stage, value: stage } : undefined}
            options={stages.map(s => ({ label: s, value: s }))}
            onOptionSelect={(o: any) => setStage(o?.value ?? "")}
            onClear={() => setStage("")} />
        </div>
        <Button kind={mine ? "primary" : "tertiary"} size="small" onClick={() => setMine(m => !m)}>My deals</Button>
      </div>

      {/* Table */}
      <div style={{ border: "1px solid var(--layout-border-color)", borderRadius: 10, overflow: "hidden" }}>
        <Table columns={COLUMNS} errorState={<div style={{ padding: 24 }}>Failed to load.</div>}
          emptyState={<div style={{ padding: 24, ...muted }}>No deals match your filters.</div>}>
          <TableHeader>
            {COLUMNS.map(c => <TableHeaderCell key={c.id} title={c.title} />)}
          </TableHeader>
          <TableBody>
            {rows.map((r: DealRow) => (
              <TableRow key={r.id}>
                <TableCell><span style={{ fontWeight: 500 }}>{r.name}</span></TableCell>
                <TableCell><StageBadge stage={r.stage} /></TableCell>
                <TableCell><span style={{ fontVariantNumeric: "tabular-nums" }}>{money(r.amount, r.currency)}</span></TableCell>
                <TableCell><span style={muted}>{r.closeDate || "—"}</span></TableCell>
                <TableCell><span style={r.company ? undefined : muted}>{r.company || "—"}</span></TableCell>
                <TableCell><span style={r.contact ? undefined : muted}>{r.contact || "—"}</span></TableCell>
                <TableCell><Button kind="tertiary" size="small" onClick={() => setEditing(r.id)}>Open</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing !== undefined && (
        <DealModal
          itemId={editing} board={board}
          onClose={() => setEditing(undefined)}
          onSaved={async (msg) => { setEditing(undefined); setToast(msg); await board.reload(); }}
        />
      )}
      {toast && (
        <div onClick={() => setToast(null)}
          style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)",
            background: "#00854d", color: "#fff", padding: "11px 18px", borderRadius: 8, cursor: "pointer",
            boxShadow: "0 6px 20px rgba(0,0,0,0.28)", fontWeight: 500 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
