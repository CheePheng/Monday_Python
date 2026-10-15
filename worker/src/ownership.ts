import type { HsRecord, OwnershipSpec, StampState, SyncOwner, WriteAuth } from "./types";

/**
 * WRITE OWNERSHIP — the rule that keeps two two-way syncs off the same HubSpot record.
 *
 * Two monday cards for the same HubSpot record are acceptable. Two systems WRITING it are not.
 * The stamp on the record is primary; the cutover timestamp is only a fallback for records neither
 * Worker has claimed. Pure, so the rule is exhaustively testable without touching either API.
 */

/** Largest magnitude a JS Date can represent. Anything beyond it is garbage, not a timestamp. */
const MAX_DATE_MS = 8.64e15;
/** A cutover is OPERATOR CONFIG, so it is held to a plausible window — see cutoverFromEnv. */
const MIN_PLAUSIBLE_CUTOVER_MS = Date.parse("2020-01-01T00:00:00Z");
const MAX_PLAUSIBLE_CUTOVER_MS = Date.parse("2100-01-01T00:00:00Z");

/**
 * The module's ONE timestamp parser, so a given string cannot mean two different things depending
 * on which function reads it.
 *
 * Numeric strings are treated as epoch-ms and are checked FIRST, because `Date.parse("0")` returns a
 * valid date in JS (year 2000) — deferring to it would silently accept "0" as a real timestamp.
 * Anything non-finite or beyond the Date range is NaN, never a usable number: `Number("1e21")` is
 * finite and would otherwise sail through a `>=` comparison and make a garbage record claimable.
 */
function toMs(raw: unknown): number {
  const t = String(raw ?? "").trim();
  if (!t) return NaN;
  const ms = /^[+-]?\d+$/.test(t) ? Number(t) : Date.parse(t);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : NaN;
}

/**
 * The stamp's state. Three outcomes, not two:
 *  - "wm" / "crm": owned by that sync;
 *  - "": absent or blank, so the cutover fallback decides;
 *  - "other": PRESENT but unrecognised. The property is human-editable in HubSpot, so an ops user
 *    may write "hold" or "manual" to park a record. That must mean HANDS OFF for both syncs — not
 *    "unowned", which would let CRM claim it and overwrite the marker.
 */
export function syncOwnerOf(rec: HsRecord, o: OwnershipSpec): StampState {
  const v = String(rec.properties[o.prop] ?? "").trim().toLowerCase();
  if (!v) return "";
  return v === "wm" || v === "crm" ? (v as SyncOwner) : "other";
}

/**
 * May THIS Worker write this HubSpot record? Asymmetric and fail-closed:
 *  - stamped for us: allowed;
 *  - stamped for the other side, or stamped with anything unrecognised: refused;
 *  - unstamped: WM writes only pre-cutover records (the ~44k historical ones, deliberately never
 *    backfilled with a stamp). CRM may NEVER write an unstamped record — it must claim first. That
 *    ordering is precisely what stops the claim path from decaying into a general write bypass;
 *  - an unusable create date is refused, not guessed.
 *
 * `forId` binds the decision to the record it was computed for, so a decision cannot be reused
 * across records (see assertMayWrite).
 */
export function authorizeWrite(rec: HsRecord, o: OwnershipSpec): WriteAuth {
  const stamp = syncOwnerOf(rec, o);
  const deny = (reason: string): WriteAuth => ({ allowed: false, reason, forId: rec.id });
  if (stamp === "other")
    return deny(`unrecognised ${o.prop} "${String(rec.properties[o.prop]).trim()}" — hands off`);
  if (stamp) {
    return stamp === o.owner
      ? { allowed: true, reason: `stamped ${stamp}`, forId: rec.id }
      : deny(`owned by ${stamp}, this worker is ${o.owner}`);
  }
  if (o.owner === "crm") return deny("unstamped: crm must claim before writing");
  const created = toMs(rec.properties[o.createdProp]);
  if (Number.isNaN(created)) return deny(`unstamped and ${o.createdProp} unusable`);
  return created < o.cutoverAtMs
    ? { allowed: true, reason: "unstamped, pre-cutover -> wm", forId: rec.id }
    : deny("unstamped, post-cutover -> crm's to claim");
}

