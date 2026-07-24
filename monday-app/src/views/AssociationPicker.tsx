import { useEffect, useState } from "react";
import { searchHubspot, type Hit } from "../worker-client";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";
import { openLink } from "../monday-client";
import { hubspotRecordUrl } from "../board-config";

import type { Assoc } from "../lib/assoc";
export type { Assoc };
interface Props {
  kind: "contacts" | "companies"; token: string;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
  single?: boolean;   // keep at most one staged link
}

/** Picker for the deal's contact/company links: search the LIVE HubSpot CRM and stage a link. Creating new
 * contacts/companies is done elsewhere (removed here). Everything is staged; the drawer resolves cards on Save. */
export default function AssociationPicker({ kind, token, value, onChange, single }: Props) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(-1);
  const { hits, total, loading, error, query, clear } = useDebouncedSearch<Hit>(
    (q, signal) => searchHubspot(token, kind, q, signal), 300);

  useEffect(() => { setActive(-1); }, [hits]);

  function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    const link = { hubspotId: hit.id, label: hit.name };
    onChange(single ? [link] : [...value, link]);
    clear(); setText("");
  }
  function remove(a: Assoc) { onChange(value.filter(v => v !== a)); }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { if (active >= 0 && hits[active]) { e.preventDefault(); add(hits[active]); } }
    else if (e.key === "Escape") { e.stopPropagation(); clear(); setText(""); } // don't bubble to the drawer's Esc-close
  }

  return (
    <div>
      <div className="dc-section-title">{kind === "contacts" ? "Contacts" : "Companies"}</div>
      {value.length > 0 && (
        <div className="dc-chips">
          {value.map((a, i) => (
            <span key={a.itemId || a.hubspotId || i} className="dc-chip">{a.label}
              {a.hubspotId && (
                <button type="button" className="dc-chip-link" title="Open in HubSpot" aria-label="Open in HubSpot"
                  onClick={() => openLink(hubspotRecordUrl(kind, a.hubspotId!))}>↗</button>
              )}
              <button onClick={() => remove(a)} aria-label="Remove">×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input className="dc-field-input" style={{ flex: 1 }} placeholder={`Search ${kind}…`}
          value={text} onChange={e => { setText(e.target.value); query(e.target.value); }} onKeyDown={onKeyDown} />
        {loading && <div className="dc-spinner" style={{ width: 16, height: 16, borderWidth: 2, margin: 0 }} />}
      </div>
      {error && (
        <div className="dc-err" style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Search unavailable</span>
          <button type="button" className="dc-btn dc-btn-sm" onClick={() => query(text)}>Retry</button>
        </div>
      )}
      {hits.length > 0 && (
        <div className="dc-results">
          {hits.map((h, idx) => (
            <div key={h.id} className="dc-result" onMouseEnter={() => setActive(idx)} onClick={() => add(h)}
              style={{ alignItems: "center", background: idx === active ? "var(--surface-hover)" : undefined }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{h.name}</span>
                {h.secondary && <small>{h.secondary}</small>}
              </div>
              <small style={{ flexShrink: 0, fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase" }}>Existing</small>
            </div>
          ))}
          {total > hits.length && <div className="dc-mut" style={{ padding: "6px 12px", fontSize: 12.5 }}>More matches — keep typing to narrow.</div>}
        </div>
      )}
      {!loading && !error && text.trim().length >= 2 && hits.length === 0 &&
        <div className="dc-mut" style={{ marginTop: 6, fontSize: 12.5 }}>No {kind} found.</div>}
    </div>
  );
}
