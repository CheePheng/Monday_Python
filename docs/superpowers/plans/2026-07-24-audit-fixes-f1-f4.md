# Audit Fixes F1–F4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four audit findings — a dead-code contact name split (F1), a create that fails on a transient owner lookup (F2), a fragile reverse-dropdown parser (F3), and opaque worker error messages (F4).

**Architecture:** Four small, independent edits. F1 + F3 are pure functions in `worker/src/reconcile.ts` and get real unit tests (TDD). F2 (`worker/src/create-records.ts`) and F4 (`monday-app/src/worker-client.ts`) touch I/O layers this codebase verifies by `tsc` + review, consistent with its existing test boundaries.

**Tech Stack:** TypeScript, Cloudflare Worker + vitest (worker); React + Vite + vitest (app). Deploy: `wrangler` (worker) + cached `mapps` (app).

**Spec:** `docs/superpowers/specs/2026-07-24-audit-fixes-f1-f4-design.md`

---

## File Structure

| File | Change | Test |
|---|---|---|
| `worker/src/reconcile.ts` | F1 (`buildCreateProperties` contacts block) + F3 (`reverseFieldValue` dropdown branch) | `worker/test/reconcile.test.ts` |
| `worker/src/create-records.ts` | F2 (wrap owner lookup) | tsc + review |
| `monday-app/src/worker-client.ts` | F4 (surface `{error}` in throw) | tsc + review |

No new files. No config/board/schema changes. No data migration.

---

## Task 1: F1 — Contact first/last name split (TDD)

**Files:**
- Modify: `worker/src/reconcile.ts` (the `if (spec.object === "contacts")` block in `buildCreateProperties`, ~lines 150-155)
- Test: `worker/test/reconcile.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this block to `worker/test/reconcile.test.ts` (after the existing `describe("buildCreateProperties", ...)`, ~line 118). It defines its own minimal contacts spec + item so it doesn't disturb the deals `spec`/`item` fixtures:

```ts
describe("buildCreateProperties — contact name split (F1)", () => {
  const contactSpec: ObjectSpec = {
    object: "contacts", objectTypeId: "0-1", searchFilters: [], modifiedProp: "lastmodifieddate",
    nameProps: ["firstname"], nameReverse: "firstname", boardId: "CB", idCol: "cc_id", syncStateCol: "cc_sync",
    groupBy: { singleGroup: "g" }, createFromMonday: true, createDefaults: {},
    fields: [{ hs: "lastname", col: "cc_last", type: "text", reverse: true }],
  };
  const cItem = (name: string, last = ""): MondayItem => ({
    id: "i1", name, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
    group: { id: "g" }, column_values: [{ id: "cc_last", text: last }],
  });

  it("single-word name -> firstname only", () =>
    expect(buildCreateProperties(cItem("John"), contactSpec, ctx)).toEqual({ firstname: "John" }));

  it("full name + empty Last Name column -> split into first + last", () =>
    expect(buildCreateProperties(cItem("John Smith"), contactSpec, ctx))
      .toEqual({ firstname: "John", lastname: "Smith" }));

  it("Last Name column is authoritative -> item name stays the firstname", () =>
    expect(buildCreateProperties(cItem("Mary Anne", "Smith"), contactSpec, ctx))
      .toEqual({ firstname: "Mary Anne", lastname: "Smith" }));
});
```

- [ ] **Step 2: Run to verify the middle test fails**

Run: `cd worker && npx vitest run test/reconcile.test.ts -t "contact name split"`
Expected: the "full name + empty Last Name" test FAILS — actual `{ firstname: "John Smith", lastname: "Smith" }` (the current dead-code bug) vs expected `{ firstname: "John", lastname: "Smith" }`. The other two pass.

- [ ] **Step 3: Implement the fix**

In `worker/src/reconcile.ts`, replace the contacts block in `buildCreateProperties`:

```ts
  // Contacts: item name is "First Last"; derive first/last for HubSpot if not already set.
  if (spec.object === "contacts") {
    const parts = item.name.trim().split(/\s+/).filter(Boolean);
    if (parts.length && !props["firstname"]) props["firstname"] = parts[0];
    if (parts.length > 1 && !props["lastname"]) props["lastname"] = parts.slice(1).join(" ");
  }
```

with:

```ts
  // Contacts: the item name is the First Name column. If a rep typed a FULL name there and left the
  // separate Last Name column empty, split it so HubSpot gets a clean first/last instead of the whole
  // name as firstname. When Last Name is filled, the columns are authoritative — don't second-guess them.
  if (spec.object === "contacts") {
    const parts = item.name.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1 && !props["lastname"]) {
      props["firstname"] = parts[0];
      props["lastname"] = parts.slice(1).join(" ");
    }
  }