/**
 * Authorization for creating a BRAND-NEW HubSpot record. There is no record to authorize against —
 * ownership comes from birth stamping (withBirthOwnership), not from a prior owner. Kept explicit so
 * a create can never be waved through with an auth computed for some other record.
 */
export function authorizeCreate(o: OwnershipSpec): WriteAuth {
  return { allowed: true, reason: `new record, born ${o.owner}`, forId: NEW_RECORD_ID };
}

/** The `forId` a create carries, since the record has no id yet. */
export const NEW_RECORD_ID = "(new)";

/**
 * WHY a claim is being considered. The two bases answer different questions and must not blur.
 *
 *   "cutover"    -- the record was born after CRM_CUTOVER_AT, so it is CRM's by date. The original
 *                   rule, and still the default: every caller that does not say otherwise gets it.
 *   "human-edit" -- a PERSON just edited this record's card on a CRM board. That is the one signal
 *                   that genuinely means "this record is now worked in CRM", and it holds for a 2024
 *                   record exactly as much as for one created yesterday.
 *
 * The date-only rule could never claim the ~96% of the portal that predates the cutover, so every rep
 * edit on those cards was refused and visibly snapped back -- the reported Lifecycle Stage bug, and in
 * fact every two-way column on every older card. "human-edit" is reachable ONLY from the column-level
 * reverse path, which runs only for a webhook a person caused (never our own token's echo, never a
 * HubSpot event, never a sweep), so it cannot turn a passive reconcile into an ownership migration.
 */
export type ClaimBasis = "cutover" | "human-edit";

/**
 * May the CRM Worker CLAIM this record? A claim is a distinct operation, not a write exception —
 * its only permitted mutation is claimPatch(). On the "cutover" basis with an INFINITE cutover (the
 * Phase 1 setting) this is always false.
 *
 * On EITHER basis it is false for a record that is already stamped -- crm, wm, hold, or anything we do
 * not recognise. An explicit stamp is a decision someone made, and a claim only ever fills a blank.
 * Adoption still never claims: recreating a card links the existing record, and that is not an edit.
 */
export function canClaimCrmOwnership(rec: HsRecord, o: OwnershipSpec,
    basis: ClaimBasis = "cutover"): boolean {
  if (o.owner !== "crm") return false;      // the WM Worker never claims
  if (syncOwnerOf(rec, o)) return false;    // already owned, or parked with an unrecognised stamp
  const created = toMs(rec.properties[o.createdProp]);
  // FAIL CLOSED ON EITHER BASIS when the metadata is unreadable. An unusable createdate means the caller
  // may not have fetched the ownership properties at all -- and then a record parked as `hold` reads as
  // blank, and a human-edit claim would silently override the operator's decision.
  if (Number.isNaN(created)) return false;
  if (basis === "human-edit") return true;  // a person is working it in CRM, whatever its age
  return created >= o.cutoverAtMs;
}

/**
 * May the CRM path CREATE a missing monday card for this record?
 *
 * A separate chokepoint from authorizeWrite: that one guards HubSpot mutations, this one guards the
 * BIRTH of a monday card, and the two sit on opposite sides of the sync. CRM specs set
 * `includeAll: true`, which short-circuits recInScope to true, so this is the only thing between a
 * HubSpot event and a new card.
 *
 * IT USED TO REFUSE EVERY UNSTAMPED RECORD CREATED BEFORE CRM_CUTOVER_AT ("no historical import"),
 * and that was right while the historical import was a separate, controlled process that had not run.
 * It has run -- all history, every board, 2026-09-17/18 -- so the rule no longer protects anything
 * and only did harm: a lead created in HubSpot on 2026-09-23 got NO card, because it predates a
 * 2026-09-25 cutover, and every activity logged against it had nowhere to land (live log:
 * `refused-card reason="outside CRM creation scope"`, then `contact 557162299108 has no card after
 * bounded retry`). A record that has no card now is a GAP, and filling it is the point.
 *
 * What still refuses: a record an operator PARKED (`hold`, or any stamp we do not recognise), and one
 * the WM Worker owns (`wm`). Those are explicit decisions, not blanks.
 *
 * Consulted ONLY when no card exists, so it decides creation and never blocks updates to a card that
 * already exists. Returns true for specs without `ownership`, and for WM, so every WM path is unchanged.
 *
 * Fail-closed on missing metadata: an unparseable createdate means the caller did not fetch the
 * ownership properties, and then a `hold` stamp would read as blank. That caller declines to create.
 */
