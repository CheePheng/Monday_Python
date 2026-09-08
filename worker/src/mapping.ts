import type { Ctx, FieldSpec, HsRecord, ObjectSpec } from "./types";

const dict = (f: FieldSpec, ctx: Ctx): Record<string, string> =>
  (f.labels ? ctx.labels[f.labels] : undefined) ?? {};

/** monday's long-text column holds exactly 2000 characters. MEASURED on this account, not assumed:
 *  1990 and 2000 store exactly; 2001, 2500 and 5000 are all ACCEPTED and then silently truncated to
 *  2000. So an over-length value does not fail the write — it produces a PERMANENTLY DIRTY DIFF.
 *  HubSpot holds 2400 characters, monday stores 2000, expectedText predicts 2400, colText reads 2000,
 *  they never compare equal, and the card is rewritten on EVERY subsequent webhook forever.
 *
 *  Predicting monday's own truncation is what clears the diff, so this must slice to exactly 2000 with
 *  no ellipsis: appending "..." would make our stored value differ from what monday stores when any
 *  other path writes the raw string, reintroducing the same permanent diff from the other side.
 *
 *  `concrete_demand` (Requirement-具体需求) is the live exposure: unbounded free text from the public
 *  dkmeco.com web form, capped by nothing on either side. */
export const LONG_TEXT_MAX = 2000;

export function clampLongText(s: string): string {
  return s.length > LONG_TEXT_MAX ? s.slice(0, LONG_TEXT_MAX) : s;
}

export function formatValue(f: FieldSpec, value: string | null | undefined, ctx: Ctx): unknown {
  if (value === null || value === undefined || value === "") return null;
  const v = String(value);
  switch (f.type) {
    case "text": return dict(f, ctx)[v] ?? v;
    // { text }, not a bare string — and clamped, so the stored value equals what expectedText predicts.
    case "long_text": return { text: clampLongText(v) };
    case "numbers": return v;
    case "status": return { label: dict(f, ctx)[v] ?? v };
    case "dropdown": {
      const labels = v.split(";").map(s => s.trim()).filter(Boolean).map(s => dict(f, ctx)[s] ?? s);
      return labels.length ? { labels } : null;
    }
    case "date": return { date: v.slice(0, 10) };
    case "people": {
      const email = ctx.ownersById[v]?.email?.toLowerCase();
      const uid = email ? ctx.mondayUsersByEmail[email] : undefined;
      return uid ? { personsAndTeams: [{ id: Number(uid), kind: "person" }] } : null;
    }
    // monday EMAIL column. Needs { email, text }, not a bare string. Only the CRM boards use this type
    // (the WM contacts board keeps email in a plain text column), so nothing in production changes.
    case "email": {
      const e = v.trim();
      return e ? { email: e, text: e } : null;
    }
    // monday LINK column. Needs { url, text }. Distinct from spec.linkCol, which is the fixed
    // "Open in HubSpot" deep link; this carries a HubSpot URL property (e.g. linkedin_company_page).
    case "link": {
      const u = v.trim();
      return u ? { url: u, text: u } : null;
    }
    case "phone": {
      const digits = v.replace(/[^\d]/g, "");
      if (!digits) return null;
      // International (leading +): keep the + so monday reads the country from the code.
      // Local (no +): raw digits, NO country — the contacts are multi-country and HubSpot's own country
      // detection is unreliable, so any forced country would mis-flag the number.
      return v.trim().startsWith("+") ? { phone: "+" + digits } : { phone: digits };
    }
  }
}

export function itemName(rec: HsRecord, spec: ObjectSpec): string {
  const name = spec.nameProps.map(p => rec.properties[p] ?? "").join(" ").trim();
  return name || `${spec.object} ${rec.id}`;
}

export function buildColumnValues(rec: HsRecord, spec: ObjectSpec, ctx: Ctx): Record<string, unknown> {
  const cv: Record<string, unknown> = { [spec.idCol]: String(rec.id) };
  for (const f of spec.fields) {
    const v = formatValue(f, rec.properties[f.hs], ctx);
    if (v !== null && v !== undefined) cv[f.col] = v;
  }
  if (spec.linkCol) cv[spec.linkCol] = {
    url: `https://app.hubspot.com/contacts/${ctx.portalId}/record/${spec.objectTypeId}/${rec.id}`,
    text: "Open in HubSpot",
  };
  // No sales_user -> stamp the "Shared" people column with the all-members team so the Unassigned deal
  // is viewable by everyone even under restricted (assigned-people-only) board permissions.
  const us = spec.unassignedShared;
  if (us?.teamId && !(rec.properties.sales_user ?? "").trim())
    cv[us.col] = { personsAndTeams: [{ id: Number(us.teamId), kind: "team" }] };
  return cv;
}

