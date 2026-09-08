import type { CreateIdempotency } from "./create-idempotency-do";

export interface Env {
  CREATE_IDEMPOTENCY: DurableObjectNamespace<CreateIdempotency>;
  MONDAY_API_TOKEN: string;
  HUBSPOT_ACCESS_TOKEN: string;
  TRIGGER_SECRET: string;
  DRY_RUN: string; // "true" | "false"
  HUBSPOT_APP_SECRET?: string;   // optional: validate HubSpot webhook v3 signatures if set
  /** Capability key for the CRM Worker's monday webhooks. Set ONLY on the CRM Worker: mondayAuth
   *  fails open when absent so the live WM Worker's bare-path hooks keep working. */
  MONDAY_WEBHOOK_KEY?: string;
  MAX_WRITES?: string;           // optional: writes/records per cron tick (default 25; raise on Workers Paid)
  LINE_ITEM_WRITE?: string;      // "true" once the token has crm.objects.line_items.write (enables reverse line items)
  APP_SECRET?: string;           // shared secret the vibe app sends to /app/search (falls back to TRIGGER_SECRET)
  MONDAY_APP_SESSION_SECRET?: string; // signs the monday Board View sessionToken JWT (verify empirically: Client vs Signing secret)
  MONDAY_ACCOUNT_ID?: string;         // the one allowed monday account id (rejects tokens from any other account)
  /** "false" DISABLES every HubSpot mutation while leaving HubSpot -> monday writes real. Opt-OUT: the
   *  live WM Worker sets no such var and keeps writing HubSpot exactly as before. See run-opts.ts. */
  WRITE_HUBSPOT?: string;
  /** CRM ownership cutover as an ISO timestamp or epoch ms. Read via cutoverFromEnv, which fails
   *  CLOSED to Infinity (claiming and CRM card creation both disabled) for a missing, malformed or
   *  implausible value. Deployment config on purpose - a temporary test cutover never enters git. */
  CRM_CUTOVER_AT?: string;
  ENABLE_CRM?: string;                // "true" ONLY on the separate CRM Worker. Selects the CRM specs
                                      // EXCLUSIVELY (see specsFor); the production Worker never sets it.         // the one allowed monday account id (rejects tokens from any other account)
}

export type ColType = "text" | "long_text" | "numbers" | "status" | "dropdown" | "date" | "people" | "phone" | "email" | "link";
export type LabelDict =
  | "stage" | "dealtype" | "priority" | "vendor" | "pipeline"
  | "industry" | "companyType" | "leadStatus" | "salesUser"
  | "contactSource" | "contactVendor" | "partnerWith" | "contactPriority" | "lifecycleStage" | "contactStatus";

export interface FieldSpec {
  hs: string;            // HubSpot property name
  col: string;           // monday column id
  type: ColType;
  labels?: LabelDict;    // enum label dictionary (HubSpot internal value -> display label)
  reverse?: boolean;     // monday edits may be written back to HubSpot
  /** Reverse ONLY on an explicit app save (a rep pressing Save in a drawer), never on a passive
   * webhook/cron reconcile. For business-critical assignment fields — record OWNERSHIP — where letting a
   * monday column silently win reassigns records: monday's people column is populated BY the sync and can
   * be stale, so a plain `reverse` reassigns owners unattended (live incident 2026-08-28: a contact's owner
   * was moved Steven -> Wendy by the reconcile, source "Integration monday sync", with no human edit). */
  appReverse?: boolean;
  backfill?: boolean;    // allowlisted: a non-empty monday value may FILL an EMPTY HubSpot value.
                         // Objects allowed: deals + contacts (BACKFILL_OBJECTS in reconcile.ts); contacts
                         // carry it on `phone` only. "Empty" is judged on the RAW HubSpot value.
  /** HubSpot -> monday only. A monday-side edit has nothing to push back, so its webhook is ignored
   * instead of triggering a full single-record reconcile. The daily sweep still heals a manual edit. */
  oneWay?: boolean;
}

/** Which sync owns WRITE access to a HubSpot record. */
export type SyncOwner = "wm" | "crm";

