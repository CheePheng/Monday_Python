/** Types for the source reader used by structural tests. */

/** Raw text of `src/<relPath>`. */
export declare function readSource(relPath: string): string;

/** `src/<relPath>` with block and line comments stripped, for assertions about executable code. */
export declare function readCode(relPath: string): string;
