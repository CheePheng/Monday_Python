# Deal Cockpit v3.4 Phase B — Standalone Creation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a rep create a HubSpot Contact or Company standalone from the Deal Cockpit — header actions (＋ New Deal / ＋ New Contact / ＋ New Company, collapsing to a ＋ Create dropdown on narrow screens) open a right-side drawer with a full-parity form (live enum options), a stepwise progress UI with retry-only-the-failed-step, and Open-in-monday / Open-in-HubSpot links — all wired to the Phase A endpoints.

**Architecture:** A shared `DrawerShell` supplies the drawer chrome; a focused `RecordDrawer` renders the Contact/Company create form (reusing the existing `FormFields` components + design-system classes) and drives the create via the Phase A `POST /app/contact` / `POST /app/company` endpoints, keyed by one client UUID reused across retries. All decision logic (form fields/validation, form→properties, the result→progress mapping) lives in **pure, unit-tested** libs; the React components are verified by `tsc` + `vite build` (the app suite is vitest over pure libs, matching the existing convention).

**Tech Stack:** React 18 + TypeScript + Vite + vitest; monday-sdk-js; the Cloudflare Worker `/app/*` API.

**Spec:** `docs/superpowers/specs/2026-07-21-deal-cockpit-v3.4-contact-company-creation.md` (Component 4). Associations (nested create + contextual-in-deal) are **Phase C** and out of scope here.

**Reference — existing pieces reused (do not reinvent):**
- `monday-app/src/views/FormFields.tsx` — `Field`, `SelectStr`, `SelectOpt`, `ChipMulti`, `Opt`.
- `monday-app/src/worker-client.ts` — `call()` helper, `EnumProp` type, existing schema/create patterns (`getLineItemSchema`, `createHubspotLineItem`).
- `monday-app/src/lib/line-item-form.ts` — the field-descriptor + `validate*` pattern to mirror.
- `monday-app/src/board-config.ts` — `WORKER_BASE`, `HUBSPOT_PORTAL_ID`, board ids.
- `monday-app/src/monday-client.ts` — `openLink()` (external URL). Add `openItemCard()` for monday deep-open.
- Phase A endpoints return a `CreateResult`: `{ status, failedStep?, hubspotId?, mondayItemId?, existing?, unassigned?, ownerMessage?, hubspotLink?, steps:{dedup,hubspot,monday,owner,associations} }`. 200 = completed; 502 = failed but the body still carries the partial `CreateResult` (with `failedStep`).

**Commands:** all from `monday-app/`. Tests `npx vitest run`; typecheck+build `npm run build` (runs `tsc --noEmit && vite build`); deploy `"/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`.

**Commit trailer** (every commit): end the message body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT `git push`; do NOT commit anything under `docs/`.

---

### Task 1: worker-client — schema fetch + create calls + idempotency key

**Files:**
- Modify: `monday-app/src/worker-client.ts`

I/O module (no unit test — matches the existing search/create functions). Verified by `tsc` in Task 2's build and used by Task 6.

- [ ] **Step 1: Append to `monday-app/src/worker-client.ts`**

```ts
// --- v3.4: standalone Contact/Company creation (Phase A endpoints) ---

/** Mirrors the Worker's CreateResult (worker/src/idempotency.ts). 200 => completed; 502 => failed + partial. */
export interface CreateResult {
  status: "in_progress" | "completed" | "failed";
  failedStep?: "dedup" | "hubspot" | "monday" | "owner" | "associations";
  hubspotId?: string; mondayItemId?: string; existing?: boolean;
  unassigned?: boolean; ownerMessage?: string; hubspotLink?: string;
  steps: { dedup: boolean; hubspot: boolean; monday: boolean; owner: boolean; associations: boolean };
}

/** One key per Create operation, reused across every retry so the Worker's Durable Object resumes. */
export function newIdempotencyKey(): string { return crypto.randomUUID(); }

async function postCreate(token: string, kind: "contact" | "company", body: unknown): Promise<CreateResult> {
  const res = await fetch(WORKER_BASE + `/app/${kind}`, {
    method: "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  // Completed (200) and failed-with-partial (502) both carry a CreateResult; anything else is a hard error.
  if ((res.ok || res.status === 502) && json && typeof json === "object" && "status" in json) return json as CreateResult;
  throw new Error((json && (json as any).error) || `create-${kind} failed (${res.status})`);
}

export function createContact(token: string, args: { idempotencyKey: string; properties: Record<string, string> }): Promise<CreateResult> {
  return postCreate(token, "contact", args);
}
export function createCompany(token: string, args: { idempotencyKey: string; properties: Record<string, string> }): Promise<CreateResult> {
  return postCreate(token, "company", args);
}
export async function getContactSchema(token: string): Promise<Record<string, EnumProp>> {
  const res = await call(token, "GET", "/app/contact-schema");
  return res?.schema ?? {};
}
export async function getCompanySchema(token: string): Promise<Record<string, EnumProp>> {
  const res = await call(token, "GET", "/app/company-schema");
  return res?.schema ?? {};
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/worker-client.ts
git commit -m "feat(monday-app): worker-client createContact/createCompany + contact/company schema + idempotency key"
```

