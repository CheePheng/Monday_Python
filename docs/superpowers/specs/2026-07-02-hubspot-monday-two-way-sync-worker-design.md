# HubSpot ↔ monday Two-Way Sync Worker — Design Spec

**Date:** 2026-07-02
**Status:** Approved for planning

## Context

The Python POC in this repo proved the primitives: HubSpot→monday routing by owner, per-stage
groups, dedup by HubSpot Deal ID, full typed field mapping, and a two-way reconcile (`sync.py`,
last-edit-wins, update-only). The boss now wants a **different, larger structure** and an
**always-on, two-way** sync. This spec redesigns the system as a **TypeScript Cloudflare Worker**.

New structure (per salesperson): **3 boards** — Deals (grouped by stage), Company Follow Up, and
Contact Follow Up (grouped by lead status) — plus **one shared Unassigned Deals** board for records
with no sales user. We start with **one salesperson, Myla Mestiola**, to prove it out.

Routing key is the HubSpot **`sales_user`** property (a select), **not** the record owner.
`sales_user` empty ⇒ the record is "unassigned".

## Goals

- Always-on, hands-off sync (no user machine required).
- **Two-way**: HubSpot ⇄ monday, last-edit-wins, that cannot create duplicates or corrupt the CRM.
- Cover deals, companies, contacts, and unassigned deals for Myla; config-driven so more
  salespeople are added trivially later.

## Non-goals (v1)

- Instant/webhook latency (Cron gives ~2-min freshness; webhooks are a later speed enhancement).
- More than one salesperson (Myla only; config-driven expansion later).
- Creating or deleting HubSpot records (sync is **update-only** on the HubSpot side).

## Architecture

A **Cloudflare Worker (TypeScript)** with a **Cron Trigger** (~every 2 min). Each tick runs a full
**two-way reconcile** for Myla's 4 boards. No datastore — dedup is done by reading the monday boards
each run (idempotent), exactly as the Python version does. Because Cron runs are sequential and the
reconcile only writes when values **differ**, there are no webhook-style loops.

Tokens are Worker **secrets** (`wrangler secret`). The salesperson→board mapping and field maps live
in a committed **config module**. A `fetch()` handler exposes a **manual-trigger URL** (guarded by a
shared secret) for on-demand runs during testing; the `scheduled()` handler is the production path.

## Components (small, independently testable modules)

- `hubspot.ts` — REST client: paginated search of deals/companies/contacts filtered by `sales_user`;
  read pipelines, owners, property options; `PATCH` (update-only) for reverse writes. Retry w/ backoff.
- `monday.ts` — GraphQL client: read board items/columns/groups + `updated_at`; `create_item` /
  `change_multiple_column_values` (`create_labels_if_missing`); `create_column` (to add ID columns).
- `mapping.ts` — **pure** formatters per monday column type (status/dropdown/people/date/numbers/
  link/text) and reverse (monday value → HubSpot value). Unit-tested.
- `routing.ts` — **pure** decisions: which board + group a record belongs to. Unit-tested.
- `dedup.ts` — **pure** match of a HubSpot record to a monday item by the HubSpot-ID column.
- `reconcile.ts` — per-record last-edit-wins comparison (value-diff → direction by timestamp).
- `config.ts` — Myla's `sales_user` value → board IDs, group maps, column IDs, field maps; Unassigned board.
- `sync.ts` — orchestrates one object type end-to-end; `index.ts` — Worker `scheduled()` + `fetch()`.

## Routing rules

- **Deal**, `sales_user` = a mapped salesperson → that person's **Deals board**, into the group
  matching the deal's **stage** (stage→group auto-mapped by matching HubSpot stage label to group title).
- **Deal**, `sales_user` empty/unmapped → **Unassigned Deals** board.
- **Company**, `sales_user` = mapped salesperson → that person's **Company board** (single group).
- **Contact**, `sales_user` = mapped salesperson → that person's **Contact board**, into the group
  matching **`hs_lead_status`** (label→group, e.g. `IN_PROGRESS` → "In Progress").

## Dedup

Match by a **HubSpot record-ID number column** on each board. Deals boards already have it
(`numeric_mm4nz332`; Unassigned `numeric_mm4wp9y2`). The Company and Contact boards **lack one** — the
build adds a **"HubSpot ID" number column** to each (via `create_column`) and matches on it. Dedup
scans the whole board so a record that changes stage/lead-status updates in place, never duplicates.

## Two-way reconcile + loop prevention

