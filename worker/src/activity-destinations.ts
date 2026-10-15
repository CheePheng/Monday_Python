/**
 * WHERE A HUBSPOT ACTIVITY BELONGS IN MONDAY — the destination model.
 *
 * Until now the answer was always "the associated Contact's card". That was right while monday was a
 * mirror, and it is wrong now that monday is becoming the CRM the sales team actually works in: a
 * salesperson looking at an Account or a Deal has to see the conversation that happened on it without
 * opening a HubSpot seat. HubSpot associates an activity with every CRM object it touched, so one
 * email can legitimately belong on a Contact, a Company and a Deal at once, and it should appear once
 * on each.
 *
 * EXPLICIT ASSOCIATIONS ONLY. A Company is never inferred by walking from the Contact to its company:
 * if HubSpot did not link the activity to that Company, nothing here invents the link. The
 * association is the record of what actually happened; anything else is a guess dressed up as history.
 */
import type { Env } from "./types";
import { hs } from "./hubspot";
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_DEALS } from "./config/crm";

export type DestKind = "contact" | "company" | "deal";

/** The three boards an activity can land on, and the column each keys its HubSpot id by. */
export const DEST_BOARD: Record<DestKind, { boardId: string; idCol: string; assoc: string }> = {
  contact: { boardId: CRM_CONTACTS.boardId, idCol: CRM_CONTACTS.idCol, assoc: "contacts" },
  company: { boardId: CRM_ACCOUNTS.boardId, idCol: CRM_ACCOUNTS.idCol, assoc: "companies" },
  deal:    { boardId: CRM_DEALS.boardId,    idCol: CRM_DEALS.idCol,    assoc: "deals" },
};

export const DEST_KINDS: DestKind[] = ["contact", "company", "deal"];

export interface Destination { kind: DestKind; hubspotId: string }

/** How many association pages to walk before treating the count as pathological. */
export const MAX_ASSOC_PAGES = 10;

/**
 * Every CRM object an activity is associated with, per kind, paginated to exhaustion and deduplicated.
 *
 * `complete` is the load-bearing half of the return. Running out of pages with more still offered
 * produces a set that looks perfectly ordinary — a shorter list, with nothing marking it short — so
 * the caller must be able to tell "this is everyone" from "this is the first thousand". Acting on the
 * second would write a confidently incomplete history.
 */
export async function associatedDestinations(env: Env, object: string, hubspotId: string):
    Promise<{ destinations: Destination[]; complete: boolean }> {
  const destinations: Destination[] = [];
  let complete = true;

  for (const kind of DEST_KINDS) {
    const seen = new Set<string>();
    let after = "";
    let exhausted = false;
    for (let page = 0; page < MAX_ASSOC_PAGES; page++) {
      const r = await hs(env, "GET",
        `/crm/v4/objects/${object}/${hubspotId}/associations/${DEST_BOARD[kind].assoc}`
        + `?limit=100${after ? `&after=${after}` : ""}`, undefined, 2);
      for (const a of r?.results ?? []) if (a?.toObjectId != null) seen.add(String(a.toObjectId));
      after = r?.paging?.next?.after ?? "";
      if (!after) { exhausted = true; break; }
    }
    if (!exhausted) complete = false;
    for (const id of seen) destinations.push({ kind, hubspotId: id });
  }
  return { destinations, complete };
}
