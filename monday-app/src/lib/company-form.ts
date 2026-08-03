import { COMPANY_COLS } from "../board-config";
import { peopleValue } from "./columns";

export interface CompanyForm {
  name?: string; industry?: string; type?: string; salesUserId?: string; ownerId?: string;
  city?: string; state?: string; employees?: string; revenue?: string; linkedin?: string; description?: string;
}

/** Company form -> monday column_values (JSON-encode before sending). Empty fields are OMITTED (no clear
 * path in v1). Enums use labels (status -> {label}, dropdown -> {labels:[label]}), people -> personsAndTeams.
 * The item name (domain) is set separately via renameItem. */
export function companyFormToColumnValues(f: CompanyForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (f.name?.trim()) cv[COMPANY_COLS.name.id] = f.name;
  if (f.industry?.trim()) cv[COMPANY_COLS.industry.id] = { labels: [f.industry] };
  if (f.type?.trim()) cv[COMPANY_COLS.type.id] = { label: f.type };
  if (f.salesUserId) cv[COMPANY_COLS.salesUsers.id] = peopleValue([f.salesUserId]);
  if (f.ownerId) cv[COMPANY_COLS.owner.id] = peopleValue([f.ownerId]);
  if (f.city?.trim()) cv[COMPANY_COLS.city.id] = f.city;
  if (f.state?.trim()) cv[COMPANY_COLS.state.id] = f.state;
  if (f.employees?.trim()) cv[COMPANY_COLS.employees.id] = f.employees;
  if (f.revenue?.trim()) cv[COMPANY_COLS.revenue.id] = f.revenue;
  if (f.linkedin?.trim()) cv[COMPANY_COLS.linkedin.id] = f.linkedin;
  if (f.description?.trim()) cv[COMPANY_COLS.description.id] = f.description;
  return cv;
}
