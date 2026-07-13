// Single source of truth for board/column ids the app reads and writes. HubSpot ids are strings.
export const WORKER_BASE = "https://hubspot-monday-sync.askada.workers.dev";

export const DEALS_BOARD = "5029480547";
export const SUBITEMS_BOARD = "5029480548";
export const CONTACT_BOARD = "5029639630";
export const COMPANY_BOARD = "5029639440";

export const UNASSIGNED_GROUP = "group_mm53yk6d";
export const CONTACT_ID_COL = "numeric_mm4xw7rk"; // HubSpot id on the Contact board
export const COMPANY_ID_COL = "numeric_mm4xkk3a"; // HubSpot id on the Company board

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
  netPrice:   { id: "numeric_mm538yj9",    kind: "numeric" },
  currency:   { id: "text_mm538b8k",       kind: "text" },
  description:{ id: "long_text_mm53a511",  kind: "long-text" },
} as const;
