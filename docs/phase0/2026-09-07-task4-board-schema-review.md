# Task 4 — monday CRM board schema quality review

**Date:** 2026-09-07 · **Status:** ⛔ **AWAITING APPROVAL GATE 1 — no board was mutated**
**Method:** live monday API re-query of both boards *including every item's column values*, so each
proposed change carries emptiness evidence. Read-only.

---

## A. The finding that shapes every recommendation

| Board | Columns | Items | Columns holding data | Empty HubSpot-sync text stubs |
|---|---:|---:|---|---:|
| Contacts `5028000495` | 32 | 5 | **6, all native** (email, phone, dropdown, 2× status, long_text) | **19** |
| Accounts `5028000496` | 32 | 3 | **6, all native** (2× link, dropdown, long_text, 2× native CRM text) | **21** |

**Every column that holds data is a native monday CRM column. All 40 hand-added HubSpot-sync text
stubs are completely empty.** Someone scaffolded an intended integration and never populated it.

## B. Sequencing that makes the whole change set non-destructive

The data in those 6 columns per board belongs *only* to the 8 demo/template rows already approved for
deletion. Therefore:

> **Delete the eight demo rows FIRST.** Both boards then hold zero items, every column is provably
> empty, and every retype/delete below stops being a destructive change at all.

That is strictly safer than retyping around live data, and it dissolves the only real migration
question (`employee_count` — see D-2).

---

## C. Contacts board `5028000495`

✱ = currently holds data (demo rows only)

| Current column | Type | Action | Proposed | HubSpot property | Direction | Reason |
|---|---|---|---|---|---|---|
| `name` | name | **KEEP** | display only | — | — | `nameReverse` takes one property; never reverse-parse "First Last" |
| `contact_email` ✱ | email | **KEEP** | native | `email` | two-way | native, populated, and the adoption key |
| `contact_phone` ✱ | phone | **KEEP** | native | `phone` | two-way | preserves leading `+`/zeros; digits compared both sides |
| `numeric_mm6swz9c` | numbers | **DELETE** | — | — | — | duplicate phone; a numbers column destroys `+`/zeros. Empty |
| `text_mm6sab4c` | text | **KEEP** | text | `firstname` | two-way | empty, correct type |
| `text_mm6snp6r` | text | **KEEP** | text | `lastname` | two-way | empty, correct type |
| `12849070_last_name` | text | **DELETE** | — | — | — | duplicate last name. Empty |
| `text_mm6szy4q` | text | **KEEP** | text | `jobtitle` | two-way | free text matches HubSpot |
| `title5` ✱ | dropdown (3) | **KEEP, UNMAPPED** | — | — | — | CEO/COO/CIO cannot represent free-text `jobtitle`; native + populated |
| `text_mm6sdvkq` | text | **KEEP** | text | `company` | **forward-only** | HubSpot free-text `company`, NOT the association |
| `text_mm6s7db3` | text | **CREATE + retire** | **people** "Contact Owner" | `hubspot_owner_id` | `appReverse` | F1: no people column exists; required for owner safety |
| `text_mm6sakj3` | text | **CREATE + retire** | **people** "Sales Users" | `sales_user` | two-way | F1 |
| `text_mm6tqwyw` | text | **RETYPE** | **status** (8 opts) | `hs_lead_status` | two-way | 8 clean internal values; WM's proven map reused |
| `text_mm6sc26t` | text | **KEEP** | text | `leadsource` | **forward-only** | ~210 mostly-legacy options; unusable as a dropdown |
| `text_mm6s40ew` | text | **RETYPE** | **dropdown** (88) | `manufacturer__c` | two-way | real working vocabulary; needs label↔value inversion |
| `text_mm6sdc3b` | text | **RETYPE** | **date** | `createdate` | forward-only | it is a date; also the ownership fallback |
| `text_mm6tmzgq` | text | **RETYPE** | **date** | `notes_last_updated` | forward-only | it is a date |
| `text_mm6t71dj` | text | **KEEP** | text | HubSpot ID | internal | ids match as strings; text is safer than numbers |
| `text_mm6twy4w` | text | **KEEP** | text | Sync State | internal | correct as-is |
| `text_mm6t8x04` | text | **RETYPE** | **link** | HubSpot record URL | internal | a clickable record link is the point |
| `text_mm6t40d7` | text | **DELETE** | — | — | — | purpose unclear, duplicates HubSpot ID. Empty |
| `text_mm6twb9d` | text | **DELETE** | — | — | — | superseded by native `contact_account`. Empty |
| `text_mm6t592a` | text | **DELETE** | — | — | — | superseded by native `contact_deal`. Empty |
| `text_mm6t8bxb` | text | **KEEP** | — | `event_name` *(rev. 2)* | business call | "Event Name": HubSpot `event_name` verified free text; already the right column type |
| `contact_account` | board_relation | **KEEP** | — | — | — | native; reserved for a later phase |
| `contact_deal` | board_relation | **KEEP** | — | — | — | native; Deals out of scope |
| `status` ✱ | status (5) | **KEEP, UNMAPPED** | — | — | — | "Type" (Lead/Customer/…): possible `lifecyclestage` later |
| `status5` ✱ | status (3) | **KEEP, UNMAPPED** | — | — | — | "Priority": no HubSpot counterpart |
| `long_text4` ✱ | long_text | **KEEP, UNMAPPED** | — | — | — | "Comments": no counterpart chosen |
| `mirror2` | mirror | **NEVER TOUCH** | — | — | — | computed, read-only |
| `custom_mkrm9y8c` | unsupported | **NEVER TOUCH** | — | — | — | proprietary Activities timeline |
| `subtasks_mkvpdgxr` | subtasks | **NEVER TOUCH** | — | — | — | native subitems |

