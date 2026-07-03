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

  // Manual trigger: /run?secret=...&object=deals|companies|contacts&mode=dry|live&maxWrites=300
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    if (url.searchParams.get("secret") !== env.TRIGGER_SECRET)
      return new Response("forbidden", { status: 403 });
    const mode = url.searchParams.get("mode") ?? "dry";
    const opts: RunOpts = {
      dryRun: mode !== "live",
      writeHubspot: mode === "live",
      maxWrites: Number(url.searchParams.get("maxWrites") ?? "300"),
    };
    const stats = await runAll(env, opts, url.searchParams.get("object") ?? undefined);
    return Response.json({ mode, stats });
  },
};
