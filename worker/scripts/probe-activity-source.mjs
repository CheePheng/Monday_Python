/**
 * Can monday be the place reps log activity, and can that reach HubSpot?
 *
 * The team wants sales users to work ONLY in monday from now on, writing follow-ups into the board's
 * "Activities timeline" column, and have those reach HubSpot. This probe establishes what is actually
 * readable, because the answer decides the whole design:
 *
 *   1. "Activities timeline" (custom_mkrm9y8c) reports monday type `unsupported`. Ask for its
 *      value/text anyway and record exactly what comes back — null, empty, or an error. An app-backed
 *      column's data lives in the app's own storage, not in the item, so it is very likely unreadable.
 *   2. Item UPDATES (monday's per-item conversation thread) ARE first-class API objects. If those are
 *      readable they are the natural place for a rep to log a call, and they map cleanly onto a HubSpot
 *      Note engagement — which worker/src/hubspot.ts already knows how to create (createNote).
 *   3. The long_text "Comments" column (long_text4) is trivially readable and is the third option.
 *
 * Read-only: issues nothing but queries.
 *
 *   MONDAY_API_TOKEN=<token> node scripts/probe-activity-source.mjs
 */
const API = "https://api.monday.com/v2";
const CONTACTS = "5028000495";
const TIMELINE_COL = "custom_mkrm9y8c";   // "Activities timeline", type `unsupported`
const COMMENTS_COL = "long_text4";        // "Comments", type long_text

async function gql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2026-07" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  return { data: body.data, errors: body.errors };
}

async function main() {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) { console.error("MONDAY_API_TOKEN is required"); process.exit(1); }

  // 1. The unsupported column, asked for directly.
  console.log("=== 1. Reading the 'Activities timeline' column (type: unsupported) ===");
  const q1 = await gql(token,
    "query ($b: [ID!], $c: [String!]) { boards(ids: $b) { items_page(limit: 5) { items { id name "
    + "column_values(ids: $c) { id type text value } } } } }",
    { b: [CONTACTS], c: [TIMELINE_COL, COMMENTS_COL] });
  if (q1.errors) console.log("  GraphQL errors:", JSON.stringify(q1.errors).slice(0, 400));
  for (const it of q1.data?.boards?.[0]?.items_page?.items ?? []) {
    console.log(`  ${it.name}`);
    for (const c of it.column_values) {
      console.log(`    ${c.id.padEnd(20)} type=${String(c.type).padEnd(12)} text=${JSON.stringify(c.text)} value=${JSON.stringify(c.value)}`);
    }
  }

  // 2. Item updates — the real activity feed.
  console.log("\n=== 2. Reading item UPDATES (the per-item conversation thread) ===");
  const q2 = await gql(token,
    "query ($b: [ID!]) { boards(ids: $b) { items_page(limit: 10) { items { id name "
    + "updates(limit: 5) { id text_body created_at creator_id creator { id name email } } } } } }",
    { b: [CONTACTS] });
  if (q2.errors) console.log("  GraphQL errors:", JSON.stringify(q2.errors).slice(0, 400));
  let withUpdates = 0, total = 0;
  for (const it of q2.data?.boards?.[0]?.items_page?.items ?? []) {
    total++;
    const ups = it.updates ?? [];
    if (ups.length) withUpdates++;
    console.log(`  ${String(it.name).slice(0, 40).padEnd(42)} updates returned=${ups.length}`);
    for (const u of ups.slice(0, 2)) {
      console.log(`      [${u.created_at}] ${u.creator?.name ?? u.creator_id} <${u.creator?.email ?? "?"}>: `
        + `${JSON.stringify(String(u.text_body ?? u.body ?? "").slice(0, 90))}`
        + (u.replies?.length ? `  (+${u.replies.length} replies)` : ""));
    }
  }
  console.log(`  -> ${withUpdates}/${total} cards carry at least one update`);

  // 3. Which webhook events exist for updates? Ask the registrar's own event vocabulary by trying one.
  console.log("\n=== 3. Registered webhooks on the Contacts board ===");
  const q3 = await gql(token, "query ($b: ID!) { webhooks(board_id: $b) { id event board_id config } }",
    { b: CONTACTS });
  if (q3.errors) console.log("  GraphQL errors:", JSON.stringify(q3.errors).slice(0, 400));
  for (const w of q3.data?.webhooks ?? []) console.log(`  ${String(w.event).padEnd(24)} id=${w.id}`);

  console.log("\n=== 4. Is `create_update` a legal webhook event value? (introspection, no mutation) ===");
  const q4 = await gql(token,
    'query { __type(name: "WebhookEventType") { enumValues { name } } }');
  if (q4.errors) console.log("  GraphQL errors:", JSON.stringify(q4.errors).slice(0, 400));
  const vals = (q4.data?.__type?.enumValues ?? []).map(v => v.name);
  console.log(`  ${vals.length} event types: ${vals.join(", ")}`);
  for (const want of ["create_update", "edit_update", "delete_update", "item_deleted", "create_item", "change_column_value"])
    console.log(`    ${want.padEnd(22)} ${vals.includes(want) ? "AVAILABLE" : "not available"}`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("probe-activity-source.mjs");
if (invokedDirectly) main().catch(e => { console.error(String(e)); process.exit(1); });
