# Editable Companies + Association Fresh-on-Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make companies editable (fields + contact/deal associations, reverse-synced to HubSpot), load deal/company associations fresh from HubSpot on open (fixing the "1 of 10 contacts" + silent-shrink bug), and make the tables horizontally scrollable.

**Architecture:** Company field + contact-association reverse-sync reuses the generic `syncMondayItem` via a new `/app/sync-company`. Company↔deal is HubSpot-only (`putAssociation`/`deleteAssociation`). Association fresh-on-open merges the monday relation with the record's live HubSpot associations (`/app/associations`). All new logic lives in small pure helpers with unit tests.

**Tech Stack:** Cloudflare Worker (TS) + vitest; React 18 + TS + Vite + vitest; monday GraphQL 2026-07; HubSpot CRM v3/v4.

**Spec:** `docs/superpowers/specs/2026-08-03-editable-companies-and-assoc-fix-design.md`

**Toolchain (must follow):** Worker `./node_modules/.bin/tsc --noEmit` / `./node_modules/.bin/vitest run` (never `npx tsc`). App `npm test` / `npm run build`. `noUnusedLocals` ON. Commit code from repo root; **no `Co-Authored-By: Claude` trailer** (user is sole author). Don't commit `docs/`. Don't deploy/push until Task 13.

---

## File structure

**Worker:** `config.ts` (owner reverse), `hubspot.ts` (`mapAssocRecord`/`searchObjects` deals), `app-routes.ts` (parsers), `index.ts` (endpoints), `test/companies.test.ts` (append).
**App:** `board-config.ts` (`COMPANY_COLS`), `lib/company-form.ts` + test, `lib/assoc-merge.ts` + test, `monday-client.ts` (generic item ops), `worker-client.ts` (sync-company/associations/deal-search), `views/DealDrawer.tsx` (merge), `views/CompanyDrawer.tsx` (editable), `views/CompaniesView.tsx` (users), `styles.css` (scroll).

---

## Task 1: Worker — company owner reverse + deals in associations/search

**Files:** Modify `worker/src/config.ts`, `worker/src/hubspot.ts`; Test `worker/test/companies.test.ts`.

- [ ] **Step 1: Write the failing tests** — append to `worker/test/companies.test.ts`:

```ts
describe("mapAssocRecord deals", () => {
  it("deals -> {hubspotId, name: dealname}", () =>
    expect(mapAssocRecord("deals", { id: "7", properties: { dealname: "Acme Q3" } }))
      .toEqual({ hubspotId: "7", name: "Acme Q3" }));
});
describe("mapSearchResult deals", () => {
  it("deals -> name from dealname", () =>
    expect(mapSearchResult("deals", { dealname: "Acme Q3" })).toEqual({ name: "Acme Q3", secondary: "" }));
});
```

Add `mapSearchResult` to the existing `../src/hubspot` import in that test file.

- [ ] **Step 2: Run to verify it fails** — `./node_modules/.bin/vitest run companies` → FAIL (deals not handled).

- [ ] **Step 3: Implement.**

In `worker/src/config.ts`, add `reverse: true` to the company owner field:
```ts
    { hs: "hubspot_owner_id", col: "multiple_person_mm4p8xe2", type: "people", reverse: true },  // Owner (two-way)
```

In `worker/src/hubspot.ts`, add a `deals` branch to `mapAssocRecord` (before the final `return`):
```ts
  if (to === "deals") return { hubspotId: rec.id, name: (p.dealname ?? "").trim() };
```
And to `SEARCH_PROPS` + `mapSearchResult`:
```ts
// in SEARCH_PROPS:
  deals: ["dealname"],
// in mapSearchResult, before the products branch:
  if (type === "deals") return { name: p.dealname || "(no name)", secondary: "" };
```

- [ ] **Step 4: Run to verify it passes** — `./node_modules/.bin/vitest run companies` → PASS.

- [ ] **Step 5: tsc + commit** — `./node_modules/.bin/tsc --noEmit` clean.
```bash
git add worker/src/config.ts worker/src/hubspot.ts worker/test/companies.test.ts
git commit -m "feat(worker): company owner reverse-sync + deals in associations/search"
```

---

## Task 2: Worker — generalize association body parser + sync-company parser

**Files:** Modify `worker/src/app-routes.ts`; Test `worker/test/app-routes.test.ts`.

- [ ] **Step 1: Write the failing tests** — append to `worker/test/app-routes.test.ts` (import `parseAssociationBody`, `parseSyncCompanyBody` from `../src/app-routes`):

```ts
describe("parseAssociationBody (generalized)", () => {
  it("accepts companies->deals", () =>
    expect(parseAssociationBody({ fromObject: "companies", fromId: "1", toObject: "deals", toId: "2" }))
      .toEqual({ ok: true, fromObject: "companies", fromId: "1", toObject: "deals", toId: "2" }));
  it("accepts companies->contacts", () =>
    expect(parseAssociationBody({ fromObject: "companies", fromId: "1", toObject: "contacts", toId: "2" }).ok).toBe(true));
  it("still accepts deals->contacts", () =>
    expect(parseAssociationBody({ fromObject: "deals", fromId: "1", toObject: "contacts", toId: "2" }).ok).toBe(true));
  it("rejects a bad fromObject", () =>
    expect(parseAssociationBody({ fromObject: "contacts", fromId: "1", toObject: "deals", toId: "2" }).ok).toBe(false));
  it("rejects non-numeric ids", () =>
    expect(parseAssociationBody({ fromObject: "companies", fromId: "x", toObject: "deals", toId: "2" }).ok).toBe(false));
});
describe("parseSyncCompanyBody", () => {
  it("accepts a numeric itemId", () => expect(parseSyncCompanyBody({ itemId: "55" })).toEqual({ ok: true, itemId: "55" }));
  it("rejects a non-numeric itemId", () => expect(parseSyncCompanyBody({ itemId: "x" }).ok).toBe(false));
});
```

