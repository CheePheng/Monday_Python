import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "./types";
import { LONG_TEXT_MAX, expectedText, fitItemName, formatValue, itemName, linkReverse, linkText, numText, phoneDigits, unapplyScale } from "./mapping";
import { colText } from "./dedup";
import { companyDomainKey } from "./adopt";
import { reverseGroup, targetGroup } from "./routing";
import { COARSE_STAGES, STAGE_ENTERED_PROP, coarseTargetsFor, type CoarseStage } from "./hubspot";

/** A HubSpot or Sync State time, ISO or epoch milliseconds -> ms; 0 when absent or unreadable. */
function timeOf(v: unknown): number {
  const s = String(v ?? "").trim();
  return (/^\d+$/.test(s) ? Number(s) : Date.parse(s)) || 0;
}

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
   *  honoured in buildReversePatch.
   *  Also set on a NAME diff while ITEM_NAME_FIT is on (Ctx.itemNameMax): HubSpot's name is longer than
   *  monday accepts, so the card can only ever show it fitted (fitItemName). */
  viewTruncated?: boolean;
  /** A People cell must be EMPTIED to match HubSpot: its person is not HubSpot's owner, and HubSpot's
   *  owner has no monday account (or there is no owner). formatValue has no value to write for that, so
   *  buildUpdatePayload writes an explicit clear. Column-level specs only. */
  peopleClear?: boolean;
}

