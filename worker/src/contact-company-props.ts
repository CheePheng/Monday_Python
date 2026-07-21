// Server-side allowlists for app-driven Contact/Company creation. A create may write any board-mapped
// field EXCEPT the owner fields (sales_user / hubspot_owner_id — set server-side by the owner resolver)
// and read-only system fields. Mirrors line-item-props.ts. Keep in sync with CONTACTS_MYLA /
// COMPANIES_MYLA in config.ts (the write props are the mapped `hs` names minus the exclusions).

export const CONTACT_WRITE_PROPS = new Set<string>([
  "firstname", "lastname", "email", "jobtitle", "phone", "company",
  "hs_lead_status", "leadsource", "manufacturer__c",
]);
export const COMPANY_WRITE_PROPS = new Set<string>([
  "name", "domain", "industry", "type", "partner_with",
  "city", "state", "numberofemployees", "annualrevenue", "description", "linkedin_company_page",
]);

// Enum props whose live options the create forms load from the property schema (no hardcoded options).
export const CONTACT_ENUM_PROPS = ["hs_lead_status", "leadsource", "manufacturer__c"];
export const COMPANY_ENUM_PROPS = ["industry", "type", "partner_with"];

function pick(allow: Set<string>, props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!allow.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    out[k] = String(v);
  }
  return out;
}
export const pickWritableContactProps = (p: Record<string, unknown>) => pick(CONTACT_WRITE_PROPS, p);
export const pickWritableCompanyProps = (p: Record<string, unknown>) => pick(COMPANY_WRITE_PROPS, p);
