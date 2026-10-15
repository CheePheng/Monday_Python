# Deal Cockpit v3.4 Phase C — Contextual + Nested Associations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rep create a NEW Contact/Company in context — inside Deal → Associations (pending until the deal saves, then created + linked; Cancel creates nothing) and as an optional one-level nested association on the standalone Create forms (link an existing, or create a new, related record).

**Architecture:** The existing `Assoc` staging model is the extension point: a staged association gains an optional `create` payload (form values + a stable idempotency key). Nothing is created until Save — `DealDrawer.resolveAssocs` (and `RecordDrawer.submit`) turn a pending-create `Assoc` into a real record via the Phase A `POST /app/{contact,company}` endpoint, then link it exactly as an existing record is linked today. The record form is extracted into a reusable `RecordForm` shared by the standalone drawer, the in-deal "+ New" panel, and the nested panel. The live search already sitting next to "+ New" *is* the spec's name-match search; the no-dedup-key path keeps the explicit confirm.

**Tech Stack:** React 18 + TS + Vite + vitest; the Cloudflare Worker `/app/*` API (Phase A). Everything is additive; the deal create/edit save flow is preserved.

**Spec:** `docs/superpowers/specs/2026-07-21-deal-cockpit-v3.4-contact-company-creation.md` (Component 5 + duplicate protection).

**Reference — existing pieces reused (do not reinvent):**
- `monday-app/src/views/AssociationPicker.tsx` — search LIVE HubSpot + stage an `Assoc`; currently exports `Assoc = { hubspotId; itemId?; label }`.
- `monday-app/src/views/DealDrawer.tsx` — `resolveAssocs(list, kind)` maps staged `Assoc`s → monday cards (`findOrCreateContact`/`findOrCreateCompany`), then `updateDealColumns` writes the `board_relation`; `unlinkRemoved` diffs against the originals; the HubSpot deal↔record association is created by the background `syncDeal`/`reverseAssociations`.
- `monday-app/src/views/RecordDrawer.tsx` (Phase B) — the standalone create drawer + its form.
- `monday-app/src/lib/record-form.ts` — `fieldsFor`, `validateRecordForm`, `recordFormToProperties`, `RecordKind`, `RecordFormValues`, `RecordField`.
- `monday-app/src/worker-client.ts` — `createContact`/`createCompany` (extend their args here), `getContactSchema`/`getCompanySchema`, `newIdempotencyKey`, `CreateResult`, `EnumProp`.

**Commands** (from `monday-app/`): tests `npx vitest run`; build `npm run build`; deploy `"/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`.

**Commit trailer** (every commit): end the body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT `git push`; do NOT commit `docs/`.

---

### Task 1: `lib/assoc.ts` — the shared Assoc model + a pending-create builder

**Files:**
- Create: `monday-app/src/lib/assoc.ts`
- Test: `monday-app/src/lib/assoc.test.ts`
- Modify: `monday-app/src/views/AssociationPicker.tsx` (import `Assoc` from the lib; re-export for back-compat)
- Modify: `monday-app/src/views/DealDrawer.tsx` (import `Assoc` from the lib)

- [ ] **Step 1: Write the failing test**

```ts
// monday-app/src/lib/assoc.test.ts
import { describe, it, expect } from "vitest";
import { buildCreateAssoc, isPendingCreate } from "./assoc";

describe("buildCreateAssoc", () => {
  it("stages a contact create with a name label + trimmed properties", () => {
    const a = buildCreateAssoc("contact", { firstname: " Ada ", lastname: "Lovelace", email: "a@b.co", bogus: "x" }, "key-1");
    expect(a.label).toBe("Ada Lovelace");
    expect(a.create).toEqual({ key: "key-1", properties: { firstname: "Ada", lastname: "Lovelace", email: "a@b.co" } });
    expect(a.hubspotId).toBeUndefined();
    expect(a.itemId).toBeUndefined();
  });
  it("labels a company by name, falling back to domain", () => {
    expect(buildCreateAssoc("company", { name: "Acme" }, "k").label).toBe("Acme");
    expect(buildCreateAssoc("company", { domain: "acme.com" }, "k").label).toBe("acme.com");
  });
  it("falls back to a generic label when nothing is filled", () => {
    expect(buildCreateAssoc("contact", {}, "k").label).toBe("New contact");
  });
});

describe("isPendingCreate", () => {
  it("is true only for an unresolved create", () => {
    expect(isPendingCreate({ label: "x", create: { key: "k", properties: {} } })).toBe(true);
    expect(isPendingCreate({ label: "x", create: { key: "k", properties: {} }, hubspotId: "9" })).toBe(false);
    expect(isPendingCreate({ label: "x", hubspotId: "9" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run src/lib/assoc.test.ts`
