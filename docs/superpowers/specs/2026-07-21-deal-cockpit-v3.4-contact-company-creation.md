# Deal Cockpit v3.4 — Standalone + Contextual Contact/Company Creation — Design

**Date:** 2026-07-21
**Status:** Design (approved) — pending user review before writing the implementation plan
**Depends on:** v3.3 (line-item creation, live search, fresh-on-open). Extends the same Worker-is-sole-HubSpot-writer + create-with-ID-in-initial-mutation pattern.

## Business goal

The monday Board View ("Deal Cockpit") is becoming the main sales interface. A salesperson must be able to, **without leaving the app**:

1. Search existing HubSpot Contacts and Companies (already works — live search).
2. Create a new Contact — **standalone** (no deal) or **inside a deal**.
3. Create a new Company — standalone or inside a deal.
4. Create or edit a Deal (already works).
5. Associate the selected/new Contact and Company with a Deal.
6. See the new record on the correct monday board, with the same record + associations in HubSpot.
7. Keep editing from either side through the existing two-way sync.

Creation is an **action**, not primary navigation.

---

## Verified current configuration (do not trust titles — these are the live IDs from `worker/src/config.ts`, in production since 2026-07-03)

### Boards + HubSpot-ID columns
| Board | Board ID | HubSpot-ID column | Primary (name) column |
|---|---|---|---|
| Contacts ("… Follow Up") | `5029639630` | `numeric_mm4xw7rk` | First name (`firstname`) |
| Companies ("… Follow Up") | `5029639440` | `numeric_mm4xkk3a` | Company domain (`domain`) |
| Deals | `5029480547` | `numeric_mm4nz332` | Deal name (`dealname`) |

### Association (Connect Boards / `board_relation`) columns — ALL EXIST; no new columns are created
| Link | Column ID |
|---|---|
| Deal → Contact | `board_relation_mm5417sy` |
| Deal → Company | `board_relation_mm54rrj3` |
| Contact → Company | `board_relation_mm54dbxk` |
| Contact → Deal | `board_relation_mm54zahf` |
| Company → Contact | `board_relation_mm54e96` |

(There is no Company → Deal relation column, and none is required — the HubSpot association is bidirectional regardless.)

### Groups
- Contacts: grouped by `hs_lead_status` (`LEAD_STATUS_GROUPS`), forward-only, **fallback = "New" group `topics`**. A new/Unassigned contact lands in `topics`.
- Companies: single group `group_mm4s3z7e`.

### Two-way (reverse) field mappings already configured — editing these in *either* system syncs once the record exists with its ID stamped
- **Contact reverse:** `firstname` (name), `lastname` (`text_mm4scke9`), `email` (`text_mm4p2bvb`), `jobtitle` (`text_mm4sznkw`), `hs_lead_status` (`status`), `sales_user` (`multiple_person_mm542gng`). Forward-only: `phone`, `company` text, `hubspot_owner_id`, `createdate`, `leadsource`, `manufacturer__c`.
- **Company reverse:** `domain` (name), `name` (`text_mm4scke9`), `industry` (`dropdown_mm54zrp2`), `type` (`color_mm545z1t`), `city` (`text_mm4p2bvb`), `state` (`text_mm4sznkw`), `numberofemployees` (`numeric_mm4ww8gs`), `annualrevenue` (`numeric_mm4w8g9k`), `description` (`text_mm4wwtd0`), `linkedin_company_page` (`text_mm4w6rzg`), `sales_user` (`multiple_person_mm54phd7`). Forward-only: `hubspot_owner_id`, `partner_with`, `timezone`.

### Existing building blocks reused (not reinvented)
- `searchContactByEmail(env, email)` — normalized-email dedup **already exists** (`worker/src/hubspot.ts`).
- `createRecord(env, spec, props, opts)` — the sole HubSpot create path. `buildColumnValues(rec, spec, ctx)` **already stamps the HubSpot-ID column** — so a card can be born with its ID in one mutation.
- `createOnBoard()` (app `monday-client.ts`) already creates a card with the ID embedded (used for linking existing records).
- `reverseAssociations()` (`worker/src/sync.ts`) already turns a deal's board-relation links into HubSpot associations on sync (additive/set-only). The cron/incremental reconcile is the backstop.
- `session.ts` verifies the monday session token and exposes the acting `user_id` + `account_id`.

