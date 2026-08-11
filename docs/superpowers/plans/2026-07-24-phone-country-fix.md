# Phone Country Fix + Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Stop the worker forcing `countryShortName: "SG"` on every contact phone (which mangles local numbers), and backfill the ~409 existing contact phones to the corrected format.

**Architecture:** One pure-function change in `worker/src/mapping.ts` (TDD) + a one-time scratchpad backfill that drops the bogus country from existing phone cells.

**Tech Stack:** Cloudflare Worker + vitest; Node scratchpad script (monday GraphQL). Deploy: `wrangler`.

**Spec:** `docs/superpowers/specs/2026-07-24-phone-country-fix-design.md`

---

## Task 1: Fix the `phone` case in `formatValue` (TDD)

**Files:** Modify `worker/src/mapping.ts` (the `case "phone"` line); Test `worker/test/mapping.test.ts`.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("formatValue", ...)` block in `worker/test/mapping.test.ts`:
```ts
  it("phone: international + is kept, no forced country", () =>
    expect(formatValue(f({ type: "phone" }), "+60 12-345 6789", ctx)).toEqual({ phone: "+60123456789" }));
  it("phone: local number -> raw digits, no country", () =>
    expect(formatValue(f({ type: "phone" }), "012-345 6789", ctx)).toEqual({ phone: "0123456789" }));
  it("phone: strips formatting from an international number", () =>
    expect(formatValue(f({ type: "phone" }), "+1 (555) 123-4567", ctx)).toEqual({ phone: "+15551234567" }));
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd worker && npx vitest run test/mapping.test.ts -t phone`
Expected: FAIL — current code returns `{ phone: "...", countryShortName: "SG" }`, so it doesn't equal the country-less expected object.

- [ ] **Step 3: Implement**

In `worker/src/mapping.ts`, replace:
```ts
    case "phone": return { phone: v.replace(/[^\d+]/g, ""), countryShortName: "SG" };
```
with:
```ts
    case "phone": {
      const digits = v.replace(/[^\d]/g, "");
      if (!digits) return null;
      // International (leading +): keep the + so monday reads the country from the code.
      // Local (no +): raw digits, NO country — the contacts are multi-country and HubSpot's own
      // country detection is unreliable, so any forced country would mis-flag the number.
      return v.trim().startsWith("+") ? { phone: "+" + digits } : { phone: digits };
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd worker && npx vitest run test/mapping.test.ts -t phone`
Expected: 3 passed.

- [ ] **Step 5: Full worker gate + commit**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit && npx vitest run`
Expected: tsc clean; all pass.
```bash
git add worker/src/mapping.ts worker/test/mapping.test.ts
git commit -m "fix(worker): stop forcing SG country on phones; keep + international, raw digits for local"
```

- [ ] **Step 6: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: new Version ID.

---

## Task 2: Backfill existing contact phones

**Files:** Create `scratchpad/fix-phones.cjs` (one-time, not committed to the worker).

Every existing phone cell was written with `countryShortName: "SG"`. The stored digits are correct; only
the country is wrong. The backfill re-writes each cell as `{ phone: <current digits/+digits> }` with **no
country** — for a `+` number monday keeps reading the country from the code; for a local number it becomes
plain digits (no wrong flag). Idempotent: a cell already lacking `countryShortName` is skipped.

- [ ] **Step 1: Write the script**

```js
// For each contact card with a phone that still carries a countryShortName, re-write {phone:<text>} with
// no country. `text` is already the correct digit string (with or without +), verified live.
const COL = "phone_mm4s31p3", BOARD = "5029639630";
// page the board -> items with column_values(ids:[COL]) { text value }
// parse value.countryShortName; if a phone text exists AND countryShortName is set -> needs re-write
// (dry: count; live: change_multiple_column_values(board_id, item_id, { [COL]: { phone: text } }), backoff on rate limit)
```
Re-write value is exactly `{ [COL]: { phone: text } }` (text = the existing digits or `+digits`).

- [ ] **Step 2: Dry run — confirm the count**

Run: `node fix-phones.cjs --dry`
Expected: prints `would re-write: N` (≈409 — the SG/MY/other-country cells) and `already clean: M`.

- [ ] **Step 3: Live run**

Run: `node fix-phones.cjs`
Expected: `re-wrote: N, errors: 0`.

- [ ] **Step 4: Verify**

Run: `node fix-phones.cjs --dry`
Expected: `would re-write: 0` — every phone cell now has no forced country.

---

## Self-Review

**Spec coverage:** mapping fix → Task 1; backfill all existing → Task 2. ✅

**Placeholder scan:** Task 1 steps are complete code; Task 2's script is described by its exact re-write
value + behaviour (a scratchpad one-off, consistent with prior backfills like the created-date fill). ✅

**Type/behaviour consistency:** the backfill's per-cell decision (`+`-prefixed keeps `+`, else raw digits,
drop country) mirrors the `formatValue` fix exactly, so a re-written cell equals what a fresh sync would
now produce. ✅

## Rollback

`git revert` the mapping commit + redeploy. The backfill only removed a (wrong) country field from phone
cells; monday keeps deleted-item history but column edits aren't versioned — however the digits are
unchanged, so nothing is lost.
