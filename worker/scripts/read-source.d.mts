/** Types for the source reader used by structural tests. */

/** Raw text of `src/<relPath>`. */
export declare function readSource(relPath: string): string;

/** `src/<relPath>` with block and line comments stripped, for assertions about executable code. */
export declare function readCode(relPath: string): string;

/** `scripts/<relPath>`, comments stripped. For structural assertions about the one-off migration
 *  scripts, whose guarantees live in their shape and cannot be reached by a unit test. */
export declare function readScript(relPath: string): string;

/** `scripts/<relPath>` with its comments kept (line endings normalised). */
export declare function readScriptSource(relPath: string): string;

/** `test/fixtures/<relPath>`, parsed as JSON. */
export declare function readFixture(relPath: string): any;

/** Every .ts file under src/, relative to it with forward slashes ("config/crm.ts"), sorted. */
export declare function listSources(): string[];
