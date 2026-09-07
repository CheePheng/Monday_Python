import type { HsRecord, OwnershipSpec, SyncOwner, WriteAuth } from "./types";

/**
 * WRITE OWNERSHIP — the rule that keeps two two-way syncs off the same HubSpot record.
 *
 * Two monday cards for the same HubSpot record are acceptable. Two systems WRITING it are not.
 * The stamp on the record is primary; the cutover timestamp is only a fallback for records neither
 * Worker has claimed. Pure, so the rule is exhaustively testable without touching either API.
 */

/** The stamp, normalised. "" when absent, blank, or unrecognised — never a guess. */
export function syncOwnerOf(rec: HsRecord, o: OwnershipSpec): SyncOwner | "" {
  const v = String(rec.properties[o.prop] ?? "").trim().toLowerCase();
  return v === "wm" || v === "crm" ? v : "";
}

/** ms since epoch for the record's create date, or NaN when missing/unparseable. */
function createdMs(rec: HsRecord, o: OwnershipSpec): number {
  const raw = String(rec.properties[o.createdProp] ?? "").trim();
  if (!raw) return NaN;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const epoch = Number(raw);            // HubSpot sometimes returns epoch-ms as a string
  return Number.isFinite(epoch) ? epoch : NaN;
}

/**
 * May THIS Worker write this HubSpot record? Asymmetric and fail-closed:
 *  - stamped: only the named owner writes;
 *  - unstamped: WM writes only pre-cutover records (the ~44k historical ones, deliberately never
 *    backfilled with a stamp). CRM may NEVER write an unstamped record — it must claim first. That
 *    ordering is precisely what stops the claim path from decaying into a general write bypass;
 *  - an unusable create date is refused, not guessed.
 */
export function authorizeWrite(rec: HsRecord, o: OwnershipSpec): WriteAuth {
  const stamp = syncOwnerOf(rec, o);
  if (stamp) {
    return stamp === o.owner
      ? { allowed: true, reason: `stamped ${stamp}` }
      : { allowed: false, reason: `owned by ${stamp}, this worker is ${o.owner}` };
  }
  if (o.owner === "crm") return { allowed: false, reason: "unstamped: crm must claim before writing" };
  const created = createdMs(rec, o);
  if (Number.isNaN(created)) return { allowed: false, reason: `unstamped and ${o.createdProp} unusable` };
  return created < o.cutoverAtMs
    ? { allowed: true, reason: "unstamped, pre-cutover -> wm" }
    : { allowed: false, reason: "unstamped, post-cutover -> crm's to claim" };
}

/**
 * May the CRM Worker CLAIM this record? A claim is a distinct operation, not a write exception —
 * its only permitted mutation is claimPatch(). With an INFINITE cutover (the Phase 1 setting) this
 * is always false, so the CRM path cannot write anything at all until a real date is chosen.
 *
 * Deliberately false for a pre-cutover record even when a rep has just recreated it on the CRM
 * board: adoption links the existing record so no duplicate is made, but recreating something must
 * never silently migrate ownership of history.
 */
export function canClaimCrmOwnership(rec: HsRecord, o: OwnershipSpec): boolean {
  if (o.owner !== "crm") return false;      // the WM Worker never claims
  if (syncOwnerOf(rec, o)) return false;    // already owned
  const created = createdMs(rec, o);
  return !Number.isNaN(created) && created >= o.cutoverAtMs;
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
 * The specific trap this exists to close: `Number("")` is 0, so a blank env var would otherwise make
 * every record look post-cutover and hand the CRM Worker the entire portal. Missing, blank, malformed,
 * NaN and non-positive values all disable claiming rather than enabling it everywhere.
 */
export function cutoverFromEnv(raw: string | undefined): number {
  const t = (raw ?? "").trim();
  if (!t) return Number.POSITIVE_INFINITY;
  // A purely numeric string is epoch-ms, and that check MUST come first: Date.parse("0") is a valid
  // date in JS (year 2000), so deferring to Date.parse would silently accept "0" as a real cutover.
  const ms = /^[+-]?\d+$/.test(t) ? Number(t) : Date.parse(t);
  return Number.isFinite(ms) && ms > 0 ? ms : Number.POSITIVE_INFINITY;
}
