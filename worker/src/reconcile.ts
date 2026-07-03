import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "./types";
import { expectedText, itemName } from "./mapping";
import { colText } from "./dedup";
import { reverseGroup, targetGroup } from "./routing";

export interface Diff {
  kind: "field" | "name" | "group";
  f?: FieldSpec;
  hsText: string;
  mdText: string;
}

export function fieldDiffs(rec: HsRecord, item: MondayItem, spec: ObjectSpec, ctx: Ctx): Diff[] {
  const out: Diff[] = [];
  for (const f of spec.fields) {
    const hsText = expectedText(f, rec.properties[f.hs], ctx);
    if (hsText === null) continue; // people/phone: not diffable
    const mdText = colText(item, f.col);
    if (hsText !== mdText && !(hsText === "" && mdText === "")) out.push({ kind: "field", f, hsText, mdText });
  }
  const wantName = itemName(rec, spec);
  if (wantName !== item.name.trim()) out.push({ kind: "name", hsText: wantName, mdText: item.name.trim() });
  const wantGroup = targetGroup(rec, spec);
  if (wantGroup && wantGroup !== item.group.id)
    out.push({ kind: "group", hsText: wantGroup, mdText: item.group.id });
  return out;
}

export function decideDirection(
  diffs: Diff[], hsModified: string | null | undefined, mdUpdated: string | null | undefined,
): "none" | "toMonday" | "toHubspot" {
  if (diffs.length === 0) return "none";
  return (Date.parse(mdUpdated ?? "") || 0) > (Date.parse(hsModified ?? "") || 0)
    ? "toHubspot" : "toMonday";
}

function invert(dictionary: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [value, label] of Object.entries(dictionary)) out[label] = value;
  return out;
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
      const rev = d.f.labels ? invert(ctx.labels[d.f.labels] ?? {}) : {};
      if (d.f.type === "dropdown") {
        const values = d.mdText.split(",").map(s => s.trim()).filter(Boolean).map(s => rev[s] ?? s);
        if (values.length) patch[d.f.hs] = values.join(";");
      } else {
        patch[d.f.hs] = rev[d.mdText] ?? d.mdText;
      }
    }
  }
  return patch;
}
