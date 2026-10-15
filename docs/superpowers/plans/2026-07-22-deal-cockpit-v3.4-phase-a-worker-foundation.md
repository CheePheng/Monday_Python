# Deal Cockpit v3.4 Phase A — Worker Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Worker-side foundation for creating HubSpot Contacts & Companies from the Deal Cockpit — search-or-create with email/domain dedup, current-rep owner mapping, a Durable Object idempotency store, and structured step-results — behind two new authenticated endpoints, plus live schema routes. (Line-item creation is left unchanged; adding a DO key there is a separate follow-up task — see Task 9.)

**Architecture:** The Worker stays the sole HubSpot writer. New `POST /app/contact` and `POST /app/company` endpoints run a fixed step sequence (dedup → create/reuse HubSpot → create/reuse monday card with the HubSpot ID stamped in the initial mutation → apply owner → optional nested association), wrapped by a `CreateIdempotency` Durable Object keyed by a client UUID so retries resume instead of duplicating. All decision logic (allowlists, domain normalization, owner resolution, idempotency state) lives in **pure, unit-tested** modules; the DO and the I/O orchestration are thin shells verified live (the worker test suite is plain vitest, not the Workers pool).

**Tech Stack:** Cloudflare Workers (TypeScript, `wrangler`), Durable Objects (SQLite-backed, RPC), vitest (node), HubSpot CRM v3/v4, monday GraphQL.

**Spec:** `docs/superpowers/specs/2026-07-21-deal-cockpit-v3.4-contact-company-creation.md`

**Reference — verified live IDs (from `worker/src/config.ts`, do not re-guess):**
- Contacts board `5029639630`, HubSpot-ID col `numeric_mm4xw7rk`, name = `firstname`, group fallback `topics`.
- Companies board `5029639440`, HubSpot-ID col `numeric_mm4xkk3a`, name = `domain`, single group `group_mm4s3z7e`.
- `CONTACTS_MYLA` / `COMPANIES_MYLA` specs already carry every field's `hs`↔`col` mapping and reverse flags.

**Board scope — these are ALL-REP shared boards, NOT Myla-only** (the `*_MYLA` constant names are a legacy misnomer). Both specs filter on `sales_user HAS_PROPERTY` (comment in config: *"All sales users (not just Myla)"*) + `createdate GTE cutoff`, and `recInScope()` in `sync.ts` scopes on *"has any sales_user"*, not `sales_user == Myla`. So assigning a new record to the current rep places it in-scope on the one shared board with no conflict. The only caveat (already in the spec) is that an **Unassigned** record — no `sales_user` — is out of *inbound* HubSpot→monday scope until a Sales User is assigned; it is still created fully and syncs monday→HubSpot. Do **not** convert to per-rep boards or restrict creation to Myla — neither is needed. (A symbol rename `*_MYLA`→`*_SHARED` is out of scope: cosmetic, widely referenced, zero functional gain.)

**Conventions to follow (already in the codebase):**
- Pure request-body parsers live in `worker/src/app-routes.ts` and are unit-tested in `worker/test/app-routes.test.ts` (see `parseCreateLineItemBody`).
- HubSpot calls go through `hs()` in `worker/src/hubspot.ts`; creates pass `retries=1` (never double-apply).
- App routes return `Response.json(body, { status, headers: CORS })`; every response includes `CORS`; write ops use `appWriteOpts(env)`.
- `buildColumnValues(rec, spec, ctx)` already stamps the HubSpot-ID column, the HubSpot deep-link, and derives people columns from `sales_user`/`hubspot_owner_id` — reuse it so a card is born fully-populated with its ID in one mutation.

---

### Task 1: `normalizeDomain` — pure company-domain normalizer

**Files:**
- Create: `worker/src/normalize.ts`
- Test: `worker/test/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/normalize.test.ts
import { describe, it, expect } from "vitest";
import { normalizeDomain } from "../src/normalize";

describe("normalizeDomain", () => {
  it("lowercases and strips scheme, www, path and trailing slash", () => {
    expect(normalizeDomain("HTTPS://WWW.Acme.com/contact")).toBe("acme.com");
    expect(normalizeDomain("http://acme.com/")).toBe("acme.com");
    expect(normalizeDomain("www.Acme.Com")).toBe("acme.com");
    expect(normalizeDomain("acme.com")).toBe("acme.com");
  });
  it("trims surrounding whitespace and a trailing dot", () => {
    expect(normalizeDomain("  Acme.com.  ")).toBe("acme.com");
  });
  it("keeps subdomains other than www", () => {
    expect(normalizeDomain("https://mail.acme.co.uk/x")).toBe("mail.acme.co.uk");
  });
  it("returns empty string for blank/undefined input", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("   ")).toBe("");
    expect(normalizeDomain(undefined as unknown as string)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/normalize.test.ts`
Expected: FAIL — cannot find module `../src/normalize`.

- [ ] **Step 3: Write minimal implementation**

```ts
// worker/src/normalize.ts
/** Canonical company domain for dedup: lowercase, no scheme, no leading www., no path, no trailing dot/slash.
 * Pure + deterministic so it is unit-testable. Empty/blank input -> "". */
export function normalizeDomain(raw: string): string {
  if (!raw) return "";
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");   // strip scheme (http://, https://, etc.)
  d = d.replace(/^www\./, "");          // strip a single leading www.
  d = d.replace(/[/?#].*$/, "");        // strip path/query/fragment
  d = d.replace(/[.\s]+$/, "");         // strip trailing dots/whitespace
  return d;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/normalize.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/normalize.ts worker/test/normalize.test.ts
git commit -m "feat(worker): normalizeDomain pure util for company dedup"
```

---

### Task 2: `searchCompanyByDomain` — HubSpot domain dedup lookup

**Files:**
- Modify: `worker/src/hubspot.ts` (add function; import `normalizeDomain`)

This is an I/O function (calls `hs()`), so — exactly like the existing `searchContactByEmail` — it has no unit test; its behaviour is covered by the live verification in Task 10. Mirror `searchContactByEmail` precisely.

