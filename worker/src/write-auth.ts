import type { Budget, Env, HsRecord, ObjectSpec, RunOpts, WriteAuth } from "./types";
import { claimOwnership, getRecord } from "./hubspot";
import { authorizeWrite, canClaimCrmOwnership, withBirthOwnership, type ClaimBasis } from "./ownership";
import { specByObject } from "./config";

/**
 * CLAIM-THEN-WRITE, evaluated LAZILY at the moment a HubSpot business write is actually required.
 *
 * Called only once the caller knows it has real work to send — a non-empty field patch, or an
 * association that is genuinely missing. That ordering is the whole point: discovering a record,
 * creating its monday card, or reconciling HubSpot -> monday must NEVER stamp ownership. A new HubSpot
 * Contact can flow into monday CRM and stay unstamped indefinitely; ownership is claimed the first time
 * CRM needs to write BACK, and not a moment earlier.
 *
 * Returns undefined for specs without ownership, which is exactly what the legacy WM path passes today.
 *
 * LIVES IN ITS OWN MODULE because both sync.ts (field writes) and associations.ts (association writes)
 * need it, and sync.ts already imports associations.ts — importing back would be a cycle. It is not in
 * ownership.ts on purpose either: that module is deliberately PURE so the ownership rules stay
 * exhaustively testable without touching either API, and this function calls HubSpot.
 */
export async function ensureHubspotWriteAuth(env: Env, spec: ObjectSpec, budget: Budget,
    rec: { id: string; properties: Record<string, string | null> },
    opts: RunOpts, basis: ClaimBasis = "cutover"): Promise<WriteAuth | undefined> {
  const o = spec.ownership;
  if (!o) return undefined;                    // legacy WM behaviour, byte-for-byte
  const hsRec = rec as HsRecord;

  // Eligibility is re-proven inside claimOwnership too; this is not a substitute for that. It exists so
  // an INELIGIBLE record never even reaches the claim call, keeping the refusal a quiet log rather than
  // a thrown OwnershipError on the normal path. `basis` defaults to the cutover rule: only the
  // column-level reverse path, which runs for a person's monday edit and nothing else, passes
  // "human-edit".
  if (canClaimCrmOwnership(hsRec, o, basis)) {
    const mod = await claimOwnership(env, spec, hsRec, opts, basis);
    budget.left--;
    if (mod === null) {
      // Dry-run, or writeHubspot disabled. NOTHING was written, so the record is still unstamped and
      // must stay that way — stamping locally here would manufacture an "allowed" auth for a record
      // this Worker does not own, and every log line downstream would then be a lie.
      console.log(`ownership object=${spec.object} id=${rec.id} action=claim-suppressed reason="dry-run or writes disabled"`);
    } else {
      // VERIFIED TRANSITION, not an assumption: claimOwnership throws on any HubSpot error and returns the
      // new modified timestamp only on success, and claimPatch is type-constrained to exactly
      // { sync_owner: <owner> }. So "we wrote this one property and HubSpot accepted it" is a confirmed
      // fact. Reflecting it locally is deliberately preferred over a re-fetch: a re-read that lagged
      // behind its own write would refuse the business patch we just earned the right to make, and the
      // next tick would re-enter and re-claim. The window is one statement wide with no interleaved await.
      rec.properties[o.prop] = o.owner;
      rec.properties[spec.modifiedProp] = mod;
      console.log(`ownership object=${spec.object} id=${rec.id} action=claimed owner=${o.owner}`);
    }
  }

  const auth = authorizeWrite(hsRec, o);
  if (!auth.allowed)
    console.log(`ownership object=${spec.object} id=${rec.id} action=write-refused reason="${auth.reason}"`);
  return auth;
}

/**
 * WHICH SPEC'S OWNERSHIP GOVERNS A LINE-ITEM WRITE ON THIS DEPLOYMENT.
 *
 * CRM has a real `line_items` ObjectSpec. WM has none — there, a line item exists only as a SUBITEM of
 * a deal, so the deals spec's ownership governs it. Both resolve to the same `sync_owner`/`createdate`
 * contract; only the `owner` differs, which is exactly the distinction that matters.
 */
export function lineItemOwnerSpec(env: Env): ObjectSpec | undefined {
  return specByObject(env, "line_items") ?? specByObject(env, "deals");
}

/**
 * MAY THIS DEPLOYMENT MUTATE THIS EXISTING HUBSPOT LINE ITEM?
 *
 * The line item is authorized on its OWN stamp, not its deal's — a deal and its lines can in principle
 * be owned differently, and guessing from the parent would be the kind of inference this model exists
 * to avoid. Fetches only the two ownership properties.
 *
 * FAILS CLOSED: an unreadable line item yields no auth, and `assertMayWriteLineItem` throws on a
 * missing auth rather than writing.
 */
export async function lineItemWriteAuth(env: Env, lineItemId: string):
    Promise<{ spec: ObjectSpec; auth: WriteAuth } | undefined> {
  const spec = lineItemOwnerSpec(env);
  if (!spec?.ownership) return undefined;              // no ownership configured -> legacy behaviour
  const rec = await getRecord(env, "line_items", lineItemId,
    [spec.ownership.prop, spec.ownership.createdProp]);
  if (!rec) {
    return { spec, auth: { allowed: false, reason: "line item not readable", forId: lineItemId } };
  }
  const auth = authorizeWrite(rec, spec.ownership);
  if (!auth.allowed)
    console.log(`ownership object=line_items id=${lineItemId} action=write-refused reason="${auth.reason}"`);
  return { spec, auth };
}
