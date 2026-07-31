import type { Env, HsRecord, ObjectSpec, RunOpts } from "./types";
import { LINE_ITEM_WRITE_PROPS } from "./line-item-props";
import { normalizeDomain } from "./normalize";

const BASE = "https://api.hubapi.com";

async function hs(env: Env, method: string, path: string, body?: unknown, retries = 3): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt >= retries) throw e;                 // network error: retry
      await new Promise(res => setTimeout(res, 1500 * attempt));
      continue;
    }
    // 429 (rate limit) and 5xx (transient server error) did not durably apply for our safe/idempotent
    // calls -> back off and retry. Bounded by `retries`: creates pass retries=1, so a POST is never
    // retried and can't double-apply; searches/GET/PATCH (retries=3) ride out a blip.
    if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
      await new Promise(res => setTimeout(res, 2000 * attempt));
      continue;
    }
    if (!resp.ok) {                                    // other 4xx (and exhausted 5xx): throw now
      throw new Error(`hubspot ${method} ${path}: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    }
    if (resp.status === 204) return undefined;          // no-content (e.g. DELETE) -> nothing to parse
    const text = await resp.text();
    return text ? JSON.parse(text) : undefined;         // tolerate any other empty-body success
  }
}

function propertiesFor(spec: ObjectSpec): string[] {
  const props = new Set<string>([...spec.nameProps, spec.modifiedProp]);
  for (const f of spec.fields) props.add(f.hs);
  if ("prop" in spec.groupBy) props.add(spec.groupBy.prop);
  return [...props];
}

export async function searchAll(env: Env, spec: ObjectSpec): Promise<HsRecord[]> {
  const results: HsRecord[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: spec.searchFilters }],
      sorts: [{ propertyName: spec.modifiedProp, direction: "DESCENDING" }],
      properties: propertiesFor(spec),
      limit: 100,
      ...(after ? { after } : {}),
    };
    const page = await hs(env, "POST", `/crm/v3/objects/${spec.object}/search`, body);
    results.push(...(page.results ?? []));
    after = page.paging?.next?.after;
  } while (after);
  return results;
}

/** Plain list pagination (NOT search) — the only way past search's 10,000-result ceiling. Used by the
 * one-time all-companies import to walk every record. */
export async function listPage(env: Env, object: string, after: string | undefined, properties: string[], limit = 100):
    Promise<{ records: HsRecord[]; next?: string }> {
  const qs = new URLSearchParams({ limit: String(limit), archived: "false", properties: properties.join(",") });
  if (after) qs.set("after", after);
  const page = await hs(env, "GET", `/crm/v3/objects/${object}?${qs.toString()}`);
  return {
    records: (page.results ?? []).map((r: any) => ({ id: String(r.id), properties: r.properties ?? {} })),
    next: page.paging?.next?.after,
  };
}

export function propertiesForSpec(spec: ObjectSpec): string[] {
  return propertiesFor(spec);
}

/** Fetch one HubSpot record by id (webhook fast path). Null if not found / archived. */
export async function getRecord(env: Env, object: string, id: string, properties: string[]):
    Promise<HsRecord | null> {
  try {
    const res = await hs(env, "GET",
      `/crm/v3/objects/${object}/${id}?properties=${encodeURIComponent(properties.join(","))}`,
      undefined, 1);
    return { id: String(res.id), properties: res.properties ?? {} };
  } catch (e) {
    if (/: 404 /.test(String(e))) return null; // deleted/archived
    throw e;
  }
}

/** Ids of records associated to `id` (HubSpot v4 associations). e.g. deal -> companies/contacts/line_items. */
export async function getAssociatedIds(env: Env, fromObject: string, id: string, toObject: string): Promise<string[]> {
  const res = await hs(env, "GET", `/crm/v4/objects/${fromObject}/${id}/associations/${toObject}?limit=100`, undefined, 3);
  return (res.results ?? []).map((r: any) => String(r.toObjectId)).filter((x: string) => /^\d+$/.test(x));
}

/** Create a DEFAULT association (idempotent PUT) between two records — used to reverse a monday
 * Connect-Boards link into a HubSpot association. Additive: callers never delete. */
export async function putAssociation(env: Env, fromObject: string, fromId: string,
    toObject: string, toId: string, opts: RunOpts): Promise<void> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot ASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
    return;
  }
  await hs(env, "PUT", `/crm/v4/objects/${fromObject}/${fromId}/associations/default/${toObject}/${toId}`, undefined, 3);
  console.log(`hubspot ASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
}

/** Remove a DEFAULT association between two records (reverse of putAssociation). Idempotent; 404 -> gone. */
export async function deleteAssociation(env: Env, fromObject: string, fromId: string,
    toObject: string, toId: string, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot UNASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
    return false;
  }
  try {
    await hs(env, "DELETE",
      `/crm/v4/objects/${fromObject}/${fromId}/associations/${toObject}/${toId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot UNASSOC ${fromObject}/${fromId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot UNASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
  return true;
}

/** Create a line item and associate it to a deal (line_item->deal default type = 20). Returns the new
 * id. Requires crm.objects.line_items.write — throws 403 until the private app's scope is added. */
export async function createLineItem(env: Env, properties: Record<string, string>, dealId: string,
    opts: RunOpts): Promise<string | null> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CREATE line_item on deal ${dealId}: ${JSON.stringify(properties)}`);
    return null;
  }
  const res = await hs(env, "POST", "/crm/v3/objects/line_items", {
    properties,
    associations: [{ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] }],
  }, 1);
  console.log(`hubspot CREATE line_item -> ${res.id} on deal ${dealId}`);
  return res.id ? String(res.id) : null;
}

