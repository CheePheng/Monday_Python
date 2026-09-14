# Phase 2 audit — Deals, Line Items, Activities

**2026-09-11 · READ-ONLY.** Nothing in this audit modified either system. It measures what is there and
states what the sync would have to do, so the build decisions are made against evidence rather than
against the monday CRM template's defaults.

Sources: monday Platform MCP (`get_board_info`, `list_automations`, `get_board_items_page`) for board
schema and automation configs — the REST API cannot tell you that an automation *reads* a column — and
HubSpot for schemas, volumes and association cardinality.

---

## 0. The three things that change the plan

**1. The Service Key cannot read Deals or Line Items.** `GET /crm/v3/properties/deals` and
`/crm/v3/objects/deals` both return **403**, as do `line_items` and `emails`. Everything HubSpot-side
below came from the MCP connector instead (OAuth, read-only). Before any Deals sync can run, the
existing HubSpot Service Key needs `crm.objects.deals.read`, `crm.objects.deals.write`,
`crm.objects.line_items.read`, `crm.objects.line_items.write`. This is a hard prerequisite, not a
nice-to-have — the Worker uses that key, not the connector.

**2. `dealstage` has 42 values whose labels are not unique, and the monday status column cannot hold
them.** Three pipelines each use the same nine Chinese stage labels with different internal ids —
`赢单` alone exists three times (`cd8b9086…`, `d0e83c62…`, `ea1194fc…`). Our reverse mapping inverts a
label→value dictionary, so inverting this one would silently collapse three stages into one and a
monday-side edit could move a deal into **the wrong pipeline's** stage. Detail and fix in §2.4.

**3. 60% of deals have no associated contact, and the board's Accounts column is a mirror through the
contact link.** 5,204 of 8,651 deals have `num_associated_contacts = 0`. `deal_account` is a monday
`mirror` column that displays `contact_account` *through* `deal_contact`, so those 5,204 deals would
show a blank Account no matter what we write. A real Deal→Accounts relation column has to be created.

> **CORRECTED 2026-09-14.** The conclusion above is right; the reasoning is not, and it was wrong
> because it was *inferred* rather than measured — the Service Key was 403 on deals when this was
> written, so Deal→Company was read backwards off the monday mirror instead of from HubSpot. With the
> scopes granted, the real figure is that **98% of deals (8,466 of 8,653) have a direct Company
> association independent of any contact**, and 8,462 of those carry a `Primary` label. `deal_account`
> was never an approximation of the deal's company — it measures the company of whichever contact
> happens to be linked. See `2026-09-14-deals-design.md`, which supersedes §2.5's association design.

---

## 1. Volumes

| object | HubSpot | monday board | monday items |
|---|---|---|---|
| Deals | **8,651** | 5028000494 Deals | 6 |
| Line Items | **9,964** | 5028000489 "Products & Services" | 2 |
| Calls | 2,714 | 5028000492 Activities | 6 |
| Meetings | 950 | " | |
| Notes | 4,450 | " | |
| Tasks | 8,369 | " | |
| Emails | *403 — scope missing* | " | |
| Companies | 27,504 | 5028000496 Accounts | 27,504 carry a HubSpot ID |

Engagements total **16,483 excluding emails**. All three boards are on `items_limit: 100000`.

**Every item currently on all three boards is template or test data.** The 6 Deals are "Google deal",
"Apple deal", "Amazon deal" (monday CRM template seeds, 2026-04-22), two "新的 Deal" and "Test0812";
none carries a HubSpot id, none has a contact linked, and the "Deal name" text stub is null on all six.
Both Products items ("New item", "1") have **every** column null. This matters: there is no real data
on either board to preserve, so deleting or replacing the stub columns costs nothing.

Pipeline distribution of the 8,651 deals:

| pipeline | deals |
|---|---|
| Salesforce - Sales (`551f4f6c…`) | 4,360 |
| Salesforce - Maintenance (`d10159b0…`) | 3,358 |
| Sales Pipeline (`default`) | 694 |
| Salesforce - 赋能培训 + HubSpot Shared Selling | 227 |
| unaccounted (no/other pipeline) | ~12 |

**89% of the deals are in the two Salesforce pipelines**, whose stage vocabulary is Chinese and matches
none of the monday board's six English labels.

---

## 2. Deals — board 5028000494

### 2.1 Association cardinality

