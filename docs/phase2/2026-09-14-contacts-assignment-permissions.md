# Contacts assignment + permissions — complete

**2026-09-14.** The Philippines team needed monday item-level assignment that the permission system
can actually use. Done end to end. This records what the data decided, because several of the
decisions went against the obvious answer.

---

## The requirement, and the constraint that shaped it

From the 2026-09-14 meeting: individual reps should work their own Contacts, and the team leader
(Myla) needs the team's. The blocking fact, in Speaker 1's words, is that monday's assignment
permission **"只能选择的是 people 类型的字段"** — only People columns can be selected. An assignment
kept in a status or dropdown column cannot drive permissions at all.

## What the data decided

A cross-tab of Sales Person against Contact Owner (`scripts/measure-assignment-crosstab.mjs`):

```
Sales Person = Elaine Rivera       4,046   of which 4,015 (99%)  OWNED BY MYLA
Sales Person = Rick Avery Antonio    136   of which   136 (100%) OWNED BY MYLA
Sales Person = Myla Mestiola       2,360   of which 2,157 (91%)  owned by Myla herself
Sales Person = Emily You               1
```

That is the workaround the meeting described — own everything as Myla, carry the real rep in a second
field — visible in the data. **So leader visibility already existed**, and pairing Contact Owner with
Sales Person was enough. A separate "Sales Access" column was considered and rejected: it would have
solved a problem the data says was already solved.

**32 exceptions** where Myla is neither owner nor Sales Person — 26 owned by Rick Antonio (also PH
team) with Elaine as Sales Person, plus 6 stragglers; SEA prospects created Jan–Feb 2026. **HubSpot
ownership was deliberately NOT rewritten to close them.** Editing the authoritative owner field to fix
a monday permission gap would make the CRM less accurate to solve a UI problem, for 0.5% of records
that Rick and Elaine can both already edit.

## The engine change, and why it was necessary

Two facts, checked rather than assumed:

* `formatValue`'s people branch does `ctx.ownersById[value]` — it expects an **owner id**.
* `firstPersonOwnerId` returns an **owner id** to write back.

`sales_user` **is** an owner id, so it becomes a People column with no new mechanism. `sales_person`
is an enumeration whose four values are literally `"Elaine Rivera"`, `"Myla Mestiola"`, `"Emily You"`,
`"Rick Avery Antonio"` — so `ownersById["Elaine Rivera"]` is undefined and **the column would have
rendered empty on all 6,543 contacts while every counter reported success.**

`FieldSpec.peopleByName` adds the missing first hop: name → owner → email → monday user. Only that hop
changes; resolution still ends at an **email**, never at a name matched against monday.

**Ambiguous names resolve to nothing, by construction.** This portal holds two distinct owners both
called "Rick Antonio", so `ownerIdByName` omits any name claimed by more than one owner rather than
taking the first. Pinned in the selftest.

## Migration result

```
contacts scanned          6,543
cells written             6,407
left blank (no account)     136   -> all "Rick Avery Antonio"
contacts with no card         0
MISMATCHES                    0
```

* HubSpot untouched — `sales_person` still on 6,543 contacts, **zero HubSpot writes**.
* Board activity shows **195 writes to `multiple_person_mm76qtz7` and nothing else** from this work.
* Legacy columns renamed, still mapped, still syncing: `Sales Person (legacy)` `color_mm701ff2`,
  `Sales User (legacy)` `dropdown_mm70mxfy`.
* Contact Owner untouched.

Both new People fields are **forward-only** on purpose. A people column's reverse writes an owner id,
and `sales_person` is an enumeration of names, so a reverse would 400. Two-way is a prerequisite for
*deleting* the legacy column, not for creating the new one.

## Permissions

```
board_kind : public
permission : assignee   ("Only items assigned to them in …")
assignee columns: multiple_person_mm6zap53 "Contact owner"
                  multiple_person_mm76qtz7 "Sales Person"
```

**The rule is EDIT-scoped, not visibility-scoped.** The monday dialog reads *"Choose the contacts that
members can **edit**"*. This was genuinely uncertain beforehand — the API exposes no visibility field
and `BoardBasicRoleName`'s enum descriptions are empty — and an earlier warning in this project that
"36,777 unassigned contacts would become invisible" attached that risk to the wrong change. Adding an
assignee column is **monotonic**: it can only widen access. The 36,777 remain visible on a public
board; they are simply not editable by ordinary members.

`set_board_permission` sets only the role (`editor | contributor | assigned_contributor | viewer`) and
**cannot set assignee columns** — that is a UI-only operation, which is why this step was done by hand.

## Open

1. **Rick Avery Antonio** — 136 contacts blank. Needs a HubSpot owner identity whose name matches the
   enum value, and a monday account. Not resolvable by guessing.
