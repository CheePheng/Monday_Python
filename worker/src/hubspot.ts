import type { Env, HsRecord, ObjectSpec, RunOpts, WriteAuth } from "./types";
import { LINE_ITEM_WRITE_PROPS } from "./line-item-props";
import { normalizeDomain } from "./normalize";
import { canClaimCrmOwnership, claimPatch, NEW_RECORD_ID, type ClaimBasis } from "./ownership";
import { hsRateLimitRetryOn, hsRetry, hsRetryDeadlineOf } from "./hs-retry";

const BASE = "https://api.hubapi.com";

export async function hs(env: Env, method: string, path: string, body?: unknown, retries = 3): Promise<any> {
  // HS_RATE_LIMIT_RETRY: the rate-limit-aware retry (hsRateLimited). Off -- anything but the literal "true",
  // or not the CRM Worker -- every request runs through the loop below exactly as it always has.
  if (hsRateLimitRetryOn(env)) return hsRateLimited(env, method, path, body, retries);
  for (let attempt = 1; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt >= retries) throw e;                 // network error: retry
      await new Promise(res => setTimeout(res, 1500 * attempt));
      continue;
    }
    // 429 (rate limit) and 5xx (transient server error) did not durably apply for our safe/idempotent
    // calls -> back off and retry. Bounded by `retries`: creates pass retries=1, so a POST is never
    // retried and can't double-apply; searches/GET/PATCH (retries=3) ride out a blip.
    if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
      await new Promise(res => setTimeout(res, 2000 * attempt));
      continue;
    }
    if (!resp.ok) {                                    // other 4xx (and exhausted 5xx): throw now
      throw new Error(`hubspot ${method} ${path}: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    }
    if (resp.status === 204) return undefined;          // no-content (e.g. DELETE) -> nothing to parse
    const text = await resp.text();
    return text ? JSON.parse(text) : undefined;         // tolerate any other empty-body success
  }
}

// HS_RATE_LIMIT_RETRY's switch, bounds and invocation deadline live in hs-retry.ts (no run-time imports, so a
// test that mocks this module whole still runs index.ts for real); re-exported here beside hs().
export { hsRateLimitRetryOn, hsRetry, hsRetryDeadlineOf, withHsRetryDeadline } from "./hs-retry";

/** How long to wait before the next attempt, and on what -- or why not to retry at all. `final`: HubSpot's
 *  daily limit, where not even today's own retries are made (hsRateLimited). */
export type HsRetryWait = { ms: number; basis: "retry-after" | "rate-window" | "backoff" | "today" }
  | { stop: string; final?: true };

const header = (h: Headers | null | undefined, name: string): string | null => {
  const v = h?.get(name);
  return v === null || v === undefined || v.trim() === "" ? null : v.trim();
};

/**
 * HUBSPOT'S DAILY LIMIT IS SPENT: no wait of seconds can help, so a retry would only spend more of a budget
 * that is already gone. Said by the daily-remaining header, or by a 429's own body (policyName "DAILY",
 * "You have reached your daily limit.") -- the ten-second limit says "TEN_SECONDLY_ROLLING" instead.
 */
function dailyLimitSpent(h: Headers | null | undefined, status: number | null, bodyText: string): boolean {
  const daily = header(h, "x-hubspot-ratelimit-daily-remaining");
  if (daily !== null && Number(daily) <= 0) return true;
  if (status !== 429) return false;
  let policy = "";
  try { policy = String(JSON.parse(bodyText)?.policyName ?? ""); } catch { /* not JSON: the message decides */ }
  return policy.toUpperCase() === "DAILY" || /daily limit/i.test(bodyText);
}

/**
 * THE WAIT BEFORE ATTEMPT `attempt + 1` of a call whose attempt `attempt` failed retryably (`status` null:
 * the network). Pure -- the jitter is `rand`, in [0, 1) -- so every rule is pinned by test:
 *   - the attempts are spent (maxAttempts), or HubSpot's DAILY limit is (`final`): stop;
 *   - Retry-After (seconds, or an HTTP date): exactly that, never under minWaitMs -- or stop, when it asks for
 *     more than one wait may be (maxWaitMs) or than is left (see the last rule);
 *   - a 429 whose X-HubSpot-RateLimit-Remaining is 0 (or absent) beside X-HubSpot-RateLimit-Interval-
 *     Milliseconds -- that window is spent: a tenth of the window, doubling per attempt, jittered (for the
 *     10-second window ~1 s, 2 s, then the 3 s cap). That spreads a burst's calls out instead of landing them
 *     together again; it does NOT outlast the window (8 s of waiting is less than 10 s), so it rides out a
 *     window a burst has just filled, not one a burst keeps full;
 *   - anything else (a 5xx, the network, a 429 without those headers): ~0.75 s, 1.5 s, 3 s, jittered;
 *   - never longer than maxWaitMs, never past maxTotalWaitMs in all, and never past `deadlineMs` (the
 *     invocation's, withHsRetryDeadline): the last wait is shortened to what is left, and with less than
 *     minWaitMs left: stop.
 * These are the switch's OWN waits. A stop here ends the call only once today's rule is spent too
 * (hsRateLimited): only the daily limit's `final` ends it at once.
 */
export function hsRetryWait(h: Headers | null | undefined, status: number | null, bodyText: string,
    attempt: number, waitedMs: number, rand: number, nowMs: number = Date.now(), deadlineMs?: number): HsRetryWait {
  const p = hsRetry;
  if (attempt >= p.maxAttempts) return { stop: `${attempt} attempts` };
  if (dailyLimitSpent(h, status, bodyText)) return { stop: "HubSpot's daily limit is spent", final: true };
  const callLeft = p.maxTotalWaitMs - waitedMs;
  const invocationLeft = deadlineMs === undefined ? Infinity : deadlineMs - nowMs;
  const left = Math.min(callLeft, invocationLeft);
  const budgetSpent = { stop: invocationLeft < callLeft
    ? `the invocation's retry deadline (${p.invocationMs} ms) is reached`
    : `the call's wait budget (${p.maxTotalWaitMs} ms) is spent` };
  const ra = header(h, "retry-after");
  if (ra !== null) {
    const secs = Number(ra);
    const raMs = Number.isFinite(secs) ? secs * 1000 : Date.parse(ra) - nowMs;
    if (Number.isFinite(raMs)) {
      const ms = Math.max(p.minWaitMs, Math.round(raMs));
      if (ms > p.maxWaitMs) return { stop: `Retry-After ${ra} asks for more than one wait may be (${p.maxWaitMs} ms)` };
      return ms > left ? budgetSpent : { ms, basis: "retry-after" };
    }
  }
  let base = p.baseMs;
  let basis: "rate-window" | "backoff" = "backoff";
  if (status === 429) {
    const interval = Number(header(h, "x-hubspot-ratelimit-interval-milliseconds"));
    const remaining = header(h, "x-hubspot-ratelimit-remaining");
    if (Number.isFinite(interval) && interval > 0 && (remaining === null || Number(remaining) <= 0)) {
      base = interval / 10;
      basis = "rate-window";
    }
  }
  const want = Math.max(p.minWaitMs, Math.round(base * 2 ** (attempt - 1) * (0.5 + rand)));
  const ms = Math.min(want, p.maxWaitMs, left);
  return ms < p.minWaitMs ? budgetSpent : { ms, basis };
}

const pathForLog = (path: string) => (path.length > 120 ? `${path.slice(0, 117)}...` : path);

/**
 * HS_RATE_LIMIT_RETRY: hs(), with retries that honour HubSpot's rate limits (hsRetryWait), ON TOP OF the ones
 * hs() makes today -- never instead of them.
 *
 *   - A READ (GET) that gets a 429, a 5xx or a network error gets the rate-limit-aware retry, whatever
 *     `retries` its caller passed -- getRecord's retries=1 and the context build's reads included. A GET
 *     changes nothing, so repeating it cannot double anything.
 *   - Any OTHER method gets it only on a 429 -- HubSpot refused it without executing it -- and only when its
 *     caller already allows retries (`retries` > 1: patchRecord, claimOwnership, the association PUTs and
 *     DELETEs, the searches and batch reads, which are POSTs). A create passes retries=1 and is never retried
 *     (createRecord's note): neither this rule nor today's (below) ever applies to it.
 *   - TODAY'S RULE IS THE FLOOR, for every method, and no deadline cuts it: whatever hs() retries with the
 *     switch off, it still retries (while attempt < retries: 2 s x attempt after a 429 or 5xx, 1.5 s x attempt
 *     after a network error) -- and where the switch's own quicker waits spent those attempts sooner than today
 *     would, one more is made when today makes its last (todayWaits). So no call ends sooner than today's:
 *     a PATCH's 503, a search's 502 or a DELETE's dropped connection rides out a blip as before -- every
 *     non-GET caller that passes retries > 1 is idempotent or a read -- and a Retry-After longer than one wait
 *     may be falls back to today's wait instead of ending the call early. The switch gives up sooner than
 *     today in exactly one place: HubSpot's DAILY limit, where no wait can help. The invocation's deadline
 *     (withHsRetryDeadline) bounds the switch's OWN waits only -- past it a call is exactly today's.
 *   - What finally fails throws exactly what hs() throws today (`hubspot <METHOD> <path>: <status> <body>`,
 *     or the network error itself), so every caller's handling -- getRecord's 404, sendPatch's
 *     BackwardSetError, the webhook's error log -- reads it as before.
 * One log line per call that needed a retry (`retried-ok`), or that gave up after one or with a reason
 * (`gave-up`). A create's refusal logs nothing, as today. Never reached with the switch off: see hs().
 */
