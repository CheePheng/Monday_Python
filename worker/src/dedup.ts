import type { MondayItem } from "./types";

export function colText(item: MondayItem, colId: string): string {
  return (item.column_values.find(cv => cv.id === colId)?.text ?? "").trim();
}

export function indexByHubspotId(items: MondayItem[], idCol: string): Record<string, MondayItem> {
  const idx: Record<string, MondayItem> = {};
  for (const item of items) {
    const key = colText(item, idCol);
    if (key) idx[key] = item;
  }
  return idx;
}