---

## D. Accounts board `5028000496`

Identity resolved first, since four columns competed:

| Purpose | Column |
|---|---|
| display item name | `name` (display only) |
| HubSpot `name` | `text_mm6t1q4h` |
| HubSpot `domain` **and the adoption key** | `company_domain` (native link) |

| Current column | Type | Action | Proposed | HubSpot property | Direction | Reason |
|---|---|---|---|---|---|---|
| `name` | name | **KEEP** | display only | — | — | never reverse-parsed |
| `text_mm6t1q4h` | text | **KEEP** | text | `name` | two-way | empty, correct type |
| `company_domain` ✱ | link | **KEEP** | native | `domain` | two-way | native, populated, **adoption key** |
| `text_mm6tyx9z` | text | **DELETE** | — | — | — | duplicate of `company_domain`. Empty |
| `industry` ✱ | dropdown (47) | **KEEP, UNMAPPED** | — | — | — | **F9**: Crunchbase taxonomy vs HubSpot's; only 8/47 labels match. Native + populated → leave alone |
| `text_mm6tafj5` | text | **KEEP** | text | `industry` | **forward-only** | the approved text representation (empty stub) |
| `company_description` ✱ | long_text | **KEEP** | native | `description` | two-way | native; long_text is right for prose |
| `text_mm6thg86` | text | **DELETE** | — | — | — | duplicate description. Empty |
| `employee_count` ✱ | text | **KEEP AS-IS (rev. 2, see D-2)** | — | `numberofemployees` | **one-way** | native; forward round-trip proven safe through text, reverse proven unsafe. Not retyped |
| `text_mm6t68sz` | text | **DELETE** | — | — | — | duplicate employee count. Empty |
| `text_mm6t4jp` | text | **RETYPE** | **numbers** | `annualrevenue` | two-way | it is a quantity |
| `text_mm6tdrdn` | text | **KEEP** | text | `city` | two-way | correct |
| `text_mm6t5tv` | text | **KEEP** | text | `state` | two-way | correct |
| `text_mm6t7ha4` | text | **KEEP** | text | `zip` | two-way | correct |
| `headquarters_loc` ✱ | text | **KEEP, UNMAPPED** | — | — | — | native + populated; overlaps City/State — pick one model |
| `text_mm6tghg4` | text | **RETYPE** | **status** (16) | `type` | two-way | 16 options, manageable |
| `text_mm6t6w6n` | text | **RETYPE** | **status** (27) | `partner_with` | **forward-only** | matches production's direction |
| `text_mm6t8r57` | text | **RETYPE** | **link** | `linkedin_company_page` | two-way | it is a URL |
| `text_mm6tys5f` | text | **KEEP** | text | `timezone` | forward-only | read-only in production too |
| `text_mm6t7rpd` | text | **RETYPE** | **date** | `createdate` | forward-only | it is a date; ownership fallback |
| `text_mm6t638` | text | **CREATE + retire** | **people** "Company Owner" | `hubspot_owner_id` | `appReverse` | F1 |
| `text_mm6twxwe` | text | **CREATE + retire** | **people** "Sales Users" | `sales_user` | two-way | F1 |
| `text_mm6tsnwx` | text | **KEEP** | text | HubSpot ID | internal | ids match as strings |
| `text_mm6tccd0` | text | **KEEP** | text | Sync State | internal | correct as-is |
| `text_mm6t1n5g` | text | **RETYPE** | **link** | HubSpot record URL | internal | clickable link |
| `text_mm6tvb8q` | text | **DELETE** | — | — | — | redundant "HubSpot Contact". Empty |
| `text_mm6t5nqt` | text | **DELETE** | — | — | — | superseded by native `account_contact`. Empty |
| `company_profile` ✱ | link | **KEEP, UNMAPPED** | — | — | — | native + populated; purpose unclear — ask the business |
| `account_contact` | board_relation | **KEEP** | — | — | — | native; later phase |
| `account_deal` | mirror | **NEVER TOUCH** | — | — | — | computed |
| `custom_mkrm3gkw` | unsupported | **NEVER TOUCH** | — | — | — | proprietary |
| `subtasks_mm65mrb7` | subtasks | **NEVER TOUCH** | — | — | — | native |

