import type { ObjectSpec, SubitemSpec } from "./types";

// ---- Discovered constants (worker_discovery.py / add_id_columns.py, 2026-07-03) ----
// sales_user values are raw HubSpot owner ids (the property has no labeled options).
export const SALES_USER_MYLA = "1739141284";
export const COMPANY_ID_COL = "numeric_mm4xkk3a"; // "HubSpot ID" on board 5029639440
export const CONTACT_ID_COL = "numeric_mm4xw7rk"; // "HubSpot ID" on board 5029639630

export const PORTAL_ID = 39939588;

// Contacts/companies: only NEW records sync (boss decision 2026-07-03).
export const CREATED_AFTER_MS = Date.parse("2026-07-01T00:00:00Z");

// monday "All Members" team id, stamped onto the Shared column of Unassigned deals so everyone can view
// them under "restricted to assigned people" board permissions. "" = disabled until the team is created.
export const ALL_MEMBERS_TEAM_ID = "49243"; // monday "All Members" team
const DEAL_SHARED_COL = "multiple_person_mm54sj70"; // "Shared" people column on the deal board 5029480547

// monday cards created BEFORE this are never pushed to HubSpot (protects the 14 pre-existing
// orphan Unassigned cards + any legacy rows). Only cards a salesperson adds after go-live create.
export const CREATE_CUTOFF_MS = Date.parse("2026-07-03T00:00:00Z");

// Records created from monday get stamped as Myla's and (for deals) into the Sales Pipeline.
const MYLA_DEFAULTS = { sales_user: SALES_USER_MYLA, hubspot_owner_id: SALES_USER_MYLA };

// HubSpot stage id -> monday group id (shared Deals board 5029480547)
const STAGE_GROUPS: Record<string, string> = {
  appointmentscheduled: "group_mm4nf6fw",
  qualifiedtobuy: "group_title",
  presentationscheduled: "group_mm4pa9zg",
  decisionmakerboughtin: "group_mm4pbazz",
  contractsent: "group_mm4pavfa",
  closedwon: "group_mm4py571",
  closedlost: "group_mm4pw6e2",
  "2831885024": "group_mm4pdres",
};
// Deals with no sales_user land here (the "Unassigned Deals" group on the shared board 5029480547).
const UNASSIGNED_GROUP = "group_mm53yk6d";

// hs_lead_status internal value -> monday group id (Contact board 5029639630)
const LEAD_STATUS_GROUPS: Record<string, string> = {
  NEW: "topics",
  OPEN: "group_mm4wk3z0",
  IN_PROGRESS: "group_mm4w23q",
  OPEN_DEAL: "group_mm4w9de6",
  UNQUALIFIED: "group_mm4w1jd0",
  ATTEMPTED_TO_CONTACT: "group_mm4wcxb",
  CONNECTED: "group_mm4wactt",
  BAD_TIMING: "group_mm4w55z2",
};

// ---- Association columns (created 2026-07-09) ----
// Connect Boards (board_relation) link columns, created 2026-07-10 via the monday API (v2025-10).
// These LINK the actual cards (not text names). Old text columns kept below for post-verify deletion.
const DEAL_REL_COMPANY = "board_relation_mm54rrj3";    // Deal -> Company card link
const DEAL_REL_CONTACT = "board_relation_mm5417sy";    // Deal -> Contact card link
const COMPANY_REL_CONTACT = "board_relation_mm54e96";  // Company -> Contact card link
const CONTACT_REL_COMPANY = "board_relation_mm54dbxk"; // Contact -> Company card link
const CONTACT_REL_DEAL = "board_relation_mm54zahf";    // Contact -> Deal card link
// Retired text association columns (delete after verification): Deal text_mm53a30h / text_mm53k97q,
// Contact text_mm53m5g0 / text_mm53yyc3, Company text_mm5367qf.

// Deal line items -> subitems on board 5029480548. Line-item property names for Net Price / Service Date /
// Unit Discount are CONFIRMED in the plan's Task 7 (needs crm.objects.line_items.read on the private app).
export const LINE_ITEM_SUBITEMS: SubitemSpec = {
  boardId: "5029480548",
  idCol: "text_mm53ds6w",           // "HubSpot Line Item ID"
  statusCol: "status",              // removed line items -> subitem Status = "Removed"
  fields: [
    { hs: "price", col: "numeric_mm53rsfd", type: "numbers" },                       // Unit Price (HubSpot "Unit price")
    { hs: "quantity", col: "numeric_mm531345", type: "numbers" },                    // Quantity
    { hs: "hs_pre_discount_amount", col: "numeric_mm53txgw", type: "numbers" },      // Amount (pre-discount total)
    { hs: "amount", col: "numeric_mm538yj9", type: "numbers" },                      // Net Price (HubSpot "Net price")
    { hs: "service_date", col: "date_mm53chbv", type: "date" },                      // Service Date
    { hs: "discount", col: "numeric_mm53pkyf", type: "numbers" },                    // Unit Discount
    { hs: "hs_line_item_currency_code", col: "text_mm538b8k", type: "text" },        // Currency
    { hs: "description", col: "long_text_mm53a511", type: "long_text" },             // Description
  ],
};

