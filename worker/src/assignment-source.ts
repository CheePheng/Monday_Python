/**
 * DID A CONTACT COME IN THROUGH AN IMPORT? The team's rule of 2026-10-12: a contact that comes in through a HubSpot
 * IMPORT is never announced on monday -- no owner notice (#06, owner-notice.ts), no 02.2 follow-up reminder (#07,
 * follow-up-reminder.ts). That afternoon a 100-contact upload gave Myla 107 contacts in one minute: HubSpot mailed her
 * its own "assigned to you" for each (her HubSpot notification settings, not ours), and #06 mailed her 88 more --
 * one a card, none twice. This stops ours.
 *
 * An assignment counts as the import's when either:
 *   - THE IMPORT MADE IT. HubSpot records the source of every owner change in hubspot_owner_id's history (newest
 *     first). The upload's 107 came two ways:
 *       - sourceType "IMPORT", sourceId the import's id: the import set the owner -- on a contact it created (81) or
 *         on one it matched and updated (18);
 *       - sourceType "COMPANIES", sourceId "OwnerChangeToContactUpdate:triggered by companyId=<id>": HubSpot's
 *         "a contact's owner follows its company's" (8) -- the import's when the company's own owner change was,
 *         read from the company's history;
 *   - or THE CONTACT IS A FRESH UPLOAD: created by an import (`hs_object_source` "IMPORT") within FRESH_IMPORT_MS
 *     before this assignment, whoever assigned it -- three uploaded that morning were bulk-assigned by hand hours
 *     later, and mailed.
 * NOT "the contact was ever imported": 89% of all contacts were (86,034 of 96,430 on 2026-10-12), so that would
 * silence a manager assigning almost any of them by hand -- and it would still have let through the 18 existing
 * contacts the upload reassigned.
 *
 * Which change made the current assignment: the OLDEST of the newest run of versions holding the current owner --
 * a later write of the same owner (a workflow re-setting it) did not assign anything.
 */
import type { Env } from "./types";
import { hs } from "./hubspot";

/** One version of hubspot_owner_id, as `propertiesWithHistory` gives it. */
export interface OwnerVersion { value?: string; timestamp?: string; sourceType?: string; sourceId?: string }

/** What decides it, all read in one GET of the contact (ASSIGNMENT_READ). */
export interface AssignmentFacts {
  owner: string;
  assigned: string;           // hubspot_owner_assigneddate
  created: string;            // createdate
  source: string;             // hs_object_source: what created the contact
  history?: OwnerVersion[];   // hubspot_owner_id's versions, newest first
}

/** The query that reads them: append to a contact GET's path. */
export const ASSIGNMENT_READ = "properties=hubspot_owner_id,hubspot_owner_assigneddate,createdate,hs_object_source"
  + "&propertiesWithHistory=hubspot_owner_id";

/** How long after its import a contact is still a fresh upload. */
export const FRESH_IMPORT_MS = 24 * 60 * 60_000;
/** A company's owner change and the contact owners HubSpot moves with it land within seconds of each other. */
const CASCADE_SLACK_MS = 60_000;

/** epoch ms from HubSpot's ISO string or epoch-ms string; NaN when absent. */
function ms(raw: unknown): number {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : Date.parse(s);
}

/** The facts from a contact GET made with ASSIGNMENT_READ. */
export function assignmentFactsOf(rec: any): AssignmentFacts {
  const p = rec?.properties ?? {};
  return { owner: String(p.hubspot_owner_id ?? "").trim(), assigned: String(p.hubspot_owner_assigneddate ?? "").trim(),
    created: String(p.createdate ?? "").trim(), source: String(p.hs_object_source ?? "").trim(),
    history: rec?.propertiesWithHistory?.hubspot_owner_id };
}

/** The version that set `value` -- the oldest of the newest run holding it -- among those at or before `at`. */
function settingVersion(history: OwnerVersion[], value: string, at = Infinity): OwnerVersion | undefined {
  let found: OwnerVersion | undefined;
  for (const v of history) {
    if (ms(v.timestamp) > at) continue;
    if (String(v.value ?? "").trim() !== value) break;
    found = v;
  }
  return found;
}

/**
 * Why this assignment is the import's (the header) -- a few words for the log -- or null when it is not. Throws when
 * a company it must read cannot be read (the caller retries); a company HubSpot no longer has is no import.
 */
export async function importOf(env: Env, f: AssignmentFacts): Promise<string | null> {
  if (f.source === "IMPORT") {
    const age = ms(f.assigned) - ms(f.created);
    if (Number.isFinite(age) && age <= FRESH_IMPORT_MS)
      return `the contact was created by an import ${Math.max(0, Math.round(age / 60_000))} min before this assignment`;
  }
  if (!f.owner || !f.history?.length) return null;
  const set = settingVersion(f.history, f.owner);
  if (!set) return null;
  if (set.sourceType === "IMPORT") return `import ${set.sourceId ?? "-"} set the owner`;
  const company = /companyId=(\d+)/.exec(String(set.sourceId ?? ""))?.[1];
  if (set.sourceType !== "COMPANIES" || !company) return null;
  let rec: any;
  try {
    rec = await hs(env, "GET",
      `/crm/v3/objects/companies/${company}?properties=hubspot_owner_id&propertiesWithHistory=hubspot_owner_id`, undefined, 2);
  } catch (e) {
    if (/: 404\b/.test(String(e))) return null;
    throw e;
  }
  const cause = settingVersion(rec?.propertiesWithHistory?.hubspot_owner_id ?? [], f.owner, ms(set.timestamp) + CASCADE_SLACK_MS);
  return cause?.sourceType === "IMPORT" ? `import ${cause.sourceId ?? "-"} set the owner of company ${company}` : null;
}