### D-2 — `employee_count` — SETTLED (rev. 2, 2026-09-07): reuse the native column, one-way

It is a **native** monday CRM column, type `text`, and the business direction is to keep native columns
and delete hand-added duplicates. Superseding the original "retype it to numbers" recommendation, the
question was made **empirical**: can HubSpot `numberofemployees` (verified `type: number`) round-trip
through a monday *text* column using the current mapper? Evidence —
`worker/test/employee-count-roundtrip.test.ts`, 15 assertions against the real
`formatValue`/`expectedText`/`fieldDiffs`/`reverseFieldValue`:

| Direction | Result | Why |
|---|---|---|
| **HubSpot → monday** | ✅ **safe** | `formatValue` emits the *identical* bare string for `text` and `numbers` (`"500"`), so a text column needs no different payload |
| **Diff stability** | ✅ **safe** | `fieldDiffs` raises no diff once the column holds HubSpot's own value — no phantom-diff loop |
| **Formatting edge** | ⚠️ **self-healing** | `text` compares raw where `numbers` normalizes via `Number()`, so HubSpot `"500.0"` vs a column holding `"500"` diffs once; the forward write then stores HubSpot's own string and it stops. Only persists if something *other* than this sync writes a differently-formatted value — and both boards are currently empty |
| **monday → HubSpot** | ❌ **unsafe** | `reverseFieldValue` passes free text straight through — `"approx 500"`, `"500-1000"`, `"50+"`, `"1,500"`, `"unknown"`, `"N/A"` all verified — and the target property is a HubSpot **number**, so each is a 400 on every tick. A monday *text* column has no numeric validation to prevent the entry; the protection would be the column **type**, not the mapper |

**Decision:** map `numberofemployees` → native `employee_count` **one-way (HubSpot → monday)**, leave the
native column's type alone, and **delete** the empty duplicate `text_mm6t68sz`. This satisfies both the
"keep native columns" and the "remove duplicate fields" directions, and avoids showing reps two
employee-count columns. A dedicated numeric column becomes necessary only if two-way employee count is
ever required — that is the trigger to revisit, not now.

---

## E. Change set split by risk

### Tier 1 — safe / non-destructive (create + rename)

4 columns created, no data touched:

| Board | Create |
|---|---|
| Contacts | **people** "Contact Owner", **people** "Sales Users" |
| Accounts | **people** "Company Owner", **people** "Sales Users" |

Renames: group `new_group95562` → "Inactive Contacts (not synced)" **(already applied)**. Also
recommended — rename the redundant Accounts group `group_mm6t6ear` "Accounts/companies" to something
like "Unsorted (not synced)", because `singleGroup: "topics"` means the engine will pull cards back
out of it, and a group that silently rejects cards is worse than one that says so.

