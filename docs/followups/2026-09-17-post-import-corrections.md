# Post-import corrections — required before Day 1/3/5

Raised 2026-09-17, while the historical Activity import was still running. None of these may be
actioned until the full import (emails, calls, notes, meetings, tasks) has finished.

Context: monday automations `31010018` (Deals) and `31010020` (Accounts) mirrored every
Emails & Activities entry onto the old Activities board `5028000492`. They were disabled mid-import
and **must stay off**. The Contacts board has the same trigger via automations `38839624` / `38841239`,
but those stamp `date_mm7054jz` instead of creating items — they are the activity wake-up doorbell and
**must stay on**.

---

## 1. Restore Contacts' Last Activity Date (`date_mm7054jz`)

The import trips the Contacts doorbell automations, which stamp `date_mm7054jz` with **today** for
every contact that receives an imported timeline entry — regardless of how old the underlying activity
is. 1,261 contacts were already affected within the first hours.

HubSpot `notes_last_updated` is authoritative and the mapping is one-way
([`worker/src/config/crm.ts`](../../worker/src/config/crm.ts) — `{ hs: "notes_last_updated",
col: "date_mm7054jz", type: "date", oneWay: true }`). Do **not** assume self-healing; verify it.

**Required end state:** for every affected Contact, monday `date_mm7054jz` == HubSpot
`notes_last_updated` (including *empty* where HubSpot has no value — an empty doorbell is what makes a
contact eligible for a reminder).

Method:

1. Identify the affected set empirically rather than reconstructing it from the importer: query
   Contacts whose `date_mm7054jz` falls inside the import window. This is the real affected set and
   needs no bookkeeping from the import run.
2. Read HubSpot `notes_last_updated` in batches of 100 (`POST /crm/v3/objects/contacts/batch/read`).
3. Write `date_mm7054jz` **only where it differs**, clearing it where HubSpot has no value.
4. Never derive the value from the imported timeline entry's timestamp. Never write to HubSpot.
5. Verify with an aggregate mismatch count (target: 0) plus a hand-checked representative sample.

**Operational constraint, verified in code.** [`worker/src/webhooks.ts`](../../worker/src/webhooks.ts)
checks the wake branch *before* the ignored-columns loop guard, deliberately and with a comment saying
so. Every restoration write therefore rings the doorbell and fires one `syncMondayTimeline` for that
contact. That is safe — the registry means each wake "costs one read and creates nothing twice" — but
it is one monday→HubSpot pass per corrected contact, so the restore must be paced, not fired in bulk.

Note the existing daily `runAll` reconcile performs this same one-way mapping with tested code, but
`MAX_WRITES=25` makes it impractical for a set this size. Prefer a dedicated paced script, and use
`runAll` afterwards only as an independent check.

---

## 2. Reminder workflows #03 / #04 / #05 — repoint before enabling

All five reminder workflows are currently `is_active: false`.

| # | id | cadence (intended) |
|---|---|---|
| #03 首轮提醒 | `1940356394` | **Day 1** (currently configured Day 2) |
| #04 二次预警 | `1940356403` | Day 3 |
| #05 升级告警 | `1940356127` | Day 5 |

#03's live logic, read from monday:

```
trigger: 2 days after date_mm70pa4c (Owner assigned date), 09:00 Asia/Shanghai
  -> IF date_mm7054jz (Last Activity Date) IS EMPTY
     -> IF color_mm6zb4tc (Lead Status) is New
        -> send email via Gmail (askada@asiadt.com)
```

They gate on `date_mm7054jz` — the doorbell column that the import and the automations both stamp. A
stamped contact can never satisfy "is empty", so enabling these as configured would run and chase
nobody.

**Repoint the condition to `date_mm78yd2c` (Last qualifying follow-up date)** — the purpose-built
column the Worker maintains and resets on owner reassignment (`resetHelperOnReassignment`), currently
unpopulated. Correction 1 above is still required regardless, and must land first.

Also outstanding: workflow `1940356394` has **zero** recorded successful runs. Establish why before
trusting it.

---

## 3. Activities-board cleanup — classifier, not a date filter

Boundary snapshot taken at the moment the mirroring automations went off:

- board `5028000492` held **3,909** items; newest pre-existing item id `2861917395`
- **3,897** created 2026-09-17 (3,772 linked to Accounts, 125 to Deals)
- **12** genuine items spanning 2026-04-22 → 2026-09-16

**`created_at == 2026-09-17` is NOT sufficient to delete.** Legitimate live activity — the Worker's
post-cutover sync, or a person logging an activity on an Account/Deal card in monday — mirrored onto
the same board on the same day while the automations were still on.

Build a **dry-run** classifier. A pre-cutover timestamp on its own is NOT enough: a person could log
or backdate a monday activity with an old start date, and it would look identical. Both conditions are
required for the "definitely import-created" bucket:

1. The item's `activity_start_time` precedes `ACTIVITY_CUTOVER_AT` = `2026-09-16T11:16:48Z`. The
   importer refuses post-cutover activities (its `postCutover` counter held at 0 throughout), so live
   sync and human logging are post-cutover by definition.
2. **AND** the linked source card's timeline contains a historical HubSpot entry carrying a
   `[hubspot:<kind>:<id>]` marker **whose timestamp matches that same `activity_start_time`** — not
   merely "the card has a marker somewhere". Binding to the specific entry is what rules out the
   backdated-manual case on a card that also holds imported history. Match the activity kind too
   where the item's name or type makes it available.

Buckets:

- **definitely import-created** — both conditions above hold.
- **definitely genuine / live** — evidence positively places it post-cutover, or it predates the
  import window entirely (the 12 known pre-existing items).
- **ambiguous** — anything else, including items whose source card was since deleted or unlinked, and
  items where no marker matches the timestamp.

**Never delete an ambiguous item.** Anything not positively proven an import artifact is kept.

Use the aggregate comparison — "definitely import-created" against the importer's own company + deal
write counters — as a **sanity check only**, never as deletion evidence for an individual item.

Report all three counts and wait for explicit approval before deleting anything.

---

## 4. Meanwhile, unchanged

Import continues; `31010018`/`31010020` stay OFF; Task crons OFF; Products & Services backfill and
permissions wait; Day 1/3/5 waits; Lark waits. No further broad audits.
