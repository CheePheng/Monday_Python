import type { Ctx } from "./types";

export const OWNER_UNASSIGNED_MESSAGE =
  "No HubSpot owner mapping was found. Record created as Unassigned.";

export type ActorOwner = { hubspotOwnerId: string } | { unassigned: true };

/** Map the acting rep's email to their HubSpot owner id. No match / no email -> Unassigned (never Myla).
 * The caller writes {sales_user, hubspot_owner_id} = hubspotOwnerId onto the created HubSpot record;
 * buildColumnValues then derives the monday people columns. */
export function resolveActor(ctx: Ctx, email: string | undefined): ActorOwner {
  const key = (email ?? "").trim().toLowerCase();
  const owner = key ? ctx.ownerIdByEmail[key] : undefined;
  return owner ? { hubspotOwnerId: owner } : { unassigned: true };
}
