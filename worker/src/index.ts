import type { Env, RunOpts } from "./types";
import { runAll } from "./sync";

function optsFromEnv(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  return { dryRun: !live, writeHubspot: live, maxWrites: 300 };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ectx: ExecutionContext): Promise<void> {
    ectx.waitUntil(runAll(env, optsFromEnv(env)).then(s => console.log("tick", JSON.stringify(s))));
  },

  // Manual trigger: header `X-Trigger-Secret: <secret>`
  //   POST/GET /run?object=deals|companies|contacts&mode=dry|live&maxWrites=300
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    // Secret in a header, not the query string, so it is never captured by request logging/history.
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
  },
};
