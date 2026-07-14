import { useState } from "react";
import { searchHubspot, deleteHubspotAssociation, type Hit } from "../worker-client";
import { findOrCreateContact, findOrCreateCompany, createContactCard, createCompanyCard } from "../monday-client";

export interface Assoc { hubspotId: string; itemId: string; label: string }
interface Props {
  kind: "contacts" | "companies"; token: string; dealHubspotId: string | null;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
  onError?: (msg: string) => void;
}

export default function AssociationPicker({ kind, token, dealHubspotId, value, onChange, onError }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newDomain, setNewDomain] = useState("");

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) { setHits([]); return; }
    try { setHits(await searchHubspot(token, kind, text)); } catch { setHits([]); onError?.("Search unavailable"); }
  }
  async function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    try {
      const itemId = kind === "contacts"
        ? await findOrCreateContact(hit.id, hit.name) : await findOrCreateCompany(hit.id, hit.name);
      onChange([...value, { hubspotId: hit.id, itemId, label: hit.name }]);
      setQ(""); setHits([]);
    } catch (e) { onError?.("Couldn't add: " + String(e).slice(0, 120)); }
  }
  async function remove(a: Assoc) {
    if (dealHubspotId && a.hubspotId) {
      try { await deleteHubspotAssociation(token, kind, dealHubspotId, a.hubspotId); }
      catch (e) { onError?.("Couldn't unlink in HubSpot: " + String(e).slice(0, 120)); }
    }
    onChange(value.filter(v => v.itemId !== a.itemId));
  }
  function resetNewForm() {
    setNewName(""); setNewEmail(""); setNewPhone(""); setNewDomain(""); setCreating(false);
  }
  async function createNew() {
    const name = newName.trim();
    if (!name) return;
    try {
      const itemId = kind === "contacts"
        ? await createContactCard({ name, email: newEmail.trim() || undefined, phone: newPhone.trim() || undefined })
        : await createCompanyCard({ name, domain: newDomain.trim() || undefined });
      onChange([...value, { hubspotId: "", itemId, label: name }]);
      resetNewForm();
    } catch (e) { onError?.("Couldn't create: " + String(e).slice(0, 120)); }
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
      {!creating && (
        <button type="button" className="dc-btn dc-btn-sm" style={{ marginTop: 8 }} onClick={() => setCreating(true)}>
          ＋ New {kind === "contacts" ? "contact" : "company"}
        </button>
      )}
      {creating && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {kind === "contacts" ? (
            <>
              <input className="dc-field-input" placeholder="Name (required)" value={newName} onChange={e => setNewName(e.target.value)} />
              <input className="dc-field-input" placeholder="Email" value={newEmail} onChange={e => setNewEmail(e.target.value)} />
              <input className="dc-field-input" placeholder="Phone" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
            </>
          ) : (
            <>
              <input className="dc-field-input" placeholder="Company name (required)" value={newName} onChange={e => setNewName(e.target.value)} />
              <input className="dc-field-input" placeholder="Domain" value={newDomain} onChange={e => setNewDomain(e.target.value)} />
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="dc-btn dc-btn-sm" disabled={!newName.trim()} onClick={() => void createNew()}>Create</button>
            <button type="button" className="dc-btn dc-btn-sm" onClick={resetNewForm}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
