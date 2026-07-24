import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "./types";
import { expectedText, formatValue, itemName } from "./mapping";
import { colText } from "./dedup";
import { reverseGroup, targetGroup } from "./routing";

export interface Diff {
  kind: "field" | "name" | "group";
  f?: FieldSpec;
  hsText: string;
  mdText: string;
  backfill?: boolean;
}

/** monday first-person in a people column -> HubSpot owner id (via email), or "" if none/unmapped. */
function firstPersonOwnerId(item: MondayItem, col: string, ctx: Ctx): string {
  const cv = item.column_values.find(c => c.id === col);
  const pid = cv?.persons_and_teams?.find(p => p.kind === "person")?.id;
  if (!pid) return "";
  const email = ctx.mondayEmailByUserId[String(pid)];
  return email ? (ctx.ownerIdByEmail[email.toLowerCase()] ?? "") : "";
}

export function fieldDiffs(rec: HsRecord, item: MondayItem, spec: ObjectSpec, ctx: Ctx): Diff[] {
  const out: Diff[] = [];
  for (const f of spec.fields) {
    if (f.type === "people") {
      // People columns aren't text-diffable by name. Empty column -> forward-fill from HubSpot (heal, e.g.
      // the "Sales Users" column on existing cards). Filled + reversible -> reverse by comparing the monday
      // person's OWNER ID to HubSpot's value (id compare, so a matching owner yields no diff -> no loop).
      if (!colText(item, f.col)) {
        if (formatValue(f, rec.properties[f.hs], ctx))
          out.push({ kind: "field", f, hsText: "(person)", mdText: "" });
      } else if (f.reverse) {
        const wantOwner = firstPersonOwnerId(item, f.col, ctx);
        const hsOwner = (rec.properties[f.hs] ?? "").trim();
        if (wantOwner && wantOwner !== hsOwner) out.push({ kind: "field", f, hsText: hsOwner, mdText: wantOwner });
      }
      continue;
    }
    const hsText = expectedText(f, rec.properties[f.hs], ctx);
    if (hsText === null) continue; // phone: not diffable
    if (hsText === "") {
      // Empty HubSpot value: normally we don't fight monday (no clear, no loop). EXCEPTION — controlled
      // backfill: an ALLOWLISTED reversible field on a DEAL whose card carries the matching HubSpot Deal ID
      // may FILL the empty HubSpot value from a non-empty monday value. Never the reverse (an empty monday
      // value never clears HubSpot), never for contacts/companies, never matched by name.
      if (f.backfill && f.reverse && spec.object === "deals" && colText(item, spec.idCol) === rec.id) {
        const md = colText(item, f.col);
        if (md) out.push({ kind: "field", f, hsText: "", mdText: md, backfill: true });
      }
      continue;
    }
    const mdText = colText(item, f.col);
    if (hsText !== mdText) out.push({ kind: "field", f, hsText, mdText });
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

function invert(dictionary: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [value, label] of Object.entries(dictionary)) out[label] = value;
  return out;
}

/** monday display text -> HubSpot internal value for one reversible field ("" if empty). */
export function reverseFieldValue(f: FieldSpec, mdText: string, ctx: Ctx): string {
  const text = mdText.trim();
  if (!text) return "";
  if (f.type === "people") return text; // the people diff's mdText already holds the HubSpot owner id
  const rev = f.labels ? invert(ctx.labels[f.labels] ?? {}) : {};
  if (f.type === "dropdown") {
    if (rev[text] !== undefined) return rev[text]; // whole-label match first (labels with commas)
    // Multi-select: map each label; DROP labels not in the dictionary rather than passing them raw
    // (a raw monday label is not a valid HubSpot enum value -> 400 that would retry every tick).
    return text.split(",").map(s => s.trim()).filter(Boolean)
      .map(s => rev[s]).filter((v): v is string => v !== undefined).join(";");
  }
  return rev[text] ?? text;
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
    if (d.kind === "field" && d.f?.reverse) {
      const v = reverseFieldValue(d.f, d.mdText, ctx);
      if (v) patch[d.f.hs] = v;
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