---

### Task 2: `record-form` — Contact/Company field descriptors + validation + form→properties

**Files:**
- Create: `monday-app/src/lib/record-form.ts`
- Test: `monday-app/src/lib/record-form.test.ts`

Field names are the Phase A allowlists exactly (`worker/src/contact-company-props.ts`). Owner/sales_user are NOT form fields — the Worker sets them from the acting rep.

- [ ] **Step 1: Write the failing test**

```ts
// monday-app/src/lib/record-form.test.ts
import { describe, it, expect } from "vitest";
import { fieldsFor, validateRecordForm, recordFormToProperties } from "./record-form";

describe("fieldsFor", () => {
  it("contact requires firstname; company requires name", () => {
    expect(fieldsFor("contact").find(f => f.required)?.prop).toBe("firstname");
    expect(fieldsFor("company").find(f => f.required)?.prop).toBe("name");
  });
});

describe("validateRecordForm", () => {
  it("requires the name field", () => {
    expect(validateRecordForm("contact", {}).ok).toBe(false);
    expect(validateRecordForm("contact", { firstname: "Ada" }).ok).toBe(true);
    expect(validateRecordForm("company", { name: "Acme" }).ok).toBe(true);
  });
  it("rejects a malformed email", () => {
    expect(validateRecordForm("contact", { firstname: "Ada", email: "nope" }).errors.email).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).errors.email).toBeUndefined();
  });
  it("warns (not errors) when the dedup key is missing", () => {
    expect(validateRecordForm("contact", { firstname: "Ada" }).warnings.email).toBeTruthy();
    expect(validateRecordForm("company", { name: "Acme" }).warnings.domain).toBeTruthy();
    expect(validateRecordForm("contact", { firstname: "Ada", email: "a@b.co" }).warnings.email).toBeUndefined();
  });
});

describe("recordFormToProperties", () => {
  it("keeps only non-empty, trimmed fields that belong to the kind", () => {
    expect(recordFormToProperties("contact", { firstname: " Ada ", email: "", jobtitle: "CTO", bogus: "x" }))
      .toEqual({ firstname: "Ada", jobtitle: "CTO" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run src/lib/record-form.test.ts`
Expected: FAIL — cannot find module `./record-form`.

- [ ] **Step 3: Write the implementation**