async function hsRateLimited(env: Env, method: string, path: string, body: unknown, retries: number): Promise<any> {
  const read = method === "GET";
  const deadline = hsRetryDeadlineOf(env);
  let waited = 0;
  /** How long hs() off would have waited, in all, by its LAST attempt: today's wait for every failed attempt it
   *  retries (2 s x attempt, 1.5 s x attempt after a network error, while attempt < retries). */
  let todayWaits = 0;
  let retried = 0;
  let last = "";
  const tag = () => `method=${method} path=${pathForLog(path)} attempts=${retried + 1} waited_ms=${waited}`;
  const pause = async (ms: number, why: string) => {
    await hsRetry.sleep(ms);
    waited += ms; retried++; last = why;
  };
  /** The wait before attempt `attempt + 1` (`status` null: the network), or why there is none -- null when
   *  neither rule ever applied (a create's 429), which says nothing, as today. */
  const nextWait = (h: Headers | null, status: number | null, text: string, attempt: number): HsRetryWait | null => {
    const today = (status === null ? 1500 : 2000) * attempt;   // today's wait after this attempt, exactly
    if (attempt < retries) todayWaits += today;
    const ours = read || (status === 429 && retries > 1)
      ? hsRetryWait(h, status, text, attempt, waited, hsRetry.random(), Date.now(), deadline) : null;
    if (ours && ("ms" in ours || ours.final)) return ours;
    // TODAY'S RULE IS THE FLOOR, and no deadline cuts it: hs() off retries this attempt...
    if (attempt < retries) return { ms: today, basis: "today" };
    // ...or, where the switch's quicker waits spent today's attempts sooner than today would, still has its
    // last attempt to make: made when today makes it.
    if (todayWaits > waited) return { ms: todayWaits - waited, basis: "today" };
    return ours;                                       // today's rule is spent as well
  };
  const gaveUp = (w: HsRetryWait | null, what: string) => {
    if (w || retried) console.log(`[hubspot] action=gave-up ${tag()} ${what}`
      + ` reason="${w && "stop" in w ? w.stop : `today's ${retries} attempts are spent`}"`);
  };
  for (let attempt = 1; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const w = nextWait(null, null, "", attempt);
      if (w && "ms" in w) { await pause(w.ms, "network"); continue; }
      gaveUp(w, "last=network");
      throw e;                                         // the network error itself, as today
    }
    if (resp.status === 429 || resp.status >= 500) {
      // Read here (it is drained before a retry either way): the daily limit is told in the body too.
      let text = "";
      let unreadable: { e: unknown } | undefined;
      try { text = await resp.text(); } catch (e) { unreadable = { e }; }
      const w = nextWait(resp.headers, resp.status, text, attempt);
      if (w && "ms" in w) { await pause(w.ms, String(resp.status)); continue; }
      gaveUp(w, `status=${resp.status}`);
      if (unreadable) throw unreadable.e;              // as today: the body read's own failure
      throw new Error(`hubspot ${method} ${path}: ${resp.status} ${text.slice(0, 300)}`);
    }
    if (!resp.ok) {                                    // any other 4xx: thrown at once, as today
      throw new Error(`hubspot ${method} ${path}: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    }
    if (retried) console.log(`[hubspot] action=retried-ok ${tag()} last=${last}`);
    if (resp.status === 204) return undefined;
    const text = await resp.text();
    return text ? JSON.parse(text) : undefined;
  }
}

/** A HubSpot mutation was attempted without, or against, write ownership. Never swallowed. */
export class OwnershipError extends Error {
  constructor(msg: string) { super(msg); this.name = "OwnershipError"; }
}

/**
 * Fail-closed write authorization.
 *
 * A spec that declares `ownership` may not be mutated without an explicit allow — so a forgotten
 * call site becomes a loud error rather than a silent write to a record another sync owns. Placed at
 * the HTTP chokepoint on purpose: a predicate that only callers consult is one missed call away from
 * writing to the wrong place.
 *
 * "Specs without `ownership` (every production WM spec) return immediately, so their behaviour is
 * unchanged" -- that sentence used to be here and is now FALSE. Every WM spec declares OWN_WM, so this
 * assert is live on BOTH deployments, and the early-out below is effectively dead for production
 * specs. Reading it as still true is how /app/clear-deal-fields, /app/clear-record-fields and the
 * phone backfill shipped with no WriteAuth: each looked safe on the assumption that WM never reached
 * the assert. A call site that omits `auth` does not degrade gracefully -- it throws.
 */
function assertMayWrite(spec: ObjectSpec, id: string, auth: WriteAuth | undefined): void {
  if (!spec.ownership) return;
  if (!auth) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} requires a WriteAuth (spec declares ownership)`);
  // The decision must belong to THIS record. A loop that computes auth once and then patches many
  // records is an ordinary mistake, and without this the guard would wave every one of them through.
  if (auth.forId !== id) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} refused: auth was computed for ${auth.forId}`);
  if (!auth.allowed) throw new OwnershipError(
    `hubspot write to ${spec.object}/${id} refused: ${auth.reason}`);
}

function propertiesFor(spec: ObjectSpec): string[] {
  // nameFallbackProps must be FETCHED or the fallback silently never fires: an unfetched property is
  // simply absent from rec.properties, which itemName cannot distinguish from empty. On CRM Contacts
  // `email` happens to be a mapped field too, but relying on that coincidence would break the moment
  // a spec named a fallback it does not otherwise map.
  const props = new Set<string>([...spec.nameProps, ...(spec.nameFallbackProps ?? []), spec.modifiedProp]);
  for (const f of spec.fields) props.add(f.hs);
  if ("prop" in spec.groupBy) props.add(spec.groupBy.prop);
  // Not a mapped field either: the coarse Stage's reverse reads it (see STAGE_ENTERED_PROP). Unfetched, it
  // would be absent, and the reverse would read every card as in line on the stage.
  if (spec.stagePipelinePairing) props.add(STAGE_ENTERED_PROP);
  // Ownership metadata is INFRASTRUCTURE, not a mapped field: it must be fetched even though no
  // monday column displays it. Omitting it makes authorizeWrite read undefined and classify every
  // record as unstamped, which would hand records to the wrong Worker. Specs without `ownership`
  // (every production WM spec) are unaffected.
  if (spec.ownership) { props.add(spec.ownership.prop); props.add(spec.ownership.createdProp); }
  return [...props];
}

export async function searchAll(env: Env, spec: ObjectSpec): Promise<HsRecord[]> {
  const results: HsRecord[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: spec.searchFilters }],
      sorts: [{ propertyName: spec.modifiedProp, direction: "DESCENDING" }],
      properties: propertiesFor(spec),
      limit: 100,
      ...(after ? { after } : {}),
    };
    const page = await hs(env, "POST", `/crm/v3/objects/${spec.object}/search`, body);
    results.push(...(page.results ?? []));
    after = page.paging?.next?.after;
  } while (after);
  return results;
}

/** Plain list pagination (NOT search) — the only way past search's 10,000-result ceiling. Used by the
 * one-time all-companies import to walk every record. */
export async function listPage(env: Env, object: string, after: string | undefined, properties: string[], limit = 100):
    Promise<{ records: HsRecord[]; next?: string }> {
  const qs = new URLSearchParams({ limit: String(limit), archived: "false", properties: properties.join(",") });
  if (after) qs.set("after", after);
  const page = await hs(env, "GET", `/crm/v3/objects/${object}?${qs.toString()}`);
  return {
    records: (page.results ?? []).map((r: any) => ({ id: String(r.id), properties: r.properties ?? {} })),
    next: page.paging?.next?.after,
  };
}

export function propertiesForSpec(spec: ObjectSpec): string[] {
  return propertiesFor(spec);
}

/** Fetch one HubSpot record by id (webhook fast path). Null if not found / archived.
 *  retries=1: one attempt, as always -- EXCEPT with HS_RATE_LIMIT_RETRY on, where hs() retries every GET on a
 *  429 / 5xx / network error with the rate-limit-aware backoff (hsRateLimited), whatever `retries` says. */
export async function getRecord(env: Env, object: string, id: string, properties: string[]):
    Promise<HsRecord | null> {
  try {
    const res = await hs(env, "GET",
      `/crm/v3/objects/${object}/${id}?properties=${encodeURIComponent(properties.join(","))}`,
      undefined, 1);
    return { id: String(res.id), properties: res.properties ?? {} };
  } catch (e) {
    if (/: 404 /.test(String(e))) return null; // deleted/archived
    throw e;
  }
}

/** Ids of records associated to `id` (HubSpot v4 associations). e.g. deal -> companies/contacts/line_items. */
/**
 * One page of associations, WITH whether HubSpot has more it did not return.
 *
 * THE CAP IS LOAD-BEARING AND WAS SILENT. This endpoint is called with `limit=100` and does not page,
 * so for any record with more than 100 associations the caller received the first 100 with no
 * indication that a tail existed. syncRelationColumn then wrote those 100 as a FULL REPLACEMENT of a
 * PAIRED board_relation column — and monday's pairing propagated the truncation, clearing the Company
 * cell of every contact outside that 100.
 *
 * Observed live on contact 2855936605: the link was set and cleared on a cycle across 2026-09-10 to
 * 09-12, every event attributed to this integration's own token, because the relation backfill (which
 * pages properly) kept re-adding what the capped read kept removing.
 *
 * None of the four existing relation guards could see it. `want` held 100 items so it was not empty;
 * every id the capped read returned DID resolve, so resolvedAllIds passed; the cards were not fresh;
 * and the sets genuinely differed. Those guards catch incomplete RESOLUTION — this is incomplete
 * READING, one layer earlier, and it needs its own signal.
 */
export interface AssocPage { ids: string[]; truncated: boolean }

export async function getAssociatedPage(env: Env, fromObject: string, id: string, toObject: string): Promise<AssocPage> {
  const res = await hs(env, "GET", `/crm/v4/objects/${fromObject}/${id}/associations/${toObject}?limit=100`, undefined, 3);
  const ids = (res.results ?? []).map((r: any) => String(r.toObjectId)).filter((x: string) => /^\d+$/.test(x));
  // HubSpot offers a cursor only when more remain, so this is its own statement that the read is partial.
  return { ids, truncated: !!res.paging?.next?.after };
}

/** Ids only. Kept so every existing caller is byte-for-byte unchanged; callers that would DESTROY data
 *  on a partial read must use getAssociatedPage and honour `truncated`. */
export async function getAssociatedIds(env: Env, fromObject: string, id: string, toObject: string): Promise<string[]> {
  return (await getAssociatedPage(env, fromObject, id, toObject)).ids;
}

/**
 * EVERY association of one record, PAGED -- and still honest about when it gave up.
 *
 * getAssociatedPage reads one page of 100 and stops. That is fine for the forward pass, which refuses on
 * `truncated`, and wrong for a decision that must see the whole set: "is this link already in HubSpot?"
 * answered from the first 100 of an Account's 300 contacts says "missing" for 200 links that exist, and
 * "what does HubSpot hold?" for a snap-back must not rewrite a cell from a fraction of the truth.
 *
 * Follows HubSpot's cursor up to `maxPages` pages of 500 (v4's own maximum). Past that it returns what it
 * has with `truncated: true`, and every caller treats that as a refusal, never as the answer.
 */
export async function getAllAssociatedIds(env: Env, fromObject: string, id: string, toObject: string,
    maxPages = 10): Promise<AssocPage> {
  const ids = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = `limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const res = await hs(env, "GET", `/crm/v4/objects/${fromObject}/${id}/associations/${toObject}?${qs}`, undefined, 3);
    for (const r of res?.results ?? []) {
      const x = String(r.toObjectId);
      if (/^\d+$/.test(x)) ids.add(x);
    }
    after = res?.paging?.next?.after;
    if (!after) return { ids: [...ids], truncated: false };
  }
  return { ids: [...ids], truncated: true };
}

