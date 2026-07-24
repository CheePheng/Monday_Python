# monday-first deal creation (vibe app) + reverse association & line-item sync — Design

**Date:** 2026-07-11
**Status:** Approved

## Goal

A monday **vibe app** creates/updates a deal on the "Hubspot Deals" board — with contact/company
**associations** (Connect Boards columns) and **line items** (subitems). The Worker propagates all of it to
HubSpot so the deal exists in both systems with its associations and line items. Deal fields + `sales_user`
already round-trip; this adds the missing **reverse** (monday → HubSpot) for **associations** and **line items**.

## Context

Current sync directions:
- Deal fields, name, group/stage: two-way. ✓
- `sales_user` (Sales Users people col): two-way (set-only). ✓
- Deal create from monday (`createFromMonday`): monday → HubSpot. ✓
- **Associations (contacts/companies, Connect Boards): HubSpot → monday only.** ✗ (add reverse)
- **Line items (subitems): HubSpot → monday only.** ✗ (add reverse)

The Worker's HubSpot token has **write** on deals/contacts/companies but **read-only** on line_items (a
line-item create returns 403). Line-item reverse needs `crm.objects.line_items.write` added to the private
app + a reinstall.

## Confirmed decisions

1. The vibe app writes to the **monday board** (monday-first); the Worker reverse-syncs to HubSpot.
2. **Include line items now** (add the write scope).
3. Reverse is **additive + set-only** for both associations and line items: adding in monday creates in
   HubSpot; **removing** in monday does NOT delete in HubSpot (HubSpot stays source of truth for removals).

## Architecture

### 1. The vibe app (built by the user in monday vibe)

Connected to the Deals + Contact + Company boards. Create/Update deal UI (a 1-to-1 feel of HubSpot's Create
Deal): deal fields → columns; Contacts/Companies → the "Associated Contact"/"Associated Company" Connect
Boards columns; line items → subitems (name, qty, unit price, …). Creating writes a deal **item** on the
Deals board. (Prompt delivered separately.)

### 2. Reverse association sync (Worker) — additive, set-only, loop-safe

New pass `reverseAssociations(env, spec, rec, item, ctx, opts, budget)`:
- For each `AssocSpec` with a `relationCol`, read the monday item's linked card ids (`getLinkedItemIds`).
- Map each linked card → its HubSpot id (read the target board's id column).
- Read the current HubSpot associations (`getAssociatedIds`).
- **PUT** any HubSpot association that is present in monday but missing in HubSpot
  (`/crm/v4/objects/{from}/{id}/associations/default/{to}/{toId}`). Never delete (set-only).
- Idempotent PUT + additive => converges with the forward pass (`syncAssociations` skips-when-unchanged), no
  oscillation.
- Runs after the deal has a HubSpot id (post-`createFromMonday`) and on the reconcile / monday-edit path.
- Requires no new scopes (deal/contact/company write already present).

### 3. Reverse line-item sync (Worker) — additive, set-only, keyed by Line Item ID

New pass `reverseLineItems(env, sub, parentItem, dealHubspotId, opts, budget)`:
- For each subitem with an **empty** "HubSpot Line Item ID" (`text_mm53ds6w`) => a monday-created line item.
- Create a HubSpot line item (`POST /crm/v3/objects/line_items`, properties mapped back from the subitem
  columns: name, price, quantity, amount, …) **associated to the deal** (create-with-association, or PUT the
  line_item↔deal association after).
- Write the new HubSpot line-item id back to the subitem's "HubSpot Line Item ID" column (dedup key), so the
  forward pass then treats it as synced (no duplicate).
- Additive: a removed subitem does NOT delete the HubSpot line item.
- **Requires `crm.objects.line_items.write`** on the private app (user adds + reinstalls).

### 4. Direction & loop safety

- Associations: forward writes the monday link column, reverse writes HubSpot associations; both additive +
  compare sets, so a matching set is a no-op on both sides.
- Line items: keyed by the HubSpot Line Item ID column — forward creates subitems *with* the id; reverse
  creates HubSpot line items only for subitems *without* an id, then stamps the id. No path creates twice.
- Set-only removals avoid the hardest two-way conflict (delete races).

## Testing

- **Unit:** reverse assoc emits the missing PUT set + skips already-present (mocked HubSpot/monday); reverse
  line-item creates only for subitems lacking an id and stamps the returned id; additive (no deletes).
- **Live:** (a) create a deal via the vibe app with a contact + company + line item → HubSpot deal gains the
  associations + a line item within seconds; (b) add a contact link on an existing monday deal → HubSpot
  association appears; (c) removing a link on monday does not delete it in HubSpot.

## Out of scope

- Deleting HubSpot associations/line items when removed in monday (set-only by decision #3).
- Products/recurring-billing modelling for reverse line items (basic name/price/quantity/amount only).