```ts
// monday-app/src/lib/record-form.ts
// Standalone Contact/Company create forms. Field names mirror the Phase A server allowlists exactly
// (worker/src/contact-company-props.ts). Owner / sales_user are NOT fields — the Worker sets them from
// the acting rep (session token). Enum options are loaded live from /app/{contact,company}-schema.

export type RecordFieldType = "text" | "textarea" | "email" | "number" | "enum";
export interface RecordField { prop: string; label: string; type: RecordFieldType; group: string; required?: boolean; recommended?: boolean }

export const CONTACT_FIELDS: RecordField[] = [
  { prop: "firstname", label: "First name", type: "text", group: "Identity", required: true },
  { prop: "lastname", label: "Last name", type: "text", group: "Identity" },
  { prop: "email", label: "Email", type: "email", group: "Identity", recommended: true },
  { prop: "phone", label: "Phone", type: "text", group: "Identity" },
  { prop: "jobtitle", label: "Job title", type: "text", group: "Work" },
  { prop: "company", label: "Company", type: "text", group: "Work" },
  { prop: "hs_lead_status", label: "Lead status", type: "enum", group: "Work" },
  { prop: "leadsource", label: "Lead source", type: "enum", group: "Work" },
  { prop: "manufacturer__c", label: "Vendor", type: "enum", group: "Work" },
];

export const COMPANY_FIELDS: RecordField[] = [
  { prop: "name", label: "Company name", type: "text", group: "Identity", required: true },
  { prop: "domain", label: "Domain", type: "text", group: "Identity", recommended: true },
  { prop: "industry", label: "Industry", type: "enum", group: "Identity" },
  { prop: "type", label: "Type", type: "enum", group: "Identity" },
  { prop: "partner_with", label: "Partner with", type: "enum", group: "Identity" },
  { prop: "city", label: "City", type: "text", group: "Location" },
  { prop: "state", label: "State", type: "text", group: "Location" },
  { prop: "numberofemployees", label: "Employees", type: "number", group: "Details" },
  { prop: "annualrevenue", label: "Annual revenue", type: "number", group: "Details" },
  { prop: "description", label: "Description", type: "textarea", group: "Details" },
  { prop: "linkedin_company_page", label: "LinkedIn", type: "text", group: "Details" },
];

export type RecordKind = "contact" | "company";
export type RecordFormValues = Record<string, string | undefined>;

export function fieldsFor(kind: RecordKind): RecordField[] { return kind === "contact" ? CONTACT_FIELDS : COMPANY_FIELDS; }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateRecordForm(kind: RecordKind, v: RecordFormValues):
    { ok: boolean; errors: Record<string, string>; warnings: Record<string, string> } {
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  for (const f of fieldsFor(kind)) if (f.required && !v[f.prop]?.trim()) errors[f.prop] = `${f.label} is required`;
  if (kind === "contact" && v.email?.trim() && !EMAIL_RE.test(v.email.trim())) errors.email = "Enter a valid email";
  // Duplicate-risk warnings: email (contact) / domain (company) are the dedup keys.
  if (kind === "contact" && !v.email?.trim()) warnings.email = "No email — duplicates can't be detected reliably. Double-check this isn't already in HubSpot.";
  if (kind === "company" && !v.domain?.trim()) warnings.domain = "No domain — duplicates can't be detected reliably. Double-check this isn't already in HubSpot.";
  return { ok: Object.keys(errors).length === 0, errors, warnings };
}

/** Map the form values to the HubSpot properties object sent to the Worker (trimmed; empties dropped;
 * only fields that belong to this kind). */
export function recordFormToProperties(kind: RecordKind, v: RecordFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fieldsFor(kind)) { const t = v[f.prop]?.trim(); if (t) out[f.prop] = t; }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run src/lib/record-form.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/record-form.ts monday-app/src/lib/record-form.test.ts
git commit -m "feat(monday-app): record-form descriptors + validation + form->properties"
```

---

### Task 3: `create-progress` — result → step-display mapping

**Files:**
- Create: `monday-app/src/lib/create-progress.ts`
- Test: `monday-app/src/lib/create-progress.test.ts`

Pure mapping from a `CreateResult` (or `null` while the request is in flight) to the step list the UI renders.

- [ ] **Step 1: Write the failing test**

```ts
// monday-app/src/lib/create-progress.test.ts
import { describe, it, expect } from "vitest";
import { progressSteps, isComplete, isFailed, CREATE_STEPS } from "./create-progress";

const done = { status: "completed" as const, steps: { dedup: true, hubspot: true, monday: true, owner: true, associations: true } };
const failedAtHubspot = { status: "failed" as const, failedStep: "hubspot" as const, steps: { dedup: true, hubspot: false, monday: false, owner: false, associations: false } };

describe("progressSteps", () => {
  it("null (in-flight) => every step pending", () =>
    expect(progressSteps(null).map(s => s.status)).toEqual(["pending", "pending", "pending", "pending", "pending"]));
  it("completed => every step done", () =>
    expect(progressSteps(done).every(s => s.status === "done")).toBe(true));
  it("failed at hubspot => dedup done, hubspot failed, rest pending", () => {
    const s = progressSteps(failedAtHubspot);
    expect(s.find(x => x.key === "dedup")!.status).toBe("done");
    expect(s.find(x => x.key === "hubspot")!.status).toBe("failed");
    expect(s.find(x => x.key === "monday")!.status).toBe("pending");
  });
  it("labels are in the fixed order", () =>
    expect(CREATE_STEPS.map(s => s.key)).toEqual(["dedup", "hubspot", "monday", "owner", "associations"]));
});

describe("isComplete / isFailed", () => {
  it("read the status", () => {
    expect(isComplete(done)).toBe(true);
    expect(isFailed(failedAtHubspot)).toBe(true);
    expect(isComplete(failedAtHubspot)).toBe(false);
    expect(isComplete(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run src/lib/create-progress.test.ts`
