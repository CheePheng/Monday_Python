export interface Env {
  MONDAY_API_TOKEN: string;
  HUBSPOT_ACCESS_TOKEN: string;
  TRIGGER_SECRET: string;
  DRY_RUN: string; // "true" | "false"
  HUBSPOT_APP_SECRET?: string;   // optional: validate HubSpot webhook v3 signatures if set
  MONDAY_SIGNING_SECRET?: string; // optional: verify monday webhook JWT if set
  MAX_WRITES?: string;           // optional: writes/records per cron tick (default 25; raise on Workers Paid)
}

export type ColType = "text" | "long_text" | "numbers" | "status" | "dropdown" | "date" | "people" | "phone";
export type LabelDict =
  | "stage" | "dealtype" | "priority" | "vendor" | "pipeline"
  | "industry" | "companyType" | "leadStatus" | "salesUser"
  | "contactSource" | "contactVendor" | "partnerWith";

export interface FieldSpec {
  hs: string;            // HubSpot property name
  col: string;           // monday column id
  type: ColType;
  labels?: LabelDict;    // enum label dictionary (HubSpot internal value -> display label)
  reverse?: boolean;     // monday edits may be written back to HubSpot
}

export type GroupBy =
  // hs value -> monday group id. fallbackGroup catches empty/unmapped values so the record is placed
  // instead of skipped (e.g. a contact with no lead status still lands in the "New" group).
  // noSalesUserGroup overrides placement when the record has no sales_user (e.g. the shared Deals
  // board's "Unassigned Deals" group).
  | { prop: string; map: Record<string, string>; reverse: boolean; fallbackGroup?: string; noSalesUserGroup?: string }
  | { singleGroup: string };

export interface ObjectSpec {
  object: "deals" | "companies" | "contacts";
  objectTypeId: "0-1" | "0-2" | "0-3"; // for HubSpot record deep links
  searchFilters: Record<string, unknown>[]; // one HubSpot filterGroup's filters
  modifiedProp: string;  // hs_lastmodifieddate | lastmodifieddate
  nameProps: string[];   // properties composing the monday item name
  nameReverse?: string;  // HubSpot property to receive a renamed item (omit = name not reversible)
  boardId: string;
  idCol: string;         // numbers column storing the HubSpot record id (dedup key)
  syncStateCol: string;  // hidden text column storing the last-synced HubSpot modified timestamp
  linkCol?: string;
  groupBy: GroupBy;
  fields: FieldSpec[];
  // monday -> HubSpot record creation (new cards). false for system-populated boards (Unassigned).
  createFromMonday: boolean;
  // fixed HubSpot properties stamped on records created from monday (pipeline, owner, sales_user...).
  createDefaults?: Record<string, string>;
  // HubSpot associations to reflect onto the monday item (HubSpot -> monday only). See associations.ts.
  associations?: AssocSpec[];
}

// A HubSpot association synced onto the parent monday item (HubSpot -> monday only, no reverse).
export interface AssocSpec {
  toObject: "companies" | "contacts" | "deals" | "line_items";
  nameProps: string[];     // properties composing the associated record's display name / line-item name
  col?: string;            // parent text column for comma-joined names (companies/contacts/deals)
  relationCol?: string;    // "Connect Boards" (board_relation) column: links to the actual monday cards.
                           // monday can't CREATE this column type via API — make it in the UI, then set the id here.
  subitems?: SubitemSpec;  // line_items only: sync each as a subitem
}
export interface SubitemSpec {
  boardId: string;     // subitems board id
  idCol: string;       // "HubSpot Line Item ID" text column (dedup key)
  fields: FieldSpec[]; // line-item property -> subitem column
  statusCol?: string;  // subitem status column: a removed line item is marked "Removed" (else deleted)
}

export interface MondayItem {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  group: { id: string };
  column_values: { id: string; text: string | null }[];
}

export interface HsRecord { id: string; properties: Record<string, string | null> }

export interface Ctx {
  labels: Partial<Record<LabelDict, Record<string, string>>>;
  ownersById: Record<string, { name: string; email: string | null }>;
  mondayUsersByEmail: Record<string, string>;
  portalId: number;
}

export interface RunOpts { dryRun: boolean; writeHubspot: boolean; maxWrites: number }

export interface Stats {
  processed: number; created: number; toMonday: number; toHubspot: number;
  inSync: number; skipped: number; errors: number; adopted: number; createdInHubspot: number;
}

// A shared, mutable write budget threaded across all specs in one run.
export interface Budget { left: number }