/** HubSpot's own "Primary" association type for deal -> company. Verified live against this portal:
 *  `/crm/v4/associations/deals/companies/labels` returns typeId 5 HUBSPOT_DEFINED "Primary" alongside
 *  typeId 341 HUBSPOT_DEFINED with a null label. */
const PRIMARY_TYPE_ID = 5;

/**
 * TWO-LEG ASSOCIATION READ: `fromObject` -> `viaObject` -> `toObject`.
 *
 * Exists because HubSpot defines no line_item -> company association at all (the labels endpoint returns
 * an empty set), so the only way to know a line item's company is to ask its deal.
 *
 * FAILS CLOSED ON EITHER LEG. `truncated` is not a warning here, it is a refusal: syncRelationColumn
 * writes a relation column by FULL REPLACEMENT, so acting on a partial read deletes every link outside
 * the page it managed to see. That is exactly the incident the single-leg `truncated` flag was added for
 * (contact 2855936605, links set and cleared on a cycle across 2026-09-10..12). A two-leg read has two
 * chances to be partial, so both are checked and either one returns `{ ids: [], truncated: true }` —
 * which the caller's existing guard turns into "keep what is there", not "clear it".
 *
 * `primaryOnly` breaks a tie, it does not filter. See AssocSpec.viaPrimary.
 */
export async function getAssociatedVia(env: Env, fromObject: string, id: string, viaObject: string,
    toObject: string, primaryOnly = false): Promise<AssocPage> {
  const leg1 = await getAssociatedPage(env, fromObject, id, viaObject);
  if (leg1.truncated) return { ids: [], truncated: true };
  if (!leg1.ids.length) return { ids: [], truncated: false };

  const all = new Set<string>();
  const primary = new Set<string>();
  for (const viaId of leg1.ids) {
    const res = await hs(env, "GET",
      `/crm/v4/objects/${viaObject}/${viaId}/associations/${toObject}?limit=100`, undefined, 3);
    // Read the raw results rather than reusing getAssociatedPage: that helper drops `associationTypes`,
    // and the Primary tie-break is expressed entirely in them.
    if (res.paging?.next?.after) return { ids: [], truncated: true };
    for (const r of res.results ?? []) {
      const farId = String(r.toObjectId);
      if (!/^\d+$/.test(farId)) continue;
      all.add(farId);
      if ((r.associationTypes ?? []).some((t: any) => Number(t.typeId) === PRIMARY_TYPE_ID)) primary.add(farId);
    }
  }

  // Exactly one answer needs no tie-break, and a lone unlabelled company must still link.
  if (!primaryOnly || all.size <= 1) return { ids: [...all], truncated: false };
  if (primary.size === 1) return { ids: [...primary], truncated: false };
  // Ambiguous: several Primaries, or none at all. Hand back everything and let the caller log it,
  // rather than silently picking one of two companies a human can see on the deal.
  console.log(`source=hubspot object=${fromObject} id=${id} via=${viaObject} to=${toObject}`
    + ` found=${all.size} primary=${primary.size} action=no-primary-tiebreak`);
  return { ids: [...all], truncated: false };
}

/**
 * Link two HubSpot records with the DEFAULT (unlabelled) association type. Idempotent PUT, so it
 * converges with the forward pass. Used to reverse a monday Connect-Boards link a person ADDED; its
 * inverse, deleteAssociation, is used for a link a person removed -- on CRM both only from the
 * column-level reverse path, which acts on monday's own before/after and never on a card read. A
 * LABELLED link (e.g. deal -> company as Primary) goes through putAssociationTypes instead.
 *
 * OWNERSHIP-GUARDED since 2026-09-08, which is what retires the P2-1 blanket refusal in
 * associations.ts. `fromSpec` + `auth` are the same fail-closed contract patchRecord has: for a spec
 * declaring ownership, a call without a matching WriteAuth THROWS rather than writing, and
 * assertMayWrite runs BEFORE the dry-run branch so a refusal can never be mistaken for a skip.
 *
 * THE AUTH IS ON THE INITIATING RECORD ONLY, and that is a deliberate decision rather than an
 * oversight. Requiring write ownership of BOTH ends sounds safer and would in fact kill the feature:
 * 51,024 contacts in this portal are associated to companies created before the cutover, which
 * `canClaimCrmOwnership` can never claim — so a two-ended rule would refuse essentially every
 * association the business actually has. An association is a link, not a field on the far record, so
 * the rule matches a field write: you must own the record whose monday card was edited. The far end
 * only has to exist.
 *
 * PAIRED CELLS ARE ONE EDIT, NOT TWO. A monday relation column is paired with one on the far board, so
 * a single click may be reported on both cards. Authorising each report on its own record would turn
 * "the initiating record only" into "either record", and a refusal on one end into a write on the
 * other. The webhook therefore keeps only the first report of a pair (isPairedEcho in relation-edit.ts);
 * this helper still sees exactly one initiating record per click.
 */
export async function putAssociation(env: Env, fromObject: string, fromId: string,
    toObject: string, toId: string, opts: RunOpts, fromSpec?: ObjectSpec, auth?: WriteAuth): Promise<void> {
  if (fromSpec) assertMayWrite(fromSpec, fromId, auth);
  assertAssociationDefined(fromObject, toObject);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot ASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
    return;
  }
  await hs(env, "PUT", `/crm/v4/objects/${fromObject}/${fromId}/associations/default/${toObject}/${toId}`, undefined, 3);
  console.log(`hubspot ASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
}

/**
 * Remove the association between two records (reverse of putAssociation). Idempotent; 404 -> gone.
 *
 * NOT "the default association only": the v4 pair DELETE removes EVERY association type between the two
 * records, labels included -- a deal's Primary company link goes with it. That is the right meaning for a
 * person removing the card from a relation cell (the cell shows the pair, not a label), and the reason a
 * caller must be certain the removal was intended. See the unlink path in reverseAssociations.
 */
export async function deleteAssociation(env: Env, fromObject: string, fromId: string,
    toObject: string, toId: string, opts: RunOpts,
    /** Same fail-closed contract as putAssociation. Was absent entirely, which left /app/association's
     *  DELETE branch able to unlink records belonging to the other ownership domain. */
    fromSpec?: ObjectSpec, auth?: WriteAuth): Promise<boolean> {
  if (fromSpec) assertMayWrite(fromSpec, fromId, auth);   // BEFORE dry-run: a refusal is not a skip
  assertAssociationDefined(fromObject, toObject);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot UNASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
    return false;
  }
  try {
    await hs(env, "DELETE",
      `/crm/v4/objects/${fromObject}/${fromId}/associations/${toObject}/${toId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot UNASSOC ${fromObject}/${fromId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot UNASSOC ${fromObject}/${fromId} -> ${toObject}/${toId}`);
  return true;
}

/**
 * HubSpot defines NO line_item <-> company association: `/crm/v4/associations/line_items/companies/labels`
 * returns [] in both directions, verified live. A request for one cannot succeed, so it is refused here,
 * at the chokepoint, before any call -- the Products & Services "Accounts/Companies" cell is DERIVED
 * through the deal, and the only HubSpot edit it may ever cause is on the deal (see fillDealCompany).
 */
function assertAssociationDefined(fromObject: string, toObject: string): void {
  const pair = [fromObject, toObject].sort().join("|");
  if (pair === "companies|line_items")
    throw new Error(`hubspot association ${fromObject} -> ${toObject} refused: HubSpot defines no line_items <-> companies association`);
}

/** One association type to write, exactly as the v4 labelled-association PUT takes it. */
export interface AssociationType {
  associationCategory: "HUBSPOT_DEFINED" | "USER_DEFINED" | "INTEGRATOR_DEFINED";
  associationTypeId: number;
}

/**
 * Link two records WITH specific association types (labels), e.g. deal -> company as HubSpot's Primary
 * (HUBSPOT_DEFINED 5). putAssociation's `/associations/default/` path can only ever write the unlabelled
 * type; a Primary company has to be said out loud.
 *
 * Same fail-closed contract as putAssociation, and STRICTER in one respect: `fromSpec` is required, so a
 * caller cannot reach HubSpot by leaving the spec off. assertMayWrite runs first -- before the pair
 * check, the dry-run branch and any request.
 */
export async function putAssociationTypes(env: Env, fromObject: string, fromId: string,
    toObject: string, toId: string, types: AssociationType[], opts: RunOpts,
    fromSpec: ObjectSpec, auth: WriteAuth | undefined): Promise<void> {
  assertMayWrite(fromSpec, fromId, auth);
  assertAssociationDefined(fromObject, toObject);
  if (!types.length)
    throw new Error(`hubspot labelled association ${fromObject}/${fromId} -> ${toObject}/${toId}: no types`);
  const label = types.map(t => `${t.associationCategory}:${t.associationTypeId}`).join(",");
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot ASSOC ${fromObject}/${fromId} -> ${toObject}/${toId} types=${label}`);
    return;
  }
  await hs(env, "PUT", `/crm/v4/objects/${fromObject}/${fromId}/associations/${toObject}/${toId}`, types, 3);
  console.log(`hubspot ASSOC ${fromObject}/${fromId} -> ${toObject}/${toId} types=${label}`);
}

