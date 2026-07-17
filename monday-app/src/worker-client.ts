import { WORKER_BASE } from "./board-config";

async function call(token: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(WORKER_BASE + path, {
    method, signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`worker ${method} ${path}: ${res.status}`);
  return res.json();
}

export interface Hit { id: string; name: string; secondary: string }
export async function searchHubspot(token: string, type: "contacts" | "companies" | "products", q: string, signal?: AbortSignal): Promise<Hit[]> {
  const res = await call(token, "GET", `/app/search?type=${type}&q=${encodeURIComponent(q)}&limit=10`, undefined, signal);
  return res.results ?? [];
}
export async function updateHubspotLineItem(token: string, lineItemId: string, properties: Record<string, string>): Promise<void> {
  await call(token, "POST", "/app/line-item", { lineItemId, properties });
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
