import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getContext } from "../monday-client";
import { listCompanies, getOwners, type Company } from "../worker-client";
import { orDash, fmtCompanyDate, type NewDealSeed } from "../lib/companies";
import CompanyDrawer from "./CompanyDrawer";
import { dateRange } from "../lib/date-range";
import DateRangeFilter, { type DateFilterValue } from "./DateRangeFilter";

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

export default function CompaniesView() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const tokenRef = useRef("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Company[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Company | null>(null);
  const seq = useRef(0);
  const [owners, setOwners] = useState<{ id: string; name: string }[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [createdF, setCreatedF] = useState<DateFilterValue>({ preset: "" });
  const [activityF, setActivityF] = useState<DateFilterValue>({ preset: "" });
  // Refs so the debounced load() and "Load more" always read the latest filters (same pattern as tokenRef).
  const ownerRef = useRef(""); ownerRef.current = ownerId;
  const createdRef = useRef<DateFilterValue>({ preset: "" }); createdRef.current = createdF;
  const activityRef = useRef<DateFilterValue>({ preset: "" }); activityRef.current = activityF;

  // `cursor` present -> append (Load more); absent -> replace (new query / initial). A monotonic seq id
  // drops any stale response so a fast typer never sees out-of-order results. The session token is fetched
  // lazily here (and cleared on a 403), so Retry recovers a token that failed on mount or expired mid-session.
  async function load(query: string, cursor?: string) {
    const mySeq = ++seq.current;
    setLoading(true); setError(false);
    let t = tokenRef.current;
    if (!t) {
      try { t = (await getContext()).sessionToken; tokenRef.current = t; setToken(t); }
      catch { if (mySeq === seq.current) { setError(true); setLoading(false); } return; }
    }
    try {
      const now = Date.now();
      const created = createdRef.current.preset ? dateRange(createdRef.current.preset, now, createdRef.current.custom) : undefined;
      const activity = activityRef.current.preset ? dateRange(activityRef.current.preset, now, activityRef.current.custom) : undefined;
      const r = await listCompanies(t, { q: query, after: cursor, limit: 25, ownerId: ownerRef.current || undefined, created, activity });
      if (mySeq !== seq.current) return;
      if (r.error) { setError(true); return; }
      setItems(prev => cursor ? [...prev, ...r.items] : r.items);
      setAfter(r.after);
    } catch (e) {
      if (String(e).includes(": 403")) { tokenRef.current = ""; setToken(""); } // expired -> Retry re-fetches
      if (mySeq === seq.current) setError(true);
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }

  // Debounced reload on query change (immediate for the initial/cleared box, which also fetches the token).
  // Load-more calls load() directly.
  useEffect(() => {
    setAfter(null);   // a query/filter change resets pagination now, so a stale "Load more" cursor can't fire mid-debounce
    const t = setTimeout(() => { void load(q); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, ownerId, createdF, activityF]);

  useEffect(() => { if (token) getOwners(token).then(setOwners).catch(() => {}); }, [token]);

  function onCreateDeal(seed: NewDealSeed) {
    navigate("/board", { state: { newDeal: seed } });
  }

  const showEmpty = !loading && !error && items.length === 0;

  return (
    <div className="dc-wrap">
      <div className="dc-header">
        <h1 className="dc-title">Companies</h1>
        {!!items.length && <span className="dc-sub">{items.length}{after ? "+" : ""}</span>}
      </div>

      <div className="dc-toolbar">
        <div className="dc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input className="dc-input" placeholder="Search companies by name or domain" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="dc-select" value={ownerId} onChange={e => setOwnerId(e.target.value)}>
          <option value="">All owners</option>
          {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <DateRangeFilter label="Created" value={createdF} onChange={setCreatedF} />
        <DateRangeFilter label="Last activity" value={activityF} onChange={setActivityF} />
      </div>

      <div className="dc-panel">
        <div className="dc-table-scroll">
          <table className="dc-table">
            <thead><tr>
              <th>Company</th><th>Domain</th><th>Industry</th><th>Location</th><th>Owner / Sales user</th><th>Created</th>
            </tr></thead>
            <tbody>
              {loading && items.length === 0
                ? Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={6}><div className="dc-skeleton" /></td></tr>)
                : error && items.length === 0
                ? <tr><td colSpan={6}><div className="dc-empty">Companies unavailable. <button className="dc-btn dc-btn-sm" onClick={() => void load(q)}>Retry</button></div></td></tr>
                : showEmpty
                ? <tr><td colSpan={6}><div className="dc-empty">No companies match.</div></td></tr>
                : items.map(c => {
                    const label = c.name || c.domain || "Company";
                    return (
                      <tr key={c.hubspotId} onClick={() => setOpen(c)}>
                        <td>
                          <div className="dc-deal">
                            <span className="dc-avatar" style={{ background: avatarFor(label) }}>{initials(label)}</span>
                            <span className="dc-deal-name" title={label}>{label}</span>
                          </div>
                        </td>
                        <td className={c.domain ? "" : "dc-mut"}>{orDash(c.domain)}</td>
                        <td className={c.industry ? "" : "dc-mut"}>{orDash(c.industry)}</td>
                        <td className="dc-mut">{orDash([c.city, c.state].filter(Boolean).join(", "))}</td>
                        <td className="dc-trunc">{orDash(c.ownerName || c.salesUser)}</td>
                        <td className="dc-mut" style={{ whiteSpace: "nowrap" }}>{fmtCompanyDate(c.createdate)}</td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
        {after && !showEmpty && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: 12 }}>
            {error && items.length > 0 && <span className="dc-mut" style={{ fontSize: 13 }}>Couldn't load more.</span>}
            <button className="dc-btn dc-btn-ghost dc-btn-sm" disabled={loading} onClick={() => void load(q, after)}>
              {loading ? "Loading…" : (error && items.length > 0) ? "Retry" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {open && <CompanyDrawer company={open} token={token} onClose={() => setOpen(null)} onCreateDeal={onCreateDeal} />}
    </div>
  );
}
