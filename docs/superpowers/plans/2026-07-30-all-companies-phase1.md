# Sync All Companies — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** All ~25,579 HubSpot companies on the Company Follow Up board as cards, kept current, without touching the deal/contact sync. Cards only (associations = Phase 2).

**Architecture:** Two company-only spec flags (`includeAll`, `skipFullReconcile`) + spec-aware `recInScope` + relaxed incremental + a list-API bulk-import endpoint driven to completion. Deploy the code and confirm the live sync stays green **before** importing.

**Tech Stack:** Cloudflare Worker + vitest; Node driver script. Deploy: `wrangler`.

**Spec:** `docs/superpowers/specs/2026-07-30-all-companies-phase1-design.md`

---

## Task 1: Spec flags + spec-aware `recInScope` (TDD)

**Files:** `worker/src/types.ts`, `worker/src/config.ts`, `worker/src/sync.ts`; test `worker/test/sync-scope.test.ts` (new).

- [ ] **Step 1: Write the failing test**

`worker/test/sync-scope.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { recInScope } from "../src/sync";
import { COMPANIES_MYLA, CONTACTS_MYLA } from "../src/config";

const rec = (p: Record<string, string>) => ({ properties: p });
const OLD = "2026-06-01T00:00:00Z";     // before CREATED_AFTER_MS (2026-07-01)
const NEW = "2026-07-15T00:00:00Z";

describe("recInScope", () => {
  it("companies (includeAll): in scope even with no sales_user and an old createdate", () =>
    expect(recInScope(COMPANIES_MYLA, rec({ createdate: OLD }))).toBe(true));
  it("contacts: still gated — no sales_user is out of scope", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ createdate: NEW }))).toBe(false));
  it("contacts: sales_user + recent is in scope", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ sales_user: "1", createdate: NEW }))).toBe(true));
  it("contacts: sales_user but created before the cutoff is out of scope", () =>
    expect(recInScope(CONTACTS_MYLA, rec({ sales_user: "1", createdate: OLD }))).toBe(false));
});
```

- [ ] **Step 2: Run — fails**

Run: `cd worker && npx vitest run test/sync-scope.test.ts`
Expected: FAIL — `recInScope` not exported / wrong arity.

- [ ] **Step 3: Implement**

`worker/src/types.ts` — add to `ObjectSpec`:
```ts
  includeAll?: boolean;        // sync EVERY record (ignore the sales_user/createdate scope gate)
  skipFullReconcile?: boolean; // exclude from the 03:00 full sweep (too large / search-capped)
```

`worker/src/config.ts` — `COMPANIES_MYLA` object gains both flags (near `createFromMonday: true`):
```ts
  includeAll: true,
  skipFullReconcile: true,
```

`worker/src/sync.ts` — make `recInScope` spec-aware **and exported**:
```ts
export function recInScope(spec: ObjectSpec, rec: { properties: Record<string, string | null> }): boolean {
  if (spec.includeAll) return true;
  if (!(rec.properties.sales_user ?? "").trim()) return false;
  return (Date.parse(rec.properties.createdate ?? "") || 0) >= CREATED_AFTER_MS;
}
```
Update its one caller in `syncHubspotRecord` (~line 404): `if (!recInScope(rec))` → `if (!recInScope(spec, rec))`.

- [ ] **Step 4: Run — passes**

Run: `cd worker && npx vitest run test/sync-scope.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/types.ts worker/src/config.ts worker/src/sync.ts worker/test/sync-scope.test.ts
git commit -m "feat(worker): includeAll/skipFullReconcile spec flags; company scope relaxed (Phase 1)"
```

---

## Task 2: Relax the incremental + drop companies from the full sweep

**Files:** `worker/src/hubspot.ts` (`searchModifiedIds`), `worker/src/sync.ts` (`runAll`).

- [ ] **Step 1: Relax `searchModifiedIds` for `includeAll` specs**

In `worker/src/hubspot.ts`, the filter line (~288) becomes:
```ts
      filterGroups: [{ filters: [...(spec.includeAll ? [] : spec.searchFilters),
        { propertyName: spec.modifiedProp, operator: "GTE", value: sinceMs }] }],
```

- [ ] **Step 2: Skip `skipFullReconcile` specs in `runAll`**

In `worker/src/sync.ts` `runAll`, first line of the loop body:
```ts
  for (const spec of ALL_SPECS) {
    if (spec.skipFullReconcile) continue;   // e.g. companies: 25k can't be search-swept; incremental+webhooks cover it
    if (only && spec.object !== only) continue;
    ...
```