- [ ] **Step 2: Run to verify it fails** — `./node_modules/.bin/vitest run app-routes` → FAIL.

- [ ] **Step 3: Implement.** In `worker/src/app-routes.ts`, **replace the existing `FROM_OK`/`TO_OK`
declarations and the `parseAssociationBody` function** (don't add duplicates) with the below, and add
`parseSyncCompanyBody`:

```ts
const FROM_OK = new Set(["deals", "companies"]);
const TO_OK = new Set(["contacts", "companies", "deals"]);
export function parseAssociationBody(body: any): AssocReq {
  const { fromObject, fromId, toObject, toId } = body ?? {};
  if (!FROM_OK.has(fromObject)) return { ok: false, error: "fromObject must be deals|companies" };
  if (!TO_OK.has(toObject)) return { ok: false, error: "toObject must be contacts|companies|deals" };
  if (fromObject === toObject) return { ok: false, error: "fromObject and toObject must differ" };
  if (!numeric(fromId) || !numeric(toId)) return { ok: false, error: "fromId/toId must be numeric strings" };
  return { ok: true, fromObject, fromId, toObject, toId };
}

export interface SyncCompanyReq { ok: boolean; itemId?: string; error?: string }
export function parseSyncCompanyBody(body: any): SyncCompanyReq {
  const itemId = body?.itemId;
  if (!numeric(itemId)) return { ok: false, error: "itemId must be a numeric string" };
  return { ok: true, itemId };
}
```

Ensure the `AssocReq` interface's `fromObject`/`toObject` are typed `string` (not a narrow literal) so `companies`/`deals` are allowed. If `FROM_OK`/`TO_OK` were declared elsewhere, update those declarations instead of redeclaring.

- [ ] **Step 4: Run to verify it passes** — `./node_modules/.bin/vitest run app-routes` → PASS.

- [ ] **Step 5: tsc + commit** — `./node_modules/.bin/tsc --noEmit` clean.
```bash
git add worker/src/app-routes.ts worker/test/app-routes.test.ts
git commit -m "feat(worker): generalize association parser (companies) + parseSyncCompanyBody"
```

---

## Task 3: Worker — /app/sync-company, /app/association add, generalized delete, dealname in /app/associations, /app/search deals

**Files:** Modify `worker/src/index.ts`.

- [ ] **Step 1: Add the endpoints + wiring.**

Imports: add `putAssociation` to the `./hubspot` import; add `parseSyncCompanyBody` to the `./app-routes` import.

(a) `/app/associations` handler — add `"dealname"` to the fetched props:
```ts
          const recs = ids.length ? await getRecordsByIds(env, to, ids, ["name", "domain", "firstname", "lastname", "email", "jobtitle", "dealname"]) : [];
```

(b) `/app/search` — its `type` allowlist must include `deals`:
```ts
        if (!["contacts", "companies", "products", "deals"].includes(type))
```

(c) After the `/app/sync-deal` handler block, add sync-company:
```ts
      // POST /app/sync-company { itemId } — reverse-sync a company's monday edits (fields + contact links)
      // to HubSpot. Reuses the generic syncMondayItem (COMPANIES_MYLA board).
      if (url.pathname === "/app/sync-company" && req.method === "POST") {
        const s = parseSyncCompanyBody(await req.json().catch(() => ({})));
        if (!s.ok) return Response.json({ error: s.error }, { status: 400, headers: CORS });
        try {
          await syncMondayItem(env, COMPANIES_MYLA.boardId, s.itemId!, appWriteOpts(env), { left: 30 });
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/sync-company] item=${s.itemId} error="${String(e).slice(0, 160)}"`);
          return Response.json({ ok: false, error: "sync-failed" }, { status: 502, headers: CORS });
        }
      }
```

(d) The `DELETE /app/association` handler already parses with `parseAssociationBody` (now generalized) — change its `deleteAssociation` call to use the parsed `fromObject`, and add a `POST /app/association` add branch. Replace the existing DELETE handler block with a combined POST|DELETE block:
```ts
      // /app/association {fromObject, fromId, toObject, toId} — POST adds, DELETE removes a HubSpot
      // association. fromObject ∈ {deals, companies}. Used by the deal + company drawers.
      if (url.pathname === "/app/association" && (req.method === "POST" || req.method === "DELETE")) {
        const a = parseAssociationBody(await req.json().catch(() => ({})));
        if (!a.ok) return Response.json({ error: a.error }, { status: 400, headers: CORS });
        try {
          if (req.method === "POST") await putAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env));
          else await deleteAssociation(env, a.fromObject!, a.fromId!, a.toObject!, a.toId!, appWriteOpts(env));
          return Response.json({ ok: true }, { headers: CORS });
        } catch (e) {
          console.log(`[app/association] ${req.method} ${a.fromObject}/${a.fromId}->${a.toObject}/${a.toId} error="${String(e).slice(0, 140)}"`);
          return Response.json({ ok: false, error: "assoc-failed" }, { status: 502, headers: CORS });
        }
      }
