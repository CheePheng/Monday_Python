/** Canonical company domain for dedup: lowercase, no scheme, no leading www., no path, no trailing dot/slash.
 * Pure + deterministic so it is unit-testable. Empty/blank input -> "". */
export function normalizeDomain(raw: string): string {
  if (!raw) return "";
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");   // strip scheme (http://, https://, etc.)
  d = d.replace(/^www\./, "");          // strip a single leading www.
  d = d.replace(/[/?#].*$/, "");        // strip path/query/fragment
  d = d.replace(/[.\s]+$/, "");         // strip trailing dots/whitespace
  return d;
}