### Tier 2 — REUSE / REPLACE / DELETE / DEFER (rev. 2, 2026-09-07) — EXPLICIT APPROVAL EACH

Revised from "21 stubs, one deletion batch". Business guidance: **preserve monday's native CRM columns,
remove hand-added duplicates, prefer native relations, clean duplicate phone and title/type stubs.**

**Two standing caveats.**

1. **Emptiness evidence is now historical.** Both boards hold **0 items** (the 8 demo rows were deleted
   under gate 1), so a fresh filled-count proves nothing. Every `filled` figure below comes from
   `docs/phase0/2026-09-07-pre-change-board-snapshot.json`, captured while the demo rows existed. That
   snapshot is the evidence of record.
2. **Two columns were already deleted by hand** (team lead, outside this session). Live re-query
   2026-09-07: Contacts is now **31 columns** — `text_mm6twb9d` "Associated Company" and
   `text_mm6t592a` "Associated Deal" are gone, replaced by the native `contact_account` /
   `contact_deal` board_relations. Accounts is untouched at **33 columns**.

#### Contacts — board 5028000495

| Column ID | Title | Type | Class | Action | Replacement / evidence |
|---|---|---|---|---|---|
| `contact_email` | Email | email | **REUSE** | map `email` | native, 3/3 filled |
| `contact_phone` | Phone | phone | **REUSE** | map `phone` | native, 3/3 filled |
| `contact_account` | Accounts | board_relation | **REUSE** | company link | native relation |
| `contact_deal` | Deals | board_relation | **REUSE** | deal link | native relation |
| `text_mm6t8x04` | HubSpot Link | text | **REPLACE** | retype → **link** | engine `linkCol` requires link; no native equivalent; 0 filled |
| `text_mm6sdc3b` | Created date | text | **REPLACE** | retype → **date** | one-way `createdate`; 0 filled |
| `text_mm6tqwyw` | Lead Status | text | **REPLACE** | retype → **status** | `hs_lead_status`, verified enumeration, **8 options** (New / Open / In Progress / Open Deal / Unqualified / Attempted to Contact / Connected / Bad Timing); 0 filled |
| `numeric_mm6swz9c` | Phone Number | numbers | **DELETE** | — | duplicate of native `contact_phone` (3/3). Also the wrong type — a numbers column drops a leading `+`/`0` |
| `12849070_last_name` | Last name | text | **DELETE** | — | triplicate; the mapped pair is `text_mm6sab4c` "First name" + `text_mm6snp6r` "Last Name". The `12849070_` prefix is an old import artifact; 0 filled |
| `text_mm6t40d7` | HubSpot Contact | text | **DELETE** | — | redundant against `text_mm6t71dj` "HubSpot ID" (`idCol`) + `text_mm6t8x04`; 0 filled |
| `text_mm6s7db3` | Contact Owner | text | **DELETE** | — | **replacement verified**: `multiple_person_mm6zap53` "Contact Owner (synced)" (people), created + verified under gate 1 |
| ~~`text_mm6twb9d`~~ | Associated Company | — | **DONE** | deleted by lead | native `contact_account` |
| ~~`text_mm6t592a`~~ | Associated Deal | — | **DONE** | deleted by lead | native `contact_deal` |
| `text_mm6tmzgq` | Last Activity Date | text | **DEFER** | keep as-is | ⚠️ **needed by R-1**, the 24-hour follow-up reminder. Not a duplicate; no native equivalent. Do not retype until the driving HubSpot property is confirmed |
| `text_mm6s40ew` | Vendors-厂商来源 | text | **DEFER** | keep as-is | maps to `manufacturer__c` (verified: enumeration, **89 options**, numeric-prefixed e.g. `38Intercom`). Approved two-way, but 89 dropdown options is a schema decision of its own |
| `text_mm6sakj3` | Sales Users | text | **DEFER** | keep as-is | business unresolved in the meeting. Empty, harmless, and **never used for CRM scope** |
| `text_mm6t8bxb` | Event Name | text | **DEFER** → REUSE | keep as-is | **audit correction:** this DOES have a HubSpot counterpart — `event_name`, verified `type: "string"` (free text). The audit's open question G ("no HubSpot counterpart") was wrong. Text is already the right type |
| `text_mm6szy4q` / `title5` | Job Title / Title | text / dropdown | **DEFER** | business call | HubSpot `jobtitle` is verified **free text**; native `title5` is a fixed dropdown (3/3 filled). The *stub* is the correct type here — deleting the wrong one either loses data or explodes the dropdown |
| `status` | Type | status | **DEFER** | business call | Lead/Customer/Vendor/Qualified Lead/Partner, 3/3 → `lifecyclestage` (exists) in a later phase? Open question G |