```
(Confirm `deleteAssociation(env, fromObject, fromId, toObject, toId, opts)` matches hubspot.ts's signature — it does; the old handler hardcoded `"deals"`.)

- [ ] **Step 2: tsc + full worker tests** — `./node_modules/.bin/tsc --noEmit` clean; `./node_modules/.bin/vitest run` all pass.

- [ ] **Step 3: Commit.**
```bash
git add worker/src/index.ts
git commit -m "feat(worker): /app/sync-company + generalized /app/association add/delete + deals search/naming"
```

---

## Task 4: App — COMPANY_COLS in board-config

**Files:** Modify `monday-app/src/board-config.ts`.

- [ ] **Step 1: Add the column map, relation col, and a `deals` deep-link.** First, extend the existing
`HS_OBJ` + `hubspotRecordUrl` in `board-config.ts` so deals get a HubSpot URL — change:
```ts
const HS_OBJ = { contacts: "0-1", companies: "0-2" } as const;
export const hubspotRecordUrl = (kind: "contacts" | "companies", id: string) =>
```
to:
```ts
const HS_OBJ = { contacts: "0-1", companies: "0-2", deals: "0-3" } as const;
export const hubspotRecordUrl = (kind: "contacts" | "companies" | "deals", id: string) =>
```
Then append to `board-config.ts` (`COMPANY_BOARD` is already exported):
```ts
// Company Follow Up board editable columns (mirrors worker COMPANIES_MYLA reverse fields). Item name = domain.
export const COMPANY_REL_CONTACT = "board_relation_mm54e96"; // Company -> Contact card link
export const COMPANY_COLS = {
  name:        { id: "text_mm4scke9",          kind: "text" },       // Company Name
  industry:    { id: "dropdown_mm54zrp2",      kind: "dropdown" },
  type:        { id: "color_mm545z1t",         kind: "status" },
  salesUsers:  { id: "multiple_person_mm54phd7", kind: "multiple-person" },
  owner:       { id: "multiple_person_mm4p8xe2", kind: "multiple-person" },
  city:        { id: "text_mm4p2bvb",          kind: "text" },
  state:       { id: "text_mm4sznkw",          kind: "text" },
  employees:   { id: "numeric_mm4ww8gs",       kind: "numeric" },
  revenue:     { id: "numeric_mm4w8g9k",       kind: "numeric" },
  linkedin:    { id: "text_mm4w6rzg",          kind: "text" },
  description: { id: "text_mm4wwtd0",          kind: "text" },
} as const;
```

- [ ] **Step 2: build + commit** — `npm run build` passes (unused until Task 10; builds fine).
```bash
git add monday-app/src/board-config.ts
git commit -m "feat(app): COMPANY_COLS map for the editable company drawer"
```

---

## Task 5: App — companyFormToColumnValues (pure)

**Files:** Create `monday-app/src/lib/company-form.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing tests** — `monday-app/src/lib/company-form.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { companyFormToColumnValues, type CompanyForm } from "./company-form";
import { COMPANY_COLS } from "../board-config";

const base: CompanyForm = {};
describe("companyFormToColumnValues", () => {
  it("text/number -> raw string; empty omitted", () => {
    const cv = companyFormToColumnValues({ ...base, name: "Acme", city: "", employees: "50" });
    expect(cv[COMPANY_COLS.name.id]).toBe("Acme");
    expect(cv[COMPANY_COLS.employees.id]).toBe("50");
    expect(COMPANY_COLS.city.id in cv).toBe(false);
  });
  it("status -> {label}; dropdown -> {labels:[label]}", () => {
    const cv = companyFormToColumnValues({ ...base, type: "Partner", industry: "Computer Software" });
    expect(cv[COMPANY_COLS.type.id]).toEqual({ label: "Partner" });
    expect(cv[COMPANY_COLS.industry.id]).toEqual({ labels: ["Computer Software"] });
  });
  it("people -> {personsAndTeams}; empty omitted", () => {
    const cv = companyFormToColumnValues({ ...base, salesUserId: "111", ownerId: "" });
    expect(cv[COMPANY_COLS.salesUsers.id]).toEqual({ personsAndTeams: [{ id: 111, kind: "person" }] });
    expect(COMPANY_COLS.owner.id in cv).toBe(false);
  });
  it("no fields -> empty object", () => expect(companyFormToColumnValues(base)).toEqual({}));
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- company-form` → FAIL (module missing).

- [ ] **Step 3: Implement** — `monday-app/src/lib/company-form.ts`:

```ts
import { COMPANY_COLS } from "../board-config";
import { peopleValue } from "./columns";

export interface CompanyForm {
  name?: string; industry?: string; type?: string; salesUserId?: string; ownerId?: string;
  city?: string; state?: string; employees?: string; revenue?: string; linkedin?: string; description?: string;
}

/** Company form -> monday column_values (JSON-encode before sending). Empty fields are OMITTED (no clear
 * path in v1). Enums use labels (status -> {label}, dropdown -> {labels:[label]}), people -> personsAndTeams.
 * The item name (domain) is set separately via renameItem. */
export function companyFormToColumnValues(f: CompanyForm): Record<string, unknown> {
  const cv: Record<string, unknown> = {};
  if (f.name?.trim()) cv[COMPANY_COLS.name.id] = f.name;
  if (f.industry?.trim()) cv[COMPANY_COLS.industry.id] = { labels: [f.industry] };
  if (f.type?.trim()) cv[COMPANY_COLS.type.id] = { label: f.type };
  if (f.salesUserId) cv[COMPANY_COLS.salesUsers.id] = peopleValue([f.salesUserId]);
  if (f.ownerId) cv[COMPANY_COLS.owner.id] = peopleValue([f.ownerId]);
  if (f.city?.trim()) cv[COMPANY_COLS.city.id] = f.city;
  if (f.state?.trim()) cv[COMPANY_COLS.state.id] = f.state;
  if (f.employees?.trim()) cv[COMPANY_COLS.employees.id] = f.employees;
  if (f.revenue?.trim()) cv[COMPANY_COLS.revenue.id] = f.revenue;
  if (f.linkedin?.trim()) cv[COMPANY_COLS.linkedin.id] = f.linkedin;
  if (f.description?.trim()) cv[COMPANY_COLS.description.id] = f.description;
  return cv;
}
```

