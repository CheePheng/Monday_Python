# Created Date columns + Company domain gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the HubSpot record's creation date on Company Follow Up and the Deals board (Contact Follow Up already has it), and stop a company being created without a `domain` unless the rep explicitly confirms it has no website.

**Architecture:** Created Date is a one-way HubSpot → monday field mapping — no reverse, no backfill flag, no migration job; rows fill in through normal reconciliation. The domain gate lives entirely in the shared pure `record-form` validation, so both entry points (standalone drawer and the in-deal "+ New company" panel) inherit it for free, and the now-unreachable company confirm is deleted.

**Tech Stack:** Cloudflare Worker (TypeScript, vitest), React 18 + Vite app (vitest), monday GraphQL 2026-07, HubSpot CRM v3.

**Spec:** `docs/superpowers/specs/2026-07-23-created-date-and-domain-gate-design.md`

**Commands:** worker — `cd worker && npx tsc --noEmit && npx vitest run`, deploy `npx wrangler deploy`. app — `cd monday-app && npx vitest run && npm run build`, deploy `"/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`.

**Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT `git push`; do NOT commit `docs/`.

**Hard rules for this change:**
- `createdate` is **one-way HubSpot → monday**. Its field spec gets **no `reverse`** and **no `backfill`**. It must never appear in a reverse patch.
- The monday date value is the **UTC** calendar date (`formatValue`'s existing `v.slice(0,10)`). Do not introduce a timezone shift — `formatValue` and `expectedText` must stay in agreement or every tick produces a phantom diff and rewrites forever.
- **Never guess a column id.** Read the id monday returns and paste it into `config.ts`.
- **Never reuse monday's native card-created / Creation Log column** for this — different meaning.
- **No deletion of any monday card in this plan.** Task 8 only presents findings.

---

### Task 1: Worker — column listing + creation helpers, behind the temporary diag route

**Files:** Modify `worker/src/monday.ts`, `worker/src/index.ts`

- [ ] **Step 1: Add the two helpers to `worker/src/monday.ts`** (append near the other write helpers):

```ts
/** Every column on a board: id, title, type. Used to reuse-or-create a column without guessing ids. */
export async function listColumns(env: Env, boardId: string): Promise<{ id: string; title: string; type: string }[]> {
  const data = await gql(env, `query ($b:[ID!]) { boards(ids:$b) { columns { id title type } } }`, { b: [boardId] });
  return data.boards?.[0]?.columns ?? [];
}

/** Create a column and return its REAL id (never guess one). retries=1 — a create must not double-apply. */
export async function createColumn(env: Env, boardId: string, title: string, columnType: string): Promise<string | null> {
  const data = await gql(env,
    `mutation ($b:ID!, $t:String!, $ct:ColumnType!) {
       create_column(board_id:$b, title:$t, column_type:$ct) { id } }`,
    { b: boardId, t: title, ct: columnType }, 1);
  return data.create_column?.id ?? null;
}
```

- [ ] **Step 2: Add a reuse-or-create action to the temporary `/diag` route in `worker/src/index.ts`.** Insert immediately after the `const inspect = ...` block:

```ts
      // &ensureCreatedDate=<boardId>  -> READ-ONLY by default: lists the board's columns and reports which
      //                                  one (if any) already looks like the HubSpot created date.
      // &ensureCreatedDate=<boardId>&create=1 -> only then may it create the column.
      //
      // Read-only by default on purpose: an over-eager title match would otherwise CREATE a second column
      // on a board that already has a correct one. Reuse requires type === "date" AND a "created" title;
      // monday's own creation-log column (type "creation_log") answers a different question — when the CARD
      // was made — and is excluded by the type check, never reused.
      const ensureBoard = url.searchParams.get("ensureCreatedDate") ?? "";
      if (ensureBoard) {
        try {
          const cols = await listColumns(env, ensureBoard);
          const match = cols.find(c => c.type === "date" && /created/i.test(c.title));
          if (match) return Response.json({ boardId: ensureBoard, action: "reuse-candidate", column: match, allColumns: cols });
          if (url.searchParams.get("create") !== "1")
            return Response.json({ boardId: ensureBoard, action: "would-create", title: "Created date", allColumns: cols });
          const id = await createColumn(env, ensureBoard, "Created date", "date");
          return Response.json({ boardId: ensureBoard, action: "created", column: { id, title: "Created date", type: "date" } });
        } catch (e) {
          return Response.json({ error: String(e).slice(0, 300) }, { status: 502 });
        }
      }
```

- [ ] **Step 3: Import the helpers.** Extend the existing monday import in `index.ts` to include `listColumns, createColumn`.

- [ ] **Step 4: Verify + deploy**

Run: `cd worker && npx tsc --noEmit && npx vitest run` → tsc clean, 199 pass. Then `npx wrangler deploy`.

- [ ] **Step 5: Commit**

```bash
git add worker/src/monday.ts worker/src/index.ts
git commit -m "chore(worker): temporary reuse-or-create Created-date column tooling"
```

---

### Task 2: Create the two columns and capture their REAL ids

**Files:** none (operational)

**The secret lives in `/tmp/diagsecret.txt` from the session that created it.** If that file is gone, mint a new one: `S="diag-$(date +%s)-$RANDOM"; printf '%s' "$S" | npx wrangler secret put DIAG_SECRET` (then use that `$S`).

- [ ] **Step 1: LOOK FIRST — list columns on all three boards, create nothing**

```bash
S=$(cat /tmp/diagsecret.txt)
for b in 5029639440 5029480547 5029639630; do
  echo "=== board $b ==="
  curl -s "https://hubspot-monday-sync.askada.workers.dev/diag?secret=$S&ensureCreatedDate=$b" \
   | python -c "import json,sys; d=json.load(sys.stdin); print(' action:',d.get('action')); print(' match:',d.get('column')); print(' date cols:',[c for c in d.get('allColumns',[]) if c['type']=='date'])"
done
```
Read the output before doing anything:
- **Contact Follow Up (5029639630)** must report a `reuse-candidate` (or at minimum show `date_mm4s2bjd` among its date columns). `date_mm4s2bjd` is already mapped in `CONTACTS_MYLA` — whatever its title, **do not create a column on this board and make no config change for contacts.** If the tool reports `would-create` here, that only means the existing column's title doesn't contain "created"; that is fine and must NOT be acted on.
- For **Company (5029639440)** and **Deals (5029480547)**, decide per board: if a listed `date` column genuinely already means "HubSpot record created date", reuse its id; otherwise proceed to Step 2. Never reuse a `creation_log` column.

- [ ] **Step 2: Create the column ONLY on the boards that need one**

```bash
S=$(cat /tmp/diagsecret.txt)
curl -s "https://hubspot-monday-sync.askada.workers.dev/diag?secret=$S&ensureCreatedDate=5029639440&create=1"
curl -s "https://hubspot-monday-sync.askada.workers.dev/diag?secret=$S&ensureCreatedDate=5029480547&create=1"
```
Expected each: `{"action":"created","column":{"id":"date_xxxxx",...}}`. **Record both ids — they go into Task 3 verbatim.**
Do **not** run this against 5029639630.

- [ ] **Step 3: Confirm exactly one date column was added per board**

Re-run the Step 1 listing for 5029639440 and 5029480547 and confirm the new column appears once. If a board somehow gained two, delete the surplus in the monday UI before continuing.

---

### Task 3: Map `createdate` one-way on Companies and Deals

**Files:** Modify `worker/src/config.ts`

- [ ] **Step 1: Add the Company mapping.** In `COMPANIES_MYLA.fields`, add (substituting the id captured in Task 2 Step 1):

```ts
    // One-way HubSpot -> monday. NO `reverse` and NO `backfill`: createdate is HubSpot-owned and read-only,
    // so it must never enter a reverse patch. Value is the UTC calendar date (formatValue's v.slice(0,10)).
    { hs: "createdate", col: "<COMPANY_CREATED_DATE_COL_ID>", type: "date" },
```

- [ ] **Step 2: Add the Deals mapping.** In `DEALS.fields`, add (substituting the id from Task 2 Step 2):

```ts
    // One-way HubSpot -> monday (see COMPANIES_MYLA.createdate). Never reverse, never backfill.
    { hs: "createdate", col: "<DEAL_CREATED_DATE_COL_ID>", type: "date" },
```

- [ ] **Step 3: Verify neither mapping is reversible**

Run: `cd worker && grep -n 'hs: "createdate"' src/config.ts`
Expected: exactly **three** field mappings (contacts, companies, deals), and **none** of the three lines contains `reverse` or `backfill`.
(Grep for the bare word `createdate` instead and you will also match the `propertyName: "createdate"` entries in both `searchFilters` — those are the sync-scope filters and are unrelated to this change. Leave them alone.)

**Expect a one-time write burst.** `createdate` becomes a diffable field on two boards where every existing row has it empty, so the next reconcile has a real diff for every company and every deal (~190 deals). Those writes are spread across ticks by `MAX_WRITES`, so the boards will fill in progressively over a few passes rather than all at once. This is the normal reconciliation doing its job — it is not a bulk backfill job, and nothing needs to be triggered manually.

- [ ] **Step 4: Green gate**

Run: `cd worker && npx tsc --noEmit && npx vitest run` → tsc clean, 199 pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/config.ts
git commit -m "feat(worker): map HubSpot createdate to Created date on Companies + Deals (one-way)"
```

---

### Task 4: `record-form` — the domain gate

**Files:** Modify `monday-app/src/lib/record-form.ts`, `monday-app/src/lib/record-form.test.ts`

- [ ] **Step 1a: FIRST update the two existing assertions this change invalidates.** A domain-less company used to be valid-with-a-warning; it is now invalid-with-an-error, so two assertions in `monday-app/src/lib/record-form.test.ts` would fail. Fix them before adding anything.

Find (in `describe("validateRecordForm")` → `it("requires the name field")`):
```ts
    expect(validateRecordForm("company", { name: "Acme" }).ok).toBe(true);
```
Replace with (a company now also needs a domain, or the checkbox):
```ts
    expect(validateRecordForm("company", { name: "Acme", domain: "acme.com" }).ok).toBe(true);
```

Find (in `it("warns (not errors) when the dedup key is missing")`):
```ts
    expect(validateRecordForm("contact", { firstname: "Ada" }).warnings.email).toBeTruthy();
    expect(validateRecordForm("company", { name: "Acme" }).warnings.domain).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).warnings.email).toBeUndefined();