Per linked pair (monday item ↔ HubSpot record): compare each **editable** field. If all equal → do
nothing. If any differ → the side whose record changed more recently wins (HubSpot
`hs_lastmodifieddate` vs monday `updated_at`); push that side's values to the other. **Value-diff is
the loop guard** — once equal, subsequent ticks are no-ops, so it converges and never ping-pongs.
HubSpot writes are **`PATCH` only** (never create/delete). **Read-only fields excluded** (HubSpot ID,
HubSpot Link, Created date, calculated fields). Reverse (monday→HubSpot) writes are gated by a config
flag and require the relevant HubSpot write scopes.

## Board & field mapping reference (discovered)

- **Deals** `5029480547` — groups `group_mm4nf6fw`/appointmentscheduled, `group_title`/qualifiedtobuy,
  `group_mm4pa9zg`/presentationscheduled, `group_mm4pbazz`/decisionmakerboughtin,
  `group_mm4pavfa`/contractsent, `group_mm4py571`/closedwon, `group_mm4pw6e2`/closedlost,
  `group_mm4pdres`/2831885024. Cols: `numeric_mm4nz332` HubSpot Deal ID, `person` owner,
  `color_mm4n27da` stage(status), `date4` created, `dropdown_mm4ngscc` pipeline, `dropdown_mm4nxhje`
  deal type, `dropdown_mm4nmmax` priority, `dropdown_mm4n4f7r` vendor, `link_mm4ns4nn` HubSpot link.
- **Company** `5029639440` — one group `group_mm4s3z7e`. Cols incl. `text_mm4scke9` name,
  `multiple_person_mm4p8xe2` owner, `dropdown_mm4wj6nv` industry, `dropdown_mm4wa6ak` type,
  `numeric_mm4ww8gs` employees, `numeric_mm4w8g9k` revenue, `text_mm4p2bvb` city, `link_mm4pvn78`
  link. **Add** HubSpot ID number column.
- **Contact** `5029639630` — groups by lead status: `topics`/New, `group_mm4wk3z0`/Open,
  `group_mm4w23q`/In Progress, `group_mm4w9de6`/Open Deal, `group_mm4w1jd0`/Unqualified,
  `group_mm4wcxb`/Attempted to contact, `group_mm4wactt`/Connected, `group_mm4w55z2`/Bad Timing.
  Cols incl. `text_mm4scke9` last name, `text_mm4p2bvb` email, `text_mm4sznkw` job title,
  `status` Lead Status, `date4` last activity, `link_mm4pvn78` link. **Add** HubSpot ID number column.
- **Unassigned Deals** `5029479220` — one group `topics`. Cols incl. `numeric_mm4wp9y2` HubSpot Deal
  ID, `status` deal pipeline, `dropdown_mm4nkk6y` stage, `dropdown_mm4nkmg5` deal type, `link_mm4n9cce` link.

Exact HubSpot property → monday column maps per object are finalized in the implementation plan.
Company/Contact HubSpot property names must be confirmed once read scopes are granted (currently 403).

## Error handling

Retry monday/HubSpot on timeout/429 with backoff. **Per-record try/catch** so one bad record doesn't
abort the tick; log and continue. Runs are idempotent, so a failed tick self-heals next run.
`create_labels_if_missing` avoids status/dropdown label errors. A tick logs a per-object summary
(created/updated/to-hubspot/skipped/errors).

## Testing

`vitest` unit tests for all pure logic: mapping/formatting (both directions), routing decisions,
dedup match, stage/lead-status→group auto-map, `sales_user`→board resolution, and the reconcile
last-edit-wins/value-diff decision. A **dry-run flag** logs would-be writes to both sides without
executing them — used to verify Myla end-to-end before enabling live writes. `wrangler dev` +
manual-trigger URL for local runs.

## Prerequisites / setup

- **HubSpot scopes** on the private app: `crm.objects.contacts.read`+`.write`,
  `crm.objects.companies.read`+`.write`, `crm.schemas.contacts.read`, `crm.schemas.companies.read`
  (deals read+write already granted). Currently reading contacts/companies returns **403**.
- Add **"HubSpot ID" number column** to Company + Contact boards (done by the build via API).
- **Cloudflare**: account ID + an API token with **Workers Scripts: Edit** (to deploy via `wrangler`).
- Confirm Myla's `sales_user` value and that `sales_user` exists on contacts/companies.

## Phased delivery

1. Worker foundation + config + monday/HubSpot clients + **deals** two-way for Myla (parity with `sync.py`).
2. Add **companies** and **contacts** (incl. adding ID columns, lead-status grouping) + **Unassigned** routing.
3. Deploy on **Cron** (~2 min) with dry-run→live cutover.
4. (Later, optional) webhooks for instant latency; more salespeople via config.

## Out of scope (v1)

Webhooks/instant sync, multiple salespeople, creating/deleting HubSpot records, and any monday board
structure changes beyond adding the two HubSpot-ID columns.
