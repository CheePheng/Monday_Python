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
  // 3,841 of 94,318 Contacts (4.1%) carry neither name, and 3,598 of those do have an email — so this
  // one entry turns that many placeholder cards into searchable ones. Set before the historical import
  // because a rename only reaches an existing card on its next webhook.
  nameFallbackProps: ["email"],
  // matthew.ng@gmail.com -> "matthew.ng"; the full address stays in the Email column. Costs 221 of
  // those 3,598 cards a non-unique name (16 read "info", 9 "support") against 0 collisions for the
  // full address — accepted deliberately, because 3,377 cards gain a readable one and the ambiguous
  // ones are still separable by the Email column beside them.
  nameFallbackTransform: "emailLocalPart",
  // nameReverse deliberately omitted: renaming a card must not rewrite a HubSpot name.
  boardId: "5028000495",
  idCol: "text_mm6t71dj",                    // "HubSpot ID"
  syncStateCol: "text_mm6twy4w",             // "Sync State"
  linkCol: "link_mm6z7mj",                   // "HubSpot Link" (created Task 5)
  groupBy: { singleGroup: "topics" },        // Active/Inactive group sync is out of Phase 1 scope
  includeAll: true,                          // SAFE ONLY WITH Task 3B's mayCreateCrmCard
  skipFullReconcile: true,
  ownership: OWN_CONTACTS,
  restoreOnDelete: true,                     // monday delete/archive -> restore the card from HubSpot
  // An event caused by our own token is an echo: reconcile forward, never write back. See the
  // ObjectSpec note — 1,207 HubSpot Companies were created from such echoes during the import.
  suppressSelfOriginWrites: true,
  fillEmptyFromMonday: true,                 // a monday value may FILL an empty HubSpot field (never clear one)
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
    // HubSpot's free-text `company` is DELIBERATELY NOT MAPPED (removed 2026-09-08, meeting decision).
    //
    // It was a plain string the rep typed, in a monday TEXT column, sitting next to a Connect Boards
    // relation that carries the real, clickable link to the Account card. Two columns showing "which
    // company", one of them unlinkable, is the confusion the meeting asked to remove: the relation is
    // renamed "Company name" and becomes the single answer.
    //
    // The HubSpot `company` PROPERTY is untouched — HubSpot still owns and populates it, and it is
    // still what auto-creates companies from an email domain. Only the monday mirror is gone.
    //
    // ORDER MATTERS on the way out, and this repo has the scar: monday rejects an entire
    // change_multiple_column_values mutation that names an unknown column, so a spec field pointing at
    // a deleted column stops EVERY card on the board from updating (the text_mm6sdvkq incident,
    // 2026-09-08). The mapping is therefore removed and deployed FIRST; the column is deleted only
    // after the live worker no longer references it.
    { hs: "phone", col: "contact_phone", type: "phone", reverse: true },
    // Owner: app-save-only. A plain `reverse` reassigned owners unattended on the WM side (2026-08-28).
    { hs: "hubspot_owner_id", col: "multiple_person_mm6zap53", type: "people", appReverse: true },
    // Lead Status. KEPT despite being the least-filled of this board's three status ladders (450 of
    // 94,205 contacts, 0.5% - vs `lifecyclestage` 100% and `leadstatus`/状态 69%, which are the same
    // eight-step ladder in English and Chinese). It was briefly unmapped on fill rate alone; that was
    // wrong. The field is PINNED TO THE CONTACT SIDEBAR in this portal, which is the portal owner's own
    // statement that they want it - a stronger signal than how full it happens to be today. The 8
    // monday labels match the 8 HubSpot options exactly, so `status` is the correct type here.
    { hs: "hs_lead_status", col: "color_mm6zb4tc", type: "status", labels: "leadStatus", reverse: true },
    // leadsource is FORWARD-ONLY into text: ~200 legacy options (Tableau/Alteryx webinar history), far
    // too many for a rep-facing dropdown. `labels` renders the friendly label, not the internal value.
    // TWO-WAY 2026-09-09 via the validated-text branch. 210 options, and the ONLY one of these four
    // where label != value (a single option, "Others" -> "其他"), so the dictionary genuinely translates
    // here rather than only checking membership.
    { hs: "leadsource", col: "text_mm6sc26t", type: "text", labels: "contactSource", reverse: true },
    // Event Name — the marketing/event a contact came in from (e.g. "Reimagine - For HB/Aircall").
    // Verified `type: "string"` (free text), and the monday column was already text, so no retype was
    // needed. FORWARD-ONLY: HubSpot owns it and it is set at import/form time, not edited by reps.
    // Registration Date - verified type `date` in HubSpot, so it maps to a real date column.
    { hs: "registration_date", col: "date_mm70x5xn", type: "date", oneWay: true },
    { hs: "event_name", col: "text_mm6t8bxb", type: "text", reverse: true },
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
    { hs: "priority__c", col: "color_mm70ahh7", type: "status", labels: "contactPriority", reverse: true },
    // Sales User, DISPLAY-ONLY, in a SINGLE-SELECT DROPDOWN (was text_mm6sakj3, a text column).
    // `labels: "salesUser"` resolves the raw owner id to the person's name; the column is seeded with
    // all 41 of those names so the value is filterable and groupable instead of an opaque string.
    //
    // Dropdown, not status: there are 42 owners and monday rejects 20+ status labels with a bare 500.
    // `limit_select: true` keeps it single-choice — a contact has ONE sales user.
    //
    // `sales_user` is NOT a static picklist, which is the trap here: the property reports
    // type "enumeration" / fieldType "select" but `options: []`, carrying referencedObjectType +
    // externalOptions, so its choices resolve dynamically from the OWNER list. That is why the
    // `salesUser` dictionary is "derived" in sync.ts (built from getOwners) rather than fetched, and why
    // the seeding script reads /crm/v3/owners rather than the property. Owners hired later are handled
    // by `create_labels_if_missing: true` on every monday write (monday.ts), which adds the label rather
    // than failing the mutation — important, because a rejected column fails the WHOLE
    // change_multiple_column_values and would freeze every card.
    //
    // Still FORWARD-ONLY, and now for a second reason beyond "a monday edit must never reassign":
    // "Rick Antonio" is the name of TWO owner ids (164317533 and 165857270), so a label cannot be
    // resolved back to a single owner. De-duplicating for display is safe; reversing would not be.
    //
    // This does NOT reintroduce sales_user into SCOPE — scope is includeAll + mayCreateCrmCard, and
    // recInScope still ignores it for CRM.
    { hs: "sales_user", col: "dropdown_mm70mxfy", type: "dropdown", labels: "salesUser" },
    // Vendors. manufacturer__c is genuinely MULTI-VALUE (a live record holds "49HubSpot;55Aircall"),
    // so this is a MULTI-SELECT DROPDOWN, not text and not status:
    //   - formatValue's dropdown branch SPLITS on ";", so each vendor becomes a real tag rather than
    //     one unfilterable string;
    //   - a status column is impossible — monday rejects 20+ labels with a bare 500 (verified: 16 ok,
    //     20/24/26/27 fail) and this needs 88;
    //   - dropdown is also the only enum type whose REVERSE branch validates: it drops an unknown
    //     label instead of passing it raw to the HubSpot enum, which is the prerequisite for two-way.
    // Still forward-only until that two-way step is explicitly approved. Labels were seeded from the
    // HubSpot property itself (scripts/convert-vendors-dropdown.mjs) so they cannot drift.
    { hs: "manufacturer__c", col: "dropdown_mm70zvnw", type: "dropdown", labels: "contactVendor", reverse: true },
    // Sales Person - a distinct property from sales_user, and a picker on the Create Contact form with
    // no monday home until now. Its 4 option VALUES equal their labels, so no label dictionary is
    // needed (and no extra HubSpot schema fetch). Forward-only for now; because value == label and the
    // column is seeded with exactly those 4, it is the one enum here that COULD safely go two-way.
    // `labels` IS THE SAFETY MECHANISM here, not decoration. sales_person is a HubSpot ENUMERATION with
    // exactly 4 options (Elaine Rivera, Emily You, Myla Mestiola, Rick Avery Antonio). It shipped
    // reverse:true with NO dictionary on 2026-09-09, so the status branch sent whatever label the monday
    // column held: setting it to any other rep would have 400'd and frozen every field on that card.
    { hs: "sales_person", col: "color_mm701ff2", type: "status", labels: "contactSalesPerson", reverse: true },
    // Lifecycle Stage. This portal replaced HubSpot's defaults with a 10-stage Chinese pipeline
    // (生命周期阶段管道), and its option VALUES are a mix of semantic strings (lead/opportunity/customer)
    // and raw numeric ids (1028988526) - so the label dictionary is load-bearing, not cosmetic: without
    // it monday would display "1028988526" instead of "3.Competitors".
    // FORWARD-ONLY, deliberately. Lifecycle stage drives HubSpot workflows and automation, so a monday
    // edit pushing someone to "8.The customer generating the transaction" could fire real business
    // process. HubSpot stays the authority.
    { hs: "lifecyclestage", col: "color_mm70k2wk", type: "status", labels: "lifecycleStage" },
    // 状态 - the LEGACY custom status field, internal name `leadstatus`. NOT HubSpot's built-in
    // `hs_lead_status`: the names differ by a single underscore and the two hold different data, which
    // is why this one took several attempts to locate (the API property search matches internal names,
    // not Chinese labels). Values differ from labels (1New -> 1新增) so the dictionary is load-bearing.
    // FORWARD-ONLY: 14 accumulated legacy options including two both numbered 7, plus "N",
    // "Philippines" and "Primed" - not a vocabulary a monday edit should be able to write back into.
    { hs: "leadstatus", col: "color_mm70v2cd", type: "status", labels: "contactStatus", reverse: true },

    // --- SIDEBAR PARITY, 2026-09-08 -------------------------------------------------------------
    // Every field pinned to the HubSpot contact's "About this contact" sidebar now has a column, with
    // a type that matches the HubSpot property. None of these are on the Create Contact form, which is
    // why they were missing: the earlier pass matched the form, and the sidebar is a different set.
    //
    // ALL FORWARD-ONLY, and for the four big enums that is load-bearing rather than cautious.
    // reverseFieldValue only validates on the DROPDOWN branch; text/long_text fall through to
    // `rev[text] ?? text` (reconcile.ts), so a two-way TEXT column would push a rep's raw string into a
    // HubSpot enumeration — "USA" against a property whose only legal value is
    // "United States of America" — which 400s and drops the edit.
    //
    // No `labels` on any of them: verified live that department_3__c, city_1__c, countries and
    // lead_source_sub__c have value === label for EVERY option, so the raw HubSpot value already reads
    // correctly. (Contrast sales_user and lifecyclestage, where they differ and the dict is essential.)

    // A SECOND phone, distinct from `phone`/contact_phone above. Both are on the sidebar.
    { hs: "mobilephone", col: "phone_mm70npah", type: "phone", reverse: true },
    // 29 single-select options -> dropdown. A 29-label status column fails outright (bare 500 above ~19).
    // The same 2026-09-09 fix as sales_person: a 29-option HubSpot enumeration that was reversing with
    // no membership check. Its option values DO equal their labels, which is why no translation is needed
    // and why the earlier reasoning looked sound — but monday lets a user add a dropdown label and every
    // write sets create_labels_if_missing:true, so "already a legal value" was never actually true.
    { hs: "department_3__c", col: "dropdown_mm70t68r", type: "dropdown", labels: "contactDepartment", reverse: true },
    // The CONTACT-level `industry` is hsType STRING with an empty options array — genuinely free text,
    // NOT the ~246-option COMPANY picklist of the same name mapped on CRM_ACCOUNTS below. Same label,
    // different object, different type; conflating them would have produced an unfillable dropdown.
    { hs: "industry", col: "text_mm7097s5", type: "text", reverse: true },
    // 673 options: ~7.6x the highest dropdown label count verified on this account (88) and far beyond
    // any picker a rep could use. text is a deliberate, documented exception to "enum -> picker".
    // 673 options — far past the 88-label ceiling monday tolerates on this account, so it stays a TEXT
    // column and the reverse write validates against the dictionary instead of retyping the column.
    { hs: "city_1__c", col: "text_mm703scw", type: "text", labels: "contactCity", reverse: true },
    // 省份 is a RELABELLED STANDARD PROPERTY — hs_state_code carries that label in this portal.
    // Deliberately NOT province_1__c, whose label is 省份# WITH a hash and which is a clean 34-option
    // enum with more data (10,064 rows on 广东省 alone vs 3,552 total here). The sidebar shows the
    // hash-less one, confirmed from a screenshot, so that is what is mapped. Worth revisiting with the
    // sales team: they are pinning the messier, less-populated of the two province fields.
    { hs: "hs_state_code", col: "text_mm709ars", type: "text", reverse: true },
    // 198 options (12 pinned APAC + 185 alphabetical + a hand-added "Dubai UAE"), 2.25x the ceiling.
    { hs: "countries", col: "text_mm705t8j", type: "text", labels: "contactCountries", reverse: true },
    // Free-text "Specific Requirement" from the dkmeco.com web form. Prose -> long_text.
    { hs: "concrete_demand", col: "long_text_mm70scva", type: "long_text", reverse: true },
    { hs: "utm_term", col: "text_mm70vzzy", type: "text", reverse: true },
    // LONG_TEXT, not text, and the reason is measured: 19,504 populated values, of which only 1,008 are
    // URLs — the other 18,496 are Chinese page TITLES ("产品下载"). The longest live URL is 365 chars
    // (a percent-encoded Chinese utm_campaign). monday's text column cannot be widened AND cannot be
    // retyped, so a truncation discovered later would be unrecoverable without losing the column.
    { hs: "registration_page__c", col: "long_text_mm70smr5", type: "long_text", reverse: true },
    // 558 options — 6.3x the ceiling, hopeless as a picker.
    // 558 options. NOTE for whoever debugs a refused edit here: 163 of those option VALUES contain a
    // DOUBLE space, and "14 Day  Desktop Trial Request" coexists with its single-spaced spelling. If
    // monday collapses internal whitespace in a text cell, those particular labels can never match and
    // the edit is refused — safely, since the forward write then heals the cell, but confusingly.
    // Unmeasured; the test file records the exact experiment that would settle it.
    { hs: "lead_source_sub__c", col: "text_mm70a5c2", type: "text", labels: "contactLeadSourceSub", reverse: true },
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
  // 4,315 of 26,206 HubSpot Companies (16.5%) have NO name, and 4,237 of those carry a domain — so
  // without this that many cards read "companies 37108192909". The full domain stays in the Company
  // domain name column; only the card label changes. See ObjectSpec.nameFallbackTransform.
  nameFallbackProps: ["domain"],
  nameFallbackTransform: "domainStem",
  // nameReverse omitted: a renamed card must not rewrite the HubSpot company name.
  boardId: "5028000496",
  idCol: "text_mm6tsnwx",
  syncStateCol: "text_mm6tccd0",
  linkCol: "link_mm6zyad8",                  // created Task 5
  groupBy: { singleGroup: "topics" },
  includeAll: true,                          // SAFE ONLY WITH Task 3B's mayCreateCrmCard
  skipFullReconcile: true,
  ownership: OWN_ACCOUNTS,
  restoreOnDelete: true,                     // monday delete/archive -> restore the card from HubSpot
  // An event caused by our own token is an echo: reconcile forward, never write back. See the
  // ObjectSpec note — 1,207 HubSpot Companies were created from such echoes during the import.
  suppressSelfOriginWrites: true,
  fillEmptyFromMonday: true,                 // a monday value may FILL an empty HubSpot field (never clear one)
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
    // TWO-WAY 2026-09-09, and `canonicalDomain` is what makes that safe rather than reckless.
    //
    // The earlier "forward-only because it is the dedup key" reasoning had a real point but drew the
    // wrong conclusion. The danger was never that a rep may CORRECT a wrong domain — that is exactly
    // the edit we want — it is that a monday edit must not (a) retarget the card at some other HubSpot
    // company, or (b) store a value the search cannot find.
    //
    // (a) is already structurally impossible: syncMondayItem branches on the HubSpot ID column
    // (sync.ts:704) and a linked card returns after reconcileRecord (sync.ts:707-717), so the adoption
    // branch inside createFromMonday is simply unreachable once a card carries an id. An edited domain
    // updates THIS company and can never re-point the card.
    // (b) is what canonicalDomain handles: companies do not enforce unique domains, so HubSpot stores
    // any string verbatim and a URL would silently break the EQ lookup forever.
    //
    // Being reversible also fixes a live hazard in the CREATE path: buildCreateProperties skips every
    // non-reverse field (reconcile.ts:305), so while this was forward-only a monday-originated Account
    // was created with NO domain — the one field the whole matching design needs.
    { hs: "domain", col: "company_domain", type: "link", reverse: true, canonicalDomain: true },
    // COMPANY `industry` IS NOT MAPPED, as of 2026-09-08. It pointed at a custom text column
    // "Industry (HubSpot)" (text_mm6tafj5) which has since been DELETED from the board — and a spec
    // field naming a column monday does not have makes monday reject the ENTIRE
    // change_multiple_column_values mutation, which froze every card on the Accounts board until this
    // line changed. Found by the live association test, not by a unit test: only
    // scripts/audit-crm-column-types.mjs can see a dead id, because it asks the real board.
    //
    // NOT re-pointed at the board's native `industry` dropdown, and that restraint is the original
    // reasoning rather than laziness: HubSpot's enumeration carries ~250 options (English plus a
    // parallel Chinese taxonomy, heavily duplicated) against monday's 47, with only 8 matching. Every
    // monday write sets create_labels_if_missing, so mapping onto it would progressively fill a native
    // column the board relies on with a second, redundant vocabulary — permanently, and past the
    // 88-label ceiling that is the most this account has been shown to tolerate.
    //
    // So the native dropdown stays a monday-owned field reps can set freely, and HubSpot's Industry no
    // longer flows to the board. Restoring the sync means a dedicated text column again — a deliberate
    // choice between one clean column and one synced column, which is the caller's to make, not mine.
    { hs: "type", col: "color_mm6zwhwt", type: "status", labels: "companyType", reverse: true },
    // partner_with is a DROPDOWN, not a status: monday status columns reject its 27 labels with a 500
    // (16 ok, 20+ fail). Also the safer branch — dropdown reverse DROPS an unknown label where
    // status/text sends it raw to the HubSpot enum. Forward-only in Phase 1.
    { hs: "partner_with", col: "dropdown_mm6zd1ge", type: "dropdown", labels: "partnerWith" },
    { hs: "city", col: "text_mm6tdrdn", type: "text", reverse: true },
    { hs: "state", col: "text_mm6t5tv", type: "text", reverse: true },
    { hs: "zip", col: "text_mm6t7ha4", type: "text", reverse: true },
    { hs: "timezone", col: "text_mm6tys5f", type: "text", reverse: true },
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
    // Sales User, DISPLAY-ONLY, in a SINGLE-SELECT DROPDOWN (was text_mm6twxwe, a text column).
    // Identical treatment and identical reasoning to Contacts above — 41 seeded owner names, dropdown
    // because 42 breaks a status column, limit_select so it stays single-choice, labels resolved from
    // the OWNER list because `sales_user` has no static options, and forward-only because two owner ids
    // share the name "Rick Antonio". See the Contacts mapping for the full note.
    { hs: "sales_user", col: "dropdown_mm704kf4", type: "dropdown", labels: "salesUser" },
    // SIDEBAR PARITY, 2026-09-08. The only field on the company sidebar with no column.
    // TEXT despite being an enumeration, which looks like a rule violation and is not: the property
    // returns `options: []` from the API (dynamic/external options, exactly like sales_user), so a
    // dropdown cannot be SEEDED — and an unseeded one would grow without bound past the 88-label
    // ceiling via create_labels_if_missing, because HubSpot adds record sources on its own schedule.
    // Read-only system metadata ("CRM UI", "Import", "Integration"), so forward-only regardless.
    { hs: "hs_object_source_label", col: "text_mm707cf3", type: "text" },
  ],
};

