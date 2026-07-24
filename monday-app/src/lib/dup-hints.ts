// When a contact is created with no email there is no de-duplication key, so the server cannot tell whether
// it already exists. The next best thing is to show the rep the records whose NAME looks similar and let a
// human decide. This is advisory only — it never blocks, and it never auto-merges anything.

import { searchHubspot, type Hit } from "../worker-client";
import type { RecordKind, RecordFormValues } from "./record-form";

export type SearchFn = (token: string, type: "contacts" | "companies", q: string) => Promise<{ items: Hit[] }>;

const MAX_HINTS = 5;

/** The text to search on, or "" when there isn't enough to bother (a 1-char name matches everything). */
export function hintQuery(kind: RecordKind, v: RecordFormValues): string {
  const q = kind === "contact"
    ? [v.firstname, v.lastname].map(s => s?.trim()).filter(Boolean).join(" ")
    : (v.name?.trim() ?? "");
  return q.length >= 2 ? q : "";
}

/** Human-readable "possible duplicate" lines, newest search first. Never throws: a failed lookup returns
 * [] so the dialog still asks its question. */
export async function loadDuplicateHints(token: string, kind: RecordKind, v: RecordFormValues,
    search: SearchFn = (t, type, q) => searchHubspot(t, type, q)): Promise<string[]> {
  const q = hintQuery(kind, v);
  if (!q) return [];
  try {
    const { items } = await search(token, kind === "contact" ? "contacts" : "companies", q);
    return items.slice(0, MAX_HINTS).map(h => (h.secondary ? `${h.name} — ${h.secondary}` : h.name));
  } catch {
    return [];
  }
}