Expected: FAIL — cannot find module `./create-progress`.

- [ ] **Step 3: Write the implementation**

```ts
// monday-app/src/lib/create-progress.ts
// Pure mapping from the Worker's CreateResult to the progress step list the UI renders. The endpoint is a
// single synchronous call, so the client can't observe an individual step "running" mid-flight — while the
// promise is pending the component shows a spinner and passes `null` here (all steps pending). Once the
// result lands, each step is `done` (its flag is true) or, for the one `failedStep`, `failed`.

export const CREATE_STEPS = [
  { key: "dedup", label: "Checking for duplicates" },
  { key: "hubspot", label: "Creating in HubSpot" },
  { key: "monday", label: "Adding to monday board" },
  { key: "owner", label: "Applying owner" },
  { key: "associations", label: "Creating associations" },
] as const;

export type StepKey = (typeof CREATE_STEPS)[number]["key"];
export type StepStatus = "done" | "failed" | "pending";
export interface ProgressStep { key: StepKey; label: string; status: StepStatus }

interface ResultLike { status?: string; failedStep?: string; steps?: Record<string, boolean> }

export function progressSteps(result: ResultLike | null): ProgressStep[] {
  return CREATE_STEPS.map(s => {
    let status: StepStatus = "pending";
    if (result?.steps?.[s.key]) status = "done";
    else if (result?.status === "failed" && result.failedStep === s.key) status = "failed";
    return { key: s.key, label: s.label, status };
  });
}

export function isComplete(result: ResultLike | null): boolean { return result?.status === "completed"; }
export function isFailed(result: ResultLike | null): boolean { return result?.status === "failed"; }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run src/lib/create-progress.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add monday-app/src/lib/create-progress.ts monday-app/src/lib/create-progress.test.ts
git commit -m "feat(monday-app): create-progress result->step mapping"
```

---

### Task 4: `DrawerShell` — reusable drawer chrome

**Files:**
- Create: `monday-app/src/views/DrawerShell.tsx`

The chrome shared by the new record drawer, using the exact same design-system classes as `DealDrawer` (`dc-drawer`, `dc-modal-head`, `dc-drawer-body`, `dc-modal-foot`, `dc-x`). Esc calls `onClose` (the parent supplies a dirty-guarded close).

- [ ] **Step 1: Write the component**

```tsx
// monday-app/src/views/DrawerShell.tsx
import { useEffect } from "react";

interface Props {
  title: string;
  ariaLabel?: string;
  headerRight?: React.ReactNode;   // e.g. an "Open in HubSpot" button
  footer?: React.ReactNode;        // e.g. Cancel + primary buttons
  onClose: () => void;             // dirty-guarded by the parent
  children: React.ReactNode;
}

/** Right-side drawer chrome reused across create/edit surfaces (matches DealDrawer's markup). */
export default function DrawerShell({ title, ariaLabel, headerRight, footer, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dc-drawer" role="dialog" aria-label={ariaLabel ?? title}>
      <div className="dc-modal-head">
        <h2>{title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {headerRight}
          <button className="dc-x" onClick={onClose} aria-label="Close">×</button>
        </div>
      </div>
      <div className="dc-drawer-body">{children}</div>
      {footer && <div className="dc-modal-foot">{footer}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/views/DrawerShell.tsx
git commit -m "feat(monday-app): DrawerShell reusable drawer chrome"
```

---

### Task 5: `CreateProgress` — the step progress UI

**Files:**
- Create: `monday-app/src/views/CreateProgress.tsx`

- [ ] **Step 1: Write the component**

