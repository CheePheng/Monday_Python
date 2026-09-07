import type { MondayItem, ObjectSpec } from "./types";
import { normalizeDomain } from "./normalize";

/**
 * The key a monday-originated create uses to ADOPT an existing HubSpot record instead of duplicating it.
 *
 * Spec-driven on purpose. The WM company board's item NAME *is* its domain, so that path adopts on
 * `item.name`. The CRM Accounts board's item name is a display name with the domain in a link column, so
 * reusing that would adopt on a company NAME — breaking "never match records by name". "ABC Trading",
 * "ABC Trading Sdn Bhd" and "ABC Trading Malaysia" are three different companies.
 *
 * Returns "" when there is no usable key, which callers MUST treat as "do not create". Never falls back
 * to the item name.
 */
export function adoptionKey(item: MondayItem, spec: ObjectSpec): string {
  const a = spec.adoptBy;
  if (!a) return "";
  const cv = item.column_values.find(c => c.id === a.col);
  const text = (cv?.text ?? "").trim();

  if (a.kind === "email") {
    const e = text.toLowerCase();
    // A bare "@" or a missing local/host part is not an address; adopting on junk would link the wrong
    // record, which is worse than declining to create.
    const at = e.indexOf("@");
    return at > 0 && at < e.length - 1 && !/\s/.test(e) ? e : "";
  }

  // A monday LINK column keeps the address in its value JSON; `text` is a human label that may be empty
  // or may read "Acme Corporate Site". Prefer the url, fall back to text, never the item name.
  let raw = text;
  const json = (cv as { value?: string | null } | undefined)?.value;
  if (json) {
    try {
      const url = String((JSON.parse(json) as { url?: unknown }).url ?? "").trim();
      if (url) raw = url;
    } catch { /* malformed value JSON: keep the text fallback */ }
  }
  const d = normalizeDomain(raw);
  // SHAPE-CHECK, because this is the trust boundary for free-typed rep input. normalizeDomain only
  // CANONICALISES (lowercase, strip scheme/www/path) — it does not validate, and correctly so: the WM
  // path feeds it a column that already is a domain. Here a rep may type anything, and "ABC Trading Sdn
  // Bhd" would otherwise normalise to "abc trading sdn bhd", match no HubSpot company, and then be used
  // to CREATE one with a garbage domain. Requiring a real hostname makes that impossible.
  return isHostname(d) ? d : "";
}

/** A plausible registrable hostname: dot-separated alphanumeric/hyphen labels ending in a letter TLD. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

function isHostname(d: string): boolean {
  return d.length <= 253 && HOSTNAME.test(d);
}