```
Replace with (the company case is now an ERROR, asserted in the new block below; contacts keep the warning):
```ts
    expect(validateRecordForm("contact", { firstname: "Ada" }).warnings.email).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).warnings.email).toBeUndefined();
```

- [ ] **Step 1b: Write the failing tests.** Append to `monday-app/src/lib/record-form.test.ts`:

```ts
describe("company domain gate", () => {
  it("is valid with a domain", () =>
    expect(validateRecordForm("company", { name: "Acme", domain: "acme.com" }).ok).toBe(true));
  it("is INVALID with no domain and the box unticked", () => {
    const v = validateRecordForm("company", { name: "Acme" });
    expect(v.ok).toBe(false);
    expect(v.errors.domain).toBeTruthy();
  });
  it("is INVALID when the domain is only whitespace", () => {
    const v = validateRecordForm("company", { name: "Acme", domain: "   " });
    expect(v.ok).toBe(false);
    expect(v.errors.domain).toBeTruthy();
  });
  it("is valid with no domain once the box is ticked", () =>
    expect(validateRecordForm("company", { name: "Acme", [NO_WEBSITE]: "1" }).ok).toBe(true));
  it("never sends the checkbox flag to HubSpot", () =>
    expect(recordFormToProperties("company", { name: "Acme", [NO_WEBSITE]: "1" }))
      .toEqual({ name: "Acme" }));
});
```
Extend the file's import to include `NO_WEBSITE`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd monday-app && npx vitest run src/lib/record-form.test.ts`
Expected: FAIL — `NO_WEBSITE` is not exported; the no-domain case currently passes as valid.

