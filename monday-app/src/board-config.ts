// Single source of truth for board/column ids the app reads and writes. HubSpot ids are strings.
export const WORKER_BASE = "https://hubspot-monday-sync.askada.workers.dev";

// HubSpot portal (account) id — used to build deep links to a deal's HubSpot record.
export const HUBSPOT_PORTAL_ID = "39939588";
export const hubspotDealUrl = (dealId: string) =>
  `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;
// Deep link to a linked contact/company's HubSpot record (0-1 = contacts, 0-2 = companies; deals are 0-3).
const HS_OBJ = { contacts: "0-1", companies: "0-2" } as const;
export const hubspotRecordUrl = (kind: "contacts" | "companies", id: string) =>
  `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/${HS_OBJ[kind]}/${id}`;

export const DEALS_BOARD = "5029480547";
export const SUBITEMS_BOARD = "5029480548";
export const CONTACT_BOARD = "5029639630";
export const COMPANY_BOARD = "5029639440";

export const UNASSIGNED_GROUP = "group_mm53yk6d";
export const CONTACT_ID_COL = "numeric_mm4xw7rk"; // HubSpot id on the Contact board
export const COMPANY_ID_COL = "numeric_mm4xkk3a"; // HubSpot id on the Company board
// Fallback name-cascade sources (same column id on both boards): contact lastname / company name.
export const LINK_NAME_COL_2 = "text_mm4scke9";
// contact email (this column is 'city' on the company board — linkDisplayName never uses it for companies).
export const LINK_NAME_COL_3 = "text_mm4p2bvb";

export interface ColSpec { id: string; kind: string; boardId?: string }

// Deal columns. `kind` = expected monday column type (for schema validation).
export const DEAL_COLS = {
  hubspotDealId: { id: "numeric_mm4nz332", kind: "numeric" },   // read-only (Worker stamps it)
  pipeline:      { id: "color_mm4ws6k",   kind: "status" },
  stage:         { id: "color_mm53fh1r",  kind: "status" },
  vendors:       { id: "dropdown_mm4n4f7r", kind: "dropdown" },
  amount:        { id: "numeric_mm531t6e", kind: "numeric" },
  currency:      { id: "color_mm53vk99",  kind: "status" },
  closeDate:     { id: "date_mm53ecz3",   kind: "date" },
  salesUsers:    { id: "multiple_person_mm532m82", kind: "multiple-person" },
  dealOwner:     { id: "person",          kind: "multiple-person" },
  dealType:      { id: "color_mm53cky8",  kind: "status" },
  priority:      { id: "color_mm532rej",  kind: "status" },
  company:       { id: "board_relation_mm54rrj3", kind: "board-relation", boardId: COMPANY_BOARD },
  contact:       { id: "board_relation_mm5417sy", kind: "board-relation", boardId: CONTACT_BOARD },
} as const;

// Subitem (line item) columns.
export const SUB_COLS = {
  lineItemId: { id: "text_mm53ds6w",       kind: "text" },      // HubSpot Line Item ID (dedup key, read-only)
  productId:  { id: "text_mm54hbvj",       kind: "text" },      // HubSpot Product ID
  unitPrice:  { id: "numeric_mm53rsfd",    kind: "numeric" },
  quantity:   { id: "numeric_mm531345",    kind: "numeric" },
  discount:   { id: "numeric_mm53pkyf",    kind: "numeric" },   // per-unit discount amount (HubSpot discount)
  discountPct:{ id: "numeric_mm5ax22v",    kind: "numeric" },   // discount % (HubSpot hs_discount_percentage)
  serviceDate:{ id: "date_mm53chbv",       kind: "date" },
  netPrice:   { id: "numeric_mm538yj9",    kind: "numeric" },
  currency:   { id: "text_mm538b8k",       kind: "text" },
  description:{ id: "long_text_mm53a511",  kind: "long-text" },
} as const;