- [ ] **Step 1: Add the import at the top of `worker/src/hubspot.ts`**

Find the existing import line:

```ts
import { LINE_ITEM_WRITE_PROPS } from "./line-item-props";
```

Add immediately below it:

```ts
import { normalizeDomain } from "./normalize";
```

- [ ] **Step 2: Add `searchCompanyByDomain` directly below `searchContactByEmail`** (after the function that ends near line 338)

```ts
/** Find a HubSpot company by exact normalized domain (for reuse-if-exists). Null if none/blank. */
export async function searchCompanyByDomain(env: Env, domain: string):
    Promise<{ id: string; modified: string } | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const body = {
    filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: d }] }],
    properties: ["hs_lastmodifieddate"], limit: 1,
  };
  const res = await hs(env, "POST", "/crm/v3/objects/companies/search", body);
  const hit = res.results?.[0];
  return hit ? { id: String(hit.id), modified: hit.properties?.hs_lastmodifieddate ?? "" } : null;
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/hubspot.ts
git commit -m "feat(worker): searchCompanyByDomain (normalized-domain dedup)"
```

---

### Task 3: Contact/Company writable-prop allowlists + enum lists

**Files:**
- Create: `worker/src/contact-company-props.ts`
- Test: `worker/test/contact-company-props.test.ts`

Mirrors `worker/src/line-item-props.ts`. The **create** allowlist permits every board-mapped field EXCEPT the server-set owner fields (`sales_user`, `hubspot_owner_id`) and read-only system fields (`createdate`, `notes_last_updated`) — those are never taken from the client body. Names are taken from the `hs` field names in `CONTACTS_MYLA` / `COMPANIES_MYLA` (kept in sync by the cross-check test below).

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/contact-company-props.test.ts
import { describe, it, expect } from "vitest";
import {
  CONTACT_WRITE_PROPS, COMPANY_WRITE_PROPS, CONTACT_ENUM_PROPS, COMPANY_ENUM_PROPS,
  pickWritableContactProps, pickWritableCompanyProps,
} from "../src/contact-company-props";

describe("pickWritableContactProps", () => {
  it("keeps allowlisted contact props and drops unknown / server-set ones", () => {
    expect(pickWritableContactProps({
      firstname: "Ada", lastname: "Lovelace", email: "ada@acme.com", jobtitle: "CTO",
      sales_user: "999", hubspot_owner_id: "999", createdate: "x", bogus: "y",
    })).toEqual({ firstname: "Ada", lastname: "Lovelace", email: "ada@acme.com", jobtitle: "CTO" });
  });
  it("coerces values to strings and drops null/empty", () => {
    expect(pickWritableContactProps({ firstname: "Ada", email: "", jobtitle: null as unknown as string }))
      .toEqual({ firstname: "Ada" });
  });
});

describe("pickWritableCompanyProps", () => {
  it("keeps allowlisted company props and drops unknown / server-set ones", () => {
    expect(pickWritableCompanyProps({
      name: "Acme", domain: "acme.com", industry: "TECH", sales_user: "9", hubspot_owner_id: "9", bogus: "z",
    })).toEqual({ name: "Acme", domain: "acme.com", industry: "TECH" });
  });
});

