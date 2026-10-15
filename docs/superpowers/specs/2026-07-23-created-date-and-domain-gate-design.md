# Created Date columns + Company domain gate — Design

**Date:** 2026-07-23
**Status:** Design (pending review) — implementation plan follows in `docs/superpowers/plans/2026-07-23-created-date-and-domain-gate.md`

## Goal

Two small, independent improvements to the Deal Cockpit boards:

1. **Created Date** — show the HubSpot record's creation date on Company Follow Up and the Deals board, so a rep can tell at a glance which record is the most recently created. (Contact Follow Up already has this.)
2. **Company domain gate** — a company with no `domain` can never be de-duplicated, so make skipping it a deliberate act rather than an oversight.

---

## Part 1 — Created Date

### Sync direction (one-way only)

**HubSpot → monday, never monday → HubSpot.** `createdate` is HubSpot-owned and read-only; nothing the app or a rep does in monday may ever write it back. Concretely the field spec carries **no `reverse`** and **no `backfill`** flag, which is what keeps it out of `buildReversePatch` entirely.

**There is no separate bulk backfill job.** Existing rows simply receive their Created Date the next time normal reconciliation touches that record — the 10-minute incremental for anything that changes, and the 03:00 UTC full run for everything else. So the column populates itself within a day without any migration step. (If a rep wants it sooner for one board, a manual live `/run?object=companies` does the same work; that is an operator action, not part of this change.)

### Board / column state

| Board | Board id | Status |
|---|---|---|
| Contact Follow Up | `5029639630` | **Already mapped** — `createdate → date_mm4s2bjd` exists in `CONTACTS_MYLA.fields`. Column is merely hidden on the board; unhide it. No code. |
| Company Follow Up | `5029639440` | Needs a date column + a `createdate` mapping in `COMPANIES_MYLA.fields`. |
| Deals | `5029480547` | Needs a date column + a `createdate` mapping in `DEALS.fields`. |

### Column reuse rule

Reuse an existing column **only if its meaning and its type are both clearly correct** — i.e. it is a `date` column that already represents *the HubSpot record's creation date*.

**Explicitly do NOT reuse monday's own card-created-date** (the `Creation Log` / native `created_at`). It answers a different question — when the monday *card* was made — which for imported or backfilled records is not when the record was created in HubSpot. Reusing it would silently produce wrong values.

If no such column exists, create a new one named **"Created date"** of monday type `date`, and record the **id monday returns** in `config.ts`. Never guess or hand-write a column id, and never create a second column when a correct one exists.

### Timezone: the date is derived in **UTC**

HubSpot returns `createdate` as an ISO-8601 UTC instant (e.g. `2026-07-23T12:05:46.593Z`). A monday `date` column stores a calendar date. We take **the first 10 characters of the UTC timestamp** — i.e. the UTC calendar date — which is exactly what `formatValue`'s existing `case "date"` already does (`v.slice(0, 10)`).

**Why UTC and not Malaysia time (UTC+8):**
- **Consistency wins.** Contact Follow Up's `createdate` column is *already* populated this way, as are every other date column (`closedate`, `service_date`). Deriving Company/Deals in MYT would make the three boards disagree about the same instant, which is worse than a known, uniform offset.
- **Changing it is not local.** `formatValue` (write) and `expectedText` (diff) must agree exactly, or every reconcile tick sees a phantom diff and rewrites the row forever. A timezone shift would have to change both, for all date fields, on all three boards — a much larger and riskier change than this one.

**Accepted consequence, stated plainly:** a record created between **00:00 and 08:00 Malaysia time** falls on the previous UTC day, so its Created Date reads one day earlier than the rep experienced. Moving every date column to MYT is a separate, deliberate change if it ever matters.

**Precision:** date only, no time — so several records created on the same day tie. That is sufficient for "which did I make most recently" at day granularity; for finer ordering the board's native card-created column already sorts to the second.

---

## Part 2 — Company domain gate ("require unless you confirm")

### Behaviour