2. **Sales User → People** — column `multiple_person_mm76ygkp` exists and is mapped, but ~46,000 cards
   are unpopulated. Roughly 10,000 would be blank (joan zhang ~1,231 in a 10k sample, 小优 ~282, plus
   five owner ids that resolve to no owner record at all). Migration is batched and resumable.
   **Not an assignee column** — no business requirement grants Sales User editing rights.
3. **Retiring the legacy columns** — only once the People columns are two-way, or their two-way
   behaviour is deliberately given up.

---

# 2026-09-15 — Sales Person retired; Sales User is the only assignment field

The requirements meeting settled the open question above by removing it: the team will assign on
**Sales User** and nothing else. All three of the other assignment columns are gone from Contacts.

Open item 3 above said the legacy columns could only go "once the People columns are two-way, or
their two-way behaviour is deliberately given up". The second branch is what happened, deliberately.

## What was deleted (board 5028000495)

| column | id | type | was |
|---|---|---|---|
| Sales Person | `multiple_person_mm76qtz7` | people | `sales_person`, created 2026-09-14 |
| Sales Person (legacy) | `color_mm701ff2` | status | `sales_person`, the original |
| Sales User (legacy) | `dropdown_mm70mxfy` | dropdown | `sales_user`, superseded |

Contacts went from 41 columns to 38. `scripts/retire-sales-person-columns.mjs --apply` did it; the
plan mode of that script prints what will be destroyed and refuses to run out of order.

**HubSpot `sales_person` is untouched** — still on 6,543 contacts, and the script makes no HubSpot
call of any kind. The monday columns were a projection of it. Nothing in this repo now reads or
writes that property, and that is asserted rather than merely recorded in a commit message: see
*"contacts.sales_person is retired"* in `test/reverse-enabled-batch.test.ts`.

## What remains

```
board_kind : public
permission : assignee   ("Choose the contacts that members can edit")
assignee columns: multiple_person_mm6zap53 "Contact owner"
                  multiple_person_mm76ygkp "Sales User"
```

Sales User is a People column mapped from `sales_user`, **forward-only**. The dropdown's old objection
to two-way is gone — a People cell resolves monday user → email → owner id unambiguously, where the
label "Rick Antonio" named two owner ids — but a different one now applies: `CONTACTS_MYLA`'s scope
filter includes `sales_user HAS_PROPERTY`, so a CRM-side reverse write would pull contacts into the
live Work-Management Worker's scope (~957 candidates created since 2026-06-01, of 38,135 with no
`sales_user`). Enabling reverse is a scope decision, not a mapping tweak. Not taken.

## Order, and why it is not a preference

1. permission re-pointed at Contact owner + Sales User — **2026-09-15T04:42:21Z**, verified live
2. the three mappings removed from `src/config/crm.ts`
3. **CRM Worker deployed** without them — version `df2c03db-329b-4c5e-a47e-049573e38f89`
4. columns deleted — **04:58:43Z**

Step 3 before step 4 is load-bearing. monday rejects an *entire* `change_multiple_column_values`
mutation that names an unknown column, so a deployed spec pointing at a deleted column does not
degrade one field — it stops every card on the board from updating, silently. That is the
`text_mm6sdvkq` incident of 2026-09-08. Step 1 before step 4 matters for the same reason in the other
direction: deleting a column still listed as an assignee column would have narrowed who can edit.

Both preconditions are now machine-checked rather than remembered:

* `scripts/retire-sales-person-columns.mjs` reads the board's own newest `update_board_permissions`
  event and refuses if any target still grants edit access. The monday API exposes `permissions` only
  as the bare string `"assignee"`; the assignee column list is UI-only state, so the activity log is
  the only machine-readable source for it. Parser covered by `test/retire-sales-person.test.ts`.
* `scripts/verify-spec-columns-exist.mjs` bundles the real specs and checks every `fields[].col`,
  every `associations[].relationCol` and the bookkeeping columns against the live boards. Run after
  the deletion, across all four CRM boards:

```
ok  companies   board 5028000496  20 refs / 27 live columns
ok  contacts    board 5028000495  32 refs / 38 live columns
ok  deals       board 5028000494  19 refs / 28 live columns
ok  line_items  board 5028000489  22 refs / 25 live columns
```

Run it before any future deploy that follows a column deletion.

## Open, carried forward

1. **428 contacts** reference five HubSpot owner ids that return 404 — their Sales User cell is blank
   and cannot be filled. A HubSpot data-quality item, not a sync defect.
2. **joan zhang (5,962) and 小优 优阅达 (932)** have live owner records and `@dkmeco.com` emails but no
   monday account. One monday invite each fills 6,894 cells.
3. Rick Avery Antonio's 136 `sales_person` blanks are now moot on the monday side — the column they
   would have filled no longer exists. The HubSpot data is still there.
