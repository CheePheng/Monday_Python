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
  const v = applyScale(f, String(value));
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
      // Omit rather than send an address monday's validator rejects: a rejected cell fails the whole
      // create. expectedText applies the same test so no diff is raised. See emailStorable.
      if (!emailStorable(e)) return null;
      return { email: e, text: e };
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
      // Over monday's E.164 limit -> omit the column entirely. Sending it fails the whole mutation,
      // and on a create that means losing every other field on the card. expectedText applies the
      // same test so no diff is ever raised for a value the cell cannot hold. See phoneStorable.
      if (digits.length > PHONE_MAX_DIGITS) return null;
      // International (leading +): keep the + so monday reads the country from the code.
      // Local (no +): raw digits, NO country — the contacts are multi-country and HubSpot's own country
      // detection is unreliable, so any forced country would mis-flag the number.
      return v.trim().startsWith("+") ? { phone: "+" + digits } : { phone: digits };
    }
  }
}

export function itemName(rec: HsRecord, spec: ObjectSpec): string {
  const name = spec.nameProps.map(p => rec.properties[p] ?? "").join(" ").trim();
  if (name) return name;
  // Every nameProp was empty. Try the spec's declared fallbacks (e.g. email) before resorting to the
  // id, which is traceable but unsearchable — see ObjectSpec.nameFallbackProps.
  for (const p of spec.nameFallbackProps ?? []) {
    const v = String(rec.properties[p] ?? "").trim();
    if (!v) continue;
    if (spec.nameFallbackTransform === "emailLocalPart") {
      // The part before the FIRST "@". Falls through to the whole value when there is no "@" or the
      // local part is empty ("@x.com"), which is the "use it as-is if it does not parse" rule — a
      // malformed address is still a better card name than a bare id.
      const at = v.indexOf("@");
      const local = at > 0 ? v.slice(0, at).trim() : "";
      return local || v;
    }
    if (spec.nameFallbackTransform === "domainStem") {
      // Same "use it as-is if it does not parse" rule: an unusable domain still beats a bare id.
      return domainStem(v) || v;
    }
    return v;
  }
  // Last resort. monday rejects an empty item name, so SOMETHING must be returned; the id at least
  // identifies which HubSpot record the card belongs to.
  return `${spec.object} ${rec.id}`;
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
 * The most digits monday's phone column will accept: E.164 allows 15, and monday enforces it.
 *
 * Over-length values are not hypothetical bad data — they are two numbers typed into one HubSpot
 * field. Real examples from this portal: "+8522713691235547427415" (23 digits, plainly
 * +85223506974 followed by 85290675945) and "8522382645695287557558" (22).
 */
export const PHONE_MAX_DIGITS = 15;

/**
 * Generic second-level labels that sit in front of a two-letter country code in a MULTI-PART public
 * suffix: com.cn, co.uk, com.sg, edu.cn, net.cn, co.jp …
 *
 * A PATTERN rather than a country list, because that is what the data supports: of the 4,237 nameless
 * HubSpot companies that carry a domain, 698 end this way. A naive "label before the last dot" would
 * have named all 698 cards "com".
 *
 * Deliberately not a full public-suffix list. That would be thousands of entries fetched from the
 * internet to serve a display name, and being wrong here costs a slightly-off card label — nothing
 * matches, dedups or syncs on this value.
 */
const GENERIC_SLD = /^(com|net|org|co|gov|edu|ac|biz|gob|or|ne|in)$/;

/**
 * The registrable stem of a domain, for use as a display name. "" when nothing usable is left.
 *
 *   hubspot.com                     -> hubspot
 *   jsgjjn.com.cn                   -> jsgjjn      (com.cn is one suffix, not a label)
 *   mhllp.co.uk                     -> mhllp
 *   h.axhome.com.cn                 -> axhome      (subdomain dropped)
 *   ihpc.astar.edu.sg               -> astar
 *   reversetest-company.example.com -> example     (the REGISTRABLE name, not the subdomain)
 *
 * Characters are never rewritten and nothing is title-cased: the stem is shown exactly as registered.
 * "jsgjjn" is not a word and prettifying it would only invent something the record never said.
 */
export function domainStem(v: string | null | undefined): string {
  const host = String(v ?? "").trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/[.\s]+$/, "");
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  // Two-letter ccTLD behind a generic SLD means the last TWO labels are the suffix.
  const suffixLabels = parts.length >= 3 && /^[a-z]{2}$/.test(parts[parts.length - 1])
    && GENERIC_SLD.test(parts[parts.length - 2]) ? 2 : 1;
  return parts[parts.length - 1 - suffixLabels] ?? parts[0];
}

/**
 * Is this phone value one monday can actually store?
 *
 * Consulted by BOTH formatValue and expectedText, which is the whole point. monday rejects an
 * over-length phone with "invalid value ... for this column", and because a create sends every column
 * in one mutation that error fails the ENTIRE card — all 30 other fields lost, not just the phone.
 * Measured live during the 2026-09-09 Contacts import: 14 of the first 10,100 records (0.14%), which
 * extrapolates to roughly 130 contacts that would have been dropped completely.
 *
 * So an unstorable number is OMITTED rather than sent. It must then also be invisible to the diff, or
 * expectedText would keep predicting a value the cell can never hold and the card would be rewritten
 * on every webhook forever — the same permanently-dirty-diff failure the long_text clamp exists for.
 * The value stays intact in HubSpot; only monday declines to display it.
 */
