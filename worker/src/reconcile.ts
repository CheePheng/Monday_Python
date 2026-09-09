import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "./types";
import { LONG_TEXT_MAX, expectedText, formatValue, itemName, linkReverse, linkText, numText, phoneDigits } from "./mapping";
import { colText } from "./dedup";
import { companyDomainKey } from "./adopt";
import { reverseGroup, targetGroup } from "./routing";

export interface Diff {
  kind: "field" | "name" | "group";
  f?: FieldSpec;
  hsText: string;
  mdText: string;
  backfill?: boolean;
  /** The monday cell is only a TRUNCATED VIEW of the HubSpot value, so it must never be written back.
   *  monday's long-text column holds exactly 2000 characters and a longer HubSpot value is clamped on
   *  the way in. Once such a field is two-way, a rep editing that cell would push their 2000-character
   *  version over the longer original and destroy text they were never shown. Set in fieldDiffs,
   *  honoured in buildReversePatch. */
  viewTruncated?: boolean;
}

/** monday first-person in a people column -> HubSpot owner id (via email), or "" if none/unmapped. */
function firstPersonOwnerId(item: MondayItem, col: string, ctx: Ctx): string {
  const cv = item.column_values.find(c => c.id === col);
  const pid = cv?.persons_and_teams?.find(p => p.kind === "person")?.id;
  if (!pid) return "";
  const email = ctx.mondayEmailByUserId[String(pid)];
  return email ? (ctx.ownerIdByEmail[email.toLowerCase()] ?? "") : "";
}

/** Objects whose ALLOWLISTED (`backfill: true`) fields may FILL an empty HubSpot value from monday.
 * The per-field `backfill` flag is the real allowlist; this is the second lock, so adding the flag to a
 * field on some other object can't silently start writing to that object. Contacts joined 2026-08-04 for
 * `phone` only — see the phone note in config.ts. */
const BACKFILL_OBJECTS = new Set(["deals", "contacts"]);

/**
 * @param fillEmpty  APP-SAVE INTENT. A rep pressing Save in a drawer is an explicit instruction to push
 *   monday -> HubSpot, so an EMPTY HubSpot value must be fillable from the card even when the field
 *   carries no `backfill` flag. Without this, editing a field that HubSpot has never held (very common on
 *   imported/sparse records — companies carry no backfill flags at all) writes to monday, reports success,
 *   and silently never reaches HubSpot. Passive reconciles (cron/webhook) still pass false and stay
 *   conservative. It never CLEARS: an empty monday value still produces no diff.
 */