```tsx
// monday-app/src/views/CreateProgress.tsx
import { progressSteps, isComplete, isFailed } from "../lib/create-progress";
import type { CreateResult } from "../worker-client";

interface Props {
  result: CreateResult | null;   // null while the create request is in flight
  inFlight: boolean;
  onRetry: () => void;
  onOpenMonday: () => void;
  onOpenHubspot: () => void;
}

function icon(status: "done" | "failed" | "pending", inFlight: boolean): string {
  if (status === "done") return "✓";
  if (status === "failed") return "⚠";
  return inFlight ? "…" : "•";
}

/** Stepwise create progress. While in flight all steps read pending with a running hint; on the result
 * each step is done / failed. Failed => Retry (re-POST with the same idempotency key). Completed => links. */
export default function CreateProgress({ result, inFlight, onRetry, onOpenMonday, onOpenHubspot }: Props) {
  const steps = progressSteps(result);
  return (
    <div className="dc-progress">
      {steps.map(s => (
        <div key={s.key} className={"dc-progress-step " + s.status}>
          <span className="dc-progress-icon">{icon(s.status, inFlight)}</span>
          <span>{s.label}</span>
        </div>
      ))}
      {result?.existing && <div className="dc-mut" style={{ marginTop: 4 }}>Matched an existing record — reusing it (no duplicate created).</div>}
      {result?.unassigned && result.ownerMessage && <div className="dc-mut" style={{ marginTop: 4 }}>{result.ownerMessage}</div>}
      {isFailed(result) && (
        <div style={{ marginTop: 10 }}>
          <button className="dc-btn dc-btn-sm" onClick={onRetry}>Retry</button>
        </div>
      )}
      {isComplete(result) && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="dc-btn dc-btn-sm" onClick={onOpenMonday}>Open in monday</button>
          {result?.hubspotLink && <button className="dc-btn dc-btn-sm" onClick={onOpenHubspot}>↗ Open in HubSpot</button>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add monday-app/src/views/CreateProgress.tsx
git commit -m "feat(monday-app): CreateProgress step UI"
```

---

### Task 6: `RecordDrawer` — the standalone Contact/Company create drawer

**Files:**
- Create: `monday-app/src/views/RecordDrawer.tsx`
- Modify: `monday-app/src/monday-client.ts` (add `openItemCard`)

- [ ] **Step 1: Add `openItemCard` to `monday-app/src/monday-client.ts`** — directly below the existing `openLink` (around line 26):

```ts
/** Open a monday item card (e.g. a just-created contact/company) from inside the board view. */
export function openItemCard(itemId: string): void { void monday.execute("openItemCard", { itemId }); }
```

- [ ] **Step 2: Write `monday-app/src/views/RecordDrawer.tsx`**

