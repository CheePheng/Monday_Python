# HubSpot deal associations + line items → linked on monday (instant) — Design

**Date:** 2026-07-10
**Status:** Approved (design + revision)

## Goal

When a HubSpot deal is created or changed with associated **Companies/Contacts** and **line items**,
reflect all of it on the monday deal card as real **Connect Boards (board_relation) links** to the
matching Company/Contact cards, plus **line-item subitems** — instantly, both at creation and on later
change. Extend the same real-link treatment to Company↔Contact and Contact↔Deal. HubSpot → monday only.

## Context

- Associations today are **text columns of names** (`syncNameColumn`). The user wants **real linked
  columns** so the boards connect and you can click through.
- The relation-sync machinery is **already built + unit-tested** (`syncRelationColumn` in
  `worker/src/associations.ts`, `findItemIdsByColumn` / `getLinkedItemIds` in `worker/src/monday.ts`,
  `SPEC_BY_OBJECT` in `worker/src/config.ts`, `AssocSpec.relationCol` in `worker/src/types.ts`). It is
  dormant until each association's `relationCol` id is set.
- Line-item subitems already sync (`syncLineItems`).
- The HubSpot webhook app (`hubspot-monday-webhook-sync`) currently subscribes only to
  `object.creation` / `object.propertyChange` / `object.deletion` for deal/contact/company.

## Confirmed decisions

1. **Instant for changes too** — subscribe to HubSpot association-change and line-item events so later
   add/remove/edit reflect within seconds (not just at deal creation).
2. **Replace text with links** — the Connect Boards link columns become the association; the old
   "Associated *" text columns are deleted after verification.
3. **Columns created via API** — monday API version **2025-10** supports creating `board_relation`
   columns via `create_column(..., column_type: board_relation, defaults: {"boardIds":[<target>]})`.
   The admin token can do this. The Worker keeps **API version 2024-10** for its own reads/writes
   (verified: writing `{item_ids:[…]}` and reading `linked_item_ids` both work in 2024-10). No manual
   monday UI step, no Worker-wide version upgrade.

## Architecture

### 1. Connect Boards columns (created once via a 2025-10 API script)

| Board | Column title | `boardIds` target |
|---|---|---|
| Deals `5029480547` | Associated Company | `5029639440` (Company) |
| Deals `5029480547` | Associated Contact | `5029639630` (Contact) |
| Contact `5029639630` | Associated Company | `5029639440` (Company) |
| Contact `5029639630` | Associated Deal | `5029480547` (Deals) |
| Company `5029639440` | Associated Contact | `5029639630` (Contact) |

Each `create_column` returns a `board_relation_*` id; those ids go into config. (Company→Deal is
optional/future; not in the requested set.)

### 2. Link sync (built)

`syncRelationColumn(env, spec, a, ids, item, opts, budget)`:
- `target = SPEC_BY_OBJECT[a.toObject]` → target board + HubSpot-id column.
- `findItemIdsByColumn(target.boardId, target.idCol, ids)` → the monday cards to link.
- `getLinkedItemIds(item.id, a.relationCol)` → current links; **skip if the set already matches** (no
  phantom writes / loops).
- else `setColumns(spec.boardId, item.id, { [relationCol]: { item_ids } })`.

### 3. Config: relationCol replaces text col

For each association, set `relationCol` to the created column id and **remove `col`** (text). The
dispatch already runs relation when `relationCol` is set and text only when `col` is set. After live
verification, **delete** the old text association columns (`text_mm53a30h`, `text_mm53k97q`,
`text_mm53m5g0`, `text_mm53yyc3`, `text_mm5367qf`).

Associations covered:
- Deals: → companies (relationCol), → contacts (relationCol), line_items (subitems, unchanged).
- Contacts: → companies (relationCol), → deals (relationCol).
- Companies: → contacts (relationCol).

### 4. Instant on change (new webhooks)

**HubSpot app** (`webhooks-hsmeta.json`, then `hs project upload` + reinstall):
- `object.associationChange` for `deal`, `contact`, `company`. Fires on add/remove of an association,
  including **deal↔line_item** (so adding/removing a line item triggers a subitem rebuild).
- `object.propertyChange` for `line_item` on the synced properties (price, quantity, amount,
  hs_pre_discount_amount, discount, service_date, hs_line_item_currency_code, description) — so editing
  a line item rebuilds its parent deal's subitems.

**Worker** (`worker/src/webhooks.ts`):
- `extractObjectEvents` recognises `*.associationChange` → emit a normal re-sync of the **from-object**
  (`fromObjectId` + its type). Re-syncing runs `runAssociations`, which repairs links + subitems.
- Line-item events (objectTypeId `0-8`): resolve the **parent deal(s)** via
  `getAssociatedIds(line_items, id, deals)` and emit a `deal` re-sync for each. (Requires a small async
  step before dispatch, bounded like the existing `MAX` slice.)

### 5. Backfill

After columns + config + deploy: touch-backfill existing deals (and, for Company/Contact link columns,
their records) so links + subitems populate across the board — same touch pattern used before.

### 6. Safety / edge cases

- **Missing target card**: if an associated Company/Contact card isn't on monday yet, the link resolves
  to empty; the association-change event on that record (when it syncs) and the periodic reconcile heal
  it. No error, no dup.
- **Loop-safe**: relations are HubSpot→monday only and skip-when-unchanged; the webhook bookkeeping/loop
  guards already in place still apply.
- **Bounded work**: per-webhook processing keeps the existing `MAX` slice; the 10-min/daily reconcile is
  the backup for any overflow.
- **Mirror columns**: creating a board_relation link auto-shows a mirror on the target board; we do not
  depend on it and do not write it.

### 7. Testing

- **Unit**: relation resolve/link/skip (done); `extractObjectEvents` routing of `associationChange`
  → from-object re-sync; line-item event → parent-deal re-sync.
- **Live**: (a) create a deal with a Company + Contact + line item → links + subitems appear; (b) add a
  Contact to an existing deal → link appears within seconds; (c) edit a line-item price → subitem
  updates; (d) remove an association → link clears.

## Verification risks (confirm during build, before relying on them)

- Confirm this app's platform version accepts `object.associationChange` and `line_item`
  `object.propertyChange` subscriptions. If **line-item property** webhooks are not supported, price
  edits fall back to deal-edit / reconcile; **add/remove of line items and associations stays instant**
  via `deal.associationChange`.
- Confirm the association-change webhook payload exposes `fromObjectId` + object type so the Worker can
  route it (adjust `extractObjectEvents` to the real shape observed in logs).

## Out of scope

- monday → HubSpot association editing (associations are HubSpot-owned; one-directional only).
- Company→Deal link column (can be added later with the same pattern).