/** Create a line item and associate it to a deal (line_item->deal default type = 20). Returns the new
 * id. Requires crm.objects.line_items.write — throws 403 until the private app's scope is added. */
export async function createLineItem(env: Env, properties: Record<string, string>, dealId: string,
    opts: RunOpts, spec?: ObjectSpec, auth?: WriteAuth): Promise<string | null> {
  assertMayWriteLineItem(spec, NEW_RECORD_ID, auth);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CREATE line_item on deal ${dealId}: ${JSON.stringify(properties)}`);
    return null;
  }
  const res = await hs(env, "POST", "/crm/v3/objects/line_items", {
    properties,
    associations: [{ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 }] }],
  }, 1);
  console.log(`hubspot CREATE line_item -> ${res.id} on deal ${dealId}`);
  return res.id ? String(res.id) : null;
}

/** Create a HubSpot product (for "Save line item to the product library"). Returns the new product id. */
export async function createProduct(env: Env, properties: Record<string, string>, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun || !opts.writeHubspot) { console.log(`DRY hubspot CREATE product: ${JSON.stringify(properties)}`); return null; }
  const res = await hs(env, "POST", "/crm/v3/objects/products", { properties }, 1);
  console.log(`hubspot CREATE product -> ${res.id}`);
  return res.id ? String(res.id) : null;
}

/** For the manual line-item form: label + options for each enum line_item prop, read live from the
 * property schema so new portal options appear without a redeploy. */
export async function getWritablePropOptions(env: Env, object: string, names: string[]):
    Promise<Record<string, { label: string; options: { value: string; label: string }[] }>> {
  const res = await hs(env, "GET", `/crm/v3/properties/${object}`, undefined, 2);
  const byName: Record<string, any> = {};
  for (const p of (res.results ?? [])) byName[p.name] = p;
  const out: Record<string, { label: string; options: { value: string; label: string }[] }> = {};
  for (const n of names) {
    const p = byName[n];
    if (p) out[n] = { label: p.label ?? n, options: (p.options ?? []).map((o: any) => ({ value: String(o.value), label: o.label })) };
  }
  return out;
}

/** Update an existing HubSpot line item by id (qty/price/etc.). retries=3 (PATCH is idempotent). */
/**
 * OWNERSHIP GUARD FOR THE LINE-ITEM WRITE PATH, added 2026-09-22.
 *
 * patchLineItem / createLineItem / deleteLineItem were the last unguarded HubSpot mutations. They do
 * not take an ObjectSpec, so assertMayWrite never covered them — and the live WM Worker runs
 * LINE_ITEM_WRITE=true with reverseSubitemEdit able to patch any line item a rep edits as a subitem.
 * So a line item CRM owns was writable by WM with no check at all.
 *
 * Optional on purpose: a caller that passes no spec keeps the previous behaviour exactly, which is what
 * the CRM Deal-Cockpit app endpoints rely on. A caller that DOES pass one gets the same fail-closed
 * contract as patchRecord — no auth, wrong record, or a refusal all throw rather than writing.
 */
function assertMayWriteLineItem(spec: ObjectSpec | undefined, lineItemId: string,
    auth: WriteAuth | undefined): void {
  if (!spec) return;
  assertMayWrite(spec, lineItemId, auth);
}

export async function patchLineItem(env: Env, lineItemId: string,
    properties: Record<string, string>, opts: RunOpts,
    spec?: ObjectSpec, auth?: WriteAuth): Promise<boolean> {
  assertMayWriteLineItem(spec, lineItemId, auth);   // before the dry-run branch: a refusal is not a skip
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot PATCH line_item ${lineItemId}: ${JSON.stringify(properties)}`);
    return false;
  }
  await hs(env, "PATCH", `/crm/v3/objects/line_items/${lineItemId}`, { properties }, 3);
  console.log(`hubspot PATCH line_item ${lineItemId}: ${Object.keys(properties).join(",")}`);
  return true;
}