```tsx
// monday-app/src/views/RecordDrawer.tsx
import { useEffect, useRef, useState } from "react";
import type { BoardState } from "../useBoard";
import DrawerShell from "./DrawerShell";
import CreateProgress from "./CreateProgress";
import { Field, SelectStr } from "./FormFields";
import { fieldsFor, validateRecordForm, recordFormToProperties, type RecordKind, type RecordFormValues, type RecordField } from "../lib/record-form";
import { isComplete } from "../lib/create-progress";
import { openLink, openItemCard } from "../monday-client";
import {
  createContact, createCompany, getContactSchema, getCompanySchema, newIdempotencyKey,
  type CreateResult, type EnumProp,
} from "../worker-client";

interface Props { kind: RecordKind; board: BoardState; onClose: () => void; onCreated?: (r: CreateResult) => void; onDirtyChange?: (dirty: boolean) => void }

const TITLE: Record<RecordKind, string> = { contact: "Create Contact", company: "Create Company" };

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

export default function RecordDrawer({ kind, board, onClose, onCreated, onDirtyChange }: Props) {
  const [values, setValues] = useState<RecordFormValues>({});
  const [schema, setSchema] = useState<Record<string, EnumProp>>({});
  const [result, setResult] = useState<CreateResult | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [submitted, setSubmitted] = useState(false); // once true, show progress instead of the form
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // One idempotency key per drawer instance -> every Retry resumes the same server-side create.
  const keyRef = useRef<string>(newIdempotencyKey());
  const savingRef = useRef(false); // synchronous double-submit lock

  const groups = grouped(fieldsFor(kind));
  const v = validateRecordForm(kind, values);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);

  useEffect(() => {
    let alive = true;
    const load = kind === "contact" ? getContactSchema : getCompanySchema;
    load(board.sessionToken).then(s => { if (alive) setSchema(s); }).catch(() => { /* form still works without enum options */ });
    return () => { alive = false; };
  }, [kind, board.sessionToken]);

  const set = (prop: string, val: string) => { setDirty(true); setValues(s => ({ ...s, [prop]: val })); };

  function guardedClose() {
    if (dirty && !isComplete(result) && !confirm("Discard this new " + kind + "?")) return;
    onClose();
  }

  async function submit() {
    if (savingRef.current || !v.ok) return;
    // Duplicate-risk gate (spec): with no dedup key (email/domain) we can't detect an existing record —
    // require an explicit confirm on the FIRST submit (a Retry is a resume, so skip it then).
    const dedupKey = kind === "contact" ? values.email : values.domain;
    if (!submitted && !dedupKey?.trim() && !window.confirm(
      `No ${kind === "contact" ? "email" : "domain"} — a duplicate can't be detected automatically. Create this ${kind} anyway?`)) return;
    savingRef.current = true;
    setSubmitted(true); setInFlight(true); setErr(null);
    try {
      const properties = recordFormToProperties(kind, values);
      const args = { idempotencyKey: keyRef.current, properties };
      const r = kind === "contact" ? await createContact(board.sessionToken, args) : await createCompany(board.sessionToken, args);
      setResult(r);
      if (r.status === "completed") { setDirty(false); onCreated?.(r); }
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally { setInFlight(false); savingRef.current = false; }
  }

  const field = (f: RecordField) => {
    const opts = schema[f.prop]?.options ?? [];
    return (
      <Field key={f.prop} label={f.label} required={f.required}>
        {f.type === "enum" ? (
          <SelectStr options={opts.map(o => o.label)} value={optLabel(opts, values[f.prop])}
            onChange={lbl => set(f.prop, optValue(opts, lbl))} placeholder="—" />
        ) : f.type === "textarea" ? (
          <textarea className="dc-field-input" rows={2} value={values[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        ) : (
          <input className="dc-field-input" type={f.type === "email" ? "email" : "text"}
            inputMode={f.type === "number" ? "decimal" : undefined}
            value={values[f.prop] ?? ""} onChange={e => set(f.prop, e.target.value)} />
        )}
        {v.errors[f.prop] && <div className="dc-err">{v.errors[f.prop]}</div>}
        {!v.errors[f.prop] && v.warnings[f.prop] && <div className="dc-mut" style={{ marginTop: 4 }}>{v.warnings[f.prop]}</div>}
      </Field>
    );
  };

  const footer = submitted ? (
    <button className="dc-btn dc-btn-primary" onClick={guardedClose}>{isComplete(result) ? "Done" : "Close"}</button>
  ) : (
    <>
      <button className="dc-btn" onClick={guardedClose}>Cancel</button>
      <button className="dc-btn dc-btn-primary" disabled={!v.ok || inFlight} onClick={() => void submit()}>
        {inFlight ? "Creating…" : TITLE[kind]}
      </button>
    </>
  );

  return (
    <DrawerShell title={TITLE[kind]} ariaLabel={TITLE[kind]} onClose={guardedClose} footer={footer}>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <CreateProgress result={result} inFlight={inFlight}
            onRetry={() => void submit()}
            onOpenMonday={() => result?.mondayItemId && openItemCard(result.mondayItemId)}
            onOpenHubspot={() => result?.hubspotLink && openLink(result.hubspotLink)} />
          {err && <div className="dc-err">{err}</div>}
        </div>
      )}
    </DrawerShell>
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

- [ ] **Step 3: Typecheck + build**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: `tsc --noEmit` clean; `vite build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/views/RecordDrawer.tsx monday-app/src/monday-client.ts
git commit -m "feat(monday-app): RecordDrawer standalone Contact/Company create + openItemCard"
```

---

### Task 7: `CreateMenu` + styles for the create menu and progress list

**Files:**
- Create: `monday-app/src/views/CreateMenu.tsx`
- Modify: `monday-app/src/styles.css`

- [ ] **Step 1: Write `monday-app/src/views/CreateMenu.tsx`**

```tsx
// monday-app/src/views/CreateMenu.tsx
import { useEffect, useRef, useState } from "react";

interface Props { onNewDeal: () => void; onNewContact: () => void; onNewCompany: () => void }

/** Header creation actions. Wide screens: three inline buttons. Narrow screens (CSS): a single "＋ Create"
 * split button with a dropdown. Creation is an action, never a permanent tab. */
export default function CreateMenu({ onNewDeal, onNewContact, onNewCompany }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div className="dc-create" ref={ref}>
      <div className="dc-create-inline">
        <button className="dc-btn" onClick={onNewCompany}>＋ New Company</button>
        <button className="dc-btn" onClick={onNewContact}>＋ New Contact</button>
        <button className="dc-btn dc-btn-primary" onClick={onNewDeal}>＋ New Deal</button>
      </div>
      <div className="dc-create-compact">
        <button className="dc-btn dc-btn-primary" onClick={() => setOpen(o => !o)}>＋ Create ▾</button>
        {open && (
          <div className="dc-create-dropdown">
            <button className="dc-create-item" onClick={() => pick(onNewDeal)}>New Deal</button>
            <button className="dc-create-item" onClick={() => pick(onNewContact)}>New Contact</button>
            <button className="dc-create-item" onClick={() => pick(onNewCompany)}>New Company</button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append to `monday-app/src/styles.css`**

```css
/* --- v3.4 Phase B: create menu + create progress --- */
.dc-create { position: relative; }
.dc-create-inline { display: flex; gap: 8px; }
.dc-create-compact { display: none; position: relative; }
.dc-create-dropdown {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 40;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.18); padding: 6px; min-width: 180px; display: flex; flex-direction: column;
}
.dc-create-item {
  text-align: left; background: none; border: 0; color: var(--text);
  padding: 9px 10px; border-radius: 7px; font: inherit; cursor: pointer;
}
.dc-create-item:hover { background: var(--surface-hover); }
@media (max-width: 720px) {
  .dc-create-inline { display: none; }
  .dc-create-compact { display: block; }
}

