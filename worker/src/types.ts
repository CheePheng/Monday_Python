import type { CreateIdempotency } from "./create-idempotency-do";
import type { ActivityRetry } from "./activity-retry-do";
import type { DeferredSync } from "./deferred-sync-do";

export interface Env {
  CREATE_IDEMPOTENCY: DurableObjectNamespace<CreateIdempotency>;
  ACTIVITY_RETRY: DurableObjectNamespace<ActivityRetry>;
  /** Optional: absent on the Work Management deployment, whose cron covers the same ground. */
  DEFERRED_SYNC?: DurableObjectNamespace<DeferredSync>;
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
  /** "true" turns the Activities sync on. Ships FALSE: the code deploys inert so the webhook
   *  subscriptions, the handler and the enablement are three separate, reversible steps rather than
   *  one deploy that changes behaviour the moment it lands. */
  ENABLE_ACTIVITY_SYNC?: string;
  /** Cutover-forward only: activity older than this is never synced, either way. Absent or
   *  unparseable means INFINITY — nothing qualifies — because this value's job is to stop a bulk
   *  write, and a guard that fails open is not a guard. */
  ACTIVITY_CUTOVER_AT?: string;
  /** Canary scope. While either is set, ONLY that contact is processed. The feature flag alone is
   *  global, so enabling it for "a canary" would in fact start syncing the whole portal. */
  ACTIVITY_CANARY_HUBSPOT_CONTACT_ID?: string;
  ACTIVITY_CANARY_HUBSPOT_COMPANY_ID?: string;
  ACTIVITY_CANARY_HUBSPOT_DEAL_ID?: string;
  ACTIVITY_CANARY_MONDAY_ITEM_ID?: string;
  ENABLE_CRM?: string;                // "true" ONLY on the separate CRM Worker. Selects the CRM specs
                                      // EXCLUSIVELY (see specsFor); the production Worker never sets it.         // the one allowed monday account id (rejects tokens from any other account)
}

export type ColType = "text" | "long_text" | "numbers" | "status" | "dropdown" | "date" | "people" | "phone" | "email" | "link";
export type LabelDict =
  | "stage" | "dealtype" | "priority" | "vendor" | "pipeline"
  | "industry" | "companyType" | "leadStatus" | "salesUser"
  | "contactSource" | "contactVendor" | "partnerWith" | "contactPriority" | "lifecycleStage" | "contactStatus"
  // Added 2026-09-09 so a reversible field on a HubSpot ENUMERATION can validate membership. Every one
  // of these properties was verified live against portal 39939588; see LABEL_SOURCE in sync.ts.
  | "contactSalesPerson" | "contactDepartment" | "contactCountries" | "contactCity" | "contactLeadSourceSub"
  // Added 2026-09-14 for the CRM Deals + Line Items phase. `crmStage` is PIPELINE-QUALIFIED and is not
  // interchangeable with `stage`: the WM `stage` dictionary covers the default pipeline only, and this
  // portal's 42 stage values across 5 pipelines contain duplicate labels (`赢单` is three distinct ids),
  // so an unqualified dictionary cannot be inverted. See getCrmStageDicts.
  | "crmStage" | "crmPipeline" | "crmCoarseStage"
  | "liBrand" | "liFamily" | "liSubcategory" | "liPricingModel" | "liBillingFreq" | "liTaxRate"
  | "liIsActive" | "liCurrency";

