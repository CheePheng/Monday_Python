// One-time: register monday webhooks on the line-item subitems board so board edits reverse to HubSpot.
// Usage (from repo root):  MONDAY_CODE_ACCESS_TOKEN=<token> node worker/scripts/register-subitem-webhook.mjs
const TOKEN = process.env.MONDAY_CODE_ACCESS_TOKEN;
if (!TOKEN) { console.error("Set MONDAY_CODE_ACCESS_TOKEN"); process.exit(1); }
const BOARD = "5029480548"; // LINE_ITEM_SUBITEMS.boardId
const URL = "https://hubspot-monday-sync.askada.workers.dev/webhooks/monday";
const EVENTS = ["change_column_value", "change_name"];

async function createWebhook(event) {
  const query = `mutation ($b: ID!, $u: String!, $e: WebhookEventType!) {
    create_webhook(board_id: $b, url: $u, event: $e) { id board_id event }
  }`;
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables: { b: BOARD, u: URL, e: event } }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(`${event}: ${JSON.stringify(j.errors)}`);
  return j.data.create_webhook;
}

for (const e of EVENTS) {
  try { console.log("created", JSON.stringify(await createWebhook(e))); }
  catch (err) { console.error("FAILED", e, String(err).slice(0, 300)); }
}
