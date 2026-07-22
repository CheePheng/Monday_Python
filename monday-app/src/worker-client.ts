import { WORKER_BASE } from "./board-config";

async function call(token: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(WORKER_BASE + path, {
    method, signal, cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`worker ${method} ${path}: ${res.status}`);
  return res.json();
}

export interface Hit { id: string; name: string; secondary: string; sku?: string; price?: string; description?: string }
export interface SearchResult { items: Hit[]; total: number }
export async function searchHubspot(token: string, type: "contacts" | "companies" | "products", q: string, signal?: AbortSignal): Promise<SearchResult> {
  const res = await call(token, "GET", `/app/search?type=${type}&q=${encodeURIComponent(q.trim())}&limit=20`, undefined, signal);
  if (res?.error) throw new Error("search-" + res.error);           // surface HubSpot failure (scope/search-failed)
  return { items: res.results ?? [], total: Number(res.total ?? (res.results?.length ?? 0)) };
}
export async function updateHubspotLineItem(token: string, lineItemId: string, properties: Record<string, string>): Promise<void> {
  await call(token, "POST", "/app/line-item", { lineItemId, properties });
}
export interface EnumProp { label: string; options: { value: string; label: string }[] }
export async function getLineItemSchema(token: string): Promise<Record<string, EnumProp>> {
  const res = await call(token, "GET", "/app/line-item-schema");
  return res?.schema ?? {};
}
/** Create a HubSpot line item from a monday subitem via the Worker (which ensures the deal exists,
 * associates it, optional Save-to-library, and writes the Line Item ID back onto the subitem). */
export async function createHubspotLineItem(token: string, args: {
  itemId: string; subitemId: string; productId?: string; saveToLibrary?: boolean; properties: Record<string, string>;
}): Promise<{ lineItemId?: string; productId?: string }> {
  const res = await call(token, "POST", "/app/line-item", {
    itemId: args.itemId, subitemId: args.subitemId, saveToLibrary: args.saveToLibrary,
    properties: { ...args.properties, ...(args.productId ? { hs_product_id: args.productId } : {}) },
  });
  return { lineItemId: res.lineItemId, productId: res.productId };
}
/** Fetch the deal's current HubSpot line items (fresh from HubSpot), for merging into the editor's rows. */
export async function getDealLineItems(token: string, itemId: string): Promise<import("./views/LineItemsEditor").LineItem[]> {
  const res = await call(token, "GET", `/app/deal-line-items?itemId=${encodeURIComponent(itemId)}`);
  return res?.lineItems ?? [];
}
export async function deleteHubspotLineItem(token: string, lineItemId: string): Promise<void> {
  await call(token, "DELETE", "/app/line-item", { lineItemId });
}
export async function deleteHubspotAssociation(
  token: string, toObject: "contacts" | "companies", fromId: string, toId: string,
): Promise<void> {
  await call(token, "DELETE", "/app/association", { fromObject: "deals", fromId, toObject, toId });
}
export async function archiveHubspotDeal(token: string, hubspotDealId: string): Promise<void> {
  await call(token, "DELETE", "/app/deal", { hubspotDealId });
}
export async function syncDeal(token: string, itemId: string): Promise<boolean> {
  const res = await call(token, "POST", "/app/sync-deal", { itemId });
  return res?.ok === true;
}
/** Blank allowlisted properties on one deal in HubSpot (amount | closedate | sales_user; the Worker
 * enforces the list). Carries the rep's explicit intent, which the sync cannot infer: an empty monday
 * value is indistinguishable from "never set", and for people columns means "heal from HubSpot". */
export async function clearDealFields(token: string, hubspotDealId: string, fields: string[]): Promise<void> {
  await call(token, "POST", "/app/clear-deal-fields", { hubspotDealId, fields });
}

// --- v3.4: standalone Contact/Company creation (Phase A endpoints) ---

/** Mirrors the Worker's CreateResult (worker/src/idempotency.ts). 200 => completed; 502 => failed + partial. */
export interface CreateResult {
  status: "in_progress" | "completed" | "failed";
  failedStep?: "dedup" | "hubspot" | "monday" | "owner" | "associations";
  hubspotId?: string; mondayItemId?: string; existing?: boolean;
  unassigned?: boolean; ownerMessage?: string; hubspotLink?: string;
  steps: { dedup: boolean; hubspot: boolean; monday: boolean; owner: boolean; associations: boolean };
}

/** One key per Create operation, reused across every retry so the Worker's Durable Object resumes. */
export function newIdempotencyKey(): string { return crypto.randomUUID(); }

async function postCreate(token: string, kind: "contact" | "company", body: unknown): Promise<CreateResult> {
  const res = await fetch(WORKER_BASE + `/app/${kind}`, {
    method: "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  // Completed (200) and failed-with-partial (502) both carry a CreateResult; anything else is a hard error.
  if ((res.ok || res.status === 502) && json && typeof json === "object" && "status" in json) return json as CreateResult;
  throw new Error((json && (json as any).error) || `create-${kind} failed (${res.status})`);
}

export function createContact(token: string, args: { idempotencyKey: string; properties: Record<string, string>; associateCompanyHubspotId?: string }): Promise<CreateResult> {
  return postCreate(token, "contact", args);
}
export function createCompany(token: string, args: { idempotencyKey: string; properties: Record<string, string>; associateContactHubspotIds?: string[] }): Promise<CreateResult> {
  return postCreate(token, "company", args);
}
export async function getContactSchema(token: string): Promise<Record<string, EnumProp>> {
  const res = await call(token, "GET", "/app/contact-schema");
  return res?.schema ?? {};
}
export async function getCompanySchema(token: string): Promise<Record<string, EnumProp>> {
  const res = await call(token, "GET", "/app/company-schema");
  return res?.schema ?? {};
}
