# Reverse-sync Sales Users → HubSpot `sales_user` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`). Task 5 hits live monday/HubSpot with the local token — run inline.

**Goal:** Assigning a person to the Sales Users people column in monday writes HubSpot `sales_user` back (first person if several; set-only), so deals move out of Unassigned into their stage group automatically. Deal, Company, Contact boards.

**Architecture:** Reuse the existing diff → direction → reverse-patch flow. Add reverse identity maps to `ctx`, carry people-column person ids on `MondayItem`, and make a *filled* Sales Users column diff **by owner-id** (monday person → owner id vs HubSpot) — reliable, no phantom loops. Empty column keeps the existing forward-fill.

**Tech Stack:** Cloudflare Worker (TypeScript, vitest, wrangler), monday GraphQL (PeopleValue typed fragment), HubSpot CRM v3.

---

## Task 1: Reverse identity maps in ctx

**Files:** Modify `worker/src/types.ts`, `worker/src/sync.ts`

- [ ] **Step 1:** In `types.ts`, add to `Ctx`:

```typescript
  mondayEmailByUserId: Record<string, string>; // monday user id -> email
  ownerIdByEmail: Record<string, string>;       // email (lowercased) -> HubSpot owner id
```

- [ ] **Step 2:** In `sync.ts` `buildCtx`, after `ownersById` + `mondayUsersByEmail` are available, build and return the inverses:

```typescript
  const mondayEmailByUserId: Record<string, string> = {};
  for (const [email, id] of Object.entries(mondayUsersByEmail)) mondayEmailByUserId[id] = email;
  const ownerIdByEmail: Record<string, string> = {};
  for (const [id, o] of Object.entries(ownersById)) if (o.email) ownerIdByEmail[o.email.toLowerCase()] = id;
```

Add `mondayEmailByUserId, ownerIdByEmail` to the returned `ctx`.

- [ ] **Step 3:** Update the two other `Ctx` literals used in tests (`reconcile.test.ts`, `mapping.test.ts`, `associations.test.ts`) to include the new fields (`mondayEmailByUserId: {}, ownerIdByEmail: {}`) so they compile.

- [ ] **Step 4:** `cd worker && npx tsc --noEmit` → clean.

---

## Task 2: Carry people-column person ids on MondayItem

**Files:** Modify `worker/src/types.ts`, `worker/src/monday.ts`

- [ ] **Step 1:** In `types.ts`, extend the `MondayItem` column value shape:

```typescript
  column_values: { id: string; text: string | null; persons_and_teams?: { id: string; kind: string }[] }[];
```

- [ ] **Step 2:** In `monday.ts`, extend `ITEM_FIELDS` and the two inline queries in `getBoardItems` to fetch the People typed value. Replace `column_values { id text }` with:

```graphql
column_values { id text ... on PeopleValue { persons_and_teams { id kind } } }
```

(There are 3 occurrences: `ITEM_FIELDS` const + the `items_page` and `next_items_page` queries in `getBoardItems`.)

- [ ] **Step 3:** `npx tsc --noEmit` → clean; `npx vitest run` → still green.

---

## Task 3: People reverse in the diff/patch flow

**Files:** Modify `worker/src/reconcile.ts`; Test `worker/test/reconcile.test.ts`

- [ ] **Step 1: Write failing tests** in `reconcile.test.ts` (add a ctx with the reverse maps + a people field):

```typescript
const pctx: Ctx = { labels: {}, ownersById: {}, mondayUsersByEmail: {},
  mondayEmailByUserId: { "42": "rep@x.com" }, ownerIdByEmail: { "rep@x.com": "555" }, portalId: 1 };
const pspec: ObjectSpec = { ...spec, fields: [{ hs: "sales_user", col: "c_people", type: "people", reverse: true }] };
const pitem = (persons: { id: string; kind: string }[]) => item({
  column_values: [{ id: "c_id", text: "9001" }, { id: "c_people", text: persons.length ? "Rep" : "", persons_and_teams: persons }] });
const pRec = (sales_user?: string) => ({ id: "9001", properties: { dealname: "Acme", ...(sales_user ? { sales_user } : {}) } });

it("filled Sales Users mapping to a different owner -> reversible people diff", () => {
  const d = fieldDiffs(pRec(""), pitem([{ id: "42", kind: "person" }]), pspec, pctx);
  expect(d.find(x => x.f?.col === "c_people")).toMatchObject({ kind: "field", hsText: "", mdText: "555" });
  expect(buildReversePatch(d, pitem([{ id: "42", kind: "person" }]), pspec, pctx)).toEqual({ sales_user: "555" });
});
it("Sales Users person already matching HubSpot owner -> no diff", () =>
  expect(fieldDiffs(pRec("555"), pitem([{ id: "42", kind: "person" }]), pspec, pctx).some(x => x.f?.col === "c_people")).toBe(false));
it("unmapped person (no HubSpot owner) -> no diff (skipped)", () =>
  expect(fieldDiffs(pRec(""), pitem([{ id: "99", kind: "person" }]), pspec, pctx).some(x => x.f?.col === "c_people")).toBe(false));
it("empty Sales Users -> still just the forward-fill heal, never a reverse diff", () => {
  const d = fieldDiffs(pRec("555"), pitem([]), pspec, { ...pctx, ownersById: { "555": { name: "R", email: "rep@x.com" } }, mondayUsersByEmail: { "rep@x.com": "42" } });
  expect(d.find(x => x.f?.col === "c_people")).toMatchObject({ mdText: "" }); // forward fill, not reverse
});
```

