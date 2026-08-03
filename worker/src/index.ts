import type { Env, RunOpts, Budget } from "./types";
export { CreateIdempotency } from "./create-idempotency-do";
import { runAll, runIncremental, syncMondayItem, getCtxCached } from "./sync";
import { createContactOrCompany, type CreateInput } from "./create-records";
import { handleHubspot, handleMonday } from "./webhooks";
import { searchObjects, patchLineItem, deleteLineItem, deleteAssociation, putAssociation, archiveDeal, patchRecord, createProduct, createLineItem, getWritablePropOptions, getDealLineItems, getRecord, propertiesForSpec, getAssociatedIds, getRecordsByIds, listPage, listCompanies, mapAssocRecord, mapOwners } from "./hubspot";
import { ensureCardForRecord, cardIdOf } from "./ensure-card";
import { verifySessionToken } from "./session";
import { parseLineItemBody, parseAssociationBody, parseDealBody, parseSyncDealBody, parseClearDealBody, parseCreateLineItemBody, parseContactBody, parseCompanyBody, parseSyncCompanyBody } from "./app-routes";
import { DEALS, LINE_ITEM_SUBITEMS, CONTACTS_MYLA, COMPANIES_MYLA } from "./config";
import { getItem, setColumns, findItemByColumn } from "./monday";
import { syncAssociations } from "./associations";
import { colText } from "./dedup";
import { LINE_ITEM_ENUM_PROPS, PRODUCT_COPY_PROPS } from "./line-item-props";
import { CONTACT_ENUM_PROPS, COMPANY_ENUM_PROPS } from "./contact-company-props";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-Trigger-Secret, Content-Type",
};

// Writes for real when the Worker is live (mirrors optsFromEnv but with a small per-request budget).
function appWriteOpts(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  return { dryRun: !live, writeHubspot: live, maxWrites: 5 };
}

// Auth for /app/*: a valid monday session token (browser) OR X-Trigger-Secret (server-to-server).
// The old static X-App-Secret path is retired (it was exposed in frontend prompt material).
async function authApp(req: Request, env: Env): Promise<{ ok: boolean; reason: string; userId?: string; accountId?: string }> {
  const trigger = req.headers.get("x-trigger-secret");
  if (trigger && env.TRIGGER_SECRET && trigger === env.TRIGGER_SECRET) return { ok: true, reason: "trigger-secret" };
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false, reason: "no session token / trigger secret" };
  const v = await verifySessionToken(env.MONDAY_APP_SESSION_SECRET ?? "", bearer, env.MONDAY_ACCOUNT_ID, Date.now());
  return { ok: v.ok, reason: v.reason, userId: v.userId, accountId: v.accountId };
}

function optsFromEnv(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  // Writes/records per cron tick. Default 25 keeps subrequests under the free-plan 50 cap; raise via the
  // MAX_WRITES var on Workers Paid (1,000 subrequests) so bulk imports catch up faster per tick.
  const n = Number(env.MAX_WRITES ?? "25");
  const maxWrites = Number.isFinite(n) && n > 0 ? n : 25;
  return { dryRun: !live, writeHubspot: live, maxWrites };
}

