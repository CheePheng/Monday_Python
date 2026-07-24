// Pure request-body validation for the app's edit/remove endpoints. All ids are strings and must be
// numeric (HubSpot ids). Kept separate from index.ts so it is unit-testable without a live request.
import { pickWritableLineItemProps } from "./line-item-props";
import { pickWritableContactProps, pickWritableCompanyProps } from "./contact-company-props";

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

export interface DealReq { ok: boolean; hubspotDealId?: string; error?: string }
export function parseDealBody(body: any): DealReq {
  const hubspotDealId = body?.hubspotDealId;
  if (!numeric(hubspotDealId)) return { ok: false, error: "hubspotDealId must be a numeric string" };
  return { ok: true, hubspotDealId };
}

/** The ONLY deal properties this API may blank, enforced server-side. The reconciler must never clear
 * HubSpot from an empty monday value — it can't tell "never set" from "just cleared" — so clearing is
 * an explicit act the rep takes in the app, carried here, and confined to this allowlist. */
export const CLEARABLE_DEAL_PROPS = new Set(["amount", "closedate", "sales_user"]);

export interface ClearDealReq { ok: boolean; hubspotDealId?: string; fields?: string[]; error?: string }
export function parseClearDealBody(body: any): ClearDealReq {
  const hubspotDealId = body?.hubspotDealId;
  if (!numeric(hubspotDealId)) return { ok: false, error: "hubspotDealId must be a numeric string" };
  const fields = body?.fields;
  if (!Array.isArray(fields) || fields.length === 0)
    return { ok: false, error: "fields must be a non-empty array" };
  const bad = fields.filter(f => typeof f !== "string" || !CLEARABLE_DEAL_PROPS.has(f));
  if (bad.length) return { ok: false, error: `not clearable: ${bad.map(String).join(",")}` };
  return { ok: true, hubspotDealId, fields: [...new Set(fields as string[])] };
}

export interface SyncDealReq { ok: boolean; itemId?: string; error?: string }
export function parseSyncDealBody(body: any): SyncDealReq {
  const itemId = body?.itemId;
  if (!numeric(itemId)) return { ok: false, error: "itemId must be a numeric string" };
  return { ok: true, itemId };
}

export interface CreateLineItemReq {
  ok: boolean; itemId?: string; subitemId?: string; saveToLibrary?: boolean;
  properties?: Record<string, string>; error?: string;
}
export function parseCreateLineItemBody(body: any): CreateLineItemReq {
  const itemId = body?.itemId, subitemId = body?.subitemId;
  if (!numeric(itemId)) return { ok: false, error: "itemId must be a numeric string" };
  if (!numeric(subitemId)) return { ok: false, error: "subitemId must be a numeric string" };
  const properties = pickWritableLineItemProps(body?.properties ?? {});
  if (!properties.name && !properties.hs_product_id)
    return { ok: false, error: "a line item needs a name or a product id" };
  return { ok: true, itemId, subitemId, saveToLibrary: body?.saveToLibrary === true, properties };
}

// The client generates the key once with crypto.randomUUID() and reuses it across retries. Validate the
// shape (any UUID variant) so a short/garbage/accidentally-shared key can't be used as an idempotency id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isKey = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface CreateContactReq {
  ok: boolean; idempotencyKey?: string; properties?: Record<string, string>;
  associateCompanyHubspotId?: string; error?: string;
}
export function parseContactBody(body: any): CreateContactReq {
  if (!isKey(body?.idempotencyKey)) return { ok: false, error: "idempotencyKey must be a UUID" };
  const properties = pickWritableContactProps(body?.properties ?? {});
  if (!properties.firstname) return { ok: false, error: "a contact needs a name (firstname)" };
  const assoc = body?.associateCompanyHubspotId;
  if (assoc !== undefined && !numeric(assoc)) return { ok: false, error: "associateCompanyHubspotId must be numeric" };
  return { ok: true, idempotencyKey: body.idempotencyKey, properties, associateCompanyHubspotId: assoc };
}

export interface CreateCompanyReq {
  ok: boolean; idempotencyKey?: string; properties?: Record<string, string>;
  associateContactHubspotIds?: string[]; error?: string;
}
export function parseCompanyBody(body: any): CreateCompanyReq {
  if (!isKey(body?.idempotencyKey)) return { ok: false, error: "idempotencyKey must be a UUID" };
  const properties = pickWritableCompanyProps(body?.properties ?? {});
  if (!properties.name && !properties.domain) return { ok: false, error: "a company needs a name or domain" };
  const ids = body?.associateContactHubspotIds;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.some((x: unknown) => !numeric(x)))
      return { ok: false, error: "associateContactHubspotIds must be numeric strings" };
  }
  return { ok: true, idempotencyKey: body.idempotencyKey, properties, associateContactHubspotIds: ids ?? [] };
}
