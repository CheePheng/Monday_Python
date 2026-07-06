import type { HsRecord, ObjectSpec } from "./types";

export function targetGroup(rec: HsRecord, spec: ObjectSpec): string | null {
  if ("singleGroup" in spec.groupBy) return spec.groupBy.singleGroup;
  const v = rec.properties[spec.groupBy.prop];
  const mapped = v ? spec.groupBy.map[v] : undefined;   // empty OR unmapped value ->
  return mapped ?? spec.groupBy.fallbackGroup ?? null;  // fall back so the record isn't skipped
}

/** monday group id -> HubSpot group-by value (null when not applicable). */
export function reverseGroup(spec: ObjectSpec, groupId: string): string | null {
  if ("singleGroup" in spec.groupBy) return null;
  for (const [hsValue, gid] of Object.entries(spec.groupBy.map))
    if (gid === groupId) return hsValue;
  return null;
}
