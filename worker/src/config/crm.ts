import type { ObjectSpec, OwnershipSpec } from "../types";

/**
 * CRM sync configuration — the SECOND, independent HubSpot <-> monday sync.
 *
 * Every column id here was captured from the live boards after Task 5 (2026-09-07) and re-verified by
 * `crm-config.test.ts`. The pre-Task-5 `text_mm6t*` stubs no longer exist: monday cannot retype a column,
 * so each retype was a create-new + delete-old and the ids changed. Never reintroduce an old stub id.
 *
 * These specs are NOT reachable from a production deploy — routing is gated behind env.ENABLE_CRM,
 * which the production Worker does not set.
 */

/** Records created at/after this belong to the CRM sync.
 *  INERT IN PHASE 1: POSITIVE_INFINITY means nothing is ever post-cutover, so canClaimCrmOwnership and
 *  mayCreateCrmCard are both false for unstamped records — the CRM path can neither claim, write, nor
 *  card anything. Set a real timestamp only at Phase D, after full -> incremental -> two-way validation. */
export const CRM_CUTOVER_AT_MS = Number.POSITIVE_INFINITY;

/** monday CRM cards created BEFORE this never create a HubSpot record. A second, independent guard:
 *  kept even though createFromMonday is false for Contacts, because Accounts does create. */
export const CRM_CREATE_CUTOFF_MS = Number.POSITIVE_INFINITY;

const OWN_CONTACTS: OwnershipSpec = {
  prop: "sync_owner", createdProp: "createdate", owner: "crm", cutoverAtMs: CRM_CUTOVER_AT_MS,
};
const OWN_ACCOUNTS: OwnershipSpec = { ...OWN_CONTACTS };

/**
 * CRM CONTACTS — board 5028000495, group `topics` ("Active Contacts").
 *
 * CREATION IS HUBSPOT-ONLY (2026-09-07 meeting): `createFromMonday: false`. Approved fields still sync
 * two-way once the Contact exists; a row typed straight into the monday board creates nothing in HubSpot
 * (`sync.ts:576` logs reason="board not create-enabled"). Consequently there is NO `adoptBy` — adoption
 * by normalised email exists only to serve the monday->HubSpot create path — and NO `createDefaults`,
 * in particular no `createDefaults.sales_user`.
 *
 * `sales_user` plays NO part in CRM scope and is not mapped. `includeAll: true` bypasses the engine's
 * hardcoded sales_user/createdate gate (`sync.ts:458`), which would otherwise silently drop the ~1 in 3
 * new Contacts that carry no sales_user (771 of 2,318 created since June 2026). The no-historical-import
 * invariant is carried instead by `mayCreateCrmCard` at the card-creation chokepoint (Task 3B) — the two
 * settings are a pair and must never be separated.
 */
