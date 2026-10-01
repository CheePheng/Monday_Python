/** Types for the parts of restore-timeline-entries.mjs the structural tests import. */

/** The copied builders and rules this script depends on, checked against the Worker source. [] = none drifted. */
export declare function sourceDrift(): string[];
/** The markers this script can rebuild -- CRM activity objects only. */
export declare const MARKER_RE: RegExp;
/** A marketing email entry's marker: recognised only so it can be REFUSED (no restore path). */
export declare const MARKETING_MARKER_RE: RegExp;
export declare const OUR_TYPE: Record<string, string>;