export const DEALS: ObjectSpec = {
  object: "deals",
  objectTypeId: "0-3",
  // One shared board for ALL sales users: every Sales-Pipeline deal, any/no sales_user, all dates.
  searchFilters: [
    { propertyName: "pipeline", operator: "EQ", value: "default" },
  ],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"],
  nameReverse: "dealname",
  boardId: "5029480547",
  idCol: "numeric_mm4nz332",
  syncStateCol: "text_mm4xxyzx",
  linkCol: "link_mm4ns4nn",
  // Group by stage; deals with no sales_user go to the "Unassigned Deals" group instead.
  groupBy: { prop: "dealstage", map: STAGE_GROUPS, reverse: true, noSalesUserGroup: UNASSIGNED_GROUP },
  createFromMonday: true,
  // A card added by a salesperson creates a Sales-Pipeline deal; owner/sales_user get set in HubSpot
  // afterward — until then it sits in the Unassigned group.
  createDefaults: { pipeline: "default" },
  associations: [
    { toObject: "companies", nameProps: ["name"], relationCol: DEAL_REL_COMPANY },
    { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: DEAL_REL_CONTACT },
    { toObject: "line_items", nameProps: ["name"], subitems: LINE_ITEM_SUBITEMS },
  ],
  // Unassigned deals (no sales_user) -> stamp the all-members team on the Shared column so everyone can
  // see them under restricted board permissions. Active once ALL_MEMBERS_TEAM_ID is filled in.
  unassignedShared: { col: DEAL_SHARED_COL, teamId: ALL_MEMBERS_TEAM_ID },
  fields: [
    { hs: "hubspot_owner_id", col: "person", type: "people" },                                    // Deal Owner
    { hs: "sales_user", col: "multiple_person_mm532m82", type: "people", reverse: true },           // Sales Users (assign in monday -> HubSpot sales_user)
    { hs: "amount", col: "numeric_mm531t6e", type: "numbers" },                                    // Amounts
    { hs: "deal_currency_code", col: "color_mm53vk99", type: "status" },                           // Currency
    { hs: "closedate", col: "date_mm53ecz3", type: "date" },                                       // Close Date
    { hs: "dealstage", col: "color_mm53fh1r", type: "status", labels: "stage" },                   // Deal Stage
    { hs: "pipeline", col: "color_mm4ws6k", type: "status", labels: "pipeline" },                  // Deal Pipeline
    { hs: "dealtype", col: "color_mm53cky8", type: "status", labels: "dealtype", reverse: true },  // Deal Type
    { hs: "hs_priority", col: "color_mm532rej", type: "status", labels: "priority", reverse: true },             // Priority
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm4n4f7r", type: "dropdown", labels: "vendor", reverse: true }, // Vendors
  ],
};

export const COMPANIES_MYLA: ObjectSpec = {
  object: "companies",
  objectTypeId: "0-2",
  searchFilters: [
    // All sales users (not just Myla): any record with a sales_user assigned.
    { propertyName: "sales_user", operator: "HAS_PROPERTY" },
    { propertyName: "createdate", operator: "GTE", value: CREATED_AFTER_MS },
  ],
  modifiedProp: "hs_lastmodifieddate",
  // The board's primary column is "Company domain name" -> item name = HubSpot `domain`.
  // The company `name` maps to the separate "Company Name" text column (field below).
  nameProps: ["domain"],
  nameReverse: "domain",
  boardId: "5029639440",
  idCol: COMPANY_ID_COL,
  syncStateCol: "text_mm4xrhjt",
  linkCol: "link_mm4pvn78",
  groupBy: { singleGroup: "group_mm4s3z7e" },
  associations: [
    { toObject: "contacts", nameProps: ["firstname", "lastname"], relationCol: COMPANY_REL_CONTACT },
  ],
  createFromMonday: true,
  createDefaults: { ...MYLA_DEFAULTS },
  fields: [
    { hs: "name", col: "text_mm4scke9", type: "text", reverse: true },
    { hs: "hubspot_owner_id", col: "multiple_person_mm4p8xe2", type: "people" },
    { hs: "sales_user", col: "multiple_person_mm54phd7", type: "people", reverse: true },  // "Sales Users" (reverse to HubSpot)
    { hs: "industry", col: "dropdown_mm54zrp2", type: "dropdown", labels: "industry", reverse: true }, // single-select dropdown (limit_select): 200 options, one pick
    { hs: "type", col: "color_mm545z1t", type: "status", labels: "companyType", reverse: true },
    { hs: "partner_with", col: "color_mm54xzax", type: "status", labels: "partnerWith" },  // "Partner With"
    { hs: "city", col: "text_mm4p2bvb", type: "text", reverse: true },
    { hs: "state", col: "text_mm4sznkw", type: "text", reverse: true },
    { hs: "numberofemployees", col: "numeric_mm4ww8gs", type: "numbers", reverse: true },
    { hs: "annualrevenue", col: "numeric_mm4w8g9k", type: "numbers", reverse: true },
    { hs: "timezone", col: "text_mm4wp480", type: "text" },
    { hs: "description", col: "text_mm4wwtd0", type: "text", reverse: true },
    { hs: "linkedin_company_page", col: "text_mm4w6rzg", type: "text", reverse: true },
  ],
};

