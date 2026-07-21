import type { Ctx, Env, HsRecord, ObjectSpec, RunOpts } from "./types";
import { CONTACTS_MYLA, COMPANIES_MYLA } from "./config";
import { createRecord, searchContactByEmail, searchCompanyByDomain, putAssociation } from "./hubspot";
import { getUserById, findItemByColumn, createItem } from "./monday";
import { buildColumnValues, itemName } from "./mapping";
import { targetGroup } from "./routing";
import { resolveActor, OWNER_UNASSIGNED_MESSAGE } from "./actor";
import { normalizeDomain } from "./normalize";
import type { CreateResult } from "./idempotency";

export interface CreateInput {
  properties: Record<string, string>;
  sessionUserId?: string;                 // acting rep (undefined for trigger-secret auth -> Unassigned)
  dedup: { kind: "email"; value: string } | { kind: "domain"; value: string } | { kind: "none" };
  associateContacts?: string[];           // company create: contact HubSpot ids to associate
  associateCompany?: string;              // contact create: one company HubSpot id to associate
}

function hubspotLink(spec: ObjectSpec, ctx: Ctx, id: string): string {
  return `https://app.hubspot.com/contacts/${ctx.portalId}/record/${spec.objectTypeId}/${id}`;
}

/** Find (by HubSpot id) or create the monday card for a just-created/reused record, stamping the id in
 * the initial create mutation via buildColumnValues so the reverse-sync never re-creates it in HubSpot. */
async function findOrCreateCard(env: Env, spec: ObjectSpec, ctx: Ctx, rec: HsRecord, opts: RunOpts): Promise<string | null> {
  const existing = (await findItemByColumn(env, spec.boardId, spec.idCol, rec.id))[0];
  if (existing) return existing.id;
  const group = targetGroup(rec, spec);          // contacts -> New/topics, companies -> single group (never null)
  if (!group) return null;
  const cv = buildColumnValues(rec, spec, ctx);  // includes idCol + link + derived people columns
  cv[spec.syncStateCol] = rec.properties[spec.modifiedProp] ?? "";
  return createItem(env, spec.boardId, group, itemName(rec, spec), cv, opts);
}

/** Search-or-create a Contact/Company. Resumable: skips steps already recorded in `prior`. Never throws
 * (returns {result, error?}) so the caller can persist the partial for a resumed retry. The app builds
 * the "Open in monday" link from mondayItemId via the SDK, so no monday URL is fabricated here. */
export async function createContactOrCompany(
  env: Env, object: "contacts" | "companies", ctx: Ctx, input: CreateInput, prior: CreateResult, opts: RunOpts,
): Promise<{ result: CreateResult; error?: string }> {
  const spec = object === "contacts" ? CONTACTS_MYLA : COMPANIES_MYLA;
  const result: CreateResult = { ...prior, steps: { ...prior.steps }, status: "in_progress", failedStep: undefined };
  let step: NonNullable<CreateResult["failedStep"]> = "owner"; // the stage in flight -> failedStep on throw
  // Store the CANONICAL domain (what searchCompanyByDomain searches for) so a later dedup can find this
  // company — otherwise a raw "WWW.Acme.com/" would never match a normalized "acme.com" search -> a dup.
  const properties = object === "companies" && input.properties.domain
    ? { ...input.properties, domain: normalizeDomain(input.properties.domain) }
    : input.properties;
  try {
    // Resolve owner once (deterministic; safe to recompute on a resumed call). No acting user (trigger-
    // secret auth) or no owner match -> Unassigned (never Myla). Owner is applied ONLY to records we
    // create, never to a deduped existing record.
    const email = input.sessionUserId ? (await getUserById(env, input.sessionUserId))?.email : undefined;
    const owner = resolveActor(ctx, email);
    const ownerProps: Record<string, string> = "hubspotOwnerId" in owner
      ? { sales_user: owner.hubspotOwnerId, hubspot_owner_id: owner.hubspotOwnerId } : {};

    // 1) dedup + 2) create-or-reuse in HubSpot (skip entirely if a prior attempt already resolved an id)
    if (!result.hubspotId) {
      step = "dedup";
      const found = input.dedup.kind === "email" ? await searchContactByEmail(env, input.dedup.value)
                  : input.dedup.kind === "domain" ? await searchCompanyByDomain(env, input.dedup.value)
                  : null;
      result.steps.dedup = true;
      if (found) {
        result.hubspotId = found.id; result.existing = true;                 // reuse — do not touch its owner
      } else {
        step = "hubspot";
        const created = await createRecord(env, spec, { ...properties, ...ownerProps }, opts);
        if (!created) return { result };                                     // dry-run: nothing was written
        result.hubspotId = created.id; result.existing = false;
        if ("unassigned" in owner) { result.unassigned = true; result.ownerMessage = OWNER_UNASSIGNED_MESSAGE; }
      }
      result.steps.hubspot = true; result.steps.owner = true;
    }
    result.hubspotLink = hubspotLink(spec, ctx, result.hubspotId);

    // 3) monday card: find-or-create by HubSpot id, stamping the id in the initial create mutation. Seed
    //    it from the props we sent (+ owner for records we created) so people columns render immediately;
    //    the reverse-sync reconciles everything else next tick.
    if (!result.mondayItemId) {
      step = "monday";
      const cardProps = result.existing ? { ...properties } : { ...properties, ...ownerProps };
      const rec: HsRecord = { id: result.hubspotId, properties: { ...cardProps, [spec.modifiedProp]: "" } };
      const itemId = await findOrCreateCard(env, spec, ctx, rec, opts);
      result.steps.monday = true;
      if (itemId) result.mondayItemId = itemId;
    }

    // 4) optional deal-free associations (contact<->company). Additive/idempotent PUT.
    if (!result.steps.associations) {
      step = "associations";
      if (object === "contacts" && input.associateCompany)
        await putAssociation(env, "contacts", result.hubspotId, "companies", input.associateCompany, opts);
      if (object === "companies") for (const cId of input.associateContacts ?? [])
        await putAssociation(env, "companies", result.hubspotId, "contacts", cId, opts);
      result.steps.associations = true;
    }
    result.status = "completed";
    return { result };
  } catch (e) {
    result.status = "failed"; result.failedStep = step;
    return { result, error: String(e).slice(0, 200) };
  }
}
