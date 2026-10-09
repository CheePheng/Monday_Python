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
 * CREATION IS TWO-WAY as of 2026-09-21, reversing the 2026-09-07 decision. The business confirmed that
 * the monday "创建/Create" form must produce a HubSpot Contact, because that form is how ~50 sales users
 * will add contacts once they no longer have HubSpot seats. Until now it produced a monday card and
 * nothing else, silently.
 *
 * Duplicate protection is `adoptBy` on normalised EMAIL: a rep adding someone HubSpot already knows
 * LINKS to that contact instead of minting a second one. There is still NO `createDefaults` — nothing
 * about a Contact needs manufacturing, and `sales_user` in particular must never be fabricated.
 *
 * Creation is nonetheless INERT as shipped: `createCutoffMs` is Infinity until the deployment sets
 * CRM_CREATE_CUTOFF_AT. See ObjectSpec.createCutoffMs for why that guard is not optional.
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
  groupBy: { singleGroup: "topics", placeOnly: true },   // new cards land here; the Worker never moves a card
  /**
   * ...EXCEPT OUT OF "No Activity - 未跟进" WHEN THE CARD IS WORKED (2026-10-09, NO_ACTIVITY_RELEASE). The board's
   * own automations put cards INTO that group; nothing took them out again when a rep did the work, so a
   * contact Elaine moved to 10.Other / In Progress on 5 Oct sat there until hiffer dragged it out on 9 Oct.
   * Worked = the owner's outbound email or call syncs (activity-sync.ts), or Lifecycle changes off 1.NEW, or
   * Lead Status changes to anything but New -- in monday or in HubSpot. Labels as reps see them; a change, not
   * a state, so a card swept back in by the nightly automation stays put until it is worked again.
   */
  leaveWhenWorked: { from: "group_mm7cj2yx", to: "topics",
    notWorked: { color_mm70k2wk: ["1.NEW"], color_mm6zb4tc: ["New"] } },
  // A contact reaches monday only once HubSpot gives it an owner (2026-10-09 meeting, CONTACT_CARD_NEEDS_OWNER).
  cardNeedsOwner: true,
  // 上次通知Owner (email): the last owner told about this contact. Written by owner-notice.ts (OWNER_NOTICE) when
  // HubSpot's owner is someone else, which is what the board's assignment email automation fires on.
  ownerNoticeCol: "email_mm7v3xxg",
  includeAll: true,                          // SAFE ONLY WITH Task 3B's mayCreateCrmCard
  skipFullReconcile: true,
  ownership: OWN_CONTACTS,
  restoreOnDelete: true,                     // monday delete/archive -> restore the card from HubSpot
  // An event caused by our own token is an echo: reconcile forward, never write back. See the
  // ObjectSpec note — 1,207 HubSpot Companies were created from such echoes during the import.
  suppressSelfOriginWrites: true,
  columnLevelReverse: true,   // a person's edit pushes only that column; nothing else writes HubSpot
  fillEmptyFromMonday: true,                 // a monday value may FILL an empty HubSpot field (never clear one)
  /**
   * CREATION ENABLED 2026-09-21, reversing the 2026-09-07 decision, because the business confirmed the
   * monday "创建/Create" form is how ~50 sales users will add Contacts once they leave HubSpot. Until
   * now that form produced a monday card and nothing else — silently: no HubSpot record, no error, and
   * no feedback to the rep who filled it in.
   */
  createFromMonday: true,
  // Inert as shipped (CRM_CREATE_CUTOFF_MS is Infinity): no monday card is old enough to be
  // NEWER than it, so nothing creates until CRM_CREATE_CUTOFF_AT names a go-live timestamp.
  createCutoffMs: CRM_CREATE_CUTOFF_MS,
  // ADOPT BY NORMALISED EMAIL, never by name. A rep adding someone who is already in HubSpot must LINK
  // to that contact rather than mint a second one; email is the only key that identifies a person
  // uniquely, and searchContactByEmail normalises before matching.
  adoptBy: { kind: "email", col: "contact_email" },
  // CONTACT <-> COMPANY, into the board's NATIVE `contact_account` relation. FORWARD: the forward pass
  // fills it with the CRM Account cards for this contact's HubSpot company associations. REVERSE, at
  // column level (reverseAssociations, 2026-09-28): a PERSON's edit of this cell pushes only the cards
  // they added and unlinks only the ones they removed (monday's own before/after), each ownership-guarded
  // on the contact through putAssociation/deleteAssociation; a refusal or HubSpot error undoes the
  // person's edit at once, judged against HubSpot's current set; a card that was deleted or archived never
  // unlinks; the paired Accounts-side report of the same click is dropped (see the Accounts spec); an
  // automation's edit or our own token's echo never pushes. No `col` — no comma-joined text column is wanted. NO DEAL RELATION:
  // `contact_deal` points at board 5028000494 and is not mapped on this spec.
  associations: [
    { toObject: "companies", nameProps: ["name"], relationCol: "contact_account" },
  ],
  fields: [
    { hs: "firstname", col: "text_mm6sab4c", type: "text", reverse: true },
    { hs: "lastname", col: "text_mm6snp6r", type: "text", reverse: true },
    // Native monday email column. Forward-only: email is the contact dedup key, so a monday edit must
    // never rewrite it (the WM spec excludes email from backfill for the same reason).
    // `writeOnCreate`, NOT `reverse`: the record must be BORN with its email, because email is
    // adoptBy.col and createFromMonday refuses to mint a record whose adoption key is absent — nothing
    // could ever match it again, and the next card would create a duplicate. A later monday edit must
    // still never rewrite it. See FieldSpec.writeOnCreate.
    // TWO-WAY from 2026-09-23, so a rep can fix a typo'd address. It is the adoption key only at CREATE
    // time; a card with a HubSpot ID is linked by that id, so changing the email cannot re-point it. An
    // address another contact already holds is rejected by HubSpot and the cell heals.
    { hs: "email", col: "contact_email", type: "email", writeOnCreate: true, reverse: true },
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
    { hs: "createdate", col: "date_mm6z33nk", type: "date", oneWay: true, localDate: true },
    // --- added 2026-09-08 from the reviewed mapping sheet ---
    // Owner assigned date. HubSpot RESETS this on reassignment, which is exactly the semantics the
    // future 24-hour follow-up reminder needs, so it is the trigger field rather than a custom counter.
    // An instant (HubSpot `datetime`), and a candidate clock for the Day 1/3/5 follow-up reminder —
    // a day's error here would fire a reminder a day early for anyone assigned after local midnight.
    { hs: "hubspot_owner_assigneddate", col: "date_mm70pa4c", type: "date", oneWay: true, localDate: true },
    // Last Activity Date into a real DATE column. HubSpot sets notes_last_updated automatically from
    // calls/chats/LinkedIn/mail/meetings/notes/email/SMS/WhatsApp, so monday must never write it back.
    { hs: "notes_last_updated", col: "date_mm7054jz", type: "date", oneWay: true, localDate: true },
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
    // The legacy Sales User DROPDOWN was retired on 2026-09-15 and its column deleted. Everything the
    // comment above says about sales_user still holds — dynamically-resolved options, the derived
    // `salesUser` dictionary, and "Rick Antonio" naming two owner ids — which is precisely why the
    // replacement is a PEOPLE column resolved through owner ids rather than labels. See below.
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
    /**
     * SALES PERSON IS RETIRED FROM MONDAY — 2026-09-15, team decision: Sales User is the only
     * assignment field from now on. THREE columns go, and all three were mapped here until now:
     *   multiple_person_mm76qtz7  Sales Person          (People, built days earlier for permissions)
     *   color_mm701ff2            Sales Person (legacy) (status)
     *   dropdown_mm70mxfy         Sales User (legacy)   (dropdown, superseded by the People column)
     *
     * ORDER IS LOAD-BEARING and is the whole reason this comment exists: the mappings are removed and
     * DEPLOYED FIRST, and the columns are deleted only once the running Worker no longer names them.
     * monday rejects an entire change_multiple_column_values mutation that names an unknown column, so
     * one spec field pointing at a deleted column stops EVERY card on the board from updating — the
     * text_mm6sdvkq incident, 2026-09-08. The board permission was re-pointed at Contact owner +
     * Sales User (multiple_person_mm76ygkp) and verified live BEFORE any of this, so deleting the
     * Sales Person People column cannot narrow anyone's access.
     *
     * HUBSPOT'S `sales_person` DATA IS UNTOUCHED AND MUST STAY THAT WAY. 6,543 contacts still carry
     * it. Removing a mapping stops the sync reading it; it does not clear the property, and nothing
     * added here should ever make that untrue.
     *
     * `FieldSpec.peopleByName` stays in the engine even though its only user is gone. It exists
     * because a people column fed from a NAME rather than an owner id renders EMPTY while every
     * counter reports success — a failure mode worth keeping the fix for.
     */
    /** sales_user stores an owner ID, so the ordinary people path resolves it with no new mechanism.
     *  A value whose owner has no monday account leaves the cell EMPTY — accepted by the business, and
     *  measured: 1,810 of a 10,000-contact sample, joan zhang alone accounting for 1,231.
     *
     *  FORWARD-ONLY, and the reason CHANGED on 2026-09-15 even though the direction did not. It used
     *  to be an ambiguity argument: the legacy dropdown held a label, and "Rick Antonio" names two
     *  owner ids, so a label could not resolve back to one owner. A People cell resolves monday user
     *  -> email -> owner id, so that argument is gone. What replaces it is SCOPE: CONTACTS_MYLA filters
     *  on `sales_user HAS_PROPERTY` (config.ts), so a CRM-side reverse write would pull contacts into
     *  the live Work-Management Worker's scope — ~957 candidates created since 2026-06-01 among the
     *  38,135 carrying no sales_user. Enabling reverse here is a WM scope decision, not a mapping
     *  tweak, and the WM deployment must stay untouched. Asserted in reverse-enabled-batch.test.ts.
     *
     *  TWO-WAY FROM 2026-09-23. The business asked for it outright ("Sales User doesn't update"), and
     *  both objections to it are now answered in the engine rather than by keeping the column one-way:
     *    - AMBIGUITY (the shared-email collapse -- nine owners share idaliang@dkmeco.com): buildCtx drops an
     *      email claimed by more than one owner, so assigning such a person is REFUSED and healed, never
     *      guessed. A person with a unique email is assigned exactly.
     *    - STALE OVERWRITE: columnLevelReverse means this column is pushed only when a person edits THIS
     *      column. The record-level engine would have sent whatever the cell held on any edit.
     *  Known side effect, accepted: CONTACTS_MYLA (the legacy Work-Management board) scopes on
     *  `sales_user HAS_PROPERTY`, so giving a contact its first Sales User here also brings it onto that
     *  board. That board is no longer where sales work happens, and it touches no CRM data. */
    { hs: "sales_user", col: "multiple_person_mm76ygkp", type: "people", reverse: true },
    // Lifecycle Stage. This portal replaced HubSpot's defaults with a 10-stage Chinese pipeline
    // (生命周期阶段管道), and its option VALUES are a mix of semantic strings (lead/opportunity/customer)
    // and raw numeric ids (1028988526) - so the label dictionary is load-bearing, not cosmetic: without
    // it monday would display "1028988526" instead of "3.Competitors".
    /**
     * TWO-WAY as of 2026-09-22, reversing the forward-only decision above it.
     *
     * The old reasoning was that lifecycle stage drives HubSpot workflows, so a monday edit could fire
     * real business process, and HubSpot should stay the authority. That was coherent while HubSpot was
     * where people worked. It stopped being coherent once the sales team moved to monday: the confirmed
     * process is that a rep contacts a newly assigned Contact, logs the activity, and moves the stage
     * off "1.NEW". Forward-only made that impossible in a particularly nasty way — see below.
     *
     * THE BUG IT CAUSED, on contact 549865853636 (monday item 2856478689). The field had neither
     * `reverse` NOR `oneWay`. `oneWay` is what puts a column into ignoredColumns(), so without it a
     * monday edit still fired a reconcile; without `reverse` that reconcile had nothing to send; and the
     * forward pass then wrote HubSpot's value straight back. The rep's own edit triggered the write that
     * erased it, roughly a second later. HubSpot's history for that contact shows ONE lifecyclestage
     * entry ever — 2026-09-10, source FORM — so nothing on the HubSpot side was involved at all.
     *
     * SAFE TO REVERSE, verified against the live portal rather than assumed: all 10 monday labels
     * translate back to a HubSpot option, and all 10 HubSpot labels are UNIQUE, so the inverse is a
     * function. An unknown label (a rep renaming one) resolves to "" and is omitted rather than sent —
     * reverseFieldValue refuses a status it cannot translate instead of inventing a value.
     *
     * OWNERSHIP STILL GOVERNS, and that is the real limit: a reverse write on an unstamped contact is
     * refused and falls through to the forward write, so the edit still snaps back. That covers 97.9% of
     * contacts created since 2026-09-10 (1,642 of 1,677 are crm-stamped) but almost none of the 94,244
     * historical ones, which no rep is being assigned.
     *
     * BACKWARD MOVES NEED A CLEAR FIRST (2026-10-01). HubSpot accepts a PATCH to an EARLIER lifecycle stage
     * with a 200 and ignores it, so every backward edit from monday silently never landed: 7 -> 3 on
     * contact 42000269320 (Matthew Ng), 10 -> 6 -> 5 -> 6 on 553232416501 (hiffer), no history entry for
     * either. See FieldSpec.backwardNeedsClear: an earlier stage is now sent as "" and then the stage, in
     * the pipeline order HubSpot itself reports (displayOrder, 1.NEW = 0 ... 10.Other = 9, read live).
     */
    { hs: "lifecyclestage", col: "color_mm70k2wk", type: "status", labels: "lifecycleStage", reverse: true,
      backwardNeedsClear: true },
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
  // TWO-WAY from 2026-09-23. It was one-way so a stale card title could never ride along on an unrelated
  // edit and overwrite HubSpot -- a record-level-engine risk. With columnLevelReverse the name is sent
  // only when a person renames the card. It is also the only way a monday-created record gets a name:
  // buildCreateProperties sends the item name through nameReverse and nothing else.
  nameReverse: "name",
  boardId: "5028000496",
  idCol: "text_mm6tsnwx",
  syncStateCol: "text_mm6tccd0",
  linkCol: "link_mm6zyad8",                  // created Task 5
  groupBy: { singleGroup: "topics", placeOnly: true },
  includeAll: true,                          // SAFE ONLY WITH Task 3B's mayCreateCrmCard
  skipFullReconcile: true,
  ownership: OWN_ACCOUNTS,
  restoreOnDelete: true,                     // monday delete/archive -> restore the card from HubSpot
  // An event caused by our own token is an echo: reconcile forward, never write back. See the
  // ObjectSpec note — 1,207 HubSpot Companies were created from such echoes during the import.
  suppressSelfOriginWrites: true,
  columnLevelReverse: true,   // a person's edit pushes only that column; nothing else writes HubSpot
  fillEmptyFromMonday: true,                 // a monday value may FILL an empty HubSpot field (never clear one)
  createFromMonday: true,
  // Inert as shipped (CRM_CREATE_CUTOFF_MS is Infinity): no monday card is old enough to be
  // NEWER than it, so nothing creates until CRM_CREATE_CUTOFF_AT names a go-live timestamp.
  createCutoffMs: CRM_CREATE_CUTOFF_MS,
  adoptBy: { kind: "domain", col: "company_domain" },   // native Domain link column, NOT the name column
  // The mirror image of the Contacts relation, into the native `account_contact` column, under the same
  // rules: forward fill from HubSpot, and a person's column-level edit pushes only what they added or
  // removed (ownership decided on the COMPANY), snapping back on refusal. The two cells are paired, and
  // one click must be ONE decision: if monday also reports the paired side, judging each side on its own
  // record would let a refusal on the Contact be bypassed by a write authorised on the Company, or let a
  // refused side's snap-back undo the other side's allowed edit. So the webhook drops the card from the
  // paired echo's diff -- the first event of the pair to arrive owns it (isPairedEcho, relation-edit.ts;
  // whether monday sends the echo, and in which order, is still to be confirmed from a live payload).
  // `account_deal` is a monday MIRROR that resolves through account_contact, so it is never written
  // directly and needs no entry here.
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
    // TWO-WAY from 2026-09-23: it had neither reverse nor oneWay, so a rep edit fired a reconcile that wrote
    // HubSpot's value straight back -- the Lifecycle Stage bug class. It has a validated dictionary.
    { hs: "partner_with", col: "dropdown_mm6zd1ge", type: "dropdown", labels: "partnerWith", reverse: true },
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
    // TWO-WAY since 2026-09-23, through reverseAs "integer": a whole number reaches HubSpot, a range or
    // any other text is refused and the cell healed -- the failure described above cannot happen.
    { hs: "numberofemployees", col: "employee_count", type: "text", reverse: true, reverseAs: "integer" },
    { hs: "hubspot_owner_id", col: "multiple_person_mm6z8mwy", type: "people", appReverse: true },
    { hs: "createdate", col: "date_mm6zmtf8", type: "date", oneWay: true, localDate: true },
    /**
     * LAST ACTIVITY DATE — the exact mirror of the Contacts column (date_mm7054jz), same property and
     * same title, so the two boards cannot disagree about what "last activity" means.
     *
     * oneWay is mandatory, not stylistic: HubSpot reports modificationMetadata.readOnlyValue=true, so a
     * reverse write would 400. It also puts the column into ignoredColumns(), which stops a bulk fill
     * from storming the reconciler with one full record sync per card.
     *
     * Expect it to read EMPTY on ~79% of Accounts. That is HubSpot's own coverage — 5,997 of 28,586
     * carded companies have any logged activity at all — not a broken sync.
     */
    { hs: "notes_last_updated", col: "date_mm7dtzwm", type: "date", oneWay: true, localDate: true },
    // Sales User, DISPLAY-ONLY, in a SINGLE-SELECT DROPDOWN (was text_mm6twxwe, a text column).
    // Identical treatment and identical reasoning to Contacts above — 41 seeded owner names, dropdown
    // because 42 breaks a status column, limit_select so it stays single-choice, labels resolved from
    // the OWNER list because `sales_user` has no static options, and forward-only because two owner ids
    // share the name "Rick Antonio". See the Contacts mapping for the full note.
    /**
     * SALES USER AS A PEOPLE COLUMN — the shape the business asked for, and the shape Contacts already
     * uses (multiple_person_mm76ygkp). An avatar a rep recognises, and the column Lark will read to
     * decide who a follow-up reminder goes to.
     *
     * FORWARD-ONLY, and that is not caution for its own sake. The people path joins HubSpot owners to
     * monday users by EMAIL, and nine owner ids in this portal share ida***@dkmeco.com — 华南销售,
     * 华东销售, 华北销售, 华北主管, 华南主管, Commercial, Maintenance, ADMIN A and Ida Liang. Forward they
     * all resolve to one monday user, which is a display loss. BACKWARD there is no way to tell them
     * apart at all, so a reverse write would pick one arbitrarily and silently reassign ~1,255 Accounts
     * to the wrong department. Reverse stays off until each of those owners has its own email.
     *
     * THE DROPDOWN IS KEPT, hidden rather than deleted, until the People column is populated and
     * verified: it is the only place the nine departments remain distinguishable, and deleting a column
     * a live spec still names 400s every write to the board (the text_mm6sdvkq incident).
     */
    // TWO-WAY from 2026-09-23 -- see the Contacts Sales User note: an ambiguous (shared-email) person is
    // refused by the engine, and column-level reverse pushes this cell only when someone edits it.
    { hs: "sales_user", col: "multiple_person_mm7d2qk6", type: "people", reverse: true },
    // SIDEBAR PARITY, 2026-09-08. The only field on the company sidebar with no column.
    // TEXT despite being an enumeration, which looks like a rule violation and is not: the property
    // returns `options: []` from the API (dynamic/external options, exactly like sales_user), so a
    // dropdown cannot be SEEDED — and an unseeded one would grow without bound past the 88-label
    // ceiling via create_labels_if_missing, because HubSpot adds record sources on its own schedule.
    // Read-only system metadata ("CRM UI", "Import", "Integration"), so forward-only regardless.
    // A read-only HubSpot system property: oneWay, so a monday edit is ignored instead of reconciled and reverted.
    { hs: "hs_object_source_label", col: "text_mm707cf3", type: "text", oneWay: true },
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
 *     stages map onto one monday label and a many-to-one map has no inverse. Behind STAGE_COARSE_REVERSE
 *     a PERSON's edit of it CHOOSES one (see the field below): never a guess, never another pipeline.
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
  // TWO-WAY from 2026-09-23. It was one-way so a stale card title could never ride along on an unrelated
  // edit and overwrite HubSpot -- a record-level-engine risk. With columnLevelReverse the name is sent
  // only when a person renames the card. It is also the only way a monday-created record gets a name:
  // buildCreateProperties sends the item name through nameReverse and nothing else.
  nameReverse: "dealname",
  boardId: "5028000494",
  idCol: "text_mm76kxz4",
  syncStateCol: "text_mm7668db",
  linkCol: "link_mm76z640",
  groupBy: { singleGroup: "topics", placeOnly: true },
  includeAll: true,
  skipFullReconcile: true,
  ownership: OWN_DEALS,
  restoreOnDelete: true,
  suppressSelfOriginWrites: true,
  columnLevelReverse: true,   // a person's edit pushes only that column; nothing else writes HubSpot
  fillEmptyFromMonday: true,
  createFromMonday: true,
  // Inert as shipped (CRM_CREATE_CUTOFF_MS is Infinity): no monday card is old enough to be
  // NEWER than it, so nothing creates until CRM_CREATE_CUTOFF_AT names a go-live timestamp.
  createCutoffMs: CRM_CREATE_CUTOFF_MS,
  /**
   * A DEAL CANNOT BE BORN WITHOUT A VALID PIPELINE + STAGE PAIR — HubSpot rejects the record otherwise,
   * and the monday form leaves both unanswered: Deal Pipeline is hidden on it and Stage is not
   * mandatory. These are the FLOOR, used only when the rep supplies nothing usable.
   *
   * "default" is HubSpot's own Sales Pipeline and `appointmentscheduled` its first, open stage (both
   * verified live). A floor rather than a guess at intent: deals created since 2026-08-01 split across
   * three pipelines — Maintenance 47, default 41, Shared Selling 12 — so there is no majority to infer.
   * The real answer is to make Pipeline visible and Stage mandatory on the form; this only guarantees a
   * create can never 400, and never lands in a CLOSED stage.
   *
   * NO adoptBy, deliberately: deal NAMES are not unique (this portal holds three deals called
   * "test123"), so adopting on one would link a new deal to an unrelated record. Duplicate protection
   * comes from claimHubspotForItem instead, which is keyed on the monday ITEM.
   */
  createDefaults: { pipeline: "default", dealstage: "appointmentscheduled" },
  stagePipelinePairing: { stageProp: "dealstage", pipelineProp: "pipeline" },
  // All three association directions, into the paired Connect Boards columns created 2026-09-14.
  // `deal_account` is a monday MIRROR resolving through deal_contact and is never written directly.
  associations: [
    { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: "deal_contact" },
    { toObject: "companies", nameProps: ["name"], relationCol: "board_relation_mm76wp4e" },
    { toObject: "line_items", nameProps: ["name"], relationCol: "board_relation_mm76btmt" },
  ],
  fields: [
    /**
     * ONE-WAY: the coarse summary. See the header — many-to-one has no inverse.
     *
     * FIXED 2026-09-15, mid-import, and this is the defect that stopped it. This was
     * `labels: "stage"`, and `stage` is built by getDealStageLabels, which reads HubSpot's DEFAULT
     * PIPELINE ONLY. This portal keeps 42 stages across 5 pipelines and almost every deal lives in a
     * Salesforce pipeline, so the dictionary missed them, formatValue fell through `dict[v] ?? v`,
     * and — because every monday write sets create_labels_if_missing — each unmapped deal MINTED A
     * STATUS LABEL NAMED AFTER ITS RAW STAGE GUID. 8 appeared in the first 70 cards; a status column
     * degrades above ~19, so the import was two labels from wedging the column for the whole team.
     *
     * The canary could not have caught it, and said so: automation 31010016 (item created -> set
     * Stage = New) was live then and overwrote this column on every card, so canary-deals.mjs
     * explicitly excludes it from validation. Turning that automation off — a prerequisite of the
     * import — is precisely what exposed the bug.
     *
     * `crmCoarseStage` buckets every stage in every pipeline into the five labels the board already
     * has, from HubSpot's own stage METADATA rather than label text (the Salesforce pipelines reuse
     * the same nine Chinese names, so 赢单 alone is three stage ids). `strictDict` makes an unmapped
     * stage omit the column and log, instead of inventing a sixth label.
     *
     * KEPT, not removed, deliberately: Zmark's automations 31010010/31010011/31010012/31010014/
     * 31010017 all key off this native column, and they are how the business wants the board to work.
     * The exact, authoritative stage is the pipeline-qualified dropdown below; this one is the coarse
     * surface those automations read.
     */
    /*
     * STAGE_COARSE_REVERSE (ships "false"): a PERSON may edit it through. Still `oneWay` here on purpose:
     * with the flag off that keeps every event on it ignored, and with it on the webhook lets only a
     * person's edit past (never automation 31010016's Stage = New, never our own echo), and
     * coarseStageEdit (reconcile.ts) turns the label into ONE stage within the deal's current pipeline:
     * nothing when HubSpot's stage already reads as it, else the first stage of that bucket -- the LAST
     * for Lost, so it is 输单 and never the 暂停 (Paused) before it (coarseStageTargets). Only the five
     * labels are accepted; the leftovers and a blank are refused and snapped back -- but never back onto
     * Won, because that write re-runs 31010010 and 31010017 (a duplicate Client Project): a refused edit
     * of an already-Won deal is left as set and logged. An edit of HubSpot Stage in the same change wins.
     * The forward direction is unchanged. A monday-born deal is still created from createDefaults when
     * HubSpot Stage is empty: the create cannot tell a person's Stage from 31010016's New, so this column
     * never feeds it.
     */
    { hs: "dealstage", col: "deal_stage", type: "status", labels: "crmCoarseStage",
      oneWay: true, strictDict: true },
    // TWO-WAY: the exact stage, pipeline-qualified so the inverse is a function.
    { hs: "dealstage", col: "dropdown_mm7624zd", type: "dropdown", labels: "crmStage", reverse: true },
    { hs: "pipeline", col: "dropdown_mm76s7kk", type: "dropdown", labels: "crmPipeline", reverse: true },
    { hs: "amount", col: "deal_value", type: "numbers", reverse: true },
    /**
     * localDate: HubSpot stores a Close Date picked in its UI as LOCAL midnight (16:00Z the day before,
     * portal Asia/Shanghai). A UTC slice showed the day BEFORE on 7,094 of 8,632 deals (2026-09-23).
     * The reverse sends a plain YYYY-MM-DD, stored at 00:00Z, which reads back as the same local day --
     * so the round trip is stable in both directions.
     */
    { hs: "closedate", col: "deal_expected_close_date", type: "date", reverse: true, localDate: true },
    // HubSpot stores a FRACTION (0.2); the column renders `%`. Without scale a 20% deal reads 0.2%,
    // and the board's Forecast Value formula multiplies that error into money.
    { hs: "hs_deal_stage_probability", col: "deal_close_probability", type: "numbers", reverse: true, scale: 100 },
    { hs: "dealtype", col: "dropdown_mm76sh6x", type: "dropdown", labels: "dealtype", reverse: true },
    { hs: "hs_priority", col: "color_mm76tdww", type: "status", labels: "priority", reverse: true },
    // No dictionary: HubSpot resolves these options dynamically, and `labels: "pipeline"` (the value
    // until 2026-09-23) was the wrong dictionary outright, so every edit was refused. See reverseAs.
    { hs: "deal_currency_code", col: "dropdown_mm76570x", type: "dropdown", reverse: true, reverseAs: "currency" },
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm76dtzq", type: "dropdown", labels: "vendor", reverse: true },
    // The People column the business asked for. FORWARD-ONLY — see the Accounts twin above for why the
    // shared-email collapse makes the inverse unsafe. The dropdown below keeps its reverse for now, so
    // a rep can still reassign a deal until the People path is proven.
    // TWO-WAY from 2026-09-23 -- see the Contacts Sales User note. The dropdown stays for now: it is the
    // only place deals owned by people without a monday seat (joan zhang, the shared-email departments)
    // still show a Sales User, so deleting it would blank ~390 cards.
    { hs: "sales_user", col: "multiple_person_mm7df31a", type: "people", reverse: true },
    // Record OWNERSHIP: appReverse, so a stale people column cannot silently reassign a deal.
    { hs: "hubspot_owner_id", col: "deal_owner", type: "people", appReverse: true },
    // HubSpot-computed: there is nothing to push back.
    { hs: "notes_last_updated", col: "date__1", type: "date", oneWay: true, localDate: true },
    /**
     * CREATED DATE — the HubSpot deal's, not the monday card's.
     *
     * Deliberately NOT monday's built-in Creation Log: that records when the CARD was made, and every
     * card on this board was made during the 2026-09-14/15 import, so it would assert that all 8,665
     * deals were created that week. Measured: 0 of 20 sampled cards share a calendar day with their
     * HubSpot deal. Creation Log is also read-only, so the engine could not populate it either way.
     *
     * Population is essentially total (8,664 of 8,665), so this fills in on virtually every card.
     */
    { hs: "createdate", col: "date_mm7dgxym", type: "date", oneWay: true, localDate: true },
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
  // TWO-WAY from 2026-09-23. It was one-way so a stale card title could never ride along on an unrelated
  // edit and overwrite HubSpot -- a record-level-engine risk. With columnLevelReverse the name is sent
  // only when a person renames the card. It is also the only way a monday-created record gets a name:
  // buildCreateProperties sends the item name through nameReverse and nothing else.
  nameReverse: "name",
  boardId: "5028000489",
  idCol: "text_mm76qwtw",
  syncStateCol: "text_mm76kcss",
  linkCol: "link_mm76mcap",
  groupBy: { singleGroup: "topics", placeOnly: true },
  includeAll: true,
  skipFullReconcile: true,
  ownership: OWN_LINE_ITEMS,
  restoreOnDelete: true,
  suppressSelfOriginWrites: true,
  columnLevelReverse: true,   // a person's edit pushes only that column; nothing else writes HubSpot
  fillEmptyFromMonday: true,
  /**
   * CREATION ENABLED 2026-09-21. The P&S form's own description says what it is for — "等同之前在
   * hubspot中新增：Line items" — and until now it added a monday card and no Line Item.
   *
   * NO adoptBy: a line item has no natural key. Two rows of "Intercom, qty 5" on one deal are two
   * legitimate line items, not a duplicate, so matching on name or SKU would silently merge real data.
   * Duplicate protection is claimHubspotForItem, keyed on the monday ITEM, which is the only thing that
   * genuinely identifies "this row the rep just added".
   */
  createFromMonday: true,
  // Inert as shipped (CRM_CREATE_CUTOFF_MS is Infinity): no monday card is old enough to be
  // NEWER than it, so nothing creates until CRM_CREATE_CUTOFF_AT names a go-live timestamp.
  createCutoffMs: CRM_CREATE_CUTOFF_MS,
  /**
   * BORN ON ITS DEAL. typeId 20 is HubSpot's line_item -> deal association, read live from
   * /crm/v4/associations/line_items/deals/labels rather than assumed. The Deal relation is already
   * mandatory on the form, so a rep cannot normally reach the refusal — but a Deal card that has not
   * itself synced yet can, and that is exactly when refusing is right.
   */
  createParent: { toObject: "deals", relationCol: "board_relation_mm76w9y5", associationTypeId: 20 },
  associations: [
    { toObject: "deals", nameProps: ["dealname"], relationCol: "board_relation_mm76w9y5" },
    /**
     * THE ACCOUNT, DERIVED — so nobody has to pick it by hand.
     *
     * A line item carries no company in HubSpot: `/crm/v4/associations/line_items/companies/labels`
     * returns an EMPTY set, verified live, so this is not a direct association written the long way,
     * it is the only way the link can be known. `via: "deals"` walks line_item -> deal -> company.
     *
     * NO `col:` AND NO Company Name FIELD, deliberately. lookup_mm7cte64 ("Company name") is a monday
     * MIRROR already resolving through this very relation column onto the Accounts board's
     * text_mm6t1q4h. Populating the relation makes the name appear by itself; adding a text copy would
     * be the second source of truth the Contacts spec removed `company` for.
     *
     * `viaPrimary` matters on ~5% of the board: a deal may link two companies, one of them flagged
     * Primary (typeId 5). Without it a line item would show both Accounts.
     *
     * REVERSE: a person's edit of this cell never writes a line item association (none can exist).
     * Behind PS_ACCOUNT_REVERSE (off by default) it may FILL the company of the line item's single deal
     * when that deal has none -- deal -> company, Primary -- and every other edit snaps the cell back to
     * this derived set. See fillDealCompany in associations.ts.
     */
    { toObject: "companies", nameProps: ["name"], relationCol: "board_relation_mm7cz3v8",
      via: "deals", viaPrimary: true },
  ],
  fields: [
    /**
     * DEAL OWNER, so item-level permissions can later restrict a rep to their own deals' lines.
     *
     * NOT derived from the associated Deal, though that is what it represents. Measured across 60
     * line items: 46 carried an owner identical to their deal's, 0 disagreed, and 0 lacked one where
     * the deal had one — HubSpot already maintains this. Computing it ourselves would add a second
     * source of truth to drift out of step, and a permissions column that silently drifts is how
     * someone loses sight of their own pipeline.
     *
     * oneWay: monday must never write an owner back. The Deal is where ownership is decided, and a
     * stale people column reassigning a line item is the failure this ordering exists to prevent.
     */
    { hs: "hubspot_owner_id", col: "multiple_person_mm79ey0p", type: "people", oneWay: true },
    { hs: "hs_sku", col: "text_mm73mvfj", type: "text", reverse: true },
    { hs: "description", col: "product_and_service_description", type: "long_text", reverse: true },
    { hs: "note", col: "text_mm7318s1", type: "text", reverse: true },
    { hs: "quantity", col: "numeric_mm7652yc", type: "numbers", reverse: true },
    { hs: "price", col: "numeric_mm76w6wc", type: "numbers", reverse: true },
    { hs: "hs_cost_of_goods_sold", col: "numeric_mm76yzc4", type: "numbers", reverse: true },
    { hs: "discount", col: "numeric_mm76kfhq", type: "numbers", reverse: true },
    { hs: "deposit", col: "numeric_mm762vb", type: "numbers", reverse: true },
    /**
     * NET PRICE — HubSpot's own label for `amount`, and HubSpot's own arithmetic.
     *
     * NEVER compute this as price x quantity. That formula reproduces `hs_pre_discount_amount`, not
     * `amount`: live line item 9956357489 is 15,400 x 1 with an amount of 12,320, because a discount
     * that the `discount` property does not show is folded in. Recomputing would overstate that row by
     * 3,080 and nothing would flag it.
     *
     * oneWay because the property is calculated/read-only in HubSpot — a reverse write is rejected.
     * Populated on 9,970 of 9,970 line items, so the column fills on every card.
     */
    { hs: "amount", col: "numeric_mm7dezck", type: "numbers", oneWay: true },
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
    // No dictionary: the property's options are externalOptions, so `liCurrency` fetched EMPTY and every
    // edit was refused. The cells hold bare ISO codes. See reverseAs.
    { hs: "hs_line_item_currency_code", col: "dropdown_mm76dqnc", type: "dropdown", reverse: true, reverseAs: "currency" },
  ],
};

/** The CRM specs, selected EXCLUSIVELY (never unioned with the WM specs) when ENABLE_CRM is set. */
export const CRM_SPECS: ObjectSpec[] = [CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS, CRM_LINE_ITEMS];
