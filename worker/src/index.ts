import type { Env, RunOpts } from "./types";
import { runAll } from "./sync";
import { handleHubspot, handleMonday } from "./webhooks";

function optsFromEnv(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  // Cron is now a BACKUP (every 10 min). 25 writes/tick keeps subrequests under the free-plan 50 cap.
  return { dryRun: !live, writeHubspot: live, maxWrites: 25 };
}

export default {
  // Backup reconciliation — catches anything the webhooks missed.
  async scheduled(_event: ScheduledEvent, env: Env, ectx: ExecutionContext): Promise<void> {
    ectx.waitUntil(runAll(env, optsFromEnv(env)).then(s => console.log("cron-backup", JSON.stringify(s))));
  },

  async fetch(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Near-instant fast paths (no secret header — guarded by the challenge/signature inside).
    if (url.pathname === "/webhooks/monday") return handleMonday(req, env, ectx);
    if (url.pathname === "/webhooks/hubspot") return handleHubspot(req, env, ectx);

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
