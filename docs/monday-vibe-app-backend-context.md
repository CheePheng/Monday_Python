# Backend context for the "Deal Creator" vibe app

Paste this into the vibe app builder as context. It explains how the backend two-way sync behaves so the
app stops guessing (e.g. about group moves and line-item removals).

```text
BACKEND CONTEXT — read before making design decisions.

The "Hubspot Deals" board and the "Contact Follow Up" / "Company Follow Up" boards are two-way synced to
HubSpot by a backend service (a Cloudflare Worker). Follow these rules so the app doesn't fight the sync.

1) GROUPS ARE BACKEND-CONTROLLED (by Deal Stage + Sales User) — don't manage them on UPDATE.
   - An item's group is decided by the backend: if the deal has NO Sales User -> the "Unassigned Deals"
     group; otherwise -> the group whose name matches its Deal Stage. The backend re-places the item after
     any change (within a few seconds).
   - CREATE: set the Deal Stage, then place the new item in the matching group YOURSELF (Unassigned Deals
     if no Sales User is set, else the Deal-Stage group) so it looks right immediately — the webhook may lag
     a moment on a brand-new item.
   - UPDATE: just set the Deal Stage / Sales User columns and DO NOT run any group-move logic — the backend
     moves it. (So: keep the group placement for CREATE, drop it for UPDATE — your instinct was correct.)
   - Never move an item to a group that contradicts its Deal Stage / Sales User; the backend will move it
     back. When a Sales User is assigned to an Unassigned deal, the backend moves it to its Deal-Stage group
     automatically — the app doesn't need to.

2) LINE ITEMS = SUBITEMS; REMOVALS ARE "SET-ONLY".
   - Add each line item as a SUBITEM (Name, Quantity, Unit Price, and "HubSpot Product ID" if picked from
     the product library). The backend creates the matching HubSpot line item and writes a "HubSpot Line
     Item ID" onto the subitem — DO NOT read/write that column yourself.
   - The backend is SET-ONLY for removals: removing a subitem on monday does NOT delete the HubSpot line
     item. So in EDIT mode, when the user removes a line item you MUST actually delete/archive the subitem
     on the board yourself (delete_subitem) — otherwise, as you noticed, the removal is lost on save. Know
     that the HubSpot line item will still remain (HubSpot is the source of truth for deletions); to remove
     it there, the user deletes it in HubSpot.

3) ASSOCIATIONS (Contacts/Companies via the Connect Boards columns) — also set-only.
   - Adding a Connect Boards link -> the backend creates the HubSpot association. Removing a link on monday
     does NOT remove the HubSpot association. To make a removal stick visually, just clear the link column;
     it won't propagate to HubSpot.

4) DO NOT WRITE these backend-managed columns (the sync owns them):
   "HubSpot Deal ID" / "HubSpot ID", "Sync State", "HubSpot Link", "HubSpot Line Item ID", and "Shared".
   Setting Deal fields, Sales Users, Connect Boards links, and subitems is all you need — the backend
   mirrors everything to HubSpot.
```
