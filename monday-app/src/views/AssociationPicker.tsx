import { useState } from "react";
import { searchHubspot, deleteHubspotAssociation, type Hit } from "../worker-client";
import { findOrCreateContact, findOrCreateCompany } from "../monday-client";

export interface Assoc { hubspotId: string; itemId: string; label: string }
interface Props {
  kind: "contacts" | "companies"; token: string; dealHubspotId: string | null;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
}

const chip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 12,
  background: "var(--primary-selected-color, #cce5ff)", fontSize: 13,
};
const hitRow: React.CSSProperties = { cursor: "pointer", padding: "4px 6px", fontSize: 13 };

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
    // If the deal is already synced to HubSpot, propagate the unlink; otherwise just drop it locally.
    if (dealHubspotId) { try { await deleteHubspotAssociation(token, kind, dealHubspotId, a.hubspotId); } catch { /* surfaced on save */ } }
    onChange(value.filter(v => v.hubspotId !== a.hubspotId));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <strong>{kind === "contacts" ? "Contacts" : "Companies"}</strong>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {value.map(a => (
          <span key={a.hubspotId} style={chip}>
            {a.label}
            <span style={{ cursor: "pointer", fontWeight: 700 }} onClick={() => void remove(a)}>×</span>
          </span>
        ))}
      </div>
      <input placeholder={`Search ${kind}`} value={q} onChange={e => void search(e.target.value)}
        style={{ padding: "6px 10px" }} />
      {hits.map(h => (
        <div key={h.id} style={hitRow} onClick={() => void add(h)}>{h.name} · {h.secondary}</div>
      ))}
    </div>
  );
}
