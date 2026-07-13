import { useMemo, useState } from "react";
import { useBoard } from "../useBoard";
import { filterDeals, type DealRow } from "../lib/filter";
import { stageOptions } from "../lib/stage";
import DealModal from "./DealModal";

const CUR_SYMBOL: Record<string, string> = { USD: "$", CNY: "¥", RMB: "¥", EUR: "€", GBP: "£", HKD: "HK$", JPY: "¥", AUD: "A$", SGD: "S$" };
function fmt(n: number): string { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function money(amount?: string, cur?: string): string {
  if (!amount) return "—";
  const n = Number(amount);
  if (!isFinite(n)) return amount;
  const s = CUR_SYMBOL[cur ?? ""];
  return s ? `${s}${fmt(n)}` : `${fmt(n)}${cur ? " " + cur : ""}`;
}
function stageVars(stage: string): { bg: string; fg: string } {
  const s = stage.toLowerCase();
  if (s.includes("won")) return { bg: "var(--green-soft)", fg: "var(--green)" };
  if (s.includes("lost")) return { bg: "var(--red-soft)", fg: "var(--red)" };
  if (s.includes("contract")) return { bg: "var(--violet-soft)", fg: "var(--violet)" };
  if (s.includes("decision")) return { bg: "var(--sky-soft)", fg: "var(--sky)" };
  if (s.includes("presentation")) return { bg: "var(--violet-soft)", fg: "var(--violet)" };
  if (s.includes("qualified")) return { bg: "var(--amber-soft)", fg: "var(--amber)" };
  return { bg: "var(--accent-soft)", fg: "var(--accent)" };
}
const AVATAR = ["#4b6ef5", "#7b5cff", "#e8952a", "#10b26b", "#2b90d9", "#e14a63", "#0ea5a5", "#d9488c"];
function avatarFor(name: string) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const c1 = AVATAR[Math.abs(h) % AVATAR.length];
  const c2 = AVATAR[Math.abs(h >> 3) % AVATAR.length];
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}
function initials(name: string): string {
  const t = name.trim(); if (!t) return "?";
  if (/[一-鿿]/.test(t)) return t.slice(0, 1);
  const p = t.split(/\s+/);
  return (p[0][0] + (p[1]?.[0] ?? "")).toUpperCase();
}

function Badge({ stage }: { stage: string }) {
  if (!stage) return <span className="dc-mut">—</span>;
  const { bg, fg } = stageVars(stage);
  return <span className="dc-badge" style={{ background: bg, color: fg }}>{stage}</span>;
}

function Kpi({ label, value, foot, color }: { label: string; value: string; foot?: string; color: string }) {
  return (
    <div className="dc-kpi" style={{ ["--k" as any]: color }}>
      <div className="dc-kpi-label">{label}</div>
      <div className="dc-kpi-value">{value}</div>
      {foot && <div className="dc-kpi-foot">{foot}</div>}
    </div>
  );
}