export interface FieldSpec {
  hs: string;            // HubSpot property name
  col: string;           // monday column id
  type: ColType;
  labels?: LabelDict;    // enum label dictionary (HubSpot internal value -> display label)
  reverse?: boolean;     // monday edits may be written back to HubSpot
  /**
   * SEND THE MONDAY TEXT TO A HUBSPOT ENUMERATION WITHOUT CHECKING IT IS AN OPTION.
   *
   * Required to reverse a `status`/`dropdown` field that carries no `labels`, because the default for
   * that combination is now to REFUSE. It exists for exactly one field — the live Work-Management
   * `deal_currency_code` — so that spec keeps behaving byte-for-byte as it did; do not add it to
   * anything else, give the field a dictionary instead.
   *
   * The reasoning it replaces was wrong and cost two live fields today. The old comment argued that
   * "no dictionary means value === label by construction, so the raw text is already a legal value".
   * value === label removes the need to TRANSLATE a label; it says nothing about MEMBERSHIP. monday
   * lets a user rename or add a status/dropdown label, and every write we make sets
   * create_labels_if_missing:true — so a cell can easily hold text that is not an option at all.
   * HubSpot 400s on that, patchRecord throws before Sync State is stamped, and with
   * skipFullReconcile:true and no CRM cron the card stops syncing every field until a human edits it
   * in HubSpot. `sales_person` (4 options) and `department_3__c` (29 options) shipped in that state
   * on 2026-09-09; both now carry dictionaries.
   */
  unvalidatedEnum?: boolean;
  /**
   * ON REVERSE, WRITE THE CANONICAL DOMAIN — because this value is also a SEARCH KEY.
   *
   * For `company_domain` the reverse path is not just "get the value back to HubSpot", it has to get
   * it back in the one spelling `searchCompanyByDomain` can find, since that function filters
   * `domain EQ normalizeDomain(x)`. Companies do NOT enforce a unique domain (verified live: 57
   * companies share qcc.com), so HubSpot accepts and stores whatever string it is sent — four
   * companies in this portal already hold values like "https://www.aliyun.com/". Sending
   * linkReverse's output would therefore store a URL, no error anywhere, and the next lookup for that
   * company would miss and manufacture a duplicate instead.
   *
   * Only the REVERSE direction changes. Forward formatting and the diff comparison stay exactly as
   * `link`, which is already scheme-insensitive on both sides via linkText — that is what stopped the
   * 76-iteration loop and must not be disturbed.
   */
  canonicalDomain?: boolean;
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
  /**
   * UNIT CONVERSION between HubSpot's stored number and what the monday column displays.
   * Forward: monday = hs * scale. Reverse: hs = monday / scale.
   *
   * Exists for `hs_deal_stage_probability`, which HubSpot stores as a FRACTION (0.2) while the monday
   * column renders a percent symbol. Without the conversion a 20% deal reads "0.2%" — a plausible
   * number, wrong by two orders of magnitude, and one that survives a casual look at the board. The
   * forecast column multiplies by it, so the error propagates into money.
   *
   * Applied in BOTH formatValue and expectedText. That pairing is not optional: a transform applied
   * on only one of them makes every comparison differ, so the record is rewritten on every single
   * pass forever. Contacts learned that with the phone and email storable checks.
   */
  scale?: number;
  /**
   * THIS PROPERTY HOLDS AN OWNER'S DISPLAY NAME, NOT AN OWNER ID — so a `people` column must resolve
   * it through the name index rather than through ownersById.
   *
   * Needed by `sales_person`, which is a HubSpot ENUMERATION whose four option values are literally
   * "Elaine Rivera", "Myla Mestiola", "Emily You", "Rick Avery Antonio". The ordinary people path does
   * `ctx.ownersById[value]`, which for a name is always undefined — so without this the column would
   * silently render EMPTY on all 6,543 contacts rather than failing loudly.
   *
   * Resolution is still by EMAIL at the last hop (name -> owner -> email -> monday user); only the
   * first hop changes. Ambiguous names are absent from the index by construction, so "Rick Avery
   * Antonio" — which matches no owner at all — resolves to nothing, which is the correct outcome
   * until that person has an account.
   */
  peopleByName?: boolean;