- [ ] **Step 2:** Run `npx vitest run test/reconcile.test.ts` → FAIL (people reverse not implemented; `mdText` is not the owner id).

- [ ] **Step 3: Implement** in `reconcile.ts`. Add the helper (near the top):

```typescript
/** monday first-person in a people column -> HubSpot owner id (via email), or "" if none/unmapped. */
function firstPersonOwnerId(item: MondayItem, col: string, ctx: Ctx): string {
  const cv = item.column_values.find(c => c.id === col);
  const pid = cv?.persons_and_teams?.find(p => p.kind === "person")?.id;
  if (!pid) return "";
  const email = ctx.mondayEmailByUserId[String(pid)];
  return email ? (ctx.ownerIdByEmail[email.toLowerCase()] ?? "") : "";
}
```

Replace the `if (f.type === "people")` block in `fieldDiffs`:

```typescript
    if (f.type === "people") {
      if (!colText(item, f.col)) {
        // empty column: forward-fill from HubSpot when it maps to a monday user (existing heal)
        if (formatValue(f, rec.properties[f.hs], ctx))
          out.push({ kind: "field", f, hsText: "(person)", mdText: "" });
      } else if (f.reverse) {
        // filled + reversible: compare the monday person's owner id to HubSpot (id compare -> no phantom).
        const wantOwner = firstPersonOwnerId(item, f.col, ctx);
        const hsOwner = (rec.properties[f.hs] ?? "").trim();
        if (wantOwner && wantOwner !== hsOwner) out.push({ kind: "field", f, hsText: hsOwner, mdText: wantOwner });
      }
      continue;
    }
```

In `reverseFieldValue`, handle people (the diff's `mdText` already holds the owner id) — add right after the empty guard:

```typescript
  if (f.type === "people") return text; // text is the monday-derived HubSpot owner id
```

In `buildCreateProperties`, use the owner id (not the name) for reversible people fields:

```typescript
  for (const f of spec.fields) {
    if (!f.reverse) continue;
    const v = f.type === "people" ? firstPersonOwnerId(item, f.col, ctx)
                                  : reverseFieldValue(f, colText(item, f.col), ctx);
    if (v) props[f.hs] = v;
  }
```

- [ ] **Step 4:** Run `npx vitest run test/reconcile.test.ts` → PASS. Then `npx tsc --noEmit && npx vitest run` → all green.

---

## Task 4: Mark Sales Users reversible on all three boards

**Files:** Modify `worker/src/config.ts`

- [ ] **Step 1:** Add `reverse: true` to the `sales_user` people field in each spec:
  - DEALS: `{ hs: "sales_user", col: "multiple_person_mm532m82", type: "people", reverse: true }`
  - COMPANIES_MYLA: `{ hs: "sales_user", col: "multiple_person_mm54phd7", type: "people", reverse: true }`
  - CONTACTS_MYLA: `{ hs: "sales_user", col: "multiple_person_mm542gng", type: "people", reverse: true }`

- [ ] **Step 2:** Update the Sales Users column descriptions in monday (optional, one-off script) to note "effectively single — first person is used as the HubSpot sales user."

- [ ] **Step 3:** `npx tsc --noEmit && npx vitest run` → all green. Commit-ready.

---

## Task 5: Deploy + live verification

- [ ] **Step 1:** `cd worker && npx wrangler deploy` (production; user-authorized).
- [ ] **Step 2 (deal move):** In monday, assign a Sales User to a deal in the **Unassigned** group. Within ~30s: HubSpot `sales_user` is set (verify via API), the card moves to its Deal Stage group, and the Shared/all-members team clears. Revert.
- [ ] **Step 3 (create):** Create a deal in monday with a Sales User assigned → the new HubSpot deal carries `sales_user` (not null). Clean up the test deal (monday card + HubSpot deal).
- [ ] **Step 4 (company + contact):** Assign a Sales User to a company card and a contact card in monday → their HubSpot `sales_user` is written. Revert.
- [ ] **Step 5:** Confirm no oscillation: after each assignment, a second reconcile makes no further writes (person maps to the owner already set).

---

## Self-Review Notes

- **Spec coverage:** reverse maps (Task 1) ✔; read person id (Task 2) ✔; reversible people diff by owner-id + set-only empty-fill + skip-unmapped (Task 3) ✔; monday-created record carries sales_user via buildCreateProperties people fix (Task 3) ✔; all three boards (Task 4) ✔; automatic group move + live verify (Task 5) ✔; loop safety = id-compare so matching owner produces no diff (Task 3 test) ✔.
- **Type consistency:** `firstPersonOwnerId(item, col, ctx)` used in both `fieldDiffs` and `buildCreateProperties`; `Ctx.mondayEmailByUserId` / `ownerIdByEmail` added in Task 1 and consumed in Task 3; `persons_and_teams` added to `MondayItem` in Task 2 and read in Task 3.
- **Set-only:** an empty monday column never produces a reverse diff — it only forward-fills from HubSpot, so clearing in monday gets re-filled (HubSpot `sales_user` untouched), matching decision #4.
- **No placeholders:** every step shows real code.