Expected: FAIL — cannot find module `./assoc`.

- [ ] **Step 3: Write `monday-app/src/lib/assoc.ts`**

```ts
import { recordFormToProperties, type RecordKind, type RecordFormValues } from "./record-form";

/** A staged deal↔record (or record↔record) link. Existing records carry a hubspotId; a NEW record staged
 * for create-on-save carries a `create` payload instead. `itemId` (the monday card) is filled on resolve. */
export interface Assoc {
  label: string;
  hubspotId?: string;
  itemId?: string;
  create?: { properties: Record<string, string>; key: string }; // pending create-on-save (Phase A endpoint)
}

/** A staged create that hasn't been turned into a real record yet. */
export function isPendingCreate(a: Assoc): boolean { return !!a.create && !a.hubspotId; }

/** Build a pending-create Assoc from a filled record form + a stable idempotency key. */
export function buildCreateAssoc(kind: RecordKind, values: RecordFormValues, key: string): Assoc {
  const properties = recordFormToProperties(kind, values);
  const label = kind === "contact"
    ? ([values.firstname, values.lastname].map(s => s?.trim()).filter(Boolean).join(" ") || values.email?.trim() || "New contact")
    : (values.name?.trim() || values.domain?.trim() || "New company");
  return { label, create: { key, properties } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run src/lib/assoc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Point AssociationPicker + DealDrawer at the shared type.**

In `monday-app/src/views/AssociationPicker.tsx`, find:
```ts
/** A staged link to an existing HubSpot contact/company (resolved to a monday card on Save). */
export interface Assoc { hubspotId: string; itemId?: string; label: string }
```
Replace it with a LOCAL import + re-export (a bare `export type { … } from` re-export does NOT put `Assoc` in local scope, and this file uses `Assoc` in its Props and `remove()`):
```ts
import type { Assoc } from "../lib/assoc";
export type { Assoc };
```

In `monday-app/src/views/DealDrawer.tsx`, find:
```ts
import AssociationPicker, { type Assoc } from "./AssociationPicker";
```
Replace with:
```ts
import AssociationPicker from "./AssociationPicker";
import type { Assoc } from "../lib/assoc";
```

Also, because `Assoc.hubspotId` is now optional, patch the two existing calls in `resolveAssocs` so they still type-check (Task 5 rewrites this function fully; this keeps THIS task building). Find:
```ts
      const itemId = kind === "contacts"
        ? await findOrCreateContact(a.hubspotId, a.label)
        : await findOrCreateCompany(a.hubspotId, a.label);
```
Replace with:
```ts
      const itemId = kind === "contacts"
        ? await findOrCreateContact(a.hubspotId!, a.label)
        : await findOrCreateCompany(a.hubspotId!, a.label);
```

- [ ] **Step 6: Build to confirm nothing broke**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: tsc clean; vite build succeeds. (The old `Assoc.hubspotId` was required; it is now optional — existing code that reads `a.hubspotId` still compiles. `AssociationPicker.add` sets `hubspotId`, so existing links are unaffected.)

- [ ] **Step 7: Commit**

```bash
git add monday-app/src/lib/assoc.ts monday-app/src/lib/assoc.test.ts monday-app/src/views/AssociationPicker.tsx monday-app/src/views/DealDrawer.tsx
git commit -m "feat(monday-app): shared Assoc model + buildCreateAssoc (pending create-on-save)"
```

---

### Task 2: `RecordForm` — extract the reusable record-form body

**Files:**
- Create: `monday-app/src/views/RecordForm.tsx`
- Modify: `monday-app/src/views/RecordDrawer.tsx` (use RecordForm; drop the inlined form rendering)

- [ ] **Step 1: Create `monday-app/src/views/RecordForm.tsx`** (moves the grouped-field rendering + enum label/value round-trip out of RecordDrawer, verbatim):

```tsx
import { Field, SelectStr } from "./FormFields";
import { fieldsFor, type RecordKind, type RecordFormValues, type RecordField } from "../lib/record-form";
import type { EnumProp } from "../worker-client";

