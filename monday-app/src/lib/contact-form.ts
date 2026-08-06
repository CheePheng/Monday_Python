import { CONTACT_COLS } from "../board-config";
import { peopleValue } from "./columns";

export interface ContactForm {
  firstname?: string; lastname?: string; email?: string; jobtitle?: string;
  salesUserId?: string; ownerId?: string; leadStatus?: string; leadSource?: string; vendor?: string;
  // phone is displayed read-only until Task 8; intentionally not written here.
}

/** Contact form -> monday column_values (JSON-encode before sending). Empty fields OMITTED (no clear path
 * in v1). Enums use labels (status -> {label}, dropdown -> {labels:[label]}), people -> personsAndTeams.
 * The item name (firstname) is set separately via renameItem. */
export function contactFormToColumnValues(f: ContactForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (f.lastname?.trim()) cv[CONTACT_COLS.lastname.id] = f.lastname;
  if (f.email?.trim()) cv[CONTACT_COLS.email.id] = f.email;
  if (f.jobtitle?.trim()) cv[CONTACT_COLS.jobtitle.id] = f.jobtitle;
  if (f.salesUserId) cv[CONTACT_COLS.salesUsers.id] = peopleValue([f.salesUserId]);
  if (f.ownerId) cv[CONTACT_COLS.owner.id] = peopleValue([f.ownerId]);
  if (f.leadStatus?.trim()) cv[CONTACT_COLS.leadStatus.id] = { label: f.leadStatus };
  if (f.leadSource?.trim()) cv[CONTACT_COLS.leadSource.id] = { labels: [f.leadSource] };
  if (f.vendor?.trim()) cv[CONTACT_COLS.vendor.id] = { labels: [f.vendor] };
  return cv;
}
