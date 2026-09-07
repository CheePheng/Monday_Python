/** Types for the wrangler.jsonc reader used by the deployment-config regression test. */

export interface WranglerConfig {
  name?: string;
  account_id?: string;
  main?: string;
  compatibility_date?: string;
  vars?: Record<string, string>;
  triggers?: { crons?: string[] };
  observability?: { enabled?: boolean };
  durable_objects?: unknown;
  migrations?: unknown;
  [k: string]: unknown;
}

export declare function parseJsonc(raw: string): WranglerConfig;
export declare function readWranglerConfig(): WranglerConfig;