#### Accounts / Companies — board 5028000496

| Column ID | Title | Type | Class | Action | Replacement / evidence |
|---|---|---|---|---|---|
| `employee_count` | No. of employees | text | **REUSE** | map `numberofemployees` **one-way**, column untouched | ⬅️ **rev. 2.** Round-trip proven safe forward by `worker/test/employee-count-roundtrip.test.ts`; reverse is unsafe (see D-2 rev. 2). Native column kept, not retyped |
| `company_domain` | Domain | link | **REUSE** | company **adoption key** | native, 3/3 filled |
| `industry` | Industry | dropdown | **REUSE** | **KEEP UNMAPPED** | ⬅️ **rev. 2.** native, 3/3. HubSpot company `industry` is an enumeration of **~250** options (English + a parallel Chinese taxonomy + heavy near-duplication) vs monday's 47, 8 matching (F9). Forward-only does not fix a vocabulary mismatch, and `create_labels_if_missing` would contaminate monday's native vocabulary. Preserved for monday-side use |
| `company_description` | Description | long_text | **REUSE** | map `description` | native, 3/3 filled |
| `account_contact` | Contacts | board_relation | **REUSE** | contact link | native relation |
| `text_mm6tafj5` | Industry | text | **REUSE** | **rename → "Industry (HubSpot)"**, map `industry` **HubSpot→monday only** | ⬅️ **rev. 2 — was DELETE.** The correct home for HubSpot's taxonomy, already the right type and already empty. Matches plan Task 7, which always specified `{ hs: "industry", col: "text_mm6tafj5", type: "text" }` |
| `text_mm6t4jp` | Annual Revenue | text | **REPLACE** | retype → **numbers** | `annualrevenue`, verified `type: number`; 0 filled |
| `text_mm6tghg4` | Type | text | **REPLACE** | retype → **status** | `type`, verified enumeration, **16 options**; 0 filled |
| `text_mm6t6w6n` | Partner With | text | **REPLACE** | retype → **status** | `partner_with`, verified enumeration, **27 options**; forward-only; 0 filled |
| `text_mm6t8r57` | LinkedIn company page | text | **REPLACE** | retype → **link** | `linkedin_company_page`; 0 filled |
| `text_mm6t7rpd` | Created date | text | **REPLACE** | retype → **date** | one-way `createdate`; 0 filled |
| `text_mm6t1n5g` | HubSpot Link | text | **REPLACE** | retype → **link** | engine `linkCol`; 0 filled |
| `text_mm6t68sz` | Number Of Employees | text | **DELETE** | — | ⬅️ **rev. 2 — was REPLACE→numbers.** No longer needed: native `employee_count` carries it one-way. Empty duplicate of a native column, exactly the class the business asked to remove; 0 filled |
| `text_mm6tyx9z` | Company domain name | text | **DELETE** | — | duplicate of native `company_domain` (link, 3/3), which must be the adoption key; 0 filled |
| `text_mm6thg86` | Description | text | **DELETE** | — | duplicate of native `company_description` (3/3); 0 filled |
| `text_mm6t638` | Company Owner | text | **DELETE** | — | **replacement verified**: `multiple_person_mm6z8mwy` "Company Owner (synced)", created + verified under gate 1 |
| `text_mm6tvb8q` | HubSpot Contact | text | **DELETE** | — | redundant against `text_mm6tsnwx` "HubSpot ID"; 0 filled |
| `text_mm6t5nqt` | Associated Contact | text | **DELETE** | — | duplicate of native `account_contact` — the same class the lead deleted by hand on Contacts; 0 filled |
| `text_mm6twxwe` | Sales Users | text | **DEFER** | keep as-is | unresolved, as on Contacts |
| `headquarters_loc` | Headquarters location | text | **DEFER** | business call | native, 3/3 — keep, or standardise on City/State/Postal? (question G) |
| `company_profile` | Company profile | link | **DEFER** | business call | native, 3/3 — how does it differ from `company_domain`? (question G) |