  /**
   * REFUSE a value the dictionary does not know, instead of writing it through raw.
   *
   * `formatValue` normally falls back to `dict[v] ?? v`, which is right for a free-text column: an
   * unknown value is still the user's data and showing it beats showing nothing. It is WRONG for a
   * monday STATUS column, because every write sets `create_labels_if_missing: true` — so a value the
   * dictionary missed does not merely display oddly, it permanently ADDS A LABEL to the column for
   * every board member, and a status column degrades above roughly 19 labels.
   *
   * That is not hypothetical. On 2026-09-15 the Deals import mapped the coarse Stage column to a
   * dictionary covering only HubSpot's DEFAULT pipeline, and the first 70 cards minted 8 status
   * labels named after raw stage GUIDs before it was stopped.
   *
   * With this set, an unmapped value omits the column (and `expectedText` reports "" so the omission
   * raises no diff and no churn). The cell keeps whatever it had rather than gaining a junk label,
   * and the miss is logged so an unmapped stage is a reported fact rather than a silent one.
   */
  strictDict?: boolean;
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
  // "line_items" joined 2026-09-14: the CRM phase gives Line Items their own BOARD with a paired Deal
  // relation, rather than the Work-Management shape where they are subitems of a deal card. 29% of
  // deals carry more than one line item, so a board is the only shape that shows them all.
  object: "deals" | "companies" | "contacts" | "line_items";
  objectTypeId: "0-1" | "0-2" | "0-3" | "0-8"; // for HubSpot record deep links (0-8 = line items)
  searchFilters: Record<string, unknown>[]; // one HubSpot filterGroup's filters
  modifiedProp: string;  // hs_lastmodifieddate | lastmodifieddate
  nameProps: string[];   // properties composing the monday item name
  /**
   * Tried in order when every `nameProps` value is empty, BEFORE falling back to
   * `"<object> <id>"`.
   *
   * Measured on this portal before the 2026-09-09 historical import: 3,841 of 94,318 Contacts
   * (4.1%) have neither firstname nor lastname, so they would each land on the board reading
   * "contacts 548911732425" — unsearchable by name, on a board whose entire purpose is finding a
   * contact. 3,598 of those 3,841 do carry an email, so one fallback property recovers 94% of them.
   *
   * OPT-IN PER SPEC so the live Work-Management boards keep their existing names exactly. A rename
   * only reaches an existing card on its next webhook, which is why this has to be decided before a
   * bulk import rather than after: afterwards, most placeholder cards would simply never be renamed.
   */
  nameFallbackProps?: string[];
  /**
   * How to shorten a `nameFallbackProps` value for display. Applies ONLY to fallback values, never to
   * a real `nameProps` name.
   *
   * "emailLocalPart" — matthew.ng@gmail.com becomes "matthew.ng". The full address is untouched in the
   * Email column, so nothing is lost; this is purely about what the card is labelled.
   *
   * MEASURED COST, so it is a choice rather than an assumption: across the 3,598 nameless Contacts
   * that do carry an email, the local part is NOT unique for 221 of them (6.1%) — 16 read "info",
   * 9 "support", 5 "sales". The full address collides zero times. It is still the better trade, since
   * 3,377 cards gain a readable name and the ambiguous ones remain separable by the adjacent Email
   * column, but the ambiguity is real and deliberate.
   *
   * "domainStem" — hubspot.com becomes "hubspot", jsgjjn.com.cn becomes "jsgjjn", h.axhome.com.cn
   * becomes "axhome". 4,315 of 26,206 HubSpot Companies (16.5%) carry no name at all, and 4,237 of
   * those do have a domain, so this replaces "companies 37108192909" with something a salesperson can
   * read, on 4,237 cards. The full domain stays in the Company domain name column untouched.
   *
   * Characters are NEVER rewritten under either transform: no dots to spaces, no title-casing.
   * "sales.apac_01" is not necessarily a person and "jsgjjn" is not a word — prettifying either would
   * invent information the record never contained.
   */
  nameFallbackTransform?: "emailLocalPart" | "domainStem";
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
  /**
   * SUPPRESS EVERY monday -> HubSpot WRITE ON AN EVENT OUR OWN TOKEN CAUSED.
   *
   * An event we produced is an echo, not a user instruction. With this set, a webhook attributed to
   * the integration's own monday user still reconciles FORWARD (harmless, self-healing) but cannot
   * create a HubSpot record, patch a field, add an association, or claim ownership.
   *
   * Earned by measurement, not caution: during the 2026-09-09/11 historical import the Worker created
   * 1,207 HubSpot Companies — 1,207 of the 1,213 it has ever created — each within 2-26 seconds of a
   * monday Accounts card appearing, and monday's activity log attributes every one of those cards to
   * user 104118038, this integration's token. One of the companies (fake.com) then accumulated 1,581
   * contact associations. The mechanism is a race: createItem stamps the HubSpot ID column, monday
   * fires create_item within milliseconds, and the webhook's read of that column comes back empty — so
   * the card looks monday-originated.
   *
   * OPT-IN PER SPEC, and deliberately NOT inferred from `ownership`. The live Work-Management specs
   * must keep their exact current behaviour, and a test enforces that webhooks.ts does not use
   * `ownership` as a stand-in for another decision.
   */
  suppressSelfOriginWrites?: boolean;
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
  /**
   * WRITE THE STAGE AND ITS PIPELINE IN ONE PATCH, ALWAYS.
   *
   * HubSpot rejects a `dealstage` that does not belong to the record's CURRENT `pipeline`. So moving
   * a deal to a stage in another pipeline fails if the stage is sent alone, and sending the two in
   * separate PATCHes leaves a window in which the record holds an invalid pair. Neither is
   * acceptable for a field a rep edits from a dropdown that spans all five pipelines.
   *
   * When the reverse patch contains `stageProp`, `pipelineProp` is set from the stage's own pipeline
   * (ctx.pipelineByStage) whether or not the Pipeline column itself changed — because the common case
   * is exactly that: the rep picks "SF-Maint / 赢单" on a deal currently in SF-Sales and touches
   * nothing else.
   *
   * OPT-IN PER SPEC. The live Work-Management DEALS spec does not set it and is unaffected.
   */
  stagePipelinePairing?: { stageProp: string; pipelineProp: string };
}

