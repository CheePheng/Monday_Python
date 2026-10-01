# Historical Activity import — completion report

**Completed** 2026-09-18 13:55 (started 2026-09-17 15:25). Runtime **81,246 s ≈ 22 h 34 m**.
**Failures: 0.**

Scope as agreed: all history, all five activity types, all three destinations. Nothing narrowed.

---

## Headline

| | |
|---|---|
| HubSpot activities scanned | **29,383** |
| monday timeline entries written | **63,043** |
| Activities with at least one entry written | **28,236** |
| Failures | **0** |

Destination split of the 63,043 entries:

| Board | Entries | Share |
|---|---:|---:|
| Contacts | 32,350 | 51.3 % |
| Accounts / Companies | 25,202 | 40.0 % |
| Deals | 5,491 | 8.7 % |

---

## By activity type

| Type | Scanned | Entries written | Phase duration |
|---|---:|---:|---:|
| Emails | 12,595 | 38,144 | 14 h 01 m |
| Calls | 2,946 | 4,357 | 1 h 29 m |
| Notes | 4,509 | 7,313 | 2 h 30 m |
| Meetings | 961 | 2,321 | 50 m |
| Tasks | 8,372 | 10,908 | 3 h 40 m |

Emails dominated the runtime: they averaged 3.0 destinations each and made up 43 % of all
activities. Notes and tasks are what actually populated the **Deals** timelines — 2,269 and 2,411 deal
entries respectively, against 273 from the entire calls phase. Reps log against deals in notes and
tasks, not in mail.

---

## Disposition of everything not written

| Outcome | Count | Meaning |
|---|---:|---|
| Post-cutover, deferred | 718 | Newer than `ACTIVITY_CUTOVER_AT` (2026-09-16T11:16:48Z); live sync owns these, by design |
| No CRM association | 270 | Not linked to any contact/company/deal in HubSpot — nothing to file them against |
| Already present | 371 | Destination already carried the entry (re-run safety working) |
| Staff destinations excluded | 9,092 | Internal participants stripped from fan-out (see below) |
| Missing monday card | 3 | Associated record has no card on the destination board |
| Unaccounted | 159 | See "known gap" below |

**Accounted for: 29,224 of 29,383 = 99.46 %.**

### The staff filter

9,092 *destination cards* were removed from fan-out because the associated contact is a staff member.
This is the control added after the production incident in which 40 campaign emails were filed onto a
sender's own card. It strips the internal copy while leaving the customer-facing one intact — it does
not drop activities. It is overwhelmingly an email phenomenon: the counter moved by 3 across the
entire calls phase and not at all during notes.

### Known gap, measured rather than assumed

159 activities (0.54 %) produced no entry and no counter. At
[`worker/scripts/backfill-activities.mjs`](../../worker/scripts/backfill-activities.mjs) the branch
`if (!dests.length) continue;` fires when the staff filter empties a destination list — an activity
associated *only* to staff contacts, with no company or deal — and nothing records it. The same line
also swallows activities whose every destination was already present.

The figure was derived by difference (`scanned − written − postCutover − noAssoc`) and tracked at
0.21–0.54 % throughout. **Add an explicit counter there before any future re-run.** Do not patch the
importer to chase these 159 retrospectively; they are, by definition, internal-only activities.

---

## Verified after completion

1. **Activities board `5028000492` is unchanged at 3,909 items** — the same figure recorded when
   automations `31010018` / `31010020` were disabled mid-import. Mirroring stayed off for the entire
   run, so the import added **zero** items to that board.
2. **All five phases flagged `done: true`** with cursors cleared — a clean finish, not an abort.
3. **Entries confirmed on all three boards** by sampling live cards: a Contact carrying imported
   calls, an Account carrying imported emails, a Deal carrying imported tasks.
4. **The two open HubSpot tasks** (`399418856154`, `400208219863`, owner `91624653`, both
   "Set up first strategy call") were correctly **deferred as post-cutover** — due 2026-09-17 and
   2026-09-21. They remain on the list to migrate to monday-native tasks.

---

## Outstanding — nothing actioned without approval

All three items are specified in
[`docs/followups/2026-09-17-post-import-corrections.md`](../followups/2026-09-17-post-import-corrections.md):

1. **Restore Contacts' `date_mm7054jz`** from authoritative HubSpot `notes_last_updated`. The import
   tripped the doorbell automations, stamping it with *today*. Paced writes — each one rings the
   doorbell — clearing the column where HubSpot has no value. **Must land before Day 1/3/5.**
2. **Repoint reminder workflows** `1940356394` / `1940356403` / `1940356127` from `date_mm7054jz` to
   `date_mm78yd2c`, final cadence 1 / 3 / 5, and establish why #03 has zero successful runs. All five
   are currently inactive.
3. **Activities-board classifier**, dry-run, three buckets. "Definitely import-created" requires
   *both* a pre-cutover `activity_start_time` **and** a timestamp-matched `[hubspot:<kind>:<id>]`
   marker on the linked source timeline. Never delete ambiguous.

Also still deliberately off: `31010018` / `31010020`, both Task crons, Products & Services backfill
and permissions, Day 1/3/5, Lark.

---

## Throughput note

monday serialises timeline writes **account-wide**. Measured: 8 concurrent writes to one card
1,779 ms each; to eight different cards 1,834 ms; 16-wide 1,790 ms. Concurrency buys nothing, so
subagents or extra processes cannot help. Alias-batching 8 mutations per request (1,323 ms each) was
the only effective lever, and re-benchmarking during this run confirmed 8 is optimal — batch 24 was
no faster and batch 48 returned `REQUEST_TIMEOUT`. Effective rate: **63,043 entries in 22 h 34 m ≈
1,289 ms per entry**, i.e. at the API's floor. The only remaining way to go faster would be to write
fewer entries, which means cutting scope.
