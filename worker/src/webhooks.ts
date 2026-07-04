import type { Budget, Env, RunOpts } from "./types";
import { SPEC_BY_BOARD } from "./config";
import { syncHubspotDeal, syncMondayItem } from "./sync";

// Webhooks write for real when the Worker is live; a small per-webhook budget is plenty (1 record).
function liveOpts(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  return { dryRun: !live, writeHubspot: live, maxWrites: 30 };
}

async function hmacB64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ------------------------------- monday -------------------------------
// POST /webhooks/monday
// Handles the subscription challenge, then item-created / name-changed / column-changed / moved.
export async function handleMonday(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  let body: any = {};
  try { body = JSON.parse(raw); } catch { /* not json */ }

  // monday sends {"challenge":"..."} when the webhook is created — echo it back.
  if (body.challenge) return Response.json({ challenge: body.challenge });

  const ev = body.event ?? {};
  const boardId = String(ev.boardId ?? "");
  const itemId = String(ev.pulseId ?? ev.itemId ?? "");
  const type = String(ev.type ?? "");
  const columnId = ev.columnId ? String(ev.columnId) : "";
  const spec = SPEC_BY_BOARD[boardId];

  if (!spec || !itemId) {
    console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type} action=ignored reason="board not configured / no item"`);
    return new Response("ok");
  }
  // LOOP GUARD: ignore changes we made to our own bookkeeping columns (Sync State / HubSpot ID /
  // Link). Value columns still flow through, but value-diff will no-op an echo.
  const bookkeeping = new Set([spec.syncStateCol, spec.idCol, spec.linkCol].filter(Boolean) as string[]);
  if (type === "update_column_value" && bookkeeping.has(columnId)) {
    console.log(`[webhook] source=monday item=${itemId} type=${type} col=${columnId} action=ignored reason="own bookkeeping column"`);
    return new Response("ok");
  }

  console.log(`[webhook] source=monday board=${boardId} item=${itemId} type=${type}${columnId ? ` col=${columnId}` : ""} action=received`);
  const budget: Budget = { left: 30 };
  ectx.waitUntil(syncMondayItem(env, boardId, itemId, liveOpts(env), budget)
    .catch(e => console.log(`[webhook] source=monday item=${itemId} action=error reason="${String(e).slice(0, 160)}"`)));
  return new Response("ok"); // respond fast so monday doesn't retry
}

// ------------------------------- hubspot -------------------------------
// POST /webhooks/hubspot — deal.creation / deal.propertyChange (name, stage, pipeline, owner, sales_user).
async function verifyHubspot(env: Env, req: Request, raw: string): Promise<boolean> {
  if (!env.HUBSPOT_APP_SECRET) return true; // not configured -> accept (endpoint is unguessable)
  const sig = req.headers.get("x-hubspot-signature-v3");
  const ts = req.headers.get("x-hubspot-request-timestamp");
  if (!sig || !ts || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false;
  const expected = await hmacB64(env.HUBSPOT_APP_SECRET, `${req.method}${req.url}${raw}${ts}`);
  return safeEq(expected, sig);
}

export async function handleHubspot(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  if (!(await verifyHubspot(env, req, raw))) {
    console.log('[webhook] source=hubspot action=rejected reason="bad signature"');
    return new Response("forbidden", { status: 403 });
  }
  let events: any[] = [];
  try { const b = JSON.parse(raw); events = Array.isArray(b) ? b : [b]; } catch { /* not json */ }

  const dealIds = [...new Set(events
    .filter(e => String(e.subscriptionType ?? e.eventType ?? "").startsWith("deal"))
    .map(e => String(e.objectId ?? "")).filter(Boolean))];
  if (!dealIds.length) return new Response("ok");

  console.log(`[webhook] source=hubspot deals=${dealIds.join(",")} events=${events.length} action=received`);
  const opts = liveOpts(env);
  const budget: Budget = { left: 30 };
  ectx.waitUntil(Promise.all(dealIds.map(id =>
    syncHubspotDeal(env, id, opts, budget)
      .catch(e => console.log(`[webhook] source=hubspot deal=${id} action=error reason="${String(e).slice(0, 160)}"`)))));
  return new Response("ok"); // respond fast so HubSpot doesn't retry
}
