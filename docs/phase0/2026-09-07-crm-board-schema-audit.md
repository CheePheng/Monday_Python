# Phase 0 — monday CRM board schema audit

**Date:** 2026-09-07 · **Branch:** `feat/monday-crm-sync` · **Base:** `8088e94`
**Method:** live monday GraphQL API (2026-07), read-only. No board was modified.

**Status:** monday side **COMPLETE**. HubSpot side **BLOCKED** — see §6.

---

## 1. Verified baseline

| | Result |
|---|---|
| worker `tsc --noEmit` | CLEAN |
| worker tests | **340 passed** (20 files) |
| monday-app `npm run build` | CLEAN |
| monday-app tests | **195 passed** (29 files) |

Matches the expected clean base exactly.

---

## 2. Boards

| Board | ID | Items | Groups |
|---|---|---|---|
| Contacts | `5028000495` | 5 | `topics` = "Active Contacts" · `new_group95562` = "Inactive Contacts" |
| Accounts/Companies | `5028000496` | 3 | `topics` = "Companies" · `group_mm6t6ear` = "Accounts/companies" |

**Related boards discovered (out of Phase 1 scope, recorded for later):**

- `5028000494` — CRM **Deals** board (target of `contact_deal`)
- `5028000498` — Contacts subitems
- `5030578011` — Accounts subitems

---

## 3. Headline findings

**F1 — Neither CRM board has a people column.** Contact Owner, Sales Users (Contacts) and Company Owner, Sales Users (Accounts) are all **text**. The `appReverse` owner-safety mechanism requires a real people column to resolve a monday user → HubSpot owner id. **Phase 0 must CREATE people columns on both boards.** This is not a retype — the columns don't exist.

**F2 — Both boards carry a parallel set of text "HubSpot sync" stubs** that duplicate native CRM columns. Contacts has ~11; Accounts has ~10. Someone scaffolded an intended integration by hand. Most should be dropped in favour of native columns.

**F3 — The `industry` dropdown on Accounts already holds HubSpot-shaped values** ("Financial Services", "Lending and Investments", "Software", "Administrative Services", "Advertising", "Agriculture and …"). Strong candidate for a direct enum mapping to HubSpot `industry`.

**F4 — `title5` (dropdown: CEO / COO / CIO) conflicts with `text_mm6szy4q` "Job Title".** HubSpot `jobtitle` is free text, so a 3-option dropdown cannot represent it. Use the text column; leave `title5` unmapped.

**F5 — `status` "Type" (Lead / Customer / Vendor / Qualified Lead / Partner)** looks like a lifecycle concept. Possible HubSpot `lifecyclestage` mapping, but the value sets differ — **decision required, and I recommend deferring it past Phase 1.**

**F6 — `status5` "Priority" (Medium / High / Low)** has no obvious HubSpot Contact counterpart. Leave unmapped.

**F7 — Read-only columns confirmed:** `account_deal` and `mirror2` are **mirror** type; `custom_mkrm3gkw` / `custom_mkrm9y8c` ("Activities timeline") report as **`unsupported`** (monday CRM proprietary). Never write to any of these.

---

## 4. Contacts board `5028000495` — proposal

