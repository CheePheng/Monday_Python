# Duplicate Card Cleanup + Created-Date Catch-Up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Delete the 50 orphaned duplicate cards left by the pre-fix card race, and bring the Created date column to 100% current on the Deals, Company Follow Up and Contact Follow Up boards.

**Architecture:** Two independent workstreams, run in this order. (1) A one-time, idempotent, verify-before-delete cleanup script. (2) A small worker change marking one-way HubSpot→monday columns as webhook-ignorable, deployed before a one-time idempotent fill script. Cleanup runs FIRST so the fill never writes to a card that is about to be deleted.

**Tech Stack:** Node scratchpad scripts (monday GraphQL 2026-07 + HubSpot CRM v3); TypeScript Cloudflare Worker + vitest; `wrangler deploy`.

---

## Root cause (established in Phase 1 — not re-litigated here)

All 50 duplicates were created 0–1 seconds apart by the eventually-consistent
`items_page_by_column_values` read race. **Zero were created after the reservation fix
(2026-07-23 ~19:00 local, `2e16bdd`/`ef92c74`).** They are legacy wreckage, not an active leak.
`indexByHubspotId` (`idx[key] = item`) keeps the last card in board order, so the twin is orphaned
and never updated again — hence the divergent sync stamps.

**Safety established:** no delete/archive webhook on any of the three boards, and the subitems board
has no webhooks at all → deleting a monday card cannot propagate to HubSpot. Cards remain in the
board recycle bin ~30 days.

**Canonical rule:** keep the card with the newest sync state (the one the reconcile actually updates);
ties broken by most subitems, then links, then filled columns. Verified against HubSpot: the two pairs
where a stale card had MORE subitems were holding the *same* line-item id twice — corruption, not data.
The keeper matches HubSpot exactly in every one of the 50 groups.

---

## File Structure

| File | Responsibility |
|---|---|
| `scratchpad/dupe-plan.json` | Already generated: the 50 keep/drop decisions |
| `scratchpad/cleanup.cjs` | One-time cleanup: re-verify each card, delete the orphan, report |
| `scratchpad/census.cjs` | Already written: re-run to prove 0 duplicate groups |
| `worker/src/types.ts` | `FieldSpec.oneWay` marker |
| `worker/src/config.ts` | Mark the 3 `createdate` fields one-way |
| `worker/src/webhooks.ts` | `ignoredColumns(spec)` — pure, testable; replaces the inline set |
| `worker/test/webhooks.test.ts` | Tests for `ignoredColumns` |
| `scratchpad/fill-created.cjs` | One-time idempotent Created-date fill for all 3 boards |

---

### Task 1: Delete the 50 duplicate cards

**Files:** Create `scratchpad/cleanup.cjs`; consumes `scratchpad/dupe-plan.json`.

- [ ] **Step 1: Write the cleanup script**

Re-verifies immediately before each delete and aborts that group on any drift. Idempotent: a
card already gone is reported and skipped, so the script is safe to re-run.

```js
// For each planned group: confirm the drop card STILL has the same HubSpot id, STILL has a
// surviving sibling carrying that id, and is NOT the keeper. Only then delete.
const pre = await mapi(`query ($i:[ID!],$c:[String!]) { items(ids:$i, limit:100) {
  id column_values(ids:$c) { text } } }`, { i: [keep, drop], c: [idCol] });
const byId = Object.fromEntries(pre.items.map(i => [i.id, (i.column_values[0]?.text||"").trim()]));
if (!byId[drop])            { skipped++; continue; }              // already deleted
if (byId[drop] !== hs)      { aborted.push(...); continue; }       // id changed under us
if (byId[keep] !== hs)      { aborted.push(...); continue; }       // keeper no longer carries the id
await mapi(`mutation ($i:ID!) { delete_item(item_id:$i) { id } }`, { i: drop });
```

- [ ] **Step 2: Run it**

