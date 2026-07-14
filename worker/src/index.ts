import type { Env, RunOpts } from "./types";
import { runAll, runIncremental } from "./sync";
import { handleHubspot, handleMonday } from "./webhooks";
import { searchObjects, patchLineItem, deleteLineItem, deleteAssociation, archiveDeal } from "./hubspot";
import { verifySessionToken } from "./session";
import { parseLineItemBody, parseAssociationBody, parseDealBody } from "./app-routes";

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
          return Response.json({ error: "type must be contacts|companies|products" }, { status: 400, headers: CORS });
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? "10");
        try {
          const results = await searchObjects(env, type, q, Number.isFinite(limit) ? limit : 10);
          return Response.json({ results }, { headers: CORS });
        } catch (e) {
          const scope = /403|forbidden|scope/i.test(String(e));
          console.log(`[app/search] type=${type} error="${String(e).slice(0, 140)}"`);
          return Response.json({ results: [], error: scope ? "scope" : "search-failed" }, { headers: CORS });
        }
      }

      // POST /app/line-item {lineItemId, properties}  |  DELETE /app/line-item {lineItemId}
      if (url.pathname === "/app/line-item" && (req.method === "POST" || req.method === "DELETE")) {
        const body = await req.json().catch(() => ({}));
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