export function fieldDiffs(rec: HsRecord, item: MondayItem, spec: ObjectSpec, ctx: Ctx,
    fillEmpty = false): Diff[] {
  const out: Diff[] = [];
  for (const f of spec.fields) {
    if (f.type === "people") {
      // People columns aren't text-diffable by name. Empty column -> forward-fill from HubSpot (heal, e.g.
      // the "Sales Users" column on existing cards). Filled + reversible -> reverse by comparing the monday
      // person's OWNER ID to HubSpot's value (id compare, so a matching owner yields no diff -> no loop).
      if (!colText(item, f.col)) {
        if (formatValue(f, rec.properties[f.hs], ctx))
          out.push({ kind: "field", f, hsText: "(person)", mdText: "" });
      } else if (f.reverse || (fillEmpty && f.appReverse)) {   // appReverse: explicit app save only
        const wantOwner = firstPersonOwnerId(item, f.col, ctx);
        const hsOwner = (rec.properties[f.hs] ?? "").trim();
        if (wantOwner && wantOwner !== hsOwner) out.push({ kind: "field", f, hsText: hsOwner, mdText: wantOwner });
      }
      continue;
    }
    const hsText = expectedText(f, rec.properties[f.hs], ctx);
    if (hsText === null) continue; // people: matched by owner id above, not text-diffable
    if (hsText === "") {
      // Empty HubSpot value: normally we don't fight monday (no clear, no loop). EXCEPTION — controlled
      // backfill: an ALLOWLISTED reversible field on an ALLOWLISTED object whose card carries the matching
      // HubSpot id may FILL the empty HubSpot value from a non-empty monday value. Never the reverse (an
      // empty monday value never clears HubSpot), never for companies, never matched by name.
      //
      // "Empty" is judged on the RAW property, not on hsText. hsText is NORMALIZED (phone -> digits), so a
      // real-but-digitless value like "N/A"/"none"/"ask reception" normalizes to "" and would otherwise look
      // empty — backfilling over it would DESTROY real HubSpot data while logging previous="".
      const rawHs = String(rec.properties[f.hs] ?? "").trim();
      // `spec.fillEmptyFromMonday` is opt-in per SPEC, so the CRM boards can fill an empty HubSpot
      // field from any reverse field while the live WM specs — which share these object NAMES and so
      // would have been caught by any change to BACKFILL_OBJECTS — behave exactly as before.
      const allowed = fillEmpty || (f.backfill && BACKFILL_OBJECTS.has(spec.object))
        || !!spec.fillEmptyFromMonday;
      if (rawHs === "" && allowed && f.reverse && colText(item, spec.idCol) === rec.id) {
        const md = colText(item, f.col);
        // Only raise the diff if the value would actually SURVIVE the reverse mapping. A monday value that
        // canonicalises to "" (a digitless phone, an unmappable dropdown label) writes nothing, so raising
        // it would re-diff every pass forever — churn, a bogus stats.toMonday++, and no progress.
        if (md && reverseFieldValue(f, md, ctx)) out.push({ kind: "field", f, hsText: "", mdText: md, backfill: true });
      }
      continue;
    }
    const mdText = colText(item, f.col);
    // Phone compares DIGITS on both sides (hsText is already digits from expectedText): monday re-formats
    // a phone column by country, so a raw compare would diff every tick and loop. The diff still carries the
    // RAW monday text so the reverse write keeps the user's "+"/formatting.
    // LINK is normalised on BOTH sides for the same reason phone is: monday does not echo back what we
    // wrote. It canonicalises the url and renders `text` as "<text> - <url>", so a raw compare never
    // matched and the forward write fired on every reconcile — and because that write triggers monday's
    // own change_column_value webhook, it LOOPED (76 iterations observed live on company_domain).
    const same = f.type === "phone" ? phoneDigits(mdText) === hsText
      : f.type === "email" ? mdText.trim().toLowerCase() === hsText
      : f.type === "link" ? linkText(mdText) === linkText(hsText)
      // numbers: monday may render "1500000.50" or add thousands separators; hsText is already canonical.
      : f.type === "numbers" ? numText(mdText) === hsText
      : hsText === mdText;
    if (!same) {
      // A long_text whose HubSpot value exceeds monday's 2000-character column is only PARTIALLY
      // visible on the card, so the card cannot be authoritative for it.
      const rawLen = String(rec.properties[f.hs] ?? "").length;
      const viewTruncated = f.type === "long_text" && rawLen > LONG_TEXT_MAX;
      out.push({ kind: "field", f, hsText, mdText, ...(viewTruncated ? { viewTruncated } : {}) });
    }
  }
  const wantName = itemName(rec, spec);
  if (wantName !== item.name.trim()) out.push({ kind: "name", hsText: wantName, mdText: item.name.trim() });
  const wantGroup = targetGroup(rec, spec);
  if (wantGroup && wantGroup !== item.group.id)
    out.push({ kind: "group", hsText: wantGroup, mdText: item.group.id });
  return out;
}

/** Direction by last-synced HubSpot timestamp (stored in the Sync State column), NOT monday's
 * updated_at. If HubSpot changed since we last synced this card -> HubSpot wins; otherwise the diff
 * came from a monday edit -> monday wins. Immune to the sync's own updated_at bumps and the
 * fetch->write self-race. First encounter (empty lastSynced) => HubSpot wins (source of truth). */
