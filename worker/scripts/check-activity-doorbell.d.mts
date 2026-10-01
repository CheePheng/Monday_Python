/** Types for the read-only activity-doorbell preflight (scripts/check-activity-doorbell.mjs). */

export declare const CONTACTS_BOARD: string;
export declare const LAD_COL: string;
export declare const BELL_COL: string;
export declare const DOORBELL_COL: string;
export declare const RECIPE_TYPED: number;
export declare const RECIPE_ANY: number;
export declare const BELL_WORKFLOW_ID: string;
export declare const MAX_PAGES: number;

export interface DoorbellRow {
  id: unknown;
  kind: "bell" | "lad-writer" | "lad-reader" | "review" | "off";
  why: string;
  covers?: boolean;
  filter?: string;
}
export type DoorbellVerdictName = "OK" | "NO-BELL" | "LAD-WRITER" | "INCOMPLETE" | "BELL-PARTIAL";
export interface DoorbellVerdict { rows: DoorbellRow[]; warnings: string[]; verdict: DoorbellVerdictName; exitCode: 0 | 2 | 3 | 4 | 5 }
export interface ColumnUse { node: unknown; block: unknown; title: string; role: "trigger" | "condition" | "action"; field: string; col: string }

export declare function filterCovers(filter: unknown): { ok: boolean; missing: string[]; filter: string };
export declare function workflowColumnUses(w: unknown): ColumnUse[];
export declare function workflowTrigger(w: unknown): { emailsAndActivities: boolean; filter: string };
export declare function classifyDoorbell(legacy?: unknown[], workflows?: unknown[], opts?: { complete?: boolean }): DoorbellVerdict;
