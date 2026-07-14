import { WORKER_BASE } from "./board-config";

async function call(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(WORKER_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`worker ${method} ${path}: ${res.status}`);
  return res.json();
}

export interface Hit { id: string; name: string; secondary: string }
export async function searchHubspot(token: string, type: "contacts" | "companies" | "products", q: string): Promise<Hit[]> {
  const res = await call(token, "GET", `/app/search?type=${type}&q=${encodeURIComponent(q)}&limit=10`);
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
