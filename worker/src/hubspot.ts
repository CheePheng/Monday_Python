import type { Env, HsRecord, ObjectSpec, RunOpts } from "./types";

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
    if (resp.status === 429 && attempt < retries) {    // rate limited: back off + retry
      await new Promise(res => setTimeout(res, 2000 * attempt));
      continue;
    }
    if (!resp.ok) {                                    // 4xx/5xx: permanent — throw now, no retry
      throw new Error(`hubspot ${method} ${path}: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    }
    return resp.json();
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

/** Ids of records matching a spec that changed at/after `sinceMs` (one page; the full cron backup
 * catches any overflow). Cheap — used by the 1-minute incremental poll. */
export async function searchModifiedIds(env: Env, spec: ObjectSpec, sinceMs: number): Promise<string[]> {
  const body = {
    filterGroups: [{ filters: [...spec.searchFilters,
      { propertyName: spec.modifiedProp, operator: "GTE", value: sinceMs }] }],
    sorts: [{ propertyName: spec.modifiedProp, direction: "DESCENDING" }],
    properties: ["hs_object_id"], limit: 100,
  };
  const page = await hs(env, "POST", `/crm/v3/objects/${spec.object}/search`, body);
  return (page.results ?? []).map((r: any) => String(r.id));
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