export function mayCreateCrmCard(rec: HsRecord, o: OwnershipSpec | undefined): boolean {
  if (!o) return true;                      // no ownership declared -> legacy WM behaviour
  /**
   * THE GATE IS CRM-ONLY, AND "has an ownership spec" IS NOT THE SAME QUESTION.
   *
   * This used to return early only for `!o`, using the absence of ownership as a stand-in for "this is
   * the WM deployment". That held exactly as long as WM declared none. The moment WM was given an
   * ownership spec (2026-09-22, to make it refuse crm-stamped records) the proxy inverted: WM's cutover
   * is Infinity, `created >= Infinity` is false for every record, and the WM Worker stopped carding
   * anything at all — `action=refused-card reason="outside CRM creation scope"` on a WM deal.
   *
   * The real question is whose no-historical-import invariant this is, so it asks that directly. WM has
   * always carded every record in its search scope and must keep doing so.
   */
  if (o.owner !== "crm") return true;
  const stamp = syncOwnerOf(rec, o);
  if (stamp === "other") return false;      // parked by an operator (e.g. "hold") -> hands off
  if (stamp === "wm") return false;         // the WM Worker owns it -> no CRM card
  if (stamp === "crm") return true;         // ours
  // Unstamped: a gap, whatever its age. The createdate is read only to prove the metadata was fetched.
  return !Number.isNaN(toMs(rec.properties[o.createdProp]));
}

/** The ONLY payload a claim may send. Exactly one property; anything else is a bug. */
export function claimPatch(o: OwnershipSpec): Record<string, string> {
  return { [o.prop]: o.owner };
}

/**
 * Stamp ownership into a CREATE payload. A record created by this Worker is owned by it from birth —
 * there is no prior record to claim, and leaving it unstamped would strand it behind our own write
 * guard (CRM may never write an unstamped record). Distinct from claimPatch(), which may only ever
 * touch the ownership property of an EXISTING record. Unchanged for specs without ownership.
 */
export function withBirthOwnership(
  properties: Record<string, string>, o: OwnershipSpec | undefined,
): Record<string, string> {
  return o ? { ...properties, ...claimPatch(o) } : properties;
}

/**
 * Parse CRM_CUTOVER_AT from the environment, FAILING SAFE to infinity (claiming disabled).
 *
 * Held to a PLAUSIBLE WINDOW, not merely `> 0`, because the dangerous inputs are the plausible
 * typos. `"1"`, `"2026"` (the year) and `"20261001"` (a date without separators) all parse as
 * epoch-ms a few milliseconds after 1970 — which would put the cutover in the past, make EVERY
 * record post-cutover, and hand the CRM Worker the entire portal. Bounding the result rejects those,
 * plus `"0"`, negatives, `Number("")`, overflow and malformed text, in one predicate.
 *
 * Requires an unambiguous instant: prefer ISO-8601 with an explicit offset, e.g.
 * "2026-10-01T00:00:00Z". Locale-dependent forms like "01/10/2026" are ambiguous across runtimes.
 */
export function cutoverFromEnv(raw: string | undefined): number {
  const ms = toMs(raw);
  return !Number.isNaN(ms) && ms >= MIN_PLAUSIBLE_CUTOVER_MS && ms <= MAX_PLAUSIBLE_CUTOVER_MS
    ? ms
    : Number.POSITIVE_INFINITY;
}
