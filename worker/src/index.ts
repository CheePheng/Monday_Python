import type { Env, RunOpts } from "./types";
import { runAll, runIncremental } from "./sync";
import { handleHubspot, handleMonday } from "./webhooks";
import { searchObjects } from "./hubspot";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "X-App-Secret, Content-Type",
};

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

    // Live HubSpot picker for the vibe app: GET /app/search?type=contacts|companies|products&q=&limit=
    // Auth: header X-App-Secret (falls back to TRIGGER_SECRET). CORS-enabled (app calls cross-origin).
    if (url.pathname === "/app/search") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const secret = env.APP_SECRET || env.TRIGGER_SECRET;
      if (!secret || req.headers.get("x-app-secret") !== secret)
        return new Response("forbidden", { status: 403, headers: CORS });
      const type = url.searchParams.get("type") ?? "";
      if (!["contacts", "companies", "products"].includes(type))
        return Response.json({ error: "type must be contacts|companies|products" }, { status: 400, headers: CORS });
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "10");
      try {
        const results = await searchObjects(env, type, q, Number.isFinite(limit) ? limit : 10);
        return Response.json({ results }, { headers: CORS });
      } catch (e) {
        // products (or any type) missing its read scope -> degrade gracefully instead of 500.
        const scope = /403|forbidden|scope/i.test(String(e));
        console.log(`[app/search] type=${type} error="${String(e).slice(0, 140)}"`);
        return Response.json({ results: [], error: scope ? "scope" : "search-failed" }, { headers: CORS });
      }
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
