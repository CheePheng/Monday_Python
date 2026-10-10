import type { Env, MondayItem, RunOpts } from "./types";
import { fitItemName, itemNameFitOn } from "./mapping";

const URL_ = "https://api.monday.com/v2";

/**
 * THE NAME AN ITEM WRITE SENDS. Every create, subitem create and rename the Worker makes goes through
 * createItem, createSubitem or updateItem below (ensure-card.ts's card birth; sync.ts's forward writes,
 * heals and create-window settles; associations.ts's line-item subitems), so this is the one place a name is
 * fitted to monday's limit. ITEM_NAME_FIT only (itemNameFitOn): fitItemName, with one log line when it had to
 * cut. Off, the name goes out exactly as given, as it always has.
 */
function sendableName(env: Env, name: string, where: string): string {
  if (!itemNameFitOn(env)) return name;
  const fitted = fitItemName(name);
  if (fitted !== name) console.log(`[name] action=fitted from=${name.length} to=${fitted.length} ${where}`);
  return fitted;
}

/**
 * monday refused the request for rate limit / complexity budget on EVERY try. Such a request provably
 * never executed, so a caller holding a create-once reservation may RELEASE it and retry -- unlike any
 * other failure after a mutation was sent, which may have landed. Thrown only from the rate-limit branch.
 */
export class MondayRateLimitedError extends Error {
  constructor(msg: string) { super(msg); this.name = "MondayRateLimitedError"; }
}

/**
 * `maxRateWaits`: how many rate-limit waits (up to 65 s each) to sit through before giving up with
 * MondayRateLimitedError. The default suits a webhook or a sweep; a caller racing its own wall-clock
 * deadline (the marketing poller, inside a 15-minute cron) passes fewer, because six full waits alone
 * are six and a half minutes.
 */