| Column | id | Type | Proposal |
|---|---|---|---|
| Name (item) | `name` | name | **DISPLAY ONLY** — `nameReverse` takes a single property, so never reverse-parse "First Last" |
| First name | `text_mm6sab4c` | text | **KEEP** → HubSpot `firstname` (two-way) |
| Last Name | `text_mm6snp6r` | text | **KEEP** → HubSpot `lastname` (two-way) |
| Last name | `12849070_last_name` | text | **DELETE** — duplicate of the above (verify empty first) |
| Email | `contact_email` | email | **KEEP (native)** → `email`. Identity/adoption key; never clearable |
| Job Title | `text_mm6szy4q` | text | **KEEP** → `jobtitle` |
| Title | `title5` | dropdown | **UNMAPPED** — 3 options can't represent free-text `jobtitle` (F4) |
| Phone | `contact_phone` | phone | **KEEP (native)** → `phone`, digits-normalised both sides |
| Phone Number | `numeric_mm6swz9c` | numbers | **DELETE** — a numbers column destroys leading `+`/zeros and breaks the phone-loop invariant |
| Company name | `text_mm6sdvkq` | text | **KEEP, FORWARD-ONLY** → HubSpot free-text `company` (not the association — same trap as the WM board) |
| Contact Owner | `text_mm6s7db3` | text | **CREATE a `people` column**; retire this stub (F1). `appReverse` only |
| Sales Users | `text_mm6sakj3` | text | **CREATE a `people` column**; retire this stub (F1) |
| Lead Status | `text_mm6tqwyw` | text | **RETYPE → status/dropdown** with explicit label↔internal-value mapping for `hs_lead_status`, or forward-only |
| Contact Source | `text_mm6sc26t` | text | **RETYPE → dropdown** for `leadsource` (enum), or forward-only |
| Vendors | `text_mm6s40ew` | text | **RETYPE → dropdown** for `manufacturer__c` (enum), or forward-only |
| Created date | `text_mm6sdc3b` | text | **RETYPE → date**, forward-only (`createdate`) |
| Last Activity Date | `text_mm6tmzgq` | text | **RETYPE → date**, forward-only |
| HubSpot ID | `text_mm6t71dj` | text | **KEEP text** — engine matches ids as strings; text is safer than numbers |
| Sync State | `text_mm6twy4w` | text | **KEEP text** |
| HubSpot Link | `text_mm6t8x04` | text | **RETYPE → link** if a clickable record link is wanted, else DELETE |
| HubSpot Contact | `text_mm6t40d7` | text | **DELETE** — purpose unclear, appears redundant (verify empty) |
| Associated Company | `text_mm6twb9d` | text | **DELETE** — use native `contact_account` when associations land |
| Associated Deal | `text_mm6t592a` | text | **DELETE** — use native `contact_deal` when Deals land |
| Accounts | `contact_account` | board_relation → `5028000496` | **KEEP** — reserved for a later phase, unused in Phase 1 |
| Deals | `contact_deal` | board_relation → `5028000494` | **KEEP** — out of Phase 1 scope |
| Type | `status` | status | **UNMAPPED in Phase 1** (F5) |
| Priority | `status5` | status | **UNMAPPED** (F6) |
| Comments | `long_text4` | long_text | **UNMAPPED** — no HubSpot counterpart chosen |
| Event Name | `text_mm6t8bxb` | text | **UNMAPPED** — clarify purpose with the business |
| Deals value | `mirror2` | mirror | **NEVER WRITE** |
| Activities timeline | `custom_mkrm9y8c` | unsupported | **NEVER WRITE** |
| Subitems | `subtasks_mkvpdgxr` | subtasks → `5028000498` | out of scope |

---

## 5. Accounts board `5028000496` — proposal

Identity decision first, because four columns compete:

| Purpose | Use | Rejected |
|---|---|---|
| Display item name | `name` (**display only**) | — |
| HubSpot `name` | `text_mm6t1q4h` "Company Name" | `name` (would need reverse-parsing) |
| HubSpot `domain` | **`company_domain`** (link, native) | `text_mm6tyx9z` "Company domain name" (text stub) |
| **Adoption key** | normalized `domain` | never the company name (F8 below) |

**F8 — never adopt a Company by name.** "ABC Trading", "ABC Trading Sdn Bhd" and "ABC Trading Malaysia" are distinct records. Domain only.