- [ ] **Step 3: Gate + commit**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit && npx vitest run`
Expected: tsc clean; all pass (existing + Task 1's 4). Existing contact/deal scope + reconcile tests unchanged = proof the relaxation is company-only.
```bash
git add worker/src/hubspot.ts worker/src/sync.ts
git commit -m "feat(worker): incremental honors includeAll; full sweep skips skipFullReconcile specs"
```

---

## Task 3: List-API pagination helper

**Files:** `worker/src/hubspot.ts`.

- [ ] **Step 1: Add `listPage`**

```ts
/** Plain list pagination (NOT search) — the only way past search's 10,000-result ceiling. */
export async function listPage(env: Env, object: string, after: string | undefined, properties: string[], limit = 100):
    Promise<{ records: HsRecord[]; next?: string }> {
  const qs = new URLSearchParams({ limit: String(limit), archived: "false", properties: properties.join(",") });
  if (after) qs.set("after", after);
  const page = await hs(env, "GET", `/crm/v3/objects/${object}?${qs.toString()}`);
  return {
    records: (page.results ?? []).map((r: any) => ({ id: String(r.id), properties: r.properties ?? {} })),
    next: page.paging?.next?.after,
  };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit`
Expected: clean.
```bash
git add worker/src/hubspot.ts
git commit -m "feat(worker): listPage — list-API pagination past the 10k search cap"
```

---

## Task 4: Bulk-import endpoint

**Files:** `worker/src/index.ts`.

- [ ] **Step 1: Import `listPage`**

Add `listPage` to the existing `./hubspot` import. Everything else the endpoint uses is already imported:
`getCtxCached` (`./sync`), `ensureCardForRecord` (`./ensure-card`), `COMPANIES_MYLA` (`./config`),
`propertiesForSpec` (`./hubspot`), and `optsFromEnv` (local). So this is the only import change.

- [ ] **Step 2: Add the endpoint (next to `/run`, same `X-Trigger-Secret` gate)**

```ts
    // GET /import?object=companies&after=<cursor> — one list-API page per call, upsert each card via the
    // real (deduped) path. NO association pass (Phase 1 = cards only). Trigger-secret gated.
    if (url.pathname === "/import" && req.method === "GET") {
      const provided = req.headers.get("x-trigger-secret") ?? "";
      if (!env.TRIGGER_SECRET || provided !== env.TRIGGER_SECRET) return new Response("forbidden", { status: 403 });
      if ((url.searchParams.get("object") ?? "") !== "companies")
        return Response.json({ error: "only object=companies supported" }, { status: 400 });
      const after = url.searchParams.get("after") || undefined;
      const ctx = await getCtxCached(env);
      const opts = optsFromEnv(env);
      const { records, next } = await listPage(env, "companies", after, propertiesForSpec(COMPANIES_MYLA), 100);
      let created = 0, existing = 0;
      for (const rec of records) {
        const r = await ensureCardForRecord(env, COMPANIES_MYLA, ctx, rec, opts);
        if (r.status === "created") created++; else if (r.status === "existing") existing++;
      }
      return Response.json({ processed: records.length, created, existing, after: next ?? null, done: !next });
    }
```
(`propertiesForSpec` is already imported.)

- [ ] **Step 3: Gate + commit + deploy**

Run: `cd worker && ./node_modules/.bin/tsc --noEmit && npx vitest run`
Expected: tsc clean; all pass.
```bash
git add worker/src/index.ts
git commit -m "feat(worker): GET /import bulk-imports companies via the list API (Phase 1)"
cd worker && npx wrangler deploy
```

---

## Task 5: Regression check BEFORE importing (safety gate)

- [ ] **Step 1: Confirm the live sync is unharmed**

- `wrangler tail` briefly (or check the next 10-min incremental log): deals + contacts still sync, no errors.
- Poke one out-of-scope company (a property change) and confirm the webhook now **upserts** it (a card appears / updates) instead of `skipped` — proving `includeAll` works end-to-end for a single record before the bulk run.
- Confirm the 03:00 sweep log (or a manual `/run`) no longer processes companies (it's skipped).

Expected: deals/contacts unaffected; a single company now syncs via webhook. **Do not proceed to Task 6 until this is clean.**

---

## Task 6: Run the bulk import

**Files:** Create `scratchpad/import-companies.cjs`.

- [ ] **Step 0: Ensure the driver can authenticate**

`/import` is gated by `X-Trigger-Secret`, and the worker's `TRIGGER_SECRET` value is not in the local
`.env` (worker secrets are write-only — can't be read back). So set a fresh strong value the driver can use:
```bash
cd worker && echo "<generated-strong-secret>" | npx wrangler secret put TRIGGER_SECRET
```
Put the same value in the driver (read from a local file, not committed/logged). Note: this also becomes
the gate for the manual `/run` endpoint — fine, `/run` is manual-only and not used by the crons.

- [ ] **Step 1: Write the driver**

Loops `GET /import?object=companies&after=<cursor>` with the `X-Trigger-Secret` header, follows `after`
until `done`, prints running totals, backs off on 429/5xx. Resumable (re-run with the last cursor);
dedupe-safe (ensureCardForRecord adopts existing cards).

- [ ] **Step 2: First page as a smoke test**

Run the driver limited to ~3 pages. Expected: `created`/`existing` counts sane, cards appear on the board, no errors.

- [ ] **Step 3: Full run (background, monitored)**

Run the driver to completion (hours). Monitor progress; it's resumable if interrupted.
Expected: ~24,900 created + ~682 existing adopted, 0 errors.

---

## Task 7: Verify

- [ ] **Step 1:** Board `items_count` ≈ 25,579 (± a few for concurrent HubSpot changes).
- [ ] **Step 2:** Spot-check: a company with no sales_user and an old createdate now has a card (was previously excluded).
- [ ] **Step 3:** `wrangler tail` over a 10-min incremental + a webhook poke: companies stay current; deals/contacts still healthy; no subrequest-limit errors.

---

## Self-Review

**Spec coverage:** flags → T1; scope-aware recInScope → T1; incremental relax + full-sweep skip → T2; list API → T3; import endpoint → T4; safety gate → T5; import → T6; verify → T7. ✅

**Placeholder scan:** all code steps are complete; the driver (T6) is a scratchpad one-off described by its exact loop + endpoint contract (consistent with prior backfills). ✅

**Type consistency:** `recInScope(spec, rec)` def/caller match; `listPage(...)→{records,next}` feeds the endpoint; `ensureCardForRecord` returns `{status}` used for the counts; flags typed on `ObjectSpec`. ✅

**Regression guard:** existing contact/deal tests must pass unchanged — the proof the relaxation is company-only.

## Rollback

Each task is its own commit. Reverting `config.ts` (drop the two flags) instantly returns companies to the
old filtered scope and full-sweep behaviour; already-created cards stay (harmless) or can be left. The
import is additive and dedupe-safe.