- [ ] **Step 3: Implement in `monday-app/src/lib/record-form.ts`**

(a) Extend the field type and export the flag key. Replace:
```ts
export type RecordFieldType = "text" | "textarea" | "email" | "number" | "enum";
```
with:
```ts
export type RecordFieldType = "text" | "textarea" | "email" | "number" | "enum" | "checkbox";

/** Form-only flag (NOT a HubSpot property): "this company has no website". A company with no domain can
 * never be de-duplicated, so skipping the domain has to be a deliberate act rather than an oversight. */
export const NO_WEBSITE = "__noWebsite";
```

(b) Add the checkbox to `COMPANY_FIELDS`, directly after the `domain` entry:
```ts
  { prop: NO_WEBSITE, label: "This company has no website", type: "checkbox", group: "Identity" },
```

(c) Replace the company warning with a hard gate. Find:
```ts
  if (kind === "company" && !v.domain?.trim()) warnings.domain = "No domain — duplicates can't be detected reliably. Double-check this isn't already in HubSpot.";
```
Replace with:
```ts
  // Domain is the ONLY de-duplication key a company has, so it is required unless the rep explicitly
  // states there is no website. `.trim()` means a whitespace-only entry does not count as present.
  if (kind === "company" && !v.domain?.trim() && v[NO_WEBSITE] !== "1")
    errors.domain = "Enter a domain, or tick “This company has no website”";
```