.dc-progress { display: flex; flex-direction: column; gap: 8px; }
.dc-progress-step { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text-mut); }
.dc-progress-step .dc-progress-icon {
  width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; background: var(--surface-hover); color: var(--text-mut); flex-shrink: 0;
}
.dc-progress-step.done { color: var(--text); }
.dc-progress-step.done .dc-progress-icon { background: var(--green-soft); color: var(--green); }
.dc-progress-step.failed { color: var(--red); }
.dc-progress-step.failed .dc-progress-icon { background: var(--red-soft); color: var(--red); }
```

- [ ] **Step 3: Typecheck + build**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add monday-app/src/views/CreateMenu.tsx monday-app/src/styles.css
git commit -m "feat(monday-app): CreateMenu (responsive) + create-menu/progress styles"
```

---

### Task 8: Wire the header + RecordDrawer into `BoardView`

**Files:**
- Modify: `monday-app/src/views/BoardView.tsx`

Keep the deal path (`editing`) untouched; add an independent `creating` state for the record drawer, with a dirty guard so only one drawer is open at a time.

- [ ] **Step 1: Add imports** near the top of `BoardView.tsx` (below the existing `DealDrawer` import):

```ts
import RecordDrawer from "./RecordDrawer";
import CreateMenu from "./CreateMenu";
```

- [ ] **Step 2a: Declare the `creating` state WITH the other `useState` hooks** — it must be in scope before the auto-refresh effect (Step 4) which references it, so declare it right after the `editing` state. Find:

```ts
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
```
Add directly below it:
```ts
  const [creating, setCreating] = useState<null | "contact" | "company">(null);
```

- [ ] **Step 2b: Add `recordDirty` + `openCreate`.** After the line `const drawerDirty = useRef(false);`, add:

```ts
  const recordDirty = useRef(false);
  // Open a standalone create drawer; guard against discarding an open+dirty deal drawer first.
  function openCreate(kind: "contact" | "company") {
    if (editing !== undefined && drawerDirty.current && !window.confirm("Discard unsaved changes?")) return;
    drawerDirty.current = false;
    setEditing(undefined);
    setCreating(kind);
  }
```

- [ ] **Step 3: Guard the record drawer when switching to a deal.** In `attemptOpen`, add a record-dirty guard and clear `creating`. Replace the existing `attemptOpen`:

```ts
  function attemptOpen(id: string | null) {
    if (editing !== undefined && drawerDirty.current && !window.confirm("Discard unsaved changes?")) return;
    if (creating !== null && recordDirty.current && !window.confirm("Discard this new " + creating + "?")) return;
    drawerDirty.current = false;
    recordDirty.current = false;
    setCreating(null);
    setEditing(id);
  }
```

- [ ] **Step 4: Pause auto-refresh while EITHER drawer is open.** Replace the existing effect:

```ts
  useEffect(() => { board.setAutoRefreshPaused(editing !== undefined || creating !== null); }, [editing, creating]);
```

- [ ] **Step 5: Replace the header Create button with `CreateMenu`.** Find:

```tsx
        <button className="dc-btn dc-btn-primary" onClick={() => attemptOpen(null)}>＋ Create deal</button>
```

Replace with:

