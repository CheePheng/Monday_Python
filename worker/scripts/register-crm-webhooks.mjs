/**
 * Register monday webhooks for the two CRM boards. **NOT RUN IN PHASE 1.**
 *
 * Requires an explicit --apply to do anything. The default (--plan) prints what it WOULD do, which is
 * how this should first be reviewed. Idempotent: existing hooks are read first and matching ones are
 * left alone, so re-running never produces duplicate deliveries.
 *
 *   node scripts/register-crm-webhooks.mjs --plan                  # read-only (default)
 *   node scripts/register-crm-webhooks.mjs --apply --url https://…/webhook/monday
 *
 * Env: MONDAY_API_TOKEN (required for any mode, including --plan, since it reads existing hooks).
 */

export const CRM_BOARDS = {
  "5028000495": "Contacts",
  "5028000496": "Accounts/Companies",
};

/**
 * REGISTRATION names, which are NOT the delivered payload names.
 *
 * monday accepts `create_item` at registration but DELIVERS `event.type = "create_pulse"`. The
 * webhook handler must therefore branch on the delivered name while the registrar sends this one —
 * a mismatch that has bitten this repo before (see the create_pulse notes in card-registry.ts and
 * sync.ts). Do not "correct" this list to the delivered names.
 */
export const CRM_WEBHOOK_EVENTS = [
  "create_item",          // delivered as create_pulse
  "change_column_value",
  "change_name",
  "item_deleted",
];

/** Delivered payload names the handler must accept for the events above. Documentation + tests only. */
export const DELIVERED_EVENT_ALIASES = {
  create_item: ["create_pulse", "create_item"],
  change_column_value: ["change_column_value", "update_column_value"],
  change_name: ["change_name", "update_name"],
  item_deleted: ["item_deleted"],
};

const API = "https://api.monday.com/v2";

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

/** Hooks already on a board, so registration can skip what exists rather than duplicating it. */
export async function existingHooks(token, boardId) {
  const d = await gql(token, "query ($b: ID!) { webhooks(board_id: $b) { id event board_id config } }",
    { b: boardId });
  return d.webhooks ?? [];
}

/** What is missing on this board: the events with no existing hook pointing at `url`. */
export function missingEvents(hooks, url) {
  const have = new Set(hooks
    .filter(h => !url || String(h.config ?? "").includes(url) || !h.config)
    .map(h => h.event));
  return CRM_WEBHOOK_EVENTS.filter(e => !have.has(e));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const url = (args[args.indexOf("--url") + 1] ?? "").startsWith("http")
    ? args[args.indexOf("--url") + 1] : "";
  const token = process.env.MONDAY_API_TOKEN;

  if (!token) { console.error("MONDAY_API_TOKEN is required (even for --plan, which reads existing hooks)"); process.exit(1); }
  if (apply && !url) { console.error("--apply requires --url <webhook endpoint>"); process.exit(1); }

  for (const [boardId, label] of Object.entries(CRM_BOARDS)) {
    const hooks = await existingHooks(token, boardId);
    const missing = missingEvents(hooks, url);
    console.log(`\nboard ${boardId} (${label}): ${hooks.length} existing hook(s)`);
    for (const h of hooks) console.log(`   have  ${h.event}  id=${h.id}`);
    if (!missing.length) { console.log("   nothing to add — already registered"); continue; }
    for (const event of missing) {
      if (!apply) { console.log(`   WOULD create  ${event}  -> ${url || "(no --url given)"}`); continue; }
      const d = await gql(token,
        "mutation ($b: ID!, $u: String!, $e: WebhookEventType!) { create_webhook(board_id: $b, url: $u, event: $e) { id event } }",
        { b: boardId, u: url, e: event });
      console.log(`   created  ${d.create_webhook.event}  id=${d.create_webhook.id}`);
    }
  }
  if (!apply) console.log("\n--plan only. Nothing was registered. Re-run with --apply --url <endpoint> to register.");
}

// Import-safe: the constants above are imported by tests, which must not execute main().
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("register-crm-webhooks.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
