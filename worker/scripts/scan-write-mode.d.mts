/** Types for the writeHubspot source scan used by the deployment-config regression test. */

/**
 * File names, relative to `src/`, that derive `writeHubspot` themselves instead of taking it from
 * run-opts.ts. Empty is the only healthy answer.
 */
export declare function scanWriteMode(srcDir?: string): string[];
