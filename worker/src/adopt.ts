import type { MondayItem, ObjectSpec } from "./types";
import { normalizeDomain } from "./normalize";
import { linkReverse } from "./mapping";

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

  // A monday LINK column keeps the address in its value JSON, so prefer the url when we have it.
  //
  // BUT WE USUALLY DO NOT HAVE IT, AND THAT IS THE BUG THIS COMMENT EXISTS FOR. `ITEM_FIELDS` in
  // monday.ts selects `column_values { id text ... }` and NOT `value`, so for every item the sync
  // fetches this branch is unreachable and `text` is the operative input. That made the fallback the
  // real path while it was written as the exception — and monday renders a link column's `text` as
  // "<label> - <url>" ("example.com - https://example.com"), which normalizeDomain turns into a string
  // full of spaces and a dash, isHostname rejects, and adoptionKey returns "". The card is then stamped
  // "not synced — needs domain" no matter what a rep types into the Domain column. Observed live on
  // 2026-09-09: six Accounts cards with a filled Domain, a blank HubSpot ID and a blank HubSpot Link.
  //
  // This is the SAME monday rendering that caused the 76-iteration company_domain sync loop (fixed by
  // linkText in the diff path). `linkReverse` is that fix's counterpart — it takes the half after the
  // last " - " only when that half is URL-shaped, so "Acme Corporate Site - https://acme.com" yields
  // the url while a company whose name simply contains " - " is left intact and still refused by the
  // hostname check below.
  //
  // The `value` branch is kept rather than deleted: it is correct whenever the url IS present, and
  // keeping it means adding `value` to ITEM_FIELDS later needs no change here.
  let raw = linkReverse(text);
  const json = (cv as { value?: string | null } | undefined)?.value;
  if (json) {
    try {
      const url = String((JSON.parse(json) as { url?: unknown }).url ?? "").trim();
      if (url) raw = url;
    } catch { /* malformed value JSON: keep the text fallback */ }
  }
  return companyDomainKey(raw);
}

/**
 * THE ONE DEFINITION of a usable company domain in this system — used both to MATCH a card to a
 * HubSpot company and to decide what a monday edit may STORE as a company's domain.
 *
 * Shared deliberately. If the two ever disagreed, a rep's edit could store a value that this system's
 * own matcher then refuses to find, which is the state that manufactures duplicate companies.
 *
 * Returns "" for anything unusable, which every caller must treat as "do nothing".
 */
export function companyDomainKey(raw: string): string {
  const d = normalizeDomain(raw);
  // PA-1. A consumer email provider is not a company domain. Blocked BEFORE the hostname check so the
  // reason is unambiguous in the logs.
  if (isPublicEmailDomain(d)) return "";
  // SHAPE-CHECK, because this is the trust boundary for free-typed rep input. normalizeDomain only
  // CANONICALISES (lowercase, strip scheme/www/path) — it does not validate, and correctly so: the WM
  // path feeds it a column that already is a domain. Here a rep may type anything, and "ABC Trading Sdn
  // Bhd" would otherwise normalise to "abc trading sdn bhd" — which would match no HubSpot company, and
  // was then used both to CREATE one with a garbage domain and (once Domain went two-way on 2026-09-09)
  // to overwrite a real company's dedup key with a company NAME. Requiring a real hostname makes both
  // impossible. Caught by a test, not by review: normalizeDomain looks like it validates and does not.
  return isHostname(d) ? d : "";
}

/** A plausible registrable hostname: dot-separated alphanumeric/hyphen labels ending in a letter TLD. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

function isHostname(d: string): boolean {
  return d.length <= 253 && HOSTNAME.test(d);
}

/**
 * PA-1 — consumer/public email providers, which must NEVER be an automatic company-matching key.
 *
 * A SHORT, EXPLICIT, REVIEWED list, deliberately not an internet-derived blacklist. Every entry is
 * either evidenced in this portal or an obvious provider a rep might plausibly type.
 *
 * Why this is not theoretical: five companies in the live portal ALREADY carry a provider domain —
 * gmail.com -> "上海胜意十方传媒技术有限公司", qq.com -> "QQ Music", 163.com -> a Zhuhai consultancy,
 * vip.163.com -> "NETEASE", yahoo.com -> "JOYY Inc." (verified 2026-09-07). So a rep typing "gmail.com"
 * into an Accounts card's Domain column would adopt an unrelated Chinese media company. The collision
 * target exists today.
 *
 * SCOPE: this blocks AUTOMATIC company adoption/creation by domain only. It says nothing about the
 * validity of a Contact whose email is at one of these providers — contact email is never a company
 * matching key, and those contacts sync normally. Some of these are also genuine companies (Tencent
 * really does own qq.com); a human can still link such a card deliberately by its HubSpot ID.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  // Western
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me",
  "gmx.com", "mail.com", "zoho.com",
  // Chinese — the ones that matter most for this portal
  "qq.com", "163.com", "126.com", "sina.com", "sina.cn", "foxmail.com", "139.com", "189.cn",
  "aliyun.com", "sohu.com", "yeah.net", "21cn.com", "tom.com", "wo.cn", "vip.sina.com",
]);

/** True for a provider domain or any subdomain of one — "vip.163.com" is a real case in this portal. */
export function isPublicEmailDomain(d: string): boolean {
  if (!d) return false;
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return true;
  for (const p of PUBLIC_EMAIL_DOMAINS) if (d.endsWith("." + p)) return true;
  return false;
}
