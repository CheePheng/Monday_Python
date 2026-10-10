import type { CreateIdempotency } from "./create-idempotency-do";
import type { ActivityRetry } from "./activity-retry-do";
import type { DeferredSync } from "./deferred-sync-do";

export interface Env {
  CREATE_IDEMPOTENCY: DurableObjectNamespace<CreateIdempotency>;
  /** Optional for the same reason as DEFERRED_SYNC: the Work Management deployment does not run
   *  activity sync and has no such namespace. Declaring it required was a lie the compiler believed,
   *  which is how an unguarded read reached a route WM can serve. */
  ACTIVITY_RETRY?: DurableObjectNamespace<ActivityRetry>;
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
  /** A second live webhook key, for hooks registered after the first key's value was lost. See mondayAuth. */
  MONDAY_WEBHOOK_KEY_2?: string;
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
  /** "true" = do not write a second copy of a HubSpot activity onto an Account/Deal card that monday has
   *  already copied it onto from a linked Contact card -- only when a bounded read of that card finds the
   *  copy; "absent", "unknown" and unreadable links all write as before (activity-sync.ts,
   *  skipMirroredCopies). Anything else, including absent, is the old behaviour exactly. Ships "false". */
  ACTIVITY_SKIP_MIRRORED_COPIES?: string;
  ENABLE_CRM?: string;                // "true" ONLY on the separate CRM Worker. Selects the CRM specs
                                      // EXCLUSIVELY (see specsFor); the production Worker never sets it.         // the one allowed monday account id (rejects tokens from any other account)
  /** "true" lets a person's edit of the Products & Services "Accounts/Companies" cell FILL an empty
   *  company on the line item's deal (deal -> company, Primary). Anything else -- including absent --
   *  keeps that derived cell read-only: every edit snaps back. Ships "false". See fillDealCompany. */
  PS_ACCOUNT_REVERSE?: string;
  /** "true" lets a PERSON's edit of the Deals board's native coarse Stage (deal_stage: New / Proposal /
   *  Negotiation / Won / Lost) set the deal's stage, within its current pipeline (coarseStageEdit in
   *  reconcile.ts). An automation's or our own token's edit of it is never sent. Anything else -- including
   *  absent -- keeps the column one-way: every event on it is ignored. Ships "false". */
  STAGE_COARSE_REVERSE?: string;
  /** "true" turns the HubSpot marketing email poller on (marketing-email-poller.ts). Ships "false".
   *  Also needs ENABLE_ACTIVITY_SYNC (the kill switch for every timeline write), ENABLE_CRM, and the
   *  monday activity type id in activities.ts. */
  ENABLE_MARKETING_EMAIL_SYNC?: string;
  /** Where the LIVE marketing cursor starts (ISO). Unset or unparseable = the poller refuses: seeding
   *  from "now" would silently lose everything between deploy and first run, and from zero would
   *  import all history through the live path. */
  MARKETING_CUTOVER_AT?: string;
  /** Where the BACKFILL cursor starts (ISO); it runs up to MARKETING_CUTOVER_AT with whatever write
   *  budget the live work leaves. Unset = no backfill. */
  MARKETING_BACKFILL_FROM?: string;
  /** Timeline writes per poll, all phases together. Default 60. */
  MARKETING_MAX_WRITES_PER_POLL?: string;
  /** Canary: comma-separated HubSpot contact ids. While set, ONLY those contacts get entries, and the
   *  cursors are kept under separate names so the production cursors start clean afterwards. Separate
   *  from ACTIVITY_CANARY_* on purpose: those scope the live activity sync in both directions. */
  MARKETING_CANARY_CONTACT_IDS?: string;
  /** "true" turns on the bounded Last Activity backstop sweep in the 15-minute cron (lad-sweep.ts):
   *  records whose notes_last_updated moved since its watermark get the ordinary, non-forced sync, so
   *  a dropped HubSpot webhook heals itself. CRM Worker only. Ships "false". */
  ENABLE_LAD_SWEEP?: string;
  /** KILL SWITCH. "true" = a record created from a monday card by a PERSON gets the relation links the
   *  card shows, pushed to HubSpot right after the create (the birth pass: bornAttached ->
   *  pushBirthAssociations). Anything else, including absent, is the old behaviour: no association
   *  write follows a monday-born record. The card-owner re-stamp and the create's provenance stay on
   *  either way. Ships "false"; the deploy passes "true". */
  BORN_ATTACHED_LINKS?: string;
  /** KILL SWITCH. "true" = a person's edit made while its card's HubSpot record is being created is
   *  queued and replayed by the creator, and the creator holds the forward pass off the new card until
   *  it has settled it (createWindowReplayOn in sync.ts). Anything else, including absent, is the old
   *  create path: an edit that finds the create in flight is skipped, and a 'have' claim only
   *  re-stamps. Ships "false"; the deploy passes "true". */
  CREATE_WINDOW_REPLAY?: string;
  /** "true" = an event of our own token user (104118038 "ask ada", a login people share) is read as a
   *  PERSON's when monday's activity log proves it was a UI action: the matching update_column_value row
   *  carries an action_record_uuid, or a create_pulse row lacks the HubSpot ID column (ui-actor.ts). One
   *  activity_logs query per such event on a two-way column; no row / an error = our own, as today.
   *  Anything else, including absent, is today's behaviour exactly: every event of ours is an echo.
   *  Ships "false". */
  ASK_ADA_UI_EDITS?: string;
  /** "true", with ENABLE_CRM "true", arms HubSpot's rate-limit-aware retry in hs() (hs-retry.ts, hubspot.ts
   *  hsRateLimited): a GET is also retried on a 429, a 5xx or a network error whatever retry count its caller
   *  passed; any other method also on a 429, when its caller already allows retries -- so a create
   *  (retries=1) never is; and every retry hs() makes today is still made, no later than today makes it.
   *  Its own retries are bounded per call (hsRetry) and, in a webhook's work, per invocation
   *  (withHsRetryDeadline: none ends 20 s past the webhook's start); today's are never cut. Anything else,
   *  including absent, is hs()'s loop exactly as it was. Ships "false". */
  HS_RATE_LIMIT_RETRY?: string;
  /** "true", with ENABLE_CRM "true", fits every monday item name the Worker writes to monday's 255-unit
   *  limit (mapping.ts itemNameFitOn / fitItemName; monday.ts) and compares names fitted (Ctx.itemNameMax),
   *  instead of a long HubSpot name failing the card's create and every later update of it. Anything else,
   *  including absent, sends and compares names exactly as before. Ships "false". */
  ITEM_NAME_FIT?: string;
  /** "true", with ENABLE_CRM "true": a Contacts card in "No Activity - 未跟进" moves to "Active Contacts" when it
   *  is worked -- any activity reaches it within a day (a note, call, email, meeting, task, a customer's reply, a
   *  marketing send), or Lifecycle moves off 1.NEW or a Lead Status is set, in monday or in HubSpot (no-activity.ts,
   *  ObjectSpec.leaveWhenWorked). The only group move the Worker makes,
   *  and only ever OUT of that group. Anything else, including absent: no card is moved, as before. Ships "false". */
  NO_ACTIVITY_RELEASE?: string;
  /** "true", with ENABLE_CRM "true": when HubSpot assigned a contact's owner recently and that owner is not the
   *  person in the card's 上次通知Owner, the Worker sets the card's 通知状态 to 待通知, at most once per assignment
   *  and only once the card's Contact owner shows that owner (owner-notice.ts, ObjectSpec.ownerNotice). That change
   *  is what the board's workflow (monday workflow #06, 5031811440) fires on: IT sends the email, from the Outlook mailbox
   *  askada@dkmeco.com.sg, to the card's Contact owner, records them in 上次通知Owner and sets 已通知. The Worker
   *  only decides: it never writes 上次通知Owner and never sets 已通知. Anything else, including absent: neither
   *  column is written. Ships "false". */
  OWNER_NOTICE?: string;
  /** "true", with ENABLE_CRM "true": a HubSpot contact with no owner gets no Contacts card; the card is created
   *  when HubSpot sets an owner (ensure-card.ts, ObjectSpec.cardNeedsOwner). Cards that already exist are kept.
   *  Anything else, including absent: every in-scope contact is carded, as before. Ships "false". */
  CONTACT_CARD_NEEDS_OWNER?: string;
  /** "true", with ENABLE_CRM "true": Contact owner is changed in HubSpot only. A monday edit of it is refused and
   *  the cell put back (FieldSpec.hubspotOnly, applied by config.ts withContactOwnerRule); a contact created in
   *  monday is still born with its owner. Anything else, including absent: the owner column is app-save two-way,
   *  as before. Ships "false". */
  CONTACT_OWNER_HUBSPOT_ONLY?: string;
  /** "true", with ENABLE_CRM "true": a column-level forward write judges each differing TWO-WAY cell by itself --
   *  monday's per-cell changed_at against HubSpot's per-property history -- and leaves one alone only while it
   *  plausibly carries a person's edit still on its way, for at most STALE_FORWARD_HOLD_S; every such cell is
   *  watched by its card's Durable Object and converges to HubSpot when its hold ends (card-watch.ts, sync.ts
   *  forwardOnlyGated). Anything else, including absent: the engine exactly as before. Ships "false". */
  STALE_FORWARD_GATE?: string;
  /** "true", with STALE_FORWARD_GATE on: a person's edit whose run died is re-sent from the card (the mark's
   *  retry), and an unmarked edit monday's log proves was a person's is rescued instead of converged. Both WRITE
   *  HubSpot outside a webhook. Anything else: a mark simply expires at its lease. Ships "false". */
  STALE_FORWARD_RETRY?: string;
  /** W, seconds (default 180, clamped 60..900): the longest a person's push is believed to take. */
  STALE_FORWARD_HOLD_S?: string;
}