```

- [ ] **Step 4: Run to verify all three pass**

Run: `cd worker && npx vitest run test/reconcile.test.ts -t "contact name split"`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/reconcile.ts worker/test/reconcile.test.ts
git commit -m "fix(worker): split a full name into first/last on contact create (F1)"
```

---

## Task 2: F3 — Greedy reverse-dropdown parser (TDD)

**Files:**
- Modify: `worker/src/reconcile.ts` (the `if (f.type === "dropdown")` branch in `reverseFieldValue`, ~lines 89-95)
- Test: `worker/test/reconcile.test.ts`

- [ ] **Step 1: Write the failing tests**

First, ensure `FieldSpec` is imported in the test file so the custom field below type-checks under `tsc`
(vitest strips types and would not catch this, but Task 5's `tsc` gate would). Change the type import at
the top of `worker/test/reconcile.test.ts`:

```ts
import type { Ctx, MondayItem, ObjectSpec, FieldSpec } from "../src/types";
```

Then add this describe (below the existing `describe("reverseFieldValue", ...)`):

```ts
describe("reverseFieldValue — multi-select dropdown (F3)", () => {
  // "industry" is used because FieldSpec.labels / Ctx.labels keys must be members of the LabelDict union
  // (see worker/src/types.ts) — an arbitrary string like "ind" would fail tsc.
  const mCtx: Ctx = {
    labels: { industry: { glass: "Glass, Ceramics & Concrete", mfg: "Manufacturing", aws: "AWS" } },
    ownersById: {}, mondayUsersByEmail: {}, mondayEmailByUserId: {}, ownerIdByEmail: {}, portalId: 1,
  };
  const dd: FieldSpec = { hs: "industry", col: "c_ind", type: "dropdown", labels: "industry", reverse: true };

  it("single value (whole-label match, unchanged)", () =>
    expect(reverseFieldValue(dd, "Glass, Ceramics & Concrete", mCtx)).toBe("glass"));

  it("comma-free multi value stays identical to the old split", () =>
    expect(reverseFieldValue(dd, "AWS, Manufacturing", mCtx)).toBe("aws;mfg"));

  it("multi value where one label CONTAINS a comma", () =>
    expect(reverseFieldValue(dd, "Glass, Ceramics & Concrete, Manufacturing", mCtx)).toBe("glass;mfg"));

  it("drops an unknown label rather than passing it raw", () =>
    expect(reverseFieldValue(dd, "AWS, Nope", mCtx)).toBe("aws"));
});
```

- [ ] **Step 2: Run to verify the comma-label test fails**

Run: `cd worker && npx vitest run test/reconcile.test.ts -t "multi-select dropdown"`
Expected: "multi value where one label CONTAINS a comma" FAILS — the current `split(",")` yields `"mfg"` (Glass dropped) vs expected `"glass;mfg"`. The other three pass under the old code.

- [ ] **Step 3: Implement the fix**

In `worker/src/reconcile.ts`, replace the dropdown branch in `reverseFieldValue`:

```ts
  if (f.type === "dropdown") {
    if (rev[text] !== undefined) return rev[text]; // whole-label match first (labels with commas)
    // Multi-select: map each label; DROP labels not in the dictionary rather than passing them raw
    // (a raw monday label is not a valid HubSpot enum value -> 400 that would retry every tick).
    return text.split(",").map(s => s.trim()).filter(Boolean)
      .map(s => rev[s]).filter((v): v is string => v !== undefined).join(";");
  }
```

with:

```ts
  if (f.type === "dropdown") {
    if (rev[text] !== undefined) return rev[text]; // whole-label match first (single value)
    // Multi-select: monday joins labels with ", ", and a label can itself contain a comma, so don't
    // blindly split on ",". Greedily consume the longest known label at a comma/end boundary; an unknown
    // label stops the scan (a raw monday label is not a valid HubSpot enum value -> 400 every tick).
    const labels = Object.keys(rev).filter(Boolean).sort((a, b) => b.length - a.length);
    const out: string[] = [];
    let rest = text;
    while (rest) {
      rest = rest.replace(/^\s*,\s*/, "");
      const hit = labels.find(l => rest.startsWith(l) && (rest.length === l.length || rest[l.length] === ","));
      if (!hit) break;
      out.push(rev[hit]);
      rest = rest.slice(hit.length);
    }
    return out.join(";");
  }
```

- [ ] **Step 4: Run to verify all four pass**

Run: `cd worker && npx vitest run test/reconcile.test.ts -t "multi-select dropdown"`
Expected: 4 passed.

- [ ] **Step 5: Full worker test run (guard the existing reverseFieldValue/create tests)**

Run: `cd worker && npx vitest run test/reconcile.test.ts`
Expected: all pass — including the pre-existing `reverseFieldValue` ("New Business" -> "newbusiness", empty -> "") and `buildCreateProperties` cases.

- [ ] **Step 6: Commit**

```bash
git add worker/src/reconcile.ts worker/test/reconcile.test.ts
git commit -m "fix(worker): robust reverse-map of multi-select dropdowns with comma labels (F3)"
```

---

## Task 3: F2 — Owner lookup failure degrades to Unassigned

**Files:**
- Modify: `worker/src/create-records.ts` (the owner-email line, ~line 40)

No unit test (this is monday-API I/O, verified live like the rest of `createContactOrCompany`). The behaviour it degrades into — `resolveActor(ctx, undefined) → { unassigned: true }` — is already covered by `worker/test/actor.test.ts:14`.

- [ ] **Step 1: Apply the fix**

In `worker/src/create-records.ts`, replace:

```ts
    const email = input.sessionUserId ? (await getUserById(env, input.sessionUserId))?.email : undefined;
    const owner = resolveActor(ctx, email);
```

with:

```ts
    // A transient monday error on the owner lookup must NOT fail the whole create — a missing owner is
    // already a supported state (record created Unassigned). Degrade a thrown lookup into that same path.
    let email: string | undefined;
    try { email = input.sessionUserId ? (await getUserById(env, input.sessionUserId))?.email : undefined; }
    catch (e) { console.log(`[create] owner lookup failed for user ${input.sessionUserId}: ${String(e).slice(0, 120)} — creating Unassigned`); }
    const owner = resolveActor(ctx, email);
```

- [ ] **Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Full worker test run (nothing regressed)**

Run: `cd worker && npx vitest run`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/create-records.ts
git commit -m "fix(worker): owner-lookup failure creates Unassigned instead of failing the create (F2)"
```

---

## Task 4: F4 — Surface the worker's error message

**Files:**
- Modify: `monday-app/src/worker-client.ts` (the `!res.ok` throw in `call`, ~line 9)

No unit test (this wraps `fetch`, not unit-tested in this app). Additive and backward-compatible.

- [ ] **Step 1: Apply the fix**

In `monday-app/src/worker-client.ts`, replace:

```ts
  if (!res.ok) throw new Error(`worker ${method} ${path}: ${res.status}`);
  return res.json();
```

with:

```ts
  if (!res.ok) {
    // Surface the Worker's JSON {error} (e.g. "deal-not-synced") instead of a bare status code, so the
    // app's error toast reads meaningfully. Body may be empty/HTML -> fall back to the status.
    const detail = await res.json().catch(() => null);
    const msg = detail && typeof detail.error === "string" ? `: ${detail.error}` : "";
    throw new Error(`worker ${method} ${path}: ${res.status}${msg}`);
  }
  return res.json();
```

- [ ] **Step 2: Typecheck**

Run: `cd monday-app && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Full app test run + build**

Run: `cd monday-app && npx vitest run && npx vite build`
Expected: all tests pass; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/worker-client.ts
git commit -m "fix(monday-app): surface the worker's error message, not just the HTTP status (F4)"
```

---

## Task 5: Green gate + deploy

- [ ] **Step 1: Both workspaces green**

Run: `cd worker && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all worker tests pass (existing + F1's 3 + F3's 4).

Run: `cd monday-app && npx tsc --noEmit && npx vitest run && npx vite build`
Expected: tsc clean; all app tests pass; build succeeds.

- [ ] **Step 2: Deploy the worker (F1, F2, F3)**

Run: `cd worker && npx wrangler deploy`
Expected: a new Version ID printed.

- [ ] **Step 3: Deploy the app (F4)**

Run: `cd monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/e144775468857254/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`
Expected: "Your project is live at …".

---

## Self-Review

**Spec coverage:** F1 → Task 1; F2 → Task 3; F3 → Task 2; F4 → Task 4; green/deploy → Task 5. F5 (documented) and F6 (withdrawn) are non-goals with no task, as the spec states. ✅

**Placeholder scan:** every code step shows complete code; every run step has an exact command + expected output. No TBD/TODO. ✅

**Type consistency:** `buildCreateProperties(item, spec, ctx)` and `reverseFieldValue(f, mdText, ctx)` match their signatures in `reconcile.ts`; the test `ctx`/`ObjectSpec`/`MondayItem` shapes match the fixtures already in `reconcile.test.ts` (imported at the top of that file). The contacts test spec uses `groupBy: { singleGroup }` so `buildCreateProperties` adds no group value (its group branch is gated on `"prop" in spec.groupBy`). ✅

## Rollback

Each fix is its own commit — `git revert <sha>` any one independently. No data or board settings changed, so nothing else to undo.
