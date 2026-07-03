import type { HsRecord, ObjectSpec } from "./types";

export function targetGroup(rec: HsRecord, spec: ObjectSpec): string | null {
  if ("singleGroup" in spec.groupBy) return spec.groupBy.singleGroup;
  const v = rec.properties[spec.groupBy.prop];
  return v ? spec.groupBy.map[v] ?? null : null;
}

/** monday group id -> HubSpot group-by value (null when not applicable). */
export function reverseGroup(spec: ObjectSpec, groupId: string): string | null {
  if ("singleGroup" in spec.groupBy) return null;
  for (const [hsValue, gid] of Object.entries(spec.groupBy.map))
    if (gid === groupId) return hsValue;
  return null;
}
