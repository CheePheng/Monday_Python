import type { ObjectSpec, SubitemSpec } from "./types";

// ---- Discovered constants (worker_discovery.py / add_id_columns.py, 2026-07-03) ----
// sales_user values are raw HubSpot owner ids (the property has no labeled options).
export const SALES_USER_MYLA = "1739141284";
export const COMPANY_ID_COL = "numeric_mm4xkk3a"; // "HubSpot ID" on board 5029639440
export const CONTACT_ID_COL = "numeric_mm4xw7rk"; // "HubSpot ID" on board 5029639630

export const PORTAL_ID = 39939588;

// Contacts/companies: only NEW records sync (boss decision 2026-07-03).
export const CREATED_AFTER_MS = Date.parse("2026-07-01T00:00:00Z");

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
const DEAL_ASSOC_COMPANY = "text_mm53a30h";   // Deal board "Associated Company"
const DEAL_ASSOC_CONTACT = "text_mm53k97q";   // Deal board "Associated Contact"
const DEAL_LI_SUMMARY = "long_text_mm53xer1"; // "Line Items Summary"
const DEAL_LI_COUNT = "numeric_mm53j24a";     // "Line Items Count"
const DEAL_LI_TOTAL = "numeric_mm534mmf";     // "Line Items Total Value"
const COMPANY_ASSOC_CONTACT = "text_mm5367qf"; // Company board "Associated Contact"
const CONTACT_ASSOC_COMPANY = "text_mm53m5g0"; // Contact board "Associated Company"
const CONTACT_ASSOC_DEAL = "text_mm53yyc3";    // Contact board "Associated Deal"

// Deal line items -> subitems on board 5029480548. Line-item property names for Net Price / Service Date /
// Unit Discount are CONFIRMED in the plan's Task 7 (needs crm.objects.line_items.read on the private app).
export const LINE_ITEM_SUBITEMS: SubitemSpec = {
  boardId: "5029480548",
  idCol: "text_mm53ds6w",           // "HubSpot Line Item ID"
  summaryCol: DEAL_LI_SUMMARY, countCol: DEAL_LI_COUNT, totalCol: DEAL_LI_TOTAL, totalProp: "amount",
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
    { toObject: "companies", nameProps: ["name"], col: DEAL_ASSOC_COMPANY },
    { toObject: "contacts", nameProps: ["firstname", "lastname"], col: DEAL_ASSOC_CONTACT },
    { toObject: "line_items", nameProps: ["name"], subitems: LINE_ITEM_SUBITEMS },
  ],
  fields: [
    { hs: "hubspot_owner_id", col: "person", type: "people" },                                    // Deal Owner
    { hs: "sales_user", col: "multiple_person_mm532m82", type: "people" },                         // Sales Users (person)
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
    { propertyName: "sales_user", operator: "EQ", value: SALES_USER_MYLA },
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
    { toObject: "contacts", nameProps: ["firstname", "lastname"], col: COMPANY_ASSOC_CONTACT },
  ],
  createFromMonday: true,
  createDefaults: { ...MYLA_DEFAULTS },
  fields: [
    { hs: "name", col: "text_mm4scke9", type: "text", reverse: true },
    { hs: "hubspot_owner_id", col: "multiple_person_mm4p8xe2", type: "people" },
    { hs: "industry", col: "dropdown_mm4wj6nv", type: "dropdown", labels: "industry", reverse: true },
    { hs: "type", col: "dropdown_mm4wa6ak", type: "dropdown", labels: "companyType", reverse: true },
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
    { propertyName: "sales_user", operator: "EQ", value: SALES_USER_MYLA },
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
  groupBy: { prop: "hs_lead_status", map: LEAD_STATUS_GROUPS, reverse: true, fallbackGroup: "topics" },
  associations: [
    { toObject: "companies", nameProps: ["name"], col: CONTACT_ASSOC_COMPANY },
    { toObject: "deals", nameProps: ["dealname"], col: CONTACT_ASSOC_DEAL },
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
    { hs: "sales_user", col: "dropdown_mm4thdr", type: "dropdown", labels: "salesUser" },
    { hs: "createdate", col: "date_mm4s2bjd", type: "date" },
    { hs: "notes_last_updated", col: "date4", type: "date" },
    { hs: "hs_lead_status", col: "status", type: "status", labels: "leadStatus" },
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
