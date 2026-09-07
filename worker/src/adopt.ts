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
  // PA-1. A consumer email provider is not a company domain. Blocked BEFORE the hostname check so the
  // reason is unambiguous in the logs.
  if (isPublicEmailDomain(d)) return "";
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