const OWN_DEALS: OwnershipSpec = { ...OWN_CONTACTS };
const OWN_LINE_ITEMS: OwnershipSpec = { ...OWN_CONTACTS };

/**
 * CRM DEALS — board 5028000494, group `topics` ("Active Deals").
 *
 * STAGE IS THE WHOLE DESIGN PROBLEM, and it is a property of this portal's data rather than a
 * preference. `dealstage` holds 42 values across 5 pipelines and THE LABELS ARE NOT UNIQUE: the three
 * Salesforce pipelines use the same nine Chinese stage names, so `赢单` alone is three distinct ids.
 * An unqualified dictionary cannot be inverted, and a wrong reverse write does not error — it moves
 * the deal into another pipeline, which is what reporting, forecasting and the Won automations key
 * off. So:
 *
 *   - `deal_stage` (the native monday status, 6 labels) stays HUBSPOT -> MONDAY ONLY. Many HubSpot
 *     stages map onto one monday label and a many-to-one map has no inverse.
 *   - `HubSpot Stage` carries the exact stage two-way, with PIPELINE-QUALIFIED labels
 *     ("SF-Maint / 赢单") from getCrmStageDicts. Qualifying is what restores uniqueness.
 *   - `stagePipelinePairing` sends `pipeline` with every `dealstage` write, because HubSpot rejects a
 *     stage that does not belong to the record's current pipeline and two PATCHes would leave an
 *     invalid pair in between.
 *
 * ASSOCIATIONS LINK ALL, SELECT NOTHING. Measured 2026-09-14: max 2 companies, 9 contacts and 12 line
 * items per deal, against relation cells holding ~750 elsewhere on this account — so no platform
 * constraint forces a choice. Selecting one would reproduce on purpose the failure the Contacts phase
 * spent five rounds removing: monday showing less than HubSpot holds, invisibly, with a rep re-adding
 * the missing record by hand. `Primary Account` exposes the `Primary`-labelled company separately
 * (8,462 of 8,466 deals carry that label) WITHOUT discarding the second.
 *
 * NO HISTORICAL IMPORT YET. createFromMonday is false and the ownership cutover is still INFINITY, so
 * nothing here can claim, create or card a record until that is deliberately changed.
 */