// A HubSpot association synced onto the parent monday item (HubSpot -> monday only, no reverse).
export interface AssocSpec {
  toObject: "companies" | "contacts" | "deals" | "line_items";
  nameProps: string[];     // properties composing the associated record's display name / line-item name
  col?: string;            // parent text column for comma-joined names (companies/contacts/deals)
  relationCol?: string;    // "Connect Boards" (board_relation) column: links to the actual monday cards.
                           // CORRECTED 2026-09-14: the 2026-07 API DOES create these. create_column with
                           // columnSettings {boardIds, allowCreateReflectionColumn: true} makes the column
                           // AND its paired counterpart on the target board, so both sides are visible.
                           // The old note ("make it in the UI") was true of an earlier API version only.
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
  /**
   * Owner display NAME (lowercased) -> owner id, for `peopleByName` fields. AMBIGUOUS NAMES ARE
   * DELIBERATELY ABSENT: this portal holds two distinct owners both called "Rick Antonio", and
   * silently picking one would assign contacts to the wrong person. A name that maps to more than one
   * owner is omitted, so the field resolves to nothing rather than to a guess.
   */
  ownerIdByName?: Record<string, string>;
  mondayUsersByEmail: Record<string, string>;
  mondayEmailByUserId: Record<string, string>; // monday user id -> email (reverse of mondayUsersByEmail)
  ownerIdByEmail: Record<string, string>;       // email (lowercased) -> HubSpot owner id
  /** deal stage id -> the pipeline id it belongs to. Populated only when a spec declares the
   *  `crmStage` dictionary, and used by stagePipelinePairing. See getCrmStageDicts. */
  pipelineByStage?: Record<string, string>;
  portalId: number;
}

export interface RunOpts { dryRun: boolean; writeHubspot: boolean; maxWrites: number }

export interface Stats {
  processed: number; created: number; toMonday: number; toHubspot: number;
  inSync: number; skipped: number; errors: number; adopted: number; createdInHubspot: number;
}

// A shared, mutable write budget threaded across all specs in one run.
export interface Budget { left: number }