/**
 * WHAT THE HUBSPOT EVENTS BEHIND A FORWARD PASS NAMED (STALE_FORWARD_GATE): per property, the newest event's
 * time (occurredAt, ms) and whether it was our own write (true), someone else's (false), or cannot be told
 * (null: the history read decides). Built by webhooks.ts extractObjectScopes. ABSENT on a pass means UNSCOPED:
 * nothing is known about what changed, and every differing two-way cell's history is read.
 */
export interface PassScope { props: Record<string, { at: number; own: boolean | null }> }

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
   * ON REVERSE, SEND THE TEXT ONLY IN ONE STRICT SHAPE -- for a property whose valid values a label
   * dictionary cannot describe.
   *
   *   "currency": a three-letter ISO 4217 code. `deal_currency_code` and `hs_line_item_currency_code`
   *     resolve their options dynamically in HubSpot, so a fetched dictionary comes back EMPTY and every
   *     edit was refused (Deals also pointed at the pipeline dictionary by mistake). The monday cells hold
   *     bare codes -- measured 2026-09-23: Deals CNY 5,272 / USD 3,302 / HKD 10 / SGD 7; P&S CNY 7,144 /
   *     USD 2,813 / HKD 11 -- so the code IS the value.
   *   "integer": a whole number, thousands separators allowed and stripped. For a HubSpot NUMBER property
   *     shown in a monday TEXT column (`numberofemployees`), where a range like "100-500" must be refused
   *     rather than 400 the write.
   *
   * Anything else is refused and the cell healed, exactly like an unknown status label.
   */
  reverseAs?: "currency" | "integer";
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

  /**
   * THIS HUBSPOT PROPERTY IS AN INSTANT, NOT A DAY — so take its date part in the BUSINESS timezone.
   *
   * A monday date column holds a calendar day. The engine used to produce one with `value.slice(0, 10)`
   * on HubSpot's raw UTC string, which is only correct for a viewer sitting in UTC. This portal is
   * Asia/Shanghai (UTC+8, no DST), so every value from 16:00Z onward belongs to the NEXT local day and
   * the board showed the one before it. Measured: 496 of 1,399 populated `notes_last_updated` values
   * (35.5%), of which 488 are exactly 16:00:00.000Z — i.e. local midnight, the worst possible case.
   * Live example, deal 14054129559: closedate 2023-11-09T16:00:00Z is Nov 10 in Shanghai, shown as Nov 9.
   *
   * OPT-IN PER FIELD, for two separate reasons:
   *
   *  - NOT EVERY DATE PROPERTY IS AN INSTANT. HubSpot distinguishes `datetime` from `date`, and the
   *    line-item properties `service_date` and `hs_recurring_billing_start_date` are genuinely `date`
   *    (stored as midnight UTC, where the day IS the value). Shifting those is a no-op at +8h, so they
   *    are left plain rather than given a flag that suggests a conversion is happening.
   *  - THE LIVE WORK-MANAGEMENT WORKER SHARES THIS FILE. A blanket change would alter dates on its
   *    production boards on the next reconcile. Those specs carry no flag and are untouched.
   *
   * KEEP IT TO oneWay FIELDS UNTIL THE TRANSITION IS PLANNED. Moving a displayed date by a day raises a
   * diff on every existing card. Forward that is a correction. On a `reverse` field — `closedate` is the
   * only one — the direction could resolve to monday and PATCH the stale day back into HubSpot, so that
   * field is deliberately NOT flagged yet and needs its own migration.
   */
  localDate?: boolean;

  /**
   * WRITABLE AT BIRTH, READ-ONLY AFTERWARDS.
   *
   * `buildCreateProperties` emits only `reverse` fields, which is right for an update — a monday edit
   * may push back only what the spec says it owns. It is wrong for a CREATE, because a record has to be
   * born with the very key that identifies it.
   *
   * Contacts is the case that forces it. `email` is deliberately forward-only: it is the dedup key, so a
   * monday edit must never rewrite it (a typo would orphan the card from its HubSpot twin). But it is
   * also `adoptBy.col`, and the create path REFUSES to mint a record whose adoption key is absent —
   * correctly, since nothing could ever match it again and the next card would create a duplicate.
   * Marking the field `reverse` to satisfy the create would hand monday permission to rewrite the key
   * on every subsequent edit, which is the opposite of what is wanted.
   *
   * So the two directions are separated: present in the birth payload, absent from every later patch.
   */
  writeOnCreate?: boolean;

  /**
   * HUBSPOT IGNORES A MOVE TO AN EARLIER OPTION OF THIS PROPERTY UNLESS IT IS CLEARED FIRST.
   *
   * `lifecyclestage` is a pipeline, and HubSpot's API only lets it move FORWARD: a PATCH to an earlier
   * stage returns 200 and changes nothing. The documented way back is to clear it ("") and then set it,
   * which is exactly what HubSpot's own UI does (contact 553232416501, 2026-10-01: "" at 03:12:27, then
   * 6 at 03:12:28). Proven live the same day: Matthew Ng set 7 -> 3 on contact 42000269320 and hiffer set
   * 10 -> 6 -> 5 -> 6 on 553232416501; both PATCHes went out, and neither left a history entry.
   *
   * With this set, a reverse write that moves the value to an EARLIER position (the property's live
   * `displayOrder`, read with its label dictionary: see optionOrderOf in reconcile.ts) sends the clear --
   * carrying every other property of the write -- and then the move alone, after queueing a durable
   * re-check that finishes a clear whose move never followed (sendPatch and repairDanglingClears in
   * sync.ts). Forward moves, first fills, clears and unchanged values are one PATCH, as before. Requires
   * `labels`: an unknown order is never guessed, it is one PATCH and a log line.
   */
  backwardNeedsClear?: boolean;

  /**
   * CHANGED IN HUBSPOT ONLY. Never pushed by an edit: a person's monday edit of it is refused and the cell put
   * back to HubSpot's value at once (columnEditPatch), including an edit made as our own token user, which is
   * looked up like any two-way column's (uiLookupColumns). Not `oneWay`, deliberately: a oneWay column's events
   * are dropped (ignoredColumns), so the wrong value would sit on the card until HubSpot next changed the record.
   * Pair with `writeOnCreate` so a monday-created record is still born with it.
   *
   * Contact owner, from 2026-10-09 (CONTACT_OWNER_HUBSPOT_ONLY): assignment and reassignment happen in HubSpot,
   * and the monday CRM only follows. See config.ts withContactOwnerRule.
   */
  hubspotOnly?: boolean;
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
  /**
   * `placeOnly`: the group is where a NEW card is created, and nothing more. The Worker never moves an
   * existing card. Without it every reconcile compares the card's group to `singleGroup` and moves it
   * back, so any synced card left a group a person had put it in -- the CRM Contacts board's
   * "No Activity - 未跟进" emptied into "Active Contacts" whenever a card in it was edited or updated.
   */
  | { singleGroup: string; placeOnly?: boolean };