/** What the ownership stamp says. "other" = present but unrecognised, which means HANDS OFF for
 *  both syncs (the property is human-editable, so an ops user may park a record with "hold"). */
export type StampState = SyncOwner | "" | "other";

/** How a spec decides write ownership. `cutoverAtMs` is ONLY a fallback for unstamped records. */
export interface OwnershipSpec {
  /** HubSpot property holding the stamp. Constrained to a literal so a spec author cannot point the
   *  claim payload at a business field (`prop: "email"` would make a claim write email="crm"). */
  prop: "sync_owner";
  createdProp: string;  // create-date property (contacts + companies both use "createdate")
  owner: SyncOwner;     // which side THIS Worker is
  cutoverAtMs: number;  // CRM_CUTOVER_AT; POSITIVE_INFINITY = inert (nothing is ever post-cutover)
}

/** Result of the ownership check. `reason` is always logged, never swallowed.
 *  `forId` binds the decision to the record it was computed for, so one record's allow cannot be
 *  reused to write another's — assertMayWrite rejects a mismatch. */
export interface WriteAuth { allowed: boolean; reason: string; forId: string }

/** How a monday-originated create finds its existing HubSpot twin, so it ADOPTS instead of duplicating. */
export interface AdoptBy {
  kind: "email" | "domain";
  col: string;   // monday column id holding the key
}

export type GroupBy =
  // hs value -> monday group id. fallbackGroup catches empty/unmapped values so the record is placed
  // instead of skipped (e.g. a contact with no lead status still lands in the "New" group).
  // noSalesUserGroup overrides placement when the record has no sales_user (e.g. the shared Deals
  // board's "Unassigned Deals" group).
  | { prop: string; map: Record<string, string>; reverse: boolean; fallbackGroup?: string; noSalesUserGroup?: string }
  | { singleGroup: string };

export interface ObjectSpec {
  object: "deals" | "companies" | "contacts";
  objectTypeId: "0-1" | "0-2" | "0-3"; // for HubSpot record deep links
  searchFilters: Record<string, unknown>[]; // one HubSpot filterGroup's filters
  modifiedProp: string;  // hs_lastmodifieddate | lastmodifieddate
  nameProps: string[];   // properties composing the monday item name
  nameReverse?: string;  // HubSpot property to receive a renamed item (omit = name not reversible)
  boardId: string;
  idCol: string;         // numbers column storing the HubSpot record id (dedup key)
  syncStateCol: string;  // hidden text column storing the last-synced HubSpot modified timestamp
  linkCol?: string;
  groupBy: GroupBy;
  fields: FieldSpec[];
  includeAll?: boolean;        // sync EVERY record (ignore the sales_user/createdate scope gate)
  skipFullReconcile?: boolean; // exclude from the 03:00 full sweep (too large / search-capped)
  scopeAlsoLinkedProp?: string; // in scope if this property is present, OR'd with the sales_user/date gate
  /** Per-record HubSpot WRITE ownership. When set, EVERY HubSpot mutation for this spec must carry a
   * WriteAuth — a mutation without one throws rather than writing (see hubspot.ts assertMayWrite).
   * Absent on every production WM spec, so their code path is unchanged. */
  ownership?: OwnershipSpec;
  /** A non-empty monday value may FILL an empty HubSpot value, for any `reverse: true` field.
   *
   * The engine's default is the opposite: an empty HubSpot value is left alone, so monday and HubSpot
   * never fight and no loop can form. That default was written when monday was the SECONDARY surface.
   * It is wrong once reps work in monday: a salesperson typing Annual Revenue into a blank field
   * watched it silently revert on the next HubSpot change, which is not what anyone would call two-way.
   *
   * Opt-IN PER SPEC, and deliberately NOT keyed on `spec.object`. The pre-existing allowlists
   * (BACKFILL_OBJECTS in reconcile.ts, INDEPENDENT_BACKFILL_OBJECTS in sync.ts) are sets of object
   * NAMES — "contacts", "companies" — which the live Work-Management specs share. Adding "companies"
   * to either would have changed WM behaviour silently. A spec flag cannot.
   *
   * THE OPPOSITE RULE IS UNCHANGED AND MUST STAY: an EMPTY monday value never clears a non-empty
   * HubSpot value. reverseFieldValue returns "" for a blank cell and buildReversePatch drops it, so
   * clearing requires an explicit per-field decision that does not exist yet. */
  fillEmptyFromMonday?: boolean;
  /** Deleting or archiving a monday card RESTORES it from HubSpot instead of being a no-op.
   *
   * Opt-IN, and deliberately its own flag rather than piggybacking on `ownership`. The two mean
   * different things — `ownership` is about who may WRITE to HubSpot — and conflating them is exactly
   * how the WRITE_HUBSPOT bug happened: one signal quietly standing in for another until someone
   * changed one of them. It must also stay opt-in because the restore path ends in
   * ensureCardForRecord, and `mayCreateCrmCard` opens with `if (!o) return true` — so on a spec with
   * no ownership the no-import gate is a pass-through and the card is re-created unconditionally.
   * On the live WM follow-up boards that would mean a rep's deliberate deletion silently reappearing. */
  restoreOnDelete?: boolean;
  /** Spec-driven adoption key. Absent on production WM specs, which keep their existing
   * object-specific adoption branches untouched. */
  adoptBy?: AdoptBy;
  // monday -> HubSpot record creation (new cards). false for system-populated boards (Unassigned).
  createFromMonday: boolean;
  // fixed HubSpot properties stamped on records created from monday (pipeline, owner, sales_user...).
  createDefaults?: Record<string, string>;
  // HubSpot associations to reflect onto the monday item (HubSpot -> monday only). See associations.ts.
  associations?: AssocSpec[];
  // When set: on records with NO sales_user, assign `teamId` to the people column `col` so that under
  // "restricted to assigned people" board permissions, Unassigned deals stay viewable by that team;
  // the column is cleared once the record gets a sales_user. teamId "" = disabled (no-op).
  unassignedShared?: { col: string; teamId: string };
}