(d) Keep form-only controls out of the HubSpot payload. In `recordFormToProperties`, replace the loop body:
```ts
  for (const f of fieldsFor(kind)) { const t = v[f.prop]?.trim(); if (t) out[f.prop] = t; }
```
with:
```ts
  for (const f of fieldsFor(kind)) {
    if (f.type === "checkbox") continue;          // form-only control, never a HubSpot property
    const t = v[f.prop]?.trim(); if (t) out[f.prop] = t;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd monday-app && npx vitest run src/lib/record-form.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/record-form.ts monday-app/src/lib/record-form.test.ts
git commit -m "feat(monday-app): company domain required unless 'no website' is confirmed"
```

---

### Task 5: `RecordForm` — render the checkbox

**Files:** Modify `monday-app/src/views/RecordForm.tsx`

- [ ] **Step 1: Render checkbox fields inline (no stacked label).** In the `field` renderer, insert this as the FIRST statement of the function, before `const opts = ...`:

```tsx
    if (f.type === "checkbox") return (
      <label key={f.prop} className="dc-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={values[f.prop] === "1"}
          onChange={e => onChange(f.prop, e.target.checked ? "1" : "")} />
        <span className="dc-field-label" style={{ margin: 0 }}>{f.label}</span>
      </label>
    );
```

- [ ] **Step 2: Build**

Run: `cd monday-app && npm run build` → tsc clean, vite build succeeds.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/views/RecordForm.tsx
git commit -m "feat(monday-app): RecordForm renders checkbox fields"
```

---

### Task 6: Delete the now-unreachable company confirm

**Files:** Modify `monday-app/src/views/RecordDrawer.tsx`, `monday-app/src/views/AssociationSection.tsx`

The form gate makes a domain-less company create impossible without an explicit tick, so the company branch of the old `window.confirm` can never fire. Remove it rather than leaving dead logic. **The contact branch stays** — contacts have no equivalent checkbox.

- [ ] **Step 1: `RecordDrawer.tsx`.** Find:
```tsx
    const dedupKey = kind === "contact" ? values.email : values.domain;
    if (!submitted && !dedupKey?.trim() && !window.confirm(
      `No ${kind === "contact" ? "email" : "domain"} — a duplicate can't be detected automatically. Create this ${kind} anyway?`)) return;
```
Replace with:
```tsx
    // Contacts only: a missing email still needs an explicit acknowledgement. Companies are gated by the
    // form itself (domain required unless "This company has no website" is ticked), which makes the old
    // company confirm unreachable — it was removed rather than left as dead logic.
    if (kind === "contact" && !submitted && !values.email?.trim() && !window.confirm(
      "No email — a duplicate can't be detected automatically. Create this contact anyway?")) return;
```

- [ ] **Step 2: `AssociationSection.tsx`.** Find:
```tsx
    const dedupKey = kind === "contact" ? values.email : values.domain;
    if (!dedupKey?.trim() && !window.confirm(
      `No ${kind === "contact" ? "email" : "domain"} — a duplicate can't be detected automatically. Add this new ${kind} anyway?`)) return;
```
Replace with:
```tsx
    // Contacts only — see RecordDrawer.submit. The company path is gated by the form's domain requirement.
    if (kind === "contact" && !values.email?.trim() && !window.confirm(
      "No email — a duplicate can't be detected automatically. Add this new contact anyway?")) return;
```

- [ ] **Step 3: Confirm no company-domain confirm survives**

Run: `cd monday-app && grep -rn "domain — a duplicate" src/ || echo "NONE (correct)"`
Expected: `NONE (correct)`.

- [ ] **Step 4: Build + commit**

Run: `npm run build` → clean.
```bash
git add monday-app/src/views/RecordDrawer.tsx monday-app/src/views/AssociationSection.tsx
git commit -m "refactor(monday-app): drop unreachable company no-domain confirm (form now gates it)"
```

---

### Task 7 (OPTIONAL — adds a devDependency; decline to skip): light integration tests for both entry points

**Files:** Modify `monday-app/package.json`, create `monday-app/src/views/RecordForm.integration.test.tsx`

The app currently tests pure libs only. This adds a minimal component test so the gate is proven to actually bind in the UI, and that the checkbox does not persist between openings.

- [ ] **Step 1: Add the test dependencies**

Run: `cd monday-app && npm i -D @testing-library/react jsdom`

(`@testing-library/jest-dom` is deliberately NOT added — the test below uses plain DOM assertions, so there is no custom-matcher setup to maintain.)

- [ ] **Step 2: No config file.** Do NOT add a `vitest.config.ts` with a global `environment: "jsdom"` — that would force a DOM on all ~108 pure-lib tests that neither need nor want one. The new file opts itself in with a `@vitest-environment jsdom` docblock (first line of the file below).

- [ ] **Step 3: Create `monday-app/src/views/RecordForm.integration.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import RecordForm from "./RecordForm";
import { validateRecordForm, NO_WEBSITE, type RecordFormValues } from "../lib/record-form";

