# Deal Cockpit v3.0 — Sync correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Amount, Currency and Close date entered in the Deal Cockpit app actually reach HubSpot — they currently never do — plus two small follow-ups exposed by that fix.

**Architecture:** The Worker already has everything needed: `buildReversePatch` (edits) and `buildCreateProperties` (app-created deals) push every field marked `reverse: true`, and `expectedText` (mapping.ts:55-67) already number-normalizes and date-slices so a matching value produces no phantom diff. So the fix is three `reverse: true` flags in `config.ts`, guarded by tests that use the **real `DEALS` spec** (so they pin the config, not just the generic machinery). Two small app fixes ride along: remove the dead Pipeline dropdown, and stop an unguarded `deleteItem` from becoming an unhandled rejection.

**Tech Stack:** TypeScript, Cloudflare Workers (`wrangler`, `vitest`); React 18 + Vite (`monday-app`).

**Spec:** `docs/superpowers/specs/2026-07-16-deal-cockpit-v3.0-sync-correctness.md`.

**Key column ids (real Deals board):** HubSpot Deal ID `numeric_mm4nz332` · Amount `numeric_mm531t6e` · Currency `color_mm53vk99` · Close Date `date_mm53ecz3` · Stage `color_mm53fh1r` · Sales Users `multiple_person_mm532m82`. Stage group `group_mm4nf6fw` = "Appointment Scheduled"; Unassigned group `group_mm53yk6d`.

---

## Task 1: Reverse Amount / Currency / Close date (TDD, real DEALS spec)

**Files:** Modify `worker/src/config.ts`; Test `worker/test/reconcile.test.ts`.

- [ ] **Step 1: Write the failing tests.** Append to `worker/test/reconcile.test.ts` (the file already imports `fieldDiffs`, `buildReversePatch`, `buildCreateProperties`, the `item()` helper, and the `Ctx`/`ObjectSpec` types — reuse them; add a `DEALS` import from `../src/config`):

```typescript
import { DEALS } from "../src/config";

describe("deal Amount / Currency / Close date reverse to HubSpot (real DEALS spec)", () => {
  // Empty label dicts + no owners: keeps unrelated fields from producing noise. We assert only on the
  // field under test, the same way the sales_user suite does.
  const dctx: Ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {},
    ownerIdByEmail: {}, portalId: 1 };

  // A deal card in its stage group with amount/currency/close-date columns filled.
  const dItem = (cols: { amount?: string; currency?: string; close?: string }) => item({
    name: "Acme", group: { id: "group_mm4nf6fw" },
    column_values: [
      { id: "numeric_mm4nz332", text: "9001" },
      { id: "numeric_mm531t6e", text: cols.amount ?? "5000" },
      { id: "color_mm53vk99", text: cols.currency ?? "USD" },
      { id: "date_mm53ecz3", text: cols.close ?? "2026-07-31" },
    ],
  });
  // HubSpot side: sales_user set so routing keeps it in the stage group (not Unassigned).
  const dRec = (props: Record<string, string> = {}) => ({
    id: "9001",
    properties: {
      dealname: "Acme", dealstage: "appointmentscheduled", sales_user: "555",
      amount: "5000.00", deal_currency_code: "USD", closedate: "2026-07-31T00:00:00Z", ...props,
    },
  });
  const byCol = (d: ReturnType<typeof fieldDiffs>, col: string) => d.find(x => x.f?.col === col);

  it("no phantom diff: HubSpot 5000.00 vs monday 5000 (guards the reverse loop)", () =>
    expect(byCol(fieldDiffs(dRec(), dItem({}), DEALS, dctx), "numeric_mm531t6e")).toBeUndefined());

  it("no phantom diff: HubSpot ISO close date vs monday YYYY-MM-DD", () =>
    expect(byCol(fieldDiffs(dRec(), dItem({}), DEALS, dctx), "date_mm53ecz3")).toBeUndefined());

  it("an amount edited in monday reverses to HubSpot", () => {
    const md = dItem({ amount: "7500" });
    const patch = buildReversePatch(fieldDiffs(dRec(), md, DEALS, dctx), md, DEALS, dctx);
    expect(patch.amount).toBe("7500");
  });

  it("a close date edited in monday reverses to HubSpot", () => {
    const md = dItem({ close: "2026-08-15" });
    const patch = buildReversePatch(fieldDiffs(dRec(), md, DEALS, dctx), md, DEALS, dctx);
    expect(patch.closedate).toBe("2026-08-15");
  });

  it("a currency changed in monday reverses to HubSpot", () => {
    const md = dItem({ currency: "CNY" });
    const patch = buildReversePatch(fieldDiffs(dRec(), md, DEALS, dctx), md, DEALS, dctx);
    expect(patch.deal_currency_code).toBe("CNY");
  });

  it("a deal created in monday sends amount, currency and close date to HubSpot", () =>
    expect(buildCreateProperties(dItem({}), DEALS, dctx)).toMatchObject({
      amount: "5000", deal_currency_code: "USD", closedate: "2026-07-31",
    }));
});
```

