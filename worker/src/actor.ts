import type { Ctx } from "./types";

// NOTE: an Unassigned record has no `sales_user`, and BOTH board specs filter on `sales_user HAS_PROPERTY`
// (config.ts) — so it sits outside the inbound HubSpot->monday sync until someone assigns a Sales User.
// The message says so explicitly rather than leaving the rep to discover a card that never updates.
export const OWNER_UNASSIGNED_MESSAGE =
  "No HubSpot owner mapping was found. Record created as Unassigned — assign a Sales User to turn on two-way sync for it.";

export type ActorOwner = { hubspotOwnerId: string } | { unassigned: true };

/** Map the acting rep's email to their HubSpot owner id. No match / no email -> Unassigned (never Myla).
 * The caller writes {sales_user, hubspot_owner_id} = hubspotOwnerId onto the created HubSpot record;
 * buildColumnValues then derives the monday people columns. */
export function resolveActor(ctx: Ctx, email: string | undefined): ActorOwner {
  const key = (email ?? "").trim().toLowerCase();
  const owner = key ? ctx.ownerIdByEmail[key] : undefined;
  return owner ? { hubspotOwnerId: owner } : { unassigned: true };
}
