import { useEffect, useMemo, useRef, useState } from "react";
import { useBoard } from "../useBoard";
import { filterDeals, type DealRow } from "../lib/filter";
import { stageOptions } from "../lib/stage";
import DealDrawer from "./DealDrawer";
import { computeKpis } from "../lib/kpi";
import { sortDeals, type SortKey } from "../lib/sort";
import KanbanView from "./KanbanView";
import { openLink } from "../monday-client";
import { hubspotDealUrl } from "../board-config";

const CUR_SYMBOL: Record<string, string> = { USD: "$", CNY: "¥", RMB: "¥", EUR: "€", GBP: "£", HKD: "HK$", JPY: "¥", AUD: "A$", SGD: "S$" };
function fmt(n: number): string { return n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtCreated(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function money(amount?: string, cur?: string): string {
  if (!amount) return "—";
  const n = Number(amount);
  if (!isFinite(n)) return amount;
  const s = CUR_SYMBOL[cur ?? ""];
  return s ? `${s}${fmt(n)}` : `${fmt(n)}${cur ? " " + cur : ""}`;
}
function fmtPipe({ currency, total }: { currency: string; total: number }): string {
  const s = CUR_SYMBOL[currency ?? ""];
  return s ? `${s}${Math.round(total).toLocaleString()}` : `${Math.round(total).toLocaleString()} ${currency}`;
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
  const [salesUser, setSalesUser] = useState("");
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [toast, setToast] = useState<{ text: string; type: "success" | "info" | "error" } | null>(null);
  // Default: newest-created first, so a deal a rep just made is at the top.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "createdAt", dir: "desc" });
  const [view, setView] = useState<"table" | "board">("table");

  // A background refresh remounts the board, so hold it off while the drawer is open — otherwise
  // returning to the tab mid-edit would silently discard the deal being written.
  useEffect(() => { board.setAutoRefreshPaused(editing !== undefined); }, [editing]);

  // Success/info toasts auto-dismiss; error toasts persist until the user dismisses them.
  useEffect(() => {
    if (!toast || toast.type === "error") return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Guard a deal switch (row click / Create / Kanban open) when the open drawer has unsaved edits.
  const drawerDirty = useRef(false);
  function attemptOpen(id: string | null) {
    if (editing !== undefined && drawerDirty.current && !window.confirm("Discard unsaved changes?")) return;
    drawerDirty.current = false;
    setEditing(id);
  }

  const userName = (id: string) => board.users.find(u => u.id === id)?.name ?? id;
  const stages = useMemo(() => (board.meta ? stageOptions(board.meta.groups) : []), [board.meta]);
  const rows = useMemo(
    () => sortDeals(filterDeals(board.rows, { q, stage: stage || undefined, mine, myUserId: board.userId, salesUserId: salesUser || undefined }), sort.key, sort.dir),
    [board.rows, q, stage, mine, salesUser, board.userId, sort]);
  const filtersActive = !!(q || stage || mine || salesUser);

  const kpi = useMemo(() => computeKpis(board.rows), [board.rows]);
  const pipeRest = kpi.pipeline.slice(1);
  const pipeFoot = pipeRest.length
    ? pipeRest.slice(0, 2).map(fmtPipe).join(" · ") + (pipeRest.length > 2 ? ` · +${pipeRest.length - 2} more` : "")
    : `${kpi.active} active deals`;

  function sortIndicator(key: SortKey): string {
    if (sort.key !== key) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  }
  function toggleSort(key: SortKey) {
    setSort(s => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
  }

  if (board.loading)
    return (
      <div className="dc-wrap">
        <div className="dc-header"><h1 className="dc-title">Deals</h1></div>
        <div className="dc-panel"><div className="dc-table-scroll">
          <table className="dc-table"><tbody>
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i}><td colSpan={9}><div className="dc-skeleton" /></td></tr>
            ))}
          </tbody></table>
        </div></div>
      </div>
    );
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
        <button className="dc-btn dc-btn-primary" onClick={() => attemptOpen(null)}>＋ Create deal</button>
      </div>

      <div className="dc-kpis">
        <Kpi label="Open pipeline" value={kpi.pipeline[0] ? fmtPipe(kpi.pipeline[0]) : "—"} foot={pipeFoot} color="var(--accent)" />
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
        <select className="dc-select" value={salesUser} onChange={e => setSalesUser(e.target.value)}>
          <option value="">All sales users</option>
          {board.users.map(u => <option key={u.id} value={u.id}>{u.name || u.email || u.id}</option>)}
        </select>
        <button className={"dc-btn dc-btn-ghost dc-btn-sm" + (mine ? " on" : "")} onClick={() => setMine(m => !m)}>My deals</button>
        <div className="dc-spacer" />
        <button className={"dc-btn dc-btn-ghost dc-btn-sm" + (view === "table" ? " on" : "")} onClick={() => setView("table")}>Table</button>
        <button className={"dc-btn dc-btn-ghost dc-btn-sm" + (view === "board" ? " on" : "")} onClick={() => setView("board")}>Board</button>
        <button className="dc-btn dc-btn-ghost dc-btn-sm" onClick={() => void board.reload()}>⟳ Refresh</button>
      </div>

      {view === "board" ? (
        <KanbanView board={board} rows={rows} onOpen={attemptOpen} onToast={(text) => setToast({ text, type: "info" })} />
      ) : (
        <div className="dc-panel">
          <div className="dc-table-scroll">
            <table className="dc-table">
              <thead><tr>
                <th style={{ cursor: "pointer" }} onClick={() => toggleSort("name")}>Deal{sortIndicator("name")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => toggleSort("stage")}>Stage{sortIndicator("stage")}</th>
                <th className="r" style={{ cursor: "pointer" }} onClick={() => toggleSort("amount")}>Amount{sortIndicator("amount")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => toggleSort("closeDate")}>Close date{sortIndicator("closeDate")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => toggleSort("company")}>Company{sortIndicator("company")}</th>
                <th style={{ cursor: "pointer" }} onClick={() => toggleSort("contact")}>Contact{sortIndicator("contact")}</th>
                <th>Sales User</th>
                <th style={{ cursor: "pointer" }} onClick={() => toggleSort("createdAt")}>Created{sortIndicator("createdAt")}</th>
                <th></th>
              </tr></thead>
              <tbody>
                {rows.length === 0
                  ? <tr><td colSpan={9}>
                      {filtersActive
                        ? <div className="dc-empty">No deals match your filters.</div>
                        : <div className="dc-empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <span style={{ fontSize: 15 }}>No deals yet.</span>
                            <button className="dc-btn dc-btn-primary" onClick={() => attemptOpen(null)}>＋ Create your first deal</button>
                          </div>}
                    </td></tr>
                  : rows.map((r: DealRow) => (
                    <tr key={r.id} onClick={() => attemptOpen(r.id)}>
                      <td>
                        <div className="dc-deal">
                          <span className="dc-avatar" style={{ background: avatarFor(r.name) }}>{initials(r.name)}</span>
                          <span className="dc-deal-name" title={r.name}>{r.name}</span>
                        </div>
                      </td>
                      <td><Badge stage={r.stage} /></td>
                      <td className="r"><span className="dc-money">{money(r.amount, r.currency)}</span></td>
                      <td className="dc-mut">{r.closeDate || "—"}</td>
                      <td className={r.company ? "" : "dc-mut"} title={r.company || ""}>{r.company || "—"}</td>
                      <td className={r.contact ? "" : "dc-mut"} title={r.contact || ""}>{r.contact || "—"}</td>
                      <td className={r.salesUserIds.length ? "" : "dc-mut"}>{r.salesUserIds.map(userName).join(", ") || "—"}</td>
                      <td className="dc-mut">{fmtCreated(r.createdAt)}</td>
                      <td className="r">
                        {board.syncing[r.id] === "syncing" && <span className="dc-syncbadge syncing" style={{ marginRight: 6 }}>⟳ Syncing…</span>}
                        {board.syncing[r.id] === "synced" && <span className="dc-syncbadge synced" style={{ marginRight: 6 }}>✓ Synced</span>}
                        {board.syncing[r.id] === "error" && (
                          <button className="dc-syncbadge error" style={{ marginRight: 6 }}
                            onClick={e => { e.stopPropagation(); void board.finishSave({ itemId: r.id, isEdit: true, clearProps: [] }); }}>
                            ⚠ Retry
                          </button>
                        )}
                        {r.hubspotId && <button className="dc-btn dc-btn-sm" title="Open in HubSpot" style={{ marginRight: 6 }} onClick={e => { e.stopPropagation(); openLink(hubspotDealUrl(r.hubspotId!)); }}>↗ HubSpot</button>}
                        <span className="dc-open dc-btn dc-btn-sm">Open →</span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing !== undefined && (
        <DealDrawer key={editing ?? "new"} itemId={editing} board={board}
          onDirtyChange={d => { drawerDirty.current = d; }}
          onClose={() => setEditing(undefined)}
          onSaved={(info) => {
            setEditing(undefined);
            setToast({ text: "Saved to monday", type: "info" });
            void board.finishSave(info);
          }} />
      )}
      {toast && (
        <div className={"dc-toast dc-toast-" + toast.type} onClick={() => setToast(null)}>
          {toast.type === "error" ? "⚠ " : toast.type === "info" ? "" : "✓ "}{toast.text}
        </div>
      )}
    </div>
  );
}