export const CRM_CONTACTS: ObjectSpec = {
  object: "contacts",
  objectTypeId: "0-1",
  // DEAD BY CONSTRUCTION: `includeAll` makes searchModifiedIds ignore searchFilters (hubspot.ts:505) and
  // `skipFullReconcile` excludes the sweep that would otherwise use them. Asserted by test so this empty
  // array can never become the operative scope gate.
  searchFilters: [],
  modifiedProp: "lastmodifieddate",          // contacts, NOT hs_lastmodifieddate
  nameProps: ["firstname", "lastname"],
  // nameReverse deliberately omitted: renaming a card must not rewrite a HubSpot name.
  boardId: "5028000495",
  idCol: "text_mm6t71dj",                    // "HubSpot ID"
  syncStateCol: "text_mm6twy4w",             // "Sync State"
  linkCol: "link_mm6z7mj",                   // "HubSpot Link" (created Task 5)
  groupBy: { singleGroup: "topics" },        // Active/Inactive group sync is out of Phase 1 scope
  includeAll: true,                          // SAFE ONLY WITH Task 3B's mayCreateCrmCard
  skipFullReconcile: true,
  ownership: OWN_CONTACTS,
  createFromMonday: false,                   // HubSpot is the creation source for Contacts
  // no createDefaults, no adoptBy
  // CONTACT <-> COMPANY, HUBSPOT -> MONDAY ONLY. Fills the board's NATIVE `contact_account` relation
  // with the CRM Account cards for this contact's HubSpot company associations. The reverse direction is
  // blocked in code, not by convention: reverseAssociations returns immediately for any spec declaring
  // `ownership`, because putAssociation/deleteAssociation take no spec and so cannot be ownership-guarded
  // yet (P2-1). No `col` — no comma-joined text column is wanted. NO DEAL RELATION: `contact_deal`
  // points at board 5028000494, a third board outside Phase 1 whose deals the WM boards already own.
  associations: [
    { toObject: "companies", nameProps: ["name"], relationCol: "contact_account" },
  ],
  fields: [
    { hs: "firstname", col: "text_mm6sab4c", type: "text", reverse: true },
    { hs: "lastname", col: "text_mm6snp6r", type: "text", reverse: true },
    // Native monday email column. Forward-only: email is the contact dedup key, so a monday edit must
    // never rewrite it (the WM spec excludes email from backfill for the same reason).
    { hs: "email", col: "contact_email", type: "email" },
    { hs: "jobtitle", col: "text_mm6szy4q", type: "text", reverse: true },
    // HubSpot's free-text `company` is deliberately NOT mapped: the "Company name" column it used to
    // write (text_mm6sdvkq) was deleted from the board, and the real company link is the native
    // `contact_account` relation below. A field pointing at a deleted column id makes monday reject the
    // whole change_multiple_column_values mutation, so the card would stop updating entirely.
    { hs: "phone", col: "contact_phone", type: "phone", reverse: true },
    // Owner: app-save-only. A plain `reverse` reassigned owners unattended on the WM side (2026-08-28).
    { hs: "hubspot_owner_id", col: "multiple_person_mm6zap53", type: "people", appReverse: true },
    { hs: "hs_lead_status", col: "color_mm6zb4tc", type: "status", labels: "leadStatus", reverse: true },
    // leadsource is FORWARD-ONLY into text: ~200 legacy options (Tableau/Alteryx webinar history), far
    // too many for a rep-facing dropdown. `labels` renders the friendly label, not the internal value.
    { hs: "leadsource", col: "text_mm6sc26t", type: "text", labels: "contactSource" },
    // Event Name — the marketing/event a contact came in from (e.g. "Reimagine - For HB/Aircall").
    // Verified `type: "string"` (free text), and the monday column was already text, so no retype was
    // needed. FORWARD-ONLY: HubSpot owns it and it is set at import/form time, not edited by reps.
    { hs: "event_name", col: "text_mm6t8bxb", type: "text" },
    { hs: "createdate", col: "date_mm6z33nk", type: "date", oneWay: true },
    // --- added 2026-09-08 from the reviewed mapping sheet ---
    // Owner assigned date. HubSpot RESETS this on reassignment, which is exactly the semantics the
    // future 24-hour follow-up reminder needs, so it is the trigger field rather than a custom counter.
    { hs: "hubspot_owner_assigneddate", col: "date_mm70pa4c", type: "date", oneWay: true },
    // Last Activity Date into a real DATE column. HubSpot sets notes_last_updated automatically from
    // calls/chats/LinkedIn/mail/meetings/notes/email/SMS/WhatsApp, so monday must never write it back.
    { hs: "notes_last_updated", col: "date_mm7054jz", type: "date", oneWay: true },
    // HubSpot priority in its OWN status column, labels seeded from the exact 4 SLA options. The board's
    // native Priority (High/Medium/Low) stays UNMAPPED — same concept name, different meaning.
    { hs: "priority__c", col: "color_mm70ahh7", type: "status", labels: "contactPriority" },
    // Sales User, DISPLAY-ONLY. `labels: "salesUser"` resolves the raw owner id to the person's name.
    // This does NOT reintroduce sales_user into SCOPE — scope is includeAll + mayCreateCrmCard, and
    // recInScope still ignores it for CRM. Forward-only, so a monday edit can never reassign it.
    { hs: "sales_user", col: "text_mm6sakj3", type: "text", labels: "salesUser" },
    // Vendors. manufacturer__c is MULTI-VALUE (a live record holds "49HubSpot;55Aircall") across 89
    // options, so this is interim: forward-only into the existing TEXT column, which shows the raw
    // semicolon-joined value. A seeded multi-select dropdown is the proper form and the prerequisite
    // for ever making it two-way — until then a monday edit must not reach the HubSpot enum.
    { hs: "manufacturer__c", col: "text_mm6s40ew", type: "text", labels: "contactVendor" },
  ],
};

/**
 * CRM ACCOUNTS / COMPANIES — board 5028000496, group `topics` ("Companies").
 *
 * Company creation from monday IS retained (unchanged by the 2026-09-07 meeting, which established a
 * rule for Contacts only), adopting by normalised DOMAIN via `adoptBy` — never by company name.
 */
