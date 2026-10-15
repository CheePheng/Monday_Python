# Deals + Line Items — implementation design

**2026-09-14.** This is the document implementation is built from. It supersedes the association
design in `2026-09-11-deals-lineitems-activities-audit.md` §2.5, which was built on a premise that
measurement has now disproved, and it incorporates the approved stage decisions from
`2026-09-12-deal-stage-mapping.md`.

Every number here is measured, not inferred. `scripts/measure-deal-associations.mjs` is the source.

---

## 0. The correction

The audit's third headline finding said *60% of deals have no associated contact, so the board's
Accounts mirror shows blank for 5,204 of them — therefore build a real Deal→Accounts relation.*

The conclusion was right. **The reasoning was wrong, and it was wrong because it was inferred rather
than measured** — the Service Key was 403 on deals at the time, so Deal→Company was read backwards
off the monday board's mirror column instead of from HubSpot.

Measured now, with the scopes granted:

**98% of deals have a direct Company association that has nothing to do with any contact.**

```
Deal -> companies   8,466 of 8,653 have at least one   (0:187  1:7,926  2:540)
Deal -> contacts    3,449 of 8,653 have at least one   (5,204 have none)
```

`deal_account` was never an approximation of the deal's company. It measures a different thing — the
company of whichever contact happens to be linked — and for the 5,017 deals that have a company but no
contact it shows nothing at all. It is display-only and **not authoritative**.

---

## 1. Measured association cardinality and labels

| direction | deals with ≥1 | with >1 | max | total pairs | labels |
|---|---|---|---|---|---|
| Deal → **Companies** | 8,466 | **540** | 2 | 9,006 | **8,462 carry `Primary`** |
| Deal → **Contacts** | 3,449 | 314 | 9 | 3,812 | **none at all** (type 3, unlabelled) |
| Deal → **Line Items** | 6,347 | **2,527** | 12 | 9,943 | none (type 19, unlabelled) |

Three facts drive the whole design:

1. **`Primary` is real and populated** — 8,462 of the 8,466 deals that have a company. Not the empty
   historical field it might have been. The 540 two-company deals look exactly like
   `[type:341|Primary] [type:341]`, so the label cleanly distinguishes them. Only **4** deals have a
   company and no Primary.
2. **Contacts carry no labels whatsoever.** "Prefer the Primary contact" is not unpopulated, it is
   *impossible*. Any single-selection rule for contacts would have to key on something arbitrary —
   and "the first result the API returns" is not deterministic across calls.
3. **Multiple Line Items are the norm, not an edge case** — 2,527 deals, 29%, with up to 12. A design
   that shows one line item per deal discards data on nearly a third of the board.

---

## 2. Association design: link all, select nothing

**Every HubSpot association becomes a monday link. monday never shows less than HubSpot knows.**

| monday column | type | source | direction |
|---|---|---|---|
| `deal_contact` "Contacts" *(exists)* | board_relation → 5028000495 | Deal→Contact associations, **all of them** | two-way |
| **Accounts** *(create)* | board_relation → 5028000496 | Deal→Company associations, **all of them** | two-way |
| **Line Items** *(create)* | board_relation → 5028000489 | Deal→Line Item associations, **all of them** | two-way |
| **Primary Account** *(create)* | text or single-select mirror of the primary card | the association labelled `Primary` | HubSpot → monday |
| `deal_account` "Accounts" *(existing mirror)* | mirror via `deal_contact` | — | **display only, not authoritative** |

**Why link all rather than select one.** There is no platform constraint forcing a choice: max 2
companies, 9 contacts, 12 line items, in cells that hold ~750 elsewhere on this account. There is no
business constraint stated either. And selecting one reproduces on purpose the failure the
Contacts↔Companies phase spent five rounds eliminating — monday displaying less than HubSpot holds,
with the difference invisible, and a rep re-adding the missing record by hand. That hand-added link
is exactly the id-less manual relation that made the Contacts relation pass dangerous.

`Primary Account` gives the single headline company the Create Deal UI implies, **without discarding
the second one.** The 4 deals with a company but no Primary get an explicit fallback (lowest HubSpot
object id, for determinism) and are **reported by count**, not silently absorbed.

**Removal is never inferred from monday.** A HubSpot association is removed only by an explicit user
action in the app's own remove path, never because monday displays fewer links. This is the
additive-only rule carried over from the Contacts relation pass, and it is one of the two places the
focused tests go.

---

## 3. Stage and pipeline — approved decisions

Full mapping table in `2026-09-12-deal-stage-mapping.md`. Approved shape:

| column | type | direction |
|---|---|---|
| `deal_stage` *(exists)* | status | **HubSpot → monday display only** |
| **Pipeline** *(create)* | dropdown, 5 | two-way |
| **HubSpot Stage** *(create)* | dropdown, 42, pipeline-qualified | two-way |

- Prefixes: `Sales`, `SF-Sales`, `SF-Maint`, `SF-Train`, `Shared`.
- `deal_stage` gains one label: **`Paused`** for `暂停`.
- `Trustpilot邀约评价（已成交）` → **Won**.
- **The reverse write PATCHes `pipeline` and `dealstage` in one call.** HubSpot rejects a stage that
  does not belong to the record's current pipeline, so the stage alone fails while the pipeline still
  holds the old value, and two PATCHes leave a window where the pair is invalid.

