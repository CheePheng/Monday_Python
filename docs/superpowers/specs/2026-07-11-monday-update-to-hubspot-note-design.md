# monday item Update → HubSpot Note (deal/contact/company activity) — Design

**Date:** 2026-07-11
**Status:** Approved

## Goal

When someone posts an **Update** on a monday item (Deals / Contact Follow Up / Company Follow Up), create a
**Note** on the matching HubSpot record so it appears under the record's **Activities**. One-directional
(monday → HubSpot), prefixed with who wrote it.

## Context

- The Worker's HubSpot token can already **create notes** (verified — a test note POST/DELETE succeeded), so
  no scope change.
- The monday boards currently subscribe to `create_item / change_column_value / change_name /
  item_moved_to_any_group` — **not** update events. Need a `create_update` subscription per board.
- `handleMonday` already routes board webhooks and has the `mondayEmailByUserId` / `ownerIdByEmail` reverse
  maps in `ctx` for author→owner mapping.

## Confirmed decisions

1. **All three boards** (deal/contact/company updates → notes on the matching HubSpot object).
2. **Author-prefixed**: note body = `Update by <monday author> (via monday): <text>`; set the note's
   `hubspot_owner_id` to that author's HubSpot owner when their email matches (else leave unset).
3. One-directional (monday → HubSpot). HubSpot notes are NOT synced back to monday (no loop).

## Architecture

### 1. `createNote` (hubspot.ts)

`POST /crm/v3/objects/notes` with `{ properties: { hs_note_body, hs_timestamp, hubspot_owner_id? },
associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: N }] }] }`
where the note→object default type id is **deal 214, contact 202, company 190**. retries=1 (a create).

### 2. `handleMonday` create_update path (webhooks.ts)

- When `ev.type === "create_update"`: read `pulseId` (the item), `userId` (author), and the update text
  (`textBody` ?? `body`). Ignore empty text.
- In `waitUntil`: `getItem(pulseId)` → `colText(item, spec.idCol)` = the HubSpot id; skip if none (item not
  linked yet).
- Author: `getUserById(userId)` (new monday helper → `{ name, email }`); `author = name || "a monday user"`;
  `ownerId = ctx.ownerIdByEmail[email]` if the email maps.
- `createNote(env, "Update by "+author+" (via monday): "+text, Date.now(), ownerId, spec.object, hsId, opts)`.
- Runs before the normal `syncMondayItem` dispatch and returns fast (respond 200 quickly).
- Loop-safe: we never create monday updates, so notes can't echo back.

### 3. Subscribe `create_update` on all three boards

One-off monday `create_webhook(board_id, url: .../webhooks/monday, event: create_update)` per board
(5029480547, 5029639630, 5029639440).

## Testing

- **Unit** (webhook.test.ts): a `create_update` event with text + pulseId is recognised and routed to the
  note path (not to item-sync); empty-text update is ignored; the note body is `Update by X (via monday): …`.
- **Live**: post an Update on a monday deal → within seconds a Note appears on the HubSpot deal's Activities
  with the author prefix; repeat for a contact and a company card.

## Out of scope

- Update **replies**, **edits**, **deletes**, and **file attachments** (only new top-level updates → notes).
- HubSpot activities/notes → monday updates (one-directional only).
- Setting the note's true HubSpot author (API can't); the author name is in the body + owner instead.