- [ ] **Step 4: Run to verify it passes** — `npm test -- company-form` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add monday-app/src/lib/company-form.ts monday-app/src/lib/company-form.test.ts
git commit -m "feat(app): companyFormToColumnValues pure helper"
```

---

## Task 6: App — mergeAssoc (pure, the bug-fix core)

**Files:** Create `monday-app/src/lib/assoc-merge.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing tests** — `monday-app/src/lib/assoc-merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeAssoc } from "./assoc-merge";

const card = (itemId: string, hubspotId: string, label: string) => ({ itemId, hubspotId, label });
describe("mergeAssoc", () => {
  const cards = [card("10", "1", "Ann"), card("20", "2", "Bob")];
  const hs = [{ hubspotId: "2", name: "Bob" }, { hubspotId: "3", name: "Cara" }];
  it("keeps monday cards (with itemId) and adds HubSpot-only ones (no itemId), deduped by hubspotId", () => {
    expect(mergeAssoc(cards, hs)).toEqual([
      { itemId: "10", hubspotId: "1", label: "Ann" },
      { itemId: "20", hubspotId: "2", label: "Bob" },
      { hubspotId: "3", label: "Cara" },
    ]);
  });
  it("monday-only when HubSpot is empty", () => expect(mergeAssoc(cards, [])).toEqual(cards));
  it("HubSpot-only when there are no cards", () =>
    expect(mergeAssoc([], hs)).toEqual([{ hubspotId: "2", label: "Bob" }, { hubspotId: "3", label: "Cara" }]));
  it("empty + empty -> []", () => expect(mergeAssoc([], [])).toEqual([]));
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- assoc-merge` → FAIL.

- [ ] **Step 3: Implement** — `monday-app/src/lib/assoc-merge.ts`:

```ts
import type { Assoc } from "./assoc";

/** Merge the monday relation cards (which carry itemId) with the record's live HubSpot associations.
 * Every HubSpot record NOT already present by hubspotId is added as a staged Assoc (label + hubspotId,
 * no itemId — resolved to a card on Save by resolveAssocs). Deduped by hubspotId. Pure/testable.
 * This is what makes the drawer show ALL associations (not just the possibly-lagging monday relation). */
export function mergeAssoc(
  mondayCards: { itemId: string; hubspotId: string; label: string }[],
  hubspotRecs: { hubspotId: string; name: string }[],
): Assoc[] {
  const out: Assoc[] = mondayCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.label }));
  const seen = new Set(mondayCards.map(c => c.hubspotId).filter(Boolean));
  for (const r of hubspotRecs) {
    if (!r.hubspotId || seen.has(r.hubspotId)) continue;
    seen.add(r.hubspotId);
    out.push({ label: r.name, hubspotId: r.hubspotId });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes** — `npm test -- assoc-merge` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add monday-app/src/lib/assoc-merge.ts monday-app/src/lib/assoc-merge.test.ts
git commit -m "feat(app): mergeAssoc pure helper (association fresh-on-open)"
```

---

## Task 7: App — generic monday-client item ops

**Files:** Modify `monday-app/src/monday-client.ts`.

- [ ] **Step 1: Add generics + point the deal wrappers at them.**

