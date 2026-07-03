import type { Ctx, FieldSpec, HsRecord, ObjectSpec } from "./types";

const dict = (f: FieldSpec, ctx: Ctx): Record<string, string> =>
  (f.labels ? ctx.labels[f.labels] : undefined) ?? {};

export function formatValue(f: FieldSpec, value: string | null | undefined, ctx: Ctx): unknown {
  if (value === null || value === undefined || value === "") return null;
  const v = String(value);
  switch (f.type) {
    case "text": return dict(f, ctx)[v] ?? v;
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
    case "phone": return { phone: v.replace(/[^\d+]/g, ""), countryShortName: "SG" };
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
  return cv;
}

/** Canonical text a monday column should show for this HubSpot value; null = not diffable. */
export function expectedText(f: FieldSpec, value: string | null | undefined, ctx: Ctx): string | null {
  if (f.type === "people" || f.type === "phone") return null;
  if (value === null || value === undefined || value === "") return "";
  const v = String(value);
  switch (f.type) {
    case "date": return v.slice(0, 10);
    case "status": case "text": return dict(f, ctx)[v] ?? v;
    case "dropdown":
      return v.split(";").map(s => s.trim()).filter(Boolean).map(s => dict(f, ctx)[s] ?? s).join(", ");
    default: return v;
  }
}
