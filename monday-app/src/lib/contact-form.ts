import { CONTACT_COLS } from "../board-config";
import { peopleValue } from "./columns";

export interface ContactForm {
  firstname?: string; lastname?: string; email?: string; jobtitle?: string; phone?: string;
  salesUserId?: string; ownerId?: string; leadStatus?: string; leadSource?: string; vendor?: string;
}

/** Contact form -> monday column_values (JSON-encode before sending). Empty fields OMITTED (no clear path
 * in v1). Enums use labels (status -> {label}, dropdown -> {labels:[label]}), people -> personsAndTeams.
 * The item name (firstname) is set separately via renameItem. */
/** Only columns whose value CHANGED are written. Rewriting an untouched column is not harmless here:
 *  - a MULTI-value dropdown hydrates as monday's rendered text ("A, B"); re-sending that as a single
 *    label is an unknown label, and monday rejects the WHOLE mutation -> the contact becomes unsavable;
 *  - a people column holding two assignees hydrates as the first one, so a rewrite silently drops the rest;
 *  - a phone column loses the country flag the rep picked.
 * A field the rep genuinely edits is a single picked value, which is always valid. */
export function contactFormToColumnValues(f: ContactForm, orig?: ContactForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  const changed = (k: keyof ContactForm) => !orig || (f[k] ?? "") !== (orig[k] ?? "");
  if (changed("lastname") && f.lastname?.trim()) cv[CONTACT_COLS.lastname.id] = f.lastname;
  if (changed("email") && f.email?.trim()) cv[CONTACT_COLS.email.id] = f.email;
  if (changed("jobtitle") && f.jobtitle?.trim()) cv[CONTACT_COLS.jobtitle.id] = f.jobtitle;
  // monday's phone column takes { phone }: digits, keeping a leading "+" (mirrors the Worker's
  // mapping.ts phone branch). The reconcile compares phone DIGITS on both sides, so formatting is free.
  // Canonical shape, identical to the Worker's mapping.ts phone branch: digits, keeping only a LEADING "+"
  // (a stray "+" mid-string would otherwise survive, e.g. "1+2"). Both writers must agree or the reconcile
  // sees drift.
  if (changed("phone") && f.phone?.trim()) {
    const t = f.phone.trim(), digits = t.replace(/[^\d]/g, "");
    if (digits) cv[CONTACT_COLS.phone.id] = { phone: t.startsWith("+") ? "+" + digits : digits };
  }
  if (changed("salesUserId") && f.salesUserId) cv[CONTACT_COLS.salesUsers.id] = peopleValue([f.salesUserId]);
  if (changed("ownerId") && f.ownerId) cv[CONTACT_COLS.owner.id] = peopleValue([f.ownerId]);
  if (changed("leadStatus") && f.leadStatus?.trim()) cv[CONTACT_COLS.leadStatus.id] = { label: f.leadStatus };
  if (changed("leadSource") && f.leadSource?.trim()) cv[CONTACT_COLS.leadSource.id] = { labels: [f.leadSource] };
  if (changed("vendor") && f.vendor?.trim()) cv[CONTACT_COLS.vendor.id] = { labels: [f.vendor] };
  return cv;
}

/** HubSpot props the rep DELIBERATELY emptied: the field loaded with a value and the box is now blank.
 * A field that was ALREADY empty is never a clear — monday being blank from sync lag must not wipe
 * HubSpot. Mirrors the deal drawer's deliberateClears. Only server-allowlisted props are listed. */
const CLEARABLE: [keyof ContactForm, string][] = [
  ["jobtitle", "jobtitle"], ["phone", "phone"], ["leadStatus", "hs_lead_status"],
  ["leadSource", "leadsource"], ["vendor", "manufacturer__c"],
  ["salesUserId", "sales_user"], ["ownerId", "hubspot_owner_id"],
];
export function contactClears(orig: ContactForm, now: ContactForm): { props: string[]; cols: Record<string, null> } {
  const props: string[] = []; const cols: Record<string, null> = {};
  const colOf: Record<string, string> = {
    jobtitle: CONTACT_COLS.jobtitle.id, phone: CONTACT_COLS.phone.id, leadStatus: CONTACT_COLS.leadStatus.id,
    leadSource: CONTACT_COLS.leadSource.id, vendor: CONTACT_COLS.vendor.id,
    salesUserId: CONTACT_COLS.salesUsers.id, ownerId: CONTACT_COLS.owner.id,
  };
  for (const [key, hs] of CLEARABLE) {
    const had = (orig[key] ?? "").toString().trim(), has = (now[key] ?? "").toString().trim();
    if (had && !has) { props.push(hs); cols[colOf[key as string]] = null; }  // null clears any monday column type
  }
  return { props, cols };
}