- [ ] **Step 2: Run, expect FAIL.** `cd worker` then `npx vitest run test/reconcile.test.ts`
Expected: the two "no phantom diff" tests PASS already (they guard `expectedText`, which is why the fix is safe), and the **four reverse/create tests FAIL** — `patch.amount` etc. are `undefined` because `buildReversePatch`/`buildCreateProperties` skip fields without `reverse: true`.

- [ ] **Step 3: Add the flags.** In `worker/src/config.ts`, inside `DEALS.fields`, add `reverse: true` to exactly these three (leave `dealstage` and `pipeline` untouched — stage reverses via the group, and DKM uses a single pipeline):

```typescript
    { hs: "amount", col: "numeric_mm531t6e", type: "numbers", reverse: true },                     // Amounts (reverse: app edits reach HubSpot)
    { hs: "deal_currency_code", col: "color_mm53vk99", type: "status", reverse: true },            // Currency
    { hs: "closedate", col: "date_mm53ecz3", type: "date", reverse: true },                        // Close Date
```

- [ ] **Step 4: Run, expect PASS.** `cd worker` then `npx vitest run test/reconcile.test.ts` → all pass. Then the FULL suite `npx vitest run` (the existing 135 must stay green — this is the regression gate for the forward sync) and `npx tsc --noEmit` (clean).

- [ ] **Step 5: Commit**
```bash
git add worker/src/config.ts worker/test/reconcile.test.ts
git commit -m "fix(worker): reverse Amount/Currency/Close date to HubSpot (app edits now sync)"
```

---

## Task 1b: Controlled deals-only backfill of empty HubSpot values (TDD)

**Files:** Modify `worker/src/types.ts`, `worker/src/config.ts`, `worker/src/reconcile.ts`, `worker/src/sync.ts`; Test `worker/test/reconcile.test.ts`.

**Why:** `fieldDiffs` skips fields whose HubSpot value is empty (`reconcile.ts:41`), so Task 1's flags only help NEW deals and edits to fields HubSpot already has — existing deals with a blank HubSpot amount stay stranded. This adds a strictly-guarded fill.

**Rules (all must hold):** HubSpot value empty **and** monday value non-empty **and** the item's HubSpot Deal ID matches the record (id only, never name) **and** the field is allowlisted (`backfill: true`) **and** `spec.object === "deals"`. Allowlist: `amount`, `closedate` only. Never clears HubSpot. Idempotent.

- [ ] **Step 1: `FieldSpec` gains the flag.** In `worker/src/types.ts`, inside `interface FieldSpec`, after `reverse?: boolean;`:
```typescript
  backfill?: boolean;    // allowlisted: a non-empty monday value may FILL an EMPTY HubSpot value (deals only)
```

- [ ] **Step 2: `Diff` gains the marker.** In `worker/src/reconcile.ts`, in `interface Diff`, add:
```typescript
  backfill?: boolean;
```

- [ ] **Step 3: Write the failing tests.** Append to `worker/test/reconcile.test.ts` (reuse the `dctx`/`dItem`/`dRec`/`byCol` helpers from the Task 1 suite by declaring this suite AFTER it, or redeclare equivalents inside this describe):