// A HubSpot association synced onto the parent monday item (HubSpot -> monday only, no reverse).
export interface AssocSpec {
  toObject: "companies" | "contacts" | "deals" | "line_items";
  nameProps: string[];     // properties composing the associated record's display name / line-item name
  col?: string;            // parent text column for comma-joined names (companies/contacts/deals)
  relationCol?: string;    // "Connect Boards" (board_relation) column: links to the actual monday cards.
                           // monday can't CREATE this column type via API — make it in the UI, then set the id here.
  subitems?: SubitemSpec;  // line_items only: sync each as a subitem
}
export interface SubitemSpec {
  boardId: string;     // subitems board id
  idCol: string;       // "HubSpot Line Item ID" text column (dedup key)
  fields: FieldSpec[]; // line-item property -> subitem column
  statusCol?: string;  // subitem status column: a removed line item is marked "Removed" (else deleted)
  productIdCol?: string;   // subitem text column holding a HubSpot product id -> reverse sets hs_product_id
}

export interface MondayItem {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  group: { id: string };
  column_values: { id: string; text: string | null; persons_and_teams?: { id: string; kind: string }[] }[];
}

export interface HsRecord { id: string; properties: Record<string, string | null> }

export interface Ctx {
  labels: Partial<Record<LabelDict, Record<string, string>>>;
  ownersById: Record<string, { name: string; email: string | null }>;
  mondayUsersByEmail: Record<string, string>;
  mondayEmailByUserId: Record<string, string>; // monday user id -> email (reverse of mondayUsersByEmail)
  ownerIdByEmail: Record<string, string>;       // email (lowercased) -> HubSpot owner id
  portalId: number;
}

export interface RunOpts { dryRun: boolean; writeHubspot: boolean; maxWrites: number }

export interface Stats {
  processed: number; created: number; toMonday: number; toHubspot: number;
  inSync: number; skipped: number; errors: number; adopted: number; createdInHubspot: number;
}

// A shared, mutable write budget threaded across all specs in one run.
export interface Budget { left: number }
