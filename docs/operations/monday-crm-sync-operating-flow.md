# How the monday CRM ↔ HubSpot sync works

**Audience:** sales, operations and management. No coding knowledge needed.
**Covers:** the CRM boards — **Contacts** and **Accounts/Companies**.
**Does not cover:** the older Work Management sync, which runs separately and is unaffected by any of this.

---

## 1. In one picture

```
        A salesperson creates a Contact
                  in HubSpot
                        │
                        ▼
             HubSpot notifies our system
                        │
                        ▼
            ┌───────────────────────┐
            │  Sync service         │
            │  (Cloudflare Worker)  │
            │                       │
            │  "Is this record      │
            │   mine to handle?"    │
            └───────────┬───────────┘
                        │  yes
                        ▼
        A card appears on the monday CRM board
                        │
                        ▼
        Reps read it, and edit the agreed fields
                        │
                        ▼
        Approved edits go back to HubSpot
```

**HubSpot is the master record.** monday CRM is where the team works. Most information flows
HubSpot → monday; only a short, agreed list of fields travels back.

---

## 2. Where records come from

| | Created in | Appears in monday? |
|---|---|---|
| **Contacts** | **HubSpot only** | Yes, automatically |
| **Companies / Accounts** | HubSpot, **or** monday | Yes, both directions |

**Contacts are created in HubSpot.** This was decided in the 2026-09-07 meeting: new contacts come from
HubSpot, and the sync brings them into monday.

**If a rep types a new Contact row directly onto the monday board, nothing happens.** No HubSpot contact
is created. The row just sits there. This is deliberate, not a fault — see §8.

---

## 3. Which records are eligible

Not every HubSpot record becomes a monday CRM card. Two rules decide:

**Rule 1 — only new records.** There is a **cutover date/time**. Records created **before** it are
history and are left alone. Records created **at or after** it are handled by the CRM sync.

> **We do not import the existing HubSpot database.** There are tens of thousands of historical
> contacts and companies. Bringing them in would flood the board and make it unusable. Only new
> records flow in from the cutover onward.

**Rule 2 — one owner per record.** Two separate syncs exist (the old Work Management one and this new
CRM one). To stop them fighting over the same HubSpot record, each record can be marked as belonging to
one of them. A record marked as the other sync's is left completely alone.

Notably, **"Sales User" is not one of the rules.** The older sync only handles contacts that have a
Sales User assigned. That would have been wrong here: **771 of the 2,318 contacts created since June
2026 have no Sales User** — roughly one in three. Using that rule would have silently dropped a third
of all new contacts. The CRM sync ignores Sales User entirely.

---

## 4. What syncs, and in which direction

### Contacts

| Field on the monday board | Direction | Notes |
|---|---|---|
| First name, Last Name | **Two-way** | |
| Job Title | **Two-way** | Free text, as in HubSpot |
| Phone | **Two-way** | |
| Lead Status | **Two-way** | Fixed list of 8 HubSpot values |
| **Email** | HubSpot → monday | Read-only in monday. It identifies the person, so an accidental edit could match the wrong record |
| Company name | HubSpot → monday | The plain text name. The real link is the Accounts relation (§6) |
| Contact Source | HubSpot → monday | ~200 historical values; not a list reps should pick from |
| Event Name | HubSpot → monday | |
| Created date | HubSpot → monday | HubSpot owns it |
| **Contact Owner (synced)** | Saved edits only | See the note below |
| HubSpot ID, Sync State | System use | Do not edit. See §9 |
| HubSpot Link | System use | Click it to open the record in HubSpot |

### Accounts / Companies

| Field | Direction |
|---|---|
| Company Name, City, State/Region, Postal code, Annual Revenue, LinkedIn, Description, Type | **Two-way** |
| **Industry (HubSpot)** | HubSpot → monday |
| Partner With (HubSpot) | HubSpot → monday |
| No. of employees | HubSpot → monday |
| Time zone, Created date | HubSpot → monday |
| **Company Owner (synced)** | Saved edits only |
| Domain | Used to match companies (§7) |

> **"Owner" fields behave differently on purpose.** In August 2026 a contact's owner was silently
> reassigned from one person to another with nobody having touched it — a background sync overwrote
> HubSpot from a stale monday column. Owner fields now only change HubSpot when someone **deliberately
> saves** the record in the app. A passive background refresh can never reassign an owner again.

### Two Industry columns — which is which?

The Accounts board shows **"Industry"** and **"Industry (HubSpot)"**. This is intentional.

HubSpot's industry list has around **250** entries (English and Chinese mixed, heavily duplicated).
monday's built-in list has **47**. Only **8** names appear on both. They cannot be merged without
either losing data or polluting monday's list with hundreds of HubSpot values.

- **Industry (HubSpot)** — filled by the sync. Shows what HubSpot holds.
- **Industry** — monday's own column. Untouched by the sync. Use it freely for monday-side reporting.

---

## 5. When does it update?

Within seconds of a HubSpot change, most of the time — HubSpot notifies the sync directly.

There is no overnight sweep of all records for the CRM boards, by design: sweeping tens of thousands of
records nightly would be slow, expensive, and would risk re-touching history.