/** Delete a HubSpot line item by id (archive). retries=3 (DELETE is idempotent). 404 -> already gone. */
export async function deleteLineItem(env: Env, lineItemId: string, opts: RunOpts,
    spec?: ObjectSpec, auth?: WriteAuth): Promise<boolean> {
  assertMayWriteLineItem(spec, lineItemId, auth);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot DELETE line_item ${lineItemId}`);
    return false;
  }
  try {
    await hs(env, "DELETE", `/crm/v3/objects/line_items/${lineItemId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot DELETE line_item ${lineItemId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot DELETE line_item ${lineItemId}`);
  return true;
}

/** Archive (soft-delete) a HubSpot deal by id. Idempotent; 404 -> already gone. */
export async function archiveDeal(env: Env, dealId: string, opts: RunOpts,
    spec?: ObjectSpec, auth?: WriteAuth): Promise<boolean> {
  // Same guard as every other record write: before the dry-run check, so a refusal never looks like a skip.
  if (spec) assertMayWrite(spec, dealId, auth);
  if (opts.dryRun || !opts.writeHubspot) { console.log(`DRY hubspot ARCHIVE deal ${dealId}`); return false; }
  try {
    await hs(env, "DELETE", `/crm/v3/objects/deals/${dealId}`, undefined, 3);
  } catch (e) {
    if (/: 404 /.test(String(e))) { console.log(`hubspot ARCHIVE deal ${dealId}: already gone`); return true; }
    throw e;
  }
  console.log(`hubspot ARCHIVE deal ${dealId}`);
  return true;
}

// --- live search for the vibe app picker (/app/search) ---
const SEARCH_PROPS: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email"],
  companies: ["name", "domain"],
  products: ["name", "price", "hs_sku", "description"],
  deals: ["dealname"],
};

export interface SearchHit { id: string; name: string; secondary: string; sku?: string; price?: string; description?: string }

/** HubSpot result -> a compact hit for the picker. Pure (unit-testable). */
export function mapSearchResult(type: string, p: Record<string, any>): Omit<SearchHit, "id"> {
  if (type === "contacts") {
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
    return { name: name || p.email || "(no name)", secondary: p.email ?? "" };
  }
  if (type === "companies") return { name: p.name || "(no name)", secondary: p.domain ?? "" };
  if (type === "deals") return { name: p.dealname || "(no name)", secondary: "" };
  // products
  const price = p.price != null ? String(p.price) : "";
  return { name: p.name || "(no name)", secondary: price, sku: p.hs_sku ?? "", price, description: p.description ?? "" };
}

/** Full-text search one HubSpot object type; returns up to `limit` (<=20) hits plus the match total. */
export async function searchObjects(env: Env, type: string, q: string, limit: number):
    Promise<{ results: SearchHit[]; total: number }> {
  const res = await hs(env, "POST", `/crm/v3/objects/${type}/search`,
    { query: q, properties: SEARCH_PROPS[type] ?? ["name"], limit: Math.min(Math.max(limit, 1), 20) }, 2);
  const results = (res.results ?? []).map((r: any) => ({ id: String(r.id), ...mapSearchResult(type, r.properties ?? {}) }));
  return { results, total: Number(res.total ?? results.length) };
}

// --- /app/companies directory (live HubSpot company list + search) ---
export const COMPANY_LIST_PROPS = [
  "name", "domain", "industry", "type", "partner_with", "city", "state",
  "numberofemployees", "annualrevenue", "linkedin_company_page", "description",
  "createdate", "hubspot_owner_id", "sales_user",
];

export interface CompanyHit {
  hubspotId: string; name: string; domain: string; industry: string; type: string;
  partnerWith: string; city: string; state: string; employees: string; revenue: string;
  linkedin: string; description: string; createdate: string; ownerName: string; salesUser: string;
}

export interface CompanyFilters {
  ownerId?: string;
  created?: { gte?: number; lte?: number };
  activity?: { gte?: number; lte?: number };
}

/** Build the HubSpot company search body. Pure/testable. Newest-created first. Owner/date filters go in a
 * single AND'd filter group; a full-text query (when present) is sent alongside and ANDs with it. */
export function companySearchBody(args: { q?: string; after?: string; limit?: number } & CompanyFilters): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: COMPANY_LIST_PROPS,
    limit,
  };
  const filters: Record<string, unknown>[] = [];
  if (args.ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: args.ownerId });
  if (args.created?.gte != null) filters.push({ propertyName: "createdate", operator: "GTE", value: args.created.gte });
  if (args.created?.lte != null) filters.push({ propertyName: "createdate", operator: "LTE", value: args.created.lte });
  if (args.activity?.gte != null) filters.push({ propertyName: "notes_last_updated", operator: "GTE", value: args.activity.gte });
  if (args.activity?.lte != null) filters.push({ propertyName: "notes_last_updated", operator: "LTE", value: args.activity.lte });
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  if (filters.length) body.filterGroups = [{ filters }];
  else if (!query) body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** HubSpot owners -> sorted [{id,name}] for the Company-owner filter dropdown. Pure/testable.
 *
 *  ARCHIVED OWNERS ARE EXCLUDED HERE, and only here. getOwners now returns them so that a `sales_user`
 *  pointing at a departed rep still RESOLVES TO A NAME for display; but this list is a CHOICE offered
 *  in the app, and a rep must not be able to assign work to someone who has left. Keeping the two
 *  concerns apart is the whole reason getOwners carries the `archived` flag rather than just merging. */
export function mapOwners(ownersById: Record<string, { name: string; email: string | null; archived?: boolean }>): { id: string; name: string }[] {
  return Object.entries(ownersById)
    .filter(([, o]) => o.name?.trim() && !o.archived)
    .map(([id, o]) => ({ id, name: o.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Map one HubSpot company result's properties to a CompanyHit (minus id). Pure/testable. `labels` is
 * ctx.labels; the enum fields (industry/type/partner_with/sales_user) resolve to display labels, falling
 * back to the raw value if unmapped. */
export function mapCompanyResult(
  p: Record<string, any>,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Omit<CompanyHit, "hubspotId"> {
  const lab = (dict: string, v: string) => (v ? (labels?.[dict]?.[v] ?? v) : "");
  return {
    name: p.name ?? "", domain: p.domain ?? "",
    industry: lab("industry", p.industry ?? ""),
    type: lab("companyType", p.type ?? ""),
    partnerWith: lab("partnerWith", p.partner_with ?? ""),
    city: p.city ?? "", state: p.state ?? "",
    employees: p.numberofemployees ?? "", revenue: p.annualrevenue ?? "",
    linkedin: p.linkedin_company_page ?? "", description: p.description ?? "",
    createdate: p.createdate ?? "",
    ownerName: p.hubspot_owner_id ? (ownersById[p.hubspot_owner_id]?.name ?? "") : "",
    salesUser: lab("salesUser", p.sales_user ?? ""),
  };
}

/** Live company list/search for /app/companies. Returns mapped hits + the next-page cursor (or null). */
export async function listCompanies(
  env: Env,
  args: { q?: string; after?: string; limit?: number } & CompanyFilters,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Promise<{ items: CompanyHit[]; after: string | null }> {
  const res = await hs(env, "POST", "/crm/v3/objects/companies/search", companySearchBody(args), 2);
  const items = (res.results ?? []).map((r: any) => ({
    hubspotId: String(r.id), ...mapCompanyResult(r.properties ?? {}, ownersById, labels),
  }));
  return { items, after: res.paging?.next?.after ?? null };
}

// --- /app/contacts directory (live HubSpot contact list + search) ---
export const CONTACT_LIST_PROPS = [
  "firstname", "lastname", "email", "phone", "jobtitle", "company",
  "hs_lead_status", "leadsource", "createdate", "hubspot_owner_id", "sales_user", "notes_last_updated",
];

export interface ContactHit {
  hubspotId: string; name: string; email: string; phone: string; jobtitle: string; company: string;
  leadStatus: string; leadSource: string; createdate: string; ownerName: string; salesUser: string;
}

/** Build the HubSpot contact search body. Pure/testable. Same shape as companySearchBody. */
export function contactSearchBody(args: { q?: string; after?: string; limit?: number } & CompanyFilters): Record<string, unknown> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
  const body: Record<string, unknown> = {
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: CONTACT_LIST_PROPS,
    limit,
  };
  const filters: Record<string, unknown>[] = [];
  if (args.ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: args.ownerId });
  if (args.created?.gte != null) filters.push({ propertyName: "createdate", operator: "GTE", value: args.created.gte });
  if (args.created?.lte != null) filters.push({ propertyName: "createdate", operator: "LTE", value: args.created.lte });
  if (args.activity?.gte != null) filters.push({ propertyName: "notes_last_updated", operator: "GTE", value: args.activity.gte });
  if (args.activity?.lte != null) filters.push({ propertyName: "notes_last_updated", operator: "LTE", value: args.activity.lte });
  const query = (args.q ?? "").trim();
  if (query) body.query = query;
  if (filters.length) body.filterGroups = [{ filters }];
  else if (!query) body.filterGroups = [{ filters: [{ propertyName: "createdate", operator: "HAS_PROPERTY" }] }];
  if (args.after) body.after = args.after;
  return body;
}

/** Map one HubSpot contact result to a ContactHit (minus id). Pure/testable. */
export function mapContactResult(
  p: Record<string, any>,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Omit<ContactHit, "hubspotId"> {
  const lab = (dict: string, v: string) => (v ? (labels?.[dict]?.[v] ?? v) : "");
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? "");
  return {
    name, email: p.email ?? "", phone: p.phone ?? "", jobtitle: p.jobtitle ?? "", company: p.company ?? "",
    leadStatus: lab("leadStatus", p.hs_lead_status ?? ""),
    leadSource: lab("contactSource", p.leadsource ?? ""),
    createdate: p.createdate ?? "",
    ownerName: p.hubspot_owner_id ? (ownersById[p.hubspot_owner_id]?.name ?? "") : "",
    // sales_user holds a raw HubSpot OWNER ID; resolve it through the label dict like mapCompanyResult
    // does, or the directory's Owner column shows a bare id (e.g. "70154321") for owner-less contacts.
    salesUser: lab("salesUser", p.sales_user ?? ""),
  };
}

/** Live contact list/search for /app/contacts. Returns mapped hits + the next-page cursor (or null). */
export async function listContacts(
  env: Env,
  args: { q?: string; after?: string; limit?: number } & CompanyFilters,
  ownersById: Record<string, { name: string; email: string | null }>,
  labels: Partial<Record<string, Record<string, string>>>,
): Promise<{ items: ContactHit[]; after: string | null }> {
  const res = await hs(env, "POST", "/crm/v3/objects/contacts/search", contactSearchBody(args), 2);
  const items = (res.results ?? []).map((r: any) => ({
    hubspotId: String(r.id), ...mapContactResult(r.properties ?? {}, ownersById, labels),
  }));
  return { items, after: res.paging?.next?.after ?? null };
}

/** Map an associated record for /app/associations. companies -> {hubspotId,name}; contacts also carry
 * email + jobtitle. Pure/testable. */
export function mapAssocRecord(
  to: string, rec: { id: string; properties: Record<string, string | null> },
): { hubspotId: string; name: string; email?: string; title?: string } {
  const p = rec.properties;
  if (to === "companies") return { hubspotId: rec.id, name: (p.name || p.domain || "").trim() };
  if (to === "contacts") {
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || (p.email ?? "");
    return { hubspotId: rec.id, name, email: p.email ?? "", title: p.jobtitle ?? "" };
  }
  if (to === "deals") return { hubspotId: rec.id, name: (p.dealname ?? "").trim() };
  return { hubspotId: rec.id, name: "" };
}

// note -> object default association type ids (HUBSPOT_DEFINED).
const NOTE_ASSOC: Record<string, number> = { deals: 214, contacts: 202, companies: 190 };

/** Create a HubSpot note associated to a deal/contact/company — a monday Update mirrored to Activities. */
export async function createNote(env: Env, body: string, tsMs: number, ownerId: string | undefined,
    objectType: string, objectId: string, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CREATE note on ${objectType}/${objectId}: ${body.slice(0, 80)}`);
    return null;
  }
  const props: Record<string, string> = { hs_note_body: body, hs_timestamp: String(tsMs) };
  if (ownerId) props["hubspot_owner_id"] = ownerId;
  const res = await hs(env, "POST", "/crm/v3/objects/notes", {
    properties: props,
    associations: [{ to: { id: objectId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_ASSOC[objectType] ?? 214 }] }],
  }, 1);
  console.log(`hubspot CREATE note -> ${res.id} on ${objectType}/${objectId}`);
  return res.id ? String(res.id) : null;
}

/** Batch-read records by id (names for association columns, or line-item fields). Empty ids -> []. */
export async function getRecordsByIds(env: Env, object: string, ids: string[], properties: string[]): Promise<HsRecord[]> {
  if (!ids.length) return [];
  const res = await hs(env, "POST", `/crm/v3/objects/${object}/batch/read`,
    { properties, inputs: ids.map(id => ({ id })) });
  return (res.results ?? []).map((r: any) => ({ id: String(r.id), properties: r.properties ?? {} }));
}

/** Fetch a deal's CURRENT HubSpot line items, mapped to the app editor's row shape (core fields + a full
 * `props` bag of the writable extended fields for re-editing). Read-only. */
