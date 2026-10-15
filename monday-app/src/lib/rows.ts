import type { DealRow } from "./filter";

/** Replace the row with the same id, or append it. Pure; never mutates the input array. */
export function upsertRow(rows: DealRow[], row: DealRow): DealRow[] {
  const i = rows.findIndex(r => r.id === row.id);
  if (i === -1) return [...rows, row];
  const out = rows.slice();
  out[i] = row;
  return out;
}
