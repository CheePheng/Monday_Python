import type { ObjectSpec } from "./types";

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

// HubSpot stage id -> monday group id (Myla's Deals board 5029480547)
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

export const DEALS_MYLA: ObjectSpec = {
  object: "deals",
  objectTypeId: "0-3",
  searchFilters: [
    { propertyName: "pipeline", operator: "EQ", value: "default" },
    { propertyName: "sales_user", operator: "EQ", value: SALES_USER_MYLA },
  ],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"],
  nameReverse: "dealname",
  boardId: "5029480547",
  idCol: "numeric_mm4nz332",
  syncStateCol: "text_mm4xxyzx",
  linkCol: "link_mm4ns4nn",
  groupBy: { prop: "dealstage", map: STAGE_GROUPS, reverse: true },
  createFromMonday: true,
  createDefaults: { pipeline: "default", ...MYLA_DEFAULTS },
  fields: [
    { hs: "hubspot_owner_id", col: "person", type: "people" },
    { hs: "dealstage", col: "color_mm4n27da", type: "status", labels: "stage" },
    { hs: "createdate", col: "date4", type: "date" },
    { hs: "pipeline", col: "dropdown_mm4ngscc", type: "dropdown", labels: "pipeline" },
    { hs: "dealtype", col: "dropdown_mm4nxhje", type: "dropdown", labels: "dealtype", reverse: true },
    { hs: "hs_priority", col: "dropdown_mm4nmmax", type: "dropdown", labels: "priority", reverse: true },
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm4n4f7r", type: "dropdown", labels: "vendor", reverse: true },
  ],
};

export const DEALS_UNASSIGNED: ObjectSpec = {
  object: "deals",
  objectTypeId: "0-3",
  searchFilters: [
    { propertyName: "pipeline", operator: "EQ", value: "default" },
    { propertyName: "sales_user", operator: "NOT_HAS_PROPERTY" },
  ],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"],
  boardId: "5029479220",
  idCol: "numeric_mm4wp9y2",
  syncStateCol: "text_mm4xsfh3",
  linkCol: "link_mm4n9cce",
  groupBy: { singleGroup: "topics" },
  createFromMonday: false, // system-populated bucket; never create HubSpot deals from here
  fields: [
    { hs: "hubspot_owner_id", col: "person", type: "people" },
    { hs: "pipeline", col: "status", type: "status", labels: "pipeline" },
    { hs: "dealstage", col: "dropdown_mm4nkk6y", type: "dropdown", labels: "stage" },
    { hs: "createdate", col: "date4", type: "date" },
    { hs: "dealtype", col: "dropdown_mm4nkmg5", type: "dropdown", labels: "dealtype" },
    { hs: "hs_priority", col: "dropdown_mm4n2mrd", type: "dropdown", labels: "priority" },
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm4nys6v", type: "dropdown", labels: "vendor" },
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
  nameProps: ["name"],
  nameReverse: "name",
  boardId: "5029639440",
  idCol: COMPANY_ID_COL,
  syncStateCol: "text_mm4xrhjt",
  linkCol: "link_mm4pvn78",
  groupBy: { singleGroup: "group_mm4s3z7e" },
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
  nameProps: ["firstname", "lastname"],
  boardId: "5029639630",
  idCol: CONTACT_ID_COL,
  syncStateCol: "text_mm4xpe1g",
  linkCol: "link_mm4pvn78",
  groupBy: { prop: "hs_lead_status", map: LEAD_STATUS_GROUPS, reverse: true },
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

export const ALL_SPECS: ObjectSpec[] = [DEALS_MYLA, DEALS_UNASSIGNED, COMPANIES_MYLA, CONTACTS_MYLA];