**Totals (corrected):** **9 REPLACE** · **10 DELETE** · 8 REUSE · 8 DEFER · 2 already done by the lead.
*(The rev. 2 summary line first said 11/9 — an arithmetic slip in the summary only; the itemised rows
were always 9 and 10. Verified against the executed operations below.)*

> **Structural finding — no native Deal relation on Accounts.** On Accounts, "Deals" is `account_deal`,
> a **mirror**, not a `board_relation` (it resolves through `account_contact`). So "prefer the native
> Associated Deal relation" is available on Contacts but **not** on Accounts. If Accounts needs a direct
> Deal link later, that is a new native relation to create — not a stub to reuse.

> **Execution order within Tier 2:** every REPLACE (retype) and the `text_mm6tafj5` rename first, verify,
> then the DELETEs. Re-query both boards and confirm each column id immediately before touching it.

---

## H. Task 5 — EXECUTED 2026-09-07. Both boards: 27 columns, 0 items.

### H-1. Two platform findings that changed the mechanism

**1. monday cannot retype a column.** There is no `change_column_type` mutation. `update_column` accepts
a `column_type` argument, but supplying it for a type change returns
`INVALID_INPUT / "column type mismatch"` (probed on `text_mm6t7rpd`; the column was left unmodified).
**So every REPLACE is create-new-correctly-typed + delete-old-stub, and the stub's column ID does not
survive.** Net board state is identical to what was approved; only the mechanism differs. Consequence:
19 delete operations were performed (10 approved DELETEs + the 9 replaced stubs), and Tasks 6-7 must use
the new IDs in H-2, not the old `text_mm6t*` ones.

**2. monday status columns cannot hold 27 labels.** Seeding `partner_with`'s 27 options into a `status`
column returns a bare `500 INTERNAL_SERVER_ERROR`. Probed: 16 labels ✅ (the `Type` column), 20 / 24 /
26 / 27 all ❌. `create_dropdown_column` with `defaults: { labels: [{label}], limit_select: true }`
accepted all 27 and stored them. **`partner_with` is therefore a `dropdown`, not a `status`** — a
platform limit, not a preference. It is also the safer type: `reverseFieldValue`'s dropdown branch
validates each label against the inverted dict and **stops on an unknown label** (`reconcile.ts:137-138`),
whereas the status/text branch falls through raw (`rev[text] ?? text`, `reconcile.ts:144`) and would
send an unmapped monday label straight to a HubSpot enum.

### H-2. Old → new column IDs (REPLACE)

| Board | Old stub (deleted) | New column | Type | Title | Labels seeded |
|---|---|---|---|---|---|
| Contacts | `text_mm6t8x04` | **`link_mm6z7mj`** | link | HubSpot Link | — |
| Contacts | `text_mm6sdc3b` | **`date_mm6z33nk`** | date | Created date | — |
| Contacts | `text_mm6tqwyw` | **`color_mm6zb4tc`** | status | Lead Status | **8**, exact `hs_lead_status` labels |
| Accounts | `text_mm6t4jp` | **`numeric_mm6zj731`** | numbers | Annual Revenue | — |
| Accounts | `text_mm6tghg4` | **`color_mm6zwhwt`** | status | Type | **16**, exact company `type` labels |
| Accounts | `text_mm6t6w6n` | **`dropdown_mm6zd1ge`** | **dropdown** | Partner With (HubSpot) | **27**, exact `partner_with` labels, `limit_select` |
| Accounts | `text_mm6t8r57` | **`link_mm6z41s3`** | link | LinkedIn company page | — |
| Accounts | `text_mm6t7rpd` | **`date_mm6zmtf8`** | date | Created date | — |
| Accounts | `text_mm6t1n5g` | **`link_mm6zyad8`** | link | HubSpot Link | — |

Label seeding means the ctx dict maps HubSpot value → an already-existing monday label, so **no
`create_labels_if_missing` is needed at runtime** for any of these three.