| Column | id | Type | Proposal |
|---|---|---|---|
| Name (item) | `name` | name | **DISPLAY ONLY** |
| Company Name | `text_mm6t1q4h` | text | **KEEP** → `name` (two-way) |
| Domain | `company_domain` | link | **KEEP (native)** → `domain`; adoption key |
| Company domain name | `text_mm6tyx9z` | text | **DELETE** — duplicate of `company_domain` |
| Industry | `industry` | dropdown | **KEEP (native)** → `industry`; values already HubSpot-shaped (F3) |
| Industry | `text_mm6tafj5` | text | **DELETE** — duplicate stub |
| Description | `company_description` | long_text | **KEEP (native)** → `description` |
| Description | `text_mm6thg86` | text | **DELETE** — duplicate stub |
| No. of employees | `employee_count` | text | **RETYPE → numbers** → `numberofemployees` |
| Number Of Employees | `text_mm6t68sz` | text | **DELETE** — duplicate stub |
| Annual Revenue | `text_mm6t4jp` | text | **RETYPE → numbers** → `annualrevenue` |
| City | `text_mm6tdrdn` | text | **KEEP** → `city` |
| State/Region | `text_mm6t5tv` | text | **KEEP** → `state` |
| Postal code | `text_mm6t7ha4` | text | **KEEP** → `zip` |
| Headquarters location | `headquarters_loc` | text | **UNMAPPED** — overlaps City/State; pick one model |
| LinkedIn company page | `text_mm6t8r57` | text | **RETYPE → link** → `linkedin_company_page` |
| Company profile | `company_profile` | link | **UNMAPPED** — clarify purpose |
| Type | `text_mm6tghg4` | text | **RETYPE → status/dropdown** for HubSpot `type` (enum), or forward-only |
| Partner With | `text_mm6t6w6n` | text | **RETYPE → dropdown** for `partner_with` (enum), or forward-only |
| Time zone | `text_mm6tys5f` | text | **FORWARD-ONLY** (read-only in the WM spec too) |
| Created date | `text_mm6t7rpd` | text | **RETYPE → date**, forward-only |
| Company Owner | `text_mm6t638` | text | **CREATE a `people` column**; retire stub (F1) |
| Sales Users | `text_mm6twxwe` | text | **CREATE a `people` column**; retire stub (F1) |
| HubSpot ID | `text_mm6tsnwx` | text | **KEEP text** |
| Sync State | `text_mm6tccd0` | text | **KEEP text** |
| HubSpot Link | `text_mm6t1n5g` | text | **RETYPE → link** or DELETE |
| HubSpot Contact | `text_mm6tvb8q` | text | **DELETE** — redundant (verify empty) |
| Associated Contact | `text_mm6t5nqt` | text | **DELETE** — use native `account_contact` |
| Contacts | `account_contact` | board_relation → `5028000495` | **KEEP** — later phase |
| Deals | `account_deal` | mirror | **NEVER WRITE** |
| Activities timeline | `custom_mkrm3gkw` | unsupported | **NEVER WRITE** |
| 子项目 | `subtasks_mm65mrb7` | subtasks → `5030578011` | out of scope |

---

## 6. BLOCKED — HubSpot schema discovery

The other half of Phase 0 (HubSpot Contact/Company property schemas → the direction/normalization/adoption mapping table) **cannot proceed from this machine.**

Verified absent: no `HUBSPOT_ACCESS_TOKEN` in the environment, no `worker/.dev.vars`, no `.env`. The repo's POC tools (`hubspot_smoke_test.py`, `owner_router_test.py`) read `HUBSPOT_ACCESS_TOKEN` from the environment. The live token exists only as a Cloudflare Worker secret.

**One of these unblocks it:**

1. Set `HUBSPOT_ACCESS_TOKEN` in the environment for a read-only schema pull (needs `crm.schemas.contacts.read` / `crm.schemas.companies.read`), **or**
2. Provide the Worker's `TRIGGER_SECRET` so the existing `/app/contact-schema` and `/app/company-schema` endpoints can be called, **or**
3. Paste the property lists from HubSpot Settings → Properties (internal names + types for Contacts and Companies).

Option 1 is best — it also lets Phase 0 verify enum internal values, which the mapping table needs and which cannot be guessed.