### Not verifiable locally (no credentials in this workspace) — must be re-verified live during Phase A
- Exact live HubSpot property **options** (industry/type/lead-status/etc.) — served **live at runtime** via new `/app/contact-schema` + `/app/company-schema` (same pattern as `/app/line-item-schema`), so nothing is hardcoded/guessed.
- Board titles ("… Follow Up") — irrelevant to correctness; we key off the **IDs** above, never titles.

---

## Architecture

The Worker remains the **only** component that creates/updates HubSpot records and associations. Two new endpoints perform **search-or-create atomically**, stamp the HubSpot ID into the monday card's **initial** create mutation (so the reverse-sync never mistakes the card for a brand-new record needing another HubSpot record), and return a **structured step-result**. A **Durable Object** keyed by a client-generated UUID makes every create idempotent and resumable. The app generalizes the right-side drawer into an entity drawer that creates Contacts/Companies standalone or in-deal, driven by these endpoints.

### Component 1 — Durable Object idempotency store (Worker)
- New DO class `CreateIdempotency`, one instance per key via `env.CREATE_IDEMPOTENCY.idFromName(uuid)`. It stores the accumulated **step-result JSON** for that key (with a stored timestamp for age-based expiry; ~24h).
- Each create request: read the key's stored state → run only the **missing** steps → persist the updated state → return it. A completed key returns the stored result without repeating work; a partial key **resumes**.
- `wrangler.toml` gains the DO binding + a migration (`new_sqlite_classes` for a SQLite-backed DO).
- **Key lifecycle (client):** generate **one UUID when a Create operation begins**; reuse it for every double-click, network retry, partial-failure retry, and page-level retry. A new key is generated only for a genuinely new record.
- **Applied to:** `POST /app/contact`, `POST /app/company`, and the existing `POST /app/line-item` create branch (add an optional `idempotencyKey`; when present, wrap the create in the DO). **Deal creation is unchanged** — it is monday-first (client-side) and already double-submit-safe via the synchronous `savingRef` + `createdItemId` reuse (v3.1.5). No Worker create-deal endpoint is added.

### Component 2 — Owner-mapping resolver (Worker)
- `resolveActor(env, ctx, sessionUserId)` → `{ hubspotOwnerId } | { unassigned: true }`.
  1. `getUserById(sessionUserId)` → email.
  2. `ctx.ownerIdByEmail[email.toLowerCase()]` → HubSpot owner id.
  3. Match ⇒ set the new HubSpot record's **`sales_user`** and **`hubspot_owner_id`** properties to the matched owner id (`sales_user` values are raw owner ids per config). `buildColumnValues` then renders the monday **Sales User** + **Owner** people columns from those — the monday columns are *derived*, never written directly, so they can't drift from HubSpot.
  4. No match ⇒ **omit `sales_user`/`hubspot_owner_id` (Unassigned)**; the card lands in its normal group (New/`topics` for contacts, the single group for companies); return `unassigned:true` and the message *"No HubSpot owner mapping was found. Record created as Unassigned."*
- **Never falls back to Myla** (`MYLA_DEFAULTS` is not used for app-created records).
- **Documented consequence:** the inbound HubSpot→monday sync scope filter requires `sales_user HAS_PROPERTY`; an Unassigned record is therefore **not swept inbound** until a Sales User is assigned. It is still created fully-populated with its ID, and **outbound monday→HubSpot edits still work** (an already-linked card syncs regardless of scope). Assigning a Sales User later brings it fully into scope.

