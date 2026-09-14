/** Types for the source reader used by structural tests. */

/** Raw text of `src/<relPath>`. */
export declare function readSource(relPath: string): string;

/** `src/<relPath>` with block and line comments stripped, for assertions about executable code. */
export declare function readCode(relPath: string): string;

/** `scripts/<relPath>`, comments stripped. For structural assertions about the one-off migration
 *  scripts, whose guarantees live in their shape and cannot be reached by a unit test. */
export declare function readScript(relPath: string): string;