---

## 7. Decisions needed before Phase 1 code

1. **Group** — confirm `singleGroup: "topics"` on both boards, and choose: rename `new_group95562` to "Inactive Contacts (future — not synced)", or delete it. *Reminder: the engine enforces placement continuously, so a rep moving a card to Inactive will have it moved back.* Same question for the redundant `group_mm6t6ear` on Accounts.
2. **The eight demo rows** — all verified to have empty HubSpot ID and Sync State. Recommend deleting all eight before Phase C, plus a CRM-specific create cutoff as defence in depth.
3. **Enum fields** — for Lead Status, Contact Source, Vendors, Company Type, Partner With: retype to dropdown/status with explicit mapping, or make them forward-only? Forward-only is cheaper and safe; two-way needs the internal-value table from §6.
4. **`status` "Type"** (F5) — map to `lifecyclestage` later, or leave unmapped permanently?
5. **Deletions** — 12 text stubs are proposed for deletion. All appear to be scaffolding, but each must be verified empty before removal (per the handoff: never delete blindly).

---

## 8. Next actions

- [ ] Unblock HubSpot schema access (§6)
- [ ] Confirm the §7 decisions
- [ ] Produce the full field mapping table (HubSpot property → monday column → direction → normalization → empty-value behaviour → adoption role)
- [ ] Then, and only then: design the `sync_owner` write guard + `canClaimCrmOwnership`, write the spec, write the plan
- [ ] No board mutations until the proposal above is approved

---

# UPDATE — 2026-09-07, later: HubSpot side largely recovered from the repo

The production Worker has synced these exact objects for months, so `CONTACTS_MYLA` /
`COMPANIES_MYLA` already encode the HubSpot internal property names, types and sync directions.
**This supersedes §6's ask — the blocker is now much smaller (see §11).**

## 9. Draft field mapping (from the production config, unverified enum values)

### Contacts — `modifiedProp: "lastmodifieddate"` ⚠️

**Note the asymmetry:** Contacts use **`lastmodifieddate`**, Companies use **`hs_lastmodifieddate`**.
Getting this wrong breaks Sync State and the whole newer-wins arbitration.

| HubSpot property | Type | Prod direction | Proposed CRM column | Notes |
|---|---|---|---|---|
| `firstname` | text | two-way (item name on WM) | `text_mm6sab4c` First name | CRM item name is display-only instead |
| `lastname` | text | two-way | `text_mm6snp6r` Last Name | delete the duplicate `12849070_last_name` |
| `email` | text | two-way | `contact_email` (native email) | **identity/adoption key**, never clearable |
| `jobtitle` | text | two-way | `text_mm6szy4q` Job Title | `title5` (CEO/COO/CIO) stays unmapped |
| `phone` | phone | two-way + backfill | `contact_phone` (native phone) | digits both sides; never the numbers column |
| `company` | text | **forward-only** | `text_mm6sdvkq` Company name | free text, NOT the association |
| `hubspot_owner_id` | people | **appReverse** | **CREATE a people column** | F1 — does not exist yet |
| `sales_user` | people | two-way | **CREATE a people column** | F1 |
| `createdate` | date | **oneWay** | `text_mm6sdc3b` → retype date | **also the ownership fallback property** |
| `notes_last_updated` | date | forward-only | `text_mm6tmzgq` Last Activity Date | retype date |
| `hs_lead_status` | status | two-way | `text_mm6tqwyw` → retype status | enum dict `leadStatus` |
| `leadsource` | dropdown | two-way | `text_mm6sc26t` → retype dropdown | enum dict `contactSource` |
| `manufacturer__c` | dropdown | two-way | `text_mm6s40ew` → retype dropdown | enum dict `contactVendor` |
| `sync_owner` | *(new)* | infrastructure | **no monday column** | fetched only, never displayed |