### H-3. Renamed (ID preserved)

`text_mm6tafj5` "Industry" → **"Industry (HubSpot)"** (Accounts). Still `text`, still empty, still the
only industry field the sync writes. Native `industry` dropdown untouched and unmapped.

### H-4. Deleted (19 total)

**Approved DELETEs (10).** Contacts: `numeric_mm6swz9c`, `12849070_last_name`, `text_mm6t40d7`,
`text_mm6s7db3`. Accounts: `text_mm6t68sz`, `text_mm6tyx9z`, `text_mm6thg86`, `text_mm6t638`,
`text_mm6tvb8q`, `text_mm6t5nqt`.
**Replaced stubs (9).** The nine "old stub" IDs in H-2.

Every deletion was gated on a live re-query immediately beforehand asserting the column's **exact title
and type**, membership of a hard-coded allowlist, and **board item count == 0**. A mismatch aborted the
run rather than guessing. No native, mirror, `board_relation`, `subtasks`, `unsupported` or people
column was touched.

### H-5. Groups (unchanged, confirmed)

Both boards sync into group **`topics`** — Contacts "Active Contacts", Accounts "Companies". The
not-synced groups are Contacts `new_group95562` and Accounts `group_mm6t6ear`.

### H-6. Nothing behaved unexpectedly beyond H-1

The retype refusal and the 27-label 500 are recorded above; both were caught by probing before any
destructive step. Two scratch probe columns were created during isolation and **both deleted** —
verified absent in the final schema. One incidental note: the `mq.py` helper raises `SystemExit`, not
`Exception`, so an early probe's `except Exception` did not catch a GraphQL error; it aborted safely
rather than continuing blind, and the 5 already-created IDs were recovered from the live board and
re-verified before the run resumed.

### H-7. Deferred fields — confirmed still present, untouched

Contacts: `text_mm6tmzgq`, `text_mm6s40ew`, `text_mm6sakj3`, `text_mm6t8bxb`, `text_mm6szy4q`,
`title5`, `status`. Accounts: `text_mm6twxwe`, `headquarters_loc`, `company_profile`, `employee_count`,
`industry`. **No Sales Users column created. Board permissions unchanged** (`everyone` / `public`).

### Never touched

`mirror2`, `account_deal`, `custom_mkrm9y8c`, `custom_mkrm3gkw`, both `subtasks_*`, both `name`, and
the populated native columns `title5`, `status`, `status5`, `long_text4`, `industry`,
`company_profile`, `headquarters_loc`, `contact_email`, `contact_phone`, `company_domain`,
`company_description`.

---

## F. Recommended order of operations

1. **Delete the 8 demo rows** — approved, conditional on re-verifying empty HubSpot ID **and** Sync
   State immediately before. If any is linked: stop and report.
2. **Tier 1 creates + the Accounts group rename** — additive and reversible.
3. **Tier 2 REPLACEs** — retypes on provably-empty columns, plus the `text_mm6tafj5` → "Industry (HubSpot)" rename. **`employee_count` is NOT retyped** (rev. 2, D-2).
4. **Tier 2 deletes** — last, once the replacements exist and are verified.
5. Re-query both boards, record the real new column ids, then proceed to Tasks 6-7.

## G. Open questions for the business (not blocking)

- ~~**`text_mm6t8bxb` "Event Name"** (Contacts) — what is it for? No HubSpot counterpart.~~
  **RESOLVED 2026-09-07 (correction):** it *does* have one — HubSpot contact `event_name`, verified
  `type: "string"` (free text), and it appears on the HubSpot Create Contact form the reps use. The
  original "no HubSpot counterpart" finding was wrong. The monday column is already the right type;
  what remains is the business question of whether Phase 1 should map it.
- **`company_profile`** (Accounts, populated) — how does it differ from `company_domain`?
- **`headquarters_loc`** (Accounts, populated) — keep it, or standardise on City/State/Postal code?
- **`status` "Type"** (Contacts: Lead/Customer/Vendor/Qualified Lead/Partner) — map to
  `lifecyclestage` in a later phase, or leave unmapped permanently?

---

**⛔ APPROVAL GATE 1. Nothing above has been executed. No monday board was mutated by this review.**
