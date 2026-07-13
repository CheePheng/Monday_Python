// Pure request-body validation for the app's edit/remove endpoints. All ids are strings and must be
// numeric (HubSpot ids). Kept separate from index.ts so it is unit-testable without a live request.
const numeric = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const FROM_OK = new Set(["deals"]);
const TO_OK = new Set(["contacts", "companies"]);

export interface LineItemReq { ok: boolean; lineItemId?: string; properties?: Record<string, string>; error?: string }
export function parseLineItemBody(method: string, body: any): LineItemReq {
  const lineItemId = body?.lineItemId;
  if (!numeric(lineItemId)) return { ok: false, error: "lineItemId must be a numeric string" };
  if (method === "PATCH") {
    const properties = body?.properties;
    if (!properties || typeof properties !== "object" || Object.keys(properties).length === 0)
      return { ok: false, error: "properties required for update" };
    return { ok: true, lineItemId, properties };
  }
  return { ok: true, lineItemId, properties: undefined };
}

export interface AssocReq { ok: boolean; fromObject?: string; fromId?: string; toObject?: string; toId?: string; error?: string }
export function parseAssociationBody(body: any): AssocReq {
  const { fromObject, fromId, toObject, toId } = body ?? {};
  if (!FROM_OK.has(fromObject)) return { ok: false, error: "fromObject must be deals" };
  if (!TO_OK.has(toObject)) return { ok: false, error: "toObject must be contacts|companies" };
  if (!numeric(fromId) || !numeric(toId)) return { ok: false, error: "fromId/toId must be numeric strings" };
  return { ok: true, fromObject, fromId, toObject, toId };
}