export function decideDirection(
  diffs: Diff[], hsModified: string | null | undefined, lastSynced: string,
): "none" | "toMonday" | "toHubspot" {
  if (diffs.length === 0) return "none";
  const hs = Date.parse(hsModified ?? "") || 0;
  const synced = Date.parse(lastSynced) || 0;
  return hs > synced ? "toMonday" : "toHubspot";
}

/** label -> internal value. NULL-PROTOTYPE: see `has` below. */
function invert(dictionary: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [value, label] of Object.entries(dictionary)) out[label] = value;
  return out;
}

/**
 * Is `key` a real entry in `d`, as opposed to something inherited from Object.prototype?
 *
 * `d[text] !== undefined` was truthy for "constructor", "toString", "valueOf", "hasOwnProperty" and
 * "__proto__" — so a monday cell reading "constructor" passed validation and put
 * Object.prototype.constructor (a Function) into the PATCH body. No live option is spelled that way
 * today, but "Other"/"Support/Service"/free-typed city names are exactly the kind of column where a
 * user types a word of their choosing, and the failure would be a 400 that wedges the card. The
 * dictionaries reaching here come from HubSpot property options and from ctx.labels, so this is a
 * boundary between user text and a lookup — the one place the check belongs.
 */
function has(d: Record<string, string>, key: string): boolean {
  return Object.hasOwn(d, key);
}