interface Props {
  kind: RecordKind;
  values: RecordFormValues;
  schema: Record<string, EnumProp>;
  validation: { errors: Record<string, string>; warnings: Record<string, string> };
  onChange: (prop: string, val: string) => void;
}

/** Group the fields in declaration order, preserving first-seen group order. */
function grouped(fields: RecordField[]): { group: string; fields: RecordField[] }[] {
  const out: { group: string; fields: RecordField[] }[] = [];
  for (const f of fields) {
    let g = out.find(x => x.group === f.group);
    if (!g) { g = { group: f.group, fields: [] }; out.push(g); }
    g.fields.push(f);
  }
  return out;
}

/** The grouped Contact/Company create form body (no drawer chrome, no submit) — reused standalone, in the
 * deal's "+ New" panel, and in the nested-association panel. */
export default function RecordForm({ kind, values, schema, validation, onChange }: Props) {
  const groups = grouped(fieldsFor(kind));
  const field = (f: RecordField) => {
    const opts = schema[f.prop]?.options ?? [];
    return (
      <Field key={f.prop} label={f.label} required={f.required}>
        {f.type === "enum" ? (
          <SelectStr options={opts.map(o => o.label)} value={optLabel(opts, values[f.prop])}
            onChange={lbl => onChange(f.prop, optValue(opts, lbl))} placeholder="—" />
        ) : f.type === "textarea" ? (
          <textarea className="dc-field-input" rows={2} value={values[f.prop] ?? ""} onChange={e => onChange(f.prop, e.target.value)} />
        ) : (
          <input className="dc-field-input" type={f.type === "email" ? "email" : "text"}
            inputMode={f.type === "number" ? "decimal" : undefined}
            value={values[f.prop] ?? ""} onChange={e => onChange(f.prop, e.target.value)} />
        )}
        {validation.errors[f.prop] && <div className="dc-err">{validation.errors[f.prop]}</div>}
        {!validation.errors[f.prop] && validation.warnings[f.prop] && <div className="dc-mut" style={{ marginTop: 4 }}>{validation.warnings[f.prop]}</div>}
      </Field>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {groups.map(g => (
        <div key={g.group} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="dc-section-title">{g.group}</div>
          <div className="dc-grid">{g.fields.map(field)}</div>
        </div>
      ))}
    </div>
  );
}

// Enum columns store the HubSpot value but the picker shows labels; translate both ways via the schema.
function optLabel(opts: EnumProp["options"], value?: string): string | undefined {
  return opts.find(o => o.value === value)?.label ?? value;
}
function optValue(opts: EnumProp["options"], label?: string): string {
  return opts.find(o => o.label === label)?.value ?? label ?? "";
}
```

- [ ] **Step 2: Refactor `RecordDrawer.tsx` to use `RecordForm`.**

(a) Replace the imports at the top. Find:
```tsx
import { Field, SelectStr } from "./FormFields";
import { fieldsFor, validateRecordForm, recordFormToProperties, type RecordKind, type RecordFormValues, type RecordField } from "../lib/record-form";
```
with (drop `Field`/`SelectStr`, `fieldsFor`, and `RecordField` — all now used only inside RecordForm; `noUnusedLocals` is on):
```tsx
import RecordForm from "./RecordForm";
import { validateRecordForm, recordFormToProperties, type RecordKind, type RecordFormValues } from "../lib/record-form";
```

(b) Delete the now-moved helpers from RecordDrawer: remove the `grouped(...)` function, the `const groups = grouped(fieldsFor(kind));` line, the `const field = (f: RecordField) => { ... };` block, and the two `optLabel`/`optValue` functions at the bottom of the file.

(c) Replace the form-phase JSX. Find:
```tsx
      {!submitted ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {groups.map(g => (
            <div key={g.group} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="dc-section-title">{g.group}</div>
              <div className="dc-grid">{g.fields.map(field)}</div>
            </div>
          ))}
        </div>
      ) : (
```
with:
```tsx
      {!submitted ? (
        <RecordForm kind={kind} values={values} schema={schema} validation={v} onChange={set} />
      ) : (
```

- [ ] **Step 3: Build**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: tsc clean; vite build succeeds. (`RecordField` is no longer referenced in RecordDrawer — its import was dropped in step 2a.)

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/views/RecordForm.tsx monday-app/src/views/RecordDrawer.tsx
git commit -m "refactor(monday-app): extract reusable RecordForm from RecordDrawer"
```

---

### Task 3: worker-client — createContact/createCompany accept association ids

**Files:**
- Modify: `monday-app/src/worker-client.ts`

- [ ] **Step 1: Extend the two create signatures.** Find:
```ts
export function createContact(token: string, args: { idempotencyKey: string; properties: Record<string, string> }): Promise<CreateResult> {
  return postCreate(token, "contact", args);
}
export function createCompany(token: string, args: { idempotencyKey: string; properties: Record<string, string> }): Promise<CreateResult> {
  return postCreate(token, "company", args);
}
```
Replace with (the Phase A endpoint already reads these optional fields):
```ts
export function createContact(token: string, args: { idempotencyKey: string; properties: Record<string, string>; associateCompanyHubspotId?: string }): Promise<CreateResult> {
  return postCreate(token, "contact", args);
}
export function createCompany(token: string, args: { idempotencyKey: string; properties: Record<string, string>; associateContactHubspotIds?: string[] }): Promise<CreateResult> {
  return postCreate(token, "company", args);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/worker-client.ts
git commit -m "feat(monday-app): createContact/createCompany accept association ids"
```

---

### Task 4: `AssociationSection` — search-existing + "+ New" (create-on-save)

**Files:**
- Create: `monday-app/src/views/AssociationSection.tsx`

Wraps `AssociationPicker` (search + stage existing = the live name-match search) and adds a "+ New" panel that stages a pending-create `Assoc` via `RecordForm`. `single` mode (for a Contact's one Company) keeps at most one staged link.

- [ ] **Step 1: Create `monday-app/src/views/AssociationSection.tsx`**

```tsx
import { useState } from "react";
import AssociationPicker from "./AssociationPicker";
import RecordForm from "./RecordForm";
import { buildCreateAssoc, type Assoc } from "../lib/assoc";
import { validateRecordForm, type RecordKind, type RecordFormValues } from "../lib/record-form";
import { newIdempotencyKey, type EnumProp } from "../worker-client";

interface Props {
  kind: RecordKind;              // "contact" | "company" (the record being linked/created)
  token: string;
  schema: Record<string, EnumProp>;
  value: Assoc[];
  onChange: (next: Assoc[]) => void;
  single?: boolean;              // keep at most one link (e.g. a Contact's Company)
}

const PLURAL: Record<RecordKind, "contacts" | "companies"> = { contact: "contacts", company: "companies" };

/** Search + stage an existing record, or stage a brand-new one (created on the parent's Save). */
export default function AssociationSection({ kind, token, schema, value, onChange, single }: Props) {
  const [creating, setCreating] = useState(false);
  const [values, setValues] = useState<RecordFormValues>({});
  const v = validateRecordForm(kind, values);

  function addNew() {
    if (!v.ok) return;
    const dedupKey = kind === "contact" ? values.email : values.domain;
    if (!dedupKey?.trim() && !window.confirm(
      `No ${kind === "contact" ? "email" : "domain"} — a duplicate can't be detected automatically. Add this new ${kind} anyway?`)) return;
    const staged = buildCreateAssoc(kind, values, newIdempotencyKey());
    onChange(single ? [staged] : [...value, staged]);
    setValues({}); setCreating(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <AssociationPicker kind={PLURAL[kind]} token={token} value={value} onChange={onChange} single={single} />
      {!creating ? (
        <button type="button" className="dc-btn dc-btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setCreating(true)}>
          ＋ New {kind}
        </button>
      ) : (
        <div className="dc-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="dc-section-title">New {kind}</div>
          <RecordForm kind={kind} values={values} schema={schema} validation={v} onChange={(p, val) => setValues(s => ({ ...s, [p]: val }))} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="dc-btn dc-btn-sm" onClick={() => { setValues({}); setCreating(false); }}>Cancel</button>
            <button type="button" className="dc-btn dc-btn-sm dc-btn-primary" disabled={!v.ok} onClick={addNew}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add `single` support to `AssociationPicker`.** In `monday-app/src/views/AssociationPicker.tsx`, extend the props interface. Find:
```ts
interface Props {
  kind: "contacts" | "companies"; token: string;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
}
```
Replace with:
```ts
interface Props {
  kind: "contacts" | "companies"; token: string;
  value: Assoc[]; onChange: (next: Assoc[]) => void;
  single?: boolean;   // keep at most one staged link
}
```
Then find the component signature `export default function AssociationPicker({ kind, token, value, onChange }: Props) {` and add `single` to the destructure: `export default function AssociationPicker({ kind, token, value, onChange, single }: Props) {`. Finally, in the `add` function, find:
```ts
  function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    onChange([...value, { hubspotId: hit.id, label: hit.name }]);
    clear(); setText("");
  }
```
Replace with:
```ts
  function add(hit: Hit) {
    if (value.some(v => v.hubspotId === hit.id)) return;
    const link = { hubspotId: hit.id, label: hit.name };
    onChange(single ? [link] : [...value, link]);
    clear(); setText("");
  }
```

- [ ] **Step 3: Build**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: tsc clean; vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/views/AssociationSection.tsx monday-app/src/views/AssociationPicker.tsx
git commit -m "feat(monday-app): AssociationSection (search-existing + '+ New' create-on-save)"
```

---

### Task 5: Deal → Associations uses AssociationSection; save creates pending records

**Files:**
- Modify: `monday-app/src/views/DealDrawer.tsx`

- [ ] **Step 1: Import the create calls + schema fetch.** Extend the existing worker-client import in DealDrawer. Find:
```ts
import { deleteHubspotAssociation, getDealLineItems } from "../worker-client";
```
Replace with:
```ts
import { deleteHubspotAssociation, getDealLineItems, createContact, createCompany, getContactSchema, getCompanySchema, type EnumProp } from "../worker-client";
```
Add a new import for the section component near the AssociationPicker import:
```ts
import AssociationSection from "./AssociationSection";
```

- [ ] **Step 2: Fetch the contact/company enum schemas (for the "+ New" forms).** Add this state + effect next to the other `useState` hooks (e.g. right after `const [dirty, setDirty] = useState(false);`):
```ts
  const [contactSchema, setContactSchema] = useState<Record<string, EnumProp>>({});
  const [companySchema, setCompanySchema] = useState<Record<string, EnumProp>>({});
  useEffect(() => {
    let alive = true;
    getContactSchema(board.sessionToken).then(s => { if (alive) setContactSchema(s); }).catch(() => {});
    getCompanySchema(board.sessionToken).then(s => { if (alive) setCompanySchema(s); }).catch(() => {});
    return () => { alive = false; };
  }, [board.sessionToken]);
```

- [ ] **Step 3: Resolve pending creates in `resolveAssocs`.** Find:
```ts
  async function resolveAssocs(list: Assoc[], kind: "contacts" | "companies"): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      const itemId = kind === "contacts"
        ? await findOrCreateContact(a.hubspotId, a.label)
        : await findOrCreateCompany(a.hubspotId, a.label);
      out.push({ ...a, itemId });
    }
    return out;
  }
```
Replace with:
```ts
  async function resolveAssocs(list: Assoc[], kind: "contacts" | "companies"): Promise<Assoc[]> {
    const out: Assoc[] = [];
    for (const a of list) {
      if (a.itemId) { out.push(a); continue; }
      if (a.create) {
        // Pending "+ New" record: create/reuse it in HubSpot + monday now (on deal Save), keyed so a retry
        // resumes instead of duplicating. The record's monday card comes back from the Worker.
        const r = kind === "contacts"
          ? await createContact(board.sessionToken, { idempotencyKey: a.create.key, properties: a.create.properties })
          : await createCompany(board.sessionToken, { idempotencyKey: a.create.key, properties: a.create.properties });
        if (!r.hubspotId || !r.mondayItemId) throw new Error(`Couldn't create the new ${kind === "contacts" ? "contact" : "company"}`);
        out.push({ label: a.label, hubspotId: r.hubspotId, itemId: r.mondayItemId });
        continue;
      }
      const itemId = kind === "contacts"
        ? await findOrCreateContact(a.hubspotId!, a.label)
        : await findOrCreateCompany(a.hubspotId!, a.label);
      out.push({ ...a, itemId });
    }
    return out;
  }
```

- [ ] **Step 4: Swap the two pickers for sections in the Associations tab.** Find:
```tsx
          {tab === "associations" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <AssociationPicker kind="contacts" token={board.sessionToken} value={contacts} onChange={next => { setDirty(true); setContacts(next); }} />
              <AssociationPicker kind="companies" token={board.sessionToken} value={companies} onChange={next => { setDirty(true); setCompanies(next); }} />
            </div>
          )}
```
Replace with:
```tsx
          {tab === "associations" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <AssociationSection kind="contact" token={board.sessionToken} schema={contactSchema} value={contacts} onChange={next => { setDirty(true); setContacts(next); }} />
              <AssociationSection kind="company" token={board.sessionToken} schema={companySchema} value={companies} onChange={next => { setDirty(true); setCompanies(next); }} />
            </div>
          )}
```
(The `AssociationPicker` import is now unused in DealDrawer — remove the line `import AssociationPicker from "./AssociationPicker";` added in Task 1 Step 5.)

- [ ] **Step 5: Build**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: tsc clean; vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add monday-app/src/views/DealDrawer.tsx
git commit -m "feat(monday-app): Deal > Associations '+ New' contact/company, created on deal save"
```

---

### Task 6: Standalone RecordDrawer — optional nested association (link or create)

**Files:**
- Modify: `monday-app/src/views/RecordDrawer.tsx`

A standalone Contact may link/create ONE Company; a standalone Company may link/create Contacts. Resolved on submit (nested pending-create is created first, then its id is passed to the main create).

- [ ] **Step 1: Import the nested pieces.** Add to RecordDrawer's imports:
```ts
import AssociationSection from "./AssociationSection";
import type { Assoc } from "../lib/assoc";
```
Extend the worker-client import (add the other kind's create + both schemas). Find:
```ts
import {
  createContact, createCompany, getContactSchema, getCompanySchema, newIdempotencyKey,
  type CreateResult, type EnumProp,
} from "../worker-client";
```
(That already imports both creates + both schemas — no change needed. Confirm it is present.)

- [ ] **Step 2: Track the nested association + its schema.** The nested kind is the OTHER kind. Add near the other `useState` hooks:
```ts
  const nestedKind: RecordKind = kind === "contact" ? "company" : "contact";
  const [assoc, setAssoc] = useState<Assoc[]>([]);
  const [nestedSchema, setNestedSchema] = useState<Record<string, EnumProp>>({});
```
Extend the existing schema-loading effect so it also loads the nested schema. Find:
```ts
  useEffect(() => {
    let alive = true;
    const load = kind === "contact" ? getContactSchema : getCompanySchema;
    load(board.sessionToken).then(s => { if (alive) setSchema(s); }).catch(() => { /* form still works without enum options */ });
    return () => { alive = false; };
  }, [kind, board.sessionToken]);
```
Replace with:
```ts
  useEffect(() => {
    let alive = true;
    const load = kind === "contact" ? getContactSchema : getCompanySchema;
    const loadNested = nestedKind === "contact" ? getContactSchema : getCompanySchema;
    load(board.sessionToken).then(s => { if (alive) setSchema(s); }).catch(() => { /* form still works without enum options */ });
    loadNested(board.sessionToken).then(s => { if (alive) setNestedSchema(s); }).catch(() => {});
    return () => { alive = false; };
  }, [kind, nestedKind, board.sessionToken]);
```

- [ ] **Step 3: Resolve the nested association to HubSpot ids inside `submit`, before the main create.** Find the body of `submit` from `const properties = ...` through the create call:
```ts
      const properties = recordFormToProperties(kind, values);
      const args = { idempotencyKey: keyRef.current, properties };
      const r = kind === "contact" ? await createContact(board.sessionToken, args) : await createCompany(board.sessionToken, args);
```
Replace with:
```ts
      const properties = recordFormToProperties(kind, values);
      // Resolve any linked/new related records to HubSpot ids first (a staged "+ New" is created here,
      // keyed so a retry resumes). Then the main create carries the association ids.
      const relatedIds: string[] = [];
      for (const a of assoc) {
        if (a.hubspotId) { relatedIds.push(a.hubspotId); continue; }
        if (a.create) {
          const rr = nestedKind === "contact"
            ? await createContact(board.sessionToken, { idempotencyKey: a.create.key, properties: a.create.properties })
            : await createCompany(board.sessionToken, { idempotencyKey: a.create.key, properties: a.create.properties });
          if (!rr.hubspotId) throw new Error(`Couldn't create the linked ${nestedKind}`);
          relatedIds.push(rr.hubspotId);
        }
      }
      const args = kind === "contact"
        ? { idempotencyKey: keyRef.current, properties, associateCompanyHubspotId: relatedIds[0] }
        : { idempotencyKey: keyRef.current, properties, associateContactHubspotIds: relatedIds };
      const r = kind === "contact" ? await createContact(board.sessionToken, args) : await createCompany(board.sessionToken, args);
```

- [ ] **Step 4: Mark dirty when the nested association changes + include it in the form-phase UI.** In the form-phase JSX, find:
```tsx
      {!submitted ? (
        <RecordForm kind={kind} values={values} schema={schema} validation={v} onChange={set} />
      ) : (
```
Replace with:
```tsx
      {!submitted ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <RecordForm kind={kind} values={values} schema={schema} validation={v} onChange={set} />
          <div>
            <div className="dc-section-title">{kind === "contact" ? "Company (optional)" : "Contacts (optional)"}</div>
            <AssociationSection kind={nestedKind} token={board.sessionToken} schema={nestedSchema}
              value={assoc} onChange={next => { setDirty(true); setAssoc(next); }} single={kind === "contact"} />
          </div>
        </div>
      ) : (
```

- [ ] **Step 5: Build**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: tsc clean; vite build succeeds. (`RecordKind` must be imported in RecordDrawer — it already is, via the record-form import; confirm.)

- [ ] **Step 6: Commit**

```bash
git add monday-app/src/views/RecordDrawer.tsx
git commit -m "feat(monday-app): standalone drawer optional nested association (link or create)"
```

---

### Task 7: Full green gate, deploy, and manual verification

**Files:** none (verification + deploy)

- [ ] **Step 1: Full green gate**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run && npm run build`
Expected: all tests pass (existing + assoc 4); tsc clean; vite build succeeds.

- [ ] **Step 2: Deploy the app**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`
Expected: "Your project is live at …" with a new source id.

- [ ] **Step 3: Manual verification in the Board View app**
  1. **Contextual — search still works:** open/create a Deal → Associations → the Contacts and Companies pickers still search live HubSpot and stage existing links.
  2. **Contextual — + New:** click **＋ New contact**, fill first name + a fresh email, **Add** → it appears as a staged chip; **Cancel the deal** → confirm NOTHING was created in HubSpot/monday. Reopen, add again, **Save the deal** → the new contact is created on board `5029639630`, linked to the deal (deal's Associated Contact), and the HubSpot deal↔contact association appears after the background sync.
  3. **Contextual — dedup:** + New contact with an **existing email** → the deal save reuses the existing contact (no duplicate).
  4. **Contextual — no email:** + New contact with no email → the "add anyway?" confirm appears.
  5. **Standalone nested — link:** ＋ New Company (header) → in "Contacts (optional)" search + link an existing contact → Save → the company is created and associated to that contact in HubSpot.
  6. **Standalone nested — create:** ＋ New Contact (header) → in "Company (optional)" click ＋ New company, fill a name/domain, Add → Save → both are created and associated.
  7. **Idempotency:** double-click Save / a mid-flight retry creates no duplicates (each staged create has its own key).
  8. Clean up all test records.

- [ ] **Step 4: Record results** in memory `deal-cockpit-app.md` (v3.4-Phase-C entry: app source id, what shipped, verification). Do NOT commit spec/plan docs.

---

## Notes for the implementer
- **Cancel creates nothing** is structural: a "+ New" only stages an `Assoc` with a `create` payload; the HubSpot/monday record is created solely inside `resolveAssocs` (deal) / `submit` (standalone), both reached only on Save.
- Each staged create carries its OWN idempotency key (from `newIdempotencyKey()` at stage time), stable across deal-save retries → resume, never duplicate.
- The live picker sitting next to "+ New" **is** the spec's name-match search (full-text search finds existing records by name); the no-dedup-key path keeps the explicit confirm.
- Do not change the deal create/edit column-write or line-item flows — Phase C only extends `resolveAssocs` and the Associations tab.
- Nested is intentionally **one level**: the nested "+ New" form has no further nested association (AssociationSection is only rendered by DealDrawer and RecordDrawer, never by itself).