export const CRM_DEALS: ObjectSpec = {
  object: "deals",
  objectTypeId: "0-3",
  searchFilters: [],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"],
  // nameReverse omitted: renaming a card must not rewrite the HubSpot deal name.
  boardId: "5028000494",
  idCol: "text_mm76kxz4",
  syncStateCol: "text_mm7668db",
  linkCol: "link_mm76z640",
  groupBy: { singleGroup: "topics" },
  includeAll: true,
  skipFullReconcile: true,
  ownership: OWN_DEALS,
  restoreOnDelete: true,
  suppressSelfOriginWrites: true,
  fillEmptyFromMonday: true,
  createFromMonday: false,
  stagePipelinePairing: { stageProp: "dealstage", pipelineProp: "pipeline" },
  // All three association directions, into the paired Connect Boards columns created 2026-09-14.
  // `deal_account` is a monday MIRROR resolving through deal_contact and is never written directly.
  associations: [
    { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "deal_contact" },
    { toObject: "companies", nameProps: ["name"], relationCol: "board_relation_mm76wp4e" },
    { toObject: "line_items", nameProps: ["name"], relationCol: "board_relation_mm76btmt" },
  ],
  fields: [
    // ONE-WAY: the coarse summary. See the header — many-to-one has no inverse.
    { hs: "dealstage", col: "deal_stage", type: "status", labels: "stage", oneWay: true },
    // TWO-WAY: the exact stage, pipeline-qualified so the inverse is a function.
    { hs: "dealstage", col: "dropdown_mm7624zd", type: "dropdown", labels: "crmStage", reverse: true },
    { hs: "pipeline", col: "dropdown_mm76s7kk", type: "dropdown", labels: "crmPipeline", reverse: true },
    { hs: "amount", col: "deal_value", type: "numbers", reverse: true },
    { hs: "closedate", col: "deal_expected_close_date", type: "date", reverse: true },
    // HubSpot stores a FRACTION (0.2); the column renders `%`. Without scale a 20% deal reads 0.2%,
    // and the board's Forecast Value formula multiplies that error into money.
    { hs: "hs_deal_stage_probability", col: "deal_close_probability", type: "numbers", reverse: true, scale: 100 },
    { hs: "dealtype", col: "dropdown_mm76sh6x", type: "dropdown", labels: "dealtype", reverse: true },
    { hs: "hs_priority", col: "color_mm76tdww", type: "status", labels: "priority", reverse: true },
    { hs: "deal_currency_code", col: "dropdown_mm76570x", type: "dropdown", labels: "pipeline", reverse: true, unvalidatedEnum: true },
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm76dtzq", type: "dropdown", labels: "vendor", reverse: true },
    { hs: "sales_user", col: "dropdown_mm76ncf5", type: "dropdown", labels: "salesUser", reverse: true },
    // Record OWNERSHIP: appReverse, so a stale people column cannot silently reassign a deal.
    { hs: "hubspot_owner_id", col: "deal_owner", type: "people", appReverse: true },
    // HubSpot-computed: there is nothing to push back.
    { hs: "notes_last_updated", col: "date__1", type: "date", oneWay: true },
  ],
};