/** Create a HubSpot product (for "Save line item to the product library"). Returns the new product id. */
export async function createProduct(env: Env, properties: Record<string, string>, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun || !opts.writeHubspot) { console.log(`DRY hubspot CREATE product: ${JSON.stringify(properties)}`); return null; }
  const res = await hs(env, "POST", "/crm/v3/objects/products", { properties }, 1);
  console.log(`hubspot CREATE product -> ${res.id}`);
  return res.id ? String(res.id) : null;
}

/** For the manual line-item form: label + options for each enum line_item prop, read live from the
 * property schema so new portal options appear without a redeploy. */
export async function getWritablePropOptions(env: Env, object: string, names: string[]):
    Promise<Record<string, { label: string; options: { value: string; label: string }[] }>> {
  const res = await hs(env, "GET", `/crm/v3/properties/${object}`, undefined, 2);
  const byName: Record<string, any> = {};
  for (const p of (res.results ?? [])) byName[p.name] = p;
  const out: Record<string, { label: string; options: { value: string; label: string }[] }> = {};
  for (const n of names) {
    const p = byName[n];
    if (p) out[n] = { label: p.label ?? n, options: (p.options ?? []).map((o: any) => ({ value: String(o.value), label: o.label })) };
  }
  return out;
}

/** Update an existing HubSpot line item by id (qty/price/etc.). retries=3 (PATCH is idempotent). */
export async function patchLineItem(env: Env, lineItemId: string,
    properties: Record<string, string>, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot PATCH line_item ${lineItemId}: ${JSON.stringify(properties)}`);
    return false;
  }
  await hs(env, "PATCH", `/crm/v3/objects/line_items/${lineItemId}`, { properties }, 3);
  console.log(`hubspot PATCH line_item ${lineItemId}: ${Object.keys(properties).join(",")}`);
  return true;
}

/** Delete a HubSpot line item by id (archive). retries=3 (DELETE is idempotent). 404 -> already gone. */
export async function deleteLineItem(env: Env, lineItemId: string, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot DELETE line_item ${lineItemId}`);
    return false;
  }
  try {
    await hs(env, "DELETE", `/crm/v3/objects/line_items/${lineItemId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot DELETE line_item ${lineItemId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot DELETE line_item ${lineItemId}`);
  return true;
}