export async function gql(env: Env, query: string, variables: Record<string, unknown> = {}, retries = 3,
    maxRateWaits = 6): Promise<any> {
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
      // A reply that carries a result EXECUTED, whatever its errors say: never re-send it, and never call
      // it rate-limited (a caller would read that as "provably did not run").
      const returned = !!data?.data && Object.values(data.data).some(v => v !== null && v !== undefined);
      const limited = !returned
        && (resp.status === 429 || /complexity|rate.?limit|budget|too many|throttl/i.test(errText));
      if (limited && rateWaits < maxRateWaits) {
        rateWaits++;
        // monday says "reset in N seconds" in older replies and `retry_in_seconds` in newer ones.
        const m = /reset in (\d+)/i.exec(errText) ?? /retry_in_seconds"?\s*:\s*(\d+)/i.exec(errText);
        const waitS = Math.min(m ? Number(m[1]) + 1 : 15, 65);
        await new Promise(res => setTimeout(res, waitS * 1000));
        continue;
      }
      if (limited)
        throw new MondayRateLimitedError(`monday ${resp.status}: rate-limited after ${rateWaits} waits: ${errText.slice(0, 200)}`);
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
             cursor items { id name created_at updated_at group { id } column_values { id text ... on PeopleValue { persons_and_teams { id kind } } ... on StatusValue { status_index: index } } } } }`,
          { c: cursor })).next_items_page
      : (await gql(env,
          `query ($b:[ID!]) { boards(ids:$b) { items_page(limit:500) {
             cursor items { id name created_at updated_at group { id } column_values { id text ... on PeopleValue { persons_and_teams { id kind } } ... on StatusValue { status_index: index } } } } } }`,
          { b: [boardId] })).boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

const ITEM_FIELDS = "id name created_at updated_at group { id } column_values { id text ... on PeopleValue { persons_and_teams { id kind } } ... on StatusValue { status_index: index } }";

/** Fetch one item by id (webhook fast path). Null if it no longer exists. */
export async function getItem(env: Env, itemId: string): Promise<MondayItem | null> {
  const items: any[] = (await gql(env, `query ($i:[ID!]) { items(ids:$i) { ${ITEM_FIELDS} } }`,
    { i: [itemId] })).items;
  return items[0] ?? null;
}

/**
 * ONE CARD, FRESH, WITH WHEN EACH OF `cols` LAST CHANGED (STALE_FORWARD_GATE): the ordinary item read plus, for those
 * columns only, the value JSON -- `values` (raw, for the activity-log fingerprint) and its `changed_at` -- `stamps`,
 * ms, null when the value carries none (a text or numbers column does not; an API write to a status column gets one
 * too). One query. Read only by a gated forward pass when a two-way cell differs, and by the card watch's converge.
 * `maxRateWaits` as for gql (a monday-born record's create fill passes 0: it never holds up its creator).
 */
export async function getItemFresh(env: Env, itemId: string, cols: string[], maxRateWaits?: number):
    Promise<{ item: MondayItem; stamps: Record<string, number | null>; values: Record<string, string | null> } | null> {
  const withStamps = cols.length > 0;
  const data = await gql(env, withStamps
    ? `query ($i:[ID!], $c:[String!]) { items(ids:$i) { ${ITEM_FIELDS} stamps: column_values(ids:$c) { id value } } }`
    : `query ($i:[ID!]) { items(ids:$i) { ${ITEM_FIELDS} } }`,
    withStamps ? { i: [itemId], c: cols } : { i: [itemId] }, 3, maxRateWaits);
  const raw: any = data.items?.[0];
  if (!raw) return null;
  const stamps: Record<string, number | null> = {};
  const values: Record<string, string | null> = {};
  for (const c of cols) { stamps[c] = null; values[c] = null; }
  for (const s of raw.stamps ?? []) {
    const id = String(s?.id ?? "");
    if (!id) continue;
    stamps[id] = changedAtOf(s.value);
    values[id] = s.value === null || s.value === undefined ? null : typeof s.value === "string" ? s.value : JSON.stringify(s.value);
  }
  const { stamps: _drop, ...item } = raw;
  return { item: item as MondayItem, stamps, values };
}

/** A column value JSON's changed_at in ms, or null (absent, unparseable, or a value that is not JSON). */
export function changedAtOf(value: unknown): number | null {
  let o: any = value;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { return null; } }
  const t = o && typeof o === "object" ? Date.parse(String(o.changed_at ?? "")) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** A relation (Connect Boards) cell: the linked item ids, and when the cell last changed (changed_at; null if none). */
export async function getLinkedCell(env: Env, itemId: string, relationCol: string):
    Promise<{ ids: string[]; changedAt: number | null }> {
  const data = await gql(env,
    `query ($i:[ID!], $c:[String!]) {
       items(ids:$i) { column_values(ids:$c) { value ... on BoardRelationValue { linked_item_ids } } } }`,
    { i: [itemId], c: [relationCol] });
  const cv = data.items?.[0]?.column_values?.[0];
  return { ids: (cv?.linked_item_ids ?? []).map((x: any) => String(x)), changedAt: changedAtOf(cv?.value) };
}

/** Subitems under a parent item (id, name, columns incl. the HubSpot Line Item ID column). */
export async function getSubitems(env: Env, parentItemId: string): Promise<MondayItem[]> {
  const data = await gql(env, `query ($i:[ID!]) { items(ids:$i) { subitems { ${ITEM_FIELDS} } } }`, { i: [parentItemId] });
  return data.items?.[0]?.subitems ?? [];
}

/** The parent item id of a subitem (a line-item subitem's parent is the deal card). Null if none/deleted. */
export async function getParentItemId(env: Env, subitemId: string): Promise<string | null> {
  const data = await gql(env, `query ($i:[ID!]) { items(ids:$i) { parent_item { id } } }`, { i: [subitemId] });
  const pid = data.items?.[0]?.parent_item?.id;
  return pid ? String(pid) : null;
}

/** Create a subitem under a parent. Returns the new subitem id (null in dry-run). retries=1 (a create). */
export async function createSubitem(env: Env, parentItemId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<string | null> {
  const n = sendableName(env, name, `op=create-subitem parent=${parentItemId}`);
  if (opts.dryRun) { console.log(`DRY create subitem '${n}' under ${parentItemId}`); return null; }
  const data = await gql(env,
    `mutation ($p:ID!, $n:String!, $c:JSON) {
       create_subitem(parent_item_id:$p, item_name:$n, column_values:$c, create_labels_if_missing:true) { id } }`,
    { p: parentItemId, n, c: JSON.stringify(cv) }, 1);
  const sid = data.create_subitem?.id ?? null;
  console.log(`created subitem ${sid} under ${parentItemId}`);
  return sid;
}

/** Find items on a board whose column equals a value (used to locate a card by HubSpot Deal ID
 * without reading the whole board). */
export async function findItemByColumn(env: Env, boardId: string, columnId: string, value: string,
    maxRateWaits = 6): Promise<MondayItem[]> {
  const data = await gql(env,
    `query ($b:ID!, $c:String!, $v:[String!]!) {
       items_page_by_column_values(limit:10, board_id:$b,
         columns:[{ column_id:$c, column_values:$v }]) { items { ${ITEM_FIELDS} } } }`,
    { b: boardId, c: columnId, v: [value] }, 3, maxRateWaits);
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
 * HubSpot id (for reversing a Connect-Boards link into a HubSpot association).
 *
 * NOTE: `items(ids:)` silently returns only the first 25 rows unless `limit` is passed — no error, no
 * flag. Unbounded here (a record can link any number of cards), so it must chunk AND set the limit;
 * without it, links past the 25th would never be reversed into HubSpot associations. */
export async function getItemsColumnText(env: Env, itemIds: string[], columnId: string):
    Promise<Record<string, string>> {
  if (!itemIds.length) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < itemIds.length; i += 100) {
    const data = await gql(env,
      `query ($i:[ID!], $c:[String!]) { items(ids:$i, limit:100) { id column_values(ids:$c) { text } } }`,
      { i: itemIds.slice(i, i + 100), c: [columnId] });
    for (const it of data.items ?? []) out[String(it.id)] = (it.column_values?.[0]?.text ?? "").trim();
  }
  return out;
}

/**
 * Each item's lifecycle state -- "active", "archived", "deleted" -- keyed by item id.
 *
 * Exists for ONE decision: whether a card that left a relation cell was UNLINKED by a person or simply
 * stopped existing. board_relation columns are paired, so deleting or archiving a card removes it from
 * every cell it was linked in, and monday reports each of those as an ordinary relation change. Only an
 * active card's removal is an unlink. `items(ids:)` returns non-active items too unless asked for
 * `exclude_nonactive`, which is what makes `state` readable here.
 *
 * An id that does not come back is simply absent from the map. Callers must read absent as NOT active:
 * the cost of that is a missed unlink, the cost of the opposite is a deleted HubSpot association.
 * Chunked with an explicit limit for the same silent-25 reason as getItemsColumnText.
 */
export async function getItemStates(env: Env, itemIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < itemIds.length; i += 100) {
    const data = await gql(env, `query ($i:[ID!]) { items(ids:$i, limit:100) { id state } }`,
      { i: itemIds.slice(i, i + 100) });
    for (const it of data.items ?? []) if (it?.state) out[String(it.id)] = String(it.state);
  }
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

/** One monday user's name + email (to attribute a monday Update -> HubSpot note). Null if not found. */
export async function getUserById(env: Env, userId: string): Promise<{ name: string; email: string } | null> {
  const users: any[] = (await gql(env, "query ($u:[ID!]) { users(ids:$u) { name email } }", { u: [userId] })).users;
  const u = users?.[0];
  return u ? { name: u.name ?? "", email: u.email ?? "" } : null;
}

/** The monday user this API token acts as. Lets a log distinguish OUR writes from a person's, because
 * every write we make is attributed to this user in monday's activity log. */
export async function whoAmI(env: Env): Promise<string | null> {
  const d: any = await gql(env, "query { me { id } }");
  const id = d?.me?.id;
  return id ? String(id) : null;
}

/** Every monday user, by lowercased email. `maxRateWaits` as for gql: a caller inside a short lock (the owner
 *  notice, when it has no cached user list) allows one rate-limit wait, not six. */
export async function getUsersByEmail(env: Env, maxRateWaits = 6): Promise<Record<string, string>> {
  const users: any[] = (await gql(env, "query { users(limit:500) { id email } }", {}, 3, maxRateWaits)).users;
  const out: Record<string, string> = {};
  for (const u of users) if (u.email) out[u.email.toLowerCase()] = String(u.id);
  return out;
}

// --- writes: mutations use retries=1 so an ambiguous network failure can't double-apply ---

export async function createItem(env: Env, boardId: string, groupId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<string | null> {
  const n = sendableName(env, name, `op=create board=${boardId} group=${groupId}`);
  if (opts.dryRun) { console.log(`DRY create '${n}' on ${boardId}/${groupId}`); return null; }
  const data = await gql(env,
    `mutation ($b:ID!, $g:String!, $n:String!, $c:JSON) {
       create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c,
                   create_labels_if_missing:true) { id } }`,
    { b: boardId, g: groupId, n, c: JSON.stringify(cv) }, 1);
  console.log(`created '${n}' on ${boardId}/${groupId}`);
  return data.create_item?.id ?? null;
}

/** Writes `cv` AND the item name, always (a forward write renames as it goes): see sendableName.
 *  `maxRateWaits` as for gql (a gated forward write passes 0: never a stale write sent a minute late). */
export async function updateItem(env: Env, boardId: string, itemId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts, maxRateWaits?: number): Promise<void> {
  const withName = { ...cv, name: sendableName(env, name, `op=update board=${boardId} item=${itemId}`) };
  if (opts.dryRun) { console.log(`DRY update item ${itemId} on ${boardId}`); return; }
  await gql(env,
    `mutation ($b:ID!, $i:ID!, $c:JSON!) {
       change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c,
                                     create_labels_if_missing:true) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify(withName) }, 1, maxRateWaits);
  console.log(`updated item ${itemId} on ${boardId}`);
}