export const CONTACTS_MYLA: ObjectSpec = {
  object: "contacts",
  objectTypeId: "0-1",
  searchFilters: [
    // All sales users (not just Myla): any record with a sales_user assigned.
    { propertyName: "sales_user", operator: "HAS_PROPERTY" },
    { propertyName: "createdate", operator: "GTE", value: CREATED_AFTER_MS },
  ],
  modifiedProp: "lastmodifieddate",
  // The board's primary column is "First name" -> item name = HubSpot `firstname` (reverse-synced so
  // editing it in monday writes back). `lastname` maps to the separate "Last Name" text column (field).
  nameProps: ["firstname"],
  nameReverse: "firstname",
  boardId: "5029639630",
  idCol: CONTACT_ID_COL,
  syncStateCol: "text_mm4xpe1g",
  linkCol: "link_mm4pvn78",
  // Contacts with no/unknown lead status land in the "New" group (topics) instead of being skipped.
  // reverse:false -> the group FOLLOWS HubSpot (forward-only). Lead status is edited via the "Lead
  // Status" column (the reversible field below); the group then moves to match on the next sync. If the
  // group also reverse-wrote hs_lead_status it would fight the column edit and oscillate ("Open" -> "New").
  groupBy: { prop: "hs_lead_status", map: LEAD_STATUS_GROUPS, reverse: false, fallbackGroup: "topics" },
  associations: [
    { toObject: "companies", nameProps: ["name"], relationCol: CONTACT_REL_COMPANY },
    { toObject: "deals", nameProps: ["dealname"], relationCol: CONTACT_REL_DEAL },
  ],
  createFromMonday: true,
  createDefaults: { ...MYLA_DEFAULTS },
  fields: [
    { hs: "lastname", col: "text_mm4scke9", type: "text", reverse: true },
    { hs: "email", col: "text_mm4p2bvb", type: "text", reverse: true },
    { hs: "jobtitle", col: "text_mm4sznkw", type: "text", reverse: true },
    { hs: "company", col: "text_mm4sbj9b", type: "text" },
    { hs: "phone", col: "phone_mm4s31p3", type: "phone" },
    { hs: "hubspot_owner_id", col: "multiple_person_mm4p8xe2", type: "people" },
    { hs: "sales_user", col: "multiple_person_mm542gng", type: "people", reverse: true },  // "Sales Users" (reverse to HubSpot)
    { hs: "createdate", col: "date_mm4s2bjd", type: "date" },
    { hs: "notes_last_updated", col: "date4", type: "date" },
    { hs: "hs_lead_status", col: "status", type: "status", labels: "leadStatus", reverse: true }, // edit here -> writes back to HubSpot
    { hs: "leadsource", col: "dropdown_mm4sj3kw", type: "dropdown", labels: "contactSource" },
    { hs: "manufacturer__c", col: "dropdown_mm4t8gjf", type: "dropdown", labels: "contactVendor" },
  ],
};

export const ALL_SPECS: ObjectSpec[] = [DEALS, COMPANIES_MYLA, CONTACTS_MYLA];

// Deal boards a HubSpot deal webhook can route to (now just the one shared board).
export const DEAL_SPECS: ObjectSpec[] = [DEALS];

// boardId -> spec, so a monday webhook can find the spec for the board that fired it.
export const SPEC_BY_BOARD: Record<string, ObjectSpec> =
  Object.fromEntries(ALL_SPECS.map(s => [s.boardId, s]));

// object name -> spec, so a Connect-Boards association can resolve the target board + its HubSpot-id
// column (to turn associated HubSpot ids into the monday cards to link). line_items has no board.
export const SPEC_BY_OBJECT: Record<string, ObjectSpec> = {
  deals: DEALS, companies: COMPANIES_MYLA, contacts: CONTACTS_MYLA,
};