export function phoneStorable(v: string | null | undefined): boolean {
  const d = phoneDigits(v);
  return d.length > 0 && d.length <= PHONE_MAX_DIGITS;
}

/**
 * Is this address one monday's email column will accept?
 *
 * THE SAME HAZARD AS phoneStorable, and the third instance of one pattern worth naming: several monday
 * column types VALIDATE their input, a create sends every column in a single mutation, so one rejected
 * cell fails the ENTIRE card. A validated column therefore needs a guard on our side, and the guard has
 * to be consulted by formatValue AND expectedText or the card churns forever instead.
 *
 * monday validates more strictly than HubSpot stores. All 7 rejections in the 2026-09-09 Contacts
 * import were NON-ASCII local parts, which HubSpot holds happily:
 *
 *   doáz.zwhswdp@newlogic.com      vy.xfåuljqnq@flyfrontier.com   tzkyjö.mbbaö@diytrade.com.hk
 *   eøey@visionsgroup.co.uk        müw.akw@complyadvantage.com    oühvqbr@suntecgroup.com
 *   hpepn.wâ€™ewofs@gammonconstruction.com   (a mojibake apostrophe, also non-ASCII)
 *
 * The address is NOT lost: it stays in HubSpot, and itemName still names the card from the raw
 * property ("doáz.zwhswdp"), because a text column accepts what an email column will not.
 */
export function emailStorable(v: string | null | undefined): boolean {
  const s = String(v ?? "").trim();
  if (!s) return false;
  if (/[^\x00-\x7F]/.test(s)) return false;              // the observed cause, every time
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);        // plus a basic shape check
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
 * Canonical numeric form, or "" when the text is not a number. Used on BOTH sides and in the reverse
 * write, so all three agree.
 *
 * monday renders a numbers column as it pleases — "1500000.50", or with thousands separators once a
 * column unit/format is set — while HubSpot stores a number. Comparing those raw produced the same
 * permanently-dirty diff class as the link loop, and on a `reverse: true` numbers field it also shipped
 * whatever the cell said straight into a HubSpot NUMBER property, which 400s on anything non-numeric.
 * Separators are stripped before parsing precisely because a formatted column is the common case.
 */
export function numText(v: string | null | undefined): string {
  const t = String(v ?? "").trim();
  if (!t) return "";
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : "";
}

/**
 * HubSpot value -> the number the monday column DISPLAYS. See FieldSpec.scale.
 *
 * `hs_deal_stage_probability` is stored as a fraction (0.2) against a column rendering `%`, so
 * without this a 20% deal reads "0.2%" — wrong by two orders of magnitude, plausible enough to pass
 * a glance, and multiplied into money by the Forecast Value formula.
 *
 * Called from BOTH formatValue and expectedText, which is the part that matters: a transform applied
 * to only one of them makes every comparison differ, so the record is rewritten on every pass
 * forever. reverseFieldValue divides by the same factor.
 *
 * A non-numeric value is returned untouched rather than becoming NaN — the existing numText path
 * already decides what to do with garbage, and scaling must not turn a recoverable value into one.
 */
export function applyScale(f: FieldSpec, v: string): string {
  if (!f.scale || f.type !== "numbers") return v;
  // EMPTY STAYS EMPTY. `Number("")` is 0, which is finite, so without this an absent probability would
  // scale to "0" and be written to the board as a real zero. Both callers happen to return early on an
  // empty value today, so this is unreachable in production — which is exactly why it is worth
  // pinning: the next caller will not know that, and a 0% forecast reads as a decision, not a blank.
  if (!String(v).trim()) return v;
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return v;
  // Rounded to 10 dp before stringifying: 0.07 * 100 is 7.000000000000001 in binary floating point,
  // which would differ from monday's stored "7" on every comparison and rewrite the card forever.
  return String(Math.round(n * f.scale * 1e10) / 1e10);
}

/** The inverse of applyScale: what monday's displayed number means in HubSpot's units. */
export function unapplyScale(f: FieldSpec, v: string): string {
  if (!f.scale || f.type !== "numbers") return v;
  if (!String(v).trim()) return v;          // see applyScale: an empty cell must not become 0
  const n = Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return v;
  return String(Math.round((n / f.scale) * 1e10) / 1e10);
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
  const v = applyScale(f, String(value).trim());
  // Phone: diffable, but only as digits (see phoneDigits). fieldDiffs normalizes the monday side to match.
  // An UNSTORABLE number reports "" so it is treated exactly like an empty HubSpot value: no diff, no
  // write, no churn. Must stay in lockstep with formatValue's identical check — if the two ever
  // disagreed, the card would be rewritten on every webhook chasing a value monday cannot accept.
  if (f.type === "phone") return phoneStorable(v) ? phoneDigits(v) : "";
  // Email: compared CASE-INSENSITIVELY. HubSpot stores what was typed ("Bob@X.com") while monday's email
  // column may echo a normalised form, and a raw compare would diff every tick and loop. fieldDiffs
  // lowercases the monday side to match.
  // An address monday will not store reports "" so it is treated as an empty HubSpot value: no diff,
  // no write, no churn. Must stay in lockstep with formatValue's identical check.
  if (f.type === "email") return emailStorable(v) ? v.toLowerCase() : "";
  switch (f.type) {
    case "date": return v.slice(0, 10);
    // numText, so the diff, the forward write and the reverse write all canonicalise identically.
    case "numbers": return numText(v) || v;
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