/**
 * CRM LINE ITEMS — board 5028000489 ("Products & Services").
 *
 * A BOARD, NOT SUBITEMS, which is the one structural difference from the Work-Management shape. 2,527
 * of 8,653 deals (29%) carry more than one line item and one carries 12, so a design that shows a
 * single line item per deal discards data on nearly a third of the board. The Deal link is the paired
 * counterpart of the Deals board's "Line Items" column, so the relationship is visible from both.
 *
 * Unlike `dealstage`, EVERY line-item enumeration here has unique labels, so all of them invert
 * cleanly and the board is fully two-way.
 *
 * The board's own `product_and_service_price` and `product_and_service_type` are monday-CRM template
 * columns that someone retitled without retyping — a NUMBERS column called "Brand ISV" cannot hold
 * "Docusign". They are left in place but retitled "(monday template, unused)"; the real values live in
 * the typed columns created 2026-09-14.
 */
export const CRM_LINE_ITEMS: ObjectSpec = {
  object: "line_items",
  objectTypeId: "0-8",
  searchFilters: [],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["name"],
  boardId: "5028000489",
  idCol: "text_mm76qwtw",
  syncStateCol: "text_mm76kcss",
  linkCol: "link_mm76mcap",
  groupBy: { singleGroup: "topics" },
  includeAll: true,
  skipFullReconcile: true,
  ownership: OWN_LINE_ITEMS,
  restoreOnDelete: true,
  suppressSelfOriginWrites: true,
  fillEmptyFromMonday: true,
  createFromMonday: false,
  associations: [
    { toObject: "deals", nameProps: ["dealname"], relationCol: "board_relation_mm76w9y5" },
  ],
  fields: [
    { hs: "hs_sku", col: "text_mm73mvfj", type: "text", reverse: true },
    { hs: "description", col: "product_and_service_description", type: "long_text", reverse: true },
    { hs: "note", col: "text_mm7318s1", type: "text", reverse: true },
    { hs: "quantity", col: "numeric_mm7652yc", type: "numbers", reverse: true },
    { hs: "price", col: "numeric_mm76w6wc", type: "numbers", reverse: true },
    { hs: "hs_cost_of_goods_sold", col: "numeric_mm76yzc4", type: "numbers", reverse: true },
    { hs: "discount", col: "numeric_mm76kfhq", type: "numbers", reverse: true },
    { hs: "deposit", col: "numeric_mm762vb", type: "numbers", reverse: true },
    { hs: "service_date", col: "date_mm76shxe", type: "date", reverse: true },
    { hs: "hs_recurring_billing_start_date", col: "date_mm76qejs", type: "date", reverse: true },
    { hs: "brand_isv", col: "dropdown_mm76atcg", type: "dropdown", labels: "liBrand", reverse: true },
    { hs: "family", col: "dropdown_mm769s51", type: "dropdown", labels: "liFamily", reverse: true },
    { hs: "product_subcategory", col: "dropdown_mm76skb3", type: "dropdown", labels: "liSubcategory", reverse: true },
    { hs: "hs_pricing_model", col: "dropdown_mm76gfjd", type: "dropdown", labels: "liPricingModel", reverse: true },
    { hs: "recurringbillingfrequency", col: "dropdown_mm76r942", type: "dropdown", labels: "liBillingFreq", reverse: true },
    // Stores a tax-rate GROUP ID and displays a label, so the dictionary is mandatory rather than cosmetic.
    { hs: "hs_tax_rate_group_id", col: "dropdown_mm76ftmq", type: "dropdown", labels: "liTaxRate", reverse: true },
    { hs: "is_active", col: "color_mm76w1cs", type: "status", labels: "liIsActive", reverse: true },
    { hs: "hs_line_item_currency_code", col: "dropdown_mm76dqnc", type: "dropdown", labels: "liCurrency", reverse: true },
  ],
};

/** The CRM specs, selected EXCLUSIVELY (never unioned with the WM specs) when ENABLE_CRM is set. */
export const CRM_SPECS: ObjectSpec[] = [CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS, CRM_LINE_ITEMS];
