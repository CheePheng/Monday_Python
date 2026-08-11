# Sync All Companies — Phase 2 (company→contact associations) — Design

**Date:** 2026-07-30
**Status:** draft for review
**Builds on:** Phase 1 (all companies on the board). Reuses its `includeAll`/`skipFullReconcile` pattern.

## Goal

Populate the **company→contact associations**: put the ~50,325 company-linked contacts on the Contact
Follow Up board and write the Connect-Boards links from each company to its contacts — keeping them current,
without disturbing the deal sync or the existing contact sync.

**Scope (confirmed):** the contact board keeps its existing sales_user-owned contacts **and** gains the
company-linked ones — a **union**, not a replacement. Contacts with neither a sales_user nor a company stay
off the board.

## Constraints (from Phase 1 + the code)

- HubSpot `/search` caps at 10k → the bulk run enumerates via the **list API** over companies (already
  built), and links each company's contacts through the existing association pass.
- The contact board goes from ~715 to ~50k → contacts must leave the 03:00 full sweep too.
- `syncAssociations(env, spec, rec, item, ctx, opts, budget)` already does exactly what's needed per
  company: `getAssociatedIds` → for each contact `ensureTargetCard` (create/adopt the contact card, deduped)
  → write the company card's contact-relation column. So the bulk run **creates the ~50k contacts and
  writes the ~160k links together** — no separate contact import.

## Design

### 1. Contact scope = union (a new, general spec flag)

`worker/src/types.ts` — `ObjectSpec` gains:
```ts
  scopeAlsoLinkedProp?: string; // in scope if THIS property is present, OR'd with the normal sales_user/date gate
```
`CONTACTS_MYLA` gets `scopeAlsoLinkedProp: "associatedcompanyid"` **and** `skipFullReconcile: true`.
(Companies already have `includeAll`; contacts deliberately do **not** — only company-linked ones qualify.)

`recInScope` (Phase 1 made it spec-aware) also honors the union:
```ts
export function recInScope(spec: ObjectSpec, rec: {...}): boolean {
  if (spec.includeAll) return true;
  if (spec.scopeAlsoLinkedProp && (rec.properties[spec.scopeAlsoLinkedProp] ?? "").toString().trim()) return true;
  if (!(rec.properties.sales_user ?? "").trim()) return false;
  return (Date.parse(rec.properties.createdate ?? "") || 0) >= CREATED_AFTER_MS;
}
```
`syncHubspotRecord`'s scope-check fetch adds `spec.scopeAlsoLinkedProp` so the value is available. The
search enumerators (`searchAll`, `searchModifiedIds`) add a second OR filterGroup when the flag is set:
`[{ filters: spec.searchFilters }, { filters: [{ propertyName: scopeAlsoLinkedProp, operator: "HAS_PROPERTY" }] }]`.
So a company-linked contact now syncs and **stays current** via the incremental + webhooks, even with no
sales_user; the existing sales_user contacts are untouched (first group unchanged).

### 2. Bulk association run (reuses the association pass)

Extend the import endpoint: `GET /import?object=company-associations&after=<cursor>` (trigger-secret gated).
Per list-API page of companies:
```
for each company rec:
  card = findItemByColumn(companies board, idCol, rec.id)    // its Phase-1 card
  if card: syncAssociations(env, COMPANIES_MYLA, rec, card, ctx, opts, budget)  // create linked contacts + write company→contact links
```
Concurrency-bounded like Phase 1. Idempotent: `ensureTargetCard` adopts existing contact cards; the
relation write is set-to-desired (no duplicate links). Resumable via the `after` cursor.

### 3. Ongoing

- A **company** change re-runs its association pass automatically (it's already part of the company sync via
  webhook/incremental) — new/removed contact links reflect.
- A **contact** change flows via the widened contact incremental + webhooks (scope union).
- New company↔contact links fire HubSpot **association-change** webhooks → re-sync (already handled by
  `extractObjectEvents`' `fromObjectId` path).

### 4. Link direction (decision)

The bulk run writes the **company→contact** link (on the company card) — which is what a future "Companies
tab" needs ("show this company's contacts"). The **contact→company** link (on the contact card) is written
by the *contact's* own association pass, which now runs as each company-linked contact syncs (scope union) —
so it fills in over time via the incremental/webhooks rather than in this bulk run. **Recommended:**
company→contact in the bulk run; contact→company organically. (Doing both in bulk ≈ doubles the ~160k link
writes and the runtime — deferred unless you want it up front.)

## Scale & delivery

~50k contact-creates + ~160k link-writes = **the largest import yet — multi-day** at the throttled rate.
Same discipline as Phase 1: deploy code → **regression-gate** (deals + companies + existing contacts stay
green, a single company-linked contact now syncs end-to-end) → then run in the background, resumable,
monitored. It will span days of wall-clock; the incremental/webhooks also populate in parallel.

## Testing

| Change | Test |
|---|---|
| `recInScope` union (`scopeAlsoLinkedProp`) | ✅ unit: company-linked-no-sales_user → in scope; still-gated cases unchanged |
| search enumerators add the OR group | ✅ unit if the filter-build is extracted; else tsc + review |
| `/import?object=company-associations` | I/O — verified live (smoke a few companies, check cards + links) |

Regression guard: existing contact/deal `recInScope` + reconcile tests pass unchanged.

## Risks

- **Contact-board scale (50k):** within monday Enterprise's 100k limit; the app doesn't load the contact
  board wholesale, so app impact is limited.
- **Runtime (days):** background + resumable + monitored; self-throttles on rate limits (proven in Phase 1).
- **No-name contacts:** show `contacts <id>` on the board (readable in-app via the name cascade).
- **Live-sync blast radius:** the union is additive (existing contacts unchanged) and behind the new flag;
  deals/companies untouched. Regression-gated before the run.

## Non-goals (Phase 2)

- Contact→company reverse links in the *bulk* run (they fill in via the ongoing contact sync).
- Contacts with no company and no sales_user (out of scope by the union).
- The app "Companies tab" (separate future feature; this is its data foundation).
- Deals unchanged.