/** The person ids in a People cell, sorted -- a set comparison, not "who is first". */
function personIds(item: MondayItem, col: string): string[] {
  const cv = item.column_values.find(c => c.id === col);
  return (cv?.persons_and_teams ?? []).filter(p => p.kind === "person").map(p => String(p.id)).sort();
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
      // COLUMN-LEVEL SPECS: compare the exact SET of people to the one HubSpot's owner resolves to.
      //
      // The record-level branch below only ever fills an EMPTY cell. Once a People cell held anyone, a
      // HubSpot change to that owner was never detected unless the field was reversible -- so Sales User
      // and owner columns were write-once from HubSpot. Contact 394787683005 is the live case: filled
      // with Myla on 2026-09-15, changed to Elaine in HubSpot at 2026-09-23T05:01Z, never updated. It is
      // also how a second person survived in an owner cell: "who is first" matched, so nothing moved.
      //
      // Safe here and ONLY here: a column-level spec never pushes from fieldDiffs (its push is built by
      // columnEditPatch from the edited column alone), so this diff can only ever repair monday. On the
      // record-level engine the same diff could reach buildReversePatch and send a stale owner to
      // HubSpot -- the 2026-08-28 silent-reassignment incident -- so that path is left exactly as it was.
      if (spec.columnLevelReverse) {
        const want = formatValue(f, rec.properties[f.hs], ctx) as { personsAndTeams?: { id: number }[] } | null;
        const wantIds = (want?.personsAndTeams ?? []).map(p => String(p.id)).sort();
        const have = personIds(item, f.col);
        if (have.join(",") !== wantIds.join(","))
          out.push({ kind: "field", f, hsText: String(rec.properties[f.hs] ?? ""), mdText: have.join(","),
            ...(wantIds.length ? {} : { peopleClear: true }) });
        continue;
      }
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
  // ITEM_NAME_FIT (ctx.itemNameMax): the name monday.ts writes is FITTED to monday's limit, so it is compared
  // fitted too. Compared in full, a card named from a HubSpot name past the limit would differ from it forever
  // and be renamed on every pass. Absent, the full name, exactly as before.
  const fullName = itemName(rec, spec);
  const wantName = ctx.itemNameMax ? fitItemName(fullName, ctx.itemNameMax) : fullName;
  if (wantName !== item.name.trim()) out.push({ kind: "name", hsText: wantName, mdText: item.name.trim(),
    ...(wantName !== fullName ? { viewTruncated: true } : {}) });
  // A placeOnly group is where a card is CREATED, never where it is kept: no group diff, so no move.
  // Without this, editing or updating any card sitting in a group a person chose dragged it back.
  const placeOnly = "singleGroup" in spec.groupBy && spec.groupBy.placeOnly;
  const wantGroup = placeOnly ? null : targetGroup(rec, spec);
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

/**
 * The currencies this portal's records actually carry -- every non-empty Deals and P&S currency cell on
 * 2026-09-23 was one of these (Deals 8,591 of 8,666 filled; P&S 9,968 of 9,970). A code the portal has
 * not enabled 400s the write, and on a monday-born create that loses the whole record, so anything else
 * is refused rather than guessed. Enabling a new currency in HubSpot means adding it here.
 */
export const PORTAL_CURRENCIES: ReadonlySet<string> = new Set(["CNY", "USD", "HKD", "SGD"]);

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
  // See FieldSpec.reverseAs. Checked before any dictionary: these fields deliberately have none.
  if (f.reverseAs === "currency") return PORTAL_CURRENCIES.has(text.toUpperCase()) ? text.toUpperCase() : "";
  if (f.reverseAs === "integer") {
    const n = text.replace(/[,\s]/g, "");
    return /^\d+$/.test(n) ? String(Number(n)) : "";
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
  // unapplyScale FIRST, so a scaled field (hs_deal_stage_probability: monday shows 20, HubSpot stores
  // 0.2) goes back in HubSpot's units. numText then canonicalises and rejects non-numeric exactly as
  // before, so an unscaled field is byte-for-byte unchanged.
  if (f.type === "numbers") return numText(unapplyScale(f, text));
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
    // A FIELD that carries the same property wins over the item name. CRM Accounts maps HubSpot `name` to
    // both the item name and a "Company name" column (no WM spec overlaps); a rep who edited the column
    // must not have it silently replaced by an unchanged title. fieldDiffs emits fields before the name,
    // so any field value is already in the patch by the time the name diff is reached.
    if (d.kind === "name" && spec.nameReverse && !(spec.nameReverse in patch)) {
      // A name the card shows only FITTED (ITEM_NAME_FIT; see fieldDiffs) is a partial view, exactly like the
      // long text below: written back, it would cut HubSpot's name down to what monday could hold.
      if (d.viewTruncated)
        console.log(`[reverse] field=${spec.nameReverse} type=name action=refused`
          + ` reason="monday shows only the first ${ctx.itemNameMax} chars of a longer HubSpot name;`
          + ` writing back would destroy the remainder"`);
      else patch[spec.nameReverse] = item.name.trim();
    }
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

  // Deliberately AFTER the loop, so it cannot be skipped by a `continue` in any refusal branch.
  applyStagePipelinePairing(patch, spec, ctx);
  return patch;
}

/**
 * THE STAGE AND ITS PIPELINE TRAVEL TOGETHER. See ObjectSpec.stagePipelinePairing.
 *
 * HubSpot rejects a dealstage that does not belong to the record's current pipeline, so the common
 * edit — a rep picking "SF-Maint / 赢单" on a deal currently in SF-Sales — fails if the stage goes
 * alone, and two PATCHes would leave the record holding an invalid pair in between. The pipeline is
 * therefore derived from the stage itself and always sent with it, whether or not the Pipeline
 * column changed. Acts only when the stage survived validation into the patch.
 *
 * Shared by the record-level and column-level builders so neither can send a bare stage.
 * Returns false when it had to DROP the stage, so a caller can report the refusal.
 */
function applyStagePipelinePairing(patch: Record<string, string>, spec: ObjectSpec, ctx: Ctx): boolean {
  const pair = spec.stagePipelinePairing;
  if (!pair || !patch[pair.stageProp]) return true;
  const pipelineId = ctx.pipelineByStage?.[patch[pair.stageProp]];
  if (pipelineId) { patch[pair.pipelineProp] = pipelineId; return true; }
  // Refusing the whole write is the safe direction: a stage with no known pipeline is one this
  // Worker has never seen, and sending it alone is the failure mode this pairing exists to stop.
  delete patch[pair.stageProp];
  return false;
}

/**
 * WHERE EACH OPTION OF AN ENUMERATION SITS IN HUBSPOT'S OWN ORDER (its `displayOrder`), carried ON the
 * label dictionary it was read with -- so it is fetched and cached exactly like the labels (buildCtx,
 * getCtxCached) and needs no second request or Ctx field.
 *
 * WHY A REGISTERED SYMBOL rather than a WeakMap in hubspot.ts beside COARSE_TARGETS: the reader is here,
 * and reconcile.ts must not import a new runtime value from hubspot.ts for it -- 36 test files replace
 * that module wholesale, and on a mocked module a missing export throws where it is used, i.e. on every
 * lifecycle edit those files drive. hubspot.ts's getPropertyOptions writes it under the SAME
 * `Symbol.for(OPTION_ORDER_KEY)` (pinned by lifecycle-backward-clear.test.ts, which reads a real
 * getPropertyOptions result back through optionOrderOf).
 *
 * NON-ENUMERABLE, so it is invisible to everything that treats the dictionary as value -> label:
 * Object.keys/entries, invert, `has` (Object.hasOwn on a string), JSON, toEqual. A COPY of the
 * dictionary does not carry it, and an absent order is never guessed: backwardClearPlan reports it as
 * unknown and the write goes as one PATCH, exactly as before.
 */
export const OPTION_ORDER_KEY = "dkm-crm-sync:hubspot-option-order";
const OPTION_ORDER = Symbol.for(OPTION_ORDER_KEY);

/** The displayOrder of each option value of this dictionary, or undefined when none was recorded. */
export function optionOrderOf(dict: Record<string, string> | undefined): Readonly<Record<string, number>> | undefined {
  return dict ? (dict as unknown as Record<symbol, Record<string, number> | undefined>)[OPTION_ORDER] : undefined;
}

/** Attach an order to a dictionary (getPropertyOptions does the same through the registered symbol). */
export function withOptionOrder<T extends Record<string, string>>(dict: T, order: Record<string, number>): T {
  Object.defineProperty(dict, OPTION_ORDER, { value: order, enumerable: false, configurable: true });
  return dict;
}

/** What has to go out BEFORE a patch, for the properties HubSpot only lets move forward. */
export interface BackwardClearPlan {
  /** The PATCH to send first: each property moving to an EARLIER option, set to "". Empty -> one PATCH. */
  clear: Record<string, string>;
  /** HubSpot's value before the clear, per cleared property: what a failed set puts back. */
  previous: Record<string, string>;
  /** Flagged properties whose move could not be placed in the order (none loaded, or a value outside it). */
  unknown: string[];
}

/**
 * DOES THIS PATCH MOVE A `backwardNeedsClear` PROPERTY TO AN EARLIER OPTION? See FieldSpec.backwardNeedsClear.
 *
 * Judged against `current` -- the record as HubSpot holds it now (the read this sync is working from) --
 * and the property's live displayOrder. Only a move to a strictly EARLIER position is a backward move:
 *   - a clear (""), a first fill (HubSpot empty) and an unchanged value are never one, so they keep the
 *     single PATCH they always had (HubSpot accepts all three);
 *   - a move it cannot place -- no order on the dictionary, or either value outside it -- is UNKNOWN: one
 *     PATCH, as before, and the caller logs it. Never a guessed clear: clearing a stage that HubSpot would
 *     then refuse to set again is worse than the no-op it replaces.
 * Pure; the caller sends.
 */
export function backwardClearPlan(spec: ObjectSpec, patch: Record<string, string>,
    current: Record<string, string | null | undefined>, ctx: Ctx): BackwardClearPlan {
  const out: BackwardClearPlan = { clear: {}, previous: {}, unknown: [] };
  const seen = new Set<string>();
  for (const f of spec.fields) {
    if (!f.backwardNeedsClear || seen.has(f.hs) || !Object.hasOwn(patch, f.hs)) continue;
    seen.add(f.hs);
    const to = String(patch[f.hs] ?? "").trim();
    const from = String(current[f.hs] ?? "").trim();
    if (!to || !from || to === from) continue;
    const order = f.labels ? optionOrderOf(ctx.labels[f.labels]) : undefined;
    const at = (v: string) => order && Object.hasOwn(order, v) ? order[v] : undefined;
    const fromAt = at(from), toAt = at(to);
    if (fromAt === undefined || toAt === undefined) { out.unknown.push(f.hs); continue; }
    if (toAt < fromAt) { out.clear[f.hs] = ""; out.previous[f.hs] = from; }
  }
  return out;
}

/**
 * THE SHAPE A BACKWARD MOVE LEAVES WHEN ITS CLEAR LANDED AND ITS SET DID NOT: a `backwardNeedsClear` field
 * HubSpot holds EMPTY while the card shows a stage that translates back to one of its options. Each, with
 * the value the card would send. Pure; whether the empty value really is our clear is the history's to
 * say (danglingClearVerdict), and the caller reads that only for what this returns.
 *
 * Nothing else ever repairs this state: an empty HubSpot value never raises a forward diff (it must not
 * blank a monday cell), and only a person's edit of the column itself would push it.
 */
export function emptiedFlaggedFields(spec: ObjectSpec, rec: HsRecord, card: MondayItem, ctx: Ctx):
    { f: FieldSpec; value: string }[] {
  const out: { f: FieldSpec; value: string }[] = [];
  const seen = new Set<string>();
  for (const f of spec.fields) {
    if (!f.backwardNeedsClear || !f.reverse || seen.has(f.hs)) continue;
    seen.add(f.hs);
    if (String(rec.properties[f.hs] ?? "").trim()) continue;
    const value = reverseFieldValue(f, colText(card, f.col), ctx);
    if (value) out.push({ f, value });
  }
  return out;
}

/**
 * How long after OUR clear the re-check may still finish it from the card: comfortably past the deferred
 * queue's worst-case drain (MAX_QUEUE / WAVE x WAVE_GAP_MS, about 55 minutes), short enough that an old
 * empty stage some integration left long ago is never "finished" by this Worker.
 */
export const DANGLING_CLEAR_WINDOW_MS = 6 * 60 * 60_000;

/** One version of a property, as propertiesWithHistory lists it (hubspot.ts's PropertyVersion). */
export interface HistoryVersion { value: string; timestamp: string; sourceType: string; sourceId?: string }

/**
 * IS THIS EMPTY VALUE A CLEAR AN INTEGRATION MADE, MOMENTS AGO, OF A VALUE THAT WAS SET? null when it is
 * -- the re-check may then send the card's value -- otherwise why not, for the log. Pure.
 *
 * "An integration", not "this Worker": HubSpot's history names the app only by an id this Worker is never
 * told (sourceId; the token's own identity does not carry it), so the window and the ownership check the
 * caller makes (a CRM-owned record) are what keep it to our own clears. A PERSON's clear (CRM_UI), a
 * workflow's or an import's is never touched: that empty value is theirs, and stays.
 *
 * `syncedAtMs`, the card's Sync State: a clear NOT NEWER than it is one monday already took, never a move's
 * half. A person who empties the cell on monday sends one PATCH of "" -- recorded as an INTEGRATION clear of
 * a set value, the same shape -- and that push stamps Sync State with the lastmodifieddate it set, which is
 * the clear's own history timestamp (read live 2026-10-01: INTEGRATION 03:10:17.297 and CRM_UI 03:12:57.175
 * appear identically in lifecyclestage's and lastmodifieddate's histories). A dangling clear always leaves
 * Sync State strictly before it: the move's run holds it back (ColumnPush.pending), or died before stamping.
 * Without this, a stage our own token or anything else later put in that emptied cell was sent to HubSpot as
 * a "repair" (PROBE B). Not given, or unreadable: the other rules decide, as before.
 */
export function danglingClearVerdict(history: readonly HistoryVersion[], nowMs: number, syncedAtMs?: number): string | null {
  const byTime = [...history].sort((a, b) => timeOf(b.timestamp) - timeOf(a.timestamp));
  const [newest, before] = byTime;
  if (!newest) return "HubSpot reports no history for it";
  if (newest.value.trim()) return `HubSpot's newest version is ${JSON.stringify(newest.value)}, not empty`;
  if (newest.sourceType !== "INTEGRATION")
    return `emptied by ${newest.sourceType || "an unknown source"}${newest.sourceId ? ` (${newest.sourceId})` : ""}, not by an integration`;
  if (!before || !before.value.trim()) return "nothing was cleared: it held no value before";
  if (syncedAtMs !== undefined && Number.isFinite(syncedAtMs) && timeOf(newest.timestamp) <= syncedAtMs)
    return `the clear (${newest.timestamp}) is not newer than Sync State (${new Date(syncedAtMs).toISOString()}):`
      + ` monday already took it -- a clear sent from monday, not a move's unfinished half`;
  const age = nowMs - timeOf(newest.timestamp);
  if (!(age <= DANGLING_CLEAR_WINDOW_MS))
    return `the clear is ${Math.round(age / 60_000)} min old, past the ${DANGLING_CLEAR_WINDOW_MS / 60_000}-min window`;
  return null;
}

/** What a column-level edit resolves to. See ObjectSpec.columnLevelReverse. */
export interface ColumnEditResult {
  /** HubSpot properties to write -- ONLY those the person's edited columns map to. "" clears. */
  patch: Record<string, string>;
  /** Edited fields that could NOT be sent. Their cells are brought back into line with HubSpot, so the
   *  person sees at once that the edit did not take instead of believing it saved. */
  heal: FieldSpec[];
  /** The edited item name could not be sent (no nameReverse, or it was emptied). */
  healName: boolean;
  /** One human-readable reason per refusal, for the log. */
  refusals: string[];
  /**
   * Columns this change did NOT edit that the same run's forward pass must leave alone: each holds a
   * person's edit still on its way, in its own run, and writing HubSpot's value over it would revert that
   * edit before its run reads it. Set only by coarseStageEdit (the HubSpot Stage cell); absent otherwise.
   */
  hold?: string[];
}

/**
 * THE PATCH FOR EXACTLY WHAT A PERSON EDITED. Every other column on the card is ignored, however
 * stale -- see ObjectSpec.columnLevelReverse for why that is the whole point.
 *
 * Differences from buildReversePatch, each deliberate:
 *   - It reads the edited cells directly rather than filtering `fieldDiffs`, because fieldDiffs hides the
 *     two cases this path exists for: an EMPTY monday cell (a clear) and an EMPTY HubSpot value (a first
 *     fill). Both are unambiguous once we know the person edited that very column.
 *   - `appReverse` counts as two-way. It was introduced so a PASSIVE reconcile could never push a stale
 *     owner (the 2026-08-28 silent-reassignment incident). A person editing the owner column is not
 *     passive, and column-level reverse cannot push a column nobody touched, so the incident's mechanism
 *     does not exist on this path.
 *   - A person's edit that cannot be sent is reported in `heal` instead of silently dropped.
 *
 * Unchanged guarantees: an unknown status/dropdown label, a non-numeric number, or a person with no
 * HubSpot user is REFUSED, never guessed; a long text HubSpot holds beyond monday's 2000 characters is
 * never written back; a deal stage never travels without its pipeline; the item name is never cleared,
 * and (ITEM_NAME_FIT) never replaces a HubSpot name longer than monday's 255 from its fitted copy.
 */
export function columnEditPatch(rec: HsRecord, item: MondayItem, spec: ObjectSpec, ctx: Ctx,
    edit: { cols: string[]; name?: boolean; removedPeople?: Record<string, string[]>; byAutomation?: boolean }):
    ColumnEditResult {
  const out: ColumnEditResult = { patch: {}, heal: [], healName: false, refusals: [] };
  const edited = new Set(edit.cols);
  const raw = (p: string) => String(rec.properties[p] ?? "").trim();
  const coarse = coarseStageField(spec);

  for (const f of spec.fields) {
    if (!edited.has(f.col)) continue;
    // The native coarse Stage is resolved AFTER every other edited column: the stage it sends depends on
    // a Pipeline edit made in the same change, and it yields to an exact-stage edit made in it.
    if (f === coarse) continue;
    const refuse = (why: string) => { out.heal.push(f); out.refusals.push(`${f.hs}: ${why}`); };

    if (!(f.reverse || f.appReverse)) { refuse("column is one-way (HubSpot -> monday)"); continue; }
    const hs = raw(f.hs);

    if (f.type === "people") {
      const cv = item.column_values.find(c => c.id === f.col);
      const hasPerson = !!cv?.persons_and_teams?.some(p => p.kind === "person");
      /**
       * AN EMPTIED CELL CLEARS HUBSPOT ONLY WHEN THE PERSON REMOVED *HUBSPOT'S* OWNER.
       *
       * Three cases that used to clear and must not:
       *   - a TEAM left in the cell: HubSpot cannot hold a team, so it is refused and the cell healed;
       *   - a SEATLESS owner (joan zhang, 小优, archived owners): shown as an empty cell since the
       *     2026-09-23 decision, so an event on that cell says nothing about the owner (~1,800 contacts);
       *   - a STALE cell: it showed Myla while HubSpot already had Elaine (People cells were write-once
       *     under the old engine). Removing Myla is not removing Elaine; the cell is healed to Elaine.
       * `removedPeople` comes from monday's before/after for every event in this run. When monday did
       * not send the before-side, the displayable-owner rule alone applies, as before.
       */
      if (!hasPerson) {
        if (cv?.persons_and_teams?.some(p => p.kind === "team")) { refuse("a monday team cannot be a HubSpot owner"); continue; }
        if (!hs) continue;
        const shown = formatValue(f, rec.properties[f.hs], ctx) as { personsAndTeams?: { id: number }[] } | null;
        if (shown === null) continue;                            // seatless: nothing monday showed was removed
        const removed = edit.removedPeople?.[f.col];
        const shownId = String(shown.personsAndTeams?.[0]?.id ?? "");
        if (removed && !removed.includes(shownId)) {
          refuse("the person removed is not HubSpot's current owner (the cell was out of date)"); continue;
        }
        out.patch[f.hs] = "";
        continue;
      }
      const owner = firstPersonOwnerId(item, f.col, ctx);
      if (!owner) { refuse("that person has no HubSpot user to assign"); continue; }
      if (owner !== hs) out.patch[f.hs] = owner;
      continue;
    }

    if (f.type === "long_text" && String(rec.properties[f.hs] ?? "").length > LONG_TEXT_MAX) {
      refuse(`HubSpot holds more than the ${LONG_TEXT_MAX} characters monday can show; writing back would destroy the rest`);
      continue;
    }

    const md = colText(item, f.col);
    if (!md.trim()) { if (hs) out.patch[f.hs] = ""; continue; }            // emptied -> clear
    const v = reverseFieldValue(f, md, ctx);
    if (!v) { refuse(`"${md.slice(0, 60)}" is not a valid value for this HubSpot property`); continue; }
    if (v !== hs) out.patch[f.hs] = v;
  }

  if (edit.name) {
    const name = item.name.trim();
    if (!spec.nameReverse) { out.healName = true; out.refusals.push("item name is one-way"); }
    else if (!name) { out.healName = true; out.refusals.push("item name cannot be emptied"); }
    /**
     * ITEM_NAME_FIT (ctx.itemNameMax): HubSpot's name is longer than monday accepts, so the card can only ever
     * hold it FITTED (fitItemName) -- the long-text rule above, for the name. The fitted name itself is no
     * change, and sends nothing. Any other rename would replace HubSpot's whole name on the strength of a
     * cut-down copy of it, so it is refused, and the heal shows the fitted name again.
     */
    else if (ctx.itemNameMax && raw(spec.nameReverse).length > ctx.itemNameMax) {
      if (name !== fitItemName(raw(spec.nameReverse), ctx.itemNameMax)) {
        out.healName = true;
        out.refusals.push("HubSpot's name is longer than monday can show; rename it in HubSpot");
      }
    }
    else if (name !== raw(spec.nameReverse)) out.patch[spec.nameReverse] = name;
  }

  if (coarse && edited.has(coarse.col)) coarseStageEdit(rec, item, spec, ctx, edit, coarse, out);

  if (!applyStagePipelinePairing(out.patch, spec, ctx)) {
    const stage = spec.fields.find(f => f.hs === spec.stagePipelinePairing!.stageProp);
    if (stage) out.heal.push(stage);
    out.refusals.push("deal stage has no known pipeline, so it cannot be sent");
  }
  return out;
}

/**
 * The spec's native COARSE Stage field: the status column bucketed through `crmCoarseStage` (the Deals
 * board's `deal_stage`), summarising the paired stage property. Undefined on every other spec.
 */
export function coarseStageField(spec: ObjectSpec): FieldSpec | undefined {
  const pair = spec.stagePipelinePairing;
  if (!pair) return undefined;
  return spec.fields.find(f => f.labels === "crmCoarseStage" && f.hs === pair.stageProp);
}

/** The spec's EXACT two-way stage field (the Deals board's "HubSpot Stage" dropdown), beside the coarse one. */
export function exactStageField(spec: ObjectSpec): FieldSpec | undefined {
  const pair = spec.stagePipelinePairing;
  if (!pair) return undefined;
  const coarse = coarseStageField(spec);
  return spec.fields.find(f => f !== coarse && f.hs === pair.stageProp && (f.reverse || f.appReverse));
}

/**
 * A PERSON'S EDIT OF THE NATIVE COARSE STAGE, as an exact stage. STAGE_COARSE_REVERSE.
 *
 * WHERE THE FLAG LIVES. The field stays `oneWay` in the spec, and the webhook is the only way a column
 * edit reaches this function: it ignores this column unless STAGE_COARSE_REVERSE is "true", and even then
 * passes on only a PERSON's edit -- an automation's (31010016 sets Stage = New on every new card, cards
 * this Worker makes from HubSpot deals included) and our own token's echoes are dropped there, exactly as
 * they are with the flag off. So with the flag off nothing here runs.
 *
 * MANY-TO-ONE, SO ONLY ONE WAY BACK IS SAFE. Five labels summarise 42 stages across 5 pipelines, and the
 * inverse is chosen, never guessed:
 *   - the pipeline is the deal's CURRENT one (HubSpot's; the card's Pipeline cell only when HubSpot has
 *     none), or the one a Pipeline edit in this same change sends -- otherwise the pairing below would put
 *     the deal straight back and silently drop that edit. A label never moves a deal between pipelines.
 *   - HubSpot's stage ALREADY reads as that label, in that pipeline: nothing is sent. The exact stage a
 *     person or HubSpot chose inside the bucket is kept, and HubSpot's Won/Lost automations do not fire
 *     again for a deal that is already Won or Lost.
 *   - otherwise a stage coarseStageOf puts in that bucket, by displayOrder (coarseStageTargets): the
 *     pipeline's first closed-won stage for Won, its LAST other closed stage for Lost (输单, not the 暂停
 *     before it), the first open stage of the third for New / Proposal / Negotiation. It reads back as the
 *     same label, so nothing churns.
 *   - stagePipelinePairing then sends the pipeline with it, as for every stage write.
 *
 * A PAUSED DEAL (暂停) ALREADY READS AS Lost, so Lost on it sends nothing, like any stage already in its
 * bucket: this column cannot tell Paused from Lost, and does not pretend to. HubSpot Stage can.
 *
 * REFUSED, and the cell snapped back to HubSpot's coarse value (the ordinary heal) -- EXCEPT onto Won,
 * see NEVER A SNAP-BACK ONTO Won below, and never onto the label the cell already shows:
 *   - anything but the five labels: the column's leftovers (Discovery, Appointment Scheduled, Presentation
 *     Scheduled, Closed Lost) and a blank -- a deal cannot be without a stage;
 *   - an edit that carries the exact "HubSpot Stage" column too: the exact stage is authoritative and wins,
 *     and the heal then shows the bucket of the stage it sent;
 *   - a card whose HubSpot Stage cell names a stage HubSpot does not hold: an exact edit still on its way
 *     in another run, or a card behind HubSpot ON THE STAGE (judged by the stage's own time, never by
 *     hs_lastmodifieddate). The exact stage wins that too, and this edit cannot know which stage it would
 *     be moving away from. On a card in line with HubSpot on the stage it is the former: the cell is NOT
 *     healed, the exact edit's own run brings it into line, and this run's forward pass keeps off that
 *     edit (`hold`; see the check itself);
 *   - an edit marked as an automation's (only reachable when a stalled create's queued person edits are
 *     taken over by an automation's event, see createWindowFor): fail closed, never a push;
 *   - no pipeline, no loaded stage order, or no stage in that bucket: nothing is guessed.
 *
 * NEVER A SNAP-BACK ONTO Won. A heal is a monday write by our token, and monday runs a board's automations
 * on API writes too: on this board a change to Won runs 31010010 (a "has been won" notification to every
 * subscriber of the board) and 31010017 (a NEW "Client Project" item on board 5028000491). Snapping a
 * refused edit back onto a deal that was already Won would therefore notify everyone again and create a
 * duplicate project -- on every refused edit, and people do pick the leftover labels (Discovery among
 * them). So when the value the heal would write is Won and the card had ALREADY received a Won stage from
 * HubSpot before this edit (lastShown: HubSpot's stage on a card in line with it on the stage, the HubSpot
 * Stage cell's on a card behind it on the stage), the cell is LEFT as the person set it and the refusal
 * says so. That is what the
 * flag-off Worker does with every edit of this column: it ignores it, and the card shows Won again only
 * when HubSpot next changes (reconcileForwardOnly) -- the same single, later forward write as today.
 * The heals onto Won that ARE written are news, exactly what the forward pass would write: a deal becoming
 * Won in this very change (a same-change exact edit sent a Won stage), and a Won HubSpot has that the card
 * never showed (HubSpot closed the deal and a person edited this cell before that webhook was served --
 * withholding it there lost the Won for good, since this run's forward pass buries HubSpot's change).
 * sync.ts heals the edited columns itself when HubSpot rejects the PATCH or the claim is refused; those
 * heals are held to the same rule in buildUpdatePayload (see wonHealWithheld).
 */
function coarseStageEdit(rec: HsRecord, item: MondayItem, spec: ObjectSpec, ctx: Ctx,
    edit: { cols: string[]; byAutomation?: boolean }, coarse: FieldSpec, out: ColumnEditResult): void {
  const pair = spec.stagePipelinePairing!;
  const hsStage = String(rec.properties[pair.stageProp] ?? "").trim();
  const bucketOf = (stage: string) => stage ? ctx.labels.crmCoarseStage?.[stage] : undefined;
  const exact = exactStageField(spec);
  const exactEdited = !!exact && edit.cols.includes(exact.col);
  const md = colText(item, coarse.col);
  // The stage the card's HubSpot Stage cell names ("" when it names none this Worker knows).
  const shownExact = exact ? colText(item, exact.col) : "";
  const pending = exact && shownExact ? reverseFieldValue(exact, shownExact, ctx) : "";
  /**
   * THE CARD IS BEHIND HUBSPOT ON THE STAGE: the deal entered its current stage after the card's Sync
   * State (STAGE_ENTERED_PROP), so HubSpot's stage change is not on the card yet. reconcileColumnEdit's
   * forward pass then rewrites every column this edit did NOT touch, the HubSpot Stage cell among them, and
   * moves Sync State up to HubSpot's change; so the later webhook of that change finds nothing newer.
   * Whatever this column is to show of that change, the heal below is the only write that can bring it.
   *
   * JUDGED BY THE STAGE'S OWN TIME, NEVER BY hs_lastmodifieddate. That moves for everything -- a
   * customer's email reply (a rollup no webhook reports), a post-create recalculation, a clone -- and a
   * card stays behind for it until HubSpot's next reported change: live 2026-10-01, 29 of the 150 cards
   * last worked, days to months, the stage having moved on ONE of them. On the other 28 the HubSpot Stage
   * cell is not HubSpot's previous stage but HubSpot's own, or a person's edit of it still on its way.
   * Read as "behind", a rep's two clicks (Stage, then HubSpot Stage) had our token write Won again
   * (31010010 notify, 31010017 a duplicate Client Project) and the HubSpot Stage edit thrown away.
   * No stage time at all is no evidence of a stage change: in line, the direction that writes nothing.
   */
  const stageBehind = timeOf(rec.properties[STAGE_ENTERED_PROP]) > timeOf(colText(item, spec.syncStateCol));
  /**
   * THE HUBSPOT STAGE CELL HOLDS A PERSON'S EDIT STILL ON ITS WAY: it names a stage HubSpot does not hold
   * on a card in line with HubSpot on the stage, and this change does not carry it -- that edit's own run
   * sends it. HELD from this run's forward pass, whatever this column's own verdict below: when HubSpot
   * changed anything else since Sync State that pass rewrites every column this edit did not touch, and
   * would put HubSpot's stage back over the edit before its run reads it. reconcileColumnEdit then also
   * leaves Sync State where it is, so were the stage time ever to lag a real stage change (it is a
   * calculated property), that change's own webhook would still bring it -- nothing is buried.
   */
  if (exact && !exactEdited && pending && pending !== hsStage && !stageBehind) (out.hold ??= []).push(exact.col);
  /**
   * WHAT THE CARD LAST RECEIVED FROM HUBSPOT, which is what "already Won" is judged by -- not HubSpot's
   * stage now. In line with HubSpot on the stage, it is HubSpot's stage (a HubSpot Stage cell that differs
   * is a person's edit, not something the card received). Behind it on the stage, it is the stage the
   * HubSpot Stage cell still shows (a forward pass writes that cell and this one together), unless a
   * person is editing that cell in this very change, or it names no single stage this column buckets
   * (empty, unknown text, two labels); then HubSpot's, as before.
   */
  const lastShown = stageBehind && !exactEdited && bucketOf(pending) ? pending : hsStage;
  const wasWon = bucketOf(lastShown) === "Won";
  /** `heal: false`: the exact stage's own run brings this cell into line (see the pending check below). */
  const refuse = (why: string, o: { heal?: boolean } = {}) => {
    const reason = `${coarse.hs} via ${coarse.col}: ${why}`;
    if (o.heal === false) {
      out.refusals.push(`${reason}; left as set: the HubSpot Stage edit's own run sends that stage and brings`
        + ` this cell into line`);
      return;
    }
    // What the heal would write: HubSpot's stage after this change -- the one a same-change exact edit
    // put in the patch, if it did, else HubSpot's own.
    const healsTo = bucketOf(out.patch[pair.stageProp] || hsStage);
    // A heal onto the label the cell already shows writes nothing new -- and onto Won it is still a write
    // of Won, by our token, on a board whose automations run on Won. Not made.
    if (healsTo && md === healsTo) {
      out.refusals.push(`${reason}; not healed: the cell already shows ${healsTo}`);
      return;
    }
    if (healsTo === "Won" && wasWon) {
      out.refusals.push(`${reason}; left as set, not snapped back: the deal is already Won, and writing Won`
        + ` re-runs the board's Won automations (31010010 notify, 31010017 Client Project)`);
      return;
    }
    out.heal.push(healsTo === "Won" ? vouchWonHeal(coarse) : coarse);
    out.refusals.push(reason);
  };

  if (edit.byAutomation) { refuse("an automation's edit of the Stage column is never sent"); return; }
  if (exactEdited) {
    refuse("HubSpot Stage was edited in the same change, and the exact stage wins");
    return;
  }
  const label = (COARSE_STAGES as readonly string[]).includes(md) ? md as CoarseStage : undefined;
  if (!label) {
    refuse(md ? `"${md.slice(0, 60)}" is not one of the five Stage labels (${COARSE_STAGES.join(", ")})`
      : "the Stage cannot be emptied: a deal always has a stage");
    return;
  }
  /**
   * THE HUBSPOT STAGE CELL NAMES A STAGE HUBSPOT DOES NOT HOLD, so the exact stage wins -- and which of
   * two things this is decides whether to heal:
   *   - the card is in line with HubSpot on the stage (whatever else HubSpot changed since): that cell is
   *     a person's HubSpot Stage edit still on its way, in its own run, and held from this run's forward
   *     pass (see `hold` above). That run sends it, and its forward pass then brings this cell into line
   *     (fieldDiffs compares first, so it never writes Won onto Won). A heal here would write the bucket
   *     of the stage HubSpot is about to leave: Stage = Won and then HubSpot Stage = Closed Won, a second
   *     apart, went Won -> Negotiation -> Won by our token -- a second Won notification, a duplicate Client
   *     Project. So the cell is left as set, as the flag-off Worker leaves every edit of it.
   *   - the card is behind HubSpot on the stage: that cell shows HubSpot's previous stage, and HubSpot's
   *     change is not on the card yet. Healed to it -- onto Won too when the card never showed Won (see
   *     lastShown): a HubSpot user's 赢单 with a person's Stage edit before its webhook used to be
   *     swallowed for good.
   */
  if (pending && pending !== hsStage) {
    refuse(`HubSpot Stage shows "${shownExact.slice(0, 60)}", which HubSpot does not hold: the exact stage wins`,
      { heal: stageBehind });
    return;
  }
  const pipeField = spec.fields.find(f => f.hs === pair.pipelineProp);
  const pipeline = out.patch[pair.pipelineProp]
    || String(rec.properties[pair.pipelineProp] ?? "").trim()
    || (pipeField ? reverseFieldValue(pipeField, colText(item, pipeField.col), ctx) : "");
  if (!pipeline) { refuse("the deal's pipeline is unknown, so no stage can be chosen in it"); return; }
  const where = `[reverse] object=${spec.object} hubspot_id=${rec.id} monday_item=${item.id} col=${coarse.col}`
    + ` label=${label} pipeline=${pipeline}`;
  if (hsStage && ctx.pipelineByStage?.[hsStage] === pipeline && ctx.labels.crmCoarseStage?.[hsStage] === label) {
    console.log(`${where} stage=${hsStage} action=coarse-in-bucket reason="HubSpot's stage already reads as ${label}; nothing to send"`);
    return;
  }
  const targets = coarseTargetsFor(ctx.labels.crmCoarseStage);
  if (!targets) { refuse("the pipelines' stage order is not loaded, so no stage of the bucket can be chosen"); return; }
  const target = targets[pipeline]?.[label];
  if (!target) { refuse(`pipeline ${pipeline} has no stage that reads as ${label}`); return; }
  out.patch[pair.stageProp] = target;
  console.log(`${where} stage=${target} previous=${hsStage || "-"} action=coarse-mapped`);
}

/**
 * The heals of the coarse Stage that MAY write Won: a copy of the field, made by coarseStageEdit only for
 * a deal that becomes Won in the very change being healed. Keyed by object identity, so nothing else --
 * the spec's own field in particular -- can ever carry the permission.
 */
const WON_HEAL_VOUCHED = new WeakSet<FieldSpec>();
function vouchWonHeal(coarse: FieldSpec): FieldSpec {
  const f = { ...coarse };
  WON_HEAL_VOUCHED.add(f);
  return f;
}

/**
 * THE BACKSTOP FOR "NEVER A SNAP-BACK ONTO Won" (see coarseStageEdit): is this diff a heal of the spec's
 * coarse Stage that would write Won without coarseStageEdit having vouched for it?
 *
 * A HEAL IS A DIFF WITH NO hsText. sync.ts builds its heals that way (`hsText: ""`), and fieldDiffs never
 * raises one for this column: a deal with no stage has no expected text and is skipped, and the column is
 * not `reverse`, so it takes no backfill. The heals this catches are the ones coarseStageEdit cannot see:
 * sync.ts heals every edited column when HubSpot rejects the PATCH or the claim is refused, and then the
 * value written is HubSpot's unchanged stage -- so a Won there is a deal that was already Won.
 *
 * With STAGE_COARSE_REVERSE off no edit of the column reaches a sync, and the only other heal of it (a
 * stage the pairing could not place, in columnEditPatch) cannot happen on Deals: the exact dropdown's
 * values and pipelineByStage are built from the same pipelines response, stage by stage.
 */
function wonHealWithheld(d: Diff, v: unknown, coarseCol: string | undefined): boolean {
  if (!coarseCol || d.hsText || !d.f || d.f.col !== coarseCol) return false;
  return (v as { label?: unknown } | null)?.label === "Won" && !WON_HEAL_VOUCHED.has(d.f);
}

/** monday update payload: ONLY the diffed fields (kind "field"). Name is applied via the item name
 * and group via move_item_to_group, so they're excluded. Leaving unchanged fields out prevents
 * clobbering monday-side edits to columns HubSpot doesn't own (people/phone/unmapped). */
export function buildUpdatePayload(
  diffs: Diff[], rec: HsRecord, spec: ObjectSpec, ctx: Ctx,
): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  const coarseCol = coarseStageField(spec)?.col;
  for (const d of diffs) {
    if (d.kind === "field" && d.f) {
      // Same clear the live "Shared" column uses (maintainShared). A People cell showing someone who is
      // not HubSpot's owner is wrong, and empty is the honest state when the owner has no monday seat.
      if (d.peopleClear) { cv[d.f.col] = { personsAndTeams: [] }; continue; }
      const v = formatValue(d.f, rec.properties[d.f.hs], ctx);
      if (wonHealWithheld(d, v, coarseCol)) {
        console.log(`[reverse] object=${spec.object} hubspot_id=${rec.id} col=${d.f.col} action=won-heal-withheld`
          + ` reason="the deal is already Won: snapping the cell back to Won would re-run the board's Won`
          + ` automations (31010010 notify, 31010017 Client Project); the cell is left as the person set it"`);
        continue;
      }
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
    // `writeOnCreate` is birth-only: it widens THIS builder and nothing else, so the field stays out of
    // every later reverse patch. See FieldSpec.writeOnCreate — it exists so a forward-only dedup key
    // (Contacts `email`) can be present at birth without becoming monday-writable forever after.
    // A column-level spec also carries appReverse fields at birth (Contact / Company / Deal owner): a rep
    // filling in the Create form chose them on purpose, and leaving them out would create an unowned
    // record -- which the People forward rule would then 'correct' by CLEARING the rep's choice.
    if (!f.reverse && !f.writeOnCreate && !(spec.columnLevelReverse && f.appReverse)) continue;
    // people: derive the HubSpot owner id from the assigned monday person (not the display-name text).
    const v = f.type === "people" ? firstPersonOwnerId(item, f.col, ctx)
                                  : reverseFieldValue(f, colText(item, f.col), ctx);
    if (v) props[f.hs] = v;
  }
  /**
   * A DEAL MUST BE BORN WITH A STAGE THAT BELONGS TO ITS PIPELINE.
   *
   * The same rule the update path enforces (see the pairing block in buildReversePatch) applies at
   * creation, and was missing here: a create emitted whatever `pipeline` the rep picked alongside
   * whatever `dealstage` they picked, and HubSpot rejects a pair that does not match. The stage is
   * authoritative because it names exactly one pipeline; the Pipeline column cannot disambiguate a
   * stage label that three Salesforce pipelines share.
   *
   * Only when a stage actually survived into the payload — a create with no stage at all is left for
   * `createDefaults` to answer, not for this to guess.
   */
  const pair = spec.stagePipelinePairing;
  if (pair && props[pair.stageProp]) {
    const pipelineId = ctx.pipelineByStage?.[props[pair.stageProp]];
    if (pipelineId) props[pair.pipelineProp] = pipelineId;
    else {
      // A stage this Worker has never seen cannot be paired, and sending it alone is the 400 the
      // pairing exists to prevent. Fall back to the spec's declared default PAIR — restoring, not
      // deleting, because createDefaults was spread in first and a bare delete would leave the record
      // with no stage at all.
      const dflt = spec.createDefaults ?? {};
      console.log(`[create] object=${spec.object} action=unpairable-stage`
        + ` stage=${JSON.stringify(props[pair.stageProp]).slice(0, 60)}`
        + ` fallback=${dflt[pair.stageProp] ? "createDefaults" : "none"}`
        + ` reason="stage has no known pipeline"`);
      if (dflt[pair.stageProp]) props[pair.stageProp] = dflt[pair.stageProp];
      else delete props[pair.stageProp];
      if (dflt[pair.pipelineProp]) props[pair.pipelineProp] = dflt[pair.pipelineProp];
    }
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