```typescript
describe("controlled deals-only backfill of EMPTY HubSpot values (allowlist: amount, closedate)", () => {
  const bctx: Ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {},
    ownerIdByEmail: {}, portalId: 1 };
  // monday card carrying the matching HubSpot Deal ID (numeric_mm4nz332 = 9001).
  const bItem = (over: Partial<{ id: string; amount: string; close: string; type: string }> = {}) => item({
    name: "Acme", group: { id: "group_mm4nf6fw" },
    column_values: [
      { id: "numeric_mm4nz332", text: over.id ?? "9001" },
      { id: "numeric_mm531t6e", text: over.amount ?? "5000" },
      { id: "date_mm53ecz3", text: over.close ?? "2026-07-31" },
      { id: "color_mm53cky8", text: over.type ?? "" },
    ],
  });
  // HubSpot deal with EMPTY amount + closedate (the stranded-deal case).
  const bRec = (props: Record<string, string> = {}) => ({
    id: "9001",
    properties: { dealname: "Acme", dealstage: "appointmentscheduled", sales_user: "555",
      amount: "", closedate: "", ...props },
  });
  const byCol = (d: ReturnType<typeof fieldDiffs>, col: string) => d.find(x => x.f?.col === col);

  it("fills an EMPTY HubSpot amount from monday (marked backfill)", () => {
    const md = bItem();
    const d = byCol(fieldDiffs(bRec(), md, DEALS, bctx), "numeric_mm531t6e");
    expect(d).toMatchObject({ hsText: "", mdText: "5000", backfill: true });
    expect(buildReversePatch(fieldDiffs(bRec(), md, DEALS, bctx), md, DEALS, bctx).amount).toBe("5000");
  });

  it("fills an EMPTY HubSpot close date from monday", () => {
    const md = bItem();
    expect(buildReversePatch(fieldDiffs(bRec(), md, DEALS, bctx), md, DEALS, bctx).closedate).toBe("2026-07-31");
  });

  it("does NOT backfill a non-allowlisted field (dealtype stays empty in HubSpot)", () => {
    const md = bItem({ type: "New Business" });
    expect(byCol(fieldDiffs(bRec({ dealtype: "" }), md, DEALS, bctx), "color_mm53cky8")).toBeUndefined();
  });

  it("does NOT backfill currency (reversible on edit, but not allowlisted)", () => {
    const md = item({ name: "Acme", group: { id: "group_mm4nf6fw" }, column_values: [
      { id: "numeric_mm4nz332", text: "9001" }, { id: "color_mm53vk99", text: "USD" }] });
    expect(byCol(fieldDiffs(bRec({ deal_currency_code: "" }), md, DEALS, bctx), "color_mm53vk99")).toBeUndefined();
  });

  it("never clears HubSpot: an EMPTY monday value produces no diff", () => {
    const md = bItem({ amount: "", close: "" });
    expect(byCol(fieldDiffs(bRec(), md, DEALS, bctx), "numeric_mm531t6e")).toBeUndefined();
  });

  it("requires a matching HubSpot Deal ID on the card (never match by name)", () => {
    const md = bItem({ id: "8888" }); // card carries a DIFFERENT deal id
    expect(byCol(fieldDiffs(bRec(), md, DEALS, bctx), "numeric_mm531t6e")).toBeUndefined();
  });

  it("is idempotent: once HubSpot holds the value there is no diff", () =>
    expect(byCol(fieldDiffs(bRec({ amount: "5000.00" }), bItem(), DEALS, bctx), "numeric_mm531t6e")).toBeUndefined());

  it("does NOT apply to contacts/companies even if a field were flagged", () => {
    const contactish: ObjectSpec = { ...spec, object: "contacts", idCol: "c_id",
      fields: [{ hs: "amount", col: "c_amt", type: "numbers", reverse: true, backfill: true }] };
    const md = item({ column_values: [{ id: "c_id", text: "9001" }, { id: "c_amt", text: "5000" }] });
    expect(fieldDiffs({ id: "9001", properties: { dealname: "A", amount: "" } }, md, contactish, ctx)
      .find(x => x.f?.col === "c_amt")).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run, expect FAIL** — `cd worker && npx vitest run test/reconcile.test.ts`: the two "fills…" tests fail (no diff emitted today); the NOT/never/idempotent tests pass already (they assert current behaviour and must KEEP passing after the change — they are the guard rails).

- [ ] **Step 5: Implement the guarded fill.** In `worker/src/reconcile.ts` `fieldDiffs`, replace this line:
```typescript
    if (hsText === "") continue;   // empty HubSpot value: don't fight monday (no clear, no loop)