---

## 6. Contacts ↔ Companies

The monday **Accounts** column on a Contact card, and the **Contacts** column on an Account card, are
filled from HubSpot's own associations.

**This is one-way for now: HubSpot → monday.**

If you link or unlink companies and contacts **on the monday board**, that change **is not sent to
HubSpot**, and the next update from HubSpot will set it back. To change a real relationship, change it
in HubSpot.

This restriction is temporary and deliberate — the safety checks that protect every other HubSpot write
do not yet cover association changes, so association writing stays switched off until they do.

**Roughly half of new contacts have no company at all** (1,118 of 2,320 since June 2026), so an empty
Accounts column is normal and not a sign of a problem.

---

## 7. Creating a Company from monday

Companies **can** be created from the monday board. When a new Account card is saved:

1. The sync reads the card's **Domain**.
2. **No usable domain → nothing is created in HubSpot.** The card's Sync State reads
   `not synced — needs domain`.
3. It searches HubSpot for a company with that domain.
   - **Found** → the card is linked to the existing company. No duplicate is made.
   - **Not found** → a new HubSpot company is created.

**Companies are never matched by name.** "ABC Trading", "ABC Trading Sdn Bhd" and "ABC Trading
Malaysia" may be three different businesses. Only the domain is trusted.

**Personal email domains are rejected.** `gmail.com`, `qq.com`, `163.com`, `yahoo.com`, `outlook.com`
and similar are refused as a company domain. This is not theoretical — five companies in HubSpot
already carry one, so `gmail.com` would have matched an unrelated Shanghai media company. Use the
company's real website domain.

---

## 8. Deletions and manual rows

| What happens | Result |
|---|---|
| A HubSpot Contact is deleted | Its monday CRM card is removed |
| A HubSpot Company is deleted | Its monday CRM card is removed |
| A **monday card** is deleted | **Nothing is deleted in HubSpot.** HubSpot is the master record |
| A rep types a new Contact row in monday | Nothing is created in HubSpot |

The system has **no ability to delete a HubSpot contact or company** — that capability does not exist in
the code at all, so it cannot happen by accident.

---

## 9. What "Sync State" means

A system column holding the timestamp of the last successful sync of that record. It is how the sync
decides which side changed most recently.

**Please don't edit or clear it.** Doing so can make the sync think monday is newer than it is.

It sometimes shows a message instead, e.g. `not synced — needs domain` (§7).

---

## 10. Not in scope today

| | Status |
|---|---|
| **Deals** | Not synced to the CRM boards. Deals already sync to the separate Work Management boards |
| **Activities timeline** | monday's own. Emails, calls and meetings logged in HubSpot are **not** copied across |
| **24-hour owner follow-up reminder** | Planned next, not built. The chasing itself already runs as monday workflows **#03 / #04 / #05**, live at **2 / 3 / 5 days** after Owner assigned date. Intended cadence is **1 / 3 / 5** — so only **#03** changes, 2 days → 1 day. Not changed yet: it waits until the Activity sync is proven and enabled, because retiming a chaser while the thing that silences it is still inert would chase reps over contacts they had in fact worked |
| **Sales Playbook library** | Planned, not built |
| **Sales User column** | Left empty; not used by the CRM sync |
| **Vendors** | Left empty for now — 89 possible values need a proper dropdown first |

> **On the Activities timeline:** HubSpot has a property called *"Number of Sales Activities"*, which
> sounds related but is only a **count** — the number 7, say. monday's Activities area holds the actual
> emails, calls and notes. They are different things and must not be connected.
>
> **Similarly for Priority:** HubSpot's 优先级 holds follow-up deadlines (`P1_2小时内`, `P2_1周内`…)
> while monday's Priority holds High/Medium/Low. Same name, different meaning — deliberately not linked.

---

## 11. "It hasn't synced" — what to check

Work down this list:

1. **Was the record created before the cutover?** History is deliberately excluded (§3). Expected.
2. **Is it a Contact you created in monday?** Contacts must be created in HubSpot (§2). Expected.
3. **Is it a Company with no domain, or a personal email domain?** See §7. Check the card's Sync State.
4. **Did you edit a HubSpot → monday field?** Your change will be overwritten. Check the direction in §4.
5. **Did you change a company/contact link in monday?** One-way for now (§6). Change it in HubSpot.
6. **Did you edit an Owner field and not press Save?** Owner changes need a deliberate save (§4).
7. **Only a few seconds since the change?** Give it a moment (§5).
8. **Is the record marked as belonging to the other sync?** It will be left alone (§3, rule 2).

If none of these explains it, send the **HubSpot record ID** and the **monday card link** to whoever
maintains the sync — every decision is logged with a reason, so "why didn't this sync" is answerable
from the logs.

---

*Companion technical documents: `docs/superpowers/plans/2026-09-07-monday-crm-phase1.md` (implementation),
`docs/handoff/2026-09-07-monday-crm-sync-handoff.md` (specification),
`docs/rollout/2026-09-07-phase-b-cutover-sequence.md` (rollout).*
