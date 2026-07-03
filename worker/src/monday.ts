import type { Env, MondayItem, RunOpts } from "./types";

const URL_ = "https://api.monday.com/v2";

async function gql(env: Env, query: string, variables: Record<string, unknown> = {}, retries = 3): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(URL_, {
        method: "POST",
        headers: { Authorization: env.MONDAY_API_TOKEN, "Content-Type": "application/json",
                   "API-Version": "2024-10" },
        body: JSON.stringify({ query, variables }),
      });
      const data: any = await resp.json().catch(() => ({}));
      // monday returns some failures (rate limit, maintenance, auth) as {error_message,...} with a
      // non-2xx status and NO `errors` key — treat those as failures instead of phantom success.
      if (!resp.ok || data.error_message || data.errors) {
        throw new Error(`monday ${resp.status}: ${data.error_message ?? JSON.stringify(data.errors ?? data).slice(0, 400)}`);
      }
      return data.data;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise(res => setTimeout(res, 1500 * attempt));
    }
  }
}

export async function getBoardItems(env: Env, boardId: string): Promise<MondayItem[]> {
  const items: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    const page: any = cursor
      ? (await gql(env,
          `query ($c:String!) { next_items_page(cursor:$c, limit:500) {
             cursor items { id name created_at updated_at group { id } column_values { id text } } } }`,
          { c: cursor })).next_items_page
      : (await gql(env,
          `query ($b:[ID!]) { boards(ids:$b) { items_page(limit:500) {
             cursor items { id name created_at updated_at group { id } column_values { id text } } } } }`,
          { b: [boardId] })).boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export async function getUsersByEmail(env: Env): Promise<Record<string, string>> {
  const users: any[] = (await gql(env, "query { users(limit:500) { id email } }")).users;
  const out: Record<string, string> = {};
  for (const u of users) if (u.email) out[u.email.toLowerCase()] = String(u.id);
  return out;
}

// --- writes: mutations use retries=1 so an ambiguous network failure can't double-apply ---

export async function createItem(env: Env, boardId: string, groupId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<void> {
  if (opts.dryRun) { console.log(`DRY create '${name}' on ${boardId}/${groupId}`); return; }
  await gql(env,
    `mutation ($b:ID!, $g:String!, $n:String!, $c:JSON) {
       create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c,
                   create_labels_if_missing:true) { id } }`,
    { b: boardId, g: groupId, n: name, c: JSON.stringify(cv) }, 1);
  console.log(`created '${name}' on ${boardId}/${groupId}`);
}

export async function updateItem(env: Env, boardId: string, itemId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<void> {
  const withName = { ...cv, name };
  if (opts.dryRun) { console.log(`DRY update item ${itemId} on ${boardId}`); return; }
  await gql(env,
    `mutation ($b:ID!, $i:ID!, $c:JSON!) {
       change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c,
                                     create_labels_if_missing:true) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify(withName) }, 1);
  console.log(`updated item ${itemId} on ${boardId}`);
}

/** Set specific columns on an item (no name change) — used for ID / Sync-State write-back.
 * This write is IDEMPOTENT (same values every retry), so it retries hard: a dropped write-back
 * after a HubSpot create is what would otherwise re-create the record next tick. */
export async function setColumns(env: Env, boardId: string, itemId: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<void> {
  if (opts.dryRun) { console.log(`DRY setColumns item ${itemId}: ${JSON.stringify(cv)}`); return; }
  await gql(env,
    `mutation ($b:ID!, $i:ID!, $c:JSON!) {
       change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify(cv) }, 3);
}

export async function moveItem(env: Env, boardId: string, itemId: string, groupId: string,
    opts: RunOpts): Promise<void> {
  if (opts.dryRun) { console.log(`DRY move item ${itemId} -> group ${groupId}`); return; }
  await gql(env, `mutation ($i:ID!, $g:String!) { move_item_to_group(item_id:$i, group_id:$g) { id } }`,
    { i: itemId, g: groupId }, 1);
  console.log(`moved item ${itemId} -> group ${groupId}`);
}
