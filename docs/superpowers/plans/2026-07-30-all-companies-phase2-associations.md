# Sync All Companies — Phase 2 (associations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Company-linked contacts (~50k) on the contact board + company→contact links (~160k), kept current, without disturbing deals/companies/existing contacts.

**Architecture:** A union contact scope (`scopeAlsoLinkedProp`) so company-linked contacts sync + stay current, plus a bulk `/import?object=company-associations` run that reuses `syncAssociations` per company to create the linked contact cards and write the links together.

**Tech Stack:** Cloudflare Worker + vitest; Node driver. Deploy: `wrangler`.

**Spec:** `docs/superpowers/specs/2026-07-30-all-companies-phase2-associations-design.md`

---

## Task 1: Contact scope union (TDD)

**Files:** `worker/src/types.ts`, `worker/src/config.ts`, `worker/src/sync.ts`, `worker/src/hubspot.ts`; extend `worker/test/sync-scope.test.ts`.

- [ ] **Step 1: Extend the failing test** (append to the existing `describe("recInScope", …)`)
```ts
  it("contacts: company-linked (associatedcompanyid) is in scope even with no sales_user", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ associatedcompanyid: "5", createdate: OLD }))).toBe(true));
  it("contacts: neither sales_user nor a company is out of scope", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ createdate: NEW }))).toBe(false));
```

- [ ] **Step 2: Run — the first new test fails**

Run: `cd worker && npx vitest run test/sync-scope.test.ts`
Expected: the "company-linked" test FAILS (`CONTACTS_MYLA` has no `scopeAlsoLinkedProp` yet, and the contact
currently lacks a sales_user → false).

- [ ] **Step 3: Implement**

`worker/src/types.ts` — add to `ObjectSpec`:
```ts
  scopeAlsoLinkedProp?: string; // in scope if this property is present, OR'd with the sales_user/date gate
```

`worker/src/config.ts` — `CONTACTS_MYLA` gains:
```ts
  scopeAlsoLinkedProp: "associatedcompanyid",
  skipFullReconcile: true,
```

`worker/src/sync.ts` — `recInScope` (add the union clause before the sales_user gate):
```ts
export function recInScope(spec: ObjectSpec, rec: { properties: Record<string, string | null> }): boolean {
  if (spec.includeAll) return true;
  if (spec.scopeAlsoLinkedProp && (rec.properties[spec.scopeAlsoLinkedProp] ?? "").toString().trim()) return true;
  if (!(rec.properties.sales_user ?? "").trim()) return false;
  return (Date.parse(rec.properties.createdate ?? "") || 0) >= CREATED_AFTER_MS;
}
```

`worker/src/sync.ts` — `syncHubspotRecord` scope-check fetch (~line 399): include the linked prop so its
value is present for the check:
```ts
  const props = [...new Set([...propertiesForSpec(spec), "sales_user", "createdate",
    ...(spec.scopeAlsoLinkedProp ? [spec.scopeAlsoLinkedProp] : [])])];
```

`worker/src/hubspot.ts` — `searchModifiedIds`, so a recently-modified contact is swept if it's in the normal
scope **or** company-linked. Replace the `const body` object's opening + `filterGroups` (lines ~300-302):
```ts
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: [...(spec.includeAll ? [] : spec.searchFilters),
        { propertyName: spec.modifiedProp, operator: "GTE", value: sinceMs }] }],
```
with:
```ts
    // OR'd scope groups, each AND'd with the modified-date filter (HubSpot: groups OR, filters-in-group AND).
    const mod = { propertyName: spec.modifiedProp, operator: "GTE" as const, value: sinceMs };
    const groups: Record<string, unknown>[][] = spec.includeAll
      ? [[mod]]
      : [[...spec.searchFilters, mod],
         ...(spec.scopeAlsoLinkedProp
           ? [[{ propertyName: spec.scopeAlsoLinkedProp, operator: "HAS_PROPERTY" as const }, mod]] : [])];
    const body: Record<string, unknown> = {
      filterGroups: groups.map(filters => ({ filters })),
```
(`searchAll` is unchanged — it only ever runs for deals, since companies/contacts are `skipFullReconcile`.)

- [ ] **Step 4: Run — passes**

Run: `cd worker && npx vitest run test/sync-scope.test.ts`
Expected: 6 passed (4 from Phase 1 + 2 new).

- [ ] **Step 5: Full gate + commit**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit && npx vitest run`
Expected: tsc clean; all pass; existing deal/contact tests unchanged.
```bash
git add worker/src/types.ts worker/src/config.ts worker/src/sync.ts worker/src/hubspot.ts worker/test/sync-scope.test.ts
git commit -m "feat(worker): contact scope union (company-linked); skipFullReconcile for contacts (Phase 2)"
```

---

## Task 2: Bulk association endpoint

**Files:** `worker/src/index.ts`.

- [ ] **Step 1: Fix the imports (three changes — verified against source)**

- `Budget` is NOT imported → `import type { Env, RunOpts, Budget } from "./types";`
- `findItemByColumn` is NOT imported (only `getItem, setColumns`) → `import { getItem, setColumns, findItemByColumn } from "./monday";`
- `syncAssociations` is NOT imported (there is no `./associations` import) → add `import { syncAssociations } from "./associations";`

- [ ] **Step 2: Restructure the `/import` handler to branch on object**

The current handler rejects any object except `companies` and declares `after/limit/conc/ctx/opts` inline.
Restructure so it accepts both objects and shares the common setup. Replace:
```ts
      if ((url.searchParams.get("object") ?? "") !== "companies")
        return Response.json({ error: "only object=companies supported" }, { status: 400 });
      const after = url.searchParams.get("after") || undefined;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "40"), 1), 100);
      const conc = Math.min(Math.max(Number(url.searchParams.get("conc") ?? "5"), 1), 10);
      const ctx = await getCtxCached(env);
      const opts = optsFromEnv(env);
      const { records, next } = await listPage(env, "companies", after, propertiesForSpec(COMPANIES_MYLA), limit);