Creatable set (from `CONTACT_WRITE_PROPS`): `firstname` `lastname` `email` `jobtitle` `phone`
`company` `hs_lead_status` `leadsource` `manufacturer__c`. Owner fields are deliberately excluded —
they are resolved server-side.

### Companies → CRM Accounts — `modifiedProp: "hs_lastmodifieddate"`

| HubSpot property | Type | Prod direction | Proposed CRM column | Notes |
|---|---|---|---|---|
| `name` | text | two-way | `text_mm6t1q4h` Company Name | |
| `domain` | text | two-way (item name on WM) | `company_domain` (native link) | **adoption key**; CRM item name is display-only |
| `industry` | dropdown | two-way | `industry` (native dropdown) | ~200 options, single-select; CRM values look HubSpot-shaped (F3) — **verify they match internal values** |
| `type` | status | two-way | `text_mm6tghg4` → retype status | enum dict `companyType` |
| `partner_with` | status | **forward-only** | `text_mm6t6w6n` → retype status | enum dict `partnerWith` |
| `city` | text | two-way | `text_mm6tdrdn` City | |
| `state` | text | two-way | `text_mm6t5tv` State/Region | |
| `numberofemployees` | numbers | two-way | `employee_count` → retype numbers | |
| `annualrevenue` | numbers | two-way | `text_mm6t4jp` → retype numbers | |
| `timezone` | text | **forward-only** | `text_mm6tys5f` Time zone | |
| `description` | text | two-way | `company_description` (native long_text) | prod uses a *text* column; long_text is safer |
| `linkedin_company_page` | text | two-way | `text_mm6t8r57` → retype link | |
| `createdate` | date | **oneWay** | `text_mm6t7rpd` → retype date | ownership fallback |
| `sync_owner` | *(new)* | infrastructure | **no monday column** | |

Creatable set (`COMPANY_WRITE_PROPS`): `name` `domain` `industry` `type` `partner_with` `city`
`state` `numberofemployees` `annualrevenue` `description` `linkedin_company_page`.

**No HubSpot counterpart identified** for CRM `zip`/Postal code, `headquarters_loc`,
`company_profile`, Contacts' `status`/`status5`/`long_text4`/`text_mm6t8bxb` Event Name. Confirm
with the business whether any are needed; otherwise leave unmapped.

## 10. Correction to the handoff — `createdate` is ALREADY fetched

The handoff (§8 Prerequisite B) warns that both `sync_owner` and `createdate` must be added to the
fetched property list. Verified: **`createdate` is already a mapped field** on both
`CONTACTS_MYLA` and `COMPANIES_MYLA` (`oneWay: true`), and `propertiesFor()` builds its list from
`nameProps + modifiedProp + fields + groupBy.prop` — so `createdate` is already retrieved on both
objects.

**Only `sync_owner` needs adding.** Smaller change, less risk. Keep `ownershipCreatedProp` as an
explicit concept anyway, so a future spec that drops the `createdate` field can't silently break the
ownership fallback.

## 11. The blocker, narrowed

Not "the whole HubSpot schema" any more. Exactly two things:

**(a) Option values for six enum properties** — label ↔ **internal value** pairs:

| Object | Property | Label dictionary |
|---|---|---|
| contacts | `hs_lead_status` | `leadStatus` |
| contacts | `leadsource` | `contactSource` |
| contacts | `manufacturer__c` | `contactVendor` |
| companies | `industry` | `industry` (~200 options) |
| companies | `type` | `companyType` |
| companies | `partner_with` | `partnerWith` |

These cannot be guessed, and pushing a display label where HubSpot expects an internal value is a
failure mode the design explicitly guards against.

**(b) Confirmation that no *additional* HubSpot properties are wanted** for the CRM boards beyond
the production set above.

**Cheapest unblock:** the deployed production Worker already loads all six at runtime via
`getPropertyOptions` in `buildCtx`, and exposes them through `/app/contact-schema` and
`/app/company-schema`. A single authorized call to those two endpoints returns exactly (a).
Otherwise a temporary read-only credential with `crm.schemas.{contacts,companies}.read`, revoked
afterwards, does the same.

