import { DEAL_COLS, UNASSIGNED_GROUP, type ColSpec } from "../board-config";

// monday column `type` strings for each expected `kind` (confirmed against the live 2024-10 API):
// numbers column -> "numbers"; people/person -> "people"; status -> "status"; dropdown -> "dropdown";
// date -> "date"; Connect Boards -> "board_relation"; text -> "text"; long text -> "long-text".
const KIND_TO_MONDAY_TYPE: Record<string, string> = {
  numeric: "numbers", status: "status", dropdown: "dropdown", date: "date",
  "multiple-person": "people", "board-relation": "board_relation", text: "text", "long-text": "long-text",
};

export interface SchemaResult { ok: boolean; errors: string[] }

/** Confirm every configured Deal column exists with the right type, and the Unassigned group exists.
 * Pure: takes monday `columns {id type}` and `groups {id title}` arrays. */
export function validateBoardSchema(
  columns: { id: string; type: string }[],
  groups: { id: string; title: string }[],
): SchemaResult {
  const byId = new Map(columns.map(c => [c.id, c.type]));
  const errors: string[] = [];
  for (const spec of Object.values(DEAL_COLS) as ColSpec[]) {
    const actual = byId.get(spec.id);
    const want = KIND_TO_MONDAY_TYPE[spec.kind] ?? spec.kind;
    if (actual === undefined) errors.push(`missing column ${spec.id} (expected ${want})`);
    else if (actual !== want) errors.push(`column ${spec.id}: expected ${want}, got ${actual}`);
  }
  if (!groups.some(g => g.id === UNASSIGNED_GROUP))
    errors.push(`missing Unassigned group ${UNASSIGNED_GROUP}`);
  return { ok: errors.length === 0, errors };
}