```
with:
```ts
      const object = url.searchParams.get("object") ?? "";
      if (!["companies", "company-associations"].includes(object))
        return Response.json({ error: "object must be companies|company-associations" }, { status: 400 });
      const after = url.searchParams.get("after") || undefined;
      const ctx = await getCtxCached(env);
      const opts = optsFromEnv(env);

      // Phase 2: per company, run the association pass — creates each linked contact's card (deduped) and
      // writes the company→contact link. Heavier per record than the card import, so small pages.
      if (object === "company-associations") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "5"), 1), 30);
        const { records, next } = await listPage(env, "companies", after, propertiesForSpec(COMPANIES_MYLA), limit);
        let linked = 0, missing = 0;
        for (const rec of records) {
          const card = (await findItemByColumn(env, COMPANIES_MYLA.boardId, COMPANIES_MYLA.idCol, rec.id))[0];
          if (!card) { missing++; continue; }
          const budget: Budget = { left: 60 };
          try { await syncAssociations(env, COMPANIES_MYLA, rec, card, ctx, opts, budget); linked++; }
          catch (e) { console.log(`[import assoc] company=${rec.id} error="${String(e).slice(0, 140)}"`); }
        }
        return Response.json({ processed: records.length, linked, missing, after: next ?? null, done: !next });
      }

      // Phase 1: card import (object === "companies").
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "40"), 1), 100);
      const conc = Math.min(Math.max(Number(url.searchParams.get("conc") ?? "5"), 1), 10);
      const { records, next } = await listPage(env, "companies", after, propertiesForSpec(COMPANIES_MYLA), limit);
```
The rest of the existing companies branch (the `created/existing` concurrency loop + its `Response.json`)
stays unchanged, now reached only when `object === "companies"`.

- [ ] **Step 3: Gate + commit + deploy**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit && npx vitest run`
Expected: tsc clean; all pass.
```bash
git add worker/src/index.ts
git commit -m "feat(worker): /import?object=company-associations links each company's contacts (Phase 2)"
cd worker && npx wrangler deploy
```

---

## Task 3: Regression gate BEFORE the run

- [ ] **Step 1: Confirm nothing regressed**

- `wrangler tail` briefly: deals + companies + contacts still sync, no errors.
- Poke a company-linked contact that has **no sales_user** (property change) → confirm it now **upserts a
  card** (was previously skipped) — proving the union works end-to-end.
- Smoke the endpoint on ~2 companies: `/import?object=company-associations&limit=2` → confirm their contacts
  get cards and the company card's contact-relation column shows the links, no errors.

**Do not proceed to Task 4 until this is clean.**

---

## Task 4: Bulk association run

**Files:** Create `scratchpad/import-associations.cjs` (mirror of `import-companies.cjs`, `object=company-associations`, `limit=5`, `conc` unused server-side here, per-call timeout, resumable).

- [ ] **Step 1:** Smoke 3 pages; check linked/missing counts + a few company cards' contact links + new contact cards.
- [ ] **Step 2:** Full run in the background (multi-day), monitored (milestone + terminal filter). Resumable via `--after`.

Expected: every company processed; ~50k contact cards created; company→contact links written; 0 hard errors.

---

## Task 5: Verify

- [ ] **Step 1:** Contact board `items_count` grew to roughly the union size (~50k+); spot-check a company card → its Contacts relation lists its contacts.
- [ ] **Step 2:** Census the contact board for duplicates (same HubSpot id on 2+ cards) → expect 0.
- [ ] **Step 3:** `wrangler tail` over an incremental + webhook: companies/contacts/deals healthy; no subrequest-limit errors.

---

## Self-Review

**Spec coverage:** union scope → T1; bulk association run → T2/T4; regression gate → T3; verify → T5. Link
direction = company→contact (spec §4). ✅

**Type/behaviour consistency:** `recInScope(spec, rec)` unchanged arity (Phase 1); `scopeAlsoLinkedProp`
typed on `ObjectSpec`; `syncAssociations(env, spec, rec, item, ctx, opts, budget)` matches the call;
`Budget` imported; `findItemByColumn`/`listPage`/`getCtxCached`/`COMPANIES_MYLA` already available. ✅

**Regression guard:** the union is additive (first filterGroup unchanged); deals/companies untouched; contact
tests for the still-gated cases pass unchanged.

## Rollback

Per-task commits. Reverting `config.ts` (drop `scopeAlsoLinkedProp`/`skipFullReconcile` from contacts)
returns contacts to the old scope; created cards/links stay (harmless) or can be pruned. The run is additive
and dedupe-safe.
