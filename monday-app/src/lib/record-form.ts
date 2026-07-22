// Standalone Contact/Company create forms. Field names mirror the Phase A server allowlists exactly
// (worker/src/contact-company-props.ts). Owner / sales_user are NOT fields — the Worker sets them from
// the acting rep (session token). Enum options are loaded live from /app/{contact,company}-schema.

export type RecordFieldType = "text" | "textarea" | "email" | "number" | "enum";
export interface RecordField { prop: string; label: string; type: RecordFieldType; group: string; required?: boolean; recommended?: boolean }

export const CONTACT_FIELDS: RecordField[] = [
  { prop: "firstname", label: "First name", type: "text", group: "Identity", required: true },
  { prop: "lastname", label: "Last name", type: "text", group: "Identity" },
  { prop: "email", label: "Email", type: "email", group: "Identity", recommended: true },
  { prop: "phone", label: "Phone", type: "text", group: "Identity" },
  { prop: "jobtitle", label: "Job title", type: "text", group: "Work" },
  { prop: "company", label: "Company", type: "text", group: "Work" },
  { prop: "hs_lead_status", label: "Lead status", type: "enum", group: "Work" },
  { prop: "leadsource", label: "Lead source", type: "enum", group: "Work" },
  { prop: "manufacturer__c", label: "Vendor", type: "enum", group: "Work" },
];

export const COMPANY_FIELDS: RecordField[] = [
  { prop: "name", label: "Company name", type: "text", group: "Identity", required: true },
  { prop: "domain", label: "Domain", type: "text", group: "Identity", recommended: true },
  { prop: "industry", label: "Industry", type: "enum", group: "Identity" },
  { prop: "type", label: "Type", type: "enum", group: "Identity" },
  { prop: "partner_with", label: "Partner with", type: "enum", group: "Identity" },
  { prop: "city", label: "City", type: "text", group: "Location" },
  { prop: "state", label: "State", type: "text", group: "Location" },
  { prop: "numberofemployees", label: "Employees", type: "number", group: "Details" },
  { prop: "annualrevenue", label: "Annual revenue", type: "number", group: "Details" },
  { prop: "description", label: "Description", type: "textarea", group: "Details" },
  { prop: "linkedin_company_page", label: "LinkedIn", type: "text", group: "Details" },
];

export type RecordKind = "contact" | "company";
export type RecordFormValues = Record<string, string | undefined>;

export function fieldsFor(kind: RecordKind): RecordField[] { return kind === "contact" ? CONTACT_FIELDS : COMPANY_FIELDS; }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateRecordForm(kind: RecordKind, v: RecordFormValues):
    { ok: boolean; errors: Record<string, string>; warnings: Record<string, string> } {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  for (const f of fieldsFor(kind)) if (f.required && !v[f.prop]?.trim()) errors[f.prop] = `${f.label} is required`;
  if (kind === "contact" && v.email?.trim() && !EMAIL_RE.test(v.email.trim())) errors.email = "Enter a valid email";
  // Duplicate-risk warnings: email (contact) / domain (company) are the dedup keys.
  if (kind === "contact" && !v.email?.trim()) warnings.email = "No email — duplicates can't be detected reliably. Double-check this isn't already in HubSpot.";
  if (kind === "company" && !v.domain?.trim()) warnings.domain = "No domain — duplicates can't be detected reliably. Double-check this isn't already in HubSpot.";
  return { ok: Object.keys(errors).length === 0, errors, warnings };
}

/** Map the form values to the HubSpot properties object sent to the Worker (trimmed; empties dropped;
 * only fields that belong to this kind). */
export function recordFormToProperties(kind: RecordKind, v: RecordFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fieldsFor(kind)) { const t = v[f.prop]?.trim(); if (t) out[f.prop] = t; }
  return out;
}
