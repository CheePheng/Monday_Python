# HubSpot ↔ monday Two-Way Sync Worker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on Cloudflare Worker (Cron, ~2 min) that two-way syncs HubSpot deals/companies/contacts with Myla's 3 monday boards plus the shared Unassigned Deals board, routed by the HubSpot `sales_user` property — last-edit-wins, value-diff (no ping-pong), update-only on HubSpot.

**Architecture:** TypeScript Worker in `worker/` inside this repo. Pure logic (mapping/routing/dedup/reconcile) is unit-tested with vitest; thin fetch clients for monday GraphQL + HubSpot REST; a `scheduled()` cron entry and a secret-guarded `fetch()` manual trigger. No datastore — each tick reads the boards and converges. Static config (board/group/column ids discovered and committed) rather than runtime auto-mapping.

**Tech Stack:** TypeScript, wrangler 4 (already installed, v4.106), vitest, Cloudflare Workers Paid plan (confirmed), native `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-02-hubspot-monday-two-way-sync-worker-design.md`

**Known facts (discovered in prior sessions — do not re-derive):**
- monday API: `https://api.monday.com/v2`, header `Authorization: <token>`, `API-Version: 2024-10`. HubSpot: `https://api.hubapi.com`, `Authorization: Bearer <token>`. Portal id **39939588**.
- Myla: HubSpot owner id `1739141284`, email `mylamestiola@dkmeco.com`, monday user id `102443183`.
- Boards: Deals `5029480547`, Company `5029639440`, Contact `5029639630`, Unassigned `5029479220` (columns/groups listed in the spec and hardcoded in Task 4's config).
- HubSpot Sales Pipeline id `default`; stage ids `appointmentscheduled`, `qualifiedtobuy`, `presentationscheduled`, `decisionmakerboughtin`, `contractsent`, `closedwon`, `closedlost`, `2831885024`.
- Routing property: `sales_user` (select) on deals — its value for Myla and its existence on contacts/companies is confirmed in Task 1.
- Contacts use `lastmodifieddate`; deals/companies use `hs_lastmodifieddate`.
- Existing Python (`owner_router_test.py`) stays for one-off backfills/onboarding helpers; the Worker replaces `watch.py`/`sync.py` for steady state.

---

### Task 1: Discovery — sales_user values, contact/company properties, lead-status options

Requires the new HubSpot scopes (`crm.objects.contacts.read/write`, `crm.objects.companies.read/write`, `crm.schemas.contacts.read`, `crm.schemas.companies.read`). If any call 403s, STOP and ask the user to add scopes.

**Files:**
- Create: `worker_discovery.py` (repo root, throwaway helper committed for onboarding reuse)

- [ ] **Step 1: Write the discovery script**

```python
"""Discovers the constants the Worker config needs. Run: python worker_discovery.py"""
import sys
import owner_router_test as r

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

print("=== deals.sales_user options ===")
p = r.hubspot("GET", "/crm/v3/properties/deals/sales_user")
for o in p.get("options", []):
    print(f"  value={o['value']!r} label={o['label']!r}")

print("\n=== sample deals that HAVE sales_user (see real values) ===")
body = {"filterGroups": [{"filters": [
            {"propertyName": "pipeline", "operator": "EQ", "value": "default"},
            {"propertyName": "sales_user", "operator": "HAS_PROPERTY"}]}],
        "properties": ["dealname", "sales_user", "hubspot_owner_id"], "limit": 10}
for d in r.hubspot("POST", "/crm/v3/objects/deals/search", json=body)["results"]:
    pr = d["properties"]
    print(f"  {d['id']} | {pr.get('dealname')} | sales_user={pr.get('sales_user')!r} | owner={pr.get('hubspot_owner_id')}")

for obj in ("contacts", "companies"):
    print(f"\n=== {obj}: routing/source/vendor-ish properties ===")
    for prop in r.hubspot("GET", f"/crm/v3/properties/{obj}")["results"]:
        n, l = prop["name"].lower(), prop.get("label") or ""
        if ("sales" in n and "user" in n) or "厂商" in l or "来源" in l or n in (
                "sales_user", "lead_source", "hs_lead_status", "industry", "type"):
            print(f"  {prop['name']} | {l} | {prop.get('fieldType')}")

print("\n=== contacts.hs_lead_status options (value -> label) ===")
p = r.hubspot("GET", "/crm/v3/properties/contacts/hs_lead_status")
for o in p.get("options", []):
    print(f"  value={o['value']!r} label={o['label']!r}")

print("\n=== counts for Myla (size the backfill) ===")
for obj, flt in (("contacts", "CONTACT"), ("companies", "COMPANY")):
    body = {"filterGroups": [{"filters": [
        {"propertyName": "hubspot_owner_id", "operator": "EQ", "value": "1739141284"}]}],
        "properties": ["hs_object_id"], "limit": 1}
    res = r.hubspot("POST", f"/crm/v3/objects/{obj}/search", json=body)
    print(f"  {obj} owned by Myla: total={res.get('total')}")
```

- [ ] **Step 2: Run it and save the output**

Run: `python worker_discovery.py > worker-discovery.txt` then read `worker-discovery.txt`.
Expected: sales_user option list including Myla; lead-status options; contact/company property names; Myla's contact/company counts. **Record**: `SALES_USER_MYLA` (exact value string), `CONTACT_ROUTING_PROP` and `COMPANY_ROUTING_PROP` (use `sales_user` if it exists on that object, otherwise fall back to `hubspot_owner_id` with value `1739141284`), the 8 `hs_lead_status` values, and optional contact source/vendor property names (omit those fields in config if absent).

- [ ] **Step 3: Commit**

```bash
git add worker_discovery.py
git commit -m "feat: worker discovery helper (sales_user, lead status, contact/company props)"
```

---

### Task 2: Add "HubSpot ID" number columns to Company + Contact boards

**Files:**
- Create: `add_id_columns.py` (repo root)

- [ ] **Step 1: Write the script**

```python
"""Adds a 'HubSpot ID' numbers column to the Company and Contact boards (dedup key)."""
import owner_router_test as r

MUT = 'mutation ($b:ID!) { create_column(board_id:$b, title:"HubSpot ID", column_type:numbers) { id } }'
for board in ("5029639440", "5029639630"):
    col = r.monday_query(MUT, {"b": board})["create_column"]["id"]
    print(f"board {board} -> HubSpot ID column id: {col}")
```

- [ ] **Step 2: Run it and record both column ids**

Run: `python add_id_columns.py`
Expected: two lines like `board 5029639440 -> HubSpot ID column id: numeric_xxxx`. **Record** `COMPANY_ID_COL` and `CONTACT_ID_COL` for Task 4.

- [ ] **Step 3: Commit**

```bash
git add add_id_columns.py
git commit -m "feat: add HubSpot ID dedup columns to company + contact boards"
```

---

### Task 3: Scaffold the Worker project

**Files:**
- Create: `worker/package.json`, `worker/wrangler.jsonc`, `worker/tsconfig.json`, `worker/.gitignore`

- [ ] **Step 1: Write `worker/package.json`**

```json
{
  "name": "hubspot-monday-sync",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260101.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Write `worker/wrangler.jsonc`**

```jsonc
{
  "name": "hubspot-monday-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "triggers": { "crons": ["*/2 * * * *"] },
  "vars": { "DRY_RUN": "true" },
  "observability": { "enabled": true }
}
```

- [ ] **Step 3: Write `worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Write `worker/.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
```

- [ ] **Step 5: Install and verify**

Run (in `worker/`): `npm install` then `npx tsc --version` and `npx vitest --version`
Expected: installs cleanly; versions print.

- [ ] **Step 6: Commit**

```bash
git add worker/package.json worker/wrangler.jsonc worker/tsconfig.json worker/.gitignore
git commit -m "chore: scaffold cloudflare worker project (wrangler, vitest, ts)"
```

---

### Task 4: `types.ts` + `config.ts` (all boards, all field maps)

**Files:**
- Create: `worker/src/types.ts`, `worker/src/config.ts`

- [ ] **Step 1: Write `worker/src/types.ts`**

```typescript
export interface Env {
  MONDAY_API_TOKEN: string;
  HUBSPOT_ACCESS_TOKEN: string;
  TRIGGER_SECRET: string;
  DRY_RUN: string; // "true" | "false"
}

export type ColType = "text" | "numbers" | "status" | "dropdown" | "date" | "people" | "phone";
export type LabelDict =
  | "stage" | "dealtype" | "priority" | "vendor" | "pipeline"
  | "industry" | "companyType" | "leadStatus" | "salesUser";

export interface FieldSpec {
  hs: string;            // HubSpot property name
  col: string;           // monday column id
  type: ColType;
  labels?: LabelDict;    // enum label dictionary (HubSpot internal value -> display label)
  reverse?: boolean;     // monday edits may be written back to HubSpot
}

export type GroupBy =
  | { prop: string; map: Record<string, string>; reverse: boolean } // hs value -> monday group id
  | { singleGroup: string };

export interface ObjectSpec {
  object: "deals" | "companies" | "contacts";
  objectTypeId: "0-1" | "0-2" | "0-3"; // for HubSpot record deep links
  searchFilters: Record<string, unknown>[]; // one HubSpot filterGroup's filters
  modifiedProp: string;  // hs_lastmodifieddate | lastmodifieddate
  nameProps: string[];   // properties composing the monday item name
  nameReverse?: string;  // HubSpot property to receive a renamed item (omit = name not reversible)
  boardId: string;
  idCol: string;         // numbers column storing the HubSpot record id (dedup key)
  linkCol?: string;
  groupBy: GroupBy;
  fields: FieldSpec[];
}

export interface MondayItem {
  id: string;
  name: string;
  updated_at: string;
  group: { id: string };
  column_values: { id: string; text: string | null }[];
}

export interface HsRecord { id: string; properties: Record<string, string | null> }

export interface Ctx {
  labels: Partial<Record<LabelDict, Record<string, string>>>;
  ownersById: Record<string, { name: string; email: string | null }>;
  mondayUsersByEmail: Record<string, string>;
  portalId: number;
}

export interface RunOpts { dryRun: boolean; writeHubspot: boolean; maxWrites: number }

export interface Stats {
  processed: number; created: number; toMonday: number; toHubspot: number;
  inSync: number; skipped: number; errors: number;
}
```

- [ ] **Step 2: Write `worker/src/config.ts`** — replace the three `FILL_*` constants with Task 1/2 output.

```typescript
import type { ObjectSpec } from "./types";

// ---- Discovery-filled constants (from worker-discovery.txt / add_id_columns.py) ----
export const SALES_USER_MYLA = "FILL_SALES_USER_VALUE";       // Task 1
export const COMPANY_ID_COL = "FILL_COMPANY_ID_COLUMN";       // Task 2
export const CONTACT_ID_COL = "FILL_CONTACT_ID_COLUMN";       // Task 2
// If Task 1 showed contacts/companies have no sales_user property, use
// { propertyName: "hubspot_owner_id", operator: "EQ", value: "1739141284" } instead.
const CONTACT_ROUTING = { propertyName: "sales_user", operator: "EQ", value: SALES_USER_MYLA };
const COMPANY_ROUTING = { propertyName: "sales_user", operator: "EQ", value: SALES_USER_MYLA };

export const PORTAL_ID = 39939588;

// HubSpot stage id -> monday group id (Myla's Deals board 5029480547)
const STAGE_GROUPS: Record<string, string> = {
  appointmentscheduled: "group_mm4nf6fw",
  qualifiedtobuy: "group_title",
  presentationscheduled: "group_mm4pa9zg",
  decisionmakerboughtin: "group_mm4pbazz",
  contractsent: "group_mm4pavfa",
  closedwon: "group_mm4py571",
  closedlost: "group_mm4pw6e2",
  "2831885024": "group_mm4pdres",
};

// hs_lead_status internal value -> monday group id (Contact board 5029639630).
// Fill the KEYS from Task 1's hs_lead_status option values; the group ids are fixed:
// "New"->topics, "Open"->group_mm4wk3z0, "In Progress"->group_mm4w23q,
// "Open Deal"->group_mm4w9de6, "Unqualified"->group_mm4w1jd0,
// "Attempted to contact"->group_mm4wcxb, "Connected"->group_mm4wactt, "Bad Timing"->group_mm4w55z2
const LEAD_STATUS_GROUPS: Record<string, string> = {
  NEW: "topics",
  OPEN: "group_mm4wk3z0",
  IN_PROGRESS: "group_mm4w23q",
  OPEN_DEAL: "group_mm4w9de6",
  UNQUALIFIED: "group_mm4w1jd0",
  ATTEMPTED_TO_CONTACT: "group_mm4wcxb",
  CONNECTED: "group_mm4wactt",
  BAD_TIMING: "group_mm4w55z2",
};

export const DEALS_MYLA: ObjectSpec = {
  object: "deals",
  objectTypeId: "0-3",
  searchFilters: [
    { propertyName: "pipeline", operator: "EQ", value: "default" },
    { propertyName: "sales_user", operator: "EQ", value: SALES_USER_MYLA },
  ],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"],
  nameReverse: "dealname",
  boardId: "5029480547",
  idCol: "numeric_mm4nz332",
  linkCol: "link_mm4ns4nn",
  groupBy: { prop: "dealstage", map: STAGE_GROUPS, reverse: true },
  fields: [
    { hs: "hubspot_owner_id", col: "person", type: "people" },
    { hs: "dealstage", col: "color_mm4n27da", type: "status", labels: "stage" },
    { hs: "createdate", col: "date4", type: "date" },
    { hs: "pipeline", col: "dropdown_mm4ngscc", type: "dropdown", labels: "pipeline" },
    { hs: "dealtype", col: "dropdown_mm4nxhje", type: "dropdown", labels: "dealtype", reverse: true },
    { hs: "hs_priority", col: "dropdown_mm4nmmax", type: "dropdown", labels: "priority", reverse: true },
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm4n4f7r", type: "dropdown", labels: "vendor", reverse: true },
  ],
};

export const DEALS_UNASSIGNED: ObjectSpec = {
  object: "deals",
  objectTypeId: "0-3",
  searchFilters: [
    { propertyName: "pipeline", operator: "EQ", value: "default" },
    { propertyName: "sales_user", operator: "NOT_HAS_PROPERTY" },
  ],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"],
  boardId: "5029479220",
  idCol: "numeric_mm4wp9y2",
  linkCol: "link_mm4n9cce",
  groupBy: { singleGroup: "topics" },
  fields: [
    { hs: "hubspot_owner_id", col: "person", type: "people" },
    { hs: "pipeline", col: "status", type: "status", labels: "pipeline" },
    { hs: "dealstage", col: "dropdown_mm4nkk6y", type: "dropdown", labels: "stage" },
    { hs: "createdate", col: "date4", type: "date" },
    { hs: "dealtype", col: "dropdown_mm4nkmg5", type: "dropdown", labels: "dealtype" },
    { hs: "hs_priority", col: "dropdown_mm4n2mrd", type: "dropdown", labels: "priority" },
    { hs: "vendorschang_shang_lai_yuan", col: "dropdown_mm4nys6v", type: "dropdown", labels: "vendor" },
  ],
};

export const COMPANIES_MYLA: ObjectSpec = {
  object: "companies",
  objectTypeId: "0-2",
  searchFilters: [COMPANY_ROUTING],
  modifiedProp: "hs_lastmodifieddate",
  nameProps: ["name"],
  nameReverse: "name",
  boardId: "5029639440",
  idCol: COMPANY_ID_COL,
  linkCol: "link_mm4pvn78",
  groupBy: { singleGroup: "group_mm4s3z7e" },
  fields: [
    { hs: "name", col: "text_mm4scke9", type: "text", reverse: true },
    { hs: "hubspot_owner_id", col: "multiple_person_mm4p8xe2", type: "people" },
    { hs: "industry", col: "dropdown_mm4wj6nv", type: "dropdown", labels: "industry", reverse: true },
    { hs: "type", col: "dropdown_mm4wa6ak", type: "dropdown", labels: "companyType", reverse: true },
    { hs: "city", col: "text_mm4p2bvb", type: "text", reverse: true },
    { hs: "state", col: "text_mm4sznkw", type: "text", reverse: true },
    { hs: "numberofemployees", col: "numeric_mm4ww8gs", type: "numbers", reverse: true },
    { hs: "annualrevenue", col: "numeric_mm4w8g9k", type: "numbers", reverse: true },
    { hs: "timezone", col: "text_mm4wp480", type: "text" },
    { hs: "description", col: "text_mm4wwtd0", type: "text", reverse: true },
    { hs: "linkedin_company_page", col: "text_mm4w6rzg", type: "text", reverse: true },
    // Postal code column (phone_mm4s31p3) is a phone-type column — intentionally not mapped.
  ],
};

export const CONTACTS_MYLA: ObjectSpec = {
  object: "contacts",
  objectTypeId: "0-1",
  searchFilters: [CONTACT_ROUTING],
  modifiedProp: "lastmodifieddate",
  nameProps: ["firstname", "lastname"],
  // item name is "First Last" — splitting a rename back into first/last is ambiguous, so no nameReverse
  boardId: "5029639630",
  idCol: CONTACT_ID_COL,
  linkCol: "link_mm4pvn78",
  groupBy: { prop: "hs_lead_status", map: LEAD_STATUS_GROUPS, reverse: true },
  fields: [
    { hs: "lastname", col: "text_mm4scke9", type: "text", reverse: true },
    { hs: "email", col: "text_mm4p2bvb", type: "text", reverse: true },
    { hs: "jobtitle", col: "text_mm4sznkw", type: "text", reverse: true },
    { hs: "company", col: "text_mm4sbj9b", type: "text" },
    { hs: "phone", col: "phone_mm4s31p3", type: "phone" },
    { hs: "hubspot_owner_id", col: "multiple_person_mm4p8xe2", type: "people" },
    { hs: "sales_user", col: "dropdown_mm4thdr", type: "dropdown", labels: "salesUser" },
    { hs: "createdate", col: "date_mm4s2bjd", type: "date" },
    { hs: "notes_last_updated", col: "date4", type: "date" },
    { hs: "hs_lead_status", col: "status", type: "status", labels: "leadStatus" },
    // Contact Source (dropdown_mm4sj3kw) / Vendors (dropdown_mm4t8gjf): add here only if
    // Task 1 discovery found matching HubSpot properties; otherwise leave unmapped.
  ],
};

export const ALL_SPECS: ObjectSpec[] = [DEALS_MYLA, DEALS_UNASSIGNED, COMPANIES_MYLA, CONTACTS_MYLA];
```

- [ ] **Step 3: Type-check**

Run (in `worker/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/types.ts worker/src/config.ts
git commit -m "feat(worker): types + full board/field config for all four boards"
```

---

### Task 5: `mapping.ts` — forward formatting (TDD)

**Files:**
- Create: `worker/src/mapping.ts`
- Test: `worker/test/mapping.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { formatValue, buildColumnValues, itemName, expectedText } from "../src/mapping";
import type { Ctx, FieldSpec, ObjectSpec } from "../src/types";

const ctx: Ctx = {
  labels: {
    stage: { appointmentscheduled: "Appointment Scheduled" },
    dealtype: { existingbusiness: "Existing Business", newbusiness: "New Business" },
    pipeline: { default: "Sales Pipeline" },
  },
  ownersById: { "555": { name: "Myla Mestiola", email: "myla@x.com" } },
  mondayUsersByEmail: { "myla@x.com": "1001" },
  portalId: 39939588,
};

const f = (over: Partial<FieldSpec>): FieldSpec => ({ hs: "p", col: "c", type: "text", ...over });

describe("formatValue", () => {
  it("status uses the label dictionary", () =>
    expect(formatValue(f({ type: "status", labels: "stage" }), "appointmentscheduled", ctx))
      .toEqual({ label: "Appointment Scheduled" }));
  it("dropdown splits multi values and maps each", () =>
    expect(formatValue(f({ type: "dropdown", labels: "dealtype" }), "existingbusiness;newbusiness", ctx))
      .toEqual({ labels: ["Existing Business", "New Business"] }));
  it("date truncates to YYYY-MM-DD", () =>
    expect(formatValue(f({ type: "date" }), "2026-06-26T02:22:45Z", ctx)).toEqual({ date: "2026-06-26" }));
  it("people resolves owner -> monday user", () =>
    expect(formatValue(f({ type: "people" }), "555", ctx))
      .toEqual({ personsAndTeams: [{ id: 1001, kind: "person" }] }));
  it("numbers becomes a string", () =>
    expect(formatValue(f({ type: "numbers" }), "5000", ctx)).toBe("5000"));
  it("null/empty is skipped", () => {
    expect(formatValue(f({}), null, ctx)).toBeNull();
    expect(formatValue(f({}), "", ctx)).toBeNull();
  });
});

const spec: ObjectSpec = {
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"], boardId: "B", idCol: "c_id", linkCol: "c_link",
  groupBy: { singleGroup: "g" },
  fields: [{ hs: "dealtype", col: "c_type", type: "dropdown", labels: "dealtype" }],
};

describe("buildColumnValues / itemName", () => {
  it("includes id, mapped fields, and deep link", () => {
    const cv = buildColumnValues({ id: "9001", properties: { dealtype: "existingbusiness" } }, spec, ctx);
    expect(cv.c_id).toBe("9001");
    expect(cv.c_type).toEqual({ labels: ["Existing Business"] });
    expect(cv.c_link).toEqual({
      url: "https://app.hubspot.com/contacts/39939588/record/0-3/9001", text: "Open in HubSpot" });
  });
  it("itemName joins nameProps and falls back", () => {
    expect(itemName({ id: "1", properties: { dealname: "Acme" } }, spec)).toBe("Acme");
    expect(itemName({ id: "1", properties: {} }, spec)).toBe("deals 1");
  });
});

describe("expectedText (canonical comparison value)", () => {
  it("maps enum values to labels for status/dropdown", () => {
    expect(expectedText(f({ type: "status", labels: "stage" }), "appointmentscheduled", ctx))
      .toBe("Appointment Scheduled");
    expect(expectedText(f({ type: "date" }), "2026-06-26T02:22:45Z", ctx)).toBe("2026-06-26");
    expect(expectedText(f({ type: "people" }), "555", ctx)).toBeNull(); // not diffable
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (in `worker/`): `npx vitest run test/mapping.test.ts`
Expected: FAIL — cannot resolve `../src/mapping`.

- [ ] **Step 3: Implement `worker/src/mapping.ts`**

```typescript
import type { Ctx, FieldSpec, HsRecord, ObjectSpec } from "./types";

const dict = (f: FieldSpec, ctx: Ctx): Record<string, string> =>
  (f.labels ? ctx.labels[f.labels] : undefined) ?? {};

export function formatValue(f: FieldSpec, value: string | null | undefined, ctx: Ctx): unknown {
  if (value === null || value === undefined || value === "") return null;
  const v = String(value);
  switch (f.type) {
    case "text": return dict(f, ctx)[v] ?? v;
    case "numbers": return v;
    case "status": return { label: dict(f, ctx)[v] ?? v };
    case "dropdown": {
      const labels = v.split(";").map(s => s.trim()).filter(Boolean).map(s => dict(f, ctx)[s] ?? s);
      return labels.length ? { labels } : null;
    }
    case "date": return { date: v.slice(0, 10) };
    case "people": {
      const email = ctx.ownersById[v]?.email?.toLowerCase();
      const uid = email ? ctx.mondayUsersByEmail[email] : undefined;
      return uid ? { personsAndTeams: [{ id: Number(uid), kind: "person" }] } : null;
    }
    case "phone": return { phone: v.replace(/[^\d+]/g, ""), countryShortName: "SG" };
  }
}

export function itemName(rec: HsRecord, spec: ObjectSpec): string {
  const name = spec.nameProps.map(p => rec.properties[p] ?? "").join(" ").trim();
  return name || `${spec.object} ${rec.id}`;
}

export function buildColumnValues(rec: HsRecord, spec: ObjectSpec, ctx: Ctx): Record<string, unknown> {
  const cv: Record<string, unknown> = { [spec.idCol]: String(rec.id) };
  for (const f of spec.fields) {
    const v = formatValue(f, rec.properties[f.hs], ctx);
    if (v !== null && v !== undefined) cv[f.col] = v;
  }
  if (spec.linkCol) cv[spec.linkCol] = {
    url: `https://app.hubspot.com/contacts/${ctx.portalId}/record/${spec.objectTypeId}/${rec.id}`,
    text: "Open in HubSpot",
  };
  return cv;
}

/** Canonical text a monday column should show for this HubSpot value; null = not diffable. */
export function expectedText(f: FieldSpec, value: string | null | undefined, ctx: Ctx): string | null {
  if (f.type === "people" || f.type === "phone") return null;
  if (value === null || value === undefined || value === "") return "";
  const v = String(value);
  switch (f.type) {
    case "date": return v.slice(0, 10);
    case "status": case "text": return dict(f, ctx)[v] ?? v;
    case "dropdown":
      return v.split(";").map(s => s.trim()).filter(Boolean).map(s => dict(f, ctx)[s] ?? s).join(", ");
    default: return v;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/mapping.test.ts` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/mapping.ts worker/test/mapping.test.ts
git commit -m "feat(worker): forward field mapping with canonical comparison text"
```

---

### Task 6: `routing.ts` + `dedup.ts` (TDD)

**Files:**
- Create: `worker/src/routing.ts`, `worker/src/dedup.ts`
- Test: `worker/test/routing.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { targetGroup, reverseGroup } from "../src/routing";
import { indexByHubspotId } from "../src/dedup";
import type { MondayItem, ObjectSpec } from "../src/types";

const grouped: ObjectSpec = {
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "m",
  nameProps: ["dealname"], boardId: "B", idCol: "c_id",
  groupBy: { prop: "dealstage", map: { appointmentscheduled: "g1", closedwon: "g6" }, reverse: true },
  fields: [],
};
const single: ObjectSpec = { ...grouped, groupBy: { singleGroup: "gS" } };

describe("targetGroup", () => {
  it("maps the group-by property value", () =>
    expect(targetGroup({ id: "1", properties: { dealstage: "closedwon" } }, grouped)).toBe("g6"));
  it("returns null for unmapped values", () =>
    expect(targetGroup({ id: "1", properties: { dealstage: "weird" } }, grouped)).toBeNull());
  it("single-group boards always route to that group", () =>
    expect(targetGroup({ id: "1", properties: {} }, single)).toBe("gS"));
});

describe("reverseGroup", () => {
  it("maps a monday group id back to the HubSpot value", () =>
    expect(reverseGroup(grouped, "g6")).toBe("closedwon"));
  it("returns null for unknown groups or single-group specs", () => {
    expect(reverseGroup(grouped, "gX")).toBeNull();
    expect(reverseGroup(single, "gS")).toBeNull();
  });
});

const item = (id: string, hsId: string): MondayItem => ({
  id, name: "x", updated_at: "2026-07-01T00:00:00Z", group: { id: "g1" },
  column_values: [{ id: "c_id", text: hsId }],
});

describe("indexByHubspotId", () => {
  it("finds items by the id column, ignores blanks", () => {
    const idx = indexByHubspotId([item("i1", "9001"), item("i2", "")], "c_id");
    expect(idx["9001"].id).toBe("i1");
    expect(idx["9002"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/routing.test.ts` → FAIL (unresolved imports).

- [ ] **Step 3: Implement `worker/src/routing.ts`**

```typescript
import type { HsRecord, ObjectSpec } from "./types";

export function targetGroup(rec: HsRecord, spec: ObjectSpec): string | null {
  if ("singleGroup" in spec.groupBy) return spec.groupBy.singleGroup;
  const v = rec.properties[spec.groupBy.prop];
  return v ? spec.groupBy.map[v] ?? null : null;
}

/** monday group id -> HubSpot group-by value (null when not applicable). */
export function reverseGroup(spec: ObjectSpec, groupId: string): string | null {
  if ("singleGroup" in spec.groupBy) return null;
  for (const [hsValue, gid] of Object.entries(spec.groupBy.map))
    if (gid === groupId) return hsValue;
  return null;
}
```

- [ ] **Step 4: Implement `worker/src/dedup.ts`**

```typescript
import type { MondayItem } from "./types";

export function colText(item: MondayItem, colId: string): string {
  return (item.column_values.find(cv => cv.id === colId)?.text ?? "").trim();
}

export function indexByHubspotId(items: MondayItem[], idCol: string): Record<string, MondayItem> {
  const idx: Record<string, MondayItem> = {};
  for (const item of items) {
    const key = colText(item, idCol);
    if (key) idx[key] = item;
  }
  return idx;
}
```

- [ ] **Step 5: Run to verify pass** — `npx vitest run test/routing.test.ts` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routing.ts worker/src/dedup.ts worker/test/routing.test.ts
git commit -m "feat(worker): routing (group targeting both directions) + dedup index"
```

---

### Task 7: `reconcile.ts` — diffs, direction, reverse patch (TDD)

**Files:**
- Create: `worker/src/reconcile.ts`
- Test: `worker/test/reconcile.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { fieldDiffs, decideDirection, buildReversePatch } from "../src/reconcile";
import type { Ctx, MondayItem, ObjectSpec } from "../src/types";

const ctx: Ctx = {
  labels: { dealtype: { existingbusiness: "Existing Business", newbusiness: "New Business" } },
  ownersById: {}, mondayUsersByEmail: {}, portalId: 1,
};

const spec: ObjectSpec = {
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"], nameReverse: "dealname", boardId: "B", idCol: "c_id",
  groupBy: { prop: "dealstage", map: { appointmentscheduled: "g1", closedwon: "g6" }, reverse: true },
  fields: [
    { hs: "dealtype", col: "c_type", type: "dropdown", labels: "dealtype", reverse: true },
    { hs: "createdate", col: "c_date", type: "date" }, // forward-only
  ],
};

const item = (over: Partial<MondayItem>): MondayItem => ({
  id: "i1", name: "Acme", updated_at: "2026-07-01T00:00:00Z", group: { id: "g1" },
  column_values: [
    { id: "c_id", text: "9001" }, { id: "c_type", text: "Existing Business" },
    { id: "c_date", text: "2026-06-26" },
  ],
  ...over,
});

const rec = (props: Record<string, string>) => ({
  id: "9001",
  properties: { dealname: "Acme", dealstage: "appointmentscheduled",
    dealtype: "existingbusiness", createdate: "2026-06-26T00:00:00Z", ...props },
});

describe("fieldDiffs", () => {
  it("returns [] when everything matches", () =>
    expect(fieldDiffs(rec({}), item({}), spec, ctx)).toEqual([]));
  it("detects a field diff", () => {
    const d = fieldDiffs(rec({ dealtype: "newbusiness" }), item({}), spec, ctx);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "field", hsText: "New Business", mdText: "Existing Business" });
  });
  it("detects name and group diffs", () => {
    const d = fieldDiffs(rec({ dealname: "Acme2", dealstage: "closedwon" }), item({}), spec, ctx);
    expect(d.map(x => x.kind).sort()).toEqual(["group", "name"]);
  });
});

describe("decideDirection", () => {
  const diffs = [{ kind: "name" as const, hsText: "A", mdText: "B" }];
  it("none when no diffs", () =>
    expect(decideDirection([], "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z")).toBe("none"));
  it("HubSpot newer -> toMonday", () =>
    expect(decideDirection(diffs, "2026-07-02T00:00:00Z", "2026-07-01T00:00:00Z")).toBe("toMonday"));
  it("monday newer -> toHubspot", () =>
    expect(decideDirection(diffs, "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z")).toBe("toHubspot"));
});

describe("buildReversePatch", () => {
  it("inverts labels, includes name and group, skips non-reversible fields", () => {
    const md = item({
      name: "Acme Renamed", group: { id: "g6" },
      column_values: [
        { id: "c_id", text: "9001" }, { id: "c_type", text: "New Business" },
        { id: "c_date", text: "2030-01-01" }, // date is forward-only: must NOT appear in patch
      ],
    });
    const diffs = fieldDiffs(rec({}), md, spec, ctx);
    const patch = buildReversePatch(diffs, md, spec, ctx);
    expect(patch).toEqual({ dealname: "Acme Renamed", dealstage: "closedwon", dealtype: "newbusiness" });
  });
  it("returns {} when only non-reversible fields differ", () => {
    const md = item({ column_values: [
      { id: "c_id", text: "9001" }, { id: "c_type", text: "Existing Business" },
      { id: "c_date", text: "2030-01-01" }] });
    const diffs = fieldDiffs(rec({}), md, spec, ctx);
    expect(buildReversePatch(diffs, md, spec, ctx)).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/reconcile.test.ts` → FAIL.

- [ ] **Step 3: Implement `worker/src/reconcile.ts`**

```typescript
import type { Ctx, FieldSpec, HsRecord, MondayItem, ObjectSpec } from "./types";
import { expectedText, itemName } from "./mapping";
import { colText } from "./dedup";
import { reverseGroup, targetGroup } from "./routing";

export interface Diff {
  kind: "field" | "name" | "group";
  f?: FieldSpec;
  hsText: string;
  mdText: string;
}

export function fieldDiffs(rec: HsRecord, item: MondayItem, spec: ObjectSpec, ctx: Ctx): Diff[] {
  const out: Diff[] = [];
  for (const f of spec.fields) {
    const hsText = expectedText(f, rec.properties[f.hs], ctx);
    if (hsText === null) continue; // people/phone: not diffable
    const mdText = colText(item, f.col);
    if (hsText !== mdText && !(hsText === "" && mdText === "")) out.push({ kind: "field", f, hsText, mdText });
  }
  const wantName = itemName(rec, spec);
  if (wantName !== item.name.trim()) out.push({ kind: "name", hsText: wantName, mdText: item.name.trim() });
  const wantGroup = targetGroup(rec, spec);
  if (wantGroup && wantGroup !== item.group.id)
    out.push({ kind: "group", hsText: wantGroup, mdText: item.group.id });
  return out;
}

export function decideDirection(
  diffs: Diff[], hsModified: string | null | undefined, mdUpdated: string | null | undefined,
): "none" | "toMonday" | "toHubspot" {
  if (diffs.length === 0) return "none";
  return (Date.parse(mdUpdated ?? "") || 0) > (Date.parse(hsModified ?? "") || 0)
    ? "toHubspot" : "toMonday";
}

function invert(dictionary: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [value, label] of Object.entries(dictionary)) out[label] = value;
  return out;
}

/** HubSpot PATCH body from monday-side values. Only reversible diffs are included. */
export function buildReversePatch(
  diffs: Diff[], item: MondayItem, spec: ObjectSpec, ctx: Ctx,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const d of diffs) {
    if (d.kind === "name" && spec.nameReverse) patch[spec.nameReverse] = item.name.trim();
    if (d.kind === "group" && "prop" in spec.groupBy && spec.groupBy.reverse) {
      const v = reverseGroup(spec, item.group.id);
      if (v) patch[spec.groupBy.prop] = v;
    }
    if (d.kind === "field" && d.f?.reverse) {
      const rev = d.f.labels ? invert(ctx.labels[d.f.labels] ?? {}) : {};
      if (d.f.type === "dropdown") {
        const values = d.mdText.split(",").map(s => s.trim()).filter(Boolean).map(s => rev[s] ?? s);
        if (values.length) patch[d.f.hs] = values.join(";");
      } else {
        patch[d.f.hs] = rev[d.mdText] ?? d.mdText;
      }
    }
  }
  return patch;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/reconcile.test.ts` → all PASS. Also run the full suite: `npx vitest run` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/reconcile.ts worker/test/reconcile.test.ts
git commit -m "feat(worker): reconcile - value diffs, last-edit-wins, reverse patch"
```

---

### Task 8: `monday.ts` client

Thin fetch wrapper; not unit-tested (verified live in Task 11+). Writes honor dry-run.

**Files:**
- Create: `worker/src/monday.ts`

- [ ] **Step 1: Implement**

```typescript
import type { Env, MondayItem, RunOpts } from "./types";

const URL_ = "https://api.monday.com/v2";

async function gql(env: Env, query: string, variables: Record<string, unknown> = {}, retries = 3): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(URL_, {
        method: "POST",
        headers: { Authorization: env.MONDAY_API_TOKEN, "Content-Type": "application/json",
                   "API-Version": "2024-10" },
        body: JSON.stringify({ query, variables }),
      });
      const data: any = await resp.json();
      if (data.errors) throw new Error(`monday: ${JSON.stringify(data.errors).slice(0, 500)}`);
      return data.data;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise(res => setTimeout(res, 1500 * attempt));
    }
  }
}

export async function getBoardItems(env: Env, boardId: string): Promise<MondayItem[]> {
  const items: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    const page: any = cursor
      ? (await gql(env,
          `query ($c:String!) { next_items_page(cursor:$c, limit:500) {
             cursor items { id name updated_at group { id } column_values { id text } } } }`,
          { c: cursor })).next_items_page
      : (await gql(env,
          `query ($b:[ID!]) { boards(ids:$b) { items_page(limit:500) {
             cursor items { id name updated_at group { id } column_values { id text } } } } }`,
          { b: [boardId] })).boards[0].items_page;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export async function getUsersByEmail(env: Env): Promise<Record<string, string>> {
  const users: any[] = (await gql(env, "query { users(limit:500) { id email } }")).users;
  const out: Record<string, string> = {};
  for (const u of users) if (u.email) out[u.email.toLowerCase()] = String(u.id);
  return out;
}

export async function createItem(env: Env, boardId: string, groupId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<void> {
  if (opts.dryRun) { console.log(`DRY create '${name}' on ${boardId}/${groupId}`); return; }
  await gql(env,
    `mutation ($b:ID!, $g:String!, $n:String!, $c:JSON) {
       create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$c,
                   create_labels_if_missing:true) { id } }`,
    { b: boardId, g: groupId, n: name, c: JSON.stringify(cv) });
  console.log(`created '${name}' on ${boardId}/${groupId}`);
}

export async function updateItem(env: Env, boardId: string, itemId: string, name: string,
    cv: Record<string, unknown>, opts: RunOpts): Promise<void> {
  const withName = { ...cv, name };
  if (opts.dryRun) { console.log(`DRY update item ${itemId} on ${boardId}`); return; }
  await gql(env,
    `mutation ($b:ID!, $i:ID!, $c:JSON!) {
       change_multiple_column_values(board_id:$b, item_id:$i, column_values:$c,
                                     create_labels_if_missing:true) { id } }`,
    { b: boardId, i: itemId, c: JSON.stringify(withName) });
  console.log(`updated item ${itemId} on ${boardId}`);
}

export async function moveItem(env: Env, boardId: string, itemId: string, groupId: string,
    opts: RunOpts): Promise<void> {
  if (opts.dryRun) { console.log(`DRY move item ${itemId} -> group ${groupId}`); return; }
  await gql(env, `mutation ($i:ID!, $g:String!) { move_item_to_group(item_id:$i, group_id:$g) { id } }`,
    { i: itemId, g: groupId });
  console.log(`moved item ${itemId} -> group ${groupId}`);
}
```

- [ ] **Step 2: Type-check** — `npx tsc --noEmit` → no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/monday.ts
git commit -m "feat(worker): monday graphql client (paginated reads, dry-run-gated writes, move)"
```

---

### Task 9: `hubspot.ts` client

**Files:**
- Create: `worker/src/hubspot.ts`

- [ ] **Step 1: Implement**

```typescript
import type { Env, HsRecord, ObjectSpec, RunOpts } from "./types";

const BASE = "https://api.hubapi.com";

async function hs(env: Env, method: string, path: string, body?: unknown, retries = 3): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (resp.status === 429 && attempt < retries) {
        await new Promise(res => setTimeout(res, 2000 * attempt));
        continue;
      }
      if (!resp.ok) throw new Error(`hubspot ${method} ${path}: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
      return resp.json();
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise(res => setTimeout(res, 1500 * attempt));
    }
  }
}

function propertiesFor(spec: ObjectSpec): string[] {
  const props = new Set<string>([...spec.nameProps, spec.modifiedProp]);
  for (const f of spec.fields) props.add(f.hs);
  if ("prop" in spec.groupBy) props.add(spec.groupBy.prop);
  return [...props];
}

export async function searchAll(env: Env, spec: ObjectSpec): Promise<HsRecord[]> {
  const results: HsRecord[] = [];
  let after: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters: spec.searchFilters }],
      sorts: [{ propertyName: spec.modifiedProp, direction: "DESCENDING" }],
      properties: propertiesFor(spec),
      limit: 100,
      ...(after ? { after } : {}),
    };
    const page = await hs(env, "POST", `/crm/v3/objects/${spec.object}/search`, body);
    results.push(...(page.results ?? []));
    after = page.paging?.next?.after;
  } while (after);
  return results;
}

export async function patchRecord(env: Env, spec: ObjectSpec, id: string,
    properties: Record<string, string>, opts: RunOpts): Promise<void> {
  if (opts.dryRun || !opts.writeHubspot) {
    console.log(`DRY hubspot PATCH ${spec.object}/${id}: ${JSON.stringify(properties)}`);
    return;
  }
  await hs(env, "PATCH", `/crm/v3/objects/${spec.object}/${id}`, { properties });
  console.log(`hubspot PATCH ${spec.object}/${id}: ${Object.keys(properties).join(",")}`);
}

export async function getOwners(env: Env): Promise<Record<string, { name: string; email: string | null }>> {
  const res = await hs(env, "GET", "/crm/v3/owners/?limit=100");
  const out: Record<string, { name: string; email: string | null }> = {};
  for (const o of res.results ?? [])
    out[String(o.id)] = { name: `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim(), email: o.email ?? null };
  return out;
}

export async function getPropertyOptions(env: Env, object: string, prop: string):
    Promise<Record<string, string>> {
  const res = await hs(env, "GET", `/crm/v3/properties/${object}/${prop}`);
  const out: Record<string, string> = {};
  for (const o of res.options ?? []) out[String(o.value)] = String(o.label);
  return out;
}
```

- [ ] **Step 2: Type-check** — `npx tsc --noEmit` → no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/hubspot.ts
git commit -m "feat(worker): hubspot rest client (paginated search, gated patch, options)"
```

---

### Task 10: `sync.ts` orchestrator + `index.ts` entrypoints

**Files:**
- Create: `worker/src/sync.ts`, `worker/src/index.ts`

- [ ] **Step 1: Implement `worker/src/sync.ts`**

```typescript
import type { Ctx, Env, ObjectSpec, RunOpts, Stats } from "./types";
import { ALL_SPECS, PORTAL_ID } from "./config";
import { buildColumnValues, itemName } from "./mapping";
import { indexByHubspotId } from "./dedup";
import { targetGroup } from "./routing";
import { decideDirection, fieldDiffs, buildReversePatch } from "./reconcile";
import { createItem, getBoardItems, getUsersByEmail, moveItem, updateItem } from "./monday";
import { getOwners, getPropertyOptions, patchRecord, searchAll } from "./hubspot";

export async function buildCtx(env: Env): Promise<Ctx> {
  const [ownersById, mondayUsersByEmail, stage, dealtype, priority, vendor, leadStatus,
         industry, companyType, salesUser] = await Promise.all([
    getOwners(env),
    getUsersByEmail(env),
    getPropertyOptions(env, "deals", "dealstage"),
    getPropertyOptions(env, "deals", "dealtype"),
    getPropertyOptions(env, "deals", "hs_priority"),
    getPropertyOptions(env, "deals", "vendorschang_shang_lai_yuan"),
    getPropertyOptions(env, "contacts", "hs_lead_status"),
    getPropertyOptions(env, "companies", "industry"),
    getPropertyOptions(env, "companies", "type"),
    getPropertyOptions(env, "deals", "sales_user"),
  ]);
  return {
    labels: { stage, dealtype, priority, vendor, leadStatus, industry, companyType, salesUser,
              pipeline: { default: "Sales Pipeline" } },
    ownersById, mondayUsersByEmail, portalId: PORTAL_ID,
  };
}

export async function syncSpec(env: Env, spec: ObjectSpec, ctx: Ctx, opts: RunOpts): Promise<Stats> {
  const stats: Stats = { processed: 0, created: 0, toMonday: 0, toHubspot: 0, inSync: 0, skipped: 0, errors: 0 };
  const [records, items] = await Promise.all([searchAll(env, spec), getBoardItems(env, spec.boardId)]);
  const byId = indexByHubspotId(items, spec.idCol);
  let writes = 0;

  for (const rec of records) {
    stats.processed++;
    if (writes >= opts.maxWrites) { stats.skipped++; continue; }
    try {
      const group = targetGroup(rec, spec);
      if (!group) { stats.skipped++; continue; }
      const existing = byId[String(rec.id)];

      if (!existing) {
        await createItem(env, spec.boardId, group, itemName(rec, spec), buildColumnValues(rec, spec, ctx), opts);
        stats.created++; writes++;
        continue;
      }

      const diffs = fieldDiffs(rec, existing, spec, ctx);
      const dir = decideDirection(diffs, rec.properties[spec.modifiedProp], existing.updated_at);
      if (dir === "none") { stats.inSync++; continue; }

      if (dir === "toHubspot") {
        const patch = buildReversePatch(diffs, existing, spec, ctx);
        if (Object.keys(patch).length > 0) {
          await patchRecord(env, spec, rec.id, patch, opts);
          stats.toHubspot++; writes++;
          continue;
        }
        // nothing reversible differs -> fall through to forward write
      }

      await updateItem(env, spec.boardId, existing.id, itemName(rec, spec), buildColumnValues(rec, spec, ctx), opts);
      if (diffs.some(d => d.kind === "group")) await moveItem(env, spec.boardId, existing.id, group, opts);
      stats.toMonday++; writes++;
    } catch (e) {
      stats.errors++;
      console.log(`error ${spec.object}/${rec.id}: ${String(e).slice(0, 300)}`);
    }
  }
  console.log(`${spec.object} board ${spec.boardId}: ${JSON.stringify(stats)}`);
  return stats;
}

export async function runAll(env: Env, opts: RunOpts, only?: string): Promise<Record<string, Stats>> {
  const ctx = await buildCtx(env);
  const out: Record<string, Stats> = {};
  for (const spec of ALL_SPECS) {
    if (only && spec.object !== only) continue;
    out[`${spec.object}:${spec.boardId}`] = await syncSpec(env, spec, ctx, opts);
  }
  return out;
}
```

- [ ] **Step 2: Implement `worker/src/index.ts`**

```typescript
import type { Env, RunOpts } from "./types";
import { runAll } from "./sync";

function optsFromEnv(env: Env): RunOpts {
  const live = env.DRY_RUN === "false";
  return { dryRun: !live, writeHubspot: live, maxWrites: 300 };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ectx: ExecutionContext): Promise<void> {
    ectx.waitUntil(runAll(env, optsFromEnv(env)).then(s => console.log("tick", JSON.stringify(s))));
  },

  // Manual trigger: /run?secret=...&object=deals|companies|contacts&mode=dry|live&maxWrites=300
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    if (url.searchParams.get("secret") !== env.TRIGGER_SECRET)
      return new Response("forbidden", { status: 403 });
    const mode = url.searchParams.get("mode") ?? "dry";
    const opts: RunOpts = {
      dryRun: mode !== "live",
      writeHubspot: mode === "live",
      maxWrites: Number(url.searchParams.get("maxWrites") ?? "300"),
    };
    const stats = await runAll(env, opts, url.searchParams.get("object") ?? undefined);
    return Response.json({ mode, stats });
  },
};
```

- [ ] **Step 3: Type-check + full test suite** — `npx tsc --noEmit && npx vitest run` → clean, all PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/src/sync.ts worker/src/index.ts
git commit -m "feat(worker): orchestrator + cron/manual-trigger entrypoints"
```

---

### Task 11: Deploy, secrets, and dry-run verification (deals first)

- [ ] **Step 1: Authorize wrangler** — Run `npx wrangler login` (in `worker/`). A browser opens; the user clicks **Allow**. Verify with `npx wrangler whoami` → prints the account.

- [ ] **Step 2: First deploy (DRY_RUN=true is already the var default)**

Run: `npx wrangler deploy`
Expected: uploads, prints `https://hubspot-monday-sync.<account>.workers.dev` and the cron schedule.

- [ ] **Step 3: Set secrets** (values come from the local `.env` in the repo root; TRIGGER_SECRET is any long random string — generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"`)

```bash
npx wrangler secret put MONDAY_API_TOKEN
npx wrangler secret put HUBSPOT_ACCESS_TOKEN
npx wrangler secret put TRIGGER_SECRET
```

- [ ] **Step 4: Dry-run deals via the manual trigger**

Run: `curl "https://hubspot-monday-sync.<account>.workers.dev/run?secret=<TRIGGER_SECRET>&object=deals&mode=dry"`
Expected: JSON stats for both deals specs. Myla's board was previously synced by *owner*; since routing is now by `sales_user`, expect some `created`>0 (deals with sales_user=Myla not yet carded) and inspect `wrangler tail` logs to confirm each DRY line looks right. Zero `errors` required.

- [ ] **Step 5: Watch a cron tick** — Run `npx wrangler tail` for ~3 minutes; confirm a scheduled dry tick logs all four boards with no exceptions.

- [ ] **Step 6: Commit any fixes** — `git add -A worker && git commit -m "fix(worker): dry-run findings"` (skip if no changes).

---

### Task 12: Companies + contacts dry-run, then live backfill

- [ ] **Step 1: Dry-run companies and contacts**

```bash
curl "https://.../run?secret=...&object=companies&mode=dry"
curl "https://.../run?secret=...&object=contacts&mode=dry"
```
Expected: stats show `created` ≈ the counts from Task 1 discovery, `errors: 0`. Inspect `wrangler tail` output for correct group routing (contacts spread across lead-status groups) and field payloads.

- [ ] **Step 2: Live backfill in batches** (repeat each command until `created: 0`; each call writes ≤300)

```bash
curl "https://.../run?secret=...&object=deals&mode=live&maxWrites=300"
curl "https://.../run?secret=...&object=companies&mode=live&maxWrites=300"
curl "https://.../run?secret=...&object=contacts&mode=live&maxWrites=300"
```
Expected: convergence — final run of each shows `created: 0, errors: 0`, remainder `inSync`.

- [ ] **Step 3: Verify on the boards** — user visually confirms: deals in correct stage groups; companies in the single group with fields; contacts spread across the 8 lead-status groups with the Sales User dropdown filled.

- [ ] **Step 4: Two-way spot test** — Rename one monday deal card and move one contact to a different lead-status group, wait/trigger a dry run, confirm the log proposes the correct HubSpot PATCHes, then run `mode=live` and verify in HubSpot. Then edit a HubSpot field and confirm it flows to monday. Confirm a following tick reports everything `inSync` (no ping-pong).

---

### Task 13: Cutover to live cron + docs

- [ ] **Step 1: Flip the cron to live** — In `worker/wrangler.jsonc` change `"DRY_RUN": "true"` to `"DRY_RUN": "false"`, then `npx wrangler deploy`. Watch one tick with `npx wrangler tail`: expect mostly `inSync`, zero errors.

- [ ] **Step 2: Update the repo README** — Add a `## Always-on sync (Cloudflare Worker)` section: what the Worker does (two-way, every 2 min, routed by sales_user, update-only on HubSpot), the manual trigger URL pattern, how to flip DRY_RUN, and a warning to STOP using `watch.py`/`sync.py` while the cron is live (double-writers). Note `owner_router_test.py` remains for one-off onboarding/backfill helpers.

- [ ] **Step 3: Final commit**

```bash
git add worker/wrangler.jsonc README.md
git commit -m "feat(worker): go live on cron; document always-on sync + python decommission"
```

---

## Self-Review Notes

- **Spec coverage:** always-on cron (T3/T13), two-way last-edit-wins value-diff (T7/T10), update-only HubSpot (patchRecord only — no create path exists), routing by sales_user incl. Unassigned NOT_HAS_PROPERTY (T4), dedup via ID columns incl. adding missing ones (T2/T6), per-record error isolation + retries (T8–T10), dry-run gates (clients + mode param), backfill within paid limits via maxWrites batches (T12), tests for all pure logic (T5–T7), prerequisites verified (T1).
- **Deviations from spec (justified):** stage/lead-status maps are static config, not runtime auto-mapping (determinism, fewer subrequests; the Python `build_stage_to_group` remains the onboarding generator). Backfill runs through the Worker's batched manual trigger rather than new Python (companies/contacts have no Python support; batching keeps runs within limits).
- **Type consistency check:** `FieldSpec/ObjectSpec/Ctx/RunOpts/Stats` defined once in T4 and imported everywhere; `fieldDiffs/decideDirection/buildReversePatch` signatures in T7 match T10 usage; `colText` lives in dedup.ts and is imported by reconcile.ts.
- **Known risk:** monday `updated_at` changes when the sync itself writes — safe because value-diff gates all action; after convergence, ticks are no-ops.
