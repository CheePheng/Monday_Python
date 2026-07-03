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
  const res = await hs(env, "POST", `/crm/v3/objects/${spec.object}`, { properties });
  console.log(`hubspot CREATE ${spec.object} -> ${res.id}`);
  return { id: String(res.id), modified: res.properties?.[spec.modifiedProp] ?? "" };
}

/** Find a HubSpot contact by exact email (for adopt-if-exists). Null if none. */
export async function searchContactByEmail(env: Env, email: string):
    Promise<{ id: string; modified: string } | null> {
  const body = {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
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

export async function getPropertyOptions(env: Env, object: string, prop: string):
    Promise<Record<string, string>> {
  const res = await hs(env, "GET", `/crm/v3/properties/${object}/${prop}`);
  const out: Record<string, string> = {};
  for (const o of res.options ?? []) out[String(o.value)] = String(o.label);
  return out;
}