/** Archive (soft-delete) a HubSpot deal by id. Idempotent; 404 -> already gone. */
export async function archiveDeal(env: Env, dealId: string, opts: RunOpts): Promise<boolean> {
  if (opts.dryRun || !opts.writeHubspot) { console.log(`DRY hubspot ARCHIVE deal ${dealId}`); return false; }
  try {
    await hs(env, "DELETE", `/crm/v3/objects/deals/${dealId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot ARCHIVE deal ${dealId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot ARCHIVE deal ${dealId}`);
  return true;
}

// --- live search for the vibe app picker (/app/search) ---
const SEARCH_PROPS: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email"],
  companies: ["name", "domain"],
  products: ["name", "price", "hs_sku", "description"],
};

export interface SearchHit { id: string; name: string; secondary: string; sku?: string; price?: string; description?: string }

/** HubSpot result -> a compact hit for the picker. Pure (unit-testable). */
export function mapSearchResult(type: string, p: Record<string, any>): Omit<SearchHit, "id"> {
  if (type === "contacts") {
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
    return { name: name || p.email || "(no name)", secondary: p.email ?? "" };
  }
  if (type === "companies") return { name: p.name || "(no name)", secondary: p.domain ?? "" };
  // products
  const price = p.price != null ? String(p.price) : "";
  return { name: p.name || "(no name)", secondary: price, sku: p.hs_sku ?? "", price, description: p.description ?? "" };
}

/** Full-text search one HubSpot object type; returns up to `limit` (<=20) hits plus the match total. */
export async function searchObjects(env: Env, type: string, q: string, limit: number):
    Promise<{ results: SearchHit[]; total: number }> {
  const res = await hs(env, "POST", `/crm/v3/objects/${type}/search`,
    { query: q, properties: SEARCH_PROPS[type] ?? ["name"], limit: Math.min(Math.max(limit, 1), 20) }, 2);
  const results = (res.results ?? []).map((r: any) => ({ id: String(r.id), ...mapSearchResult(type, r.properties ?? {}) }));
  return { results, total: Number(res.total ?? results.length) };
}

// --- /app/companies directory (live HubSpot company list + search) ---
export const COMPANY_LIST_PROPS = [
  "name", "domain", "industry", "type", "partner_with", "city", "state",
  "numberofemployees", "annualrevenue", "linkedin_company_page", "description",
  "createdate", "hubspot_owner_id", "sales_user",
];

export interface CompanyHit {
  hubspotId: string; name: string; domain: string; industry: string; type: string;
  partnerWith: string; city: string; state: string; employees: string; revenue: string;
  linkedin: string; description: string; createdate: string; ownerName: string; salesUser: string;
}

/** Build the HubSpot company search body. Pure/testable. Newest-created first; a query does full-text
 * (name+domain); an empty query uses a createdate HAS_PROPERTY filter (every company has one) so the
 * search is always valid rather than relying on a fully-empty body. */
export function companySearchBody(args: { q?: string; after?: string; limit?: number }): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: COMPANY_LIST_PROPS,
    limit,
  };
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  else body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** Map one HubSpot company result's properties to a CompanyHit (minus id). Pure/testable. `labels` is
 * ctx.labels; the enum fields (industry/type/partner_with/sales_user) resolve to display labels, falling
 * back to the raw value if unmapped. */
