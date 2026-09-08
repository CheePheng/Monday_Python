import type { Env, HsRecord, ObjectSpec, RunOpts, WriteAuth } from "./types";
import { LINE_ITEM_WRITE_PROPS } from "./line-item-props";
import { normalizeDomain } from "./normalize";
import { canClaimCrmOwnership, claimPatch } from "./ownership";

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

/** A HubSpot mutation was attempted without, or against, write ownership. Never swallowed. */
export class OwnershipError extends Error {
  constructor(msg: string) { super(msg); this.name = "OwnershipError"; }
}

/**
 * Fail-closed write authorization.
 *
 * A spec that declares `ownership` may not be mutated without an explicit allow — so a forgotten
 * call site becomes a loud error rather than a silent write to a record another sync owns. Placed at
 * the HTTP chokepoint on purpose: a predicate that only callers consult is one missed call away from
 * writing to the wrong place. Specs without `ownership` (every production WM spec) return
 * immediately, so their behaviour is unchanged.
 */
function assertMayWrite(spec: ObjectSpec, id: string, auth: WriteAuth | undefined): void {
  if (!spec.ownership) return;
  if (!auth) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} requires a WriteAuth (spec declares ownership)`);
  // The decision must belong to THIS record. A loop that computes auth once and then patches many
  // records is an ordinary mistake, and without this the guard would wave every one of them through.
  if (auth.forId !== id) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} refused: auth was computed for ${auth.forId}`);
  if (!auth.allowed) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} refused: ${auth.reason}`);
}

function propertiesFor(spec: ObjectSpec): string[] {
  const props = new Set<string>([...spec.nameProps, spec.modifiedProp]);
  for (const f of spec.fields) props.add(f.hs);
  if ("prop" in spec.groupBy) props.add(spec.groupBy.prop);
  // Ownership metadata is INFRASTRUCTURE, not a mapped field: it must be fetched even though no
  // monday column displays it. Omitting it makes authorizeWrite read undefined and classify every
  // record as unstamped, which would hand records to the wrong Worker. Specs without `ownership`
  // (every production WM spec) are unaffected.
  if (spec.ownership) { props.add(spec.ownership.prop); props.add(spec.ownership.createdProp); }
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
/**
 * Link two HubSpot records. Idempotent PUT, so it converges with the forward pass.
 *
 * OWNERSHIP-GUARDED since 2026-09-08, which is what retires the P2-1 blanket refusal in
 * associations.ts. `fromSpec` + `auth` are the same fail-closed contract patchRecord has: for a spec
 * declaring ownership, a call without a matching WriteAuth THROWS rather than writing, and
 * assertMayWrite runs BEFORE the dry-run branch so a refusal can never be mistaken for a skip.
 *
 * THE AUTH IS ON THE INITIATING RECORD ONLY, and that is a deliberate decision rather than an
 * oversight. Requiring write ownership of BOTH ends sounds safer and would in fact kill the feature:
 * 51,024 contacts in this portal are associated to companies created before the cutover, which
 * `canClaimCrmOwnership` can never claim — so a two-ended rule would refuse essentially every
 * association the business actually has. An association is a link, not a field on the far record, so
 * the rule matches a field write: you must own the record whose monday card was edited. The far end
 * only has to exist.
 */
export async function putAssociation(env: Env, fromObject: string, fromId: string,
    toObject: string, toId: string, opts: RunOpts, fromSpec?: ObjectSpec, auth?: WriteAuth): Promise<void> {
  if (fromSpec) assertMayWrite(fromSpec, fromId, auth);
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
  deals: ["dealname"],
};

export interface SearchHit { id: string; name: string; secondary: string; sku?: string; price?: string; description?: string }

/** HubSpot result -> a compact hit for the picker. Pure (unit-testable). */
export function mapSearchResult(type: string, p: Record<string, any>): Omit<SearchHit, "id"> {
  if (type === "contacts") {
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
    return { name: name || p.email || "(no name)", secondary: p.email ?? "" };
  }
  if (type === "companies") return { name: p.name || "(no name)", secondary: p.domain ?? "" };
  if (type === "deals") return { name: p.dealname || "(no name)", secondary: "" };
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

export interface CompanyFilters {
  ownerId?: string;
  created?: { gte?: number; lte?: number };
  activity?: { gte?: number; lte?: number };
}

/** Build the HubSpot company search body. Pure/testable. Newest-created first. Owner/date filters go in a
 * single AND'd filter group; a full-text query (when present) is sent alongside and ANDs with it. */
export function companySearchBody(args: { q?: string; after?: string; limit?: number } & CompanyFilters): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: COMPANY_LIST_PROPS,
    limit,
  };
  const filters: Record<string, unknown>[] = [];
  if (args.ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: args.ownerId });
  if (args.created?.gte != null) filters.push({ propertyName: "createdate", operator: "GTE", value: args.created.gte });
  if (args.created?.lte != null) filters.push({ propertyName: "createdate", operator: "LTE", value: args.created.lte });
  if (args.activity?.gte != null) filters.push({ propertyName: "notes_last_updated", operator: "GTE", value: args.activity.gte });
  if (args.activity?.lte != null) filters.push({ propertyName: "notes_last_updated", operator: "LTE", value: args.activity.lte });
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  if (filters.length) body.filterGroups = [{ filters }];
  else if (!query) body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** HubSpot owners -> sorted [{id,name}] for the Company-owner filter dropdown. Pure/testable.
 *
 *  ARCHIVED OWNERS ARE EXCLUDED HERE, and only here. getOwners now returns them so that a `sales_user`
 *  pointing at a departed rep still RESOLVES TO A NAME for display; but this list is a CHOICE offered
 *  in the app, and a rep must not be able to assign work to someone who has left. Keeping the two
 *  concerns apart is the whole reason getOwners carries the `archived` flag rather than just merging. */
export function mapOwners(ownersById: Record<string, { name: string; email: string | null; archived?: boolean }>): { id: string; name: string }[] {
  return Object.entries(ownersById)
    .filter(([, o]) => o.name?.trim() && !o.archived)
    .map(([id, o]) => ({ id, name: o.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

/** Live company list/search for /app/companies. Returns mapped hits + the next-page cursor (or null). */
export async function listCompanies(
  env: Env,
  args: { q?: string; after?: string; limit?: number } & CompanyFilters,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Promise<{ items: CompanyHit[]; after: string | null }> {
  const res = await hs(env, "POST", "/crm/v3/objects/companies/search", companySearchBody(args), 2);
  const items = (res.results ?? []).map((r: any) => ({
    hubspotId: String(r.id), ...mapCompanyResult(r.properties ?? {}, ownersById, labels),
  }));
  return { items, after: res.paging?.next?.after ?? null };
}

// --- /app/contacts directory (live HubSpot contact list + search) ---
export const CONTACT_LIST_PROPS = [
  "firstname", "lastname", "email", "phone", "jobtitle", "company",
  "hs_lead_status", "leadsource", "createdate", "hubspot_owner_id", "sales_user", "notes_last_updated",
];

export interface ContactHit {
  hubspotId: string; name: string; email: string; phone: string; jobtitle: string; company: string;
  leadStatus: string; leadSource: string; createdate: string; ownerName: string; salesUser: string;
}

/** Build the HubSpot contact search body. Pure/testable. Same shape as companySearchBody. */
export function contactSearchBody(args: { q?: string; after?: string; limit?: number } & CompanyFilters): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: CONTACT_LIST_PROPS,
    limit,
  };
  const filters: Record<string, unknown>[] = [];
  if (args.ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: args.ownerId });
  if (args.created?.gte != null) filters.push({ propertyName: "createdate", operator: "GTE", value: args.created.gte });
  if (args.created?.lte != null) filters.push({ propertyName: "createdate", operator: "LTE", value: args.created.lte });
  if (args.activity?.gte != null) filters.push({ propertyName: "notes_last_updated", operator: "GTE", value: args.activity.gte });
  if (args.activity?.lte != null) filters.push({ propertyName: "notes_last_updated", operator: "LTE", value: args.activity.lte });
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  if (filters.length) body.filterGroups = [{ filters }];
  else if (!query) body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** Map one HubSpot contact result to a ContactHit (minus id). Pure/testable. */
export function mapContactResult(
  p: Record<string, any>,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Omit<ContactHit, "hubspotId"> {
  const lab = (dict: string, v: string) => (v ? (labels?.[dict]?.[v] ?? v) : "");
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? "");
  return {
    name, email: p.email ?? "", phone: p.phone ?? "", jobtitle: p.jobtitle ?? "", company: p.company ?? "",
    leadStatus: lab("leadStatus", p.hs_lead_status ?? ""),
    leadSource: lab("contactSource", p.leadsource ?? ""),
    createdate: p.createdate ?? "",
    ownerName: p.hubspot_owner_id ? (ownersById[p.hubspot_owner_id]?.name ?? "") : "",
    // sales_user holds a raw HubSpot OWNER ID; resolve it through the label dict like mapCompanyResult
    // does, or the directory's Owner column shows a bare id (e.g. "70154321") for owner-less contacts.
    salesUser: lab("salesUser", p.sales_user ?? ""),
  };
}

/** Live contact list/search for /app/contacts. Returns mapped hits + the next-page cursor (or null). */
export async function listContacts(
  env: Env,
  args: { q?: string; after?: string; limit?: number } & CompanyFilters,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Promise<{ items: ContactHit[]; after: string | null }> {
  const res = await hs(env, "POST", "/crm/v3/objects/contacts/search", contactSearchBody(args), 2);
  const items = (res.results ?? []).map((r: any) => ({
    hubspotId: String(r.id), ...mapContactResult(r.properties ?? {}, ownersById, labels),
  }));
  return { items, after: res.paging?.next?.after ?? null };
}

/** Map an associated record for /app/associations. companies -> {hubspotId,name}; contacts also carry
 * email + jobtitle. Pure/testable. */
export function mapAssocRecord(
  to: string, rec: { id: string; properties: Record<string, string | null> },
): { hubspotId: string; name: string; email?: string; title?: string } {
  const p = rec.properties;
  if (to === "companies") return { hubspotId: rec.id, name: (p.name || p.domain || "").trim() };
  if (to === "contacts") {
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? "");
    return { hubspotId: rec.id, name, email: p.email ?? "", title: p.jobtitle ?? "" };
  }
  if (to === "deals") return { hubspotId: rec.id, name: (p.dealname ?? "").trim() };
  return { hubspotId: rec.id, name: "" };
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
    properties: Record<string, string>, opts: RunOpts, auth?: WriteAuth): Promise<string | null> {
  assertMayWrite(spec, id, auth);   // before the dry-run check: a refusal must never look like a skip
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
    opts: RunOpts, auth?: WriteAuth): Promise<{ id: string; modified: string } | null> {
  assertMayWrite(spec, "(new)", auth);
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

/**
 * Claim CRM write ownership of an EXISTING HubSpot record.
 *
 * The only mutation permitted on an unclaimed record, and its payload is exactly one property
 * (claimPatch). Deliberately NOT routed through patchRecord: widening the write guard can never
 * widen this, and widening this can never write a business field. A brand-new record created from
 * monday is a different case — it is born owned via withBirthOwnership() in the create payload.
 */
export async function claimOwnership(env: Env, spec: ObjectSpec, rec: HsRecord,
    opts: RunOpts): Promise<string | null> {
  if (!spec.ownership) throw new OwnershipError(`claimOwnership on ${spec.object}: no ownership spec`);
  // Eligibility is asserted HERE, not left to the caller. authorizeWrite returns allowed:false for
  // two very different reasons — "unstamped: crm must claim" and "owned by wm" — so the natural
  // wiring `if (!auth.allowed) claim()` would stamp crm onto every WM-owned record. This repo has a
  // live incident of exactly that shape (silent owner reassignment on a passive reconcile), and the
  // guard's own principle is that a predicate only callers consult is one missed call from disaster.
  if (!canClaimCrmOwnership(rec, spec.ownership)) throw new OwnershipError(
    `claim refused for ${spec.object}/${rec.id}: not eligible (stamp/cutover)`);
  const properties = claimPatch(spec.ownership);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CLAIM ${spec.object}/${rec.id}: ${JSON.stringify(properties)}`);
    return null;
  }
  const res = await hs(env, "PATCH", `/crm/v3/objects/${spec.object}/${rec.id}`, { properties });
  console.log(`hubspot CLAIM ${spec.object}/${rec.id} -> ${spec.ownership.owner}`);
  return res.properties?.[spec.modifiedProp] ?? null;
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