Run: `node cleanup.cjs`
Expected: `deleted: 50, skipped: 0, aborted: 0`

- [ ] **Step 3: Prove the boards are clean**

Run: `node census.cjs`
Expected: `DUPLICATE GROUPS: 0` on all three boards, and card counts down by exactly
13 / 15 / 22 (629→616, 693→678, 731→709).

---

### Task 2: Mark one-way columns webhook-ignorable

**Files:** Modify `worker/src/types.ts`, `worker/src/config.ts`, `worker/src/webhooks.ts`;
Create `worker/test/webhooks.test.ts`.

Rationale: writing Created date on ~1,300 cards fires ~1,300 `change_column_value` webhooks. The
loop guard currently ignores only Sync State / HubSpot ID / Link, so each would run a full
single-record reconcile against HubSpot. A one-way HubSpot→monday field has nothing to push back,
so reconciling on it is pure waste. The daily sweep still heals a manual edit.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { ignoredColumns } from "../src/webhooks";
import { DEALS, CONTACTS_MYLA, COMPANIES_MYLA } from "../src/config";

describe("ignoredColumns", () => {
  it("ignores our own bookkeeping columns", () => {
    const s = ignoredColumns(DEALS);
    expect(s.has(DEALS.syncStateCol)).toBe(true);
    expect(s.has(DEALS.idCol)).toBe(true);
  });
  it("ignores one-way createdate columns on every board", () => {
    for (const spec of [DEALS, CONTACTS_MYLA, COMPANIES_MYLA]) {
      const f = spec.fields.find(x => x.hs === "createdate")!;
      expect(f.oneWay, `${spec.object} createdate must be one-way`).toBe(true);
      expect(ignoredColumns(spec).has(f.col)).toBe(true);
    }
  });
  it("does NOT ignore reversible fields — those must still reach HubSpot", () => {
    const s = ignoredColumns(DEALS);
    for (const f of DEALS.fields.filter(x => x.reverse)) expect(s.has(f.col)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run test/webhooks.test.ts`
Expected: FAIL — `ignoredColumns` is not exported.

- [ ] **Step 3: Implement**

`types.ts`, inside `FieldSpec`:
```ts
  /** HubSpot -> monday only. A monday edit has nothing to push back, so its webhook is ignored
   * instead of triggering a full reconcile; the daily sweep still heals a manual edit. */
  oneWay?: boolean;
```

`config.ts` — add `oneWay: true` to all three `createdate` fields:
```ts
{ hs: "createdate", col: "date_mm5hsbzv", type: "date", oneWay: true },   // DEALS
{ hs: "createdate", col: "date_mm5hmk5v", type: "date", oneWay: true },   // COMPANIES_MYLA
{ hs: "createdate", col: "date_mm4s2bjd", type: "date", oneWay: true },   // CONTACTS_MYLA
```

`webhooks.ts` — replace the inline `bookkeeping` set with:
```ts
/** Columns whose monday-side change must NOT trigger a reconcile: our own bookkeeping (Sync State /
 * HubSpot ID / Link) plus one-way HubSpot->monday fields, which have nothing to push back. */
export function ignoredColumns(spec: ObjectSpec): Set<string> {
  const out = new Set<string>([spec.syncStateCol, spec.idCol, spec.linkCol].filter(Boolean) as string[]);
  for (const f of spec.fields) if (f.oneWay) out.add(f.col);
  return out;
}
```
and at the call site:
```ts
const ignored = ignoredColumns(spec);
if (columnId && ignored.has(columnId)) {
  console.log(`[webhook] source=monday item=${itemId} type=${type} col=${columnId} action=ignored reason="bookkeeping/one-way column"`);
  return new Response("ok");
}
```

- [ ] **Step 4: Green gate**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests pass (199 existing + 3 new).

- [ ] **Step 5: Commit + deploy**

```bash
git add worker/src worker/test && git commit -m "fix(worker): one-way columns no longer trigger a reverse reconcile"
npx wrangler deploy
```

---

### Task 3: Fill Created date on all three boards

**Files:** Create `scratchpad/fill-created.cjs`.

**CRITICAL — value format.** `mapping.ts formatValue` writes `{ date: createdate.slice(0, 10) }` and
`expectedText` compares `createdate.slice(0, 10)` against the column text. The fill MUST use that exact
UTC-truncated form. Any other format leaves permanent drift, and the daily reconcile would rewrite all
1,300 cards every single day.

- [ ] **Step 1: Write the fill script**

Idempotent and resumable: it reads current state, writes only where the value is missing or differs,
so re-running after an interruption continues cleanly.

```js
const BOARDS = [
  { n:"Deals",     b:"5029480547", id:"numeric_mm4nz332", date:"date_mm5hsbzv", obj:"deals" },
  { n:"Companies", b:"5029639440", id:"numeric_mm4xkk3a", date:"date_mm5hmk5v", obj:"companies" },
  { n:"Contacts",  b:"5029639630", id:"numeric_mm4xw7rk", date:"date_mm4s2bjd", obj:"contacts" },
];
// 1. page the board -> { itemId, hubspotId, currentDateText }
// 2. HubSpot batch read (100/request): POST /crm/v3/objects/{obj}/batch/read
//    body { properties:["createdate"], inputs:[{id}] }
// 3. want = createdate.slice(0,10); write ONLY where want && want !== currentDateText
// 4. change_multiple_column_values(board_id, item_id, column_values: {[date]:{date:want}})
//    with backoff on 429 / "complexity"
```

- [ ] **Step 2: Dry run first — TWO HARD GATES before any write**

Run: `node fill-created.cjs --dry`
Expected: per-board counts of `would write` / `already correct` / `no HubSpot createdate`, zero
writes performed, **and a printed sample of the raw HubSpot `createdate` value**.

**GATE 1 — `createdate` must be an ISO string, not epoch millis.** The whole pipeline relies on
`createdate.slice(0, 10)`. On an ISO value (`"2026-07-22T09:15:00Z"`) that yields `"2026-07-22"`.
If the batch-read endpoint returns epoch millis (`"1753176900000"`), the same slice yields
`"1753176900"` — garbage that would be written into 1,300 date cells. The dry run prints the raw
value; confirm it is ISO before proceeding. If it is epoch, parse it with `new Date(Number(v))`
and re-verify.

**GATE 2 — Contacts must show a near-zero `would write` count.** `date_mm4s2bjd` is titled
**"Registration Date"** and is already fully populated. The config has mapped `createdate` into it
all along, so the sync has been maintaining it and differences should be almost none. A LARGE
`would write` count on Contacts means the column holds something that is NOT HubSpot's createdate —
STOP and investigate rather than overwrite pre-existing business data. Deals and Companies are
expected to show large counts (their columns are new and mostly empty); Contacts is not.

- [ ] **Step 3: Live run**

Run: `node fill-created.cjs`
Expected: writes complete with 0 errors.

- [ ] **Step 4: Verify 100%**

Run: `node fill-created.cjs --dry` again.
Expected: `would write: 0` on all three boards — i.e. every card matches HubSpot exactly.

---

### Task 4: Final verification

- [ ] **Step 1: No duplicates, no resurrection**

Run: `node census.cjs`
Expected: `DUPLICATE GROUPS: 0` on all three boards — confirming the reconcile did not
re-create the deleted cards.

- [ ] **Step 2: Confirm the loop guard is live**

Check `wrangler tail` output during the fill for
`action=ignored reason="bookkeeping/one-way column"` — proving the date writes are no-ops
rather than full reconciles.

---

## Rollback

- Deleted cards: restore from each board's recycle bin (~30 days).
- Worker change: `git revert` + `wrangler deploy`.
- The fill only ever writes HubSpot's own `createdate` into a display column; there is no
  monday→HubSpot write anywhere in this plan.
