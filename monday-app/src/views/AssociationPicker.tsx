import { useState } from "react";
import { Search, Chips } from "@vibe/core";
import { searchHubspot, deleteHubspotAssociation, type Hit } from "../worker-client";
import { findOrCreateContact, findOrCreateCompany } from "../monday-client";

export interface Assoc { hubspotId: string; itemId: string; label: string }
interface Props {
  kind: "contacts" | "companies"; token: string; dealHubspotId: string | null;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
}

const hitRow: React.CSSProperties = { cursor: "pointer", padding: "4px 6px", fontSize: 13, borderRadius: 4 };

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
    // Propagate the unlink only when both the deal and the linked record already exist in HubSpot;
    // otherwise just drop the monday link (nothing to disassociate yet).
    if (dealHubspotId && a.hubspotId) {
      try { await deleteHubspotAssociation(token, kind, dealHubspotId, a.hubspotId); } catch { /* surfaced on save */ }
    }
    onChange(value.filter(v => v.itemId !== a.itemId));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <strong>{kind === "contacts" ? "Contacts" : "Companies"}</strong>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {value.map(a => (
          <Chips key={a.itemId} id={a.itemId} label={a.label} onDelete={() => void remove(a)} />
        ))}
      </div>
      <Search size="small" placeholder={`Search ${kind}`} value={q} onChange={search} />
      {hits.map(h => (
        <div key={h.id} style={hitRow} onClick={() => void add(h)}>{h.name} · {h.secondary}</div>
      ))}
    </div>
  );
}
