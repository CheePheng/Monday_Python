# Contacts ↔ Companies — sign-off report

**2026-09-12.** The HubSpot ↔ monday CRM sync for Contacts (board 5028000495) and Accounts/Companies
(board 5028000496) is complete, including the Contact → Company relation pass. This report is the
evidence, not a summary of intentions.

---

## 1. Final state

| | |
|---|---|
| Contacts in HubSpot | 94,327 imported → **94,343** monday cards today |
| Companies in HubSpot | 27,506 → **28,030** Accounts cards (490 carry no HubSpot ID) |
| Contact → Company links held | **55,878** |
| Contacts holding ≥1 Account link | **50,842** |
| Links to a card absent from the board | **0** |

### The integrity check that matters most

monday `board_relation` columns are **paired**: the Contacts side and the Accounts side are two views
of the same links, maintained independently by the platform. Measured separately, from two full board
scans:

```
Accounts board — total links held : 55,878
Contacts board — links held in total : 55,878
```

They agree exactly. If the migration had written a link that failed to mirror, or mirrored one it did
not write, these two numbers would diverge. They do not.

---

## 2. The relation pass

```
contacts with a HubSpot company association : 51,436
  relation already correct (no write needed) : 45,715
  relations written                          :  4,141
  left with NO link solely by the ceiling    :  1,580
                                               ------
                                               51,436  ✓

51,436 with an association + 42,906 HubSpot reports "no company" = 94,342  ✓

links preserved that HubSpot does not assert :    858 on 858 contacts
UNEXPLAINED per-input read errors            :      0
FAILED                                       :      0
isolate retries / ceiling markings / flush fallbacks : 0 / 0 / 0
```

Every contact is accounted for on both axes, with nothing left over.

**Prediction vs actual.** The dry run projected 4,206 writes; the canary consumed 60, leaving 4,146
expected. Actual was 4,141, and `already correct` rose by 66 rather than 60 — so ~5 contacts were
linked by the live Worker between the dry run and the full run. The board also gained 8 contacts in
that window. The discrepancy is small and fully explained; it is recorded rather than rounded away.

---

## 3. The safety property, proven on real records

The pass is **additive-only: it never removes a link.** This was not a precaution — it was forced by
measurement. 490 of the 28,030 Accounts cards carry no HubSpot ID, so a link to one of them can never
be resolved from HubSpot and is structurally unreproducible; **571 contact links point at such cards**,
and in every sampled case it was that contact's only company link. A full-replacement write built from
HubSpot's associations alone would have deleted every one of them.

A 100-card stratified canary was run before the full migration and re-verified after it:

| group | n | gained | lost |
|---|---|---|---|
| add-only | 20 | 20 | **0** |
| already-correct | 20 | 0 | **0** |
| multi-company | 20 | 20 | **0** |
| unasserted *(holds a link HubSpot does not assert)* | 20 | 21 | **0** |
| capped *(company's card at the ceiling)* | 20 | 0 | **0** |

All six assertions pass, before the full run and again after 4,141 further writes swept the same
board:

- no link was removed from any card
- all 20 unasserted links survived
- all 20 already-correct cards were left completely alone
- no capped account was newly linked
- existing links to full accounts were retained
- the add-only group actually gained links — i.e. the pass did real work, so the safety assertions are
  not passing vacuously

---

## 4. The ceiling held

monday stops accepting links into a relation cell at ~750. Two Accounts cards are at the limit:

```
750 links  card 2855677250  北京慧信德融科技有限公司  (2,007 HubSpot contacts)
745 links  card 2855584566  中国第一汽车集团有限公司  (1,105 HubSpot contacts)
```

Both are **unchanged** by this run: the projected-count guard refused every addition to them rather
than discovering the limit by being rejected. Nothing else on the board exceeds 295.

**1,580 contacts remain unlinked because of this** — 1,257 on the first card, 360 on the second. The
associations are intact in HubSpot. This is a platform limit, not a defect, but it is a visible gap on
those two accounts and needs a product decision eventually: split them into regional cards, or accept
that those two accounts are managed in HubSpot. **Open — not decided here.**

---

## 5. No write-back

The relation writes generated ~4,200 monday webhooks. The provenance guard suppresses every
monday → HubSpot mutation for an event attributed to our own token.

```
HubSpot companies stamped sync_owner=crm : 1,335  (unchanged across the canary and the full run)
ALL HubSpot companies                    : 27,506
newest company created anywhere in the portal : 2026-09-11T10:42:15Z
```

The newest record in the entire portal predates the run. Not one company was created — the guard held
under the heaviest load it has faced. Measured by creation timestamp against the run window rather
than by a count, because a count drifts with normal business activity and would not have been proof.

---

## 6. What it took to get here

Five rounds of defects in the relation pass, and **not one was found by reading the code**:

| round | defect | found by |
|---|---|---|
| 1 | ceiling hardcoded at 200 when monday accepts ~750; abandoned ~2,705 valid relations | advisor review |
| 2a | already-linked associations charged against the ceiling — an account at 600 links refused its own contacts from #141 | advisor review |
| 2b | a capped account dropped from `want`, which **deletes** it under full-replacement semantics | reproducing 2a |
| 3a | `NaN` ceiling from a bare `--relation-cap` silently disabled the guard entirely | adversarial review |
| 3b | duplicate Accounts cards double-linked one company | adversarial review |
| 3c | additive-only against a **stale snapshot** still destroyed links created mid-run | adversarial review |
| 3d | a rejected write never fed back, so one full cell punished every remaining contact — **the original stall** | adversarial review |
| 4 | HubSpot's `NO_ASSOCIATIONS_FOUND` counted as a failure; would have reported ~43,000 normal records as broken | dry run |
| 5 | the canary's own capped assertion would have failed a correct run | reading the selected sample |

The protections that came out of it: additive-only by construction, a validated ceiling on projected
counts, a pre-write re-read that unions against live state, three-strike account marking, a
40-consecutive-failure abort, and per-group counters that reconcile.

---

## 7. Sign-off status

**Contacts ↔ Companies: complete.** Two-way sync live for both objects, relations populated,
ownership and provenance guards verified under load.

Carried forward, none blocking:

1. **1,580 contacts unlinked** on the two oversized accounts — product decision (§4).
2. **490 Accounts cards with no HubSpot ID** — adoption candidates; created by monday's relation-cell
   "create a new item here" affordance.
3. **`none.com`** — real Parrish Trading LLC firmographic data behind a placeholder identity. Rename or
   merge, not deletion.
4. **The live Worker can still remove a link to an id-less card.** `syncRelationColumn` in
   `src/associations.ts` writes a full replacement, and for a target carrying no HubSpot ID none of its
   four guards holds. Pinned by a characterization test that will fail when fixed. Proposed fifth
   guard: union into `want` any currently-linked card whose own HubSpot ID is empty. **Needs approval —
   it changes the live Work-Management Worker.**

Next phase: Deals (5028000494) and Line Items (5028000489), per
`2026-09-11-deals-lineitems-activities-audit.md` and `2026-09-12-deal-stage-mapping.md`.