export default {
  // Webhooks are the primary, instant path. Crons are only safety nets:
  //   - every 10 min: a LIGHT incremental check (recently-changed records only) that sweeps up any
  //     missed webhook. Window >10 min so nothing slips between ticks.
  //   - once a day (03:00 UTC): a FULL reconciliation (deep scan of every record). The heavy scan runs
  //     daily instead of every minute to avoid unnecessary API load.
  async scheduled(event: ScheduledEvent, env: Env, ectx: ExecutionContext): Promise<void> {
    const opts = optsFromEnv(env);
    if (event.cron === "0 3 * * *") {
      ectx.waitUntil(runAll(env, opts).then(s => console.log("cron-daily-full", JSON.stringify(s))));
    } else {
      ectx.waitUntil(runIncremental(env, opts, 11 * 60_000).then(s => console.log("cron-backup", s)));
    }
  },

  async fetch(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Near-instant fast paths (no secret header — guarded by the challenge/signature inside).
    if (url.pathname === "/webhooks/monday") return handleMonday(req, env, ectx);
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
      const actingAccountId = auth.accountId ?? env.MONDAY_ACCOUNT_ID ?? "acct"; // namespaces idempotency keys

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
          const recs = ids.length ? await getRecordsByIds(env, to, ids, ["name", "domain", "firstname", "lastname", "email", "jobtitle", "dealname"]) : [];
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
            const lineItemId = await createLineItem(env, props, dealId, appWriteOpts(env));
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
          if (req.method === "POST") await patchLineItem(env, p.lineItemId!, p.properties!, appWriteOpts(env));
          else await deleteLineItem(env, p.lineItemId!, appWriteOpts(env));
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
          if (req.method === "POST") await putAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env));
          else await deleteAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env));
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
          await archiveDeal(env, d.hubspotDealId!, appWriteOpts(env));
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
          await patchRecord(env, DEALS, c.hubspotDealId!, props, appWriteOpts(env));
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/clear-deal-fields] deal=${c.hubspotDealId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "clear-failed" }, { status: 502, headers: CORS });
        }
      }

      if (url.pathname === "/app/sync-deal" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const s = parseSyncDealBody(body);
        if (!s.ok) return Response.json({ error: s.error }, { status: 400, headers: CORS });
        try {
          await syncMondayItem(env, DEALS.boardId, s.itemId!, appWriteOpts(env), { left: 30 });
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
          await syncMondayItem(env, COMPANIES_MYLA.boardId, s.itemId!, appWriteOpts(env), { left: 30 });
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/sync-company] item=${s.itemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "sync-failed" }, { status: 502, headers: CORS });
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
          const spec = object === "contacts" ? CONTACTS_MYLA : COMPANIES_MYLA;
          const ctx = await getCtxCached(env);
          const rec = await getRecord(env, spec.object, hubspotId, propertiesForSpec(spec));
          if (!rec) return Response.json({ error: "record-not-found" }, { status: 404, headers: CORS });
          const itemId = cardIdOf(await ensureCardForRecord(env, spec, ctx, rec, appWriteOpts(env)));
          // null = another path holds the reservation right now; the caller should retry shortly.
          if (!itemId) return Response.json({ error: "card-pending" }, { status: 409, headers: CORS });
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
    if (url.pathname === "/run") {
      const provided = req.headers.get("x-trigger-secret") ?? "";
      if (!env.TRIGGER_SECRET || provided !== env.TRIGGER_SECRET)
        return new Response("forbidden", { status: 403 });
      const mode = url.searchParams.get("mode") ?? "dry";
      const n = Number(url.searchParams.get("maxWrites") ?? "300");
      const opts: RunOpts = {
        dryRun: mode !== "live",
        writeHubspot: mode === "live",
        maxWrites: Number.isFinite(n) && n >= 0 ? n : 300,
      };
      const stats = await runAll(env, opts, url.searchParams.get("object") ?? undefined);
      return Response.json({ mode, maxWrites: opts.maxWrites, stats });
    }

    // One-time bulk import of ALL companies: `X-Trigger-Secret` header.
    //   /import?object=companies&after=<cursor>  — one list-API page per call; upsert each card via the
    // real (deduped) path. NO association pass (Phase 1 = cards only). Driven page-by-page by a script.
    if (url.pathname === "/import" && req.method === "GET") {
      const provided = req.headers.get("x-trigger-secret") ?? "";
      if (!env.TRIGGER_SECRET || provided !== env.TRIGGER_SECRET)
        return new Response("forbidden", { status: 403 });
      const object = url.searchParams.get("object") ?? "";
      if (!["companies", "company-associations"].includes(object))
        return Response.json({ error: "object must be companies|company-associations" }, { status: 400 });
      const after = url.searchParams.get("after") || undefined;
      const ctx = await getCtxCached(env);
      const opts = optsFromEnv(env);

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
        const { records: page, next } = await listPage(env, "companies", after, propertiesForSpec(COMPANIES_MYLA), limit);
        const records = shardN > 1 ? page.filter(r => Number(r.id) % shardN === shardI) : page;
        let linked = 0, missing = 0, errors = 0;
        // Bounded concurrency: each company's association pass is independent and I/O-bound (HubSpot reads +
        // monday card/relation writes), so a few in parallel overlap the network waits and multiply
        // throughput. It does NOT raise the per-request subrequest count for a given page (same companies,
        // same work — just overlapped), so it stays well under the Worker limit. Mirrors the Phase 1 import.
        for (let i = 0; i < records.length; i += conc) {
          const results = await Promise.all(records.slice(i, i + conc).map(async rec => {
            const card = (await findItemByColumn(env, COMPANIES_MYLA.boardId, COMPANIES_MYLA.idCol, rec.id))[0];
            if (!card) return "missing" as const;
            const budget: Budget = { left: 60 };
            try { await syncAssociations(env, COMPANIES_MYLA, rec, card, ctx, opts, budget); return "linked" as const; }
            catch (e) { console.log(`[import assoc] company=${rec.id} error="${String(e).slice(0, 140)}"`); return "error" as const; }
          }));
          for (const r of results) { if (r === "linked") linked++; else if (r === "missing") missing++; else errors++; }
        }
        return Response.json({ processed: records.length, scanned: page.length, linked, missing, errors, after: next ?? null, done: !next });
      }

      // Phase 1: card import (object === "companies").
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "40"), 1), 100);
      const conc = Math.min(Math.max(Number(url.searchParams.get("conc") ?? "5"), 1), 10);
      const { records, next } = await listPage(env, "companies", after, propertiesForSpec(COMPANIES_MYLA), limit);
      let created = 0, existing = 0;
      // Bounded concurrency: each company's ensureCardForRecord is independent (its own DO instance), so a
      // few in parallel cut the per-request latency without overrunning monday's rate limit.
      for (let i = 0; i < records.length; i += conc) {
        const results = await Promise.all(records.slice(i, i + conc).map(rec =>
          ensureCardForRecord(env, COMPANIES_MYLA, ctx, rec, opts).catch(() => ({ status: "error" as const }))));
        for (const r of results) { if (r.status === "created") created++; else if (r.status === "existing") existing++; }
      }
      return Response.json({ processed: records.length, created, existing, after: next ?? null, done: !next });
    }

    return new Response("not found", { status: 404 });
  },
};
