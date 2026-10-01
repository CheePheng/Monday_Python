import type { Env, RunOpts, Budget, WriteAuth, ObjectSpec, HsRecord } from "./types";
export { CreateIdempotency } from "./create-idempotency-do";
export { ActivityRetry } from "./activity-retry-do";
export { DeferredSync } from "./deferred-sync-do";
import { pollTasks, reconcileRecentTasks } from "./task-poller";
import { pollMarketingEmails, readLedger } from "./marketing-email-poller";
import { ladSweepEnabled, sweepDeadline, sweepLastActivity } from "./lad-sweep";
import { runAll, runIncremental, syncMondayItem, getCtxCached, syncHubspotRecord, legacyDealRouting } from "./sync";
import { writeModeFor, maxWritesFor, dryRunModeFor } from "./run-opts";
import { createContactOrCompany, type CreateInput } from "./create-records";
import { handleHubspot, handleMonday, safeEq } from "./webhooks";
import { deadLetterStub, activityRetryBound } from "./activity-retry";
import { activitySyncEnabled, syncHubspotActivity, syncMondayTimeline } from "./activity-sync";
import { CRM_CONTACTS } from "./config/crm";
import { searchObjects, patchLineItem, deleteLineItem, deleteAssociation, putAssociation, archiveDeal, patchRecord, createProduct, createLineItem, getWritablePropOptions, getDealLineItems, getRecord, propertiesForSpec, getAssociatedIds, getRecordsByIds, listPage, listCompanies, listContacts, mapAssocRecord, mapOwners } from "./hubspot";
import { ensureCardForRecord, cardIdOf } from "./ensure-card";
import { verifySessionToken } from "./session";
import { parseLineItemBody, parseAssociationBody, parseDealBody, parseSyncDealBody, parseClearDealBody, parseCreateLineItemBody, parseContactBody, parseCompanyBody, parseSyncCompanyBody, parseSyncContactBody, parseClearRecordBody } from "./app-routes";
import { DEALS, LINE_ITEM_SUBITEMS, CONTACTS_MYLA, COMPANIES_MYLA, specByObject } from "./config";
import { getItem, setColumns, findItemByColumn, getBoardItems, gql } from "./monday";
import { phoneBackfillCandidates } from "./backfill";
import { lineItemOwnerSpec, lineItemWriteAuth } from "./write-auth";
import { authorizeCreate, authorizeWrite, withBirthOwnership } from "./ownership";
import { syncAssociations } from "./associations";
import { colText } from "./dedup";
import { actorLabel } from "./actor-label";
import { LINE_ITEM_ENUM_PROPS, PRODUCT_COPY_PROPS } from "./line-item-props";
import { CONTACT_ENUM_PROPS, COMPANY_ENUM_PROPS } from "./contact-company-props";

/** Properties `/app/associations` reads per TARGET object — exactly what mapAssocRecord consumes, and
 * nothing that the object type doesn't own (a foreign property name can make HubSpot reject the whole
 * batch/read, and that endpoint fails soft, so the drawer would just show an empty association list). */
const ASSOC_PROPS: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email", "jobtitle"],
  companies: ["name", "domain"],
  deals: ["dealname"],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-Trigger-Secret, Content-Type",
};

// Writes for real when the Worker is live (mirrors optsFromEnv but with a small per-request budget).
function appWriteOpts(env: Env): RunOpts {
  return writeModeFor(env, 5);
}

// Auth for /app/*: a valid monday session token (browser) OR X-Trigger-Secret (server-to-server).
// The old static X-App-Secret path is retired (it was exposed in frontend prompt material).
async function authApp(req: Request, env: Env): Promise<{ ok: boolean; reason: string; userId?: string; accountId?: string }> {
  if (triggerOk(req, env)) return { ok: true, reason: "trigger-secret" };
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false, reason: "no session token / trigger secret" };
  const v = await verifySessionToken(env.MONDAY_APP_SESSION_SECRET ?? "", bearer, env.MONDAY_ACCOUNT_ID, Date.now());
  return { ok: v.ok, reason: v.reason, userId: v.userId, accountId: v.accountId };
}

/** The server-to-server secret, compared in constant time. Fails closed when TRIGGER_SECRET is unset. */
function triggerOk(req: Request, env: Env): boolean {
  const provided = req.headers.get("x-trigger-secret") ?? "";
  return !!env.TRIGGER_SECRET && !!provided && safeEq(provided, env.TRIGGER_SECRET);
}

/**
 * /app/* WRITE routes that exist only for the Work-Management Deal Cockpit, refused on the CRM Worker.
 *
 * Each hardcodes a WM spec or board (CONTACTS_MYLA, COMPANIES_MYLA, DEALS, the WM subitem board), so
 * on CRM it either created a wm-stamped HubSpot record plus a card on a WM board (/app/contact,
 * /app/company), wrote Sync State onto WM cards (/app/backfill-contact-phones), wrote WM subitems
 * (/app/line-item), archived a HubSpot deal outside the CRM ownership model (/app/deal), or did nothing
 * while answering {ok:true} (/app/sync-*). The Cockpit talks to the WM Worker; nothing legitimate calls
 * these on CRM, so a clear 409 is safer than any of those.
 */
const WM_ONLY_APP_WRITES = new Set([
  "/app/contact", "/app/company", "/app/backfill-contact-phones", "/app/line-item", "/app/deal",
  "/app/sync-deal", "/app/sync-company", "/app/sync-contact",
]);

function optsFromEnv(env: Env): RunOpts {
  return writeModeFor(env, maxWritesFor(env));
}

/**
 * The ownership decision for an EXISTING record, for the /app/* routes that patch one directly.
 *
 * Shared rather than hand-rolled per route, because hand-rolling it is exactly how three live routes
 * came to omit it. Once every WM spec declared `ownership`, hubspot.ts began ASSERTING a WriteAuth,
 * and a route that passes none does not fail safe -- it throws OwnershipError and answers 502. That
 * broke clear-deal-fields, clear-record-fields and the phone backfill on the Work Management Worker,
 * which is the one the Deal Cockpit talks to.
 *
 * Returns an undefined auth when the spec declares no ownership (nothing to authorize, unchanged
 * behaviour), and a REFUSAL rather than a throw when the record cannot be read -- an unreadable record
 * is not an owned one, and the caller turns that into a 409 the drawer can show.
 *
 * It also hands back the SPEC it decided against, which the caller must then use for the patch. That
 * is not a convenience: withCutover() returns COPIES, so the module constants imported at the top of
 * this file (DEALS, CONTACTS_MYLA, COMPANIES_MYLA) keep OWN_WM's placeholder cutoverAtMs of Infinity
 * and never learn this deployment's CRM_CUTOVER_AT. Authorizing against one of those makes every
 * unstamped record look pre-cutover, so these routes would keep writing records the crons had already
 * stopped writing -- one Worker disagreeing with itself about who owns what. specByObject() resolves
 * through specsFor(), which is where the cutover is actually applied.
 */
async function recordWriteAuth(env: Env, fallback: ObjectSpec, object: string, id: string):
    Promise<{ spec: ObjectSpec; auth: WriteAuth | undefined }> {
  const spec = specByObject(env, object) ?? fallback;
  if (!spec.ownership) return { spec, auth: undefined };
  const rec = await getRecord(env, object, id, [spec.ownership.prop, spec.ownership.createdProp]);
  const auth: WriteAuth = rec
    ? authorizeWrite(rec, spec.ownership)
    : { allowed: false, reason: `${object}/${id} not readable`, forId: id };
  return { spec, auth };
}