```
with:
```typescript
    if (hsText === "") {
      // Empty HubSpot value: normally we don't fight monday (no clear, no loop). EXCEPTION — controlled
      // backfill: an ALLOWLISTED reversible field on a DEAL whose card carries the matching HubSpot Deal ID
      // may FILL the empty HubSpot value from a non-empty monday value. Never the reverse (an empty monday
      // value never clears HubSpot), never for contacts/companies, never matched by name.
      if (f.backfill && f.reverse && spec.object === "deals" && colText(item, spec.idCol) === rec.id) {
        const md = colText(item, f.col);
        if (md) out.push({ kind: "field", f, hsText: "", mdText: md, backfill: true });
      }
      continue;
    }
```

- [ ] **Step 6: Allowlist the two fields.** In `worker/src/config.ts` `DEALS.fields`, add `backfill: true` to exactly `amount` and `closedate` (leave currency and every other field alone):
```typescript
    { hs: "amount", col: "numeric_mm531t6e", type: "numbers", reverse: true, backfill: true },     // Amounts (reverse + allowlisted backfill)
    { hs: "closedate", col: "date_mm53ecz3", type: "date", reverse: true, backfill: true },        // Close Date (reverse + allowlisted backfill)
```

- [ ] **Step 7: Log every backfill at the write site.** In `worker/src/sync.ts`, in the `dir === "toHubspot"` block (≈lines 96-105), replace:
```typescript
    const patch = buildReversePatch(diffs, existing, spec, ctx);
    if (Object.keys(patch).length > 0) {
      const newMod = await patchRecord(env, spec, rec.id, patch, opts);
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: newMod ?? recModified }, opts);
      stats.toHubspot++; budget.left--;
      return;
    }
```
with:
```typescript
    const patch = buildReversePatch(diffs, existing, spec, ctx);
    if (Object.keys(patch).length > 0) {
      const filled = diffs.filter(d => d.backfill && d.f && patch[d.f.hs] !== undefined);
      const newMod = await patchRecord(env, spec, rec.id, patch, opts);
      // Audit trail for the controlled backfill (a failed patch throws and is logged by the caller).
      for (const d of filled)
        console.log(`[backfill] object=${spec.object} hubspot_id=${rec.id} monday_item=${existing.id} field=${d.f!.hs} previous="" value="${patch[d.f!.hs]}" result=${newMod === null ? "dry-run" : "written"}`);
      await setColumns(env, spec.boardId, existing.id, { [spec.syncStateCol]: newMod ?? recModified }, opts);
      stats.toHubspot++; budget.left--;
      return;
    }
```

- [ ] **Step 8: Run, expect PASS** — `cd worker && npx vitest run test/reconcile.test.ts` → all pass (incl. the Task 1 suite). Then the FULL suite `npx vitest run` — **the 141 must stay green** (if a pre-existing test breaks, STOP and report). `npx tsc --noEmit` → clean.

- [ ] **Step 9: Commit**
```bash
git add worker/src/types.ts worker/src/config.ts worker/src/reconcile.ts worker/src/sync.ts worker/test/reconcile.test.ts
git commit -m "feat(worker): controlled deals-only backfill of empty HubSpot amount/close date (allowlisted, id-matched, logged)"
```

---

## Task 2: Remove the dead Pipeline field from the form

**Files:** Modify `monday-app/src/views/DealModal.tsx`.

DKM uses a single "Sales Pipeline" and pipeline stays forward-only, so a Pipeline dropdown is a control that cannot sync — misleading now that its neighbours do. The create default stays (it stamps the monday column); only the UI control goes.

- [ ] **Step 1: Remove the field.** In the first `dc-grid`, delete the Pipeline `<Field>` line so the row keeps only Deal stage + Deal type:

```tsx
          <div className="dc-grid">
            <Field label="Deal stage" required>
              <SelectStr options={stages} value={form.stage} onChange={v => set({ stage: v })} placeholder="Select stage…" />
              {invalid.errors.stage && <div className="dc-err">{invalid.errors.stage}</div>}
            </Field>
            <Field label="Deal type"><SelectStr options={board.options.dealType} value={form.dealType} onChange={v => set({ dealType: v })} placeholder="—" /></Field>
          </div>
