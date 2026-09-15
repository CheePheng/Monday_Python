/** Types for the CRM app's scope reader, used by the specs-vs-scopes test. */

export interface ObjectScopes {
  read: string;
  schema: string;
  write: string;
}

/** HubSpot object name (as ObjectSpec.object spells it) -> the scopes a spec for it requires. */
export declare const SCOPES_FOR: Record<string, ObjectScopes>;

export interface AppScopes {
  required: string[];
  optional: string[];
  /** Is this scope granted, required or optional? */
  has(scope: string): boolean;
}

export declare function readAppScopes(): AppScopes;