/** monday display text -> HubSpot internal value for one reversible field ("" if empty). */
export function reverseFieldValue(f: FieldSpec, mdText: string, ctx: Ctx): string {
  const text = mdText.trim();
  if (!text) return "";
  if (f.type === "people") return text; // the people diff's mdText already holds the HubSpot owner id
  // Phone: write a CANONICAL value, never monday's rendered column text. monday renders a phone column as
  // "<number> <countryShortName>" once a country is set (which is what a rep picking the flag produces), and
  // storing "12345678900 US" in HubSpot would poison dialer/marketing integrations — and it would never
  // self-repair, because the digits still match so no further diff is ever raised. Mirrors mapping.ts's
  // phone branch: keep a LEADING "+" (international), otherwise bare digits.
  if (f.type === "phone") {
    const digits = text.replace(/[^\d]/g, "");
    if (!digits) return "";
    return text.startsWith("+") ? "+" + digits : digits;
  }
  const rev = f.labels ? invert(ctx.labels[f.labels] ?? {}) : Object.create(null);
  if (f.type === "dropdown") {
    // NO DICTIONARY -> REFUSE, unless the field explicitly opts out (see FieldSpec.unvalidatedEnum).
    //
    // This used to comma-split and pass monday's text through raw, on the reasoning that a property
    // whose option values equal their labels needs no translation. True, and beside the point: nothing
    // was checking the text was an OPTION. monday lets a user add or rename a dropdown label and every
    // write we make sets create_labels_if_missing:true, so `department_3__c` (29 options) shipped able
    // to send an arbitrary label into a HubSpot enumeration — a 400 that throws before Sync State is
    // stamped and, with no CRM cron, freezes that card's every field. It now carries a dictionary.
    if (!f.labels) return f.unvalidatedEnum ? text.split(",").map(s => s.trim()).filter(Boolean).join(";") : "";
    if (has(rev, text)) return rev[text]; // whole-label match first (single value)
    // Multi-select: monday joins labels with ", ", and a label can itself contain a comma, so don't
    // blindly split on ",". Greedily consume the longest known label at a comma/end boundary; an unknown
    // label stops the scan (a raw monday label is not a valid HubSpot enum value -> 400 every tick).
    const labels = Object.keys(rev).filter(Boolean).sort((a, b) => b.length - a.length);
    const out: string[] = [];
    let rest = text;
    while (rest) {
      rest = rest.replace(/^\s*,\s*/, "");
      const hit = labels.find(l => rest.startsWith(l) && (rest.length === l.length || rest[l.length] === ","));
      if (!hit) break;
      out.push(rev[hit]);
      rest = rest.slice(hit.length);
    }
    return out.join(";");
  }
  // A link column's monday text is "<text> - <url>"; send the URL half, never the concatenation.
  // `canonicalDomain` additionally strips it to a bare registrable domain, because that value doubles
  // as the record's search key — see FieldSpec.canonicalDomain. "" when nothing usable survives, so
  // an unparseable cell is refused and healed forward rather than stored as junk.
  if (f.type === "link") return f.canonicalDomain ? companyDomainKey(linkReverse(text)) : linkReverse(text);
  // STATUS: only ever send a value HubSpot's enumeration actually accepts.
  //
  // This fell through to `rev[text] ?? text`, shipping whatever label the monday column held into a
  // HubSpot enum. A label a rep renamed or added — or a dictionary that has drifted — earned a 400, and
  // because Sync State is not stamped on a throw, that card's webhooks wedged PERMANENTLY. Refusing
  // (returning "") makes buildReversePatch omit the field; if the patch is then empty the engine falls
  // through to a FORWARD write, so HubSpot's value overwrites the invalid cell and the card self-heals.
  //
  // NO DICTIONARY -> REFUSE, unless the field explicitly opts out (FieldSpec.unvalidatedEnum). The
  // old text was "value === label by construction, so the raw text is already a legal value" — which
  // conflates translation with membership. `sales_person` is a 4-option enumeration (Elaine Rivera,
  // Emily You, Myla Mestiola, Rick Avery Antonio); a rep setting it to "Ada" or "Heifer" — the very
  // reassignment the 2026-09-09 requirements meeting is about — would have 400'd and wedged the card.
  if (f.type === "status") {
    if (!f.labels) return f.unvalidatedEnum ? text : "";
    if (has(rev, text)) return rev[text];                        // monday shows the LABEL — the normal case
    // monday's cell may already hold the INTERNAL VALUE: every write sets create_labels_if_missing, so a
    // value the dictionary could not resolve at write time became a label spelled as that raw value.
    // Accepting it keeps the function a fixed point on its own output, and refusing it would have
    // blocked exactly the records that most need repairing.
    if (has(ctx.labels[f.labels] ?? {}, text)) return text;
    return "";                                                   // genuinely unknown -> refuse
  }
  // NUMBERS: canonicalise, and refuse non-numeric rather than 400 on a HubSpot number property.
  if (f.type === "numbers") return numText(text);
  // VALIDATED TEXT: a monday TEXT column standing in for a HubSpot ENUMERATION.
  //
  // Four Contact fields are shaped this way — leadsource (210 options), countries (198),
  // lead_source_sub__c (558), city_1__c (673) — because monday cannot hold option sets that size: a
  // column cannot be retyped, the verified label ceiling on this account is 88, and
  // create_labels_if_missing:true on every write would grow a second permanent vocabulary in the
  // column. A text column shows the label and this branch validates it on the way back, which gets
  // two-way editing with none of that.
  //
  // Same two-clause shape as the status branch above, and the same reason for each clause: the cell
  // normally holds the LABEL, but it may already hold the internal VALUE for a record whose label the
  // dictionary could not resolve when it was written. Unknown text is REFUSED, which makes
  // buildReversePatch omit the field; an otherwise-empty patch then falls through to a forward write,
  // so HubSpot's value overwrites the invalid cell and the card self-heals instead of churning.
  //
  // Note this is fail-closed under my own uncertainty: if a dictionary is empty because its fetch
  // failed, every edit is refused and the field behaves exactly as it did while it was one-way. The
  // failure mode of being wrong here is a rejected edit, never a 400.
  if (f.type === "text" && f.labels) {
    if (has(rev, text)) return rev[text];
    if (has(ctx.labels[f.labels] ?? {}, text)) return text;
    return "";
  }
  return has(rev, text) ? rev[text] : text;
}

