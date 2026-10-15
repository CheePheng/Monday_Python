/** Types for the read-only stale Last Activity Date finder (scripts/find-stale-lad.mjs). */

export interface StaleObject { board: string; idCol: string; ladCol: string; syncStateCol: string; modifiedProp: string }
export declare const STALE_OBJECTS: Record<"contacts" | "companies" | "deals", StaleObject>;
export declare const LAD_PROP: string;
export declare function localDay(v: unknown): string;
export declare function cardDay(cv: { text?: string | null; value?: unknown } | null | undefined): string;
export declare function classifyStale(x: { cardLad: string; hsLad: unknown; hsModified: unknown; syncState: unknown }):
  "stale" | "differs-not-newer" | "hubspot-empty" | "in-line";