export async function getDealLineItems(env: Env, dealId: string):
    Promise<{ lineItemId: string; productId?: string; name: string; unitPrice: string; quantity: string;
      currency?: string; description?: string; discount?: string; discountPct?: string;
      discountMode: "amount" | "percent"; serviceDate?: string; props: Record<string, string> }[]> {
  const ids = await getAssociatedIds(env, "deals", dealId, "line_items");
  if (!ids.length) return [];
  const recs = await getRecordsByIds(env, "line_items", ids, [...LINE_ITEM_WRITE_PROPS]);
  return recs.map(r => {
    const p = r.properties as Record<string, string>;
    const props: Record<string, string> = {};
    for (const k of LINE_ITEM_WRITE_PROPS) if (p[k] != null && p[k] !== "") props[k] = String(p[k]);
    return {
      lineItemId: String(r.id), productId: p.hs_product_id || undefined,
      name: p.name ?? "", unitPrice: p.price ?? "", quantity: p.quantity ?? "1",
      currency: p.hs_line_item_currency_code || undefined, description: p.description || undefined,
      discount: p.discount || undefined, discountPct: p.hs_discount_percentage || undefined,
      discountMode: p.hs_discount_percentage ? "percent" : "amount",
      serviceDate: p.service_date || undefined, props,
    };
  });
}

/** Ids of records matching a spec that changed at/after `sinceMs`. Paginates (up to `maxPages` pages of
 * 100) so a bulk import that changes many records in one window is fully swept by the 10-min backup, not
 * capped at the first 100. The write BUDGET still throttles how many are pushed per tick. */
export async function searchModifiedIds(env: Env, spec: ObjectSpec, sinceMs: number, maxPages = 20): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    // OR'd scope groups, each AND'd with the modified-date filter (HubSpot: groups OR, filters-in-group AND).
    const mod = { propertyName: spec.modifiedProp, operator: "GTE" as const, value: sinceMs };
    const groups: Record<string, unknown>[][] = spec.includeAll
      ? [[mod]]
      : [[...spec.searchFilters, mod],
         ...(spec.scopeAlsoLinkedProp
           ? [[{ propertyName: spec.scopeAlsoLinkedProp, operator: "HAS_PROPERTY" as const }, mod]] : [])];
    const body: Record<string, unknown> = {
      filterGroups: groups.map(filters => ({ filters })),
      sorts: [{ propertyName: spec.modifiedProp, direction: "DESCENDING" }],
      properties: ["hs_object_id"], limit: 100,
      ...(after ? { after } : {}),
    };
    const page = await hs(env, "POST", `/crm/v3/objects/${spec.object}/search`, body);
    for (const r of page.results ?? []) ids.push(String(r.id));
    after = page.paging?.next?.after;
  } while (after && ++pages < maxPages);
  return ids;
}

/** PATCH existing record (update-only). Returns the record's new modified timestamp (for Sync
 * State), or null when not actually written (dry / reverse writes disabled). */
export async function patchRecord(env: Env, spec: ObjectSpec, id: string,
    properties: Record<string, string>, opts: RunOpts, auth?: WriteAuth): Promise<string | null> {
  assertMayWrite(spec, id, auth);   // before the dry-run check: a refusal must never look like a skip
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot PATCH ${spec.object}/${id}: ${JSON.stringify(properties)}`);
    return null;
  }
  const res = await hs(env, "PATCH", `/crm/v3/objects/${spec.object}/${id}`, { properties });
  console.log(`hubspot PATCH ${spec.object}/${id}: ${Object.keys(properties).join(",")}`);
  reportIgnoredWrites(spec, id, properties, res?.properties);
  return res.properties?.[spec.modifiedProp] ?? null;
}

/** CREATE a new record from a monday card. Returns {id, modified}, or null when not written. */
export async function createRecord(env: Env, spec: ObjectSpec, properties: Record<string, string>,
    opts: RunOpts, auth?: WriteAuth,
    /** Parent links sent WITH the create. See ObjectSpec.createParent — a line item whose association
     *  were PUT afterwards would be an orphan for as long as that second call took, and permanently if
     *  it failed. HubSpot accepts them atomically, so this takes the atomic route. */
    associations?: { toId: string; associationTypeId: number }[]): Promise<{ id: string; modified: string } | null> {
  assertMayWrite(spec, "(new)", auth);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CREATE ${spec.object}: ${JSON.stringify(properties)}`
      + (associations?.length ? ` assoc=${associations.map(a => a.toId).join(",")}` : ""));
    return null;
  }
  const body: Record<string, unknown> = { properties };
  if (associations?.length) body.associations = associations.map(a => ({
    to: { id: a.toId },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.associationTypeId }],
  }));
  // retries=1: a CREATE is not idempotent — a network retry after HubSpot already processed the POST
  // would make a duplicate record. (A 429 means it was NOT processed, but with retries=1 we simply
  // surface it and let the card re-create next tick, which is safe.)
  const res = await hs(env, "POST", `/crm/v3/objects/${spec.object}`, body, 1);
  console.log(`hubspot CREATE ${spec.object} -> ${res.id}`
    + (associations?.length ? ` on ${associations.map(a => a.toId).join(",")}` : ""));
  return { id: String(res.id), modified: res.properties?.[spec.modifiedProp] ?? "" };
}

/**
 * Claim CRM write ownership of an EXISTING HubSpot record.
 *
 * The only mutation permitted on an unclaimed record, and its payload is exactly one property
 * (claimPatch). Deliberately NOT routed through patchRecord: widening the write guard can never
 * widen this, and widening this can never write a business field. A brand-new record created from
 * monday is a different case — it is born owned via withBirthOwnership() in the create payload.
 */