Measured, because a late cardinality discovery nearly derailed the Contacts phase (one company had
2,007 contacts against monday's ~751-link cell limit).

| relation | max observed | verdict |
|---|---|---|
| Deal → Contacts | **9** (deal 41573034139) | safe, no ceiling needed |
| Deal → Line Items | **12** (deal 14415149320) | safe |
| Company → Deals | **154** (vstecs.com, a distributor) | safe |
| Line Item → Deals | 1 by construction | single-link |

Nothing here approaches monday's relation-cell limit. **No link ceiling is required on the Deals
phase** — a materially easier problem than Contacts↔Companies.

### 2.2 Automation dependency map

Nine automations, all on the board's read-only legacy engine. **The column each one reads is the
constraint on what we may write.**

| id | active | what it does | reads |
|---|---|---|---|
| 31010009 | ✅ | email opened → notify item subscribers | — |
| 31010010 | ✅ | `deal_stage` → **Won** → notify **board** subscribers "Congratulations! {name} worth ${deal_value} has been won!" | `deal_stage`, `deal_value` |
| 31010011 | ✅ | `deal_stage` → Discovery → move to group `topics` | `deal_stage` |
| 31010012 | ✅ | `deal_stage` → Negotiation → move to group `topics` | `deal_stage` |
| 31010013 | ❌ | `deal_stage` → Won → move to group `closed` | broken: `auto_disabled_by_deleted_resource`, group `closed` was deleted |
| 31010014 | ✅ | `deal_stage` → Proposal → move to group `topics` | `deal_stage` |
| 31010016 | ✅ | **item created → set `deal_stage` = New** | writes `deal_stage` |
| 31010017 | ✅ | `deal_stage` → Won → **create an item in board 5028000491** linked via `project_opportunity`, name `"{name} - New project"`, `project_owner` ← `deal_owner` | `deal_stage`, `deal_owner`, `name` |
| 31010018 | ✅ | any Emails & Activities activity → create an item in **Activities 5028000492** linked via `activity_item` | E&A app |

In these configs `index` is the label **id**, not the position — confirmed by 31010010, whose id-1
target carries a "has been won" message and `deal_stage` label id 1 is "Won".

### 2.3 The backfill storm — the hard prerequisite

**3,640 of the 8,651 deals are Closed Won** (`hs_is_closed_won = true`). If the backfill writes the Won
stage onto those cards with the automations live:

- **31010017 creates 3,640 items in board 5028000491**, each linked and owner-mapped. That board is not
  ours and is not in scope.
- **31010010 sends 3,640 "Congratulations!" notifications to every subscriber of the Deals board.**
- **31010016 clobbers the stage we just wrote**, on all 8,651 cards, because it fires on item creation
  and sets `deal_stage` = New. The forward reconcile would repair each one — at the cost of 8,651
  needless webhooks and writes.

The Contacts phase got away with this because Zmark's assignment-reminder workflow ran only **2** times
against 95,013 webhook firings. **Deals will not be so lucky**: 31010010 and 31010017 are simple
status-change recipes with no such guard. So: **31010010, 31010016 and 31010017 must be deactivated for
the duration of the Deals backfill and reactivated after**, and that must be done by a human in the
monday UI — these are legacy automations and the API cannot toggle them.

### 2.4 `dealstage` — why Stage must be one-way, and what to build instead

HubSpot's 42 `dealstage` values span 5 pipelines. Grouped by label:

- **Salesforce × 3 pipelines**, nine labels each, *identical text, different ids*: `1 共同利益 MI`,
  `2 探索 Discover`, `3 验证 Validate`, `4 选择 Select`, `5 决定 Decide`, `6 承诺 Commit`, `暂停`,
  `赢单`, `输单`
- **Sales Pipeline**: Appointment Scheduled, Qualified To Buy, Presentation Scheduled, Decision Maker
  Bought-In, Contract Sent, Closed Won, Closed Lost, `Trustpilot邀约评价（已成交）`
- **Shared Selling**: Discovery, Solution Demo, Business Considerations, Pricing and Terms, Out for
  Signature, Closed Lost, Closed Won

Two independent problems:

1. **Labels are not unique.** `赢单` → 3 ids, `Closed Won` → 2, `Closed Lost` → 2, `Discovery` → 1 as a
   registration stage. A label-keyed inverse dictionary is not well-defined. This is the same class of
   bug as the `sales_person`/`department_3__c` enums that froze Contact cards — except those merely
   failed to write, whereas this one would write a *wrong* stage in a *wrong* pipeline.
2. **~24 distinct labels exceed what a monday status column holds.** Status columns were measured in
   this project to start returning 500s above roughly 19 labels. Dropdowns were verified to 88.

**Recommendation:**

- `deal_stage` (status, 6 usable labels) → **KEEP as a coarse monday-native view, HubSpot → monday
  only.** Many HubSpot stages map onto one monday label, and a many-to-one map is not invertible.
- **CREATE `HubSpot Stage` as a dropdown** holding the exact stage, with **pipeline-qualified labels**
  — `Sales / 赢单`, `Maintenance / 赢单`, `赋能培训 / 赢单`. Qualifying restores label uniqueness, which
  makes the inverse dictionary well-defined and lets **this** column be genuinely two-way.
- **CREATE `Pipeline` as a dropdown** (5 labels). A stage without its pipeline is ambiguous by
  construction, so the two columns have to travel together.

This is the one place where the standing "everything two-way except delete and system metadata" policy
cannot be honoured literally. The business-editable field *is* editable two-way — through the
pipeline-qualified dropdown. What stays one-way is the *coarse summary* column, which is a display
convenience, not a field.

### 2.5 Column diff

Board has **24 columns**. Verdicts:

**KEEP unchanged (monday-native, not synced)**

| column | type | why |
|---|---|---|
| `name` | name | the card name, from `dealname` |
| `subitems` "Tasks" | subtasks → 5028000500 | monday-native task tracking |
| `custom_mkrmrgz6` "Activities timeline" | app column | monday app, do not touch |
| `custom_mknwwj0z` "Quotes & Invoices" | app column | monday app, do not touch |
| `deal_forecast_value` | formula `{deal_value}*{deal_close_probability}` | monday-computed, unwritable by design |
| `color_mm1hjwv8` "Forecast categories" | status | **no HubSpot counterpart** — `hs_forecast_category` does not exist in this portal. monday-only. |
| `board_relation_mm6zfen6` "Sales Playbook Library" | board_relation → 5031141754 | monday-only |
| `deal_account` "Accounts" | **mirror** via `deal_contact` → `contact_account` | unwritable by construction. Display-only: **no automation reads it.** Leave in place; see §2.5 CREATE. |

**REUSE as-is (map to HubSpot, two-way unless noted)**

| column | type | HubSpot property | direction | note |
|---|---|---|---|---|
| `deal_stage` "Stage" | status | `dealstage` | **→ monday only** | see §2.4 |
| `deal_owner` "Deal Owner" | people | `hubspot_owner_id` | two-way | same owner-email mapping the Contacts spec uses |
| `deal_value` "Deal Value" | numbers $ | `amount` | two-way | |
| `deal_contact` "Contacts" | board_relation → 5028000495 | deal↔contact associations | two-way | max 9 |
| `deal_expected_close_date` "Close Date" | date | `closedate` | two-way | |
| `deal_close_probability` | numbers % | `hs_deal_stage_probability` | two-way | **unit mismatch**: HubSpot stores a 0–1 fraction, the monday column renders `%`. Needs a ×100 / ÷100 transform on both legs, or it will read 0.2% instead of 20%. |
| `date__1` "Last interaction" | date | `notes_last_updated` ("Last Activity Date") | **→ monday only** | HubSpot-computed |

**RETYPE — i.e. CREATE a typed column then DELETE the text stub.** monday columns cannot be retyped in
place; this was established in Phase 1. All five stubs are empty on every item, so nothing is lost.

| stub | title | → new type | HubSpot property | labels |
|---|---|---|---|---|
| `text_mm6tk0kt` | Sales Users | dropdown | `sales_user` | 43 |
| `text_mm6tqv5g` | Deal Pipeline | dropdown | `pipeline` | 5 |
| `text_mm6tqq08` | Vendors | dropdown | `vendorschang_shang_lai_yuan` | **85** — under the 88 verified dropdown ceiling, but only just. Flagged. |
| `text_mm6t56f4` | Currency | dropdown | `deal_currency_code` | 5 |
| `text_mm6termq` | Deal Type | dropdown | `dealtype` | 9 — note overlapping semantics: `1 Landing`/`Landing`, `2 Expand`/`Expand` |
| `text_mm6tf8hs` | Priority | status | `hs_priority` | 3 (Low/Medium/High) |

**DELETE (redundant, empty)**

| stub | why |
|---|---|
| `text_mm6tk32c` "Deal name" | the card name already *is* `dealname`; a second copy invites divergence |
| `text_mm6t5a5x` "Amounts" | duplicate of `deal_value` → `amount` |

**CREATE (new)**

| column | type | purpose |
|---|---|---|
| HubSpot ID | text | **the board has none.** Required by the engine's `idCol` |
| HubSpot Link | link | required by `linkCol` |
| Sync State | text | required by `syncStateCol` |
| HubSpot Stage | dropdown, pipeline-qualified | the exact stage, two-way — §2.4 |
| Pipeline | dropdown (5) | travels with the stage — §2.4 |
| Line Items | board_relation → 5028000489 | **no such column exists**; max 12 |
| Accounts (real) | board_relation → 5028000496 | because `deal_account` is a mirror and **5,204 deals have no contact to mirror through** |

`sales_user` and `hubspot_owner_id` expose the **identical 43-option list**, so `sales_user` is an
owner-shaped duplicate. Note also two owners named **Rick Antonio** (`164317533`, `165857270`) — a
pre-existing data-quality issue, not ours to fix here.

---

## 3. Line Items — board 5028000489

Treated as HubSpot **`line_items`**, per instruction, not Products. The board is *named* "Products &
Services" and its `item_terminology` is "Name *", which is where the Products reading came from.

**All 13 text stubs map to a real HubSpot `line_items` property.** Whoever built them in Phase 0 worked
from the actual schema, including the Salesforce-migrated custom ones (`family`, `product_subcategory`,
`service_date` all carry `salesforce - …` descriptions). Confirmed types:

| monday column | current type | HubSpot property | correct type | labels |
|---|---|---|---|---|
| `name` | name | `name` | KEEP | |
| `text_mm73mvfj` SKU | text | `hs_sku` | text — **KEEP as-is** | |
| `product_and_service_description` | long_text | `description` | KEEP | |
| `product_and_service_price` **"Brand ISV"** | **numbers $** | `brand_isv` | **dropdown** | 7 |
| `product_and_service_type` **"Family"** | status (Service, Inventory) | `family` | status/dropdown | **9, and the two existing labels are not among them** |
| `text_mm739x8p` Product Subcategory | text | `product_subcategory` | dropdown | **43** |
| `text_mm73j5g9` Is Active | text | `is_active` | status or checkbox | 2 (Yes/No) |
| `text_mm7318s1` Note | text | `note` | text/long_text — KEEP | |
| `text_mm738n4x` Service Date | text | `service_date` | **date** | |
| `text_mm73t7v9` Billing frequency | text | `recurringbillingfrequency` | dropdown | 10 |
| `text_mm73gvej` Billing start date | text | `hs_recurring_billing_start_date` | **date** | |
| `text_mm73zrcw` Tax rate | text | `hs_tax_rate_group_id` | dropdown | 3 (GST 9%, VAT 9%, GST-1 0.0001%) — **stores an id, displays a label**, so the label dictionary is mandatory |
| `text_mm735shw` Unit discount | text | `discount` | **numbers** | |
| `text_mm73bz1v` Pricing model * | text | `hs_pricing_model` | dropdown | 4 |
| `text_mm73axh0` Unit price * | text | `price` | **numbers** | |
| `text_mm73j3sh` Quantity | text | `quantity` | **numbers** | |
| `text_mm7371qb` Unit cost | text | `hs_cost_of_goods_sold` | **numbers** | |
| `text_mm73ck1s` Deposit | text | `deposit` | **numbers** | |

**Two mis-typings that cannot be repaired in place:**

- `product_and_service_price` is a **numeric** column titled "Brand ISV", but `brand_isv` is an
  **enumeration** of 7 ISV names. Someone renamed monday's native Price column and left its type. A
  numeric column cannot hold "Docusign".
- `product_and_service_type` is a status titled "Family" whose two labels (Service, Inventory) are
  monday-template values; HubSpot's `family` uses nine entirely different ones (`1 产品` … `99 其他`).
  Writing with `create_labels_if_missing` would leave the two template labels orphaned in the column.

**Unlike `dealstage`, every Line Item enum has unique labels** — `brand_isv`, `family`,
`product_subcategory` (43), `hs_pricing_model`, `recurringbillingfrequency`, `hs_tax_rate_group_id`,
`is_active`, `hs_line_item_currency_code` all invert cleanly. Line Items can be fully two-way.

**CREATE:** HubSpot ID (text), HubSpot Link (link), Sync State (text), **Deal** (board_relation →
5028000494 — no relation column exists on this board at all), and a Currency dropdown for
`hs_line_item_currency_code` (5). **DELETE** the 11 text stubs replaced by typed columns.

**0 automations on this board** — retyping and deleting here breaks nothing.

**Association model:** a line item belongs to exactly one deal (HubSpot's own model), so the Deal link
is single-valued; the Deals side carries up to 12.

---

## 4. Activities — board 5028000492

Structure: `activity_owner` (people), `activity_type` (status), `activity_start_time` /
`activity_end_time` (date), `activity_status` (status: Open, Done), `activity_item` (board_relation with
`allowMultipleBoards: true`, pointing at Contacts, Deals, 5028000493, Accounts **and itself**).

**One automation, and it works:** `31009998` — when `activity_end_time` arrives (09:00,
**timezone `Asia/Jerusalem`**) set `activity_status` = Done. The timezone is a monday template default
and is almost certainly wrong for a Philippines/Malaysia team; that is a config question for Zmark, not
a sync change.

**What feeds this board today:** monday's native **Emails & Activities** app, via automation `31010018`
on the Deals board and an equivalent on Contacts. Its field mapping is already correct and should be
**reused, not rebuilt**: name ← `"{source item} - {activity type}"`, `activity_status` ← status,
`activity_type` ← activity type, `activity_owner` ← activity creator, `activity_start_time` ← start
date, `activity_end_time` ← end date.

**Two existing defects, both pre-existing and neither ours to fix silently:**

1. `activity_type` carries a junk label **id 1, text `"1"`, `is_done: true`**, and three of the six
   items use it. Automation `31010018`'s stored config snapshot lists the labels as
   `{0: Call summary, 107: Meeting, 153: Phone call}` — so "Phone call" was deleted from the board and
   "1" appeared after the automation was configured. The automation maps by label text, so any HubSpot
   activity type outside the current labels will land as an unmapped value.
2. **A duplicate pair already exists.** Items 2855149555 and 2855143261 are both
   `"PhaseA Tester  -  1"`, same start time, same linked Contact card, created 11 seconds apart on
   2026-09-09 under our token. One logged activity produced two cards. Before syncing 16,483 HubSpot
   engagements into this board, that duplication path has to be understood — otherwise the Contacts
   phase's 758-duplicate incident repeats at ten times the scale.

**Last Activity Date:** HubSpot's `notes_last_updated` is labelled "Last Activity Date" and is
maintained automatically from notes, calls, emails, meetings and tasks. `notes_last_contacted`
("Last Contacted") is the narrower one — calls, sales emails and meetings only. Both are
HubSpot-computed, so both are **one-way by construction**; `date__1` "Last interaction" on the Deals
board is the natural home for `notes_last_updated`.

**Architectural decision still open:** HubSpot engagements are five object types (calls, meetings,
notes, tasks, emails) totalling 16,483 excluding emails, and this board is *already* populated by
monday's own E&A app. Syncing both into one board means two writers with no shared key. That needs a
decision before any Activities work starts — it is not a mapping question.

---

## 5. Blockers and prerequisites

| # | blocker | who |
|---|---|---|
| 1 | HubSpot Service Key needs `crm.objects.deals.read/write` + `crm.objects.line_items.read/write` (and `sales-email-read` if emails are ever in scope) | user, in HubSpot |
| 2 | Deactivate legacy automations **31010010, 31010016, 31010017** for the Deals backfill; reactivate after. Legacy automations are read-only to the API — a human must toggle them | user, in monday UI |
| 3 | Decide the Activities architecture: one shared board with monday's E&A app, or a separate HubSpot-engagements board | advisor |
| 4 | Confirm the pipeline-qualified `HubSpot Stage` dropdown approach for two-way stage editing (§2.4) | advisor |
| 5 | Explain the pre-existing Activities duplicate pair before syncing 16,483 engagements | this project, next |

## 6. What is NOT a problem

- **Cardinality.** Nothing on this phase approaches monday's relation-cell limit: 9 contacts per deal,
  12 line items per deal, 154 deals per company. No link ceiling needed.
- **Data migration on the boards.** All 14 items across the three boards are template or test data with
  effectively empty columns, so retyping and deleting stubs destroys nothing.
- **Line Item enums.** Every one inverts cleanly; Line Items can be fully two-way.
- **Volume.** 8,651 + 9,964 records is roughly a tenth of the 94,090 Contacts already imported, on the
  same serialised-per-board write path.
