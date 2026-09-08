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

/**
 * Which of CRM_WEBHOOK_EVENTS have no existing hook on this board.
 *
 * MATCHED ON EVENT NAME ALONE, and that is a real limitation rather than a shortcut: monday's
 * `webhooks` query returns only { id, event, board_id, config }, and `config` comes back as the literal
 * string "{}" — **the target URL is not exposed by the API at all**. So this cannot distinguish a hook
 * pointing at our Worker from one pointing somewhere else; it assumes an existing hook for the same
 * event on the same board is ours and leaves it alone.
 *
 * That is the safe direction to be wrong in: the failure mode is "declines to add a hook that already
 * exists for that event", not "creates a duplicate". Duplicates are the expensive error, because monday
 * would then deliver every change twice.
 *
 * If a hook ever needs repointing at a different URL, delete it in the monday UI and re-run — this
 * script deliberately never mutates an existing hook.
 *
 * (An earlier version filtered on `config.includes(url) || !config`. With the real value "{}" that
 * matched nothing, so every event looked missing and a second --apply would have doubled every hook.)
 */
export function missingEvents(hooks) {
  const have = new Set(hooks.map(h => h.event));
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
    const missing = missingEvents(hooks);
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