---

## 12. HubSpot access path — resolved (2026-09-07)

**No token needed.** HubSpot is reachable through the **`claude.ai HubSpot` MCP connector**
(`https://mcp.hubspot.com/anthropic`), browser-authorized via OAuth. `claude mcp list` reports
`✓ Connected`, and the server answers queries without an auth error.

**But its tools require a session restart to become usable.** The connector was authorized
mid-session, and a Claude Code session builds its tool registry at startup — so HubSpot's tools were
never registered in the session that authorized it. This is neither a permission problem nor a proven
MCP tool-surface limitation; it is session registration.

**Next session must:**

1. Start in this worktree (`Monday_Python-crm`) — the `dkm-matthew` Cloudflare profile is bound here,
   the configs are pinned, and both handoff and audit docs live here.
2. Confirm HubSpot tools are present, then verify the portal is **`39939588`** before anything else.
   Stop if it is not.
3. Retrieve label ↔ **internal value** pairs for the six enums in §11.
4. Diff HubSpot `industry` against the 47 cached monday options
   (`%TEMP%\claude\monday_industry_options.json`). Expect HubSpot to have far more (~200 per the
   production config comment), so decide between `create_labels_if_missing` (how the production Worker
   already behaves), pre-creating the missing labels, or making `industry` forward-only.
5. If the MCP genuinely cannot expose property option metadata, say so explicitly as a **tool-surface
   limitation** and fall back to a temporary read-only key
   (`crm.schemas.contacts.read`, `crm.schemas.companies.read`), revoked afterwards.
   **Never substitute display labels for internal values.**

Phase 0 remains READ ONLY: no HubSpot record, property, schema, app or webhook writes; no deploys.
Note the redundant local `hubspot` MCP entry added via `claude mcp add` is unnecessary — the
account-level `claude.ai HubSpot` connector covers it and works in any worktree.

---

# PHASE 0 — HubSpot half COMPLETE (2026-09-07)

**Access:** `claude.ai HubSpot` MCP connector, browser OAuth. **No token created.**
**Portal verified:** `accountId 39939588` — "Data Knowledge Management Ecosystem"
(`app-na2.hubspot.com`, TZ Asia/Shanghai, currency USD + HKD/CNY/SGD/EUR). Correct account.
**MCP tool surface DOES expose property schemas** (`get_properties`) — no fallback token needed.
All six enums retrieved read-only. No HubSpot writes were made.

## 13. Enum reality: internal values ≠ labels (confirmed, and it matters)

Every one of the six carries value↔label mismatches. Pushing a display label where HubSpot wants an
internal value would fail — the exact failure mode the design guards against:

| Property | Options | Example mismatches (value → label) |
|---|---:|---|
| `hs_lead_status` | 8 | `IN_PROGRESS` → "In Progress", `ATTEMPTED_TO_CONTACT` → "Attempted to Contact" |
| `leadsource` | ~210 | `Others` → "其他"; near-dupes `3 市场活动…` vs `3市场活动…` |
| `manufacturer__c` | ~88 | `38Altair` → "**39**Altair", `Zoom` → "**65**Zoom", `咨询合作` → "**57**咨询合作" |
| `type` | 16 | `PROSPECT` → "Prospect", `RESELLER` → "Reseller" |
| `partner_with` | 27 | `3 Docusign` → "Docusign", `GOOGLE` → "Google Workspace", `9 Power BI` → "Power BI", `SAP` → "SAP -Theobald Software" |
| `industry` | ~250 | `GLASS_CERAMICS_CONCRETE` → "Glass, Ceramics & Concrete"; plus ~90 custom CN/EN additions |

`hs_lead_status`'s 8 internal values match the WM board's `LEAD_STATUS_GROUPS` map exactly — that
mapping is already proven in production and can be reused verbatim.

