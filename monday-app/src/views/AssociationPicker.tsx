import { useEffect, useState } from "react";
import { searchHubspot, deleteHubspotAssociation, type Hit } from "../worker-client";
import { findOrCreateContact, findOrCreateCompany, createContactCard, createCompanyCard } from "../monday-client";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";

export interface Assoc { hubspotId: string; itemId: string; label: string }
interface Props {
  kind: "contacts" | "companies"; token: string; dealHubspotId: string | null;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
  onError?: (msg: string) => void;
}

export default function AssociationPicker({ kind, token, dealHubspotId, value, onChange, onError }: Props) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(-1);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [dupMatch, setDupMatch] = useState<Hit | null>(null);

  const { hits, loading, error, query, clear } = useDebouncedSearch<Hit>(
    (q, signal) => searchHubspot(token, kind, q, signal), 300);

  // Keep the highlighted row in sync whenever the result set changes.
  useEffect(() => { setActive(-1); }, [hits]);

  async function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    try {
      const itemId = kind === "contacts"
        ? await findOrCreateContact(hit.id, hit.name) : await findOrCreateCompany(hit.id, hit.name);
      onChange([...value, { hubspotId: hit.id, itemId, label: hit.name }]);
      clear(); setText("");
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
    setNewName(""); setNewEmail(""); setNewPhone(""); setNewDomain(""); setCreating(false); setDupMatch(null);
  }

  /** Look for a likely-duplicate among the current search hits, keyed on email/domain or exact name. */
  function findDuplicate(): Hit | null {
    const name = newName.trim();
    if (kind === "contacts") {
      const email = newEmail.trim().toLowerCase();
      return hits.find(h => (email && h.secondary?.toLowerCase() === email) || h.name === name) ?? null;
    }
    const domain = newDomain.trim().toLowerCase();
    return hits.find(h => (domain && h.secondary?.toLowerCase() === domain) || h.name === name) ?? null;
  }

  async function doCreate() {
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
  function createNew() {
    const name = newName.trim();
    if (!name) return;
    const dup = findDuplicate();
    if (dup) { setDupMatch(dup); return; }
    void doCreate();
  }
  async function createAnyway() {
    setDupMatch(null);
    await doCreate();
  }
  async function linkInstead() {
    if (!dupMatch) return;
    await add(dupMatch);
    resetNewForm();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { if (active >= 0 && hits[active]) { e.preventDefault(); void add(hits[active]); } }
    else if (e.key === "Escape") { clear(); setText(""); }
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="dc-field-input"
          style={{ flex: 1 }}
          placeholder={`Search ${kind}…`}
          value={text}
          onChange={e => { setText(e.target.value); query(e.target.value); }}
          onKeyDown={onKeyDown}
        />
        {loading && <div className="dc-spinner" style={{ width: 16, height: 16, borderWidth: 2, margin: 0 }} />}
      </div>
      {error && <div className="dc-mut" style={{ fontSize: 12.5, marginTop: 4 }}>Search unavailable</div>}
      {hits.length > 0 && (
        <div className="dc-results">
          {hits.map((h, idx) => (
            <div
              key={h.id}
              className="dc-result"
              onMouseEnter={() => setActive(idx)}
              onClick={() => void add(h)}
              style={{ alignItems: "center", background: idx === active ? "var(--surface-hover)" : undefined }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{h.name}</span>
                {h.secondary && <small>{h.secondary}</small>}
              </div>
              <small style={{ flexShrink: 0, fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase" }}>Existing</small>
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
          {dupMatch ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, background: "var(--amber-soft)", borderRadius: 10, padding: "10px 12px" }}>
              <span style={{ color: "var(--amber)", fontSize: 13.5 }}>
                A similar record already exists: {dupMatch.name} · {dupMatch.secondary}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="dc-btn dc-btn-sm" onClick={() => void linkInstead()}>Link it instead</button>
                <button type="button" className="dc-btn dc-btn-sm" onClick={() => void createAnyway()}>Create anyway</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="dc-btn dc-btn-sm" disabled={!newName.trim()} onClick={createNew}>Create</button>
              <button type="button" className="dc-btn dc-btn-sm" onClick={resetNewForm}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
