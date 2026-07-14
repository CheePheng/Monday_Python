import mondaySdk from "monday-sdk-js";
import {
  DEALS_BOARD, SUBITEMS_BOARD, CONTACT_BOARD, COMPANY_BOARD,
  CONTACT_ID_COL, COMPANY_ID_COL,
} from "./board-config";

const monday = mondaySdk();
monday.setApiVersion("2024-10");

async function api<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res: any = await monday.api(query, { variables });
  if (res.errors) throw new Error(JSON.stringify(res.errors));
  return res.data as T;
}

export interface Ctx { userId: string; sessionToken: string }
/** Read the board-view context (current user) + a fresh session token for Worker calls. */
export async function getContext(): Promise<Ctx> {
  const ctx: any = await monday.get("context");
  const tok: any = await monday.get("sessionToken");
  return { userId: String(ctx?.data?.user?.id ?? ""), sessionToken: String(tok?.data ?? "") };
}

export interface BoardMeta {
  columns: { id: string; type: string; title: string; settings_str?: string }[];
  groups: { id: string; title: string }[];
}
export async function getBoardMeta(): Promise<BoardMeta> {
  const d = await api(`query ($b:[ID!]) { boards(ids:$b) {
    columns { id type title settings_str } groups { id title } } }`, { b: [DEALS_BOARD] });
  const board = d.boards[0];
  return { columns: board.columns, groups: board.groups };
}

export interface AccountUser { id: string; name: string; email: string }
export async function getUsers(): Promise<AccountUser[]> {
  const d = await api(`query { users(kind: non_guests, limit: 500) { id name email } }`);
  return (d.users ?? []).map((u: any) => ({ id: String(u.id), name: u.name, email: u.email }));
}

// Raw item shape the app reads (deals + their column values, incl. linked ids for relation columns).
export interface RawItem {
  id: string; name: string; group: { id: string };
  column_values: { id: string; text: string | null; value: string | null; linked_item_ids?: string[] }[];
}
export async function getDeals(): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let cursor: string | null = null;
  do {
    const d: any = await api(
      `query ($b:[ID!], $cursor:String) { boards(ids:$b) {
        items_page(limit:200, cursor:$cursor) {
          cursor
          items { id name group { id }
            column_values { id text value ... on BoardRelationValue { linked_item_ids } } }
        } } }`, { b: [DEALS_BOARD], cursor });
    const page = d.boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export async function getSubitems(parentItemId: string): Promise<RawItem[]> {
  const d: any = await api(`query ($i:[ID!]) { items(ids:$i) {
    subitems { id name column_values { id text } } } }`, { i: [parentItemId] });
  return d.items[0]?.subitems ?? [];
}

export async function getUpdates(itemId: string): Promise<{ id: string; body: string; creator?: { name: string } }[]> {
  const d: any = await api(`query ($i:ID!) { items(ids:[$i]) {
    updates(limit:50) { id body creator { name } } } }`, { i: itemId });
  return d.items[0]?.updates ?? [];
}

// ---- writes (all honor monday's own permissions; the app never bypasses them) ----
export async function createDeal(groupId: string, name: string, columnValues: Record<string, unknown>): Promise<string> {
  const d: any = await api(`mutation ($b:ID!, $g:String!, $n:String!, $c:JSON!) {
    create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c) { id } }`,
    { b: DEALS_BOARD, g: groupId, n: name, c: JSON.stringify(columnValues) });
  return String(d.create_item.id);
}
export async function updateDealColumns(itemId: string, columnValues: Record<string, unknown>): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: DEALS_BOARD, i: itemId, c: JSON.stringify(columnValues) });
}
export async function renameDeal(itemId: string, name: string): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: DEALS_BOARD, i: itemId, c: JSON.stringify({ name }) });
}
export async function moveToGroup(itemId: string, groupId: string): Promise<void> {
  await api(`mutation ($i:ID!, $g:String!) { move_item_to_group(item_id:$i, group_id:$g) { id } }`,
    { i: itemId, g: groupId });
}
export async function createSubitem(parentItemId: string, name: string, columnValues: Record<string, unknown>): Promise<string> {
  const d: any = await api(`mutation ($p:ID!, $n:String!, $c:JSON!) {
    create_subitem(parent_item_id:$p, item_name:$n, column_values:$c) { id } }`,
    { p: parentItemId, n: name, c: JSON.stringify(columnValues) });
  return String(d.create_subitem.id);
}
export async function updateSubitemColumns(itemId: string, columnValues: Record<string, unknown>): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: SUBITEMS_BOARD, i: itemId, c: JSON.stringify(columnValues) });
}
export async function deleteItem(itemId: string): Promise<void> {
  await api(`mutation ($i:ID!) { delete_item(item_id:$i) { id } }`, { i: itemId });
}
export async function postUpdate(itemId: string, body: string): Promise<void> {
  await api(`mutation ($i:ID!, $b:String!) { create_update(item_id:$i, body:$b) { id } }`, { i: itemId, b: body });
}

/** Find a card by HubSpot id on a linked board, else create it (name only). Returns the monday item id.
 * Used for associations: the Worker fills the rest of the card on its next sync. */
async function findCardByHubspotId(boardId: string, idCol: string, hubspotId: string): Promise<string | null> {
  const d: any = await api(`query ($b:ID!, $col:String!, $val:String!) {
    items_page_by_column_values(board_id:$b, limit:1,
      columns: [{ column_id:$col, column_values:[$val] }]) { items { id } } }`,
    { b: boardId, col: idCol, val: hubspotId });
  const hit = d.items_page_by_column_values?.items?.[0];
  return hit ? String(hit.id) : null;
}
async function createOnBoard(boardId: string, idCol: string, hubspotId: string, name: string): Promise<string> {
  // Re-query right before create to shrink the two-users-same-record race; the Worker dedups the rest.
  const existing = await findCardByHubspotId(boardId, idCol, hubspotId);
  if (existing) return existing;
  const d: any = await api(`mutation ($b:ID!, $n:String!, $c:JSON!) {
    create_item(board_id:$b, item_name:$n, column_values:$c) { id } }`,
    { b: boardId, n: name, c: JSON.stringify({ [idCol]: hubspotId }) });
  return String(d.create_item.id);
}
export async function findOrCreateContact(hubspotId: string, name: string): Promise<string> {
  return (await findCardByHubspotId(CONTACT_BOARD, CONTACT_ID_COL, hubspotId))
    ?? await createOnBoard(CONTACT_BOARD, CONTACT_ID_COL, hubspotId, name);
}
export async function findOrCreateCompany(hubspotId: string, name: string): Promise<string> {
  return (await findCardByHubspotId(COMPANY_BOARD, COMPANY_ID_COL, hubspotId))
    ?? await createOnBoard(COMPANY_BOARD, COMPANY_ID_COL, hubspotId, name);
}

/** Resolve linked monday item ids to { itemId, name, hubspotId } — used to hydrate association chips in
 * edit mode so existing links are shown (and removable). `idCol` is the board's HubSpot-id column. */
export async function getCardsByIds(itemIds: string[], idCol: string):
    Promise<{ itemId: string; name: string; hubspotId: string }[]> {
  if (!itemIds.length) return [];
  const d: any = await api(`query ($ids:[ID!], $cols:[String!]) {
    items(ids:$ids) { id name column_values(ids:$cols) { id text } } }`, { ids: itemIds, cols: [idCol] });
  return (d.items ?? []).map((it: any) => ({
    itemId: String(it.id), name: it.name, hubspotId: it.column_values?.[0]?.text ?? "",
  }));
}