export default {
  // Webhooks are the primary, instant path. Crons are only safety nets:
  //   - every 10 min: a LIGHT incremental check (recently-changed records only) that sweeps up any
  //     missed webhook. Window >10 min so nothing slips between ticks.
  //   - once a day (03:00 UTC): a FULL reconciliation (deep scan of every record). The heavy scan runs
  //     daily instead of every minute to avoid unnecessary API load.
  async scheduled(event: ScheduledEvent, env: Env, ectx: ExecutionContext): Promise<void> {
    const opts = optsFromEnv(env);
    /**
     * EVERY CRON IS DISPATCHED BY NAME. The previous shape fell through to runIncremental for
     * ANYTHING that was not the daily sweep, which meant adding a trigger for some unrelated small
     * job — a five-minute task poll, say — would quietly start a full CRM incremental reconciliation
     * that Phase 1 deliberately disabled. An unrecognised expression must do nothing and say so.
     */
    if (event.cron === "*/15 * * * *") {
      /**
       * RETURNED, NOT waitUntil -- unlike every branch below. A marketing poll spends a minute or two
       * creating monday timeline entries, and Cloudflare guarantees the full cron budget only to the
       * promise scheduled() returns; waitUntil is documented at about 30 seconds. A write cut off
       * between create and settle is the lost-response state behind the doubled emails.
       *
       * CRM ONLY, checked here and again inside the poller: the Work Management Worker runs this same
       * source, and must never poll even if someone adds this expression to its config.
       */
      if (env.ENABLE_CRM !== "true") {
        console.log(`[mkt-poller] action=refused reason="not the CRM Worker" cron="${event.cron}"`);
        return;
      }
      /**
       * AND THE LAST ACTIVITY BACKSTOP (lad-sweep.ts), when ENABLE_LAD_SWEEP is "true" -- AFTER the poll,
       * in the same returned promise, never beside it. Beside it, the sweep's whole-record syncs ran in
       * the same moments as the poll's creates, on one invocation's subrequest ceiling and one monday
       * complexity budget: hitting either between a create and its settle is the lost-response state
       * behind the doubled emails. After it, the sweep gets what the cron has left (sweepDeadline: no
       * sync starts later than 13 minutes in) and a total sync cap, lower when the poll ran
       * (maxSweepSyncs). Each catches its own failure, so one can never take the other down or leave an
       * unhandled rejection.
       */
      const cronStart = Date.now();
      const marketing = pollMarketingEmails(env).then(() => undefined)
        .catch(e => console.log(`[mkt-poller] action=error reason="${String(e).slice(0, 140)}"`));
      const sweep = () => ladSweepEnabled(env)
        ? sweepLastActivity(env, { deadlineMs: sweepDeadline(cronStart, Date.now()) }).then(() => undefined)
          .catch(e => console.log(`[lad-sweep] action=error reason="${String(e).slice(0, 140)}"`))
        : Promise.resolve();
      return marketing.then(sweep);
    }
    if (event.cron === "*/5 * * * *") {
      ectx.waitUntil(pollTasks(env)
        .catch(e => console.log(`[task-poller] action=error reason="${String(e).slice(0, 140)}"`)));
      return;
    }
    if (event.cron === "0 4 * * *") {
      // Deliberately NOT 03:00: that expression belongs to the full CRM reconciliation, and sharing
      // it would make a small bounded task sweep indistinguishable from a deep scan of every record.
      ectx.waitUntil(reconcileRecentTasks(env)
        .catch(e => console.log(`[task-sweep] action=error reason="${String(e).slice(0, 140)}"`)));
      return;
    }
    if (event.cron === "0 3 * * *") {
      ectx.waitUntil(runAll(env, opts).then(s => console.log("cron-daily-full", JSON.stringify(s))));
      return;
    }
    if (event.cron === "*/10 * * * *") {
      ectx.waitUntil(runIncremental(env, opts, 11 * 60_000).then(s => console.log("cron-backup", s)));
      return;
    }
    console.log(`[cron] action=ignored expression="${event.cron}" reason="not a recognised schedule"`);
  },

  async fetch(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Near-instant webhook fast paths. HubSpot is verified by its v3 HMAC signature (verifyHubspot).
    // monday board webhooks carry NO signature unless created with an integration app's OAuth token,
    // so the CRM Worker registers them under a capability path `/webhooks/monday/<key>` and
    // mondayAuth refuses anything else. The bare path stays routable because the live WM Worker's
    // hooks use it and set no key — see mondayAuth for why it fails open only when unconfigured.
    if (url.pathname === "/webhooks/monday" || url.pathname.startsWith("/webhooks/monday/"))
      return handleMonday(req, env, ectx);
    if (url.pathname === "/webhooks/hubspot") return handleHubspot(req, env, ectx);

    // App API (browser Board View app, cross-origin). Auth: monday session token or X-Trigger-Secret.
    if (url.pathname.startsWith("/app/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const auth = await authApp(req, env);
      if (!auth.ok) {
        console.log(`[app] path=${url.pathname} action=rejected reason="${auth.reason}"`);
        return new Response("forbidden", { status: 403, headers: CORS });
      }
      const actingUserId = auth.userId; // undefined under trigger-secret auth -> record created Unassigned
      // Attribute every WRITE from the app to the logged-in monday account (the session token identifies it).
      // GETs are skipped to keep the log readable.
      if (req.method !== "GET") {
        console.log(`[actor] source=app path=${url.pathname} user=${actingUserId ?? "trigger-secret"}`);
        if (actingUserId) ectx.waitUntil(actorLabel(env, actingUserId).then(a =>
          console.log(`[actor] source=app path=${url.pathname} ${a}`)).catch(() => {}));
      }
      const actingAccountId = auth.accountId ?? env.MONDAY_ACCOUNT_ID ?? "acct"; // namespaces idempotency keys
      if (env.ENABLE_CRM === "true" && req.method !== "GET" && WM_ONLY_APP_WRITES.has(url.pathname)) {
        console.log(`[app] path=${url.pathname} action=refused reason="Work-Management-only route on the CRM Worker"`);
        return Response.json({ ok: false, error: "wm-only-route" }, { status: 409, headers: CORS });
      }

      // GET /app/search?type=contacts|companies|products&q=&limit=
      if (url.pathname === "/app/search" && req.method === "GET") {
        const type = url.searchParams.get("type") ?? "";
        if (!["contacts", "companies", "products", "deals"].includes(type))
          return Response.json({ error: "type must be contacts|companies|products|deals" }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const SEARCH_HEADERS = { ...CORS, "Cache-Control": "no-store" };
        try {
          const { results, total } = await searchObjects(env, type, q, Number.isFinite(limit) ? limit : 20);
          return Response.json({ results, total }, { headers: SEARCH_HEADERS });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/search] type=${type} error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], total: 0, error: scope ? "scope" : "search-failed" },
            { headers: SEARCH_HEADERS });
        }
      }

      // GET /app/companies?q=&after=&limit= — live company directory (newest-created first), paginated.
      if (url.pathname === "/app/companies" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const after = url.searchParams.get("after") || undefined;
        const limit = Number(url.searchParams.get("limit") ?? "25");
        const numP = (k: string) => { const s = url.searchParams.get(k); if (!s) return undefined; const v = Number(s); return Number.isFinite(v) ? v : undefined; };
        const ownerId = url.searchParams.get("ownerId") || undefined;
        const created = { gte: numP("createdGte"), lte: numP("createdLte") };
        const activity = { gte: numP("activityGte"), lte: numP("activityLte") };
        const H = { ...CORS, "Cache-Control": "no-store" };
        try {
          const ctx = await getCtxCached(env);
          const { items, after: next } = await listCompanies(
            env, { q, after, limit: Number.isFinite(limit) ? limit : 25, ownerId, created, activity },
            ctx.ownersById, ctx.labels);
          return Response.json({ results: items, after: next }, { headers: H });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/companies] error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], after: null, error: scope ? "scope" : "companies-failed" }, { headers: H });
        }
      }

      // GET /app/contacts?q=&after=&limit= — live contact directory (newest-created first), paginated.
      if (url.pathname === "/app/contacts" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const after = url.searchParams.get("after") || undefined;
        const limit = Number(url.searchParams.get("limit") ?? "25");
        const numP = (k: string) => { const s = url.searchParams.get(k); if (!s) return undefined; const v = Number(s); return Number.isFinite(v) ? v : undefined; };
        const ownerId = url.searchParams.get("ownerId") || undefined;
        const created = { gte: numP("createdGte"), lte: numP("createdLte") };
        const activity = { gte: numP("activityGte"), lte: numP("activityLte") };
        const H = { ...CORS, "Cache-Control": "no-store" };
        try {
          const ctx = await getCtxCached(env);
          const { items, after: next } = await listContacts(
            env, { q, after, limit: Number.isFinite(limit) ? limit : 25, ownerId, created, activity },
            ctx.ownersById, ctx.labels);
          return Response.json({ results: items, after: next }, { headers: H });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/contacts] error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], after: null, error: scope ? "scope" : "contacts-failed" }, { headers: H });
        }
      }

      // GET /app/owners — HubSpot owners for the Company-owner filter dropdown.
      if (url.pathname === "/app/owners" && req.method === "GET") {
        const H = { ...CORS, "Cache-Control": "no-store" };
        try {
          const ctx = await getCtxCached(env);
          return Response.json({ owners: mapOwners(ctx.ownersById) }, { headers: H });
        } catch (e) {
          console.log(`[app/owners] error="${String(e).slice(0, 140)}"`);
          return Response.json({ owners: [] }, { headers: H });
        }
      }

      // GET /app/associations?type=contacts&id=<hsId>&to=companies -> [{ hubspotId, name }]. Read-only,
      // fails soft so a lookup hiccup never blocks the form (used to auto-link a picked contact's company).
      if (url.pathname === "/app/associations" && req.method === "GET") {
        const type = url.searchParams.get("type") ?? "", to = url.searchParams.get("to") ?? "";
        const id = url.searchParams.get("id") ?? "";
        const OBJ = new Set(["contacts", "companies", "deals"]);
        if (!OBJ.has(type) || !OBJ.has(to) || !/^\d+$/.test(id))
          return Response.json({ error: "type/to must be a CRM object; id must be numeric" }, { status: 400, headers: CORS });
        try {
          const ids = await getAssociatedIds(env, type, id, to);
          // Ask ONLY for properties that exist on the target object. The previous shared list sent
          // `dealname` to contacts and `firstname`/`email` to deals; HubSpot can reject a batch/read that
          // names a property the object type doesn't have, and this endpoint fails SOFT — so one bad
          // property silently emptied the drawer's association list instead of erroring.
          const recs = ids.length ? await getRecordsByIds(env, to, ids, ASSOC_PROPS[to]) : [];
          const results = recs.map(r => mapAssocRecord(to, r));
          return Response.json({ results }, { headers: CORS });
        } catch (e) {
          console.log(`[app/associations] type=${type} to=${to} error="${String(e).slice(0, 140)}"`);
          // Additive `error`: the deal-form auto-associate consumer ignores it (reads results ?? []), while
          // getCompanyContacts throws on it so the CompanyDrawer shows Retry instead of "No linked contacts".
          return Response.json({ results: [], error: "assoc-failed" }, { headers: CORS });
        }
      }

      // GET /app/line-item-schema — writable enum options for the manual line-item form (live).
      if (url.pathname === "/app/line-item-schema" && req.method === "GET") {
        try {
          const schema = await getWritablePropOptions(env, "line_items", LINE_ITEM_ENUM_PROPS);
          return Response.json({ schema }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/line-item-schema] error="${String(e).slice(0, 140)}"`);
          return Response.json({ schema: {}, error: "schema-failed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }

      // GET /app/contact-schema — live enum options for the Create Contact form.
      if (url.pathname === "/app/contact-schema" && req.method === "GET") {
        try {
          const schema = await getWritablePropOptions(env, "contacts", CONTACT_ENUM_PROPS);
          return Response.json({ schema }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/contact-schema] error="${String(e).slice(0, 140)}"`);
          return Response.json({ schema: {}, error: "schema-failed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }

      // GET /app/company-schema — live enum options for the Create Company form.
      if (url.pathname === "/app/company-schema" && req.method === "GET") {
        try {
          const schema = await getWritablePropOptions(env, "companies", COMPANY_ENUM_PROPS);
          return Response.json({ schema }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/company-schema] error="${String(e).slice(0, 140)}"`);
          return Response.json({ schema: {}, error: "schema-failed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }

      // GET /app/deal-line-items?itemId=<monday parent> — the deal's CURRENT HubSpot line items (fresh-on-open).
      if (url.pathname === "/app/deal-line-items" && req.method === "GET") {
        const itemId = url.searchParams.get("itemId") ?? "";
        if (!/^\d+$/.test(itemId)) return Response.json({ error: "itemId must be numeric" }, { status: 400, headers: CORS });
        try {
          const deal = await getItem(env, itemId);
          const dealId = deal ? colText(deal, DEALS.idCol) : "";
          const lineItems = dealId ? await getDealLineItems(env, dealId) : [];
          return Response.json({ lineItems }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/deal-line-items] item=${itemId} error="${String(e).slice(0, 140)}"`);
          return Response.json({ lineItems: [], error: "fetch-failed" }, { status: 502, headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }

      // POST /app/line-item — create (body has subitemId) OR update (body has lineItemId) | DELETE {lineItemId}
      if (url.pathname === "/app/line-item" && (req.method === "POST" || req.method === "DELETE")) {
        const body: any = await req.json().catch(() => ({}));
        if (req.method === "POST" && body?.subitemId !== undefined) {
          const c = parseCreateLineItemBody(body);
          if (!c.ok) return Response.json({ error: c.error }, { status: 400, headers: CORS });
          try {
            // Idempotency: reuse a Line Item ID / Product ID already stamped on this subitem by a prior
            // attempt, so a retry can never create a duplicate HubSpot line item or product.
            const sub = await getItem(env, c.subitemId!);
            const existingLi = sub ? colText(sub, LINE_ITEM_SUBITEMS.idCol) : "";
            if (existingLi) return Response.json({ ok: true, lineItemId: existingLi }, { headers: CORS });
            const existingPid = sub && LINE_ITEM_SUBITEMS.productIdCol ? colText(sub, LINE_ITEM_SUBITEMS.productIdCol) : "";
            // 1) ensure the parent deal exists in HubSpot; resolve its id from the monday deal card.
            let deal = await getItem(env, c.itemId!);
            let dealId = deal ? colText(deal, DEALS.idCol) : "";
            if (!dealId) {
              await syncMondayItem(env, DEALS.boardId, c.itemId!, appWriteOpts(env), { left: 10 });
              deal = await getItem(env, c.itemId!);
              dealId = deal ? colText(deal, DEALS.idCol) : "";
            }
            if (!dealId) return Response.json({ ok: false, error: "deal-not-synced" }, { status: 409, headers: CORS });
            // 2) Save-to-library -> create the product ONCE (reuse a prior attempt's), persist its id.
            const props = { ...c.properties! };
            if (c.saveToLibrary && !props.hs_product_id) {
              if (existingPid) props.hs_product_id = existingPid;
              else {
                const pProps: Record<string, string> = {};
                for (const [k, v] of Object.entries(props)) if (PRODUCT_COPY_PROPS.has(k)) pProps[k] = v;
                const pid = await createProduct(env, pProps, appWriteOpts(env));
                if (pid) {
                  props.hs_product_id = pid;
                  if (LINE_ITEM_SUBITEMS.productIdCol)
                    try { await setColumns(env, LINE_ITEM_SUBITEMS.boardId, c.subitemId!, { [LINE_ITEM_SUBITEMS.productIdCol]: pid }, appWriteOpts(env)); } catch { /* best-effort */ }
                }
              }
            }
            // 3) create the HubSpot line item (+ associate to the deal).
            // BORN OWNED, like every other record this Worker creates. Origin is the DEPLOYMENT, which
            // is the only thing provable here: the route is served by whichever Worker holds
            // MONDAY_APP_SESSION_SECRET, and lineItemOwnerSpec resolves that Worker's own ownership.
            const liSpec = lineItemOwnerSpec(env);
            const lineItemId = await createLineItem(env,
              withBirthOwnership(props, liSpec?.ownership), dealId, appWriteOpts(env),
              liSpec, liSpec?.ownership ? authorizeCreate(liSpec.ownership) : undefined);
            // 4) write the Line Item ID back onto the subitem — BEST EFFORT: the line item already exists, so
            //    never fail the request over a write-back; returning the id lets the app store it and skip a dup on retry.
            if (lineItemId)
              try { await setColumns(env, LINE_ITEM_SUBITEMS.boardId, c.subitemId!, { [LINE_ITEM_SUBITEMS.idCol]: lineItemId }, appWriteOpts(env)); }
              catch (e) { console.log(`[app/line-item] create write-back subitem=${c.subitemId} error="${String(e).slice(0, 120)}"`); }
            return Response.json({ ok: true, lineItemId, productId: props.hs_product_id }, { headers: CORS });
          } catch (e) {
            console.log(`[app/line-item] create subitem=${body?.subitemId} error="${String(e).slice(0, 160)}"`);
            return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
          }
        }
        const p = parseLineItemBody(req.method === "POST" ? "PATCH" : "DELETE", body);
        if (!p.ok) return Response.json({ error: p.error }, { status: 400, headers: CORS });
        try {
          // OWNERSHIP FIRST. This route was the last production line-item mutation outside the model:
          // a rep with the board view open could PATCH or DELETE a line item the other deployment owns.
          // Refused with 409, not 502 — the request is well-formed, it simply is not ours to make.
          const wa = await lineItemWriteAuth(env, p.lineItemId!);
          if (wa && !wa.auth.allowed) {
            console.log(`[app/line-item] ${req.method} ${p.lineItemId} action=refused reason="${wa.auth.reason}"`);
            return Response.json({ ok: false, error: "not-owned", reason: wa.auth.reason },
              { status: 409, headers: CORS });
          }
          if (req.method === "POST")
            await patchLineItem(env, p.lineItemId!, p.properties!, appWriteOpts(env), wa?.spec, wa?.auth);
          else await deleteLineItem(env, p.lineItemId!, appWriteOpts(env), wa?.spec, wa?.auth);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/line-item] ${req.method} ${p.lineItemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
        }
      }

      // /app/association {fromObject, fromId, toObject, toId} — POST adds, DELETE removes a HubSpot
      // association. fromObject ∈ {deals, companies}. Used by the deal + company drawers.
      if (url.pathname === "/app/association" && (req.method === "POST" || req.method === "DELETE")) {
        const a = parseAssociationBody(await req.json().catch(() => ({})));
        if (!a.ok) return Response.json({ error: a.error }, { status: 400, headers: CORS });
        try {
          // OWNERSHIP FIRST, on the INITIATING record — the same rule reverseAssociations follows: an
          // association is a link, not a field on the far record, so you must own the end you are
          // editing from. Without this the drawer could link or unlink records the other deployment
          // owns, which is the same escape hatch /app/line-item had.
          const aSpec = specByObject(env, a.fromObject!);
          let aAuth: WriteAuth | undefined;
          if (aSpec?.ownership) {
            const fromRec = await getRecord(env, a.fromObject!, a.fromId!,
              [aSpec.ownership.prop, aSpec.ownership.createdProp]);
            aAuth = fromRec
              ? authorizeWrite(fromRec, aSpec.ownership)
              : { allowed: false, reason: `${a.fromObject}/${a.fromId} not readable`, forId: a.fromId! };
            if (!aAuth.allowed) {
              console.log(`[app/association] ${req.method} ${a.fromObject}/${a.fromId} action=refused reason="${aAuth.reason}"`);
              return Response.json({ ok: false, error: "not-owned", reason: aAuth.reason },
                { status: 409, headers: CORS });
            }
          }
          if (req.method === "POST") await putAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env), aSpec, aAuth);
          else await deleteAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env), aSpec, aAuth);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/association] ${req.method} ${a.fromObject}/${a.fromId}->${a.toObject}/${a.toId} error="${String(e).slice(0, 140)}"`);
          return Response.json({ ok: false, error: "assoc-failed" }, { status: 502, headers: CORS });
        }
      }

      // DELETE /app/deal {hubspotDealId} — archive the HubSpot deal (removes it from both systems)
      if (url.pathname === "/app/deal" && req.method === "DELETE") {
        const body = await req.json().catch(() => ({}));
        const d = parseDealBody(body);
        if (!d.ok) return Response.json({ error: d.error }, { status: 400, headers: CORS });
        try {
          // The one HubSpot DELETE the app can make, so it answers to ownership like every other write:
          // the WM Cockpit must not archive a deal the CRM Worker owns (HubSpot's delete webhook would
          // then remove the CRM card too).
          // Already gone in HubSpot: nothing is left to own, and the Cockpit treated this as success before.
          if (!(await getRecord(env, "deals", d.hubspotDealId!, ["hs_object_id"]))) {
            console.log(`[app/deal] archive ${d.hubspotDealId} action=already-gone`);
            return Response.json({ ok: true }, { headers: CORS });
          }
          const own = await recordWriteAuth(env, DEALS, "deals", d.hubspotDealId!);
          if (own.auth && !own.auth.allowed) {
            console.log(`[app/deal] archive ${d.hubspotDealId} action=refused reason="${own.auth.reason}"`);
            return Response.json({ ok: false, error: "not-owned", reason: own.auth.reason }, { status: 409, headers: CORS });
          }
          await archiveDeal(env, d.hubspotDealId!, appWriteOpts(env), own.spec, own.auth);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/deal] archive ${d.hubspotDealId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
        }
      }

      // POST /app/sync-deal {itemId} — run the deal's reconcile NOW (fields+associations+line items -> HubSpot),
      // the same path the monday webhook uses. Makes a drawer save instant instead of waiting on a webhook/cron.
      // POST /app/clear-deal-fields {hubspotDealId, fields:[...]} — blank allowlisted deal properties.
      // The rep emptied the field and pressed Save; the app carries that intent, because the reconciler
      // can't infer it from state (an empty monday value means "never set" OR "just cleared", and for
      // people columns it means "heal from HubSpot"). Every clear is logged.
      if (url.pathname === "/app/clear-deal-fields" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const c = parseClearDealBody(body);
        if (!c.ok) return Response.json({ error: c.error }, { status: 400, headers: CORS });
        try {
          const props = Object.fromEntries(c.fields!.map(f => [f, ""]));
          console.log(`[app/clear-deal-fields] deal=${c.hubspotDealId} fields=${c.fields!.join(",")}`);
          const d = await recordWriteAuth(env, DEALS, "deals", c.hubspotDealId!);
          if (d.auth && !d.auth.allowed) {
            console.log(`[app/clear-deal-fields] deal=${c.hubspotDealId} action=refused reason="${d.auth.reason}"`);
            return Response.json({ ok: false, error: "not-owned", reason: d.auth.reason }, { status: 409, headers: CORS });
          }
          await patchRecord(env, d.spec, c.hubspotDealId!, props, appWriteOpts(env), d.auth);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/clear-deal-fields] deal=${c.hubspotDealId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "clear-failed" }, { status: 502, headers: CORS });
        }
      }

      // POST /app/clear-record-fields {object, hubspotId, fields:[...]} — the company/contact equivalent of
      // clear-deal-fields. MUST run BEFORE the drawer's monday write: if HubSpot still held the old value,
      // the monday webhook would read the now-empty column as "never set", restore it from HubSpot and
      // silently undo the clear on both sides (the exact bug fixed for deals in v3.4).
      if (url.pathname === "/app/clear-record-fields" && req.method === "POST") {
        const c = parseClearRecordBody(await req.json().catch(() => ({})));
        if (!c.ok) return Response.json({ error: c.error }, { status: 400, headers: CORS });
        const spec = c.object === "companies" ? COMPANIES_MYLA : c.object === "contacts" ? CONTACTS_MYLA : DEALS;
        try {
          const props = Object.fromEntries(c.fields!.map(f => [f, ""]));
          console.log(`[app/clear-record-fields] object=${c.object} id=${c.hubspotId} fields=${c.fields!.join(",")}`);
          const r = await recordWriteAuth(env, spec, c.object!, c.hubspotId!);
          if (r.auth && !r.auth.allowed) {
            console.log(`[app/clear-record-fields] object=${c.object} id=${c.hubspotId} action=refused reason="${r.auth.reason}"`);
            return Response.json({ ok: false, error: "not-owned", reason: r.auth.reason }, { status: 409, headers: CORS });
          }
          await patchRecord(env, r.spec, c.hubspotId!, props, appWriteOpts(env), r.auth);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/clear-record-fields] object=${c.object} id=${c.hubspotId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "clear-failed" }, { status: 502, headers: CORS });
        }
      }

      if (url.pathname === "/app/sync-deal" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const s = parseSyncDealBody(body);
        if (!s.ok) return Response.json({ error: s.error }, { status: 400, headers: CORS });
        try {
          await syncMondayItem(env, DEALS.boardId, s.itemId!, appWriteOpts(env), { left: 30 }, true);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/sync-deal] item=${s.itemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "sync-failed" }, { status: 502, headers: CORS });
        }
      }

      // POST /app/sync-company { itemId } — reverse-sync a company's monday edits (fields + contact links)
      // to HubSpot. Reuses the generic syncMondayItem (COMPANIES_MYLA board).
      if (url.pathname === "/app/sync-company" && req.method === "POST") {
        const s = parseSyncCompanyBody(await req.json().catch(() => ({})));
        if (!s.ok) return Response.json({ error: s.error }, { status: 400, headers: CORS });
        try {
          await syncMondayItem(env, COMPANIES_MYLA.boardId, s.itemId!, appWriteOpts(env), { left: 30 }, true);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/sync-company] item=${s.itemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "sync-failed" }, { status: 502, headers: CORS });
        }
      }

      // POST /app/backfill-contact-phones { dryRun?, limit? } — ONE-OFF bounded migration for historical
      // contacts: fill an EMPTY HubSpot phone from the monday card. Contacts are skipFullReconcile, so the
      // automatic per-record backfill (which fires on a webhook/incremental touch) never reaches records
      // nobody edits. DRY-RUN BY DEFAULT: pass {"dryRun": false} to actually write. Every write is logged
      // `[backfill] ... path=migration`. Never overwrites an existing phone, never matched by name.
      if (url.pathname === "/app/backfill-contact-phones" && req.method === "POST") {
        // Bulk WRITE + full-board scan: require the server-to-server secret specifically. Plain /app/ auth
        // accepts ANY valid monday session token, so a board-view user (or a lifted token) could otherwise
        // fire hundreds of HubSpot writes. Every other bulk/admin route in this Worker is gated the same way.
        if (auth.reason !== "trigger-secret")
          return Response.json({ error: "trigger-secret required for the bulk backfill" }, { status: 403, headers: CORS });
        const body: any = await req.json().catch(() => ({}));
        const dryRun = body?.dryRun !== false;                       // default TRUE
        const n = Number(body?.limit ?? 25);
        // Capped at 50: each write is a sequential HubSpot PATCH (retried up to 3x on 429/5xx) on top of a
        // full board scan, and a bigger batch risks the Worker's subrequest ceiling / an edge timeout —
        // after which the caller cannot tell how many writes landed. `remaining` drives the next call.
        const limit = Math.min(Math.max(Number.isFinite(n) ? n : 25, 1), 50);
        const phoneCol = CONTACTS_MYLA.fields.find(f => f.hs === "phone")!.col;
        try {
          const items = await getBoardItems(env, CONTACTS_MYLA.boardId);
          const deduped = items
            .map(it => ({ itemId: it.id, hubspotId: colText(it, CONTACTS_MYLA.idCol).trim(), phone: colText(it, phoneCol) }))
            // Numeric ids only: a hand-typed non-numeric "HubSpot ID" would 400 the WHOLE 100-id batch/read
            // and abort the run with zero progress.
            .filter(c => /^\d+$/.test(c.hubspotId) && c.phone.trim());
          // Dedup by id via a Set (a findIndex scan is O(n^2) — ~2.5bn comparisons on a 50k board) so a
          // duplicated card can't PATCH the same record twice with different phones, last-write-wins.
          const seen = new Set<string>();
          const cards = deduped.filter(c => !seen.has(c.hubspotId) && (seen.add(c.hubspotId), true));
          // Batch-read HubSpot phones (100/call), STOPPING once we have enough candidates for this batch.
          // Reading every carded contact just to write `limit` of them is what pushes a large board toward
          // the Worker's subrequest ceiling. `candidates`/`remaining` therefore become LOWER BOUNDS when the
          // scan stops early (`scanComplete` says which) — call again to continue.
          const phoneById: Record<string, string | null> = {};
          // The ownership props ride along on the read that was already happening. This loop patches
          // many contacts, and a WriteAuth must be computed PER RECORD (assertMayWrite rejects an auth
          // whose forId belongs to another record), so the alternative was one extra HubSpot GET per
          // contact -- on a path whose whole design is about staying under the subrequest ceiling.
          // The deployment's contacts spec, for the same reason recordWriteAuth resolves one: the
          // imported CONTACTS_MYLA constant carries OWN_WM's placeholder Infinity cutover.
          const cSpec = specByObject(env, "contacts") ?? CONTACTS_MYLA;
          const ownProps = cSpec.ownership
            ? [cSpec.ownership.prop, cSpec.ownership.createdProp] : [];
          const recById: Record<string, HsRecord> = {};
          const candidates: typeof cards = [];
          let scanned = 0, scanComplete = true;
          for (let i = 0; i < cards.length; i += 100) {
            const slice = cards.slice(i, i + 100);
            for (const r of await getRecordsByIds(env, "contacts", slice.map(c => c.hubspotId), ["phone", ...ownProps])) {
              phoneById[r.id] = r.properties.phone ?? "";
              recById[r.id] = r;
            }
            scanned += slice.length;
            candidates.push(...phoneBackfillCandidates(slice, phoneById));
            if (candidates.length >= limit && i + 100 < cards.length) { scanComplete = false; break; }
          }
          const batch = candidates.slice(0, limit);
          let written = 0, refused = 0;
          if (!dryRun) {
            for (const c of batch) {
              // A contact the CRM Worker owns is not this Worker's to backfill. Skipped and COUNTED,
              // never thrown: one unowned contact must not abort the whole batch, and a silent skip
              // would read as "nothing needed doing".
              const own = cSpec.ownership;
              const pAuth = own
                ? (recById[c.hubspotId] ? authorizeWrite(recById[c.hubspotId], own)
                   : { allowed: false, reason: `contacts/${c.hubspotId} not readable`, forId: c.hubspotId })
                : undefined;
              if (pAuth && !pAuth.allowed) { refused++; continue; }
              // Canonical phone, NOT monday's rendered column text (which carries a country suffix once a
              // rep picks the flag) — identical rule to reverseFieldValue's phone branch.
              const digits = c.phone.replace(/[^\d]/g, "");
              if (!digits) continue;
              const value = c.phone.trim().startsWith("+") ? "+" + digits : digits;
              const newMod = await patchRecord(env, cSpec, c.hubspotId, { phone: value }, appWriteOpts(env), pAuth);
              // Stamp the POST-patch timestamp, exactly as the reconcile path does. The PATCH bumps the
              // contact's lastmodifieddate, so without this the next incremental sweep reads hs > synced,
              // decides "HubSpot is newer", and overwrites the monday card — reverting any unsynced rep edit.
              if (newMod) await setColumns(env, CONTACTS_MYLA.boardId, c.itemId, { [CONTACTS_MYLA.syncStateCol]: newMod }, appWriteOpts(env));
              if (newMod) written++;
              console.log(`[backfill] object=contacts hubspot_id=${c.hubspotId} monday_item=${c.itemId} field=phone previous="" value="${value}" result=${newMod === null ? "dry-run" : "written"} path=migration`);
            }
          }
          console.log(`[backfill] migration board_items=${items.length} with_monday_phone=${cards.length} hubspot_checked=${scanned} candidates=${candidates.length} scan_complete=${scanComplete} batch=${batch.length} written=${written} dryRun=${dryRun}`);
          return Response.json({
            boardItems: items.length, withMondayPhone: cards.length, hubspotChecked: scanned,
            candidates: candidates.length, scanComplete,   // false -> counts are LOWER BOUNDS; call again
            batch: batch.length, written, dryRun, remaining: Math.max(candidates.length - batch.length, 0),
            sample: batch.slice(0, 10).map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, phone: c.phone })),
          }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/backfill-contact-phones] error="${String(e).slice(0, 200)}"`);
          return Response.json({ error: "backfill-failed" }, { status: 502, headers: CORS });
        }
      }

      // POST /app/sync-contact { itemId } — reverse-sync a contact's monday edits (fields + company/deal links)
      if (url.pathname === "/app/sync-contact" && req.method === "POST") {
        const s = parseSyncContactBody(await req.json().catch(() => ({})));
        if (!s.ok) return Response.json({ error: s.error }, { status: 400, headers: CORS });
        try {
          // 30 to match /app/sync-deal and /app/sync-company: reverseAssociations spends one unit per
          // putAssociation across BOTH relation columns and simply breaks when the budget runs out, so a
          // smaller budget silently drops a contact's later company/deal links with no error to the drawer.
          await syncMondayItem(env, CONTACTS_MYLA.boardId, s.itemId!, appWriteOpts(env), { left: 30 }, true);
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/sync-contact] item=${s.itemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ error: "sync-failed" }, { status: 502, headers: CORS });
        }
      }

      // POST /app/ensure-card {object:"contacts"|"companies", hubspotId} — resolve (or create) the monday
      // card for an EXISTING HubSpot record. The browser must never create these cards itself: it cannot
      // see the strongly-consistent card registry, so a client-side create raced the sync/association pass
      // and produced duplicate rows on the Contact/Company boards.
      if (url.pathname === "/app/ensure-card" && req.method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        const object = body?.object;
        const hubspotId = String(body?.hubspotId ?? "");
        if (object !== "contacts" && object !== "companies")
          return Response.json({ error: "object must be contacts|companies" }, { status: 400, headers: CORS });
        if (!/^\d+$/.test(hubspotId))
          return Response.json({ error: "hubspotId must be a numeric string" }, { status: 400, headers: CORS });
        try {
          // THIS DEPLOYMENT'S spec. The WM constants were hardcoded here, so on the CRM Worker this route
          // would have created the card on a Work-Management board -- a cross-deployment write.
          // specByObject resolves exactly those constants on WM, so WM behaves as before.
          const spec = specByObject(env, object) ?? (object === "contacts" ? CONTACTS_MYLA : COMPANIES_MYLA);
          const ctx = await getCtxCached(env);
          const rec = await getRecord(env, spec.object, hubspotId, propertiesForSpec(spec));
          if (!rec) return Response.json({ error: "record-not-found" }, { status: 404, headers: CORS });
          const r = await ensureCardForRecord(env, spec, ctx, rec, appWriteOpts(env));
          // TERMINAL vs TRANSIENT. These were previously indistinguishable — both arrived as
          // `skipped` and answered 409 "card-pending", whose own comment tells the caller to retry
          // shortly. For an ownership refusal a retry can NEVER succeed, so a client that honours that
          // advice loops forever. 422 (well-formed request, but this record cannot be carded) rather
          // than 403 (which would imply the CALLER is unauthorised — it isn't; the RECORD isn't ours)
          // and rather than 409 (which means "conflict, try again"). `retryable` is the field clients
          // should branch on; the status code is for humans and proxies.
          if (r.status === "refused")
            return Response.json({ code: "card-refused", retryable: false, reason: "ownership",
              detail: r.reason }, { status: 422, headers: CORS });
          const itemId = cardIdOf(r);
          // null = another path holds the reservation right now; the caller should retry shortly.
          // `error` is unchanged so existing WM clients behave exactly as before.
          if (!itemId) return Response.json({ error: "card-pending", retryable: true },
            { status: 409, headers: CORS });
          return Response.json({ itemId }, { headers: CORS });
        } catch (e) {
          console.log(`[app/ensure-card] ${object}/${hubspotId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ error: "ensure-card-failed" }, { status: 502, headers: CORS });
        }
      }

      // POST /app/contact | /app/company — search-or-create a HubSpot Contact/Company, create the monday
      // card with the HubSpot id in the initial mutation, apply owner, optional deal-free association.
      // Idempotent via the CreateIdempotency Durable Object keyed by the client UUID.
      if ((url.pathname === "/app/contact" || url.pathname === "/app/company") && req.method === "POST") {
        const isContact = url.pathname === "/app/contact";
        const body: any = await req.json().catch(() => ({}));
        const parsed = isContact ? parseContactBody(body) : parseCompanyBody(body);
        if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: CORS });

        // Namespace the key by account + kind so a UUID can never collide across contact/company/line-item
        // or across monday accounts (a Contact request must never read a Company's stored result).
        const doName = `${actingAccountId}:${isContact ? "contact" : "company"}:${parsed.idempotencyKey!}`;
        const stub = env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(doName));
        let claim;
        try {
          claim = await stub.claim(Date.now());
        } catch (e) {
          // A Durable Object failure here would otherwise escape as a bare 500 with no CORS headers, which
          // the browser surfaces as an opaque network error instead of a readable message.
          console.log(`[app/${isContact ? "contact" : "company"}] claim-failed="${String(e).slice(0, 160)}"`);
          return Response.json({ error: "create-unavailable" }, { status: 503, headers: CORS });
        }
        if (claim.status === "done") return Response.json(claim.result, { headers: CORS });
        // "inflight" only happens under genuine concurrency (two requests, same key, in the same ~60s).
        // The client generates one key per Create and holds a savingRef lock, so this is rare; sequential
        // retries never hit it because every failure path below RELEASES the key (updatedAt=0).
        if (claim.status === "inflight") return Response.json({ error: "in-progress" }, { status: 409, headers: CORS });

        // Everything after the claim runs inside the try so ANY failure (including a cold getCtxCached,
        // which fans out ~12 HubSpot/monday calls) RELEASES the key — otherwise the fresh `inflight` from
        // claim() would strand it for 60s and return a CORS-less 500. `partial` carries the freshest result
        // so even a failure AFTER the create still releases with the ids already produced (resume, no dup).
        let partial = claim.result;
        try {
          const ctx = await getCtxCached(env);
          const props = parsed.properties!;
          const input: CreateInput = isContact
            ? { properties: props, sessionUserId: actingUserId,
                dedup: props.email ? { kind: "email", value: props.email } : { kind: "none" },
                associateCompany: (parsed as any).associateCompanyHubspotId }
            : { properties: props, sessionUserId: actingUserId,
                dedup: props.domain ? { kind: "domain", value: props.domain } : { kind: "none" },
                associateContacts: (parsed as any).associateContactHubspotIds };
          const { result, error } = await createContactOrCompany(
            env, isContact ? "contacts" : "companies", ctx, input, claim.result, appWriteOpts(env));
          partial = result;
          if (error) {
            await stub.save(result, false, 0); // release + keep the partial: the next retry resumes, reusing any id already created
            console.log(`[app/${isContact ? "contact" : "company"}] error="${error}"`);
            return Response.json({ ...result, error: "create-failed" }, { status: 502, headers: CORS });
          }
          await stub.save(result, true, Date.now()); // mark done: this key now short-circuits to the stored result
          return Response.json(result, { headers: CORS });
        } catch (e) {
          await stub.save(partial, false, 0); // release (with any partial) so the retry isn't blocked by a stuck inflight key
          console.log(`[app/${isContact ? "contact" : "company"}] fatal="${String(e).slice(0, 160)}"`);
          return Response.json({ error: "create-failed" }, { status: 502, headers: CORS });
        }
      }

      return new Response("not found", { status: 404, headers: CORS });
    }

    // Manual full reconcile: header `X-Trigger-Secret: <secret>`
    //   /run?object=deals|companies|contacts&mode=dry|live&maxWrites=300
    /**
     * Terminal activity-retry failures — the dead-letter view.
     *
     * The one thing Cloudflare Queues would have given us for free is somewhere to LOOK when a job
     * finally gives up. Read-only, guarded by the same trigger secret as /run and /import.
     */
    if (url.pathname === "/activity-dead-letters" && req.method === "GET") {
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      // The Work Management deployment serves this route -- it has TRIGGER_SECRET -- but has no
      // retry namespace to read. Say so, rather than dereferencing undefined and returning a 500.
      if (!activityRetryBound(env))
        return Response.json({ enabled: false, reason: "ACTIVITY_RETRY not bound on this deployment" });
      const dead = await deadLetterStub(env).listDead();
      return Response.json({ count: dead.length, dead });
    }

    /**
     * POST /resync {object, ids[]} -- re-sync specific HubSpot records onto THIS deployment's board.
     *
     * The repair tool. Runs the same code a HubSpot webhook runs (syncHubspotRecord), so a missing card is
     * created through the deduped reservation and an existing card is brought in line -- never a
     * re-implementation in a script. `forceForward` makes HubSpot authoritative for these records even
     * when their Sync State says nothing changed: the old engine stamped cards without applying some
     * changes (a filled People cell was never updated), so the ordinary rule cannot see that drift.
     * Column-level specs only (refused otherwise), which never write HubSpot from this path: a
     * HubSpot-originated reconcile is forward-only.
     */
    if (url.pathname === "/resync" && req.method === "POST") {
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      const body: any = await req.json().catch(() => ({}));
      const object = String(body?.object ?? "");
      const spec = ["contacts", "companies", "deals", "line_items"].includes(object) ? specByObject(env, object) : undefined;
      if (!spec) return Response.json({ error: "object not owned by this deployment" }, { status: 400 });
      if (object === "deals" && legacyDealRouting(env))
        return Response.json({ error: "WM deals route across boards; use the deal webhook path" }, { status: 400 });
      // COLUMN-LEVEL SPECS ONLY. On a record-level (Work-Management) spec forceForward does not exist
      // and the engine may decide "toHubspot" for any card that differs, which would push stale monday
      // values -- the opposite of what a repair is for.
      if (!spec.columnLevelReverse)
        return Response.json({ error: "resync is for this deployment's column-level specs only" }, { status: 400 });
      const ids: string[] = [...new Set<string>((Array.isArray(body?.ids) ? body.ids : []).map(String)
        .filter((i: string) => /^\d+$/.test(i)))];
      if (!ids.length || ids.length > 10) return Response.json({ error: "1-10 numeric ids" }, { status: 400 });
      /**
       * `dryRun: true` (a literal true only) runs the SAME engine with every write suppressed, so a repair
       * can be sized by the code that will perform it rather than by a script's re-implementation of it.
       * The per-record result says what it would have done.
       */
      const dryRun = body?.dryRun === true;
      const opts = dryRun ? dryRunModeFor(env, maxWritesFor(env)) : optsFromEnv(env);
      const results: Record<string, string> = {};
      for (const id of ids) {
        try { results[id] = await syncHubspotRecord(env, spec, id, opts, { left: 30 }, undefined, body?.forceForward === true); }
        catch (e) { results[id] = `error: ${String(e).slice(0, 140)}`; }
      }
      return Response.json({ object, dryRun, results });
    }

    /**
     * POST /resync-activity {object, ids[]} -- deliver specific HubSpot activities to their cards.
     *
     * For the ones the live path missed (819 inbox-imported emails refused by the old cutover rule, and
     * activities whose card did not exist yet). Same function a webhook runs, with verifyExisting so an
     * activity already on a card is found rather than written twice.
     */
    if (url.pathname === "/resync-activity" && req.method === "POST") {
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      if (!activitySyncEnabled(env)) return Response.json({ error: "activity sync is off" }, { status: 409 });
      const body: any = await req.json().catch(() => ({}));
      const object = String(body?.object ?? "");
      if (!["emails", "calls", "notes", "meetings", "tasks"].includes(object))
        return Response.json({ error: "object must be emails|calls|notes|meetings|tasks" }, { status: 400 });
      const ids: string[] = [...new Set<string>((Array.isArray(body?.ids) ? body.ids : []).map(String)
        .filter((i: string) => /^\d+$/.test(i)))];
      if (!ids.length || ids.length > 10) return Response.json({ error: "1-10 numeric ids" }, { status: 400 });
      const results: Record<string, string> = {};
      for (const id of ids) {
        try { results[id] = await syncHubspotActivity(env, object, id, { verifyExisting: true }); }
        catch (e) { results[id] = `error: ${String(e).slice(0, 140)}`; }
      }
      return Response.json({ object, results });
    }

    /**
     * POST /marketing-poll {dryRun?, limit?} -- one marketing email poll, on demand.
     *
     * For the canary ("does exactly one entry appear, and does a second poll add none?") and for looking
     * before switching anything on. DRY BY DEFAULT: only a literal `dryRun: false` writes, and the
     * `limit` (1-10, default 3) can only lower the per-poll cap. Every gate the cron obeys still applies,
     * and it shares the cron's lock, so the two can never work the same window at once.
     */
    if (url.pathname === "/marketing-poll" && req.method === "POST") {
      // CRM-ONLY ROUTES. The Work Management Worker shares this fetch handler; there these paths must
      // stay exactly what they were before the poller existed -- "not found", reading nothing.
      if (env.ENABLE_CRM !== "true") return new Response("not found", { status: 404 });
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      const body: any = await req.json().catch(() => ({}));
      const n = Number(body?.limit ?? 3);
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 10) : 3;
      try {
        return Response.json(await pollMarketingEmails(env, { dryRun: body?.dryRun !== false, maxWrites: limit }));
      } catch (e) {
        return Response.json({ status: "error", reason: String(e).slice(0, 200) }, { status: 500 });
      }
    }

    /**
     * POST /wake-timeline {itemIds[]} -- read these Contacts cards' timelines and push their native Notes
     * and Calls to HubSpot, exactly as a doorbell ring would (syncMondayTimeline).
     *
     * The catch-up for the gap when nothing rang: automations #09/#10 went off at 2026-09-30T09:00:42Z,
     * and until the bell workflow (1940472437) stamped the Activity bell, reps' monday notes and calls
     * reached nobody -- and a Call summary still does not ring a Note-only bell.
     *
     * IT WRITES HUBSPOT WHATEVER DRY_RUN OR WRITE_HUBSPOT SAY, exactly like a ring: the activity push is
     * gated by ENABLE_ACTIVITY_SYNC alone (activitySyncEnabled below), never by the record-sync write
     * mode.
     * scripts/wake-timelines.mjs finds the cards. Repeats are safe -- the durable registry makes an
     * entry already pushed cost one read and create nothing -- and entries before the activity cutover
     * are never pushed. Contacts cards only (one read checks the board), 1-20 ids per request.
     */
    if (url.pathname === "/wake-timeline" && req.method === "POST") {
      // CRM-ONLY, like the marketing routes: on Work Management this path stays "not found".
      if (env.ENABLE_CRM !== "true") return new Response("not found", { status: 404 });
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      if (!activitySyncEnabled(env)) return Response.json({ error: "activity sync is off" }, { status: 409 });
      const body: any = await req.json().catch(() => ({}));
      const ids: string[] = [...new Set<string>((Array.isArray(body?.itemIds) ? body.itemIds : []).map(String)
        .filter((i: string) => /^\d+$/.test(i)))];
      if (!ids.length || ids.length > 20) return Response.json({ error: "1-20 numeric itemIds" }, { status: 400 });
      let boardOf: Record<string, string>;
      try {
        const d = await gql(env, `query ($i: [ID!]) { items(ids: $i) { id board { id } } }`, { i: ids }, 2);
        boardOf = Object.fromEntries(((d?.items ?? []) as any[]).map(it => [String(it.id), String(it.board?.id ?? "")]));
      } catch (e) {
        return Response.json({ error: `board check failed: ${String(e).slice(0, 140)}` }, { status: 502 });
      }
      const results: Record<string, string> = {};
      for (const id of ids) {
        if (boardOf[id] !== CRM_CONTACTS.boardId) {
          results[id] = boardOf[id] ? `skipped: not a Contacts card (board ${boardOf[id]})` : "skipped: item not found";
          continue;
        }
        try { results[id] = await syncMondayTimeline(env, id); }
        catch (e) { results[id] = `error: ${String(e).slice(0, 140)}`; }
      }
      return Response.json({ results });
    }

    /** GET /marketing-ledger?hour=YYYY-MM-DDTHH -- what the marketing poller wrote that hour, for rollback. */
    if (url.pathname === "/marketing-ledger" && req.method === "GET") {
      if (env.ENABLE_CRM !== "true") return new Response("not found", { status: 404 });
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      const hour = url.searchParams.get("hour") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour))
        return Response.json({ error: "hour must be YYYY-MM-DDTHH (UTC)" }, { status: 400 });
      const rows = await readLedger(env, hour);
      return Response.json({ hour, count: rows.length,
        rows: rows.map(([timelineId, cardId, object, eventKey, contactId]) => ({ timelineId, cardId, object, eventKey, contactId })) });
    }

    if (url.pathname === "/run") {
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      const mode = url.searchParams.get("mode") ?? "dry";
      const n = Number(url.searchParams.get("maxWrites") ?? "300");
      // /run's ?mode=live is an explicit manual override of DRY_RUN, but WRITE_HUBSPOT still applies:
      // a deployment configured not to touch HubSpot must not be talked into it by a query string.
      const opts: RunOpts = writeModeFor(
        { DRY_RUN: mode === "live" ? "false" : "true", WRITE_HUBSPOT: env.WRITE_HUBSPOT },
        Number.isFinite(n) && n >= 0 ? n : 300,
      );
      const stats = await runAll(env, opts, url.searchParams.get("object") ?? undefined);
      return Response.json({ mode, maxWrites: opts.maxWrites, stats });
    }

    // One-time bulk import of ALL companies: `X-Trigger-Secret` header.
    //   /import?object=companies&after=<cursor>  — one list-API page per call; upsert each card via the
    // real (deduped) path. NO association pass (Phase 1 = cards only). Driven page-by-page by a script.
    if (url.pathname === "/import" && req.method === "GET") {
      if (!triggerOk(req, env))
        return new Response("forbidden", { status: 403 });
      const object = url.searchParams.get("object") ?? "";
      if (!["companies", "company-associations"].includes(object))
        return Response.json({ error: "object must be companies|company-associations" }, { status: 400 });
      const after = url.searchParams.get("after") || undefined;
      const ctx = await getCtxCached(env);
      const opts = optsFromEnv(env);
      // THIS DEPLOYMENT'S companies spec -- see /app/ensure-card. Hardcoded COMPANIES_MYLA would card every
      // company onto the Work-Management board when run against the CRM Worker.
      const coSpec = specByObject(env, "companies") ?? COMPANIES_MYLA;

      // Phase 2: per company, run the association pass — creates each linked contact's card (deduped) and
      // writes the company->contact link. Heavier per record than the card import, so small pages.
      if (object === "company-associations") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "10"), 1), 60);
        const conc = Math.min(Math.max(Number(url.searchParams.get("conc") ?? "5"), 1), 10);
        // Shard "i/N": process only companies whose id % N === i. All N walkers page the SAME list (cursor
        // advances by the full page, `scanned`), but each processes a disjoint 1/N — so N parallel walkers,
        // each a separate Worker invocation with its own connection budget, multiply throughput past the
        // per-invocation concurrency ceiling. No shard (N=1) processes everything (backward compatible).
        let shardI = 0, shardN = 1;
        const shard = url.searchParams.get("shard");
        if (shard && /^\d+\/\d+$/.test(shard)) { const [i, n] = shard.split("/").map(Number); if (n >= 1 && i >= 0 && i < n) { shardI = i; shardN = n; } }
        const { records: page, next } = await listPage(env, "companies", after, propertiesForSpec(coSpec), limit);
        const records = shardN > 1 ? page.filter(r => Number(r.id) % shardN === shardI) : page;
        let linked = 0, missing = 0, errors = 0;
        // Bounded concurrency: each company's association pass is independent and I/O-bound (HubSpot reads +
        // monday card/relation writes), so a few in parallel overlap the network waits and multiply
        // throughput. It does NOT raise the per-request subrequest count for a given page (same companies,
        // same work — just overlapped), so it stays well under the Worker limit. Mirrors the Phase 1 import.
        for (let i = 0; i < records.length; i += conc) {
          const results = await Promise.all(records.slice(i, i + conc).map(async rec => {
            const card = (await findItemByColumn(env, coSpec.boardId, coSpec.idCol, rec.id))[0];
            if (!card) return "missing" as const;
            const budget: Budget = { left: 60 };
            try { await syncAssociations(env, coSpec, rec, card, ctx, opts, budget); return "linked" as const; }
            catch (e) { console.log(`[import assoc] company=${rec.id} error="${String(e).slice(0, 140)}"`); return "error" as const; }
          }));
          for (const r of results) { if (r === "linked") linked++; else if (r === "missing") missing++; else errors++; }
        }
        return Response.json({ processed: records.length, scanned: page.length, linked, missing, errors, after: next ?? null, done: !next });
      }

      // Phase 1: card import (object === "companies").
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "40"), 1), 100);
      const conc = Math.min(Math.max(Number(url.searchParams.get("conc") ?? "5"), 1), 10);
      const { records, next } = await listPage(env, "companies", after, propertiesForSpec(coSpec), limit);
      let created = 0, existing = 0;
      // Bounded concurrency: each company's ensureCardForRecord is independent (its own DO instance), so a
      // few in parallel cut the per-request latency without overrunning monday's rate limit.
      for (let i = 0; i < records.length; i += conc) {
        const results = await Promise.all(records.slice(i, i + conc).map(rec =>
          ensureCardForRecord(env, coSpec, ctx, rec, opts).catch(() => ({ status: "error" as const }))));
        for (const r of results) { if (r.status === "created") created++; else if (r.status === "existing") existing++; }
      }
      return Response.json({ processed: records.length, created, existing, after: next ?? null, done: !next });
    }

    return new Response("not found", { status: 404 });
  },
};
