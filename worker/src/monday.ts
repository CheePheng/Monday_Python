import type { Env, MondayItem, RunOpts } from "./types";

const URL_ = "https://api.monday.com/v2";

async function gql(env: Env, query: string, variables: Record<string, unknown> = {}, retries = 3): Promise<any> {
  let rateWaits = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(URL_, {
        method: "POST",
        headers: { Authorization: env.MONDAY_API_TOKEN, "Content-Type": "application/json",
                   "API-Version": "2024-10" },
        body: JSON.stringify({ query, variables }),
      });
      const data: any = await resp.json().catch(() => ({}));
      const errText = JSON.stringify(data.errors ?? data.error_message ?? "");
      // Rate limit / complexity budget: the request did NOT apply, so it's always safe to wait and
      // retry — even for mutations. monday resets the complexity budget each minute.
      if ((resp.status === 429 || /complexity|rate.?limit|budget|too many|throttl/i.test(errText))
          && rateWaits < 6) {
        rateWaits++;
        const m = /reset in (\d+)/i.exec(errText);
        const waitS = Math.min(m ? Number(m[1]) + 1 : 15, 65);
        await new Promise(res => setTimeout(res, waitS * 1000));
        continue;
      }
      // monday returns some failures (maintenance, auth, bad query) as {error_message,...} with a
      // non-2xx status and NO `errors` key — treat those as failures, not phantom success.
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
             cursor items { id name created_at updated_at group { id } column_values { id text ... on PeopleValue { persons_and_teams { id kind } } } } } }`,
          { c: cursor })).next_items_page
      : (await gql(env,
          `query ($b:[ID!]) { boards(ids:$b) { items_page(limit:500) {
             cursor items { id name created_at updated_at group { id } column_values { id text ... on PeopleValue { persons_and_teams { id kind } } } } } } }`,
          { b: [boardId] })).boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

const ITEM_FIELDS = "id name created_at updated_at group { id } column_values { id text ... on PeopleValue { persons_and_teams { id kind } } }";

/** Fetch one item by id (webhook fast path). Null if it no longer exists. */
export async function getItem(env: Env, itemId: string): Promise<MondayItem | null> {
  const items: any[] = (await gql(env, `query ($i:[ID!]) { items(ids:$i) { ${ITEM_FIELDS} } }`,
    { i: [itemId] })).items;
  return items[0] ?? null;
}

/** Subitems under a parent item (id, name, columns incl. the HubSpot Line Item ID column). */
export async function getSubitems(env: Env, parentItemId: string): Promise<MondayItem[]> {
  const data = await gql(env, `query ($i:[ID!]) { items(ids:$i) { subitems { ${ITEM_FIELDS} } } }`, { i: [parentItemId] });
  return data.items?.[0]?.subitems ?? [];
}

/** Create a subitem under a parent. Returns the new subitem id (null in dry-run). retries=1 (a create). */
export async function createSubitem(env: Env, parentItemId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun) { console.log(`DRY create subitem '${name}' under ${parentItemId}`); return null; }
  const data = await gql(env,
    `mutation ($p:ID!, $n:String!, $c:JSON) {
       create_subitem(parent_item_id:$p, item_name:$n, column_values:$c, create_labels_if_missing:true) { id } }`,
    { p: parentItemId, n: name, c: JSON.stringify(cv) }, 1);
  const sid = data.create_subitem?.id ?? null;
  console.log(`created subitem ${sid} under ${parentItemId}`);
  return sid;
}

/** Find items on a board whose column equals a value (used to locate a card by HubSpot Deal ID
 * without reading the whole board). */
export async function findItemByColumn(env: Env, boardId: string, columnId: string, value: string):
    Promise<MondayItem[]> {
  const data = await gql(env,
    `query ($b:ID!, $c:String!, $v:[String!]!) {
       items_page_by_column_values(limit:10, board_id:$b,
         columns:[{ column_id:$c, column_values:$v }]) { items { ${ITEM_FIELDS} } } }`,
    { b: boardId, c: columnId, v: [value] });
  return data.items_page_by_column_values?.items ?? [];
}

/** Map of HubSpot id -> monday card id on a board, for the given HubSpot ids (via the board's id column).
 * Used to turn associated HubSpot ids into the monday cards to link, and to spot which are missing. */
export async function findItemIdsByColumn(env: Env, boardId: string, columnId: string, values: string[]):
    Promise<Record<string, string>> {
  if (!values.length) return {};
  const data = await gql(env,
    `query ($b:ID!, $c:String!, $cl:[String!]!, $v:[String!]!) {
       items_page_by_column_values(limit:100, board_id:$b,
         columns:[{ column_id:$c, column_values:$v }]) {
           items { id column_values(ids:$cl) { text } } } }`,
    { b: boardId, c: columnId, cl: [columnId], v: values });
  const out: Record<string, string> = {};
  for (const it of data.items_page_by_column_values?.items ?? []) {
    const t = (it.column_values?.[0]?.text ?? "").trim();
    if (t) out[t] = String(it.id);
  }
  return out;
}

/** Text of one column across several items -> { itemId: text }. Used to resolve linked cards to their
 * HubSpot id (for reversing a Connect-Boards link into a HubSpot association). */
export async function getItemsColumnText(env: Env, itemIds: string[], columnId: string):
    Promise<Record<string, string>> {
  if (!itemIds.length) return {};
  const data = await gql(env,
    `query ($i:[ID!], $c:[String!]) { items(ids:$i) { id column_values(ids:$c) { text } } }`,
    { i: itemIds, c: [columnId] });
  const out: Record<string, string> = {};
  for (const it of data.items ?? []) out[String(it.id)] = (it.column_values?.[0]?.text ?? "").trim();
  return out;
}

/** The item ids currently linked in a board_relation ("Connect Boards") column on one item. */
export async function getLinkedItemIds(env: Env, itemId: string, relationCol: string): Promise<string[]> {
  const data = await gql(env,
    `query ($i:[ID!], $c:[String!]) {
       items(ids:$i) { column_values(ids:$c) { ... on BoardRelationValue { linked_item_ids } } } }`,
    { i: [itemId], c: [relationCol] });
  const cv = data.items?.[0]?.column_values?.[0];
  return (cv?.linked_item_ids ?? []).map((x: any) => String(x));
}

// Mirrors a HubSpot deletion by hard-deleting the linked card. monday keeps deleted items in the board
// recycle bin for ~30 days, so this is recoverable. Requires the API token's user to have item-delete
// permission on the board (an admin/service account).
export async function deleteItem(env: Env, itemId: string, opts: RunOpts): Promise<void> {
  if (opts.dryRun) { console.log(`DRY delete item ${itemId}`); return; }
  await gql(env, `mutation ($i:ID!) { delete_item(item_id:$i) { id } }`, { i: itemId }, 1);
  console.log(`deleted item ${itemId}`);
}

export async function getUsersByEmail(env: Env): Promise<Record<string, string>> {
  const users: any[] = (await gql(env, "query { users(limit:500) { id email } }")).users;
  const out: Record<string, string> = {};
  for (const u of users) if (u.email) out[u.email.toLowerCase()] = String(u.id);
  return out;
}

// --- writes: mutations use retries=1 so an ambiguous network failure can't double-apply ---

export async function createItem(env: Env, boardId: string, groupId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<string | null> {
  if (opts.dryRun) { console.log(`DRY create '${name}' on ${boardId}/${groupId}`); return null; }
  const data = await gql(env,
    `mutation ($b:ID!, $g:String!, $n:String!, $c:JSON) {
       create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c,
                   create_labels_if_missing:true) { id } }`,
    { b: boardId, g: groupId, n: name, c: JSON.stringify(cv) }, 1);
  console.log(`created '${name}' on ${boardId}/${groupId}`);
  return data.create_item?.id ?? null;
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
