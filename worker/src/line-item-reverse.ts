import { LINE_ITEM_SUBITEMS } from "./config";
import type { FieldSpec } from "./types";

// The two mutually-exclusive discount modes: setting one clears the other in HubSpot.
const DISCOUNT_SIBLING: Record<string, string> = {
  discount: "hs_discount_percentage",
  hs_discount_percentage: "discount",
};

/** The LINE_ITEM_SUBITEMS field mapped to a monday subitem column id, or undefined (id/status/product/unknown). */
export function subitemFieldByCol(colId: string): FieldSpec | undefined {
  return LINE_ITEM_SUBITEMS.fields.find(f => f.col === colId);
}

/** monday subitem webhook events we reverse-sync. Registered on the PARENT deals board (not the hidden
 * subitems board, which the API rejects). We handle only column edits + renames; create is folded into
 * the first column edit, and removals are not synced. */
export function isReverseSubitemEvent(type: string): boolean {
  return type === "change_subitem_column_value" || type === "change_subitem_name";
}

/** Extract subitem-event fields from a monday webhook `event`, tolerant of camelCase AND snake_case
 * (monday payloads have been observed in both). Returns "" for any missing field. */
export function readSubitemEvent(ev: any): { subitemId: string; columnId: string; parentItemId: string } {
  const pick = (...keys: string[]): string => {
    for (const k of keys) { const v = ev?.[k]; if (v != null && v !== "") return String(v); }
    return "";
  };
  return {
    subitemId: pick("pulseId", "pulse_id", "itemId", "item_id", "subitemId", "subitem_id"),
    columnId: pick("columnId", "column_id"),
    parentItemId: pick("parentItemId", "parent_item_id", "parentId", "parent_id"),
  };
}

/** Type-aware equality: numbers compared numerically (90 == 90.00), dates by first 10 chars, else trimmed string. */
export function liValueEqual(type: string, a: string, b: string): boolean {
  const A = (a ?? "").trim(), B = (b ?? "").trim();
  if (type === "numbers") {
    const na = Number(A), nb = Number(B);
    if (A !== "" && B !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return A === B;
  }
  if (type === "date") return A.slice(0, 10) === B.slice(0, 10);
  return A === B;
}

/**
 * PURE reverse-patch decision for one subitem column edit.
 * @param columnId            the monday subitem column that changed
 * @param subitemColumnValue  its current value (from colText)
 * @param hubspotCurrentValue HubSpot's current value for the mapped property (for echo suppression)
 * @returns the HubSpot props to PATCH, or null to send nothing
 *          (non-reverse column / empty value / echo).
 */
export function buildSubitemReversePatch(
  columnId: string, subitemColumnValue: string, hubspotCurrentValue: string,
): Record<string, string> | null {
  const f = subitemFieldByCol(columnId);
  if (!f || !f.reverse) return null;                                   // not reverse-eligible (calc/currency/id/status/unknown)
  const raw = (subitemColumnValue ?? "").trim();
  if (raw === "") return null;                                         // omit-empty: never clear HubSpot from an empty cell
  const value = f.type === "date" ? raw.slice(0, 10) : raw;
  if (liValueEqual(f.type, value, hubspotCurrentValue ?? "")) return null; // echo: already equals HubSpot -> no patch
  const props: Record<string, string> = { [f.hs]: value };
  const sibling = DISCOUNT_SIBLING[f.hs];
  if (sibling) props[sibling] = "";                                    // discount mode-switch: clear the other mode
  return props;
}