/**
 * What a person changed on a monday card, as reported by the webhook that delivered it. Carried into
 * the reconcile so a column-level spec can push exactly that and nothing else. `cols` are monday
 * column ids; `name` means the item name itself.
 */
export interface MondayEdit {
  cols: string[];
  name?: boolean;
  /** For a relation (Connect Boards) column: the linked monday item ids the person REMOVED, composed
   *  from monday's own before/after over every event coalesced into this run. The webhook sets it for
   *  every relation edit; an event whose before/after was unreadable contributes nothing to it (a missed
   *  unlink, never an invented one). A paired echo of a click already seen on the other card is left
   *  out -- that card's run owns the pair. See unlinkedCardIds and isPairedEcho. */
  unlinked?: Record<string, string[]>;
  /** For a relation column: the linked monday item ids the person ADDED, composed over every event of
   *  this person's that was coalesced into this run (monday's previousValue -> value). A column is
   *  ABSENT when any of those events lacked a usable before-value -- "cannot tell", which refuses the
   *  push and snaps the cell back; an empty list means "added nothing". See linkedCardIds. */
  linked?: Record<string, string[]>;
  /** For a relation column: how many cards the largest SINGLE event composed into this run added and
   *  removed. The per-edit caps (MAX_LINKS_PER_EDIT / MAX_UNLINKS_PER_EDIT) judge one click by it, so
   *  six quick one-card clicks queued behind a running pass are not mistaken for one bulk edit. Absent
   *  when the caller has no per-event view; the caps then judge the composed lists. */
  largestEvent?: Record<string, { added: number; removed: number }>;
  /** The monday user id behind the edit (the first event's, for a coalesced run). For logs only:
   *  relation edits are serialised per item + column + actor CLASS, and the reverse pass, which only
   *  ever runs for the person class, finds its re-check key without it. See relation-edit.ts. */
  actor?: string;
  /** For a People column: the monday PERSON ids the person removed, accumulated over every event
   *  coalesced into this run (from monday's previousValue -> value). Absent when the events did not
   *  carry both sides. See columnEditPatch's people branch. */
  removedPeople?: Record<string, string[]>;
  /** The edit was made by a monday AUTOMATION (a negative userId, e.g. -4), not a person. A FIELD edit
   *  still pushes to a record CRM already owns, but can never CLAIM one -- see isAutomationActor. A
   *  RELATION edit by an automation pushes nothing at all (logged, not snapped back): see
   *  reverseAssociations. */
  byAutomation?: boolean;
}

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
  /**
   * TWO-WAY BY COLUMN, NOT BY RECORD. When set:
   *   - a person editing a monday column pushes THAT column to HubSpot, and nothing else on the card;
   *   - a sync that did not start from a person's monday edit (a HubSpot webhook, a sweep, a restore)
   *     only ever writes MONDAY. It never writes HubSpot.
   *
   * The default engine decides direction for the whole RECORD by comparing HubSpot's lastmodifieddate
   * against the card's Sync State, then pushes every reversible column that differs. That is only safe
   * while every monday column is known to be current, and on the CRM boards it is not: a HubSpot
   * change that was never delivered leaves a stale cell, and the next unrelated edit on that card
   * would write the stale cell back over a deliberate HubSpot change. Contact 394787683005 was the live
   * example on 2026-09-23 — HubSpot's Sales User had been changed to Elaine Rivera, monday still showed
   * Myla, and a Job Title edit would have reverted HubSpot to Myla.
   *
   * Knowing the column is also what makes a CLEAR syncable. The record-level engine cannot tell "never
   * set" from "just emptied", so it never sends an empty monday value to HubSpot; a person emptying the
   * one column they edited is unambiguous.
   *
   * OPT-IN PER SPEC. The live Work-Management specs keep the record-level engine exactly.
   */
  columnLevelReverse?: boolean;
  /** Spec-driven adoption key. Absent on production WM specs, which keep their existing
   * object-specific adoption branches untouched. */
  adoptBy?: AdoptBy;
  // monday -> HubSpot record creation (new cards). false for system-populated boards (Unassigned).
  createFromMonday: boolean;
  // fixed HubSpot properties stamped on records created from monday (pipeline, owner, sales_user...).
  createDefaults?: Record<string, string>;
  /**
   * MONDAY CARDS OLDER THAN THIS NEVER CREATE A HUBSPOT RECORD. Per-spec override of the module-level
   * CREATE_CUTOFF_MS, which is a Work-Management constant (2026-07-03) and far too old to protect the
   * CRM boards.
   *
   * THIS IS THE GUARD THAT MAKES ENABLING CREATION SAFE. The Accounts board carries ~1,301 cards with a
   * name and a domain and no HubSpot id — manufactured by monday's CRM "Item association" feature, not
   * by a person. Every one of them was created in September 2026, so every one of them clears the
   * 2026-07-03 cutoff. Turning creation on without a newer cutoff would therefore, on the next column
   * change to any of those cards, adopt or CREATE a HubSpot Company for each — silently, at scale, and
   * irreversibly from monday's side (a monday deletion never deletes a HubSpot record).
   *
   * Supplied from the environment (CRM_CREATE_CUTOFF_AT) and FAILS CLOSED to Infinity, so a deployment
   * that forgets to set it creates nothing at all rather than creating everything. Go-live is then a
   * var, and rolling back is deleting that var.
   */
  createCutoffMs?: number;
  /**
   * THIS RECORD CANNOT EXIST WITHOUT A PARENT, so the parent is part of its BIRTH, not a later link.
   *
   * A HubSpot line item with no deal is not a lesser line item, it is an orphan: it appears in no
   * quote, rolls into no deal amount, and nothing in either system will ever point at it again. So the
   * association is sent in the create payload rather than PUT afterwards — a create that succeeded and
   * an association that then failed would leave exactly that orphan, and monday cannot delete a HubSpot
   * record to clean it up.
   *
   * The parent is found the way a rep sees it: the monday Connect-Boards column they filled in on the
   * form, resolved to the linked card, and then to that card's HubSpot id. If any hop fails the create
   * is REFUSED and the reason is stamped on Sync State — a visible refusal beats an invisible orphan.
   */
  createParent?: {
    toObject: "deals";
    relationCol: string;        // monday board_relation column holding the parent card
    associationTypeId: number;  // HubSpot association type id for child -> parent
  };
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
  /**
   * THE ONE GROUP MOVE THE WORKER MAKES: out of `from`, into `to`, the moment the card is WORKED -- and only
   * while NO_ACTIVITY_RELEASE is on. See no-activity.ts.
   *
   * Worked means a change, never a state: an activity reaches the card (any kind, anyone's, within a day), or a
   * pass changes one of `notWorked`'s status columns to a non-empty label that its list does not name. A card that merely SITS in
   * `from` with a worked value is left there, so whatever put it there (a person, or the board's nightly
   * sweep) is never fought over and over.
   */
  leaveWhenWorked?: { from: string; to: string; notWorked: Record<string, string[]> };
  /** No card for a record with no `hubspot_owner_id` (CONTACT_CARD_NEEDS_OWNER): see ensureCardForRecord. */
  cardNeedsOwner?: boolean;
  /**
   * THE OWNER NOTICE'S TWO COLUMNS (OWNER_NOTICE): see owner-notice.ts. The Worker DECIDES and the board's own
   * monday workflow NOTIFIES, so these name the hand-over between the two:
   *   - `statusCol`: the status column the workflow fires on ("When 通知状态 changes to 待通知"). The ONE column
   *     the Worker writes for a notice, and only ever with `pending`, at most once per assignment.
   *   - `pending` / `done`: that column's labels exactly as the board spells them. `done` is set by the workflow
   *     when it has sent; the Worker never writes it -- it is named here so the column's meaning lives in one place.
   *   - `lastToldCol`: the email column the workflow records the owner it told in (上次通知Owner). READ ONLY to
   *     the Worker: writing it was the old design, and is exactly what must never happen again.
   * The third column the notice reads is not named here: the workflow sends to the card's Contact owner, which is
   * the People column this spec maps `hubspot_owner_id` to (owner-notice.ts ownerColOf), and 待通知 is written only
   * once that cell shows HubSpot's owner. Absent on every spec but Contacts: no other board is noticed.
   */
  ownerNotice?: { lastToldCol: string; statusCol: string; pending: string; done: string };
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
  /**
   * RESOLVE `toObject` THROUGH A SECOND OBJECT, because HubSpot defines no direct association.
   *
   * A line item has no company. Verified live, not assumed:
   * `/crm/v4/associations/line_items/companies/labels` returns an EMPTY result set — the association
   * TYPE does not exist, so a plain `{ toObject: "companies" }` entry would read zero ids forever,
   * write nothing, and look like a working mapping. The company a line item belongs to is the company
   * of its DEAL, so the link has to be walked: line_item -> deals -> companies.
   *
   * FORWARD, only the READ changes. Everything after it — card resolution through the target spec's
   * idCol, on-demand card creation, the truncation guard, the full-replacement write — is the ordinary
   * relation path, untouched.
   *
   * REVERSE, it is NOT the ordinary path: the link it shows is computed, so there is no association of
   * this type to put or delete. The column-level reverse pass dispatches it to its own narrow rule
   * (fillDealCompany in associations.ts: fill the deal's company when it has none, behind
   * PS_ACCOUNT_REVERSE), and snaps every other edit back to the derived set. The whole-cell pass skips it.
   */
  via?: "deals";
  /**
   * WHEN THE HOP YIELDS MORE THAN ONE, PREFER THE ONE HUBSPOT ITSELF CALLS PRIMARY.
   *
   * A deal may carry several companies (typeId 341, unlabelled) of which exactly one is marked Primary
   * (typeId 5, HUBSPOT_DEFINED — both verified live against this portal). Writing all of them would put
   * two Accounts on a line item that belongs to one, so on a multi-company deal the Primary wins.
   *
   * Applied ONLY to break a tie. A single company that happens to carry no Primary label still links —
   * filtering it away would trade a correct link for an empty cell, which is the worse error.
   */
  viaPrimary?: boolean;
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
  /** `status_index` is present ONLY on status cells (fetched via `... on StatusValue`) and is null when
   *  the cell is unset -- see colText for why the text of an unset status must never be trusted. */
  column_values: { id: string; text: string | null; persons_and_teams?: { id: string; kind: string }[];
    status_index?: number | null }[];
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
  /**
   * The longest item name monday accepts (MONDAY_ITEM_NAME_MAX), set by buildCtx ONLY while ITEM_NAME_FIT
   * is on -- monday.ts then fits every name it writes. With it, the name diff compares the FITTED HubSpot
   * name (fitItemName), so a fitted card is never renamed again, and a name the card can show only fitted
   * is never pushed back over HubSpot's longer one (buildReversePatch, columnEditPatch). Absent: names are
   * compared and pushed exactly as before.
   */
  itemNameMax?: number;
}

export interface RunOpts {
  dryRun: boolean; writeHubspot: boolean; maxWrites: number;
  /** The HubSpot id whose DELETED card this pass re-creates (restore-card.ts). That card existed, so a rule for
   *  a record's first card -- CONTACT_CARD_NEEDS_OWNER -- does not apply to it; any other card this pass makes
   *  (an associated contact's) is still a first card. */
  restore?: string;
  /** STALE_FORWARD_GATE: what the HubSpot events behind this forward pass named. ABSENT = UNSCOPED. */
  scope?: PassScope;
}

export interface Stats {
  processed: number; created: number; toMonday: number; toHubspot: number;
  inSync: number; skipped: number; errors: number; adopted: number; createdInHubspot: number;
}

// A shared, mutable write budget threaded across all specs in one run.
export interface Budget { left: number }