/** Minimal host mirroring how BOTH entry points drive the form: local values + shared validation. */
function Host({ initial = {} as RecordFormValues }) {
  const [values, setValues] = useState<RecordFormValues>(initial);
  const v = validateRecordForm("company", values);
  return (
    <>
      <RecordForm kind="company" values={values} schema={{}} validation={v}
        onChange={(p, val) => setValues(s => ({ ...s, [p]: val }))} />
      <button disabled={!v.ok}>Save</button>
    </>
  );
}

const saveBtn = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const checkbox = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("company form gate (as both entry points use it)", () => {
  it("blocks Save with a name but no domain, and shows why", () => {
    render(<Host initial={{ name: "Acme" }} />);
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByText(/Enter a domain/i)).toBeTruthy();
  });
  it("allows Save once a domain is present", () => {
    render(<Host initial={{ name: "Acme", domain: "acme.com" }} />);
    expect(saveBtn().disabled).toBe(false);
  });
  it("rejects a whitespace-only domain", () => {
    render(<Host initial={{ name: "Acme", domain: "   " }} />);
    expect(saveBtn().disabled).toBe(true);
  });
  it("allows Save when 'no website' is ticked instead", () => {
    render(<Host initial={{ name: "Acme", [NO_WEBSITE]: "1" }} />);
    expect(saveBtn().disabled).toBe(false);
    expect(checkbox().checked).toBe(true);
  });
  it("does not carry the tick into a freshly opened form", () => {
    const first = render(<Host initial={{ name: "Acme", [NO_WEBSITE]: "1" }} />);
    expect(checkbox().checked).toBe(true);
    first.unmount();                              // closing the drawer / collapsing the "+ New" panel
    render(<Host initial={{ name: "Beta" }} />);  // a fresh opening starts from empty values
    expect(checkbox().checked).toBe(false);
    expect(saveBtn().disabled).toBe(true);
  });
});
```

- [ ] **Step 4: Run**

Run: `cd monday-app && npx vitest run` → the existing pure-lib tests all still pass, plus 5 new ones.
If the runner cannot resolve the jsdom environment, confirm `jsdom` installed and that the docblock is the **very first line** of the test file.

- [ ] **Step 5: Build (make sure the new .tsx doesn't break the production typecheck)**

Run: `cd monday-app && npm run build` → tsc clean, vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add monday-app/package.json monday-app/package-lock.json monday-app/src/views/RecordForm.integration.test.tsx
git commit -m "test(monday-app): light integration cover for the company domain gate + checkbox reset"
```

---

### Task 8: Green gate, deploy, verify — and PRESENT the duplicate findings (no deletion)

**Files:** none

- [ ] **Step 1: Full green gate**

Run: `cd worker && npx tsc --noEmit && npx vitest run` (199) and `cd ../monday-app && npx vitest run && npm run build`.

- [ ] **Step 2: Deploy both**

`cd worker && npx wrangler deploy`, then `cd ../monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`

- [ ] **Step 3: Verify Created Date populates (one-way)**

Touch one company in HubSpot (any trivial edit) so the incremental picks it up, then:
```bash
S=$(cat /tmp/diagsecret.txt)
curl -s "https://hubspot-monday-sync.askada.workers.dev/diag?secret=$S&object=companies&items=<thatCardId>"
```
Expected: the new Created-date column now holds the record's **UTC** creation date (compare against the `createdate` shown by `&recentHours=`; for a record created 00:00–08:00 Malaysia time the column will legitimately read the previous day).

Then confirm the direction really is one-way: edit that date column in monday and wait for the webhook. Expected outcome — **HubSpot's `createdate` is unchanged, AND monday reverts to the HubSpot value.** That second half is the point: because the field has no `reverse`, it never enters a reverse patch, so the reconcile falls through to a forward write and HubSpot wins. A monday edit that *stuck* would mean the mapping was made reversible by mistake.