/**
 * Every HubSpot owner, INCLUDING ARCHIVED ones.
 *
 * `/crm/v3/owners/` returns only ACTIVE owners — 42 in this portal. There are also 50 archived owners
 * (27 with names), and 481 contacts plus 32 companies still carry a `sales_user` pointing at one of
 * those departed reps (measured live 2026-09-08). Without them the `salesUser` dictionary cannot
 * resolve the id, so formatValue's `dict[v] ?? v` writes the RAW OWNER ID to monday — and since every
 * write sets `create_labels_if_missing:true`, monday then creates a dropdown label literally named
 * "275262201". Reassigning those 481 records is not on the table, so the sync has to read history.
 *
 * ACTIVE IS FETCHED SECOND AND THEREFORE WINS. If an archived owner shares an email with an active one,
 * the active record must be the one that ends up in ownerIdByEmail, or a monday people-column edit
 * could reverse onto a deactivated owner.
 *
 * `archived` is carried through so consumers that offer owners as a CHOICE can exclude them — a rep
 * must not be able to ASSIGN a departed colleague. Only display resolution wants the full set.
 */
export async function getOwners(env: Env): Promise<Record<string, { name: string; email: string | null; archived?: boolean }>> {
  const out: Record<string, { name: string; email: string | null; archived?: boolean }> = {};
  for (const archived of [true, false]) {
    let after: string | undefined;
    do {
      const path = `/crm/v3/owners/?limit=100${archived ? "&archived=true" : ""}${after ? `&after=${after}` : ""}`;
      const res = await hs(env, "GET", path);
      for (const o of res.results ?? [])
        out[String(o.id)] = {
          name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim(),
          email: o.email ?? null,
          ...(archived ? { archived: true } : {}),
        };
      after = res.paging?.next?.after;
    } while (after);
  }
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