/** Canonical text a monday column should show for this HubSpot value; null = not diffable.
 * Trimmed + number-normalized so it round-trips against monday's echoed column text
 * (monday trims text and renders "1500000.50" as "1500000.5") — otherwise every tick sees a
 * phantom diff and loops. */
/** Bare digits of a phone value. Phone is the one column whose monday rendering never matches HubSpot's
 * string byte-for-byte (monday re-formats by country), so BOTH sides are compared on digits only —
 * otherwise every reconcile tick sees a phantom diff and the sync fights itself. */
export function phoneDigits(v: string | null | undefined): string {
  return String(v ?? "").replace(/[^\d]/g, "");
}

/**
 * Canonical comparison form for a LINK column. Applied to BOTH sides, like phoneDigits.
 *
 * A monday link column does NOT echo back what you wrote. formatValue sends
 * `{ url: v, text: v }`; monday canonicalises the url (a bare domain becomes `https://domain`) and its
 * `text` field then renders as `"<text> - <url>"` because the two now differ. So HubSpot's
 * `reversetest-company.example.com` was compared against monday's
 * `reversetest-company.example.com - https://reversetest-company.example.com` and could never match.
 *
 * That is a PERMANENTLY DIRTY DIFF, and for a link column it does not merely rewrite the card — it
 * LOOPS. Each forward write fires monday's own change_column_value webhook, which reconciles, which
 * writes again. Observed live on 2026-09-08: 76 iterations on `company_domain` from a single company,
 * the first one with a domain ever to sync. Nothing capped it.
 *
 * Normalises three real differences: the `" - url"` suffix monday appends, the scheme monday adds, and
 * a trailing slash. Case-folded because a host is case-insensitive.
 */
export function linkText(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const dash = s.indexOf(" - ");
  const head = (dash >= 0 ? s.slice(0, dash) : s).trim();
  return head.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * What to send to HubSpot for a link column edited in monday. Different job from linkText: that one
 * canonicalises for COMPARISON and deliberately drops the scheme; this one must produce a value a
 * HubSpot URL property will accept, so the scheme is kept.
 *
 * monday's `text` for a link column renders as `"<text> - <url>"` once the two differ. Sending that
 * whole string is what `reverse: true` did — `companies.linkedin_company_page` would have pushed
 * `"MyCo - https://linkedin.com/company/myco"` into a HubSpot URL field. Prefer the URL half, and fall
 * back to the raw string when the tail does not look like one (a display label may itself contain
 * " - ", so this cannot be a blind split).
 */
export function linkReverse(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const at = s.lastIndexOf(" - ");
  if (at < 0) return s;
  const tail = s.slice(at + 3).trim();
  return /^https?:\/\//i.test(tail) || /^[\w-]+(\.[\w-]+)+/.test(tail) ? tail : s;
}

export function expectedText(f: FieldSpec, value: string | null | undefined, ctx: Ctx): string | null {
  if (f.type === "people") return null;
  if (value === null || value === undefined || value === "") return "";
  const v = String(value).trim();
  // Phone: diffable, but only as digits (see phoneDigits). fieldDiffs normalizes the monday side to match.
  if (f.type === "phone") return phoneDigits(v);
  // Email: compared CASE-INSENSITIVELY. HubSpot stores what was typed ("Bob@X.com") while monday's email
  // column may echo a normalised form, and a raw compare would diff every tick and loop. fieldDiffs
  // lowercases the monday side to match.
  if (f.type === "email") return v.toLowerCase();
  switch (f.type) {
    case "date": return v.slice(0, 10);
    case "numbers": { const n = Number(v); return Number.isFinite(n) ? String(n) : v; }
    // A monday link column echoes its TEXT part, which formatValue sets equal to the url.
    case "link": return v;
    case "status": case "text": return (dict(f, ctx)[v] ?? v).trim();
    // Must predict monday's OWN 2000-char truncation, or the diff never clears and the card is
    // rewritten on every webhook. Clamp before trim, matching formatValue's order.
    case "long_text": return clampLongText(dict(f, ctx)[v] ?? v).trim();
    case "dropdown":
      return v.split(";").map(s => s.trim()).filter(Boolean).map(s => (dict(f, ctx)[s] ?? s).trim()).join(", ");
    default: return v;
  }
}