This is the second place the focused tests go: a wrong reverse stage write does not fail, it silently
moves a deal into another pipeline — which is what reporting, forecasting and the Won automations all
key off.

---

## 4. Column diff — Deals board 5028000494

Confirmed against the Create Deal UI screenshots: Deal name, Pipeline, Deal stage, Vendors-厂商来源,
Amount, Currency, Close date, Sales User, Deal owner, Deal type, Priority, Contacts, Companies,
Line Item + Quantity.

**KEEP unchanged** — `name`, `subitems`, `custom_mkrmrgz6` (Activities timeline app),
`custom_mknwwj0z` (Quotes & Invoices app), `deal_forecast_value` (formula),
`color_mm1hjwv8` (Forecast categories — no HubSpot counterpart, `hs_forecast_category` does not exist
in this portal), `board_relation_mm6zfen6` (Sales Playbook), `deal_account` (mirror, display only).

**REUSE**

| column | HubSpot | direction | note |
|---|---|---|---|
| `deal_stage` | `dealstage` | → monday | §3 |
| `deal_owner` | `hubspot_owner_id` | two-way | owner-email mapping, as Contacts |
| `deal_value` | `amount` | two-way | |
| `deal_contact` | Deal→Contact associations | two-way | all of them |
| `deal_expected_close_date` | `closedate` | two-way | |
| `deal_close_probability` | `hs_deal_stage_probability` | two-way | **unit mismatch: HubSpot stores 0–1, the column renders `%`. Needs ×100 / ÷100 on both legs or it reads 0.2% for 20%.** |
| `date__1` "Last interaction" | `notes_last_updated` | → monday | HubSpot-computed |

**RETYPE** — create typed column, then delete the empty text stub. monday cannot retype in place; all
stubs are null on all 6 template items, so nothing is lost.

| stub | title | → type | HubSpot | labels |
|---|---|---|---|---|
| `text_mm6tk0kt` | Sales Users | dropdown | `sales_user` | 43 |
| `text_mm6tqv5g` | Deal Pipeline | dropdown | `pipeline` | 5 |
| `text_mm6tqq08` | Vendors | dropdown | `vendorschang_shang_lai_yuan` | **85** — under the 88 verified ceiling, but only just |
| `text_mm6t56f4` | Currency | dropdown | `deal_currency_code` | 5 |
| `text_mm6termq` | Deal Type | dropdown | `dealtype` | 9 |
| `text_mm6tf8hs` | Priority | status | `hs_priority` | 3 |

**DELETE** — `text_mm6tk32c` "Deal name" (the card name already *is* `dealname`),
`text_mm6t5a5x` "Amounts" (duplicate of `deal_value`).

**CREATE** — HubSpot ID (text), HubSpot Link (link), Sync State (text), Pipeline (dropdown),
HubSpot Stage (dropdown), Accounts (board_relation → 5028000496), Line Items (board_relation →
5028000489), Primary Account.

---

## 5. Line Items — board 5028000489

All 13 text stubs map to real `line_items` properties; every enum has unique labels, so Line Items is
**fully two-way**. The board has **0 automations**, so retyping breaks nothing.

**RETYPE / CREATE**: `hs_sku` (text, keep), `description` (long_text, keep), `brand_isv` → dropdown 7
(the existing "Brand ISV" column is **numeric** and cannot hold "Docusign"), `family` → 9 labels (the
existing status holds two monday-template labels that appear nowhere in HubSpot),
`product_subcategory` → dropdown 43, `is_active` → status 2, `note` (text), `service_date` → **date**,
`recurringbillingfrequency` → dropdown 10, `hs_recurring_billing_start_date` → **date**,
`hs_tax_rate_group_id` → dropdown 3 (stores an id, displays a label — the dictionary is mandatory),
`discount` / `price` / `quantity` / `hs_cost_of_goods_sold` / `deposit` → **numbers**,
`hs_line_item_currency_code` → dropdown 5.

Plus HubSpot ID, HubSpot Link, Sync State, and a **Deal** board_relation — the board has no relation
column at all today.

**HubSpot Line Item ID is authoritative.** A line item belongs to one deal; the Deals side carries up
to 12.

---

## 6. Validation budget

Fixed, and deliberately smaller than the Contacts phase because the blast radius is different: that
pass could irreversibly delete a person's data, this one creates cards and fills fields, and a wrong
field is repaired by re-running.

1. ~~Read-only association measurement~~ — **done, this document**
2. Focused automated tests for the two genuinely dangerous behaviours only: **pipeline+stage mapping**
   and **association preservation**, plus Line Item field conversions
3. One complete dry run
4. One small live canary, 20–50 representative deals
5. Historical backfill — **only after the three monday automations are manually disabled**
6. One final verification and sign-off

No further audits, reviewers, or repeated measurements. A failing test is fixed at that layer and that
test re-run, not the cycle restarted.

## 7. Blocking prerequisites

- **HubSpot scopes** — granted and verified 2026-09-14 (`deals` and `line_items` read/write both 200).
- **monday automations 31010010, 31010016, 31010017 must be disabled by a human immediately before the
  historical backfill.** 3,640 deals are Closed Won; leaving them on sends 3,640 "Congratulations!"
  notifications to every board subscriber and creates 3,640 items in board 5028000491. The API cannot
  toggle legacy automations. **Implementation stops and asks before this step.**

Out of scope: Activities and the HubSpot engagement import. monday Emails & Activities stays
authoritative.
