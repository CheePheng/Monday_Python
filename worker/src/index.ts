import type { Env, RunOpts } from "./types";
import { runAll, runIncremental, syncMondayItem } from "./sync";
import { handleHubspot, handleMonday } from "./webhooks";
import { searchObjects, patchLineItem, deleteLineItem, deleteAssociation, archiveDeal, patchRecord, createProduct, createLineItem, getWritablePropOptions } from "./hubspot";
import { verifySessionToken } from "./session";
import { parseLineItemBody, parseAssociationBody, parseDealBody, parseSyncDealBody, parseClearDealBody, parseCreateLineItemBody } from "./app-routes";
import { DEALS, LINE_ITEM_SUBITEMS } from "./config";
import { getItem, setColumns } from "./monday";
import { colText } from "./dedup";
import { LINE_ITEM_ENUM_PROPS, PRODUCT_COPY_PROPS } from "./line-item-props";

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
async function authApp(req: Request, env: Env): Promise<{ ok: boolean; reason: string }> {
  const trigger = req.headers.get("x-trigger-secret");
  if (trigger && env.TRIGGER_SECRET && trigger === env.TRIGGER_SECRET) return { ok: true, reason: "trigger-secret" };
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false, reason: "no session token / trigger secret" };
  const v = await verifySessionToken(env.MONDAY_APP_SESSION_SECRET ?? "", bearer, env.MONDAY_ACCOUNT_ID, Date.now());
  return { ok: v.ok, reason: v.reason };
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

      // GET /app/search?type=contacts|companies|products&q=&limit=
      if (url.pathname === "/app/search" && req.method === "GET") {
        const type = url.searchParams.get("type") ?? "";
        if (!["contacts", "companies", "products"].includes(type))
          return Response.json({ error: "type must be contacts|companies|products" }, { status: 400, headers: { ...CORS, "Cache-Control": "no-store" } });
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

      // GET /app/line-item-schema — writable enum options for the manual line-item form (live).
      if (url.pathname === "/app/line-item-schema" && req.method === "GET") {
        try {
          const schema = await getWritablePropOptions(env, LINE_ITEM_ENUM_PROPS);
          return Response.json({ schema }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/line-item-schema] error="${String(e).slice(0, 140)}"`);
          return Response.json({ schema: {}, error: "schema-failed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }

      // POST /app/line-item — create (body has subitemId) OR update (body has lineItemId) | DELETE {lineItemId}
      if (url.pathname === "/app/line-item" && (req.method === "POST" || req.method === "DELETE")) {
        const body: any = await req.json().catch(() => ({}));
        if (req.method === "POST" && body?.subitemId !== undefined) {
          const c = parseCreateLineItemBody(body);
          if (!c.ok) return Response.json({ error: c.error }, { status: 400, headers: CORS });
          try {
            // 1) ensure the parent deal exists in HubSpot; resolve its id from the monday deal card.
            let deal = await getItem(env, c.itemId!);
            let dealId = deal ? colText(deal, DEALS.idCol) : "";
            if (!dealId) {
              await syncMondayItem(env, DEALS.boardId, c.itemId!, appWriteOpts(env), { left: 10 }); // createFromMonday
              deal = await getItem(env, c.itemId!);
              dealId = deal ? colText(deal, DEALS.idCol) : "";
            }
            if (!dealId) return Response.json({ ok: false, error: "deal-not-synced" }, { status: 409, headers: CORS });
            // 2) optional Save-to-library -> create a product, link it.
            const props = { ...c.properties! };
            if (c.saveToLibrary && !props.hs_product_id) {
              const pProps: Record<string, string> = {};
              for (const [k, v] of Object.entries(props)) if (PRODUCT_COPY_PROPS.has(k)) pProps[k] = v;
              const pid = await createProduct(env, pProps, appWriteOpts(env));
              if (pid) props.hs_product_id = pid;
            }
            // 3) create the HubSpot line item (+ associate to the deal), 4) write the id back onto the subitem.
            const lineItemId = await createLineItem(env, props, dealId, appWriteOpts(env));
            if (lineItemId) await setColumns(env, LINE_ITEM_SUBITEMS.boardId, c.subitemId!, { [LINE_ITEM_SUBITEMS.idCol]: lineItemId }, appWriteOpts(env));
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

      // DELETE /app/association {fromObject, fromId, toObject, toId}
      if (url.pathname === "/app/association" && req.method === "DELETE") {
        const body = await req.json().catch(() => ({}));
        const a = parseAssociationBody(body);
        if (!a.ok) return Response.json({ error: a.error }, { status: 400, headers: CORS });
        try {
          await deleteAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env));
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/association] ${a.fromId}->${a.toId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "hubspot-failed" }, { status: 502, headers: CORS });
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

    return new Response("not found", { status: 404 });
  },
};
