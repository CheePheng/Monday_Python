# Phase B rollout — how to exercise the CRM sync given the inert cutover

**Settles the question raised at the Task 11 checkpoint.** The code became safer than the original
rollout plan; this is the rollout plan catching up.

## The problem, stated exactly

`CRM_CUTOVER_AT_MS = Number.POSITIVE_INFINITY` (shipped). Therefore:

| Record state | `mayCreateCrmCard` | Consequence |
|---|---|---|
| unstamped, any `createdate` | **false** | no monday card, ever |
| `sync_owner = "crm"` | true | card created |
| `sync_owner = "wm"` / unknown | false | no card |

And `sync_owner` **does not exist as a property in this HubSpot portal** — Phase 1 explicitly forbids
creating it. So *every* record in the portal is "unstamped".

**Conclusion: as shipped, the CRM sync creates ZERO monday cards.** Not few — zero. Phase B
(`dryRun: false`, `writeHubspot: false`) would therefore observe nothing at all, and someone would
discover this during deployment rather than now.

### A verified fact that shapes the answer

HubSpot **silently ignores** an unknown property in a fetch. Confirmed 2026-09-07 by requesting
`["email", "sync_owner", "createdate"]` for contact `520796719820`: the response contained `email` and
`createdate` and simply omitted `sync_owner`. **No 400, no error.**

That matters twice over:

- The CRM fetch works today without the property existing, and `sync_owner` reads as `undefined` →
  unstamped → fail closed. The design degrades safely rather than crashing.
- It means a **finite cutover needs no HubSpot schema change**, which is what makes Option 1 viable
  inside Phase 1's constraints.

## Options

### Option 1 — finite cutover, HubSpot writes still disabled ✅ RECOMMENDED

Set `CRM_CUTOVER_AT_MS` to a real timestamp; keep `writeHubspot: false`.

- ✅ No HubSpot schema change — works with `sync_owner` absent.
- ✅ Exercises the **real** forward path: discovery → `mayCreateCrmCard` → `ensureCardForRecord` → card.
- ✅ Claims remain impossible (`writeHubspot: false` → `claimOwnership` returns `null` →
  `action=claim-suppressed`, and Task 9 does **not** fabricate local ownership).
- ⚠️ Sets the cutover, which is also the claim trigger. If someone later flips `writeHubspot: true`
  while the cutover is still an early date, every record created since becomes a claim candidate.

**Refinement that makes this materially safer — set the cutover to the moment the test begins, not a
past date.** Then the eligible set is exactly the records created *during* the test, i.e. the two or
three you create yourself. A past date instead makes the whole tail eligible: ~2,320 contacts were
created in the 98 days since 1 June (≈24/day), so a cutover of "one month ago" would put ~700 records
one touch away from being carded. CRM specs are `skipFullReconcile`, so nothing sweeps them in bulk —
but a HubSpot import or workflow touching many records would card them all at once.

### Option 2 — explicitly `sync_owner=crm` test records

Hand-stamp two or three records so they pass the gate under the infinite cutover.

- ✅ Tightest possible blast radius: exactly the records stamped, and no cutover is set.
- ❌ **Requires creating the `sync_owner` property first** — a HubSpot schema change that Phase 1
  forbids and that the plan assigns to Phase 2.
- ❌ Stamping is itself a HubSpot write, so it must be done by hand in the HubSpot UI, not by the Worker.

Correct, but blocked by the Phase-1 constraint. Becomes the better option **after** Phase 2 creates the
property, because it needs no cutover at all.

## Recommended sequence

```
1.  Create 2-3 disposable test Contacts/Companies in HubSpot          (manual, no code)
        ↓  note the exact time you are about to start
2.  CRM Worker: CRM_CUTOVER_AT_MS = <that moment>, writeHubspot=false, dryRun=false
        ↓  WM Worker untouched — it has no cutover and no ownership
3.  Create 2-3 MORE test records in HubSpot  ->  these are the eligible set
        ↓
4.  Observe: cards appear on boards 5028000495 / 5028000496 for ONLY those records.
    Verify the pre-existing portal produced nothing.
        ↓
5.  Edit a card to force a reverse write. Expect in the logs:
       action=claim-suppressed reason="dry-run or writes disabled"
       action=write-refused    reason="unstamped: crm must claim before writing"
    and ZERO HubSpot mutations.
        ↓
6.  STOP. Report. Do not proceed without approval.
```

Steps 5's two log lines are the real deliverable: they prove the claim path is wired and correctly
inert, without a single HubSpot write.

## Before HubSpot writes / automatic claiming are ever enabled

These remain **mandatory** and are not part of Phase B:

1. **`sync_owner` property created** in HubSpot (Phase 2), with a single-select or text definition an
   ops user can set to `hold` to park a record.
2. **The identical finite `CRM_CUTOVER_AT` on BOTH Workers.** A mismatch means each side disagrees about
   who owns unstamped records — the split-brain the whole design exists to prevent.
3. **The claim rehearsal (PA-2):** finite cutover + `writeHubspot: false`, read every
   `DRY hubspot CLAIM <object>/<id>` line, confirm the candidate list is what you expect, *then* enable
   writes.
4. **PA-1 public email-provider domains** fail closed for Company adoption/creation
   (`gmail.com`, `qq.com`, `163.com`, `126.com`, `sina.com`, `foxmail.com`, `yahoo.com`, `hotmail.com`,
   `outlook.com`). `adoptionKey`'s hostname check does not catch these — they are valid hostnames.
5. **P2-1 ownership activation gate** for the remaining unguarded HubSpot mutation paths
   (`putAssociation` / `deleteAssociation`), required before any CRM spec declares `associations`.

## What must NOT be done

**Do not weaken `mayCreateCrmCard` to make Phase B easier.** The refusal of unstamped pre-cutover
records is the no-historical-import invariant itself. Both options above keep it: a pre-cutover
unstamped record is uncardable under a finite cutover *and* under the infinite one, asserted in
`crm-coexistence-matrix.test.ts` section F.
