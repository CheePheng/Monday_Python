import { useEffect, useState } from "react";
import DrawerShell from "./DrawerShell";
import { getCompanyContacts, ensureCard, type Company, type CompanyContact } from "../worker-client";
import { openLink, openItemCard } from "../monday-client";
import { hubspotRecordUrl } from "../board-config";
import { fmtNumber, orDash, fmtCompanyDate, type NewDealSeed } from "../lib/companies";

interface Props {
  company: Company;
  token: string;
  onClose: () => void;
  onCreateDeal: (seed: NewDealSeed) => void;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="dc-detail">
      <div className="dc-detail-label">{label}</div>
      <div className="dc-detail-value">{value}</div>
    </div>
  );
}

export default function CompanyDrawer({ company, token, onClose, onCreateDeal }: Props) {
  const [contacts, setContacts] = useState<CompanyContact[] | null>(null);
  const [cErr, setCErr] = useState(false);
  const [opening, setOpening] = useState(false);
  const title = company.name || company.domain || "Company";

  async function loadContacts() {
    setCErr(false); setContacts(null);
    try { setContacts(await getCompanyContacts(token, company.hubspotId)); }
    catch { setCErr(true); }
  }
  useEffect(() => { void loadContacts(); }, [company.hubspotId]);

  async function openMondayCard() {
    setOpening(true);
    try { openItemCard(await ensureCard(token, "companies", company.hubspotId)); }
    catch { /* best effort */ }
    finally { setOpening(false); }
  }

  const count = contacts ? (contacts.length === 100 ? "100+" : String(contacts.length)) : "";
  const location = [company.city, company.state].filter(Boolean).join(", ");
  // HubSpot's linkedin_company_page may lack a scheme across 25k records; ensure a valid absolute URL.
  const linkedinUrl = company.linkedin
    ? (/^https?:\/\//i.test(company.linkedin) ? company.linkedin : `https://${company.linkedin}`)
    : "";

  return (
    <DrawerShell title={title} ariaLabel={`Company ${title}`} onClose={onClose}>
      <div className="dc-drawer-actions">
        <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("companies", company.hubspotId))}>↗ HubSpot</button>
        <button className="dc-btn dc-btn-sm" disabled={opening} onClick={() => void openMondayCard()}>{opening ? "Opening…" : "↗ monday card"}</button>
        <button className="dc-btn dc-btn-primary dc-btn-sm" onClick={() => onCreateDeal({ company: { hubspotId: company.hubspotId, name: title } })}>＋ Create deal</button>
      </div>

      <div className="dc-section-title">Company</div>
      <div className="dc-detail-grid">
        <Detail label="Domain" value={orDash(company.domain)} />
        <Detail label="Industry" value={orDash(company.industry)} />
        <Detail label="Type" value={orDash(company.type)} />
        <Detail label="Partner with" value={orDash(company.partnerWith)} />
        <Detail label="Location" value={orDash(location)} />
        <Detail label="Employees" value={fmtNumber(company.employees)} />
        <Detail label="Annual revenue" value={fmtNumber(company.revenue)} />
        <Detail label="Owner" value={orDash(company.ownerName)} />
        <Detail label="Sales user" value={orDash(company.salesUser)} />
        <Detail label="Created" value={fmtCompanyDate(company.createdate)} />
        <Detail label="LinkedIn" value={company.linkedin
          ? <a href={linkedinUrl} onClick={e => { e.preventDefault(); openLink(linkedinUrl); }}>{company.linkedin}</a>
          : "—"} />
      </div>
      {company.description && (
        <>
          <div className="dc-section-title">Description</div>
          <p className="dc-detail-desc">{company.description}</p>
        </>
      )}

      <div className="dc-section-title">Contacts{count ? ` (${count})` : ""}</div>
      {contacts === null && !cErr && <div className="dc-mut">Loading contacts…</div>}
      {cErr && (
        <div className="dc-empty">Couldn't load contacts. <button className="dc-btn dc-btn-sm" onClick={() => void loadContacts()}>Retry</button></div>
      )}
      {contacts && contacts.length === 0 && <div className="dc-mut">No linked contacts.</div>}
      {contacts && contacts.length > 0 && (
        <div className="dc-contact-list">
          {contacts.map(c => (
            <div key={c.hubspotId} className="dc-contact-row">
              <div className="dc-contact-info">
                <span className="dc-contact-name">{c.name}</span>
                {(c.email || c.title) && <span className="dc-mut">{[c.email, c.title].filter(Boolean).join(" · ")}</span>}
              </div>
              <div className="dc-contact-actions">
                <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("contacts", c.hubspotId))}>↗ HubSpot</button>
                <button className="dc-btn dc-btn-sm" onClick={() => onCreateDeal({ company: { hubspotId: company.hubspotId, name: title }, contact: { hubspotId: c.hubspotId, name: c.name } })}>＋ Deal</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DrawerShell>
  );
}
