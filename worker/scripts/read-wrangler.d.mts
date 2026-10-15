/** Types for the wrangler.jsonc reader used by the deployment-config regression test. */

export interface WranglerConfig {
  name?: string;
  account_id?: string;
  main?: string;
  compatibility_date?: string;
  vars?: Record<string, string>;
  triggers?: { crons?: string[] };
  observability?: { enabled?: boolean };
  /** Typed, because the WM config test asserts on the exact binding and migration shape: a
   *  re-declared migration whose tag or form differs from the applied one is not a no-op. */
  durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }>;
  [k: string]: unknown;
}

export declare function parseJsonc(raw: string): WranglerConfig;
export declare function readConfig(file: string): WranglerConfig;
export declare function readWranglerConfig(): WranglerConfig;
/** The Work Management deploy config (wrangler.wm.jsonc), which is NOT the checked-in default. */
export declare function readWmConfig(): WranglerConfig;
