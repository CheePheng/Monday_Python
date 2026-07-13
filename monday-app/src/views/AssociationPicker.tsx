import { useState } from "react";
import { searchHubspot, deleteHubspotAssociation, type Hit } from "../worker-client";
import { findOrCreateContact, findOrCreateCompany } from "../monday-client";

export interface Assoc { hubspotId: string; itemId: string; label: string }
interface Props {
  kind: "contacts" | "companies"; token: string; dealHubspotId: string | null;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
}

export default function AssociationPicker({ kind, token, dealHubspotId, value, onChange }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) { setHits([]); return; }
    try { setHits(await searchHubspot(token, kind, text)); } catch { setHits([]); }
  }
  async function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    const itemId = kind === "contacts"
      ? await findOrCreateContact(hit.id, hit.name) : await findOrCreateCompany(hit.id, hit.name);
    onChange([...value, { hubspotId: hit.id, itemId, label: hit.name }]);
    setQ(""); setHits([]);
  }
  async function remove(a: Assoc) {
    if (dealHubspotId && a.hubspotId) {
      try { await deleteHubspotAssociation(token, kind, dealHubspotId, a.hubspotId); } catch { /* surfaced on save */ }
    }
    onChange(value.filter(v => v.itemId !== a.itemId));
  }

  return (
    <div>
      <div className="dc-section-title">{kind === "contacts" ? "Contacts" : "Companies"}</div>
      {value.length > 0 && (
        <div className="dc-chips">
          {value.map(a => (
            <span key={a.itemId} className="dc-chip">{a.label}
              <button onClick={() => void remove(a)} aria-label="Remove">×</button>
            </span>
          ))}
        </div>
      )}
      <input className="dc-field-input" placeholder={`Search ${kind}…`} value={q} onChange={e => void search(e.target.value)} />
      {hits.length > 0 && (
        <div className="dc-results">
          {hits.map(h => (
            <div key={h.id} className="dc-result" onClick={() => void add(h)}>
              <span>{h.name}</span><small>{h.secondary}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