export default function BoardView() {
  const board = useBoard();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [toast, setToast] = useState<string | null>(null);

  const stages = useMemo(() => (board.meta ? stageOptions(board.meta.groups) : []), [board.meta]);
  const rows = useMemo(
    () => filterDeals(board.rows, { q, stage: stage || undefined, mine, myUserId: board.userId }),
    [board.rows, q, stage, mine, board.userId]);

  const kpi = useMemo(() => {
    const all = board.rows;
    const isWon = (s: string) => s.toLowerCase().includes("won");
    const isLost = (s: string) => s.toLowerCase().includes("lost");
    const open = all.filter(r => !isWon(r.stage) && !isLost(r.stage));
    const curCount: Record<string, number> = {};
    let pipeline = 0;
    for (const r of open) { const n = Number(r.amount); if (isFinite(n)) pipeline += n; if (r.currency) curCount[r.currency] = (curCount[r.currency] ?? 0) + 1; }
    const domCur = Object.entries(curCount).sort((a, b) => b[1] - a[1])[0]?.[0];
    const sym = CUR_SYMBOL[domCur ?? ""] ?? "";
    const won = all.filter(r => isWon(r.stage)).length;
    const lost = all.filter(r => isLost(r.stage)).length;
    const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;
    return { pipeline: sym + fmt(pipeline), active: open.length, won, winRate };
  }, [board.rows]);

  if (board.loading)
    return <div className="dc-wrap"><div className="dc-loading"><div className="dc-spinner" />Loading deals…</div></div>;
  if (board.schemaErrors.length)
    return (
      <div className="dc-wrap"><div className="dc-config">
        <h3>Configuration error — the board schema doesn't match this app.</h3>
        <ul>{board.schemaErrors.map(e => <li key={e} style={{ marginBottom: 4 }}><code>{e}</code></li>)}</ul>
        <p className="dc-mut">Fix the board (or update board-config) and reload. Writing is disabled until this passes.</p>
      </div></div>
    );
  if (board.error) return <div className="dc-wrap"><div className="dc-config">Failed to load: {board.error}</div></div>;

  return (
    <div className="dc-wrap">
      <div className="dc-header">
        <h1 className="dc-title">Deals</h1>
        <span className="dc-sub">{rows.length} of {board.rows.length}</span>
        <div className="dc-spacer" />
        <button className="dc-btn dc-btn-primary" onClick={() => setEditing(null)}>＋ Create deal</button>
      </div>

      <div className="dc-kpis">
        <Kpi label="Open pipeline" value={kpi.pipeline} foot={`${kpi.active} active deals`} color="var(--accent)" />
        <Kpi label="Active deals" value={String(kpi.active)} color="var(--sky)" />
        <Kpi label="Won" value={String(kpi.won)} foot="closed won" color="var(--green)" />
        <Kpi label="Win rate" value={`${kpi.winRate}%`} foot="won ÷ closed" color="var(--violet)" />
      </div>

      <div className="dc-toolbar">
        <div className="dc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input className="dc-input" placeholder="Search deals" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="dc-select" value={stage} onChange={e => setStage(e.target.value)}>
          <option value="">All stages</option>
          {stages.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className={"dc-btn dc-btn-ghost dc-btn-sm" + (mine ? " on" : "")} onClick={() => setMine(m => !m)}>My deals</button>
      </div>

      <div className="dc-panel">
        <div className="dc-table-scroll">
          <table className="dc-table">
            <thead><tr>
              <th>Deal</th><th>Stage</th><th className="r">Amount</th><th>Close date</th><th>Company</th><th>Contact</th><th></th>
            </tr></thead>
            <tbody>
              {rows.length === 0
                ? <tr><td colSpan={7}><div className="dc-empty">No deals match your filters.</div></td></tr>
                : rows.map((r: DealRow) => (
                  <tr key={r.id} onClick={() => setEditing(r.id)}>
                    <td>
                      <div className="dc-deal">
                        <span className="dc-avatar" style={{ background: avatarFor(r.name) }}>{initials(r.name)}</span>
                        <span className="dc-deal-name">{r.name}</span>
                      </div>
                    </td>
                    <td><Badge stage={r.stage} /></td>
                    <td className="r"><span className="dc-money">{money(r.amount, r.currency)}</span></td>
                    <td className="dc-mut">{r.closeDate || "—"}</td>
                    <td className={r.company ? "" : "dc-mut"}>{r.company || "—"}</td>
                    <td className={r.contact ? "" : "dc-mut"}>{r.contact || "—"}</td>
                    <td className="r"><span className="dc-open dc-btn dc-btn-sm">Open →</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing !== undefined && (
        <DealModal itemId={editing} board={board}
          onClose={() => setEditing(undefined)}
          onSaved={async (msg) => { setEditing(undefined); setToast(msg); await board.reload(); }} />
      )}
      {toast && <div className="dc-toast" onClick={() => setToast(null)}>✓ {toast}</div>}
    </div>
  );
}
