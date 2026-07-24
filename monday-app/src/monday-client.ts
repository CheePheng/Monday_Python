import mondaySdk from "monday-sdk-js";
import {
  DEALS_BOARD, SUBITEMS_BOARD,
} from "./board-config";
import { apiErrorDetail, apiErrorMessage } from "./lib/api-error";

const monday = mondaySdk();
// Pin an API version monday actually still serves. "2024-10" was removed (its live list now starts at
// 2025-04), and an unknown version silently falls back to an unspecified one — bump this deliberately.
monday.setApiVersion("2026-07");

async function api<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
  let res: any;
  try {
    res = await monday.api(query, { variables });
  } catch (e) {
    // Seamless auth rejects with the host's summary only; the real GraphQL errors sit on e.data.
    throw new Error(apiErrorMessage(e));
  }
  if (res.errors) throw new Error(apiErrorDetail(res) || JSON.stringify(res.errors));
  return res.data as T;
}

/** Open an external URL in a new tab from inside the monday board-view iframe (reliable vs. target=_blank). */
export function openLink(url: string): void { void monday.execute("openLinkInTab", { url }); }

/** Open a monday item card (e.g. a just-created contact/company) from inside the board view. */
export function openItemCard(itemId: string): void { void monday.execute("openItemCard", { itemId }); }

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
  id: string; name: string; group: { id: string }; created_at?: string;
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
          items { id name created_at group { id }
            column_values { id text value ... on BoardRelationValue { linked_item_ids } } }
        } } }`, { b: [DEALS_BOARD], cursor });
    const page = d.boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

/** Fetch a single deal item (fast edit-open, avoids re-fetching every deal). */
export async function getDeal(itemId: string): Promise<RawItem | null> {
  // created_at MUST be selected: patchRow() rebuilds the row from this after a save, and without it the
  // Created column would blank out on the edited row (getDeals, used by the initial load, has it too).
  const d: any = await api(`query ($i:[ID!]) { items(ids:$i) {
    id name created_at group { id } column_values { id text value ... on BoardRelationValue { linked_item_ids } } } }`, { i: [itemId] });
  return d.items?.[0] ?? null;
}

// monday's `items(ids:)` returns only the FIRST 25 rows unless an explicit `limit` is passed. It is a
// silent truncation — no error, no partial-result flag — so any ids query that can exceed 25 must pass a
// limit >= its chunk size. This once left 444 of 608 linked deals showing "—" in the board's Company /
// Contact columns while the drawer (which asks for one deal's 1-3 ids) looked fine.
const ID_CHUNK = 100;

/** Resolve monday item ids -> { id: name } (batched) for showing linked company/contact names. */
export async function getItemNames(itemIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    const d: any = await api(`query ($ids:[ID!]) { items(ids:$ids, limit:${ID_CHUNK}) { id name } }`, { ids: chunk });
    for (const it of d.items ?? []) out[String(it.id)] = it.name;
  }
  return out;
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

// NOTE: the browser must NOT create cards on the Contact/Company boards. It cannot see the Worker's
// strongly-consistent card registry, so a client-side create raced the sync + association passes and
// produced duplicate rows for one HubSpot record. Card resolution now goes through the Worker —
// `ensureCard()` in worker-client.ts (POST /app/ensure-card). Do not reintroduce a create_item here.

/** Resolve linked monday item ids to { itemId, name, hubspotId } — used to hydrate association chips in
 * edit mode so existing links are shown (and removable). `idCol` is the board's HubSpot-id column. */
export async function getCardsByIds(itemIds: string[], idCol: string):
    Promise<{ itemId: string; name: string; hubspotId: string }[]> {
  if (!itemIds.length) return [];
  const out: { itemId: string; name: string; hubspotId: string }[] = [];
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {   // same 25-row cap as getItemNames
    const d: any = await api(`query ($ids:[ID!], $cols:[String!]) {
      items(ids:$ids, limit:${ID_CHUNK}) { id name column_values(ids:$cols) { id text } } }`,
      { ids: itemIds.slice(i, i + ID_CHUNK), cols: [idCol] });
    for (const it of d.items ?? [])
      out.push({ itemId: String(it.id), name: it.name, hubspotId: it.column_values?.[0]?.text ?? "" });
  }
  return out;
}