### Component 3 — Search-or-create endpoints (Worker)
- New `normalizeDomain(raw)` — pure/tested: lowercase, strip scheme, leading `www.`, path, and trailing slash. New `searchCompanyByDomain(env, domain)` → `{id, modified} | null` (EQ on `domain`). `searchContactByEmail` already exists.
- `POST /app/contact` body `{ idempotencyKey, properties, associateCompanyHubspotId? }`.
- `POST /app/company` body `{ idempotencyKey, properties, associateContactHubspotIds? }`.
- **Server-side writable-prop allowlist** per object (built from the `hs` field names in `CONTACTS_MYLA` / `COMPANIES_MYLA` plus name/domain; mirrors `line-item-props.ts` / `CLEARABLE_DEAL_PROPS`). Any unknown/read-only property is stripped. Contact requires at least a name; Company requires at least a name or domain.
- **Server steps** (each recorded in the DO so a retry resumes):
  1. **dedup** — contact by normalized email, company by normalized domain (skipped when none supplied; see Duplicate protection).
  2. **create-or-reuse HubSpot** — reuse the deduped record if found, else `createRecord` with the allowlisted props + the owner from Component 2.
  3. **create/reuse monday card** — find-or-create by HubSpot-ID column; on create, build the full `cv` from the created record (`buildColumnValues` → ID + all mapped fields + link + sync-state) so the card is **born with its ID and fully populated in one mutation**.
  4. **apply owner** — Sales User / `hubspot_owner_id` (part of step 2's props; surfaced as its own progress step).
  5. **optional nested association** — link a Company to the Contact (or Contacts to the Company) when supplied (one level; via the same search-or-create).
  6. **done.**
- **Returns** `{ hubspotId, mondayItemId, existing, unassigned, ownerMessage?, mondayLink, hubspotLink, steps: { dedup, hubspot, monday, owner, associations } }`.
- **Auth:** session-token verify + allowed account/user (existing gate); **structured errors** `{ error, code }`; **never logs tokens/secrets**.
- `GET /app/contact-schema` + `GET /app/company-schema` — live dropdown options for the forms (industry, type, lead status, leadsource, manufacturer, partner-with…), read from the HubSpot property schema and cached briefly in the isolate.

### Component 4 — Generalized entity drawer + header actions (App)
- **Header (BoardView top bar):** `+ New Deal`, `+ New Contact`, `+ New Company`. On narrow screens they collapse into a single `+ Create` split/dropdown (Deal / Contact / Company). No permanent tabs for blank creation forms.
- **Drawer:** today's `DealDrawer` is generalized to an entity drawer with `mode ∈ {deal, contact, company}`, reusing the drawer shell, dirty-guard, close/Esc behavior, and form field components. Deal mode is unchanged. Titles *Create Contact* / *Create Company*.
- **Full-parity forms** (per config, live options from the schema routes):
  - **Contact:** firstname, lastname, **email** (dedup key — strongly recommended, warned when blank), jobtitle, phone, company, lead status, Sales User (read-only display of the resolved actor), leadsource, manufacturer/vendor.
  - **Company:** name, **domain** (dedup key — strongly recommended, warned when blank), industry, type, partner-with, city, state, numberofemployees, annualrevenue, description, LinkedIn.
- **Progress UI** driven by the step-result: *Checking for duplicates → Creating in HubSpot → Adding to monday board → Applying owner → Creating associations → Completed*. A failed step shows **Retry**, which re-calls with the **same idempotency key** to resume only the incomplete steps (reusing already-created IDs). Synchronous `savingRef` submission lock; double-click creates one record.
- **After save:** **Open in monday** + **Open in HubSpot** links; the Unassigned message when `unassigned:true`.
- Live search stays fresh (`no-store`), so a just-created standalone record is immediately findable in future Deal forms.

### Component 5 — Contextual + nested associations (App)
- **Deal → Associations** keeps `+ New Contact` / `+ New Company`. Records created here are **pending until the deal saves**; on Save they are created/reused via the endpoints, associated to the HubSpot Deal, and Connect-Boards-linked (the deal's `board_relation` columns). **Cancel creates nothing.**
- **Standalone Contact** form may optionally link **or create one Company** and associate it; **standalone Company** may optionally link or create Contacts. One level deep, via the same endpoints. No deal required.
- The deal↔contact/company HubSpot association is created by the existing `reverseAssociations` on the deal's next sync (as today); unlink stays the existing synchronous `DELETE /app/association`. Disassociating **never deletes** the Contact/Company record.

---

## Data flow — standalone new Contact (happy path)
1. Rep clicks **+ New Contact** → entity drawer opens (`mode=contact`); the app generates **one UUID** idempotency key.
2. Rep fills the form → **Save** → `savingRef` locks → `POST /app/contact { idempotencyKey, properties, associateCompanyHubspotId? }`.
3. Worker: open DO(key) → **dedup** by normalized email → none → **createRecord** (contacts, allowlisted props + resolved owner) → **monday card** via find-or-create-by-ID with full `cv` (ID stamped in the create) → **owner** applied → optional **company association** → persist + return step-result.
4. Client renders progress from the result, shows **Open in monday / Open in HubSpot**, and (if applicable) the Unassigned message. Live-search picks up the new record immediately.

## Error handling
- **Structured Worker errors** `{ error, code }`; the client surfaces a clear message, never a silent empty state.
- **Partial failure** (HubSpot created, monday failed): the result carries `hubspotId` with `mondayItemId:null` and the failing step. Retry (same key) resumes the monday step and **reuses the HubSpot ID** — never a second HubSpot record. The DO guarantees this even with no email/domain.
- **Dedup match:** `existing:true` — standalone shows the existing record + links; in-deal associates it instead of creating.
- **No email (contact) / no domain (company):** the client shows a **duplicate-risk warning**, runs a **name-match search**, and requires **explicit confirm** before calling create.
- **Invariants:** never delete a Contact/Company on disassociate; never clear HubSpot from an empty monday value; never match/merge by name alone.

## Testing
- **Worker units:** `normalizeDomain`; `searchCompanyByDomain`; `resolveActor` (match → owner+sales_user, no-match → unassigned); `parseContactBody` / `parseCompanyBody` allowlists (strip read-only/unknown, require name/domain); the DO (two calls with the same key ⇒ one HubSpot create; a partial state ⇒ resume only missing steps).
- **App units:** contact/company form validation; the progress/retry-step reducer (which step to resume); header responsive collapse logic.
- **Live post-deploy checklist:** re-verify columns/schema against the IDs above; create a standalone Contact and Company; dedup by existing email/domain (reuse, no dup); owner-mapped vs Unassigned paths (+ message); in-deal contextual create + association; one-level nested association; double-click Save ⇒ one record; edit the new record in monday → HubSpot and in HubSpot → monday. Clean up test records.

---

## Delivery — one spec, three phases
- **Phase A — Worker foundation:** DO idempotency store + `wrangler.toml` migration; `normalizeDomain` + `searchCompanyByDomain`; `resolveActor`; `parseContactBody` / `parseCompanyBody` allowlists; `POST /app/contact` + `POST /app/company` (search-or-create, owner rule, step-result, auth, structured errors); wire the idempotency key into `POST /app/line-item`; `/app/contact-schema` + `/app/company-schema`. Unit tests. Live re-verification of IDs/schema.
- **Phase B — Standalone creation UI:** header actions + responsive `+ Create`; generalize the drawer to the entity drawer; standalone Contact + Company full-parity forms (live options); progress UI + retry-only-failed-step; Open-in-monday / Open-in-HubSpot links; Unassigned messaging; live-search freshness.
- **Phase C — Contextual + nested associations:** `+ New Contact` / `+ New Company` in Deal → Associations (pending-until-save, associate on deal save, Cancel creates nothing); optional one-level nested Contact↔Company association in the standalone forms; verify the reverse-association webhook/reconciliation path covers app-created records.

Each phase gets its own `writing-plans` document when it is started.

## Flagged decisions (as approved)
- Owner = **current logged-in rep**; **never** Myla; no mapping ⇒ **Unassigned + message** (inbound sync dormant until assigned).
- Idempotency = dedup + ID-reuse **+ a Durable Object** keyed by a client UUID, applied to contact/company creation now; **line-item keying deferred** to its own fully-tested task (see revisions); deal creation stays client-side.
- Forms = **full parity** with the board-synced fields.
- Standalone forms live in a **generalized drawer** (not separate components).
- Progress = **structured step-result** from the Worker; retry resumes only the failed step.

## Review revisions (2026-07-22, after an external review pass)
Applied to the Phase A plan (`docs/superpowers/plans/2026-07-22-deal-cockpit-v3.4-phase-a-worker-foundation.md`):
- **Durable Object keys are namespaced** `${accountId}:${kind}:${uuid}` — a UUID can never collide across contact/company/line-item or across monday accounts.
- **The idempotency key is validated as a UUID** server-side (client uses `crypto.randomUUID()`).
- **The step-result carries `status` (`in_progress`/`completed`/`failed`) + `failedStep`** alongside the per-step completion flags + produced ids, so the progress UI is exact rather than inferred. (Rejected as not matching the model: live "running/pending" states and a client-driven `nextRetryStep` — the call is synchronous and the *server* resumes from stored partial state on a same-key retry; the client does not drive per-step retries.)
- **The claim read-modify-write is serialized** (`blockConcurrencyWhile`) so two concurrent same-key requests can't both proceed.
- **The 24h self-clean alarm is refreshed on every claim and save** (not only on success), so abandoned/failed keys can't linger.
- **Failure paths release the key** (immediately reclaimable, partial carried forward) so a *sequential* retry resumes instead of hitting a 60s `409`.
- **Line-item idempotency is deferred** to its own fully-tested task — the existing subitem-Line-Item-ID reuse + client lock already prevent duplicate line items, so a partial wrapper would add risk for no gain.
- **Confirmed (not a defect):** the Contact/Company boards are already **all-rep shared** (`sales_user HAS_PROPERTY`), not Myla-only — the `*_MYLA` constant names are a legacy misnomer. Current-rep ownership works with no board-model change.