Add near the deal functions:
```ts
/** Fetch one item (any board) with column values + relation linked ids. Generic form of getDeal. */
export async function getItem(itemId: string): Promise<RawItem | null> {
  const d: any = await api(`query ($i:[ID!]) { items(ids:$i) {
    id name created_at group { id } column_values { id text value ... on BoardRelationValue { linked_item_ids } } } }`, { i: [itemId] });
  return d.items?.[0] ?? null;
}
export async function updateItemColumns(boardId: string, itemId: string, columnValues: Record<string, unknown>): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify(columnValues) });
}
export async function renameItem(boardId: string, itemId: string, name: string): Promise<void> {
  await api(`mutation ($b:ID!, $i:ID!, $c:JSON!) {
    change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify({ name }) });
}
```

(Keep `getDeal`/`updateDealColumns`/`renameDeal` as-is — they already target `DEALS_BOARD` and other code depends on them. The new generics are additive.)

- [ ] **Step 2: build + commit** — `npm run build` passes.
```bash
git add monday-app/src/monday-client.ts
git commit -m "feat(app): generic getItem/updateItemColumns/renameItem"
```

---

## Task 8: App — worker-client for sync-company, associations, deal search

**Files:** Modify `monday-app/src/worker-client.ts`.

- [ ] **Step 1: Add/generalize the client functions.**

Generalize `getRecordAssociations` `to` + `deleteHubspotAssociation` `fromObject`, and add `syncCompany` + `addHubspotAssociation`:
```ts
export async function getRecordAssociations(token: string, type: "contacts" | "companies" | "deals", id: string, to: "contacts" | "companies" | "deals"):
    Promise<{ hubspotId: string; name: string }[]> {
  const res = await call(token, "GET", `/app/associations?type=${type}&id=${encodeURIComponent(id)}&to=${to}`);
  return res?.results ?? [];
}
export async function addHubspotAssociation(token: string, fromObject: "deals" | "companies", fromId: string, toObject: "contacts" | "companies" | "deals", toId: string): Promise<void> {
  await call(token, "POST", "/app/association", { fromObject, fromId, toObject, toId });
}
export async function deleteHubspotAssociation(token: string, fromObject: "deals" | "companies", fromId: string, toObject: "contacts" | "companies" | "deals", toId: string): Promise<void> {
  await call(token, "DELETE", "/app/association", { fromObject, fromId, toObject, toId });
}
export async function syncCompany(token: string, itemId: string): Promise<boolean> {
  const res = await call(token, "POST", "/app/sync-company", { itemId });
  return res?.ok === true;
}
```
**Note:** `deleteHubspotAssociation`'s signature changed (now takes `fromObject` first). Update its existing caller in `DealDrawer.tsx`'s `unlinkRemoved` to pass `"deals"` as the first arg (Task 9 touches DealDrawer anyway; do it there).

Extend `searchHubspot`'s `type` to include `"deals"`:
```ts
export async function searchHubspot(token: string, type: "contacts" | "companies" | "products" | "deals", q: string, signal?: AbortSignal): Promise<SearchResult> {
```

- [ ] **Step 2: tsc** — `npm run build` will FAIL until DealDrawer's `deleteHubspotAssociation` call is updated (Task 9). That's expected; commit after Task 9 compiles, OR update the one call now:

In `monday-app/src/views/DealDrawer.tsx` `unlinkRemoved`, change:
```ts
        try { await deleteHubspotAssociation(board.sessionToken, kind, dealHubspotId, o.hubspotId); }
```
to:
```ts
        try { await deleteHubspotAssociation(board.sessionToken, "deals", dealHubspotId, kind, o.hubspotId); }
```

- [ ] **Step 3: build + commit** — `npm run build` passes.
```bash
git add monday-app/src/worker-client.ts monday-app/src/views/DealDrawer.tsx
git commit -m "feat(app): worker-client sync-company + generalized associations + deal search"
```

---

## Task 9: App — DealDrawer association fresh-on-open (the bug fix)

**Files:** Modify `monday-app/src/views/DealDrawer.tsx`.

- [ ] **Step 1: Fold `mergeAssoc` into the edit-open load.**

Add imports:
```ts
import { mergeAssoc } from "../lib/assoc-merge";
import { getRecordAssociations } from "../worker-client";  // add to the existing worker-client import
```

In the load effect, after the `getCardsByIds` results build `cs`/`cos`, fetch the deal's live HubSpot contacts/companies and merge. Replace:
```ts
      const cs = contactCards.map(c => ({ hubspotId: c.hubspotId, itemId: c.itemId, label: c.name }));
      const cos = companyCards.map(c => ({ hubspotId: c.hubspotId, itemId: c.itemId, label: c.name }));
      setContacts(cs); setOrigContacts(cs);
      resolvedContactsRef.current = new Set(cs.map(c => c.hubspotId).filter((x): x is string => !!x));
      setCompanies(cos); setOrigCompanies(cos);
```
with:
```ts
      const cCards = contactCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name }));
      const coCards = companyCards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name }));
      let cs: Assoc[] = cCards;
      let cos: Assoc[] = coCards;
      const dealHsId = colText(it, DEAL_COLS.hubspotDealId.id);
      if (dealHsId) {  // merge the deal's LIVE HubSpot associations so all show (fixes the 1-of-10 bug)
        try {
          const [hsC, hsCo] = await Promise.all([
            getRecordAssociations(board.sessionToken, "deals", dealHsId, "contacts"),
            getRecordAssociations(board.sessionToken, "deals", dealHsId, "companies"),
          ]);
          cs = mergeAssoc(cCards, hsC);
          cos = mergeAssoc(coCards, hsCo);
        } catch { /* fail soft — fall back to the monday relation */ }
      }
      setContacts(cs); setOrigContacts(cs);
      resolvedContactsRef.current = new Set(cs.map(c => c.hubspotId).filter((x): x is string => !!x));
      setCompanies(cos); setOrigCompanies(cos);
```

(`DealDrawer` already imports `Assoc` from `../lib/assoc`, so `let cs: Assoc[]` type-checks; `mergeAssoc` returns `Assoc[]`.)

- [ ] **Step 2: build + full app tests** — `npm test` all pass; `npm run build` passes.

- [ ] **Step 3: Manual check (after deploy in Task 13):** open a deal with ~10 HubSpot contacts → all show; save with no changes → none dropped from the relation.

- [ ] **Step 4: Commit.**
```bash
git add monday-app/src/views/DealDrawer.tsx
git commit -m "fix(app): deal drawer loads associations fresh from HubSpot (shows all, no shrink-on-save)"
```

---

## Task 10: App — editable CompanyDrawer

**Files:** Rewrite `monday-app/src/views/CompanyDrawer.tsx`.

- [ ] **Step 1: Implement the editable drawer.** Replace `CompanyDrawer.tsx` with the version below.

Behavior: on open, resolve the monday card (`ensureCard`) + `getItem` for hydration; render an editable form (`FormFields`), a contacts `AssociationSection`, and a HubSpot-only deals list (search + add/remove); Save writes changed columns + renames on domain change + `syncCompany`, and unlinks removed contacts. Reuses the deal drawer's dirty-guard + status patterns.

```tsx
import { useEffect, useRef, useState } from "react";
import DrawerShell from "./DrawerShell";
import AssociationSection from "./AssociationSection";
import { Field, SelectStr, SelectOpt, type Opt } from "./FormFields";
import { COMPANY_COLS, COMPANY_REL_CONTACT, CONTACT_ID_COL, COMPANY_BOARD, hubspotRecordUrl } from "../board-config";
import { getItem, updateItemColumns, renameItem, getCardsByIds, openLink, openItemCard, type AccountUser } from "../monday-client";
import {
  ensureCard, syncCompany, getCompanyContacts, getRecordAssociations, getCompanySchema,
  addHubspotAssociation, deleteHubspotAssociation, searchHubspot,
  type Company, type EnumProp,
} from "../worker-client";
import { companyFormToColumnValues, type CompanyForm } from "../lib/company-form";
import { mergeAssoc } from "../lib/assoc-merge";
import type { Assoc } from "../lib/assoc";
import { colText, linkedIds } from "../useBoard";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";
import { useConfirm } from "../confirm";
import type { NewDealSeed } from "../lib/companies";
import { orDash } from "../lib/companies";

