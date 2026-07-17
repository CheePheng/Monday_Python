import { useEffect, useState } from "react";
import { searchHubspot, type Hit } from "../worker-client";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";

/** A record to create when the deal is saved (it exists in neither monday nor HubSpot yet). */
export type NewRecord =
  | { kind: "contact"; name: string; email?: string; phone?: string }
  | { kind: "company"; name: string; domain?: string };

export interface Assoc {
  hubspotId: string;   // "" for a record that isn't in HubSpot yet
  itemId?: string;     // set once the monday card exists: hydrated on open, or created on Save
  label: string;
  create?: NewRecord;  // staged new record; resolved by the drawer on Save
}
interface Props {
  kind: "contacts" | "companies"; token: string;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
}

/** Picker for the deal's contact/company links. Everything here is STAGED: no card is created and
 * nothing is unlinked in HubSpot until the drawer is saved, so Cancel really cancels and an abandoned
 * draft can't leave an orphan record behind. The drawer resolves `create`/missing `itemId` on Save. */
export default function AssociationPicker({ kind, token, value, onChange }: Props) {
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
  // The duplicate check needs its OWN lookup. It used to read the search box's results, so typing a
  // name straight into the new-record form — the normal path — compared against nothing and never warned.
  const dup = useDebouncedSearch<Hit>((q, signal) => searchHubspot(token, kind, q, signal), 300);

  useEffect(() => { setActive(-1); }, [hits]);

  const probeDup = (name: string, email: string, domain: string) =>
    dup.query(kind === "contacts" ? (email.trim() || name.trim()) : (domain.trim() || name.trim()));

  function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    onChange([...value, { hubspotId: hit.id, label: hit.name }]);
    clear(); setText("");
  }
  function remove(a: Assoc) { onChange(value.filter(v => v !== a)); }
  function resetNewForm() {
    setNewName(""); setNewEmail(""); setNewPhone(""); setNewDomain(""); setCreating(false);
    setDupMatch(null); dup.clear();
  }

  /** A likely duplicate among the lookups for what's being typed, keyed on email/domain or exact name. */
  function findDuplicate(): Hit | null {
    const name = newName.trim();
    if (kind === "contacts") {
      const email = newEmail.trim().toLowerCase();
      return dup.hits.find(h => (email && h.secondary?.toLowerCase() === email) || h.name === name) ?? null;
    }
    const domain = newDomain.trim().toLowerCase();
    return dup.hits.find(h => (domain && h.secondary?.toLowerCase() === domain) || h.name === name) ?? null;
  }

  function stageNew() {
    const name = newName.trim();
    if (!name) return;
    const rec: NewRecord = kind === "contacts"
      ? { kind: "contact", name, email: newEmail.trim() || undefined, phone: newPhone.trim() || undefined }
      : { kind: "company", name, domain: newDomain.trim() || undefined };
    onChange([...value, { hubspotId: "", label: name, create: rec }]);
    resetNewForm();
  }
  function createNew() {
    if (!newName.trim()) return;
    const d = findDuplicate();
    if (d) { setDupMatch(d); return; }
    stageNew();
  }
  function linkInstead() { if (dupMatch) { add(dupMatch); resetNewForm(); } }

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
            <span key={a.itemId || a.hubspotId || `new-${i}`} className="dc-chip">
              {a.label}{a.create && <small style={{ opacity: .7, marginLeft: 4 }}>new</small>}
              <button onClick={() => remove(a)} aria-label="Remove">×</button>
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
              onClick={() => add(h)}
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
              <input className="dc-field-input" placeholder="Name (required)" value={newName}
                onChange={e => { setNewName(e.target.value); probeDup(e.target.value, newEmail, ""); }} />
              <input className="dc-field-input" placeholder="Email" value={newEmail}
                onChange={e => { setNewEmail(e.target.value); probeDup(newName, e.target.value, ""); }} />
              <input className="dc-field-input" placeholder="Phone" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
            </>
          ) : (
            <>
              <input className="dc-field-input" placeholder="Company name (required)" value={newName}
                onChange={e => { setNewName(e.target.value); probeDup(e.target.value, "", newDomain); }} />
              <input className="dc-field-input" placeholder="Domain" value={newDomain}
                onChange={e => { setNewDomain(e.target.value); probeDup(newName, "", e.target.value); }} />
            </>
          )}
          {dupMatch ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, background: "var(--amber-soft)", borderRadius: 10, padding: "10px 12px" }}>
              <span style={{ color: "var(--amber)", fontSize: 13.5 }}>
                A similar record already exists: {dupMatch.name} · {dupMatch.secondary}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="dc-btn dc-btn-sm" onClick={linkInstead}>Link it instead</button>
                <button type="button" className="dc-btn dc-btn-sm" onClick={() => { setDupMatch(null); stageNew(); }}>Create anyway</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button type="button" className="dc-btn dc-btn-sm" disabled={!newName.trim()} onClick={createNew}>Add</button>
              <button type="button" className="dc-btn dc-btn-sm" onClick={resetNewForm}>Cancel</button>
              {dup.loading && <div className="dc-spinner" style={{ width: 14, height: 14, borderWidth: 2, margin: 0 }} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