/** HubSpot PATCH body from monday-side values. Only reversible diffs are included. */
export function buildReversePatch(
  diffs: Diff[], item: MondayItem, spec: ObjectSpec, ctx: Ctx,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const d of diffs) {
    if (d.kind === "name" && spec.nameReverse) patch[spec.nameReverse] = item.name.trim();
    if (d.kind === "group" && "prop" in spec.groupBy && spec.groupBy.reverse) {
      const v = reverseGroup(spec, item.group.id);
      if (v) patch[spec.groupBy.prop] = v;
    }
    if (d.kind === "field" && (d.f?.reverse || d.f?.appReverse)) {   // the diff only exists when allowed
      if (d.viewTruncated) {
        console.log(`[reverse] field=${d.f.hs} type=${d.f.type} action=refused`
          + ` reason="monday shows only the first ${LONG_TEXT_MAX} chars of a longer HubSpot value;`
          + ` writing back would destroy the remainder"`);
        continue;
      }
      const v = reverseFieldValue(d.f, d.mdText, ctx);
      if (v) patch[d.f.hs] = v;
      // A NON-EMPTY cell that yields nothing was REFUSED (unknown status label, non-numeric number).
      // Logged, because the alternative is a value that silently never syncs. An empty cell is not a
      // refusal — that is the deliberate "a monday blank never clears HubSpot" rule.
      else if (d.mdText.trim())
        console.log(`[reverse] field=${d.f.hs} type=${d.f.type} action=refused`
          + ` reason="monday value is not valid for this HubSpot property"`
          + ` value=${JSON.stringify(d.mdText.slice(0, 60))}`);
    }
  }
  return patch;
}

/** monday update payload: ONLY the diffed fields (kind "field"). Name is applied via the item name
 * and group via move_item_to_group, so they're excluded. Leaving unchanged fields out prevents
 * clobbering monday-side edits to columns HubSpot doesn't own (people/phone/unmapped). */
export function buildUpdatePayload(
  diffs: Diff[], rec: HsRecord, spec: ObjectSpec, ctx: Ctx,
): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  for (const d of diffs) {
    if (d.kind === "field" && d.f) {
      const v = formatValue(d.f, rec.properties[d.f.hs], ctx);
      if (v !== null && v !== undefined) cv[d.f.col] = v;
    }
  }
  return cv;
}

/** HubSpot properties to CREATE a record from a new monday card: defaults + group value + name +
 * every reversible field the card has filled in. */
export function buildCreateProperties(item: MondayItem, spec: ObjectSpec, ctx: Ctx): Record<string, string> {
  const props: Record<string, string> = { ...(spec.createDefaults ?? {}) };
  if ("prop" in spec.groupBy && spec.groupBy.reverse) {
    const v = reverseGroup(spec, item.group.id);
    if (v) props[spec.groupBy.prop] = v;
  }
  if (spec.nameReverse && item.name.trim()) props[spec.nameReverse] = item.name.trim();
  for (const f of spec.fields) {
    if (!f.reverse) continue;
    // people: derive the HubSpot owner id from the assigned monday person (not the display-name text).
    const v = f.type === "people" ? firstPersonOwnerId(item, f.col, ctx)
                                  : reverseFieldValue(f, colText(item, f.col), ctx);
    if (v) props[f.hs] = v;
  }
  // Contacts: the item name is the First Name column. If a rep typed a FULL name there and left the
  // separate Last Name column empty, split it so HubSpot gets a clean first/last instead of the whole
  // name as firstname. When Last Name is filled, the columns are authoritative — don't second-guess them.
  if (spec.object === "contacts") {
    const parts = item.name.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1 && !props["lastname"]) {
      props["firstname"] = parts[0];
      props["lastname"] = parts.slice(1).join(" ");
    }
  }
  return props;
}