interface Props {
  company: Company; token: string; users: AccountUser[];
  onClose: () => void; onCreateDeal: (seed: NewDealSeed) => void; onSaved?: () => void;
}
const enumOpts = (schema: Record<string, EnumProp>, key: string): string[] =>
  (schema[key]?.options ?? []).map(o => o.label);

export default function CompanyDrawer({ company, token, users, onClose, onCreateDeal, onSaved }: Props) {
  const confirm = useConfirm();
  const [itemId, setItemId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<CompanyForm & { domain?: string }>({});
  const [origDomain, setOrigDomain] = useState("");
  const [contacts, setContacts] = useState<Assoc[]>([]);
  const [origContacts, setOrigContacts] = useState<Assoc[]>([]);
  const [deals, setDeals] = useState<{ hubspotId: string; name: string }[]>([]);
  const [schema, setSchema] = useState<Record<string, EnumProp>>({});
  const savingRef = useRef(false);
  const title = company.name || company.domain || "Company";
  const userOpts: Opt[] = users.map(u => ({ value: u.id, label: u.name || u.email || u.id }));
  const set = (p: Partial<typeof form>) => { setDirty(true); setForm(f => ({ ...f, ...p })); };

  useEffect(() => { getCompanySchema(token).then(setSchema).catch(() => {}); }, [token]);

  // Hydrate: resolve the monday card, read its columns + relation, merge fresh HubSpot contacts + deals.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const id = await ensureCard(token, "companies", company.hubspotId);
        const it = await getItem(id);
        if (!it || !alive) { if (alive) setErr("Couldn't load this company. Close and reopen."); return; }
        const people = (col: string) => {
          try { return (JSON.parse(it.column_values.find(c => c.id === col)?.value ?? "{}").personsAndTeams ?? [])
            .filter((p: any) => p.kind === "person").map((p: any) => String(p.id)); } catch { return []; }
        };
        const f: CompanyForm & { domain?: string } = {
          domain: it.name,
          name: colText(it as any, COMPANY_COLS.name.id),
          industry: colText(it as any, COMPANY_COLS.industry.id),
          type: colText(it as any, COMPANY_COLS.type.id),
          salesUserId: people(COMPANY_COLS.salesUsers.id)[0],
          ownerId: people(COMPANY_COLS.owner.id)[0],
          city: colText(it as any, COMPANY_COLS.city.id), state: colText(it as any, COMPANY_COLS.state.id),
          employees: colText(it as any, COMPANY_COLS.employees.id), revenue: colText(it as any, COMPANY_COLS.revenue.id),
          linkedin: colText(it as any, COMPANY_COLS.linkedin.id), description: colText(it as any, COMPANY_COLS.description.id),
        };
        const cards = await getCardsByIds(linkedIds(it as any, COMPANY_REL_CONTACT), CONTACT_ID_COL);
        const [hsContacts, hsDeals] = await Promise.all([
          getCompanyContacts(token, company.hubspotId).catch(() => []),
          getRecordAssociations(token, "companies", company.hubspotId, "deals").catch(() => []),
        ]);
        const merged = mergeAssoc(cards.map(c => ({ itemId: c.itemId, hubspotId: c.hubspotId, label: c.name })),
          hsContacts.map(c => ({ hubspotId: c.hubspotId, name: c.name })));
        if (!alive) return;
        setItemId(id); setForm(f); setOrigDomain(it.name);
        setContacts(merged); setOrigContacts(merged); setDeals(hsDeals); setLoaded(true);
      } catch (e) { if (alive) setErr("Couldn't load this company. " + String(e).slice(0, 120)); }
    })();
    return () => { alive = false; };
  }, [company.hubspotId, token]);

  async function guardedClose() {
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", message: "This company has edits that haven't been saved.", confirmLabel: "Discard changes", cancelLabel: "Keep editing" }))) return;
    onClose();
  }

  async function resolveContacts(list: Assoc[]): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      const cid = await ensureCard(token, "contacts", a.hubspotId!);
      out.push({ ...a, itemId: cid });
    }
    return out;
  }

  async function save() {
    if (savingRef.current || !itemId) return;
    savingRef.current = true; setSaving(true); setErr(null);
    try {
      const cv = companyFormToColumnValues(form);
      if (Object.keys(cv).length) await updateItemColumns(COMPANY_BOARD, itemId, cv);
      if (form.domain && form.domain !== origDomain) await renameItem(COMPANY_BOARD, itemId, form.domain);
      const rc = await resolveContacts(contacts);
      setContacts(rc);
      await updateItemColumns(COMPANY_BOARD, itemId, { [COMPANY_REL_CONTACT]: { item_ids: [...new Set(rc.map(c => Number(c.itemId)))] } });
      // Unlink contacts removed since open (reverseAssociations never deletes).
      for (const o of origContacts) {
        if (o.hubspotId && !rc.some(c => c.hubspotId === o.hubspotId))
          try { await deleteHubspotAssociation(token, "companies", company.hubspotId, "contacts", o.hubspotId); } catch { /* best effort */ }
      }
      setOrigContacts(rc);
      await syncCompany(token, itemId);       // reverse fields + contact links to HubSpot
      setDirty(false); onSaved?.(); onClose();
    } catch (e) {
      setErr("Save failed — press Save to retry. " + String(e).slice(0, 200));
    } finally { setSaving(false); savingRef.current = false; }
  }

  // HubSpot-only deal association add/remove.
  const dealSearch = useDebouncedSearch<{ id: string; name: string; secondary: string }>(
    async (q, signal) => { const r = await searchHubspot(token, "deals", q, signal); return { items: r.items, total: r.total }; });
  async function addDeal(hsDealId: string, name: string) {
    if (deals.some(d => d.hubspotId === hsDealId)) return;
    setDeals(d => [...d, { hubspotId: hsDealId, name }]);
    try { await addHubspotAssociation(token, "companies", company.hubspotId, "deals", hsDealId); } catch { setDeals(d => d.filter(x => x.hubspotId !== hsDealId)); }
  }
  async function removeDeal(hsDealId: string) {
    setDeals(d => d.filter(x => x.hubspotId !== hsDealId));
    try { await deleteHubspotAssociation(token, "companies", company.hubspotId, "deals", hsDealId); } catch { /* best effort */ }
  }

  const footer = (
    <>
      <button className="dc-btn" onClick={guardedClose}>Cancel</button>
      <button className="dc-btn dc-btn-primary" disabled={saving || !loaded} onClick={() => { if (!saving) void save(); }}>
        {saving ? "Saving…" : "Save changes"}
      </button>
    </>
  );
  const headerRight = (
    <>
      <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("companies", company.hubspotId))}>↗ HubSpot</button>
      {itemId && <button className="dc-btn dc-btn-sm" onClick={() => openItemCard(itemId)}>↗ card</button>}
      <button className="dc-btn dc-btn-primary dc-btn-sm" onClick={() => onCreateDeal({ company: { hubspotId: company.hubspotId, name: title } })}>＋ Deal</button>
    </>
  );

  return (
    <DrawerShell title={loaded ? (form.name || form.domain || title) : title} ariaLabel={`Edit company ${title}`} onClose={guardedClose} headerRight={headerRight} footer={footer}>
      {!loaded && !err && <div className="dc-mut">Loading company…</div>}
      {err && <div className="dc-err">{err}</div>}
      {loaded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="dc-section-title">Company</div>
          <div className="dc-grid">
            <Field label="Company name"><input className="dc-field-input" value={form.name ?? ""} onChange={e => set({ name: e.target.value })} /></Field>
            <Field label="Domain"><input className="dc-field-input" value={form.domain ?? ""} onChange={e => set({ domain: e.target.value })} /></Field>
            <Field label="Industry"><SelectStr options={enumOpts(schema, "industry")} value={form.industry} onChange={v => set({ industry: v })} placeholder="—" /></Field>
            <Field label="Type"><SelectStr options={enumOpts(schema, "type")} value={form.type} onChange={v => set({ type: v })} placeholder="—" /></Field>
            <Field label="Sales user"><SelectOpt options={userOpts} value={form.salesUserId} onChange={v => set({ salesUserId: v })} placeholder="No sales user" /></Field>
            <Field label="Owner"><SelectOpt options={userOpts} value={form.ownerId} onChange={v => set({ ownerId: v })} placeholder="No owner" /></Field>
            <Field label="City"><input className="dc-field-input" value={form.city ?? ""} onChange={e => set({ city: e.target.value })} /></Field>
            <Field label="State"><input className="dc-field-input" value={form.state ?? ""} onChange={e => set({ state: e.target.value })} /></Field>
            <Field label="Employees"><input className="dc-field-input" value={form.employees ?? ""} onChange={e => set({ employees: e.target.value })} /></Field>
            <Field label="Annual revenue"><input className="dc-field-input" value={form.revenue ?? ""} onChange={e => set({ revenue: e.target.value })} /></Field>
            <Field label="LinkedIn"><input className="dc-field-input" value={form.linkedin ?? ""} onChange={e => set({ linkedin: e.target.value })} /></Field>
          </div>
          <Field label="Description"><textarea className="dc-field-input" rows={3} value={form.description ?? ""} onChange={e => set({ description: e.target.value })} /></Field>

          <div className="dc-section-title">Contacts</div>
          <AssociationSection kind="contact" token={token} schema={schema} value={contacts} onChange={next => { setDirty(true); setContacts(next); }} />

          <div className="dc-section-title">Deals</div>
          <div className="dc-search">
            <input className="dc-input" placeholder="Search a deal to link…" onChange={e => dealSearch.query(e.target.value)} />
          </div>
          {dealSearch.hits.length > 0 && (
            <div className="dc-picker-results">
              {dealSearch.hits.map(h => <button key={h.id} className="dc-picker-row" onClick={() => { addDeal(h.id, h.name); dealSearch.clear(); }}>＋ {h.name}</button>)}
            </div>
          )}
          <div className="dc-contact-list">
            {deals.length === 0 && <div className="dc-mut">No linked deals.</div>}
            {deals.map(d => (
              <div key={d.hubspotId} className="dc-contact-row">
                <span className="dc-contact-name">{orDash(d.name)}</span>
                <div className="dc-contact-actions">
                  <button className="dc-btn dc-btn-sm" onClick={() => openLink(hubspotRecordUrl("deals", d.hubspotId))}>↗</button>
                  <button className="dc-btn dc-btn-sm" onClick={() => void removeDeal(d.hubspotId)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </DrawerShell>
  );
}
```

**Notes for the implementer:**
- `Field`/`SelectStr`/`SelectOpt`/`Opt` come from `./FormFields` (same as `DealDrawer`). `colText`/`linkedIds`
  are imported from `../useBoard` (re-exported there). `useDebouncedSearch` is used exactly as
  `AssociationPicker` uses it (it exposes `hits`, `query(q)`, `clear()`).
- `dc-picker-results`/`dc-picker-row` styles are added in Task 12.
- The `hubspotRecordUrl`, `COMPANY_BOARD`, and `AccountUser` imports above are already correct (Task 4
  adds the `deals` deep-link) — no post-hoc fixups needed.

- [ ] **Step 2: build** — `npm run build`. Fix any import/type nits (AccountUser source, COMPANY_BOARD constant, hubspotRecordUrl deals). It must compile with `noUnusedLocals`.

- [ ] **Step 3: Commit.**
```bash
git add monday-app/src/views/CompanyDrawer.tsx monday-app/src/board-config.ts
git commit -m "feat(app): editable CompanyDrawer (fields + contact/deal associations, reverse-synced)"
```

---

## Task 11: App — CompaniesView passes users + onSaved

**Files:** Modify `monday-app/src/views/CompaniesView.tsx`.

- [ ] **Step 1: Fetch users once + pass through.**

Add import `getUsers, type AccountUser` from `../monday-client`. Add state + fetch (next to the token effect):
```ts
  const [users, setUsers] = useState<AccountUser[]>([]);
  useEffect(() => { getUsers().then(setUsers).catch(() => {}); }, []);
```
Update the `CompanyDrawer` render to pass `users` + `onSaved` (reload the open company's row is optional; a simple reload of the list is fine):
```tsx
      {open && <CompanyDrawer company={open} token={token} users={users}
        onClose={() => setOpen(null)} onCreateDeal={onCreateDeal}
        onSaved={() => void load(q)} />}
```

- [ ] **Step 2: build + full app tests + commit.** `npm test` + `npm run build` pass.
```bash
git add monday-app/src/views/CompaniesView.tsx
git commit -m "feat(app): CompaniesView provides users + onSaved to the editable CompanyDrawer"
```

---

## Task 12: App — horizontal table scroll + any picker styles

**Files:** Modify `monday-app/src/styles.css`.

- [ ] **Step 1: Add the scroll + minor styles.** Append (adjust to match existing `--` variable names):
```css
/* Tables scroll horizontally so right-hand columns (Sales User / ↗ HubSpot) are reachable */
.dc-table-scroll { overflow-x: auto; scrollbar-width: thin; }
.dc-table-scroll::-webkit-scrollbar { height: 10px; }
.dc-table-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 6px; }
.dc-table { min-width: max-content; }

/* Deal-picker results in the company drawer */
.dc-picker-results { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
.dc-picker-row { text-align: left; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); cursor: pointer; }
.dc-picker-row:hover { border-color: var(--accent); }
```

- [ ] **Step 2: build + commit.** `npm run build` passes.
```bash
git add monday-app/src/styles.css
git commit -m "feat(app): horizontal table scroll + deal-picker styles"
```

---

## Task 13: Deploy worker + end-to-end verification

- [ ] **Step 1: Full gate** — worker `./node_modules/.bin/tsc --noEmit` && `./node_modules/.bin/vitest run` green; app `npm test` && `npm run build` green.
- [ ] **Step 2: Deploy worker** — `./node_modules/.bin/wrangler deploy`.
- [ ] **Step 3: Live smoke** (trigger-secret): `POST /app/sync-company` a company itemId returns ok; `POST/DELETE /app/association` companies↔deals returns ok; `/app/associations?type=companies&to=deals` returns named deals; `/app/search?type=deals&q=` returns named deals.
- [ ] **Step 4: App publish (user step)** — `mapps code:push --client-side -d ./dist -a 11691779 -i 16011075` (needs the user's app token).
- [ ] **Step 5: Manual verification in monday** — edit a company field → HubSpot updates; add/remove a company↔contact → HubSpot + board reflect; add/remove a company↔deal → HubSpot reflects; open a 10-contact deal → all 10 show; save with no changes → none dropped.

---

## Self-review checklist (run after all tasks)

- New/changed exports referenced later all exist: `mapAssocRecord`(deals), `parseAssociationBody`(companies)/`parseSyncCompanyBody`, `putAssociation`; `COMPANY_COLS`/`COMPANY_REL_CONTACT`/`COMPANY_BOARD`, `companyFormToColumnValues`/`CompanyForm`, `mergeAssoc`, `getItem`/`updateItemColumns`/`renameItem`, `syncCompany`/`addHubspotAssociation`/(re-signed)`deleteHubspotAssociation`.
- `deleteHubspotAssociation`'s new signature (`fromObject` first) is updated at **every** caller (DealDrawer + CompanyDrawer).
- No field-blanking: `companyFormToColumnValues` omits empty (no clear path).
- `mergeAssoc` dedups by `hubspotId`; `origContacts` = merged set so no shrink-on-save.
- `noUnusedLocals` satisfied (remove any dangling import after the CompanyDrawer rewrite).
```