## 14. `industry` — the taxonomies DO NOT MATCH (F9, decision-grade)

The monday CRM Accounts `industry` dropdown is **Crunchbase-style**; HubSpot's is **LinkedIn-style
plus ~90 custom CN/EN additions**. They are not subset/superset — they are different vocabularies
that coincide on a handful of names.

**Exact label matches: 8 of 47.**
`Biotechnology` · `Consumer Electronics` · `Consumer Goods` · `Design` · `Financial Services` ·
`Other` · `Real Estate` · `Sports`

The other 39 monday options have **no HubSpot equivalent** — e.g. "Apps", "Artificial Intelligence",
"Data and Analytics", "Lending and Investments", "Platforms", "Sustainability". And near-misses do
not count: monday "Food and Beverage" vs HubSpot "Food & Beverage**s**"/"Food & Beverage";
monday "Software" vs HubSpot "Computer Software"; monday "Health Care" vs "Hospital & Health Care".

**Therefore `industry` MUST NOT be two-way in Phase 1**, despite production having it two-way on the
WM board (whose dropdown was built from HubSpot's own taxonomy — a different column entirely).

Options, in recommended order:

1. **Forward-only into a TEXT column** — cleanest. No label management, no failure mode, no
   pollution of the native dropdown. Rep sees HubSpot's industry, can't edit it back.
2. **Forward-only into the native dropdown with `create_labels_if_missing`** — works (it is how the
   production Worker's `updateItem` already behaves), but the 47 unused Crunchbase labels then sit
   alongside HubSpot's, which will confuse reps.
3. **Replace the 47 options with HubSpot's taxonomy** — the only route to genuine two-way. A large,
   deliberate board change; propose separately, do not sneak into Phase 1.

## 15. Final direction decisions

Production directions are the default; deviations are justified by the schema evidence above.

| Property | Production | **Phase 1 CRM** | Why |
|---|---|---|---|
| `hs_lead_status` | two-way | **two-way** | 8 clean options; retype the text stub → status, reuse the proven map |
| `leadsource` | two-way | **FORWARD-ONLY** | ~210 options, mostly legacy Tableau/Alteryx marketing values + value≠label dupes. A 210-option monday dropdown is unusable; keep as text |
| `manufacturer__c` | two-way | **two-way, dropdown** | ~88 options but a real working vocabulary. **Must** invert label→value via `ctx.labels` (`38Altair`/`39Altair` proves it) |
| `industry` | two-way | **FORWARD-ONLY** | F9 — taxonomies don't match (8/47) |
| `type` | two-way | **two-way, status** | 16 options, manageable |
| `partner_with` | forward-only | **forward-only** | unchanged; matches production |

Every two-way enum needs its label dictionary loaded via `getPropertyOptions` in `buildCtx` —
already the mechanism, just add the CRM specs' dictionaries.

## 16. Remaining decisions for the user (3)

1. **`industry`** — confirm option 1 (forward-only text) for Phase 1.
2. **"Inactive Contacts" group** (`new_group95562`) — rename to "Inactive Contacts (not synced)",
   or delete. Reminder: the engine enforces `singleGroup` continuously, so a card dragged there gets
   moved back. Same question for the redundant `group_mm6t6ear` on Accounts.
3. **The eight demo rows** — all verified unlinked (empty HubSpot ID + Sync State). Recommend
   deleting all eight before Phase C, plus a CRM-specific create cutoff as defence in depth.
   Requires explicit approval.

## 17. Phase 0 status: **COMPLETE**

monday schema ✓ · HubSpot schema ✓ · portal verified ✓ · six enum lists ✓ · industry diff ✓ ·
mapping table final ✓ · directions decided ✓ · baseline green (340/195) ✓ · Cloudflare settled ✓

**Ready for Phase 1 implementation** (specs + ownership guard + adoption + webhooks + tests) once
the three decisions above are signed off. No deploys; `DRY_RUN=true`; crons off.