export async function claimOwnership(env: Env, spec: ObjectSpec, rec: HsRecord,
    opts: RunOpts, basis: ClaimBasis = "cutover"): Promise<string | null> {
  if (!spec.ownership) throw new OwnershipError(`claimOwnership on ${spec.object}: no ownership spec`);
  // Eligibility is asserted HERE, not left to the caller. authorizeWrite returns allowed:false for
  // two very different reasons — "unstamped: crm must claim" and "owned by wm" — so the natural
  // wiring `if (!auth.allowed) claim()` would stamp crm onto every WM-owned record. This repo has a
  // live incident of exactly that shape (silent owner reassignment on a passive reconcile), and the
  // guard's own principle is that a predicate only callers consult is one missed call from disaster.
  // The basis is re-checked with the SAME value the caller used, so a human-edit claim cannot be
  // smuggled in by a path that only proved the cutover rule, or the reverse.
  if (!canClaimCrmOwnership(rec, spec.ownership, basis)) throw new OwnershipError(
    `claim refused for ${spec.object}/${rec.id}: not eligible (stamp/${basis})`);
  const properties = claimPatch(spec.ownership);
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot CLAIM ${spec.object}/${rec.id}: ${JSON.stringify(properties)}`);
    return null;
  }
  const res = await hs(env, "PATCH", `/crm/v3/objects/${spec.object}/${rec.id}`, { properties });
  console.log(`hubspot CLAIM ${spec.object}/${rec.id} -> ${spec.ownership.owner}`);
  return res.properties?.[spec.modifiedProp] ?? null;
}

/** Find a HubSpot contact by exact email (for adopt-if-exists). Null if none. */
export async function searchContactByEmail(env: Env, email: string):
    Promise<{ id: string; modified: string } | null> {
  const body = {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email.trim().toLowerCase() }] }],
    properties: ["lastmodifieddate"], limit: 1,
  };
  const res = await hs(env, "POST", "/crm/v3/objects/contacts/search", body);
  const hit = res.results?.[0];
  return hit ? { id: String(hit.id), modified: hit.properties?.lastmodifieddate ?? "" } : null;
}

/** Find a HubSpot company by exact normalized domain (for reuse-if-exists). Null if none/blank. */
export async function searchCompanyByDomain(env: Env, domain: string):
    Promise<{ id: string; modified: string } | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const body = {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: d }] }],
    properties: ["hs_lastmodifieddate"], limit: 1,
  };
  const res = await hs(env, "POST", "/crm/v3/objects/companies/search", body);
  const hit = res.results?.[0];
  return hit ? { id: String(hit.id), modified: hit.properties?.hs_lastmodifieddate ?? "" } : null;
}

/**
 * Every HubSpot owner, INCLUDING ARCHIVED ones.
 *
 * `/crm/v3/owners/` returns only ACTIVE owners — 42 in this portal. There are also 50 archived owners
 * (27 with names), and 481 contacts plus 32 companies still carry a `sales_user` pointing at one of
 * those departed reps (measured live 2026-09-08). Without them the `salesUser` dictionary cannot
 * resolve the id, so formatValue's `dict[v] ?? v` writes the RAW OWNER ID to monday — and since every
 * write sets `create_labels_if_missing:true`, monday then creates a dropdown label literally named
 * "275262201". Reassigning those 481 records is not on the table, so the sync has to read history.
 *
 * ACTIVE IS FETCHED SECOND AND THEREFORE WINS. If an archived owner shares an email with an active one,
 * the active record must be the one that ends up in ownerIdByEmail, or a monday people-column edit
 * could reverse onto a deactivated owner.
 *
 * `archived` is carried through so consumers that offer owners as a CHOICE can exclude them — a rep
 * must not be able to ASSIGN a departed colleague. Only display resolution wants the full set.
 */
export async function getOwners(env: Env): Promise<Record<string, { name: string; email: string | null; archived?: boolean }>> {
  const out: Record<string, { name: string; email: string | null; archived?: boolean }> = {};
  for (const archived of [true, false]) {
    let after: string | undefined;
    do {
      const path = `/crm/v3/owners/?limit=100${archived ? "&archived=true" : ""}${after ? `&after=${after}` : ""}`;
      const res = await hs(env, "GET", path);
      for (const o of res.results ?? [])
        out[String(o.id)] = {
          name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim(),
          email: o.email ?? null,
          ...(archived ? { archived: true } : {}),
        };
      after = res.paging?.next?.after;
    } while (after);
  }
  return out;
}

/** Deal stage id -> label from the pipelines API. The `dealstage` PROPERTY has no options
 * (stages live on the pipeline), so this is the correct source for stage display labels. */
export async function getDealStageLabels(env: Env, pipelineId = "default"): Promise<Record<string, string>> {
  const res = await hs(env, "GET", "/crm/v3/pipelines/deals");
  const pipe = (res.results ?? []).find((p: any) => p.id === pipelineId);
  const out: Record<string, string> = {};
  for (const s of pipe?.stages ?? []) out[String(s.id)] = String(s.label);
  return out;
}

/**
 * THE CRM STAGE DICTIONARIES — every pipeline, with PIPELINE-QUALIFIED stage labels.
 *
 * getDealStageLabels above reads ONE pipeline (default) and is what the Work-Management sync uses.
 * That is unusable for CRM, for a reason that is a property of this portal's data rather than a
 * preference: `dealstage` has 42 values across 5 pipelines, and THE LABELS ARE NOT UNIQUE. The three
 * Salesforce pipelines each use the same nine Chinese stage names, so `赢单` alone is three different
 * stage ids. Our reverse mapping inverts a label -> value dictionary, so an unqualified dictionary
 * would collapse those three into one and a monday-side edit could move a deal into ANOTHER
 * PIPELINE's stage — which is what reporting, forecasting and the Won automations key off. A wrong
 * stage write does not fail loudly; it silently relocates the deal.
 *
 * Qualifying each label with its pipeline restores uniqueness, which is what makes the inverse a
 * function and the reverse write safe.
 *
 * PREFIXES ARE KEYED BY PIPELINE ID, NOT BY LABEL, because a pipeline can be renamed in the HubSpot
 * UI and ids cannot. An unknown pipeline falls back to its own label rather than being dropped, so a
 * pipeline added later still produces a unique, if longer, label instead of silently colliding.
 */
const CRM_PIPELINE_PREFIX: Record<string, string> = {
  "default": "Sales",
  "551f4f6c-ced0-4069-b1be-f0d3dc33bf2d": "SF-Sales",
  "d10159b0-bab4-487a-a11f-55f3a682a170": "SF-Maint",
  "08554d8d-265d-4fbf-94e2-7002cb1ecbca": "SF-Train",
  "81ee3345-1b0f-42aa-9e78-580614546602": "Shared",
};

export interface CrmStageDicts {
  /** pipeline id -> pipeline label */
  pipelines: Record<string, string>;
  /** stage id -> "<prefix> / <stage label>", unique across all pipelines */
  stages: Record<string, string>;
  /** stage id -> the pipeline id that stage belongs to */
  pipelineByStage: Record<string, string>;
  /** stage id -> one of COARSE_STAGES, for the board's native Stage column. See coarseStageOf. */
  coarse: Record<string, string>;
}

/**
 * The ONLY labels the monday "Stage" status column may ever receive. They are the five the board
 * already had; nothing here may invent a sixth.
 *
 * WHY THIS LIST IS CLOSED. Every monday write sets `create_labels_if_missing: true`, so any value
 * that is not already a label CREATES one. On 2026-09-15 the coarse column was mapped to the `stage`
 * dictionary — which `getDealStageLabels` builds from the DEFAULT PIPELINE ONLY — so every deal in
 * the four Salesforce pipelines fell through `dict[v] ?? v` and minted a status label named after a
 * raw stage GUID. 8 of them appeared in the first 70 cards, and a monday status column degrades above
 * roughly 19 labels; the import was two labels from wedging the column for everyone.
 */
export const COARSE_STAGES = ["New", "Proposal", "Negotiation", "Won", "Lost"] as const;
export type CoarseStage = typeof COARSE_STAGES[number];

/** HubSpot stage metadata arrives as the STRINGS "true"/"false" as often as as booleans. */
const isTrue = (x: unknown): boolean => x === true || x === "true";

type PipelineStage = { id: unknown; displayOrder?: unknown; metadata?: Record<string, unknown> };

/** A pipeline's stages in funnel order: by displayOrder, ties keeping HubSpot's array order. The ONE
 *  ordering both coarseStageOf and coarseStageTargets read, so "first" (or "last") in a bucket means the
 *  same stage to both. */
function byDisplayOrder<T extends PipelineStage>(stages: T[]): T[] {
  return [...stages].sort((a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0));
}

/**
 * One pipeline's stages -> coarse label, keyed by stage id.
 *
 * DERIVED FROM METADATA, NEVER FROM LABEL TEXT. The three Salesforce pipelines reuse the same nine
 * Chinese stage names, so `赢单` alone is three different stage ids in three pipelines — matching on
 * text would collapse them and could bucket a live deal as Won. `isClosedWon` / `isClosed` are
 * per-stage facts HubSpot maintains, and they are the same facts its own forecasting uses.
 *
 * Open stages are bucketed by ORDERED POSITION among the open stages of their own pipeline, in
 * thirds. Position is the only ordering property every pipeline shares regardless of naming, and it
 * keeps a 9-stage Salesforce pipeline and a 4-stage default pipeline mapping onto the same five
 * labels without either needing a hand-written table that would rot the next time someone edits a
 * pipeline in the HubSpot UI.
 */
export function coarseStageOf(stages: PipelineStage[]): Record<string, string> {
  const out: Record<string, string> = {};
  const open: string[] = [];
  const ordered = byDisplayOrder(stages);
  for (const s of ordered) {
    const sid = String(s.id);
    const md = s.metadata ?? {};
    // Won before Lost: a closed-won stage is also closed, so testing `isClosed` first would call
    // every won deal lost — and 3,640 of this portal's deals are closed won.
    if (isTrue(md.isClosedWon) || (isTrue(md.isClosed) && Number(md.probability) === 1)) out[sid] = "Won";
    else if (isTrue(md.isClosed)) out[sid] = "Lost";
    else open.push(sid);
  }
  const n = open.length;
  open.forEach((sid, i) => {
    out[sid] = i < n / 3 ? "New" : i < (2 * n) / 3 ? "Proposal" : "Negotiation";
  });
  return out;
}

/**
 * THE WAY BACK FROM A COARSE LABEL, for ONE pipeline: label -> the stage a person's edit of the native
 * Stage column moves a deal to (STAGE_COARSE_REVERSE; see columnEditPatch).
 *
 * Always a stage coarseStageOf itself puts in that bucket. Not a second copy of the rule: the bucket IS
 * coarseStageOf's answer, so a stage chosen here always reads back as the very label that chose it, and
 * the round trip cannot drift. WHICH stage of the bucket, by displayOrder:
 *   - New / Proposal / Negotiation: the FIRST open stage of that third;
 *   - Won: the FIRST closed-won stage (isClosedWon, or closed at probability 1). The Sales Pipeline's
 *     later `Trustpilot邀约评价（已成交）` (closed, probability 1) is a post-sale step after Closed Won;
 *   - Lost: the LAST other closed stage -- the pipeline's terminal lost stage.
 *
 * WHY LOST IS THE LAST ONE. Measured 2026-10-01 (GET /crm/v3/pipelines/deals): each of the three
 * Salesforce pipelines -- about 7,900 of the portal's 8,651 deals -- holds TWO closed, not-won stages,
 * `暂停` (Paused) and `输单` (Lost), with the same metadata ({isClosed: "true", probability: "0.0"}),
 * and 暂停 comes FIRST (displayOrder 6 / 13 / 13 against 8 / 17 / 17). Metadata cannot tell them apart,
 * so "first" sent a person's Lost to Paused. The last closed-not-won stage is 输单 / closedlost /
 * Closed Lost on all five live pipelines; a pause step sits before the terminal outcome, never after it.
 * (coarseStageOf still shows 暂停 as Lost -- there is no sixth label for it.)
 *
 * A label the pipeline has no stage for is absent.
 */
export function coarseStageTargets(stages: PipelineStage[]): Partial<Record<CoarseStage, string>> {
  const bucket = coarseStageOf(stages);
  const out: Partial<Record<CoarseStage, string>> = {};
  for (const s of byDisplayOrder(stages)) {
    const label = bucket[String(s.id)] as CoarseStage | undefined;
    // Lost keeps overwriting, so the last one in funnel order stands; every other label keeps its first.
    if (label && (label === "Lost" || !(label in out))) out[label] = String(s.id);
  }
  return out;
}

/** pipeline id -> coarseStageTargets for that pipeline. */
export type CoarseTargets = Record<string, Partial<Record<CoarseStage, string>>>;

/**
 * The targets, keyed by the `coarse` dictionary they were built beside.
 *
 * WHY A SIDE TABLE. buildCtx hands the reverse path exactly `coarse`, `stages`, `pipelines` and
 * `pipelineByStage` -- flat maps that cannot say which stage comes FIRST in a pipeline -- and adding a
 * fifth map to Ctx is a change to buildCtx and the Ctx type for one flagged column. Keyed by the object
 * itself, the targets can only ever be read beside the dictionary they were built with, never a stale or
 * foreign one. A dictionary built any other way (a test's hand-made ctx, a copy) has no entry, and the
 * reverse REFUSES rather than guessing a stage: see coarseTargetsFor's callers.
 */
const COARSE_TARGETS = new WeakMap<Record<string, string>, CoarseTargets>();

/** The coarse -> stage targets built beside this `coarse` dictionary, or undefined if there are none. */
export function coarseTargetsFor(coarse: Record<string, string> | undefined): CoarseTargets | undefined {
  return coarse ? COARSE_TARGETS.get(coarse) : undefined;
}

/**
 * WHEN THE DEAL ENTERED ITS CURRENT STAGE: the one HubSpot time that moves with the stage and with nothing
 * else. Fetched for every spec with a stagePipelinePairing (propertiesFor), read by the coarse Stage's
 * reverse to tell a card behind HubSpot ON THE STAGE from one behind it for any other reason.
 *
 * WHY NOT hs_lastmodifieddate. It moves for everything: a customer's email reply
 * (hs_latest_sales_email_reply_date, a rollup no webhook reports), a post-create recalculation, a clone,
 * an edit of any other property. Measured live 2026-10-01 (read-only): 29 of the 150 most recently updated
 * Deals cards have hs_lastmodifieddate after Sync State, and this property is after it on ONE of them --
 * the one whose stage a HubSpot user really changed. On 150 of 150 it equals the dealstage history's own
 * latest timestamp; it is ISO text (epoch milliseconds are read too); and on the 12 cards whose stage an
 * integration last wrote it is 344 ms or more BEFORE Sync State, so our own push never reads as a change.
 */
export const STAGE_ENTERED_PROP = "hs_v2_date_entered_current_stage";

/** The four maps (and the coarse targets) from the pipelines API's `results`. Pure: see getCrmStageDicts. */
export function crmStageDictsOf(results: { id: unknown; label?: unknown; stages?: (PipelineStage & { label?: unknown })[] }[]):
    CrmStageDicts {
  const out: CrmStageDicts = { pipelines: {}, stages: {}, pipelineByStage: {}, coarse: {} };
  const targets: CoarseTargets = {};
  for (const p of results) {
    const pid = String(p.id);
    const plabel = String(p.label ?? pid);
    out.pipelines[pid] = plabel;
    const prefix = CRM_PIPELINE_PREFIX[pid] ?? plabel;
    for (const s of p.stages ?? []) {
      const sid = String(s.id);
      out.stages[sid] = `${prefix} / ${String(s.label)}`;
      out.pipelineByStage[sid] = pid;
    }
    // Bucketed PER PIPELINE, so "first third of the open stages" means first third of THAT pipeline's
    // funnel rather than of a meaningless merged list across five different funnels.
    Object.assign(out.coarse, coarseStageOf(p.stages ?? []));
    targets[pid] = coarseStageTargets(p.stages ?? []);
  }
  COARSE_TARGETS.set(out.coarse, targets);
  return out;
}

/** One call to the pipelines API yields all four maps; splitting them would quadruple the requests. */
export async function getCrmStageDicts(env: Env): Promise<CrmStageDicts> {
  const res = await hs(env, "GET", "/crm/v3/pipelines/deals");
  return crmStageDictsOf(res.results ?? []);
}

/** Must equal reconcile.ts's OPTION_ORDER_KEY; lifecycle-backward-clear.test.ts pins the pair. */
const OPTION_ORDER_KEY = "dkm-crm-sync:hubspot-option-order";

export async function getPropertyOptions(env: Env, object: string, prop: string):
    Promise<Record<string, string>> {
  const res = await hs(env, "GET", `/crm/v3/properties/${object}/${prop}`);
  const out: Record<string, string> = {};
  for (const o of res.options ?? []) out[String(o.value)] = String(o.label);
  // The options' own order rides on the dictionary, from the same response: see optionOrderOf in
  // reconcile.ts, which reads it under this same registered key (it cannot be imported from there
  // without a reconcile <-> hubspot import cycle). Non-enumerable: the dictionary is unchanged as data.
  const order = optionDisplayOrder(res.options ?? []);
  if (order) Object.defineProperty(out, Symbol.for(OPTION_ORDER_KEY), { value: order, enumerable: false, configurable: true });
  return out;
}

/**
 * value -> displayOrder for a property's options, or undefined when they cannot be ordered unambiguously:
 * no options, an option without a usable displayOrder (HubSpot uses -1 for "unordered"), or two options
 * sharing one. A partial or ambiguous order is not an order -- backwardClearPlan then treats every move
 * as unknown and sends one PATCH, rather than clearing on a guess. Pure.
 *
 * Read live 2026-10-01, contacts AND companies `lifecyclestage` (and both lifecycle pipelines agree):
 * lead 0, marketingqualifiedlead 1, 1028988526 2, 1029059094 3, 1029060900 4, 1029059095 5,
 * opportunity 6, customer 7, 1029055302 8, 1135842429 9 -- i.e. "1.NEW" ... "10.Other".
 */
export function optionDisplayOrder(options: { value?: unknown; displayOrder?: unknown }[]):
    Record<string, number> | undefined {
  if (!options.length) return undefined;
  const order: Record<string, number> = Object.create(null);
  const used = new Set<number>();
  for (const o of options) {
    const n = typeof o.displayOrder === "number" ? o.displayOrder : NaN;
    if (!Number.isInteger(n) || n < 0 || used.has(n)) return undefined;
    used.add(n);
    order[String(o.value)] = n;
  }
  return order;
}

/** One version of a property, as HubSpot's propertiesWithHistory lists it. */
export interface PropertyVersion {
  value: string;
  timestamp: string;
  /** Who made the change: "INTEGRATION" (an app's API write, this Worker's among them), "CRM_UI", "DEALS", ... */
  sourceType: string;
  sourceId?: string;
}

/**
 * One property's history on one record, as HubSpot returns it (newest first). A single read, retried like
 * any GET. Only the lifecycle re-check reads it -- to tell an empty stage that OUR clear left behind from one
 * a person or another source emptied (see repairDanglingClears in sync.ts) -- so it runs only for a record
 * whose stage HubSpot holds empty while its card shows one.
 */
export async function getPropertyHistory(env: Env, object: string, id: string, prop: string): Promise<PropertyVersion[]> {
  const p = encodeURIComponent(prop);
  const res = await hs(env, "GET", `/crm/v3/objects/${object}/${id}?properties=${p}&propertiesWithHistory=${p}`);
  const list: unknown = res?.propertiesWithHistory?.[prop];
  if (!Array.isArray(list)) return [];
  return list.map((v: any) => ({
    value: String(v?.value ?? ""), timestamp: String(v?.timestamp ?? ""), sourceType: String(v?.sourceType ?? ""),
    ...(v?.sourceId != null ? { sourceId: String(v.sourceId) } : {}),
  }));
}

/**
 * THE RECORD, WITH THE HISTORY OF THE PROPERTIES ASKED ABOUT: one GET carrying `properties` and
 * `propertiesWithHistory` (STALE_FORWARD_GATE). Read by a column-level forward pass only when a two-way cell differs
 * and its verdict needs HubSpot's own versions (sync.ts forwardOnlyGated), by the card watch's converge, and by a
 * mark's retry. `history` maps each asked property to its versions, newest first (HubSpot's order); a property HubSpot
 * never held has none. Every requested property is present in `properties` (null when HubSpot has no value).
 * Null on 404. retries=1, as getRecord: HS_RATE_LIMIT_RETRY retries every GET on its own.
 */
export async function getRecordWithHistory(env: Env, object: string, id: string, properties: string[],
    withHistory: string[]): Promise<{ properties: Record<string, string | null>; history: Record<string, PropertyVersion[]> } | null> {
  const props = [...new Set([...properties, ...withHistory])];
  let res: any;
  try {
    res = await hs(env, "GET", `/crm/v3/objects/${object}/${id}?properties=${encodeURIComponent(props.join(","))}`
      + (withHistory.length ? `&propertiesWithHistory=${encodeURIComponent([...new Set(withHistory)].join(","))}` : ""),
      undefined, 1);
  } catch (e) {
    if (/: 404 /.test(String(e))) return null;
    throw e;
  }
  const got = (res?.properties ?? {}) as Record<string, string | null>;
  const properties_: Record<string, string | null> = {};
  for (const p of props) properties_[p] = got[p] ?? null;
  for (const [p, v] of Object.entries(got)) if (!(p in properties_)) properties_[p] = v ?? null;
  const history: Record<string, PropertyVersion[]> = {};
  for (const p of withHistory) {
    const list: unknown = res?.propertiesWithHistory?.[p];
    history[p] = Array.isArray(list) ? list.map((v: any) => ({
      value: String(v?.value ?? ""), timestamp: String(v?.timestamp ?? ""), sourceType: String(v?.sourceType ?? ""),
      ...(v?.sourceId != null ? { sourceId: String(v.sourceId) } : {}),
    })) : [];
  }
  return { properties: properties_, history };
}

/**
 * A 200 THAT CHANGED NOTHING. HubSpot answers a lifecycle stage it will not apply (a move to an earlier
 * stage, without the clear) with success and the OLD value, and nothing else in this Worker can tell:
 * Sync State is stamped from the response, so the card simply goes on showing a stage HubSpot never took.
 * That is how every backward move from monday was lost until 2026-10-01 (see FieldSpec.backwardNeedsClear).
 *
 * So for the properties that can do this, the response is compared with what was sent, and a mismatch is
 * LOGGED -- never retried and never written back, so it cannot loop. A property the response does not
 * carry is not judged. Every caller of patchRecord gets it, whatever path built the patch.
 */
function reportIgnoredWrites(spec: ObjectSpec, id: string, sent: Record<string, string>,
    stored: Record<string, unknown> | undefined): void {
  if (!stored) return;
  for (const f of spec.fields) {
    if (!f.backwardNeedsClear || !Object.hasOwn(sent, f.hs) || !Object.hasOwn(stored, f.hs)) continue;
    const want = String(sent[f.hs] ?? "").trim();
    const got = String(stored[f.hs] ?? "").trim();
    if (got !== want)
      console.log(`[reverse] object=${spec.object} hubspot_id=${id} field=${f.hs} sent=${JSON.stringify(want)}`
        + ` stored=${JSON.stringify(got)} action=lifecycle-noop reason="HubSpot answered 200 but still holds`
        + ` another value: the write did not land"`);
  }
}
