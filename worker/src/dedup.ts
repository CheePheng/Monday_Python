import type { MondayItem } from "./types";

/**
 * A cell's text, as the engine reasons about it.
 *
 * AN UNSET STATUS IS EMPTY, WHATEVER IT DISPLAYS. monday renders an unset status cell with the label at
 * index 5, so on the Accounts "Type" column 25,656 empty cells read `text: "Other"` with `index: null`
 * (verified live, 2026-09-23). Trusting the text made the engine see a real "Other": the record-level
 * backfill wrote type=OTHER into 2,424 HubSpot companies that had no type, a rep clearing the cell would
 * have pushed OTHER instead of a clear, and a monday-created Account would be born "Other". Card reads
 * fetch `status_index` for status cells only, so the key's presence marks a status cell and `null`
 * proves it is unset. A genuinely chosen "Other" carries index 5 and reads normally.
 */
export function colText(item: MondayItem, colId: string): string {
  const cv = item.column_values.find(c => c.id === colId);
  if (!cv) return "";
  if ("status_index" in cv && cv.status_index === null) return "";
  return (cv.text ?? "").trim();
}

export function indexByHubspotId(items: MondayItem[], idCol: string): Record<string, MondayItem> {
  const idx: Record<string, MondayItem> = {};
  for (const item of items) {
    const key = colText(item, idCol);
    if (key) idx[key] = item;
  }
  return idx;
}
