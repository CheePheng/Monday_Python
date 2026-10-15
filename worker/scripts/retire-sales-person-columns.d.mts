/** Types for the Sales Person retirement. See retire-sales-person-columns.mjs for the reasoning. */

export interface ColumnTarget {
  /** The monday column id. Opaque, so the title and type below are what actually identify it. */
  id: string;
  expectTitle: string;
  expectType: string;
  /** Why this column is going. Printed in the plan so the operator reads it before --apply. */
  why: string;
}

export declare const TARGETS: ColumnTarget[];

/** One monday activity-log entry, as `activity_logs` returns it (newest first). */
export interface ActivityLog {
  event: string;
  /** monday's 100-nanosecond timestamp, as a string. */
  created_at: string;
  /** A JSON string. May be malformed; the parser steps over it rather than throwing. */
  data: string;
}

/** The columns that currently grant EDIT access, from the newest `update_board_permissions` event.
 *  `null` means "could not determine" — distinct from an empty list, and the caller refuses on it. */
export declare function assigneeColumnsFromLogs(
  logs: ActivityLog[],
): { columns: string[]; at: string } | null;

/** Cards in the sample with a non-empty value in `columnId`. A sample count, never a board total. */
export declare function countFilled(
  items: { column_values?: { id: string; value: string | null }[] }[],
  columnId: string,
): number;
