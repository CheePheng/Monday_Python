# monday vibe app prompt — "Deal Creator"

Paste this into monday vibe. It builds an app on the "Hubspot Deals" board that creates/updates deals
(a 1-to-1 feel of HubSpot's Create Deal), with contact/company associations (Connect Boards) and line-item
subitems. Creating writes to the monday board; the Cloudflare Worker mirrors it to HubSpot (fields +
sales_user + associations today; line items once `crm.objects.line_items.write` is added).

```text
Build a monday app (via vibe) called "Deal Creator" that creates and updates deals on my "Hubspot Deals" board. Connect it to three boards: "Hubspot Deals" (main), "Contact Follow Up", and "Company Follow Up".

MAIN SCREEN
- A list/table of existing deals from the Hubspot Deals board (name, Deal Stage, Sales Users, Amount, Close Date), with a "+ Create Deal" button and an "Edit" action per row.

CREATE / EDIT DEAL FORM — a 1-to-1 feel of HubSpot's Create Deal, three sections:

SECTION 1 — Deal information (reuse the board's existing columns + options; don't invent new ones)
1. Deal name *      -> item Name (single-line text)
2. Pipeline *       -> status "Deal Pipeline", default "Sales Pipeline"
3. Deal stage *     -> status "Deal Stage", default "Appointment Scheduled" (drop the item into the group for the chosen stage)
4. Vendors-厂商来源  -> dropdown "Vendors"
5. Amount           -> number "Amounts"
6. Currency         -> status "Currency", default "US Dollar (USD)" (USD, CNY, EUR, HKD, SGD)
7. Close date       -> date "Close Date", default 2026-07-31
8. Sales User       -> people "Sales Users", default empty
9. Deal owner       -> people "Deal Owner", default "Ask Ada"
10. Deal type       -> status "Deal Type"
11. Priority        -> status "Priority" (Low, Medium, High)

SECTION 2 — Associate Deal with (LIVE search across ALL of HubSpot, not just what's on monday)
- Contacts: a search box. As I type, call this HTTP endpoint:
    GET https://hubspot-monday-sync.askada.workers.dev/app/search?type=contacts&q=<text>&limit=10
    header: X-App-Secret: dkm-vibe-app-2026-7f3a9c
  It returns { results: [ { id, name, secondary } ] } (secondary = email). Show name + email.
  On select: look on the "Contact Follow Up" board for an item whose "HubSpot ID" column == the picked id;
  if none, create an item (name = the contact name, "HubSpot ID" = the id); then add that item to the
  deal's "Associated Contact" Connect Boards column. Show chosen contacts as removable chips + "Add more".
- Companies: identical, but type=companies, board "Company Follow Up", column "Associated Company".

SECTION 3 — Line items (pick from the HubSpot PRODUCT LIBRARY)
- "Add line item": a search box calling the same endpoint with type=products&q=<text> (returns name +
  price). On select, add a SUBITEM to the deal named after the product, with Quantity (default 1), Unit
  Price = the product price, and store the product's id in the subitem's "HubSpot Product ID" column.
  Allow several rows + removal. Optional. (You can also add a free-text line item without a product.)

BUTTONS (bottom, like HubSpot): "Create", "Create and add another", "Cancel". In edit mode: "Save". Keep "Create"/"Save" disabled until Deal name, Pipeline, and Deal stage are filled.

BEHAVIOR
- Creating writes ONE new deal item to the Hubspot Deals board with all the above columns, the Connect Boards links, and the line-item subitems. (A backend sync mirrors it into HubSpot automatically — the app only needs to write to the monday board.)
- Editing updates the existing deal item's columns, links, and subitems.
- Style: clean and monday-native — labels above fields, required fields marked with a red asterisk, three clearly separated sections in the order above.
```