describe("enum + write prop sets", () => {
  it("never exposes owner/sales_user in the write allowlists", () => {
    for (const s of [CONTACT_WRITE_PROPS, COMPANY_WRITE_PROPS]) {
      expect(s.has("sales_user")).toBe(false);
      expect(s.has("hubspot_owner_id")).toBe(false);
    }
  });
  it("enum props are a subset of the write props", () => {
    for (const e of CONTACT_ENUM_PROPS) expect(CONTACT_WRITE_PROPS.has(e)).toBe(true);
    for (const e of COMPANY_ENUM_PROPS) expect(COMPANY_WRITE_PROPS.has(e)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/contact-company-props.test.ts`
Expected: FAIL — cannot find module `../src/contact-company-props`.

- [ ] **Step 3: Write minimal implementation**

```ts
// worker/src/contact-company-props.ts
// Server-side allowlists for app-driven Contact/Company creation. A create may write any board-mapped
// field EXCEPT the owner fields (sales_user / hubspot_owner_id — set server-side by the owner resolver)
// and read-only system fields. Mirrors line-item-props.ts. Keep in sync with CONTACTS_MYLA /
// COMPANIES_MYLA in config.ts (the write props are the mapped `hs` names minus the exclusions).

export const CONTACT_WRITE_PROPS = new Set<string>([
  "firstname", "lastname", "email", "jobtitle", "phone", "company",
  "hs_lead_status", "leadsource", "manufacturer__c",
]);
export const COMPANY_WRITE_PROPS = new Set<string>([
  "name", "domain", "industry", "type", "partner_with",
  "city", "state", "numberofemployees", "annualrevenue", "description", "linkedin_company_page",
]);

// Enum props whose live options the create forms load from the property schema (no hardcoded options).
export const CONTACT_ENUM_PROPS = ["hs_lead_status", "leadsource", "manufacturer__c"];
export const COMPANY_ENUM_PROPS = ["industry", "type", "partner_with"];

function pick(allow: Set<string>, props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!allow.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    out[k] = String(v);
  }
  return out;
}
export const pickWritableContactProps = (p: Record<string, unknown>) => pick(CONTACT_WRITE_PROPS, p);
export const pickWritableCompanyProps = (p: Record<string, unknown>) => pick(COMPANY_WRITE_PROPS, p);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/contact-company-props.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/contact-company-props.ts worker/test/contact-company-props.test.ts
git commit -m "feat(worker): contact/company writable-prop allowlists + enum lists"
```

---

### Task 4: `resolveActor` — current-rep → HubSpot owner (or Unassigned)

**Files:**
- Create: `worker/src/actor.ts`
- Test: `worker/test/actor.test.ts`

Pure over `Ctx` + email (the route resolves the session `userId` → email via `getUserById` before calling this). Returns the matched HubSpot owner id, or `{ unassigned: true }` — **never** the Myla default.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/actor.test.ts
import { describe, it, expect } from "vitest";
import { resolveActor, OWNER_UNASSIGNED_MESSAGE } from "../src/actor";
import type { Ctx } from "../src/types";

const ctx = { ownerIdByEmail: { "rep@dkm.com": "555" } } as unknown as Ctx;

describe("resolveActor", () => {
  it("maps a known rep email to their HubSpot owner id", () =>
    expect(resolveActor(ctx, "Rep@DKM.com")).toEqual({ hubspotOwnerId: "555" }));
  it("returns unassigned for an unknown email", () =>
    expect(resolveActor(ctx, "stranger@x.com")).toEqual({ unassigned: true }));
  it("returns unassigned for a missing email", () => {
    expect(resolveActor(ctx, "")).toEqual({ unassigned: true });
    expect(resolveActor(ctx, undefined)).toEqual({ unassigned: true });
  });
  it("exposes the exact Unassigned message", () =>
    expect(OWNER_UNASSIGNED_MESSAGE).toBe("No HubSpot owner mapping was found. Record created as Unassigned."));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/actor.test.ts`
Expected: FAIL — cannot find module `../src/actor`.

- [ ] **Step 3: Write minimal implementation**

```ts
// worker/src/actor.ts
import type { Ctx } from "./types";

export const OWNER_UNASSIGNED_MESSAGE =
  "No HubSpot owner mapping was found. Record created as Unassigned.";

export type ActorOwner = { hubspotOwnerId: string } | { unassigned: true };

/** Map the acting rep's email to their HubSpot owner id. No match / no email -> Unassigned (never Myla).
 * The caller writes {sales_user, hubspot_owner_id} = hubspotOwnerId onto the created HubSpot record;
 * buildColumnValues then derives the monday people columns. */
export function resolveActor(ctx: Ctx, email: string | undefined): ActorOwner {
  const key = (email ?? "").trim().toLowerCase();
  const owner = key ? ctx.ownerIdByEmail[key] : undefined;
  return owner ? { hubspotOwnerId: owner } : { unassigned: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/actor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/actor.ts worker/test/actor.test.ts
git commit -m "feat(worker): resolveActor owner mapping (rep email -> owner, else Unassigned)"
```

---

### Task 5: `parseContactBody` / `parseCompanyBody` request validators

**Files:**
- Modify: `worker/src/app-routes.ts` (add two parsers + import the pickers)
- Test: `worker/test/app-routes.test.ts` (extend)

- [ ] **Step 1: Write the failing tests (append to `worker/test/app-routes.test.ts`)**

First extend the import at the top of the file to add the two new parsers:

```ts
import {
  parseLineItemBody, parseAssociationBody, parseDealBody, parseSyncDealBody, parseClearDealBody,
  parseCreateLineItemBody, parseContactBody, parseCompanyBody,
} from "../src/app-routes";
```

Then append:

```ts
const KEY = "123e4567-e89b-42d3-a456-426614174000"; // a valid UUID, like crypto.randomUUID()

describe("parseContactBody", () => {
  it("requires a UUID key + a name and strips props to the contact allowlist", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { firstname: "Ada", email: "a@x.com", bogus: "1" } }))
      .toEqual({ ok: true, idempotencyKey: KEY, properties: { firstname: "Ada", email: "a@x.com" }, associateCompanyHubspotId: undefined }));
  it("accepts an optional numeric associateCompanyHubspotId", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { firstname: "Ada" }, associateCompanyHubspotId: "77" }).associateCompanyHubspotId)
      .toBe("77"));
  it("rejects a missing key and a malformed (non-UUID) key", () => {
    expect(parseContactBody({ properties: { firstname: "Ada" } }).ok).toBe(false);
    expect(parseContactBody({ idempotencyKey: "k1", properties: { firstname: "Ada" } }).ok).toBe(false);
  });
  it("rejects when no name survives the allowlist", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { email: "a@x.com" } }).ok).toBe(false));
  it("rejects a non-numeric associateCompanyHubspotId", () =>
    expect(parseContactBody({ idempotencyKey: KEY, properties: { firstname: "Ada" }, associateCompanyHubspotId: "x" }).ok).toBe(false));
});

describe("parseCompanyBody", () => {
  it("requires a UUID key + name-or-domain and strips props to the company allowlist", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { name: "Acme", industry: "TECH", bogus: "1" } }))
      .toEqual({ ok: true, idempotencyKey: KEY, properties: { name: "Acme", industry: "TECH" }, associateContactHubspotIds: [] }));
  it("accepts optional numeric associateContactHubspotIds", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { domain: "acme.com" }, associateContactHubspotIds: ["1", "2"] }).associateContactHubspotIds)
      .toEqual(["1", "2"]));
  it("rejects a malformed (non-UUID) key", () =>
    expect(parseCompanyBody({ idempotencyKey: "k1", properties: { name: "Acme" } }).ok).toBe(false));
  it("rejects when neither name nor domain survives", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { city: "SG" } }).ok).toBe(false));
  it("rejects a non-numeric id in associateContactHubspotIds", () =>
    expect(parseCompanyBody({ idempotencyKey: KEY, properties: { name: "Acme" }, associateContactHubspotIds: ["1", "x"] }).ok).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/app-routes.test.ts`
Expected: FAIL — `parseContactBody` / `parseCompanyBody` are not exported.

- [ ] **Step 3: Write the implementation in `worker/src/app-routes.ts`**

At the top, extend the existing import:

```ts
import { pickWritableLineItemProps } from "./line-item-props";
import { pickWritableContactProps, pickWritableCompanyProps } from "./contact-company-props";
```

Append at the end of the file:

```ts
// The client generates the key once with crypto.randomUUID() and reuses it across retries. Validate the
// shape (any UUID variant) so a short/garbage/accidentally-shared key can't be used as an idempotency id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isKey = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export interface CreateContactReq {
  ok: boolean; idempotencyKey?: string; properties?: Record<string, string>;
  associateCompanyHubspotId?: string; error?: string;
}
export function parseContactBody(body: any): CreateContactReq {
  if (!isKey(body?.idempotencyKey)) return { ok: false, error: "idempotencyKey must be a UUID" };
  const properties = pickWritableContactProps(body?.properties ?? {});
  if (!properties.firstname) return { ok: false, error: "a contact needs a name (firstname)" };
  const assoc = body?.associateCompanyHubspotId;
  if (assoc !== undefined && !numeric(assoc)) return { ok: false, error: "associateCompanyHubspotId must be numeric" };
  return { ok: true, idempotencyKey: body.idempotencyKey, properties, associateCompanyHubspotId: assoc };
}

export interface CreateCompanyReq {
  ok: boolean; idempotencyKey?: string; properties?: Record<string, string>;
  associateContactHubspotIds?: string[]; error?: string;
}
export function parseCompanyBody(body: any): CreateCompanyReq {
  if (!isKey(body?.idempotencyKey)) return { ok: false, error: "idempotencyKey must be a UUID" };
  const properties = pickWritableCompanyProps(body?.properties ?? {});
  if (!properties.name && !properties.domain) return { ok: false, error: "a company needs a name or domain" };
  const ids = body?.associateContactHubspotIds;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.some((x: unknown) => !numeric(x)))
      return { ok: false, error: "associateContactHubspotIds must be numeric strings" };
  }
  return { ok: true, idempotencyKey: body.idempotencyKey, properties, associateContactHubspotIds: ids ?? [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/app-routes.test.ts`
Expected: PASS (all existing cases + the 10 new parseContactBody/parseCompanyBody cases).

- [ ] **Step 5: Commit**

```bash
git add worker/src/app-routes.ts worker/test/app-routes.test.ts
git commit -m "feat(worker): parseContactBody/parseCompanyBody validators + allowlists"
```

---

### Task 6: Idempotency state helpers + `CreateIdempotency` Durable Object

**Files:**
- Create: `worker/src/idempotency.ts` (pure state types + helpers)
- Create: `worker/src/create-idempotency-do.ts` (the DO class — thin shell)
- Test: `worker/test/idempotency.test.ts`
- Modify: `worker/wrangler.jsonc` (DO binding + migration)
- Modify: `worker/src/types.ts` (Env binding)

The DO cannot be exercised by the plain-vitest suite, so the **state machine is pure and unit-tested**; the DO is a thin adapter around it and is verified live in Task 10.

- [ ] **Step 1: Write the failing test**

```ts
// worker/test/idempotency.test.ts
import { describe, it, expect } from "vitest";
import { emptyResult, decideClaim, type CreateState } from "../src/idempotency";

describe("emptyResult", () => {
  it("starts in_progress with every step false and no ids", () => {
    const r = emptyResult();
    expect(r.status).toBe("in_progress");
    expect(r.hubspotId).toBeUndefined();
    expect(r.steps).toEqual({ dedup: false, hubspot: false, monday: false, owner: false, associations: false });
  });
});

describe("decideClaim", () => {
  const now = 1_000_000;
  it("proceeds from empty when there is no prior state", () =>
    expect(decideClaim(undefined, now).status).toBe("proceed"));
  it("short-circuits a completed key and returns its result", () => {
    const done: CreateState = { status: "done", result: { ...emptyResult(), hubspotId: "9" }, updatedAt: now - 5 };
    const c = decideClaim(done, now);
    expect(c.status).toBe("done");
    expect(c.result.hubspotId).toBe("9");
  });
  it("reports a fresh in-flight key as inflight (concurrent double-submit)", () => {
    const s: CreateState = { status: "inflight", result: emptyResult(), updatedAt: now - 1000 };
    expect(decideClaim(s, now).status).toBe("inflight");
  });
  it("lets a stale in-flight key be reclaimed, carrying its partial result forward", () => {
    const partial = { ...emptyResult(), hubspotId: "42", steps: { ...emptyResult().steps, hubspot: true } };
    const s: CreateState = { status: "inflight", result: partial, updatedAt: now - 120_000 };
    const c = decideClaim(s, now);
    expect(c.status).toBe("proceed");
    expect(c.result.hubspotId).toBe("42"); // resume: don't re-create in HubSpot
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/idempotency.test.ts`
Expected: FAIL — cannot find module `../src/idempotency`.

- [ ] **Step 3: Write the pure state module**

```ts
// worker/src/idempotency.ts
// Pure state machine for create idempotency. The Durable Object persists a CreateState per key and
// delegates its decisions here so they are unit-testable without the Workers runtime.

export interface CreateSteps {
  dedup: boolean; hubspot: boolean; monday: boolean; owner: boolean; associations: boolean;
}
export interface CreateResult {
  // Top-level outcome for the progress UI. "completed" = every needed step done; "failed" = a step threw
  // (see failedStep); "in_progress" = never returned to the client (only a stored partial). The client
  // renders the completed `steps` and, on "failed", highlights `failedStep` + offers Retry (re-POST with
  // the SAME key — the server resumes from the stored partial; the client does NOT drive per-step retry).
  status: "in_progress" | "completed" | "failed";
  failedStep?: "dedup" | "hubspot" | "monday" | "owner" | "associations";
  hubspotId?: string; mondayItemId?: string; existing?: boolean;
  unassigned?: boolean; ownerMessage?: string;
  mondayLink?: string; hubspotLink?: string;
  steps: CreateSteps;
}
export interface CreateState { status: "inflight" | "done"; result: CreateResult; updatedAt: number }

export function emptyResult(): CreateResult {
  return { status: "in_progress", steps: { dedup: false, hubspot: false, monday: false, owner: false, associations: false } };
}

export type Claim =
  | { status: "done"; result: CreateResult }       // key already completed -> return stored result
  | { status: "inflight"; result: CreateResult }    // another attempt is running -> caller returns 409
  | { status: "proceed"; result: CreateResult };    // run/resume the steps from this (possibly partial) result

/** Decide what a claim on a key should do, given the stored state (if any) and now. An in-flight entry
 * older than ttlMs is treated as abandoned and reclaimable, carrying its partial result forward so the
 * retry resumes (reuses any HubSpot/monday id already created) instead of duplicating. */
export function decideClaim(state: CreateState | undefined, nowMs: number, ttlMs = 60_000): Claim {
  if (state?.status === "done") return { status: "done", result: state.result };
  if (state?.status === "inflight" && nowMs - state.updatedAt < ttlMs)
    return { status: "inflight", result: state.result };
  return { status: "proceed", result: state?.result ?? emptyResult() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run test/idempotency.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the Durable Object class**

```ts
// worker/src/create-idempotency-do.ts
import { DurableObject } from "cloudflare:workers";
import { decideClaim, type CreateState, type CreateResult, type Claim } from "./idempotency";

const RETENTION_MS = 24 * 60 * 60_000; // self-clean stored state 24h after the last claim/save

/** One instance per idempotency key (via idFromName). Stores a single CreateState. `claim` serializes its
 * read-modify-write with blockConcurrencyWhile so two concurrent same-key requests can't both proceed —
 * the whole point of the DO (blockConcurrencyWhile is available on every DO backend, unlike the async KV
 * transaction() which isn't guaranteed on SQLite-backed classes). Every claim/save refreshes a 24h cleanup
 * alarm, so no key (completed, partial, or abandoned) lingers forever, while same-day retries are covered. */
export class CreateIdempotency extends DurableObject {
  async claim(nowMs: number): Promise<Claim> {
    let decision!: Claim;
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<CreateState>("state");
      decision = decideClaim(state, nowMs);
      if (decision.status === "proceed")
        await this.ctx.storage.put("state", { status: "inflight", result: decision.result, updatedAt: nowMs });
    });
    await this.ctx.storage.setAlarm(nowMs + RETENTION_MS);
    return decision;
  }
  async save(result: CreateResult, done: boolean, updatedAt: number): Promise<void> {
    await this.ctx.storage.put("state", { status: done ? "done" : "inflight", result, updatedAt });
    // Alarm is always relative to REAL now — never `updatedAt`, which a release passes as 0 to force
    // reclaimability; basing the alarm on 0 would schedule cleanup in 1970 and wipe the partial at once.
    await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
  }
  async alarm(): Promise<void> { await this.ctx.storage.deleteAll(); }
}
```

- [ ] **Step 6: Add the Env binding in `worker/src/types.ts`**

At the top of the file, before `export interface Env {`, add the import type; then add the binding field. Replace:

```ts
export interface Env {
  MONDAY_API_TOKEN: string;
```

with:

```ts
import type { CreateIdempotency } from "./create-idempotency-do";

export interface Env {
  CREATE_IDEMPOTENCY: DurableObjectNamespace<CreateIdempotency>;
  MONDAY_API_TOKEN: string;
```

- [ ] **Step 7: Register the DO binding + migration in `worker/wrangler.jsonc`**

Replace the file contents with:

```jsonc
{
  "name": "hubspot-monday-sync",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "triggers": { "crons": ["*/10 * * * *", "0 3 * * *"] },
  "vars": { "DRY_RUN": "false", "MAX_WRITES": "100", "LINE_ITEM_WRITE": "true" },
  "observability": { "enabled": true },
  "durable_objects": {
    "bindings": [ { "name": "CREATE_IDEMPOTENCY", "class_name": "CreateIdempotency" } ]
  },
  "migrations": [ { "tag": "v1", "new_sqlite_classes": ["CreateIdempotency"] } ]
}
```

- [ ] **Step 8: Export the DO from the Worker entry `worker/src/index.ts`**

Add near the other imports at the top:

```ts
export { CreateIdempotency } from "./create-idempotency-do";
```

- [ ] **Step 9: Verify it type-checks (DO wiring included)**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors. (If `cloudflare:workers` types are missing, they ship with `wrangler`; `@cloudflare/workers-types` is already a devDependency.)

- [ ] **Step 10: Commit**

```bash
git add worker/src/idempotency.ts worker/src/create-idempotency-do.ts worker/test/idempotency.test.ts worker/src/types.ts worker/wrangler.jsonc worker/src/index.ts
git commit -m "feat(worker): CreateIdempotency Durable Object + pure claim state machine"
```

---

### Task 7: Generalize the live-schema helper + add contact/company schema routes

**Files:**
- Modify: `worker/src/hubspot.ts` (`getWritablePropOptions` gains an `object` param)
- Modify: `worker/src/index.ts` (update the line-item-schema caller; add two routes)

- [ ] **Step 1: Generalize `getWritablePropOptions` in `worker/src/hubspot.ts`**

Replace the current signature/first line:

```ts
export async function getWritablePropOptions(env: Env, names: string[]):
    Promise<Record<string, { label: string; options: { value: string; label: string }[] }>> {
  const res = await hs(env, "GET", "/crm/v3/properties/line_items", undefined, 2);
```

with (adds `object`, used in the path):

```ts
export async function getWritablePropOptions(env: Env, object: string, names: string[]):
    Promise<Record<string, { label: string; options: { value: string; label: string }[] }>> {
  const res = await hs(env, "GET", `/crm/v3/properties/${object}`, undefined, 2);
```

- [ ] **Step 2: Update the existing line-item-schema caller in `worker/src/index.ts`**

Find (near line 97):

```ts
          const schema = await getWritablePropOptions(env, LINE_ITEM_ENUM_PROPS);
```

Replace with:

```ts
          const schema = await getWritablePropOptions(env, "line_items", LINE_ITEM_ENUM_PROPS);
```

- [ ] **Step 3: Add the two schema imports + route handlers in `worker/src/index.ts`**

Extend the `contact-company-props` import (added in later tasks — add it now) near the other imports:

```ts
import { CONTACT_ENUM_PROPS, COMPANY_ENUM_PROPS } from "./contact-company-props";
```

Add these two routes immediately AFTER the `/app/line-item-schema` block (after its closing `}` near line 103):

```ts
      // GET /app/contact-schema — live enum options for the Create Contact form.
      if (url.pathname === "/app/contact-schema" && req.method === "GET") {
        try {
          const schema = await getWritablePropOptions(env, "contacts", CONTACT_ENUM_PROPS);
          return Response.json({ schema }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/contact-schema] error="${String(e).slice(0, 140)}"`);
          return Response.json({ schema: {}, error: "schema-failed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }

      // GET /app/company-schema — live enum options for the Create Company form.
      if (url.pathname === "/app/company-schema" && req.method === "GET") {
        try {
          const schema = await getWritablePropOptions(env, "companies", COMPANY_ENUM_PROPS);
          return Response.json({ schema }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        } catch (e) {
          console.log(`[app/company-schema] error="${String(e).slice(0, 140)}"`);
          return Response.json({ schema: {}, error: "schema-failed" }, { headers: { ...CORS, "Cache-Control": "no-store" } });
        }
      }
```

- [ ] **Step 4: Verify it type-checks and all tests still pass**

Run: `cd worker && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/hubspot.ts worker/src/index.ts
git commit -m "feat(worker): generic getWritablePropOptions + /app/contact-schema + /app/company-schema"
```

---

### Task 8: `createContactOrCompany` orchestration (search-or-create + card-with-ID + owner + association)

**Files:**
- Create: `worker/src/create-records.ts`

I/O orchestration (no unit test — like the `/app/line-item` create branch); each step reads the incoming `CreateResult` so a resumed call skips already-done work. Verified live in Task 10. Returns `{ result, error? }` and never throws (so the DO always stores the partial for resume).

- [ ] **Step 1: Write the module**

```ts
// worker/src/create-records.ts
import type { Ctx, Env, HsRecord, ObjectSpec, RunOpts } from "./types";
import { CONTACTS_MYLA, COMPANIES_MYLA } from "./config";
import { createRecord, searchContactByEmail, searchCompanyByDomain, putAssociation } from "./hubspot";
import { getUserById, findItemByColumn, createItem } from "./monday";
import { buildColumnValues, itemName } from "./mapping";
import { targetGroup } from "./routing";
import { resolveActor, OWNER_UNASSIGNED_MESSAGE } from "./actor";
import { normalizeDomain } from "./normalize";
import type { CreateResult } from "./idempotency";

export interface CreateInput {
  properties: Record<string, string>;
  sessionUserId?: string;                 // acting rep (undefined for trigger-secret auth -> Unassigned)
  dedup: { kind: "email"; value: string } | { kind: "domain"; value: string } | { kind: "none" };
  associateContacts?: string[];           // company create: contact HubSpot ids to associate
  associateCompany?: string;              // contact create: one company HubSpot id to associate
}

function hubspotLink(spec: ObjectSpec, ctx: Ctx, id: string): string {
  return `https://app.hubspot.com/contacts/${ctx.portalId}/record/${spec.objectTypeId}/${id}`;
}

/** Find (by HubSpot id) or create the monday card for a just-created/reused record, stamping the id in
 * the initial create mutation via buildColumnValues so the reverse-sync never re-creates it in HubSpot. */
async function findOrCreateCard(env: Env, spec: ObjectSpec, ctx: Ctx, rec: HsRecord, opts: RunOpts): Promise<string | null> {
  const existing = (await findItemByColumn(env, spec.boardId, spec.idCol, rec.id))[0];
  if (existing) return existing.id;
  const group = targetGroup(rec, spec);          // contacts -> New/topics, companies -> single group (never null)
  if (!group) return null;
  const cv = buildColumnValues(rec, spec, ctx);  // includes idCol + link + derived people columns
  cv[spec.syncStateCol] = rec.properties[spec.modifiedProp] ?? "";
  return createItem(env, spec.boardId, group, itemName(rec, spec), cv, opts);
}

/** Search-or-create a Contact/Company. Resumable: skips steps already recorded in `prior`. Never throws
 * (returns {result, error?}) so the caller can persist the partial for a resumed retry. The app builds
 * the "Open in monday" link from mondayItemId via the SDK, so no monday URL is fabricated here. */
export async function createContactOrCompany(
  env: Env, object: "contacts" | "companies", ctx: Ctx, input: CreateInput, prior: CreateResult, opts: RunOpts,
): Promise<{ result: CreateResult; error?: string }> {
  const spec = object === "contacts" ? CONTACTS_MYLA : COMPANIES_MYLA;
  const result: CreateResult = { ...prior, steps: { ...prior.steps }, status: "in_progress", failedStep: undefined };
  let step: NonNullable<CreateResult["failedStep"]> = "owner"; // the stage in flight -> failedStep on throw
  // Store the CANONICAL domain (what searchCompanyByDomain searches for) so a later dedup can find this
  // company — otherwise a raw "WWW.Acme.com/" would never match a normalized "acme.com" search -> a dup.
  const properties = object === "companies" && input.properties.domain
    ? { ...input.properties, domain: normalizeDomain(input.properties.domain) }
    : input.properties;
  try {
    // Resolve owner once (deterministic; safe to recompute on a resumed call). No acting user (trigger-
    // secret auth) or no owner match -> Unassigned (never Myla). Owner is applied ONLY to records we
    // create, never to a deduped existing record.
    const email = input.sessionUserId ? (await getUserById(env, input.sessionUserId))?.email : undefined;
    const owner = resolveActor(ctx, email);
    const ownerProps: Record<string, string> = "hubspotOwnerId" in owner
      ? { sales_user: owner.hubspotOwnerId, hubspot_owner_id: owner.hubspotOwnerId } : {};

    // 1) dedup + 2) create-or-reuse in HubSpot (skip entirely if a prior attempt already resolved an id)
    if (!result.hubspotId) {
      step = "dedup";
      const found = input.dedup.kind === "email" ? await searchContactByEmail(env, input.dedup.value)
                  : input.dedup.kind === "domain" ? await searchCompanyByDomain(env, input.dedup.value)
                  : null;
      result.steps.dedup = true;
      if (found) {
        result.hubspotId = found.id; result.existing = true;                 // reuse — do not touch its owner
      } else {
        step = "hubspot";
        const created = await createRecord(env, spec, { ...properties, ...ownerProps }, opts);
        if (!created) return { result };                                     // dry-run: nothing was written
        result.hubspotId = created.id; result.existing = false;
        if ("unassigned" in owner) { result.unassigned = true; result.ownerMessage = OWNER_UNASSIGNED_MESSAGE; }
      }
      result.steps.hubspot = true; result.steps.owner = true;
    }
    result.hubspotLink = hubspotLink(spec, ctx, result.hubspotId);

    // 3) monday card: find-or-create by HubSpot id, stamping the id in the initial create mutation. Seed
    //    it from the props we sent (+ owner for records we created) so people columns render immediately;
    //    the reverse-sync reconciles everything else next tick.
    if (!result.mondayItemId) {
      step = "monday";
      const cardProps = result.existing ? { ...properties } : { ...properties, ...ownerProps };
      const rec: HsRecord = { id: result.hubspotId, properties: { ...cardProps, [spec.modifiedProp]: "" } };
      const itemId = await findOrCreateCard(env, spec, ctx, rec, opts);
      result.steps.monday = true;
      if (itemId) result.mondayItemId = itemId;
    }

    // 4) optional deal-free associations (contact<->company). Additive/idempotent PUT.
    if (!result.steps.associations) {
      step = "associations";
      if (object === "contacts" && input.associateCompany)
        await putAssociation(env, "contacts", result.hubspotId, "companies", input.associateCompany, opts);
      if (object === "companies") for (const cId of input.associateContacts ?? [])
        await putAssociation(env, "companies", result.hubspotId, "contacts", cId, opts);
      result.steps.associations = true;
    }
    result.status = "completed";
    return { result };
  } catch (e) {
    result.status = "failed"; result.failedStep = step;
    return { result, error: String(e).slice(0, 200) };
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/create-records.ts
git commit -m "feat(worker): createContactOrCompany orchestration (search-or-create, card-with-ID, owner, assoc)"
```

---

### Task 9: `POST /app/contact` + `POST /app/company` endpoints (+ auth carries userId/accountId, account/kind-namespaced idempotency keys)

**Files:**
- Modify: `worker/src/index.ts` (auth returns userId + accountId; two new routes; the `/app/line-item` branch is left unchanged — see the note in Step 3)

- [ ] **Step 1: Make `authApp` return the acting user id**

Replace the whole `authApp` function:

```ts
async function authApp(req: Request, env: Env): Promise<{ ok: boolean; reason: string; userId?: string; accountId?: string }> {
  const trigger = req.headers.get("x-trigger-secret");
  if (trigger && env.TRIGGER_SECRET && trigger === env.TRIGGER_SECRET) return { ok: true, reason: "trigger-secret" };
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false, reason: "no session token / trigger secret" };
  const v = await verifySessionToken(env.MONDAY_APP_SESSION_SECRET ?? "", bearer, env.MONDAY_ACCOUNT_ID, Date.now());
  return { ok: v.ok, reason: v.reason, userId: v.userId, accountId: v.accountId };
}
```

And capture the user + account where `authApp` is called (near line 69):

```ts
      const auth = await authApp(req, env);
      if (!auth.ok) {
        console.log(`[app] path=${url.pathname} action=rejected reason="${auth.reason}"`);
        return new Response("forbidden", { status: 403, headers: CORS });
      }
      const actingUserId = auth.userId; // undefined under trigger-secret auth -> record created Unassigned
      const actingAccountId = auth.accountId ?? env.MONDAY_ACCOUNT_ID ?? "acct"; // namespaces idempotency keys
```

- [ ] **Step 2: Add imports for the create pipeline in `worker/src/index.ts`**

Extend the existing `app-routes` import to include the two new parsers:

```ts
import { parseLineItemBody, parseAssociationBody, parseDealBody, parseSyncDealBody, parseClearDealBody, parseCreateLineItemBody, parseContactBody, parseCompanyBody } from "./app-routes";
```

Extend the existing `./sync` import (currently `import { runAll, runIncremental, syncMondayItem } from "./sync";`) to also bring in `getCtxCached` (already exported there):

```ts
import { runAll, runIncremental, syncMondayItem, getCtxCached } from "./sync";
```

Add one new import line near the other imports:

```ts
import { createContactOrCompany, type CreateInput } from "./create-records";
```

- [ ] **Step 3: Add the two endpoints (place them just before the final `return new Response("not found", ...)` inside the `/app/` block, near line 244)**

```ts
      // POST /app/contact | /app/company — search-or-create a HubSpot Contact/Company, create the monday
      // card with the HubSpot id in the initial mutation, apply owner, optional deal-free association.
      // Idempotent via the CreateIdempotency Durable Object keyed by the client UUID.
      if ((url.pathname === "/app/contact" || url.pathname === "/app/company") && req.method === "POST") {
        const isContact = url.pathname === "/app/contact";
        const body: any = await req.json().catch(() => ({}));
        const parsed = isContact ? parseContactBody(body) : parseCompanyBody(body);
        if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: CORS });

        // Namespace the key by account + kind so a UUID can never collide across contact/company/line-item
        // or across monday accounts (a Contact request must never read a Company's stored result).
        const doName = `${actingAccountId}:${isContact ? "contact" : "company"}:${parsed.idempotencyKey!}`;
        const stub = env.CREATE_IDEMPOTENCY.get(env.CREATE_IDEMPOTENCY.idFromName(doName));
        const claim = await stub.claim(Date.now());
        if (claim.status === "done") return Response.json(claim.result, { headers: CORS });
        // "inflight" only happens under genuine concurrency (two requests, same key, in the same ~60s).
        // The client generates one key per Create and holds a savingRef lock, so this is rare; sequential
        // retries never hit it because every failure path below RELEASES the key (updatedAt=0).
        if (claim.status === "inflight") return Response.json({ error: "in-progress" }, { status: 409, headers: CORS });

        // Everything after the claim runs inside the try so ANY failure (including a cold getCtxCached,
        // which fans out ~12 HubSpot/monday calls) RELEASES the key — otherwise the fresh `inflight` from
        // claim() would strand it for 60s and return a CORS-less 500. `partial` carries the freshest result
        // so even a failure AFTER the create still releases with the ids already produced (resume, no dup).
        let partial = claim.result;
        try {
          const ctx = await getCtxCached(env);
          const props = parsed.properties!;
          const input: CreateInput = isContact
            ? { properties: props, sessionUserId: actingUserId,
                dedup: props.email ? { kind: "email", value: props.email } : { kind: "none" },
                associateCompany: (parsed as any).associateCompanyHubspotId }
            : { properties: props, sessionUserId: actingUserId,
                dedup: props.domain ? { kind: "domain", value: props.domain } : { kind: "none" },
                associateContacts: (parsed as any).associateContactHubspotIds };
          const { result, error } = await createContactOrCompany(
            env, isContact ? "contacts" : "companies", ctx, input, claim.result, appWriteOpts(env));
          partial = result;
          if (error) {
            await stub.save(result, false, 0); // release + keep the partial: the next retry resumes, reusing any id already created
            console.log(`[app/${isContact ? "contact" : "company"}] error="${error}"`);
            return Response.json({ ...result, error: "create-failed" }, { status: 502, headers: CORS });
          }
          await stub.save(result, true, Date.now()); // mark done: this key now short-circuits to the stored result
          return Response.json(result, { headers: CORS });
        } catch (e) {
          await stub.save(partial, false, 0); // release (with any partial) so the retry isn't blocked by a stuck inflight key
          console.log(`[app/${isContact ? "contact" : "company"}] fatal="${String(e).slice(0, 160)}"`);
          return Response.json({ error: "create-failed" }, { status: 502, headers: CORS });
        }
      }
```

> **Line-item idempotency is deliberately NOT wired here.** A partial "short-circuit on done, else fall
> through" wrapper is weaker than the contact/company path (no inflight→409) and would touch shipped code
> for little gain — the existing subitem Line-Item-ID reuse + the client `savingRef` lock already prevent
> duplicate line items. Uniform DO idempotency for line items (full done→return / inflight→409 /
> proceed→resume / fail→release, keyed `${accountId}:line-item:${key}`) is a **separate, fully-tested
> follow-up task**, not part of Phase A. So the `/app/line-item` branch is left unchanged in this task.

- [ ] **Step 4: Verify it type-checks and the full suite passes**

Run: `cd worker && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests green (no new unit tests here — logic is covered by Tasks 1/3/4/5/6; endpoints are verified live in Task 10).

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): POST /app/contact + /app/company endpoints; auth carries userId + accountId; account/kind-namespaced idempotency keys"
```

---

### Task 10: Build gate, deploy, and live verification

**Files:** none (verification + deploy)

- [ ] **Step 1: Full green gate**

Run: `cd worker && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all suites pass (normalize 4, contact-company-props 5, actor 4, idempotency 5, app-routes extended, plus the existing suites).

- [ ] **Step 2: Deploy the Worker (creates the Durable Object on first deploy)**

Run: `cd worker && npx wrangler deploy`
Expected: deploy succeeds and prints a new Current Version ID; the output lists the `CreateIdempotency` Durable Object binding and applies migration tag `v1`.

- [ ] **Step 3: Auth-gate + preflight checks on the new endpoints**

```bash
# 403 for a bad token:
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://hubspot-monday-sync.askada.workers.dev/app/contact" -H 'Authorization: Bearer x' -H 'Content-Type: application/json' -d '{"idempotencyKey":"t","properties":{"firstname":"T"}}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://hubspot-monday-sync.askada.workers.dev/app/company" -H 'Authorization: Bearer x' -H 'Content-Type: application/json' -d '{"idempotencyKey":"t","properties":{"name":"T"}}'
# 204 for OPTIONS preflight:
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "https://hubspot-monday-sync.askada.workers.dev/app/contact"
# 403 for the schema routes without a token:
curl -s -o /dev/null -w '%{http_code}\n' "https://hubspot-monday-sync.askada.workers.dev/app/contact-schema" -H 'Authorization: Bearer x'
```

Expected: `403`, `403`, `204`, `403`.

- [ ] **Step 4: Manual end-to-end (with a real Board View session token, on a throwaway record — the app UI arrives in Phase B, so drive these with curl):**
  1. **Re-verify IDs/schema live:** `GET /app/contact-schema` and `GET /app/company-schema` return option lists for the enum props (industry/type/lead-status/leadsource/manufacturer/partner-with) — confirming the live property names match `contact-company-props.ts`.
  2. **Create a Contact** (`POST /app/contact` with a unique `idempotencyKey` UUID + a test email): response has `status:"completed"`, `hubspotId`, `mondayItemId`, `existing:false`, and `hubspotLink` (the app builds the monday link from `mondayItemId`); the card appears on board `5029639630` in the **New** group with its HubSpot-ID column stamped; the owner (or Unassigned + `ownerMessage`) is correct for the acting rep.
  3. **Dedup:** repeat with the **same email** but a **new** idempotencyKey → `existing:true`, the **same** `hubspotId`, no duplicate.
  4. **Idempotency:** repeat with the **same idempotencyKey** as step 2 → identical stored result returned, no second HubSpot record or monday card.
  5. **Company:** the same three checks by normalized **domain** on board `5029639440`.
  6. **Clean up** the test records in HubSpot + monday.

- [ ] **Step 5: Record results** in the memory file `deal-cockpit-app.md` (new v3.4-Phase-A entry: worker version, DO migration applied, endpoints live, verification outcomes). Do NOT commit spec/plan docs (the user commits those).

---

## Notes for the implementer
- **Do not** introduce `@cloudflare/vitest-pool-workers`; the suite is plain vitest and the design keeps all decision logic pure so it stays that way. The DO + orchestration are verified live (Task 10).
- **Never** log tokens/secrets; keep the `console.log` lines to ids/paths/short error slices (match existing style).
- Creates pass `retries=1` inside `hs()`/`createRecord`; do not change that — it is what prevents double-applied POSTs.
- **Never** match/merge by name; dedup is email (contacts) / normalized domain (companies) only. **Never** fall back to Myla.
- Owner fields (`sales_user`, `hubspot_owner_id`) are set **server-side** only; they are intentionally excluded from the client allowlists.
```
