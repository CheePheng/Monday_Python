/** Types for the timeline catch-up finder (scripts/wake-timelines.mjs). */

export declare const CONTACTS_BOARD: string;
export declare const DEFAULT_SINCE: string;
export declare const WAKE_COLS: string[];
export declare const INTEGRATION_USER_ID: string;
export declare const BATCH: number;
export declare const TIMELINE_PAGE: number;
export declare const TIMELINE_MAX_PAGES: number;
export declare function eligibleNative(e: unknown): boolean;
export declare function nativeSince<T extends { created_at: string }>(entries: T[] | null | undefined, sinceMs: number): T[];
export declare function itemIdsFromLogs(logs: unknown[], opts?: { columns?: string[]; excludeUser?: string }): Set<string>;
export declare function batches<T>(ids: T[], n?: number): T[][];
