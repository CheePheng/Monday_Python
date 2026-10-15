/**
 * Re-point the CRM board webhooks at the authenticated capability URL.
 *
 * WHY A SEPARATE SCRIPT. monday cannot change a webhook's target URL, and register-crm-webhooks.mjs
 * matches existing hooks BY EVENT NAME ONLY — monday's `webhooks` query never exposes targetUrl — so it
 * would see all six events already present on each board and register nothing. Moving to a new URL is
 * therefore delete-then-create, which is destructive enough to deserve its own script and its own
 * --apply.
 *
 * ORDER MATTERS AND IS DELIBERATE: for each board we CREATE the new hook first, then delete the old
 * one. A create failure leaves the old hook working; the reverse order would leave the board deaf if
 * the create failed. A brief window of DOUBLE delivery is the accepted cost, and it is harmless —
 * every handler is idempotent (coalesce + the card registry + value-diff no-ops).
 *
 * SCOPED TO THE TWO CRM BOARDS. The live Work-Management boards (5029639630, 5029639440, 5029480547,
 * 5028000494, 5029480548) are never touched: their hooks stay on the bare path, and mondayAuth fails
 * OPEN when MONDAY_WEBHOOK_KEY is unset, which is the case on that Worker.
 *
 *   MONDAY_API_TOKEN=… MONDAY_WEBHOOK_KEY=… node scripts/repoint-crm-webhooks.mjs --plan
 *   MONDAY_API_TOKEN=… MONDAY_WEBHOOK_KEY=… node scripts/repoint-crm-webhooks.mjs --apply
 */
const API = "https://api.monday.com/v2";
const BASE = "https://hubspot-monday-crm-sync.askada.workers.dev/webhooks/monday";

export const CRM_BOARDS = { "5028000495": "Contacts", "5028000496": "Accounts" };
/** Must stay in step with CRM_WEBHOOK_EVENTS in register-crm-webhooks.mjs. */
export const EVENTS = ["create_item", "change_column_value", "change_name",
  "item_deleted", "item_archived", "create_update"];

/** The five live Work-Management boards. Present so a typo cannot aim this at production. */
export const WM_BOARDS = ["5029639630", "5029639440", "5029480547", "5028000494", "5029480548"];

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`monday: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.MONDAY_API_TOKEN;
  const key = (process.env.MONDAY_WEBHOOK_KEY ?? "").trim();
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }
  if (!/^[0-9a-f]{64}$/.test(key)) { console.error("MONDAY_WEBHOOK_KEY must be 64 hex chars"); process.exit(1); }
  const url = `${BASE}/${key}`;

  for (const [board, name] of Object.entries(CRM_BOARDS)) {
    if (WM_BOARDS.includes(board)) { console.error(`REFUSING: ${board} is a Work-Management board`); process.exit(1); }
    const existing = (await gql(token, "query ($b: ID!) { webhooks(board_id: $b) { id event } }", { b: board })).webhooks ?? [];
    console.log(`\n=== ${name} (${board}) — ${existing.length} existing hook(s) ===`);

    if (!apply) {
      for (const e of EVENTS) {
        const old = existing.filter(w => w.event === e);
        console.log(`  WOULD create ${e.padEnd(21)} -> .../webhooks/monday/<key>`
          + (old.length ? `  then delete ${old.length} old hook(s) ${old.map(o => o.id).join(",")}` : "  (none to delete)"));
      }
      continue;
    }

    for (const e of EVENTS) {
      // CREATE FIRST. monday re-issues its challenge to the new URL, so this also proves the Worker
      // authenticates the new path — a wrong key makes the create fail here rather than silently
      // producing a hook that 401s on every future event.
      const created = (await gql(token,
        "mutation ($b: ID!, $u: String!, $e: WebhookEventType!) "
        + "{ create_webhook(board_id: $b, url: $u, event: $e) { id event } }",
        { b: board, u: url, e })).create_webhook;
      console.log(`  created ${e.padEnd(21)} id=${created.id}`);

      for (const old of existing.filter(w => w.event === e)) {
        await gql(token, "mutation ($i: ID!) { delete_webhook(id: $i) { id } }", { i: old.id });
        console.log(`  deleted ${e.padEnd(21)} id=${old.id} (was on the unauthenticated bare path)`);
      }
    }
  }
  if (!apply) console.log("\n--plan only. Nothing changed. Re-run with --apply.");
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("repoint-crm-webhooks.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