export const CRM_ACCOUNTS: ObjectSpec = {
  object: "companies",
  objectTypeId: "0-2",
  searchFilters: [],                         // see the note on CRM_CONTACTS.searchFilters
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["name"],
  // nameReverse omitted: a renamed card must not rewrite the HubSpot company name.
  boardId: "5028000496",
  idCol: "text_mm6tsnwx",
  syncStateCol: "text_mm6tccd0",
  linkCol: "link_mm6zyad8",                  // created Task 5
  groupBy: { singleGroup: "topics" },
  includeAll: true,                          // SAFE ONLY WITH Task 3B's mayCreateCrmCard
  skipFullReconcile: true,
  ownership: OWN_ACCOUNTS,
  createFromMonday: true,
  adoptBy: { kind: "domain", col: "company_domain" },   // native Domain link column, NOT the name column
  // The mirror image of the Contacts relation, into the native `account_contact` column. HubSpot ->
  // monday only, by the same reverseAssociations ownership gate. `account_deal` is a monday MIRROR that
  // resolves through account_contact, so it is never written directly and needs no entry here.
  associations: [
    { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "account_contact" },
  ],
  fields: [
    { hs: "name", col: "text_mm6t1q4h", type: "text", reverse: true },
    // DOMAIN IS THE COMPANY'S IDENTITY, and it was missing. `adoptBy` READS this column to match an
    // existing HubSpot company; nothing WROTE it, so every HubSpot-originated Account arrived with an
    // empty Domain — the one field the whole matching design depends on. Forward-only: the domain is
    // the dedup key, exactly as `email` is for contacts, so a monday edit must never rewrite it.
    { hs: "domain", col: "company_domain", type: "link" },
    // industry -> the RENAMED custom text stub "Industry (HubSpot)". The board's NATIVE `industry`
    // dropdown is deliberately UNMAPPED: HubSpot's enumeration carries ~250 options (English plus a
    // parallel Chinese taxonomy, heavily duplicated) against monday's 47, with 8 matching (audit F9).
    // Forward-only does not fix a vocabulary mismatch, and create_labels_if_missing would permanently
    // contaminate a native column the CRM board relies on. `labels` renders the readable HubSpot label.
    { hs: "industry", col: "text_mm6tafj5", type: "text", labels: "industry" },
    { hs: "type", col: "color_mm6zwhwt", type: "status", labels: "companyType", reverse: true },
    // partner_with is a DROPDOWN, not a status: monday status columns reject its 27 labels with a 500
    // (16 ok, 20+ fail). Also the safer branch — dropdown reverse DROPS an unknown label where
    // status/text sends it raw to the HubSpot enum. Forward-only in Phase 1.
    { hs: "partner_with", col: "dropdown_mm6zd1ge", type: "dropdown", labels: "partnerWith" },
    { hs: "city", col: "text_mm6tdrdn", type: "text", reverse: true },
    { hs: "state", col: "text_mm6t5tv", type: "text", reverse: true },
    { hs: "zip", col: "text_mm6t7ha4", type: "text", reverse: true },
    { hs: "timezone", col: "text_mm6tys5f", type: "text" },
    { hs: "annualrevenue", col: "numeric_mm6zj731", type: "numbers", reverse: true },
    { hs: "linkedin_company_page", col: "link_mm6z41s3", type: "link", reverse: true },
    { hs: "description", col: "company_description", type: "long_text", reverse: true },
    // numberofemployees -> the NATIVE `employee_count` (a monday TEXT column), ONE-WAY.
    // Verified in employee-count-roundtrip.test.ts: the forward direction round-trips cleanly (identical
    // payload, stable diffs) but the reverse does not — a text column has no numeric validation, so
    // "approx 500" / "500-1000" would reach a HubSpot NUMBER property and 400 every tick. Contacts in
    // this portal really do carry ranges like "100-500" in the sibling `numemployees` property.
    { hs: "numberofemployees", col: "employee_count", type: "text" },
    { hs: "hubspot_owner_id", col: "multiple_person_mm6z8mwy", type: "people", appReverse: true },
    { hs: "createdate", col: "date_mm6zmtf8", type: "date", oneWay: true },
  ],
};

/** The CRM specs, selected EXCLUSIVELY (never unioned with the WM specs) when ENABLE_CRM is set. */
export const CRM_SPECS: ObjectSpec[] = [CRM_ACCOUNTS, CRM_CONTACTS];