/**
 * Write `cv` WITHOUT the item name, and with create_labels_if_missing like updateItem (STALE_FORWARD_GATE's forward
 * writes: a name is sent only when the name itself is forwarded, so a rename still on its way is never written over,
 * and a new HubSpot label is still created as updateItem creates it). retries=1, like updateItem.
 */
export async function updateColumns(env: Env, boardId: string, itemId: string,
    cv: Record<string, unknown>, opts: RunOpts, maxRateWaits?: number): Promise<void> {
  if (opts.dryRun) { console.log(`DRY update columns item ${itemId} on ${boardId}`); return; }
  await gql(env,
    `mutation ($b:ID!, $i:ID!, $c:JSON!) {
       change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c,
                                     create_labels_if_missing:true) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify(cv) }, 1, maxRateWaits);
  console.log(`updated item ${itemId} on ${boardId}`);
}

/** Set specific columns on an item (no name change) — used for ID / Sync-State write-back.
 * This write is IDEMPOTENT (same values every retry), so it retries hard: a dropped write-back
 * after a HubSpot create is what would otherwise re-create the record next tick. */
export async function setColumns(env: Env, boardId: string, itemId: string,
    cv: Record<string, unknown>, opts: RunOpts, maxRateWaits?: number): Promise<void> {
  if (opts.dryRun) { console.log(`DRY setColumns item ${itemId}: ${JSON.stringify(cv)}`); return; }
  await gql(env,
    `mutation ($b:ID!, $i:ID!, $c:JSON!) {
       change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify(cv) }, 3, maxRateWaits);
}

export async function moveItem(env: Env, boardId: string, itemId: string, groupId: string,
    opts: RunOpts, maxRateWaits?: number): Promise<void> {
  if (opts.dryRun) { console.log(`DRY move item ${itemId} -> group ${groupId}`); return; }
  await gql(env, `mutation ($i:ID!, $g:String!) { move_item_to_group(item_id:$i, group_id:$g) { id } }`,
    { i: itemId, g: groupId }, 1, maxRateWaits);
  console.log(`moved item ${itemId} -> group ${groupId}`);
}