```

- [ ] **Step 2: Leave the default alone.** Do NOT touch the `useState` initializer's `pipeline: pick(board.options.pipeline, /sales pipeline/i)` — it still stamps the monday Pipeline column on create, and it keeps `board.options.pipeline` in use (so no unused-variable error).

- [ ] **Step 3: Verify.** `cd monday-app && npx tsc --noEmit` (clean — confirms nothing became unused) and `npm run build` (succeeds).

- [ ] **Step 4: Commit**
```bash
git add monday-app/src/views/DealModal.tsx
git commit -m "feat(monday-app): drop the Pipeline field (single pipeline, forward-only)"
```

---

## Task 3: Surface a failed monday line-item delete

**Files:** Modify `monday-app/src/views/LineItemsEditor.tsx`.

`remove()` awaits `deleteItem(li.subitemId)` outside any try/catch, so a failure becomes an unhandled rejection (the handler is called as `void remove(i)`) and the row still disappears from the UI even though the subitem still exists.

- [ ] **Step 1: Wrap it.** Replace the body of `remove`:

```typescript
  async function remove(i: number) {
    const li = value[i];
    if (li.subitemId) {
      try { await deleteItem(li.subitemId); }
      catch (e) { onError?.("Couldn't remove the line item: " + String(e).slice(0, 120)); return; }
    }
    if (li.lineItemId) {
      try { await deleteHubspotLineItem(token, li.lineItemId); }
      catch (e) { onError?.("Couldn't remove the line item in HubSpot: " + String(e).slice(0, 120)); }
    }
    onChange(value.filter((_, j) => j !== i));
  }
```
Note the `return` on the monday failure: if the subitem could not be deleted it must stay in the list (removing it from the UI would lie). A HubSpot-side failure still drops the row locally, as before — the error is surfaced and the Worker reconciles.

- [ ] **Step 2: Verify.** `cd monday-app && npx tsc --noEmit` (clean) and `npm run build` (succeeds).

- [ ] **Step 3: Commit**
```bash
git add monday-app/src/views/LineItemsEditor.tsx
git commit -m "fix(monday-app): surface a failed monday line-item delete instead of swallowing it"
```

---

## Task 4: Deploy + live verification

- [ ] **Step 1: Full gate.** `cd worker && npx tsc --noEmit && npx vitest run` (all green, 135 + the 6 new) and `cd monday-app && npx vitest run && npm run build` (green).
- [ ] **Step 2: Deploy.** `cd worker && npx wrangler deploy`; then `cd monday-app && npx @mondaycom/apps-cli@latest code:push -d ./dist -c -i 16011075 -f`.
- [ ] **Step 3: Live (hard-refresh the board view):**
  - **Create** a deal in the app with an **Amount**, **Currency** and **Close date** → within ~30s all three appear on the HubSpot deal record (this is the whole point of the round).
  - **Edit** the amount in the app → HubSpot updates.
  - **Edit** the close date → HubSpot updates.
  - Confirm the **Pipeline dropdown is gone** and a newly created deal still lands in the **Sales Pipeline** in HubSpot.
  - Watch whether a **line-item roll-up overrides the typed Amount** (HubSpot behaviour, not a sync bug — note the result either way).
  - Sanity: an existing deal whose amount you have NOT touched does not start flapping between values (no oscillation).

---

## Self-Review Notes

- **Spec coverage:** the three `reverse: true` flags (Task 1) with the loop guard + reverse + create tests (Task 1 Step 1); Pipeline dropdown removal (Task 2); LineItemsEditor `deleteItem` wrap (Task 3); live verification incl. the amount roll-up watch (Task 4). Pipeline and dealstage deliberately untouched, per the spec's decisions.
- **Type consistency:** tests reuse the existing `item()` helper, `Ctx`/`ObjectSpec` types and the real `DEALS` spec; `byCol` mirrors the existing suites' `d.find(x => x.f?.col === ...)` pattern; `buildCreateProperties` returns `Record<string,string>` so `toMatchObject` with string values is correct.
- **Placeholder scan:** none — every step has real code and exact commands.
- **Known-unknown (not a placeholder):** whether HubSpot recalculates Amount from line items is a portal setting, resolved by observation in Task 4, not by code.