- [ ] **Step 4: Verify the domain gate in the app**

Standalone **＋ New Company**: with a name but no domain, Save is disabled and the inline message appears; ticking **This company has no website** enables it **and no popup appears**. Repeat inside **Deal → Associations → ＋ New company**. Confirm a domain-less company still lands with the `companies <id>` fallback name (unchanged behaviour).

- [ ] **Step 5: PRESENT the duplicate-card findings — do NOT delete anything**

Re-run the comparison and report it for approval:
```bash
S=$(cat /tmp/diagsecret.txt)
curl -s "https://hubspot-monday-sync.askada.workers.dev/diag?secret=$S&object=companies&items=2800166155,2800227220"
```
Findings as captured 2026-07-23 (re-verify before any action):
- Both cards carry HubSpot id **335311575762**, are named `changhongit.com`, are in group `group_mm4s3z7e`, and hold **identical values in every mapped column**.
- **`2800166155` — CANONICAL.** Created 03:47:19Z, updated 04:11:28Z, Sync State `04:04:49.974Z`, and it is the **only** one holding the Company→Contact relation (`board_relation_mm54e96 = ["2800227425"]`).
- **`2800227220` — DUPLICATE.** Created 03:47:20Z (one second later), Sync State `03:47:18.612Z`, relation column **empty**, and it holds **no** value the canonical card lacks.
- Cause: the eventually-consistent id-column search race, from before the card-registry fix.

**Proposed action, for explicit human approval only:**
1. Re-verify both cards immediately before acting.
2. Confirm `2800227220` still has an empty relation column and nothing unique.
3. Delete **only** `2800227220`, from the monday UI (recoverable from the board recycle bin ~30 days).
4. Run reconciliation and confirm it does not reappear — the canonical card is long-indexed, so the column search finds it and `ensureCardForRecord` adopts rather than creates.

**This task performs no deletion.** Stop here and wait.

---

### Task 9: Remove the temporary diagnostic

**Files:** Modify `worker/src/index.ts`, `worker/src/hubspot.ts`, `worker/src/types.ts`

Only after Tasks 2 and 8 are complete and the duplicate question is closed.

- [ ] **Step 1:** Delete the whole `if (url.pathname === "/diag" ...)` block from `worker/src/index.ts`, then remove only the imports it alone was using. **Check each with grep first — `getItem` and `setColumns` are used by the line-item routes and MUST stay:**

```bash
cd worker
for s in recentRecords listColumns createColumn getLinkedItemIds getBoardItems findItemByColumn getItem setColumns; do
  printf '%-20s uses in index.ts: ' "$s"; grep -c "\b$s\b" src/index.ts
done
```
Any symbol showing `1` after the block is gone is import-only → remove it from the import list. Anything ≥2 is still in use → keep it. `tsc` (`noUnusedLocals`) will catch a miss either way.

- [ ] **Step 2:** Delete `recentRecords` from `worker/src/hubspot.ts`. Leave `listColumns`/`createColumn` in `worker/src/monday.ts` — they are harmless unused exports (`noUnusedLocals` does not flag exports) and are genuinely useful the next time a column is needed.
- [ ] **Step 3:** Delete `DIAG_SECRET` from the `Env` interface in `worker/src/types.ts`.
- [ ] **Step 4:** `npx tsc --noEmit && npx vitest run` → clean, 199 pass. Deploy.
- [ ] **Step 5:** Delete the secret: `npx wrangler secret delete DIAG_SECRET`
- [ ] **Step 6:** Confirm it is gone: `curl -s -o /dev/null -w '%{http_code}\n' "https://hubspot-monday-sync.askada.workers.dev/diag?secret=x"` → expect `404`.
- [ ] **Step 7: Commit**

```bash
git add worker/src/index.ts worker/src/hubspot.ts worker/src/types.ts
git commit -m "chore(worker): remove temporary /diag diagnostic endpoint and secret"
```

---

## Notes for the implementer
- `createdate` must never gain `reverse` or `backfill`. If a future diff shows it in a reverse patch, that is a bug.
- Do not "fix" the UTC date into local time here. `formatValue` and `expectedText` must agree exactly; changing one without the other causes a permanent phantom diff that rewrites the row every tick.
- Existing domain-less companies are left alone on purpose, and the `companies <id>` fallback name stays.
- No monday card is deleted by this plan.
