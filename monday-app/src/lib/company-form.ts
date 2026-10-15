import { COMPANY_COLS } from "../board-config";
import { peopleValue } from "./columns";

export interface CompanyForm {
  name?: string; industry?: string; type?: string; salesUserId?: string; ownerId?: string;
  city?: string; state?: string; employees?: string; revenue?: string; linkedin?: string; description?: string;
}

/** Company form -> monday column_values (JSON-encode before sending). Empty fields are OMITTED (no clear
 * path in v1). Enums use labels (status -> {label}, dropdown -> {labels:[label]}), people -> personsAndTeams.
 * The item name (domain) is set separately via renameItem. */
/** Only columns whose value CHANGED are written. Rewriting an untouched column is not harmless here:
 *  - a MULTI-value dropdown hydrates as monday's rendered text ("A, B"); re-sending that as a single
 *    label is an unknown label, and monday rejects the WHOLE mutation -> the contact becomes unsavable;
 *  - a people column holding two assignees hydrates as the first one, so a rewrite silently drops the rest;
 *  - a phone column loses the country flag the rep picked.
 * A field the rep genuinely edits is a single picked value, which is always valid. */
export function companyFormToColumnValues(f: CompanyForm, orig?: CompanyForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  const changed = (k: keyof CompanyForm) => !orig || (f[k] ?? "") !== (orig[k] ?? "");
  if (changed("name") && f.name?.trim()) cv[COMPANY_COLS.name.id] = f.name;
  if (changed("industry") && f.industry?.trim()) cv[COMPANY_COLS.industry.id] = { labels: [f.industry] };
  if (changed("type") && f.type?.trim()) cv[COMPANY_COLS.type.id] = { label: f.type };
  if (changed("salesUserId") && f.salesUserId) cv[COMPANY_COLS.salesUsers.id] = peopleValue([f.salesUserId]);
  if (changed("ownerId") && f.ownerId) cv[COMPANY_COLS.owner.id] = peopleValue([f.ownerId]);
  if (changed("city") && f.city?.trim()) cv[COMPANY_COLS.city.id] = f.city;
  if (changed("state") && f.state?.trim()) cv[COMPANY_COLS.state.id] = f.state;
  if (changed("employees") && f.employees?.trim()) cv[COMPANY_COLS.employees.id] = f.employees;
  if (changed("revenue") && f.revenue?.trim()) cv[COMPANY_COLS.revenue.id] = f.revenue;
  if (changed("linkedin") && f.linkedin?.trim()) cv[COMPANY_COLS.linkedin.id] = f.linkedin;
  if (changed("description") && f.description?.trim()) cv[COMPANY_COLS.description.id] = f.description;
  return cv;
}

/** HubSpot props the rep DELIBERATELY emptied (loaded with a value, now blank). An already-empty field is
 * never a clear, so sync lag can't wipe HubSpot. Only server-allowlisted props (never name/domain). */
const CLEARABLE: [keyof CompanyForm, string, string][] = [
  ["industry", "industry", COMPANY_COLS.industry.id],
  ["type", "type", COMPANY_COLS.type.id],
  ["city", "city", COMPANY_COLS.city.id],
  ["state", "state", COMPANY_COLS.state.id],
  ["employees", "numberofemployees", COMPANY_COLS.employees.id],
  ["revenue", "annualrevenue", COMPANY_COLS.revenue.id],
  ["linkedin", "linkedin_company_page", COMPANY_COLS.linkedin.id],
  ["description", "description", COMPANY_COLS.description.id],
  ["salesUserId", "sales_user", COMPANY_COLS.salesUsers.id],
  ["ownerId", "hubspot_owner_id", COMPANY_COLS.owner.id],
];
export function companyClears(orig: CompanyForm, now: CompanyForm): { props: string[]; cols: Record<string, null> } {
  const props: string[] = []; const cols: Record<string, null> = {};
  for (const [key, hs, col] of CLEARABLE) {
    const had = (orig[key] ?? "").toString().trim(), has = (now[key] ?? "").toString().trim();
    if (had && !has) { props.push(hs); cols[col] = null; }
  }
  return { props, cols };
}