- The Create Company form gains a checkbox: **"This company has no website"**.
- `domain` is **required unless that box is ticked**. Until one or the other is true, Save stays disabled and an inline error explains why.
- The checkbox is **form-only state**. It is not a HubSpot property and is not in `COMPANY_WRITE_PROPS`, so `recordFormToProperties` drops it automatically — it can never leak into a HubSpot payload.
- Applies to **both** entry points automatically, because both render the same `RecordForm` and call the same `validateRecordForm`: the standalone Create Company drawer, and the "+ New company" panel inside Deal → Associations.

### The old confirm becomes unreachable — delete it

Today a domain-less company create is gated by a `window.confirm("No domain — a duplicate can't be detected automatically…")`. Once the checkbox exists, that popup **can no longer be reached** for companies: the user has already made the decision explicitly in the form. Leaving it would be dead code that silently double-prompts if the gate ever regressed.

**Remove the company branch of that confirm** in both `RecordDrawer.submit` and `AssociationSection.addNew`.

**Keep the contact branch.** Contacts have no equivalent checkbox — a contact with no email is still gated by the existing confirm. Only the company path changes.

### Explicitly out of scope

- **Existing domain-less companies stay exactly as they are.** No migration, no renaming, no forced domain. They remain un-de-duplicatable; that is accepted.
- **The `companies <id>` fallback card name stays.** When `domain` is empty the board's primary column is empty, so `itemName()` falls back to `` `${spec.object} ${rec.id}` ``. That is fine and is not being changed.

---

## Part 3 — Duplicate company cards: findings and proposed actions (NO deletion in this change)

Two cards on Company Follow Up point at the **same** HubSpot company. Captured live via the temporary `/diag` endpoint:

**Both cards** carry HubSpot id `335311575762` in `numeric_mm4xkk3a`, are named `changhongit.com`, sit in group `group_mm4s3z7e`, and hold **identical values in every mapped column** (company name, owner, industry, partner-with, address, city, employees, description, LinkedIn, sales users, HubSpot link).

| | **2800166155** | 2800227220 |
|---|---|---|
| Created | 2026-07-23T03:47:**19**Z | 2026-07-23T03:47:**20**Z |
| Last updated | 2026-07-23T04:11:28Z | 2026-07-23T03:47:24Z |
| Sync State (`text_mm4xrhjt`) | `2026-07-23T04:04:49.974Z` | `2026-07-23T03:47:18.612Z` |
| Company→Contact relation (`board_relation_mm54e96`) | **`["2800227425"]`** | **`[]`** |
| Any column the other lacks | none | none |

**Cause:** created one second apart — the eventually-consistent id-column search race, from before the card-registry fix.

**Canonical: `2800166155`.** It holds the only unique data in the pair (the contact association), has the fresher Sync State, and is the one the reconciler has been maintaining.

**Duplicate: `2800227220`.** It has no relation links and no column value the canonical card lacks, so deleting it loses nothing.

**Proposed action — for human approval, not automated:**
1. Re-verify both cards immediately before acting (values can change).
2. Confirm `2800227220` still has an empty relation column and no unique data.
3. Delete **only** `2800227220`, via the monday UI (recoverable from the board recycle bin for ~30 days).
4. Run reconciliation and confirm the card does **not** reappear — the canonical card is long-indexed, so the column search finds it and `ensureCardForRecord` adopts rather than creates.

**This change performs no deletion.** The plan stops at presenting these findings; the delete is a separate, explicitly approved step.

---

## Testing

Pure-logic unit tests (the app's convention), covering:
- `domain` present → valid.
- `domain` missing, checkbox unticked → **invalid**.
- `domain` missing, checkbox ticked → valid.
- **`domain` whitespace-only (`"   "`), checkbox unticked → invalid** (must not pass as "present").
- The checkbox flag never appears in `recordFormToProperties` output.

Plus a **light integration test** asserting the gate really binds in both entry points (standalone drawer and the in-deal "+ New company" panel), and that **the checkbox resets between form openings** — a stale tick must not silently authorise the next company. This requires adding a component-test setup to the app, which is called out as its own step so it can be declined.

## Cleanup

Remove the temporary `/diag` endpoint, its `recentRecords` helper, and the `DIAG_SECRET` binding + secret once the columns are created and the duplicate question is closed.
