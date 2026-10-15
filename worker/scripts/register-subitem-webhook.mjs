// One-time / idempotent: register monday SUBITEM webhooks so board edits to line items reverse to HubSpot.
// monday requires subitem webhooks to be registered on the PARENT board (the hidden subitems board is
// rejected: "Creating webhook on subitems board isn't allowed"). Events used: change_subitem_column_value
// (field edits + create-on-first-edit) and change_subitem_name (renames).
//
// Usage (from repo root):  MONDAY_CODE_ACCESS_TOKEN=<token> node worker/scripts/register-subitem-webhook.mjs
const TOKEN = process.env.MONDAY_CODE_ACCESS_TOKEN;
if (!TOKEN) { console.error("Set MONDAY_CODE_ACCESS_TOKEN"); process.exit(1); }

// Every configured Deals (parent) board. There is one today (DEALS.boardId); listed here so adding a
// board is a one-line change.
const DEALS_BOARDS = ["5029480547"];
const URL = "https://hubspot-monday-sync.askada.workers.dev/webhooks/monday";
const EVENTS = ["change_subitem_column_value", "change_subitem_name"];

async function gql(query, variables) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: TOKEN, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

for (const board of DEALS_BOARDS) {
  // 1. Query existing webhooks on this board so we never create a duplicate.
  let existing = [];
  try {
    existing = (await gql(`query ($b: ID!) { webhooks(board_id: $b) { id event } }`, { b: board })).webhooks ?? [];
  } catch (err) { console.error("FAILED listing webhooks for board", board, String(err).slice(0, 300)); continue; }
  const have = new Set(existing.map(w => w.event));
  console.log(`board ${board}: existing events = [${[...have].join(", ")}]`);

  // 2. Create only the events not already present.
  for (const e of EVENTS) {
    if (have.has(e)) { console.log(`  exists, skipping: ${e}`); continue; }
    try {
      const d = await gql(`mutation ($b: ID!, $u: String!, $e: WebhookEventType!) {
        create_webhook(board_id: $b, url: $u, event: $e) { id board_id event }
      }`, { b: board, u: URL, e });
      console.log("  created", JSON.stringify(d.create_webhook));
    } catch (err) { console.error("  FAILED", e, String(err).slice(0, 300)); }
  }
}