```tsx
        <CreateMenu onNewDeal={() => attemptOpen(null)} onNewContact={() => openCreate("contact")} onNewCompany={() => openCreate("company")} />
```

- [ ] **Step 6: Render the record drawer.** Find the existing deal-drawer render block:

```tsx
      {editing !== undefined && (
        <DealDrawer key={editing ?? "new"} itemId={editing} board={board}
          onDirtyChange={d => { drawerDirty.current = d; }}
          onClose={() => setEditing(undefined)}
          onSaved={(info) => {
            setEditing(undefined);
            setToast({ text: "Saved to monday", type: "info" });
            void board.finishSave(info);
          }} />
      )}
```

Immediately AFTER it, add:

```tsx
      {creating !== null && (
        <RecordDrawer key={"create-" + creating} kind={creating} board={board}
          onDirtyChange={d => { recordDirty.current = d; }}
          onClose={() => { recordDirty.current = false; setCreating(null); }}
          onCreated={(r) => setToast({ text: `${creating === "contact" ? "Contact" : "Company"} ${r.existing ? "matched" : "created"}`, type: "success" })} />
      )}
```

- [ ] **Step 7: Typecheck + build**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npm run build`
Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add monday-app/src/views/BoardView.tsx
git commit -m "feat(monday-app): header CreateMenu + RecordDrawer wiring (standalone contact/company)"
```

---

### Task 9: Full green gate, deploy, and manual verification

**Files:** none (verification + deploy)

- [ ] **Step 1: Full green gate**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && npx vitest run && npm run build`
Expected: all tests pass (existing + record-form 6 + create-progress 6); `tsc` clean; `vite build` succeeds.

- [ ] **Step 2: Deploy the app to monday**

Run: `cd /c/Users/PC/Downloads/DKM_Project/Monday_Python/monday-app && "/c/Users/PC/AppData/Local/npm-cache/_npx/43bf806144c7ff45/node_modules/.bin/mapps" code:push -c -i 16011075 -f -d ./dist`
Expected: "Your project is live at …" with a new source id.

- [ ] **Step 3: Manual verification in the Board View app** (this is where the Phase A endpoints finally get their real end-to-end test):
  1. Header shows **＋ New Deal / ＋ New Contact / ＋ New Company**; shrinking the panel collapses them into **＋ Create ▾**.
  2. **＋ New Contact** → drawer "Create Contact"; the Lead status / Lead source / Vendor dropdowns are populated from live schema. Leaving Email blank shows the duplicate-risk hint. Save with a first name + a fresh email → progress runs to **Completed**; **Open in monday** opens the new card on board `5029639630`; **Open in HubSpot** opens the contact.
  3. Create a Contact with an **email that already exists** → progress shows completed with **"Matched an existing record"**, no duplicate.
  4. **＋ New Company** → "Create Company"; Industry/Type/Partner-with from live schema; domain dedup works the same way on board `5029639440`.
  5. **Owner:** the created record's Sales User = you (or the Unassigned message if your monday email has no HubSpot owner).
  6. **Idempotency:** double-clicking Create makes exactly one record; a mid-flight network failure + Retry resumes (no duplicate).
  7. **Deal path unchanged:** ＋ New Deal still opens the deal drawer and creates/edits deals exactly as before.
  8. Clean up the test records in HubSpot + monday.

- [ ] **Step 4: Record results** in memory `deal-cockpit-app.md` (new v3.4-Phase-B entry: app source id, what shipped, verification outcomes). Do NOT commit spec/plan docs.

---

## Notes for the implementer
- **Do not touch `DealDrawer.tsx`'s internals** — the deal create/edit flow is shipped and out of scope. `RecordDrawer` reuses the same CSS + `FormFields`, giving a matching look without risking the deal path.
- One idempotency key per drawer instance (`keyRef`), reused on Retry — never generate a new one per attempt.
- Owner / sales_user are never form fields; the Worker sets them from the session token.
- Enum `<select>` shows labels but stores HubSpot values — `optLabel`/`optValue` translate via the live schema.
- Associations (nested create, contextual-in-deal) are Phase C — do not add them here.
- Duplicate protection for a missing dedup key is an inline warning + an explicit confirm on submit. The heavier **name-match search** ("here are possible existing matches") reuses the association search UI and is deferred to **Phase C**.
- The spec's "read-only Sales User display of the resolved actor" is conveyed by the **Applying owner** progress step + the Unassigned message, rather than a static form field (the client can't know the resolved owner until the Worker responds).