export function mapCompanyResult(
  p: Record<string, any>,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Omit<CompanyHit, "hubspotId"> {
  const lab = (dict: string, v: string) => (v ? (labels?.[dict]?.[v] ?? v) : "");
  return {
    name: p.name ?? "", domain: p.domain ?? "",
    industry: lab("industry", p.industry ?? ""),
    type: lab("companyType", p.type ?? ""),
    partnerWith: lab("partnerWith", p.partner_with ?? ""),
    city: p.city ?? "", state: p.state ?? "",
    employees: p.numberofemployees ?? "", revenue: p.annualrevenue ?? "",
    linkedin: p.linkedin_company_page ?? "", description: p.description ?? "",
    createdate: p.createdate ?? "",
    ownerName: p.hubspot_owner_id ? (ownersById[p.hubspot_owner_id]?.name ?? "") : "",
    salesUser: lab("salesUser", p.sales_user ?? ""),
  };
}

// note -> object default association type ids (HUBSPOT_DEFINED).
const NOTE_ASSOC: Record<string, number> = { deals: 214, contacts: 202, companies: 190 };

/** Create a HubSpot note associated to a deal/contact/company — a monday Update mirrored to Activities. */
export async function createNote(env: Env, body: string, tsMs: number, ownerId: string | undefined,
    objectType: string, objectId: string, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CREATE note on ${objectType}/${objectId}: ${body.slice(0, 80)}`);
    return null;
  }
  const props: Record<string, string> = { hs_note_body: body, hs_timestamp: String(tsMs) };
  if (ownerId) props["hubspot_owner_id"] = ownerId;
  const res = await hs(env, "POST", "/crm/v3/objects/notes", {
    properties: props,
    associations: [{ to: { id: objectId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_ASSOC[objectType] ?? 214 }] }],
  }, 1);
  console.log(`hubspot CREATE note -> ${res.id} on ${objectType}/${objectId}`);
  return res.id ? String(res.id) : null;
}

/** Batch-read records by id (names for association columns, or line-item fields). Empty ids -> []. */
export async function getRecordsByIds(env: Env, object: string, ids: string[], properties: string[]): Promise<HsRecord[]> {
  if (!ids.length) return [];
  const res = await hs(env, "POST", `/crm/v3/objects/${object}/batch/read`,
    { properties, inputs: ids.map(id => ({ id })) });
  return (res.results ?? []).map((r: any) => ({ id: String(r.id), properties: r.properties ?? {} }));
}

/** Fetch a deal's CURRENT HubSpot line items, mapped to the app editor's row shape (core fields + a full
 * `props` bag of the writable extended fields for re-editing). Read-only. */
export async function getDealLineItems(env: Env, dealId: string):
    Promise<{ lineItemId: string; productId?: string; name: string; unitPrice: string; quantity: string;
      currency?: string; description?: string; discount?: string; discountPct?: string;
      discountMode: "amount" | "percent"; serviceDate?: string; props: Record<string, string> }[]> {
  const ids = await getAssociatedIds(env, "deals", dealId, "line_items");
  if (!ids.length) return [];
  const recs = await getRecordsByIds(env, "line_items", ids, [...LINE_ITEM_WRITE_PROPS]);
  return recs.map(r => {
    const p = r.properties as Record<string, string>;
    const props: Record<string, string> = {};
    for (const k of LINE_ITEM_WRITE_PROPS) if (p[k] != null && p[k] !== "") props[k] = String(p[k]);
    return {
      lineItemId: String(r.id), productId: p.hs_product_id || undefined,
      name: p.name ?? "", unitPrice: p.price ?? "", quantity: p.quantity ?? "1",
      currency: p.hs_line_item_currency_code || undefined, description: p.description || undefined,
      discount: p.discount || undefined, discountPct: p.hs_discount_percentage || undefined,
      discountMode: p.hs_discount_percentage ? "percent" : "amount",
      serviceDate: p.service_date || undefined, props,
    };
  });
}

/** Ids of records matching a spec that changed at/after `sinceMs`. Paginates (up to `maxPages` pages of
 * 100) so a bulk import that changes many records in one window is fully swept by the 10-min backup, not
 * capped at the first 100. The write BUDGET still throttles how many are pushed per tick. */
export async function searchModifiedIds(env: Env, spec: ObjectSpec, sinceMs: number, maxPages = 20): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    // OR'd scope groups, each AND'd with the modified-date filter (HubSpot: groups OR, filters-in-group AND).
    const mod = { propertyName: spec.modifiedProp, operator: "GTE" as const, value: sinceMs };
    const groups: Record<string, unknown>[][] = spec.includeAll
      ? [[mod]]
      : [[...spec.searchFilters, mod],
         ...(spec.scopeAlsoLinkedProp
           ? [[{ propertyName: spec.scopeAlsoLinkedProp, operator: "HAS_PROPERTY" as const }, mod]] : [])];
    const body: Record<string, unknown> = {
      filterGroups: groups.map(filters => ({ filters })),
      sorts: [{ propertyName: spec.modifiedProp, direction: "DESCENDING" }],
      properties: ["hs_object_id"], limit: 100,
      ...(after ? { after } : {}),
    };
    const page = await hs(env, "POST", `/crm/v3/objects/${spec.object}/search`, body);
    for (const r of page.results ?? []) ids.push(String(r.id));
    after = page.paging?.next?.after;
  } while (after && ++pages < maxPages);
  return ids;
}

/** PATCH existing record (update-only). Returns the record's new modified timestamp (for Sync
 * State), or null when not actually written (dry / reverse writes disabled). */
export async function patchRecord(env: Env, spec: ObjectSpec, id: string,
    properties: Record<string, string>, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot PATCH ${spec.object}/${id}: ${JSON.stringify(properties)}`);
    return null;
  }
  const res = await hs(env, "PATCH", `/crm/v3/objects/${spec.object}/${id}`, { properties });
  console.log(`hubspot PATCH ${spec.object}/${id}: ${Object.keys(properties).join(",")}`);
  return res.properties?.[spec.modifiedProp] ?? null;
}

/** CREATE a new record from a monday card. Returns {id, modified}, or null when not written. */
export async function createRecord(env: Env, spec: ObjectSpec, properties: Record<string, string>,
    opts: RunOpts): Promise<{ id: string; modified: string } | null> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CREATE ${spec.object}: ${JSON.stringify(properties)}`);
    return null;
  }
  // retries=1: a CREATE is not idempotent — a network retry after HubSpot already processed the POST
  // would make a duplicate record. (A 429 means it was NOT processed, but with retries=1 we simply
  // surface it and let the card re-create next tick, which is safe.)
  const res = await hs(env, "POST", `/crm/v3/objects/${spec.object}`, { properties }, 1);
  console.log(`hubspot CREATE ${spec.object} -> ${res.id}`);
  return { id: String(res.id), modified: res.properties?.[spec.modifiedProp] ?? "" };
}

/** Find a HubSpot contact by exact email (for adopt-if-exists). Null if none. */
export async function searchContactByEmail(env: Env, email: string):
    Promise<{ id: string; modified: string } | null> {
  const body = {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email.trim().toLowerCase() }] }],
    properties: ["lastmodifieddate"], limit: 1,
  };
  const res = await hs(env, "POST", "/crm/v3/objects/contacts/search", body);
  const hit = res.results?.[0];
  return hit ? { id: String(hit.id), modified: hit.properties?.lastmodifieddate ?? "" } : null;
}

/** Find a HubSpot company by exact normalized domain (for reuse-if-exists). Null if none/blank. */
export async function searchCompanyByDomain(env: Env, domain: string):
    Promise<{ id: string; modified: string } | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const body = {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: d }] }],
    properties: ["hs_lastmodifieddate"], limit: 1,
  };
  const res = await hs(env, "POST", "/crm/v3/objects/companies/search", body);
  const hit = res.results?.[0];
  return hit ? { id: String(hit.id), modified: hit.properties?.hs_lastmodifieddate ?? "" } : null;
}

export async function getOwners(env: Env): Promise<Record<string, { name: string; email: string | null }>> {
  const out: Record<string, { name: string; email: string | null }> = {};
  let after: string | undefined;
  do {
    const path = `/crm/v3/owners/?limit=100${after ? `&after=${after}` : ""}`;
    const res = await hs(env, "GET", path);
    for (const o of res.results ?? [])
      out[String(o.id)] = { name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim(), email: o.email ?? null };
    after = res.paging?.next?.after;
  } while (after);
  return out;
}

/** Deal stage id -> label from the pipelines API. The `dealstage` PROPERTY has no options
 * (stages live on the pipeline), so this is the correct source for stage display labels. */
export async function getDealStageLabels(env: Env, pipelineId = "default"): Promise<Record<string, string>> {
  const res = await hs(env, "GET", "/crm/v3/pipelines/deals");
  const pipe = (res.results ?? []).find((p: any) => p.id === pipelineId);
  const out: Record<string, string> = {};
  for (const s of pipe?.stages ?? []) out[String(s.id)] = String(s.label);
  return out;
}

export async function getPropertyOptions(env: Env, object: string, prop: string):
    Promise<Record<string, string>> {
  const res = await hs(env, "GET", `/crm/v3/properties/${object}/${prop}`);
  const out: Record<string, string> = {};
  for (const o of res.options ?? []) out[String(o.value)] = String(o.label);
  return out;
}
